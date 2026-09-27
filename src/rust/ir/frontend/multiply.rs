//! MUL/IMUL and guarded DIV/IDIV. Wide arithmetic stays in native i64 HIR.
use super::{
    decode::DecodedInstruction,
    integer::{width_type, IntegerBuilder},
    lift::{effective_offset, memory_read, segmented, snapshot},
};
use crate::ir::{
    hir::{Binary, Op},
    ids::ValueId,
    state::ResumeKind,
    types::Type,
};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0x69 | 0x6B | 0x0FAF)
        || matches!(i.encoding.opcode, 0xF6 | 0xF7) && i.modrm.unwrap() >> 3 & 7 >= 4
}
pub fn divides(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0xF6 | 0xF7) && i.modrm.unwrap() >> 3 & 7 >= 6
}
fn extend(b: &mut IntegerBuilder, value: ValueId, signed: bool) -> ValueId {
    b.node(Op::Extend { signed }, vec![value], Type::I64)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let op = i.encoding.opcode;
    let group = i.modrm.unwrap() >> 3 & 7;
    let width = if op == 0xF6 { 8 } else { i.operand_size };
    let ty = width_type(width);
    let implicit = matches!(op, 0xF6 | 0xF7);
    let signed = !implicit || group & 1 != 0;
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    let source = if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        memory_read(b, address, width, map, false).0
    }
    else {
        b.read(i.modrm.unwrap() & 7, width)
    };
    if divides(i) {
        let dividend = if width == 8 {
            b.read(0, 16)
        }
        else {
            let low = b.read(0, width);
            let high = b.read(2, width);
            let double = if width == 16 { Type::I32 } else { Type::I64 };
            let zero = b.node(Op::Const(0), vec![], double);
            let both = b.node(Op::Insert { lsb: 0 }, vec![zero, low], double);
            b.node(Op::Insert { lsb: width }, vec![both, high], double)
        };
        let dividend = if width == 32 { dividend } else { extend(b, dividend, signed) };
        let divisor = extend(b, source, signed);
        let values = b.region.append(
            b.block,
            Op::Divide {
                bits: width,
                signed,
            },
            vec![dividend, divisor, b.effect],
            &[ty, ty, Type::Effect],
            Some(map),
        );
        b.effect = values[2];
        b.write(0, width, values[0]);
        b.write(if width == 8 { 4 } else { 2 }, width, values[1]);
        return;
    }
    let other = if implicit {
        b.read(0, width)
    }
    else if let Some(imm) = i.immediate {
        b.constant(imm, ty)
    }
    else {
        b.read(group, width)
    };
    let a = extend(b, source, signed);
    let other = extend(b, other, signed);
    let product = b.binary(Binary::Mul, a, other);
    let low = b.node(Op::Truncate, vec![product], ty);
    let expected = extend(b, low, signed);
    let fits = b.binary(Binary::Eq, product, expected);
    let one = b.constant(1, Type::I1);
    let overflow = b.binary(Binary::Xor, fits, one);
    let result =
        if width == 32 { low } else { b.node(Op::Extend { signed: false }, vec![low], Type::I32) };
    super::shift::shift_flags(b, result, overflow, overflow, width);
    b.preserve_mul_backing(result, overflow, width);
    if implicit {
        if width == 8 {
            let ax = b.node(Op::Truncate, vec![product], Type::I16);
            b.write(0, 16, ax);
        }
        else {
            let high = b.extract(product, width, ty);
            b.write(0, width, low);
            b.write(2, width, high);
        }
    }
    else {
        b.write(group, width, low);
    }
}
