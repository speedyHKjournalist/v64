// The glibc part of the x64 Linux acceptance (docs/simd-xsave-plan.md 11.3,
// P12), for tests/x64/linux_boot.mjs with X64_LINUX_GLIBC=1: Ubuntu 24.04's
// glibc 2.39 (the package whose libraries gave plan 5.1's hot forms),
// tests/x64/linux_glibc_probe.c linked against it, and libhwprobe.so
// (tests/x64/linux_hwprobe.c) in a baseline build and, under
// glibc-hwcaps/x86-64-v3, a -march=x86-64-v3 one. Alpine itself uses musl:
// the probe runs through glibc's ld.so with --library-path.
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {createHash as create_hash} from "node:crypto";

const PACKAGE = {
    name: "libc6_2.39-0ubuntu8.9_amd64.deb",
    sha256: "ff5557d99b51f761c4b7c92368b9cc45565eda17df9bf9eb4b134d09825008be",
    url: "https://launchpad.net/ubuntu/+archive/primary/+files/libc6_2.39-0ubuntu8.9_amd64.deb",
};
const LIBRARIES = ["ld-linux-x86-64.so.2", "libc.so.6", "libm.so.6"];
// glibc's x86-64 levels (sysdeps/x86/get-isa-level.h) beyond what the x64
// profile always has (CMPXCHG16B, LAHF/SAHF, POPCNT, SSE3)
const V2 = ["SSSE3", "SSE4.1", "SSE4.2"];
const V3 = [...V2, "XSAVE", "AVX", "AVX2", "BMI1", "BMI2", "F16C", "FMA", "LZCNT", "MOVBE"];
// The implementations glibc picks with AVX2, BMI1, BMI2 and LZCNT
// (ifunc-avx2.h) use YMM registers; with FMA and AVX2 libm's use FMA
// (ifunc-fma.h). Without AVX2 no IFUNC picks a YMM or FMA implementation.
// (not wmemset: glibc 2.39 keeps its SSE2 version on this CPU model)
const AVX2_STRINGS = ["memchr", "memcmp", "memcpy", "memmove", "memrchr", "memset", "rawmemchr", "stpcpy", "strcat",
    "strchr", "strchrnul", "strcmp", "strcpy", "strlen", "strncmp", "strnlen", "strrchr", "wcschr", "wcslen", "wmemchr",
    "__memcmpeq"];
const FMA_MATH = ["sin", "cos", "tan", "atan", "sincos", "expf", "logf", "log2f", "exp2f", "powf", "sinf", "cosf",
    "sincosf", "fma", "fmaf", "__exp_finite", "__log_finite", "__pow_finite"];

export const GLIBC_COMMAND = "/tmp/glibc/lib/ld-linux-x86-64.so.2 --help | grep x86-64-v; " +
    "/tmp/glibc/lib/ld-linux-x86-64.so.2 --library-path /tmp/glibc/lib /tmp/glibc/glibc_probe; ";

