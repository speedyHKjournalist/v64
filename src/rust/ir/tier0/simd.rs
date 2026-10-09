//! Tier-0 templates for MMX, SSE and SSE2: native Wasm SIMD over the CPU's
//! XMM/MMX registers in memory, with the interpreter's semantics.
//!
//! Every form reads its memory operand (with the interpreter's width) before
//! writing any state; operands outside one ordinary RAM page, and results the
//! interpreter might produce differently (NaNs, whose payloads Wasm leaves
//! open), take retry() instead. MMX registers alias the x87 mantissas: a read
//! first syncs that slot from the f64 shadow cache, a write invalidates it and
//! sets the exponent to 0xFFFF, and the form ends with
//! cpu::transition_fpu_to_mmx (all tags valid, TOP 0).
//!
//! VEX forms (AVX, P5: VEX.128 and VEX.LIG) run on their legacy forms'
//! templates (classify_vex, Vex): they read VEX.vvvv where the legacy form
//! reads its destination, zero the destination's bits 255:128 (in the CPU
//! state, not cached) with the write that ends the template, and check the
//! alignment of the aligned moves only. Of the VEX.256 forms (P6), the moves
//! and VZEROALL have templates of their own (classify_vex256); the others
//! are interpreter steps.
use super::Page;
use crate::cpu::{
    cpu::CR0_EM, cpu::CR0_TS, cpu::CR4_OSFXSR, cpu::CR4_OSXSAVE, cpu::FLAGS_ALL, cpu::FLAG_VM,
    global_pointers as gp,
};
use crate::ir::helper::imports::signature;

use crate::ir::frontend::decode::DecodedInstruction;
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocalV128};
use crate::x86tpl::ops::{self, Facts, VecOperands};
use crate::x86tpl::vec::{
    self, clean_bits, compare_flags, known_clean, operand_facts, packed, packed_op, palignr,
    shift_immediate, shuffle_lanes, shuffled_clean, sse_fp_call, sse_fp_result, Packed, CLEAN_PD,
    CLEAN_PS, CLEAN_SD, CLEAN_SS,
};
use crate::x86tpl::{mmx, native_fp};

/// Push nonzero when VEX forms fault: #UD (no CR4.OSXSAVE, XCR0 without SSE
/// and AVX state, real and virtual-8086 mode) or #NM (CR0.TS)
pub(super) fn vex_fault(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::cr as u32);
    w.const_i32(CR0_TS);
    w.and_i32();
    w.load_fixed_i32(gp::cr as u32 + 4 * 4);
    w.const_i32(CR4_OSXSAVE);
    w.and_i32();
    w.eqz_i32();
    w.or_i32();
    w.load_fixed_i32(gp::xcr0 as u32);
    w.const_i32(6);
    w.and_i32();
    w.const_i32(6);
    w.ne_i32();
    w.or_i32();
    w.load_fixed_u8(gp::protected_mode as u32);
    w.eqz_i32();
    w.or_i32();
    w.load_fixed_i32(gp::flags as u32);
    w.const_i32(FLAG_VM);
    w.and_i32();
    w.or_i32();
}

/// A VEX form on its legacy form's template (classify_vex): what cpu::avx
/// does differently
#[derive(Clone, Copy)]
pub(super) struct Vex {
    /// Read where the legacy form reads its destination: VEX.vvvv (the
    /// first source), or the r/m register of a shift by imm8 (whose
    /// destination is VEX.vvvv); None for the forms of one source
    first: Option<u8>,
    /// VMOVAPS/APD/DQA and VMOVNTPS/PD/DQ: the m128 must be 16-byte aligned,
    /// the m256 32-byte aligned (the other VEX forms take any; VEX rows'
    /// Encoding::aligned_m128 is false)
    aligned: bool,
}

#[derive(Clone, Copy)]
pub(super) enum Simd {
    /// MOVUPS/MOVAPS/MOVUPD/MOVAPD/MOVDQA/MOVDQU xmm, xmm/m128.
    Load128 {
        reg: u8,
    },
    /// The same, xmm/m128, xmm.
    Store128 {
        reg: u8,
    },
    /// MOVSS/MOVSD xmm, xmm/m: registers merge the low lane, memory zero-extends.
    LoadScalar {
        reg: u8,
        bytes: u8,
    },
    /// MOVSS/MOVSD xmm/m, xmm.
    StoreScalar {
        reg: u8,
        bytes: u8,
    },
    /// MOVQ xmm, xmm/m64 (upper quadword cleared).
    LoadQuad {
        reg: u8,
    },
    /// MOVQ xmm/m64, xmm (a register destination's upper quadword cleared).
    StoreQuad {
        reg: u8,
    },
    /// MOVQ mm, mm/m64.
    MmxLoad {
        reg: u8,
    },
    /// MOVQ mm/m64, mm.
    MmxStore {
        reg: u8,
    },
    /// MOVD mm/xmm, r/m32.
    MovdIn {
        reg: u8,
        mmx: bool,
    },
    /// MOVD r/m32, mm/xmm.
    MovdOut {
        reg: u8,
        mmx: bool,
    },
    /// reg = op(reg, source) (see simd_source for its alignment)
    Packed {
        op: Packed,
        reg: u8,
        mmx: bool,
        source: u8,
    },
    /// PSRLx/PSRAx/PSLLx/PSRLDQ/PSLLDQ reg, imm8 (`kind` is the ModRM reg).
    ShiftImmediate {
        reg: u8,
        mmx: bool,
        bits: u8,
        kind: u8,
        count: u8,
    },
    /// ADD/SUB/MUL/DIV/MIN/MAX/SQRT/RSQRT/RCP PS/PD/SS/SD.
    Float {
        opcode: u8,
        reg: u8,
        double: bool,
        scalar: bool,
    },
    /// Float conversions: (Wasm opcode, source bytes, result bytes).
    Convert {
        opcode: u32,
        reg: u8,
        source: u8,
        result: u8,
    },
    /// CVT(T)PS2DQ/CVT(T)PD2DQ.
    ConvertInteger {
        reg: u8,
        double: bool,
        truncate: bool,
    },
    /// CVTSI2SS/CVTSI2SD xmm, r/m32.
    ToScalar {
        reg: u8,
        double: bool,
    },
    /// CVT(T)SS2SI/CVT(T)SD2SI r32, xmm/m.
    ToInteger {
        reg: u8,
        double: bool,
        truncate: bool,
    },
    /// UCOMISS/COMISS/UCOMISD/COMISD.
    CompareFlags {
        reg: u8,
        double: bool,
    },
    /// PCMPESTRM/PCMPESTRI/PCMPISTRM/PCMPISTRI (SSE4.2; `op` the 66 0F 3A
    /// byte): runtime::tier0::ir_t0_pcmpstr on the operand block, ECX or
    /// XMM0 and EFLAGS written here
    Strings {
        reg: u8,
        op: u8,
        imm8: u8,
    },
    /// ROUNDPS/ROUNDPD/ROUNDSS/ROUNDSD (SSE4.1) with `imm8`.
    Round {
        reg: u8,
        double: bool,
        scalar: bool,
        imm8: u8,
    },
    /// PMOVMSKB/MOVMSKPS/MOVMSKPD r32, xmm: the sign bits of the `lane`-byte
    /// lanes
    MoveMask {
        reg: u8,
        lane: u8,
    },
    /// CMPPS/CMPPD/CMPSS/CMPSD with `predicate` (imm8[2:0], VEX imm8[4:0]):
    /// natively for operands neither NaN nor denormal, which raise nothing
    /// and whose result imm8[2:0] decides (simd_fp::Fp::compare); else the
    /// exact path
    CompareMask {
        reg: u8,
        double: bool,
        scalar: bool,
        predicate: u8,
    },
    /// BLENDVPS/BLENDVPD/PBLENDVB: the source's lanes of `lane` bytes whose
    /// sign bit in XMM `mask` (XMM0, VEX imm8[6:4]) is set
    Blendv {
        reg: u8,
        lane: u8,
        mask: u8,
    },
    /// VZEROUPPER: bits 255:128 of YMM0-7 zeroed
    Vzeroupper,
    /// VMOVUPS/UPD/DQU, VMOVAPS/APD/DQA ymm, ymm/m256 (VEX.256): bits
    /// 255:128 from the source's
    Load256 {
        reg: u8,
    },
    /// The same, ymm/m256, ymm; VMOVNTPS/PD/DQ m256, ymm
    Store256 {
        reg: u8,
    },
    /// VZEROALL: YMM0-7 zeroed (Tier-0 runs outside 64-bit mode)
    Vzeroall,
    /// AVX2's packed integer forms (VEX.256, P7): `op` on each half of
    /// VEX.vvvv and ymm/m256 (not the shifts by xmm/m128, whose count is
    /// one 128-bit operand)
    Packed256 {
        op: Packed,
        reg: u8,
    },
    /// VPMOVMSKB (`lane` 1), VMOVMSKPS (4), VMOVMSKPD (8) r32, ymm: the sign
    /// bits of both halves
    MoveMask256 {
        reg: u8,
        lane: u8,
    },
    /// VBROADCASTSS, VBROADCASTSD (AVX2: also from a register), VPBROADCASTB/W/D/Q
    /// ymm: the element (`bytes`) in each lane of both halves
    Broadcast256 {
        reg: u8,
        bytes: u8,
    },
    /// FMA's VEX.128 and scalar forms (P11): runtime::tier0::ir_t0_fma on
    /// the destination, the first source and the r/m operand (`op` the
    /// opcode byte, `double` VEX.W1)
    Fused {
        op: u8,
        double: bool,
        reg: u8,
    },
    Emms,
}

