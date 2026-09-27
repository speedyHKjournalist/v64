//! Exchange and compare/exchange with source capture and ordered commit.
use super::{
    decode::DecodedInstruction,
    integer::{width_type, IntegerBuilder},
    lift::{effective_offset, memory_read, memory_store, segmented, snapshot},
};
use crate::ir::{hir::Op, state::ResumeKind};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(
        i.encoding.opcode,
        0x86 | 0x87 | 0x0FB0 | 0x0FB1 | 0x0FC0 | 0x0FC1
    )
}
/// LOCK forms whose complete memory RMW path has a checked affine pair. Other
/// prefixes/forms remain compile stops, including the pinned interpreter's TODOs.
pub fn lock_supported(i: &DecodedInstruction) -> bool {
    if i.ea.is_none() {
        return false;
    }
    let op = i.encoding.opcode;
    let g = i.modrm.unwrap() >> 3 & 7;
    supports(i)
        || op == 0x0FC7 && g == 1
        || op <= 0x31 && op & 7 <= 1
        || matches!(op, 0x80 | 0x81 | 0x83) && g != 7
        || matches!(op, 0xFE | 0xFF) && g < 2
        || matches!(op, 0xF6 | 0xF7) && matches!(g, 2 | 3)
        || matches!(op, 0x0FAB | 0x0FB3 | 0x0FBB)
        || op == 0x0FBA && g >= 5
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let op = i.encoding.opcode;
    let reg = i.modrm.unwrap() >> 3 & 7;
    let rm = i.modrm.unwrap() & 7;
    let width = if op & 1 == 0 { 8 } else { i.operand_size };
    let ty = width_type(width);
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    let source = b.read(reg, width);
    let (destination, ticket) = if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        memory_read(b, address, width, map, true)
    }
    else {
        (b.read(rm, width), None)
    };
    let result = if matches!(op, 0x86 | 0x87) {
        b.write(reg, width, destination);
        source
    }
    else if matches!(op, 0x0FC0 | 0x0FC1) {
        let sum = b.arithmetic(0, destination, source);
        // This write precedes the destination write, including identical aliases.
        b.write(reg, width, destination);
        sum
    }
    else {
        let accumulator = b.read(0, width);
        b.arithmetic(7, accumulator, destination);
        let equal = b.flags.arithmetic[3];
        let updated = b.node(Op::Select, vec![equal, accumulator, destination], ty);
        b.write(0, width, updated);
        // A failed comparison still performs the baseline memory write cycle.
        b.node(Op::Select, vec![equal, source, destination], ty)
    };
    if let Some(ticket) = ticket {
        memory_store(b, ticket, result, width, map, i, count, true);
    }
    else {
        b.write(rm, width, result);
    }
}
