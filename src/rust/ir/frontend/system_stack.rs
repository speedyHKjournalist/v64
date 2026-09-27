//! FLAGS and segment stacks with terminal authoritative-state CPU adapters.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{memory_read, memory_store, snapshot},
    stack::{adjusted, stack_address},
};
use crate::ir::{
    hir::{Binary, Op},
    ids::ValueId,
    state::ResumeKind,
    types::Type,
};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(
        i.encoding.opcode,
        0x06 | 0x07
            | 0x0E
            | 0x16
            | 0x17
            | 0x1E
            | 0x1F
            | 0x9C
            | 0x9D
            | 0x0FA0
            | 0x0FA1
            | 0x0FA8
            | 0x0FA9
    )
}
pub fn pops(i: &DecodedInstruction) -> bool { i.encoding.opcode & 1 != 0 }
fn segment(op: u32) -> u8 {
    match op {
        0x06 | 0x07 => 0,
        0x0E => 1,
        0x16 | 0x17 => 2,
        0x1E | 0x1F => 3,
        0x0FA0 | 0x0FA1 => 4,
        0x0FA8 | 0x0FA9 => 5,
        _ => unreachable!(),
    }
}
fn flags_value(b: &mut IntegerBuilder) -> ValueId {
    let mask = b.constant(!0x8D5, Type::I32);
    let mut value = b.binary(Binary::And, b.flags.system, mask);
    for (n, bit) in [0, 2, 4, 6, 7, 11].into_iter().enumerate() {
        let part = b.node(
            Op::Extend { signed: false },
            vec![b.flags.arithmetic[n]],
            Type::I32,
        );
        let shift = b.constant(bit, Type::I32);
        let part = b.binary(Binary::Shl, part, shift);
        value = b.binary(Binary::Or, value, part);
    }
    value
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let flags = matches!(i.encoding.opcode, 0x9C | 0x9D);
    let pop = pops(i);
    let width = i.operand_size;
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    if flags {
        call(b, "ir_flags_stack_check", vec![], map, false);
    }
    let mode = b.node(Op::ReadStack32, vec![], Type::I1);
    if pop {
        let address = stack_address(b, b.gpr[4], mode, map);
        let value = memory_read(b, address, width, map, false).0;
        let value = if width == 16 {
            b.node(Op::Extend { signed: false }, vec![value], Type::I32)
        }
        else {
            value
        };
        let bytes = b.constant((width / 8) as u32, Type::I32);
        if flags {
            call(b, "ir_pop_flags", vec![value, bytes], map, true);
        }
        else {
            let seg = b.constant(segment(i.encoding.opcode) as u32, Type::I32);
            call(b, "ir_pop_segment", vec![value, seg, bytes], map, true);
        }
    }
    else {
        let value = if flags {
            let value = flags_value(b);
            if width == 16 {
                b.node(Op::Truncate, vec![value], Type::I16)
            }
            else {
                let mask = b.constant(0xFCFFFF, Type::I32);
                b.binary(Binary::And, value, mask)
            }
        }
        else {
            b.node(
                Op::ReadSegment(segment(i.encoding.opcode)),
                vec![],
                Type::I16,
            )
        };
        let next = adjusted(b, b.gpr[4], mode, -(width as i32 / 8));
        let address = stack_address(b, next, mode, map);
        b.gpr[4] = next;
        // Operand32 segment pushes reserve four bytes but only write a word.
        memory_store(
            b,
            address,
            value,
            if flags { width } else { 16 },
            map,
            i,
            count,
            false,
        );
    }
}