/// (see Encoding::aligned_m128)
fn aligned_m128(i: &DecodedInstruction, bytes: u8) -> bool { i.encoding.aligned_m128(bytes) }

/// Bytes of the r/m operand the interpreter reads (its instr_* source type).
fn source_bytes(op: u32) -> u8 {
    match op {
        0x0F14 | 0x660F14 | 0x0F16 | 0xF20F58 | 0xF20F59 | 0xF20F5C | 0xF20F5E | 0xF20F5D
        | 0xF20F5F | 0xF20F51 | 0xF20F5A | 0x0F5A | 0x660F2E | 0x660F2F | 0xF20F2C | 0xF20F2D
        | 0xF30FE6 => 8,
        0xF30F58 | 0xF30F59 | 0xF30F5C | 0xF30F5E | 0xF30F5D | 0xF30F5F | 0xF30F51 | 0xF30F52
        | 0xF30F53 | 0xF30F5A | 0x0F2E | 0x0F2F | 0xF30F2C | 0xF30F2D | 0x0F60 | 0x0F61
        | 0x0F62 => 4,
        0x0FC6 => 16,
        _ if op >> 16 == 0 && (0x0F60..=0x0FFF).contains(&op) => 8,
        _ => 16,
    }
}

/// SSE4.1/SSE4.2 forms of one Wasm SIMD operation over (destination,
/// source), with an aligned m128 (the hot PMINUD and its siblings), the
/// blends with imm8 as shuffles and BLENDVPS/BLENDVPD/PBLENDVB, ROUND (the
/// hot ROUNDSS and ROUNDSD) and PCMPxSTRx (the hot PCMPISTRI); `op` is the
/// catalogue key (a VEX form's legacy one)
fn sse4(i: &DecodedInstruction, op: u32) -> Option<Simd> {
    if let 0x660F3810 | 0x660F3814 | 0x660F3815 = op {
        return Some(Simd::Blendv {
            reg: i.modrm? >> 3 & 7,
            lane: match op {
                0x660F3810 => 1,
                0x660F3814 => 4,
                _ => 8,
            },
            mask: 0,
        });
    }
    if (0x660F3A60..=0x660F3A63).contains(&op) {
        return Some(Simd::Strings {
            reg: i.modrm? >> 3 & 7,
            op: op as u8,
            imm8: i.immediate? as u8,
        });
    }
    if (0x660F3A08..=0x660F3A0B).contains(&op) {
        return Some(Simd::Round {
            reg: i.modrm? >> 3 & 7,
            double: op & 1 != 0,
            scalar: op & 2 != 0,
            imm8: i.immediate? as u8,
        });
    }
    Some(Simd::Packed {
        op: vec::sse4_packed(op, i.immediate)?,
        reg: i.modrm? >> 3 & 7,
        mmx: false,
        source: 16,
    })
}

/// PSHUFB and PALIGNR (SSSE3), the hot forms of 0F 38 and 0F 3A (`op`
/// as sse4's)
fn ssse3(i: &DecodedInstruction, op: u32) -> Option<Simd> {
    let mmx = op >> 24 == 0;
    let n = if mmx { 8 } else { 16 };
    Some(Simd::Packed {
        op: match op & 0xFFFFFF {
            0x0F3800 => Packed::Swizzle(if mmx { 0x87 } else { 0x8F }),
            0x0F3A0F => palignr(i.immediate? as u8, n),
            _ => return None,
        },
        reg: i.modrm? >> 3 & 7,
        mmx,
        source: n as u8,
    })
}

pub(super) fn classify(i: &DecodedInstruction) -> Option<Simd> {
    if !cfg!(target_feature = "simd128") {
        return None;
    }
    legacy_form(i)
}

/// classify without its simd128 condition (tests/x86tpl/leaf_digests.rs
/// classifies on the host)
fn legacy_form(i: &DecodedInstruction) -> Option<Simd> {
    let op = i.encoding.opcode;
    if matches!(op, 0x0F3800 | 0x660F3800 | 0x0F3A0F | 0x660F3A0F)
        && !i.prefixes.lock
        && !i.baseline_ud
    {
        return ssse3(i, op);
    }
    if matches!(op >> 8, 0x660F38 | 0x660F3A) {
        return if i.prefixes.lock || i.baseline_ud { None } else { sse4(i, op) };
    }
    if op & 0xFF00 != 0x0F00 || i.prefixes.lock || i.baseline_ud {
        return None;
    }
    let prefix = op >> 16;
    // A REP/REPNE prefix that selected no form is left to the interpreter.
    if prefix == 0 && (i.prefixes.rep || i.prefixes.repne) {
        return None;
    }
    let code = op as u8;
    if op == 0x0F77 {
        return Some(Simd::Emms);
    }
    let modrm = i.modrm?;
    let reg = modrm >> 3 & 7;
    let memory = i.ea.is_some();
    Some(match op {
        0x0F10 | 0x0F28 | 0x660F10 | 0x660F28 | 0x660F6F | 0xF30F6F => Simd::Load128 { reg },
        0x0F11 | 0x0F29 | 0x660F11 | 0x660F29 | 0x660F7F | 0xF30F7F => Simd::Store128 { reg },
        0xF30F10 | 0xF20F10 => Simd::LoadScalar {
            reg,
            bytes: if prefix == 0xF3 { 4 } else { 8 },
        },
        0xF30F11 | 0xF20F11 => Simd::StoreScalar {
            reg,
            bytes: if prefix == 0xF3 { 4 } else { 8 },
        },
        0xF30F7E => Simd::LoadQuad { reg },
        0x660FD6 => Simd::StoreQuad { reg },
        0x0F6F => Simd::MmxLoad { reg },
        0x0F7F => Simd::MmxStore { reg },
        0x0F6E | 0x660F6E => Simd::MovdIn {
            reg,
            mmx: prefix == 0,
        },
        0x0F7E | 0x660F7E => Simd::MovdOut {
            reg,
            mmx: prefix == 0,
        },
        0x0F71 | 0x0F72 | 0x0F73 | 0x660F71 | 0x660F72 | 0x660F73 if !memory => {
            let kind = reg;
            let bytes = matches!(kind, 3 | 7);
            let valid = matches!(kind, 2 | 4 | 6) && !(code == 0x73 && kind == 4)
                || bytes && code == 0x73 && prefix == 0x66;
            if !valid {
                return None;
            }
            Simd::ShiftImmediate {
                reg: modrm & 7,
                mmx: prefix == 0,
                bits: if bytes { 128 } else { 16 << (code - 0x71) },
                kind,
                count: i.immediate? as u8,
            }
        },
        0x0F51 | 0x0F52 | 0x0F53 | 0x0F58 | 0x0F59 | 0x0F5C | 0x0F5D | 0x0F5E | 0x0F5F
        | 0x660F51 | 0x660F58 | 0x660F59 | 0x660F5C | 0x660F5D | 0x660F5E | 0x660F5F | 0xF20F51
        | 0xF20F58 | 0xF20F59 | 0xF20F5C | 0xF20F5D | 0xF20F5E | 0xF20F5F | 0xF30F51 | 0xF30F52
        | 0xF30F53 | 0xF30F58 | 0xF30F59 | 0xF30F5C | 0xF30F5D | 0xF30F5E | 0xF30F5F => {
            Simd::Float {
                opcode: code,
                reg,
                double: matches!(prefix, 0x66 | 0xF2),
                scalar: matches!(prefix, 0xF2 | 0xF3),
            }
        },
        0x0F5A => Simd::Convert {
            opcode: 0x5F,
            reg,
            source: 8,
            result: 16,
        },
        0x660F5A => Simd::Convert {
            opcode: 0x5E,
            reg,
            source: 16,
            result: 16,
        },
        0xF20F5A => Simd::Convert {
            opcode: 0x5E,
            reg,
            source: 8,
            result: 4,
        },
        0xF30F5A => Simd::Convert {
            opcode: 0x5F,
            reg,
            source: 4,
            result: 8,
        },
        0x0F5B => Simd::Convert {
            opcode: 0xFA,
            reg,
            source: 16,
            result: 16,
        },
        0xF30FE6 => Simd::Convert {
            opcode: 0xFE,
            reg,
            source: 8,
            result: 16,
        },
        0x660F5B | 0xF30F5B | 0x660FE6 | 0xF20FE6 => Simd::ConvertInteger {
            reg,
            double: code == 0xE6,
            truncate: matches!(op, 0xF30F5B | 0x660FE6),
        },
        0xF20F2A | 0xF30F2A => Simd::ToScalar {
            reg,
            double: prefix == 0xF2,
        },
        0xF20F2C | 0xF30F2C | 0xF20F2D | 0xF30F2D => Simd::ToInteger {
            reg,
            double: prefix == 0xF2,
            truncate: code == 0x2C,
        },
        0x0F2E | 0x0F2F | 0x660F2E | 0x660F2F => Simd::CompareFlags {
            reg,
            double: prefix == 0x66,
        },
        0x0FC2 | 0x660FC2 | 0xF30FC2 | 0xF20FC2 => Simd::CompareMask {
            reg,
            double: matches!(prefix, 0x66 | 0xF2),
            scalar: matches!(prefix, 0xF2 | 0xF3),
            predicate: i.immediate? as u8 & 7,
        },
        0x660FD7 | 0x0F50 | 0x660F50 if !memory => Simd::MoveMask {
            reg,
            lane: match op {
                0x660FD7 => 1,
                0x0F50 => 4,
                _ => 8,
            },
        },
        0x0F70 | 0x660F70 | 0xF20F70 | 0xF30F70 | 0x0FC6 | 0x660FC6 => Simd::Packed {
            op: vec::shuffle(op, i.immediate?),
            reg,
            mmx: op == 0x0F70,
            source: source_bytes(op),
        },
        0x0F14 => Simd::Packed {
            op: Packed::Unpack(4, false),
            reg,
            mmx: false,
            source: 8,
        },
        0x0F15 => Simd::Packed {
            op: Packed::Unpack(4, true),
            reg,
            mmx: false,
            source: 16,
        },
        0x660F14 => Simd::Packed {
            op: Packed::Unpack(8, false),
            reg,
            mmx: false,
            source: 8,
        },
        0x660F15 => Simd::Packed {
            op: Packed::Unpack(8, true),
            reg,
            mmx: false,
            source: 16,
        },
        0x0F16 => Simd::Packed {
            op: Packed::Shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]),
            reg,
            mmx: false,
            source: 8,
        },
        0x0F54 | 0x660F54 => Simd::Packed {
            op: Packed::Binary(0x4E),
            reg,
            mmx: false,
            source: 16,
        },
        0x0F55 | 0x660F55 => Simd::Packed {
            op: Packed::AndNot,
            reg,
            mmx: false,
            source: 16,
        },
        0x0F56 | 0x660F56 => Simd::Packed {
            op: Packed::Binary(0x50),
            reg,
            mmx: false,
            source: 16,
        },
        0x0F57 | 0x660F57 => Simd::Packed {
            op: Packed::Binary(0x51),
            reg,
            mmx: false,
            source: 16,
        },
        _ if prefix == 0 || prefix == 0x66 => Simd::Packed {
            op: packed_op(code, prefix == 0)?,
            reg,
            mmx: prefix == 0,
            source: source_bytes(op),
        },
        _ => return None,
    })
}

