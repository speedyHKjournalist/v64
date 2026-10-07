// The AVX forms (VEX.128 and VEX.LIG) of tests/rust/avx.mjs and
// tests/x64/avx.mjs and their semantics, written from the SDM's operation
// sections independently of src/rust/cpu/avx.rs. Registers and memory
// operands are BigInts, lane 0 in the low bits.

export const big = b => b.reduceRight((v, x) => v << 8n | BigInt(x), 0n);
export const le = (v, n = 16) => Uint8Array.from({ length: n }, (_, i) => Number(v >> BigInt(8 * i) & 255n));
export const mask = bits => (1n << BigInt(bits)) - 1n;
export const LOW = mask(64);
export const lanes = (v, bits) => Array.from({ length: 128 / bits }, (_, i) => v >> BigInt(i * bits) & mask(bits));
export const join = (values, bits) => values.reduceRight((v, x) => v << BigInt(bits) | x, 0n);

const unpack = (bits, high) => (a, b) => {
    const [x, y] = [lanes(a, bits), lanes(b, bits)];
    const start = high ? x.length / 2 : 0;
    return join(x.slice(start, start + x.length / 2).flatMap((v, i) => [v, y[start + i]]), bits);
};
const signs = bits => v => join(lanes(v, bits).map(l => l >> BigInt(bits - 1)), 1);

/**
 * The forms: name, map (1: 0F, 2: 0F38, 3: 0F3A; 1 if absent), pp (0, 1:
 * 66, 2: F3, 3: F2), opcode, `group` (ModRM.reg, an opcode extension), and
 * what the instruction does (`kind`, with `f`). `bytes`: the memory
 * operand's size; `aligned`: #GP(0) unless 16-byte aligned; `memory` or
 * `register`: only that form of the r/m operand. `w`: the VEX.W the form
 * requires (WIG, or W0 and W1 ignored outside 64-bit mode, if absent;
 * `wig32`: required in 64-bit mode only); `lig`: VEX.L ignored. Kinds, with d the ModRM.reg register, v VEX.vvvv's
 * and m the r/m operand (a register or memory):
 *   load       d = f(m)
 *   store      m = d (a register destination is a VEX.128 one)
 *   binary     d = f(v, m)
 *   scalar     VMOVSS/VMOVSD 10: d = m from memory, zero-extended; between registers v's upper lanes, m's low one
 *   scalar_st  VMOVSS/VMOVSD 11: m = d to memory; between registers m = v's upper lanes, d's low one
 *   low, high  12/16: one quadword of d from m (a register's high/low one, or m64), the other from v
 *   store64    13/17: m64 = d's low/high quadword
 *   to_gpr     the r/m register d, the general-purpose register the ModRM.reg (f of the XMM register)
 *   gpr_load   VMOVD/VMOVQ xmm, r/m: d = m zero-extended
 *   gpr_store  VMOVD/VMOVQ r/m, xmm: m = d's low dword or quadword
 *   zero_upper VZEROUPPER
 *   ldmxcsr, stmxcsr, maskmov (VMASKMOVDQU: [rDI] = d's bytes the r/m register selects)
 */
