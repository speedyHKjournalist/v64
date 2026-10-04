// A model of SSE4.1 and SSE4.2 (docs/simd-xsave-plan.md 7.2, 7.3) written
// from the SDM's pseudocode, independent of src/rust/cpu: byte vectors in and
// out (16 bytes, little-endian lanes, read as BigInts); floating point with
// tests/rust/sse_fp_model.mjs (exact arithmetic under MXCSR); PCMPxSTRx after
// SDM Vol. 2, 4.1; CRC32 as the SDM's polynomial division (CRC-32C).
import { Fp, IE, PE, format, is_inf, is_nan, is_snan, is_zero } from "./sse_fp_model.mjs";

export { Fp };

/** Lane `i` of `size` bytes, unsigned or sign-extended */
export function get(v, size, i, signed = false)
{
    let x = 0n;
    for(let k = size - 1; k >= 0; k--) x = x << 8n | BigInt(v[i * size + k]);
    return signed && x >> BigInt(size * 8 - 1) ? x - (1n << BigInt(size * 8)) : x;
}
/** Lane `i` of `size` bytes := x (truncated) */
export function set(v, size, i, x)
{
    x = BigInt.asUintN(size * 8, x);
    for(let k = 0; k < size; k++) { v[i * size + k] = Number(x & 0xFFn); x >>= 8n; }
}
const lanes = (size, f) => {
    const r = new Uint8Array(16);
    for(let i = 0; i < 16 / size; i++) set(r, size, i, f(i));
    return r;
};
const min = (a, b) => a < b ? a : b, max = (a, b) => a > b ? a : b;

/** The 66 0F 38 forms but PTEST: the destination after the operation (BLENDV: the mask is XMM0) */
export function sse4_38(op, d, s, xmm0)
{
    switch(op)
    {
        case 0x10: return lanes(1, i => get(xmm0, 1, i) & 0x80n ? get(s, 1, i) : get(d, 1, i)); // pblendvb
        case 0x14: return lanes(4, i => get(xmm0, 4, i) >> 31n ? get(s, 4, i) : get(d, 4, i)); // blendvps
        case 0x15: return lanes(8, i => get(xmm0, 8, i) >> 63n ? get(s, 8, i) : get(d, 8, i)); // blendvpd
        // pmovsx/pmovzx: the low elements of the source, extended
        case 0x20: case 0x30: return lanes(2, i => get(s, 1, i, op === 0x20)); // bw
        case 0x21: case 0x31: return lanes(4, i => get(s, 1, i, op === 0x21)); // bd
        case 0x22: case 0x32: return lanes(8, i => get(s, 1, i, op === 0x22)); // bq
        case 0x23: case 0x33: return lanes(4, i => get(s, 2, i, op === 0x23)); // wd
        case 0x24: case 0x34: return lanes(8, i => get(s, 2, i, op === 0x24)); // wq
        case 0x25: case 0x35: return lanes(8, i => get(s, 4, i, op === 0x25)); // dq
        case 0x28: return lanes(8, i => get(d, 4, 2 * i, true) * get(s, 4, 2 * i, true)); // pmuldq
        case 0x29: return lanes(8, i => get(d, 8, i) === get(s, 8, i) ? -1n : 0n); // pcmpeqq
        case 0x2B: return lanes(2, i => { // packusdw
            const x = i < 4 ? get(d, 4, i, true) : get(s, 4, i - 4, true);
            return x < 0n ? 0n : x > 0xFFFFn ? 0xFFFFn : x;
        });
        case 0x37: return lanes(8, i => get(d, 8, i, true) > get(s, 8, i, true) ? -1n : 0n); // pcmpgtq (SSE4.2)
        case 0x38: return lanes(1, i => min(get(d, 1, i, true), get(s, 1, i, true))); // pminsb
        case 0x39: return lanes(4, i => min(get(d, 4, i, true), get(s, 4, i, true))); // pminsd
        case 0x3A: return lanes(2, i => min(get(d, 2, i), get(s, 2, i))); // pminuw
        case 0x3B: return lanes(4, i => min(get(d, 4, i), get(s, 4, i))); // pminud
        case 0x3C: return lanes(1, i => max(get(d, 1, i, true), get(s, 1, i, true))); // pmaxsb
        case 0x3D: return lanes(4, i => max(get(d, 4, i, true), get(s, 4, i, true))); // pmaxsd
        case 0x3E: return lanes(2, i => max(get(d, 2, i), get(s, 2, i))); // pmaxuw
        case 0x3F: return lanes(4, i => max(get(d, 4, i), get(s, 4, i))); // pmaxud
        case 0x40: return lanes(4, i => get(d, 4, i, true) * get(s, 4, i, true)); // pmulld: the low half
        case 0x41: { // phminposuw: the smallest word of the source and its (first) index
            let index = 0;
            for(let i = 1; i < 8; i++) if(get(s, 2, i) < get(s, 2, index)) index = i;
            return lanes(2, i => i === 0 ? get(s, 2, index) : i === 1 ? BigInt(index) : 0n);
        }
    }
    throw new Error("sse4_38 " + op.toString(16));
}

