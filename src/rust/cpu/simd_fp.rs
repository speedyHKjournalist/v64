//! SSE floating point as the processor computes it (docs/simd-xsave-plan.md
//! 7.4): every operation through SoftFloat (its 8086-SSE specialization gives
//! x86's NaN rules), with MXCSR's rounding mode, DAZ and FZ, its exception
//! flags, and the fault of an unmasked exception. Shared by the 32-bit
//! interpreter (and the IR helpers that call it) and the x64 engine; compiled
//! code runs natively only where that gives the same results and flags.
//!
//! Operands and results are the bits of 128-bit registers (lane 0 in the low
//! bits); the engines read the operands and write the results.
//!
//! The order of exceptions follows SDM Vol. 1, 11.5.3: pre-computation
//! exceptions (invalid operation, denormal operand, divide by zero) of all
//! lanes come first. When one of them is unmasked, MXCSR gets their flags and
//! the instruction faults without computing anything else. Otherwise the
//! post-computation exceptions (overflow, underflow, precision) are detected;
//! when one of them is unmasked, MXCSR gets all flags and the instruction
//! faults. Either way the destination is left alone. Within a lane, an
//! invalid operation, a QNaN operand and division by zero take precedence
//! over the denormal operand exception (SDM Vol. 1, 4.9.2).

use crate::cpu::global_pointers as gp;

extern "C" {
    fn f32_add(a: u32, b: u32) -> u32;
    fn f32_sub(a: u32, b: u32) -> u32;
    fn f32_mul(a: u32, b: u32) -> u32;
    fn f32_div(a: u32, b: u32) -> u32;
    fn f32_sqrt(a: u32) -> u32;
    fn f64_add(a: u64, b: u64) -> u64;
    fn f64_sub(a: u64, b: u64) -> u64;
    fn f64_mul(a: u64, b: u64) -> u64;
    fn f64_div(a: u64, b: u64) -> u64;
    fn f64_sqrt(a: u64) -> u64;
    fn f32_to_f64(a: u32) -> u64;
    fn f64_to_f32(a: u64) -> u32;
    fn i32_to_f32(a: i32) -> u32;
    fn i32_to_f64(a: i32) -> u64;
    fn i64_to_f32(a: i64) -> u32;
    fn i64_to_f64(a: i64) -> u64;
    fn f32_to_i32(a: u32, rounding: u8, exact: bool) -> i32;
    fn f32_to_i64(a: u32, rounding: u8, exact: bool) -> i64;
    fn f64_to_i32(a: u64, rounding: u8, exact: bool) -> i32;
    fn f64_to_i64(a: u64, rounding: u8, exact: bool) -> i64;
    static mut softfloat_roundingMode: u8;
    static mut softfloat_exceptionFlags: u8;
}

// MXCSR's exception flags (its masks are 7 bits above)
pub const IE: u32 = 0x01;
pub const DE: u32 = 0x02;
pub const ZE: u32 = 0x04;
pub const OE: u32 = 0x08;
pub const UE: u32 = 0x10;
pub const PE: u32 = 0x20;
const PRE_COMPUTATION: u32 = IE | DE | ZE;
const DAZ: u32 = 0x40;
const UM: u32 = 0x800;
const FZ: u32 = 0x8000;
// SoftFloat's flags that take precedence over the denormal operand exception
const SF_UNDERFLOW: u8 = 2;
const SF_INFINITE: u8 = 8;
const SF_INVALID: u8 = 16;
/// SoftFloat's rounding mode for MXCSR.RC (nearest, down, up, toward zero)
const ROUNDING: [u8; 4] = [0, 2, 3, 1];

/// An unmasked SIMD floating-point exception: the engine raises #XM (#UD
/// without CR4.OSXMMEXCPT). MXCSR has the flags already; nothing else changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unmasked;

