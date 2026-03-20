import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { basename, join, resolve } from "path";

const SRC_DIR = process.argv[2] ?? "./src";
const OUT_FILE = process.argv[3] ?? "./stage.gs";

// ── Types ────────────────────────────────────────────────────────────────────

interface Module {
  file: string;
  src: string;
  exports: Set<string>;       // explicitly exported names
  imports: Map<string, string>; // name → source file
  decls: Set<string>;         // all declared names
  isEntry: boolean;
}

// ── Step 1: discover files ───────────────────────────────────────────────────

const allFiles = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".gs"))
  .map((f) => join(SRC_DIR, f));

if (allFiles.length === 0) {
  console.error(`No .gs files found in ${SRC_DIR}`);
  process.exit(1);
}

// ── Step 2: parse custom directives ─────────────────────────────────────────
// Supported directives (comments so goboscript ignores them if seen raw):
//
//   # export foo, bar, baz
//   # import foo, bar from "other.gs"
//   # alias myLongName as short
//
// These are bundler-only — stripped from output

function parseDirectives(file: string, src: string): {
  exports: Set<string>;
  imports: Map<string, string>;
  aliases: Map<string, string>;
} {
  const exports = new Set<string>();
  const imports = new Map<string, string>();
  const aliases = new Map<string, string>();

  for (const line of src.split("\n")) {
    const t = line.trim();

    // # export foo, bar, baz
    const exportMatch = t.match(/^#\s*export\s+(.+)$/);
    if (exportMatch) {
      for (const name of exportMatch[1].split(",").map((s) => s.trim())) {
        if (name) exports.add(name);
      }
    }

    // # import foo, bar from "other.gs"
    const importMatch = t.match(/^#\s*import\s+(.+?)\s+from\s+"([^"]+)"$/);
    if (importMatch) {
      const names = importMatch[1].split(",").map((s) => s.trim());
      const fromFile = resolve(SRC_DIR, importMatch[2]);
      for (const name of names) {
        if (name) imports.set(name, fromFile);
      }
    }

    // # alias longName as short
    const aliasMatch = t.match(/^#\s*alias\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*)$/);
    if (aliasMatch) {
      aliases.set(aliasMatch[1], aliasMatch[2]);
    }
  }

  return { exports, imports, aliases };
}

// ── Step 3: preprocess source ────────────────────────────────────────────────
// - strip bundler directives (# export / # import / # alias)
// - strip %include lines
// - strip costumes/list rom from non-entry files
// - fix local → var
// - fix single = in conditions → ==

function preprocess(src: string, isEntry: boolean): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("%include")) return false;
      if (!isEntry && t.startsWith("costumes")) return false;
      if (!isEntry && t.startsWith("list rom")) return false;
      // Strip bundler directives
      if (/^#\s*(export|import|alias)\s/.test(t)) return false;
      return true;
    })
    .map((line) => {
      // Fix local → var
      line = line.replace(
        /^(\s*)local\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/,
        "$1var $2 = 0;"
      );
      line = line.replace(
        /^(\s*)local\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/,
        "$1var $2 ="
      );
      // Fix single = in conditions (only in the condition part, before {)
      if (/^\s*(if|elif|until)\s/.test(line)) {
        const braceIdx = line.indexOf("{");
        if (braceIdx !== -1) {
          const condition = line.slice(0, braceIdx);
          const body = line.slice(braceIdx);
          if (/(?<![=!<>])=(?!=)/.test(condition)) {
            line = condition.replace(/(?<![=!<>])=(?!=)/g, "==") + body;
          }
        } else {
          // Multi-line if — no { on this line, fix whole line
          if (/(?<![=!<>])=(?!=)/.test(line)) {
            line = line.replace(/(?<![=!<>])=(?!=)/g, "==");
          }
        }
      }
      return line;
    })
    .join("\n");
}

// ── Step 4: build module map ─────────────────────────────────────────────────

function extractDeclarations(src: string): Set<string> {
  const decls = new Set<string>();
  const patterns = [
    /^\s*var\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
    /^\s*list\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
    /^\s*proc\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
    /^\s*func\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
    /^\s*struct\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
    /^\s*enum\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
  ];
  for (const pat of patterns) {
    for (const m of src.matchAll(pat)) decls.add(m[1]);
  }
  return decls;
}

const modules = new Map<string, Module>();

