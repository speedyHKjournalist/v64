//! Descriptor queries and selector access verification at CPU boundaries.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, segmented, snapshot},
};
use crate::ir::{state::ResumeKind, types::Type};
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0x0F02 | 0x0F03)
        || i.encoding.opcode == 0x0F00 && matches!(i.modrm.unwrap() >> 3 & 7, 4 | 5)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    if i.encoding.opcode == 0x0F00 {
        let write = i.modrm.unwrap() >> 3 & 7 == 5;
        let (source, name) = if let Some(ea) = i.ea {
            let offset = effective_offset(b, &ea);
            (
                segmented(b, offset, ea.segment, map),
                if write { "ir_verw_mem" } else { "ir_verr_mem" },
            )
        }
        else {
            (
                b.constant((i.modrm.unwrap() & 7) as u32, Type::I32),
                if write { "ir_verw_reg" } else { "ir_verr_reg" },
            )
        };
        call(b, name, vec![source], map, true);
        return;
    }
    let width = b.constant(i.operand_size as u32, Type::I32);
    let destination = b.constant((i.modrm.unwrap() >> 3 & 7) as u32, Type::I32);
    if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        let address = segmented(b, offset, ea.segment, map);
        call(
            b,
            if i.encoding.opcode == 0x0F02 { "ir_lar_mem" } else { "ir_lsl_mem" },
            vec![address, destination, width],
            map,
            true,
        );
    }
    else {
        let source = b.constant((i.modrm.unwrap() & 7) as u32, Type::I32);
        call(
            b,
            if i.encoding.opcode == 0x0F02 { "ir_lar_reg" } else { "ir_lsl_reg" },
            vec![source, destination, width],
            map,
            true,
        );
    }
}