pub fn nan(v: u64, double: bool) -> bool {
    if double {
        v & 0x7FFF_FFFF_FFFF_FFFF > 0x7FF0_0000_0000_0000
    }
    else {
        v as u32 & 0x7FFF_FFFF > 0x7F80_0000
    }
}
pub fn snan(v: u64, double: bool) -> bool {
    nan(v, double) && v & if double { 1 << 51 } else { 1 << 22 } == 0
}
pub fn denormal(v: u64, double: bool) -> bool {
    if double {
        v & 0x7FF0_0000_0000_0000 == 0 && v & 0x000F_FFFF_FFFF_FFFF != 0
    }
    else {
        v & 0x7F80_0000 == 0 && v & 0x007F_FFFF != 0
    }
}
fn sign_mask(double: bool) -> u64 {
    if double {
        1 << 63
    }
    else {
        1 << 31
    }
}
fn lane_mask(double: bool) -> u128 {
    if double {
        u64::MAX as u128
    }
    else {
        u32::MAX as u128
    }
}
fn lane(v: u128, i: usize, double: bool) -> u64 {
    (v >> (if double { 64 } else { 32 } * i)) as u64 & lane_mask(double) as u64
}
fn set_lane(v: u128, i: usize, double: bool, x: u64) -> u128 {
    let shift = if double { 64 } else { 32 } * i;
    v & !(lane_mask(double) << shift) | (x as u128 & lane_mask(double)) << shift
}

