#![allow(non_snake_case)]
//! The opcode map 0F 38 (src/rust/gen/interpreter0f38.rs calls these). The
//! semantics are in crate::cpu::simd_int, shared with the IR and x64 engines.

use crate::cpu::cpu::*;
use crate::cpu::global_pointers::{flags, flags_changed};
use crate::cpu::simd_int;
use crate::paging::OrPageFault;

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

/// The bytes the memory form of 66 0F 38 `op` (simd_int::sse4) reads:
/// PMOVSX/PMOVZX only what they extend (no alignment), the others an m128
pub fn sse4_source_bytes(op: u8) -> u8 {
    match op {
        0x20..=0x25 | 0x30..=0x35 => [8, 4, 2, 8, 4, 8][(op & 7) as usize],
        _ => 16,
    }
}
/// The memory source of 66 0F 38 `op`: an aligned m128, or its low bytes
pub unsafe fn sse4_source(op: u8, addr: i32) -> OrPageFault<reg128> {
    Ok(match sse4_source_bytes(op) {
        16 => safe_read128s_aligned(addr)?,
        2 => reg128 {
            u64: [safe_read16(addr)? as u16 as u64, 0],
        },
        4 => reg128 {
            u64: [safe_read32s(addr)? as u32 as u64, 0],
        },
        _ => reg128 {
            u64: [safe_read64s(addr)?, 0],
        },
    })
}
/// An SSE4.1/SSE4.2 form of simd_int::sse4: xmm, xmm/m128 (BLENDV: the mask in XMM0)
pub unsafe fn sse4_xmm(op: u8, source: reg128, r: i32) {
    let result = simd_int::sse4(op, read_xmm128s(r).u8, source.u8, read_xmm128s(0).u8);
    write_xmm_reg128(r, reg128 { u8: result });
}

macro_rules! sse4 {
    ($($op:literal $xmm:ident $xmm_reg:ident $xmm_mem:ident;)*) => {$(
        pub unsafe fn $xmm(source: reg128, r: i32) { sse4_xmm($op, source, r) }
        pub unsafe fn $xmm_reg(r1: i32, r2: i32) { $xmm(read_xmm128s(r1), r2) }
        pub unsafe fn $xmm_mem(addr: i32, r: i32) { $xmm(return_on_pagefault!(sse4_source($op, addr)), r) }
    )*};
}
sse4! {
    0x10 instr_660F3810 instr_660F3810_reg instr_660F3810_mem; // pblendvb
    0x14 instr_660F3814 instr_660F3814_reg instr_660F3814_mem; // blendvps
    0x15 instr_660F3815 instr_660F3815_reg instr_660F3815_mem; // blendvpd
    0x20 instr_660F3820 instr_660F3820_reg instr_660F3820_mem; // pmovsxbw
    0x21 instr_660F3821 instr_660F3821_reg instr_660F3821_mem; // pmovsxbd
    0x22 instr_660F3822 instr_660F3822_reg instr_660F3822_mem; // pmovsxbq
    0x23 instr_660F3823 instr_660F3823_reg instr_660F3823_mem; // pmovsxwd
    0x24 instr_660F3824 instr_660F3824_reg instr_660F3824_mem; // pmovsxwq
    0x25 instr_660F3825 instr_660F3825_reg instr_660F3825_mem; // pmovsxdq
    0x28 instr_660F3828 instr_660F3828_reg instr_660F3828_mem; // pmuldq
    0x29 instr_660F3829 instr_660F3829_reg instr_660F3829_mem; // pcmpeqq
    0x2B instr_660F382B instr_660F382B_reg instr_660F382B_mem; // packusdw
    0x30 instr_660F3830 instr_660F3830_reg instr_660F3830_mem; // pmovzxbw
    0x31 instr_660F3831 instr_660F3831_reg instr_660F3831_mem; // pmovzxbd
    0x32 instr_660F3832 instr_660F3832_reg instr_660F3832_mem; // pmovzxbq
    0x33 instr_660F3833 instr_660F3833_reg instr_660F3833_mem; // pmovzxwd
    0x34 instr_660F3834 instr_660F3834_reg instr_660F3834_mem; // pmovzxwq
    0x35 instr_660F3835 instr_660F3835_reg instr_660F3835_mem; // pmovzxdq
    0x37 instr_660F3837 instr_660F3837_reg instr_660F3837_mem; // pcmpgtq (SSE4.2)
    0x38 instr_660F3838 instr_660F3838_reg instr_660F3838_mem; // pminsb
    0x39 instr_660F3839 instr_660F3839_reg instr_660F3839_mem; // pminsd
    0x3A instr_660F383A instr_660F383A_reg instr_660F383A_mem; // pminuw
    0x3B instr_660F383B instr_660F383B_reg instr_660F383B_mem; // pminud
    0x3C instr_660F383C instr_660F383C_reg instr_660F383C_mem; // pmaxsb
    0x3D instr_660F383D instr_660F383D_reg instr_660F383D_mem; // pmaxsd
    0x3E instr_660F383E instr_660F383E_reg instr_660F383E_mem; // pmaxuw
    0x3F instr_660F383F instr_660F383F_reg instr_660F383F_mem; // pmaxud
    0x40 instr_660F3840 instr_660F3840_reg instr_660F3840_mem; // pmulld
    0x41 instr_660F3841 instr_660F3841_reg instr_660F3841_mem; // phminposuw
}

