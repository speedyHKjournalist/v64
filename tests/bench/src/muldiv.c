// Integer multiply/divide heavy code: 32-bit MUL/DIV/IDIV, 64-bit products
// and libgcc 64-bit division (__udivdi3/__umoddi3), modular exponentiation.
#include "../lib/bench.h"
NOINLINE static u32 powmod(u32 base, u32 exponent, u32 modulus)
{
    u64 result = 1, b = base % modulus;
    while(exponent) {
        if(exponent & 1) result = result * b % modulus;
        b = b * b % modulus;
        exponent >>= 1;
    }
    return (u32)result;
}
NOINLINE static u32 gcd(u32 a, u32 b) { while(b) { u32 t = a % b; a = b; b = t; } return a; }
u32 bench_main(u32 n)
{
    u32 h = 0, seed = 3;
    for(u32 i = 0; i < n * 256; i++) {
        u32 a = lcg(&seed) | 1, b = lcg(&seed) >> 8 | 1;
        i32 s = (i32)a / (i32)(b | 3);
        h = mix(h, powmod(a, b, 1000000007u) + gcd(a, b) + (u32)s + a / b + (u32)((u64)a * b >> 32));
    }
    return h;
}
