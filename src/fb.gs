# fb.gs — Framebuffer at 0x20000000
# import mem_result from "cpu.gs"
# export fb_init, fb_read, fb_write, fb_flush
# 320x240 pixels, 32bpp ARGB packed as a single integer per word
# Linux writes pixel data here; we flush to screen via pen each frame

%define FB_WIDTH   320
%define FB_HEIGHT  240
%define FB_PIXELS  76800   # 320 * 240

list fb_buf;   # one word per pixel, 0xAARRGGBB
    var fb_x = 0;
    var fb_y = 0;
    var fb_pixel = 0;
    var fb_r = 0;
    var fb_g = 0;
    var fb_b = 0;
    var fb_idx = 0;
    var fb_dirty = 0;

proc fb_init {
    delete fb_buf;
    repeat FB_PIXELS {
        add 0 to fb_buf;
    }
    fb_dirty = 0;
    erase_all;
}

proc fb_read offset {
    fb_idx = $offset // 4 + 1;
    if fb_idx >= 1 and fb_idx <= FB_PIXELS {
        mem_result = fb_buf[fb_idx];
    } else {
        mem_result = 0;
    }
}

proc fb_write offset, val {
    fb_idx = $offset // 4 + 1;
    if fb_idx >= 1 and fb_idx <= FB_PIXELS {
        fb_buf[fb_idx] = MASK32($val);
        fb_dirty = 1;
    }
}

# Call this from main loop — flushes fb_buf to screen using pen
# Turbowarp pen is the only way to draw arbitrary pixels in Scratch
# Each pixel: move to (x, y), set pen color, stamp dot
proc fb_flush {
    if fb_dirty {
        fb_dirty = 0;
        erase_all;
        set_pen_size 1;
        fb_y = 0;
        repeat FB_HEIGHT {
            fb_x = 0;
            repeat FB_WIDTH {
                fb_idx = fb_y * FB_WIDTH + fb_x + 1;
                fb_pixel = fb_buf[fb_idx];
                # Extract R, G, B from 0xAARRGGBB
                fb_r = (fb_pixel // 65536) % 256;
                fb_g = (fb_pixel // 256)   % 256;
                fb_b =  fb_pixel           % 256;
                set_pen_color fb_r * 65536 + fb_g * 256 + fb_b;
                goto (fb_x - 160), (120 - fb_y);
                pen_down;
                pen_up;
                fb_x = fb_x + 1;
            }
            fb_y = fb_y + 1;
        }
    }
}