// Exact SSE floating point in the 32-bit engines (docs/simd-xsave-plan.md
// 7.4, P4a): every SSE/SSE2/SSE3 floating-point form, with register and
// memory sources, against the model of tests/rust/sse_fp_model.mjs (exact
// rational arithmetic, independent of SoftFloat and cpu/simd_fp.rs). Each
// case sets MXCSR (the four rounding modes, DAZ, FZ, masked and unmasked
// exceptions, PE set or not) and checks the destination, MXCSR and the fault:
// #XM, or #UD without CR4.OSXMMEXCPT, with the destination unchanged. Values
// include zeros, denormals, the normal extremes, infinities, QNaNs and SNaNs
// and results that overflow, underflow or are inexact. Every case runs in the
// interpreter, then hot under Tier-0 and the region tiers, whose native paths
// (ir::native_fp) must be refused exactly where they would differ.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import * as model from "./sse_fp_model.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x300000, FAULTS = 0x3F0000, CASE = 0x3FF000, SKIP = 0x3FF004;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);

// the values: special ones, and a few to overflow, underflow and round
const SINGLE = [0n, 0x80000000n, 0x3F800000n, 0xBF800000n, 0x3FC00000n, 1n, 0x807FFFFFn, 0x00800000n, 0x80800000n,
    0x7F7FFFFFn, 0xFF7FFFFFn, 0x7F800000n, 0xFF800000n, 0x7FC00001n, 0xFF812345n, 0x7F800003n,
    0x40400000n, 0x3DCCCCCDn, 0x7149F2CAn, 0x0DA24260n, 0x00C00000n, 0x4B800001n, 0xCF000000n, 0x4F000000n,
    // a product that rounds to the smallest normal but is tiny after rounding (UE)
    0x3EFFFFFFn, 0x01000000n];
const DOUBLE = [0n, 0x8000000000000000n, 0x3FF0000000000000n, 0xBFF0000000000000n, 0x3FF8000000000000n, 1n,
    0x800FFFFFFFFFFFFFn, 0x0010000000000000n, 0x8010000000000000n, 0x7FEFFFFFFFFFFFFFn, 0xFFEFFFFFFFFFFFFFn,
    0x7FF0000000000000n, 0xFFF0000000000000n, 0x7FF8000000000001n, 0xFFF0123456789ABCn, 0x7FF0000000000003n,
    0x4008000000000000n, 0x3FB999999999999An, 0x7E37E43C8800759Cn, 0x01A56E1FC2F8F359n, 0x0018000000000000n,
    0x4340000000000001n, 0xC1E0000000000000n, 0x41E0000000000000n, 0x36A0000000000000n, 0x3810000000000000n,
    0x3FDFFFFFFFFFFFFFn, 0x0020000000000000n];
// MXCSR: defaults; PE set (the native paths); each rounding mode; DAZ, FZ;
// everything unmasked; only the post-computation exceptions unmasked
const MXCSRS = [0x1F80, 0x1FA0, 0x3FA0, 0x5FA0, 0x7FA0, 0x1FE0, 0x9FA0, 0x9FE0, 0x0000, 0x0180, 0x0700 | 0x20];

let seed = 0x13572468;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const pick = list => list[random() % list.length];
const random_value = double => double ? BigInt(random()) << 32n | BigInt(random()) : BigInt(random());

const lanes_of = (v, double) => {
    const n = double ? 2 : 4, bits = double ? 64n : 32n, mask = (1n << bits) - 1n;
    return Array.from({ length: n }, (_, i) => v >> BigInt(i) * bits & mask);
};
const of_lanes = (lanes, double) => lanes.reduce((v, x, i) => v | x << BigInt(i) * (double ? 64n : 32n), 0n);
const bytes128 = v => Uint8Array.from({ length: 16 }, (_, i) => Number(v >> BigInt(8 * i) & 0xFFn));

