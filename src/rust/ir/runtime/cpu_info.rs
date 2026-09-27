//! Audited cold CPU helpers; the pinned CPU owns identification/MSR/TSC policy.
use crate::cpu::{cpu, global_pointers as gp, instructions_0f};
use crate::ir::helper::Outcome;
unsafe fn commit() -> u32 {
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
unsafe fn ring0() -> bool {
    if *gp::cpl != 0 {
        cpu::trigger_gp(0);
        false
    }
    else {
        true
    }
}
#[no_mangle]
pub unsafe fn ir_cpuid() -> u32 {
    // The pinned debug body logs most leaves through the host. Revoke before
    // observing it, even for callers using the terminal (CpuExit) adapter.
    #[cfg(debug_assertions)]
    if !matches!(*gp::reg32 as u32, 0 | 2 | 0x80000000) {
        super::entry::ir_admission_barrier();
    }
    instructions_0f::instr_0FA2();
    commit()
}
/// CPUID preserves execution context and XMM state when it cannot log. The
/// debug observer path owns completed post-state and never returns to SSA.
#[no_mangle]
pub unsafe fn ir_cpuid_continue() -> u32 {
    #[cfg(debug_assertions)]
    if !matches!(*gp::reg32 as u32, 0 | 2 | 0x80000000) {
        return ir_cpuid();
    }
    instructions_0f::instr_0FA2();
    Outcome::Normal as u32
}
#[no_mangle]
pub unsafe fn ir_rdtsc() -> u32 {
    if *gp::cpl != 0 && *gp::cr.offset(4) & cpu::CR4_TSD != 0 {
        cpu::trigger_gp(0);
        return Outcome::ControlTransferred as u32;
    }
    instructions_0f::instr_0F31();
    commit()
}
/// Only an unchanged active code/context certificate authorizes SSA resumption.
#[no_mangle]
pub unsafe fn ir_rdtsc_continue() -> u32 {
    if *gp::cpl != 0 && *gp::cr.offset(4) & cpu::CR4_TSD != 0 {
        cpu::trigger_gp(0);
        return Outcome::ControlTransferred as u32;
    }
    // Under the notified contract the only host import of a release RDTSC is
    // the monotonic clock: it cannot write guest RAM, CPU state or IRQ lines.
    // Strict mode, debug logging and timing diagnostics keep the full observer.
    if !cfg!(debug_assertions)
        && !super::cache::strict_validation()
        && !super::diagnostics::enabled()
    {
        let quiet = super::continuation::no_pending_irq();
        instructions_0f::instr_0F31();
        if quiet && super::continuation::no_pending_irq() {
            return Outcome::Normal as u32;
        }
        return commit();
    }
    let observer = super::continuation::ScalarObserver::capture();
    instructions_0f::instr_0F31();
    observer.finish()
}
#[no_mangle]
pub unsafe fn ir_rdmsr() -> u32 {
    if !ring0() {
        return Outcome::ControlTransferred as u32;
    }
    // The audited body has no delivered faults after its CPL check. Unknown
    // indices retain its debug abort / release zero-result policy.
    instructions_0f::instr_0F32();
    commit()
}
#[no_mangle]
pub unsafe fn ir_wrmsr() -> u32 {
    if !ring0() {
        return Outcome::ControlTransferred as u32;
    }
    // APIC restrictions and unknown-index debug assertions remain CPU-owned.
    instructions_0f::instr_0F30();
    commit()
}
#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_tsc_reset(offset: u64) {
    cpu::tsc_offset = offset;
    cpu::tsc_last_value = 0;
    cpu::tsc_resolution = u64::MAX;
    cpu::tsc_number_of_same_readings = 0;
    cpu::tsc_speed = 1;
    #[cfg(debug_assertions)]
    {
        cpu::tsc_last_extra = 0;
    }
}
#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_tsc_state(field: u32) -> u64 {
    match field {
        0 => cpu::tsc_offset,
        1 => cpu::tsc_last_value,
        2 => cpu::tsc_resolution,
        3 => cpu::tsc_number_of_same_readings,
        4 => cpu::tsc_speed,
        5 => {
            #[cfg(debug_assertions)]
            {
                return cpu::tsc_last_extra;
            }
            #[cfg(not(debug_assertions))]
            {
                0
            }
        },
        _ => unreachable!(),
    }
}
