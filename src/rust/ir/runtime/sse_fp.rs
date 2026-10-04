//! Explicit semantic calls: guard and ordered load precede any destination update.
//! Floating point is the interpreter's, exact (cpu::simd_fp: MXCSR rounding and
//! flags, unmasked exceptions as #XM or #UD).
//! The SSSE3, SSE4.1 and SSE4.2 XMM forms share these adapters (integer
//! semantics, no MXCSR).
use crate::cpu::{
    cpu, fpu, global_pointers as gp, instructions_0f as sem, instructions_0f38 as sem38,
    instructions_0f3a as sem3a,
};
use crate::ir::helper::Outcome;

use super::continuation::ContinuationContext;

/// The forms of crate::cpu::simd_int::sse4 (66 0F 38)
macro_rules! sse4 {
    () => {
        0x660F3810
            | 0x660F3814
            | 0x660F3815
            | 0x660F3820..=0x660F3825
            | 0x660F3828
            | 0x660F3829
            | 0x660F382B
            | 0x660F3830..=0x660F3835
            | 0x660F3837..=0x660F3841
    };
}

unsafe fn finish(success: bool) -> u32 {
    if success {
        Outcome::Normal as u32
    }
    else {
        Outcome::ControlTransferred as u32
    }
}
#[no_mangle]
pub unsafe fn ir_sse_fp_reg_continue(
    op: u32,
    source: i32,
    destination: i32,
    immediate: i32,
) -> u32 {
    assert!((0..8).contains(&source) && (0..8).contains(&destination));
    if !cpu::task_switch_test_xmm() {
        return finish(false);
    }
    fpu::fpu_cache_barrier();
    match op {
        0x0F2A => {
            if !sem::instr_0F2A(cpu::read_mmx64s(source), destination) {
                return finish(false);
            }
        },
        0x0F2C => {
            if !sem::instr_0F2C(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0x0F2D => {
            if !sem::instr_0F2D(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0x0F2E => {
            if !sem::instr_0F2E(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0x0F2F => {
            if !sem::instr_0F2F(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0x0F51 => {
            if !sem::instr_0F51(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F52 => {
            if !sem::instr_0F52(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F53 => {
            if !sem::instr_0F53(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F58 => {
            if !sem::instr_0F58(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F59 => {
            if !sem::instr_0F59(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F5A => {
            if !sem::instr_0F5A(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0x0F5B => {
            if !sem::instr_0F5B(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F5C => {
            if !sem::instr_0F5C(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F5D => {
            if !sem::instr_0F5D(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F5E => {
            if !sem::instr_0F5E(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0F5F => {
            if !sem::instr_0F5F(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x0FC2 => {
            if !sem::instr_0FC2(cpu::read_xmm128s(source), destination, immediate) {
                return finish(false);
            }
        },
        0x660F2A => {
            if !sem::instr_660F2A(cpu::read_mmx64s(source), destination) {
                return finish(false);
            }
            cpu::transition_fpu_to_mmx();
        },
        0x660F2C => {
            if !sem::instr_660F2C(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F2D => {
            if !sem::instr_660F2D(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F2E => {
            if !sem::instr_660F2E(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0x660F2F => {
            if !sem::instr_660F2F(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0x660F51 => {
            if !sem::instr_660F51(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F58 => {
            if !sem::instr_660F58(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F59 => {
            if !sem::instr_660F59(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F5A => {
            if !sem::instr_660F5A(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F5B => {
            if !sem::instr_660F5B(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F5C => {
            if !sem::instr_660F5C(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F5D => {
            if !sem::instr_660F5D(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F5E => {
            if !sem::instr_660F5E(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F5F => {
            if !sem::instr_660F5F(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F7C => {
            if !sem::instr_660F7C(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660F7D => {
            if !sem::instr_660F7D(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660FC2 => {
            if !sem::instr_660FC2(cpu::read_xmm128s(source), destination, immediate) {
                return finish(false);
            }
        },
        0x660FD0 => {
            if !sem::instr_660FD0(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0x660FE6 => {
            if !sem::instr_660FE6(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0xF20F2A => {
            if !sem::instr_F20F2A(cpu::read_reg32(source), destination) {
                return finish(false);
            }
        },
        0xF20F2C => {
            if !sem::instr_F20F2C(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F2D => {
            if !sem::instr_F20F2D(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F51 => {
            if !sem::instr_F20F51(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F58 => {
            if !sem::instr_F20F58(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F59 => {
            if !sem::instr_F20F59(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F5A => {
            if !sem::instr_F20F5A(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F5C => {
            if !sem::instr_F20F5C(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F5D => {
            if !sem::instr_F20F5D(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F5E => {
            if !sem::instr_F20F5E(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F5F => {
            if !sem::instr_F20F5F(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0xF20F7C => {
            if !sem::instr_F20F7C(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0xF20F7D => {
            if !sem::instr_F20F7D(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0xF20FC2 => {
            if !sem::instr_F20FC2(cpu::read_xmm64s(source), destination, immediate) {
                return finish(false);
            }
        },
        0xF20FD0 => {
            if !sem::instr_F20FD0(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0xF20FE6 => {
            if !sem::instr_F20FE6(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0xF30F2A => {
            if !sem::instr_F30F2A(cpu::read_reg32(source), destination) {
                return finish(false);
            }
        },
        0xF30F2C => {
            if !sem::instr_F30F2C(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F2D => {
            if !sem::instr_F30F2D(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F51 => {
            if !sem::instr_F30F51(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F52 => {
            if !sem::instr_F30F52(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F53 => {
            if !sem::instr_F30F53(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F58 => {
            if !sem::instr_F30F58(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F59 => {
            if !sem::instr_F30F59(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F5A => {
            if !sem::instr_F30F5A(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F5B => {
            if !sem::instr_F30F5B(cpu::read_xmm128s(source), destination) {
                return finish(false);
            }
        },
        0xF30F5C => {
            if !sem::instr_F30F5C(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F5D => {
            if !sem::instr_F30F5D(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F5E => {
            if !sem::instr_F30F5E(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30F5F => {
            if !sem::instr_F30F5F(cpu::read_xmm_f32(source), destination) {
                return finish(false);
            }
        },
        0xF30FC2 => {
            if !sem::instr_F30FC2(cpu::read_xmm64s(source) as i32, destination, immediate) {
                return finish(false);
            }
        },
        0xF30FE6 => {
            if !sem::instr_F30FE6(cpu::read_xmm64s(source), destination) {
                return finish(false);
            }
        },
        0x660F3800..=0x660F380B | 0x660F381C..=0x660F381E => {
            sem38::ssse3_xmm(op as u8, cpu::read_xmm128s(source), destination);
        },
        0x660F3A0F => {
            sem3a::instr_660F3A0F(cpu::read_xmm128s(source), destination, immediate);
        },
        sse4!() => sem38::sse4_xmm(op as u8, cpu::read_xmm128s(source), destination),
        0x660F3817 => sem38::instr_660F3817(cpu::read_xmm128s(source), destination),
        0x660F3A0C..=0x660F3A0E | 0x660F3A42 => {
            sem3a::sse4_imm_xmm(op as u8, cpu::read_xmm128s(source), destination, immediate)
        },
        // (the interpreter's forms: `source` is the GPR of PEXTR*/EXTRACTPS
        // and PINSRB/PINSRD, the XMM register of INSERTPS)
        0x660F3A14 => sem3a::instr_660F3A14_reg(source, destination, immediate),
        0x660F3A15 => sem3a::instr_660F3A15_reg(source, destination, immediate),
        0x660F3A16 => sem3a::instr_660F3A16_reg(source, destination, immediate),
        0x660F3A17 => sem3a::instr_660F3A17_reg(source, destination, immediate),
        0x660F3A20 => sem3a::instr_660F3A20_reg(source, destination, immediate),
        0x660F3A21 => sem3a::instr_660F3A21_reg(source, destination, immediate),
        0x660F3A22 => sem3a::instr_660F3A22_reg(source, destination, immediate),
        _ => unreachable!("unregistered SSE FP semantic operation"),
    }
    finish(true)
}
unsafe fn memory(
    op: u32,
    offset: u32,
    segment: u32,
    destination: i32,
    immediate: i32,
) -> Result<(), ()> {
    let addr = offset.wrapping_add(cpu::get_seg(segment as i32)? as u32) as i32;
    fpu::fpu_cache_barrier();
    match op {
        0x0F2A => {
            if !sem::instr_0F2A(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0x0F2C => {
            if !sem::instr_0F2C(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0x0F2D => {
            if !sem::instr_0F2D(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0x0F2E => {
            if !sem::instr_0F2E(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0x0F2F => {
            if !sem::instr_0F2F(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0x0F51 => {
            if !sem::instr_0F51(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F52 => {
            if !sem::instr_0F52(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F53 => {
            if !sem::instr_0F53(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F58 => {
            if !sem::instr_0F58(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F59 => {
            if !sem::instr_0F59(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F5A => {
            if !sem::instr_0F5A(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0x0F5B => {
            if !sem::instr_0F5B(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F5C => {
            if !sem::instr_0F5C(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F5D => {
            if !sem::instr_0F5D(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F5E => {
            if !sem::instr_0F5E(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0F5F => {
            if !sem::instr_0F5F(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x0FC2 => {
            if !sem::instr_0FC2(cpu::safe_read128s_aligned(addr)?, destination, immediate) {
                return Err(());
            }
        },
        0x660F2A => {
            if !sem::instr_660F2A(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0x660F2C => {
            if !sem::instr_660F2C(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F2D => {
            if !sem::instr_660F2D(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F2E => {
            if !sem::instr_660F2E(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0x660F2F => {
            if !sem::instr_660F2F(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0x660F51 => {
            if !sem::instr_660F51(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F58 => {
            if !sem::instr_660F58(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F59 => {
            if !sem::instr_660F59(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F5A => {
            if !sem::instr_660F5A(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F5B => {
            if !sem::instr_660F5B(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F5C => {
            if !sem::instr_660F5C(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F5D => {
            if !sem::instr_660F5D(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F5E => {
            if !sem::instr_660F5E(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F5F => {
            if !sem::instr_660F5F(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F7C => {
            if !sem::instr_660F7C(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660F7D => {
            if !sem::instr_660F7D(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660FC2 => {
            if !sem::instr_660FC2(cpu::safe_read128s_aligned(addr)?, destination, immediate) {
                return Err(());
            }
        },
        0x660FD0 => {
            if addr & 15 != 0 {
                cpu::trigger_gp(0);
                return Err(());
            }
            if !sem::instr_660FD0(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0x660FE6 => {
            if !sem::instr_660FE6(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F2A => {
            if !sem::instr_F20F2A(cpu::safe_read32s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F2C => {
            if !sem::instr_F20F2C(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F2D => {
            if !sem::instr_F20F2D(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F51 => {
            if !sem::instr_F20F51(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F58 => {
            if !sem::instr_F20F58(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F59 => {
            if !sem::instr_F20F59(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F5A => {
            if !sem::instr_F20F5A(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F5C => {
            if !sem::instr_F20F5C(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F5D => {
            if !sem::instr_F20F5D(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F5E => {
            if !sem::instr_F20F5E(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F5F => {
            if !sem::instr_F20F5F(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F7C => {
            if !sem::instr_F20F7C(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0xF20F7D => {
            if !sem::instr_F20F7D(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0xF20FC2 => {
            if !sem::instr_F20FC2(cpu::safe_read64s(addr)?, destination, immediate) {
                return Err(());
            }
        },
        0xF20FD0 => {
            if addr & 15 != 0 {
                cpu::trigger_gp(0);
                return Err(());
            }
            if !sem::instr_F20FD0(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0xF20FE6 => {
            if !sem::instr_F20FE6(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F2A => {
            if !sem::instr_F30F2A(cpu::safe_read32s(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F2C => {
            if !sem::instr_F30F2C(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F2D => {
            if !sem::instr_F30F2D(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F51 => {
            if !sem::instr_F30F51(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F52 => {
            if !sem::instr_F30F52(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F53 => {
            if !sem::instr_F30F53(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F58 => {
            if !sem::instr_F30F58(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F59 => {
            if !sem::instr_F30F59(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F5A => {
            if !sem::instr_F30F5A(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F5B => {
            if !sem::instr_F30F5B(cpu::safe_read128s_aligned(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F5C => {
            if !sem::instr_F30F5C(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F5D => {
            if !sem::instr_F30F5D(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F5E => {
            if !sem::instr_F30F5E(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30F5F => {
            if !sem::instr_F30F5F(cpu::safe_read_f32(addr)?, destination) {
                return Err(());
            }
        },
        0xF30FC2 => {
            if !sem::instr_F30FC2(cpu::safe_read32s(addr)?, destination, immediate) {
                return Err(());
            }
        },
        0xF30FE6 => {
            if !sem::instr_F30FE6(cpu::safe_read64s(addr)?, destination) {
                return Err(());
            }
        },
        0x660F3800..=0x660F380B | 0x660F381C..=0x660F381E => {
            sem38::ssse3_xmm(op as u8, cpu::safe_read128s_aligned(addr)?, destination);
        },
        0x660F3A0F => {
            sem3a::instr_660F3A0F(cpu::safe_read128s_aligned(addr)?, destination, immediate);
        },
        sse4!() => sem38::sse4_xmm(op as u8, sem38::sse4_source(op as u8, addr)?, destination),
        0x660F3817 => sem38::instr_660F3817(cpu::safe_read128s_aligned(addr)?, destination),
        0x660F382A => cpu::write_xmm_reg128(destination, cpu::safe_read128s_aligned(addr)?),
        0x660F3A0C..=0x660F3A0E | 0x660F3A42 => sem3a::sse4_imm_xmm(
            op as u8,
            cpu::safe_read128s_aligned(addr)?,
            destination,
            immediate,
        ),
        0x660F3A14 => cpu::safe_write8(addr, sem3a::extract(destination, 1, immediate) as i32)?,
        0x660F3A15 => cpu::safe_write16(addr, sem3a::extract(destination, 2, immediate) as i32)?,
        0x660F3A16 | 0x660F3A17 => {
            cpu::safe_write32(addr, sem3a::extract(destination, 4, immediate) as i32)?
        },
        0x660F3A20 => sem3a::insert(destination, 1, cpu::safe_read8(addr)? as u32, immediate),
        0x660F3A21 => {
            sem3a::instr_660F3A21(cpu::safe_read32s(addr)? as u32, destination, immediate)
        },
        0x660F3A22 => sem3a::insert(destination, 4, cpu::safe_read32s(addr)? as u32, immediate),
        _ => unreachable!("unregistered SSE FP semantic operation"),
    }
    Ok(())
}
#[no_mangle]
pub unsafe fn ir_sse_fp_mem_continue(
    op: u32,
    offset: u32,
    segment: u32,
    destination: i32,
    immediate: i32,
) -> u32 {
    assert!(segment < 6 && (0..8).contains(&destination));
    if !cpu::task_switch_test_xmm() {
        return finish(false);
    }
    let before = ContinuationContext::capture();
    if memory(op, offset, segment, destination, immediate).is_err() {
        return finish(false);
    }
    if before.epoch != u64::MAX && before.matches_current() {
        Outcome::Normal as u32
    }
    else {
        // A synchronous observer can reset the VM, remap code, alter execution
        // context or invalidate a compiled dependency. The completed operation
        // retires once, and the CPU remains authoritative at the cold boundary.
        terminal(Outcome::Normal as u32)
    }
}

unsafe fn terminal(outcome: u32) -> u32 {
    if outcome == Outcome::Normal as u32 {
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        Outcome::Invalidated as u32
    }
    else {
        outcome
    }
}
#[no_mangle]
pub unsafe fn ir_sse_fp_reg(op: u32, source: i32, destination: i32, immediate: i32) -> u32 {
    terminal(ir_sse_fp_reg_continue(op, source, destination, immediate))
}
#[no_mangle]
pub unsafe fn ir_sse_fp_mem(
    op: u32,
    offset: u32,
    segment: u32,
    destination: i32,
    immediate: i32,
) -> u32 {
    terminal(ir_sse_fp_mem_continue(
        op,
        offset,
        segment,
        destination,
        immediate,
    ))
}
