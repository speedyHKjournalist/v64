//! BMI1 and BMI2 (VEX-encoded, general-purpose registers), TZCNT, LZCNT and
//! MOVBE: the interpreter's semantics (crate::cpu::bmi) through CPU helpers
//! that let the region go on. Register forms reload the general-purpose
//! registers and flags; memory forms the whole CPU (an MMIO access can
//! observe it).
use super::{
    adapters::call_abi,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, snapshot},
};
use crate::decode_rules::vex;
use crate::ir::{helper::HelperAbi, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    i.vex.is_some() && i.encoding.vex & vex::GPR != 0
        || matches!(i.encoding.opcode, 0xF30FBC | 0xF30FBD | 0x0F38F0 | 0x0F38F1)
}
/// The helpers' `operands`: ModRM.reg (bits 2:0), VEX.vvvv (6:4), ModRM.rm
/// (10:8), a memory operand (11), the operand size (15:12, in bytes: legacy
/// forms), imm8 (23:16)
pub fn operands(i: &DecodedInstruction) -> u32 {
    let modrm = i.modrm.unwrap_or(0) as u32;
    (modrm >> 3 & 7)
        | i.vex.map_or(0, |v| v.vvvv as u32 & 7) << 4
        | (modrm & 7) << 8
        | (i.ea.is_some() as u32) << 11
        | (i.operand_size as u32 / 8) << 12
        | (i.immediate.unwrap_or(0) & 255) << 16
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let key = b.constant(i.encoding.opcode, Type::I32);
    let operands = b.constant(operands(i), Type::I32);
    if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let segment = b.constant(ea.segment as u32, Type::I32);
        call_abi(
            b,
            "ir_bmi_mem_continue",
            vec![key, operands, offset, segment],
            state,
            HelperAbi::CpuReload,
        );
    }
    else {
        call_abi(
            b,
            "ir_bmi_reg_continue",
            vec![key, operands],
            state,
            HelperAbi::CpuReload,
        );
    }
}
