# clint.gs — RISC-V CLINT (Core Local Interruptor)
# import csr_mip, csr_mstatus, csr_mie, take_trap, bitwise_and, bitwise_or from "cpu.gs"
# export clint_init, clint_read, clint_write, clint_tick
# Bundled before cpu.gs — duplicate MASK32 for this module only
%define MASK32(V) ((V) % 4294967296)
# Base: 0x02000000
# mtime     at offset 0xBFF8 (64-bit, lo word at 0xBFF8, hi at 0xBFFC)
# mtimecmp  at offset 0x4000 (64-bit, lo at 0x4000, hi at 0x4004)
# Linux compares mtime >= mtimecmp to fire a timer interrupt (cause 0x80000007)

    var clint_mtime_lo = 0;
    var clint_mtime_hi = 0;
    var clint_mtimecmp_lo = 0;
    var clint_mtimecmp_hi = 0;
    var clint_ticks = 0;
    var clint_mie_bit = 0;
    var clint_mtie_bit = 0;

%define CLINT_TICKS_PER_STEP 100   # increment mtime by this per cpu_step call

proc clint_init {
    clint_mtime_lo    = 0;
    clint_mtime_hi    = 0;
    clint_mtimecmp_lo = 0xFFFFFFFF;
    clint_mtimecmp_hi = 0xFFFFFFFF;
    clint_ticks       = 0;
}

proc clint_read offset {
    if $offset == 0xBFF8 { mem_result = clint_mtime_lo; }
    elif $offset == 0xBFFC { mem_result = clint_mtime_hi; }
    elif $offset == 0x4000 { mem_result = clint_mtimecmp_lo; }
    elif $offset == 0x4004 { mem_result = clint_mtimecmp_hi; }
    else { mem_result = 0; }
}

proc clint_write offset, val {
    if $offset == 0x4000 {
        clint_mtimecmp_lo = MASK32($val);
        # Writing mtimecmp clears the pending timer interrupt
        bitwise_and csr_mip, 0xFFFFFF7F;
        csr_mip = result;
    } elif $offset == 0x4004 {
        clint_mtimecmp_hi = MASK32($val);
    } elif $offset == 0xBFF8 {
        clint_mtime_lo = MASK32($val);
    } elif $offset == 0xBFFC {
        clint_mtime_hi = MASK32($val);
    }
}

proc clint_tick {
    # Advance mtime every cpu step
    clint_mtime_lo = clint_mtime_lo + CLINT_TICKS_PER_STEP;
    if clint_mtime_lo >= 0x100000000 {
        clint_mtime_lo = clint_mtime_lo - 0x100000000;
        clint_mtime_hi = clint_mtime_hi + 1;
    }

    # Check if mtime >= mtimecmp → fire timer interrupt
    if clint_mtime_hi > clint_mtimecmp_hi {
        fire_timer_interrupt;
    } elif clint_mtime_hi == clint_mtimecmp_hi {
        if clint_mtime_lo >= clint_mtimecmp_lo {
            fire_timer_interrupt;
        }
    }
}

proc fire_timer_interrupt {
    # Set MTIP bit (bit 7) in mip
    bitwise_or csr_mip, 0x80;
    csr_mip = result;

    # Only take interrupt if MIE bit set in mstatus and MTIE bit set in mie
    bitwise_and csr_mstatus, 0x8;
    clint_mie_bit = result;
    bitwise_and csr_mie, 0x80;
    clint_mtie_bit = result;

    if clint_mie_bit and clint_mtie_bit {
        take_trap 0x80000007, 0;  # cause 7 = machine timer interrupt
    }
}