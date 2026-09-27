# v86 CPU benchmark suite

A SPEC CPU 2017-style suite for comparing IR cores (a build against a baseline
build) on identical guest work. Every benchmark is a freestanding 32-bit program that
runs under a small benchmark BIOS (flat protected mode, 4 KiB paging over
64 MiB, x87/SSE enabled, interrupts off). Nothing else runs in the guest, so
the timings measure CPU emulation only.

## Running

```sh
make bench-build                      # build/bench/*.exe (needs nasm, i686-w64-mingw32-gcc)
make bench                            # full run: 5 warm runs, 3 cold samples per arm
make bench-quick                      # half-size work, 3 warm runs, 1 cold sample
node tests/bench/run.mjs --filter 'x87|sse' --runs 7
node tests/bench/run.mjs --baseline build/older-ir.wasm   # reference arm: another core
node tests/bench/run.mjs --xp windowsxp.img --xp-runs 3   # add the XP boot benchmark
node tests/bench/run.mjs --ir-setup ir_t0_set_ranges=1     # call IR exports after boot, on every arm
node tests/bench/report.mjs build/bench/results-new.json build/bench/results-old.json
node tests/bench/run.mjs --fallbacks                       # list the opcodes Tier-0 interprets
```

`BENCH_ARGS` passes options through the make targets. Results are written to
`build/bench/results-<date>.json` (or `--out`), including the host load, the
git revision and every raw sample.

## Method

For each benchmark and arm (the core under test, `ir`, and the optional
`--baseline` core; both in the default IR configuration, Tier-0 on):

- **cold**: the first run in a fresh VM. This includes JIT discovery,
  compilation and early interpretation, so it reflects short-lived code.
- **warm**: the median of timed runs after warm-up. Warm-up repeats the run
  until two consecutive timings of every arm agree within 5%.
- Arms are interleaved (ABBA order) to spread host-load drift evenly.
- Writable sections are restored and the CPU/FPU state is reset before every
  run, so every run executes the same instructions. All arms must report the
  same checksum and the same retired-instruction count; any difference is an
  error, not a timing.

The ratio is `baseline time / arm time`: above 1 means faster than the
baseline core. Without `--baseline` only MIPS are reported. The suite score is
the geometric mean of the ratios, reported overall and per category, for warm
and cold runs separately. Result files recorded before IR became the only
backend carry a `legacy` arm instead; `report.mjs` uses it as their reference. MIPS are retired guest
instructions per second (a REP string instruction counts once).

## Benchmarks

| id | category | shape |
|---|---|---|
| 500.bytecode | int | perlbench-like switch-dispatched bytecode interpreter |
| 502.codebloat | int | gcc-like: 600 generated functions, large code footprint |
| 505.chase | memory | mcf-like pointer chasing over a 2 MiB permuted list and a tree |
| 520.vcall | control | omnetpp-like event queue with vtable dispatch |
| 523.strings | int | xalancbmk-like tokenizing, hashing, string compares |
| 531.bitboard | int | deepsjeng-like 64-bit bitboards on a 32-bit CPU |
| 541.recursion | control | leela-like recursion: n-queens, fib, ackermann |
| 557.lz | int | xz-like LZ77 compress/decompress round trip |
| 560.hash | int | SHA-256, table CRC-32, Adler-32 |
| 561.sort | int | quicksort through a comparator pointer, merge |
| 562.muldiv | int | 32/64-bit multiply/divide, libgcc 64-bit division |
| 563.memops | memory | REP MOVS/STOS copies and fills, memmove |
| 600/601.matmul | x87 / sse | float 4x4 matrices and vertex transforms (same source) |
| 605/606.nbody | x87 / sse | double n-body with sqrt/div |
| 610/611.mandel | x87 / sse | Mandelbrot escape loop |
| 615.ftol | x87 | float/int conversions (FNSTCW/FLDCW/FISTP, FILD) |
| 616.fcompare | x87 | i586 float branches (FCOMP, FNSTSW AX, SAHF) |
| 617.trig | x87 | FSIN/FCOS/FPATAN/FSQRT/FRNDINT |
| 620.simd.sse | sse | packed float transforms, RSQRTPS |
| 621.simd.int | sse | SSE2 packed integer image processing, PSADBW |
| 625.mmx | mmx | MMX pixel blending with EMMS |
| 700-711 | micro | one dimension each: ALU, branches, CALL/RET, indirect calls, jump tables, stack, loads/stores, RMW, cross-page code, self-modifying code, REP strings, x87 stack |
| 900.xpboot | system | Windows XP boot to desktop, synchronous disk (`--xp`) |

C kernels are compiled by MinGW-w64 GCC with era-appropriate profiles (see
`tests/bench/suite.json`): integer code for i686 without SSE, x87 code with
`-mfpmath=387`, an i586 profile without FCOMI/CMOV, SSE2 and MMX. The micro
benchmarks are nasm sources. Adding a benchmark means adding a source file and
one line in `suite.json`; `iterations` should give a warm run of about
250 ms.

## Layout

- `tests/bench/lib/boot.asm` benchmark BIOS; `crt0.asm` entry and parameter
  block (`0x600` iterations, `0x604` checksum, `0x608` status, `0x60C` fault
  EIP); `rt.c` freestanding string routines in REP form; `bench.h` helpers.
- `tests/bench/src/` benchmark sources; `tests/bench/suite.json` manifest.
- `tools/bench/build.mjs` builds PE images at 0x400000 and `build/bench/manifest.json`.
- `tests/bench/run.mjs` runner; `tests/bench/report.mjs` summaries and comparisons.
