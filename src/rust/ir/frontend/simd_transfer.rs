//! Half-vector and duplicate transfers preserve callback-visible target sampling.
use super::{
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, segmented, snapshot},
    simd_moves::prepare,
};
use crate::ir::{hir::Op, simd::TransferOp, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    TransferOp::from_encoding(i.encoding.opcode).is_some()
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    prepare(b, i, count);
    let operation = TransferOp::from_encoding(i.encoding.opcode).unwrap();
    let register = i.modrm.unwrap() >> 3 & 7;
    let destination = b.xmm[register as usize];
    let value = if let Some(ea) = i.ea {
        let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
        b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        let values = b.region.append(
            b.block,
            Op::XmmTransferLoad {
                operation,
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
        let mut lanes = operation.lanes();
        if i.encoding.opcode == 0x0F12 {
            // Register MOVHLPS takes the source high qword; memory MOVLPS takes low.
            for byte in &mut lanes[..8] {
                *byte += 8;
            }
        }
        b.node(
            Op::VectorShuffle(lanes),
            vec![destination, b.xmm[(i.modrm.unwrap() & 7) as usize]],
            Type::V128,
        )
    };
    b.xmm[register as usize] = value;
}
