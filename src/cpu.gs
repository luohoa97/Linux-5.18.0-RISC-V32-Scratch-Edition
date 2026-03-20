# cpu.gs — RV32IMA CPU core
# Reference: CNLohr's mini-rv32ima, Its-Jakey's Linux-On-Scratch

# import mem_read_byte, mem_read_half, mem_read_word, mem_write_byte, mem_write_half, mem_write_word from "memory.gs"
# import clint_tick from "clint.gs"

# export cycle, mem_result

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

list reg;
    var pc = 0;
    var cycle = 0;

# ── CSR registers (minimal set Linux needs) ───────────────────────────────────
    var csr_mstatus = 0;
    var csr_mie = 0;
    var csr_mtvec = 0;
    var csr_mscratch = 0;
    var csr_mepc = 0;
    var csr_mcause = 0;
    var csr_mtval = 0;
    var csr_mip = 0;
    var csr_mhartid = 0;   # always 0

# ── Temp decode variables ─────────────────────────────────────────────────────
    var insn = 0;
    var opcode = 0;
    var rd = 0;
    var rs1 = 0;
    var rs2 = 0;
    var funct3 = 0;
    var funct7 = 0;
    var imm_i = 0;
    var imm_s = 0;
    var imm_b = 0;
    var imm_u = 0;
    var imm_j = 0;
    var rs1v = 0;
    var rs2v = 0;
    var result = 0;
    var addr = 0;
    var mem_tmp = 0;
    var trap = 0;

# ── Memory I/O result (set by mem_read / mem_write) ──────────────────────────
    var mem_result = 0;
    var exec_shamt = 0;
    var sys_csr_addr = 0;
    var sys_csr_old = 0;
    var sys_csr_new = 0;

# ── Init ──────────────────────────────────────────────────────────────────────
proc cpu_init {
    pc = 0x80000000;
    cycle = 0;
    csr_mstatus = 0;
    csr_mie = 0;
    csr_mtvec = 0;
    csr_mscratch = 0;
    csr_mepc = 0;
    csr_mcause = 0;
    csr_mtval = 0;
    csr_mip = 0;
    csr_mhartid = 0;
    delete reg;
    repeat 32 {
        add 0 to reg;
    }
}

# ── Register helpers ──────────────────────────────────────────────────────────
proc reg_read n {
    if $n == 0 {
        result = 0;
    } else {
        result = reg[$n + 1];
    }
}

proc reg_write n, val {
    if $n != 0 {
        reg[$n + 1] = MASK32($val);
    }
}

# ── Decode helpers ────────────────────────────────────────────────────────────
proc decode {
    opcode  = BITS(insn, 6, 0);
    rd      = BITS(insn, 11, 7);
    funct3  = BITS(insn, 14, 12);
    rs1     = BITS(insn, 19, 15);
    rs2     = BITS(insn, 24, 20);
    funct7  = BITS(insn, 31, 25);

    # I-type immediate
    imm_i = SEXT12(BITS(insn, 31, 20));

    # S-type immediate
    imm_s = SEXT12((BITS(insn, 31, 25) * 32) + BITS(insn, 11, 7));

    # B-type immediate
    imm_b = SEXT13(
        (BIT(31, insn) * 4096) +
        (BIT(7,  insn) * 2048) +
        (BITS(insn, 30, 25) * 64) +
        (BITS(insn, 11, 8)  * 2)
    );

    # U-type immediate
    imm_u = MASK32(BITS(insn, 31, 12) * 4096);

    # J-type immediate
    imm_j = SEXT21(
        (BIT(31, insn)      * 1048576) +
        (BITS(insn, 19, 12) * 4096) +
        (BIT(20, insn)      * 2048) +
        (BITS(insn, 30, 21) * 2)
    );
}

