//! Terminal FXSAVE/FXRSTOR and MXCSR transfers, with guard-before-segment order.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, snapshot},
};
use crate::ir::{state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    i.encoding.opcode == 0x0FAE && (0..=3).contains(&i.encoding.group) && i.ea.is_some()
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let ea = i.ea.unwrap();
    let offset = effective_offset(b, &ea);
    let segment = b.constant(ea.segment as u32, Type::I32);
    let name = ["ir_fxsave", "ir_fxrstor", "ir_ldmxcsr", "ir_stmxcsr"][i.encoding.group as usize];
    call(b, name, vec![offset, segment], state, true);
}
