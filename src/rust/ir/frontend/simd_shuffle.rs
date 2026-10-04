//! Immediate shuffles use a pure byte permutation or an explicit faulting source read.
use super::{
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, segmented, snapshot},
    simd_moves::prepare,
};
use crate::ir::{
    hir::Op,
    simd::{PackedOp, ShuffleOp},
    state::ResumeKind,
    types::Type,
};
pub fn supports(i: &DecodedInstruction) -> bool {
    ShuffleOp::from_encoding(i.encoding.opcode).is_some()
        // PALIGNR xmm, xmm (an aligned memory operand: the SSE helper)
        || i.encoding.opcode == 0x660F3A0F && i.ea.is_none()
}
/// PALIGNR xmm, xmm, imm8: one shuffle of the destination with the source,
/// or with zero once imm8 reaches beyond the source
fn palignr(b: &mut IntegerBuilder, i: &DecodedInstruction) {
    let register = (i.modrm.unwrap() >> 3 & 7) as usize;
    let destination = b.xmm[register];
    let (lanes, zero) = crate::cpu::simd_int::palignr_lanes(i.immediate.unwrap() as u8, 16);
    let second = if zero {
        b.node(
            Op::VectorBinary(PackedOp::Xor),
            vec![destination, destination],
            Type::V128,
        )
    }
    else {
        b.xmm[(i.modrm.unwrap() & 7) as usize]
    };
    b.xmm[register] = b.node(
        Op::VectorShuffle(lanes),
        vec![destination, second],
        Type::V128,
    );
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    prepare(b, i, count);
    if i.encoding.opcode == 0x660F3A0F {
        return palignr(b, i);
    }
    let operation = ShuffleOp::from_encoding(i.encoding.opcode).unwrap();
    let immediate = i.immediate.unwrap() as u8;
    let register = i.modrm.unwrap() >> 3 & 7;
    let destination = b.xmm[register as usize];
    let value = if let Some(ea) = i.ea {
        let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
        b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        let values = b.region.append(
            b.block,
            Op::XmmShuffle {
                operation,
                immediate,
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
            Op::VectorShuffle(operation.lanes(immediate)),
            vec![destination, b.xmm[(i.modrm.unwrap() & 7) as usize]],
            Type::V128,
        )
    };
    b.xmm[register as usize] = value;
}
