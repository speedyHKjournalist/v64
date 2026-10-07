//! AVX: the VEX-encoded SIMD instructions (docs/simd-xsave-plan.md, P5-P6).
//! One executor serves the 32-bit interpreter (crate::cpu::vex), the IR's
//! helper (crate::ir::runtime::avx) and the x64 engine (crate::x64::vector).
//! An engine decodes the instruction (decode_rules::vex_row: the row exists,
//! has its semantics and accepts the VEX fields), calls `check` once all of
//! its bytes are fetched and before its operand's segment is checked, then
//! `execute`, which reaches memory, the general-purpose registers, FLAGS and
//! exception delivery through the engine's `Machine`. The XMM registers, the
//! upper halves of the YMM registers, MXCSR, CR0, CR4 and XCR0 are the same
//! state in every engine.
//!
//! The semantics are the legacy forms' (crate::ir::simd, simd_int, simd_fp)
//! with VEX's operands: VEX.vvvv is the first source, a VEX.128 form zeroes
//! bits 255:128 of its destination register (VMOVSS/VMOVSD between registers
//! too), and every input is read before the destination is written, so any of
//! the operands may be the same register.
use crate::cpu::cpu::{self, reg128, CR0_TS, CR4_OSXSAVE, MXCSR_MASK};
use crate::cpu::global_pointers as gp;
use crate::cpu::{simd_fp, simd_int};
use crate::ir::simd::{PackedOp, ShuffleOp, TransferOp};

/// A decoded VEX instruction
#[derive(Clone, Copy, Debug)]
pub struct Instruction {
    /// The row's catalogue key 0xC4_MM_PP_OO (decode_rules::Vex::key)
    pub key: u32,
    /// ModRM.reg (with VEX.R): a register, or a group's opcode extension
    pub reg: u8,
    /// VEX.vvvv: a register, or 0 for a form without that operand
    pub vvvv: u8,
    /// ModRM.rm (with VEX.B) of a register form; None: the memory operand
    pub rm: Option<u8>,
    pub l: bool,
    pub w: bool,
    pub imm8: u8,
    /// 64-bit mode: XMM8-XMM15, and the 64-bit general-purpose operands of
    /// the VEX.W1 forms
    pub long: bool,
}

/// An exception the executor raises
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exception {
    /// #UD
    InvalidOpcode,
    /// #NM
    DeviceNotAvailable,
    /// #GP(0)
    GeneralProtection,
    /// An unmasked SIMD floating-point exception: #XM, or #UD without
    /// CR4.OSXMMEXCPT
    SimdFloatingPoint,
}

/// An engine's side of an instruction
pub trait Machine {
    /// An exception that ends the instruction (the interpreter delivers it
    /// when raised)
    type Fault;
    unsafe fn raise(&mut self, e: Exception) -> Self::Fault;
    /// `bytes` (1, 2, 4, 8 or 16) of the memory operand, zero-extended;
    /// `aligned`: #GP(0) unless the operand is aligned to 16 bytes
    unsafe fn read(&mut self, bytes: u8, aligned: bool) -> Result<u128, Self::Fault>;
    /// The low `bytes` of `value` to the memory operand
    unsafe fn write(&mut self, bytes: u8, value: u128, aligned: bool) -> Result<(), Self::Fault>;
    /// VMASKMOVDQU: the bytes of `value` whose bit in `mask` is set, to
    /// (E/R)DI in DS or the segment prefix's
    unsafe fn write_masked(&mut self, value: u128, mask: u16) -> Result<(), Self::Fault>;
    unsafe fn gpr(&mut self, r: u8) -> u64;
    /// The low 32 bits of `value` (zero-extended in 64-bit mode), or all 64
    /// with `wide`
    unsafe fn set_gpr(&mut self, r: u8, value: u64, wide: bool);
    /// OF, SF, ZF, AF, PF and CF to those of `flags`
    unsafe fn set_flags(&mut self, flags: u32);
}

