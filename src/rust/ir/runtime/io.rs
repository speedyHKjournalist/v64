//! Audited port adapters. CPU owns I/O permissions, devices and fault delivery.
use crate::cpu::{cpu, global_pointers as gp};
use crate::ir::helper::Outcome;
fn valid(port: u32, bytes: u32) {
    assert!(port <= 65535 && matches!(bytes, 1 | 2 | 4));
}
unsafe fn commit() -> u32 {
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
unsafe fn read(port: u32, bytes: u32) -> i32 {
    match bytes {
        1 => cpu::io_port_read8(port as i32),
        2 => cpu::io_port_read16(port as i32),
        4 => cpu::io_port_read32(port as i32),
        _ => unreachable!(),
    }
}
unsafe fn write(port: u32, bytes: u32, value: u32) {
    match bytes {
        1 => cpu::io_port_write8(port as i32, (value & 255) as i32),
        2 => cpu::io_port_write16(port as i32, (value & 65535) as i32),
        4 => cpu::io_port_write32(port as i32, value as i32),
        _ => unreachable!(),
    }
}
unsafe fn write_accumulator(bytes: u32, value: i32) {
    match bytes {
        1 => cpu::write_reg8(0, value),
        2 => cpu::write_reg16(0, value),
        4 => cpu::write_reg32(0, value),
        _ => unreachable!(),
    }
}
#[no_mangle]
pub unsafe fn ir_io_check(port: u32, bytes: u32) -> u32 {
    valid(port, bytes);
    if cpu::test_privileges_for_io(port as i32, bytes as i32) {
        Outcome::Normal as u32
    }
    else {
        Outcome::ControlTransferred as u32
    }
}
#[no_mangle]
pub unsafe fn ir_in(port: u32, bytes: u32) -> u32 {
    if ir_io_check(port, bytes) != 0 {
        return Outcome::ControlTransferred as u32;
    }
    let value = read(port, bytes);
    match bytes {
        1 => cpu::write_reg8(0, value),
        2 => cpu::write_reg16(0, value),
        4 => cpu::write_reg32(0, value),
        _ => unreachable!(),
    };
    commit()
}
#[no_mangle]
pub unsafe fn ir_out(port: u32, bytes: u32, _value: u32) -> u32 {
    if ir_io_check(port, bytes) != 0 {
        return Outcome::ControlTransferred as u32;
    }
    // CPU OUT reads the accumulator after permission checks, whose TSS/bitmap
    // accesses can call the host. Keep the existing call ABI, but use the
    // authoritative (already materialized) accumulator after those callbacks.
    write(port, bytes, cpu::read_reg32(0) as u32);
    commit()
}
/// One device observation; never repeat it after a failed continuation check.
#[no_mangle]
pub unsafe fn ir_in_continue(port: u32, bytes: u32) -> u32 {
    // Permission checks may read a TSS/I/O bitmap through MMIO. Include those
    // observers in the certificate, not only the eventual port callback.
    if super::continuation::NotifiedObserver::enabled() {
        let observer = super::continuation::NotifiedObserver::capture();
        if ir_io_check(port, bytes) != 0 {
            return Outcome::ControlTransferred as u32;
        }
        write_accumulator(bytes, read(port, bytes));
        return observer.finish();
    }
    let observer = super::continuation::ScalarObserver::capture();
    if ir_io_check(port, bytes) != 0 {
        return Outcome::ControlTransferred as u32;
    }
    let value = read(port, bytes);
    match bytes {
        1 => cpu::write_reg8(0, value),
        2 => cpu::write_reg16(0, value),
        4 => cpu::write_reg32(0, value),
        _ => unreachable!(),
    }
    observer.finish()
}
#[no_mangle]
pub unsafe fn ir_out_continue(port: u32, bytes: u32, _value: u32) -> u32 {
    if super::continuation::NotifiedObserver::enabled() {
        let observer = super::continuation::NotifiedObserver::capture();
        if ir_io_check(port, bytes) != 0 {
            return Outcome::ControlTransferred as u32;
        }
        write(port, bytes, cpu::read_reg32(0) as u32);
        return observer.finish();
    }
    let observer = super::continuation::ScalarObserver::capture();
    if ir_io_check(port, bytes) != 0 {
        return Outcome::ControlTransferred as u32;
    }
    write(port, bytes, cpu::read_reg32(0) as u32);
    observer.finish()
}
/// Keep every observation of a single string I/O instruction inside the CPU
/// implementation. No intermediate permission or memory callback returns to
/// SSA state, and a completed device operation is never replayed.
unsafe fn io_once(input: bool, bytes: u32, asize32: u32, segment: u32) -> u32 {
    use crate::cpu::string::{execute_io_once, StringOutcome};
    assert!(asize32 <= 1 && segment < 6);
    let result = execute_io_once(input, bytes, asize32 != 0, segment as i32);
    match result.outcome {
        StringOutcome::Complete => {
            debug_assert_eq!(result.iterations, 1);
            commit()
        },
        StringOutcome::Fault => Outcome::ControlTransferred as u32,
        StringOutcome::Repeat => unreachable!("non-REP I/O cannot repeat"),
    }
}
#[no_mangle]
pub unsafe fn ir_ins_once(bytes: u32, asize32: u32, segment: u32) -> u32 {
    io_once(true, bytes, asize32, segment)
}
#[no_mangle]
pub unsafe fn ir_outs_once(bytes: u32, asize32: u32, segment: u32) -> u32 {
    io_once(false, bytes, asize32, segment)
}
/// Frontend has already checked permission before its ordered source GuestLoad.
#[no_mangle]
pub unsafe fn ir_outs(port: u32, bytes: u32, value: u32, next_si: u32) -> u32 {
    valid(port, bytes);
    write(port, bytes, value);
    cpu::write_reg32(6, next_si as i32);
    commit()
}
/// INS checks the entire destination before reading the port. The actual write
/// still translates again: a device callback may invalidate the preflight.
#[no_mangle]
pub unsafe fn ir_ins(port: u32, bytes: u32, address: u32, next_di: u32) -> u32 {
    if ir_io_check(port, bytes) != 0 {
        return Outcome::ControlTransferred as u32;
    }
    if cpu::writable_or_pagefault(address as i32, bytes as i32).is_err() {
        return Outcome::ControlTransferred as u32;
    }
    let value = read(port, bytes);
    let result = match bytes {
        1 => cpu::safe_write8(address as i32, value),
        2 => cpu::safe_write16(address as i32, value),
        4 => cpu::safe_write32(address as i32, value),
        _ => unreachable!(),
    };
    if result.is_err() {
        return Outcome::ControlTransferred as u32;
    }
    cpu::write_reg32(7, next_di as i32);
    commit()
}
