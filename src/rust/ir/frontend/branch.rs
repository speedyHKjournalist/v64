//! Terminal relative branches, with independent counter and target widths.
use super::{
    decode::{DecodedInstruction, GuestEip},
    integer::IntegerBuilder,
    lift::snapshot,
};
use crate::ir::{
    hir::{Binary, Edge, Terminator},
    types::Type,
};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode,0x70..=0x7F|0x0F80..=0x0F8F|0xE0..=0xE3|0xE9|0xEB)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let op = i.encoding.opcode;
    let condition = if matches!(op, 0xE9 | 0xEB) {
        None
    }
    else if matches!(op, 0xE0..=0xE3) {
        let mut counter = b.read(1, i.address_size);
        if op != 0xE3 {
            let one = b.constant(1, b.ty(counter));
            // LOOP decrements without changing any FLAGS source.
            counter = b.binary(Binary::Sub, counter, one);
            b.write(1, i.address_size, counter);
        }
        let zero = b.constant(0, b.ty(counter));
        let is_zero = b.binary(Binary::Eq, counter, zero);
        let condition = if op == 0xE3 {
            is_zero
        }
        else {
            let one = b.constant(1, Type::I1);
            let nonzero = b.binary(Binary::Xor, is_zero, one);
            if op == 0xE2 {
                nonzero
            }
            else {
                let zf = if op == 0xE1 {
                    b.flags.arithmetic[3]
                }
                else {
                    b.binary(Binary::Xor, b.flags.arithmetic[3], one)
                };
                b.binary(Binary::And, nonzero, zf)
            }
        };
        Some(condition)
    }
    else {
        Some(b.condition(op as u8 & 15))
    };
    let target = i.next_pc.0.wrapping_add(i.immediate.unwrap());
    let target = GuestEip(if i.operand_size == 16 { target & 65535 } else { target });
    let taken = snapshot(b, i.instruction_pc, target, count);
    if let Some(condition) = condition {
        // Untaken fallthrough is the decoded next PC; do not apply the taken
        // 16-bit target mask to a fallthrough crossing the 64 KiB boundary.
        let not_taken = snapshot(b, i.instruction_pc, i.next_pc, count);
        let yes = b.region.block(false);
        let no = b.region.block(false);
        for (block, map) in [(yes, taken), (no, not_taken)] {
            b.region.blocks[block.index()].entry_state = Some(map);
            b.region.terminate(block, Terminator::Exit(map));
        }
        b.region.terminate(
            b.block,
            Terminator::CondBranch {
                condition,
                taken: Edge {
                    target: yes,
                    args: vec![],
                },
                not_taken: Edge {
                    target: no,
                    args: vec![],
                },
            },
        );
    }
    else {
        b.region.terminate(b.block, Terminator::Exit(taken));
    }
}
