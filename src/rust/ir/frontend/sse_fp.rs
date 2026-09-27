//! Baseline-compatible SSE floating-point adapters with CPU state reloads.
use super::{
    adapters::call_abi,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, snapshot},
};
use crate::ir::{helper::HelperAbi, state::ResumeKind, types::Type};
pub const OPERATIONS: &[(u32, u32)] = &[
    (0x0F2A, 8),
    (0x0F2C, 8),
    (0x0F2D, 8),
    (0x0F2E, 4),
    (0x0F2F, 4),
    (0x0F51, 16),
    (0x0F52, 16),
    (0x0F53, 16),
    (0x0F58, 16),
    (0x0F59, 16),
    (0x0F5A, 8),
    (0x0F5B, 16),
    (0x0F5C, 16),
    (0x0F5D, 16),
    (0x0F5E, 16),
    (0x0F5F, 16),
    (0x0FC2, 16),
    (0x660F2A, 8),
    (0x660F2C, 16),
    (0x660F2D, 16),
    (0x660F2E, 8),
    (0x660F2F, 8),
    (0x660F51, 16),
    (0x660F58, 16),
    (0x660F59, 16),
    (0x660F5A, 16),
    (0x660F5B, 16),
    (0x660F5C, 16),
    (0x660F5D, 16),
    (0x660F5E, 16),
    (0x660F5F, 16),
    (0x660F7C, 16),
    (0x660F7D, 16),
    (0x660FC2, 16),
    (0x660FD0, 16),
    (0x660FE6, 16),
    (0xF20F2A, 4),
    (0xF20F2C, 8),
    (0xF20F2D, 8),
    (0xF20F51, 8),
    (0xF20F58, 8),
    (0xF20F59, 8),
    (0xF20F5A, 8),
    (0xF20F5C, 8),
    (0xF20F5D, 8),
    (0xF20F5E, 8),
    (0xF20F5F, 8),
    (0xF20F7C, 16),
    (0xF20F7D, 16),
    (0xF20FC2, 8),
    (0xF20FD0, 16),
    (0xF20FE6, 16),
    (0xF30F2A, 4),
    (0xF30F2C, 4),
    (0xF30F2D, 4),
    (0xF30F51, 4),
    (0xF30F52, 4),
    (0xF30F53, 4),
    (0xF30F58, 4),
    (0xF30F59, 4),
    (0xF30F5A, 4),
    (0xF30F5B, 16),
    (0xF30F5C, 4),
    (0xF30F5D, 4),
    (0xF30F5E, 4),
    (0xF30F5F, 4),
    (0xF30FC2, 4),
    (0xF30FE6, 8),
];
pub fn supports(i: &DecodedInstruction) -> bool {
    OPERATIONS.iter().any(|&(op, _)| op == i.encoding.opcode)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    if b.xmm.is_empty() {
        b.xmm = (0..8)
            .map(|r| {
                b.region.append(
                    b.block,
                    crate::ir::hir::Op::ReadXmm(r),
                    vec![],
                    &[Type::V128],
                    None,
                )[0]
            })
            .collect();
    }
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let modrm = i.modrm.unwrap();
    let op = b.constant(i.encoding.opcode, Type::I32);
    let destination = b.constant((modrm >> 3 & 7) as u32, Type::I32);
    let immediate = b.constant(i.immediate.unwrap_or(0), Type::I32);
    if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let segment = b.constant(ea.segment as u32, Type::I32);
        call_abi(
            b,
            "ir_sse_fp_mem_continue",
            vec![op, offset, segment, destination, immediate],
            state,
            HelperAbi::CpuReload,
        );
    }
    else {
        let source = b.constant((modrm & 7) as u32, Type::I32);
        call_abi(
            b,
            "ir_sse_fp_reg_continue",
            vec![op, source, destination, immediate],
            state,
            HelperAbi::CpuReload,
        );
    }
}
