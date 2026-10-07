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
/// VEX floating point between XMM registers (the frontend's
/// avx::fp_register): `op` the legacy form's key, XMM `destination` =
/// op(XMM `first`, XMM `source`), the destination's bits 255:128 zeroed.
/// Its CpuReload adapter reloads only the destination (as
/// ir_sse_fp_reg_continue's: mir::call's NativeFp); after Op::AvxCheck.
#[no_mangle]
pub unsafe fn ir_avx_fp_reg_continue(
    op: u32,
    source: i32,
    destination: i32,
    first: i32,
    immediate: i32,
) -> u32 {
    assert!([source, destination, first]
        .iter()
        .all(|r| (0..8).contains(r)));
    CALLS += 1;
    // (the VEX key of the legacy one: map 1, 2 or 3 and the prefix's pp)
    let (map, prefix) = match op & 0xFF_FF00 {
        0x0F_3800 => (2, op >> 24),
        0x0F_3A00 => (3, op >> 24),
        _ => (1, op >> 16),
    };
    let pp = match prefix {
        0x66 => 1,
        0xF3 => 2,
        0xF2 => 3,
        _ => 0,
    };
    let instruction = crate::cpu::avx::Instruction {
        key: 0xC400_0000 | map << 16 | pp << 8 | op & 0xFF,
        reg: destination as u8,
        vvvv: first as u8,
        rm: Some(source as u8),
        l: false,
        w: false,
        imm8: immediate as u8,
        long: false,
    };
    match crate::cpu::avx::execute(
        &mut crate::cpu::avx::Interpreter { address: 0 },
        &instruction,
    ) {
        Ok(()) => Outcome::Normal as u32,
        Err(()) => Outcome::ControlTransferred as u32,
    }
}
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
