//! Native SSE floating point in compiled code (docs/simd-xsave-plan.md 7.4):
//! Wasm's IEEE arithmetic, admitted only where it gives exactly the results
//! and MXCSR effects of cpu::simd_fp (whose interpreter fast path applies the
//! same rule). Tier-0 and the region backend emit these checks; a refused
//! instruction runs in the exact interpreter or helper.
//!
//! MXCSR's flags are sticky. When every exception is masked, the rounding is
//! to nearest, DAZ and FZ are clear and PE is set already (`mxcsr_refused`), a
//! native result equals the exact one and an inexact result changes nothing.
//! The other flags must not become set, so each operation refuses the lanes
//! that could set one: a denormal operand (DE), a NaN or infinite result (IE,
//! ZE, OE; and NaN payloads, which Wasm leaves open) and, for MUL, DIV and the
//! conversion to single precision, a result that is tiny after rounding (at
//! most the smallest normal in magnitude) unless it is the exact zero of a
//! zero factor (UE). A denormal sum or difference of normal operands is
//! exact, so it raises nothing (masked, UE needs inexactness). Operations that
//! cannot round and raise nothing for normal operands (MIN, MAX, compares,
//! widening conversions, reciprocal approximations) need only their operand
//! checks; the `*_refused` functions leave MXCSR's condition to the caller
//! (Tier-0 evaluates it once per block).
//!
//! The checks build a mask of the admitted lanes with integer and float
//! comparisons. Their constants have the same value in every 32-bit lane, so
//! that each is one move of an immediate (arbitrary v128 constants cost a
//! general-purpose register and a transfer per use on ARM64):
//! - finite x: x - x is 0 (else NaN);
//! - 2|x| - 1 (`x << 1` plus all ones) is all ones for a zero and below
//!   2 * smallest normal - 1 exactly for denormals;
//! - tiny x: |x| <= smallest normal.
//!
//! In double precision the integer comparisons see only the high half of
//! each lane (lanes 1 and 3; 2|x| - 1 and 2|x| compared to their bound's high
//! half), which also refuses a few normals just above the smallest one. The
//! low halves of such masks are left over: a scalar form reads lane 1 of the
//! result and packed forms copy the high halves down first (`high_half`).

use crate::cpu::global_pointers as gp;
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocalV128};

/// Push i32 nonzero unless MXCSR admits native rounding operations: every
/// exception masked, round to nearest, no DAZ or FZ, PE set
pub fn mxcsr_refused(w: &mut WasmBuilder) {
    w.load_fixed_i32(gp::mxcsr as u32);
    w.const_i32(0xFFE0);
    w.and_i32();
    w.const_i32(0x1FA0);
    w.ne_i32();
}

/// v128.const with `v` in every 32-bit lane
fn splat32(w: &mut WasmBuilder, v: u32) {
    let mut bytes = [0; 16];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = (v >> (i % 4 * 8)) as u8;
    }
    w.const_v128(bytes);
}

/// The lanes an instruction reads
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lanes {
    /// lane 0
    Scalar,
    /// all lanes
    Packed,
    /// single-precision lanes 0 and 1 (CVTPS2PD)
    LowPair,
}
/// Pop an admitted-lanes mask, push i32 nonzero if a lane read is refused
fn refused(w: &mut WasmBuilder, double: bool, lanes: Lanes) {
    match lanes {
        // (lane 1: the high half of a double, see above)
        Lanes::Scalar => w.simd_lane(0x1B, double as u8), // i32x4.extract_lane
        Lanes::Packed => w.simd(0xA3),                    // i32x4.all_true
        Lanes::LowPair => {
            w.simd_lane(0x1D, 0); // i64x2.extract_lane
            w.const_i64(-1);
            w.ne_i64();
            return;
        },
    }
    w.eqz_i32();
}
/// Make a mask of double-precision lanes from its high halves (packed forms)
fn high_half(w: &mut WasmBuilder, double: bool, scalar: bool) {
    if double && !scalar {
        w.const_i32(32);
        w.simd(0xCC); // i64x2.shr_s
    }
}