/** PTEST: ZF if source AND destination is zero, CF if source AND NOT destination is; the others clear */
export function ptest(d, s)
{
    let and = 0n, andn = 0n;
    for(let i = 0; i < 2; i++)
    {
        and |= get(d, 8, i) & get(s, 8, i);
        andn |= get(s, 8, i) & ~get(d, 8, i);
    }
    return { zf: and === 0n, cf: BigInt.asUintN(64, andn) === 0n };
}

/** The 66 0F 3A integer and bitwise forms with imm8 (INSERTPS: `s` a register; see insertps) */
export function sse4_3a(op, d, s, imm8)
{
    switch(op)
    {
        case 0x0C: return lanes(4, i => imm8 >> i & 1 ? get(s, 4, i) : get(d, 4, i)); // blendps
        case 0x0D: return lanes(8, i => imm8 >> i & 1 ? get(s, 8, i) : get(d, 8, i)); // blendpd
        case 0x0E: return lanes(2, i => imm8 >> i & 1 ? get(s, 2, i) : get(d, 2, i)); // pblendw
        case 0x21: return insertps(d, get(s, 4, imm8 >> 6 & 3), imm8);
        case 0x42: { // mpsadbw: eight sums of absolute differences against a 4-byte block of the source
            const source = (imm8 & 3) * 4, destination = (imm8 >> 2 & 1) * 4;
            return lanes(2, i => {
                let sum = 0n;
                for(let j = 0; j < 4; j++)
                {
                    const x = get(d, 1, destination + i + j) - get(s, 1, source + j);
                    sum += x < 0n ? -x : x;
                }
                return sum;
            });
        }
    }
    throw new Error("sse4_3a " + op.toString(16));
}
/** INSERTPS with the 32-bit `value` (from memory, or the dword of the source register imm8[7:6] selects) */
export function insertps(d, value, imm8)
{
    const r = lanes(4, i => i === (imm8 >> 4 & 3) ? value : get(d, 4, i));
    return lanes(4, i => imm8 >> i & 1 ? 0n : get(r, 4, i));
}
/** PEXTRB/PEXTRW/PEXTRD/PEXTRQ/EXTRACTPS: the element imm8 selects */
export const extract = (v, size, imm8) => get(v, size, imm8 & (16 / size - 1));
/** PINSRB/PINSRD/PINSRQ: the element imm8 selects := value */
export function insert(d, size, value, imm8)
{
    const r = Uint8Array.from(d);
    set(r, size, imm8 & (16 / size - 1), value);
    return r;
}

