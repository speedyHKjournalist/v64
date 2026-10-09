/* The real-guest acceptance probe of docs/simd-xsave-plan.md 11.3 (P12):
 * linked against Ubuntu 24.04's glibc 2.39 (libc.so.6, libm.so.6 and
 * libhwprobe.so, see below) and run through glibc's ld.so in Alpine x86_64
 * (musl) by tests/x64/linux_boot.mjs (X64_LINUX_GLIBC=1). It prints:
 *   GLIBC_IFUNC <name> <library> <offset>: the implementation glibc's IFUNC
 *     resolver chose for <name> (dlsym or dlvsym, then dladdr: the offset in
 *     its library); the harness disassembles that function (its range from
 *     .eh_frame) to tell the AVX2, FMA, SSE4 and SSE2 variants
 *   GLIBC_STRING <name> <hash>: string functions over lengths 0-300 at every
 *     alignment within 64 bytes, strings that end right before an unmapped
 *     page, overlapping copies
 *   GLIBC_MATH <name> <hash>: libm functions on 4096 fixed inputs and the
 *     special values
 *   GLIBC_HWCAPS <level> <hash>: libhwprobe.so's level, from the copy that
 *     ld.so loaded (glibc-hwcaps/x86-64-v3 holds a -march=x86-64-v3 build),
 *     and its results (FMA dot products, an AVX2 integer loop in that build)
 *   GLIBC_TIME <name> <ns>: the time of a fixed amount of work (not compared)
 * The harness compares everything but the times with QEMU's run under the
 * same CPU features. Built freestanding: no glibc headers on the host. */
typedef unsigned long size_t;
typedef unsigned long u64;
typedef unsigned int u32;
typedef struct { const char *dli_fname; void *dli_fbase; const char *dli_sname; void *dli_saddr; } Dl_info;
struct timespec { long tv_sec; long tv_nsec; };
#define RTLD_DEFAULT ((void *)0)

extern int printf(const char *, ...);
extern void *dlsym(void *, const char *);
extern void *dlvsym(void *, const char *, const char *);
extern int dladdr(const void *, Dl_info *);
extern void *mmap(void *, size_t, int, int, int, long);
extern int clock_gettime(int, struct timespec *);
extern size_t strlen(const char *);
extern size_t strnlen(const char *, size_t);
extern char *strchr(const char *, int);
extern char *strchrnul(const char *, int);
extern char *strrchr(const char *, int);
extern void *memchr(const void *, int, size_t);
extern void *memrchr(const void *, int, size_t);
extern void *rawmemchr(const void *, int);
extern int strcmp(const char *, const char *);
extern int strncmp(const char *, const char *, size_t);
extern int memcmp(const void *, const void *, size_t);
extern int strcasecmp(const char *, const char *);
extern char *strcpy(char *, const char *);
extern char *stpcpy(char *, const char *);
extern char *strncpy(char *, const char *, size_t);
extern char *strcat(char *, const char *);
extern void *memcpy(void *, const void *, size_t);
extern void *memmove(void *, const void *, size_t);
extern void *mempcpy(void *, const void *, size_t);
extern void *memset(void *, int, size_t);
extern size_t strspn(const char *, const char *);
extern size_t strcspn(const char *, const char *);
extern char *strpbrk(const char *, const char *);
extern char *strstr(const char *, const char *);
extern size_t wcslen(const int *);
extern int *wmemset(int *, int, size_t);
extern int *wcschr(const int *, int);
extern int wcscmp(const int *, const int *);
extern double exp(double), exp2(double), log(double), log2(double), log10(double), pow(double, double);
extern double sin(double), cos(double), tan(double), atan(double), atan2(double, double), asin(double), acos(double);
extern double sinh(double), cosh(double), tanh(double), expm1(double), log1p(double), fma(double, double, double);
extern float expf(float), exp2f(float), logf(float), log2f(float), powf(float, float), sinf(float), cosf(float), fmaf(float, float, float);
extern void sincos(double, double *, double *);
extern void sincosf(float, float *, float *);
/* libhwprobe.so (tests/x64/linux_hwprobe.c) */
extern const char *hwprobe_level(void);
extern double hwprobe_dot(const double *, const double *, int);
extern unsigned hwprobe_mix(const unsigned *, int);

