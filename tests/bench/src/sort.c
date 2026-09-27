// Quicksort through a comparator function pointer with insertion-sort
// leaves, plus a merge of sorted runs (indirect calls, swaps, recursion).
#include "../lib/bench.h"
#define N 32768
static i32 data[N], scratch[N];
typedef int (*compare_fn)(const void *, const void *);
static int ascending(const void *a, const void *b) { i32 x = *(const i32 *)a, y = *(const i32 *)b; return (x > y) - (x < y); }
NOINLINE static void quicksort(i32 *a, i32 lo, i32 hi, compare_fn cmp)
{
    while(hi - lo > 16) {
        i32 pivot = a[lo + (hi - lo) / 2], i = lo, j = hi;
        while(i <= j) {
            while(cmp(&a[i], &pivot) < 0) i++;
            while(cmp(&a[j], &pivot) > 0) j--;
            if(i <= j) { i32 t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if(j - lo < hi - i) { quicksort(a, lo, j, cmp); lo = i; }
        else { quicksort(a, i, hi, cmp); hi = j; }
    }
    for(i32 i = lo + 1; i <= hi; i++) {
        i32 v = a[i], j = i - 1;
        while(j >= lo && cmp(&a[j], &v) > 0) { a[j + 1] = a[j]; j--; }
        a[j + 1] = v;
    }
}
NOINLINE static void merge(i32 *out, const i32 *a, u32 na, const i32 *b, u32 nb)
{
    u32 i = 0, j = 0, k = 0;
    while(i < na && j < nb) out[k++] = a[i] <= b[j] ? a[i++] : b[j++];
    while(i < na) out[k++] = a[i++];
    while(j < nb) out[k++] = b[j++];
}
u32 bench_main(u32 n)
{
    u32 h = 0, seed = 5;
    for(u32 r = 0; r < n; r++) {
        for(u32 i = 0; i < N; i++) data[i] = (i32)lcg(&seed);
        quicksort(data, 0, N / 2 - 1, ascending);
        quicksort(data, N / 2, N - 1, ascending);
        merge(scratch, data, N / 2, data + N / 2, N / 2);
        for(u32 i = 0; i < N; i += 97) h = mix(h, scratch[i]);
    }
    return h;
}