const hash = bytes => create_hash("sha256").update(bytes).digest("hex");
function run(program, args)
{
    const result = spawnSync(program, args, {encoding: "utf8", maxBuffer: 1 << 28});
    assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr || result.error}`);
    return result.stdout;
}

/** The pinned package's ld.so, libc and libm in `directory`glibc-2.39/ */
async function libraries(directory, local)
{
    const out = directory + "glibc-2.39/";
    if(LIBRARIES.every(name => fs.existsSync(out + name))) return out;
    const deb = directory + PACKAGE.name;
    if(!fs.existsSync(deb))
    {
        if(fs.existsSync(local)) fs.copyFileSync(local, deb);
        else
        {
            const response = await fetch(PACKAGE.url);
            assert.ok(response.ok, `glibc package HTTP ${response.status}`);
            fs.writeFileSync(deb, Buffer.from(await response.arrayBuffer()));
        }
    }
    assert.equal(hash(fs.readFileSync(deb)), PACKAGE.sha256, "pinned glibc package SHA-256");
    const unpack = out + "unpack/";
    fs.mkdirSync(unpack, {recursive: true});
    run("bsdtar", ["-xf", deb, "-C", unpack, "data.tar.zst"]);
    run("bsdtar", ["-xf", unpack + "data.tar.zst", "-C", unpack, ...LIBRARIES.map(name => "./usr/lib/x86_64-linux-gnu/" + name)]);
    for(const name of LIBRARIES) fs.copyFileSync(unpack + "usr/lib/x86_64-linux-gnu/" + name, out + name);
    fs.rmSync(unpack, {recursive: true, force: true});
    return out;
}

/** Builds the probe and both libhwprobe.so in `work` (the package is kept in
 * `directory`): returns the directory that holds glibc/ as the guest finds
 * it in /tmp, and the libraries there */
export async function prepare_glibc(root, directory, work, lld)
{
    const glibc = await libraries(directory, root + "build/simd-xsave/p0-baseline/glibc/" + PACKAGE.name);
    const lib = work + "stage/glibc/lib/";
    fs.rmSync(work, {recursive: true, force: true});
    fs.mkdirSync(lib + "glibc-hwcaps/x86-64-v3", {recursive: true});
    const clang = args => run(process.env.CLANG || "clang", ["--target=x86_64-unknown-linux-gnu", "-O2", "-ffreestanding", "-fno-stack-protector", ...args]);
    const v3 = lib + "glibc-hwcaps/x86-64-v3/libhwprobe.so";
    clang(["-fPIC", "-c", root + "tests/x64/linux_hwprobe.c", "-o", work + "hwprobe.o"]);
    clang(["-fPIC", "-march=x86-64-v3", "-ffp-contract=fast", "-DHWPROBE_V3", "-c", root + "tests/x64/linux_hwprobe.c", "-o", work + "hwprobe-v3.o"]);
    run(lld, ["-flavor", "gnu", "-m", "elf_x86_64", "-shared", "-soname", "libhwprobe.so", "-o", lib + "libhwprobe.so", work + "hwprobe.o"]);
    run(lld, ["-flavor", "gnu", "-m", "elf_x86_64", "-shared", "-soname", "libhwprobe.so", "-o", v3, work + "hwprobe-v3.o"]);
    // (plan 11.3: a build for a level holds that level's instructions)
    const code = run("objdump", ["-d", v3]), baseline = run("objdump", ["-d", lib + "libhwprobe.so"]);
    assert.match(code, /vfmadd\d+sd/, "the x86-64-v3 libhwprobe.so has FMA");
    assert.match(code, /%ymm/, "the x86-64-v3 libhwprobe.so has AVX2");
    assert.doesNotMatch(baseline, /%ymm|vfmadd/, "the baseline libhwprobe.so has neither");
    for(const name of LIBRARIES) fs.copyFileSync(glibc + name, lib + name);
    clang(["-fPIE", "-fno-builtin", "-c", root + "tests/x64/linux_glibc_probe.c", "-o", work + "probe.o"]);
    run(lld, ["-flavor", "gnu", "-m", "elf_x86_64", "-pie", "--dynamic-linker", "/lib64/ld-linux-x86-64.so.2",
        "-o", work + "stage/glibc/glibc_probe", work + "probe.o", lib + "libc.so.6", lib + "libm.so.6", lib + "libhwprobe.so"]);
    return {stage: work + "stage/", libraries: lib};
}

/** What each GLIBC_IFUNC line chose: "avx2" (YMM registers), "fma" or
 * "other", from the disassembly of the function (its .eh_frame range) */
function ifunc_kinds(text, libraries)
{
    const ranges = {}, kinds = {};
    const frames = library => ranges[library] ??= [...run("objdump", ["--dwarf=frames", libraries + library])
        .matchAll(/FDE cie=\w+ pc=([0-9a-f]+)\.\.\.?([0-9a-f]+)/g)].map(m => [parseInt(m[1], 16), parseInt(m[2], 16)]);
    for(const [, name, library, offset] of text.matchAll(/GLIBC_IFUNC (\S+) (\S+) ([0-9a-f]+)\r?\n/g))
    {
        const at = parseInt(offset, 16);
        const range = frames(library).find(([start, end]) => start <= at && at < end);
        assert.ok(range, `${name}: no .eh_frame range at ${offset} in ${library}`);
        const code = run("objdump", ["-d", "--start-address=0x" + range[0].toString(16), "--stop-address=0x" + range[1].toString(16), libraries + library]);
        kinds[name] = /vfn?m(add|sub)/.test(code) ? "fma" : /%ymm/.test(code) ? "avx2" : "other";
    }
    return kinds;
}

/** Checks the glibc probe's report in `text` for `features`; `reference`:
 * a transcript of the same probe under QEMU with the same features, whose
 * IFUNC choices and results must be the same */
export function check_glibc(text, features, libraries, reference)
{
    const has = list => list.every(name => features.includes(name));
    const levels = {};
    for(const [, level, supported] of text.matchAll(/^\s*x86-64-v(\d)( \(supported, searched\))?\r?$/gm)) levels[level] = !!supported;
    assert.deepEqual(levels, {2: has(V2), 3: has(V3), 4: false}, "ld.so --help: the glibc-hwcaps levels the CPU supports");
    assert.match(text, /\nGLIBC_PROBE_OK\r?\n/, "the glibc probe ran to its end");
    const hwcaps = text.match(/GLIBC_HWCAPS (\S+) [0-9a-f]+/);
    assert.equal(hwcaps?.[1], has(V3) ? "x86-64-v3" : "baseline", "ld.so loaded the libhwprobe.so of the CPU's level");
    const kinds = ifunc_kinds(text, libraries);
    assert.equal(Object.keys(kinds).length, 64, "every IFUNC reported");
    for(const [name, kind] of Object.entries(kinds))
    {
        if(!has(["AVX2"])) assert.equal(kind, "other", `glibc's IFUNC choice for ${name} without AVX2`);
        else if(FMA_MATH.includes(name)) assert.equal(kind, has(["FMA"]) ? "fma" : "other", `glibc's IFUNC choice for ${name}`);
        else if(AVX2_STRINGS.includes(name) && has(["BMI1", "BMI2", "LZCNT"])) assert.equal(kind, "avx2", `glibc's IFUNC choice for ${name}`);
    }
    const results = s => s.match(/^GLIBC_(STRING|MATH|HWCAPS) [^\r\n]+/gm);
    if(reference)
    {
        assert.deepEqual(kinds, ifunc_kinds(reference, libraries), "the same IFUNC choices as QEMU");
        assert.deepEqual(results(text), results(reference), "the same string, libm and libhwprobe.so results as QEMU");
    }
    return {kinds, times: Object.fromEntries([...text.matchAll(/GLIBC_TIME (\S+) (\d+)/g)].map(([, name, ns]) => [name, +ns]))};
}

