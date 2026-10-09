// A model of BMI1, BMI2, TZCNT, LZCNT and MOVBE (docs/simd-xsave-plan.md
// 9.2, P10) from the SDM's operations, written apart from src/rust/cpu/bmi.rs:
// BigInt bit by bit. Each instruction gives its result(s) and its flags as
// { value, defined }: `defined` the flags the SDM specifies, the others
// undefined. v86 gives undefined flags fixed values (`v86_flags`).
export const CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800;
export const ARITHMETIC = CF | PF | AF | ZF | SF | OF;

const ones = bits => (1n << BigInt(bits)) - 1n;
const bit = (v, i) => Number(v >> BigInt(i) & 1n);
const sign = (v, bits) => bit(v, bits - 1);
const parity = v => { let n = 0; for(let i = 0; i < 8; i++) n += bit(v, i); return n % 2 === 0; };

/** The flags v86 gives an instruction: its defined ones, and for the
 * undefined ones AF 0, PF the result's parity, SF the result's sign, OF 0 */
export function v86_flags(r, bits, { value, defined })
{
    const fallback = (parity(r) ? PF : 0) | (sign(r, bits) ? SF : 0);
    return value & defined | fallback & ~defined & ARITHMETIC;
}

// each: (operands as BigInt, bits) => { result, flags?: { value, defined } }
export const ops = {
    // ANDN: NOT src1 AND src2; SF, ZF; OF, CF cleared; AF, PF undefined
    andn: (a, b, bits) => {
        const r = ~a & b & ones(bits);
        return { result: r, flags: { value: (r === 0n ? ZF : 0) | (sign(r, bits) ? SF : 0), defined: ZF | SF | OF | CF } };
    },
    // BEXTR: start control[7:0], length control[15:8], bits beyond the
    // operand zero; ZF; CF, OF cleared; AF, SF, PF undefined
    bextr: (src, control, bits) => {
        const start = Number(control & 0xFFn), length = Number(control >> 8n & 0xFFn);
        let r = 0n;
        for(let i = 0; i < length; i++)
        {
            const at = start + i;
            if(at < bits) r |= BigInt(bit(src, at)) << BigInt(i);
        }
        return { result: r & ones(bits), flags: { value: r === 0n ? ZF : 0, defined: ZF | CF | OF } };
    },
    // BLSI: -src AND src; ZF, SF; CF = src != 0; OF cleared
    blsi: (src, bits) => {
        const s = src & ones(bits), r = (-s & s) & ones(bits);
        return { result: r, flags: { value: (r === 0n ? ZF : 0) | (sign(r, bits) ? SF : 0) | (s !== 0n ? CF : 0), defined: ZF | SF | CF | OF } };
    },
    // BLSMSK: (src - 1) XOR src; SF; CF = src == 0; ZF, OF cleared
    blsmsk: (src, bits) => {
        const s = src & ones(bits), r = ((s - 1n) ^ s) & ones(bits);
        return { result: r, flags: { value: (sign(r, bits) ? SF : 0) | (s === 0n ? CF : 0), defined: SF | CF | ZF | OF } };
    },
    // BLSR: (src - 1) AND src; ZF, SF; CF = src == 0; OF cleared
    blsr: (src, bits) => {
        const s = src & ones(bits), r = ((s - 1n) & s) & ones(bits);
        return { result: r, flags: { value: (r === 0n ? ZF : 0) | (sign(r, bits) ? SF : 0) | (s === 0n ? CF : 0), defined: ZF | SF | CF | OF } };
    },
    // BZHI: bits from index[7:0] on cleared; ZF, SF; CF = index > size - 1; OF cleared
    bzhi: (src, index, bits) => {
        const n = Number(index & 0xFFn);
        let r = src & ones(bits);
        if(n < bits) r &= ones(n);
        return { result: r, flags: { value: (r === 0n ? ZF : 0) | (sign(r, bits) ? SF : 0) | (n > bits - 1 ? CF : 0), defined: ZF | SF | CF | OF } };
    },
    // MULX: EDX/RDX times the source, unsigned: high and low halves; no flags
    mulx: (d, src, bits) => {
        const p = (d & ones(bits)) * (src & ones(bits));
        return { result: p >> BigInt(bits), low: p & ones(bits) };
    },
    // PDEP: the source's low bits to the selector's set bits
    pdep: (src, selector, bits) => {
        let r = 0n, k = 0;
        for(let i = 0; i < bits; i++) if(bit(selector, i)) r |= BigInt(bit(src, k++)) << BigInt(i);
        return { result: r };
    },
    // PEXT: the source's bits at the selector's set bits, packed
    pext: (src, selector, bits) => {
        let r = 0n, k = 0;
        for(let i = 0; i < bits; i++) if(bit(selector, i)) r |= BigInt(bit(src, i)) << BigInt(k++);
        return { result: r };
    },
    // RORX: rotate right by imm8 modulo the size
    rorx: (src, imm8, bits) => {
        const n = Number(imm8) % bits, s = src & ones(bits);
        let r = 0n;
        for(let i = 0; i < bits; i++) r |= BigInt(bit(s, (i + n) % bits)) << BigInt(i);
        return { result: r };
    },
    // SARX, SHLX, SHRX: by count modulo the size
    sarx: (src, count, bits) => {
        const n = Number(count) % bits, s = src & ones(bits);
        let r = 0n;
        for(let i = 0; i < bits; i++) r |= BigInt(bit(s, Math.min(i + n, bits - 1))) << BigInt(i);
        return { result: r };
    },
    shlx: (src, count, bits) => ({ result: (src << BigInt(Number(count) % bits)) & ones(bits) }),
    shrx: (src, count, bits) => ({ result: (src & ones(bits)) >> BigInt(Number(count) % bits) }),
    // TZCNT, LZCNT: the operand's size for 0; CF = source zero, ZF = result zero; OF, SF, PF, AF undefined
    tzcnt: (src, bits) => {
        const s = src & ones(bits);
        let r = 0;
        while(r < bits && !bit(s, r)) r++;
        return { result: BigInt(r), flags: { value: (r === 0 ? ZF : 0) | (s === 0n ? CF : 0), defined: ZF | CF } };
    },
    lzcnt: (src, bits) => {
        const s = src & ones(bits);
        let r = 0;
        while(r < bits && !bit(s, bits - 1 - r)) r++;
        return { result: BigInt(r), flags: { value: (r === 0 ? ZF : 0) | (s === 0n ? CF : 0), defined: ZF | CF } };
    },
    // MOVBE: the operand's bytes reversed
    movbe: (v, bits) => {
        let r = 0n;
        for(let i = 0; i < bits / 8; i++) r |= (v >> BigInt(8 * i) & 0xFFn) << BigInt(bits - 8 - 8 * i);
        return { result: r };
    },
    // BSF, BSR (TZCNT and LZCNT without their features): ZF for a zero
    // source, whose destination is kept (v86's); the other flags undefined
    bsf: (src, bits, old) => {
        const s = src & ones(bits);
        if(s === 0n) return { result: old, flags: { value: ZF, defined: ZF } };
        let r = 0;
        while(!bit(s, r)) r++;
        return { result: BigInt(r), flags: { value: 0, defined: ZF } };
    },
    bsr: (src, bits, old) => {
        const s = src & ones(bits);
        if(s === 0n) return { result: old, flags: { value: ZF, defined: ZF } };
        let r = bits - 1;
        while(!bit(s, r)) r--;
        return { result: BigInt(r), flags: { value: 0, defined: ZF } };
    },
};

