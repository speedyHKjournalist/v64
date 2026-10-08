//! SSE floating point as the processor computes it (docs/simd-xsave-plan.md
//! 7.4): every operation through SoftFloat (its 8086-SSE specialization gives
//! x86's NaN rules), with MXCSR's rounding mode, DAZ and FZ, its exception
//! flags, and the fault of an unmasked exception. Shared by the 32-bit
//! interpreter (and the IR helpers that call it) and the x64 engine; compiled
//! code runs natively only where that gives the same results and flags.
//!
//! Operands and results are the bits of 128-bit registers (lane 0 in the low
//! bits), a VEX.256 form's the two halves of 256-bit ones; the engines read
//! the operands and write the results.
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
    fn f32_roundToInt(a: u32, rounding: u8, exact: bool) -> u32;
    fn f64_roundToInt(a: u64, rounding: u8, exact: bool) -> u64;
    fn f32_mulAdd(a: u32, b: u32, c: u32) -> u32;
    fn f64_mulAdd(a: u64, b: u64, c: u64) -> u64;
    // (float16_t is a struct of one u16: clang passes and returns it in an
    // i32 whose upper bits it does not define, so these take and give u32,
    // masked here; with u16 Rust would assume a zero-extended value)
    fn f16_to_f32(a: u32) -> u32;
    fn f32_to_f16(a: u32) -> u32;
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
    /// One lane of CMPPS/CMPPD/CMPSS/CMPSD's predicate 0-7, of VCMP*'s 0-31
    /// (imm8[3:0] the relation, imm8[4] swapping quiet and signaling; and
    /// COMISS/UCOMISS: 1 and 0): a QNaN is invalid for the signaling ones
    pub unsafe fn compare(&mut self, a: u64, b: u64, double: bool, predicate: u8) -> bool {
        let mut de = 0;
        let a = self.input(a, double, &mut de);
        let b = self.input(b, double, &mut de);
        let unordered = nan(a, double) || nan(b, double);
        // (the signaling predicates: 1, 2, 5 and 6 of each eight, the others
        // with imm8[4])
        let signaling = matches!(predicate & 7, 1 | 2 | 5 | 6) != (predicate & 16 != 0);
        if snan(a, double) || snan(b, double) || unordered && signaling {
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
        if unordered {
            // UNORD, NEQ_U, NLT_U, NLE_U, EQ_U, NGE_U, NGT_U, TRUE
            return matches!(predicate & 15, 3..=6 | 8..=10 | 15);
        }
        // (ordered: imm8[2:0] decides; 8-15 are 0-7's other unordered results)
        match predicate & 7 {
            0 => eq,
            1 => lt,
            2 => lt || eq,
            3 => false,
            4 => !eq,
            5 => !lt,
            6 => !(lt || eq),
            _ => true,
        }
    }
    /// One lane of FMA (SDM Vol. 1, 14.5.2): `x` × `y`, negated if
    /// `negate_product`, plus `z`, negated if `negate_addend`, rounded once.
    /// A NaN operand gives the first of x, y and z quieted, and IE for an
    /// SNaN; with a QNaN addend 0 × ∞ gives that NaN without IE (SoftFloat's
    /// 8086-SSE rules give the default NaN with IE), so NaN operands are
    /// handled here, unnegated. Otherwise SoftFloat: 0 × ∞ and ∞ − ∞ are
    /// invalid operations (the default NaN).
    pub unsafe fn fused(
        &mut self,
        x: u64,
        y: u64,
        z: u64,
        double: bool,
        negate_product: bool,
        negate_addend: bool,
    ) -> u64 {
        let mut de = 0;
        let x = self.input(x, double, &mut de);
        let y = self.input(y, double, &mut de);
        let z = self.input(z, double, &mut de);
        if let Some(&first) = [x, y, z].iter().find(|&&v| nan(v, double)) {
            if snan(x, double) || snan(y, double) || snan(z, double) {
                self.flags |= IE;
            }
            self.lane(de, true);
            return first | if double { 1 << 51 } else { 1 << 22 };
        }
        let x = if negate_product { x ^ sign_mask(double) } else { x };
        let z = if negate_addend { z ^ sign_mask(double) } else { z };
        let result = if double {
            f64_mulAdd(x, y, z)
        }
        else {
            f32_mulAdd(x as u32, y as u32, z as u32) as u64
        };
        self.lane(de, false);
        self.output(result, double)
    }
    /// A half-precision result (VCVTPS2PH): FZ does not apply, a tiny result
    /// is a half denormal (SDM); unmasked, the underflow exception is a tiny
    /// result even when exact
    fn half_output(&mut self, v: u16) {
        let denormal = v & 0x7C00 == 0 && v & 0x03FF != 0;
        if (self.underflow || denormal) && self.mxcsr & UM == 0 {
            self.flags |= UE;
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
    // (legacy CMP: imm8[2:0], its other bits ignored)
    operate(op, [destination], [source], imm8 & 7).map(|[r]| r)
}
/// VCMPPS/VCMPPD/VCMPSS/VCMPSD (VEX.0F C2): `arithmetic`'s CMP with the 32
/// predicates of imm8[4:0]
pub unsafe fn compare(
    op: u32,
    destination: u128,
    source: u128,
    imm8: u8,
) -> Result<u128, Unmasked> {
    operate(op, [destination], [source], imm8 & 31).map(|[r]| r)
}
/// The VEX.256 forms of `arithmetic` (VCMPPS/PD: `compare`'s): the lanes of
/// both halves (HADD/HSUB's pairs within each) with one exception context,
/// the halves of the new destination
pub unsafe fn arithmetic256(
    op: u32,
    destination: (u128, u128),
    source: (u128, u128),
    imm8: u8,
) -> Result<(u128, u128), Unmasked> {
    operate(
        op,
        [destination.0, destination.1],
        [source.0, source.1],
        imm8 & 31,
    )
    .map(|[low, high]| (low, high))
}
/// One half's `lanes` natively (fast_lane), or None when one is not
unsafe fn fast_half(
    code: u8,
    destination: u128,
    source: u128,
    double: bool,
    lanes: usize,
    imm8: u8,
) -> Option<u128> {
    // (lanes as arrays: u128 shifts are slow in Wasm)
    if double {
        let (d, s): ([u64; 2], [u64; 2]) = (
            std::mem::transmute(destination),
            std::mem::transmute(source),
        );
        let mut r = d;
        for i in 0..lanes {
            r[i] = fast_lane(code, d[i], s[i], true, imm8)?;
        }
        Some(std::mem::transmute(r))
    }
    else {
        let (d, s): ([u32; 4], [u32; 4]) = (
            std::mem::transmute(destination),
            std::mem::transmute(source),
        );
        let mut r = d;
        for i in 0..lanes {
            r[i] = fast_lane(code, d[i] as u64, s[i] as u64, false, imm8)? as u32;
        }
        Some(std::mem::transmute(r))
    }
}
/// `arithmetic` of N halves (a VEX.256 form: 2) with one exception context
unsafe fn operate<const N: usize>(
    op: u32,
    destination: [u128; N],
    source: [u128; N],
    imm8: u8,
) -> Result<[u128; N], Unmasked> {
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
        let mut r = destination;
        if (0..N).all(|h| {
            fast_half(code, destination[h], source[h], double, lanes, imm8)
                .map(|v| r[h] = v)
                .is_some()
        }) {
            return Ok(r);
        }
    }
    let mut fp = Fp::new();
    let mut result = destination;
    for h in 0..N {
        let (destination, source) = (destination[h], source[h]);
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
            result[h] = set_lane(result[h], i, double, v);
        }
    }
    fp.finish()?;
    Ok(result)
}