/// The template of a VEX form (AVX, P5: VEX.128 and VEX.LIG; others step):
/// its legacy form's, with what cpu::avx does differently (Vex)
pub(super) fn classify_vex(i: &DecodedInstruction) -> Option<(Simd, Vex)> {
    if !cfg!(target_feature = "simd128") {
        return None;
    }
    vex_form(i)
}

/// classify_vex without its simd128 condition (see legacy_form)
fn vex_form(i: &DecodedInstruction) -> Option<(Simd, Vex)> {
    use crate::decode_rules::vex;
    let v = i.vex?;
    if i.early_ud || i.baseline_ud {
        return None;
    }
    // (VEX.L1 of other than VEX.LIG rows: 256-bit forms)
    if v.l && i.encoding.vex & (vex::L0 | vex::L1) != 0 {
        return classify_vex256(i);
    }
    let key = crate::cpu::avx::legacy(i.encoding.opcode);
    let code = key as u8;
    // VZEROUPPER (no ModRM byte)
    if key == 0x0F77 {
        return Some((
            Simd::Vzeroupper,
            Vex {
                first: None,
                aligned: false,
            },
        ));
    }
    let modrm = i.modrm?;
    let (reg, rm, memory) = (modrm >> 3 & 7, modrm & 7, i.ea.is_some());
    // (VEX.vvvv: XMM0-7 outside 64-bit mode)
    let first = Some(v.vvvv & 7);
    let one_source = Vex {
        first: None,
        aligned: false,
    };
    let two_sources = Vex {
        first,
        aligned: false,
    };
    let aligned = Vex {
        first: None,
        aligned: true,
    };
    // FMA (P11): the VEX.128 and scalar forms
    if v.map == 2 && v.pp == 1 && matches!(code, 0x96..=0x9F | 0xA6..=0xAF | 0xB6..=0xBF) {
        return Some((
            Simd::Fused {
                op: code,
                double: v.w,
                reg,
            },
            two_sources,
        ));
    }
    let vector = |op: Packed| Simd::Packed {
        op,
        reg,
        mmx: false,
        source: 16,
    };
    let scalar_bytes = if v.pp == 2 { 4 } else { 8 };
    Some(match (v.map, v.pp, code) {
        // VMOVUPS VMOVUPD VMOVDQU, VMOVAPS VMOVAPD VMOVDQA
        (1, 0 | 1, 0x10) | (1, 2, 0x6F) => (Simd::Load128 { reg }, one_source),
        (1, 0 | 1, 0x28) | (1, 1, 0x6F) => (Simd::Load128 { reg }, aligned),
        (1, 0 | 1, 0x11) | (1, 2, 0x7F) => (Simd::Store128 { reg }, one_source),
        (1, 0 | 1, 0x29) | (1, 1, 0x7F) => (Simd::Store128 { reg }, aligned),
        // VMOVNTPS VMOVNTPD VMOVNTDQ
        (1, 0 | 1, 0x2B) | (1, 1, 0xE7) if memory => (Simd::Store128 { reg }, aligned),
        // VMOVSS VMOVSD: between registers the other lanes from VEX.vvvv
        (1, 2 | 3, 0x10) => (
            Simd::LoadScalar {
                reg,
                bytes: scalar_bytes,
            },
            two_sources,
        ),
        (1, 2 | 3, 0x11) => (
            Simd::StoreScalar {
                reg,
                bytes: scalar_bytes,
            },
            two_sources,
        ),
        // VMOVQ xmm, xmm/m64 and xmm/m64, xmm; VMOVD xmm, r/m32 and r/m32,
        // xmm (VEX.W ignored)
        (1, 2, 0x7E) => (Simd::LoadQuad { reg }, one_source),
        (1, 1, 0xD6) => (Simd::StoreQuad { reg }, one_source),
        (1, 1, 0x6E) => (Simd::MovdIn { reg, mmx: false }, one_source),
        (1, 1, 0x7E) => (Simd::MovdOut { reg, mmx: false }, one_source),
        // VANDPS/PD VANDNPS/PD VORPS/PD VXORPS/PD
        (1, 0 | 1, 0x54..=0x57) => (
            vector(match code {
                0x54 => Packed::Binary(0x4E),
                0x55 => Packed::AndNot,
                0x56 => Packed::Binary(0x50),
                _ => Packed::Binary(0x51),
            }),
            two_sources,
        ),
        // VUNPCKLPS/PD VUNPCKHPS/PD (an m128, as cpu::avx reads)
        (1, 0 | 1, 0x14 | 0x15) => (
            vector(Packed::Unpack(if v.pp == 1 { 8 } else { 4 }, code == 0x15)),
            two_sources,
        ),
        // VSHUFPS VSHUFPD
        (1, 0 | 1, 0xC6) => (
            vector(Packed::Shuffle(shuffle_lanes(key, i.immediate?).0)),
            two_sources,
        ),
        // VBROADCASTSS xmm, m32 (AVX2: also xmm), VPBROADCASTB/W/D/Q (AVX2):
        // the source's element in each lane
        (2, 1, 0x18 | 0x58 | 0x59 | 0x78 | 0x79) => {
            let bytes = broadcast_bytes(code);
            let lanes = std::array::from_fn(|k| 16 + k as u8 % bytes);
            (
                Simd::Packed {
                    op: Packed::Shuffle(lanes),
                    reg,
                    mmx: false,
                    source: bytes,
                },
                one_source,
            )
        },
        // VMOVHLPS, VMOVLPS, VMOVLPD (the low quadword from the source's
        // high one or m64) and VMOVLHPS, VMOVHPS, VMOVHPD (the high one from
        // the source's low one or m64), the other from the first source
        (1, 0 | 1, 0x12 | 0x16) => {
            let (low, high, bytes) = match (code, memory) {
                (0x12, false) => (24, 8, 16),
                (0x12, true) => (16, 8, 8),
                _ => (0, 16, 8),
            };
            let lanes = std::array::from_fn(|k| {
                if k < 8 {
                    low + k as u8
                }
                else {
                    high + k as u8 - 8
                }
            });
            (
                Simd::Packed {
                    op: Packed::Shuffle(lanes),
                    reg,
                    mmx: false,
                    source: bytes,
                },
                two_sources,
            )
        },
        // VMOVDDUP (m64), VMOVSLDUP, VMOVSHDUP: the source's lanes only
        (1, 3, 0x12) | (1, 2, 0x12 | 0x16) => {
            let lanes: [u8; 16] = std::array::from_fn(|k| {
                let k = k as u8;
                16 + match (v.pp, code) {
                    (3, _) => k % 8,
                    (_, 0x12) => k / 8 * 8 + k % 4,
                    _ => k / 8 * 8 + 4 + k % 4,
                }
            });
            (
                Simd::Packed {
                    op: Packed::Shuffle(lanes),
                    reg,
                    mmx: false,
                    source: if v.pp == 3 { 8 } else { 16 },
                },
                one_source,
            )
        },
        // VPSHUFD VPSHUFHW VPSHUFLW: lanes of the source only
        (1, 1..=3, 0x70) => {
            let (mut lanes, _) = shuffle_lanes(key, i.immediate?);
            for lane in &mut lanes {
                *lane += 16;
            }
            (vector(Packed::Shuffle(lanes)), one_source)
        },
        // the packed integer operations of 66 0F (cpu::avx)
        (
            1,
            1,
            0x60..=0x6D
            | 0x74..=0x76
            | 0xD1..=0xD5
            | 0xD8..=0xDF
            | 0xE0..=0xE5
            | 0xE8..=0xEF
            | 0xF1..=0xF6
            | 0xF8..=0xFE,
        ) => (vector(packed_op(code, false)?), two_sources),
        // VPSRLx VPSRAx VPSLLx VPSRLDQ VPSLLDQ by imm8: VEX.vvvv the
        // destination, the r/m register the source
        (1, 1, 0x71..=0x73) if !memory => {
            let kind = reg;
            let bytes = matches!(kind, 3 | 7);
            (
                Simd::ShiftImmediate {
                    reg: v.vvvv & 7,
                    mmx: false,
                    bits: if bytes { 128 } else { 16 << (code - 0x71) },
                    kind,
                    count: i.immediate? as u8,
                },
                Vex {
                    first: Some(rm),
                    aligned: false,
                },
            )
        },
        // VSQRT VADD VMUL VSUB VMIN VDIV VMAX PS/PD/SS/SD, VRSQRT VRCP PS/SS
        // (a scalar form's other lanes from VEX.vvvv; VSQRT, VRSQRT and VRCP
        // PS/PD: one_source source)
        (1, 0..=3, 0x51 | 0x58 | 0x59 | 0x5C..=0x5F) | (1, 0 | 2, 0x52 | 0x53) => {
            let scalar = v.pp >= 2;
            (
                Simd::Float {
                    opcode: code,
                    reg,
                    double: v.pp & 1 != 0,
                    scalar,
                },
                if scalar || !matches!(code, 0x51..=0x53) { two_sources } else { one_source },
            )
        },
        // VCVTPS2PD VCVTPD2PS VCVTSS2SD VCVTSD2SS VCVTDQ2PS VCVTDQ2PD
        (1, 0..=3, 0x5A) | (1, 0, 0x5B) | (1, 2, 0xE6) => {
            let (opcode, source, result) = match key {
                0x0F5A => (0x5F, 8, 16),
                0x660F5A => (0x5E, 16, 16),
                0xF20F5A => (0x5E, 8, 4),
                0xF30F5A => (0x5F, 4, 8),
                0x0F5B => (0xFA, 16, 16),
                _ => (0xFE, 8, 16),
            };
            (
                Simd::Convert {
                    opcode,
                    reg,
                    source,
                    result,
                },
                if result < 16 { two_sources } else { one_source },
            )
        },
        // VCVT(T)PS2DQ VCVT(T)PD2DQ
        (1, 1 | 2, 0x5B) | (1, 1 | 3, 0xE6) => (
            Simd::ConvertInteger {
                reg,
                double: code == 0xE6,
                truncate: matches!(key, 0xF30F5B | 0x660FE6),
            },
            one_source,
        ),
        // VCVTSI2SS VCVTSI2SD xmm, xmm, r/m32 (VEX.W ignored)
        (1, 2 | 3, 0x2A) => (
            Simd::ToScalar {
                reg,
                double: v.pp == 3,
            },
            two_sources,
        ),
        // VCVT(T)SS2SI VCVT(T)SD2SI r32 (VEX.W ignored)
        (1, 2 | 3, 0x2C | 0x2D) => (
            Simd::ToInteger {
                reg,
                double: v.pp == 3,
                truncate: code == 0x2C,
            },
            one_source,
        ),
        // VUCOMISS/SD VCOMISS/SD
        (1, 0 | 1, 0x2E | 0x2F) => (
            Simd::CompareFlags {
                reg,
                double: v.pp == 1,
            },
            one_source,
        ),
        // VCMPPS/PD/SS/SD with imm8[4:0]
        (1, 0..=3, 0xC2) => (
            Simd::CompareMask {
                reg,
                double: v.pp & 1 != 0,
                scalar: v.pp >= 2,
                predicate: i.immediate? as u8 & 31,
            },
            two_sources,
        ),
        // VPMOVMSKB VMOVMSKPS VMOVMSKPD r32, xmm
        (1, 1, 0xD7) | (1, 0 | 1, 0x50) if !memory => (
            Simd::MoveMask {
                reg,
                lane: match (v.pp, code) {
                    (_, 0xD7) => 1,
                    (0, _) => 4,
                    _ => 8,
                },
            },
            one_source,
        ),
        // VROUNDPS/PD (one_source source), VROUNDSS/SD
        (3, 1, 0x08..=0x0B) => (
            Simd::Round {
                reg,
                double: code & 1 != 0,
                scalar: code & 2 != 0,
                imm8: i.immediate? as u8,
            },
            if code & 2 != 0 { two_sources } else { one_source },
        ),
        // VPCMPESTRM/I VPCMPISTRM/I (VEX.W ignored)
        (3, 1, 0x60..=0x63) => (
            Simd::Strings {
                reg,
                op: code,
                imm8: i.immediate? as u8,
            },
            one_source,
        ),
        // VBLENDVPS VBLENDVPD VPBLENDVB: the mask register imm8[6:4]
        (3, 1, 0x4A..=0x4C) => (
            Simd::Blendv {
                reg,
                lane: [4, 8, 1][(code - 0x4A) as usize],
                mask: i.immediate? as u8 >> 4 & 7,
            },
            two_sources,
        ),
        // VPSHUFB VPALIGNR, the SSE4.1 forms of one_source operation and the
        // blends by imm8
        (2 | 3, 1, _) => match sse4(i, key).or_else(|| ssse3(i, key))? {
            form @ Simd::Packed { .. } => (form, two_sources),
            _ => return None,
        },
        _ => return None,
    })
}

