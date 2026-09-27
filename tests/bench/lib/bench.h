// Freestanding helpers shared by the benchmark kernels.
#ifndef BENCH_H
#define BENCH_H
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int i32;
typedef unsigned long long u64;
typedef long long i64;
#define NOINLINE __attribute__((noinline))
#define UNUSED __attribute__((unused))

void *memcpy(void *dst, const void *src, unsigned n);
void *memset(void *dst, int value, unsigned n);
void *memmove(void *dst, const void *src, unsigned n);
int memcmp(const void *a, const void *b, unsigned n);

// FNV-1a style accumulation of results into the checksum.
static inline u32 mix(u32 h, u32 v) { return (h ^ v) * 0x01000193u; }
static inline u32 lcg(u32 *state) { return *state = *state * 1664525u + 1013904223u; }
// Keep a value observable without a memory round trip the optimizer can drop.
#define KEEP(x) __asm__ volatile("" : : "r"(x))

u32 bench_main(u32 iterations);
#endif
