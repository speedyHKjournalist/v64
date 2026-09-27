//! x87 register and memory forms with CPU-owned F80 stack/status.
//!
//! Continuing forms (see `ir::x87`) use a #NM guard, ordinary guest-memory ops
//! and one `Op::X87`; they never end the region. Remaining forms keep the
//! audited helpers: FLAGS/GPR register forms reload CPU state, and environment,
//! 80-bit/BCD memory forms are terminal and resolve their own segments.
use super::{
    adapters::{call, call_abi},
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, memory_read, memory_store, segmented, snapshot},
};
use crate::ir::{
    helper::HelperAbi,
    hir::Op,
    ids::{StateId, ValueId},
    state::ResumeKind,
    types::Type,
    x87::{io, Io},
};

pub fn supports(i: &DecodedInstruction) -> bool { (0xD8..=0xDF).contains(&i.encoding.opcode) }

/// The instruction continues the region (no terminal helper).
pub fn continues(i: &DecodedInstruction) -> bool {
    supports(i) && io(i.encoding.opcode as u8, i.modrm.unwrap()).is_some()
}

pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    debug_assert!(supports(i));
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;

    let modrm = i.modrm.expect("x87 form has ModRM");
    let opcode = i.encoding.opcode as u8;
    if let Some(form) = io(opcode, modrm) {
        lift_continuing(b, i, count, state, opcode, modrm, form);
        return;
    }
    if let Some(ea) = i.ea {
        // Segment resolution belongs to the helper: #NM precedes segment faults.
        let offset = effective_offset(b, &ea);
        let opcode = b.constant(i.encoding.opcode, Type::I32);
        let group = b.constant((modrm >> 3 & 7) as u32, Type::I32);
        let segment = b.constant(ea.segment as u32, Type::I32);
        let width = b.constant(i.operand_size as u32, Type::I32);
        call(
            b,
            "ir_x87_mem",
            vec![opcode, group, offset, segment, width],
            state,
            true,
        );
        return;
    }
    let args = [
        i.encoding.opcode,
        (modrm >> 3 & 7) as u32,
        (modrm & 7) as u32,
        i.operand_size as u32,
    ]
    .into_iter()
    .map(|value| b.constant(value, Type::I32))
    .collect();
    call_abi(b, "ir_x87_reg_continue", args, state, HelperAbi::CpuReload);
}

fn ordered(
    b: &mut IntegerBuilder,
    op: Op,
    mut args: Vec<ValueId>,
    results: usize,
    state: StateId,
) -> Vec<ValueId> {
    args.push(b.effect);
    let mut types = vec![Type::I32; results];
    types.push(Type::Effect);
    let values = b.region.append(b.block, op, args, &types, Some(state));
    b.effect = *values.last().unwrap();
    values[..results].to_vec()
}

fn lift_continuing(
    b: &mut IntegerBuilder,
    i: &DecodedInstruction,
    count: u32,
    state: StateId,
    opcode: u8,
    modrm: u8,
    form: Io,
) {
    // #NM precedes segment, page and stack effects.
    ordered(b, Op::FpuCheck, vec![], 0, state);
    let x87 = Op::X87 { opcode, modrm };
    let Some(ea) = i.ea
    else {
        ordered(b, x87, vec![], 0, state);
        return;
    };
    let offset = effective_offset(b, &ea);
    let address = segmented(b, offset, ea.segment, state);
    let high = |b: &mut IntegerBuilder| {
        let four = b.constant(4, Type::I32);
        b.node(Op::LinearOffset, vec![address, four], Type::LinearAddress)
    };
    match form {
        Io::Load { bytes } => {
            let (low, high) = match bytes {
                2 => {
                    let word = memory_read(b, address, 16, state, false).0;
                    let word = b.node(Op::Extend { signed: false }, vec![word], Type::I32);
                    (word, b.constant(0, Type::I32))
                },
                4 => (memory_read(b, address, 32, state, false).0, b.constant(0, Type::I32)),
                8 => {
                    let low = memory_read(b, address, 32, state, false).0;
                    let upper = high(b);
                    (low, memory_read(b, upper, 32, state, false).0)
                },
                _ => unreachable!(),
            };
            ordered(b, x87, vec![low, high], 0, state);
        },
        Io::Store { bytes } => {
            // Only after the whole destination is writable may the FPU pop.
            b.effect = b.region.append(
                b.block,
                Op::GuestCheck {
                    bytes: bytes.into(),
                    write: true,
                },
                vec![address, b.effect],
                &[Type::Effect],
                Some(state),
            )[0];
            let words = ordered(b, x87, vec![], 2, state);
            match bytes {
                2 => {
                    let word = b.node(Op::Truncate, vec![words[0]], Type::I16);
                    memory_store(b, address, word, 16, state, i, count, false);
                },
                4 => memory_store(b, address, words[0], 32, state, i, count, false),
                8 => {
                    b.effect = b.region.append(
                        b.block,
                        Op::PartialStore { bytes: 4 },
                        vec![address, words[0], b.effect],
                        &[Type::Effect],
                        Some(state),
                    )[0];
                    let upper = high(b);
                    memory_store(b, upper, words[1], 32, state, i, count, false);
                },
                _ => unreachable!(),
            }
        },
        Io::Stack => unreachable!("register form with a memory operand"),
    }
}