/* FNV-1a, 64 bits */
static u64 mix(u64 h, u64 v)
{
    for(int i = 0; i < 8; i++)
    {
        h ^= (v >> (8 * i)) & 0xFF;
        h *= 0x100000001B3ul;
    }
    return h;
}
static u64 bits(double x) { u64 b; __builtin_memcpy(&b, &x, 8); return b; }
static u32 bits32(float x) { u32 b; __builtin_memcpy(&b, &x, 4); return b; }
static long now(void)
{
    struct timespec t;
    clock_gettime(1, &t);
    return t.tv_sec * 1000000000l + t.tv_nsec;
}

static const char *const LIBC_IFUNCS[] = {
    "memchr", "memcmp", "memcpy", "memmove", "mempcpy", "memrchr", "memset", "rawmemchr", "stpcpy", "stpncpy",
    "strcasecmp", "strcat", "strchr", "strchrnul", "strcmp", "strcpy", "strcspn", "strlen", "strncasecmp", "strncat",
    "strncmp", "strncpy", "strnlen", "strpbrk", "strrchr", "strspn", "strstr", "wcschr", "wcscmp", "wcslen", "wcsnlen",
    "wmemchr", "wmemcmp", "wmemset", "__memcmpeq",
};
/* (libm's exp, log, pow, atan2, asin and acos dispatch internally; their
 * deprecated __*_finite aliases, GLIBC_2.15, are IFUNCs over the same
 * implementations) */
static const char *const LIBM_IFUNCS[] = {
    "sin", "cos", "tan", "atan", "sincos", "expm1", "log2", "exp2f", "expf", "log2f", "logf", "powf", "sinf", "cosf",
    "sincosf", "fma", "fmaf", "floor", "ceil", "rint", "nearbyint", "trunc", "roundeven",
};
static const char *const LIBM_FINITE[] = {
    "__exp_finite", "__log_finite", "__pow_finite", "__atan2_finite", "__asin_finite", "__acos_finite",
};

static void ifuncs(const char *const *names, int count, const char *version)
{
    for(int i = 0; i < count; i++)
    {
        void *f = version ? dlvsym(RTLD_DEFAULT, names[i], version) : dlsym(RTLD_DEFAULT, names[i]);
        Dl_info info;
        if(!f || !dladdr(f, &info)) { printf("GLIBC_IFUNC %s missing\n", names[i]); continue; }
        const char *library = info.dli_fname, *slash = library;
        for(const char *c = library; *c; c++) if(*c == '/') slash = c + 1;
        printf("GLIBC_IFUNC %s %s %lx\n", names[i], slash, (u64)((char *)f - (char *)info.dli_fbase));
    }
}

/* Two pages, the second unmapped: a string that ends at the end of the first
 * page must not fault however wide the implementation reads */
static char *edge_page(void)
{
    char *p = mmap(0, 3 * 4096, 0, 0x22, -1, 0);
    char *q = mmap(p, 2 * 4096, 3, 0x32, -1, 0); /* MAP_FIXED: the first two pages readable */
    (void)q;
    return p + 4096;
}

