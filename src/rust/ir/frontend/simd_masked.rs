//! MASKMOVDQU preflights the whole range even when its mask selects no bytes.
use super::{
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{segmented, snapshot},
    simd_moves::prepare,
};
use crate::ir::{hir::Op, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool { i.encoding.opcode == 0x660FF7 }
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    prepare(b, i, count);
    let source = i.modrm.unwrap() >> 3 & 7;
    let mask = i.modrm.unwrap() & 7;
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    let offset = b.read(7, i.address_size);
    let offset = if i.address_size == 16 {
        b.node(Op::Extend { signed: false }, vec![offset], Type::I32)
    }
    else {
        offset
    };
    let address = segmented(b, offset, i.prefixes.segment.unwrap_or(3), map);
    b.effect = b.region.append(
        b.block,
        Op::XmmMaskedStore { source, mask },
        vec![
            address,
            b.xmm[source as usize],
            b.xmm[mask as usize],
            b.effect,
        ],
        &[Type::Effect],
        Some(map),
    )[0];
    let store = *b.region.blocks[b.block.index()]
        .instructions
        .last()
        .unwrap();
    let commit = snapshot(b, i.instruction_pc, i.next_pc, count);
    b.region.instructions[store.index()].commit = Some(commit);
}
