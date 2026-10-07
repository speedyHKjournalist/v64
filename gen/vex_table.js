// The VEX rows of the opcode table (gen/x86_table.js): one per VEX form of
// gen/isa_forms.json, whose decode facts (map, pp, opcode, ModRM.reg group,
// VEX.L, VEX.W, VEX.vvvv, register/memory forms, immediates) come from
// iced-x86 through tools/isa_forms. Their semantics come in phases of
// docs/simd-xsave-plan.md (AVX_128).
//
// A VEX row's key is 0xC4_MM_PP_OO: the map (1: 0F, 2: 0F38, 3: 0F3A), VEX.pp
// (0: none, 1: 66, 2: F3, 3: F2) and the opcode byte. Its `vex` lists which
// VEX fields it accepts and what they encode (decode_rules::vex in Rust):
//   l, w     VEX.L and VEX.W the row requires (undefined: ignored)
//   wig32    VEX.W is ignored outside 64-bit mode (iced-x86 WIG32)
//   vvvv     VEX.vvvv is an operand; otherwise it must be 1111b
//   long     64-bit mode only
//   is4      imm8[7:4] is a register operand
//   vsib     a VSIB memory operand: SIB byte and 32/64-bit addressing
//   unique   destination, index and mask registers must differ
//   gpr      a general-purpose register instruction (BMI1, BMI2: exception
//            type 13, without AVX state requirements)
// reg_ud/mem_ud: the row has no register/memory form; another row of the key
// may have one (VBROADCASTSS xmm, m32 is AVX, its register form AVX2).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const DIR = path.dirname(url.fileURLToPath(import.meta.url));

export const VEX_MAPS = { "0F": 1, "0F38": 2, "0F3A": 3 };
export const VEX_PP = { NP: 0, "66": 1, F3: 2, F2: 3 };

/** The key of a VEX encoding: map, pp and opcode byte */
export function vex_key(map, pp, byte)
{
    return (0xC4000000 | map << 16 | pp << 8 | byte) >>> 0;
}
export function is_vex_key(opcode)
{
    return opcode >>> 24 === 0xC4;
}

/** Whether `row` accepts these VEX fields (decode_rules::vex_row) */
export function vex_accepts(row, { l, w, long, memory, group })
{
    const v = row.vex;
    if(row.fixed_g !== undefined && row.fixed_g !== group) return false;
    if(row.e && (memory ? row.mem_ud : row.reg_ud)) return false;
    if(v.l !== undefined && v.l !== l) return false;
    if(v.w !== undefined && (long || !v.wig32) && v.w !== w) return false;
    return long || !v.long;
}

