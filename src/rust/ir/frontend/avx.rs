//! AVX (VEX-encoded SIMD, crate::cpu::avx): the shared executor through a
//! CPU helper that lets the region go on. The IR decodes C4/C5 with a
//! register ModRM byte as VEX in every mode; in real and virtual-8086 mode,
//! where that is LES/LDS's register form, the helper is #UD.
use super::{
    adapters::call_abi,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, snapshot},
};
use crate::decode_rules::vex;
use crate::ir::{helper::HelperAbi, hir::Op, state::ResumeKind, types::Type};
/// The VEX forms of the shared executor (not BMI1/BMI2's, on general-purpose
/// registers)
pub fn supports(i: &DecodedInstruction) -> bool {
    i.vex.is_some() && i.encoding.vex & vex::GPR == 0
}
/// ir_avx_continue's `operands`: ModRM.reg (bits 2:0), VEX.vvvv (6:4),
/// ModRM.rm (10:8), a memory operand (11), VEX.L (12), VEX.W (13), imm8 (23:16)
pub fn operands(i: &DecodedInstruction) -> u32 {
    let v = i.vex.unwrap();
    let modrm = i.modrm.unwrap_or(0) as u32;
    (modrm >> 3 & 7)
        | (v.vvvv as u32 & 7) << 4
        | (modrm & 7) << 8
        | (i.ea.is_some() as u32) << 11
        | (v.l as u32) << 12
        | (v.w as u32) << 13
        | (i.immediate.unwrap_or(0) & 255) << 16
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    if b.xmm.is_empty() {
        b.xmm = (0..8)
            .map(|r| {
                b.region
                    .append(b.block, Op::ReadXmm(r), vec![], &[Type::V128], None)[0]
            })
            .collect();
    }
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let key = b.constant(i.encoding.opcode, Type::I32);
    let operands = b.constant(operands(i), Type::I32);
    let (offset, segment) = if let Some(ea) = i.ea {
        (
            effective_offset(b, &ea),
            b.constant(ea.segment as u32, Type::I32),
        )
    }
    else if i.encoding.opcode == 0xC40101F7 {
        // VMASKMOVDQU: to DI or EDI in DS or the segment prefix's
        let offset = b.read(7, i.address_size);
        let offset = if i.address_size == 16 {
            b.node(Op::Extend { signed: false }, vec![offset], Type::I32)
        }
        else {
            offset
        };
        (
            offset,
            b.constant(i.prefixes.segment.unwrap_or(3) as u32, Type::I32),
        )
    }
    else {
        (b.constant(0, Type::I32), b.constant(u32::MAX, Type::I32))
    };
    call_abi(
        b,
        "ir_avx_continue",
        vec![key, operands, offset, segment],
        state,
        HelperAbi::CpuReload,
    );
}