/// The exceptions of every AVX instruction before its operands (SDM vol. 2,
/// 2.8, the exception types of VEX-encoded forms): #UD unless the operating
/// system enabled the AVX state (CR4.OSXSAVE and XCR0[2:1] = 11b), then #NM
/// with CR0.TS. Unlike legacy SSE, CR0.EM and CR4.OSFXSR do not matter.
pub unsafe fn check<M: Machine>(m: &mut M) -> Result<(), M::Fault> {
    if *gp::cr.add(4) & CR4_OSXSAVE == 0 || *gp::xcr0 & 6 != 6 {
        return Err(m.raise(Exception::InvalidOpcode));
    }
    if *gp::cr & CR0_TS != 0 {
        return Err(m.raise(Exception::DeviceNotAvailable));
    }
    Ok(())
}

/// The catalogue key of the legacy form whose semantics a VEX form has: 66
/// 0F 58 for VEX.66.0F 58, 66 0F 38 00 for VEX.66.0F38 00
pub fn legacy(key: u32) -> u32 {
    let prefix = [0, 0x66, 0xF3, 0xF2][(key >> 8 & 3) as usize];
    let op = key & 0xFF;
    match key >> 16 & 0xFF {
        1 => prefix << 16 | 0x0F00 | op,
        2 => prefix << 24 | 0x0F3800 | op,
        _ => prefix << 24 | 0x0F3A00 | op,
    }
}

unsafe fn xmm(r: u8) -> u128 { cpu::read_xmm128s(r as i32).bits() }
/// A VEX.128 destination register: bits 255:128 zeroed
unsafe fn set_xmm(r: u8, value: u128) {
    cpu::write_xmm_reg128(r as i32, reg128::of_bits(value));
    *gp::ymm_hi.add(r as usize) = reg128::of_bits(0);
}
/// The r/m operand: a register, or `bytes` of memory
unsafe fn source<M: Machine>(
    m: &mut M,
    i: &Instruction,
    bytes: u8,
    aligned: bool,
) -> Result<u128, M::Fault> {
    match i.rm {
        Some(r) => Ok(xmm(r)),
        None => m.read(bytes, aligned),
    }
}
fn packed(op: PackedOp, a: u128, b: u128) -> u128 {
    u128::from_le_bytes(op.apply(a.to_le_bytes(), b.to_le_bytes()))
}
/// A function of byte vectors on 128-bit values
fn bytes(f: impl FnOnce([u8; 16]) -> [u8; 16], v: u128) -> u128 {
    u128::from_le_bytes(f(v.to_le_bytes()))
}
/// The low `bytes` bytes
fn low(bytes: u32) -> u128 { u128::MAX >> (128 - 8 * bytes) }
/// The sign bits of `v`'s lanes of `lane` bytes
fn sign_mask(v: u128, lane: u32) -> u64 {
    (0..16 / lane).fold(0, |mask, n| {
        mask | ((v >> (n * lane * 8 + lane * 8 - 1)) as u64 & 1) << n
    })
}