# ── Main execute loop (call this every frame or in a forever loop) ────────────
proc cpu_step {
    trap = 0;

    # Fetch
    mem_read_word pc;
    insn = mem_result;

    decode;

    reg_read rs1; rs1v = result;
    reg_read rs2; rs2v = result;

    # ── Opcode dispatch ───────────────────────────────────────────────────────

    if opcode == 0x37 {          # LUI
        reg_write rd, imm_u;
        pc = pc + 4;

    } elif opcode == 0x17 {   # AUIPC
        reg_write rd, MASK32(pc + imm_u);
        pc = pc + 4;

    } elif opcode == 0x6F {   # JAL
        reg_write rd, MASK32(pc + 4);
        pc = MASK32(pc + imm_j);

    } elif opcode == 0x67 {   # JALR
        result = MASK32(pc + 4);
        pc = MASK32((rs1v + imm_i) & 0xFFFFFFFE);
        reg_write rd, result;

    } elif opcode == 0x63 {   # BRANCH
        exec_branch;

    } elif opcode == 0x03 {   # LOAD
        exec_load;

    } elif opcode == 0x23 {   # STORE
        exec_store;

    } elif opcode == 0x13 {   # OP-IMM
        exec_op_imm;
        pc = pc + 4;

    } elif opcode == 0x33 {   # OP (RV32I + M-ext)
        exec_op;
        pc = pc + 4;

    } elif opcode == 0x0F {   # FENCE — no-op for single-core
        pc = pc + 4;

    } elif opcode == 0x73 {   # SYSTEM (CSR + ECALL + EBREAK + MRET)
        exec_system;

    } else {
        # Illegal instruction trap
        take_trap 2, insn;
    }

    # Timer interrupt check
    clint_tick;
}

# ── BRANCH ────────────────────────────────────────────────────────────────────
proc exec_branch {
    result = 0;
    if funct3 == 0 { if rs1v == rs2v { result = 1; } }   # BEQ
    if funct3 == 1 { if rs1v != rs2v { result = 1; } }   # BNE
    if funct3 == 4 {                                       # BLT (signed)
        if (rs1v - rs2v) > 2147483647 { result = 1; }
        if (rs1v < rs2v) and (rs1v < 2147483648) { result = 1; }
    }
    if funct3 == 5 {                                       # BGE (signed)
        if rs1v == rs2v { result = 1; }
        if (rs1v > rs2v) and (rs2v < 2147483648) { result = 1; }
    }
    if funct3 == 6 { if rs1v < rs2v { result = 1; } }    # BLTU
    if funct3 == 7 { if rs1v >= rs2v { result = 1; } }   # BGEU
    if result {
        pc = MASK32(pc + imm_b);
    } else {
        pc = pc + 4;
    }
}

# ── LOAD ──────────────────────────────────────────────────────────────────────
proc exec_load {
    addr = MASK32(rs1v + imm_i);
    if funct3 == 0 {             # LB
        mem_read_byte addr;
        reg_write rd, SEXT(mem_result, 8);
    } elif funct3 == 1 {      # LH
        mem_read_half addr;
        reg_write rd, SEXT(mem_result, 16);
    } elif funct3 == 2 {      # LW
        mem_read_word addr;
        reg_write rd, mem_result;
    } elif funct3 == 4 {      # LBU
        mem_read_byte addr;
        reg_write rd, mem_result;
    } elif funct3 == 5 {      # LHU
        mem_read_half addr;
        reg_write rd, mem_result;
    }
    pc = pc + 4;
}

# ── STORE ─────────────────────────────────────────────────────────────────────
proc exec_store {
    addr = MASK32(rs1v + imm_s);
    if funct3 == 0 { mem_write_byte addr, rs2v % 256; }
    if funct3 == 1 { mem_write_half addr, rs2v % 65536; }
    if funct3 == 2 { mem_write_word addr, rs2v; }
    pc = pc + 4;
}