for (const file of allFiles) {
  const rawSrc = readFileSync(file, "utf8");
  const isEntry = /^\s*onflag\s*\{/m.test(rawSrc);
  const { exports, imports, aliases } = parseDirectives(file, rawSrc);
  const src = preprocess(rawSrc, isEntry);
  const decls = extractDeclarations(src);

  // If no explicit exports, infer exports = all procs/funcs (public API)
  // vars stay private unless explicitly exported
  if (exports.size === 0 && !isEntry) {
    for (const decl of decls) {
      if (/^(proc|func)/.test(decl)) {
        // Check if it was declared as proc/func
      }
    }
    // Actually: infer by re-scanning for proc/func names
    const procPattern = /^\s*(proc|func)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
    for (const m of src.matchAll(procPattern)) {
      exports.add(m[2]);
    }
  }

  modules.set(file, { file, src, exports, imports, decls, isEntry });
}

// ── Step 5: detect entry ─────────────────────────────────────────────────────

const entryModule = [...modules.values()].find((m) => m.isEntry);
if (!entryModule) {
  console.error("No onflag block found. Aborting.");
  process.exit(1);
}

const moduleList = [...modules.values()].filter((m) => !m.isEntry);
const orderedModules = [...moduleList, entryModule];

console.log(`\nEntry:   ${basename(entryModule.file)}`);
console.log(`Modules: ${moduleList.map((m) => basename(m.file)).join(", ")}\n`);

// ── Step 6: resolve what is shared ───────────────────────────────────────────
// A name is shared (not mangled) if:
//   - it is explicitly exported from its declaring file
//   - it is explicitly imported by another file
//   - it appears in another file's source (cross-reference)

const allExports = new Set<string>();
for (const mod of modules.values()) {
  for (const name of mod.exports) allExports.add(name);
}

const allImports = new Set<string>();
for (const mod of modules.values()) {
  for (const name of mod.imports.keys()) allImports.add(name);
}

function extractIdentifiers(src: string): Set<string> {
  const ids = new Set<string>();
  const stripped = src.replace(/#.*/g, "").replace(/"[^"]*"/g, "");
  for (const m of stripped.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g)) {
    ids.add(m[1]);
  }
  return ids;
}

function isShared(name: string, declaredIn: string): boolean {
  const mod = modules.get(declaredIn)!;
  // Explicitly exported
  if (mod.exports.has(name)) return true;
  // Explicitly imported by someone
  if (allImports.has(name)) return true;
  // Cross-referenced by another file
  for (const [file, other] of modules) {
    if (file === declaredIn) continue;
    if (extractIdentifiers(other.src).has(name)) return true;
  }
  return false;
}

// ── Step 7: build mangle maps ────────────────────────────────────────────────

let nameCounter = 0;
function nextName(): string {
  const pool = "abcdefghijklmnopqrstuvwxyz";
  let n = nameCounter++;
  let out = "";
  do {
    out = pool[n % 26] + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `_p${out}`;
}

// Also apply aliases as part of mangle map
const fileMangles = new Map<string, Map<string, string>>();

for (const [file, mod] of modules) {
  const { aliases } = parseDirectives(file, readFileSync(file, "utf8"));
  const map = new Map<string, string>();

  // Apply explicit aliases first
  for (const [orig, alias] of aliases) {
    map.set(orig, alias);
  }

  // Mangle private declarations
  for (const name of mod.decls) {
    if (!map.has(name) && !isShared(name, file)) {
      map.set(name, nextName());
    }
  }

  fileMangles.set(file, map);

  const privateCount = [...map.values()].filter((v) => v.startsWith("_p")).length;
  const aliasCount = [...map.values()].filter((v) => !v.startsWith("_p")).length;

  console.log(`[${basename(file)}]`);
  if (privateCount > 0) {
    console.log(`  ${privateCount} private vars mangled`);
    for (const [k, v] of map) {
      if (v.startsWith("_p")) console.log(`    ${k} → ${v}`);
    }
  }
  if (aliasCount > 0) {
    console.log(`  ${aliasCount} aliases applied`);
    for (const [k, v] of map) {
      if (!v.startsWith("_p")) console.log(`    ${k} → ${v}`);
    }
  }
  if (privateCount === 0 && aliasCount === 0) {
    console.log(`  no private vars`);
  }
}

// ── Step 8: apply mangle ─────────────────────────────────────────────────────

function applyMangle(src: string, map: Map<string, string>): string {
  if (map.size === 0) return src;
  const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
  return src
    .split("\n")
    .map((line) => {
      const commentIdx = line.indexOf("#");
      const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
      const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";
      // Split on string/backtick literals — never mangle inside strings
      const parts = code.split(/(\"[^\"]*\"|`[^`]*`)/g);
      const result = parts
        .map((part, i) => {
          if (i % 2 === 1) return part; // string literal
          let out = part;
          for (const [orig, mangled] of entries) {
            out = out.replace(new RegExp(`\\b${orig}\\b`, "g"), mangled);
          }
          return out;
        })
        .join("");
      return result + comment;
    })
    .join("\n");
}

// ── Step 9: bundle ───────────────────────────────────────────────────────────

let bundle = "";
const sep = (name: string) =>
  `\n# ${"─".repeat(3)} ${name} ${"─".repeat(Math.max(0, 55 - name.length))}\n`;

for (const mod of orderedModules) {
  const map = fileMangles.get(mod.file)!;
  const mangled = applyMangle(mod.src, map);
  bundle += sep(basename(mod.file));
  bundle += mangled;
  bundle += "\n";
}

writeFileSync(OUT_FILE, bundle);
console.log(`\n==> ${OUT_FILE} written (${bundle.length} bytes)`);

// ── Step 10: emit import map for debugging ───────────────────────────────────

const importMap: Record<string, Record<string, string>> = {};
for (const [file, map] of fileMangles) {
  importMap[basename(file)] = Object.fromEntries(map);
}
writeFileSync(
  OUT_FILE.replace(".gs", ".map.json"),
  JSON.stringify(importMap, null, 2)
);
console.log(`==> ${OUT_FILE.replace(".gs", ".map.json")} written`);