/// Execute `i` (after `check`)
pub unsafe fn execute<M: Machine>(m: &mut M, i: &Instruction) -> Result<(), M::Fault> {
    const LOW: u128 = u64::MAX as u128;
    let (map, pp, op) = (i.key >> 16 & 0xFF, i.key >> 8 & 3, i.key as u8);
    // (the general-purpose operands of VEX.W1 forms, in 64-bit mode)
    let wide = i.long && i.w;
    // VMOVSS and VMOVSD: the bytes of the scalar and its lanes' mask
    let scalar = if pp == 2 { (4, 0xFFFF_FFFF) } else { (8, LOW) };
    match (map, pp, op) {
        // VMOVUPS, VMOVUPD, VMOVAPS, VMOVAPD, VMOVDQA, VMOVDQU, VLDDQU and
        // VMOVNTDQA, the aligned ones #GP(0) otherwise
        (1, 0 | 1, 0x10 | 0x28) | (1, 1 | 2, 0x6F) | (1, 3, 0xF0) | (2, 1, 0x2A) => {
            let aligned = matches!(op, 0x28 | 0x2A) || op == 0x6F && pp == 1;
            let v = source(m, i, 16, aligned)?;
            set_xmm(i.reg, v);
        },
        // their stores, and VMOVNTPS, VMOVNTPD, VMOVNTDQ
        (1, 0 | 1, 0x11 | 0x29 | 0x2B) | (1, 1 | 2, 0x7F) | (1, 1, 0xE7) => {
            let aligned = matches!(op, 0x29 | 0x2B | 0xE7) || op == 0x7F && pp == 1;
            let v = xmm(i.reg);
            match i.rm {
                Some(r) => set_xmm(r, v),
                None => m.write(16, v, aligned)?,
            }
        },
        // VMOVSS, VMOVSD: from memory zero-extended; between registers the
        // other lanes from the first source
        (1, 2 | 3, 0x10) => {
            let v = match i.rm {
                Some(r) => xmm(i.vvvv) & !scalar.1 | xmm(r) & scalar.1,
                None => m.read(scalar.0, false)?,
            };
            set_xmm(i.reg, v);
        },
        (1, 2 | 3, 0x11) => match i.rm {
            Some(r) => set_xmm(r, xmm(i.vvvv) & !scalar.1 | xmm(i.reg) & scalar.1),
            None => m.write(scalar.0, xmm(i.reg) & scalar.1, false)?,
        },
        // VMOVHLPS, VMOVLPS, VMOVLPD: the low quadword from the source's
        // high one or memory, the high one from the first source
        (1, 0 | 1, 0x12) => {
            let low = match i.rm {
                Some(r) => xmm(r) >> 64,
                None => m.read(8, false)?,
            };
            set_xmm(i.reg, xmm(i.vvvv) & !LOW | low);
        },
        // VMOVLHPS, VMOVHPS, VMOVHPD: the high quadword from the source's
        // low one or memory, the low one from the first source
        (1, 0 | 1, 0x16) => {
            let high = match i.rm {
                Some(r) => xmm(r) & LOW,
                None => m.read(8, false)?,
            };
            set_xmm(i.reg, xmm(i.vvvv) & LOW | high << 64);
        },
        // VMOVLPS, VMOVLPD, VMOVHPS, VMOVHPD m64, xmm
        (1, 0 | 1, 0x13) => m.write(8, xmm(i.reg) & LOW, false)?,
        (1, 0 | 1, 0x17) => m.write(8, xmm(i.reg) >> 64, false)?,
        // VMOVSLDUP, VMOVSHDUP, VMOVDDUP (from 64 bits of memory)
        (1, 2, 0x12 | 0x16) | (1, 3, 0x12) => {
            let v = source(m, i, if pp == 3 { 8 } else { 16 }, false)?;
            let t = TransferOp::from_encoding(legacy(i.key)).unwrap();
            set_xmm(
                i.reg,
                u128::from_le_bytes(t.apply([0; 16], v.to_le_bytes())),
            );
        },
        // VUNPCKLPS, VUNPCKLPD, VUNPCKHPS, VUNPCKHPD; VANDPS, VANDPD,
        // VANDNPS, VANDNPD, VORPS, VORPD, VXORPS, VXORPD; the packed integer
        // operations of 66 0F: unpacks, packs, compares, shifts by xmm/m128
        // (the count in its low quadword), arithmetic and logic
        (1, 0 | 1, 0x14 | 0x15 | 0x54..=0x57)
        | (
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
        ) => {
            let b = source(m, i, 16, false)?;
            let p = PackedOp::from_encoding(legacy(i.key)).unwrap();
            set_xmm(i.reg, packed(p, xmm(i.vvvv), b));
        },
        // VPSRLW/VPSRAW/VPSLLW, VPSRLD/VPSRAD/VPSLLD, VPSRLQ/VPSRLDQ/VPSLLQ/
        // VPSLLDQ by imm8: VEX.vvvv is the destination, the r/m register the
        // source
        (1, 1, 0x71..=0x73) => {
            let (v, count) = (xmm(i.rm.unwrap()), i.imm8 as u32);
            let r = match (op, i.reg & 7) {
                (0x73, 3) => {
                    if count < 16 {
                        v >> (8 * count)
                    }
                    else {
                        0
                    }
                },
                (0x73, 7) => {
                    if count < 16 {
                        v << (8 * count)
                    }
                    else {
                        0
                    }
                },
                (_, group) => {
                    let id = [0xD1, 0xE1, 0xF1][(group / 2 - 1) as usize] + (op as u32 - 0x71);
                    packed(PackedOp::from_id(id).unwrap(), v, count as u128)
                },
            };
            set_xmm(i.vvvv, r);
        },
        // VSQRT, VADD, VMUL, VSUB, VMIN, VDIV, VMAX PS/PD/SS/SD, VHADDPS/PD,
        // VHSUBPS/PD, VADDSUBPS/PD; VCMP* with 32 predicates: a scalar
        // form's other lanes from the first source (VSQRTPS/PD: one source)
        (1, 0..=3, 0x51 | 0x58 | 0x59 | 0x5C..=0x5F | 0xC2) | (1, 1 | 3, 0x7C | 0x7D | 0xD0) => {
            let scalar = pp >= 2 && !matches!(op, 0x7C | 0x7D | 0xD0);
            let bytes = match (scalar, pp) {
                (false, _) => 16,
                (true, 2) => 4,
                _ => 8,
            };
            let b = source(m, i, bytes, false)?;
            let r = if op == 0xC2 {
                simd_fp::compare(legacy(i.key), xmm(i.vvvv), b, i.imm8)
            }
            else {
                simd_fp::arithmetic(legacy(i.key), xmm(i.vvvv), b, 0)
            };
            let r = r.map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VRSQRTPS/SS, VRCPPS/SS: no exceptions
        (1, 0 | 2, 0x52 | 0x53) => {
            let b = source(m, i, if pp == 2 { 4 } else { 16 }, false)?;
            set_xmm(i.reg, simd_fp::reciprocal(legacy(i.key), xmm(i.vvvv), b));
        },
        // VUCOMISS/SD, VCOMISS/SD: ZF, PF and CF
        (1, 0 | 1, 0x2E | 0x2F) => {
            let b = source(m, i, if pp == 0 { 4 } else { 8 }, false)?;
            let flags = simd_fp::compare_flags(legacy(i.key), xmm(i.reg), b)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            m.set_flags(flags);
        },
        // VCVTSI2SS/SD: from a general-purpose register or memory (64 bits
        // with VEX.W1 in 64-bit mode) into the first source's low lane
        (1, 2 | 3, 0x2A) => {
            let value = match i.rm {
                Some(r) => m.gpr(r),
                None => m.read(if wide { 8 } else { 4 }, false)? as u64,
            };
            let value = if wide { value } else { value & 0xFFFF_FFFF };
            let r = simd_fp::convert(legacy(i.key), wide, xmm(i.vvvv), value as u128)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VCVTSS2SI, VCVTTSS2SI, VCVTSD2SI, VCVTTSD2SI: to a general-purpose
        // register (64-bit with VEX.W1 in 64-bit mode)
        (1, 2 | 3, 0x2C | 0x2D) => {
            let b = source(m, i, if pp == 2 { 4 } else { 8 }, false)?;
            let r = simd_fp::convert(legacy(i.key), wide, 0, b)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            m.set_gpr(i.reg, r as u64, wide);
        },
        // VCVTPS2PD (m64), VCVTPD2PS, VCVTSS2SD (m32), VCVTSD2SS (m64);
        // VCVTDQ2PS, VCVTPS2DQ, VCVTTPS2DQ; VCVTTPD2DQ, VCVTDQ2PD (m64),
        // VCVTPD2DQ: a scalar form's other lanes from the first source
        (1, 0..=3, 0x5A) | (1, 0..=2, 0x5B) | (1, 1..=3, 0xE6) => {
            let bytes = match (op, pp) {
                (0x5A, 0) | (0x5A, 3) | (0xE6, 2) => 8,
                (0x5A, 2) => 4,
                _ => 16,
            };
            let b = source(m, i, bytes, false)?;
            let r = simd_fp::convert(legacy(i.key), false, xmm(i.vvvv), b)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VROUNDPS/PD (one source), VROUNDSS/SD
        (3, 1, 0x08..=0x0B) => {
            let b = source(m, i, [16, 16, 4, 8][(op - 8) as usize], false)?;
            let r = simd_fp::round(legacy(i.key), xmm(i.vvvv), b, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VDPPS, VDPPD
        (3, 1, 0x40 | 0x41) => {
            let b = source(m, i, 16, false)?;
            let r = simd_fp::dot_product(op == 0x41, xmm(i.vvvv), b, i.imm8)
                .map_err(|_| m.raise(Exception::SimdFloatingPoint))?;
            set_xmm(i.reg, r);
        },
        // VBLENDVPS, VBLENDVPD: the mask register is imm8[7:4] (bit 7
        // ignored outside 64-bit mode)
        (3, 1, 0x4A | 0x4B) => {
            let b = source(m, i, 16, false)?;
            let selector = xmm(i.imm8 >> 4 & if i.long { 15 } else { 7 }).to_le_bytes();
            let a = xmm(i.vvvv).to_le_bytes();
            let legacy = if op == 0x4A { 0x14 } else { 0x15 };
            set_xmm(i.reg, bytes(|b| simd_int::sse4(legacy, a, b, selector), b));
        },
        // VSHUFPS, VSHUFPD: the low lanes from the first source, the high
        // ones from the second, as imm8 selects
        (1, 0 | 1, 0xC6) => {
            let b = source(m, i, 16, false)?;
            let shuffle = ShuffleOp::from_encoding(legacy(i.key)).unwrap();
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| shuffle.apply(a, b, i.imm8), b));
        },
        // VPSHUFD, VPSHUFHW, VPSHUFLW: the source's lanes as imm8 selects
        (1, 1..=3, 0x70) => {
            let v = source(m, i, 16, false)?;
            let shuffle = ShuffleOp::from_encoding(legacy(i.key)).unwrap();
            set_xmm(i.reg, bytes(|v| shuffle.apply([0; 16], v, i.imm8), v));
        },
        // VPINSRW: a general-purpose register's low word or an m16 into the
        // first source's word imm8[2:0]
        (1, 1, 0xC4) => {
            let value = match i.rm {
                Some(r) => m.gpr(r) as u128 & 0xFFFF,
                None => m.read(2, false)?,
            };
            let at = (i.imm8 as u32 & 7) * 16;
            set_xmm(i.reg, xmm(i.vvvv) & !(0xFFFF << at) | value << at);
        },
        // VPEXTRW (C5): word imm8[2:0] to a general-purpose register
        (1, 1, 0xC5) => {
            let v = xmm(i.rm.unwrap()) >> ((i.imm8 as u32 & 7) * 16) & 0xFFFF;
            m.set_gpr(i.reg, v as u64, wide);
        },
        // SSSE3: VPSHUFB, VPHADDW/D/SW, VPMADDUBSW, VPHSUBW/D/SW,
        // VPSIGNB/W/D, VPMULHRSW; VPABSB/W/D (of the source alone)
        (2, 1, 0x00..=0x0B | 0x1C..=0x1E) => {
            let b = source(m, i, 16, false)?;
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::ssse3(op, a, b), b));
        },
        // VPTEST: ZF and CF
        (2, 1, 0x17) => {
            let b = source(m, i, 16, false)?;
            let (zf, cf) = simd_int::ptest(xmm(i.reg).to_le_bytes(), b.to_le_bytes());
            m.set_flags((zf as u32) << 6 | cf as u32);
        },
        // VPMOVSX*, VPMOVZX*: the source's low lanes extended (from memory,
        // those bytes only)
        (2, 1, 0x20..=0x25 | 0x30..=0x35) => {
            let b = source(m, i, [8, 4, 2, 8, 4, 8][(op & 7) as usize], false)?;
            set_xmm(i.reg, bytes(|b| simd_int::sse4(op, [0; 16], b, [0; 16]), b));
        },
        // VPMULDQ, VPCMPEQQ, VPACKUSDW, VPCMPGTQ, VPMINSB/SD/UW/UD,
        // VPMAXSB/SD/UW/UD, VPMULLD; VPHMINPOSUW (of the source alone)
        (2, 1, 0x28 | 0x29 | 0x2B | 0x37..=0x41) => {
            let b = source(m, i, 16, false)?;
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::sse4(op, a, b, [0; 16]), b));
        },
        // VBLENDPS, VBLENDPD, VPBLENDW, VMPSADBW
        (3, 1, 0x0C..=0x0E | 0x42) => {
            let b = source(m, i, 16, false)?;
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::sse4_imm(op, a, b, i.imm8), b));
        },
        // VPALIGNR
        (3, 1, 0x0F) => {
            let b = source(m, i, 16, false)?;
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::palignr(a, b, i.imm8), b));
        },
        // VPEXTRB, VPEXTRW, VPEXTRD/VPEXTRQ, VEXTRACTPS: an element to a
        // general-purpose register (zero-extended) or memory
        (3, 1, 0x14..=0x17) => {
            let size = match op {
                0x14 => 1,
                0x15 => 2,
                0x16 if wide => 8,
                _ => 4,
            };
            let v = xmm(i.reg) >> ((i.imm8 as u32 & (16 / size - 1)) * size * 8) & low(size);
            match i.rm {
                Some(r) => m.set_gpr(r, v as u64, wide),
                None => m.write(size as u8, v, false)?,
            }
        },
        // VPINSRB, VPINSRD/VPINSRQ: a general-purpose register's low bytes or
        // memory into the first source's element imm8
        (3, 1, 0x20 | 0x22) => {
            let size = if op == 0x20 {
                1
            }
            else if wide {
                8
            }
            else {
                4
            };
            let value = match i.rm {
                Some(r) => m.gpr(r) as u128 & low(size),
                None => m.read(size as u8, false)?,
            };
            let at = (i.imm8 as u32 & (16 / size - 1)) * size * 8;
            set_xmm(i.reg, xmm(i.vvvv) & !(low(size) << at) | value << at);
        },
        // VINSERTPS: the source register's dword imm8[7:6], or the m32
        (3, 1, 0x21) => {
            let value = match i.rm {
                Some(r) => (xmm(r) >> ((i.imm8 >> 6) * 32)) as u32,
                None => m.read(4, false)? as u32,
            };
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(
                i.reg,
                u128::from_le_bytes(simd_int::insertps(a, value, i.imm8)),
            );
        },
        // VPBLENDVB: the mask register is imm8[7:4] (bit 7 ignored outside
        // 64-bit mode)
        (3, 1, 0x4C) => {
            let b = source(m, i, 16, false)?;
            let selector = xmm(i.imm8 >> 4 & if i.long { 15 } else { 7 }).to_le_bytes();
            let a = xmm(i.vvvv).to_le_bytes();
            set_xmm(i.reg, bytes(|b| simd_int::sse4(0x10, a, b, selector), b));
        },
        // VPCMPESTRM, VPCMPESTRI, VPCMPISTRM, VPCMPISTRI: the explicit
        // lengths in EAX and EDX (RAX and RDX with VEX.W1 in 64-bit mode); the
        // index to ECX (zero-extended) or the mask to XMM0
        (3, 1, 0x60..=0x63) => {
            let b = source(m, i, 16, false)?;
            let length = |m: &mut M, r| {
                let v = m.gpr(r);
                if wide {
                    v as i64
                }
                else {
                    v as i32 as i64
                }
            };
            let (la, lb) =
                if op < 0x62 { (Some(length(m, 0)), Some(length(m, 2))) } else { (None, None) };
            let r = simd_int::compare_strings(
                i.imm8,
                xmm(i.reg).to_le_bytes(),
                b.to_le_bytes(),
                la,
                lb,
            );
            if op & 1 != 0 {
                m.set_gpr(1, r.index as u64, false);
            }
            else {
                set_xmm(0, u128::from_le_bytes(r.xmm0));
            }
            m.set_flags(r.flags as u32);
        },
        // VMOVMSKPS, VMOVMSKPD, VPMOVMSKB: the lanes' sign bits
        (1, 0 | 1, 0x50) | (1, 1, 0xD7) => {
            let lane = if op == 0xD7 {
                1
            }
            else if pp == 0 {
                4
            }
            else {
                8
            };
            let mask = sign_mask(xmm(i.rm.unwrap()), lane);
            m.set_gpr(i.reg, mask, wide);
        },
        // VMOVD, VMOVQ xmm, r/m32 or r/m64: zero-extended
        (1, 1, 0x6E) => {
            let v = match i.rm {
                Some(r) => m.gpr(r) & if wide { u64::MAX } else { 0xFFFF_FFFF },
                None => m.read(if wide { 8 } else { 4 }, false)? as u64,
            };
            set_xmm(i.reg, v as u128);
        },
        // VMOVD, VMOVQ r/m32 or r/m64, xmm
        (1, 1, 0x7E) => {
            let v = xmm(i.reg) as u64 & if wide { u64::MAX } else { 0xFFFF_FFFF };
            match i.rm {
                Some(r) => m.set_gpr(r, v, wide),
                None => m.write(if wide { 8 } else { 4 }, v as u128, false)?,
            }
        },
        // VMOVQ xmm, xmm/m64 and xmm/m64, xmm: the low quadword, zero-extended
        (1, 2, 0x7E) => {
            let v = source(m, i, 8, false)? & LOW;
            set_xmm(i.reg, v);
        },
        (1, 1, 0xD6) => {
            let v = xmm(i.reg) & LOW;
            match i.rm {
                Some(r) => set_xmm(r, v),
                None => m.write(8, v, false)?,
            }
        },
        // VZEROUPPER: bits 255:128 of YMM0-YMM7, in 64-bit mode of YMM0-YMM15
        (1, 0, 0x77) => {
            for r in 0..if i.long { 16 } else { 8 } {
                *gp::ymm_hi.add(r) = reg128::of_bits(0);
            }
        },
        // VLDMXCSR (#GP(0) for a reserved bit), VSTMXCSR
        (1, 0, 0xAE) if i.reg & 7 == 2 => {
            let v = m.read(4, false)? as i32;
            if v & !MXCSR_MASK != 0 {
                return Err(m.raise(Exception::GeneralProtection));
            }
            cpu::set_mxcsr(v);
        },
        (1, 0, 0xAE) if i.reg & 7 == 3 => m.write(4, *gp::mxcsr as u32 as u128, false)?,
        // VMASKMOVDQU: the bytes whose mask byte (in the r/m register) has
        // its top bit set
        (1, 1, 0xF7) => {
            let mask = sign_mask(xmm(i.rm.unwrap()), 1);
            m.write_masked(xmm(i.reg), mask as u16)?;
        },
        _ => {
            dbg_assert!(false, "VEX form {:x} without semantics", i.key);
            return Err(m.raise(Exception::InvalidOpcode));
        },
    }
    Ok(())
}

