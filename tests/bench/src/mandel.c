// Mandelbrot set escape iterations in double precision (tight dependent
// multiply/add chains and a compare per iteration).
#include "../lib/bench.h"
u32 bench_main(u32 n)
{
    u32 h = 0;
    for(u32 frame = 0; frame < n; frame++) {
        double zoom = 1.0 / (1 + frame % 8);
        for(int y = 0; y < 48; y++)
            for(int x = 0; x < 64; x++) {
                double cr = -0.75 + (x - 32) * 0.05 * zoom, ci = 0.1 + (y - 24) * 0.05 * zoom, zr = 0, zi = 0;
                int k = 0;
                while(k < 64 && zr * zr + zi * zi < 4.0) { double t = zr * zr - zi * zi + cr; zi = 2 * zr * zi + ci; zr = t; k++; }
                h = mix(h, k);
            }
    }
    return h;
}