/// One instruction's computation: MXCSR's controls, the flags so far, and
/// SoftFloat's state (shared with the x87 code) around it
pub struct Fp {
    mxcsr: u32,
    flags: u32,
    /// SoftFloat signalled underflow for the current lane: tiny after
    /// rounding (and inexact), even where the result rounded up to the
    /// smallest normal
    underflow: bool,
    saved_rounding: u8,
    saved_flags: u8,
}
impl Fp {
    pub unsafe fn new() -> Self {
        let mxcsr = *gp::mxcsr as u32;
        let fp = Self {
            mxcsr,
            flags: 0,
            underflow: false,
            saved_rounding: softfloat_roundingMode,
            saved_flags: softfloat_exceptionFlags,
        };
        softfloat_roundingMode = ROUNDING[(mxcsr >> 13 & 3) as usize];
        softfloat_exceptionFlags = 0;
        fp
    }
    /// SoftFloat's rounding mode for MXCSR.RC
    pub fn rounding(&self) -> u8 { ROUNDING[(self.mxcsr >> 13 & 3) as usize] }
    /// A source operand: a denormal is zero with DAZ, else the denormal
    /// operand exception (returned for the lane, see `lane`)
    fn input(&self, v: u64, double: bool, de: &mut u32) -> u64 {
        if denormal(v, double) {
            if self.mxcsr & DAZ != 0 {
                return v & sign_mask(double);
            }
            *de = DE;
        }
        v
    }
    /// A computed result (after `lane`): unmasked, the underflow exception is
    /// a tiny result even when exact; masked with FZ, a tiny result is zero
    /// (and inexact). Tiny: an exact denormal, or SoftFloat's underflow (an
    /// inexact one may round to the smallest normal)
    fn output(&mut self, v: u64, double: bool) -> u64 {
        if self.underflow || denormal(v, double) {
            if self.mxcsr & UM == 0 {
                self.flags |= UE;
            }
            else if self.mxcsr & FZ != 0 {
                self.flags |= UE | PE;
                return v & sign_mask(double);
            }
        }
        v
    }
    /// The flags of one lane: SoftFloat's (cleared for the next lane) and its
    /// denormal operand exception unless a QNaN operand, an invalid
    /// operation or a division by zero takes precedence
    unsafe fn lane(&mut self, de: u32, qnan_operand: bool) {
        let sf = softfloat_exceptionFlags;
        softfloat_exceptionFlags = 0;
        self.underflow = sf & SF_UNDERFLOW != 0;
        if !qnan_operand && sf & (SF_INVALID | SF_INFINITE) == 0 {
            self.flags |= de;
        }
        self.flags |= (sf as u32 & 1) << 5
            | (sf as u32 & 2) << 3
            | (sf as u32 & 4) << 1
            | (sf as u32 & 8) >> 1
            | (sf as u32 & 16) >> 4;
    }
    /// One lane of 0x51 SQRT (of b), 0x58 ADD, 0x59 MUL, 0x5C SUB, 0x5D MIN,
    /// 0x5E DIV, 0x5F MAX
    pub unsafe fn binary(&mut self, op: u8, a: u64, b: u64, double: bool) -> u64 {
        let mut de = 0;
        let a = if op == 0x51 { 0 } else { self.input(a, double, &mut de) };
        let b = self.input(b, double, &mut de);
        let qnan = nan(a, double) || nan(b, double);
        if op == 0x5D || op == 0x5F {
            // MIN and MAX: the second operand for any NaN (an invalid
            // operation) and for equal operands (zeros of either sign); no
            // post-computation exceptions
            let result = if qnan {
                self.flags |= IE;
                b
            }
            else {
                let (less, greater) = if double {
                    let (x, y) = (f64::from_bits(a), f64::from_bits(b));
                    (x < y, x > y)
                }
                else {
                    let (x, y) = (f32::from_bits(a as u32), f32::from_bits(b as u32));
                    (x < y, x > y)
                };
                if if op == 0x5D { less } else { greater } {
                    a
                }
                else {
                    b
                }
            };
            self.lane(de, qnan);
            return result;
        }
        let result = if double {
            match op {
                0x58 => f64_add(a, b),
                0x59 => f64_mul(a, b),
                0x5C => f64_sub(a, b),
                0x5E => f64_div(a, b),
                0x51 => f64_sqrt(b),
                _ => unreachable!(),
            }
        }
        else {
            let (a, b) = (a as u32, b as u32);
            (match op {
                0x58 => f32_add(a, b),
                0x59 => f32_mul(a, b),
                0x5C => f32_sub(a, b),
                0x5E => f32_div(a, b),
                0x51 => f32_sqrt(b),
                _ => unreachable!(),
            }) as u64
        };
        self.lane(de, qnan);
        self.output(result, double)
    }
    /// One lane of CMPPS/CMPPD/CMPSS/CMPSD's predicates 0-7 (and COMISS/
    /// UCOMISS: 1 and 0): a QNaN is invalid for the signaling ones
    pub unsafe fn compare(&mut self, a: u64, b: u64, double: bool, predicate: u8) -> bool {
        let mut de = 0;
        let a = self.input(a, double, &mut de);
        let b = self.input(b, double, &mut de);
        let unordered = nan(a, double) || nan(b, double);
        if snan(a, double) || snan(b, double) || unordered && matches!(predicate & 7, 1 | 2 | 5 | 6)
        {
            self.flags |= IE;
        }
        self.lane(de, unordered);
        let (eq, lt) = if unordered {
            (false, false)
        }
        else if double {
            (
                f64::from_bits(a) == f64::from_bits(b),
                f64::from_bits(a) < f64::from_bits(b),
            )
        }
        else {
            (
                f32::from_bits(a as u32) == f32::from_bits(b as u32),
                f32::from_bits(a as u32) < f32::from_bits(b as u32),
            )
        };
        match predicate & 7 {
            0 => eq,
            1 => lt,
            2 => lt || eq,
            3 => unordered,
            4 => !eq,
            5 => !lt,
            6 => !(lt || eq),
            _ => !unordered,
        }
    }
    /// A floating-point source of a conversion: DAZ, and the denormal operand
    /// exception unless `no_de` (conversions to integers do not have it)
    pub fn convert_input(&mut self, v: u64, double: bool, no_de: bool) -> u64 {
        let mut de = 0;
        let v = self.input(v, double, &mut de);
        if !no_de && !nan(v, double) {
            self.flags |= de;
        }
        v
    }
    /// The SoftFloat flags of a conversion lane
    pub unsafe fn convert_lane(&mut self) { self.lane(0, false) }
    /// A computed conversion result (see `output`)
    pub fn convert_output(&mut self, v: u64, double: bool) -> u64 { self.output(v, double) }
    /// Restore SoftFloat's state; commit the flags to MXCSR in the order of
    /// SDM Vol. 1, 11.5.3 (see above)
    pub unsafe fn finish(self) -> Result<(), Unmasked> {
        let flags = self.flags;
        softfloat_roundingMode = self.saved_rounding;
        softfloat_exceptionFlags = self.saved_flags;
        let unmasked = !(self.mxcsr >> 7) & 0x3F;
        let pre = flags & PRE_COMPUTATION;
        if pre & unmasked != 0 {
            *gp::mxcsr |= pre as i32;
            return Err(Unmasked);
        }
        *gp::mxcsr |= flags as i32;
        if flags & unmasked != 0 {
            return Err(Unmasked);
        }
        Ok(())
    }
}

