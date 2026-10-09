//! CRC32 (SSE4.2, ir::frontend::crc32) from a register and from memory: the
//! interpreter's semantics, and the region goes on. No flags change and no
//! XMM state is checked.
use crate::cpu::{cpu, global_pointers as gp, instructions_0f38 as sem38};
use crate::ir::helper::Outcome;

use super::continuation::ContinuationContext;

/// `source`: the ModRM r/m register (a byte register for 8 bits); `bits`: 8,
/// 16 or 32
#[no_mangle]
pub unsafe fn ir_crc32_reg_continue(source: i32, destination: i32, bits: i32) -> u32 {
    assert!((0..8).contains(&source) && (0..8).contains(&destination));
    match bits {
        8 => sem38::instr_F20F38F0_reg(source, destination),
        16 => sem38::instr16_F20F38F1_reg(source, destination),
        32 => sem38::instr32_F20F38F1_reg(source, destination),
        _ => unreachable!(),
    }
    Outcome::Normal as u32
}
#[no_mangle]
pub unsafe fn ir_crc32_mem_continue(offset: u32, segment: u32, destination: i32, bits: i32) -> u32 {
    assert!(segment < 6 && (0..8).contains(&destination));
    let before = ContinuationContext::capture();
    let value = cpu::get_seg(segment as i32).and_then(|base| {
        let addr = offset.wrapping_add(base as u32) as i32;
        match bits {
            8 => cpu::safe_read8(addr),
            16 => cpu::safe_read16(addr),
            32 => cpu::safe_read32s(addr),
            _ => unreachable!(),
        }
    });
    let Ok(value) = value
    else {
        return Outcome::ControlTransferred as u32;
    };
    sem38::crc32(destination, value as u32, bits as u32 / 8);
    if before.epoch != u64::MAX && before.matches_current() {
        Outcome::Normal as u32
    }
    else {
        // A synchronous observer of the read (MMIO) can reset the VM, remap
        // code or invalidate a compiled dependency: the instruction retires,
        // and the CPU is authoritative at the cold boundary.
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        Outcome::Invalidated as u32
    }
}
