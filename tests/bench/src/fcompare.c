// Branchy float code built for i586 (FCOM/FCOMP + FNSTSW AX + SAHF/TEST, no
// FCOMI/FCMOV): clamping, min/max and bounding-box tests like 2004-era games.
#include "../lib/bench.h"
typedef struct { float x, y, z; } vec3;
static vec3 points[2048];
NOINLINE static u32 cull(const vec3 *lo, const vec3 *hi, u32 count)
{
    u32 inside = 0;
    for(u32 i = 0; i < count; i++) {
        const vec3 *p = &points[i];
        if(p->x < lo->x || p->x > hi->x) continue;
        if(p->y < lo->y || p->y > hi->y) continue;
        if(p->z >= lo->z && p->z <= hi->z) inside++;
    }
    return inside;
}
NOINLINE static float clamp_sum(u32 count)
{
    float sum = 0, best = -1e30f;
    for(u32 i = 0; i < count; i++) {
        float v = points[i].x - points[i].y;
        if(v < -100.0f) v = -100.0f;
        else if(v > 100.0f) v = 100.0f;
        if(v > best) best = v;
        sum += v;
    }
    return sum + best;
}
u32 bench_main(u32 n)
{
    u32 seed = 11;
    for(u32 i = 0; i < 2048; i++) {
        points[i].x = (i32)(lcg(&seed) >> 16) - 32768.0f;
        points[i].y = (i32)(lcg(&seed) >> 16) - 32768.0f;
        points[i].z = (i32)(lcg(&seed) >> 16) - 32768.0f;
    }
    u32 h = 0;
    for(u32 i = 0; i < n; i++) {
        vec3 lo = { -20000.0f + i, -15000.0f, -30000.0f }, hi = { 20000.0f, 15000.0f + i, 10000.0f };
        h = mix(h, cull(&lo, &hi, 2048));
        h = mix(h, (u32)(i32)clamp_sum(2048));
    }
    return h;
}