// The forms: prefix and opcode byte, the operation, the operand shape
const FORMS = [];
for(const [prefix, double, scalar] of [[[], false, false], [[0x66], true, false], [[0xF3], false, true], [[0xF2], true, true]])
{
    for(const [code, op] of [[0x51, "sqrt"], [0x58, "add"], [0x59, "mul"], [0x5C, "sub"], [0x5D, "min"], [0x5E, "div"], [0x5F, "max"]])
        FORMS.push({ name: op + (scalar ? "s" : "p") + (double ? "d" : "s"), prefix, code, kind: "binary", op, double, scalar });
    FORMS.push({ name: "cmp" + (scalar ? "s" : "p") + (double ? "d" : "s"), prefix, code: 0xC2, kind: "compare", double, scalar, imm8: true });
}
for(const [prefix, double] of [[[0x66], true], [[0xF2], false]])
{
    FORMS.push({ name: "hadd" + (double ? "pd" : "ps"), prefix, code: 0x7C, kind: "horizontal", op: "add", double });
    FORMS.push({ name: "hsub" + (double ? "pd" : "ps"), prefix, code: 0x7D, kind: "horizontal", op: "sub", double });
    FORMS.push({ name: "addsub" + (double ? "pd" : "ps"), prefix, code: 0xD0, kind: "addsub", double });
}
for(const [prefix, double] of [[[], false], [[0x66], true]])
{
    FORMS.push({ name: (double ? "ucomisd" : "ucomiss"), prefix, code: 0x2E, kind: "comi", double, predicate: 0 });
    FORMS.push({ name: (double ? "comisd" : "comiss"), prefix, code: 0x2F, kind: "comi", double, predicate: 1 });
}
for(const [prefix, scalar] of [[[], false], [[0xF3], true]])
{
    FORMS.push({ name: scalar ? "rsqrtss" : "rsqrtps", prefix, code: 0x52, kind: "reciprocal", square_root: true, scalar });
    FORMS.push({ name: scalar ? "rcpss" : "rcpps", prefix, code: 0x53, kind: "reciprocal", square_root: false, scalar });
}
// conversions: from (float width, integer, mmx/gpr) to ...
FORMS.push(
    { name: "cvtps2pd", prefix: [], code: 0x5A, kind: "widen", scalar: false },
    { name: "cvtss2sd", prefix: [0xF3], code: 0x5A, kind: "widen", scalar: true },
    { name: "cvtpd2ps", prefix: [0x66], code: 0x5A, kind: "narrow", scalar: false },
    { name: "cvtsd2ss", prefix: [0xF2], code: 0x5A, kind: "narrow", scalar: true },
    { name: "cvtdq2ps", prefix: [], code: 0x5B, kind: "from_dwords", double: false },
    { name: "cvtdq2pd", prefix: [0xF3], code: 0xE6, kind: "from_dwords", double: true },
    { name: "cvtps2dq", prefix: [0x66], code: 0x5B, kind: "to_dwords", double: false, truncate: false },
    { name: "cvttps2dq", prefix: [0xF3], code: 0x5B, kind: "to_dwords", double: false, truncate: true },
    { name: "cvtpd2dq", prefix: [0xF2], code: 0xE6, kind: "to_dwords", double: true, truncate: false },
    { name: "cvttpd2dq", prefix: [0x66], code: 0xE6, kind: "to_dwords", double: true, truncate: true },
    { name: "cvtsi2ss", prefix: [0xF3], code: 0x2A, kind: "from_gpr", double: false },
    { name: "cvtsi2sd", prefix: [0xF2], code: 0x2A, kind: "from_gpr", double: true },
    { name: "cvtss2si", prefix: [0xF3], code: 0x2D, kind: "to_gpr", double: false, truncate: false },
    { name: "cvttss2si", prefix: [0xF3], code: 0x2C, kind: "to_gpr", double: false, truncate: true },
    { name: "cvtsd2si", prefix: [0xF2], code: 0x2D, kind: "to_gpr", double: true, truncate: false },
    { name: "cvttsd2si", prefix: [0xF2], code: 0x2C, kind: "to_gpr", double: true, truncate: true },
    { name: "cvtpi2ps", prefix: [], code: 0x2A, kind: "from_mmx", double: false },
    { name: "cvtpi2pd", prefix: [0x66], code: 0x2A, kind: "from_mmx", double: true },
    { name: "cvtps2pi", prefix: [], code: 0x2D, kind: "to_mmx", double: false, truncate: false },
    { name: "cvttps2pi", prefix: [], code: 0x2C, kind: "to_mmx", double: false, truncate: true },
    { name: "cvtpd2pi", prefix: [0x66], code: 0x2D, kind: "to_mmx", double: true, truncate: false },
    { name: "cvttpd2pi", prefix: [0x66], code: 0x2C, kind: "to_mmx", double: true, truncate: true },
);

// integer sources: the edges of the conversions
const INTEGERS = [0n, 1n, 0xFFFFFFFFn, 0x7FFFFFFFn, 0x80000000n, 0x01000001n, 0xFEFFFFFFn, 0x075BCD15n, 0x80000001n, 0x00FFFFFFn];

/**
 * The cases of a form: { mxcsr, a (the destination), b (the source), imm8 }
 * with the model's expectation { result, after (MXCSR), fault }. The active
 * lanes go through every pair of special values, then random ones.
 */
