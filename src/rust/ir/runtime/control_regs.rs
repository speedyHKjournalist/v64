//! Audited CR/DR bodies retain mode, translation and debug assertion policy.
use crate::cpu::{cpu, global_pointers as gp, instructions_0f};
use crate::ir::helper::Outcome;
unsafe fn permission(r: u32, index: u32) -> bool {
    assert!(r < 8 && index < 8);
    if *gp::cpl != 0 {
        cpu::trigger_gp(0);
        false
    }
    else {
        true
    }
}
unsafe fn finish(fault: bool) -> u32 {
    if fault {
        Outcome::ControlTransferred as u32
    }
    else {
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        Outcome::Invalidated as u32
    }
}
#[no_mangle]
pub unsafe fn ir_read_cr(r: u32, index: u32) -> u32 {
    let outcome = ir_read_cr_continue(r, index);
    if outcome == Outcome::Normal as u32 {
        finish(false)
    }
    else {
        outcome
    }
}
/// Successful reads only change one GPR. CpuReload exposes that result to SSA;
/// the caller retires on Normal, while the CPU owns every fault/debug outcome.
#[no_mangle]
pub unsafe fn ir_read_cr_continue(r: u32, index: u32) -> u32 {
    if !permission(r, index) {
        return Outcome::ControlTransferred as u32;
    }
    let fault = !matches!(index, 0 | 2 | 3 | 4);
    // Invalid indices keep the body's debug abort / release #UD behavior.
    instructions_0f::instr_0F20(r as i32, index as i32);
    if fault {
        Outcome::ControlTransferred as u32
    }
    else {
        Outcome::Normal as u32
    }
}
#[no_mangle]
pub unsafe fn ir_write_cr(r: u32, index: u32) -> u32 {
    if !permission(r, index) {
        return Outcome::ControlTransferred as u32;
    }
    // The body reports its delivered faults (#GP from reserved CR4 bits, PG
    // without PE and the long-mode checks; #UD from invalid indices).
    // CR0/CR3/PDPTE debug assertions can still trap, including partially
    // updated CPU state, before finish is reached. Never infer a fault from a
    // possibly unchanged EIP.
    let delivered = !instructions_0f::mov_to_cr(r as i32, index as i32);
    finish(delivered)
}
unsafe fn debug_alias_fault(index: u32) -> bool {
    matches!(index, 4 | 5) && *gp::cr.add(4) & cpu::CR4_DE != 0
}
#[no_mangle]
pub unsafe fn ir_read_dr(r: u32, index: u32) -> u32 {
    let outcome = ir_read_dr_continue(r, index);
    if outcome == Outcome::Normal as u32 {
        finish(false)
    }
    else {
        outcome
    }
}
#[no_mangle]
pub unsafe fn ir_read_dr_continue(r: u32, index: u32) -> u32 {
    if !permission(r, index) {
        return Outcome::ControlTransferred as u32;
    }
    let fault = debug_alias_fault(index);
    instructions_0f::instr_0F21(r as i32, index as i32);
    if fault {
        Outcome::ControlTransferred as u32
    }
    else {
        Outcome::Normal as u32
    }
}
#[no_mangle]
pub unsafe fn ir_write_dr(r: u32, index: u32) -> u32 {
    if !permission(r, index) {
        return Outcome::ControlTransferred as u32;
    }
    let fault = debug_alias_fault(index);
    instructions_0f::instr_0F23(r as i32, index as i32);
    finish(fault)
}
