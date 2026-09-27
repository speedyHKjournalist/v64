//! Explicit, terminal control-transfer ABI. No opcode fetch or interpreter dispatch.
use crate::cpu::{cpu, global_pointers as gp, misc_instr};
use crate::ir::helper::Outcome;

unsafe fn finish(completed: bool) -> u32 {
    if completed {
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        Outcome::Invalidated as u32
    }
    else {
        Outcome::ControlTransferred as u32
    }
}

#[no_mangle]
pub unsafe fn ir_far_jump(ip: u32, cs: u32, is_call: u32, width: u32) -> u32 {
    assert!(cs <= 65535 && is_call <= 1 && matches!(width, 16 | 32));
    if is_call != 0 && width == 32 && (!*gp::protected_mode || cpu::vm86_mode()) {
        dbg_assert!(ip & 0xFFFF0000 == 0);
    }
    finish(cpu::far_jump_checked(
        ip as i32,
        cs as i32,
        is_call != 0,
        width == 32,
    ))
}

#[no_mangle]
pub unsafe fn ir_far_jump_mem(address: u32, is_call: u32, width: u32) -> u32 {
    assert!(is_call <= 1 && matches!(width, 16 | 32));
    let ip = if width == 16 {
        cpu::safe_read16(address as i32)
    }
    else {
        cpu::safe_read32s(address as i32)
    };
    let Ok(ip) = ip
    else {
        return finish(false);
    };
    let Ok(cs) = cpu::safe_read16(address.wrapping_add(width / 8) as i32)
    else {
        return finish(false);
    };
    if width == 32 && (!*gp::protected_mode || cpu::vm86_mode()) {
        dbg_assert!(ip as u32 & 0xFFFF0000 == 0);
    }
    ir_far_jump(ip as u32, cs as u32, is_call, width)
}

#[no_mangle]
pub unsafe fn ir_far_return(adjust: u32, width: u32) -> u32 {
    assert!(adjust <= 65535 && matches!(width, 16 | 32));
    let address = misc_instr::get_stack_pointer(0);
    let ip = if width == 16 { cpu::safe_read16(address) } else { cpu::safe_read32s(address) };
    let Ok(ip) = ip
    else {
        return finish(false);
    };
    // RETF32 reads a full dword for the selector, unlike IRET32 and m16:32.
    let address = misc_instr::get_stack_pointer((width / 8) as i32);
    let cs = if width == 16 { cpu::safe_read16(address) } else { cpu::safe_read32s(address) };
    let Ok(cs) = cs
    else {
        return finish(false);
    };
    finish(cpu::far_return_checked(
        ip,
        cs & 65535,
        adjust as i32,
        width == 32,
    ))
}

#[no_mangle]
pub unsafe fn ir_iret(width: u32) -> u32 {
    assert!(matches!(width, 16 | 32));
    finish(cpu::iret_checked(width == 16))
}

#[no_mangle]
pub unsafe fn ir_software_interrupt(vector: u32, conditional: u32) -> u32 {
    assert!(vector <= 255 && conditional <= 1);
    if conditional != 0 && !misc_instr::getof() {
        return finish(true);
    }
    finish(cpu::call_interrupt_vector_checked(
        vector as i32,
        true,
        None,
    ))
}

#[no_mangle]
pub unsafe fn ir_far_control_ud() -> u32 {
    cpu::trigger_ud();
    finish(false)
}