/// The 32-bit interpreter's and the IR helper's side: `address` is the
/// memory operand's linear address (VMASKMOVDQU's destination), which the
/// caller computes after `check`
pub struct Interpreter {
    pub address: i32,
}
impl Machine for Interpreter {
    type Fault = ();
    unsafe fn raise(&mut self, e: Exception) {
        match e {
            Exception::InvalidOpcode => cpu::trigger_ud(),
            Exception::DeviceNotAvailable => cpu::trigger_nm(),
            Exception::GeneralProtection => cpu::trigger_gp(0),
            Exception::SimdFloatingPoint => cpu::trigger_simd_fp(),
        }
    }
    unsafe fn read(&mut self, bytes: u8, aligned: bool) -> Result<u128, ()> {
        let a = self.address;
        if aligned {
            cpu::aligned16(a)?;
        }
        Ok(match bytes {
            1 => cpu::safe_read8(a)? as u8 as u128,
            2 => cpu::safe_read16(a)? as u16 as u128,
            4 => cpu::safe_read32s(a)? as u32 as u128,
            8 => cpu::safe_read64s(a)? as u128,
            16 => cpu::safe_read128s(a)?.bits(),
            _ => unreachable!(),
        })
    }
    unsafe fn write(&mut self, bytes: u8, value: u128, aligned: bool) -> Result<(), ()> {
        let a = self.address;
        if aligned {
            cpu::aligned16(a)?;
        }
        match bytes {
            1 => cpu::safe_write8(a, value as u8 as i32),
            2 => cpu::safe_write16(a, value as u16 as i32),
            4 => cpu::safe_write32(a, value as i32),
            8 => cpu::safe_write64(a, value as u64),
            16 => cpu::safe_write128(a, reg128::of_bits(value)),
            _ => unreachable!(),
        }
    }
    /// (as MASKMOVDQU: the whole range writable first, whatever the mask)
    unsafe fn write_masked(&mut self, value: u128, mask: u16) -> Result<(), ()> {
        let a = self.address;
        cpu::writable_or_pagefault(a, 16)?;
        for n in 0..16 {
            if mask >> n & 1 != 0 {
                cpu::safe_write8(a.wrapping_add(n), (value >> (n * 8)) as u8 as i32).unwrap();
            }
        }
        Ok(())
    }
    unsafe fn gpr(&mut self, r: u8) -> u64 { cpu::read_reg32(r as i32) as u32 as u64 }
    unsafe fn set_gpr(&mut self, r: u8, value: u64, _wide: bool) {
        cpu::write_reg32(r as i32, value as i32);
    }
    unsafe fn set_flags(&mut self, flags: u32) {
        *gp::flags = *gp::flags & !cpu::FLAGS_ALL | flags as i32;
        *gp::flags_changed = 0;
    }
}