/// The FMA forms (VEX.66.0F38 96-9F, A6-AF, B6-BF; `op` the opcode byte) of
/// DEST (also the first source), SRC2 (VEX.vvvv) and SRC3 (r/m) in halves of
/// 128 bits (a VEX.256 form: two) with one exception context; `double`:
/// VEX.W1 (PD, SD). The low nibble is the operation (6 ADDSUB: even lanes
/// subtract, 7 SUBADD: odd lanes subtract, 8/9 ADD, A/B SUB, C/D NADD (the
/// product negated), E/F NSUB; scalar from 9 when odd), the high one the
/// order: 9 (132) DEST × SRC3 + SRC2, A (213) SRC2 × DEST + SRC3, B (231)
/// SRC2 × SRC3 + DEST. A scalar form's other lanes are DEST's.
pub unsafe fn fused<const N: usize>(
    op: u8,
    double: bool,
    destination: [u128; N],
    second: [u128; N],
    third: [u128; N],
) -> Result<[u128; N], Unmasked> {
    let operation = op & 0xF;
    let scalar = operation >= 9 && operation & 1 == 1;
    let lanes = if scalar {
        1
    }
    else if double {
        2
    }
    else {
        4
    };
    let mut fp = Fp::new();
    let mut result = destination;
    for h in 0..N {
        for i in 0..lanes {
            let (a, b, c) = (
                lane(destination[h], i, double),
                lane(second[h], i, double),
                lane(third[h], i, double),
            );
            let (x, y, z) = match op >> 4 {
                9 => (a, c, b),
                0xA => (b, a, c),
                _ => (b, c, a),
            };
            let even = i % 2 == 0;
            let (negate_product, negate_addend) = match operation {
                6 => (false, even),
                7 => (false, !even),
                8 | 9 => (false, false),
                0xA | 0xB => (false, true),
                0xC | 0xD => (true, false),
                _ => (true, true),
            };
            let v = fp.fused(x, y, z, double, negate_product, negate_addend);
            result[h] = set_lane(result[h], i, double, v);
        }
    }
    fp.finish()?;
    Ok(result)
}

