// The FMA and F16C forms of docs/simd-xsave-plan.md 9.3 (P11) and their
// cases for tests/rust/fma.mjs and tests/x64/fma.mjs, with the expectations of
// tests/rust/sse_fp_model.mjs (exact rational arithmetic, independent of
// SoftFloat and cpu/simd_fp.rs).
import { SINGLE, DOUBLE, MXCSRS, lanes_of, of_lanes } from "./sse_fp_cases.mjs";
import * as model from "./sse_fp_model.mjs";

// The FMA forms: opcode, the operation (by its low nibble), the order (by its
// high one: 132, 213, 231), PS/PD/SS/SD, VEX.L
export const FMA_FORMS = [];
for(const [code, name, packed] of [[0x96, "fmaddsub", true], [0x97, "fmsubadd", true], [0x98, "fmadd", true], [0x99, "fmadd", false],
    [0x9A, "fmsub", true], [0x9B, "fmsub", false], [0x9C, "fnmadd", true], [0x9D, "fnmadd", false], [0x9E, "fnmsub", true], [0x9F, "fnmsub", false]])
{
    for(const [order, delta] of [["132", 0], ["213", 0x10], ["231", 0x20]])
        for(const double of [false, true])
            for(const l of packed ? [0, 1] : [0])
                FMA_FORMS.push({ name: `v${name}${order}${packed ? "p" : "s"}${double ? "d" : "s"}${l ? " ymm" : ""}`, op: code + delta, double, scalar: !packed, l });
}
/** A lane's x, y, z (x × y + z) of the operands a (DEST), b (SRC2), c (SRC3) */
export const order = (form, a, b, c) => ({ 9: [a, c, b], 10: [b, a, c], 11: [b, c, a] })[form.op >> 4];
/** The operands a, b, c that give x, y, z (`order`'s inverse) */
export const place = (form, x, y, z) => ({ 9: [x, z, y], 10: [y, x, z], 11: [z, x, y] })[form.op >> 4];
/** Lane i's negations: [the product's, the addend's] */
export function negations(form, i)
{
    const kind = form.op & 15, even = i % 2 === 0;
    if(kind === 6) return [false, even];
    if(kind === 7) return [false, !even];
    return [[false, false], [false, false], [false, true], [false, true], [true, false], [true, false], [true, true], [true, true]][kind - 8];
}
/** The model's result of an FMA form: { result, after, fault } */
export function fma_expect(form, mxcsr, a, b, c)
{
    const width = form.l ? 256 : 128;
    const fp = new model.Fp(mxcsr);
    const la = lanes_of(a, form.double, width), lb = lanes_of(b, form.double, width), lc = lanes_of(c, form.double, width);
    for(let i = 0; i < (form.scalar ? 1 : la.length); i++)
    {
        const [x, y, z] = order(form, la[i], lb[i], lc[i]);
        const [np, na] = negations(form, i);
        la[i] = fp.fused(x, y, z, form.double, np, na);
    }
    const { mxcsr: after, fault } = fp.finish();
    return { result: of_lanes(la, form.double), after, fault };
}

let seed = 0x2468ACE1;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const pick = list => list[random() % list.length];
const random_value = double => double ? BigInt(random()) << 32n | BigInt(random()) : BigInt(random());
/** A normal value of moderate size (exponent within ±16 of 0) */
const moderate = double => double ? BigInt(0x3F0 + random() % 32) << 52n | BigInt(random()) << 20n | BigInt(random() & 0xFFFFF) | BigInt(random() & 1) << 63n
    : BigInt(0x6F + random() % 32) << 23n | BigInt(random() & 0x7FFFFF) | BigInt(random() & 1) << 31n;