pub unsafe fn instr_660F3817(source: reg128, r: i32) {
    // ptest xmm, xmm/m128: ZF and CF, the other arithmetic flags cleared
    let (zero, carry) = simd_int::ptest(read_xmm128s(r).u8, source.u8);
    *flags_changed = 0;
    *flags =
        *flags & !FLAGS_ALL | if zero { FLAG_ZERO } else { 0 } | if carry { FLAG_CARRY } else { 0 };
}
pub unsafe fn instr_660F3817_reg(r1: i32, r2: i32) { instr_660F3817(read_xmm128s(r1), r2) }
pub unsafe fn instr_660F3817_mem(addr: i32, r: i32) {
    instr_660F3817(return_on_pagefault!(safe_read128s_aligned(addr)), r)
}

pub unsafe fn instr_660F382A_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_660F382A_mem(addr: i32, r: i32) {
    // movntdqa xmm, m128
    write_xmm_reg128(r, return_on_pagefault!(safe_read128s_aligned(addr)));
}

/// CRC32 r32, r/m8 (F2 0F 38 F0), r/m16 (66 F2 0F 38 F1), r/m32 (F2 0F 38
/// F1): the low `bytes` of `value` into the CRC-32C in `r` (simd_int::crc32c);
/// no flags, no XMM state checks
pub unsafe fn crc32(r: i32, value: u32, bytes: u32) {
    write_reg32(
        r,
        simd_int::crc32c(read_reg32(r) as u32, value as u64, bytes) as i32,
    );
}
pub unsafe fn instr_F20F38F0_reg(r1: i32, r: i32) { crc32(r, read_reg8(r1) as u32, 1) }
pub unsafe fn instr_F20F38F0_mem(addr: i32, r: i32) {
    crc32(r, return_on_pagefault!(safe_read8(addr)) as u32, 1)
}
pub unsafe fn instr16_F20F38F1_reg(r1: i32, r: i32) { crc32(r, read_reg16(r1) as u32, 2) }
pub unsafe fn instr16_F20F38F1_mem(addr: i32, r: i32) {
    crc32(r, return_on_pagefault!(safe_read16(addr)) as u32, 2)
}
pub unsafe fn instr32_F20F38F1_reg(r1: i32, r: i32) { crc32(r, read_reg32(r1) as u32, 4) }
pub unsafe fn instr32_F20F38F1_mem(addr: i32, r: i32) {
    crc32(r, return_on_pagefault!(safe_read32s(addr)) as u32, 4)
}
