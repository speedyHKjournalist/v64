//! CRC32 (SSE4.2, F2 0F 38 F0/F1): general-purpose registers only, no flags,
//! no XMM state checks. The interpreter's semantics through CPU helpers that
//! let the region go on (crate::cpu::simd_int::crc32c).
use super::{
    adapters::call_abi,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, snapshot},
};
use crate::ir::{helper::HelperAbi, state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0xF20F38F0 | 0xF20F38F1)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let modrm = i.modrm.unwrap();
    let destination = b.constant((modrm >> 3 & 7) as u32, Type::I32);
    // (the source's bits: F0 a byte, F1 the operand size)
    let bits = b.constant(
        if i.encoding.opcode == 0xF20F38F0 { 8 } else { i.operand_size as u32 },
        Type::I32,
    );
    if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let segment = b.constant(ea.segment as u32, Type::I32);
        call_abi(
            b,
            "ir_crc32_mem_continue",
            vec![offset, segment, destination, bits],
            state,
            HelperAbi::CpuReload,
        );
    }
    else {
        let source = b.constant((modrm & 7) as u32, Type::I32);
        call_abi(
            b,
            "ir_crc32_reg_continue",
            vec![source, destination, bits],
            state,
            HelperAbi::CpuReload,
        );
    }
}
