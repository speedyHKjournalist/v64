/*
 * The 64-bit division helpers that 32-bit x86 code calls into libgcc (or
 * compiler-rt), for building kvm-unit-tests on macOS where neither exists for
 * i386-linux. Written without 64-bit division, so they cannot call themselves.
 */

typedef unsigned long long u64;
typedef long long s64;

u64 __udivmoddi4(u64 n, u64 d, u64 *rem)
{
    u64 q = 0, r = 0;
    int i;

    if (d == 0) {
        /* divide error, like the hardware */
        volatile unsigned zero = 0;
        return 1 / zero;
    }

    if ((n >> 32) == 0 && (d >> 32) == 0) {
        unsigned n32 = (unsigned)n, d32 = (unsigned)d;
        if (rem)
            *rem = n32 % d32;
        return n32 / d32;
    }

    for (i = 63; i >= 0; i--) {
        r = (r << 1) | ((n >> i) & 1);
        if (r >= d) {
            r -= d;
            q |= 1ULL << i;
        }
    }

    if (rem)
        *rem = r;
    return q;
}

u64 __udivdi3(u64 n, u64 d)
{
    return __udivmoddi4(n, d, 0);
}

u64 __umoddi3(u64 n, u64 d)
{
    u64 r;
    __udivmoddi4(n, d, &r);
    return r;
}

s64 __divdi3(s64 n, s64 d)
{
    int negative = (n < 0) != (d < 0);
    u64 q = __udivmoddi4(n < 0 ? -(u64)n : (u64)n, d < 0 ? -(u64)d : (u64)d, 0);
    return negative ? -(s64)q : (s64)q;
}

s64 __moddi3(s64 n, s64 d)
{
    u64 r;
    __udivmoddi4(n < 0 ? -(u64)n : (u64)n, d < 0 ? -(u64)d : (u64)d, &r);
    return n < 0 ? -(s64)r : (s64)r;
}
