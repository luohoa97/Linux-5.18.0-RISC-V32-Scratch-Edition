# memory.gs — RAM + MMIO dispatch
# import mem_result, reg_write, insn, rs1v, rs2v, rd, addr, pc, bitwise_xor, bitwise_or, bitwise_and, result from "cpu.gs"
# import uart_read, uart_write from "uart.gs"
# import clint_read, clint_write from "clint.gs"
# import fb_read, fb_write from "fb.gs"
# export mem_init, load_kernel, mem_read_byte, mem_read_half, mem_read_word, mem_write_byte, mem_write_half, mem_write_word, mmio_read, mmio_write
# RAM is word-addressed: ram[1] = bytes 0x00000000-0x00000003
# Physical layout:
#   0x00000000 - 0x03FFFFFF  → 64MB RAM (mapped to list index 1..16777216)
#   0x02000000               → CLINT base
#   0x10000000               → UART base
#   0x20000000               → Framebuffer base
#   0x80000000               → Kernel load address (aliased into RAM)

# ── Constants ─────────────────────────────────────────────────────────────────
%define RAM_BASE        0x80000000
%define RAM_SIZE        0x04000000   # 64MB
%define RAM_WORDS       16777216

%define UART_BASE       0x10000000
%define CLINT_BASE      0x02000000
%define FB_BASE         0x20000000
%define FB_WIDTH        320
%define FB_HEIGHT       240

# ── RAM list ──────────────────────────────────────────────────────────────────
list ram;

# ── Scratch has no byte arrays so we pack 4 bytes per word ───────────────────
# word index = (addr - RAM_BASE) // 4 + 1
# byte lane  = (addr - RAM_BASE) % 4      (0=LSB ... 3=MSB, little-endian)