function cases(form)
{
    const double = form.double ?? form.kind === "narrow";
    const integer = ["from_dwords", "from_gpr", "from_mmx"].includes(form.kind);
    const values = integer ? INTEGERS : double ? DOUBLE : SINGLE;
    const lane_double = integer ? false : double;
    const lanes = lane_double ? 2 : 4;
    const active = form.scalar || form.kind === "comi" || form.kind === "from_gpr" || form.kind === "to_gpr" ? 1 : lanes;
    const out = [];
    // (every pair of special values in the active lanes)
    const count = Math.max(64, Math.ceil(values.length * values.length / MXCSRS.length / active));
    MXCSRS.forEach((mxcsr, mi) => {
        for(let n = 0; n < count; n++)
        {
            const a = [], b = [];
            for(let i = 0; i < lanes; i++)
            {
                const k = (mi * count + n) * active + i;
                if(i < active && k < values.length * values.length)
                {
                    a.push(values[k % values.length]);
                    b.push(values[Math.floor(k / values.length) % values.length]);
                }
                else
                {
                    a.push(random() & 3 ? pick(values) : random_value(lane_double));
                    b.push(random() & 3 ? pick(values) : random_value(lane_double));
                }
            }
            const ca = of_lanes(a, lane_double), cb = of_lanes(b, lane_double);
            const imm8 = form.imm8 ? (mi + n) & 7 : 0;
            out.push({ mxcsr, a: ca, b: cb, imm8, ...expect(form, mxcsr, ca, cb, imm8) });
        }
    });
    return out;
}
function expect(form, mxcsr, a, b, imm8)
{
    const fp = new model.Fp(mxcsr);
    let result;
    switch(form.kind)
    {
        case "binary": case "compare":
        {
            const la = lanes_of(a, form.double), lb = lanes_of(b, form.double);
            const n = form.scalar ? 1 : la.length;
            const all = form.double ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
            for(let i = 0; i < n; i++)
                la[i] = form.kind === "compare" ? (fp.compare(la[i], lb[i], form.double, imm8) ? all : 0n) :
                    fp.binary(form.op, la[i], lb[i], form.double);
            result = of_lanes(la, form.double);
            break;
        }
        case "horizontal": case "addsub":
        {
            const la = lanes_of(a, form.double), lb = lanes_of(b, form.double), n = la.length;
            const r = [];
            for(let i = 0; i < n; i++)
            {
                if(form.kind === "addsub") r.push(fp.binary(i % 2 ? "add" : "sub", la[i], lb[i], form.double));
                else
                {
                    const v = i < n / 2 ? la : lb, base = i % (n / 2) * 2;
                    r.push(fp.binary(form.op, v[base], v[base + 1], form.double));
                }
            }
            result = of_lanes(r, form.double);
            break;
        }
        case "comi":
        {
            const x = lanes_of(a, form.double)[0], y = lanes_of(b, form.double)[0];
            // the flags of the comparison (COMI: a QNaN is invalid; UCOMI: only an SNaN)
            fp.compare(x, y, form.double, form.predicate);
            const dx = fp.input(x, form.double).x, dy = fp.input(y, form.double).x;
            if(model.is_nan(dx, form.double) || model.is_nan(dy, form.double)) result = 0x45;
            else
            {
                const c = model.compare(dx, dy, form.double);
                result = c < 0 ? 0x01 : c === 0 ? 0x40 : 0;
            }
            break;
        }
        case "reciprocal":
        {
            const la = lanes_of(a, false), lb = lanes_of(b, false);
            if(!form.scalar) la.fill(0n);
            for(let i = 0; i < (form.scalar ? 1 : 4); i++) la[i] = model.reciprocal(lb[i], form.square_root);
            result = of_lanes(la, false);
            break;
        }
        case "widen": case "narrow":
        {
            const from_double = form.kind === "narrow";
            const lb = lanes_of(b, from_double);
            const n = form.scalar ? 1 : 2;
            const converted = Array.from({ length: n }, (_, i) => fp.convert(lb[i], from_double));
            if(form.scalar)
            {
                const la = lanes_of(a, !from_double);
                la[0] = converted[0];
                result = of_lanes(la, !from_double);
            }
            else result = of_lanes(converted, !from_double);
            break;
        }
        case "from_dwords":
        {
            const n = form.double ? 2 : 4;
            const ints = lanes_of(b, false).map(x => BigInt.asIntN(32, x)).slice(0, n);
            result = of_lanes(ints.map(x => fp.from_integer(x, form.double)), form.double);
            break;
        }
        case "to_dwords":
        {
            const lb = lanes_of(b, form.double);
            const ints = lb.slice(0, form.double ? 2 : 4).map(x => BigInt.asUintN(32, fp.to_integer(x, form.double, 32, form.truncate)));
            result = of_lanes(ints, false);
            break;
        }
        case "from_gpr": case "from_mmx":
        {
            const n = form.kind === "from_gpr" ? 1 : 2;
            const ints = lanes_of(b, false).slice(0, n).map(x => BigInt.asIntN(32, x));
            const converted = ints.map(x => fp.from_integer(x, form.double));
            if(form.kind === "from_mmx" && form.double) result = of_lanes(converted, true);
            else
            {
                const la = lanes_of(a, form.double);
                converted.forEach((x, i) => la[i] = x);
                result = of_lanes(la, form.double);
            }
            break;
        }
        case "to_gpr": case "to_mmx":
        {
            const lb = lanes_of(b, form.double);
            const n = form.kind === "to_gpr" ? 1 : 2;
            result = of_lanes(lb.slice(0, n).map(x => BigInt.asUintN(32, fp.to_integer(x, form.double, 32, form.truncate))), false);
            break;
        }
    }
    const { mxcsr: after, fault } = fp.finish();
    return { result, after, fault };
}

