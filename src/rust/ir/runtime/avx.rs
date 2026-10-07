//! AVX (crate::cpu::avx) in regions: ir::frontend::avx. The interpreter's
//! order: the AVX state (#UD, #NM), then the operand's segment and memory.
use crate::cpu::{avx, cpu, global_pointers as gp};
use crate::ir::helper::Outcome;

use super::continuation::ContinuationContext;

static mut CALLS: u32 = 0;
/// Calls of ir_avx_continue (tests)
#[no_mangle]
pub unsafe fn ir_avx_calls() -> u32 { CALLS }
#[no_mangle]
pub unsafe fn ir_avx_calls_reset() { CALLS = 0; }

/// `key`: the row's catalogue key; `operands`: ir::frontend::avx::operands;
/// `offset` and `segment`: the memory operand's (VMASKMOVDQU's destination)
#[no_mangle]
pub unsafe fn ir_avx_continue(key: u32, operands: u32, offset: u32, segment: u32) -> u32 {
    CALLS = CALLS.wrapping_add(1);
    // (C4 and C5 are LES and LDS in real and virtual-8086 mode, whose
    // register forms are #UD)
    if !*gp::protected_mode || cpu::vm86_mode() {
        cpu::trigger_ud();
        return Outcome::ControlTransferred as u32;
    }
    let mut machine = avx::Interpreter { address: 0 };
    if avx::check(&mut machine).is_err() {
        return Outcome::ControlTransferred as u32;
    }
    let memory = operands >> 11 & 1 != 0 || key == 0xC40101F7;
    let before = if memory { Some(ContinuationContext::capture()) } else { None };
    if memory {
        assert!(segment < 6);
        let Ok(base) = cpu::get_seg(segment as i32)
        else {
            return Outcome::ControlTransferred as u32;
        };
        machine.address = offset.wrapping_add(base as u32) as i32;
    }
    let i = avx::Instruction {
        key,
        reg: (operands & 7) as u8,
        vvvv: (operands >> 4 & 7) as u8,
        rm: if operands >> 11 & 1 != 0 { None } else { Some((operands >> 8 & 7) as u8) },
        l: operands >> 12 & 1 != 0,
        w: operands >> 13 & 1 != 0,
        imm8: (operands >> 16) as u8,
        long: false,
    };
    if avx::execute(&mut machine, &i).is_err() {
        return Outcome::ControlTransferred as u32;
    }
    match before {
        Some(before) if before.epoch == u64::MAX || !before.matches_current() => {
            // A synchronous observer of the access (MMIO) can reset the VM,
            // remap code or invalidate a compiled dependency: the
            // instruction retires, and the CPU is authoritative at the cold
            // boundary.
            *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
            Outcome::Invalidated as u32
        },
        _ => Outcome::Normal as u32,
    }
}
