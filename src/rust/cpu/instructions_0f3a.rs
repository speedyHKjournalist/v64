#![allow(non_snake_case)]
//! The opcode map 0F 3A (src/rust/gen/interpreter0f3a.rs calls these). The
//! semantics are in crate::cpu::simd_int, shared with the IR and x64 engines.

use crate::cpu::cpu::*;
use crate::cpu::simd_int;

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
