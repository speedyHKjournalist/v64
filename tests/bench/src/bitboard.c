// deepsjeng-like: 64-bit bitboard move generation on a 32-bit CPU (paired
// shifts/masks, bit scans, population counts) with a bounded recursive search.
#include "../lib/bench.h"
static inline u32 popcount64(u64 b) { u32 c = 0; while(b) { b &= b - 1; c++; } return c; }
static inline u32 lsb64(u64 b) { return (u32)b ? __builtin_ctz((u32)b) : 32 + __builtin_ctz((u32)(b >> 32)); }
static u64 knight_attacks(u64 b)
{
    const u64 a = 0xFEFEFEFEFEFEFEFEull, ab = 0xFCFCFCFCFCFCFCFCull, h = 0x7F7F7F7F7F7F7F7Full, gh = 0x3F3F3F3F3F3F3F3Full;
    return (b << 17 & a) | (b << 15 & h) | (b << 10 & ab) | (b << 6 & gh)
        | (b >> 17 & h) | (b >> 15 & a) | (b >> 10 & gh) | (b >> 6 & ab);
}
static u64 slide(u64 from, u64 occupied, int shift, u64 mask)
{
    u64 r = 0, b = from;
    for(;;) {
        b = shift > 0 ? b << shift & mask : b >> -shift & mask;
        if(!b) return r;
        r |= b;
        if(b & occupied) return r;
    }
}
static u64 rook_attacks(u64 b, u64 occupied)
{
    return slide(b, occupied, 8, ~0ull) | slide(b, occupied, -8, ~0ull)
        | slide(b, occupied, 1, 0xFEFEFEFEFEFEFEFEull) | slide(b, occupied, -1, 0x7F7F7F7F7F7F7F7Full);
}
NOINLINE static u32 search(u64 mine, u64 theirs, u32 depth)
{
    if(!depth) return popcount64(mine) * 3 - popcount64(theirs);
    u32 best = 0, tried = 0;
    u64 pieces = mine;
    while(pieces && tried < 4) {
        u32 square = lsb64(pieces);
        pieces &= pieces - 1;
        u64 from = 1ull << square;
        u64 moves = (square & 1 ? knight_attacks(from) : rook_attacks(from, mine | theirs)) & ~mine;
        while(moves && tried < 4) {
            u64 to = moves & -moves;
            moves ^= to;
            tried++;
            u32 score = search(theirs & ~to, (mine ^ from) | to, depth - 1);
            if(score > best) best = score;
        }
    }
    return best;
}
u32 bench_main(u32 n)
{
    u32 h = 0;
    u64 mine = 0x000000000000FF42ull, theirs = 0x42FF000000000000ull;
    for(u32 i = 0; i < n; i++) {
        h = mix(h, search(mine, theirs, 5));
        mine = mine << 1 | mine >> 63;
        theirs ^= (u64)i << (i & 31);
    }
    return h;
}
