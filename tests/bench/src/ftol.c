// Float/integer conversion as game code does it: truncating casts (FNSTCW/
// FLDCW/FISTP sequences), rounding conversions (FISTP), integer loads (FILD).
#include "../lib/bench.h"
static float samples[4096];
static i32 ints[4096];
NOINLINE static u32 quantize(u32 count)
{
    u32 h = 0;
    for(u32 i = 0; i < count; i++) {
        i32 t = (i32)samples[i];
        i32 r = __builtin_lrintf(samples[i] * 0.5f);
        ints[i] = t + r;
        h += t ^ r;
    }
    return h;
}
NOINLINE static float accumulate(u32 count)
{
    float sum = 0;
    for(u32 i = 0; i < count; i++) sum += (float)ints[i] * 0.125f + (float)(short)i;
    return sum;
}
u32 bench_main(u32 n)
{
    for(u32 i = 0; i < 4096; i++) samples[i] = (i32)(i * 2654435761u >> 16) * 0.37f - 30000.0f;
    u32 h = 0;
    for(u32 i = 0; i < n; i++) {
        h = mix(h, quantize(4096));
        float s = accumulate(4096);
        h = mix(h, (u32)(i32)(s * 0.001f));
        samples[i & 4095] += 1.5f;
    }
    return h;
}