/** x, y, z in the order of x × y + z: the special triples */
export function triples(double)
{
    const v = double
        ? { q1: 0x7FF8000000000001n, q2: 0xFFF8000000000002n, s3: 0x7FF0000000000003n, q4: 0x7FF8000000000004n, s5: 0xFFF0000000000005n,
            one: 0x3FF0000000000000n, none: 0xBFF0000000000000n, two: 0x4000000000000000n, zero: 0n, nzero: 0x8000000000000000n, inf: 0x7FF0000000000000n, ninf: 0xFFF0000000000000n,
            max: 0x7FEFFFFFFFFFFFFFn, nmax: 0xFFEFFFFFFFFFFFFFn, min: 0x0010000000000000n, half: 0x3FE0000000000000n, denormal: 0x000FFFFFFFFFFFFFn, ndenormal: 0x8000000000000001n }
        : { q1: 0x7FC00001n, q2: 0xFFC00002n, s3: 0x7F800003n, q4: 0x7FC00004n, s5: 0xFF800005n,
            one: 0x3F800000n, none: 0xBF800000n, two: 0x40000000n, zero: 0n, nzero: 0x80000000n, inf: 0x7F800000n, ninf: 0xFF800000n,
            max: 0x7F7FFFFFn, nmax: 0xFF7FFFFFn, min: 0x00800000n, half: 0x3F000000n, denormal: 0x007FFFFFn, ndenormal: 0x80000001n };
    return [
        // NaNs: the first of x, y, z wins (an SNaN: IE)
        [v.q1, v.q2, v.q4], [v.s3, v.q2, v.q4], [v.q1, v.s3, v.q4], [v.q1, v.q2, v.s3], [v.one, v.q2, v.s5], [v.one, v.one, v.s3],
        [v.one, v.one, v.q4], [v.q2, v.one, v.one], [v.one, v.s5, v.denormal],
        // 0 × ∞: with a QNaN addend that NaN and no IE; with an SNaN IE; with a number IE and the default NaN
        [v.zero, v.inf, v.q4], [v.ninf, v.zero, v.q1], [v.inf, v.nzero, v.s3], [v.zero, v.inf, v.one], [v.inf, v.zero, v.inf],
        // ∞ − ∞, ∞ + ∞, ∞ with a number
        [v.inf, v.one, v.ninf], [v.inf, v.one, v.inf], [v.ninf, v.two, v.one], [v.one, v.one, v.ninf],
        // zero sums and their signs
        [v.zero, v.one, v.nzero], [v.nzero, v.one, v.nzero], [v.zero, v.one, v.zero], [v.one, v.one, v.none],
        // overflow, underflow, denormals (DAZ, FZ, DE)
        [v.max, v.max, v.ninf], [v.max, v.two, v.nmax], [v.max, v.two, v.one], [v.min, v.half, v.zero], [v.min, v.half, v.denormal],
        [v.denormal, v.one, v.zero], [v.denormal, v.denormal, v.one], [v.ndenormal, v.two, v.denormal], [v.min, v.min, v.nzero],
    ];
}
/** x, y and the negated rounded product: the fused result is the rounding error */
export function error_triple(double)
{
    const x = moderate(double), y = moderate(double);
    const product = new model.Fp(0x1F80).binary("mul", x, y, double);
    return [x, y, product ^ (double ? 1n << 63n : 1n << 31n)];
}
/** An FMA form's cases: { mxcsr, a, b, c } and the model's expectation */
export function fma_cases(form, mxcsrs = MXCSRS, extra = 4)
{
    const width = form.l ? 256 : 128, lanes = width / (form.double ? 64 : 32), active = form.scalar ? 1 : lanes;
    const special = triples(form.double), values = form.double ? DOUBLE : SINGLE;
    // (each MXCSR: every special triple, then `extra` cases: half with
    // rounding errors exposed, half random)
    const per_mxcsr = Math.ceil(special.length / active) + extra;
    const out = [];
    let k = 0;
    mxcsrs.forEach(mxcsr => {
        for(let n = 0; n < per_mxcsr; n++)
        {
            const a = [], b = [], c = [];
            for(let i = 0; i < lanes; i++)
            {
                let xyz;
                if(i >= active) xyz = [random_value(form.double), random_value(form.double), random_value(form.double)];
                else if(n < per_mxcsr - extra) xyz = special[k++ % special.length];
                else if(n < per_mxcsr - extra / 2) xyz = error_triple(form.double);
                else xyz = [0, 1, 2].map(() => random() & 1 ? pick(values) : random() & 1 ? moderate(form.double) : random_value(form.double));
                const [p, q, r] = place(form, ...xyz);
                a.push(p); b.push(q); c.push(r);
            }
            const ca = of_lanes(a, form.double), cb = of_lanes(b, form.double), cc = of_lanes(c, form.double);
            out.push({ mxcsr, a: ca, b: cb, c: cc, ...fma_expect(form, mxcsr, ca, cb, cc) });
        }
    });
    return out;
}

