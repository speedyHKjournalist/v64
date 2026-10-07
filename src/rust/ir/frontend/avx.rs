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
/// A VEX form lifted on its legacy form's lifter (simd_moves, simd_transfer,
/// simd_shuffle, simd_immediate, simd_integer, simd_lane; native): VEX.vvvv, the
/// register read as the destination's old value (a shift by imm8's
/// destination), and whether an m128 must be aligned (the aligned moves'
/// only)
#[derive(Clone, Copy)]
pub struct VexLift {
    pub first: u8,
    pub aligned: bool,
}
/// The legacy form of VEX form `i` (VEX.128, VEX.LIG) whose lifter lifts
/// it natively too, its VexLift and the XMM register it writes (None: none,
/// a store to memory or a general-purpose register)
fn native(i: &DecodedInstruction) -> Option<(DecodedInstruction, VexLift, Option<u8>)> {
    let v = i.vex?;
    // (VEX.L1 of other than VEX.LIG rows: the 256-bit forms)
    if i.early_ud || v.l && i.encoding.vex & (vex::L0 | vex::L1) != 0 {
        return None;
    }
    let key = crate::cpu::avx::legacy(i.encoding.opcode);
    let modrm = i.modrm?;
    let (reg, rm, memory) = (modrm >> 3 & 7, modrm & 7, i.ea.is_some());
    let encoding = super::decode::candidates(key)
        .iter()
        .find(|row| row.group < 0 || row.group as u8 == reg)?;
    let legacy = DecodedInstruction {
        encoding,
        vex: None,
        ..i.clone()
    };
    let lifted = super::simd_moves::supports(&legacy)
        || super::simd_transfer::supports(&legacy)
        || super::simd_shuffle::supports(&legacy)
        || super::simd_immediate::supports(&legacy)
        || super::simd_integer::supports(&legacy)
        // (VPINSRW from memory: Op::XmmInsertWord has no first source)
        || super::simd_lane::supports(&legacy) && !(key == 0x660FC4 && memory);
    // (not the forms whose lifters read the destination's old value other
    // than as a first source: none here)
    if !lifted {
        return None;
    }
    // (is_store matches the moves' store opcodes by their low byte, which
    // PCMPEQQ, 66 0F 38 29, has too)
    let store = super::simd_moves::supports(&legacy) && super::simd_moves::is_store(&legacy);
    let written = match key {
        // MOVD r/m32, xmm; the sign masks and PEXTRW: a general-purpose
        // register
        0x660F7E | 0x0F50 | 0x660F50 | 0x660FD7 | 0x660FC5 => None,
        _ if store && memory => None,
        // the register forms of the stores: r/m
        _ if store => Some(rm),
        // shifts by imm8: VEX.vvvv
        0x660F71..=0x660F73 => Some(v.vvvv & 7),
        _ => Some(reg),
    };
    // (VEX.vvvv as an operand: the first source, read where the legacy form
    // reads its destination's old value; the destination of a shift by
    // imm8. The other forms' legacy forms read no old value, but where they
    // overwrite it whole.)
    let has_vvvv = i.encoding.vex & vex::VVVV != 0;
    let aligned = matches!(
        key,
        0x0F28 | 0x660F28 | 0x0F29 | 0x660F29 | 0x660F6F | 0x660F7F | 0x0F2B | 0x660F2B | 0x660FE7
    );
    Some((
        legacy,
        VexLift {
            first: if has_vvvv { v.vvvv & 7 } else { written.unwrap_or(reg) },
            aligned,
        },
        written,
    ))
}
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
/// ir_avx_fp_reg_continue's VEX forms: between XMM registers, of the legacy
/// keys whose helper reloads only its destination
/// (cpu_registry::xmm_register_op); their legacy key
fn fp_register(i: &DecodedInstruction) -> Option<u32> {
    let v = i.vex?;
    if i.early_ud || i.ea.is_some() || v.l && i.encoding.vex & (vex::L0 | vex::L1) != 0 {
        return None;
    }
    let key = crate::cpu::avx::legacy(i.encoding.opcode);
    crate::ir::helper::cpu_registry::xmm_register_op(key).then_some(key)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    // VZEROUPPER (no ModRM byte, no legacy form): the AVX guard, then bits
    // 255:128 of YMM0-YMM7 zeroed
    if i.encoding.opcode == 0xC4010077 && i.vex.is_some_and(|v| !v.l) && !i.early_ud {
        let guard = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
        b.region.states[guard.index()].resume = ResumeKind::BeforeInstruction;
        b.effect = b.region.append(
            b.block,
            Op::AvxCheck,
            vec![b.effect],
            &[Type::Effect],
            Some(guard),
        )[0];
        let after = snapshot(b, i.instruction_pc, i.next_pc, count);
        for register in 0..8 {
            b.effect = b.region.append(
                b.block,
                Op::YmmZero { register },
                vec![b.effect],
                &[Type::Effect],
                Some(after),
            )[0];
        }
        return;
    }
    if let Some(key) = fp_register(i) {
        let (v, modrm) = (i.vex.unwrap(), i.modrm.unwrap());
        // (the AVX guard)
        b.vex = Some(VexLift {
            first: v.vvvv & 7,
            aligned: false,
        });
        super::simd_moves::prepare(b, i, count);
        b.vex = None;
        let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
        b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
        let destination = modrm >> 3 & 7;
        let args = vec![
            b.constant(key, Type::I32),
            b.constant((modrm & 7) as u32, Type::I32),
            b.constant(destination as u32, Type::I32),
            b.constant((v.vvvv & 7) as u32, Type::I32),
            b.constant(i.immediate.unwrap_or(0) & 255, Type::I32),
        ];
        call_abi(
            b,
            "ir_avx_fp_reg_continue",
            args,
            state,
            HelperAbi::CpuReload,
        );
        // (after MIR's NativeFp too)
        let after = snapshot(b, i.instruction_pc, i.next_pc, count);
        b.effect = b.region.append(
            b.block,
            Op::YmmZero {
                register: destination,
            },
            vec![b.effect],
            &[Type::Effect],
            Some(after),
        )[0];
        return;
    }
    if let Some((legacy, lift, written)) = native(i) {
        b.vex = Some(lift);
        if super::simd_moves::supports(&legacy) {
            super::simd_moves::lift(b, &legacy, count);
        }
        else if super::simd_transfer::supports(&legacy) {
            super::simd_transfer::lift(b, &legacy, count);
        }
        else if super::simd_shuffle::supports(&legacy) {
            super::simd_shuffle::lift(b, &legacy, count);
        }
        else if super::simd_immediate::supports(&legacy) {
            super::simd_immediate::lift(b, &legacy, count);
        }
        else if super::simd_lane::supports(&legacy) {
            super::simd_lane::lift(b, &legacy, count);
        }
        else {
            super::simd_integer::lift(b, &legacy, count);
        }
        b.vex = None;
        if let Some(register) = written {
            let after = snapshot(b, i.instruction_pc, i.next_pc, count);
            b.effect = b.region.append(
                b.block,
                Op::YmmZero { register },
                vec![b.effect],
                &[Type::Effect],
                Some(after),
            )[0];
        }
        return;
    }
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