/** The VEX forms: [name, map, pp, opcode, ModRM.reg group or undefined,
 * operand roles (reg: ModRM.reg, vvvv, rm), imm8] */
export const VEX_FORMS = [
    ["andn", 2, 0, 0xF2, undefined, "reg = vvvv, rm"],
    ["blsr", 2, 0, 0xF3, 1, "vvvv = rm"],
    ["blsmsk", 2, 0, 0xF3, 2, "vvvv = rm"],
    ["blsi", 2, 0, 0xF3, 3, "vvvv = rm"],
    ["bzhi", 2, 0, 0xF5, undefined, "reg = rm, vvvv"],
    ["pext", 2, 2, 0xF5, undefined, "reg = vvvv, rm"],
    ["pdep", 2, 3, 0xF5, undefined, "reg = vvvv, rm"],
    ["mulx", 2, 3, 0xF6, undefined, "reg:vvvv = rdx, rm"],
    ["bextr", 2, 0, 0xF7, undefined, "reg = rm, vvvv"],
    ["shlx", 2, 1, 0xF7, undefined, "reg = rm, vvvv"],
    ["sarx", 2, 2, 0xF7, undefined, "reg = rm, vvvv"],
    ["shrx", 2, 3, 0xF7, undefined, "reg = rm, vvvv"],
    ["rorx", 3, 3, 0xF0, undefined, "reg = rm, imm8"],
].map(([name, map, pp, op, group, roles]) => ({ name, map, pp, op, group, roles, isa: ["andn", "blsr", "blsmsk", "blsi", "bextr"].includes(name) ? "BMI1" : "BMI2" }));

/** A VEX form's results: the registers it writes { register: value } and
 * its flags (or none), from `gpr` (register reads) and its source operand */
export function execute_vex(f, { reg, vvvv, source, imm8, gpr, bits })
{
    const { name } = f;
    switch(name)
    {
        case "andn": case "pext": case "pdep":
        {
            const { result, flags } = ops[name](gpr(vvvv), source, bits);
            return { writes: [[reg, result]], flags };
        }
        case "blsr": case "blsmsk": case "blsi":
        {
            const { result, flags } = ops[name](source, bits);
            return { writes: [[vvvv, result]], flags };
        }
        case "bzhi": case "bextr": case "shlx": case "sarx": case "shrx":
        {
            const { result, flags } = ops[name](source, gpr(vvvv), bits);
            return { writes: [[reg, result]], flags };
        }
        case "mulx":
        {
            const { result, low } = ops.mulx(gpr(2), source, bits);
            // (the low half to VEX.vvvv first: ModRM.reg's high half wins)
            return { writes: [[vvvv, low], [reg, result]] };
        }
        case "rorx": return { writes: [[reg, ops.rorx(source, BigInt(imm8), bits).result]] };
    }
    throw new Error(name);
}
