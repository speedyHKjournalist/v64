//! Explicit terminal REP semantic batches with recoverable CPU progress.
use super::{
    adapters::call_abi, decode::DecodedInstruction, integer::IntegerBuilder, lift::snapshot,
};
use crate::ir::{helper::HelperAbi, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode >> 8, 0xF2 | 0xF3)
        && matches!(i.encoding.opcode & 255, 0xA4..=0xA7 | 0xAA..=0xAF | 0x6C..=0x6F)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32, limit: u32) {
    let name = match i.encoding.opcode & 0xFE {
        0xA4 => "ir_rep_movs",
        0xA6 => "ir_rep_cmps",
        0xAA => "ir_rep_stos",
        0xAC => "ir_rep_lods",
        0xAE => "ir_rep_scas",
        0x6C => "ir_rep_ins",
        0x6E => "ir_rep_outs",
        _ => unreachable!(),
    };
    let width = if i.encoding.opcode & 1 == 0 { 8 } else { i.operand_size };
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::RepProgress;
    b.region.states[state.index()].rep_progress = Some([b.gpr[1], b.gpr[6], b.gpr[7]]);
    let args = [
        width as u32 / 8,
        u32::from(i.address_size == 32),
        i.prefixes.segment.unwrap_or(3) as u32,
        u32::from(i.prefixes.repne),
        limit,
    ]
    .into_iter()
    .map(|n| b.constant(n, Type::I32))
    .collect();
    call_abi(b, name, args, state, HelperAbi::CpuRep);
}