/// Push the mask of finite lanes
fn finite(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    w.get_local_v128(x);
    w.simd(if double { 0xF1 } else { 0xE5 }); // sub
    w.simd_zero();
    w.simd(if double { 0x47 } else { 0x41 }); // eq
}
/// Push the mask of ordered (not NaN) lanes
fn ordered(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    w.get_local_v128(x);
    w.simd(if double { 0x47 } else { 0x41 }); // eq
}
/// Push the mask of zero lanes
fn zero(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    w.simd_zero();
    w.simd(if double { 0x47 } else { 0x41 }); // eq
}
/// Push the mask of tiny lanes: magnitudes at most the smallest normal (a
/// zero too)
fn tiny(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    if double {
        w.const_i32(1);
        w.simd(0xCB); // i64x2.shl: 2|x|
        splat32(w, 0x0020_0000);
        w.simd(0x3E); // i32x4.le_u
    }
    else {
        w.simd(0xE0); // f32x4.abs
        splat32(w, 0x0080_0000);
        w.simd(0x45); // f32x4.le
    }
}
/// Push 2|x| - 1 per lane
fn twice_less_one(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    w.get_local_v128(x);
    w.const_i32(1);
    w.simd(if double { 0xCB } else { 0xAB }); // shl
    w.const_v128([0xFF; 16]);
    w.simd(if double { 0xCE } else { 0xAE }); // add
}
/// Pop 2|x| - 1, push the mask of denormal lanes
fn denormal_of(w: &mut WasmBuilder, double: bool) {
    splat32(w, if double { 0x0020_0000 } else { 0x00FF_FFFF });
    w.simd(0x3A); // i32x4.lt_u
}
/// Push the mask of denormal lanes of `x`
fn denormal(w: &mut WasmBuilder, x: &WasmLocalV128, double: bool) {
    twice_less_one(w, x, double);
    denormal_of(w, double);
}
/// Push the mask of lanes where `x` or `y` is denormal
fn denormal2(w: &mut WasmBuilder, x: &WasmLocalV128, y: &WasmLocalV128, double: bool) {
    twice_less_one(w, x, double);
    twice_less_one(w, y, double);
    w.simd(0xB7); // i32x4.min_u
    denormal_of(w, double);
}

/// Push the mask of lanes where an operand not known to be `clean` has a
/// zero exponent: a zero or a denormal (or nothing when all are clean)
fn exponent_zero_unknown(
    w: &mut WasmBuilder,
    operands: [(&WasmLocalV128, bool); 2],
    double: bool,
) -> bool {
    let mut unknown = operands.iter().filter(|(_, clean)| !clean).map(|(x, _)| x);
    let Some(x) = unknown.next()
    else {
        return false;
    };
    for (k, x) in std::iter::once(x).chain(unknown).enumerate() {
        w.get_local_v128(x);
        w.const_i32(1);
        w.simd(if double { 0xCB } else { 0xAB }); // shl: 2|x|
        if k > 0 {
            w.simd(0xB7); // i32x4.min_u
        }
    }
    splat32(w, if double { 0x0020_0000 } else { 0x0100_0000 });
    w.simd(0x3A); // i32x4.lt_u
    true
}

/// The cheap first test of arithmetic_refused: push i32 zero only if that
/// check would admit the instruction (its operands not known to be clean
/// have no zero exponent, a product or quotient is not tiny), else nonzero:
/// arithmetic_refused decides. None where it would be arithmetic_refused.
pub fn arithmetic_unsure(
    w: &mut WasmBuilder,
    op: u8,
    double: bool,
    scalar: bool,
    [a, b]: [&WasmLocalV128; 2],
    [a_clean, b_clean]: [bool; 2],
    r: &WasmLocalV128,
) -> bool {
    // Where it pays: the zero-exempt tininess test of a scalar product or
    // quotient. (Packed data, vectors and matrices, often holds zeros that
    // would fail the first test every time.)
    let operands = [(a, a_clean), (b, b_clean)];
    if !matches!(op, 0x59 | 0x5E) || !scalar {
        return false;
    }
    if matches!(op, 0x5D | 0x5F) {
        let mut unknown = operands.iter().filter(|(_, clean)| !clean);
        let (x, _) = unknown.next().unwrap();
        ordered(w, x, double);
        if let Some((y, _)) = unknown.next() {
            ordered(w, y, double);
            w.simd(0x4E); // v128.and
        }
        exponent_zero_unknown(w, operands, double);
    }
    else {
        finite(w, r, double);
        let mut suspect = exponent_zero_unknown(w, operands, double);
        if op == 0x59 || op == 0x5E {
            tiny(w, r, double);
            if suspect {
                w.simd(0x50); // v128.or
            }
            suspect = true;
        }
        dbg_assert!(suspect);
    }
    high_half(w, double, scalar);
    w.simd(0x4F); // v128.andnot
    refused(
        w,
        double,
        if scalar { Lanes::Scalar } else { Lanes::Packed },
    );
    true
}

/// Push the mask of lanes where an operand not known to be `clean` is
/// denormal (or nothing when all are clean)
fn denormal_unknown(
    w: &mut WasmBuilder,
    operands: [(&WasmLocalV128, bool); 2],
    double: bool,
) -> bool {
    match operands {
        [(x, false), (y, false)] => denormal2(w, x, y, double),
        [(x, false), _] | [_, (x, false)] => denormal(w, x, double),
        _ => return false,
    }
    true
}

/// Push the mask of lanes where the operands not known to be `clean` are
/// neither NaN nor denormal (false: all are clean, nothing pushed)
fn clean_operands(
    w: &mut WasmBuilder,
    operands: [(&WasmLocalV128, bool); 2],
    double: bool,
    scalar: bool,
) -> bool {
    let mut unknown = operands.iter().filter(|(_, clean)| !clean);
    let Some((x, _)) = unknown.next()
    else {
        return false;
    };
    ordered(w, x, double);
    if let Some((y, _)) = unknown.next() {
        ordered(w, y, double);
        w.simd(0x4E); // v128.and
    }
    denormal_unknown(w, operands, double);
    high_half(w, double, scalar);
    w.simd(0x4F); // v128.andnot
    true
}

