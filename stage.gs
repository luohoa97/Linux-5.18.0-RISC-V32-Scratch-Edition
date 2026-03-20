
# ─── clint.gs ───────────────────────────────────────────────
# clint.gs — RISC-V CLINT (Core Local Interruptor)
# Bundled before cpu.gs — duplicate MASK32 for this module only
%define MASK32(V) ((V) % 4294967296)
# Base: 0x02000000
# mtime     at offset 0xBFF8 (64-bit, lo word at 0xBFF8, hi at 0xBFFC)
# mtimecmp  at offset 0x4000 (64-bit, lo at 0x4000, hi at 0x4004)
# Linux compares mtime >= mtimecmp to fire a timer interrupt (cause 0x80000007)

    var _pa = 0;
    var _pb = 0;
    var _pc = 0;
    var _pd = 0;
    var _pe = 0;
    var _pf = 0;
    var _pg = 0;

%define CLINT_TICKS_PER_STEP 100   # increment mtime by this per cpu_step call

proc clint_init {
    _pa    = 0;
    _pb    = 0;
    _pc = 0xFFFFFFFF;
    _pd = 0xFFFFFFFF;
    _pe       = 0;
}

proc clint_read offset {
    if $offset == 0xBFF8 { mem_result = _pa; }
    elif $offset == 0xBFFC { mem_result = _pb; }
    elif $offset == 0x4000 { mem_result = _pc; }
    elif $offset == 0x4004 { mem_result = _pd; }
    else { mem_result = 0; }
}

proc clint_write offset, val {
    if $offset == 0x4000 {
        _pc = MASK32($val);
        # Writing mtimecmp clears the pending timer interrupt
        bitwise_and csr_mip, 0xFFFFFF7F;
        csr_mip = result;
    } elif $offset == 0x4004 {
        _pd = MASK32($val);
    } elif $offset == 0xBFF8 {
        _pa = MASK32($val);
    } elif $offset == 0xBFFC {
        _pb = MASK32($val);
    }
}

proc clint_tick {
    # Advance mtime every cpu step
    _pa = _pa + CLINT_TICKS_PER_STEP;
    if _pa >= 0x100000000 {
        _pa = _pa - 0x100000000;
        _pb = _pb + 1;
    }

    # Check if mtime >= mtimecmp → fire timer interrupt
    if _pb > _pd {
        _ph;
    } elif _pb == _pd {
        if _pa >= _pc {
            _ph;
        }
    }
}

proc _ph {
    # Set MTIP bit (bit 7) in mip
    bitwise_or csr_mip, 0x80;
    csr_mip = result;

    # Only take interrupt if MIE bit set in mstatus and MTIE bit set in mie
    bitwise_and csr_mstatus, 0x8;
    _pf = result;
    bitwise_and csr_mie, 0x80;
    _pg = result;

    if _pf and _pg {
        take_trap 0x80000007, 0;  # cause 7 = machine timer interrupt
    }
}

# ─── cpu.gs ─────────────────────────────────────────────────
# cpu.gs — RV32IMA CPU core
# Reference: CNLohr's mini-rv32ima, Its-Jakey's Linux-On-Scratch



# ── Bit manipulation macros ───────────────────────────────────────────────────

