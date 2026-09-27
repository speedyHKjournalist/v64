//! Word insertion/extraction and sign-bit masks stay in XMM/GPR SSA.
use super::{
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, segmented, snapshot},
    simd_moves::prepare,
};
use crate::ir::{hir::Op, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(
        i.encoding.opcode,
        0x0F50 | 0x660F50 | 0x660FD7 | 0x660FC4 | 0x660FC5
    )
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    prepare(b, i, count);
    let register = i.modrm.unwrap() >> 3 & 7;
    let rm = i.modrm.unwrap() & 7;
    let lane = (i.immediate.unwrap_or(0) & 7) as u8;
    if i.encoding.opcode == 0x660FC4 {
        let old = b.xmm[register as usize];
        let value = if let Some(ea) = i.ea {
            let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
            b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
            let offset = effective_offset(b, &ea);
            let address = segmented(b, offset, ea.segment, map);
            let values = b.region.append(
                b.block,
                Op::XmmInsertWord { register, lane },
                vec![address, old, b.effect],
                &[Type::V128, Type::Effect],
                Some(map),
            );
            b.effect = values[1];
            values[0]
        }
        else {
            let source = b.read(rm, 32);
            b.node(
                Op::VectorReplace { bits: 16, lane },
                vec![old, source],
                Type::V128,
            )
        };
        b.xmm[register as usize] = value;
    }
    else {
        let source = b.xmm[rm as usize];
        let op = if i.encoding.opcode == 0x660FC5 {
            Op::VectorExtract { bits: 16, lane }
        }
        else {
            Op::VectorBitmask {
                bits: match i.encoding.opcode {
                    0x0F50 => 32,
                    0x660F50 => 64,
                    0x660FD7 => 8,
                    _ => unreachable!(),
                },
            }
        };
        let value = b.node(op, vec![source], Type::I32);
        b.write(register, 32, value);
    }
}