/// The template of a VEX.256 form (P6): the moves and VZEROALL, the hot
/// forms of AVX's 256-bit ones; the others step
fn classify_vex256(i: &DecodedInstruction) -> Option<(Simd, Vex)> {
    use crate::decode_rules::vex;
    let v = i.vex?;
    if i.encoding.vex & vex::L1 == 0 {
        return None;
    }
    let key = crate::cpu::avx::legacy(i.encoding.opcode);
    let vex = |aligned| Vex {
        first: None,
        aligned,
    };
    // VZEROALL (no ModRM byte)
    if key == 0x0F77 {
        return Some((Simd::Vzeroall, vex(false)));
    }
    let reg = i.modrm? >> 3 & 7;
    let two_sources = Vex {
        first: Some(v.vvvv & 7),
        aligned: false,
    };
    Some(match (v.map, v.pp, key as u8) {
        // VMOVUPS VMOVUPD VMOVDQU, VMOVAPS VMOVAPD VMOVDQA (aligned)
        (1, 0 | 1, 0x10) | (1, 2, 0x6F) => (Simd::Load256 { reg }, vex(false)),
        (1, 0 | 1, 0x28) | (1, 1, 0x6F) => (Simd::Load256 { reg }, vex(true)),
        (1, 0 | 1, 0x11) | (1, 2, 0x7F) => (Simd::Store256 { reg }, vex(false)),
        (1, 0 | 1, 0x29) | (1, 1, 0x7F) => (Simd::Store256 { reg }, vex(true)),
        // VMOVNTPS VMOVNTPD VMOVNTDQ
        (1, 0 | 1, 0x2B) | (1, 1, 0xE7) if i.ea.is_some() => (Simd::Store256 { reg }, vex(true)),
        // AVX2 (P7 part 3): VPMOVMSKB; VMOVMSKPS, VMOVMSKPD
        (1, 1, 0xD7) | (1, 0 | 1, 0x50) if i.ea.is_none() => {
            let lane = match (v.pp, key as u8) {
                (_, 0xD7) => 1,
                (0, _) => 4,
                _ => 8,
            };
            (Simd::MoveMask256 { reg, lane }, vex(false))
        },
        // VBROADCASTSS, VBROADCASTSD, VPBROADCASTB/W/D/Q
        (2, 1, 0x18 | 0x19 | 0x58 | 0x59 | 0x78 | 0x79) => (
            Simd::Broadcast256 {
                reg,
                bytes: broadcast_bytes(key as u8),
            },
            vex(false),
        ),
        // the packed integer forms of 66 0F, VPSHUFB and SSE4.1's of one
        // operation, on each half
        (1, 1, code) => match packed_op(code, false)? {
            Packed::Shift(..) => return None,
            op => (Simd::Packed256 { op, reg }, two_sources),
        },
        (2, 1, 0x00 | 0x28 | 0x29 | 0x2B | 0x37..=0x40) => {
            match sse4(i, key).or_else(|| ssse3(i, key))? {
                Simd::Packed { op, .. } => (Simd::Packed256 { op, reg }, two_sources),
                _ => return None,
            }
        },
        _ => return None,
    })
}

