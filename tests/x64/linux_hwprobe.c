/* libhwprobe.so, for the glibc-hwcaps check of tests/x64/linux_glibc_probe.c
 * (docs/simd-xsave-plan.md 11.3): built for baseline x86-64 into the library
 * directory and with -march=x86-64-v3 into its glibc-hwcaps/x86-64-v3
 * subdirectory, where ld.so takes it from when the CPU supports x86-64-v3.
 * The v3 build's loops become FMA, AVX2 and BMI2 code (the harness checks
 * the disassembly). */
#ifdef HWPROBE_V3
const char *hwprobe_level(void) { return "x86-64-v3"; }
#else
const char *hwprobe_level(void) { return "baseline"; }
#endif
/* (a chain of multiply-adds: VFMADD231SD in the v3 build) */
double hwprobe_dot(const double *a, const double *b, int n)
{
    double s = 0;
    for(int i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}
/* (vectorized: VPMULLD, VPSRLVD, VPXOR, VPADDD ymm in the v3 build) */
unsigned hwprobe_mix(const unsigned *v, int n)
{
    unsigned s = 0;
    for(int i = 0; i < n; i++) s += (v[i] * 2654435761u) ^ (v[i] >> (i & 15));
    return s;
}
