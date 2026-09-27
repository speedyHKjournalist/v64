// MMX pixel blending (PUNPCKLBW/PMULLW/PADDW/PSRLW/PACKUSWB) and packed
// arithmetic with EMMS between passes, like DirectDraw-era software paths.
#include "../lib/bench.h"
#include <mmintrin.h>
static __m64 source[8192], destination[8192];
NOINLINE static u32 blend(u32 count, int alpha)
{
    const __m64 zero = _mm_setzero_si64(), a = _mm_set1_pi16(alpha), ia = _mm_set1_pi16(256 - alpha);
    __m64 total = _mm_setzero_si64();
    for(u32 i = 0; i < count; i++) {
        __m64 s = source[i], d = destination[i];
        __m64 lo = _mm_srli_pi16(_mm_add_pi16(_mm_mullo_pi16(_mm_unpacklo_pi8(s, zero), a), _mm_mullo_pi16(_mm_unpacklo_pi8(d, zero), ia)), 8);
        __m64 hi = _mm_srli_pi16(_mm_add_pi16(_mm_mullo_pi16(_mm_unpackhi_pi8(s, zero), a), _mm_mullo_pi16(_mm_unpackhi_pi8(d, zero), ia)), 8);
        __m64 r = _mm_packs_pu16(lo, hi);
        destination[i] = r;
        total = _mm_add_pi32(total, _mm_madd_pi16(lo, hi));
    }
    u32 h = _mm_cvtsi64_si32(total) ^ _mm_cvtsi64_si32(_mm_srli_si64(total, 32));
    _mm_empty();
    return h;
}
u32 bench_main(u32 n)
{
    u32 seed = 77;
    for(u32 i = 0; i < 8192; i++) { source[i] = _mm_set_pi32(lcg(&seed), lcg(&seed)); destination[i] = _mm_set_pi32(lcg(&seed), lcg(&seed)); }
    _mm_empty();
    u32 h = 0;
    for(u32 i = 0; i < n; i++) h = mix(h, blend(8192, 32 + (i & 127)));
    return h;
}
