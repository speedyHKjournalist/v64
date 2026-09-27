//! Packed integer ALU with vector SSA and CPU-owned slow read completion.
use super::{
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, segmented, snapshot},
    simd_moves::prepare,
};
use crate::ir::{hir::Op, simd::PackedOp, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    PackedOp::from_encoding(i.encoding.opcode).is_some()
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    prepare(b, i, count);
    let operation = PackedOp::from_encoding(i.encoding.opcode).unwrap();
    let register = i.modrm.unwrap() >> 3 & 7;
    let destination = b.xmm[register as usize];
    let value = if let Some(ea) = i.ea {
        let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
        b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        let values = b.region.append(
            b.block,
            Op::XmmBinary {
                operation,
                bytes: if matches!(i.encoding.opcode, 0x0F14 | 0x660F14) { 8 } else { 16 },
                register,
            },
            vec![address, destination, b.effect],
            &[Type::V128, Type::Effect],
            Some(map),
        );
        b.effect = values[1];
        values[0]
    }
    else {
        b.node(
            Op::VectorBinary(operation),
            vec![destination, b.xmm[(i.modrm.unwrap() & 7) as usize]],
            Type::V128,
        )
    };
    b.xmm[register as usize] = value;
}
