// leela-like: recursive tree search (n-queens backtracking) and deep call
// chains (near CALL/RET, stack frames, returns to many call sites).
#include "../lib/bench.h"
NOINLINE static u32 queens(u32 row, u32 n, u32 columns, u32 left, u32 right)
{
    if(row == n) return 1;
    u32 count = 0, free = ~(columns | left | right) & ((1u << n) - 1);
    while(free) {
        u32 bit = free & -free;
        free ^= bit;
        count += queens(row + 1, n, columns | bit, (left | bit) << 1, (right | bit) >> 1);
    }
    return count;
}
NOINLINE static u32 fib(u32 n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
NOINLINE static u32 ackermann(u32 m, u32 n)
{
    if(!m) return n + 1;
    if(!n) return ackermann(m - 1, 1);
    return ackermann(m - 1, ackermann(m, n - 1));
}
u32 bench_main(u32 n)
{
    u32 h = 0;
    for(u32 i = 0; i < n; i++) h = mix(mix(mix(h, queens(0, 8, 0, 0, 0)), fib(16 + (i & 1))), ackermann(2, 20 + (i & 3)));
    return h;
}