// the code of a case: MXCSR, the operands, the instruction, its results
const ldmxcsr = a => [0x0F, 0xAE, 0x15, ...u32(a)], stmxcsr = a => [0x0F, 0xAE, 0x1D, ...u32(a)];
const movdqu_load = (r, a) => [0xF3, 0x0F, 0x6F, 0x05 | r << 3, ...u32(a)];
const movdqu_store = (r, a) => [0xF3, 0x0F, 0x7F, 0x05 | r << 3, ...u32(a)];
const movq_load = (r, a) => [0x0F, 0x6F, 0x05 | r << 3, ...u32(a)], movq_store = (r, a) => [0x0F, 0x7F, 0x05 | r << 3, ...u32(a)];
const mov_eax = a => [0xA1, ...u32(a)], store_eax = a => [0xA3, ...u32(a)];
const EMMS = [0x0F, 0x77];
/** The instruction: register 1 (XMM, MMX or EAX) and register 0 or [source] */
function instruction(form, memory, source, imm8)
{
    const rm = memory ? [0x05 | 1 << 3, ...u32(source)] : [0xC0 | 1 << 3 | 0];
    return [...form.prefix, 0x0F, form.code, ...rm, ...(form.imm8 ? [imm8] : [])];
}
function program(form, memory, list)
{
    const p = [];
    list.forEach((c, n) => {
        const base = DATA + n * 64;
        p.push(0xC7, 0x05, ...u32(CASE), ...u32(n));
        p.push(...ldmxcsr(base + 32));
        // register 1: the destination; register 0: the source (unless memory)
        if(form.kind === "to_gpr") p.push(0xB9, ...u32(0x5A5A5A5A)); // ecx (register 1)
        else if(form.kind === "to_mmx") p.push(...movq_load(1, base));
        else p.push(...movdqu_load(1, base));
        if(!memory)
        {
            if(form.kind === "from_gpr") p.push(0xB8, ...u32(Number(c.b & 0xFFFFFFFFn)));
            else if(form.kind === "from_mmx") p.push(...movq_load(0, base + 16));
            else p.push(...movdqu_load(0, base + 16));
        }
        p.push(...instruction(form, memory, base + 16, c.imm8));
        p.push(...stmxcsr(OUT + n * 32 + 16));
        if(form.kind === "comi") p.push(0x9C, 0x58, ...store_eax(OUT + n * 32));
        else if(form.kind === "to_gpr") p.push(0x89, 0x0D, ...u32(OUT + n * 32));
        else if(form.kind === "to_mmx") p.push(...movq_store(1, OUT + n * 32), ...EMMS);
        else p.push(...movdqu_store(1, OUT + n * 32));
        if(form.kind === "from_mmx") p.push(...EMMS);
    });
    return p;
}

const machines = [];
async function run(vm, code, warm, interpreter)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    vm.write_memory(Uint8Array.from(code), CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 60000;
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && compiled_activations(e) === start)
    {
        assert(performance.now() < deadline, "program/JIT timeout");
        await sleep(1);
    }
    if(warm) await sleep(20);
    await vm.stop();
}
function loop(body)
{
    const p = [...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}
/** A handler for `vector`: records it for the case, skips [SKIP] bytes */
function handler(vector, error_code)
{
    const p = [];
    if(error_code) p.push(0x58);
    p.push(0xA1, ...u32(CASE), 0xC7, 0x04, 0x85, ...u32(FAULTS), ...u32(vector)); // mov [FAULTS + eax*4], vector
    p.push(0xA1, ...u32(SKIP), 0x01, 0x04, 0x24, 0xCF);
    return p;
}
const VECTORS = [[6, false], [7, false], [13, true], [14, true], [19, false]];
async function create_machines()
{
    const set = [];
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 64 << 20,
            ...arm, disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" }, autostart: false });
        set.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
    }
    return set;
}