export const FORMS = [
    // full-width loads and stores
    { name: "vmovups", pp: 0, op: 0x10, kind: "load" }, { name: "vmovupd", pp: 1, op: 0x10, kind: "load" },
    { name: "vmovaps", pp: 0, op: 0x28, kind: "load", aligned: true }, { name: "vmovapd", pp: 1, op: 0x28, kind: "load", aligned: true },
    { name: "vmovdqa", pp: 1, op: 0x6F, kind: "load", aligned: true }, { name: "vmovdqu", pp: 2, op: 0x6F, kind: "load" },
    { name: "vlddqu", pp: 3, op: 0xF0, kind: "load", memory: true },
    { name: "vmovntdqa", map: 2, pp: 1, op: 0x2A, kind: "load", aligned: true, memory: true },
    { name: "vmovups", pp: 0, op: 0x11, kind: "store" }, { name: "vmovupd", pp: 1, op: 0x11, kind: "store" },
    { name: "vmovaps", pp: 0, op: 0x29, kind: "store", aligned: true }, { name: "vmovapd", pp: 1, op: 0x29, kind: "store", aligned: true },
    { name: "vmovdqa", pp: 1, op: 0x7F, kind: "store", aligned: true }, { name: "vmovdqu", pp: 2, op: 0x7F, kind: "store" },
    { name: "vmovntps", pp: 0, op: 0x2B, kind: "store", aligned: true, memory: true },
    { name: "vmovntpd", pp: 1, op: 0x2B, kind: "store", aligned: true, memory: true },
    { name: "vmovntdq", pp: 1, op: 0xE7, kind: "store", aligned: true, memory: true },
    // scalar moves (VEX.LIG)
    { name: "vmovss", pp: 2, op: 0x10, kind: "scalar", bytes: 4, lig: true }, { name: "vmovsd", pp: 3, op: 0x10, kind: "scalar", bytes: 8, lig: true },
    { name: "vmovss", pp: 2, op: 0x11, kind: "scalar_st", bytes: 4, lig: true }, { name: "vmovsd", pp: 3, op: 0x11, kind: "scalar_st", bytes: 8, lig: true },
    // quadword moves
    { name: "vmovhlps/vmovlps", pp: 0, op: 0x12, kind: "low" }, { name: "vmovlpd", pp: 1, op: 0x12, kind: "low", memory: true },
    { name: "vmovlhps/vmovhps", pp: 0, op: 0x16, kind: "high" }, { name: "vmovhpd", pp: 1, op: 0x16, kind: "high", memory: true },
    { name: "vmovlps", pp: 0, op: 0x13, kind: "store64", memory: true }, { name: "vmovlpd", pp: 1, op: 0x13, kind: "store64", memory: true },
    { name: "vmovhps", pp: 0, op: 0x17, kind: "store64", memory: true }, { name: "vmovhpd", pp: 1, op: 0x17, kind: "store64", memory: true },
    // duplicates
    { name: "vmovsldup", pp: 2, op: 0x12, kind: "load", f: v => { const l = lanes(v, 32); return join([l[0], l[0], l[2], l[2]], 32); } },
    { name: "vmovshdup", pp: 2, op: 0x16, kind: "load", f: v => { const l = lanes(v, 32); return join([l[1], l[1], l[3], l[3]], 32); } },
    { name: "vmovddup", pp: 3, op: 0x12, kind: "load", bytes: 8, f: v => join([v & LOW, v & LOW], 64) },
    // unpacks and logic
    { name: "vunpcklps", pp: 0, op: 0x14, kind: "binary", f: unpack(32, false) }, { name: "vunpcklpd", pp: 1, op: 0x14, kind: "binary", f: unpack(64, false) },
    { name: "vunpckhps", pp: 0, op: 0x15, kind: "binary", f: unpack(32, true) }, { name: "vunpckhpd", pp: 1, op: 0x15, kind: "binary", f: unpack(64, true) },
    ...[0, 1].flatMap(pp => [
        { name: pp ? "vandpd" : "vandps", pp, op: 0x54, kind: "binary", f: (a, b) => a & b },
        { name: pp ? "vandnpd" : "vandnps", pp, op: 0x55, kind: "binary", f: (a, b) => ~a & b & mask(128) },
        { name: pp ? "vorpd" : "vorps", pp, op: 0x56, kind: "binary", f: (a, b) => a | b },
        { name: pp ? "vxorpd" : "vxorps", pp, op: 0x57, kind: "binary", f: (a, b) => a ^ b },
    ]),
    { name: "vpand", pp: 1, op: 0xDB, kind: "binary", f: (a, b) => a & b }, { name: "vpandn", pp: 1, op: 0xDF, kind: "binary", f: (a, b) => ~a & b & mask(128) },
    { name: "vpor", pp: 1, op: 0xEB, kind: "binary", f: (a, b) => a | b }, { name: "vpxor", pp: 1, op: 0xEF, kind: "binary", f: (a, b) => a ^ b },
    // to general-purpose registers
    { name: "vmovmskps", pp: 0, op: 0x50, kind: "to_gpr", register: true, f: signs(32) },
    { name: "vmovmskpd", pp: 1, op: 0x50, kind: "to_gpr", register: true, f: signs(64) },
    { name: "vpmovmskb", pp: 1, op: 0xD7, kind: "to_gpr", register: true, f: signs(8) },
    // VMOVD and VMOVQ (W1: 64-bit general-purpose operands, 64-bit mode only)
    { name: "vmovd", pp: 1, op: 0x6E, kind: "gpr_load", w: 0, wig32: true }, { name: "vmovq", pp: 1, op: 0x6E, kind: "gpr_load", w: 1, long: true },
    { name: "vmovd", pp: 1, op: 0x7E, kind: "gpr_store", w: 0, wig32: true }, { name: "vmovq", pp: 1, op: 0x7E, kind: "gpr_store", w: 1, long: true },
    { name: "vmovq", pp: 2, op: 0x7E, kind: "load", bytes: 8, f: v => v & LOW },
    { name: "vmovq", pp: 1, op: 0xD6, kind: "store", bytes: 8, f: v => v & LOW },
    // state
    { name: "vzeroupper", pp: 0, op: 0x77, kind: "zero_upper" },
    { name: "vldmxcsr", pp: 0, op: 0xAE, group: 2, kind: "ldmxcsr", memory: true, bytes: 4 },
    { name: "vstmxcsr", pp: 0, op: 0xAE, group: 3, kind: "stmxcsr", memory: true, bytes: 4 },
    { name: "vmaskmovdqu", pp: 1, op: 0xF7, kind: "maskmov", register: true },
];