%define RAM_IDX(ADDR)   (((ADDR) - RAM_BASE) // 4 + 1)
%define RAM_LANE(ADDR)  (((ADDR) - RAM_BASE) % 4)
%define LANE_SHIFT(L)   (POW2((L) * 8))
%define LANE_MASK(L)    (255 * LANE_SHIFT(L))

# ── Temp vars ─────────────────────────────────────────────────────────────────
    var mem_addr = 0;
    var mem_val = 0;
    var mem_word = 0;
    var mem_idx = 0;
    var mem_lane = 0;
    var mem_byte = 0;
    var mem_shift = 0;

# ── Init: allocate 64MB as zeroed word list ───────────────────────────────────
proc mem_init {
    delete ram;
    # We can't literally push 16M items at init time — instead we rely on
    # Turbowarp's list auto-grow. Pre-fill with a smaller sentinel and let
    # reads to uninitialised addresses return 0 via bounds check.
    # Kernel loader will explicitly write every word of the kernel image.
    repeat 16777216 {
        add 0 to ram;
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# MMIO router — called by all reads/writes before touching RAM
# Returns 1 in mem_is_mmio if handled, 0 if should fall through to RAM
# ─────────────────────────────────────────────────────────────────────────────
    var mem_is_mmio = 0;

proc mmio_read addr {
    mem_is_mmio = 1;
    if $addr >= UART_BASE and $addr < UART_BASE + 0x100 {
        uart_read $addr - UART_BASE;
    } elif $addr >= CLINT_BASE and $addr < CLINT_BASE + 0x10000 {
        clint_read $addr - CLINT_BASE;
    } elif $addr >= FB_BASE and $addr < FB_BASE + (FB_WIDTH * FB_HEIGHT * 4) {
        fb_read $addr - FB_BASE;
    } else {
        mem_result = 0;
        mem_is_mmio = 0;
    }
}

proc mmio_write addr, val {
    mem_is_mmio = 1;
    if $addr >= UART_BASE and $addr < UART_BASE + 0x100 {
        uart_write $addr - UART_BASE, $val;
    } elif $addr >= CLINT_BASE and $addr < CLINT_BASE + 0x10000 {
        clint_write $addr - CLINT_BASE, $val;
    } elif $addr >= FB_BASE and $addr < FB_BASE + (FB_WIDTH * FB_HEIGHT * 4) {
        fb_write $addr - FB_BASE, $val;
    } else {
        mem_is_mmio = 0;
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# WORD read/write (4 bytes, little-endian, naturally aligned)
# ─────────────────────────────────────────────────────────────────────────────
proc mem_read_word addr {
    mmio_read $addr;
    if not mem_is_mmio {
        mem_idx = RAM_IDX($addr);
        if mem_idx >= 1 and mem_idx <= 16777216 {
            mem_result = ram[mem_idx];
        } else {
            mem_result = 0;
        }
    }
}

proc mem_write_word addr, val {
    mmio_write $addr, $val;
    if not mem_is_mmio {
        mem_idx = RAM_IDX($addr);
        if mem_idx >= 1 and mem_idx <= 16777216 {
            ram[mem_idx] = MASK32($val);
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# BYTE read/write — extract/insert into the packed word
# ─────────────────────────────────────────────────────────────────────────────
proc mem_read_byte addr {
    mmio_read $addr;
    if not mem_is_mmio {
        mem_idx  = RAM_IDX($addr);
        mem_lane = RAM_LANE($addr);
        if mem_idx >= 1 and mem_idx <= 16777216 {
            mem_word  = ram[mem_idx];
            mem_shift = LANE_SHIFT(mem_lane);
            mem_result = (mem_word // mem_shift) % 256;
        } else {
            mem_result = 0;
        }
    }
}

proc mem_write_byte addr, val {
    mmio_write $addr, $val;
    if not mem_is_mmio {
        mem_idx  = RAM_IDX($addr);
        mem_lane = RAM_LANE($addr);
        if mem_idx >= 1 and mem_idx <= 16777216 {
            mem_word  = ram[mem_idx];
            mem_shift = LANE_SHIFT(mem_lane);
            # Clear the target byte lane then insert new byte
            mem_word  = mem_word - ((mem_word // mem_shift) % 256) * mem_shift;
            mem_word  = mem_word + ($val % 256) * mem_shift;
            ram[mem_idx] = mem_word;
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# HALFWORD read/write (2 bytes, little-endian)
# ─────────────────────────────────────────────────────────────────────────────
proc mem_read_half addr {
    mmio_read $addr;
    if not mem_is_mmio {
        mem_idx  = RAM_IDX($addr);
        mem_lane = RAM_LANE($addr);
        if mem_idx >= 1 and mem_idx <= 16777216 {
            mem_word   = ram[mem_idx];
            mem_shift  = LANE_SHIFT(mem_lane);
            mem_result = (mem_word // mem_shift) % 65536;
        } else {
            mem_result = 0;
        }
    }
}

proc mem_write_half addr, val {
    mmio_write $addr, $val;
    if not mem_is_mmio {
        mem_idx  = RAM_IDX($addr);
        mem_lane = RAM_LANE($addr);
        if mem_idx >= 1 and mem_idx <= 16777216 {
            mem_word  = ram[mem_idx];
            mem_shift = LANE_SHIFT(mem_lane);
            mem_word  = mem_word - ((mem_word // mem_shift) % 65536) * mem_shift;
            mem_word  = mem_word + ($val % 65536) * mem_shift;
            ram[mem_idx] = mem_word;
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Atomic helpers (A-extension: LR.W / SC.W / AMOSWAP etc.)
# Single-core so we can fake atomics — no reservation tracking needed
# ─────────────────────────────────────────────────────────────────────────────
    var amo_tmp = 0;
    var amo_result = 0;
    var amo_funct5 = 0;
    var amo_s1 = 0;
    var amo_s2 = 0;

proc exec_atomic {
    # opcode 0x2F, funct3=0x2 (word), funct5 = BITS(insn,31,27)
    amo_funct5 = BITS(insn, 31, 27);
    addr = MASK32(rs1v);

    if amo_funct5 == 0x02 {                      # LR.W — load reserved
        mem_read_word addr;
        reg_write rd, mem_result;

    } elif amo_funct5 == 0x03 {              # SC.W — store conditional (always succeed)
        mem_write_word addr, rs2v;
        reg_write rd, 0;                   # 0 = success

    } elif amo_funct5 == 0x01 {              # AMOSWAP.W
        mem_read_word addr;
        amo_tmp = mem_result;
        mem_write_word addr, rs2v;
        reg_write rd, amo_tmp;

    } elif amo_funct5 == 0x00 {              # AMOADD.W
        mem_read_word addr;
        amo_tmp = mem_result;
        mem_write_word addr, MASK32(amo_tmp + rs2v);
        reg_write rd, amo_tmp;

    } elif amo_funct5 == 0x04 {              # AMOXOR.W
        mem_read_word addr;
        amo_tmp = mem_result;
        bitwise_xor amo_tmp, rs2v;
        mem_write_word addr, result;
        reg_write rd, amo_tmp;

    } elif amo_funct5 == 0x08 {              # AMOOR.W
        mem_read_word addr;
        amo_tmp = mem_result;
        bitwise_or amo_tmp, rs2v;
        mem_write_word addr, result;
        reg_write rd, amo_tmp;

    } elif amo_funct5 == 0x0C {              # AMOAND.W
        mem_read_word addr;
        amo_tmp = mem_result;
        bitwise_and amo_tmp, rs2v;
        mem_write_word addr, result;
        reg_write rd, amo_tmp;

    } elif amo_funct5 == 0x10 {              # AMOMIN.W (signed)
        mem_read_word addr;
        amo_tmp = mem_result;
        amo_s1 = amo_tmp - BIT(31, amo_tmp) * POW2(32);
        amo_s2 = rs2v    - BIT(31, rs2v)    * POW2(32);
        if amo_s1 < amo_s2 { mem_write_word addr, amo_tmp; }
        else        { mem_write_word addr, rs2v;   }
        reg_write rd, amo_tmp;

    } elif amo_funct5 == 0x14 {              # AMOMAX.W (signed)
        mem_read_word addr;
        amo_tmp = mem_result;
        amo_s1 = amo_tmp - BIT(31, amo_tmp) * POW2(32);
        amo_s2 = rs2v    - BIT(31, rs2v)    * POW2(32);
        if amo_s1 > amo_s2 { mem_write_word addr, amo_tmp; }
        else        { mem_write_word addr, rs2v;   }
        reg_write rd, amo_tmp;

    } elif amo_funct5 == 0x18 {              # AMOMINU.W
        mem_read_word addr;
        amo_tmp = mem_result;
        if amo_tmp < rs2v { mem_write_word addr, amo_tmp; }
        else               { mem_write_word addr, rs2v;   }
        reg_write rd, amo_tmp;

    } elif amo_funct5 == 0x1C {              # AMOMAXU.W
        mem_read_word addr;
        amo_tmp = mem_result;
        if amo_tmp > rs2v { mem_write_word addr, amo_tmp; }
        else               { mem_write_word addr, rs2v;   }
        reg_write rd, amo_tmp;
    }
    pc = pc + 4;
}

# ─────────────────────────────────────────────────────────────────────────────
# Kernel loader — writes the kernel binary (stored as a list of bytes
# in `rom`) into RAM starting at RAM_BASE (0x80000000)
# rom[] is populated at compile time from the binary blob
# ─────────────────────────────────────────────────────────────────────────────
list rom;
    var loader_i = 0;
    var loader_word = 0;
    var loader_b0 = 0;
    var loader_b1 = 0;
    var loader_b2 = 0;
    var loader_b3 = 0;

proc load_kernel {
    loader_i = 1;
    # Pack every 4 bytes of rom into one ram word (little-endian)
    repeat (length(rom) // 4) {
        loader_b0 = rom[loader_i];
        loader_b1 = rom[loader_i + 1];
        loader_b2 = rom[loader_i + 2];
        loader_b3 = rom[loader_i + 3];
        loader_word = loader_b0 + (loader_b1 * 256) + (loader_b2 * 65536) + (loader_b3 * 16777216);
        ram[((loader_i - 1) // 4) + 1] = loader_word;
        loader_i = loader_i + 4;
    }
}