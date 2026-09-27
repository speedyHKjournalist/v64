//! CR/DR transfers ignore ModRM.mod and always use full 32-bit GPR state.
use super::{
    adapters::call_abi, decode::DecodedInstruction, integer::IntegerBuilder, lift::snapshot,
};
use crate::ir::{helper::HelperAbi, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool { matches!(i.encoding.opcode, 0x0F20..=0x0F23) }
/// Reads change only their full-width GPR destination after the privilege and
/// index checks. Writes retain an exit because they may change translation or
/// execution policy (including debug registers).
pub fn terminal(i: &DecodedInstruction) -> bool { i.encoding.opcode >= 0x0F22 }
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let modrm = i.modrm.unwrap();
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let name = match i.encoding.opcode {
        0x0F20 => "ir_read_cr_continue",
        0x0F21 => "ir_read_dr_continue",
        0x0F22 => "ir_write_cr",
        0x0F23 => "ir_write_dr",
        _ => unreachable!(),
    };
    let args = [modrm & 7, modrm >> 3 & 7]
        .into_iter()
        .map(|n| b.constant(n as u32, Type::I32))
        .collect();
    call_abi(
        b,
        name,
        args,
        state,
        if terminal(i) { HelperAbi::CpuExit } else { HelperAbi::CpuReload },
    );
}
