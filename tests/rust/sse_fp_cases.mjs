// The SSE floating-point forms of tests/rust/sse_fp.mjs and their VEX forms
// (tests/rust/avx_fp.mjs): their cases, special values for each lane, MXCSR
// settings, and the model's result for each (tests/rust/sse_fp_model.mjs,
// exact rational arithmetic, independent of SoftFloat and cpu/simd_fp.rs).
import * as model from "./sse_fp_model.mjs";
import { dot_product, round_lane } from "./sse4_model.mjs";

// the values: special ones, and a few to overflow, underflow and round
export const SINGLE = [0n, 0x80000000n, 0x3F800000n, 0xBF800000n, 0x3FC00000n, 1n, 0x807FFFFFn, 0x00800000n, 0x80800000n,
    0x7F7FFFFFn, 0xFF7FFFFFn, 0x7F800000n, 0xFF800000n, 0x7FC00001n, 0xFF812345n, 0x7F800003n,
    0x40400000n, 0x3DCCCCCDn, 0x7149F2CAn, 0x0DA24260n, 0x00C00000n, 0x4B800001n, 0xCF000000n, 0x4F000000n,
    // a product that rounds to the smallest normal but is tiny after rounding (UE)
    0x3EFFFFFFn, 0x01000000n];
export const DOUBLE = [0n, 0x8000000000000000n, 0x3FF0000000000000n, 0xBFF0000000000000n, 0x3FF8000000000000n, 1n,
    0x800FFFFFFFFFFFFFn, 0x0010000000000000n, 0x8010000000000000n, 0x7FEFFFFFFFFFFFFFn, 0xFFEFFFFFFFFFFFFFn,
    0x7FF0000000000000n, 0xFFF0000000000000n, 0x7FF8000000000001n, 0xFFF0123456789ABCn, 0x7FF0000000000003n,
    0x4008000000000000n, 0x3FB999999999999An, 0x7E37E43C8800759Cn, 0x01A56E1FC2F8F359n, 0x0018000000000000n,
    0x4340000000000001n, 0xC1E0000000000000n, 0x41E0000000000000n, 0x36A0000000000000n, 0x3810000000000000n,
    0x3FDFFFFFFFFFFFFFn, 0x0020000000000000n];
// MXCSR: defaults; PE set (the native paths); each rounding mode; DAZ, FZ;
// everything unmasked; only the post-computation exceptions unmasked
export const MXCSRS = [0x1F80, 0x1FA0, 0x3FA0, 0x5FA0, 0x7FA0, 0x1FE0, 0x9FA0, 0x9FE0, 0x0000, 0x0180, 0x0700 | 0x20];

let seed = 0x13572468;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const pick = list => list[random() % list.length];
const random_value = double => double ? BigInt(random()) << 32n | BigInt(random()) : BigInt(random());

export const lanes_of = (v, double, width = 128) => {
    const n = width / (double ? 64 : 32), bits = double ? 64n : 32n, mask = (1n << bits) - 1n;
    return Array.from({ length: n }, (_, i) => v >> BigInt(i) * bits & mask);
};
export const of_lanes = (lanes, double) => lanes.reduce((v, x, i) => v | x << BigInt(i) * (double ? 64n : 32n), 0n);
export const bytes128 = v => Uint8Array.from({ length: 16 }, (_, i) => Number(v >> BigInt(8 * i) & 0xFFn));

// The forms: prefix and opcode byte, the operation, the operand shape
export const FORMS = [];
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

// SSE4.1 (66 0F 3A): every rounding control with and without PE suppressed,
// and the dot products' lane masks (all products often)
for(const [code, name, double, scalar] of [[0x08, "roundps", false, false], [0x09, "roundpd", true, false],
    [0x0A, "roundss", false, true], [0x0B, "roundsd", true, true]])
{
    FORMS.push({ name, prefix: [0x66], map: 0x3A, code, kind: "round", double, scalar, imm8: (mi, n) => (mi * 5 + n) & 15 });
}
for(const [code, name, double] of [[0x40, "dpps", false], [0x41, "dppd", true]])
{
    FORMS.push({ name, prefix: [0x66], map: 0x3A, code, kind: "dot", double, imm8: (mi, n) => n % 3 === 0 ? 0xFF : (mi * 37 + n * 101) & 255 });
}