%define MASK32(V)         ((V) % 4294967296)
%define SEXT(V, BITS)     (((V) + antiln(ln(2) * ((BITS) - 1))) % antiln(ln(2) * (BITS)) - antiln(ln(2) * ((BITS) - 1)))
%define SEXT12(V)         (SEXT(V, 12))
%define SEXT13(V)         (SEXT(V, 13))
%define SEXT20(V)         (SEXT(V, 20))
%define SEXT21(V)         (SEXT(V, 21))
%define BIT(N, V)         (((V) // antiln((N) * ln 2)) % 2)
%define BITS(V, HI, LO)   (((V) // antiln((LO) * ln 2)) % antiln(ln(2) * ((HI) - (LO) + 1)))
%define POW2(N)           (antiln(ln(2) * (N)))

# ── Register file ─────────────────────────────────────────────────────────────
# x0..x31 stored in list `reg`, 1-indexed (reg[1] = x0, reg[2] = x1, ...)
# x0 is always zero — we enforce this after every write

list _pai;
    var pc = 0;
    var cycle = 0;

# ── CSR registers (minimal set Linux needs) ───────────────────────────────────
    var csr_mstatus = 0;
    var csr_mie = 0;
    var _pi = 0;
    var _pj = 0;
    var _pk = 0;
    var _pl = 0;
    var _pm = 0;
    var csr_mip = 0;
    var _pn = 0;   # always 0

# ── Temp decode variables ─────────────────────────────────────────────────────
    var insn = 0;
    var _po = 0;
    var rd = 0;
    var _pp = 0;
    var _pq = 0;
    var _pr = 0;
    var _ps = 0;
    var _pt = 0;
    var _pu = 0;
    var _pv = 0;
    var _pw = 0;
    var _px = 0;
    var rs1v = 0;
    var rs2v = 0;
    var result = 0;
    var addr = 0;
    var _py = 0;
    var _pz = 0;

# ── Memory I/O result (set by mem_read / mem_write) ──────────────────────────
    var mem_result = 0;
    var _paa = 0;
    var _pab = 0;
    var _pac = 0;
    var _pad = 0;

# ── Init ──────────────────────────────────────────────────────────────────────
proc cpu_init {
    pc = 0x80000000;
    cycle = 0;
    csr_mstatus = 0;
    csr_mie = 0;
    _pi = 0;
    _pj = 0;
    _pk = 0;
    _pl = 0;
    _pm = 0;
    csr_mip = 0;
    _pn = 0;
    delete _pai;
    repeat 32 {
        add 0 to _pai;
    }
}

# ── Register helpers ──────────────────────────────────────────────────────────
proc _paj n {
    if $n == 0 {
        result = 0;
    } else {
        result = _pai[$n + 1];
    }
}

proc reg_write n, val {
    if $n != 0 {
        _pai[$n + 1] = MASK32($val);
    }
}

# ── Decode helpers ────────────────────────────────────────────────────────────
proc _pak {
    _po  = BITS(insn, 6, 0);
    rd      = BITS(insn, 11, 7);
    _pr  = BITS(insn, 14, 12);
    _pp     = BITS(insn, 19, 15);
    _pq     = BITS(insn, 24, 20);
    _ps  = BITS(insn, 31, 25);

    # I-type immediate
    _pt = SEXT12(BITS(insn, 31, 20));

    # S-type immediate
    _pu = SEXT12((BITS(insn, 31, 25) * 32) + BITS(insn, 11, 7));

    # B-type immediate
    _pv = SEXT13(
        (BIT(31, insn) * 4096) +
        (BIT(7,  insn) * 2048) +
        (BITS(insn, 30, 25) * 64) +
        (BITS(insn, 11, 8)  * 2)
    );

    # U-type immediate
    _pw = MASK32(BITS(insn, 31, 12) * 4096);

    # J-type immediate
    _px = SEXT21(
        (BIT(31, insn)      * 1048576) +
        (BITS(insn, 19, 12) * 4096) +
        (BIT(20, insn)      * 2048) +
        (BITS(insn, 30, 21) * 2)
    );
}

# ── Main execute loop (call this every frame or in a forever loop) ────────────
proc cpu_step {
    _pz = 0;

    # Fetch
    mem_read_word pc;
    insn = mem_result;

    _pak;

    _paj _pp; rs1v = result;
    _paj _pq; rs2v = result;

    # ── Opcode dispatch ───────────────────────────────────────────────────────

    if _po == 0x37 {          # LUI
        reg_write rd, _pw;
        pc = pc + 4;

    } elif _po == 0x17 {   # AUIPC
        reg_write rd, MASK32(pc + _pw);
        pc = pc + 4;

    } elif _po == 0x6F {   # JAL
        reg_write rd, MASK32(pc + 4);
        pc = MASK32(pc + _px);

    } elif _po == 0x67 {   # JALR
        result = MASK32(pc + 4);
        pc = MASK32((rs1v + _pt) & 0xFFFFFFFE);
        reg_write rd, result;

    } elif _po == 0x63 {   # BRANCH
        _pal;

    } elif _po == 0x03 {   # LOAD
        _pam;

    } elif _po == 0x23 {   # STORE
        _pan;

    } elif _po == 0x13 {   # OP-IMM
        _pao;
        pc = pc + 4;

    } elif _po == 0x33 {   # OP (RV32I + M-ext)
        _pap;
        pc = pc + 4;

    } elif _po == 0x0F {   # FENCE — no-op for single-core
        pc = pc + 4;

    } elif _po == 0x73 {   # SYSTEM (CSR + ECALL + EBREAK + MRET)
        _paq;

    } else {
        # Illegal instruction trap
        take_trap 2, insn;
    }

    # Timer interrupt check
    clint_tick;
}

# ── BRANCH ────────────────────────────────────────────────────────────────────
proc _pal {
    result = 0;
    if _pr == 0 { if rs1v == rs2v { result = 1; } }   # BEQ
    if _pr == 1 { if rs1v != rs2v { result = 1; } }   # BNE
    if _pr == 4 {                                       # BLT (signed)
        if (rs1v - rs2v) > 2147483647 { result = 1; }
        if (rs1v < rs2v) and (rs1v < 2147483648) { result = 1; }
    }
    if _pr == 5 {                                       # BGE (signed)
        if rs1v == rs2v { result = 1; }
        if (rs1v > rs2v) and (rs2v < 2147483648) { result = 1; }
    }
    if _pr == 6 { if rs1v < rs2v { result = 1; } }    # BLTU
    if _pr == 7 { if rs1v >= rs2v { result = 1; } }   # BGEU
    if result {
        pc = MASK32(pc + _pv);
    } else {
        pc = pc + 4;
    }
}

# ── LOAD ──────────────────────────────────────────────────────────────────────
proc _pam {
    addr = MASK32(rs1v + _pt);
    if _pr == 0 {             # LB
        mem_read_byte addr;
        reg_write rd, SEXT(mem_result, 8);
    } elif _pr == 1 {      # LH
        mem_read_half addr;
        reg_write rd, SEXT(mem_result, 16);
    } elif _pr == 2 {      # LW
        mem_read_word addr;
        reg_write rd, mem_result;
    } elif _pr == 4 {      # LBU
        mem_read_byte addr;
        reg_write rd, mem_result;
    } elif _pr == 5 {      # LHU
        mem_read_half addr;
        reg_write rd, mem_result;
    }
    pc = pc + 4;
}

# ── STORE ─────────────────────────────────────────────────────────────────────
proc _pan {
    addr = MASK32(rs1v + _pu);
    if _pr == 0 { mem_write_byte addr, rs2v % 256; }
    if _pr == 1 { mem_write_half addr, rs2v % 65536; }
    if _pr == 2 { mem_write_word addr, rs2v; }
    pc = pc + 4;
}

# ── OP-IMM ────────────────────────────────────────────────────────────────────
proc _pao {
    _paa = BITS(insn, 24, 20);
    if _pr == 0 { reg_write rd, MASK32(rs1v + _pt); }         # ADDI
    if _pr == 1 { reg_write rd, MASK32(rs1v * POW2(_paa)); }   # SLLI
    if _pr == 2 {                                                  # SLTI
        if rs1v < 2147483648 and rs1v < MASK32(_pt) {
            reg_write rd, 1;
        } elif rs1v >= 2147483648 and MASK32(_pt) < 2147483648 {
            reg_write rd, 1;
        } else { reg_write rd, 0; }
    }
    if _pr == 3 {                                                  # SLTIU
        if rs1v < MASK32(_pt) { reg_write rd, 1; }
        else { reg_write rd, 0; }
    }
    if _pr == 4 { reg_write rd, MASK32(rs1v) % (2 * MASK32(_pt)) - MASK32(_pt) * (MASK32(rs1v) >= MASK32(_pt)); } # XORI — use mem xor helper
    if _pr == 5 {
        if BIT(30, insn) {                                           # SRAI
            reg_write rd, MASK32((rs1v - (BIT(31,rs1v) * POW2(32))) // POW2(_paa));
        } else {                                                     # SRLI
            reg_write rd, rs1v // POW2(_paa);
        }
    }
    if _pr == 6 { bitwise_or rs1v, MASK32(_pt); reg_write rd, result; }   # ORI
    if _pr == 7 { bitwise_and rs1v, MASK32(_pt); reg_write rd, result; }  # ANDI
}

# ── OP (R-type + M-ext) ───────────────────────────────────────────────────────
proc _pap {
    _paa = rs2v % 32;
    if _ps == 0x01 {
        # M extension
        if _pr == 0 { reg_write rd, MASK32(rs1v * rs2v); }      # MUL
        if _pr == 1 {                                              # MULH
            reg_write rd, ((rs1v - BIT(31,rs1v)*POW2(32)) * (rs2v - BIT(31,rs2v)*POW2(32))) // POW2(32);
        }
        if _pr == 3 { reg_write rd, (rs1v * rs2v) // POW2(32); } # MULHU
        if _pr == 4 {                                              # DIV
            if rs2v != 0 {
                reg_write rd, MASK32((rs1v - BIT(31,rs1v)*POW2(32)) // (rs2v - BIT(31,rs2v)*POW2(32)));
            } else { reg_write rd, 0xFFFFFFFF; }
        }
        if _pr == 5 {                                              # DIVU
            if rs2v != 0 { reg_write rd, rs1v // rs2v; }
            else { reg_write rd, 0xFFFFFFFF; }
        }
        if _pr == 6 {                                              # REM
            if rs2v != 0 {
                reg_write rd, MASK32((rs1v - BIT(31,rs1v)*POW2(32)) - ((rs1v - BIT(31,rs1v)*POW2(32)) // (rs2v - BIT(31,rs2v)*POW2(32))) * (rs2v - BIT(31,rs2v)*POW2(32)));
            } else { reg_write rd, rs1v; }
        }
        if _pr == 7 {                                              # REMU
            if rs2v != 0 { reg_write rd, rs1v % rs2v; }
            else { reg_write rd, rs1v; }
        }
    } else {
        # Base RV32I R-type
        if _pr == 0 {
            if BIT(30, insn) { reg_write rd, MASK32(rs1v - rs2v); } # SUB
            else { reg_write rd, MASK32(rs1v + rs2v); }              # ADD
        }
        if _pr == 1 { reg_write rd, MASK32(rs1v * POW2(_paa)); } # SLL
        if _pr == 2 {                                                # SLT
            if rs1v < 2147483648 and rs1v < rs2v { reg_write rd, 1; }
            elif rs1v >= 2147483648 and rs2v < 2147483648 { reg_write rd, 1; }
            else { reg_write rd, 0; }
        }
        if _pr == 3 {                                                # SLTU
            if rs1v < rs2v { reg_write rd, 1; }
            else { reg_write rd, 0; }
        }
        if _pr == 4 { bitwise_xor rs1v, rs2v; reg_write rd, result; }    # XOR
        if _pr == 5 {
            if BIT(30, insn) {                                         # SRA
                reg_write rd, MASK32((rs1v - BIT(31,rs1v)*POW2(32)) // POW2(_paa));
            } else { reg_write rd, rs1v // POW2(_paa); }            # SRL
        }
        if _pr == 6 { bitwise_or rs1v, rs2v; reg_write rd, result; }     # OR
        if _pr == 7 { bitwise_and rs1v, rs2v; reg_write rd, result; }    # AND
    }
}

# ── SYSTEM (CSR, ECALL, MRET) ─────────────────────────────────────────────────
proc _paq {
    _pab = BITS(insn, 31, 20);
    if _pr == 0 {
        if insn == 0x00000073 {       # ECALL
            take_trap 8, 0;         # cause 8 = ecall from U-mode
        } elif insn == 0x30200073 { # MRET
            pc = _pk;
            bitwise_and csr_mstatus, 0xFFFFFF7F; csr_mstatus = MASK32(result);
        } else {
            pc = pc + 4;
        }
    } else {
        # CSR instructions (CSRRW, CSRRS, CSRRC, CSRRWI, CSRRSI, CSRRCI)
        _par _pab;
        _pac = result;
        _pad = 0;
        if _pr == 1 { _pad = rs1v; }                           # CSRRW
        if _pr == 2 { bitwise_or _pac, rs1v; _pad = result; }      # CSRRS
        if _pr == 3 { _pat rs1v; bitwise_and _pac, result; _pad = result; } # CSRRC
        if _pr == 5 { _pad = _pp; }                            # CSRRWI (zimm)
        if _pr == 6 { bitwise_or _pac, _pp; _pad = result; }       # CSRRSI
        if _pr == 7 { _pat _pp; bitwise_and _pac, result; _pad = result; } # CSRRCI
        reg_write rd, _pac;
        _pas _pab, _pad;
        pc = pc + 4;
    }
}

# ── CSR read/write ────────────────────────────────────────────────────────────
proc _par addr {
    if $addr == 0x300 { result = csr_mstatus; }
    elif $addr == 0x304 { result = csr_mie; }
    elif $addr == 0x305 { result = _pi; }
    elif $addr == 0x340 { result = _pj; }
    elif $addr == 0x341 { result = _pk; }
    elif $addr == 0x342 { result = _pl; }
    elif $addr == 0x343 { result = _pm; }
    elif $addr == 0x344 { result = csr_mip; }
    elif $addr == 0xF14 { result = _pn; }
    elif $addr == 0xC00 or $addr == 0xB00 { result = cycle % POW2(32); }  # cycle/mcycle lo
    elif $addr == 0xC80 or $addr == 0xB80 { result = cycle // POW2(32); } # cycle/mcycle hi
    else { result = 0; }
}

proc _pas addr, val {
    if $addr == 0x300 { csr_mstatus = MASK32($val); }
    elif $addr == 0x304 { csr_mie = MASK32($val); }
    elif $addr == 0x305 { _pi = MASK32($val); }
    elif $addr == 0x340 { _pj = MASK32($val); }
    elif $addr == 0x341 { _pk = MASK32($val); }
    elif $addr == 0x342 { _pl = MASK32($val); }
    elif $addr == 0x343 { _pm = MASK32($val); }
    elif $addr == 0x344 { csr_mip = MASK32($val); }
}

# ── Trap handler ──────────────────────────────────────────────────────────────
proc take_trap cause, tval {
    _pk = pc;
    _pl = MASK32($cause);
    _pm = MASK32($tval);
    bitwise_or csr_mstatus, 0x80; csr_mstatus = MASK32(result);  # set MPIE
    pc = _pi & 0xFFFFFFFC;               # jump to trap vector
}

# ── Bitwise helpers (Scratch has no native bitwise ops) ───────────────────────
# Uses the BIT macro to reconstruct results bit by bit
# We implement 32-bit AND/OR/XOR/NOT via the BIT extraction + reconstruction

    var _pae = 0;
    var _paf = 0;
    var _pag = 0;
    var _pah = 0;

proc bitwise_and a, b {
    _pae = $a; _paf = $b; _pag = 0; _pah = 0;
    repeat 32 {
        if BIT(_pah, _pae) and BIT(_pah, _paf) {
            _pag = _pag + POW2(_pah);
        }
        _pah = _pah + 1;
    }
    result = _pag;
}

proc bitwise_or a, b {
    _pae = $a; _paf = $b; _pag = 0; _pah = 0;
    repeat 32 {
        if BIT(_pah, _pae) or BIT(_pah, _paf) {
            _pag = _pag + POW2(_pah);
        }
        _pah = _pah + 1;
    }
    result = _pag;
}

proc bitwise_xor a, b {
    _pae = $a; _paf = $b; _pag = 0; _pah = 0;
    repeat 32 {
        if BIT(_pah, _pae) != BIT(_pah, _paf) {
            _pag = _pag + POW2(_pah);
        }
        _pah = _pah + 1;
    }
    result = _pag;
}

proc _pat a {
    _pae = $a; _pag = 0; _pah = 0;
    repeat 32 {
        if not BIT(_pah, _pae) {
            _pag = _pag + POW2(_pah);
        }
        _pah = _pah + 1;
    }
    result = _pag;
}

# ─── fb.gs ──────────────────────────────────────────────────
# fb.gs — Framebuffer at 0x20000000
# 320x240 pixels, 32bpp ARGB packed as a single integer per word
# Linux writes pixel data here; we flush to screen via pen each frame

%define FB_WIDTH   320
%define FB_HEIGHT  240
%define FB_PIXELS  76800   # 320 * 240

list _pbc;   # one word per pixel, 0xAARRGGBB
    var _pau = 0;
    var _pav = 0;
    var _paw = 0;
    var _pax = 0;
    var _pay = 0;
    var _paz = 0;
    var _pba = 0;
    var _pbb = 0;

proc fb_init {
    delete _pbc;
    repeat FB_PIXELS {
        add 0 to _pbc;
    }
    _pbb = 0;
    erase_all;
}

proc fb_read offset {
    _pba = $offset // 4 + 1;
    if _pba >= 1 and _pba <= FB_PIXELS {
        mem_result = _pbc[_pba];
    } else {
        mem_result = 0;
    }
}

proc fb_write offset, val {
    _pba = $offset // 4 + 1;
    if _pba >= 1 and _pba <= FB_PIXELS {
        _pbc[_pba] = MASK32($val);
        _pbb = 1;
    }
}

# Call this from main loop — flushes fb_buf to screen using pen
# Turbowarp pen is the only way to draw arbitrary pixels in Scratch
# Each pixel: move to (x, y), set pen color, stamp dot
proc fb_flush {
    if _pbb {
        _pbb = 0;
        erase_all;
        set_pen_size 1;
        _pav = 0;
        repeat FB_HEIGHT {
            _pau = 0;
            repeat FB_WIDTH {
                _pba = _pav * FB_WIDTH + _pau + 1;
                _paw = _pbc[_pba];
                # Extract R, G, B from 0xAARRGGBB
                _pax = (_paw // 65536) % 256;
                _pay = (_paw // 256)   % 256;
                _paz =  _paw           % 256;
                set_pen_color _pax * 65536 + _pay * 256 + _paz;
                goto (_pau - 160), (120 - _pav);
                pen_down;
                pen_up;
                _pau = _pau + 1;
            }
            _pav = _pav + 1;
        }
    }
}

# ─── memory.gs ──────────────────────────────────────────────
# memory.gs — RAM + MMIO dispatch
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
list _pbw;

# ── Scratch has no byte arrays so we pack 4 bytes per word ───────────────────
# word index = (addr - RAM_BASE) // 4 + 1
# byte lane  = (addr - RAM_BASE) % 4      (0=LSB ... 3=MSB, little-endian)

%define RAM_IDX(ADDR)   (((ADDR) - RAM_BASE) // 4 + 1)
%define RAM_LANE(ADDR)  (((ADDR) - RAM_BASE) % 4)
%define LANE_SHIFT(L)   (POW2((L) * 8))
%define LANE_MASK(L)    (255 * LANE_SHIFT(L))

# ── Temp vars ─────────────────────────────────────────────────────────────────
    var _pbd = 0;
    var _pbe = 0;
    var _pbf = 0;
    var _pbg = 0;
    var _pbh = 0;
    var _pbi = 0;
    var _pbj = 0;

# ── Init: allocate 64MB as zeroed word list ───────────────────────────────────
proc mem_init {
    delete _pbw;
    # We can't literally push 16M items at init time — instead we rely on
    # Turbowarp's list auto-grow. Pre-fill with a smaller sentinel and let
    # reads to uninitialised addresses return 0 via bounds check.
    # Kernel loader will explicitly write every word of the kernel image.
    repeat 16777216 {
        add 0 to _pbw;
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# MMIO router — called by all reads/writes before touching RAM
# Returns 1 in mem_is_mmio if handled, 0 if should fall through to RAM
# ─────────────────────────────────────────────────────────────────────────────
    var _pbk = 0;

proc mmio_read addr {
    _pbk = 1;
    if $addr >= UART_BASE and $addr < UART_BASE + 0x100 {
        uart_read $addr - UART_BASE;
    } elif $addr >= CLINT_BASE and $addr < CLINT_BASE + 0x10000 {
        clint_read $addr - CLINT_BASE;
    } elif $addr >= FB_BASE and $addr < FB_BASE + (FB_WIDTH * FB_HEIGHT * 4) {
        fb_read $addr - FB_BASE;
    } else {
        mem_result = 0;
        _pbk = 0;
    }
}

proc mmio_write addr, val {
    _pbk = 1;
    if $addr >= UART_BASE and $addr < UART_BASE + 0x100 {
        uart_write $addr - UART_BASE, $val;
    } elif $addr >= CLINT_BASE and $addr < CLINT_BASE + 0x10000 {
        clint_write $addr - CLINT_BASE, $val;
    } elif $addr >= FB_BASE and $addr < FB_BASE + (FB_WIDTH * FB_HEIGHT * 4) {
        fb_write $addr - FB_BASE, $val;
    } else {
        _pbk = 0;
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# WORD read/write (4 bytes, little-endian, naturally aligned)
# ─────────────────────────────────────────────────────────────────────────────
proc mem_read_word addr {
    mmio_read $addr;
    if not _pbk {
        _pbg = RAM_IDX($addr);
        if _pbg >= 1 and _pbg <= 16777216 {
            mem_result = _pbw[_pbg];
        } else {
            mem_result = 0;
        }
    }
}

proc mem_write_word addr, val {
    mmio_write $addr, $val;
    if not _pbk {
        _pbg = RAM_IDX($addr);
        if _pbg >= 1 and _pbg <= 16777216 {
            _pbw[_pbg] = MASK32($val);
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# BYTE read/write — extract/insert into the packed word
# ─────────────────────────────────────────────────────────────────────────────
proc mem_read_byte addr {
    mmio_read $addr;
    if not _pbk {
        _pbg  = RAM_IDX($addr);
        _pbh = RAM_LANE($addr);
        if _pbg >= 1 and _pbg <= 16777216 {
            _pbf  = _pbw[_pbg];
            _pbj = LANE_SHIFT(_pbh);
            mem_result = (_pbf // _pbj) % 256;
        } else {
            mem_result = 0;
        }
    }
}

proc mem_write_byte addr, val {
    mmio_write $addr, $val;
    if not _pbk {
        _pbg  = RAM_IDX($addr);
        _pbh = RAM_LANE($addr);
        if _pbg >= 1 and _pbg <= 16777216 {
            _pbf  = _pbw[_pbg];
            _pbj = LANE_SHIFT(_pbh);
            # Clear the target byte lane then insert new byte
            _pbf  = _pbf - ((_pbf // _pbj) % 256) * _pbj;
            _pbf  = _pbf + ($val % 256) * _pbj;
            _pbw[_pbg] = _pbf;
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# HALFWORD read/write (2 bytes, little-endian)
# ─────────────────────────────────────────────────────────────────────────────
proc mem_read_half addr {
    mmio_read $addr;
    if not _pbk {
        _pbg  = RAM_IDX($addr);
        _pbh = RAM_LANE($addr);
        if _pbg >= 1 and _pbg <= 16777216 {
            _pbf   = _pbw[_pbg];
            _pbj  = LANE_SHIFT(_pbh);
            mem_result = (_pbf // _pbj) % 65536;
        } else {
            mem_result = 0;
        }
    }
}

proc mem_write_half addr, val {
    mmio_write $addr, $val;
    if not _pbk {
        _pbg  = RAM_IDX($addr);
        _pbh = RAM_LANE($addr);
        if _pbg >= 1 and _pbg <= 16777216 {
            _pbf  = _pbw[_pbg];
            _pbj = LANE_SHIFT(_pbh);
            _pbf  = _pbf - ((_pbf // _pbj) % 65536) * _pbj;
            _pbf  = _pbf + ($val % 65536) * _pbj;
            _pbw[_pbg] = _pbf;
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Atomic helpers (A-extension: LR.W / SC.W / AMOSWAP etc.)
# Single-core so we can fake atomics — no reservation tracking needed
# ─────────────────────────────────────────────────────────────────────────────
    var _pbl = 0;
    var _pbm = 0;
    var _pbn = 0;
    var _pbo = 0;
    var _pbp = 0;

proc _pbx {
    # opcode 0x2F, funct3=0x2 (word), funct5 = BITS(insn,31,27)
    _pbn = BITS(insn, 31, 27);
    addr = MASK32(rs1v);

    if _pbn == 0x02 {                      # LR.W — load reserved
        mem_read_word addr;
        reg_write rd, mem_result;

    } elif _pbn == 0x03 {              # SC.W — store conditional (always succeed)
        mem_write_word addr, rs2v;
        reg_write rd, 0;                   # 0 = success

    } elif _pbn == 0x01 {              # AMOSWAP.W
        mem_read_word addr;
        _pbl = mem_result;
        mem_write_word addr, rs2v;
        reg_write rd, _pbl;

    } elif _pbn == 0x00 {              # AMOADD.W
        mem_read_word addr;
        _pbl = mem_result;
        mem_write_word addr, MASK32(_pbl + rs2v);
        reg_write rd, _pbl;

    } elif _pbn == 0x04 {              # AMOXOR.W
        mem_read_word addr;
        _pbl = mem_result;
        bitwise_xor _pbl, rs2v;
        mem_write_word addr, result;
        reg_write rd, _pbl;

    } elif _pbn == 0x08 {              # AMOOR.W
        mem_read_word addr;
        _pbl = mem_result;
        bitwise_or _pbl, rs2v;
        mem_write_word addr, result;
        reg_write rd, _pbl;

    } elif _pbn == 0x0C {              # AMOAND.W
        mem_read_word addr;
        _pbl = mem_result;
        bitwise_and _pbl, rs2v;
        mem_write_word addr, result;
        reg_write rd, _pbl;

    } elif _pbn == 0x10 {              # AMOMIN.W (signed)
        mem_read_word addr;
        _pbl = mem_result;
        _pbo = _pbl - BIT(31, _pbl) * POW2(32);
        _pbp = rs2v    - BIT(31, rs2v)    * POW2(32);
        if _pbo < _pbp { mem_write_word addr, _pbl; }
        else        { mem_write_word addr, rs2v;   }
        reg_write rd, _pbl;

    } elif _pbn == 0x14 {              # AMOMAX.W (signed)
        mem_read_word addr;
        _pbl = mem_result;
        _pbo = _pbl - BIT(31, _pbl) * POW2(32);
        _pbp = rs2v    - BIT(31, rs2v)    * POW2(32);
        if _pbo > _pbp { mem_write_word addr, _pbl; }
        else        { mem_write_word addr, rs2v;   }
        reg_write rd, _pbl;

    } elif _pbn == 0x18 {              # AMOMINU.W
        mem_read_word addr;
        _pbl = mem_result;
        if _pbl < rs2v { mem_write_word addr, _pbl; }
        else               { mem_write_word addr, rs2v;   }
        reg_write rd, _pbl;

    } elif _pbn == 0x1C {              # AMOMAXU.W
        mem_read_word addr;
        _pbl = mem_result;
        if _pbl > rs2v { mem_write_word addr, _pbl; }
        else               { mem_write_word addr, rs2v;   }
        reg_write rd, _pbl;
    }
    pc = pc + 4;
}

# ─────────────────────────────────────────────────────────────────────────────
# Kernel loader — writes the kernel binary (stored as a list of bytes
# in `rom`) into RAM starting at RAM_BASE (0x80000000)
# rom[] is populated at compile time from the binary blob
# ─────────────────────────────────────────────────────────────────────────────
    var _pbq = 0;
    var _pbr = 0;
    var _pbs = 0;
    var _pbt = 0;
    var _pbu = 0;
    var _pbv = 0;

proc load_kernel {
    _pbq = 1;
    # Pack every 4 bytes of rom into one ram word (little-endian)
    repeat (length(rom) // 4) {
        _pbs = rom[_pbq];
        _pbt = rom[_pbq + 1];
        _pbu = rom[_pbq + 2];
        _pbv = rom[_pbq + 3];
        _pbr = _pbs + (_pbt * 256) + (_pbu * 65536) + (_pbv * 16777216);
        _pbw[((_pbq - 1) // 4) + 1] = _pbr;
        _pbq = _pbq + 4;
    }
}

# ─── uart.gs ────────────────────────────────────────────────
# uart.gs — 16550-compatible UART at MMIO offset 0x10000000
# Linux writes characters to offset 0 (THR register) to print to console
# We accumulate into uart_buf and display it

    var _pby = 0;
    var _pbz = 0;
    var _pca = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

proc uart_init {
    _pby = "";
}

proc uart_read offset {
    # LSR register at offset 5 — bit 5 = TX empty, bit 0 = RX ready
    # Always report TX empty (0x60) so Linux doesn't stall waiting to send
    # Report RX not ready (no input) — input handled separately
    if $offset == 5 {
        mem_result = 0x60;
    } else {
        mem_result = 0;
    }
}

proc uart_write offset, val {
    if $offset == 0 {
        # THR — transmit holding register, this is the character output
        _pbz = $val % 128;   # mask to ASCII
        if _pbz == 10 {
            # Newline — flush the buffer to screen and clear
            say _pby;
            _pby = "";
        } elif _pbz == 13 {
            # Carriage return — ignore, Linux sends \r\n sometimes
        } elif _pbz >= 32 {
            # Printable ASCII — append to buffer
            _pby = _pby & _pca[_pbz - 31];
        }
    }
    # Other offsets (IER, FCR, LCR, MCR) — silently ignore
}

# ─── stage.gs ───────────────────────────────────────────────

costumes "blank.svg";

list rom "rom.txt";

onflag {
    cpu_init;
    mem_init;
    uart_init;
    clint_init;
    fb_init;
    load_kernel;
    forever {
        repeat 500 {
            cpu_step;
            cycle += 1;
        }
        fb_flush;
    }
}