/** QEMU's -cpu for the x64 profile with `features` (v86's CPUID vendor and
 * model, so that glibc tunes its choices the same way); QEMU 10.2's TCG has
 * no XSAVEC or XSAVES, and with this model and XSAVE but not XSAVEOPT its
 * guest kernel hangs setting up XSAVE: QEMU gets XSAVEOPT with XSAVE (the
 * kernel's context switch format does not change what the probes see) */
export function qemu_cpu(features)
{
    if(features.includes("XSAVE") && !features.includes("XSAVEOPT")) features = [...features, "XSAVEOPT"];
    const flags = {"SSSE3": "ssse3", "SSE4.1": "sse4.1", "SSE4.2": "sse4.2", "XSAVE": "xsave", "AVX": "avx", "AVX2": "avx2",
        "FMA": "fma", "F16C": "f16c", "BMI1": "bmi1", "BMI2": "bmi2", "LZCNT": "abm", "MOVBE": "movbe", "XSAVEOPT": "xsaveopt",
        "XGETBV1": "xgetbv1"};
    return ["qemu64,phys-bits=36,-pdpe1gb,vendor=GenuineIntel,family=6,model=7,stepping=3,+popcnt,+cx16,+lahf-lm",
        ...features.filter(name => flags[name]).map(name => "+" + flags[name])].join(",");
}