/// The element of VBROADCASTSS (18), VBROADCASTSD (19), VPBROADCASTD/Q (58,
/// 59), VPBROADCASTB/W (78, 79)
fn broadcast_bytes(code: u8) -> u8 {
    match code {
        0x78 => 1,
        0x79 => 2,
        0x18 | 0x58 => 4,
        _ => 8,
    }
}

impl Page {
    /// The register read in place of the destination `reg` (Vex::first)
    fn first(&self, reg: u8) -> u8 { self.vex.and_then(|v| v.first).unwrap_or(reg) }
    /// Whether a `bytes`-wide memory operand must be 16-byte aligned (see
    /// Encoding::aligned_m128, Vex::aligned)
    fn m128_aligned(&self, i: &DecodedInstruction, bytes: u8) -> bool {
        match self.vex {
            Some(v) => v.aligned && bytes == 16,
            None => aligned_m128(i, bytes),
        }
    }
    /// The VEX guard: #UD and #NM (vex_fault) belong to the interpreter;
    /// checked once per block (simd_checked bit 4), of the condition computed
    /// on entry (Page::vex_fault)
    fn vex_guard(&mut self) {
        if self.simd_checked & 4 != 0 {
            return;
        }
        let fault = self.vex_fault.as_ref().unwrap().unsafe_clone();
        self.w.get_local(&fault);
        self.retry_if();
        self.simd_checked |= 4;
    }
    /// Zero bits 255:128 of YMM `r` (in the CPU state), once per block (see
    /// ymm_zeroed: every template writes its destination at its top level)
    fn ymm_zero(&mut self, r: u8) {
        if self.ymm_zeroed & 1 << r != 0 {
            return;
        }
        self.ymm_zeroed |= 1 << r;
        self.w
            .const_i32(unsafe { gp::ymm_hi.add(r as usize) } as i32);
        self.w.simd_zero();
        self.w.simd_memory(0x0B, 0); // v128.store
    }
    /// #UD (CR0.EM, and for XMM forms no CR4.OSFXSR) and #NM (CR0.TS)
    /// belong to the interpreter; checked once per block (see simd_checked).
    fn simd_guard(&mut self, xmm: bool) {
        let checks = if xmm { 3 } else { 1 };
        if self.simd_checked & checks == checks {
            return;
        }
        self.w.load_fixed_i32(gp::cr as u32);
        self.w.const_i32(CR0_EM | CR0_TS);
        self.w.and_i32();
        if xmm {
            self.w.load_fixed_i32(gp::cr as u32 + 4 * 4);
            self.w.const_i32(CR4_OSFXSR);
            self.w.and_i32();
            self.w.eqz_i32();
            self.w.or_i32();
        }
        self.retry_if();
        self.simd_checked |= checks;
    }
    fn load_xmm(&mut self, r: u8) { self.load_xmm_bytes(r, 16) }
    /// The low `bytes` of XMM `r`, zero-extended, from the block's register
    /// cache (see Page::xmm).
    fn load_xmm_bytes(&mut self, r: u8, bytes: u8) {
        self.xmm_cached(r);
        let local = self.xmm[r as usize].as_ref().unwrap().unsafe_clone();
        self.w.get_local_v128(&local);
        if bytes < 16 {
            self.w.simd_zero();
            let mut lanes = [0; 16];
            for (k, lane) in lanes.iter_mut().enumerate() {
                *lane = if k < bytes as usize { k as u8 } else { 16 + k as u8 };
            }
            self.w.simd_shuffle(lanes);
        }
    }
    /// Cache XMM `r` in a local (loaded from the CPU state when first used).
    fn xmm_cached(&mut self, r: u8) {
        if self.xmm[r as usize].is_none() {
            self.w.const_i32(gp::get_reg_xmm_offset(r as u32) as i32);
            self.w.simd_memory(0x00, 0);
            self.xmm[r as usize] = Some(self.w.set_new_local_v128());
        }
    }
    /// XMM `r` = `value`; a VEX form's bits 255:128 zeroed too (every
    /// template writes its XMM destination last, after its retries)
    fn store_xmm(&mut self, r: u8, value: &WasmLocalV128) {
        self.cache_xmm(r, value);
        if self.vex.is_some() {
            self.ymm_zero(r);
        }
    }
    /// XMM `r` = `value` in the block's register cache
    fn cache_xmm(&mut self, r: u8, value: &WasmLocalV128) {
        self.xmm_clean[r as usize] = 0;
        self.w.get_local_v128(value);
        match &self.xmm[r as usize] {
            Some(local) => self.w.set_local_v128(&local.unsafe_clone()),
            None => self.xmm[r as usize] = Some(self.w.set_new_local_v128()),
        }
        self.xmm_dirty |= 1 << r;
    }
    /// YMM `r` = (`low`, `high`) (VEX.256, written last): bits 255:128 in the
    /// CPU state, where the block's next VEX.128 write to `r` zeroes them
    /// again (ymm_zeroed)
    fn store_ymm(&mut self, r: u8, low: &WasmLocalV128, high: &WasmLocalV128) {
        self.cache_xmm(r, low);
        self.w
            .const_i32(unsafe { gp::ymm_hi.add(r as usize) } as i32);
        self.w.get_local_v128(high);
        self.w.simd_memory(0x0B, 0); // v128.store
        self.ymm_zeroed &= !(1 << r);
    }
    /// Push bits 255:128 of YMM `r` (from the CPU state)
    fn load_ymm_high(&mut self, r: u8) {
        self.w
            .const_i32(unsafe { gp::ymm_hi.add(r as usize) } as i32);
        self.w.simd_memory(0x00, 0); // v128.load
    }
    /// Store the low `bytes` of `value` into the low lane of XMM `r`, the
    /// other lanes those of `r` (a VEX form's: of its first source)
    fn store_xmm_low(&mut self, r: u8, value: &WasmLocalV128, bytes: u8) {
        if bytes == 16 {
            self.store_xmm(r, value);
            return;
        }
        let base = self.first(r);
        self.xmm_cached(base);
        let local = self.xmm[base as usize].as_ref().unwrap().unsafe_clone();
        self.w.get_local_v128(value);
        self.w.get_local_v128(&local);
        let mut lanes = [0; 16];
        for (k, lane) in lanes.iter_mut().enumerate() {
            *lane = if k < bytes as usize { k as u8 } else { 16 + k as u8 };
        }
        self.w.simd_shuffle(lanes);
        let merged = self.w.set_new_local_v128();
        self.store_xmm(r, &merged);
        self.w.free_local_v128(merged);
    }
    /// Push `bytes` (zero-extended) at addr: one ordinary RAM page, else retry.
    fn load_vector(&mut self, bytes: u8) {
        self.tlb_miss(bytes as u32, false);
        self.retry_if();
        self.host_address();
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            // (cores in workers: ordered scalar halves, zero-extended)
            match bytes {
                16 => {
                    let scratch = self.w.set_new_local();
                    self.w.get_local(&scratch);
                    self.w.guest_load_v128(&scratch);
                    self.w.free_local(scratch);
                },
                8 => {
                    self.w.guest_load_i64(0);
                    let scalar = self.w.set_new_local_i64();
                    self.w.simd_zero();
                    self.w.get_local_i64(&scalar);
                    self.w.simd_lane(0x1E, 0);
                    self.w.free_local_i64(scalar);
                },
                _ => {
                    self.w.guest_load_i32(0);
                    let scalar = self.w.set_new_local();
                    self.w.simd_zero();
                    self.w.get_local(&scalar);
                    self.w.simd_lane(0x1C, 0);
                    self.w.free_local(scalar);
                },
            }
            return;
        }
        self.w.simd_memory(
            match bytes {
                16 => 0x00,
                8 => 0x5D,
                _ => 0x5C,
            },
            0,
        );
    }
    /// Store the low `bytes` of `value` at addr (writable RAM without code,
    /// else retry: the interpreter handles MMIO and code writes).
    fn store_vector(&mut self, bytes: u8, value: &WasmLocalV128) {
        self.tlb_miss(bytes as u32, true);
        self.retry_if();
        self.host_address();
        if WasmBuilder::ATOMIC_GUEST_MEMORY && bytes == 16 {
            let address = self.w.set_new_local();
            self.w.guest_store_v128(&address, value);
            self.w.free_local(address);
            return;
        }
        self.w.get_local_v128(value);
        match bytes {
            16 => self.w.simd_memory(0x0B, 0),
            8 => {
                self.w.simd_lane(0x1D, 0);
                self.w.guest_store_i64(0);
            },
            _ => {
                self.w.simd_lane(0x1B, 0);
                self.w.guest_store_i32(0);
            },
        }
    }
    /// simd_source for forms that use only the low `bytes` lane (registers
    /// are read whole: no zero extension needed).
    fn scalar_source(&mut self, i: &DecodedInstruction, bytes: u8) {
        match &i.ea {
            Some(_) => self.simd_source(i, false, bytes),
            None => self.load_xmm(i.modrm.unwrap() & 7),
        }
    }
    /// retry() unless the linear address (Page::addr) is 16-byte aligned:
    /// the interpreter raises #GP(0)
    fn retry_unaligned(&mut self) { self.retry_misaligned(16) }
    /// retry() unless the linear address is `bytes`-aligned
    fn retry_misaligned(&mut self, bytes: i32) {
        self.w.get_local(&self.addr);
        self.w.const_i32(bytes - 1);
        self.w.and_i32();
        self.retry_if();
    }
    /// The 32 bytes at addr (VEX.256) in two locals, the low and high
    /// halves: one ordinary RAM page, else retry
    fn load_vector256(&mut self) -> [WasmLocalV128; 2] {
        self.tlb_miss(32, false);
        self.retry_if();
        self.host_address();
        let low = self.w.set_new_local();
        self.w.get_local(&low);
        self.w.const_i32(16);
        self.w.add_i32();
        let high = self.w.set_new_local();
        [low, high].map(|address| {
            // (guest_load_v128 tees the address into its scratch local)
            self.w.get_local(&address);
            self.w.guest_load_v128(&address);
            self.w.free_local(address);
            self.w.set_new_local_v128()
        })
    }
    /// Store `halves` (VEX.256) at addr: one writable RAM page without code
    /// (both halves checked before either is written), else retry
    fn store_vector256(&mut self, halves: &[WasmLocalV128; 2]) {
        self.tlb_miss(32, true);
        self.retry_if();
        self.host_address();
        let address = self.w.set_new_local();
        self.w.guest_store_v128(&address, &halves[0]);
        self.w.get_local(&address);
        self.w.const_i32(16);
        self.w.add_i32();
        self.w.set_local(&address);
        self.w.guest_store_v128(&address, &halves[1]);
        self.w.free_local(address);
    }
    /// Push the r/m operand: an MMX/XMM register or `bytes` of memory (with
    /// the alignment of aligned_m128).
    fn simd_source(&mut self, i: &DecodedInstruction, mmx: bool, bytes: u8) {
        match &i.ea {
            Some(ea) => {
                self.linear(ea);
                if self.m128_aligned(i, bytes) {
                    self.retry_unaligned();
                }
                self.load_vector(bytes);
            },
            None if mmx => mmx::load(&mut self.w, i.modrm.unwrap() & 7),
            None => self.load_xmm_bytes(i.modrm.unwrap() & 7, bytes),
        }
    }
    fn simd_result(&mut self, reg: u8, mmx: bool, value: &WasmLocalV128) {
        if mmx {
            mmx::store(&mut self.w, reg, value);
            mmx::transition(&mut self.w);
        }
        else {
            self.store_xmm(reg, value);
        }
    }
    /// Push native_fp::mxcsr_refused, evaluated once per block (see fp_mxcsr)
    fn mxcsr_refused(&mut self) {
        match &self.fp_mxcsr {
            Some(local) => self.w.get_local(local),
            None => {
                native_fp::mxcsr_refused(&mut self.w);
                let local = self.w.set_new_local();
                self.w.get_local(&local);
                self.fp_mxcsr = Some(local);
            },
        }
    }
    /// Open the exact path of a refused floating-point instruction, taken if
    /// the i32 on the stack is nonzero: runtime::tier0::ir_t0_sse_fp on
    /// (`destination`, `source`), or retry() if it faults. The caller reads
    /// the result (exact_result) and closes the block. Refusals that leave
    /// facts in xmm_clean, which hold only for admitted operands, retry
    /// instead (the instruction is not refused for MXCSR alone).
    fn exact_if(
        &mut self,
        i: &DecodedInstruction,
        destination: &WasmLocalV128,
        source: &WasmLocalV128,
    ) {
        self.w.hint(false);
        self.w.if_void();
        self.exact(i, destination, source, i.immediate.unwrap_or(0));
    }
    /// (a VEX form: its legacy form's key, with the first source as the
    /// destination)
    fn exact(
        &mut self,
        i: &DecodedInstruction,
        destination: &WasmLocalV128,
        source: &WasmLocalV128,
        imm8: u32,
    ) {
        let key = match i.vex {
            Some(_) => crate::cpu::avx::legacy(i.encoding.opcode),
            None => i.encoding.opcode,
        };
        sse_fp_call(
            &mut self.w,
            self.env.sse_fp_operands,
            key,
            imm8,
            destination,
            source,
        );
        self.retry_if();
    }
    /// Push the result of exact_if's path
    fn exact_result(&mut self) { sse_fp_result(&mut self.w, self.env.sse_fp_operands) }

    /// The template of `form` (`vex`: a VEX form's, see classify_vex)
    pub(super) fn simd(&mut self, form: Simd, i: &DecodedInstruction, vex: Option<Vex>) {
        self.vex = vex;
        match vex {
            Some(_) => self.vex_guard(),
            None => self.simd_guard(!i.encoding.mmx),
        }
        self.simd_form(form, i);
        self.vex = None;
    }
    fn simd_form(&mut self, form: Simd, i: &DecodedInstruction) {
        let rm = i.modrm.unwrap_or(0) & 7;
        match form {
            Simd::Fused { op, double, reg } => {
                // (the r/m operand first: its access may retry; a scalar
                // form's 32 or 64 bits)
                let scalar = op & 0xF >= 9 && op & 1 == 1;
                self.simd_source(
                    i,
                    false,
                    if !scalar {
                        16
                    }
                    else if double {
                        8
                    }
                    else {
                        4
                    },
                );
                let third = self.w.set_new_local_v128();
                // natively where the host's relaxed multiply-adds fuse
                // (native_fp::fused): the result, a scalar form's other lanes
                // the destination's; the exact path if a lane or MXCSR is
                // refused. (Both registers are cached before the branch.)
                let native = self.env.relaxed_fma.then(|| {
                    self.load_xmm(reg);
                    let d = self.w.set_new_local_v128();
                    self.load_xmm(self.first(reg));
                    let f = self.w.set_new_local_v128();
                    let r = native_fp::fused(&mut self.w, op, double, scalar, [&d, &f, &third]);
                    self.mxcsr_refused();
                    self.w.or_i32();
                    let refused = self.w.set_new_local();
                    if scalar {
                        let bytes = if double { 8 } else { 4 };
                        self.w.get_local_v128(&r);
                        self.w.get_local_v128(&d);
                        let mut lanes = [0; 16];
                        for (k, lane) in lanes.iter_mut().enumerate() {
                            *lane = if k < bytes { k as u8 } else { 16 + k as u8 };
                        }
                        self.w.simd_shuffle(lanes);
                        self.w.set_local_v128(&r);
                    }
                    self.w.get_local(&refused);
                    self.w.free_local(refused);
                    self.w.free_local_v128(d);
                    self.w.free_local_v128(f);
                    self.w.hint(false);
                    self.w.if_void();
                    r
                });
                let operands = self.env.sse_fp_operands;
                for (k, r) in [reg, self.first(reg)].into_iter().enumerate() {
                    self.w.const_i32((operands + 16 * k as u32) as i32);
                    self.load_xmm(r);
                    self.w.simd_memory(0x0B, 4); // v128.store
                }
                self.w.const_i32((operands + 32) as i32);
                self.w.get_local_v128(&third);
                self.w.simd_memory(0x0B, 4);
                self.w.const_i32(op as i32 | (double as i32) << 8);
                self.w.call_signature("ir_t0_fma", signature("ir_t0_fma"));
                self.retry_if();
                self.w.const_i32(operands as i32);
                self.w.simd_memory(0x00, 4); // v128.load
                let result = match native {
                    Some(r) => {
                        self.w.set_local_v128(&r);
                        self.w.block_end();
                        r
                    },
                    None => self.w.set_new_local_v128(),
                };
                self.store_xmm(reg, &result);
                self.w.free_local_v128(third);
                self.w.free_local_v128(result);
            },
            Simd::Load128 { reg } => {
                self.simd_source(i, false, 16);
                let v = self.w.set_new_local_v128();
                self.store_xmm(reg, &v);
                self.w.free_local_v128(v);
                if i.ea.is_none() {
                    self.xmm_clean[reg as usize] = self.xmm_clean[rm as usize];
                }
            },
            Simd::Store128 { reg } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                    if self.m128_aligned(i, 16) {
                        self.retry_unaligned();
                    }
                }
                self.load_xmm(reg);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(16, &v);
                }
                else {
                    self.store_xmm(rm, &v);
                    self.xmm_clean[rm as usize] = self.xmm_clean[reg as usize];
                }
                self.w.free_local_v128(v);
            },
            Simd::LoadScalar { reg, bytes } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                    self.load_vector(bytes);
                    let v = self.w.set_new_local_v128();
                    self.store_xmm(reg, &v);
                    self.w.free_local_v128(v);
                }
                else {
                    self.load_xmm_bytes(rm, bytes);
                    let v = self.w.set_new_local_v128();
                    self.store_xmm_low(reg, &v, bytes);
                    self.w.free_local_v128(v);
                }
            },
            Simd::StoreScalar { reg, bytes } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                self.load_xmm_bytes(reg, bytes);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(bytes, &v);
                }
                else {
                    self.store_xmm_low(rm, &v, bytes);
                }
                self.w.free_local_v128(v);
            },
            Simd::LoadQuad { reg } => {
                // Both forms zero-extend the low quadword.
                self.simd_source(i, false, 8);
                let v = self.w.set_new_local_v128();
                self.store_xmm(reg, &v);
                self.w.free_local_v128(v);
            },
            Simd::StoreQuad { reg } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                self.load_xmm_bytes(reg, 8);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(8, &v);
                }
                else {
                    self.store_xmm(rm, &v);
                }
                self.w.free_local_v128(v);
            },
            Simd::MmxLoad { reg } => {
                self.simd_source(i, true, 8);
                let v = self.w.set_new_local_v128();
                self.simd_result(reg, true, &v);
                self.w.free_local_v128(v);
            },
            Simd::MmxStore { reg } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                mmx::load(&mut self.w, reg);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(8, &v);
                    mmx::transition(&mut self.w);
                }
                else {
                    self.simd_result(rm, true, &v);
                }
                self.w.free_local_v128(v);
            },
            Simd::MovdIn { reg, mmx } => {
                match &i.ea {
                    Some(ea) => {
                        self.linear(ea);
                        self.read_mem(32, false);
                    },
                    None => self.read_reg(rm, 32),
                }
                let value = self.value.unsafe_clone();
                self.w.set_local(&value);
                self.w.simd_zero();
                self.w.get_local(&value);
                self.w.simd_lane(0x1C, 0); // i32x4.replace_lane
                let v = self.w.set_new_local_v128();
                self.simd_result(reg, mmx, &v);
                self.w.free_local_v128(v);
            },
            Simd::MovdOut { reg, mmx } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                if mmx {
                    mmx::load(&mut self.w, reg);
                }
                else {
                    self.load_xmm(reg);
                }
                self.w.simd_lane(0x1B, 0);
                let value = self.value.unsafe_clone();
                self.w.set_local(&value);
                match &i.ea {
                    Some(_) => self.write_mem(32, &value),
                    None => {
                        self.w.get_local(&value);
                        self.write_reg(rm, 32);
                    },
                }
                if mmx {
                    mmx::transition(&mut self.w);
                }
            },
            Simd::Emms => {
                // fpu_set_tag_word(0xFFFF): all registers empty.
                self.w.const_i32(gp::fpu_stack_empty as i32);
                self.w.const_i32(0xFF);
                self.w.store_u8(0);
            },
            Simd::Packed {
                op,
                reg,
                mmx,
                source,
            } => {
                self.simd_source(i, mmx, source);
                let src = self.w.set_new_local_v128();
                let first = self.first(reg);
                if mmx {
                    mmx::load(&mut self.w, reg);
                }
                else {
                    self.load_xmm(first);
                }
                let dst = self.w.set_new_local_v128();
                packed(&mut self.w, op, &dst, &src, if mmx { 8 } else { 16 });
                let result = self.w.set_new_local_v128();
                let (destination, source) = (
                    self.xmm_clean[first as usize],
                    i.ea.is_none().then(|| self.xmm_clean[rm as usize]),
                );
                self.simd_result(reg, mmx, &result);
                for v in [src, dst, result] {
                    self.w.free_local_v128(v);
                }
                if let (false, Some(lanes)) = (mmx, op.lanes(16)) {
                    self.xmm_clean[reg as usize] = shuffled_clean(&lanes, destination, source);
                }
                if let (false, Packed::Binary(0x51), None) = (mmx, op, &i.ea) {
                    if rm == first {
                        // XORPS/XORPD/PXOR of a register with itself: zeros
                        self.xmm_clean[reg as usize] = CLEAN_SS | CLEAN_PS | CLEAN_SD | CLEAN_PD;
                    }
                }
            },
            Simd::ShiftImmediate {
                reg,
                mmx,
                bits,
                kind,
                count,
            } => {
                if mmx {
                    mmx::load(&mut self.w, reg);
                }
                else {
                    self.load_xmm(self.first(reg));
                }
                let dst = self.w.set_new_local_v128();
                shift_immediate(&mut self.w, &dst, bits, kind, count);
                let result = self.w.set_new_local_v128();
                self.simd_result(reg, mmx, &result);
                self.w.free_local_v128(dst);
                self.w.free_local_v128(result);
            },
            Simd::Float {
                opcode,
                reg,
                double,
                scalar,
            } => ops::float(&mut Operands { page: self, i, reg }, opcode, double, scalar),
            Simd::Convert {
                opcode,
                reg,
                source,
                result,
            } => ops::convert(&mut Operands { page: self, i, reg }, opcode, source, result),
            Simd::ConvertInteger {
                reg,
                double,
                truncate,
            } => ops::convert_to_integers(&mut Operands { page: self, i, reg }, double, truncate),
            Simd::ToScalar { reg, double } => {
                ops::from_integer(&mut Operands { page: self, i, reg }, double)
            },
            Simd::ToInteger {
                reg,
                double,
                truncate,
            } => ops::to_integer(&mut Operands { page: self, i, reg }, double, truncate),
            Simd::Strings { reg, op, imm8 } => {
                // (an m128 without alignment: the SDM's exception type 4 note)
                self.simd_source(i, false, 16);
                let source = self.w.set_new_local_v128();
                self.load_xmm(reg);
                let destination = self.w.set_new_local_v128();
                let operands = self.env.sse_fp_operands;
                for (k, value) in [&destination, &source].into_iter().enumerate() {
                    self.w.const_i32((operands + 16 * k as u32) as i32);
                    self.w.get_local_v128(value);
                    self.w.simd_memory(0x0B, 4); // v128.store
                }
                self.w.const_i32(op as i32);
                self.w.const_i32(imm8 as i32);
                if op & 2 == 0 {
                    // (the explicit lengths, EAX and EDX)
                    self.read_reg(0, 32);
                    self.read_reg(2, 32);
                }
                else {
                    self.w.const_i32(0);
                    self.w.const_i32(0);
                }
                self.w
                    .call_signature("ir_t0_pcmpstr", signature("ir_t0_pcmpstr"));
                let result = self.w.set_new_local();
                if op & 1 != 0 {
                    self.w.get_local(&result);
                    self.w.const_i32(0xFF);
                    self.w.and_i32();
                    self.write_reg(1, 32);
                }
                else {
                    self.w.const_i32(operands as i32);
                    self.w.simd_memory(0x00, 4); // v128.load
                    let mask = self.w.set_new_local_v128();
                    self.store_xmm(0, &mask);
                    self.w.free_local_v128(mask);
                }
                // EFLAGS: CF, ZF, SF and OF from the result; AF and PF clear
                self.w.const_i32(gp::flags as i32);
                self.w.load_fixed_i32(gp::flags as u32);
                self.w.const_i32(!FLAGS_ALL);
                self.w.and_i32();
                self.w.get_local(&result);
                self.w.const_i32(8);
                self.w.shr_u_i32();
                self.w.or_i32();
                self.w.store_aligned_i32(0);
                self.w.const_i32(gp::flags_changed as i32);
                self.w.const_i32(0);
                self.w.store_aligned_i32(0);
                self.known = super::Known::None;
                self.w.free_local(result);
                self.w.free_local_v128(destination);
                self.w.free_local_v128(source);
            },
            Simd::Round {
                reg,
                double,
                scalar,
                imm8,
            } => ops::round(&mut Operands { page: self, i, reg }, double, scalar, imm8),
            Simd::CompareFlags { reg, double } => {
                // flags = ZF (equal), CF (less), ZF|PF|CF (unordered); others clear.
                self.scalar_source(i, if double { 8 } else { 4 });
                let src = self.w.set_new_local_v128();
                self.load_xmm(reg);
                let dst = self.w.set_new_local_v128();
                // (a NaN or denormal operand raises IE or DE; ordered ones
                // leave PF clear)
                let lanes = clean_bits(double, true);
                let source = i.ea.is_none().then_some(rm);
                let known = known_clean(&self.xmm_clean, lanes, reg, source);
                if known != [true, true] {
                    native_fp::operands_refused(
                        &mut self.w,
                        double,
                        native_fp::Lanes::Scalar,
                        [&dst, &src],
                        known,
                    );
                    self.retry_if();
                }
                operand_facts(&mut self.xmm_clean, lanes, reg, source);
                self.w.const_i32(gp::flags as i32);
                self.w.load_fixed_i32(gp::flags as u32);
                self.w.const_i32(!FLAGS_ALL);
                self.w.and_i32();
                compare_flags(&mut self.w, double, &dst, &src);
                self.w.store_aligned_i32(0);
                self.w.const_i32(gp::flags_changed as i32);
                self.w.const_i32(0);
                self.w.store_aligned_i32(0);
                self.known = super::Known::None;
                self.w.free_local_v128(src);
                self.w.free_local_v128(dst);
            },
            Simd::MoveMask { reg, lane } => {
                ops::move_mask(&mut Operands { page: self, i, reg }, lane)
            },
            Simd::CompareMask {
                reg,
                double,
                scalar,
                predicate,
            } => ops::compare_mask(
                &mut Operands { page: self, i, reg },
                double,
                scalar,
                predicate,
            ),
            Simd::Blendv { reg, lane, mask } => {
                ops::blend_variable(&mut Operands { page: self, i, reg }, lane, mask)
            },
            Simd::Vzeroupper => ops::zero_upper(&mut Operands {
                page: self,
                i,
                reg: 0,
            }),
            Simd::Load256 { reg } => {
                let aligned = self.vex.is_some_and(|v| v.aligned);
                ops::load256(&mut Operands { page: self, i, reg }, aligned)
            },
            Simd::Store256 { reg } => {
                let aligned = self.vex.is_some_and(|v| v.aligned);
                ops::store256(&mut Operands { page: self, i, reg }, aligned)
            },
            Simd::Vzeroall => ops::zero_all(&mut Operands {
                page: self,
                i,
                reg: 0,
            }),
            Simd::Packed256 { op, reg } => ops::packed256(&mut Operands { page: self, i, reg }, op),
            Simd::MoveMask256 { reg, lane } => {
                ops::move_mask256(&mut Operands { page: self, i, reg }, lane)
            },
            Simd::Broadcast256 { reg, bytes } => {
                ops::broadcast(&mut Operands { page: self, i, reg }, bytes, true)
            },
        }
    }
}
/// Tier-0's operands for the x86tpl::ops templates: instruction `i` and its
/// destination `reg` in the page's block (refused instructions run
/// ir_t0_sse_fp in place; the facts are xmm_clean)
struct Operands<'p, 'i> {
    page: &'p mut Page,
    i: &'i DecodedInstruction,
    reg: u8,
}

