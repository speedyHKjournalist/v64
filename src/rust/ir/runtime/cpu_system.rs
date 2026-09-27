//! Explicit terminal adapters for privilege and execution-context changes.
use crate::cpu::{cpu, global_pointers as gp, instructions, instructions_0f};
use crate::ir::helper::Outcome;

unsafe fn commit() -> u32 {
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
unsafe fn gp_fault() -> u32 {
    cpu::trigger_gp(0);
    Outcome::ControlTransferred as u32
}
#[no_mangle]
pub unsafe fn ir_cli() -> u32 {
    // Reuse the CPU's explicit success predicate (including its VME/PVI policy).
    if !instructions::instr_FA_without_fault() {
        return gp_fault();
    }
    commit()
}
#[no_mangle]
pub unsafe fn ir_clts() -> u32 {
    if *gp::cpl != 0 {
        return gp_fault();
    }
    instructions_0f::instr_0F06();
    commit()
}
#[no_mangle]
pub unsafe fn ir_wbinvd() -> u32 {
    if *gp::cpl != 0 {
        return gp_fault();
    }
    instructions_0f::instr_0F09();
    commit()
}
#[no_mangle]
pub unsafe fn ir_sysenter() -> u32 {
    // The audited body has no guest-fault path after this guard. It owns CS/SS,
    // mode/CPL, flags, ESP/EIP and fetch-context invalidation on success.
    if !*gp::protected_mode || *gp::sysenter_cs & 0xFFFC == 0 {
        return gp_fault();
    }
    instructions_0f::instr_0F34();
    commit()
}
#[no_mangle]
pub unsafe fn ir_sysexit() -> u32 {
    if !*gp::protected_mode || *gp::cpl != 0 || *gp::sysenter_cs & 0xFFFC == 0 {
        return gp_fault();
    }
    instructions_0f::instr_0F35();
    commit()
}

#[no_mangle]
pub unsafe fn ir_hlt() -> u32 {
    if *gp::cpl != 0 {
        return gp_fault();
    }
    // The CPU owns in_hlt, timer observation, halt notification and immediate IRQ
    // delivery. Commit after those observations, matching the semantic body.
    instructions::instr_F4();
    commit()
}

/// Only check privilege here. HIR changes IF after Normal, retaining its SSA flags.
#[no_mangle]
pub unsafe fn ir_sti_check() -> u32 {
    if !*gp::protected_mode
        || if cpu::vm86_mode() { cpu::getiopl() == 3 } else { cpu::getiopl() >= *gp::cpl as i32 }
    {
        Outcome::Normal as u32
    }
    else {
        gp_fault()
    }
}
/// Every completed STI scope observes IRQs after its shadow instruction, even
/// when that instruction delivers a guest fault. Nested STIs unwind in order.
#[no_mangle]
pub unsafe fn ir_sti_finish(depth: u32) {
    assert!(depth <= 128);
    for _ in 0..depth {
        cpu::handle_irqs();
    }
}
/// The shadow has completed normally and its full state is already committed.
/// Observe IRQs before considering a successor; never carry SSA state across it.
#[no_mangle]
pub unsafe fn ir_sti_finish_link(depth: u32) {
    let ip = *gp::instruction_pointer as u32;
    let cs = cpu::get_seg_cs() as u32;
    let mode = u32::from(*gp::is_32);
    let cpl = *gp::cpl;
    let flags = *gp::flags & (cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM);
    super::entry::ir_admission_barrier();
    ir_sti_finish(depth);
    if super::entry::ir_entry_matches(ip, cs, mode)
        && *gp::cpl == cpl
        && *gp::flags & (cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM) == flags
    {
        super::entry::ir_request_observer_link();
    }
}

/// No acknowledge, host callback, FLAGS change, or CPU state materialization.
/// The emitter may discard a completed shadow scope only when this is true.
#[no_mangle]
pub unsafe fn ir_sti_no_pending_irq() -> bool {
    super::continuation::no_pending_irq()
}
/// Slow completed-shadow path. Its AfterInstruction snapshot has already
/// retired STI and its shadow. IRQ delivery owns post-state; never resume SSA.
#[no_mangle]
pub unsafe fn ir_sti_finish_continue(depth: u32) -> u32 {
    ir_sti_finish_link(depth);
    Outcome::Invalidated as u32
}

/// Catalogue-invalid operands still perform the baseline task/segment guards.
/// Missing group selectors have no guards or EA (the interpreter rejects sooner).
#[no_mangle]
pub unsafe fn ir_invalid_form(guard: u32, offset: u32, segment: u32) -> u32 {
    assert!(guard <= 2 && (segment < 6 || segment == u32::MAX));
    if guard == 1 && !cpu::task_switch_test() || guard == 2 && !cpu::task_switch_test_mmx() {
        return Outcome::ControlTransferred as u32;
    }
    if segment != u32::MAX && super::memory::ir_segment_address(offset, segment) >> 32 != 0 {
        return Outcome::ControlTransferred as u32;
    }
    cpu::trigger_ud();
    Outcome::ControlTransferred as u32
}

/// CLI uses the same pinned privilege predicate as STI; HIR owns clearing IF
/// after success, so GPR and lazy arithmetic state remain live across the call.
#[no_mangle]
pub unsafe fn ir_cli_check() -> u32 { ir_sti_check() }
