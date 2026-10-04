#![allow(non_snake_case)]
//! The opcode map 0F 38 (src/rust/gen/interpreter0f38.rs calls these). The
//! semantics are in crate::cpu::simd_int, shared with the IR and x64 engines.

use crate::cpu::cpu::*;
use crate::cpu::simd_int;

/// An SSSE3 MMX form: mm, mm/m64
pub unsafe fn ssse3_mmx(op: u8, source: u64, r: i32) {
    let destination = read_mmx64s(r).to_le_bytes();
    let result = simd_int::ssse3(op, destination, source.to_le_bytes());
    write_mmx_reg64(r, u64::from_le_bytes(result));
    transition_fpu_to_mmx();
}
/// An SSSE3 XMM form: xmm, xmm/m128 (aligned)
pub unsafe fn ssse3_xmm(op: u8, source: reg128, r: i32) {
    let destination = read_xmm128s(r);
    write_xmm_reg128(
        r,
        reg128 {
            u8: simd_int::ssse3(op, destination.u8, source.u8),
        },
    );
}

macro_rules! ssse3 {
    ($($op:literal $mmx:ident $mmx_reg:ident $mmx_mem:ident $xmm:ident $xmm_reg:ident $xmm_mem:ident;)*) => {$(
        pub unsafe fn $mmx(source: u64, r: i32) { ssse3_mmx($op, source, r) }
        pub unsafe fn $mmx_reg(r1: i32, r2: i32) { $mmx(read_mmx64s(r1), r2) }
        pub unsafe fn $mmx_mem(addr: i32, r: i32) { $mmx(return_on_pagefault!(safe_read64s(addr)), r) }
        pub unsafe fn $xmm(source: reg128, r: i32) { ssse3_xmm($op, source, r) }
        pub unsafe fn $xmm_reg(r1: i32, r2: i32) { $xmm(read_xmm128s(r1), r2) }
        pub unsafe fn $xmm_mem(addr: i32, r: i32) { $xmm(return_on_pagefault!(safe_read128s_aligned(addr)), r) }
    )*};
}
ssse3! {
    0x00 instr_0F3800 instr_0F3800_reg instr_0F3800_mem instr_660F3800 instr_660F3800_reg instr_660F3800_mem; // pshufb
    0x01 instr_0F3801 instr_0F3801_reg instr_0F3801_mem instr_660F3801 instr_660F3801_reg instr_660F3801_mem; // phaddw
    0x02 instr_0F3802 instr_0F3802_reg instr_0F3802_mem instr_660F3802 instr_660F3802_reg instr_660F3802_mem; // phaddd
    0x03 instr_0F3803 instr_0F3803_reg instr_0F3803_mem instr_660F3803 instr_660F3803_reg instr_660F3803_mem; // phaddsw
    0x04 instr_0F3804 instr_0F3804_reg instr_0F3804_mem instr_660F3804 instr_660F3804_reg instr_660F3804_mem; // pmaddubsw
    0x05 instr_0F3805 instr_0F3805_reg instr_0F3805_mem instr_660F3805 instr_660F3805_reg instr_660F3805_mem; // phsubw
    0x06 instr_0F3806 instr_0F3806_reg instr_0F3806_mem instr_660F3806 instr_660F3806_reg instr_660F3806_mem; // phsubd
    0x07 instr_0F3807 instr_0F3807_reg instr_0F3807_mem instr_660F3807 instr_660F3807_reg instr_660F3807_mem; // phsubsw
    0x08 instr_0F3808 instr_0F3808_reg instr_0F3808_mem instr_660F3808 instr_660F3808_reg instr_660F3808_mem; // psignb
    0x09 instr_0F3809 instr_0F3809_reg instr_0F3809_mem instr_660F3809 instr_660F3809_reg instr_660F3809_mem; // psignw
    0x0A instr_0F380A instr_0F380A_reg instr_0F380A_mem instr_660F380A instr_660F380A_reg instr_660F380A_mem; // psignd
    0x0B instr_0F380B instr_0F380B_reg instr_0F380B_mem instr_660F380B instr_660F380B_reg instr_660F380B_mem; // pmulhrsw
    0x1C instr_0F381C instr_0F381C_reg instr_0F381C_mem instr_660F381C instr_660F381C_reg instr_660F381C_mem; // pabsb
    0x1D instr_0F381D instr_0F381D_reg instr_0F381D_mem instr_660F381D instr_660F381D_reg instr_660F381D_mem; // pabsw
    0x1E instr_0F381E instr_0F381E_reg instr_0F381E_mem instr_660F381E instr_660F381E_reg instr_660F381E_mem; // pabsd
}
