//! MMX registers continue through CPU reloads; memory retains checked exits.
use super::{
    adapters::{call, call_abi},
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, snapshot},
};
use crate::ir::{helper::HelperAbi, hir::Op, state::ResumeKind, types::Type};
// Semantic key, memory width, legal operands (register=1, memory=2, implicit=4).
pub const OPERATIONS: &[(u32, u32, u8)] = &[
    (0xF60, 4, 3),
    (0xF61, 4, 3),
    (0xF62, 4, 3),
    (0xF63, 8, 3),
    (0xF64, 8, 3),
    (0xF65, 8, 3),
    (0xF66, 8, 3),
    (0xF67, 8, 3),
    (0xF68, 8, 3),
    (0xF69, 8, 3),
    (0xF6A, 8, 3),
    (0xF6B, 8, 3),
    (0xF6E, 4, 3),
    (0xF6F, 8, 3),
    (0xF70, 8, 3),
    (0xF74, 8, 3),
    (0xF75, 8, 3),
    (0xF76, 8, 3),
    (0xFC4, 2, 3),
    (0xFD1, 8, 3),
    (0xFD2, 8, 3),
    (0xFD3, 8, 3),
    (0xFD4, 8, 3),
    (0xFD5, 8, 3),
    (0xFD8, 8, 3),
    (0xFD9, 8, 3),
    (0xFDA, 8, 3),
    (0xFDB, 8, 3),
    (0xFDC, 8, 3),
    (0xFDD, 8, 3),
    (0xFDE, 8, 3),
    (0xFDF, 8, 3),
    (0xFE0, 8, 3),
    (0xFE1, 8, 3),
    (0xFE2, 8, 3),
    (0xFE3, 8, 3),
    (0xFE4, 8, 3),
    (0xFE5, 8, 3),
    (0xFE8, 8, 3),
    (0xFE9, 8, 3),
    (0xFEA, 8, 3),
    (0xFEB, 8, 3),
    (0xFEC, 8, 3),
    (0xFED, 8, 3),
    (0xFEE, 8, 3),
    (0xFEF, 8, 3),
    (0xFF1, 8, 3),
    (0xFF2, 8, 3),
    (0xFF3, 8, 3),
    (0xFF4, 8, 3),
    (0xFF5, 8, 3),
    (0xFF6, 8, 3),
    (0xFF8, 8, 3),
    (0xFF9, 8, 3),
    (0xFFA, 8, 3),
    (0xFFB, 8, 3),
    (0xFFC, 8, 3),
    (0xFFD, 8, 3),
    (0xFFE, 8, 3),
    (0x2000F71, 0, 1),
    (0x4000F71, 0, 1),
    (0x6000F71, 0, 1),
    (0x2000F72, 0, 1),
    (0x4000F72, 0, 1),
    (0x6000F72, 0, 1),
    (0x2000F73, 0, 1),
    (0x6000F73, 0, 1),
    (0xF77, 0, 4),
    (0xF7E, 4, 3),
    (0xF7F, 8, 3),
    (0xFC5, 0, 1),
    (0xFD7, 0, 1),
    (0xFE7, 8, 2),
    (0xF20FD6, 0, 1),
    (0xF30FD6, 0, 1),
    (0xFF7, 8, 1),
];
fn key(i: &DecodedInstruction) -> u32 {
    i.encoding.opcode
        | if (0x0F71..=0x0F73).contains(&i.encoding.opcode) {
            (i.encoding.group as u32) << 24
        }
        else {
            0
        }
}
pub fn supports(i: &DecodedInstruction) -> bool {
    OPERATIONS.iter().any(|&(op, _, _)| op == key(i))
}
pub fn terminal(i: &DecodedInstruction) -> bool {
    // MASKMOVQ has a register ModRM but performs implicit guest-memory writes.
    i.ea.is_some() || i.encoding.opcode == 0x0FF7
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let modrm = i.modrm.unwrap_or(0);
    let op = b.constant(key(i), Type::I32);
    let destination = b.constant((modrm >> 3 & 7) as u32, Type::I32);
    let immediate = b.constant(i.immediate.unwrap_or(0), Type::I32);
    let source = b.constant((modrm & 7) as u32, Type::I32);
    if i.encoding.opcode == 0x0FF7 {
        let offset = b.read(7, i.address_size);
        let offset = if i.address_size == 16 {
            b.node(Op::Extend { signed: false }, vec![offset], Type::I32)
        }
        else {
            offset
        };
        let segment = b.constant(i.prefixes.segment.unwrap_or(3) as u32, Type::I32);
        call(
            b,
            "ir_mmx_mask",
            vec![offset, segment, source, destination],
            state,
            true,
        );
    }
    else if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let segment = b.constant(ea.segment as u32, Type::I32);
        call(
            b,
            "ir_mmx_mem",
            vec![op, offset, segment, destination, immediate],
            state,
            true,
        );
    }
    else {
        call_abi(
            b,
            if matches!(i.encoding.opcode, 0xF20FD6 | 0xF30FD6) {
                "ir_mmx_xmm_continue"
            }
            else {
                "ir_mmx_reg_continue"
            },
            vec![op, source, destination, immediate],
            state,
            HelperAbi::CpuReload,
        );
    }
}