# ── OP-IMM ────────────────────────────────────────────────────────────────────
proc exec_op_imm {
    exec_shamt = BITS(insn, 24, 20);
    if funct3 == 0 { reg_write rd, MASK32(rs1v + imm_i); }         # ADDI
    if funct3 == 1 { reg_write rd, MASK32(rs1v * POW2(exec_shamt)); }   # SLLI
    if funct3 == 2 {                                                  # SLTI
        if rs1v < 2147483648 and rs1v < MASK32(imm_i) {
            reg_write rd, 1;
        } elif rs1v >= 2147483648 and MASK32(imm_i) < 2147483648 {
            reg_write rd, 1;
        } else { reg_write rd, 0; }
    }
    if funct3 == 3 {                                                  # SLTIU
        if rs1v < MASK32(imm_i) { reg_write rd, 1; }
        else { reg_write rd, 0; }
    }
    if funct3 == 4 { reg_write rd, MASK32(rs1v) % (2 * MASK32(imm_i)) - MASK32(imm_i) * (MASK32(rs1v) >= MASK32(imm_i)); } # XORI — use mem xor helper
    if funct3 == 5 {
        if BIT(30, insn) {                                           # SRAI
            reg_write rd, MASK32((rs1v - (BIT(31,rs1v) * POW2(32))) // POW2(exec_shamt));
        } else {                                                     # SRLI
            reg_write rd, rs1v // POW2(exec_shamt);
        }
    }
    if funct3 == 6 { bitwise_or rs1v, MASK32(imm_i); reg_write rd, result; }   # ORI
    if funct3 == 7 { bitwise_and rs1v, MASK32(imm_i); reg_write rd, result; }  # ANDI
}

# ── OP (R-type + M-ext) ───────────────────────────────────────────────────────
proc exec_op {
    exec_shamt = rs2v % 32;
    if funct7 == 0x01 {
        # M extension
        if funct3 == 0 { reg_write rd, MASK32(rs1v * rs2v); }      # MUL
        if funct3 == 1 {                                              # MULH
            reg_write rd, ((rs1v - BIT(31,rs1v)*POW2(32)) * (rs2v - BIT(31,rs2v)*POW2(32))) // POW2(32);
        }
        if funct3 == 3 { reg_write rd, (rs1v * rs2v) // POW2(32); } # MULHU
        if funct3 == 4 {                                              # DIV
            if rs2v != 0 {
                reg_write rd, MASK32((rs1v - BIT(31,rs1v)*POW2(32)) // (rs2v - BIT(31,rs2v)*POW2(32)));
            } else { reg_write rd, 0xFFFFFFFF; }
        }
        if funct3 == 5 {                                              # DIVU
            if rs2v != 0 { reg_write rd, rs1v // rs2v; }
            else { reg_write rd, 0xFFFFFFFF; }
        }
        if funct3 == 6 {                                              # REM
            if rs2v != 0 {
                reg_write rd, MASK32((rs1v - BIT(31,rs1v)*POW2(32)) - ((rs1v - BIT(31,rs1v)*POW2(32)) // (rs2v - BIT(31,rs2v)*POW2(32))) * (rs2v - BIT(31,rs2v)*POW2(32)));
            } else { reg_write rd, rs1v; }
        }
        if funct3 == 7 {                                              # REMU
            if rs2v != 0 { reg_write rd, rs1v % rs2v; }
            else { reg_write rd, rs1v; }
        }
    } else {
        # Base RV32I R-type
        if funct3 == 0 {
            if BIT(30, insn) { reg_write rd, MASK32(rs1v - rs2v); } # SUB
            else { reg_write rd, MASK32(rs1v + rs2v); }              # ADD
        }
        if funct3 == 1 { reg_write rd, MASK32(rs1v * POW2(exec_shamt)); } # SLL
        if funct3 == 2 {                                                # SLT
            if rs1v < 2147483648 and rs1v < rs2v { reg_write rd, 1; }
            elif rs1v >= 2147483648 and rs2v < 2147483648 { reg_write rd, 1; }
            else { reg_write rd, 0; }
        }
        if funct3 == 3 {                                                # SLTU
            if rs1v < rs2v { reg_write rd, 1; }
            else { reg_write rd, 0; }
        }
        if funct3 == 4 { bitwise_xor rs1v, rs2v; reg_write rd, result; }    # XOR
        if funct3 == 5 {
            if BIT(30, insn) {                                         # SRA
                reg_write rd, MASK32((rs1v - BIT(31,rs1v)*POW2(32)) // POW2(exec_shamt));
            } else { reg_write rd, rs1v // POW2(exec_shamt); }            # SRL
        }
        if funct3 == 6 { bitwise_or rs1v, rs2v; reg_write rd, result; }     # OR
        if funct3 == 7 { bitwise_and rs1v, rs2v; reg_write rd, result; }    # AND
    }
}

# ── SYSTEM (CSR, ECALL, MRET) ─────────────────────────────────────────────────
proc exec_system {
    sys_csr_addr = BITS(insn, 31, 20);
    if funct3 == 0 {
        if insn == 0x00000073 {       # ECALL
            take_trap 8, 0;         # cause 8 = ecall from U-mode
        } elif insn == 0x30200073 { # MRET
            pc = csr_mepc;
            bitwise_and csr_mstatus, 0xFFFFFF7F; csr_mstatus = MASK32(result);
        } else {
            pc = pc + 4;
        }
    } else {
        # CSR instructions (CSRRW, CSRRS, CSRRC, CSRRWI, CSRRSI, CSRRCI)
        csr_read sys_csr_addr;
        sys_csr_old = result;
        sys_csr_new = 0;
        if funct3 == 1 { sys_csr_new = rs1v; }                           # CSRRW
        if funct3 == 2 { bitwise_or sys_csr_old, rs1v; sys_csr_new = result; }      # CSRRS
        if funct3 == 3 { bitwise_not rs1v; bitwise_and sys_csr_old, result; sys_csr_new = result; } # CSRRC
        if funct3 == 5 { sys_csr_new = rs1; }                            # CSRRWI (zimm)
        if funct3 == 6 { bitwise_or sys_csr_old, rs1; sys_csr_new = result; }       # CSRRSI
        if funct3 == 7 { bitwise_not rs1; bitwise_and sys_csr_old, result; sys_csr_new = result; } # CSRRCI
        reg_write rd, sys_csr_old;
        csr_write sys_csr_addr, sys_csr_new;
        pc = pc + 4;
    }
}

# ── CSR read/write ────────────────────────────────────────────────────────────
proc csr_read addr {
    if $addr == 0x300 { result = csr_mstatus; }
    elif $addr == 0x304 { result = csr_mie; }
    elif $addr == 0x305 { result = csr_mtvec; }
    elif $addr == 0x340 { result = csr_mscratch; }
    elif $addr == 0x341 { result = csr_mepc; }
    elif $addr == 0x342 { result = csr_mcause; }
    elif $addr == 0x343 { result = csr_mtval; }
    elif $addr == 0x344 { result = csr_mip; }
    elif $addr == 0xF14 { result = csr_mhartid; }
    elif $addr == 0xC00 or $addr == 0xB00 { result = cycle % POW2(32); }  # cycle/mcycle lo
    elif $addr == 0xC80 or $addr == 0xB80 { result = cycle // POW2(32); } # cycle/mcycle hi
    else { result = 0; }
}

proc csr_write addr, val {
    if $addr == 0x300 { csr_mstatus = MASK32($val); }
    elif $addr == 0x304 { csr_mie = MASK32($val); }
    elif $addr == 0x305 { csr_mtvec = MASK32($val); }
    elif $addr == 0x340 { csr_mscratch = MASK32($val); }
    elif $addr == 0x341 { csr_mepc = MASK32($val); }
    elif $addr == 0x342 { csr_mcause = MASK32($val); }
    elif $addr == 0x343 { csr_mtval = MASK32($val); }
    elif $addr == 0x344 { csr_mip = MASK32($val); }
}

# ── Trap handler ──────────────────────────────────────────────────────────────
proc take_trap cause, tval {
    csr_mepc = pc;
    csr_mcause = MASK32($cause);
    csr_mtval = MASK32($tval);
    bitwise_or csr_mstatus, 0x80; csr_mstatus = MASK32(result);  # set MPIE
    pc = csr_mtvec & 0xFFFFFFFC;               # jump to trap vector
}

# ── Bitwise helpers (Scratch has no native bitwise ops) ───────────────────────
# Uses the BIT macro to reconstruct results bit by bit
# We implement 32-bit AND/OR/XOR/NOT via the BIT extraction + reconstruction

    var bw_a = 0;
    var bw_b = 0;
    var bw_result = 0;
    var bw_i = 0;

proc bitwise_and a, b {
    bw_a = $a; bw_b = $b; bw_result = 0; bw_i = 0;
    repeat 32 {
        if BIT(bw_i, bw_a) and BIT(bw_i, bw_b) {
            bw_result = bw_result + POW2(bw_i);
        }
        bw_i = bw_i + 1;
    }
    result = bw_result;
}

proc bitwise_or a, b {
    bw_a = $a; bw_b = $b; bw_result = 0; bw_i = 0;
    repeat 32 {
        if BIT(bw_i, bw_a) or BIT(bw_i, bw_b) {
            bw_result = bw_result + POW2(bw_i);
        }
        bw_i = bw_i + 1;
    }
    result = bw_result;
}

proc bitwise_xor a, b {
    bw_a = $a; bw_b = $b; bw_result = 0; bw_i = 0;
    repeat 32 {
        if BIT(bw_i, bw_a) != BIT(bw_i, bw_b) {
            bw_result = bw_result + POW2(bw_i);
        }
        bw_i = bw_i + 1;
    }
    result = bw_result;
}

proc bitwise_not a {
    bw_a = $a; bw_result = 0; bw_i = 0;
    repeat 32 {
        if not BIT(bw_i, bw_a) {
            bw_result = bw_result + POW2(bw_i);
        }
        bw_i = bw_i + 1;
    }
    result = bw_result;
}