static void strings(void)
{
    char *edge = edge_page(), *end = edge + 4096;
    static char a[1024] __attribute__((aligned(64))), b[1024] __attribute__((aligned(64)));
    static char copy[2048] __attribute__((aligned(64)));
    u64 h[16];
    for(int i = 0; i < 16; i++) h[i] = 0xCBF29CE484222325ul;
    enum { LEN, NLEN, CHR, RCHR, MCHR, CMP, NCMP, MCMP, CASE, CPY, MOVE, SET, SPN, STR, WIDE, CAT };
    for(int length = 0; length <= 300; length += length < 80 ? 1 : 7)
    {
        for(int align = 0; align < 64; align++)
        {
            /* a string at the end of the readable page (only for the
             * alignment that ends it there), else inside a */
            for(int at_edge = 0; at_edge < 2; at_edge++)
            {
                char *s = at_edge ? end - length - 1 : a + align;
                if(at_edge && align) break;
                if(!at_edge && align + length + 1 > (int)sizeof a) continue;
                for(int i = 0; i < length; i++) s[i] = 'a' + (i * 7 + align) % 23;
                s[length] = 0;
                h[LEN] = mix(h[LEN], strlen(s));
                h[NLEN] = mix(h[NLEN], strnlen(s, length / 2 + 3));
                for(int c = 'a'; c < 'a' + 26; c += 5)
                {
                    char *r = strchr(s, c);
                    h[CHR] = mix(h[CHR], r ? (u64)(r - s) : ~0ul);
                    r = strchrnul(s, c);
                    h[CHR] = mix(h[CHR], (u64)(r - s));
                    r = strrchr(s, c);
                    h[RCHR] = mix(h[RCHR], r ? (u64)(r - s) : ~0ul);
                    void *m = memchr(s, c, length);
                    h[MCHR] = mix(h[MCHR], m ? (u64)((char *)m - s) : ~0ul);
                    m = memrchr(s, c, length);
                    h[MCHR] = mix(h[MCHR], m ? (u64)((char *)m - s) : ~0ul);
                }
                h[MCHR] = mix(h[MCHR], (u64)((char *)rawmemchr(s, 0) - s));
                /* comparisons against a copy that differs at one position (or nowhere) */
                char *t = b + (align * 5) % 64;
                for(int diff = -1; diff < length; diff += length / 5 + 1)
                {
                    for(int i = 0; i <= length; i++) t[i] = s[i];
                    if(diff >= 0) t[diff] = (char)(t[diff] + (diff & 1 ? 1 : -1) * (1 + (diff & 64)));
                    int r = strcmp(s, t);
                    h[CMP] = mix(h[CMP], r < 0 ? 1 : r > 0 ? 2 : 3);
                    r = strncmp(s, t, length - length / 3);
                    h[NCMP] = mix(h[NCMP], r < 0 ? 1 : r > 0 ? 2 : 3);
                    r = memcmp(s, t, length);
                    h[MCMP] = mix(h[MCMP], r < 0 ? 1 : r > 0 ? 2 : 3);
                    if(diff >= 0) t[diff] ^= 0x20;
                    r = strcasecmp(s, t);
                    h[CASE] = mix(h[CASE], r < 0 ? 1 : r > 0 ? 2 : 3);
                }
                /* copies to every alignment */
                char *d = copy + (align * 3) % 64;
                __builtin_memset(copy, 0x5A, sizeof copy);
                h[CPY] = mix(h[CPY], (u64)(stpcpy(d, s) - d));
                strcpy(d + length + 9, s);
                strncpy(d + 2 * length + 20, s, length / 2 + 5);
                strcat(d, "xyz");
                for(int i = 0; i < (int)sizeof copy; i += 8) h[CPY] = mix(h[CPY], *(u64 *)(copy + i));
                /* overlapping moves both ways, memcpy and mempcpy, memset */
                __builtin_memset(copy, 0, sizeof copy);
                for(int i = 0; i < 700; i++) copy[i] = (char)(i * 13 + align);
                memmove(copy + align, copy + 64 + (length & 31), length * 2);
                memmove(copy + 300 + (length & 15), copy + 290 + align, length);
                memcpy(copy + 1200 + align, copy + (length & 63), length);
                h[MOVE] = mix(h[MOVE], (u64)((char *)mempcpy(copy + 1600, s, length) - copy));
                for(int i = 0; i < 2048; i += 8) h[MOVE] = mix(h[MOVE], *(u64 *)(copy + i));
                memset(copy + align, length, length * 3);
                for(int i = 0; i < 2048; i += 8) h[SET] = mix(h[SET], *(u64 *)(copy + i));
                h[SPN] = mix(h[SPN], strspn(s, "abcdefghij"));
                h[SPN] = mix(h[SPN], strcspn(s, "uvw"));
                char *p = strpbrk(s, "qrs");
                h[SPN] = mix(h[SPN], p ? (u64)(p - s) : ~0ul);
                if(length > 6)
                {
                    char needle[8];
                    for(int i = 0; i < 5; i++) needle[i] = s[length - 6 + i];
                    needle[5] = 0;
                    p = strstr(s, needle);
                    h[STR] = mix(h[STR], p ? (u64)(p - s) : ~0ul);
                    needle[2] = 'z';
                    p = strstr(s, needle);
                    h[STR] = mix(h[STR], p ? (u64)(p - s) : ~0ul);
                }
            }
        }
        /* wide strings */
        static int w[400] __attribute__((aligned(64))), w2[400] __attribute__((aligned(64)));
        if(length < 380)
        {
            wmemset(w, 'k', length);
            w[length] = 0;
            for(int i = 0; i <= length; i++) w2[i] = w[i];
            if(length) w2[length / 2] = 'm';
            h[WIDE] = mix(h[WIDE], wcslen(w));
            int *r = wcschr(w, 'k');
            h[WIDE] = mix(h[WIDE], r ? (u64)(r - w) : ~0ul);
            int c = wcscmp(w, w2);
            h[WIDE] = mix(h[WIDE], c < 0 ? 1 : c > 0 ? 2 : 3);
        }
    }
    static const char *const NAMES[] = { "strlen", "strnlen", "strchr", "strrchr", "memchr", "strcmp", "strncmp",
        "memcmp", "strcasecmp", "strcpy", "memmove", "memset", "strspn", "strstr", "wide" };
    for(int i = 0; i < 15; i++) printf("GLIBC_STRING %s %016lx\n", NAMES[i], h[i]);
}

