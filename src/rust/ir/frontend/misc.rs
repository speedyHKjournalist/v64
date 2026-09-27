//! Scalar conversions, flag transfer, BCD and implicit-address loads/stores.
use super::{
    decode::DecodedInstruction,
    integer::{width_type, IntegerBuilder},
    lift::{memory_read, memory_store, segmented, snapshot},
};
use crate::ir::{
    hir::{Binary, Op},
    ids::ValueId,
    state::ResumeKind,
    types::Type,
};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode,0x27|0x2F|0x37|0x3F|0x98|0x99|0x9E|0x9F|0xA0..=0xA3|0xD4..=0xD7|0xFC|0xFD)
}
pub fn needs_cpu(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0xA0..=0xA3 | 0xD4 | 0xD7)
}
fn c(b: &mut IntegerBuilder, op: Binary, a: ValueId, n: u32) -> ValueId {
    let n = b.constant(n, b.ty(a));
    b.binary(op, a, n)
}
fn select(b: &mut IntegerBuilder, cond: ValueId, a: ValueId, d: ValueId) -> ValueId {
    b.node(Op::Select, vec![cond, a, d], b.ty(a))
}
fn szp(b: &mut IntegerBuilder, value: ValueId) {
    let zero = b.constant(0, Type::I8);
    b.flags.arithmetic[3] = b.binary(Binary::Eq, value, zero);
    b.flags.zero_is_lazy = Some(b.constant(1, Type::I1));
    b.flags.arithmetic[4] = b.extract(value, 7, Type::I1);
    let mut parity = b.extract(value, 0, Type::I1);
    for bit in 1..8 {
        let v = b.extract(value, bit, Type::I1);
        parity = b.binary(Binary::Xor, parity, v);
    }
    b.flags.arithmetic[1] = c(b, Binary::Xor, parity, 1);
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let op = i.encoding.opcode;
    if matches!(op, 0xA0..=0xA3 | 0xD7) {
        let width = if op == 0xD7 || op & 1 == 0 { 8 } else { i.operand_size };
        let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
        b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
        let offset = if op == 0xD7 {
            let al = b.read(0, 8);
            let al = b.node(Op::Extend { signed: false }, vec![al], Type::I32);
            let sum = b.binary(Binary::Add, b.gpr[3], al);
            if i.address_size == 16 {
                c(b, Binary::And, sum, 65535)
            }
            else {
                sum
            }
        }
        else {
            b.constant(i.immediate.unwrap(), Type::I32)
        };
        let address = segmented(b, offset, i.prefixes.segment.unwrap_or(3), map);
        if matches!(op, 0xA2 | 0xA3) {
            let value = b.read(0, width);
            memory_store(b, address, value, width, map, i, count, false);
        }
        else {
            let value = memory_read(b, address, width, map, false).0;
            b.write(0, width, value);
        }
        return;
    }
    match op {
        0x98 => {
            let width = i.operand_size;
            let value = b.read(0, width / 2);
            let value = b.node(Op::Extend { signed: true }, vec![value], width_type(width));
            b.write(0, width, value);
        },
        0x99 => {
            let value = b.read(0, i.operand_size);
            let value = c(b, Binary::Sar, value, (i.operand_size - 1) as u32);
            b.write(2, i.operand_size, value);
        },
        0x9E => {
            b.invalidate_flag_backing();
            let ah = b.read(4, 8);
            for (n, bit) in [0, 2, 4, 6, 7].into_iter().enumerate() {
                b.flags.arithmetic[n] = b.extract(ah, bit, Type::I1);
            }
            b.flags.raw_zero = Some(b.flags.arithmetic[3]);
            b.flags.zero_is_lazy = Some(b.constant(0, Type::I1));
            let mask = crate::cpu::cpu::FLAGS_MASK as u32 & !255;
            let system = c(b, Binary::And, b.flags.system, mask);
            b.flags.system = c(b, Binary::Or, system, crate::cpu::cpu::FLAGS_DEFAULT as u32);
        },
        0x9F => {
            let mut value = c(b, Binary::And, b.flags.system, 255 & !0xD5);
            for (n, bit) in [0, 2, 4, 6, 7].into_iter().enumerate() {
                let v = b.node(
                    Op::Extend { signed: false },
                    vec![b.flags.arithmetic[n]],
                    Type::I32,
                );
                let v = c(b, Binary::Shl, v, bit);
                value = b.binary(Binary::Or, value, v);
            }
            let value = b.node(Op::Truncate, vec![value], Type::I8);
            b.write(4, 8, value);
        },
        0xFC | 0xFD => {
            let direction = b.constant((op == 0xFD) as u32, Type::I1);
            b.preserve_raw_flag_bit(direction, 10);
            b.flags.system = c(
                b,
                if op == 0xFC { Binary::And } else { Binary::Or },
                b.flags.system,
                if op == 0xFC { !1024 } else { 1024 },
            )
        },
        0xD6 => {
            let carry = b.node(
                Op::Extend { signed: true },
                vec![b.flags.arithmetic[0]],
                Type::I8,
            );
            b.write(0, 8, carry);
        },
        0x37 | 0x3F => {
            b.invalidate_flag_backing();
            let al = b.read(0, 8);
            let low = c(b, Binary::And, al, 15);
            let nine = b.constant(9, Type::I8);
            let adjust = b.binary(Binary::Ult, nine, low);
            let adjust = b.binary(Binary::Or, adjust, b.flags.arithmetic[2]);
            let ax = b.read(0, 16);
            let changed = c(
                b,
                if op == 0x37 { Binary::Add } else { Binary::Sub },
                ax,
                0x106,
            );
            let value = select(b, adjust, changed, ax);
            let value = c(b, Binary::And, value, 0xFF0F);
            b.write(0, 16, value);
            b.flags.arithmetic[0] = adjust;
            b.flags.arithmetic[2] = adjust;
        },
        0x27 | 0x2F => {
            b.invalidate_flag_backing();
            let al = b.read(0, 8);
            let low = c(b, Binary::And, al, 15);
            let nine = b.constant(9, Type::I8);
            let low_adjust = b.binary(Binary::Ult, nine, low);
            let low_adjust = b.binary(Binary::Or, low_adjust, b.flags.arithmetic[2]);
            let limit = b.constant(153, Type::I8);
            let high_adjust = b.binary(Binary::Ult, limit, al);
            let high_adjust = b.binary(Binary::Or, high_adjust, b.flags.arithmetic[0]);
            let arith = if op == 0x27 { Binary::Add } else { Binary::Sub };
            let six = c(b, arith, al, 6);
            let first = select(b, low_adjust, six, al);
            let ninety_six = c(b, arith, first, 96);
            let result = select(b, high_adjust, ninety_six, first);
            let carry = if op == 0x2F {
                let six = b.constant(6, Type::I8);
                let borrow = b.binary(Binary::Ult, al, six);
                let borrow = b.binary(Binary::And, low_adjust, borrow);
                b.binary(Binary::Or, high_adjust, borrow)
            }
            else {
                high_adjust
            };
            b.write(0, 8, result);
            szp(b, result);
            b.flags.arithmetic[0] = carry;
            b.flags.arithmetic[2] = low_adjust;
            // Undefined OF follows the stable preserve-input policy, independent
            // of whether the incoming CPU flags happened to be lazy.
        },
        0xD5 => {
            b.invalidate_flag_backing();
            let al = b.read(0, 8);
            let ah = b.read(4, 8);
            let product = c(b, Binary::Mul, ah, i.immediate.unwrap());
            let value = b.binary(Binary::Add, al, product);
            let ax = b.node(Op::Extend { signed: false }, vec![value], Type::I16);
            b.write(0, 16, ax);
            szp(b, value);
            let zero = b.constant(0, Type::I1);
            for n in [0, 2, 5] {
                b.flags.arithmetic[n] = zero;
            }
        },
        0xD4 => {
            let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
            b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
            let al = b.read(0, 8);
            let al = b.node(Op::Extend { signed: false }, vec![al], Type::I64);
            let divisor = b.constant(i.immediate.unwrap(), Type::I64);
            let values = b.region.append(
                b.block,
                Op::Divide {
                    bits: 8,
                    signed: false,
                },
                vec![al, divisor, b.effect],
                &[Type::I8, Type::I8, Type::Effect],
                Some(map),
            );
            b.effect = values[2];
            b.invalidate_flag_backing();
            b.write(4, 8, values[0]);
            b.write(0, 8, values[1]);
            szp(b, values[1]);
            let zero = b.constant(0, Type::I1);
            for n in [0, 2, 5] {
                b.flags.arithmetic[n] = zero;
            }
        },
        _ => unreachable!(),
    }
}
