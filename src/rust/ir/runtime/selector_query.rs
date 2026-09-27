//! Descriptor queries retain post-fault destination writes from the pinned CPU.
use crate::cpu::{cpu, global_pointers as gp};
use crate::ir::helper::Outcome;
unsafe fn allowed() -> bool {
    if !*gp::protected_mode || cpu::vm86_mode() {
        cpu::trigger_ud();
        false
    }
    else {
        true
    }
}
unsafe fn query(selector: i32, dest: u32, width: u32, limit: bool) -> u32 {
    let original =
        if width == 16 { cpu::read_reg16(dest as i32) } else { cpu::read_reg32(dest as i32) };
    let selector = cpu::SegmentSelector::of_u16(selector as u16);
    let (value, fault) = match cpu::lookup_segment_selector(selector) {
        Err(()) => (original, true),
        Ok(result) => {
            *gp::flags_changed &= !cpu::FLAG_ZERO;
            let value = match result {
                Err(_) => {
                    *gp::flags &= !cpu::FLAG_ZERO;
                    original
                },
                Ok((desc, _)) => {
                    let bad_privilege = desc.dpl() < *gp::cpl || desc.dpl() < selector.rpl();
                    let invalid_types = if limit {
                        (1u32 << 0)
                            | (1 << 4)
                            | (1 << 5)
                            | (1 << 6)
                            | (1 << 7)
                            | (1 << 8)
                            | (1 << 10)
                            | (1 << 12)
                            | (1 << 13)
                            | (1 << 14)
                            | (1 << 15)
                    }
                    else {
                        (1u32 << 0)
                            | (1 << 6)
                            | (1 << 7)
                            | (1 << 8)
                            | (1 << 10)
                            | (1 << 13)
                            | (1 << 14)
                            | (1 << 15)
                    };
                    let invalid = if desc.is_system() {
                        (invalid_types >> desc.system_type() & 1) != 0 || bad_privilege
                    }
                    else {
                        !desc.is_conforming_executable() && bad_privilege
                    };
                    if invalid {
                        *gp::flags &= !cpu::FLAG_ZERO;
                        original
                    }
                    else {
                        *gp::flags |= cpu::FLAG_ZERO;
                        if limit {
                            desc.effective_limit() as i32
                        }
                        else {
                            (desc.raw >> 32) as i32 & 0x00FFFF00
                        }
                    }
                },
            };
            (value, false)
        },
    };
    // The baseline instruction wrapper writes its saved destination even after
    // descriptor #PF delivery. A word write preserves the post-fault high half;
    // notably, ESP may already have changed during the delivered exception.
    if width == 16 {
        cpu::write_reg16(dest as i32, value);
    }
    else {
        cpu::write_reg32(dest as i32, value);
    }
    if fault {
        Outcome::ControlTransferred as u32
    }
    else {
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        Outcome::Invalidated as u32
    }
}
unsafe fn reg(source: u32, dest: u32, width: u32, limit: bool) -> u32 {
    assert!(source < 8);
    assert!(dest < 8 && matches!(width, 16 | 32));
    if !allowed() {
        return Outcome::ControlTransferred as u32;
    }
    query(cpu::read_reg16(source as i32), dest, width, limit)
}
unsafe fn mem(addr: u32, dest: u32, width: u32, limit: bool) -> u32 {
    assert!(dest < 8 && matches!(width, 16 | 32));
    if !allowed() {
        return Outcome::ControlTransferred as u32;
    }
    let Ok(selector) = cpu::safe_read16(addr as i32)
    else {
        return Outcome::ControlTransferred as u32;
    };
    query(selector, dest, width, limit)
}
#[no_mangle]
pub unsafe fn ir_lar_reg(source: u32, dest: u32, width: u32) -> u32 {
    reg(source, dest, width, false)
}
#[no_mangle]
pub unsafe fn ir_lsl_reg(source: u32, dest: u32, width: u32) -> u32 {
    reg(source, dest, width, true)
}
#[no_mangle]
pub unsafe fn ir_lar_mem(addr: u32, dest: u32, width: u32) -> u32 { mem(addr, dest, width, false) }
#[no_mangle]
pub unsafe fn ir_lsl_mem(addr: u32, dest: u32, width: u32) -> u32 { mem(addr, dest, width, true) }

// Unlike LAR/LSL, the pinned VERR/VERW implementation exposes the raw ZF
// backing bit during descriptor lookup, including MMIO and delivered #PF.
unsafe fn access_query(selector: i32, write: bool) -> u32 {
    *gp::flags_changed &= !cpu::FLAG_ZERO;
    let selector = cpu::SegmentSelector::of_u16(selector as u16);
    let Ok(result) = cpu::lookup_segment_selector(selector)
    else {
        return Outcome::ControlTransferred as u32;
    };
    let valid = match result {
        Err(_) => false,
        Ok((desc, _)) => {
            !desc.is_system()
                && if write {
                    desc.is_writable() && desc.dpl() >= *gp::cpl && desc.dpl() >= selector.rpl()
                }
                else {
                    desc.is_readable()
                        && (desc.is_conforming_executable()
                            || desc.dpl() >= *gp::cpl && desc.dpl() >= selector.rpl())
                }
        },
    };
    *gp::flags = *gp::flags & !cpu::FLAG_ZERO | if valid { cpu::FLAG_ZERO } else { 0 };
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
unsafe fn access_reg(source: u32, write: bool) -> u32 {
    assert!(source < 8);
    if !allowed() {
        return Outcome::ControlTransferred as u32;
    }
    access_query(cpu::read_reg16(source as i32), write)
}
unsafe fn access_mem(addr: u32, write: bool) -> u32 {
    if !allowed() {
        return Outcome::ControlTransferred as u32;
    }
    let Ok(selector) = cpu::safe_read16(addr as i32)
    else {
        return Outcome::ControlTransferred as u32;
    };
    access_query(selector, write)
}
#[no_mangle]
pub unsafe fn ir_verr_reg(source: u32) -> u32 { access_reg(source, false) }
#[no_mangle]
pub unsafe fn ir_verw_reg(source: u32) -> u32 { access_reg(source, true) }
#[no_mangle]
pub unsafe fn ir_verr_mem(addr: u32) -> u32 { access_mem(addr, false) }
#[no_mangle]
pub unsafe fn ir_verw_mem(addr: u32) -> u32 { access_mem(addr, true) }
