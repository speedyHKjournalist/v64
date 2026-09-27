// Game-style single-precision math: 4x4 matrix products and transforming
// vertex arrays (built for both x87 and SSE scalar code generation).
#include "../lib/bench.h"
typedef struct { float m[4][4]; } mat4;
typedef struct { float x, y, z, w; } vec4;
static vec4 vertices[4096], out[4096];
NOINLINE static void multiply(mat4 *r, const mat4 *a, const mat4 *b)
{
    for(int i = 0; i < 4; i++)
        for(int j = 0; j < 4; j++)
            r->m[i][j] = a->m[i][0] * b->m[0][j] + a->m[i][1] * b->m[1][j] + a->m[i][2] * b->m[2][j] + a->m[i][3] * b->m[3][j];
}
NOINLINE static void transform(const mat4 *m, const vec4 *in, vec4 *o, u32 count)
{
    for(u32 i = 0; i < count; i++) {
        vec4 v = in[i];
        o[i].x = m->m[0][0] * v.x + m->m[0][1] * v.y + m->m[0][2] * v.z + m->m[0][3] * v.w;
        o[i].y = m->m[1][0] * v.x + m->m[1][1] * v.y + m->m[1][2] * v.z + m->m[1][3] * v.w;
        o[i].z = m->m[2][0] * v.x + m->m[2][1] * v.y + m->m[2][2] * v.z + m->m[2][3] * v.w;
        o[i].w = m->m[3][0] * v.x + m->m[3][1] * v.y + m->m[3][2] * v.z + m->m[3][3] * v.w;
    }
}
u32 bench_main(u32 n)
{
    mat4 a, b, r;
    for(int i = 0; i < 4; i++)
        for(int j = 0; j < 4; j++) { a.m[i][j] = (i == j) + 0.01f * (i + j); b.m[i][j] = (i == j) - 0.02f * (i - j); }
    for(u32 i = 0; i < 4096; i++) { vertices[i].x = i * 0.5f; vertices[i].y = 1.0f - i * 0.25f; vertices[i].z = i & 7; vertices[i].w = 1.0f; }
    u32 h = 0;
    for(u32 i = 0; i < n; i++) {
        multiply(&r, &a, &b);
        a = r;
        transform(&r, vertices, out, 4096);
        h = mix(h, (u32)(i32)(out[i & 4095].x * 16.0f));
        if(i % 16 == 15) for(int p = 0; p < 4; p++) for(int q = 0; q < 4; q++) a.m[p][q] = (p == q) + 0.01f * (p - q);
    }
    return h;
}