/// One lane natively, by ir::native_fp's rule (see there): with MXCSR at its
/// defaults and PE set (checked by the caller), host IEEE arithmetic gives
/// SoftFloat's result and changes no flag unless an operand is denormal or
/// the result is NaN, infinite or (MUL, DIV) tiny but not an exact zero. MIN,
/// MAX and the compares (`predicate`) need only operands that are neither NaN
/// nor denormal, whatever MXCSR. None: the exact path decides.
fn fast_lane(op: u8, a: u64, b: u64, double: bool, predicate: u8) -> Option<u64> {
    let abs = if double { u64::MAX >> 1 } else { 0x7FFF_FFFF };
    let min = if double { 0x0010_0000_0000_0000 } else { 0x0080_0000 };
    let infinity = if double { 0x7FF0_0000_0000_0000 } else { 0x7F80_0000 };
    let (ma, mb) = (a & abs, b & abs);
    let denormal = |m: u64| m != 0 && m < min;
    if denormal(mb) || op != 0x51 && denormal(ma) {
        return None;
    }
    if matches!(op, 0x5D | 0x5F | 0xC2) {
        if ma > infinity || mb > infinity {
            return None;
        }
        use std::cmp::Ordering::*;
        let order = if double {
            f64::from_bits(a).partial_cmp(&f64::from_bits(b))
        }
        else {
            f32::from_bits(a as u32).partial_cmp(&f32::from_bits(b as u32))
        }
        .unwrap();
        return Some(match op {
            0x5D => {
                if order == Less {
                    a
                }
                else {
                    b
                }
            },
            0x5F => {
                if order == Greater {
                    a
                }
                else {
                    b
                }
            },
            _ => {
                let truth = match predicate & 7 {
                    0 => order == Equal,
                    1 => order == Less,
                    2 => order != Greater,
                    3 => false,
                    4 => order != Equal,
                    5 => order != Less,
                    6 => order == Greater,
                    _ => true,
                };
                if truth {
                    lane_mask(double) as u64
                }
                else {
                    0
                }
            },
        });
    }
    let r = if double {
        let (x, y) = (f64::from_bits(a), f64::from_bits(b));
        (match op {
            0x58 => x + y,
            0x5C => x - y,
            0x59 => x * y,
            0x5E => x / y,
            _ => y.sqrt(),
        })
        .to_bits()
    }
    else {
        let (x, y) = (f32::from_bits(a as u32), f32::from_bits(b as u32));
        (match op {
            0x58 => x + y,
            0x5C => x - y,
            0x59 => x * y,
            0x5E => x / y,
            _ => y.sqrt(),
        })
        .to_bits() as u64
    };
    let mr = r & abs;
    if mr >= infinity {
        return None;
    }
    if matches!(op, 0x59 | 0x5E) && mr <= min && !(mr == 0 && (ma == 0 || op == 0x59 && mb == 0)) {
        return None;
    }
    Some(r)
}

/// The lanes of a form: (double, scalar, lane count)
fn shape(op: u32) -> (bool, bool) {
    let prefix = op >> 16;
    (matches!(prefix, 0x66 | 0xF2), matches!(prefix, 0xF2 | 0xF3))
}

/// SQRT/ADD/MUL/SUB/MIN/DIV/MAX (0F 51, 58-5F), CMP (0F C2, `imm8` the
/// predicate), HADD/HSUB (66/F2 0F 7C/7D) and ADDSUB (66/F2 0F D0), PS/PD/SS/SD
/// by the mandatory prefix of `op` (the catalogue key): the new destination.
/// A scalar form leaves the destination's upper lanes alone.
pub unsafe fn arithmetic(
    op: u32,
    destination: u128,
    source: u128,
    imm8: u8,
) -> Result<u128, Unmasked> {
    let code = op as u8;
    let (double, scalar) =
        if matches!(code, 0x7C | 0x7D | 0xD0) { (op >> 16 == 0x66, false) } else { shape(op) };
    let lanes = if scalar {
        1
    }
    else if double {
        2
    }
    else {
        4
    };
    // (MIN, MAX and CMP do not round: their fast path needs no MXCSR condition)
    let admitted = *gp::mxcsr as u32 & 0xFFE0 == 0x1FA0 || matches!(code, 0x5D | 0x5F | 0xC2);
    if admitted && matches!(code, 0x51 | 0x58 | 0x59 | 0x5C..=0x5F | 0xC2) {
        // (lanes as arrays: u128 shifts are slow in Wasm)
        if double {
            let (d, s): ([u64; 2], [u64; 2]) = (
                std::mem::transmute(destination),
                std::mem::transmute(source),
            );
            let mut r = d;
            if (0..lanes).all(|i| {
                fast_lane(code, d[i], s[i], true, imm8)
                    .map(|v| r[i] = v)
                    .is_some()
            }) {
                return Ok(std::mem::transmute(r));
            }
        }
        else {
            let (d, s): ([u32; 4], [u32; 4]) = (
                std::mem::transmute(destination),
                std::mem::transmute(source),
            );
            let mut r = d;
            if (0..lanes).all(|i| {
                fast_lane(code, d[i] as u64, s[i] as u64, false, imm8)
                    .map(|v| r[i] = v as u32)
                    .is_some()
            }) {
                return Ok(std::mem::transmute(r));
            }
        }
    }
    let mut fp = Fp::new();
    let mut result = destination;
    for i in 0..lanes {
        let (a, b) = (lane(destination, i, double), lane(source, i, double));
        let v = match code {
            0xC2 => {
                if fp.compare(a, b, double, imm8) {
                    lane_mask(double) as u64
                }
                else {
                    0
                }
            },
            0xD0 => fp.binary(if i % 2 == 0 { 0x5C } else { 0x58 }, a, b, double),
            0x7C | 0x7D => {
                let half = lanes / 2;
                let input = if i < half { destination } else { source };
                let base = i % half * 2;
                fp.binary(
                    if code == 0x7C { 0x58 } else { 0x5C },
                    lane(input, base, double),
                    lane(input, base + 1, double),
                    double,
                )
            },
            _ => fp.binary(code, a, b, double),
        };
        result = set_lane(result, i, double, v);
    }
    fp.finish()?;
    Ok(result)
}

