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
    cpu::CR0_EM, cpu::CR0_TS, cpu::CR4_OSFXSR, cpu::CR4_OSXSAVE, cpu::FLAGS_ALL, cpu::FLAG_VM, fpu,
    global_pointers as gp,
};
use crate::ir::helper::imports::signature;
use crate::ir::{frontend::decode::DecodedInstruction, native_fp};
use crate::wasmgen::wasm_builder::{Signature, WasmBuilder, WasmLocalV128, WasmType};

/// Page::xmm_clean: lanes known to be neither NaN nor denormal, as single
/// precision (the low lane, all lanes) or double precision.
pub(super) const CLEAN_SS: u8 = 1;
pub(super) const CLEAN_PS: u8 = 2;
pub(super) const CLEAN_SD: u8 = 4;
pub(super) const CLEAN_PD: u8 = 8;

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
pub(super) enum Packed {
    /// i8x16.shuffle over (destination, source)
    Shuffle([u8; 16]),
    /// i8x16.shuffle over (destination, zero)
    ShuffleZero([u8; 16]),
    /// PSHUFB: the destination's bytes by the source's indices, masked
    /// (bit 7 selects zero)
    Swizzle(u8),
    Binary(u32),
    AndNot,
    Unpack(u8, bool),
    Pack(u32),
    /// Shift by the source's low quadword: (opcode, lane bits, arithmetic).
    Shift(u32, u32, bool),
    MulHigh(bool),
    /// PMULUDQ (false), PMULDQ (true): the even dwords' 64-bit products
    MulDwords(bool),
    Sad,
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

/// Packed integer and logic operations (Wasm SIMD opcodes).
fn packed(code: u8, mmx: bool) -> Option<Packed> {
    Some(match code {
        0xFC => Packed::Binary(0x6E),
        0xFD => Packed::Binary(0x8E),
        0xFE => Packed::Binary(0xAE),
        0xD4 => Packed::Binary(0xCE),
        0xF8 => Packed::Binary(0x71),
        0xF9 => Packed::Binary(0x91),
        0xFA => Packed::Binary(0xB1),
        0xFB => Packed::Binary(0xD1),
        0xEC => Packed::Binary(0x6F),
        0xED => Packed::Binary(0x8F),
        0xDC => Packed::Binary(0x70),
        0xDD => Packed::Binary(0x90),
        0xE8 => Packed::Binary(0x72),
        0xE9 => Packed::Binary(0x92),
        0xD8 => Packed::Binary(0x73),
        0xD9 => Packed::Binary(0x93),
        0x64 => Packed::Binary(0x27),
        0x65 => Packed::Binary(0x31),
        0x66 => Packed::Binary(0x3B),
        0x74 => Packed::Binary(0x23),
        0x75 => Packed::Binary(0x2D),
        0x76 => Packed::Binary(0x37),
        0xDA => Packed::Binary(0x77),
        0xDE => Packed::Binary(0x79),
        0xEA => Packed::Binary(0x96),
        0xEE => Packed::Binary(0x98),
        0xE0 => Packed::Binary(0x7B),
        0xE3 => Packed::Binary(0x9B),
        0xE4 => Packed::MulHigh(false),
        0xE5 => Packed::MulHigh(true),
        0xF4 => Packed::MulDwords(false),
        0xF6 => Packed::Sad,
        0xD5 => Packed::Binary(0x95),
        0xF5 => Packed::Binary(0xBA),
        0xDB => Packed::Binary(0x4E),
        0xDF => Packed::AndNot,
        0xEB => Packed::Binary(0x50),
        0xEF => Packed::Binary(0x51),
        0x60 => Packed::Unpack(1, false),
        0x61 => Packed::Unpack(2, false),
        0x62 => Packed::Unpack(4, false),
        0x68 => Packed::Unpack(1, true),
        0x69 => Packed::Unpack(2, true),
        0x6A => Packed::Unpack(4, true),
        0x6C if !mmx => Packed::Unpack(8, false),
        0x6D if !mmx => Packed::Unpack(8, true),
        0x63 => Packed::Pack(0x65),
        0x67 => Packed::Pack(0x66),
        0x6B => Packed::Pack(0x85),
        0xD1 => Packed::Shift(0x8D, 16, false),
        0xD2 => Packed::Shift(0xAD, 32, false),
        0xD3 => Packed::Shift(0xCD, 64, false),
        0xE1 => Packed::Shift(0x8C, 16, true),
        0xE2 => Packed::Shift(0xAC, 32, true),
        0xF1 => Packed::Shift(0x8B, 16, false),
        0xF2 => Packed::Shift(0xAB, 32, false),
        0xF3 => Packed::Shift(0xCB, 64, false),
        _ => return None,
    })
}

/// Shuffle lanes of PSHUFW/PSHUFD/PSHUFLW/PSHUFHW/SHUFPS/SHUFPD over
/// (first, source); `two`: the first operand is the destination, else the
/// source itself.
fn shuffle_lanes(op: u32, imm: u32) -> ([u8; 16], bool) {
    let mut lanes = [0; 16];
    for i in 0..16u32 {
        lanes[i as usize] = match op {
            0x0F70 => ((imm >> (2 * (i / 2 % 4)) & 3) * 2 + i % 2) as u8,
            0x660F70 => ((imm >> (2 * (i / 4)) & 3) * 4 + i % 4) as u8,
            0xF20F70 if i < 8 => ((imm >> (2 * (i / 2)) & 3) * 2 + i % 2) as u8,
            0xF30F70 if i >= 8 => (8 + (imm >> (2 * ((i - 8) / 2)) & 3) * 2 + i % 2) as u8,
            0x0FC6 => ((imm >> (2 * (i / 4)) & 3) * 4 + i % 4 + if i >= 8 { 16 } else { 0 }) as u8,
            0x660FC6 => ((imm >> (i / 8) & 1) * 8 + i % 8 + if i >= 8 { 16 } else { 0 }) as u8,
            _ => i as u8,
        };
    }
    (lanes, matches!(op, 0x0FC6 | 0x660FC6))
}

impl Packed {
    /// The byte lanes of a shuffle over (destination, source)
    fn lanes(self, bytes: u8) -> Option<[u8; 16]> {
        match self {
            Packed::Shuffle(lanes) => Some(lanes),
            Packed::Unpack(width, high) => {
                let mut lanes = [0; 16];
                let half = bytes / 2;
                for k in 0..bytes {
                    let element = k / (width * 2);
                    let side = k / width % 2;
                    lanes[k as usize] =
                        (if high { half } else { 0 }) + element * width + k % width + side * 16;
                }
                Some(lanes)
            },
            _ => None,
        }
    }
}

/// Page::xmm_clean of a byte shuffle of the destination's and the source's
/// lanes (`source`: None for memory), given theirs: whole lanes moved keep
/// their state
fn shuffled_clean(lanes: &[u8; 16], destination: u8, source: Option<u8>) -> u8 {
    let mut clean = 0;
    for (size, packed, scalar) in [(4, CLEAN_PS, CLEAN_SS), (8, CLEAN_PD, CLEAN_SD)] {
        let group_clean = |g: usize| {
            let first = lanes[g * size] as usize;
            if first % size != 0 || (0..size).any(|k| lanes[g * size + k] as usize != first + k) {
                return false;
            }
            let (bits, lane) = match (first < 16, source) {
                (true, _) => (destination, first / size),
                (false, Some(source)) => (source, (first - 16) / size),
                (false, None) => return false,
            };
            bits & packed != 0 || lane == 0 && bits & scalar != 0
        };
        if (0..16 / size).all(group_clean) {
            clean |= packed | scalar;
        }
        else if group_clean(0) {
            clean |= scalar;
        }
    }
    clean
}

/// PALIGNR with `imm8` on `n`-byte operands (simd_int::palignr_lanes)
fn palignr(imm8: u8, n: u32) -> Packed {
    match crate::cpu::simd_int::palignr_lanes(imm8, n as usize) {
        (lanes, true) => Packed::ShuffleZero(lanes),
        (lanes, false) => Packed::Shuffle(lanes),
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
    let blend = |size: u8, mask: u32| {
        let mut lanes = [0; 16];
        for (k, lane) in lanes.iter_mut().enumerate() {
            *lane = k as u8 + if mask >> (k as u8 / size) & 1 != 0 { 16 } else { 0 };
        }
        Packed::Shuffle(lanes)
    };
    Some(Simd::Packed {
        op: match op {
            0x660F3828 => Packed::MulDwords(true), // pmuldq
            0x660F3829 => Packed::Binary(0xD6),    // pcmpeqq: i64x2.eq
            0x660F382B => Packed::Pack(0x86),      // packusdw: i16x8.narrow_i32x4_u
            0x660F3837 => Packed::Binary(0xD9),    // pcmpgtq: i64x2.gt_s
            0x660F3838 => Packed::Binary(0x76),    // pminsb: i8x16.min_s
            0x660F3839 => Packed::Binary(0xB6),    // pminsd: i32x4.min_s
            0x660F383A => Packed::Binary(0x97),    // pminuw: i16x8.min_u
            0x660F383B => Packed::Binary(0xB7),    // pminud: i32x4.min_u
            0x660F383C => Packed::Binary(0x78),    // pmaxsb: i8x16.max_s
            0x660F383D => Packed::Binary(0xB8),    // pmaxsd: i32x4.max_s
            0x660F383E => Packed::Binary(0x99),    // pmaxuw: i16x8.max_u
            0x660F383F => Packed::Binary(0xB9),    // pmaxud: i32x4.max_u
            0x660F3840 => Packed::Binary(0xB5),    // pmulld: i32x4.mul
            0x660F3A0C => blend(4, i.immediate? & 0xF),
            0x660F3A0D => blend(8, i.immediate? & 3),
            0x660F3A0E => blend(2, i.immediate? & 0xFF),
            _ => return None,
        },
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
        0x0F70 | 0x660F70 | 0xF20F70 | 0xF30F70 | 0x0FC6 | 0x660FC6 => {
            // Packed pushes (destination, source): one-operand shuffles
            // select from the source only.
            let (mut lanes, two) = shuffle_lanes(op, i.immediate?);
            if !two {
                for lane in &mut lanes {
                    *lane += 16;
                }
            }
            Simd::Packed {
                op: Packed::Shuffle(lanes),
                reg,
                mmx: op == 0x0F70,
                source: source_bytes(op),
            }
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
            op: packed(code, prefix == 0)?,
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
    use crate::decode_rules::vex;
    if !cfg!(target_feature = "simd128") {
        return None;
    }
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
        // VBROADCASTSS xmm, m32: the source's dword in each lane
        (2, 1, 0x18) if memory => {
            let lanes = std::array::from_fn(|k| 16 + k as u8 % 4);
            (
                Simd::Packed {
                    op: Packed::Shuffle(lanes),
                    reg,
                    mmx: false,
                    source: 4,
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
        ) => (vector(packed(code, false)?), two_sources),
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
    Some(match (v.map, v.pp, key as u8) {
        // VMOVUPS VMOVUPD VMOVDQU, VMOVAPS VMOVAPD VMOVDQA (aligned)
        (1, 0 | 1, 0x10) | (1, 2, 0x6F) => (Simd::Load256 { reg }, vex(false)),
        (1, 0 | 1, 0x28) | (1, 1, 0x6F) => (Simd::Load256 { reg }, vex(true)),
        (1, 0 | 1, 0x11) | (1, 2, 0x7F) => (Simd::Store256 { reg }, vex(false)),
        (1, 0 | 1, 0x29) | (1, 1, 0x7F) => (Simd::Store256 { reg }, vex(true)),
        // VMOVNTPS VMOVNTPD VMOVNTDQ
        (1, 0 | 1, 0x2B) | (1, 1, 0xE7) if i.ea.is_some() => (Simd::Store256 { reg }, vex(true)),
        _ => return None,
    })
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
    /// MMX `r` (cpu::read_mmx64s: sync the slot from the f64 cache first).
    fn load_mmx(&mut self, r: u8) {
        let [_, _, dirty] = fpu::x87_cache_addresses();
        self.w.load_fixed_i32(dirty);
        self.w.const_i32(1 << r);
        self.w.and_i32();
        self.w.hint(false);
        self.w.if_void();
        self.w.const_i32(r as i32);
        self.w
            .call_signature("fpu_sync_slot", Signature::new(&[WasmType::I32], &[]));
        self.w.block_end();
        self.w.const_i32(gp::get_reg_mmx_offset(r as u32) as i32);
        self.w.simd_memory(0x5D, 0);
    }
    /// cpu::write_mmx_reg64 of the low quadword of `value`.
    fn store_mmx(&mut self, r: u8, value: &WasmLocalV128) {
        self.mmx_invalidate(r);
        let address = gp::get_reg_mmx_offset(r as u32);
        self.w.const_i32(address as i32);
        self.w.get_local_v128(value);
        self.w.simd_lane(0x1D, 0);
        self.w.store_unaligned_i64(0);
        self.w.const_i32(address as i32 + 8);
        self.w.const_i32(0xFFFF);
        self.w.store_unaligned_u16(0);
    }
    /// fpu_invalidate_slot(r).
    fn mmx_invalidate(&mut self, r: u8) {
        let [_, valid, dirty] = fpu::x87_cache_addresses();
        for address in [valid, dirty] {
            self.w.const_i32(address as i32);
            self.w.load_fixed_i32(address);
            self.w.const_i32(!(1 << r));
            self.w.and_i32();
            self.w.store_aligned_i32(0);
        }
    }
    /// cpu::transition_fpu_to_mmx: all tags valid, TOP 0.
    fn mmx_transition(&mut self) {
        for address in [gp::fpu_stack_empty as u32, gp::fpu_stack_ptr as u32] {
            self.w.const_i32(address as i32);
            self.w.const_i32(0);
            self.w.store_u8(0);
        }
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
            None if mmx => self.load_mmx(i.modrm.unwrap() & 7),
            None => self.load_xmm_bytes(i.modrm.unwrap() & 7, bytes),
        }
    }
    fn simd_result(&mut self, reg: u8, mmx: bool, value: &WasmLocalV128) {
        if mmx {
            self.store_mmx(reg, value);
            self.mmx_transition();
        }
        else {
            self.store_xmm(reg, value);
        }
    }
    /// The Page::xmm_clean bit of a lane format: the low lane or all lanes,
    /// single or double precision (all lanes clean implies the low lane)
    fn clean_bits(double: bool, scalar: bool) -> u8 {
        match (double, scalar) {
            (false, true) => CLEAN_SS,
            (false, false) => CLEAN_PS | CLEAN_SS,
            (true, true) => CLEAN_SD,
            (true, false) => CLEAN_PD | CLEAN_SD,
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
        let operands = crate::ir::runtime::tier0::sse_fp_operands();
        for (k, value) in [destination, source].into_iter().enumerate() {
            self.w.const_i32((operands + 16 * k as u32) as i32);
            self.w.get_local_v128(value);
            self.w.simd_memory(0x0B, 4); // v128.store
        }
        let key = match i.vex {
            Some(_) => crate::cpu::avx::legacy(i.encoding.opcode),
            None => i.encoding.opcode,
        };
        self.w.const_i32(key as i32);
        self.w.const_i32(imm8 as i32);
        self.w
            .call_signature("ir_t0_sse_fp", signature("ir_t0_sse_fp"));
        self.retry_if();
    }
    /// Push the result of exact_if's path
    fn exact_result(&mut self) {
        self.w
            .const_i32(crate::ir::runtime::tier0::sse_fp_operands() as i32);
        self.w.simd_memory(0x00, 4); // v128.load
    }

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
                self.load_mmx(reg);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(8, &v);
                    self.mmx_transition();
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
                    self.load_mmx(reg);
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
                    self.mmx_transition();
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
                    self.load_mmx(reg);
                }
                else {
                    self.load_xmm(first);
                }
                let dst = self.w.set_new_local_v128();
                self.packed(op, &dst, &src, if mmx { 8 } else { 16 });
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
                    self.load_mmx(reg);
                }
                else {
                    self.load_xmm(self.first(reg));
                }
                let dst = self.w.set_new_local_v128();
                let count = count as u32;
                if bits == 128 {
                    self.w.get_local_v128(&dst);
                    self.w.simd_zero();
                    let mut lanes = [16; 16];
                    for (k, lane) in lanes.iter_mut().enumerate() {
                        let index = if kind == 3 {
                            k as i32 + count as i32
                        }
                        else {
                            k as i32 - count as i32
                        };
                        if (0..16).contains(&index) {
                            *lane = index as u8;
                        }
                    }
                    self.w.simd_shuffle(lanes);
                }
                else if count >= bits as u32 && kind != 4 {
                    self.w.simd_zero();
                }
                else {
                    self.w.get_local_v128(&dst);
                    self.w.const_i32(count.min(bits as u32 - 1) as i32);
                    let base = match bits {
                        16 => 0x8B,
                        32 => 0xAB,
                        _ => 0xCB,
                    };
                    self.w.simd(
                        base + match kind {
                            6 => 0,
                            4 => 1,
                            _ => 2,
                        },
                    );
                }
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
            } => {
                let bytes = if !scalar {
                    16
                }
                else if double {
                    8
                }
                else {
                    4
                };
                // Scalar forms compute (and NaN-check) only the low lane.
                self.scalar_source(i, bytes);
                let src = self.w.set_new_local_v128();
                let first = self.first(reg);
                self.load_xmm(first);
                let dst = self.w.set_new_local_v128();
                let base = if double { 0xF0 } else { 0xE4 };
                match opcode {
                    0x51 => {
                        self.w.get_local_v128(&src);
                        self.w.simd(base - 1); // sqrt
                    },
                    0x52 | 0x53 => {
                        // rsqrt/rcp as the interpreter computes them: 1 / sqrt(x), 1 / x.
                        self.w.const_i32(0x3F800000);
                        self.w.simd(0x11); // i32x4.splat of 1.0f
                        self.w.get_local_v128(&src);
                        if opcode == 0x52 {
                            self.w.simd(0xE3);
                        }
                        self.w.simd(0xE7);
                    },
                    0x5D | 0x5F => {
                        // dst where dst < src (> for max), else src (NaNs, zeros).
                        self.w.get_local_v128(&dst);
                        self.w.get_local_v128(&src);
                        self.w.get_local_v128(&dst);
                        self.w.get_local_v128(&src);
                        self.w
                            .simd(if double { 0x49 } else { 0x43 } + (opcode == 0x5F) as u32);
                        self.w.simd(0x52);
                    },
                    _ => {
                        self.w.get_local_v128(&dst);
                        self.w.get_local_v128(&src);
                        self.w.simd(
                            base + match opcode {
                                0x58 => 0,
                                0x5C => 1,
                                0x59 => 2,
                                _ => 3,
                            },
                        );
                    },
                }
                let result = self.w.set_new_local_v128();
                // only where the native result is cpu::simd_fp's, MXCSR too;
                // else the exact path
                if matches!(opcode, 0x52 | 0x53) {
                    native_fp::reciprocal_refused(&mut self.w, opcode, scalar, &src, &result);
                }
                else {
                    let lanes = Self::clean_bits(double, scalar);
                    let clean = |r: u8| self.xmm_clean[r as usize] & lanes == lanes;
                    let source = i.ea.is_none().then_some(rm);
                    let known = [clean(first), source.is_some_and(clean)];
                    // a cheap first test where it saves work (zeros fail it)
                    let unsure = native_fp::arithmetic_unsure(
                        &mut self.w,
                        opcode,
                        double,
                        scalar,
                        [&dst, &src],
                        known,
                        &result,
                    );
                    if unsure {
                        // (no hint: zero-heavy data takes this path every time)
                        self.w.if_void();
                    }
                    native_fp::arithmetic_refused(
                        &mut self.w,
                        opcode,
                        double,
                        scalar,
                        [&dst, &src],
                        known,
                        &result,
                    );
                    // (facts for xmm_clean, see exact_if: a clean result or
                    // a source register found clean)
                    let claims =
                        !matches!(opcode, 0x58 | 0x5C) || source.is_some_and(|r| !clean(r));
                    if claims {
                        self.retry_if();
                    }
                    else {
                        self.exact_if(i, &dst, &src);
                        self.exact_result();
                        self.w.set_local_v128(&result);
                        self.w.block_end();
                    }
                    if unsure {
                        self.w.block_end();
                    }
                    if !matches!(opcode, 0x5D | 0x5F) {
                        // (a second exact run after refused lanes is harmless)
                        self.mxcsr_refused();
                        self.exact_if(i, &dst, &src);
                        self.exact_result();
                        self.w.set_local_v128(&result);
                        self.w.block_end();
                    }
                }
                if matches!(opcode, 0x52 | 0x53) {
                    self.exact_if(i, &dst, &src);
                    self.exact_result();
                    self.w.set_local_v128(&result);
                    self.w.block_end();
                }
                let before = self.xmm_clean[first as usize];
                self.store_xmm_low(reg, &result, bytes);
                for v in [src, dst, result] {
                    self.w.free_local_v128(v);
                }
                if !matches!(opcode, 0x52 | 0x53) {
                    // (see native_fp::arithmetic_refused)
                    let lanes = Self::clean_bits(double, scalar);
                    if let Some(source) = i.ea.is_none().then_some(rm).filter(|&r| r != reg) {
                        self.xmm_clean[source as usize] |= lanes;
                    }
                    if !matches!(opcode, 0x58 | 0x5C) {
                        // a scalar result keeps the destination's other lanes
                        self.xmm_clean[reg as usize] = lanes
                            | if scalar { before & Self::clean_bits(double, false) } else { 0 };
                    }
                }
            },
            Simd::Convert {
                opcode,
                reg,
                source,
                result,
            } => {
                self.simd_source(i, false, source);
                let x = self.w.set_new_local_v128();
                self.w.get_local_v128(&x);
                self.w.simd(opcode);
                let v = self.w.set_new_local_v128();
                // (the scalar forms CVTSS2SD and CVTSD2SS write less than 16 bytes)
                let scalar = result < 16;
                let source = i.ea.is_none().then_some(rm);
                // (a scalar form keeps the destination's upper bytes)
                if scalar {
                    self.load_xmm(self.first(reg));
                }
                else {
                    self.w.simd_zero();
                }
                let destination = self.w.set_new_local_v128();
                match opcode {
                    // f32 to f64: exact
                    0x5F => native_fp::operands_refused(
                        &mut self.w,
                        false,
                        if scalar { native_fp::Lanes::Scalar } else { native_fp::Lanes::LowPair },
                        [&x, &x],
                        [
                            source.is_some_and(|r| {
                                let lanes = Self::clean_bits(false, scalar);
                                self.xmm_clean[r as usize] & lanes == lanes
                            }),
                            true,
                        ],
                    ),
                    0x5E => native_fp::narrowing_refused(&mut self.w, scalar, &x, &v),
                    _ => self.w.const_i32(0),
                }
                // (facts for xmm_clean: a clean result, see exact_if)
                self.retry_if();
                if matches!(opcode, 0x5E | 0xFA) {
                    // (CVTDQ2PS: only PE)
                    self.mxcsr_refused();
                    self.exact_if(i, &destination, &x);
                    self.exact_result();
                    self.w.set_local_v128(&v);
                    self.w.block_end();
                }
                let before = self.xmm_clean[self.first(reg) as usize];
                self.store_xmm_low(reg, &v, result);
                for local in [v, x, destination] {
                    self.w.free_local_v128(local);
                }
                // admitted results are neither NaN nor denormal (integers
                // convert to normals or zeros)
                let double = matches!(opcode, 0x5F | 0xFE);
                let lanes = Self::clean_bits(double, scalar);
                self.xmm_clean[reg as usize] =
                    lanes | if scalar { before & Self::clean_bits(double, false) } else { 0 };
                if let (0x5F, Some(source)) = (opcode, source.filter(|&r| r != reg)) {
                    self.xmm_clean[source as usize] |= CLEAN_SS;
                }
            },
            Simd::ConvertInteger {
                reg,
                double,
                truncate,
            } => {
                self.simd_source(i, false, 16);
                let x = self.w.set_new_local_v128();
                self.w.get_local_v128(&x);
                let out_of_range = self.convert_integer(double, truncate);
                let v = self.w.set_new_local_v128();
                // a NaN or out-of-range lane raises IE; an inexact one PE
                self.w.get_local(&out_of_range);
                self.mxcsr_refused();
                self.w.or_i32();
                self.exact_if(i, &v, &x);
                self.exact_result();
                self.w.set_local_v128(&v);
                self.w.block_end();
                self.w.free_local(out_of_range);
                self.store_xmm(reg, &v);
                self.w.free_local_v128(v);
                self.w.free_local_v128(x);
            },
            Simd::ToScalar { reg, double } => {
                match &i.ea {
                    Some(ea) => {
                        self.linear(ea);
                        self.read_mem(32, false);
                    },
                    None => self.read_reg(rm, 32),
                }
                self.w.simd(0x11); // i32x4.splat
                let integer = self.w.set_new_local_v128();
                self.w.get_local_v128(&integer);
                self.w.simd(if double { 0xFE } else { 0xFA });
                let v = self.w.set_new_local_v128();
                if !double {
                    // (an inexact result sets PE)
                    self.load_xmm(self.first(reg));
                    let destination = self.w.set_new_local_v128();
                    self.mxcsr_refused();
                    self.exact_if(i, &destination, &integer);
                    self.exact_result();
                    self.w.set_local_v128(&v);
                    self.w.block_end();
                    self.w.free_local_v128(destination);
                }
                self.w.free_local_v128(integer);
                let before = self.xmm_clean[self.first(reg) as usize];
                self.store_xmm_low(reg, &v, if double { 8 } else { 4 });
                self.w.free_local_v128(v);
                self.xmm_clean[reg as usize] =
                    Self::clean_bits(double, true) | before & Self::clean_bits(double, false);
            },
            Simd::ToInteger {
                reg,
                double,
                truncate,
            } => {
                self.scalar_source(i, if double { 8 } else { 4 });
                let source = self.w.set_new_local_v128();
                self.w.get_local_v128(&source);
                if double {
                    self.w.simd_lane(0x21, 0); // f64x2.extract_lane
                }
                else {
                    self.w.simd_lane(0x1F, 0); // f32x4.extract_lane
                    self.w.promote_f32_to_f64();
                }
                let x = self.w.set_new_local_f64();
                // sse_convert(_with_truncation)_f64_to_i32: round (MXCSR.RC
                // or toward zero), then 0x80000000 outside the i32 range.
                if truncate {
                    self.w.get_local_f64(&x);
                    self.w.round_f64(3);
                }
                else {
                    // (admitted only with MXCSR.RC to nearest)
                    self.w.get_local_f64(&x);
                    self.w.round_f64(0);
                }
                self.w.set_local_f64(&x);
                // a NaN or out-of-range value raises IE; an inexact one PE
                self.w.get_local_f64(&x);
                self.w.const_f64(-2147483648.0);
                self.w.ge_f64();
                self.w.get_local_f64(&x);
                self.w.const_f64(2147483648.0);
                self.w.compare_f64(1);
                self.w.and_i32();
                self.w.eqz_i32();
                self.mxcsr_refused();
                self.w.or_i32();
                let value = self.w.declare_zeroed_local();
                self.exact_if(i, &source, &source);
                self.exact_result();
                self.w.simd_lane(0x1B, 0); // i32x4.extract_lane
                self.w.set_local(&value);
                self.w.else_();
                self.w.get_local_f64(&x);
                self.w.trunc_f64_to_i32();
                self.w.set_local(&value);
                self.w.block_end();
                self.w.get_local(&value);
                self.w.free_local(value);
                self.w.free_local_f64(x);
                self.w.free_local_v128(source);
                self.write_reg(reg, 32);
            },
            Simd::Strings { reg, op, imm8 } => {
                // (an m128 without alignment: the SDM's exception type 4 note)
                self.simd_source(i, false, 16);
                let source = self.w.set_new_local_v128();
                self.load_xmm(reg);
                let destination = self.w.set_new_local_v128();
                let operands = crate::ir::runtime::tier0::sse_fp_operands();
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
            } => {
                // Wasm's rounding of the lanes (a scalar form's low one into
                // the destination): imm8[1:0]'s mode, or MXCSR.RC's with
                // imm8[2], admitted to nearest only. Refused, to the exact
                // helper: a NaN lane (its payload; an SNaN raises IE), DAZ,
                // and an inexact lane while PE is reported (imm8[3] clear)
                // and unmasked. Denormals need no DE (ROUND has none); a
                // result is integral, never tiny. PE is set here.
                let bytes = if double { 8 } else { 4 };
                if scalar {
                    self.scalar_source(i, bytes);
                }
                else {
                    self.simd_source(i, false, 16);
                }
                let source = self.w.set_new_local_v128();
                self.load_xmm(self.first(reg));
                let destination = self.w.set_new_local_v128();
                let mode = if imm8 & 4 != 0 { 0 } else { imm8 & 3 };
                self.w.get_local_v128(&source);
                self.w.simd(match (double, mode) {
                    (false, 0) => 0x6A, // f32x4.nearest
                    (false, 1) => 0x68, // f32x4.floor
                    (false, 2) => 0x67, // f32x4.ceil
                    (false, _) => 0x69, // f32x4.trunc
                    (true, 0) => 0x94,  // f64x2.nearest
                    (true, 1) => 0x75,  // f64x2.floor
                    (true, 2) => 0x74,  // f64x2.ceil
                    (true, _) => 0x7A,  // f64x2.trunc
                });
                let rounded = self.w.set_new_local_v128();
                // per lane: a NaN (x != x), an inexact result (r != x); the
                // lanes that count: all, or the low one
                let ne = if double { 0x48 } else { 0x42 };
                let any = |w: &mut WasmBuilder, a: &WasmLocalV128, b: &WasmLocalV128| {
                    w.get_local_v128(a);
                    w.get_local_v128(b);
                    w.simd(ne);
                    if scalar {
                        w.simd_lane(0x1B, 0); // i32x4.extract_lane
                    }
                    else {
                        w.simd(0x53); // v128.any_true
                    }
                };
                any(&mut self.w, &rounded, &source);
                let inexact = self.w.set_new_local();
                self.w.load_fixed_i32(gp::mxcsr as u32);
                let mxcsr = self.w.set_new_local();
                any(&mut self.w, &source, &source);
                self.w.get_local(&mxcsr);
                self.w
                    .const_i32(0x40 | if imm8 & 4 != 0 { 0x6000 } else { 0 });
                self.w.and_i32();
                self.w.or_i32();
                if imm8 & 8 == 0 {
                    // (PE unmasked: PM, MXCSR bit 12, clear)
                    self.w.get_local(&inexact);
                    self.w.get_local(&mxcsr);
                    self.w.const_i32(0x1000);
                    self.w.and_i32();
                    self.w.eqz_i32();
                    self.w.and_i32();
                    self.w.or_i32();
                }
                let refused = self.w.set_new_local();
                if scalar {
                    self.w.get_local_v128(&rounded);
                    self.w.get_local_v128(&destination);
                    let mut lanes = [0; 16];
                    for (k, lane) in lanes.iter_mut().enumerate() {
                        *lane = if k < bytes as usize { k as u8 } else { 16 + k as u8 };
                    }
                    self.w.simd_shuffle(lanes);
                }
                else {
                    self.w.get_local_v128(&rounded);
                }
                let v = self.w.set_new_local_v128();
                if imm8 & 8 == 0 {
                    // MXCSR.PE for an inexact lane (when not refused)
                    self.w.get_local(&inexact);
                    self.w.get_local(&refused);
                    self.w.eqz_i32();
                    self.w.and_i32();
                    self.w.if_void();
                    self.w.const_i32(gp::mxcsr as i32);
                    self.w.get_local(&mxcsr);
                    self.w.const_i32(0x20);
                    self.w.or_i32();
                    self.w.store_aligned_i32(0);
                    self.w.block_end();
                }
                self.w.get_local(&refused);
                self.exact_if(i, &destination, &source);
                self.exact_result();
                self.w.set_local_v128(&v);
                self.w.block_end();
                self.store_xmm_low(reg, &v, if scalar { bytes } else { 16 });
                // (no lane facts: the exact path may produce a NaN)
                self.xmm_clean[reg as usize] = 0;
                for local in [refused, mxcsr, inexact] {
                    self.w.free_local(local);
                }
                for v128 in [v, rounded, destination, source] {
                    self.w.free_local_v128(v128);
                }
            },
            Simd::CompareFlags { reg, double } => {
                // flags = ZF (equal), CF (less), ZF|PF|CF (unordered); others clear.
                self.scalar_source(i, if double { 8 } else { 4 });
                let src = self.w.set_new_local_v128();
                self.load_xmm(reg);
                let dst = self.w.set_new_local_v128();
                // (a NaN or denormal operand raises IE or DE; ordered ones
                // leave PF clear)
                let lanes = Self::clean_bits(double, true);
                let source = i.ea.is_none().then_some(rm);
                let clean = |r: u8| self.xmm_clean[r as usize] & lanes == lanes;
                let known = [clean(reg), source.is_some_and(clean)];
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
                self.xmm_clean[reg as usize] |= lanes;
                if let Some(source) = source {
                    self.xmm_clean[source as usize] |= lanes;
                }
                let base = if double { 0x47 } else { 0x41 };
                self.w.const_i32(gp::flags as i32);
                self.w.load_fixed_i32(gp::flags as u32);
                self.w.const_i32(!FLAGS_ALL);
                self.w.and_i32();
                for (compare, flag) in [(0, 0x40), (2, 1)] {
                    self.w.get_local_v128(&dst);
                    self.w.get_local_v128(&src);
                    self.w.simd(base + compare);
                    self.w.simd_lane(0x1B, 0);
                    self.w.const_i32(flag);
                    self.w.and_i32();
                    self.w.or_i32();
                }
                self.w.store_aligned_i32(0);
                self.w.const_i32(gp::flags_changed as i32);
                self.w.const_i32(0);
                self.w.store_aligned_i32(0);
                self.known = super::Known::None;
                self.w.free_local_v128(src);
                self.w.free_local_v128(dst);
            },
            Simd::MoveMask { reg, lane } => {
                // (register forms only)
                self.load_xmm(rm);
                self.w.simd(match lane {
                    1 => 0x64, // i8x16.bitmask
                    4 => 0xA4, // i32x4.bitmask
                    _ => 0xC4, // i64x2.bitmask
                });
                self.write_reg(reg, 32);
            },
            Simd::CompareMask {
                reg,
                double,
                scalar,
                predicate,
            } => {
                let bytes = if !scalar {
                    16
                }
                else if double {
                    8
                }
                else {
                    4
                };
                self.scalar_source(i, bytes);
                let src = self.w.set_new_local_v128();
                let first = self.first(reg);
                self.load_xmm(first);
                let dst = self.w.set_new_local_v128();
                // the relation of imm8[2:0] for ordered operands: EQ, LT, LE,
                // UNORD (false), NEQ, NLT (ge), NLE (gt), ORD (true)
                match predicate & 7 {
                    3 => self.w.simd_zero(),
                    7 => {
                        self.w.const_i32(-1);
                        self.w.simd(0x11); // i32x4.splat
                    },
                    relation => {
                        self.w.get_local_v128(&dst);
                        self.w.get_local_v128(&src);
                        // (f32x4/f64x2: eq ne lt gt le ge)
                        let offset = [0, 2, 4, 0, 1, 5, 3][relation as usize];
                        self.w.simd(if double { 0x47 } else { 0x41 } + offset);
                    },
                }
                let result = self.w.set_new_local_v128();
                let lanes = Self::clean_bits(double, scalar);
                let source = i.ea.is_none().then_some(rm);
                let clean = |r: u8| self.xmm_clean[r as usize] & lanes == lanes;
                let known = [clean(first), source.is_some_and(clean)];
                if known != [true, true] {
                    // a NaN or denormal operand raises IE or DE, and a NaN
                    // makes them unordered
                    native_fp::operands_refused(
                        &mut self.w,
                        double,
                        if scalar { native_fp::Lanes::Scalar } else { native_fp::Lanes::Packed },
                        [&dst, &src],
                        known,
                    );
                    self.w.hint(false);
                    self.w.if_void();
                    self.exact(i, &dst, &src, predicate as u32);
                    self.exact_result();
                    self.w.set_local_v128(&result);
                    self.w.block_end();
                }
                self.store_xmm_low(reg, &result, bytes);
                for v in [src, dst, result] {
                    self.w.free_local_v128(v);
                }
            },
            Simd::Blendv { reg, lane, mask } => {
                self.simd_source(i, false, 16);
                let src = self.w.set_new_local_v128();
                self.load_xmm(self.first(reg));
                let dst = self.w.set_new_local_v128();
                // the source's lanes where the mask's lane is negative
                self.w.get_local_v128(&src);
                self.w.get_local_v128(&dst);
                self.load_xmm(mask);
                self.w.const_i32(lane as i32 * 8 - 1);
                self.w.simd(match lane {
                    1 => 0x6C, // i8x16.shr_s
                    4 => 0xAC, // i32x4.shr_s
                    _ => 0xCC, // i64x2.shr_s
                });
                self.w.simd(0x52); // v128.bitselect
                let result = self.w.set_new_local_v128();
                self.store_xmm(reg, &result);
                for v in [src, dst, result] {
                    self.w.free_local_v128(v);
                }
            },
            Simd::Vzeroupper => {
                for r in 0..8 {
                    self.ymm_zero(r);
                }
            },
            Simd::Load256 { reg } => {
                // (both halves read before the destination is written)
                let halves = match &i.ea {
                    Some(ea) => {
                        self.linear(ea);
                        if self.vex.is_some_and(|v| v.aligned) {
                            self.retry_misaligned(32);
                        }
                        self.load_vector256()
                    },
                    None => {
                        self.load_xmm(rm);
                        let low = self.w.set_new_local_v128();
                        self.load_ymm_high(rm);
                        [low, self.w.set_new_local_v128()]
                    },
                };
                self.store_ymm(reg, &halves[0], &halves[1]);
                if i.ea.is_none() {
                    self.xmm_clean[reg as usize] = self.xmm_clean[rm as usize];
                }
                for v in halves {
                    self.w.free_local_v128(v);
                }
            },
            Simd::Store256 { reg } => {
                self.load_xmm(reg);
                let low = self.w.set_new_local_v128();
                self.load_ymm_high(reg);
                let halves = [low, self.w.set_new_local_v128()];
                match &i.ea {
                    Some(ea) => {
                        self.linear(ea);
                        if self.vex.is_some_and(|v| v.aligned) {
                            self.retry_misaligned(32);
                        }
                        self.store_vector256(&halves);
                    },
                    None => {
                        self.store_ymm(rm, &halves[0], &halves[1]);
                        self.xmm_clean[rm as usize] = self.xmm_clean[reg as usize];
                    },
                }
                for v in halves {
                    self.w.free_local_v128(v);
                }
            },
            Simd::Vzeroall => {
                self.w.simd_zero();
                let zero = self.w.set_new_local_v128();
                for r in 0..8 {
                    self.store_xmm(r, &zero);
                }
                self.w.free_local_v128(zero);
            },
        }
    }

    /// Push op(dst, src) on `bytes`-wide registers (8: MMX, low quadword).
    fn packed(&mut self, op: Packed, dst: &WasmLocalV128, src: &WasmLocalV128, bytes: u8) {
        let w = &mut self.w;
        match op {
            Packed::ShuffleZero(lanes) => {
                w.get_local_v128(dst);
                w.simd_zero();
                w.simd_shuffle(lanes);
            },
            Packed::Swizzle(mask) => {
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.const_i32(mask as i32);
                w.simd(0x0F); // i8x16.splat
                w.simd(0x4E); // v128.and
                w.simd(0x0E); // i8x16.swizzle
            },
            Packed::MulHigh(signed) => {
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(if signed { 0xBC } else { 0xBE });
                if bytes == 16 {
                    w.get_local_v128(dst);
                    w.get_local_v128(src);
                    w.simd(if signed { 0xBD } else { 0xBF });
                }
                else {
                    w.simd_zero();
                }
                w.simd_shuffle([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]);
            },
            Packed::MulDwords(signed) => {
                for v in [dst, src] {
                    w.get_local_v128(v);
                    w.simd_zero();
                    w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
                }
                // i64x2.extmul_low_i32x4_s/u
                w.simd(if signed { 0xDC } else { 0xDE });
            },
            Packed::Sad => {
                // |dst - src| per byte, summed per quadword.
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(0x79);
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(0x77);
                w.simd(0x71);
                w.simd(0x7D);
                w.simd(0x7F);
                let sums = w.set_new_local_v128();
                w.get_local_v128(&sums);
                w.get_local_v128(&sums);
                w.get_local_v128(&sums);
                w.simd_shuffle([4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11]);
                w.simd(0xAE);
                w.simd_zero();
                w.simd_shuffle([0, 1, 2, 3, 16, 17, 18, 19, 8, 9, 10, 11, 16, 17, 18, 19]);
                w.free_local_v128(sums);
            },
            Packed::Shift(opcode, bits, arithmetic) => {
                w.get_local_v128(src);
                w.simd_lane(0x1D, 0);
                let count = w.set_new_local_i64();
                w.get_local_i64(&count);
                w.const_i64((bits - 1) as i64);
                w.gtu_i64();
                w.if_v128();
                if arithmetic {
                    w.get_local_v128(dst);
                    w.const_i32((bits - 1) as i32);
                    w.simd(opcode);
                }
                else {
                    w.simd_zero();
                }
                w.else_();
                w.get_local_v128(dst);
                w.get_local_i64(&count);
                w.wrap_i64_to_i32();
                w.simd(opcode);
                w.block_end();
                w.free_local_i64(count);
            },
            _ => {
                if let Packed::AndNot = op {
                    w.get_local_v128(src);
                    w.get_local_v128(dst);
                }
                else {
                    w.get_local_v128(dst);
                    w.get_local_v128(src);
                }
                match op {
                    Packed::Shuffle(lanes) => w.simd_shuffle(lanes),
                    Packed::Binary(opcode) => w.simd(opcode),
                    Packed::AndNot => w.simd(0x4F),
                    Packed::Pack(opcode) => {
                        w.simd(opcode);
                        if bytes == 8 {
                            w.simd_zero();
                            w.simd_shuffle([
                                0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23,
                            ]);
                        }
                    },
                    Packed::Unpack(..) => w.simd_shuffle(op.lanes(bytes).unwrap()),
                    _ => unreachable!(),
                }
            },
        }
    }

    /// CVT(T)PS2DQ/CVT(T)PD2DQ of the vector on the stack, rounded to nearest
    /// (or truncated): push the integer vector and return an i32 local,
    /// nonzero if a lane was out of the i32 range (or NaN)
    fn convert_integer(
        &mut self,
        double: bool,
        truncate: bool,
    ) -> crate::wasmgen::wasm_builder::WasmLocal {
        let w = &mut self.w;
        let input = w.set_new_local_v128();
        if truncate {
            w.get_local_v128(&input);
            w.simd(if double { 0x7A } else { 0x69 });
        }
        else {
            // (admitted only with MXCSR.RC to nearest)
            w.get_local_v128(&input);
            w.simd(if double { 0x94 } else { 0x6A }); // nearest
        }
        let rounded = w.set_new_local_v128();
        w.get_local_v128(&rounded);
        if double {
            w.const_i64(0xC1E0000000000000u64 as i64);
            w.simd(0x12);
        }
        else {
            w.const_i32(0xCF000000u32 as i32);
            w.simd(0x11);
        }
        w.simd(if double { 0x4C } else { 0x46 });
        w.get_local_v128(&rounded);
        if double {
            w.const_i64(0x41E0000000000000);
            w.simd(0x12);
        }
        else {
            w.const_i32(0x4F000000);
            w.simd(0x11);
        }
        w.simd(if double { 0x49 } else { 0x43 });
        w.simd(0x4E);
        if double {
            w.simd_zero();
            w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
        }
        let valid = w.set_new_local_v128();
        // (the lanes that exist: 0 and 1 for double precision)
        w.get_local_v128(&valid);
        w.simd(0xA4); // i32x4.bitmask
        w.const_i32(if double { 3 } else { 15 });
        w.and_i32();
        w.const_i32(if double { 3 } else { 15 });
        w.ne_i32();
        let out_of_range = w.set_new_local();
        w.get_local_v128(&rounded);
        w.simd(if double { 0xFC } else { 0xF8 });
        w.const_i32(i32::MIN);
        w.simd(0x11);
        w.get_local_v128(&valid);
        w.simd(0x52);
        if double {
            w.simd_zero();
            w.simd_shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
        }
        w.free_local_v128(input);
        w.free_local_v128(rounded);
        w.free_local_v128(valid);
        out_of_range
    }
}
