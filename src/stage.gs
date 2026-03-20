# import cpu_init, cpu_step, cycle from "cpu.gs"
# import mem_init, load_kernel from "memory.gs"
# import uart_init from "uart.gs"
# import clint_init from "clint.gs"
# import fb_init, fb_flush from "fb.gs"

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