impl VecOperands for Operands<'_, '_> {
    fn w(&mut self) -> &mut WasmBuilder { &mut self.page.w }
    fn first(&mut self) {
        let first = self.page.first(self.reg);
        self.page.load_xmm(first);
    }
    fn source(&mut self, bytes: u8, whole: bool) {
        if whole {
            self.page.scalar_source(self.i, bytes);
        }
        else {
            self.page.simd_source(self.i, false, bytes);
        }
    }
    fn register(&mut self, r: u8) { self.page.load_xmm(r) }
    fn registers(&self) -> u8 { 8 }
    fn memory(&self) -> bool { self.i.ea.is_some() }
    fn first_high(&mut self) {
        let first = self.page.first(self.reg);
        self.page.load_ymm_high(first);
    }
    fn source_high(&mut self) { self.page.load_ymm_high(self.i.modrm.unwrap_or(0) & 7) }
    fn source256(&mut self, aligned: bool) -> [WasmLocalV128; 2] {
        self.page.linear(self.i.ea.as_ref().unwrap());
        if aligned {
            self.page.retry_misaligned(32);
        }
        self.page.load_vector256()
    }
    fn store256(&mut self, low: &WasmLocalV128, high: &WasmLocalV128) {
        self.page.store_ymm(self.reg, low, high);
    }
    fn store256_rm(&mut self, halves: &[WasmLocalV128; 2], aligned: bool) {
        match &self.i.ea {
            Some(ea) => {
                self.page.linear(ea);
                if aligned {
                    self.page.retry_misaligned(32);
                }
                self.page.store_vector256(halves);
            },
            None => {
                let rm = self.i.modrm.unwrap_or(0) & 7;
                self.page.store_ymm(rm, &halves[0], &halves[1]);
            },
        }
    }
    fn zero_upper(&mut self, r: u8) { self.page.ymm_zero(r) }
    fn store_register(&mut self, r: u8, value: &WasmLocalV128) { self.page.store_xmm(r, value) }
    fn source_int(&mut self, wide: bool) {
        dbg_assert!(!wide, "Tier-0: 32-bit integers only");
        match &self.i.ea {
            Some(ea) => {
                self.page.linear(ea);
                self.page.read_mem(32, false);
            },
            None => self.page.read_reg(self.i.modrm.unwrap_or(0) & 7, 32),
        }
    }
    fn store_vec(&mut self, value: &WasmLocalV128, bytes: u8) {
        self.page.store_xmm_low(self.reg, value, bytes);
    }
    fn store_int(&mut self, wide: bool) {
        dbg_assert!(!wide, "Tier-0: 32-bit integers only");
        self.page.write_reg(self.reg, 32);
    }
    fn retry_if(&mut self) { self.page.retry_if() }
    fn mxcsr_refused(&mut self) { self.page.mxcsr_refused() }
    fn in_place(&self) -> bool { true }
    fn exact_open(
        &mut self,
        destination: &WasmLocalV128,
        source: &WasmLocalV128,
        imm8: Option<u32>,
    ) {
        self.page.w.hint(false);
        self.page.w.if_void();
        let imm8 = imm8.unwrap_or(self.i.immediate.unwrap_or(0));
        self.page.exact(self.i, destination, source, imm8);
    }
    fn exact_result(&mut self) { self.page.exact_result() }
    fn facts(&mut self) -> Option<Facts<'_>> {
        Some(Facts {
            first: self.page.first(self.reg),
            source: self.i.ea.is_none().then_some(self.i.modrm.unwrap_or(0) & 7),
            reg: self.reg,
            clean: &mut self.page.xmm_clean,
        })
    }
}

#[cfg(test)]
#[path = "../../../../tests/x86tpl/leaf_digests.rs"]
mod leaf_digests;
