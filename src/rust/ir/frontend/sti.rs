//! STI and its shadow instruction form one indivisible compilation fragment.
use super::{
    adapters::call,
    decode::{decode, DecodedInstruction, GuestEip, LinearAddress},
    integer::IntegerBuilder,
    lift::snapshot,
};
use crate::ir::{hir::Binary, lowering::CompileError, state::ResumeKind, types::Type};
/// Include consecutive STIs and the first following instruction. No partial
/// fragment can publish, including at an unreadable code-page boundary.
pub fn extent(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    mode: bool,
) -> Result<usize, CompileError> {
    let mut offset = 0;
    for _ in 0..128 {
        let i = decode(
            &bytes[offset..],
            GuestEip(pc.0.wrapping_add(offset as u32)),
            LinearAddress(linear.0.wrapping_add(offset as u32)),
            mode,
        )
        .map_err(|_| CompileError::Unsupported("incomplete STI shadow"))?;
        offset += i.length as usize;
        if i.encoding.opcode != 0xFB {
            return Ok(offset);
        }
        if offset == bytes.len() {
            return Err(CompileError::Unsupported("missing STI shadow instruction"));
        }
    }
    Err(CompileError::Budget("STI shadow chain"))
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    call(b, "ir_sti_check", vec![], state, false);
    let enabled = b.constant(1, Type::I1);
    b.preserve_raw_flag_bit(enabled, 9);
    let bit = b.constant(1 << 9, Type::I32);
    b.flags.system = b.binary(Binary::Or, b.flags.system, bit);
}
