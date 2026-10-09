//! Terminal FXSAVE/FXRSTOR, XSAVE/XRSTOR and MXCSR transfers, with guard-before-segment order.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, snapshot},
};
use crate::ir::{state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    i.ea.is_some()
        && match i.encoding.opcode {
            0x0FAE => (0..=6).contains(&i.encoding.group),
            // (XRSTORS, XSAVEC and XSAVES without a mandatory prefix: the
            // interpreter's #UD otherwise)
            0x0FC7 => {
                (3..=5).contains(&i.encoding.group)
                    && !i.prefixes.operand
                    && !i.prefixes.rep
                    && !i.prefixes.repne
            },
            _ => false,
        }
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let ea = i.ea.unwrap();
    let offset = effective_offset(b, &ea);
    let segment = b.constant(ea.segment as u32, Type::I32);
    let name = if i.encoding.opcode == 0x0FC7 {
        ["ir_xrstors", "ir_xsavec", "ir_xsaves"][i.encoding.group as usize - 3]
    }
    else {
        [
            "ir_fxsave",
            "ir_fxrstor",
            "ir_ldmxcsr",
            "ir_stmxcsr",
            "ir_xsave",
            "ir_xrstor",
            "ir_xsaveopt",
        ][i.encoding.group as usize]
    };
    call(b, name, vec![offset, segment], state, true);
}
