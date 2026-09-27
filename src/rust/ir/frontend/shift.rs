//! Native group-2 and double shifts, including pinned undefined FLAGS behavior.
use super::{
    decode::DecodedInstruction,
    integer::{width_type, IntegerBuilder},
    lift::{effective_offset, memory_read, memory_store, segmented, snapshot},
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
        0xC0 | 0xC1 | 0xD0..=0xD3 | 0x0FA4 | 0x0FA5 | 0x0FAC | 0x0FAD
    )
}
fn wide(b: &mut IntegerBuilder, value: ValueId, signed: bool) -> ValueId {
    if b.ty(value) == Type::I32 {
        value
    }
    else {
        b.node(Op::Extend { signed }, vec![value], Type::I32)
    }
}
fn number(b: &mut IntegerBuilder, value: u32) -> ValueId { b.constant(value, Type::I32) }
fn with_constant(b: &mut IntegerBuilder, op: Binary, a: ValueId, c: u32) -> ValueId {
    let c = number(b, c);
    b.binary(op, a, c)
}
fn from_constant(b: &mut IntegerBuilder, c: u32, op: Binary, a: ValueId) -> ValueId {
    let c = number(b, c);
    b.binary(op, c, a)
}
fn select(b: &mut IntegerBuilder, test: ValueId, yes: ValueId, no: ValueId) -> ValueId {
    b.node(Op::Select, vec![test, yes, no], b.ty(yes))
}
fn combine(
    b: &mut IntegerBuilder,
    a: ValueId,
    left: ValueId,
    c: ValueId,
    right: ValueId,
) -> ValueId {
    let a = b.binary(Binary::Shl, a, left);
    let c = b.binary(Binary::Shr, c, right);
    b.binary(Binary::Or, a, c)
}
fn modulo(b: &mut IntegerBuilder, mut n: ValueId, modulus: u32) -> ValueId {
    // Input is <=31. Avoid a trapping/remainder operation in the pure HIR.
    for _ in 0..31 / modulus {
        let m = number(b, modulus);
        let less = b.binary(Binary::Ult, n, m);
        let sub = b.binary(Binary::Sub, n, m);
        n = select(b, less, n, sub);
    }
    n
}
pub(super) fn shift_flags(
    b: &mut IntegerBuilder,
    result: ValueId,
    cf: ValueId,
    of: ValueId,
    width: u8,
) {
    let last = b.flags.last_op1.unwrap();
    let other = b.binary(Binary::Sub, result, last);
    let xor = b.binary(Binary::Xor, last, other);
    let xor = b.binary(Binary::Xor, xor, result);
    let af = b.extract(xor, 4, Type::I1);
    let zero = number(b, 0);
    let zf = b.binary(Binary::Eq, result, zero);
    let sf = b.extract(result, width - 1, Type::I1);
    let mut pf = b.extract(result, 0, Type::I1);
    for bit in 1..8 {
        let next = b.extract(result, bit, Type::I1);
        pf = b.binary(Binary::Xor, pf, next);
    }
    let one = b.constant(1, Type::I1);
    let pf = b.binary(Binary::Xor, pf, one);
    b.flags.arithmetic = [cf, pf, af, zf, sf, of];
    b.flags.zero_is_lazy = Some(one);
}
fn calculate(
    b: &mut IntegerBuilder,
    i: &DecodedInstruction,
    value: ValueId,
    count: ValueId,
    width: u8,
) -> ValueId {
    let a = wide(b, value, false);
    let old = b.flags.arithmetic;
    let old_zero_lazy = b.flags.zero_is_lazy.unwrap();
    let group = i.modrm.unwrap() >> 3 & 7;
    let double = i.encoding.opcode > 255;
    let mut n = with_constant(b, Binary::And, count, 31);
    if !double && matches!(group, 2 | 3) && width < 32 {
        n = modulo(b, n, width as u32 + 1);
    }
    let zero = number(b, 0);
    let unchanged = b.binary(Binary::Eq, n, zero);
    let previous = with_constant(b, Binary::Sub, n, 1);
    let cf;
    let of;
    let raw;
    if !double && group < 4 {
        if group < 2 {
            let rotate = with_constant(b, Binary::And, n, width as u32 - 1);
            let inverse = from_constant(b, width as u32, Binary::Sub, rotate);
            raw = if group == 0 {
                combine(b, a, rotate, a, inverse)
            }
            else {
                combine(b, a, inverse, a, rotate)
            };
            cf = b.extract(raw, if group == 0 { 0 } else { width - 1 }, Type::I1);
        }
        else if width < 32 {
            let carry = wide(b, old[0], false);
            let carry = with_constant(b, Binary::Shl, carry, width as u32);
            let packed = b.binary(Binary::Or, a, carry);
            let inverse = from_constant(b, width as u32 + 1, Binary::Sub, n);
            raw = if group == 2 {
                combine(b, packed, n, packed, inverse)
            }
            else {
                combine(b, packed, inverse, packed, n)
            };
            cf = b.extract(raw, width, Type::I1);
        }
        else {
            let carry = wide(b, old[0], false);
            let inverse = from_constant(b, 32, Binary::Sub, n);
            let through = from_constant(b, 33, Binary::Sub, n);
            let more_than_one = from_constant(b, 1, Binary::Ult, n);
            let extra = b.binary(
                if group == 2 { Binary::Shr } else { Binary::Shl },
                a,
                through,
            );
            let extra = select(b, more_than_one, extra, zero);
            let first = b.binary(if group == 2 { Binary::Shl } else { Binary::Shr }, a, n);
            let carry = b.binary(
                Binary::Shl,
                carry,
                if group == 2 { previous } else { inverse },
            );
            let first = b.binary(Binary::Or, first, carry);
            raw = b.binary(Binary::Or, first, extra);
            let carry = b.binary(Binary::Shr, a, if group == 2 { inverse } else { previous });
            cf = b.extract(carry, 0, Type::I1);
        }
        let high = b.extract(raw, width - 1, Type::I1);
        let other = if group & 1 == 0 { cf } else { b.extract(raw, width - 2, Type::I1) };
        of = b.binary(Binary::Xor, high, other);
        b.flags.arithmetic[0] = cf;
        b.flags.arithmetic[5] = of;
    }
    else if double {
        let source = b.read(group, width);
        let source = wide(b, source, false);
        let left = i.encoding.opcode & 8 == 0;
        let inverse = from_constant(b, width as u32, Binary::Sub, n);
        let first = if left {
            combine(b, a, n, source, inverse)
        }
        else {
            combine(b, source, inverse, a, n)
        };
        let carry = b.binary(Binary::Shr, a, if left { inverse } else { previous });
        let first_cf = b.extract(carry, 0, Type::I1);
        if width == 16 {
            let excess = with_constant(b, Binary::Sub, n, 16);
            let inverse = from_constant(b, 32, Binary::Sub, n);
            let second = if left {
                combine(b, source, excess, a, inverse)
            }
            else {
                combine(b, a, inverse, source, excess)
            };
            let carry_count = if left { inverse } else { with_constant(b, Binary::Sub, n, 17) };
            let carry = b.binary(Binary::Shr, source, carry_count);
            let second_cf = b.extract(carry, 0, Type::I1);
            let large = from_constant(b, 16, Binary::Ult, n);
            raw = select(b, large, second, first);
            cf = select(b, large, second_cf, first_cf);
        }
        else {
            raw = first;
            cf = first_cf;
        }
        let high = b.extract(raw, width - 1, Type::I1);
        if left {
            let overflow = b.binary(Binary::Xor, cf, high);
            of = if width == 32 {
                let one = number(b, 1);
                let one = b.binary(Binary::Eq, n, one);
                b.binary(Binary::And, one, overflow)
            }
            else {
                overflow
            };
        }
        else {
            let old_high = b.extract(a, width - 1, Type::I1);
            of = b.binary(Binary::Xor, old_high, high);
        }
    }
    else {
        match group {
            4 | 6 => {
                raw = b.binary(Binary::Shl, a, n);
                cf = if width == 32 {
                    let inverse = from_constant(b, 32, Binary::Sub, n);
                    let carry = b.binary(Binary::Shr, a, inverse);
                    b.extract(carry, 0, Type::I1)
                }
                else {
                    b.extract(raw, width, Type::I1)
                };
                let high = b.extract(raw, width - 1, Type::I1);
                of = b.binary(Binary::Xor, cf, high);
            },
            5 | 7 => {
                let signed = if group == 7 { wide(b, value, true) } else { a };
                let op = if group == 7 { Binary::Sar } else { Binary::Shr };
                raw = b.binary(op, signed, n);
                let carry = b.binary(op, signed, previous);
                cf = b.extract(carry, 0, Type::I1);
                of = if group == 7 {
                    b.constant(0, Type::I1)
                }
                else {
                    b.extract(a, width - 1, Type::I1)
                };
            },
            _ => unreachable!(),
        }
    }
    let result =
        if width < 32 { with_constant(b, Binary::And, raw, (1u32 << width) - 1) } else { raw };
    if double || group >= 4 {
        shift_flags(b, result, cf, of, width);
    }
    for (bit, previous) in old.into_iter().enumerate() {
        b.flags.arithmetic[bit] = select(b, unchanged, previous, b.flags.arithmetic[bit]);
    }
    b.flags.zero_is_lazy = Some(select(
        b,
        unchanged,
        old_zero_lazy,
        b.flags.zero_is_lazy.unwrap(),
    ));
    if !double && group < 4 {
        b.preserve_rotate_backing(unchanged, cf, of);
    }
    else {
        b.preserve_shift_backing(unchanged, raw, cf, of, width);
    }
    let result = select(b, unchanged, a, result);
    if width == 32 {
        result
    }
    else {
        b.node(Op::Truncate, vec![result], width_type(width))
    }
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, committed: u32) {
    let op = i.encoding.opcode;
    let width = if op < 256 && op & 1 == 0 { 8 } else { i.operand_size };
    let count = if matches!(op, 0xD0 | 0xD1) {
        number(b, 1)
    }
    else if let Some(count) = i.immediate {
        number(b, count)
    }
    else {
        let cl = b.read(1, 8);
        wide(b, cl, false)
    };
    if let Some(ea) = i.ea {
        let map = snapshot(b, i.instruction_pc, i.next_pc, committed - 1);
        b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        // Count zero still performs the pinned RMW permission/read/write path.
        let (value, ticket) = memory_read(b, address, width, map, true);
        let result = calculate(b, i, value, count, width);
        memory_store(b, ticket.unwrap(), result, width, map, i, committed, true);
    }
    else {
        let reg = i.modrm.unwrap() & 7;
        let value = b.read(reg, width);
        let result = calculate(b, i, value, count, width);
        b.write(reg, width, result);
    }
}
