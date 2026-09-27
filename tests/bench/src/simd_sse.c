// Packed single-precision SSE: batched vertex transforms, dot products and
// reciprocal square roots (MOVAPS/MULPS/ADDPS/SHUFPS/RSQRTPS).
#include "../lib/bench.h"
#include <xmmintrin.h>
static __m128 positions[4096], normals[4096], results[4096];
NOINLINE static void transform(const __m128 rows[4], u32 count)
{
    for(u32 i = 0; i < count; i++) {
        __m128 v = positions[i];
        __m128 x = _mm_shuffle_ps(v, v, 0x00), y = _mm_shuffle_ps(v, v, 0x55), z = _mm_shuffle_ps(v, v, 0xAA), w = _mm_shuffle_ps(v, v, 0xFF);
        __m128 r = _mm_add_ps(_mm_add_ps(_mm_mul_ps(rows[0], x), _mm_mul_ps(rows[1], y)), _mm_add_ps(_mm_mul_ps(rows[2], z), _mm_mul_ps(rows[3], w)));
        __m128 n = normals[i];
        __m128 d = _mm_mul_ps(n, n);
        d = _mm_add_ps(d, _mm_shuffle_ps(d, d, 0x4E));
        d = _mm_add_ps(d, _mm_shuffle_ps(d, d, 0xB1));
        results[i] = _mm_add_ps(r, _mm_mul_ps(n, _mm_rsqrt_ps(_mm_max_ps(d, _mm_set1_ps(1e-6f)))));
    }
}
u32 bench_main(u32 n)
{
    for(u32 i = 0; i < 4096; i++) {
        positions[i] = _mm_set_ps(1.0f, (float)(i & 63), (float)(i >> 6), (float)i * 0.5f);
        normals[i] = _mm_set_ps(0.0f, 1.0f, (float)(i & 3), 0.5f);
    }
    __m128 rows[4] = { _mm_set_ps(0, 0, 0.1f, 1), _mm_set_ps(0, 0.1f, 1, 0), _mm_set_ps(0, 1, 0, 0.1f), _mm_set_ps(1, 0, 0, 0) };
    u32 h = 0;
    for(u32 i = 0; i < n; i++) {
        transform(rows, 4096);
        float lane[4];
        _mm_storeu_ps(lane, results[i & 4095]);
        h = mix(h, (u32)(i32)(lane[0] * 256.0f + lane[1]));
        rows[0] = _mm_add_ps(rows[0], _mm_set1_ps(0.001f));
    }
    return h;
}
