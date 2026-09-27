// n-body simulation in double precision: square roots and divisions in the
// inner loop (x87 and SSE2 scalar builds).
#include "../lib/bench.h"
#define BODIES 64
static double px[BODIES], py[BODIES], pz[BODIES], vx[BODIES], vy[BODIES], vz[BODIES], mass[BODIES];
NOINLINE static void step(double dt)
{
    for(int i = 0; i < BODIES; i++)
        for(int j = i + 1; j < BODIES; j++) {
            double dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
            double d2 = dx * dx + dy * dy + dz * dz + 0.01;
            double d = __builtin_sqrt(d2), f = dt / (d2 * d);
            vx[i] -= dx * mass[j] * f; vy[i] -= dy * mass[j] * f; vz[i] -= dz * mass[j] * f;
            vx[j] += dx * mass[i] * f; vy[j] += dy * mass[i] * f; vz[j] += dz * mass[i] * f;
        }
    for(int i = 0; i < BODIES; i++) { px[i] += dt * vx[i]; py[i] += dt * vy[i]; pz[i] += dt * vz[i]; }
}
u32 bench_main(u32 n)
{
    for(int i = 0; i < BODIES; i++) {
        px[i] = i * 1.5; py[i] = (i % 7) * 0.75; pz[i] = (i % 3) - 1.0;
        vx[i] = vy[i] = vz[i] = 0; mass[i] = 1.0 + (i & 3) * 0.25;
    }
    u32 h = 0;
    for(u32 i = 0; i < n; i++) {
        step(0.001);
        h = mix(h, (u32)(i32)(px[i % BODIES] * 1000.0));
    }
    return h;
}
