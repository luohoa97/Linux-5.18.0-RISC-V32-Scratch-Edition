#!/usr/bin/env bash
set -e

echo "==> Downloading prebuilt rv32ima Linux kernel (linux-5.18.0)..."
# From the official cnlohr/mini-rv32ima-images repo
curl -L -o linux-image.zip \
  "https://github.com/cnlohr/mini-rv32ima-images/raw/master/images/linux-5.18.0-rv32nommu-cnl-1.zip"

echo "==> Extracting kernel image..."
unzip -o linux-image.zip
# The zip contains a file named 'Image'
mv Image vmlinux.bin

echo "==> Kernel size: $(wc -c < vmlinux.bin) bytes"

echo "==> Converting binary to decimal byte list..."
python3 - <<'EOF'
with open("vmlinux.bin", "rb") as f:
    data = f.read()
with open("rom.txt", "w") as out:
    for byte in data:
        out.write(str(byte) + "\n")
print(f"Written {len(data)} bytes -> rom.txt ({len(data)} lines)")
EOF

echo "==> Done. rom.txt is ready for goboscript."
echo "==> Make sure rom.txt is in your project directory before running: goboscript build"