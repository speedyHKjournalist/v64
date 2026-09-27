//! Stack pointer width is independent of operand/address width.
use super::{
    decode::DecodedInstruction,
    integer::{width_type, IntegerBuilder},
    lift::{effective_offset, memory_read, memory_store, segmented, snapshot},
};
use crate::ir::{hir::Binary, hir::Op, ids::*, state::ResumeKind, types::Type};

pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(
        i.encoding.opcode,
        0x50..=0x61 | 0x68 | 0x6A | 0x8F | 0xC8 | 0xC9
    ) || i.encoding.opcode == 0xFF && i.modrm.unwrap() >> 3 & 7 == 6
}
pub(super) fn adjusted(b: &mut IntegerBuilder, sp: ValueId, mode: ValueId, delta: i32) -> ValueId {
    let amount = b.constant(delta as u32, Type::I32);
    let full = b.binary(Binary::Add, sp, amount);
    let low = b.node(Op::Truncate, vec![full], Type::I16);
    let word = b.node(Op::Insert { lsb: 0 }, vec![sp, low], Type::I32);
    b.node(Op::Select, vec![mode, full, word], Type::I32)
}
pub(super) fn stack_address(
    b: &mut IntegerBuilder,
    sp: ValueId,
    mode: ValueId,
    map: StateId,
) -> ValueId {
    let mask = b.constant(65535, Type::I32);
    let low = b.binary(Binary::And, sp, mask);
    let offset = b.node(Op::Select, vec![mode, sp, low], Type::I32);
    segmented(b, offset, 2, map)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let op = i.encoding.opcode;
    let width = i.operand_size;
    let bytes = width / 8;
    let pop = matches!(op, 0x58..=0x5F | 0x8F);
    let mode = b.node(Op::ReadStack32, vec![], Type::I1);
    if op == 0xC8 {
        enter(b, i, count, mode);
        return;
    }
    if matches!(op, 0x60 | 0x61 | 0xC9) {
        multiple(b, i, count, mode);
        return;
    }
    let old_sp = b.gpr[4];
    let new_sp = adjusted(
        b,
        old_sp,
        mode,
        if pop { bytes as i32 } else { -(bytes as i32) },
    );
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    if !pop {
        let value = if let Some(ea) = i.ea {
            let offset = effective_offset(b, &ea);
            let source = segmented(b, offset, ea.segment, map);
            memory_read(b, source, width, map, false).0
        }
        else if matches!(op, 0x68 | 0x6A) {
            b.constant(i.immediate.unwrap(), width_type(width))
        }
        else {
            b.read(
                if op == 0xFF { i.modrm.unwrap() & 7 } else { op as u8 & 7 },
                width,
            )
        };
        let destination = stack_address(b, new_sp, mode, map);
        b.gpr[4] = new_sp;
        memory_store(b, destination, value, width, map, i, count, false);
    }
    else {
        let destination = if let Some(ea) = i.ea {
            // Baseline POP memory resolves EA with temporarily incremented SP.
            b.gpr[4] = new_sp;
            let offset = effective_offset(b, &ea);
            let temporary = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
            b.region.states[temporary.index()].resume = ResumeKind::BeforeInstruction;
            let address = b.region.append(
                b.block,
                Op::PopAddress {
                    segment: ea.segment,
                    bytes,
                },
                vec![offset, b.effect],
                &[Type::LinearAddress, Type::Effect],
                Some(temporary),
            );
            b.effect = address[1];
            b.gpr[4] = old_sp;
            Some(address[0])
        }
        else {
            None
        };
        let source = stack_address(b, old_sp, mode, map);
        let value = memory_read(b, source, width, map, false).0;
        b.gpr[4] = new_sp;
        if let Some(destination) = destination {
            memory_store(b, destination, value, width, map, i, count, false);
        }
        else {
            // The pinned 5C implementation reads directly without incrementing;
            // 8F /0 uses pop16/pop32 before the register write. Their POP SP high
            // halves differ when a 32-bit stack increment carries out of bit 15.
            if op == 0x5C {
                b.gpr[4] = old_sp;
            }
            b.write(
                if op == 0x8F { i.modrm.unwrap() & 7 } else { op as u8 & 7 },
                width,
                value,
            );
        }
    }
}