// The VEX forms that have their semantics (crate::cpu::avx), by phase of
// docs/simd-xsave-plan.md; the others are #UD (unimplemented). AVX: the
// VEX.128 and VEX.LIG forms of these instructions.
const AVX_128 = new Set([
    // P5 part 1: data movement, logic, VZEROUPPER, VLDMXCSR and VSTMXCSR
    "VMOVUPS", "VMOVUPD", "VMOVAPS", "VMOVAPD", "VMOVDQA", "VMOVDQU", "VLDDQU", "VMOVNTDQA",
    "VMOVNTPS", "VMOVNTPD", "VMOVNTDQ", "VMOVSS", "VMOVSD", "VMOVHLPS", "VMOVLHPS", "VMOVLPS",
    "VMOVLPD", "VMOVHPS", "VMOVHPD", "VMOVSLDUP", "VMOVSHDUP", "VMOVDDUP", "VMOVD", "VMOVQ",
    "VUNPCKLPS", "VUNPCKLPD", "VUNPCKHPS", "VUNPCKHPD", "VANDPS", "VANDPD", "VANDNPS", "VANDNPD",
    "VORPS", "VORPD", "VXORPS", "VXORPD", "VPAND", "VPANDN", "VPOR", "VPXOR", "VMOVMSKPS",
    "VMOVMSKPD", "VPMOVMSKB", "VMASKMOVDQU", "VZEROUPPER", "VLDMXCSR", "VSTMXCSR",
    // P5 part 2: the integer forms (and the integer-like blends, inserts and extracts)
    "VPUNPCKLBW", "VPUNPCKLWD", "VPUNPCKLDQ", "VPUNPCKLQDQ", "VPUNPCKHBW", "VPUNPCKHWD", "VPUNPCKHDQ",
    "VPUNPCKHQDQ", "VPACKSSWB", "VPACKSSDW", "VPACKUSWB", "VPACKUSDW", "VPCMPEQB", "VPCMPEQW", "VPCMPEQD",
    "VPCMPEQQ", "VPCMPGTB", "VPCMPGTW", "VPCMPGTD", "VPCMPGTQ", "VPSHUFD", "VPSHUFHW", "VPSHUFLW", "VPSHUFB",
    "VPSRLW", "VPSRLD", "VPSRLQ", "VPSRAW", "VPSRAD", "VPSLLW", "VPSLLD", "VPSLLQ", "VPSRLDQ", "VPSLLDQ",
    "VPADDB", "VPADDW", "VPADDD", "VPADDQ", "VPADDSB", "VPADDSW", "VPADDUSB", "VPADDUSW", "VPSUBB", "VPSUBW",
    "VPSUBD", "VPSUBQ", "VPSUBSB", "VPSUBSW", "VPSUBUSB", "VPSUBUSW", "VPMULLW", "VPMULLD", "VPMULHW",
    "VPMULHUW", "VPMULHRSW", "VPMULUDQ", "VPMULDQ", "VPMADDWD", "VPMADDUBSW", "VPAVGB", "VPAVGW", "VPSADBW",
    "VPMINUB", "VPMINUW", "VPMINUD", "VPMINSB", "VPMINSW", "VPMINSD", "VPMAXUB", "VPMAXUW", "VPMAXUD",
    "VPMAXSB", "VPMAXSW", "VPMAXSD", "VPHADDW", "VPHADDD", "VPHADDSW", "VPHSUBW", "VPHSUBD", "VPHSUBSW",
    "VPSIGNB", "VPSIGNW", "VPSIGND", "VPABSB", "VPABSW", "VPABSD", "VPALIGNR", "VPTEST", "VPMOVSXBW",
    "VPMOVSXBD", "VPMOVSXBQ", "VPMOVSXWD", "VPMOVSXWQ", "VPMOVSXDQ", "VPMOVZXBW", "VPMOVZXBD", "VPMOVZXBQ",
    "VPMOVZXWD", "VPMOVZXWQ", "VPMOVZXDQ", "VPHMINPOSUW", "VBLENDPS", "VBLENDPD", "VPBLENDW", "VPBLENDVB",
    "VMPSADBW", "VPINSRB", "VPINSRW", "VPINSRD", "VPINSRQ", "VINSERTPS", "VPEXTRB", "VPEXTRW", "VPEXTRD",
    "VPEXTRQ", "VEXTRACTPS", "VPCMPESTRI", "VPCMPESTRI64", "VPCMPESTRM", "VPCMPESTRM64", "VPCMPISTRI",
    "VPCMPISTRM", "VSHUFPS", "VSHUFPD",
    // P5 part 3: the floating-point forms
    "VADDPS", "VADDPD", "VADDSS", "VADDSD", "VSUBPS", "VSUBPD", "VSUBSS", "VSUBSD", "VMULPS", "VMULPD",
    "VMULSS", "VMULSD", "VDIVPS", "VDIVPD", "VDIVSS", "VDIVSD", "VMINPS", "VMINPD", "VMINSS", "VMINSD",
    "VMAXPS", "VMAXPD", "VMAXSS", "VMAXSD", "VSQRTPS", "VSQRTPD", "VSQRTSS", "VSQRTSD", "VRSQRTPS",
    "VRSQRTSS", "VRCPPS", "VRCPSS", "VHADDPS", "VHADDPD", "VHSUBPS", "VHSUBPD", "VADDSUBPS", "VADDSUBPD",
    "VCMPPS", "VCMPPD", "VCMPSS", "VCMPSD", "VCOMISS", "VCOMISD", "VUCOMISS", "VUCOMISD", "VCVTSI2SS",
    "VCVTSI2SD", "VCVTSS2SI", "VCVTSD2SI", "VCVTTSS2SI", "VCVTTSD2SI", "VCVTPS2PD", "VCVTPD2PS",
    "VCVTSS2SD", "VCVTSD2SS", "VCVTDQ2PS", "VCVTPS2DQ", "VCVTTPS2DQ", "VCVTDQ2PD", "VCVTPD2DQ",
    "VCVTTPD2DQ", "VROUNDPS", "VROUNDPD", "VROUNDSS", "VROUNDSD", "VDPPS", "VDPPD", "VBLENDVPS",
    "VBLENDVPD",
    // P5 part 4: AVX's own 128-bit forms
    "VBROADCASTSS", "VPERMILPS", "VPERMILPD", "VTESTPS", "VTESTPD", "VMASKMOVPS", "VMASKMOVPD",
]);
const implemented = form => form.isa[0] === "AVX" && form.l !== "L1" && AVX_128.has(form.mnemonic);

