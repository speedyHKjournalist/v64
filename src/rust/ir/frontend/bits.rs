//! Register bits, byte-addressed memory bit strings, scans and population count.
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
        0x0FA3 | 0x0FAB | 0x0FB3 | 0x0FBB | 0x0FBC | 0x0FBD | 0xF30FB8 | 0x0FC8..=0x0FCF
    ) || i.encoding.opcode == 0x0FBA && i.modrm.unwrap() >> 3 & 7 >= 4
}
fn wide(b: &mut IntegerBuilder, value: ValueId, signed: bool) -> ValueId {
    if b.ty(value) == Type::I32 {
        value
    }
    else {
        b.node(Op::Extend { signed }, vec![value], Type::I32)
    }
}
fn constant_op(b: &mut IntegerBuilder, op: Binary, value: ValueId, constant: u32) -> ValueId {
    let constant = b.constant(constant, Type::I32);
    b.binary(op, value, constant)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let op = i.encoding.opcode;
    if (0x0FC8..=0x0FCF).contains(&op) {
        // Pinned BSWAP always operates on the complete dword, even with 66.
        let register = op as u8 & 7;
        let value = b.read(register, 32);
        let mut result = b.constant(0, Type::I32);
        for byte in 0..4 {
            let part = b.extract(value, byte * 8, Type::I8);
            let part = wide(b, part, false);
            let part = constant_op(b, Binary::Shl, part, (3 - byte) as u32 * 8);
            result = b.binary(Binary::Or, result, part);
        }
        b.write(register, 32, result);
        return;
    }
    let width = i.operand_size;
    let group = i.modrm.unwrap() >> 3 & 7;
    let rm = i.modrm.unwrap() & 7;
    let scan = matches!(op, 0x0FBC | 0x0FBD | 0xF30FB8);
    let operation = if scan {
        0
    }
    else if op == 0x0FBA {
        group - 4
    }
    else {
        ((op >> 3) & 3) as u8
    };
    // 0FA3/AB/B3/BB => test/set/reset/complement respectively.
    let modifies = !scan && operation != 0;
    let mut bit = if scan {
        b.constant(0, Type::I32)
    }
    else if let Some(imm) = i.immediate {
        b.constant(imm & (width as u32 - 1), Type::I32)
    }
    else {
        let index = b.read(group, width);
        wide(b, index, i.ea.is_some())
    };
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    let mut ticket = None;
    let value = if let Some(ea) = i.ea {
        let mut offset = effective_offset(b, &ea);
        if !scan {
            // EA wrapping precedes signed bit-string displacement. Never mask
            // the sum to address-size 16, and access only the selected byte.
            let delta = constant_op(b, Binary::Sar, bit, 3);
            offset = b.binary(Binary::Add, offset, delta);
            bit = constant_op(b, Binary::And, bit, 7);
        }
        let address = segmented(b, offset, ea.segment, map);
        let (value, t) = memory_read(b, address, if scan { width } else { 8 }, map, modifies);
        ticket = t;
        wide(b, value, false)
    }
    else {
        if !scan {
            bit = constant_op(b, Binary::And, bit, width as u32 - 1);
        }
        let value = b.read(rm, width);
        wide(b, value, false)
    };
    if scan {
        let zero = b.constant(0, Type::I32);
        let is_zero = b.binary(Binary::Eq, value, zero);
        let result = if op == 0xF30FB8 {
            b.node(Op::PopulationCount, vec![value], Type::I32)
        }
        else {
            let raw = if op == 0x0FBC {
                b.node(Op::CountTrailingZeros, vec![value], Type::I32)
            }
            else {
                let clz = b.node(Op::CountLeadingZeros, vec![value], Type::I32);
                let high = b.constant(31, Type::I32);
                b.binary(Binary::Sub, high, clz)
            };
            b.node(Op::Select, vec![is_zero, zero, raw], Type::I32)
        };
        b.flags.raw_zero = Some(is_zero);
        let clear = b.constant(0, Type::I1);
        if op == 0xF30FB8 {
            b.flags.arithmetic = [clear; 6];
            b.flags.arithmetic[3] = is_zero;
        }
        else {
            let last = b.flags.last_op1.unwrap();
            let other = b.binary(Binary::Sub, result, last);
            let a = b.binary(Binary::Xor, last, result);
            let c = b.binary(Binary::Xor, other, result);
            let overflow = b.binary(Binary::And, a, c);
            let overflow = b.extract(overflow, width - 1, Type::I1);
            super::shift::shift_flags(b, result, clear, overflow, width);
            b.flags.arithmetic[3] = is_zero;
        }
        b.flags.zero_is_lazy = Some(clear);
        if op == 0xF30FB8 {
            b.preserve_popcnt_backing(is_zero);
        }
        else {
            b.preserve_scan_backing(result, is_zero, width);
        }
        let result =
            if width == 32 { result } else { b.node(Op::Truncate, vec![result], Type::I16) };
        let result = if op == 0xF30FB8 {
            result
        }
        else {
            let old = b.read(group, width);
            b.node(Op::Select, vec![is_zero, old, result], width_type(width))
        };
        b.write(group, width, result);
    }
    else {
        let shifted = b.binary(Binary::Shr, value, bit);
        let carry = b.extract(shifted, 0, Type::I1);
        b.flags.arithmetic[0] = carry;
        b.preserve_cf_backing(carry);
        if modifies {
            let one = b.constant(1, Type::I32);
            let mask = b.binary(Binary::Shl, one, bit);
            let result = match operation {
                1 => b.binary(Binary::Or, value, mask),
                2 => {
                    let inverted = constant_op(b, Binary::Xor, mask, u32::MAX);
                    b.binary(Binary::And, value, inverted)
                },
                3 => b.binary(Binary::Xor, value, mask),
                _ => unreachable!(),
            };
            let write_width = if i.ea.is_some() { 8 } else { width };
            let result = if write_width == 32 {
                result
            }
            else {
                b.node(Op::Truncate, vec![result], width_type(write_width))
            };
            if let Some(ticket) = ticket {
                memory_store(b, ticket, result, 8, map, i, count, true);
            }
            else {
                b.write(rm, width, result);
            }
        }
    }
}