/** The memory operand's size of form `f` */
export const memory_bytes = f => f.bytes ?? (["store64", "low", "high"].includes(f.kind) ? 8 : f.kind === "gpr_load" || f.kind === "gpr_store" ? (f.w ? 8 : 4) : 16);

/**
 * Executes form `f` on `s`: x[r] and h[r], XMM r and bits 255:128 of YMM r
 * (BigInts), mxcsr; s.load(bytes) and s.store(bytes, value) access the
 * memory operand, s.masked(value, selected) VMASKMOVDQU's, s.gpr(r) and
 * s.set_gpr(r, value, bits) the general-purpose registers. `o`: d, v (VEX.vvvv),
 * m (the r/m register; undefined for memory), `long` (64-bit mode).
 */
export function execute(f, s, { d, v, m, long })
{
    const memory = m === undefined;
    const source = bytes => memory ? s.load(bytes) : s.x[m];
    const write = (r, value) => { s.x[r] = value & mask(128); s.h[r] = 0n; };
    switch(f.kind)
    {
        case "load": write(d, (f.f || (x => x))(source(memory_bytes(f)))); break;
        case "store":
        {
            const value = (f.f || (x => x))(s.x[d]);
            if(memory) s.store(memory_bytes(f), value);
            else write(m, value);
            break;
        }
        case "binary": write(d, f.f(s.x[v], source(16))); break;
        case "scalar":
        {
            const low = mask(f.bytes * 8);
            write(d, memory ? s.load(f.bytes) : s.x[v] & ~low | s.x[m] & low);
            break;
        }
        case "scalar_st":
        {
            const low = mask(f.bytes * 8);
            if(memory) s.store(f.bytes, s.x[d]);
            else write(m, s.x[v] & ~low | s.x[d] & low);
            break;
        }
        case "low": write(d, s.x[v] & ~LOW | (memory ? s.load(8) : s.x[m] >> 64n)); break;
        case "high": write(d, s.x[v] & LOW | (memory ? s.load(8) : s.x[m] & LOW) << 64n); break;
        case "store64": s.store(8, f.op === 0x13 ? s.x[d] & LOW : s.x[d] >> 64n); break;
        // (the general-purpose register: ModRM.reg, d here)
        case "to_gpr": s.set_gpr(d, f.f(s.x[m]), long && f.w === 1 ? 64 : 32); break;
        case "gpr_load":
        {
            const bits = long && f.w === 1 ? 64 : 32;
            write(d, memory ? s.load(bits / 8) : s.gpr(m) & mask(bits));
            break;
        }
        case "gpr_store":
        {
            const bits = long && f.w === 1 ? 64 : 32;
            if(memory) s.store(bits / 8, s.x[d] & mask(bits));
            else s.set_gpr(m, s.x[d] & mask(bits), bits);
            break;
        }
        case "zero_upper": s.h.fill(0n, 0, long ? 16 : 8); break;
        case "ldmxcsr": s.mxcsr = Number(s.load(4)); break;
        case "stmxcsr": s.store(4, BigInt(s.mxcsr)); break;
        case "maskmov":
        {
            const selected = le(s.x[m]).map(b => b >> 7);
            s.masked(s.x[d], selected);
            break;
        }
        default: throw new Error(`kind ${f.kind}`);
    }
}
