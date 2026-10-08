// A model of SSE floating point (docs/simd-xsave-plan.md 7.4) written from
// IEEE 754 and the SDM, independent of src/rust/cpu/simd_fp.rs and SoftFloat:
// exact rational arithmetic on BigInts, rounded by MXCSR.RC, with DAZ and FZ,
// x86's NaN rules (SDM Vol. 1, 4.8.3.5), tininess detected after rounding
// (SDM Vol. 1, 4.9.1.5), the exception precedence of SDM Vol. 1, 4.9.2 and
// the order of SDM Vol. 1, 11.5.3 (`finish`).
//
// Values are BigInt bit patterns; `double` selects binary64 over binary32.

export const IE = 1, DE = 2, ZE = 4, OE = 8, UE = 16, PE = 32;

export function format(double)
{
    return double ? { bits: 64, p: 53, ebits: 11 } : { bits: 32, p: 24, ebits: 8 };
}
/** binary16 (F16C's half precision) */
export const HALF = { bits: 16, p: 11, ebits: 5 };
const mask = n => (1n << BigInt(n)) - 1n;
const bias = f => (1 << (f.ebits - 1)) - 1;
const max_exponent = f => (1 << f.ebits) - 1;
const sign_bit = f => 1n << BigInt(f.bits - 1);
const bit_length = m => m === 0n ? 0 : m.toString(2).length;

function parts(x, f)
{
    return {
        sign: Number(x >> BigInt(f.bits - 1) & 1n),
        exponent: Number(x >> BigInt(f.p - 1) & mask(f.ebits)),
        fraction: x & mask(f.p - 1),
    };
}
export function is_nan(x, double) { const f = format(double), q = parts(x, f); return q.exponent === max_exponent(f) && q.fraction !== 0n; }
export function is_snan(x, double) { const f = format(double); return is_nan(x, double) && (x >> BigInt(f.p - 2) & 1n) === 0n; }
export function is_inf(x, double) { const f = format(double), q = parts(x, f); return q.exponent === max_exponent(f) && q.fraction === 0n; }
export function is_zero(x, double) { return (x & mask(format(double).bits - 1)) === 0n; }
export function is_denormal(x, double) { const f = format(double), q = parts(x, f); return q.exponent === 0 && q.fraction !== 0n; }
const quiet = (x, f) => x | 1n << BigInt(f.p - 2);
export const indefinite = double => double ? 0xFFF8000000000000n : 0xFFC00000n;
const infinity = (sign, f) => (sign ? sign_bit(f) : 0n) | mask(f.ebits) << BigInt(f.p - 1);
const zero = (sign, f) => sign ? sign_bit(f) : 0n;

/** A finite value: |x| = m * 2^e */
function value(x, f)
{
    const q = parts(x, f);
    if(q.exponent === 0) return { sign: q.sign, m: q.fraction, e: 1 - bias(f) - (f.p - 1) };
    return { sign: q.sign, m: q.fraction | 1n << BigInt(f.p - 1), e: q.exponent - bias(f) - (f.p - 1) };
}

/**
 * Round (-1)^sign * (m * 2^e + something below 2^e if `sticky`), m > 0 or
 * sticky, to the format by RC (0 nearest even, 1 down, 2 up, 3 toward zero):
 * { bits, flags (OE, UE, PE as with every exception masked), tiny }
 */
export function round(sign, m, e, sticky, f, rc)
{
    const emin = 1 - bias(f);
    const s = sign ? sign_bit(f) : 0n;
    // m * 2^-drop, rounded
    const shift = (m, drop) => {
        let q, rem = 0n, half = 0n;
        if(drop > 0) { q = m >> BigInt(drop); rem = m & mask(drop); half = 1n << BigInt(drop - 1); }
        else q = m << BigInt(-drop);
        const inexact = rem !== 0n || sticky;
        let up;
        switch(rc)
        {
            case 0: up = drop > 0 && (rem > half || rem === half && (sticky || (q & 1n) === 1n)); break;
            case 1: up = sign === 1 && inexact; break;
            case 2: up = sign === 0 && inexact; break;
            default: up = false;
        }
        return { q: up ? q + 1n : q, inexact };
    };
    // with an unbounded exponent: p significant bits
    let drop = bit_length(m) - f.p;
    const u = shift(m, drop);
    if(bit_length(u.q) > f.p) { u.q >>= 1n; drop += 1; }
    const exponent = e + drop + f.p - 1; // of the leading bit
    if(exponent > bias(f))
    {
        const to_infinity = rc === 0 || rc === 1 && sign === 1 || rc === 2 && sign === 0;
        const largest = BigInt(max_exponent(f) - 1) << BigInt(f.p - 1) | mask(f.p - 1);
        return { bits: s | (to_infinity ? infinity(0, f) : largest), flags: OE | PE, tiny: false };
    }
    const tiny = exponent < emin;
    if(!tiny)
    {
        const bits = BigInt(exponent + bias(f)) << BigInt(f.p - 1) | u.q & mask(f.p - 1);
        return { bits: s | bits, flags: u.inexact ? PE : 0, tiny };
    }
    // on the denormal grid (rounding up may reach the smallest normal: the same bits)
    const d = shift(m, emin - (f.p - 1) - e);
    return { bits: s | d.q, flags: d.inexact ? PE | UE : 0, tiny };
}

