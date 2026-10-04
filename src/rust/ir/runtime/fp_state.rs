//! CPU-owned FP environment transfers. State is authoritative after every exit.
use crate::cpu::{cpu, global_pointers as gp, misc_instr, xstate};
use crate::ir::helper::Outcome;
unsafe fn address(offset: u32, segment: u32, sse: bool) -> Result<i32, ()> {
    assert!(segment < 6);
    if !(if sse { cpu::task_switch_test_mmx() } else { cpu::task_switch_test() }) {
        return Err(());
    }
    Ok(offset.wrapping_add(cpu::get_seg(segment as i32)? as u32) as i32)
}
unsafe fn finish(success: bool) -> u32 {
    if success {
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        Outcome::Invalidated as u32
    }
    else {
        Outcome::ControlTransferred as u32
    }
}
#[no_mangle]
pub unsafe fn ir_fxsave(offset: u32, segment: u32) -> u32 {
    let Ok(addr) = address(offset, segment, false)
    else {
        return finish(false);
    };
    finish(misc_instr::fxsave_checked(addr))
}
#[no_mangle]
pub unsafe fn ir_fxrstor(offset: u32, segment: u32) -> u32 {
    let Ok(addr) = address(offset, segment, false)
    else {
        return finish(false);
    };
    finish(misc_instr::fxrstor_checked(addr))
}
/// XSAVE and XRSTOR: #UD without CR4.OSXSAVE before #NM (cpu::xstate::usable)
unsafe fn xstate_address(offset: u32, segment: u32) -> Result<i32, ()> {
    assert!(segment < 6);
    if !xstate::usable(true) {
        return Err(());
    }
    Ok(offset.wrapping_add(cpu::get_seg(segment as i32)? as u32) as i32)
}
#[no_mangle]
pub unsafe fn ir_xsave(offset: u32, segment: u32) -> u32 {
    let Ok(addr) = xstate_address(offset, segment)
    else {
        return finish(false);
    };
    finish(xstate::xsave_32(addr))
}
#[no_mangle]
pub unsafe fn ir_xrstor(offset: u32, segment: u32) -> u32 {
    let Ok(addr) = xstate_address(offset, segment)
    else {
        return finish(false);
    };
    finish(xstate::xrstor_32(addr))
}
#[no_mangle]
pub unsafe fn ir_ldmxcsr(offset: u32, segment: u32) -> u32 {
    let Ok(addr) = address(offset, segment, true)
    else {
        return finish(false);
    };
    let Ok(value) = cpu::safe_read32s(addr)
    else {
        return finish(false);
    };
    if value & !cpu::MXCSR_MASK != 0 {
        dbg_log!("Invalid mxcsr bits: {:x}", value & !cpu::MXCSR_MASK);
        cpu::trigger_gp(0);
        return finish(false);
    }
    cpu::set_mxcsr(value);
    finish(true)
}
#[no_mangle]
pub unsafe fn ir_stmxcsr(offset: u32, segment: u32) -> u32 {
    let Ok(addr) = address(offset, segment, true)
    else {
        return finish(false);
    };
    finish(cpu::safe_write32(addr, *gp::mxcsr).is_ok())
}