/// VCVTPH2PS (F16C): the `count` (4 or 8) half-precision values in the low
/// bits of `source` as single-precision values, in halves of 128 bits. The
/// result is exact; DAZ does not apply and there is no denormal operand
/// exception (SDM); an SNaN is an invalid operation (quieted).
pub unsafe fn half_to_single(source: u128, count: usize) -> Result<(u128, u128), Unmasked> {
    let mut fp = Fp::new();
    let mut out = [0u128; 2];
    for i in 0..count {
        let v = f16_to_f32((source >> (16 * i)) as u16 as u32);
        fp.convert_lane();
        out[i / 4] |= (v as u128) << (32 * (i % 4));
    }
    fp.finish()?;
    Ok((out[0], out[1]))
}
/// VCVTPS2PH (F16C): the `count` (4 or 8) single-precision values of
/// `source` (halves of 128 bits) as half-precision values in the low bits of
/// the result, rounded as imm8[1:0] says or, with imm8[2], as MXCSR.RC does.
/// DAZ applies to the sources; FZ does not (half_output).
pub unsafe fn single_to_half(
    source: (u128, u128),
    count: usize,
    imm8: u8,
) -> Result<u128, Unmasked> {
    let mut fp = Fp::new();
    if imm8 & 4 == 0 {
        softfloat_roundingMode = ROUNDING[(imm8 & 3) as usize];
    }
    let mut out = 0u128;
    for i in 0..count {
        let half = if i < 4 { source.0 } else { source.1 };
        let mut de = 0;
        let value = fp.input((half >> (32 * (i % 4))) as u32 as u64, false, &mut de);
        let v = (f32_to_f16(value as u32) & 0xFFFF) as u16;
        fp.lane(de, nan(value, false));
        fp.half_output(v);
        out |= (v as u128) << (16 * i);
    }
    fp.finish()?;
    Ok(out)
}

/// ROUNDPS/ROUNDPD/ROUNDSS/ROUNDSD (66 0F 3A 08-0B by `op`'s low byte): each
/// lane (a scalar form's low one, the others from the destination) to an
/// integral value, rounded as imm8[1:0] says or, with imm8[2], as MXCSR.RC
/// does; imm8[3] suppresses the precision exception. DAZ applies, the
/// denormal operand exception does not (SDM); an SNaN is an invalid operation.
pub unsafe fn round(op: u32, destination: u128, source: u128, imm8: u8) -> Result<u128, Unmasked> {
    round_halves(op, [destination], [source], imm8).map(|[r]| r)
}
/// VROUNDPS/VROUNDPD with VEX.256 (`op` the legacy form's key): both halves
/// of `source` with one exception context
pub unsafe fn round256(op: u32, source: (u128, u128), imm8: u8) -> Result<(u128, u128), Unmasked> {
    round_halves(op, [0, 0], [source.0, source.1], imm8).map(|[low, high]| (low, high))
}
unsafe fn round_halves<const N: usize>(
    op: u32,
    destination: [u128; N],
    source: [u128; N],
    imm8: u8,
) -> Result<[u128; N], Unmasked> {
    let double = op & 1 != 0;
    let scalar = op & 0xFF >= 0x0A;
    let mut fp = Fp::new();
    let rounding = if imm8 & 4 != 0 { fp.rounding() } else { ROUNDING[(imm8 & 3) as usize] };
    let exact = imm8 & 8 == 0;
    let mut result = destination;
    for h in 0..N {
        for i in 0..if scalar {
            1
        }
        else if double {
            2
        }
        else {
            4
        } {
            let v = fp.convert_input(lane(source[h], i, double), double, true);
            let r = if double {
                f64_roundToInt(v, rounding, exact)
            }
            else {
                f32_roundToInt(v as u32, rounding, exact) as u64
            };
            fp.convert_lane();
            result[h] = set_lane(result[h], i, double, r);
        }
    }
    fp.finish()?;
    Ok(result)
}