let total = 0;
try
{
    machines.push(...await create_machines());
    for(const xmm_exceptions of [true, false])
    {
        // CR4.OSFXSR and OSXMMEXCPT (else unmasked exceptions are #UD), CR0.TS clear
        const cr4 = [0x0F, 0x20, 0xE0, 0x0D, ...u32(xmm_exceptions ? 0x600 : 0x200), ...(xmm_exceptions ? [] : [0x25, ...u32(~0x400 >>> 0)]), 0x0F, 0x22, 0xE0];
        const prologue = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), 0x0F, 0x06, ...cr4];
        for(const form of xmm_exceptions ? FORMS : FORMS.filter(f => f.kind === "binary" && !f.double))
        {
            for(const memory of [false, true])
            {
                const list = cases(form);
                const length = instruction(form, memory, 0, 0).length;
                const code = loop([...prologue, ...program(form, memory, list)]);
                const data = new Uint8Array(list.length * 64);
                list.forEach((c, n) => {
                    data.set(bytes128(c.a), n * 64);
                    data.set(bytes128(c.b), n * 64 + 16);
                    data.set(u32(c.mxcsr), n * 64 + 32);
                });
                for(const vm of machines)
                {
                    vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
                    VECTORS.forEach(([vector, error_code], i) => {
                        const h = HANDLER + i * 0x100;
                        vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
                        vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
                    });
                    vm.write_memory(Uint8Array.from(u32(length)), SKIP);
                    for(const warm of [true, false])
                    {
                        vm.write_memory(data, DATA);
                        vm.write_memory(new Uint8Array(list.length * 32), OUT);
                        vm.write_memory(new Uint8Array(list.length * 4), FAULTS);
                        vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
                        await run(vm, code, warm, vm === machines[0]);
                    }
                }
                for(const [m, vm] of machines.entries())
                {
                    const out = Uint8Array.from(vm.read_memory(OUT, list.length * 32));
                    const faults = new DataView(Uint8Array.from(vm.read_memory(FAULTS, list.length * 4)).buffer);
                    const view = new DataView(out.buffer);
                    list.forEach((c, n) => {
                        const label = `${form.name}${memory ? " [mem]" : ""} case ${n} on machine ${m}: mxcsr ${c.mxcsr.toString(16)} a ${c.a.toString(16)} b ${c.b.toString(16)}${form.imm8 ? " imm8 " + c.imm8 : ""}`;
                        const vector = faults.getUint32(n * 4, true);
                        assert.equal(vector, c.fault ? xmm_exceptions ? 19 : 6 : 0, label + ": fault");
                        assert.equal(view.getUint32(n * 32 + 16, true), c.after, label + ": MXCSR");
                        // a faulting instruction leaves its destination alone
                        const destination = form.kind === "to_gpr" ? 0x5A5A5A5An : form.kind === "comi" ? undefined : c.a;
                        let actual, expected;
                        if(form.kind === "comi")
                        {
                            actual = BigInt(view.getUint32(n * 32, true) & 0x8D5);
                            expected = c.fault ? undefined : BigInt(c.result);
                        }
                        else if(form.kind === "to_gpr")
                        {
                            actual = BigInt(view.getUint32(n * 32, true));
                            expected = c.fault ? destination : c.result & 0xFFFFFFFFn;
                        }
                        else if(form.kind === "to_mmx")
                        {
                            actual = view.getBigUint64(n * 32, true);
                            expected = c.fault ? c.a & 0xFFFFFFFFFFFFFFFFn : c.result;
                        }
                        else
                        {
                            actual = view.getBigUint64(n * 32, true) | view.getBigUint64(n * 32 + 8, true) << 64n;
                            expected = c.fault ? destination : c.result;
                        }
                        if(expected !== undefined) assert.equal(actual.toString(16), expected.toString(16), label + ": result");
                    });
                }
                total += list.length;
            }
        }
        console.log(`PASS: ${xmm_exceptions ? "all forms, unmasked exceptions as #XM" : "unmasked exceptions as #UD without CR4.OSXMMEXCPT"}`);
    }
    console.log(`PASS: ${total} exact SSE floating-point cases (${FORMS.length} forms, register and memory sources, ${MXCSRS.length} MXCSR settings) match the model on 3 arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
