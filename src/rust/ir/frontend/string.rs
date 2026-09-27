//! Single-iteration string semantics. REP needs a separate progress contract.
use super::{
    decode::DecodedInstruction,
    integer::{width_type, IntegerBuilder},
    lift::{memory_read, memory_store, segmented, snapshot},
};
use crate::ir::{
    hir::{Binary, Op},
    ids::ValueId,
    lowering::CompileError,
    state::ResumeKind,
    types::Type,
};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0xA4..=0xA7 | 0xAA..=0xAF)
}
fn offset(b: &mut IntegerBuilder, register: u8, width: u8) -> ValueId {
    let value = b.read(register, width);
    if width == 16 {
        b.node(Op::Extend { signed: false }, vec![value], Type::I32)
    }
    else {
        value
    }
}
pub fn lift(
    b: &mut IntegerBuilder,
    i: &DecodedInstruction,
    count: u32,
) -> Result<(), CompileError> {
    if i.prefixes.rep || i.prefixes.repne {
        return Err(CompileError::Unsupported("REP must use batch frontend"));
    }
    let family = i.encoding.opcode & !1;
    let width = if i.encoding.opcode & 1 == 0 { 8 } else { i.operand_size };
    let source = matches!(family, 0xA4 | 0xA6 | 0xAC);
    let destination = family != 0xAC;
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    // The pinned CPU validates ES before the source segment. SCAS also validates
    // ES again through its wrapper's fixed source-segment argument.
    let dst = if destination {
        let off = offset(b, 7, i.address_size);
        Some(segmented(b, off, 0, map))
    }
    else {
        None
    };
    let src = if source || family == 0xAE {
        let off = if source { offset(b, 6, i.address_size) } else { b.constant(0, Type::I32) };
        Some(segmented(
            b,
            off,
            if family == 0xAE { 0 } else { i.prefixes.segment.unwrap_or(3) },
            map,
        ))
    }
    else {
        None
    };
    let data =
        if source { memory_read(b, src.unwrap(), width, map, false).0 } else { b.read(0, width) };
    if matches!(family, 0xA6 | 0xAE) {
        let other = memory_read(b, dst.unwrap(), width, map, false).0;
        b.arithmetic(7, data, other);
    }
    else if family == 0xAC {
        b.write(0, width, data);
    }
    let ty = width_type(i.address_size);
    let df = b.extract(b.flags.system, 10, Type::I1);
    let forward = b.constant((width / 8) as u32, ty);
    let backward = b.constant(0u32.wrapping_sub((width / 8) as u32), ty);
    let delta = b.node(Op::Select, vec![df, backward, forward], ty);
    for reg in [6, 7] {
        if (reg == 6 && source) || (reg == 7 && destination) {
            let old = b.read(reg, i.address_size);
            let new = b.binary(Binary::Add, old, delta);
            b.write(reg, i.address_size, new);
        }
    }
    if matches!(family, 0xA4 | 0xAA) {
        // Pure SSA pointer updates belong to the successful store's commit map;
        // the fault map still contains the old pointers and FLAGS.
        memory_store(b, dst.unwrap(), data, width, map, i, count, false);
    }
    Ok(())
}
