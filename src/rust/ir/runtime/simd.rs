//! Precise CPU-owned SSE guard and slow transfer completions; no JS v128 ABI.
use crate::{
    cpu::{cpu, global_pointers as gp},
    ir::helper::Outcome,
};
#[no_mangle]
pub unsafe fn ir_sse_guard() -> u32 {
    // (Op::SseCheck guards XMM forms)
    if cpu::task_switch_test_xmm() {
        Outcome::Normal as u32
    }
    else {
        Outcome::ControlTransferred as u32
    }
}
/// Op::AvxCheck's slow path: #UD in real and virtual-8086 mode, without
/// CR4.OSXSAVE or with XCR0 lacking SSE or AVX state, #NM for CR0.TS (as
/// cpu::avx::check)
#[no_mangle]
pub unsafe fn ir_avx_guard() -> u32 {
    if !*gp::protected_mode || *gp::flags & cpu::FLAG_VM != 0 {
        cpu::trigger_ud();
        return Outcome::ControlTransferred as u32;
    }
    match crate::cpu::avx::check(&mut crate::cpu::avx::Interpreter { address: 0 }) {
        Ok(()) => Outcome::Normal as u32,
        Err(()) => Outcome::ControlTransferred as u32,
    }
}
/// Op::YmmZero (emitted inline)
#[no_mangle]
pub unsafe fn ir_ymm_zero(register: u32) -> u32 {
    assert!(register < 8);
    *gp::ymm_hi.add(register as usize) = cpu::reg128 { u64: [0, 0] };
    Outcome::Normal as u32
}
/// The register argument of the slow completions below
/// (mir::memory::slow_register): the destination, the register read as its
/// old value, and whether the destination's bits 255:128 are zeroed (a VEX
/// form)
fn slow_register(packed: u32) -> (u32, u32, bool) {
    assert!(packed < 0x200 && packed & 0x88 == 0);
    (packed & 7, packed >> 4 & 7, packed & 0x100 != 0)
}
unsafe fn vex_done(register: u32, vex: bool) {
    if vex {
        *gp::ymm_hi.add(register as usize) = cpu::reg128 { u64: [0, 0] };
    }
}
#[no_mangle]
pub unsafe fn ir_xmm_load(address: u32, register: u32, bytes: u32) -> u32 {
    let (register, _, vex) = slow_register(register);
    match bytes {
        4 => {
            let Ok(value) = cpu::safe_read32s(address as i32)
            else {
                return Outcome::ControlTransferred as u32;
            };
            cpu::write_xmm128(register as i32, value, 0, 0, 0);
        },
        8 => {
            let Ok(value) = cpu::safe_read64s(address as i32)
            else {
                return Outcome::ControlTransferred as u32;
            };
            cpu::write_xmm128_2(register as i32, value, 0);
        },
        16 => {
            let Ok(value) = cpu::safe_read128s(address as i32)
            else {
                return Outcome::ControlTransferred as u32;
            };
            cpu::write_xmm_reg128(register as i32, value);
        },
        _ => unreachable!(),
    }
    vex_done(register, vex);
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
#[no_mangle]
pub unsafe fn ir_xmm_binary(address: u32, register: u32, operation: u32, bytes: u32) -> u32 {
    let (register, first, vex) = slow_register(register);
    let operation = crate::ir::simd::PackedOp::from_id(operation).unwrap();
    let source = match bytes {
        8 => {
            assert!(matches!(
                operation,
                crate::ir::simd::PackedOp::UnpackLow32 | crate::ir::simd::PackedOp::UnpackLow64
            ));
            let Ok(value) = cpu::safe_read64s(address as i32)
            else {
                return Outcome::ControlTransferred as u32;
            };
            cpu::reg128 { u64: [value, 0] }
        },
        16 => {
            let Ok(value) = cpu::safe_read128s(address as i32)
            else {
                return Outcome::ControlTransferred as u32;
            };
            value
        },
        _ => unreachable!(),
    };
    let destination = cpu::read_xmm128s(first as i32);
    let result = operation.apply(destination.u8, source.u8);
    cpu::write_xmm_reg128(register as i32, cpu::reg128 { u8: result });
    vex_done(register, vex);
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
#[no_mangle]
pub unsafe fn ir_xmm_store(address: u32, register: u32, bytes: u32, lane: u32) -> u32 {
    assert!(lane == 0 || bytes == 8 && lane == 1);
    assert!(register < 8);
    let value = cpu::read_xmm128s(register as i32);
    let result = match bytes {
        4 => cpu::safe_write32(address as i32, value.u32[0] as i32),
        8 => cpu::safe_write64(address as i32, value.u64[lane as usize]),
        16 => cpu::safe_write128(address as i32, value),
        _ => unreachable!(),
    };
    if result.is_err() {
        return Outcome::ControlTransferred as u32;
    }
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}

#[no_mangle]
pub unsafe fn ir_xmm_shuffle(address: u32, register: u32, operation: u32, immediate: u32) -> u32 {
    let (register, first, vex) = slow_register(register);
    assert!(immediate < 256);
    let operation = crate::ir::simd::ShuffleOp::from_id(operation).unwrap();
    let Ok(source) = cpu::safe_read128s(address as i32)
    else {
        return Outcome::ControlTransferred as u32;
    };
    let destination = cpu::read_xmm128s(first as i32);
    cpu::write_xmm_reg128(
        register as i32,
        cpu::reg128 {
            u8: operation.apply(destination.u8, source.u8, immediate as u8),
        },
    );
    vex_done(register, vex);
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}

#[no_mangle]
pub unsafe fn ir_xmm_transfer_load(address: u32, register: u32, operation: u32) -> u32 {
    let (register, first, vex) = slow_register(register);
    let operation = crate::ir::simd::TransferOp::from_id(operation).unwrap();
    let source = if operation.bytes() == 8 {
        let Ok(value) = cpu::safe_read64s(address as i32)
        else {
            return Outcome::ControlTransferred as u32;
        };
        cpu::reg128 { u64: [value, 0] }
    }
    else {
        let Ok(value) = cpu::safe_read128s(address as i32)
        else {
            return Outcome::ControlTransferred as u32;
        };
        value
    };
    let destination = cpu::read_xmm128s(first as i32);
    cpu::write_xmm_reg128(
        register as i32,
        cpu::reg128 {
            u8: operation.apply(destination.u8, source.u8),
        },
    );
    vex_done(register, vex);
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}

#[no_mangle]
pub unsafe fn ir_xmm_insert_word(address: u32, register: u32, lane: u32) -> u32 {
    assert!(register < 8 && lane < 8);
    let Ok(source) = cpu::safe_read16(address as i32)
    else {
        return Outcome::ControlTransferred as u32;
    };
    let mut destination = cpu::read_xmm128s(register as i32);
    destination.u16[lane as usize] = source as u16;
    cpu::write_xmm_reg128(register as i32, destination);
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}

#[no_mangle]
pub unsafe fn ir_xmm_masked_store(address: u32, source: u32, mask: u32) -> u32 {
    assert!(source < 8 && mask < 8);
    if cpu::writable_or_pagefault(address as i32, 16).is_err() {
        return Outcome::ControlTransferred as u32;
    }
    // Both registers are sampled after preflight and before any write callback.
    let source = cpu::read_xmm128s(source as i32);
    let mask = cpu::read_xmm128s(mask as i32);
    for lane in 0..16 {
        if mask.u8[lane] & 0x80 != 0 {
            cpu::safe_write8(
                (address as i32).wrapping_add(lane as i32),
                source.u8[lane] as i32,
            )
            .unwrap();
        }
    }
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
    Outcome::Invalidated as u32
}
