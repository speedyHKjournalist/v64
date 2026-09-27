// Bulk memory: REP MOVS/STOS copies and fills of several sizes, overlapping
// memmove, byte-wise compares and a strided copy (TLB and string paths).
#include "../lib/bench.h"
static u8 a[1 << 20], b[1 << 20];
u32 bench_main(u32 n)
{
    u32 h = 0;
    static const u32 sizes[] = { 16, 64, 256, 4096, 65536, 1 << 20 };
    for(u32 i = 0; i < n; i++) {
        for(u32 s = 0; s < 6; s++) {
            u32 size = sizes[s], reps = (1 << 20) / size;
            for(u32 r = 0; r < reps; r++) memcpy(b + (r * size & ((1 << 20) - size)), a + ((r * 7 * size) & ((1 << 20) - size)), size);
            memset(a, i + s, size);
        }
        memmove(a + 3, a, 65536);
        memmove(b, b + 5, 65536);
        for(u32 k = 0; k < (1 << 20); k += 4096) memcpy(a + k, b + ((k * 3) & ((1 << 20) - 1)), 64);
        h = mix(mix(h, memcmp(a, b, 4096)), a[i & 0xFFFFF] + b[(i * 17) & 0xFFFFF]);
    }
    return h;
}