function row(form)
{
    const ops = form.operands;
    const is4 = ops.some(o => o.endsWith("_is4"));
    const vsib = ops.some(o => o.startsWith("mem_vsib"));
    return {
        opcode: vex_key(VEX_MAPS[form.map], VEX_PP[form.prefix], form.byte),
        ...(form.group === undefined ? {} : { fixed_g: form.group }),
        // (VZEROUPPER and VZEROALL have no operands and no ModRM)
        e: ops.length ? 1 : 0,
        reg_ud: ops.some(o => o === "mem" || o.startsWith("mem_vsib")) ? 1 : 0,
        mem_ud: ops.some(o => o.endsWith("_rm")) ? 1 : 0,
        imm8: ops.includes("imm8") || is4 ? 1 : 0,
        vex: {
            l: form.l === "LIG" ? undefined : +form.l[1],
            w: form.w === "WIG" ? undefined : +form.w[1],
            wig32: form.w.endsWith("/WIG32"),
            vvvv: ops.some(o => o.endsWith("_vvvv")),
            long: form.modes.join() === "64",
            is4, vsib,
            unique: !!form.unique_regs,
            gpr: form.isa[0] === "BMI1" || form.isa[0] === "BMI2",
        },
        feature: form.isa[0],
        form: form.id,
        custom: 1,
        skip: 1,
        unimplemented: implemented(form) ? 0 : 1,
    };
}

const inventory = JSON.parse(fs.readFileSync(path.join(DIR, "isa_forms.json"), "utf8"));
const forms = inventory.forms.filter(f => f.encoding === "VEX");
assert.ok(forms.every(f => !f.real_v86), "VEX forms do not exist in real and virtual-8086 mode");
assert.ok(forms.every(f => f.modes.join() === "16,32,64" || f.modes.join() === "64"));

/** The VEX rows, sorted by key, ModRM.reg group and form */
export const VEX_ROWS = Object.freeze(forms.map(row).sort((a, b) =>
    a.opcode - b.opcode || (a.fixed_g ?? -1) - (b.fixed_g ?? -1) || (a.form < b.form ? -1 : a.form > b.form)));

// Every encoding selects at most one row (the decoders take the first that
// accepts it), and the rows of a key agree on whether it has a ModRM byte
{
    const by_key = Map.groupBy(VEX_ROWS, r => r.opcode);
    for(const [key, rows] of by_key)
    {
        assert.ok(rows.every(r => r.e === rows[0].e), `VEX ${key.toString(16)}: ModRM`);
        for(const l of [0, 1]) for(const w of [0, 1]) for(const long of [false, true])
            for(const memory of rows[0].e ? [false, true] : [false]) for(let group = 0; group < 8; group++)
            {
                const matching = rows.filter(r => vex_accepts(r, { l, w, long, memory, group }));
                assert.ok(matching.length <= 1, `VEX ${key.toString(16)} l${l} w${w}${long ? " 64-bit" : ""} ${memory ? "mem" : "reg"} /${group}: ` +
                    matching.map(r => r.form).join(" "));
            }
    }
}