// F16C: the halves and singles to convert
export const HALVES = [0x0000n, 0x8000n, 0x3C00n, 0xBC00n, 0x0001n, 0x03FFn, 0x8200n, 0x0400n, 0x7BFFn, 0xFBFFn, 0x7C00n, 0xFC00n,
    0x7E00n, 0x7C01n, 0xFD23n, 0x7FFFn, 0x3555n, 0x5640n, 0xC123n, 0x2E66n];
export const SINGLES_TO_HALF = [...SINGLE, 0x477FE000n /* 65504 */, 0x477FEFFFn, 0x477FF000n /* 65520 */, 0x38800000n /* 2^-14 */, 0x33800000n /* 2^-24 */,
    0x33000000n /* 2^-25 */, 0x33000001n, 0x3F801000n /* 1 + 2^-11 */, 0x3F803000n, 0xBF801000n, 0x387FC000n, 0x38000000n, 0xC77FFFFFn, 0x7F801234n, 0xFFC0ABCDn];
export const F16C_FORMS = [
    { name: "vcvtph2ps", kind: "ph2ps", l: 0 }, { name: "vcvtph2ps ymm", kind: "ph2ps", l: 1 },
    { name: "vcvtps2ph", kind: "ps2ph", l: 0 }, { name: "vcvtps2ph ymm", kind: "ps2ph", l: 1 },
];
/** An F16C form's cases: { mxcsr, source, imm8 } and the model's expectation */
export function f16c_cases(form, mxcsrs = MXCSRS, per_mxcsr = 10)
{
    const count = form.l ? 8 : 4, out = [];
    let k = 0;
    mxcsrs.forEach((mxcsr, mi) => {
        for(let n = 0; n < per_mxcsr; n++)
        {
            // (every rounding control: imm8[1:0], or MXCSR.RC with imm8[2]; bits 7:3 ignored)
            const imm8 = (mi + n) & 7 | (n & 1 ? 0xA8 : 0);
            const fp = new model.Fp(mxcsr);
            const rc = imm8 & 4 ? mxcsr >> 13 & 3 : imm8 & 3;
            const lanes = [];
            for(let i = 0; i < count; i++)
            {
                const list = form.kind === "ph2ps" ? HALVES : SINGLES_TO_HALF;
                lanes.push(n < per_mxcsr * 0.7 ? list[k++ % list.length] : form.kind === "ph2ps" ? BigInt(random() & 0xFFFF) : random_value(false));
            }
            let source, result;
            if(form.kind === "ph2ps")
            {
                source = lanes.reduce((v, h, i) => v | h << BigInt(16 * i), 0n);
                result = lanes.reduce((v, h, i) => v | fp.half_to_single(h) << BigInt(32 * i), 0n);
            }
            else
            {
                source = of_lanes(lanes, false);
                result = lanes.reduce((v, x, i) => v | fp.single_to_half(x, rc) << BigInt(16 * i), 0n);
            }
            const { mxcsr: after, fault } = fp.finish();
            out.push({ mxcsr, source, imm8, result, after, fault });
        }
    });
    return out;
}
