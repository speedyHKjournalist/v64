// SSE2 packed integer image processing: saturating adds, averages, byte
// shuffles via unpack, multiply-add and sum of absolute differences.
#include "../lib/bench.h"
#include <emmintrin.h>
static __m128i image[8192], reference[8192];
NOINLINE static u32 process(u32 count)
{
    __m128i sad = _mm_setzero_si128(), acc = _mm_setzero_si128();
    const __m128i zero = _mm_setzero_si128(), weights = _mm_set1_epi16(3);
    for(u32 i = 0; i < count; i++) {
        __m128i a = image[i], b = reference[i];
        __m128i blended = _mm_avg_epu8(_mm_adds_epu8(a, b), a);
        __m128i lo = _mm_unpacklo_epi8(blended, zero), hi = _mm_unpackhi_epi8(blended, zero);
        acc = _mm_add_epi32(acc, _mm_madd_epi16(_mm_add_epi16(lo, hi), weights));
        sad = _mm_add_epi64(sad, _mm_sad_epu8(a, b));
        image[i] = _mm_packus_epi16(_mm_srli_epi16(lo, 1), _mm_srli_epi16(hi, 1));
    }
    acc = _mm_add_epi32(acc, _mm_shuffle_epi32(acc, 0x4E));
    acc = _mm_add_epi32(acc, _mm_shuffle_epi32(acc, 0xB1));
    return _mm_cvtsi128_si32(acc) ^ _mm_cvtsi128_si32(sad) ^ _mm_cvtsi128_si32(_mm_srli_si128(sad, 8));
}
u32 bench_main(u32 n)
{
    u32 seed = 21;
    for(u32 i = 0; i < 8192; i++) {
        image[i] = _mm_set_epi32(lcg(&seed), lcg(&seed), lcg(&seed), lcg(&seed));
        reference[i] = _mm_set_epi32(lcg(&seed), lcg(&seed), lcg(&seed), lcg(&seed));
    }
    u32 h = 0;
    for(u32 i = 0; i < n; i++) h = mix(h, process(8192));
    return h;
}