/** One SSE instruction's MXCSR: its controls, and the flags of its lanes */
/**
 * The comparison predicates of CMPPS/CMPPD/CMPSS/CMPSD (0-7, imm8[2:0]) and
 * VCMPPS/VCMPPD/VCMPSS/VCMPSD (0-31, imm8[4:0]), SDM vol. 2A, CMPPD, Table
 * 3-1: [name, the result when (less, equal, greater, unordered), whether a
 * QNaN operand signals an invalid operation]
 */
export const PREDICATES = [
    ["EQ_OQ", [0, 1, 0, 0], 0], ["LT_OS", [1, 0, 0, 0], 1], ["LE_OS", [1, 1, 0, 0], 1], ["UNORD_Q", [0, 0, 0, 1], 0],
    ["NEQ_UQ", [1, 0, 1, 1], 0], ["NLT_US", [0, 1, 1, 1], 1], ["NLE_US", [0, 0, 1, 1], 1], ["ORD_Q", [1, 1, 1, 0], 0],
    ["EQ_UQ", [0, 1, 0, 1], 0], ["NGE_US", [1, 0, 0, 1], 1], ["NGT_US", [1, 1, 0, 1], 1], ["FALSE_OQ", [0, 0, 0, 0], 0],
    ["NEQ_OQ", [1, 0, 1, 0], 0], ["GE_OS", [0, 1, 1, 0], 1], ["GT_OS", [0, 0, 1, 0], 1], ["TRUE_UQ", [1, 1, 1, 1], 0],
    ["EQ_OS", [0, 1, 0, 0], 1], ["LT_OQ", [1, 0, 0, 0], 0], ["LE_OQ", [1, 1, 0, 0], 0], ["UNORD_S", [0, 0, 0, 1], 1],
    ["NEQ_US", [1, 0, 1, 1], 1], ["NLT_UQ", [0, 1, 1, 1], 0], ["NLE_UQ", [0, 0, 1, 1], 0], ["ORD_S", [1, 1, 1, 0], 1],
    ["EQ_US", [0, 1, 0, 1], 1], ["NGE_UQ", [1, 0, 0, 1], 0], ["NGT_UQ", [1, 1, 0, 1], 0], ["FALSE_OS", [0, 0, 0, 0], 1],
    ["NEQ_OS", [1, 0, 1, 0], 1], ["GE_OQ", [0, 1, 1, 0], 0], ["GT_OQ", [0, 0, 1, 0], 0], ["TRUE_US", [1, 1, 1, 1], 1],
];