// integer sources: the edges of the conversions
const INTEGERS = [0n, 1n, 0xFFFFFFFFn, 0x7FFFFFFFn, 0x80000000n, 0x01000001n, 0xFEFFFFFFn, 0x075BCD15n, 0x80000001n, 0x00FFFFFFn];

/**
 * The cases of a form: { mxcsr, a (the destination), b (the source), imm8 }
 * with the model's expectation { result, after (MXCSR), fault }. The active
 * lanes go through every pair of special values, then random ones.
 */
export function cases(form)
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
            // (CMP: the predicate in imm8[2:0], the other bits set too, which legacy SSE ignores)
            const imm8 = typeof form.imm8 === "function" ? form.imm8(mi, n) : form.imm8 ? (mi + n) & 7 | (n * 3 + mi) % 32 << 3 : 0;
            out.push({ mxcsr, a: ca, b: cb, imm8, ...expect(form, mxcsr, ca, cb, form.kind === "compare" ? imm8 & 7 : imm8) });
        }
    });
    return out;
}
export function expect(form, mxcsr, a, b, imm8, width = 128)
{
    // (`width` 256: a VEX.256 form, its lanes with one exception context)
    const wide = width === 256, half = (v, h) => v >> BigInt(128 * h) & ((1n << 128n) - 1n);
    const fp = new model.Fp(mxcsr);
    let result;
    switch(form.kind)
    {
        case "binary": case "compare":
        {
            const la = lanes_of(a, form.double, width), lb = lanes_of(b, form.double, width);
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
            // (HADD/HSUB: their pairs within each half)
            const r = [];
            for(let h = 0; h < width / 128; h++)
            {
                const la = lanes_of(half(a, h), form.double), lb = lanes_of(half(b, h), form.double), n = la.length;
                for(let i = 0; i < n; i++)
                {
                    if(form.kind === "addsub") r.push(fp.binary(i % 2 ? "add" : "sub", la[i], lb[i], form.double));
                    else
                    {
                        const v = i < n / 2 ? la : lb, base = i % (n / 2) * 2;
                        r.push(fp.binary(form.op, v[base], v[base + 1], form.double));
                    }
                }
            }
            result = of_lanes(r, form.double);
            break;
        }
        case "round":
        {
            const la = lanes_of(a, form.double, width), lb = lanes_of(b, form.double, width);
            for(let i = 0; i < (form.scalar ? 1 : la.length); i++) la[i] = round_lane(fp, lb[i], form.double, imm8);
            result = of_lanes(la, form.double);
            break;
        }
        case "dot":
        {
            // (each operation with its own exceptions, see the model; VEX.256:
            // each half's in turn, an unmasked exception before the high one)
            const value = r => r.result.reduceRight((v, x) => v << 8n | BigInt(x), 0n);
            const low = dot_product(mxcsr, bytes128(half(a, 0)), bytes128(half(b, 0)), imm8, form.double);
            if(!wide || low.fault) return { result: value(low), after: low.mxcsr, fault: low.fault };
            const high = dot_product(low.mxcsr, bytes128(half(a, 1)), bytes128(half(b, 1)), imm8, form.double);
            return { result: value(low) | value(high) << 128n, after: high.mxcsr, fault: high.fault };
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
            const la = lanes_of(a, false, width), lb = lanes_of(b, false, width);
            if(!form.scalar) la.fill(0n);
            for(let i = 0; i < (form.scalar ? 1 : la.length); i++) la[i] = model.reciprocal(lb[i], form.square_root);
            result = of_lanes(la, false);
            break;
        }
        case "widen": case "narrow":
        {
            const from_double = form.kind === "narrow";
            // (VEX.256: four lanes, of an XMM source or into an XMM result)
            const lb = lanes_of(b, from_double, wide && from_double ? 256 : 128);
            const n = form.scalar ? 1 : wide ? 4 : 2;
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
            const n = (form.double ? 2 : 4) * (wide ? 2 : 1);
            const ints = lanes_of(b, false, wide && !form.double ? 256 : 128).map(x => BigInt.asIntN(32, x)).slice(0, n);
            result = of_lanes(ints.map(x => fp.from_integer(x, form.double)), form.double);
            break;
        }
        case "to_dwords":
        {
            const lb = lanes_of(b, form.double, width);
            const ints = lb.slice(0, (form.double ? 2 : 4) * (wide ? 2 : 1)).map(x => BigInt.asUintN(32, fp.to_integer(x, form.double, 32, form.truncate)));
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

