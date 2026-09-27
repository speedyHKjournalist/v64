//! Explicit mode/privilege guards and checked task/LDTR state transitions.
use crate::cpu::{cpu, global_pointers as gp};
use crate::ir::helper::Outcome;
unsafe fn allowed(width: u32, load: bool) -> bool {
    assert!(matches!(width, 16 | 32));
    if !*gp::protected_mode || cpu::vm86_mode() {
        cpu::trigger_ud();
        false
    }
    else if load && *gp::cpl != 0 {
        cpu::trigger_gp(0);
        false
    }
    else {
        true
    }
}
fn fault() -> u32 { Outcome::ControlTransferred as u32 }
unsafe fn commit() -> u32 {
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
unsafe fn store_reg(reg: u32, width: u32, segment: usize) -> u32 {
    assert!(reg < 8);
    if !allowed(width, false) {
        return fault();
    }
    let value = *gp::sreg.add(segment) as i32;
    if width == 16 {
        cpu::write_reg16(reg as i32, value);
    }
    else {
        cpu::write_reg32(reg as i32, value);
    }
    commit()
}
unsafe fn store_mem(addr: u32, width: u32, segment: usize) -> u32 {
    if !allowed(width, false) {
        return fault();
    }
    if cpu::safe_write16(addr as i32, *gp::sreg.add(segment) as i32).is_err() {
        return fault();
    }
    commit()
}
unsafe fn load(value: i32, task: bool) -> u32 {
    let result = if task { cpu::load_tr_checked(value) } else { cpu::load_ldt(value) };
    if result.is_err() {
        fault()
    }
    else {
        commit()
    }
}
unsafe fn load_reg(reg: u32, width: u32, task: bool) -> u32 {
    assert!(reg < 8);
    if !allowed(width, true) {
        return fault();
    }
    load(cpu::read_reg16(reg as i32), task)
}
unsafe fn load_mem(addr: u32, width: u32, task: bool) -> u32 {
    if !allowed(width, true) {
        return fault();
    }
    let Ok(value) = cpu::safe_read16(addr as i32)
    else {
        return fault();
    };
    load(value, task)
}
#[no_mangle]
pub unsafe fn ir_sldt_reg(reg: u32, width: u32) -> u32 { store_reg(reg, width, 7) }
#[no_mangle]
pub unsafe fn ir_str_reg(reg: u32, width: u32) -> u32 { store_reg(reg, width, 6) }
#[no_mangle]
pub unsafe fn ir_sldt_mem(addr: u32, width: u32) -> u32 { store_mem(addr, width, 7) }
#[no_mangle]
pub unsafe fn ir_str_mem(addr: u32, width: u32) -> u32 { store_mem(addr, width, 6) }
#[no_mangle]
pub unsafe fn ir_lldt_reg(reg: u32, width: u32) -> u32 { load_reg(reg, width, false) }
#[no_mangle]
pub unsafe fn ir_ltr_reg(reg: u32, width: u32) -> u32 { load_reg(reg, width, true) }
#[no_mangle]
pub unsafe fn ir_lldt_mem(addr: u32, width: u32) -> u32 { load_mem(addr, width, false) }
#[no_mangle]
pub unsafe fn ir_ltr_mem(addr: u32, width: u32) -> u32 { load_mem(addr, width, true) }