/**
 * ROUNDPS/PD/SS/SD of one lane: to an integral value by imm8[1:0], or by
 * MXCSR.RC if imm8[2]; imm8[3] suppresses PE. IE for an SNaN, never DE;
 * DAZ applies. Zeros keep their sign.
 */
export function round_lane(fp, x0, double, imm8)
{
    const f = format(double);
    const { x } = fp.input(x0, double);
    if(is_nan(x, double))
    {
        if(is_snan(x, double)) fp.flags |= IE;
        return x | 1n << BigInt(f.p - 2);
    }
    if(is_inf(x, double) || is_zero(x, double)) return x;
    const rc = imm8 & 4 ? fp.rc : imm8 & 3;
    const sign = x >> BigInt(f.bits - 1) & 1n;
    const field = Number(x >> BigInt(f.p - 1) & (1n << BigInt(f.ebits)) - 1n);
    const bias = (1 << f.ebits - 1) - 1;
    const m = x & (1n << BigInt(f.p - 1)) - 1n | (field ? 1n << BigInt(f.p - 1) : 0n);
    const e = (field || 1) - bias - (f.p - 1); // |x| = m * 2^e
    if(e >= 0) return x;
    const q = m >> BigInt(-e), rem = m & (1n << BigInt(-e)) - 1n, half = 1n << BigInt(-e - 1);
    let up;
    switch(rc)
    {
        case 0: up = rem > half || rem === half && (q & 1n) === 1n; break;
        case 1: up = sign === 1n && rem !== 0n; break;
        case 2: up = sign === 0n && rem !== 0n; break;
        default: up = false;
    }
    if(rem !== 0n && !(imm8 & 8)) fp.flags |= PE;
    const n = up ? q + 1n : q;
    if(n === 0n) return sign << BigInt(f.bits - 1);
    // an integer of at most p bits: exact
    const length = n.toString(2).length;
    return sign << BigInt(f.bits - 1) | BigInt(length - 1 + bias) << BigInt(f.p - 1) | n << BigInt(f.p - length) & (1n << BigInt(f.p - 1)) - 1n;
}

/**
 * DPPS/DPPD: the products imm8[7:4] selects (else +0.0), summed pairwise in
 * the SDM's order, each operation rounded, to the lanes imm8[3:0] selects
 * (else +0.0). Returns the lanes and whether an unmasked exception stops it:
 * the operations run in order, the first one raising an unmasked exception
 * faults (its flags as for a single operation, SDM Vol. 1, 11.5.3), later
 * ones do not run.
 */
export function dot_product(mxcsr, d, s, imm8, double)
{
    const size = double ? 8 : 4, n = 16 / size;
    const fp = new Fp(mxcsr);
    let flags = 0, fault = false;
    // one operation, with its own exception order
    const step = (op, a, b) => {
        if(fault) return 0n;
        const one = new Fp(mxcsr);
        const r = one.binary(op, a, b, double);
        const done = one.finish();
        flags |= done.mxcsr & 0x3F;
        if(done.fault) fault = true;
        return r;
    };
    const products = Array.from({ length: n }, (_, i) => imm8 >> 4 + i & 1 ? step("mul", get(d, size, i), get(s, size, i)) : 0n);
    let sum;
    if(double) sum = step("add", products[0], products[1]);
    else sum = step("add", step("add", products[0], products[1]), step("add", products[2], products[3]));
    fp.flags = flags;
    return { result: lanes(size, i => imm8 >> i & 1 ? sum : 0n), mxcsr: mxcsr | flags, fault };
}

/**
 * PCMPESTRI/PCMPESTRM/PCMPISTRI/PCMPISTRM (SDM Vol. 2, 4.1): `a` the first
 * operand (xmm1), `b` the second (xmm2/m128), `la` and `lb` the explicit
 * lengths (EAX/EDX or RAX/RDX as signed BigInts; undefined: implicit, up to
 * the first zero element). Returns IntRes2 (a bit per element of b), the
 * xSTRI index, the xSTRM mask and CF, ZF, SF, OF (AF and PF are cleared).
 */
