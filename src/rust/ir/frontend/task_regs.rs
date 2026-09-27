//! Task/local-descriptor register operands and terminal state changes.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, segmented, snapshot},
};
use crate::ir::{state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    i.encoding.opcode == 0x0F00 && matches!(i.encoding.group, 0..=3)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let group = i.encoding.group;
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    let width = b.constant(i.operand_size as u32, Type::I32);
    if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        let name = match group {
            0 => "ir_sldt_mem",
            1 => "ir_str_mem",
            2 => "ir_lldt_mem",
            3 => "ir_ltr_mem",
            _ => unreachable!(),
        };
        call(b, name, vec![address, width], map, true);
    }
    else {
        let reg = b.constant((i.modrm.unwrap() & 7) as u32, Type::I32);
        let name = match group {
            0 => "ir_sldt_reg",
            1 => "ir_str_reg",
            2 => "ir_lldt_reg",
            3 => "ir_ltr_reg",
            _ => unreachable!(),
        };
        call(b, name, vec![reg, width], map, true);
    }
}
