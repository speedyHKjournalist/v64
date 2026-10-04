#![allow(non_snake_case)]
//! The opcode map 0F 3A (src/rust/gen/interpreter0f3a.rs calls these). The
//! semantics are in crate::cpu::simd_int, shared with the IR and x64 engines.

use crate::cpu::cpu::*;
use crate::cpu::simd_int;
use crate::cpu::sse_instr::{sse_fp_dot_product, sse_fp_round};

pub unsafe fn instr_0F3A0F(source: u64, r: i32, imm8: i32) {
    // palignr mm, mm/m64, imm8
    let destination = read_mmx64s(r).to_le_bytes();
    let result = simd_int::palignr(destination, source.to_le_bytes(), imm8 as u8);
    write_mmx_reg64(r, u64::from_le_bytes(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F3A0F_reg(r1: i32, r2: i32, imm: i32) {
    instr_0F3A0F(read_mmx64s(r1), r2, imm);
}
pub unsafe fn instr_0F3A0F_mem(addr: i32, r: i32, imm: i32) {
    instr_0F3A0F(return_on_pagefault!(safe_read64s(addr)), r, imm);
}
pub unsafe fn instr_660F3A0F(source: reg128, r: i32, imm8: i32) {
    // palignr xmm, xmm/m128, imm8
    let destination = read_xmm128s(r);
    write_xmm_reg128(
        r,
        reg128 {
            u8: simd_int::palignr(destination.u8, source.u8, imm8 as u8),
        },
    );
}
pub unsafe fn instr_660F3A0F_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A0F(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_660F3A0F_mem(addr: i32, r: i32, imm: i32) {
    instr_660F3A0F(return_on_pagefault!(safe_read128s_aligned(addr)), r, imm);
}

/// BLENDPS/BLENDPD/PBLENDW/MPSADBW (simd_int::sse4_imm): xmm, xmm/m128, imm8
pub unsafe fn sse4_imm_xmm(op: u8, source: reg128, r: i32, imm8: i32) {
    let result = simd_int::sse4_imm(op, read_xmm128s(r).u8, source.u8, imm8 as u8);
    write_xmm_reg128(r, reg128 { u8: result });
}
macro_rules! sse4_imm {
    ($($op:literal $xmm:ident $xmm_reg:ident $xmm_mem:ident;)*) => {$(
        pub unsafe fn $xmm(source: reg128, r: i32, imm8: i32) { sse4_imm_xmm($op, source, r, imm8) }
        pub unsafe fn $xmm_reg(r1: i32, r2: i32, imm: i32) { $xmm(read_xmm128s(r1), r2, imm) }
        pub unsafe fn $xmm_mem(addr: i32, r: i32, imm: i32) {
            $xmm(return_on_pagefault!(safe_read128s_aligned(addr)), r, imm)
        }
    )*};
}
sse4_imm! {
    0x0C instr_660F3A0C instr_660F3A0C_reg instr_660F3A0C_mem; // blendps
    0x0D instr_660F3A0D instr_660F3A0D_reg instr_660F3A0D_mem; // blendpd
    0x0E instr_660F3A0E instr_660F3A0E_reg instr_660F3A0E_mem; // pblendw
    0x42 instr_660F3A42 instr_660F3A42_reg instr_660F3A42_mem; // mpsadbw
}

/// PEXTRB/PEXTRW/PEXTRD/EXTRACTPS: the element of `bytes` bytes of XMM `r`
/// that imm8 selects
pub unsafe fn extract(r: i32, bytes: usize, imm8: i32) -> u32 {
    let i = imm8 as usize & (16 / bytes - 1);
    read_xmm128s(r).u8[i * bytes..(i + 1) * bytes]
        .iter()
        .rev()
        .fold(0, |n, &b| n << 8 | b as u32)
}
/// PINSRB/PINSRD: the element of `bytes` bytes of XMM `r` that imm8 selects
/// := the low bytes of `value`
pub unsafe fn insert(r: i32, bytes: usize, value: u32, imm8: i32) {
    let i = imm8 as usize & (16 / bytes - 1);
    let mut v = read_xmm128s(r);
    v.u8[i * bytes..(i + 1) * bytes].copy_from_slice(&value.to_le_bytes()[..bytes]);
    write_xmm_reg128(r, v);
}
// pextrb r32/m8, xmm, imm8 (pextrw r32/m16, pextrd r/m32, extractps r/m32): a
// register destination is zero-extended
pub unsafe fn instr_660F3A14_reg(r1: i32, r2: i32, imm: i32) {
    write_reg32(r1, extract(r2, 1, imm) as i32)
}
pub unsafe fn instr_660F3A14_mem(addr: i32, r: i32, imm: i32) {
    return_on_pagefault!(safe_write8(addr, extract(r, 1, imm) as i32));
}
pub unsafe fn instr_660F3A15_reg(r1: i32, r2: i32, imm: i32) {
    write_reg32(r1, extract(r2, 2, imm) as i32)
}
pub unsafe fn instr_660F3A15_mem(addr: i32, r: i32, imm: i32) {
    return_on_pagefault!(safe_write16(addr, extract(r, 2, imm) as i32));
}
pub unsafe fn instr_660F3A16_reg(r1: i32, r2: i32, imm: i32) {
    write_reg32(r1, extract(r2, 4, imm) as i32)
}
pub unsafe fn instr_660F3A16_mem(addr: i32, r: i32, imm: i32) {
    return_on_pagefault!(safe_write32(addr, extract(r, 4, imm) as i32));
}
pub unsafe fn instr_660F3A17_reg(r1: i32, r2: i32, imm: i32) {
    write_reg32(r1, extract(r2, 4, imm) as i32)
}
pub unsafe fn instr_660F3A17_mem(addr: i32, r: i32, imm: i32) {
    return_on_pagefault!(safe_write32(addr, extract(r, 4, imm) as i32));
}
// pinsrb xmm, r32/m8, imm8 (pinsrd xmm, r/m32, imm8)
pub unsafe fn instr_660F3A20_reg(r1: i32, r2: i32, imm: i32) {
    insert(r2, 1, read_reg32(r1) as u32, imm)
}
pub unsafe fn instr_660F3A20_mem(addr: i32, r: i32, imm: i32) {
    insert(r, 1, return_on_pagefault!(safe_read8(addr)) as u32, imm)
}
pub unsafe fn instr_660F3A22_reg(r1: i32, r2: i32, imm: i32) {
    insert(r2, 4, read_reg32(r1) as u32, imm)
}
pub unsafe fn instr_660F3A22_mem(addr: i32, r: i32, imm: i32) {
    insert(r, 4, return_on_pagefault!(safe_read32s(addr)) as u32, imm)
}
pub unsafe fn instr_660F3A21(value: u32, r: i32, imm8: i32) {
    // insertps xmm, xmm/m32, imm8
    let result = simd_int::insertps(read_xmm128s(r).u8, value, imm8 as u8);
    write_xmm_reg128(r, reg128 { u8: result });
}
pub unsafe fn instr_660F3A21_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A21(read_xmm128s(r1).u32[(imm >> 6 & 3) as usize], r2, imm)
}
pub unsafe fn instr_660F3A21_mem(addr: i32, r: i32, imm: i32) {
    instr_660F3A21(return_on_pagefault!(safe_read32s(addr)) as u32, r, imm)
}

// roundps/roundpd xmm, xmm/m128, imm8; roundss xmm, xmm/m32, imm8; roundsd
// xmm, xmm/m64, imm8 (false: an unmasked exception, nothing changed)
pub unsafe fn instr_660F3A08(source: reg128, r: i32, imm: i32) -> bool {
    sse_fp_round(0x660F3A08, r, source.bits(), imm)
}
pub unsafe fn instr_660F3A08_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A08(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_660F3A08_mem(addr: i32, r: i32, imm: i32) {
    instr_660F3A08(return_on_pagefault!(safe_read128s_aligned(addr)), r, imm);
}
pub unsafe fn instr_660F3A09(source: reg128, r: i32, imm: i32) -> bool {
    sse_fp_round(0x660F3A09, r, source.bits(), imm)
}
pub unsafe fn instr_660F3A09_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A09(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_660F3A09_mem(addr: i32, r: i32, imm: i32) {
    instr_660F3A09(return_on_pagefault!(safe_read128s_aligned(addr)), r, imm);
}
pub unsafe fn instr_660F3A0A(source: u32, r: i32, imm: i32) -> bool {
    sse_fp_round(0x660F3A0A, r, source as u128, imm)
}
pub unsafe fn instr_660F3A0A_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A0A(read_xmm128s(r1).u32[0], r2, imm);
}
pub unsafe fn instr_660F3A0A_mem(addr: i32, r: i32, imm: i32) {
    instr_660F3A0A(return_on_pagefault!(safe_read32s(addr)) as u32, r, imm);
}
pub unsafe fn instr_660F3A0B(source: u64, r: i32, imm: i32) -> bool {
    sse_fp_round(0x660F3A0B, r, source as u128, imm)
}
pub unsafe fn instr_660F3A0B_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A0B(read_xmm64s(r1), r2, imm);
}
pub unsafe fn instr_660F3A0B_mem(addr: i32, r: i32, imm: i32) {
    instr_660F3A0B(return_on_pagefault!(safe_read64s(addr)), r, imm);
}
// dpps/dppd xmm, xmm/m128, imm8
pub unsafe fn instr_660F3A40(source: reg128, r: i32, imm: i32) -> bool {
    sse_fp_dot_product(false, r, source.bits(), imm)
}
pub unsafe fn instr_660F3A40_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A40(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_660F3A40_mem(addr: i32, r: i32, imm: i32) {
    instr_660F3A40(return_on_pagefault!(safe_read128s_aligned(addr)), r, imm);
}
pub unsafe fn instr_660F3A41(source: reg128, r: i32, imm: i32) -> bool {
    sse_fp_dot_product(true, r, source.bits(), imm)
}
pub unsafe fn instr_660F3A41_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F3A41(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_660F3A41_mem(addr: i32, r: i32, imm: i32) {
    instr_660F3A41(return_on_pagefault!(safe_read128s_aligned(addr)), r, imm);
}

/// ROUNDPS/PD/SS/SD of the XMM `source` register's value (the IR helper):
/// false after an unmasked exception
pub unsafe fn instr_660F3A08_any(op: u32, source: reg128, r: i32, imm: i32) -> bool {
    sse_fp_round(op, r, source.bits(), imm)
}