/* 4096 inputs: a sweep of each function's interesting range, the special values */
static double input(int i, double low, double high)
{
    static const u64 SPECIAL[] = { 0, 0x8000000000000000ul, 0x7FF0000000000000ul, 0xFFF0000000000000ul,
        0x7FF8000000000000ul, 1, 0x000FFFFFFFFFFFFFul, 0x0010000000000000ul, 0x3FF0000000000000ul,
        0xBFF0000000000000ul, 0x7FEFFFFFFFFFFFFFul, 0x3FE0000000000000ul, 0x400921FB54442D18ul };
    if(i < 13) { double x; __builtin_memcpy(&x, &SPECIAL[i], 8); return x; }
    /* (a sweep with irregular steps: every last bit pattern) */
    return low + (high - low) * ((i - 13) * 0.000244140625 + (i * 2654435761u % 1000) * 1e-9);
}

static void math(void)
{
    enum { N = 4096 };
    struct { const char *name; double (*f)(double); double low, high; } unary[] = {
        { "exp", exp, -745, 710 }, { "exp2", exp2, -1075, 1024 }, { "log", log, 0, 1e6 }, { "log2", log2, 0, 4 },
        { "log10", log10, 0, 1e3 }, { "sin", sin, -100, 100 }, { "cos", cos, -100, 100 }, { "tan", tan, -10, 10 },
        { "atan", atan, -50, 50 }, { "asin", asin, -1, 1 }, { "acos", acos, -1, 1 }, { "sinh", sinh, -20, 20 },
        { "cosh", cosh, -20, 20 }, { "tanh", tanh, -10, 10 }, { "expm1", expm1, -40, 40 }, { "log1p", log1p, -1, 100 },
    };
    for(int k = 0; k < (int)(sizeof unary / sizeof unary[0]); k++)
    {
        u64 h = 0xCBF29CE484222325ul;
        for(int i = 0; i < N; i++) h = mix(h, bits(unary[k].f(input(i, unary[k].low, unary[k].high))));
        printf("GLIBC_MATH %s %016lx\n", unary[k].name, h);
    }
    u64 h = 0xCBF29CE484222325ul, hs = h, hf = h, hfs = h, hfma = h, hfmaf = h, hatan2 = h;
    for(int i = 0; i < N; i++)
    {
        double x = input(i, 0, 30), y = input(N - 1 - i, -12, 12);
        h = mix(h, bits(pow(x, y)));
        double s, c;
        sincos(input(i, -1e4, 1e4), &s, &c);
        hs = mix(mix(hs, bits(s)), bits(c));
        hatan2 = mix(hatan2, bits(atan2(y, input(i, -5, 5))));
        float fx = (float)input(i, -90, 90), fy = (float)input(N - 1 - i, -3, 3);
        hf = mix(hf, bits32(expf(fx)) | (u64)bits32(exp2f(fx / 2)) << 32);
        hf = mix(hf, bits32(logf(fx + 91)) | (u64)bits32(log2f(fx + 91)) << 32);
        hf = mix(hf, bits32(powf(fx + 91, fy)) | (u64)bits32(sinf(fx)) << 32);
        float sf, cf;
        sincosf(fx * 100, &sf, &cf);
        hfs = mix(hfs, bits32(sf) | (u64)bits32(cf) << 32);
        hfs = mix(hfs, bits32(cosf(fx)));
        hfma = mix(hfma, bits(fma(x, y, input(i, -1e3, 1e3))));
        hfmaf = mix(hfmaf, bits32(fmaf(fx, fy, (float)input(i, -1, 1))));
    }
    printf("GLIBC_MATH pow %016lx\nGLIBC_MATH sincos %016lx\nGLIBC_MATH atan2 %016lx\nGLIBC_MATH float %016lx\n"
        "GLIBC_MATH sincosf %016lx\nGLIBC_MATH fma %016lx\nGLIBC_MATH fmaf %016lx\n", h, hs, hatan2, hf, hfs, hfma, hfmaf);
}

