//! Near calls, returns and indirect jumps. Targets remain SSA through commit.
use super::{
    decode::DecodedInstruction,
    integer::{width_type, IntegerBuilder},
    lift::{effective_offset, memory_read, memory_store, segmented, snapshot},
    stack::{adjusted, stack_address},
};
use crate::ir::{
    hir::{Op, Terminator},
    state::ResumeKind,
    types::Type,
};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0xE8 | 0xC2 | 0xC3)
        || i.encoding.opcode == 0xFF && matches!(i.modrm.unwrap() >> 3 & 7, 2 | 4)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let op = i.encoding.opcode;
    let width = i.operand_size;
    let ret = matches!(op, 0xC2 | 0xC3);
    let call = op == 0xE8 || op == 0xFF && i.modrm.unwrap() >> 3 & 7 == 2;
    let fault = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[fault.index()].resume = ResumeKind::BeforeInstruction;
    let target = if ret {
        let mode = b.node(Op::ReadStack32, vec![], Type::I1);
        let old_sp = b.gpr[4];
        let source = stack_address(b, old_sp, mode, fault);
        let value = memory_read(b, source, width, fault, false).0;
        b.gpr[4] = adjusted(
            b,
            old_sp,
            mode,
            width as i32 / 8 + i.immediate.unwrap_or(0) as i32,
        );
        value
    }
    else if op == 0xE8 {
        b.constant(
            i.next_pc.0.wrapping_add(i.immediate.unwrap()),
            width_type(width),
        )
    }
    else if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let source = segmented(b, offset, ea.segment, fault);
        memory_read(b, source, width, fault, false).0
    }
    else {
        b.read(i.modrm.unwrap() & 7, width)
    };
    let target = if width == 16 {
        b.node(Op::Extend { signed: false }, vec![target], Type::I32)
    }
    else {
        target
    };
    let commit = if call {
        // Target/source is captured before modifying ESP (CALL ESP and CALL [ESP]).
        let mode = b.node(Op::ReadStack32, vec![], Type::I1);
        let old_sp = b.gpr[4];
        let new_sp = adjusted(b, old_sp, mode, -(width as i32 / 8));
        let destination = stack_address(b, new_sp, mode, fault);
        let return_eip = b.constant(i.next_pc.0, width_type(width));
        b.gpr[4] = new_sp;
        memory_store(b, destination, return_eip, width, fault, i, count, false);
        let store = *b.region.blocks[b.block.index()]
            .instructions
            .last()
            .unwrap();
        b.region.instructions[store.index()].commit.unwrap()
    }
    else {
        snapshot(b, i.instruction_pc, i.next_pc, count)
    };
    b.region.states[commit.index()].next_value = Some(target);
    b.region.terminate(b.block, Terminator::Exit(commit));
}
