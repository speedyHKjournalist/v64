//! BMI1, BMI2, TZCNT, LZCNT and MOVBE in regions (frontend::bmi): the
//! interpreter's semantics (crate::cpu::bmi).
use crate::cpu::{bmi, cpu, global_pointers as gp};
use crate::ir::helper::Outcome;

use super::continuation::ContinuationContext;

/// One instruction (`operands`: frontend::bmi::operands), its memory operand
/// at the linear address `address`; Err: a fault was delivered
unsafe fn run(key: u32, operands: u32, address: i32) -> Result<(), ()> {
    let (reg, rm, memory) = (operands & 7, operands >> 8 & 7, operands >> 11 & 1 != 0);
    if key >> 24 == 0xC4 {
        // (C4 and C5 are LES and LDS in real and virtual-8086 mode, whose
        // register forms are #UD)
        if !*gp::protected_mode || cpu::vm86_mode() {
            cpu::trigger_ud();
            return Err(());
        }
        let i = bmi::Instruction {
            op: bmi::Vex::of(key, reg as u8).unwrap(),
            reg: reg as u8,
            vvvv: (operands >> 4 & 7) as u8,
            bits: 32,
            imm8: (operands >> 16) as u8,
        };
        let mut machine = bmi::Interpreter {
            rm: (!memory).then_some(rm as u8),
            address,
        };
        return bmi::execute(&mut machine, &i);
    }
    let (reg, rm, bits) = (reg as i32, rm as i32, (operands >> 12 & 15) * 8);
    let read = |memory: bool| -> Result<i32, ()> {
        Ok(match (memory, bits) {
            (true, 16) => cpu::safe_read16(address)?,
            (true, _) => cpu::safe_read32s(address)?,
            (false, 16) => cpu::read_reg16(rm),
            (false, _) => cpu::read_reg32(rm),
        })
    };
    let write = |r: i32, value: u64| {
        if bits == 16 {
            cpu::write_reg16(r, value as i32)
        }
        else {
            cpu::write_reg32(r, value as i32)
        }
    };
    match key {
        0xF30FBC | 0xF30FBD => {
            let value = read(memory)? as u32 as u64;
            let (result, flags) =
                if key == 0xF30FBD { bmi::lzcnt(value, bits) } else { bmi::tzcnt(value, bits) };
            write(reg, result);
            bmi::set_flags(flags);
        },
        0x0F38F0 => write(reg, bmi::byte_swap(read(true)? as u32 as u64, bits)),
        _ => {
            let value = bmi::byte_swap(
                if bits == 16 { cpu::read_reg16(reg) } else { cpu::read_reg32(reg) } as u32 as u64,
                bits,
            ) as i32;
            if bits == 16 {
                cpu::safe_write16(address, value)?
            }
            else {
                cpu::safe_write32(address, value)?
            }
        },
    }
    Ok(())
}
/// A register form
#[no_mangle]
pub unsafe fn ir_bmi_reg_continue(key: u32, operands: u32) -> u32 {
    match run(key, operands, 0) {
        Ok(()) => Outcome::Normal as u32,
        Err(()) => Outcome::ControlTransferred as u32,
    }
}
/// A memory form: its operand at `offset` in segment `segment`
#[no_mangle]
pub unsafe fn ir_bmi_mem_continue(key: u32, operands: u32, offset: u32, segment: u32) -> u32 {
    assert!(segment < 6);
    let before = ContinuationContext::capture();
    let Ok(base) = cpu::get_seg(segment as i32)
    else {
        return Outcome::ControlTransferred as u32;
    };
    if run(key, operands, offset.wrapping_add(base as u32) as i32).is_err() {
        return Outcome::ControlTransferred as u32;
    }
    if before.epoch == u64::MAX || !before.matches_current() {
        // A synchronous observer of the access (MMIO) can reset the VM,
        // remap code or invalidate a compiled dependency: the instruction
        // retires, and the CPU is authoritative at the cold boundary.
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        return Outcome::Invalidated as u32;
    }
    Outcome::Normal as u32
}
