//! XMM move semantics retain vector SSA on registers and guarded ordinary RAM.
use super::{
    decode::{DecodedInstruction, GuestEip},
    integer::IntegerBuilder,
    lift::{effective_offset, segmented, snapshot},
};
use crate::ir::{hir::Op, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(
        i.encoding.opcode,
        0x0F2B
            | 0x660F2B
            | 0x660FE7
            | 0xF20FF0
            | 0x0F13
            | 0x660F13
            | 0x0F17
            | 0x660F17
            | 0x660F6E
            | 0x660F7E
            | 0xF30F7E
            | 0x660FD6
            | 0x0F10
            | 0x0F11
            | 0x660F10
            | 0x660F11
            | 0xF20F10
            | 0xF20F11
            | 0xF30F10
            | 0xF30F11
            | 0x0F28
            | 0x0F29
            | 0x660F28
            | 0x660F29
            | 0x660F6F
            | 0x660F7F
            | 0xF30F6F
            | 0xF30F7F
    )
}
pub fn is_store(i: &DecodedInstruction) -> bool {
    matches!(
        i.encoding.opcode,
        0x0F2B | 0x660F2B | 0x660FE7 | 0x0F13 | 0x660F13 | 0x0F17 | 0x660F17 | 0x660F7E | 0x660FD6
    ) || matches!(i.encoding.opcode & 255, 0x11 | 0x29 | 0x7F)
}
pub fn prepare(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    if b.xmm.is_empty() {
        b.xmm = (0..8)
            .map(|r| {
                b.region
                    .append(b.block, Op::ReadXmm(r), vec![], &[Type::V128], None)[0]
            })
            .collect();
    }
    let guard = snapshot(
        b,
        i.instruction_pc,
        GuestEip(
            i.instruction_pc
                .0
                .wrapping_add(i.modrm_offset.unwrap() as u32 + 1),
        ),
        count - 1,
    );
    b.region.states[guard.index()].resume = ResumeKind::BeforeInstruction;
    b.effect = b.region.append(
        b.block,
        Op::SseCheck,
        vec![b.effect],
        &[Type::Effect],
        Some(guard),
    )[0];
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    prepare(b, i, count);
    let op = i.encoding.opcode;
    let bytes = if matches!(op, 0xF30F10 | 0xF30F11 | 0x660F6E | 0x660F7E) {
        4
    }
    else if matches!(
        op,
        0xF20F10 | 0xF20F11 | 0x0F13 | 0x660F13 | 0x0F17 | 0x660F17 | 0xF30F7E | 0x660FD6
    ) {
        8
    }
    else {
        16
    };
    let register = i.modrm.unwrap() >> 3 & 7;
    if let Some(ea) = i.ea {
        let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
        b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        if is_store(i) {
            b.effect = b.region.append(
                b.block,
                Op::XmmStore {
                    bytes,
                    register,
                    lane: if matches!(op, 0x0F17 | 0x660F17) { 1 } else { 0 },
                },
                vec![address, b.xmm[register as usize], b.effect],
                &[Type::Effect],
                Some(map),
            )[0];
            let store = *b.region.blocks[b.block.index()]
                .instructions
                .last()
                .unwrap();
            let commit = snapshot(b, i.instruction_pc, i.next_pc, count);
            b.region.instructions[store.index()].commit = Some(commit);
        }
        else {
            let values = b.region.append(
                b.block,
                Op::XmmLoad { bytes, register },
                vec![address, b.effect],
                &[Type::V128, Type::Effect],
                Some(map),
            );
            b.xmm[register as usize] = values[0];
            b.effect = values[1];
        }
    }
    else {
        let rm = i.modrm.unwrap() & 7;
        if op == 0x660F6E {
            let value = b.read(rm, 32);
            let old = b.xmm[register as usize];
            let zero = b.node(
                Op::VectorBinary(crate::ir::simd::PackedOp::Xor),
                vec![old, old],
                Type::V128,
            );
            b.xmm[register as usize] = b.node(
                Op::VectorReplace { bits: 32, lane: 0 },
                vec![zero, value],
                Type::V128,
            );
            return;
        }
        if op == 0x660F7E {
            let value = b.node(
                Op::VectorExtract { bits: 32, lane: 0 },
                vec![b.xmm[register as usize]],
                Type::I32,
            );
            b.write(rm, 32, value);
            return;
        }
        let (source, destination) = if is_store(i) { (register, rm) } else { (rm, register) };
        let value = if bytes == 16 {
            b.xmm[source as usize]
        }
        else {
            let low = b.node(
                Op::VectorExtract {
                    bits: bytes * 8,
                    lane: 0,
                },
                vec![b.xmm[source as usize]],
                if bytes == 4 { Type::I32 } else { Type::I64 },
            );
            let old = b.xmm[destination as usize];
            let upper = if matches!(op, 0xF30F7E | 0x660FD6) {
                b.node(
                    Op::VectorBinary(crate::ir::simd::PackedOp::Xor),
                    vec![old, old],
                    Type::V128,
                )
            }
            else {
                old
            };
            b.node(
                Op::VectorReplace {
                    bits: bytes * 8,
                    lane: 0,
                },
                vec![upper, low],
                Type::V128,
            )
        };
        b.xmm[destination as usize] = value;
    }
}