static void hwcaps(void)
{
    static double a[1000], b[1000];
    static unsigned v[1000];
    /* (ordinary values: no specials) */
    for(int i = 0; i < 1000; i++) { a[i] = input(i + 100, -3, 3); b[i] = input(1999 - i, -7, 7); v[i] = (unsigned)i * 2246822519u; }
    u64 h = 0xCBF29CE484222325ul;
    for(int n = 0; n <= 1000; n += 37)
    {
        h = mix(h, bits(hwprobe_dot(a + n % 5, b, 1000 - n - n % 5)));
        h = mix(h, hwprobe_mix(v + n % 7, 1000 - n - n % 7));
    }
    printf("GLIBC_HWCAPS %s %016lx\n", hwprobe_level(), h);
}

/* The times (best of ten) of libm's functions and of string functions on
 * fixed work: the performance budget of plan 12.2 compares them between CPU
 * profiles (the FMA and AVX2 versions against the SSE2 ones). The copies and
 * the memset are misaligned and cross pages; from 2 KiB (SSE2) or 4 KiB
 * (AVX2) glibc's ERMS versions use REP MOVSB and REP STOSB */
#define PAGE_ALIGNED __attribute__((aligned(4096)))
static void timing(void)
{
    static const char *const NAMES[] = { "exp", "log", "sin", "pow", "strlen", "memchr", "memcpy", "memcpy16k", "memset" };
    static char s[8192] PAGE_ALIGNED, d[8192] PAGE_ALIGNED, big_s[16384 + 4096] PAGE_ALIGNED, big_d[16384 + 4096] PAGE_ALIGNED;
    for(int i = 0; i < 4095; i++) s[i] = 'a' + i % 26;
    for(int f = 0; f < 9; f++)
    {
        long best = -1;
        for(int round = 0; round < 10; round++)
        {
            volatile double sink = 0;
            size_t n = 0;
            long t = now();
            for(int i = 0; i < 20000; i++)
            {
                double x = i * 1e-3;
                switch(f)
                {
                case 0: sink += exp(x); break;
                case 1: sink += log(x + 1.5); break;
                case 2: sink += sin(x * 37); break;
                case 3: sink += pow(1.0001, x * 100); break;
                case 4: if(i < 2000) n += strlen(s + (i & 63)); break;
                case 5: if(i < 2000) n += (size_t)((char *)memchr(s, 'z' - (i & 3), 4000) - s); break;
                case 6: if(i < 2000) memcpy(d + 2048 + (i & 31), s + 2048 + (i & 63), 4000 - 64); break;
                case 7: if(i < 500) memcpy(big_d + 2048 + (i & 31), big_s + 2048 + (i & 63), 16384 - 64); break;
                default: if(i < 2000) memset(d + 2048 + (i & 31), i, 4000 - 64); break;
                }
            }
            long elapsed = now() - t;
            if(best < 0 || elapsed < best) best = elapsed;
            (void)n;
        }
        printf("GLIBC_TIME %s %ld\n", NAMES[f], best);
    }
}

int main(int argc, char **argv)
{
    (void)argc; (void)argv;
    ifuncs(LIBC_IFUNCS, sizeof LIBC_IFUNCS / sizeof LIBC_IFUNCS[0], 0);
    ifuncs(LIBM_IFUNCS, sizeof LIBM_IFUNCS / sizeof LIBM_IFUNCS[0], 0);
    ifuncs(LIBM_FINITE, sizeof LIBM_FINITE / sizeof LIBM_FINITE[0], "GLIBC_2.15");
    strings();
    math();
    hwcaps();
    timing();
    printf("GLIBC_PROBE_OK\n");
    return 0;
}

/* crt1's job: glibc's start (init arrays, stdio, exit through atexit) */
__asm__(".text\n.globl _start\n_start:\nxor %ebp,%ebp\nmov %rdx,%r9\npop %rsi\nmov %rsp,%rdx\nand $-16,%rsp\n"
    "push %rax\npush %rsp\nxor %r8d,%r8d\nxor %ecx,%ecx\nlea main(%rip),%rdi\ncall *__libc_start_main@GOTPCREL(%rip)\nhlt\n");
