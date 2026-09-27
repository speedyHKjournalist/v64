//! CPU-owned slow paths. The caller materializes state first.
//! safe_* owns fault delivery; a fault return MUST exit without restoring old state.
use crate::cpu::{cpu, global_pointers as gp};
use crate::ir::helper::Outcome;
#[no_mangle]
pub unsafe fn ir_tlb_base() -> u32 { core::ptr::addr_of!(cpu::tlb_data) as u32 }
/// Base of guest physical RAM in the shared Wasm linear memory. Native TLB
/// pointers are `mem8 + guest_physical`; immutable code dependencies store only
/// guest-physical page addresses, so guarded store continuation needs this base
/// to compare the two address spaces without trusting the virtual TLB alias.
#[no_mangle]
pub unsafe fn ir_memory_base() -> u32 { crate::cpu::memory::mem8 as u32 }
#[no_mangle]
pub unsafe fn ir_segment_address(offset: u32, segment: u32) -> u64 {
    assert!(segment < 6);
    match cpu::get_seg(segment as i32) {
        Ok(base) => offset.wrapping_add(base as u32) as u64,
        Err(()) => (Outcome::ControlTransferred as u64) << 32,
    }
}
#[no_mangle]
pub unsafe fn ir_memory_read(address: u32, bytes: u32) -> u64 {
    let result = match bytes {
        1 => cpu::safe_read8(address as i32),
        2 => cpu::safe_read16(address as i32),
        4 => cpu::safe_read32s(address as i32),
        _ => unreachable!("IR memory width"),
    };
    match result {
        Ok(value) => value as u32 as u64,
        Err(()) => (Outcome::ControlTransferred as u64) << 32,
    }
}
#[no_mangle]
pub unsafe fn ir_memory_write(address: u32, value: u32, bytes: u32) -> u32 {
    let result = match bytes {
        1 => cpu::safe_write8(address as i32, (value & 255) as i32),
        2 => cpu::safe_write16(address as i32, (value & 65535) as i32),
        4 => cpu::safe_write32(address as i32, value as i32),
        _ => unreachable!("IR memory width"),
    };
    // A slow store may invalidate executing code or invoke a device. End the
    // region after success until publication invalidation can identify it.
    match result {
        Ok(()) => Outcome::Invalidated as u32,
        Err(()) => Outcome::ControlTransferred as u32,
    }
}
/// Runtime entry invariant: arithmetic FLAGS use the canonical CPU getters;
/// materialization preserves raw FLAGS and lazy backing separately. Also an entry guard.
#[no_mangle]
pub unsafe fn ir_enter() {
    super::rep::reset_result();
    // CPU's instruction_pointer is linear, whereas StateMap PCs are CS-relative.
    *gp::previous_ip = *gp::instruction_pointer;
}

/// Combine the single-entry module's context guard and entry initialization.
/// A rejected key has NO architectural/REP effects. Code identity, bytes and
/// mappings remain the caller's admission obligation, just as for ir_enter.
#[no_mangle]
pub unsafe fn ir_enter_checked(linear: u32, cs_base: u32, default_32: u32) -> bool {
    if !super::entry::matches_current(linear, cs_base, default_32) {
        return false;
    }
    ir_enter();
    true
}
/// Page functions test the exact PC against their served entry list inline.
#[no_mangle]
pub unsafe fn ir_enter_page(cs_base: u32, default_32: u32) -> bool {
    let linear = *gp::instruction_pointer as u32;
    if !super::entry::matches_current(linear, cs_base, default_32) {
        return false;
    }
    ir_enter();
    true
}

#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_step() {
    *gp::previous_ip = *gp::instruction_pointer;
    *gp::prefixes = 0;
    if let Ok(opcode) = cpu::read_imm8() {
        cpu::run_instruction(opcode | (*gp::is_32 as i32) << 8);
    }
}
#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_set_cr0(value: i32) { cpu::set_cr0(value); }

