//! Checked MMX adapters preserve x87 aliasing and tag transitions on completion.
use crate::cpu::{
    cpu, fpu, global_pointers as gp, instructions_0f as sem, instructions_0f38 as sem38,
    instructions_0f3a as sem3a,
};
use crate::ir::helper::Outcome;
unsafe fn finish(success: bool) -> u32 {
    if success {
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        Outcome::Invalidated as u32
    }
    else {
        Outcome::ControlTransferred as u32
    }
}
unsafe fn register(op: u32, source: i32, destination: i32, immediate: i32) -> u32 {
    assert!((0..8).contains(&source) && (0..8).contains(&destination));
    // The baseline debug guard logs through a host import when OSFXSR is off.
    // That observer may change code, context or XMMs. Revoke certificates before
    // it runs and retain CPU-owned post-state via a terminal success below.
    let observes = cfg!(debug_assertions) && *gp::cr.add(4) & cpu::CR4_OSFXSR == 0;
    if observes {
        super::entry::ir_admission_barrier();
    }
    if !cpu::task_switch_test_mmx() {
        return finish(false);
    }
    fpu::fpu_cache_barrier();
    match op {
        0x0F60 => sem::instr_0F60(cpu::read_mmx32s(source), destination),
        0x0F61 => sem::instr_0F61(cpu::read_mmx32s(source), destination),
        0x0F62 => sem::instr_0F62(cpu::read_mmx32s(source), destination),
        0x0F63 => sem::instr_0F63(cpu::read_mmx64s(source), destination),
        0x0F64 => sem::instr_0F64(cpu::read_mmx64s(source), destination),
        0x0F65 => sem::instr_0F65(cpu::read_mmx64s(source), destination),
        0x0F66 => sem::instr_0F66(cpu::read_mmx64s(source), destination),
        0x0F67 => sem::instr_0F67(cpu::read_mmx64s(source), destination),
        0x0F68 => sem::instr_0F68(cpu::read_mmx64s(source), destination),
        0x0F69 => sem::instr_0F69(cpu::read_mmx64s(source), destination),
        0x0F6A => sem::instr_0F6A(cpu::read_mmx64s(source), destination),
        0x0F6B => sem::instr_0F6B(cpu::read_mmx64s(source), destination),
        0x0F6E => sem::instr_0F6E(cpu::read_reg32(source), destination),
        0x0F6F => sem::instr_0F6F(cpu::read_mmx64s(source), destination),
        0x0F70 => sem::instr_0F70(cpu::read_mmx64s(source), destination, immediate),
        0x0F74 => sem::instr_0F74(cpu::read_mmx64s(source), destination),
        0x0F75 => sem::instr_0F75(cpu::read_mmx64s(source), destination),
        0x0F76 => sem::instr_0F76(cpu::read_mmx64s(source), destination),
        0x0FC4 => sem::instr_0FC4(cpu::read_reg32(source), destination, immediate),
        0x0FD1 => sem::instr_0FD1(cpu::read_mmx64s(source), destination),
        0x0FD2 => sem::instr_0FD2(cpu::read_mmx64s(source), destination),
        0x0FD3 => sem::instr_0FD3(cpu::read_mmx64s(source), destination),
        0x0FD4 => sem::instr_0FD4(cpu::read_mmx64s(source), destination),
        0x0FD5 => sem::instr_0FD5(cpu::read_mmx64s(source), destination),
        0x0FD8 => sem::instr_0FD8(cpu::read_mmx64s(source), destination),
        0x0FD9 => sem::instr_0FD9(cpu::read_mmx64s(source), destination),
        0x0FDA => sem::instr_0FDA(cpu::read_mmx64s(source), destination),
        0x0FDB => sem::instr_0FDB(cpu::read_mmx64s(source), destination),
        0x0FDC => sem::instr_0FDC(cpu::read_mmx64s(source), destination),
        0x0FDD => sem::instr_0FDD(cpu::read_mmx64s(source), destination),
        0x0FDE => sem::instr_0FDE(cpu::read_mmx64s(source), destination),
        0x0FDF => sem::instr_0FDF(cpu::read_mmx64s(source), destination),
        0x0FE0 => sem::instr_0FE0(cpu::read_mmx64s(source), destination),
        0x0FE1 => sem::instr_0FE1(cpu::read_mmx64s(source), destination),
        0x0FE2 => sem::instr_0FE2(cpu::read_mmx64s(source), destination),
        0x0FE3 => sem::instr_0FE3(cpu::read_mmx64s(source), destination),
        0x0FE4 => sem::instr_0FE4(cpu::read_mmx64s(source), destination),
        0x0FE5 => sem::instr_0FE5(cpu::read_mmx64s(source), destination),
        0x0FE8 => sem::instr_0FE8(cpu::read_mmx64s(source), destination),
        0x0FE9 => sem::instr_0FE9(cpu::read_mmx64s(source), destination),
        0x0FEA => sem::instr_0FEA(cpu::read_mmx64s(source), destination),
        0x0FEB => sem::instr_0FEB(cpu::read_mmx64s(source), destination),
        0x0FEC => sem::instr_0FEC(cpu::read_mmx64s(source), destination),
        0x0FED => sem::instr_0FED(cpu::read_mmx64s(source), destination),
        0x0FEE => sem::instr_0FEE(cpu::read_mmx64s(source), destination),
        0x0FEF => sem::instr_0FEF(cpu::read_mmx64s(source), destination),
        0x0FF1 => sem::instr_0FF1(cpu::read_mmx64s(source), destination),
        0x0FF2 => sem::instr_0FF2(cpu::read_mmx64s(source), destination),
        0x0FF3 => sem::instr_0FF3(cpu::read_mmx64s(source), destination),
        0x0FF4 => sem::instr_0FF4(cpu::read_mmx64s(source), destination),
        0x0FF5 => sem::instr_0FF5(cpu::read_mmx64s(source), destination),
        0x0FF6 => sem::instr_0FF6(cpu::read_mmx64s(source), destination),
        0x0FF8 => sem::instr_0FF8(cpu::read_mmx64s(source), destination),
        0x0FF9 => sem::instr_0FF9(cpu::read_mmx64s(source), destination),
        0x0FFA => sem::instr_0FFA(cpu::read_mmx64s(source), destination),
        0x0FFB => sem::instr_0FFB(cpu::read_mmx64s(source), destination),
        0x0FFC => sem::instr_0FFC(cpu::read_mmx64s(source), destination),
        0x0FFD => sem::instr_0FFD(cpu::read_mmx64s(source), destination),
        0x0FFE => sem::instr_0FFE(cpu::read_mmx64s(source), destination),
        0x2000F71 => sem::instr_0F71_2_reg(source, immediate),
        0x4000F71 => sem::instr_0F71_4_reg(source, immediate),
        0x6000F71 => sem::instr_0F71_6_reg(source, immediate),
        0x2000F72 => sem::instr_0F72_2_reg(source, immediate),
        0x4000F72 => sem::instr_0F72_4_reg(source, immediate),
        0x6000F72 => sem::instr_0F72_6_reg(source, immediate),
        0x2000F73 => sem::instr_0F73_2_reg(source, immediate),
        0x6000F73 => sem::instr_0F73_6_reg(source, immediate),
        0x0F77 => sem::instr_0F77(),
        0x0F7E => {
            cpu::write_reg32(source, cpu::read_mmx32s(destination));
            cpu::transition_fpu_to_mmx();
        },
        0x0F7F => {
            cpu::write_mmx_reg64(source, cpu::read_mmx64s(destination));
            cpu::transition_fpu_to_mmx();
        },
        0x0FC5 => sem::instr_0FC5_reg(source, destination, immediate),
        0x0FD7 => cpu::write_reg32(destination, sem::instr_0FD7(source)),
        0xF20FD6 => sem::instr_F20FD6_reg(source, destination),
        0xF30FD6 => sem::instr_F30FD6_reg(source, destination),
        0x0F3800..=0x0F380B | 0x0F381C..=0x0F381E => {
            sem38::ssse3_mmx(op as u8, cpu::read_mmx64s(source), destination)
        },
        0x0F3A0F => sem3a::instr_0F3A0F(cpu::read_mmx64s(source), destination, immediate),
        _ => unreachable!("unregistered MMX operation"),
    }
    // All register semantics preserve the execution context. Retirement stays
    // with the generated continuation, and canonical F80 holds MMX/x87 aliases.
    if observes {
        finish(true)
    }
    else {
        Outcome::Normal as u32
    }
}
#[no_mangle]
pub unsafe fn ir_mmx_reg_continue(op: u32, source: i32, destination: i32, immediate: i32) -> u32 {
    // A scalar reload must never conceal an XMM write. Cross-register-file
    // transfers have a separate full-state reload ABI even for XMM reads.
    assert!(!matches!(op, 0xF20FD6 | 0xF30FD6));
    register(op, source, destination, immediate)
}
#[no_mangle]
pub unsafe fn ir_mmx_xmm_continue(op: u32, source: i32, destination: i32, immediate: i32) -> u32 {
    assert!(matches!(op, 0xF20FD6 | 0xF30FD6));
    register(op, source, destination, immediate)
}
#[no_mangle]
pub unsafe fn ir_mmx_reg(op: u32, source: i32, destination: i32, immediate: i32) -> u32 {
    let outcome = register(op, source, destination, immediate);
    if outcome == Outcome::Normal as u32 {
        finish(true)
    }
    else {
        outcome
    }
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
        0x0F60 => sem::instr_0F60(cpu::safe_read32s(addr)?, destination),
        0x0F61 => sem::instr_0F61(cpu::safe_read32s(addr)?, destination),
        0x0F62 => sem::instr_0F62(cpu::safe_read32s(addr)?, destination),
        0x0F63 => sem::instr_0F63(cpu::safe_read64s(addr)?, destination),
        0x0F64 => sem::instr_0F64(cpu::safe_read64s(addr)?, destination),
        0x0F65 => sem::instr_0F65(cpu::safe_read64s(addr)?, destination),
        0x0F66 => sem::instr_0F66(cpu::safe_read64s(addr)?, destination),
        0x0F67 => sem::instr_0F67(cpu::safe_read64s(addr)?, destination),
        0x0F68 => sem::instr_0F68(cpu::safe_read64s(addr)?, destination),
        0x0F69 => sem::instr_0F69(cpu::safe_read64s(addr)?, destination),
        0x0F6A => sem::instr_0F6A(cpu::safe_read64s(addr)?, destination),
        0x0F6B => sem::instr_0F6B(cpu::safe_read64s(addr)?, destination),
        0x0F6E => sem::instr_0F6E(cpu::safe_read32s(addr)?, destination),
        0x0F6F => sem::instr_0F6F(cpu::safe_read64s(addr)?, destination),
        0x0F70 => sem::instr_0F70(cpu::safe_read64s(addr)?, destination, immediate),
        0x0F74 => sem::instr_0F74(cpu::safe_read64s(addr)?, destination),
        0x0F75 => sem::instr_0F75(cpu::safe_read64s(addr)?, destination),
        0x0F76 => sem::instr_0F76(cpu::safe_read64s(addr)?, destination),
        0x0FC4 => sem::instr_0FC4(cpu::safe_read16(addr)?, destination, immediate),
        0x0FD1 => sem::instr_0FD1(cpu::safe_read64s(addr)?, destination),
        0x0FD2 => sem::instr_0FD2(cpu::safe_read64s(addr)?, destination),
        0x0FD3 => sem::instr_0FD3(cpu::safe_read64s(addr)?, destination),
        0x0FD4 => sem::instr_0FD4(cpu::safe_read64s(addr)?, destination),
        0x0FD5 => sem::instr_0FD5(cpu::safe_read64s(addr)?, destination),
        0x0FD8 => sem::instr_0FD8(cpu::safe_read64s(addr)?, destination),
        0x0FD9 => sem::instr_0FD9(cpu::safe_read64s(addr)?, destination),
        0x0FDA => sem::instr_0FDA(cpu::safe_read64s(addr)?, destination),
        0x0FDB => sem::instr_0FDB(cpu::safe_read64s(addr)?, destination),
        0x0FDC => sem::instr_0FDC(cpu::safe_read64s(addr)?, destination),
        0x0FDD => sem::instr_0FDD(cpu::safe_read64s(addr)?, destination),
        0x0FDE => sem::instr_0FDE(cpu::safe_read64s(addr)?, destination),
        0x0FDF => sem::instr_0FDF(cpu::safe_read64s(addr)?, destination),
        0x0FE0 => sem::instr_0FE0(cpu::safe_read64s(addr)?, destination),
        0x0FE1 => sem::instr_0FE1(cpu::safe_read64s(addr)?, destination),
        0x0FE2 => sem::instr_0FE2(cpu::safe_read64s(addr)?, destination),
        0x0FE3 => sem::instr_0FE3(cpu::safe_read64s(addr)?, destination),
        0x0FE4 => sem::instr_0FE4(cpu::safe_read64s(addr)?, destination),
        0x0FE5 => sem::instr_0FE5(cpu::safe_read64s(addr)?, destination),
        0x0FE8 => sem::instr_0FE8(cpu::safe_read64s(addr)?, destination),
        0x0FE9 => sem::instr_0FE9(cpu::safe_read64s(addr)?, destination),
        0x0FEA => sem::instr_0FEA(cpu::safe_read64s(addr)?, destination),
        0x0FEB => sem::instr_0FEB(cpu::safe_read64s(addr)?, destination),
        0x0FEC => sem::instr_0FEC(cpu::safe_read64s(addr)?, destination),
        0x0FED => sem::instr_0FED(cpu::safe_read64s(addr)?, destination),
        0x0FEE => sem::instr_0FEE(cpu::safe_read64s(addr)?, destination),
        0x0FEF => sem::instr_0FEF(cpu::safe_read64s(addr)?, destination),
        0x0FF1 => sem::instr_0FF1(cpu::safe_read64s(addr)?, destination),
        0x0FF2 => sem::instr_0FF2(cpu::safe_read64s(addr)?, destination),
        0x0FF3 => sem::instr_0FF3(cpu::safe_read64s(addr)?, destination),
        0x0FF4 => sem::instr_0FF4(cpu::safe_read64s(addr)?, destination),
        0x0FF5 => sem::instr_0FF5(cpu::safe_read64s(addr)?, destination),
        0x0FF6 => sem::instr_0FF6(cpu::safe_read64s(addr)?, destination),
        0x0FF8 => sem::instr_0FF8(cpu::safe_read64s(addr)?, destination),
        0x0FF9 => sem::instr_0FF9(cpu::safe_read64s(addr)?, destination),
        0x0FFA => sem::instr_0FFA(cpu::safe_read64s(addr)?, destination),
        0x0FFB => sem::instr_0FFB(cpu::safe_read64s(addr)?, destination),
        0x0FFC => sem::instr_0FFC(cpu::safe_read64s(addr)?, destination),
        0x0FFD => sem::instr_0FFD(cpu::safe_read64s(addr)?, destination),
        0x0FFE => sem::instr_0FFE(cpu::safe_read64s(addr)?, destination),
        0x0F7E => {
            cpu::safe_write32(addr, cpu::read_mmx32s(destination))?;
            cpu::transition_fpu_to_mmx();
        },
        0x0F7F | 0x0FE7 => {
            cpu::safe_write64(addr, cpu::read_mmx64s(destination))?;
            cpu::transition_fpu_to_mmx();
        },
        0x0F3800..=0x0F380B | 0x0F381C..=0x0F381E => {
            sem38::ssse3_mmx(op as u8, cpu::safe_read64s(addr)?, destination)
        },
        0x0F3A0F => sem3a::instr_0F3A0F(cpu::safe_read64s(addr)?, destination, immediate),
        _ => unreachable!("unregistered MMX operation"),
    }
    Ok(())
}
#[no_mangle]
pub unsafe fn ir_mmx_mem(
    op: u32,
    offset: u32,
    segment: u32,
    destination: i32,
    immediate: i32,
) -> u32 {
    assert!(segment < 6 && (0..8).contains(&destination));
    if !cpu::task_switch_test_mmx() {
        return finish(false);
    }
    finish(memory(op, offset, segment, destination, immediate).is_ok())
}
#[no_mangle]
pub unsafe fn ir_mmx_mask(offset: u32, segment: u32, mask: i32, source: i32) -> u32 {
    assert!(segment < 6 && (0..8).contains(&mask) && (0..8).contains(&source));
    if !cpu::task_switch_test_mmx() {
        return finish(false);
    }
    let Ok(base) = cpu::get_seg(segment as i32)
    else {
        return finish(false);
    };
    let addr = offset.wrapping_add(base as u32) as i32;
    if cpu::writable_or_pagefault(addr, 8).is_err() {
        return finish(false);
    }
    fpu::fpu_cache_barrier();
    sem::maskmovq(mask, source, addr);
    finish(true)
}
