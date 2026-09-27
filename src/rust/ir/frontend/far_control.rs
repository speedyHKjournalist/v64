//! Terminal far transfers and software interrupts with CPU-owned completion.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, segmented, snapshot},
};
use crate::ir::{state::ResumeKind, types::Type};

pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0x9A | 0xEA | 0xCA..=0xCF)
        || i.encoding.opcode == 0xFF && matches!(i.encoding.group, 3 | 5)
}

pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let width = b.constant(i.operand_size as u32, Type::I32);
    let (name, args) = match i.encoding.opcode {
        0x9A | 0xEA => {
            let ip = b.constant(i.immediate.unwrap(), Type::I32);
            let cs = b.constant(i.extra_immediate.unwrap() as u32, Type::I32);
            let is_call = b.constant((i.encoding.opcode == 0x9A) as u32, Type::I32);
            ("ir_far_jump", vec![ip, cs, is_call, width])
        },
        0xFF => {
            if let Some(ea) = i.ea {
                let offset = effective_offset(b, &ea);
                let address = segmented(b, offset, ea.segment, state);
                let is_call = b.constant((i.encoding.group == 3) as u32, Type::I32);
                ("ir_far_jump_mem", vec![address, is_call, width])
            }
            else {
                ("ir_far_control_ud", vec![])
            }
        },
        0xCA | 0xCB => {
            let adjust = b.constant(i.immediate.unwrap_or(0), Type::I32);
            ("ir_far_return", vec![adjust, width])
        },
        0xCF => ("ir_iret", vec![width]),
        0xCC..=0xCE => {
            let vector = b.constant(
                match i.encoding.opcode {
                    0xCC => 3,
                    0xCE => 4,
                    _ => i.immediate.unwrap(),
                },
                Type::I32,
            );
            let conditional = b.constant((i.encoding.opcode == 0xCE) as u32, Type::I32);
            ("ir_software_interrupt", vec![vector, conditional])
        },
        _ => unreachable!(),
    };
    call(b, name, args, state, true);
}