/// DPPS/DPPD (66 0F 3A 40/41): the products of the lanes imm8[7:4] selects
/// (+0.0 for the others), summed pairwise in the SDM's order, in the lanes
/// imm8[3:0] selects (+0.0 in the others). Each multiplication and addition
/// has its own exceptions (as a single operation, SDM Vol. 1, 11.5.3) and
/// sets its flags in MXCSR. An unmasked one faults, the destination left
/// alone, where the SDM's pseudo-code looks for it: after DPPD's two
/// multiplications and after each addition (DPPS: only after the additions,
/// so the first addition runs even when a multiplication had one).
pub unsafe fn dot_product(
    double: bool,
    destination: u128,
    source: u128,
    imm8: u8,
) -> Result<u128, Unmasked> {
    unsafe fn step(op: u8, a: u64, b: u64, double: bool, unmasked: &mut bool) -> u64 {
        let mut fp = Fp::new();
        let r = fp.binary(op, a, b, double);
        *unmasked |= fp.finish().is_err();
        r
    }
    let lanes = if double { 2 } else { 4 };
    let mut unmasked = false;
    let mut products = [0; 4];
    for i in 0..lanes {
        if imm8 >> (4 + i) & 1 != 0 {
            products[i] = step(
                0x59,
                lane(destination, i, double),
                lane(source, i, double),
                double,
                &mut unmasked,
            );
        }
    }
    let check = |unmasked: bool| if unmasked { Err(Unmasked) } else { Ok(()) };
    let sum = if double {
        check(unmasked)?;
        step(0x58, products[0], products[1], double, &mut unmasked)
    }
    else {
        let low = step(0x58, products[0], products[1], double, &mut unmasked);
        check(unmasked)?;
        let high = step(0x58, products[2], products[3], double, &mut unmasked);
        check(unmasked)?;
        step(0x58, low, high, double, &mut unmasked)
    };
    check(unmasked)?;
    let mut result = 0;
    for i in 0..lanes {
        if imm8 >> i & 1 != 0 {
            result = set_lane(result, i, double, sum);
        }
    }
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

/// The VEX.256 conversions (the legacy forms' keys) with one exception
/// context: VCVTDQ2PS (0F 5B), VCVTPS2DQ (66 0F 5B) and VCVTTPS2DQ (F3 0F 5B)
/// of eight lanes; VCVTPS2PD (0F 5A) and VCVTDQ2PD (F3 0F E6) of an XMM
/// source's four into four doubles; VCVTPD2PS (66 0F 5A), VCVTPD2DQ (F2 0F E6)
/// and VCVTTPD2DQ (66 0F E6) of four doubles into an XMM result (the high
/// half zero)
pub unsafe fn convert256(op: u32, source: (u128, u128)) -> Result<(u128, u128), Unmasked> {
    let element = |i: usize, bytes: usize| {
        let offset = i * bytes;
        let half = if offset < 16 { source.0 } else { source.1 };
        (half >> (offset % 16 * 8)) as u64 & (u64::MAX >> (64 - bytes * 8))
    };
    let mut out = [0u128; 2];
    let mut put = |i: usize, bytes: usize, v: u64| {
        let offset = i * bytes;
        out[offset / 16] |= (v as u128 & (u128::MAX >> (128 - bytes * 8))) << (offset % 16 * 8);
    };
    let mut fp = Fp::new();
    match op {
        0x0F5B => {
            for i in 0..8 {
                let v = i32_to_f32(element(i, 4) as u32 as i32) as u64;
                fp.convert_lane();
                put(i, 4, fp.convert_output(v, false));
            }
        },
        0x660F5B | 0xF30F5B => {
            let rounding = if op == 0xF30F5B { 1 } else { fp.rounding() };
            for i in 0..8 {
                let value = fp.convert_input(element(i, 4), false, true);
                let n = f32_to_i32(value as u32, rounding, true);
                fp.convert_lane();
                put(i, 4, n as u32 as u64);
            }
        },
        0xF30FE6 => {
            for i in 0..4 {
                let v = i32_to_f64(element(i, 4) as u32 as i32);
                fp.convert_lane();
                put(i, 8, fp.convert_output(v, true));
            }
        },
        0x0F5A => {
            for i in 0..4 {
                let value = fp.convert_input(element(i, 4), false, false);
                let v = f32_to_f64(value as u32);
                fp.lane(0, nan(value, false));
                put(i, 8, fp.convert_output(v, true));
            }
        },
        0x660F5A => {
            for i in 0..4 {
                let value = fp.convert_input(element(i, 8), true, false);
                let v = f64_to_f32(value) as u64;
                fp.lane(0, nan(value, true));
                put(i, 4, fp.convert_output(v, false));
            }
        },
        0x660FE6 | 0xF20FE6 => {
            let rounding = if op == 0x660FE6 { 1 } else { fp.rounding() };
            for i in 0..4 {
                let value = fp.convert_input(element(i, 8), true, true);
                let n = f64_to_i32(value, rounding, true);
                fp.convert_lane();
                put(i, 4, n as u32 as u64);
            }
        },
        _ => unreachable!("not a VEX.256 conversion"),
    }
    fp.finish()?;
    Ok((out[0], out[1]))
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
