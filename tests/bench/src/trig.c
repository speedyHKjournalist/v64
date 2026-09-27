// x87 transcendental and root instructions (FSIN/FCOS/FSINCOS/FPATAN/FSQRT/
// FSCALE/FRNDINT) as used by rotation and animation code.
#include "../lib/bench.h"
static inline double fsin(double x) { double r; __asm__("fsin" : "=t"(r) : "0"(x)); return r; }
static inline double fcos(double x) { double r; __asm__("fcos" : "=t"(r) : "0"(x)); return r; }
static inline double fatan2(double y, double x) { double r; __asm__("fpatan" : "=t"(r) : "0"(x), "u"(y) : "st(1)"); return r; }
static inline double fsqrt(double x) { double r; __asm__("fsqrt" : "=t"(r) : "0"(x)); return r; }
static inline double frnd(double x) { double r; __asm__("frndint" : "=t"(r) : "0"(x)); return r; }
u32 bench_main(u32 n)
{
    u32 h = 0;
    double angle = 0.001;
    for(u32 i = 0; i < n * 1024; i++) {
        double s = fsin(angle), c = fcos(angle), a = fatan2(s, c + 1.5), r = fsqrt(s * s + c * c + a * a);
        angle += 0.0137 * frnd(r * 3.0);
        if(angle > 6.2831853) angle -= 6.2831853;
        h = mix(h, (u32)(i32)(r * 65536.0));
    }
    return h;
}
