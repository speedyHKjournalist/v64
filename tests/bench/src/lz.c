// xz-like: LZ77 compression with hash chains, then decompression and
// round-trip verification (byte loops, table lookups, data-dependent branches).
#include "../lib/bench.h"
#define SIZE 65536
static u8 input[SIZE], packed[SIZE * 2], output[SIZE];
static u16 head[4096], chain[SIZE];
NOINLINE static void make_input(u32 seed)
{
    for(u32 i = 0; i < SIZE; i++) {
        u32 r = lcg(&seed);
        input[i] = (r >> 30) ? input[i >= 64 ? i - 1 - ((r >> 8) & 63) : i] + (r >> 29 & 1) : r >> 24;
    }
}
NOINLINE static u32 compress(void)
{
    u32 out = 0;
    for(u32 i = 0; i < 4096; i++) head[i] = 0xFFFF;
    for(u32 i = 0; i < SIZE;) {
        u32 best = 0, distance = 0;
        if(i + 3 < SIZE) {
            u32 h = (input[i] << 4 ^ input[i + 1] << 2 ^ input[i + 2]) & 4095;
            u32 candidate = head[h], tries = 16;
            while(candidate != 0xFFFF && tries-- && i - candidate < 32768) {
                u32 len = 0;
                while(len < 255 && i + len < SIZE && input[candidate + len] == input[i + len]) len++;
                if(len > best) { best = len; distance = i - candidate; }
                candidate = chain[candidate];
            }
            chain[i] = head[h]; head[h] = i;
        }
        if(best >= 4) {
            packed[out++] = 0xFF; packed[out++] = best; packed[out++] = distance; packed[out++] = distance >> 8;
            for(u32 k = 1; k < best && i + k + 3 < SIZE; k++) {
                u32 h = (input[i + k] << 4 ^ input[i + k + 1] << 2 ^ input[i + k + 2]) & 4095;
                chain[i + k] = head[h]; head[h] = i + k;
            }
            i += best;
        }
        else {
            if(input[i] == 0xFF) packed[out++] = 0xFF, packed[out++] = 0;
            else packed[out++] = input[i];
            i++;
        }
    }
    return out;
}
NOINLINE static u32 decompress(u32 length)
{
    u32 out = 0;
    for(u32 i = 0; i < length;) {
        u8 b = packed[i++];
        if(b != 0xFF) { output[out++] = b; continue; }
        u32 len = packed[i++];
        if(!len) { output[out++] = 0xFF; continue; }
        u32 distance = packed[i] | packed[i + 1] << 8;
        i += 2;
        for(u32 k = 0; k < len; k++, out++) output[out] = output[out - distance];
    }
    return out;
}
u32 bench_main(u32 n)
{
    u32 h = 0;
    for(u32 i = 0; i < n; i++) {
        make_input(i + 1);
        u32 length = compress();
        u32 restored = decompress(length);
        h = mix(mix(h, length), restored == SIZE && !memcmp(input, output, SIZE));
    }
    return h;
}