/// SQRT (0x51, of `b`), ADD (0x58), MUL (0x59), SUB (0x5C), MIN (0x5D), DIV
/// (0x5E) and MAX (0x5F) of `a` (the destination) and `b` (the source) with
/// the native result `r`: push i32 nonzero to refuse. MIN and MAX of
/// operands that are neither NaN nor denormal raise nothing and do not
/// round: they do not depend on MXCSR; the others need mxcsr_refused too.
///
/// An operand known to be clean (`a_clean`, `b_clean`: neither NaN nor
/// denormal in the lanes read) is not checked again. All operands of an
/// admitted instruction are clean afterwards, and so are its results except
/// those of ADD and SUB (possibly an exact denormal).
pub fn arithmetic_refused(
    w: &mut WasmBuilder,
    op: u8,
    double: bool,
    scalar: bool,
    [a, b]: [&WasmLocalV128; 2],
    [a_clean, b_clean]: [bool; 2],
    r: &WasmLocalV128,
) {
    let operands =
        if op == 0x51 { [(b, b_clean), (b, true)] } else { [(a, a_clean), (b, b_clean)] };
    if matches!(op, 0x5D | 0x5F) {
        if !clean_operands(w, operands, double, scalar) {
            w.const_i32(0);
            return;
        }
    }
    else {
        finite(w, r, double);
        let mut refused_lanes = denormal_unknown(w, operands, double);
        if op == 0x59 || op == 0x5E {
            // a tiny product or quotient is exact only as the zero of a zero
            // factor (dividend)
            tiny(w, r, double);
            zero(w, a, double);
            if op == 0x59 {
                zero(w, b, double);
                w.simd(0x50); // v128.or
            }
            w.simd(0x4F); // v128.andnot
            if refused_lanes {
                w.simd(0x50);
            }
            refused_lanes = true;
        }
        if refused_lanes {
            high_half(w, double, scalar);
            w.simd(0x4F); // finite and not refused
        }
    }
    refused(
        w,
        double,
        if scalar { Lanes::Scalar } else { Lanes::Packed },
    );
}

/// CVTPD2PS/CVTSD2SS of `x` with the native result `r`: push i32 nonzero to
/// refuse a denormal source and a result that is NaN, infinite or tiny
/// unless of a zero source (MXCSR's condition is the caller's)
pub fn narrowing_refused(w: &mut WasmBuilder, scalar: bool, x: &WasmLocalV128, r: &WasmLocalV128) {
    // the single-precision result lanes 0 and 1 at the source's lanes
    w.get_local_v128(r);
    w.get_local_v128(r);
    w.simd_shuffle([0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7]);
    let s = w.set_new_local_v128();
    finite(w, &s, false);
    tiny(w, &s, false);
    zero(w, x, true);
    w.simd(0x4F); // v128.andnot
    denormal(w, x, true);
    w.simd(0x50); // v128.or
    high_half(w, true, scalar);
    w.simd(0x4F);
    w.free_local_v128(s);
    refused(w, true, if scalar { Lanes::Scalar } else { Lanes::Packed });
}

/// COMISS/UCOMISS/COMISD/UCOMISD of `x` and `y` (Lanes::Scalar) and
/// CVTPS2PD/CVTSS2SD of `x` (pass `y` clean, Lanes::LowPair or Scalar): push
/// i32 nonzero to refuse a NaN or denormal operand not known to be `clean`.
/// Exact, and without those operands nothing is raised.
pub fn operands_refused(
    w: &mut WasmBuilder,
    double: bool,
    lanes: Lanes,
    [x, y]: [&WasmLocalV128; 2],
    [x_clean, y_clean]: [bool; 2],
) {
    if clean_operands(
        w,
        [(x, x_clean), (y, y_clean)],
        double,
        lanes != Lanes::Packed,
    ) {
        refused(w, double, lanes);
    }
    else {
        w.const_i32(0);
    }
}

/// RCPPS/RCPSS (0x53) and RSQRTPS/RSQRTSS (0x52) of `x` with the native
/// result `r` (1 / x, 1 / sqrt(x)): push i32 nonzero to refuse a source that
/// is zero, denormal, NaN or infinite (or negative for 0x52) and a result in
/// the denormal range (which simd_fp::reciprocal makes zero). No exceptions.
pub fn reciprocal_refused(
    w: &mut WasmBuilder,
    op: u8,
    scalar: bool,
    x: &WasmLocalV128,
    r: &WasmLocalV128,
) {
    finite(w, x, false);
    tiny(w, x, false);
    // (a result in the denormal range: below the smallest normal)
    w.get_local_v128(r);
    w.simd(0xE0); // f32x4.abs
    splat32(w, 0x0080_0000);
    w.simd(0x43); // f32x4.lt
    w.simd(0x50); // v128.or
    if op == 0x52 {
        w.get_local_v128(x);
        w.simd_zero();
        w.simd(0x43); // negative
        w.simd(0x50);
    }
    w.simd(0x4F); // v128.andnot
    refused(w, false, if scalar { Lanes::Scalar } else { Lanes::Packed });
}
