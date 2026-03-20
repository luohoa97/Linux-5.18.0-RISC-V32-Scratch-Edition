# uart.gs — 16550-compatible UART at MMIO offset 0x10000000
# import mem_result from "cpu.gs"
# export uart_init, uart_read, uart_write
# Linux writes characters to offset 0 (THR register) to print to console
# We accumulate into uart_buf and display it

    var uart_buf = 0;
    var uart_char = 0;
    var uart_lookup = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

proc uart_init {
    uart_buf = "";
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
        uart_char = $val % 128;   # mask to ASCII
        if uart_char == 10 {
            # Newline — flush the buffer to screen and clear
            say uart_buf;
            uart_buf = "";
        } elif uart_char == 13 {
            # Carriage return — ignore, Linux sends \r\n sometimes
        } elif uart_char >= 32 {
            # Printable ASCII — append to buffer
            uart_buf = uart_buf & uart_lookup[uart_char - 31];
        }
    }
    # Other offsets (IER, FCR, LCR, MCR) — silently ignore
}