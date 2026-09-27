//! Audited state-changing CPU adapters. Operand memory access stays in HIR.
use crate::cpu::{cpu, global_pointers as gp, misc_instr};
use crate::ir::helper::Outcome;
#[no_mangle]
pub unsafe fn ir_flags_stack_check() -> u32 {
    if *gp::flags & cpu::FLAG_VM != 0 && cpu::getiopl() < 3 {
        cpu::trigger_gp(0);
        Outcome::ControlTransferred as u32
    }
    else {
        Outcome::Normal as u32
    }
}
#[no_mangle]
pub unsafe fn ir_pop_flags(value: u32, bytes: u32) -> u32 {
    assert!(matches!(bytes, 2 | 4));
    let old_flags = *gp::flags;
    let value = if bytes == 2 { old_flags & !65535 | value as i32 & 65535 } else { value as i32 };
    misc_instr::adjust_stack_reg(bytes as i32);
    cpu::update_eflags(value);
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    if old_flags & cpu::FLAG_INTERRUPT == 0 && *gp::flags & cpu::FLAG_INTERRUPT != 0 {
        cpu::handle_irqs();
    }
    Outcome::Invalidated as u32
}
#[no_mangle]
pub unsafe fn ir_pop_segment(value: u32, segment: u32, bytes: u32) -> u32 {
    assert!(segment < 6 && segment != 1 && matches!(bytes, 2 | 4));
    if !cpu::switch_seg(segment as i32, (value & 65535) as i32) {
        return Outcome::ControlTransferred as u32;
    }
    // POP SS adjusts using the newly loaded stack width, just like the baseline.
    misc_instr::adjust_stack_reg(bytes as i32);
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}

/// Segment validation can fault; the GPR result is committed only after success.
/// A zero data width denotes MOV Sreg and leaves all GPRs unchanged.
#[no_mangle]
pub unsafe fn ir_load_segment(
    selector: u32,
    segment: u32,
    register: u32,
    value: u32,
    bytes: u32,
) -> u32 {
    assert!(
        segment < 6 && segment != 1 && register < 8 && matches!(bytes, 0 | 2 | 4)
    );
    if !cpu::switch_seg(segment as i32, (selector & 65535) as i32) {
        return Outcome::ControlTransferred as u32;
    }
    match bytes {
        2 => cpu::write_reg16(register as i32, value as i32),
        4 => cpu::write_reg32(register as i32, value as i32),
        _ => (),
    }
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}

/// Only real/VM86 MOV Sreg may continue: this path changes segment backing,
/// never observes memory/host state, and preserves every HIR GPR/FLAGS value.
/// Protected-mode descriptor walks keep the terminal, precise-state contract.
#[no_mangle]
pub unsafe fn ir_mov_segment_continue(selector: u32, segment: u32) -> u32 {
    assert!(segment < 6 && segment != 1);
    if !*gp::protected_mode || cpu::vm86_mode() {
        assert!(cpu::switch_seg(segment as i32, (selector & 65535) as i32));
        Outcome::Normal as u32
    }
    else {
        ir_load_segment(selector, segment, 0, 0, 0)
    }
}