export class Fp
{
    constructor(mxcsr)
    {
        this.mxcsr = mxcsr;
        this.flags = 0;
        this.rc = mxcsr >> 13 & 3;
        this.daz = (mxcsr & 0x40) !== 0;
        this.fz = (mxcsr & 0x8000) !== 0;
        this.um_masked = (mxcsr & 0x800) !== 0;
    }
    /** A floating-point source: zero for a denormal with DAZ; its DE, if any */
    input(x, double)
    {
        if(!is_denormal(x, double)) return { x, de: 0 };
        if(this.daz) return { x: x & sign_bit(format(double)), de: 0 };
        return { x, de: DE };
    }
    /** A rounded result: FZ and unmasked underflow (any tiny result) */
    deliver(r, double)
    {
        if(r.tiny)
        {
            if(!this.um_masked) r.flags |= UE;
            else if(this.fz)
            {
                r.flags |= UE | PE;
                r.bits &= sign_bit(format(double));
            }
        }
        this.flags |= r.flags;
        return r.bits;
    }
    /** One lane of "add", "sub", "mul", "div", "sqrt" (of b), "min", "max" */
    binary(op, a0, b0, double)
    {
        const f = format(double);
        const ia = op === "sqrt" ? { x: 0n, de: 0 } : this.input(a0, double), ib = this.input(b0, double);
        const a = ia.x, b = ib.x, de = ia.de | ib.de;
        if(op === "min" || op === "max")
        {
            // any NaN: the second operand, as it is, and IE
            if(is_nan(a, double) || is_nan(b, double)) { this.flags |= IE; return b; }
            this.flags |= de;
            const c = compare(a, b, double);
            return (op === "min" ? c < 0 : c > 0) ? a : b;
        }
        // NaN operands: the first one's, quieted (IE for an SNaN; DE is not reported)
        const nans = op === "sqrt" ? [b] : [a, b];
        if(nans.some(x => is_snan(x, double))) this.flags |= IE;
        const nan = nans.find(x => is_nan(x, double));
        if(nan !== undefined) return quiet(nan, f);
        const invalid = () => { this.flags |= IE; return indefinite(double); };
        const sa = parts(a, f).sign, sb = parts(b, f).sign;
        const [ia_, ib_, za, zb] = [is_inf(a, double), is_inf(b, double), is_zero(a, double), is_zero(b, double)];
        switch(op)
        {
            case "add": case "sub":
            {
                const sb2 = op === "sub" ? sb ^ 1 : sb;
                if(ia_ && ib_) return sa === sb2 ? infinity(sa, f) : invalid();
                this.flags |= de;
                if(ia_) return infinity(sa, f);
                if(ib_) return infinity(sb2, f);
                const x = value(a, f), y = value(b, f);
                const e = Math.min(x.e, y.e);
                const sum = (x.sign ? -1n : 1n) * (x.m << BigInt(x.e - e)) + (sb2 ? -1n : 1n) * (y.m << BigInt(y.e - e));
                if(sum === 0n)
                {
                    // exact zeros: -0 for two negative ones, else -0 only when rounding down
                    return zero(za && zb && sa === 1 && sb2 === 1 || !(za && zb && sa === sb2) && this.rc === 1 ? 1 : 0, f);
                }
                return this.deliver(round(sum < 0n ? 1 : 0, sum < 0n ? -sum : sum, e, false, f, this.rc), double);
            }
            case "mul":
            {
                const sign = sa ^ sb;
                if((ia_ || ib_) && (za || zb)) return invalid();
                this.flags |= de;
                if(ia_ || ib_) return infinity(sign, f);
                if(za || zb) return zero(sign, f);
                const x = value(a, f), y = value(b, f);
                return this.deliver(round(sign, x.m * y.m, x.e + y.e, false, f, this.rc), double);
            }
            case "div":
            {
                const sign = sa ^ sb;
                if(ia_ && ib_ || za && zb) return invalid();
                // an infinite dividend: infinite, even divided by zero (no ZE)
                if(ia_) { this.flags |= de; return infinity(sign, f); }
                if(zb) { this.flags |= ZE; return infinity(sign, f); }
                this.flags |= de;
                if(ib_ || za) return zero(sign, f);
                const x = value(a, f), y = value(b, f);
                const k = 2 * f.p + 8;
                const scaled = x.m << BigInt(k);
                return this.deliver(round(sign, scaled / y.m, x.e - y.e - k, scaled % y.m !== 0n, f, this.rc), double);
            }
            case "sqrt":
            {
                if(zb) return b;
                if(sb) return invalid();
                this.flags |= de;
                if(ib_) return b;
                const y = value(b, f);
                let m = y.m, e = y.e;
                if(e & 1) { m <<= 1n; e -= 1; }
                const k = 2 * (2 * f.p + 8);
                m <<= BigInt(k);
                e -= k;
                const root = isqrt(m);
                return this.deliver(round(0, root, e / 2, root * root !== m, f, this.rc), double);
            }
        }
        throw new Error(op);
    }
    /**
     * One lane of FMA (SDM Vol. 1, 14.5.2, Table 14-17): x * y (negated if
     * `negate_product`) + z (negated if `negate_addend`), the exact sum
     * rounded once. NaN operands: the first of x, y, z, quieted and not
     * negated; IE for an SNaN, and for 0 * inf only without a NaN addend.
     */
    fused(x0, y0, z0, double, negate_product, negate_addend)
    {
        const f = format(double);
        const ix = this.input(x0, double), iy = this.input(y0, double), iz = this.input(z0, double);
        const de = ix.de | iy.de | iz.de;
        const operands = [ix.x, iy.x, iz.x];
        if(operands.some(v => is_snan(v, double))) this.flags |= IE;
        const nan = operands.find(v => is_nan(v, double));
        if(nan !== undefined) return quiet(nan, f);
        const [x, y, z] = operands;
        const invalid = () => { this.flags |= IE; return indefinite(double); };
        const sp = parts(x, f).sign ^ parts(y, f).sign ^ (negate_product ? 1 : 0);
        const sz = parts(z, f).sign ^ (negate_addend ? 1 : 0);
        const infinite_product = is_inf(x, double) || is_inf(y, double);
        const zero_product = is_zero(x, double) || is_zero(y, double);
        if(infinite_product && zero_product) return invalid();
        if(infinite_product)
        {
            if(is_inf(z, double) && sz !== sp) return invalid();
            this.flags |= de;
            return infinity(sp, f);
        }
        this.flags |= de;
        if(is_inf(z, double)) return infinity(sz, f);
        // the exact sum: the product's m * 2^e and the addend's on a common exponent
        const product = zero_product ? { m: 0n, e: 0 } : (() => { const a = value(x, f), b = value(y, f); return { m: a.m * b.m, e: a.e + b.e }; })();
        const addend = is_zero(z, double) ? { m: 0n, e: 0 } : value(z, f);
        const e = Math.min(product.e, addend.e);
        const sum = (sp ? -1n : 1n) * (product.m << BigInt(product.e - e)) + (sz ? -1n : 1n) * (addend.m << BigInt(addend.e - e));
        if(sum === 0n)
        {
            // an exact zero: the zeros' sign when both are zeros of one sign, else -0 only when rounding down
            const both_zero = zero_product && is_zero(z, double);
            return zero(both_zero && sp === sz ? sp : this.rc === 1 ? 1 : 0, f);
        }
        return this.deliver(round(sum < 0n ? 1 : 0, sum < 0n ? -sum : sum, e, false, f, this.rc), double);
    }
    /** VCVTPH2PS: a half (BigInt bits) to single precision, exactly: no DAZ, no DE; IE for an SNaN */
    half_to_single(h)
    {
        const to = format(false);
        const q = parts(h, HALF);
        if(q.exponent === max_exponent(HALF) && q.fraction !== 0n)
        {
            if((h >> BigInt(HALF.p - 2) & 1n) === 0n) this.flags |= IE;
            return quiet(zero(q.sign, to) | mask(to.ebits) << BigInt(to.p - 1) | q.fraction << BigInt(to.p - HALF.p), to);
        }
        if(q.exponent === max_exponent(HALF)) return infinity(q.sign, to);
        if(q.exponent === 0 && q.fraction === 0n) return zero(q.sign, to);
        const v = value(h, HALF);
        return round(q.sign, v.m, v.e, false, to, 0).bits;
    }
    /** VCVTPS2PH: a single to a half by `rc`: DAZ and DE; FZ does not apply,
     * an unmasked underflow is any tiny result */
    single_to_half(x0, rc)
    {
        const from = format(false);
        const { x, de } = this.input(x0, false);
        const q = parts(x, from);
        if(is_nan(x, false))
        {
            if(is_snan(x, false)) this.flags |= IE;
            return quiet(zero(q.sign, HALF) | mask(HALF.ebits) << BigInt(HALF.p - 1) | q.fraction >> BigInt(from.p - HALF.p), HALF);
        }
        this.flags |= de;
        if(is_inf(x, false)) return infinity(q.sign, HALF);
        if(is_zero(x, false)) return zero(q.sign, HALF);
        const v = value(x, from);
        const r = round(q.sign, v.m, v.e, false, HALF, rc);
        if(r.tiny && !this.um_masked) r.flags |= UE;
        this.flags |= r.flags;
        return r.bits;
    }
    /** CMPPS/CMPPD/CMPSS/CMPSD predicate 0-7 of a and b, VCMP*'s 0-31 (PREDICATES; COMI: 1; UCOMI: 0) */
    compare(a0, b0, double, predicate)
    {
        const ia = this.input(a0, double), ib = this.input(b0, double);
        const a = ia.x, b = ib.x;
        const unordered = is_nan(a, double) || is_nan(b, double);
        const [, truth, signaling] = PREDICATES[predicate];
        if(is_snan(a, double) || is_snan(b, double) || unordered && signaling) this.flags |= IE;
        if(!unordered) this.flags |= ia.de | ib.de;
        const c = unordered ? undefined : compare(a, b, double);
        return truth[unordered ? 3 : c < 0 ? 0 : c === 0 ? 1 : 2] === 1;
    }
    /** A signed integer (BigInt) to the format */
    from_integer(n, double)
    {
        if(n === 0n) return 0n;
        return this.deliver(round(n < 0n ? 1 : 0, n < 0n ? -n : n, 0, false, format(double), this.rc), double);
    }
    /** Between the formats: from `from_double` to the other one */
    convert(x0, from_double)
    {
        const from = format(from_double), to = format(!from_double);
        const { x, de } = this.input(x0, from_double);
        if(is_nan(x, from_double))
        {
            if(is_snan(x, from_double)) this.flags |= IE;
            const q = parts(x, from), shift = BigInt(Math.abs(from.p - to.p));
            const fraction = from_double ? q.fraction >> shift : q.fraction << shift;
            return quiet(zero(q.sign, to) | mask(to.ebits) << BigInt(to.p - 1) | fraction, to);
        }
        this.flags |= de;
        const sign = parts(x, from).sign;
        if(is_inf(x, from_double)) return infinity(sign, to);
        if(is_zero(x, from_double)) return zero(sign, to);
        const v = value(x, from);
        return this.deliver(round(sign, v.m, v.e, false, to, this.rc), !from_double);
    }
    /** To a 32- or 64-bit signed integer (BigInt), by RC or truncating; no DE */
    to_integer(x0, double, bits, truncate)
    {
        const f = format(double), { x } = this.input(x0, double);
        const indefinite = -(1n << BigInt(bits - 1));
        if(is_nan(x, double) || is_inf(x, double)) { this.flags |= IE; return indefinite; }
        if(is_zero(x, double)) return 0n;
        const v = value(x, f);
        // |x| = m * 2^e: the integer part and whether anything is below it
        let q, rem;
        if(v.e >= 0) { q = v.m << BigInt(v.e); rem = 0n; }
        else { q = v.m >> BigInt(-v.e); rem = v.m & mask(-v.e); }
        const half = v.e < 0 ? 1n << BigInt(-v.e - 1) : 0n;
        const rc = truncate ? 3 : this.rc;
        let up;
        switch(rc)
        {
            case 0: up = rem > half || rem === half && rem !== 0n && (q & 1n) === 1n; break;
            case 1: up = v.sign === 1 && rem !== 0n; break;
            case 2: up = v.sign === 0 && rem !== 0n; break;
            default: up = false;
        }
        if(up) q += 1n;
        const n = v.sign ? -q : q;
        if(n < indefinite || n > -indefinite - 1n) { this.flags |= IE; return indefinite; }
        if(rem !== 0n) this.flags |= PE;
        return n;
    }
    /** MXCSR afterwards and whether the instruction faults (SDM Vol. 1, 11.5.3) */
    finish()
    {
        const unmasked = ~(this.mxcsr >> 7) & 0x3F;
        const pre = this.flags & (IE | DE | ZE);
        if(pre & unmasked) return { mxcsr: this.mxcsr | pre, fault: true };
        return { mxcsr: this.mxcsr | this.flags, fault: (this.flags & unmasked) !== 0 };
    }
}