/// COMISS/UCOMISS/COMISD/UCOMISD (0F/66 0F 2F/2E): EFLAGS' ZF, PF and CF
/// (0x40, 0x04, 0x01) of comparing the low lanes. COMI signals a QNaN as an
/// invalid operation, UCOMI only an SNaN.
pub unsafe fn compare_flags(op: u32, a: u128, b: u128) -> Result<u32, Unmasked> {
    let double = op >> 16 == 0x66;
    let mut fp = Fp::new();
    let mut de = 0;
    let x = fp.input(lane(a, 0, double), double, &mut de);
    let y = fp.input(lane(b, 0, double), double, &mut de);
    let unordered = nan(x, double) || nan(y, double);
    if snan(x, double) || snan(y, double) || unordered && op as u8 == 0x2F {
        fp.flags |= IE;
    }
    fp.lane(de, unordered);
    fp.finish()?;
    let (eq, lt) = if unordered {
        (false, false)
    }
    else if double {
        (
            f64::from_bits(x) == f64::from_bits(y),
            f64::from_bits(x) < f64::from_bits(y),
        )
    }
    else {
        let (x, y) = (f32::from_bits(x as u32), f32::from_bits(y as u32));
        (x == y, x < y)
    };
    Ok(if unordered {
        0x45
    }
    else if lt {
        0x01
    }
    else if eq {
        0x40
    }
    else {
        0
    })
}

/// RCPPS/RCPSS/RSQRTPS/RSQRTSS (0F/F3 0F 53/52): the new destination. No
/// exceptions; denormal sources count as zero and tiny results are zero
/// (SDM: "Tiny results are always flushed to 0.0"). The approximation is the
/// correctly rounded value, well within the architectural 1.5 * 2^-12.
pub fn reciprocal(op: u32, destination: u128, source: u128) -> u128 {
    let scalar = op >> 16 == 0xF3;
    let square_root = op as u8 == 0x52;
    let mut result = if scalar { destination } else { 0 };
    for i in 0..if scalar { 1 } else { 4 } {
        let v = lane(source, i, false) as u32;
        let sign = v & 0x8000_0000;
        let bits = if nan(v as u64, false) {
            v | 0x40_0000
        }
        else if v & 0x7F80_0000 == 0 {
            // zero or denormal: an infinity of its sign
            sign | 0x7F80_0000
        }
        else if square_root && sign != 0 {
            0xFFC0_0000
        }
        else if v & 0x7FFF_FFFF == 0x7F80_0000 {
            sign
        }
        else {
            let x = f32::from_bits(v);
            let r = if square_root { 1.0 / x.sqrt() } else { 1.0 / x };
            let bits = r.to_bits();
            if denormal(bits as u64, false) {
                bits & 0x8000_0000
            }
            else {
                bits
            }
        };
        result = set_lane(result, i, false, bits as u64);
    }
    result
}