// Slow-ticket tag bits use otherwise-zero bits of the cross-page ending offset
// (0..2 for widths <=4). High word 0 denotes a native host pointer in low word.
const RMW_SLOW: u32 = 4;
const RMW_CROSS: u32 = 8;
static mut RMW_VALUE: i32 = 0;
#[no_mangle]
pub unsafe fn ir_rmw_read(address: u32, bytes: u32) -> u64 {
    use crate::cpu::memory;
    assert!(matches!(bytes, 1 | 2 | 4));
    let Ok(low) = cpu::translate_address_write(address as i32)
    else {
        return u64::MAX;
    };
    let cross = address & 4095 > 4096 - bytes;
    let high = if cross {
        let last = address.wrapping_add(bytes - 1);
        // safe_read_write32 translates the aligned word on the second page;
        // preserving that address is observable in CR2 on a fault.
        let lookup = if bytes == 4 { last & !3 } else { last };
        let Ok(high) = cpu::translate_address_write(lookup as i32)
        else {
            return u64::MAX;
        };
        high | (last & (bytes - 1))
    }
    else {
        0
    };
    // Both write translations precede any device read, exactly as safe_read_write*.
    let value = match (bytes, cross) {
        (1, _) => memory::read8(low),
        (2, false) => memory::read16(low),
        (4, false) => memory::read32s(low),
        (2, true) => cpu::virt_boundary_read16(low, high),
        (4, true) => cpu::virt_boundary_read32s(low, high),
        _ => unreachable!(),
    };
    RMW_VALUE = value; // Published after callbacks; the immediate getter cannot reenter.
    ((high | RMW_SLOW | if cross { RMW_CROSS } else { 0 }) as u64) << 32 | low as u64
}
#[no_mangle]
pub unsafe fn ir_rmw_value() -> i32 { RMW_VALUE }
#[no_mangle]
pub unsafe fn ir_rmw_write(ticket: u64, value: i32, bytes: u32) {
    use crate::cpu::memory;
    assert!(matches!(bytes, 1 | 2 | 4));
    let low = ticket as u32;
    let tag = (ticket >> 32) as u32;
    assert!(tag & RMW_SLOW != 0);
    let high = tag & !(RMW_SLOW | RMW_CROSS);
    if tag & RMW_CROSS != 0 {
        match bytes {
            2 => cpu::virt_boundary_write16(low, high, value),
            4 => cpu::virt_boundary_write32(low, high, value),
            _ => unreachable!(),
        }
    }
    else {
        match bytes {
            1 => memory::write8(low, value),
            2 => memory::write16(low, value),
            4 => memory::write32(low, value),
            _ => unreachable!(),
        }
    }
}

#[no_mangle]
pub unsafe fn ir_pop_address(offset: u32, segment: u32, bytes: u32) -> u64 {
    assert!(segment < 6 && matches!(bytes, 2 | 4));
    // Caller materialized the temporary post-increment SP used by 8F /0 EA
    // resolution. The baseline unwinds this adjustment even after #GP delivery.
    match cpu::get_seg(segment as i32) {
        Ok(base) => offset.wrapping_add(base as u32) as u64,
        Err(()) => {
            crate::cpu::misc_instr::adjust_stack_reg(-(bytes as i32));
            (Outcome::ControlTransferred as u64) << 32
        },
    }
}

/// Permission preflight is observable through page faults and page-table A/D
/// bits, but must never read a device before all pages have been checked.
#[no_mangle]
pub unsafe fn ir_memory_check(address: u32, bytes: u32, write: u32) -> u32 {
    assert!(bytes > 0 && bytes < 4096 && write <= 1);
    let result = if write != 0 {
        cpu::writable_or_pagefault(address as i32, bytes as i32)
    }
    else {
        cpu::readable_or_pagefault(address as i32, bytes as i32)
    };
    match result {
        Ok(()) => Outcome::Normal as u32,
        Err(()) => Outcome::ControlTransferred as u32,
    }
}

/// No arithmetic or register write occurs in this adapter. HIR guards own the
/// divide conditions; this adapter owns exactly one real CPU #DE delivery.
#[no_mangle]
pub unsafe fn ir_divide_fault() {
    cpu::trigger_de();
}

/// Compatibility for the pinned ENTER16 frame push. RAM truncates to a word,
/// but safe_write16 passes the full value to same-page MMIO. Its debug assertion
/// is intentionally retained; this form's complete oracle uses a release CPU.
#[no_mangle]
pub unsafe fn ir_memory_write_unmasked_word(address: u32, value: u32, bytes: u32) -> u32 {
    assert!(bytes == 2);
    match cpu::safe_write16(address as i32, value as i32) {
        Ok(()) => Outcome::Invalidated as u32,
        Err(()) => Outcome::ControlTransferred as u32,
    }
}

/// Eight-byte conditional exchange with the interpreter's preflight/read/write
/// stages. Reads compare/replacement registers after device reads. No write on
/// mismatch; a later read/write fault retains the original unwrap-abort policy.
#[no_mangle]
pub unsafe fn ir_cmpxchg8b(address: u32) -> u32 {
    if cpu::writable_or_pagefault(address as i32, 8).is_err() {
        return Outcome::ControlTransferred as u32;
    }
    let value = cpu::safe_read64s(address as i32).unwrap();
    let expected = cpu::read_reg32(0) as u32 as u64 | (cpu::read_reg32(2) as u32 as u64) << 32;
    if value == expected {
        *gp::flags |= cpu::FLAG_ZERO;
        let replacement =
            cpu::read_reg32(3) as u32 as u64 | (cpu::read_reg32(1) as u32 as u64) << 32;
        cpu::safe_write64(address as i32, replacement).unwrap();
    }
    else {
        *gp::flags &= !cpu::FLAG_ZERO;
        cpu::write_reg32(0, value as i32);
        cpu::write_reg32(2, (value >> 32) as i32);
    }
    *gp::flags_changed &= !cpu::FLAG_ZERO;
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
