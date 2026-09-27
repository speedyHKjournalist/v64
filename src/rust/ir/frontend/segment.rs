//! Segment MOV and far pointer loads. Descriptor changes terminate the region.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, memory_read, memory_store, segmented, snapshot},
};
use crate::ir::{hir::Op, lowering::CompileError, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(
        i.encoding.opcode,
        0x8C | 0x8E | 0xC4 | 0xC5 | 0x0FB2 | 0x0FB4 | 0x0FB5
    )
}
pub fn terminal(i: &DecodedInstruction) -> bool { !matches!(i.encoding.opcode, 0x8C | 0x8E) }
pub fn lift(
    b: &mut IntegerBuilder,
    i: &DecodedInstruction,
    count: u32,
) -> Result<(), CompileError> {
    let op = i.encoding.opcode;
    let reg = i.modrm.unwrap() >> 3 & 7;
    let rm = i.modrm.unwrap() & 7;
    if (op == 0x8C && reg >= 6) || (op == 0x8E && (reg == 1 || reg >= 6)) {
        return Err(CompileError::Unsupported(
            "invalid segment instruction form",
        ));
    }
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    if !matches!(op, 0x8C | 0x8E) && i.ea.is_none() {
        call(b, "ir_far_control_ud", vec![], map, true);
        return Ok(());
    }
    if op == 0x8C {
        let selector = b.node(Op::ReadSegment(reg), vec![], Type::I16);
        if let Some(ea) = i.ea {
            let offset = effective_offset(b, &ea);
            let address = segmented(b, offset, ea.segment, map);
            memory_store(b, address, selector, 16, map, i, count, false);
        }
        else {
            let value = if i.operand_size == 32 {
                b.node(Op::Extend { signed: false }, vec![selector], Type::I32)
            }
            else {
                selector
            };
            b.write(rm, i.operand_size, value);
        }
        return Ok(());
    }
    let (selector, value, segment, register, bytes) = if op == 0x8E {
        let selector = if let Some(ea) = i.ea {
            let offset = effective_offset(b, &ea);
            let address = segmented(b, offset, ea.segment, map);
            memory_read(b, address, 16, map, false).0
        }
        else {
            b.read(rm, 16)
        };
        (selector, b.constant(0, Type::I32), reg, 0, 0)
    }
    else {
        let ea = i.ea.unwrap();
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        let data = memory_read(b, address, i.operand_size, map, false).0;
        let delta = b.constant((i.operand_size / 8) as u32, Type::I32);
        let tail = b.node(Op::LinearOffset, vec![address, delta], Type::LinearAddress);
        let selector = memory_read(b, tail, 16, map, false).0;
        let data = if i.operand_size == 16 {
            b.node(Op::Extend { signed: false }, vec![data], Type::I32)
        }
        else {
            data
        };
        let segment = match op {
            0xC4 => 0,
            0xC5 => 3,
            0x0FB2 => 2,
            0x0FB4 => 4,
            0x0FB5 => 5,
            _ => unreachable!(),
        };
        (selector, data, segment, reg, i.operand_size / 8)
    };
    let selector = b.node(Op::Extend { signed: false }, vec![selector], Type::I32);
    let segment = b.constant(segment as u32, Type::I32);
    if op == 0x8E {
        call(
            b,
            "ir_mov_segment_continue",
            vec![selector, segment],
            map,
            false,
        );
        return Ok(());
    }
    let register = b.constant(register as u32, Type::I32);
    let bytes = b.constant(bytes as u32, Type::I32);
    call(
        b,
        "ir_load_segment",
        vec![selector, segment, register, value, bytes],
        map,
        true,
    );
    Ok(())
}
