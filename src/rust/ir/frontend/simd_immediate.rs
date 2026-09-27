//! Packed immediate shifts retain the full imm8 and execute the SSE guard even at zero.
use super::{decode::DecodedInstruction, integer::IntegerBuilder, simd_moves::prepare};
use crate::ir::{hir::Op, simd::PackedOp, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    i.ea.is_none()
        && match i.encoding.opcode {
            0x660F71 | 0x660F72 => matches!(i.encoding.group, 2 | 4 | 6),
            0x660F73 => matches!(i.encoding.group, 2 | 3 | 6 | 7),
            _ => false,
        }
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    prepare(b, i, count);
    let register = (i.modrm.unwrap() & 7) as usize;
    let destination = b.xmm[register];
    let immediate = i.immediate.unwrap() as u8;
    let zero = b.node(
        Op::VectorBinary(PackedOp::Xor),
        vec![destination, destination],
        Type::V128,
    );
    let value = if i.encoding.opcode == 0x660F73 && matches!(i.encoding.group, 3 | 7) {
        let mut lanes = [16; 16];
        let left = i.encoding.group == 7;
        for n in 0..16i16 {
            let index = if left { n - immediate as i16 } else { n + immediate as i16 };
            if (0..16).contains(&index) {
                lanes[n as usize] = index as u8;
            }
        }
        b.node(
            Op::VectorShuffle(lanes),
            vec![destination, zero],
            Type::V128,
        )
    }
    else {
        let opcode = match i.encoding.group {
            2 => 0xD1,
            4 => 0xE1,
            6 => 0xF1,
            _ => unreachable!(),
        } + (i.encoding.opcode & 255)
            - 0x71;
        let operation = PackedOp::from_id(opcode).unwrap();
        let count = b.node(Op::Const(immediate as u64), vec![], Type::I64);
        let source = b.node(
            Op::VectorReplace { bits: 64, lane: 0 },
            vec![zero, count],
            Type::V128,
        );
        b.node(
            Op::VectorBinary(operation),
            vec![destination, source],
            Type::V128,
        )
    };
    b.xmm[register] = value;
}