/// The conversions (catalogue keys): the new XMM destination, or for those
/// to a general-purpose or MMX register the integer bits in the low 64 bits.
/// `wide`: REX.W (64-bit integers). The integer sources are in `source`'s low
/// bits (an MMX register, or a general-purpose register for CVTSI2SS/SD).
///
/// - 0F 2A CVTPI2PS, 66 0F 2A CVTPI2PD, F3/F2 0F 2A CVTSI2SS/SD
/// - 0F/66 0F 2C CVTTPS2PI/CVTTPD2PI, 2D CVTPS2PI/CVTPD2PI; F3/F2 0F 2C/2D
///   CVT(T)SS2SI/CVT(T)SD2SI
/// - 0F 5A CVTPS2PD, 66 0F 5A CVTPD2PS, F3 0F 5A CVTSS2SD, F2 0F 5A CVTSD2SS
/// - 0F 5B CVTDQ2PS, 66 0F 5B CVTPS2DQ, F3 0F 5B CVTTPS2DQ
/// - F3 0F E6 CVTDQ2PD, 66 0F E6 CVTTPD2DQ, F2 0F E6 CVTPD2DQ
pub unsafe fn convert(
    op: u32,
    wide: bool,
    destination: u128,
    source: u128,
) -> Result<u128, Unmasked> {
    let prefix = op >> 16;
    let code = op as u8;
    let scalar = matches!(prefix, 0xF2 | 0xF3) && matches!(code, 0x2A | 0x2C | 0x2D | 0x5A);
    let mut fp = Fp::new();
    let result;
    match code {
        0x2A => {
            // from integers: an MMX register's two, or one general-purpose register
            let double = matches!(prefix, 0x66 | 0xF2);
            let mut out = if prefix == 0x66 { 0 } else { destination };
            for i in 0..if scalar { 1 } else { 2 } {
                let n =
                    if scalar && wide { source as i64 } else { (source >> (i * 32)) as i32 as i64 };
                let v = if double { i64_to_f64(n) } else { i64_to_f32(n) as u64 };
                fp.convert_lane();
                out = set_lane(out, i, double, fp.convert_output(v, double));
            }
            result = out;
        },
        0x2C | 0x2D => {
            // to integers: two for an MMX register, one for a general-purpose register
            let double = matches!(prefix, 0x66 | 0xF2);
            let rounding = if code == 0x2C { 1 } else { fp.rounding() };
            let mut out = 0u128;
            for i in 0..if scalar { 1 } else { 2 } {
                let value = fp.convert_input(lane(source, i, double), double, true);
                let n = if scalar && wide {
                    if double {
                        f64_to_i64(value, rounding, true)
                    }
                    else {
                        f32_to_i64(value as u32, rounding, true)
                    }
                }
                else {
                    (if double {
                        f64_to_i32(value, rounding, true)
                    }
                    else {
                        f32_to_i32(value as u32, rounding, true)
                    }) as i64
                };
                fp.convert_lane();
                out |= if scalar { n as u64 as u128 } else { (n as u32 as u128) << (i * 32) };
            }
            result = out;
        },
        0x5A => {
            // between single and double precision
            let from_double = matches!(prefix, 0x66 | 0xF2);
            let mut out = if scalar { destination } else { 0 };
            for i in 0..if scalar { 1 } else { 2 } {
                let value = fp.convert_input(lane(source, i, from_double), from_double, false);
                let v =
                    if from_double { f64_to_f32(value) as u64 } else { f32_to_f64(value as u32) };
                let qnan = nan(value, from_double);
                fp.lane(0, qnan);
                out = set_lane(out, i, !from_double, fp.convert_output(v, !from_double));
            }
            result = out;
        },
        _ => {
            // 5B and E6: between 32-bit integers and floating point
            let to_float = op == 0x0F5B || op == 0xF30FE6;
            let double = code == 0xE6;
            let truncate = matches!(op, 0xF30F5B | 0x660FE6);
            let count = if double { 2 } else { 4 };
            let mut out = 0u128;
            for i in 0..count {
                if to_float {
                    let n = (source >> (i * 32)) as i32;
                    let v = if double { i32_to_f64(n) } else { i32_to_f32(n) as u64 };
                    fp.convert_lane();
                    out = set_lane(out, i, double, fp.convert_output(v, double));
                }
                else {
                    let value = fp.convert_input(lane(source, i, double), double, true);
                    let rounding = if truncate { 1 } else { fp.rounding() };
                    let n = if double {
                        f64_to_i32(value, rounding, true)
                    }
                    else {
                        f32_to_i32(value as u32, rounding, true)
                    };
                    fp.convert_lane();
                    out |= (n as u32 as u128) << (i * 32);
                }
            }
            result = out;
        },
    }
    fp.finish()?;
    Ok(result)
}