/** The order of two non-NaN values: -1, 0, 1 (zeros of either sign equal) */
export function compare(a, b, double)
{
    const f = format(double);
    if(is_zero(a, double) && is_zero(b, double)) return 0;
    const key = x => x & sign_bit(f) ? -(x & mask(f.bits - 1)) : x & mask(f.bits - 1);
    const ka = key(a), kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
}
function isqrt(n)
{
    if(n < 2n) return n;
    let x = 1n << BigInt(Math.ceil(bit_length(n) / 2));
    while(true)
    {
        const y = (x + n / x) >> 1n;
        if(y >= x) return x;
        x = y;
    }
}

/** RCPSS/RSQRTSS of one lane, as v86 computes it within the architectural error */
export function reciprocal(x, square_root)
{
    const sign = x & 0x80000000n;
    if(is_nan(x, false)) return quiet(x, format(false));
    if((x & 0x7F800000n) === 0n) return sign | 0x7F800000n;
    if(square_root && sign) return indefinite(false);
    if(is_inf(x, false)) return sign;
    const v = new DataView(new ArrayBuffer(4));
    v.setUint32(0, Number(x));
    const a = v.getFloat32(0);
    const r = square_root ? Math.fround(1 / Math.fround(Math.sqrt(a))) : Math.fround(1 / a);
    v.setFloat32(0, r);
    const bits = BigInt(v.getUint32(0));
    return is_denormal(bits, false) ? bits & 0x80000000n : bits;
}
