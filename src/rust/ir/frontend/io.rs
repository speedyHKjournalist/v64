//! Continuing scalar port I/O and CPU-owned single-iteration INS/OUTS.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::snapshot,
};
use crate::ir::{
    hir::Op, lowering::CompileError, state::ResumeKind, types::Type,
};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode,0xE4..=0xE7|0xEC..=0xEF|0x6C..=0x6F)
}
pub fn lift(
    b: &mut IntegerBuilder,
    i: &DecodedInstruction,
    count: u32,
) -> Result<(), CompileError> {
    let op = i.encoding.opcode;
    let string = op < 0x70;
    if string && (i.prefixes.rep || i.prefixes.repne) {
        return Err(CompileError::Unsupported("REP I/O must use batch frontend"));
    }
    let width = if op & 1 == 0 { 8 } else { i.operand_size };
    let bytes = b.constant((width / 8) as u32, Type::I32);
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    if string {
        let asize32 = b.constant(u32::from(i.address_size == 32), Type::I32);
        let segment = b.constant(i.prefixes.segment.unwrap_or(3) as u32, Type::I32);
        call(
            b,
            if op & 2 == 0 { "ir_ins_once" } else { "ir_outs_once" },
            vec![bytes, asize32, segment],
            map,
            true,
        );
        return Ok(());
    }
    let port = if matches!(op, 0xE4..=0xE7) {
        b.constant(i.immediate.unwrap(), Type::I32)
    }
    else {
        let p = b.read(2, 16);
        b.node(Op::Extend { signed: false }, vec![p], Type::I32)
    };
    let input = op & 2 == 0;
    if input {
        super::adapters::call_abi(
            b,
            "ir_in_continue",
            vec![port, bytes],
            map,
            crate::ir::helper::HelperAbi::CpuReload,
        );
    }
    else {
        let value = b.read(0, width);
        let value = if width < 32 {
            b.node(Op::Extend { signed: false }, vec![value], Type::I32)
        }
        else {
            value
        };
        super::adapters::call_abi(
            b,
            "ir_out_continue",
            vec![port, bytes, value],
            map,
            crate::ir::helper::HelperAbi::CpuReload,
        );
    }
    Ok(())
}