export function compare_strings(imm8, a, b, la, lb)
{
    const words = imm8 & 1, signed = (imm8 & 2) !== 0, n = words ? 8 : 16, size = words ? 2 : 1;
    const ea = Array.from({ length: n }, (_, i) => get(a, size, i, signed));
    const eb = Array.from({ length: n }, (_, i) => get(b, size, i, signed));
    const length = (e, explicit) => {
        if(explicit === undefined)
        {
            const zero = e.indexOf(0n);
            return zero < 0 ? n : zero;
        }
        const magnitude = explicit < 0n ? -explicit : explicit;
        return magnitude > BigInt(n) ? n : Number(magnitude);
    };
    const va = length(ea, la), vb = length(eb, lb);
    const aggregation = imm8 >> 2 & 3;
    // BoolRes for element j of b and element i of a, invalid elements forced (SDM table 4-7)
    const bool = (j, i) => {
        const a_valid = i < va, b_valid = j < vb;
        if(!a_valid || !b_valid)
        {
            if(aggregation === 2) return !a_valid && !b_valid; // equal each
            if(aggregation === 3) return !a_valid; // equal ordered
            return false;
        }
        if(aggregation === 1) return i % 2 === 0 ? eb[j] >= ea[i] : eb[j] <= ea[i]; // ranges
        return ea[i] === eb[j];
    };
    let intres1 = 0;
    for(let j = 0; j < n; j++)
    {
        let r = false;
        switch(aggregation)
        {
            case 0: for(let i = 0; i < n; i++) r ||= bool(j, i); break; // equal any
            case 1: for(let i = 0; i < n; i += 2) r ||= bool(j, i) && bool(j, i + 1); break; // ranges
            case 2: r = bool(j, j); break; // equal each
            case 3: r = true; for(let k = 0; k < n - j; k++) r &&= bool(j + k, k); break; // equal ordered
        }
        if(r) intres1 |= 1 << j;
    }
    const all = (1 << n) - 1;
    let intres2;
    switch(imm8 >> 4 & 3)
    {
        case 1: intres2 = ~intres1 & all; break; // negative
        case 3: intres2 = intres1 ^ (1 << vb) - 1; break; // masked negative: the valid elements of b
        default: intres2 = intres1;
    }
    let index = n;
    if(intres2) index = imm8 & 0x40 ? 31 - Math.clz32(intres2) : 31 - Math.clz32(intres2 & -intres2);
    const mask = imm8 & 0x40 ? lanes(size, i => intres2 >> i & 1 ? -1n : 0n) : lanes(2, i => i === 0 ? BigInt(intres2) : 0n);
    return { intres2, index, mask, cf: intres2 !== 0, zf: vb < n, sf: va < n, of: (intres2 & 1) !== 0 };
}

const reflect = (x, bits) => {
    let r = 0n;
    for(let i = 0n; i < BigInt(bits); i++) r |= (x >> i & 1n) << BigInt(bits) - 1n - i;
    return r;
};
/** Polynomial remainder over GF(2) */
const mod2 = (x, p) => {
    const degree = p.toString(2).length - 1;
    for(let bit = x.toString(2).length - 1; bit >= degree; bit--)
    {
        if(x >> BigInt(bit) & 1n) x ^= p << BigInt(bit - degree);
    }
    return x;
};
/** CRC32 with a source of `bytes` bytes: the SDM's BIT_REFLECT and MOD2 by 11EDC6F41H */
export function crc32(crc, value, bytes)
{
    const bits = bytes * 8;
    const t3 = reflect(BigInt.asUintN(bits, value), bits) << 32n;
    const t4 = reflect(BigInt.asUintN(32, crc), 32) << BigInt(bits);
    return reflect(mod2(t3 ^ t4, 0x11EDC6F41n), 32);
}
