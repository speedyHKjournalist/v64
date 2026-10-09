//! Explicit baseline reserved/no-op forms and checked scalar side effects.
use crate::cpu::{cpu, fpu, global_pointers as gp, instructions, instructions_0f};
use crate::ir::helper::Outcome;
unsafe fn finish(success: bool) -> u32 {
    if success {
        *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
        Outcome::Invalidated as u32
    }
    else {
        Outcome::ControlTransferred as u32
    }
}
unsafe fn address(offset: u32, segment: u32) -> Result<i32, ()> {
    assert!(segment < 6);
    Ok(offset.wrapping_add(cpu::get_seg(segment as i32)? as u32) as i32)
}
#[no_mangle]
pub unsafe fn ir_reserved_form(behavior: u32, sse: u32, offset: u32, segment: u32) -> u32 {
    // (`sse`: the task checks of an MMX form, 1, or of an XMM form, 2)
    assert!(behavior <= 4 && sse <= 2);
    if sse == 1 && !cpu::task_switch_test_mmx() || sse == 2 && !cpu::task_switch_test_xmm() {
        return finish(false);
    }
    // Even no-op and explicit-UD memory forms resolve the segment in the baseline.
    if segment != u32::MAX && address(offset, segment).is_err() {
        return finish(false);
    }
    match behavior {
        0 => {},
        1 => {
            dbg_assert!(false, "Baseline unimplemented instruction");
        },
        2 => {
            instructions::instr_62_reg(0, 0);
            return finish(true);
        },
        3 => {
            instructions::instr_F1();
            return finish(true);
        },
        4 => return finish(true),
        _ => unreachable!(),
    }
    cpu::trigger_ud();
    finish(false)
}
#[no_mangle]
pub unsafe fn ir_fwait() -> u32 {
    if *gp::cr & (cpu::CR0_MP | cpu::CR0_TS) == cpu::CR0_MP | cpu::CR0_TS {
        cpu::trigger_nm();
        return finish(false);
    }
    fpu::fwait();
    finish(true)
}
unsafe fn arpl_allowed() -> bool {
    if !*gp::protected_mode || cpu::vm86_mode() {
        cpu::trigger_ud();
        false
    }
    else {
        true
    }
}
#[no_mangle]
pub unsafe fn ir_arpl_reg(destination: u32, source: u32) -> u32 {
    assert!(destination < 8 && source < 8);
    if !arpl_allowed() {
        return finish(false);
    }
    let value = instructions::arpl(
        cpu::read_reg16(destination as i32),
        cpu::read_reg16(source as i32),
    );
    cpu::write_reg16(destination as i32, value);
    finish(true)
}
#[no_mangle]
pub unsafe fn ir_arpl_mem(offset: u32, segment: u32, source: u32) -> u32 {
    assert!(source < 8);
    // Baseline ModRM resolves a segment before ARPL checks protected/vm86 mode.
    let Ok(addr) = address(offset, segment)
    else {
        return finish(false);
    };
    if !arpl_allowed() {
        return finish(false);
    }
    finish(
        cpu::safe_read_write16_checked(addr, &|value| {
            instructions::arpl(value, cpu::read_reg16(source as i32))
        })
        .is_ok(),
    )
}
#[no_mangle]
pub unsafe fn ir_movnti(offset: u32, segment: u32, source: u32) -> u32 {
    assert!(source < 8);
    let Ok(addr) = address(offset, segment)
    else {
        return finish(false);
    };
    finish(cpu::safe_write32(addr, cpu::read_reg32(source as i32)).is_ok())
}
#[no_mangle]
pub unsafe fn ir_rdrand(destination: u32, width: u32) -> u32 {
    assert!(destination < 8 && matches!(width, 16 | 32));
    if width == 16 {
        instructions_0f::instr16_0FC7_6_reg(destination as i32);
    }
    else {
        instructions_0f::instr32_0FC7_6_reg(destination as i32);
    }
    finish(true)
}