fn before(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) -> StateId {
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    map
}
fn multiple(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32, mode: ValueId) {
    let width = i.operand_size;
    let bytes = (width / 8) as i32;
    let map = before(b, i, count);
    if i.encoding.opcode == 0xC9 {
        // LEAVE uses SS width to select BP/EBP for the address. The old ESP is
        // retained for faults and for its high half when SS is 16-bit.
        let address = stack_address(b, b.gpr[5], mode, map);
        let value = memory_read(b, address, width, map, false).0;
        let bp_low = b.read(5, 16);
        let word = b.node(Op::Insert { lsb: 0 }, vec![b.gpr[4], bp_low], Type::I32);
        let base = b.node(Op::Select, vec![mode, b.gpr[5], word], Type::I32);
        b.gpr[4] = adjusted(b, base, mode, bytes);
        b.write(5, width, value);
        return;
    }
    let push = i.encoding.opcode == 0x60;
    let saved_sp = b.read(4, width);
    let start = if push { adjusted(b, b.gpr[4], mode, -8 * bytes) } else { b.gpr[4] };
    let address = stack_address(b, start, mode, map);
    b.effect = b.region.append(
        b.block,
        Op::GuestCheck {
            bytes: (8 * bytes) as u16,
            write: push,
        },
        vec![address, b.effect],
        &[Type::Effect],
        Some(map),
    )[0];
    for slot in 0..8u8 {
        let reg = if push { slot } else { 7 - slot };
        if !push && reg == 4 {
            // POPA skips the saved SP slot entirely, including device reads.
            b.gpr[4] = adjusted(b, b.gpr[4], mode, bytes);
            continue;
        }
        let map = before(b, i, count);
        let next = adjusted(b, b.gpr[4], mode, if push { -bytes } else { bytes });
        let address = stack_address(b, if push { next } else { b.gpr[4] }, mode, map);
        if push {
            let value = if reg == 4 { saved_sp } else { b.read(reg, width) };
            b.gpr[4] = next;
            if slot == 7 {
                memory_store(b, address, value, width, map, i, count, false);
            }
            else {
                b.effect = b.region.append(
                    b.block,
                    Op::PartialStore { bytes: bytes as u8 },
                    vec![address, value, b.effect],
                    &[Type::Effect],
                    Some(map),
                )[0];
            }
        }
        else {
            let value = memory_read(b, address, width, map, false).0;
            b.gpr[4] = next;
            b.write(reg, width, value);
        }
    }
}

// Preserve the pinned ENTER ordering (which differs from a conventional textbook
// expansion): nested copies precede the final save at the original frame slot.
fn enter(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32, mode: ValueId) {
    let width = i.operand_size;
    let bytes = (width / 8) as i32;
    let nesting = i.extra_immediate.unwrap() & 31;
    let decrement = b.constant(bytes as u32, Type::I32);
    let frame = b.binary(Binary::Sub, b.gpr[4], decrement);
    let mut link = b.gpr[5];
    for slot in 0..nesting {
        let map = before(b, i, count);
        let value = if slot + 1 < nesting {
            link = b.binary(Binary::Sub, link, decrement);
            let address = stack_address(b, link, mode, map);
            let value = memory_read(b, address, width, map, false).0;
            let read = *b.region.blocks[b.block.index()]
                .instructions
                .last()
                .unwrap();
            b.region.instructions[read.index()].trap_after_fault = true;
            value
        }
        else {
            frame
        };
        let next = adjusted(b, b.gpr[4], mode, -bytes);
        let address = stack_address(b, next, mode, map);
        b.effect = b.region.append(
            b.block,
            Op::PartialStore { bytes: bytes as u8 },
            vec![address, value, b.effect],
            &[Type::Effect],
            Some(map),
        )[0];
        let store = *b.region.blocks[b.block.index()]
            .instructions
            .last()
            .unwrap();
        b.region.instructions[store.index()].trap_after_fault = true;
        b.region.instructions[store.index()].unmasked_word_store =
            width == 16 && slot + 1 == nesting;
        b.gpr[4] = next;
    }
    let map = before(b, i, count);
    let address = stack_address(b, frame, mode, map);
    let old_bp = b.read(5, width);
    let new_bp = if width == 16 { b.node(Op::Truncate, vec![frame], Type::I16) } else { frame };
    b.write(5, width, new_bp);
    b.gpr[4] = adjusted(b, b.gpr[4], mode, -(i.immediate.unwrap() as i32) - bytes);
    memory_store(b, address, old_bp, width, map, i, count, false);
}
