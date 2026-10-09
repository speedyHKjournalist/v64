//! Staged six-byte CPU operands preserve preflight, callback and fault order.
use crate::cpu::{cpu, global_pointers as gp, instructions_0f};
use crate::ir::helper::Outcome;
unsafe fn valid(width: u32) {
    assert!(matches!(width, 16 | 32));
}
unsafe fn commit() -> u32 {
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
fn fault() -> u32 { Outcome::ControlTransferred as u32 }
unsafe fn ring0() -> bool {
    if *gp::cpl != 0 {
        cpu::trigger_gp(0);
        false
    }
    else {
        true
    }
}
fn mask(width: u32) -> i32 {
    if width == 16 {
        0xFFFFFF
    }
    else {
        -1
    }
}
unsafe fn store_table(address: u32, width: u32, size: *mut i32, base: *mut i32) -> u32 {
    valid(width);
    let address = address as i32;
    if cpu::writable_or_pagefault(address, 6).is_err() {
        return fault();
    }
    // Each field is read at its original observation point. A first-write MMIO
    // callback may change the base before it is read for the second write.
    // Like the pinned sgdt/sidt, a late failure after preflight dispatches then
    // host-aborts through unwrap; already completed writes remain visible.
    cpu::safe_write16(address, *size).unwrap();
    cpu::safe_write32(address.wrapping_add(2), *base & mask(width)).unwrap();
    commit()
}
unsafe fn load_table(address: u32, width: u32, size: *mut i32, base: *mut i32) -> u32 {
    valid(width);
    if !ring0() {
        return fault();
    }
    let address = address as i32;
    let Ok(new_size) = cpu::safe_read16(address)
    else {
        return fault();
    };
    let Ok(new_base) = cpu::safe_read32s(address.wrapping_add(2))
    else {
        return fault();
    };
    *size = new_size;
    *base = new_base & mask(width);
    commit()
}
#[no_mangle]
pub unsafe fn ir_sgdt(address: u32, width: u32) -> u32 {
    store_table(address, width, gp::gdtr_size, gp::gdtr_offset)
}
#[no_mangle]
pub unsafe fn ir_sidt(address: u32, width: u32) -> u32 {
    store_table(address, width, gp::idtr_size, gp::idtr_offset)
}
#[no_mangle]
pub unsafe fn ir_lgdt(address: u32, width: u32) -> u32 {
    load_table(address, width, gp::gdtr_size, gp::gdtr_offset)
}
#[no_mangle]
pub unsafe fn ir_lidt(address: u32, width: u32) -> u32 {
    load_table(address, width, gp::idtr_size, gp::idtr_offset)
}
#[no_mangle]
pub unsafe fn ir_smsw_reg(reg: u32, width: u32) -> u32 {
    valid(width);
    assert!(reg < 8);
    if width == 16 {
        cpu::write_reg16(reg as i32, *gp::cr);
    }
    else {
        cpu::write_reg32(reg as i32, *gp::cr);
    }
    commit()
}
#[no_mangle]
pub unsafe fn ir_smsw_mem(address: u32, width: u32) -> u32 {
    valid(width);
    if cpu::safe_write16(address as i32, *gp::cr & 65535).is_err() {
        return fault();
    }
    commit()
}
#[no_mangle]
pub unsafe fn ir_lmsw_reg(reg: u32, width: u32) -> u32 {
    valid(width);
    assert!(reg < 8);
    if !ring0() {
        return fault();
    }
    instructions_0f::lmsw(cpu::read_reg16(reg as i32));
    commit()
}
#[no_mangle]
pub unsafe fn ir_lmsw_mem(address: u32, width: u32) -> u32 {
    valid(width);
    if !ring0() {
        return fault();
    }
    let Ok(value) = cpu::safe_read16(address as i32)
    else {
        return fault();
    };
    instructions_0f::lmsw(value);
    commit()
}
#[no_mangle]
pub unsafe fn ir_invlpg(address: u32, width: u32) -> u32 {
    valid(width);
    if !ring0() {
        return fault();
    }
    cpu::invlpg(address as i32);
    commit()
}
/// RDTSCP: #UD outside the x86-64 profile, CPU-owned (instructions_0f::rdtscp).
#[no_mangle]
pub unsafe fn ir_rdtscp(reg: u32, width: u32) -> u32 {
    valid(width);
    assert!(reg == 1);
    if !instructions_0f::rdtscp() {
        return fault();
    }
    commit()
}
/// XGETBV and XSETBV (0F 01 D0, D1) without a mandatory prefix
#[no_mangle]
pub unsafe fn ir_xgetbv_xsetbv(reg: u32, width: u32) -> u32 {
    valid(width);
    if !instructions_0f::xgetbv_xsetbv(reg as i32) {
        return fault();
    }
    commit()
}
#[no_mangle]
pub unsafe fn ir_descriptor_ud(reg: u32, width: u32) -> u32 {
    valid(width);
    assert!(reg < 8);
    cpu::trigger_ud();
    fault()
}
