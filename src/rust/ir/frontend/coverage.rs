//! Remaining scalar, reserved-encoding and baseline no-op terminal forms.
use super::{
    adapters::call,
    decode::DecodedInstruction,
    integer::IntegerBuilder,
    lift::{effective_offset, snapshot},
};
use crate::ir::{state::ResumeKind, types::Type};
pub const OPCODES: &[u32] = &[
    0x62, 0x63, 0x9B, 0xF1, 0xF04, 0xF05, 0xF07, 0xF08, 0xF0A, 0xF0B, 0xF0C, 0xF0D, 0xF0E, 0xF0F,
    0xF18, 0xF19, 0xF1A, 0xF1B, 0xF1C, 0xF1D, 0xF1E, 0xF1F, 0xF24, 0xF25, 0xF26, 0xF27, 0xF33,
    0xF36, 0xF37, 0xF38, 0xF39, 0xF3A, 0xF3B, 0xF3C, 0xF3D, 0xF3E, 0xF3F, 0xF6C, 0xF6D, 0xF78,
    0xF79, 0xF7A, 0xF7B, 0xF7C, 0xF7D, 0xFA6, 0xFA7, 0xFAA, 0xFAE, 0xFB8, 0xFB9, 0xFC3, 0xFC7,
    0xFD0, 0xFD6, 0xFE6, 0xFF0, 0xFFF,
];
pub fn supports(i: &DecodedInstruction) -> bool {
    OPCODES.contains(&i.encoding.opcode)
        && (i.encoding.opcode != 0x0FAE || i.encoding.group >= 4)
        && (i.encoding.opcode != 0x0FC7 || i.encoding.group == 6)
}
// 0: #UD; 1: debug assertion then release #UD; 2/3: baseline debug-only
// BOUND/ICEBP assertions (release no-op); 4: no-op/prefetch/fence.
pub fn behavior(op: u32, group: i8, memory: bool) -> u32 {
    match op {
        0x62 => 2,
        0xF1 => 3,
        0x0F18 | 0x0F19 | 0x0F1C..=0x0F1F => 4,
        0x0FAE if group >= 5 && !memory => 4,
        0x0F0B | 0x0F6C | 0x0F6D | 0x0FA6 | 0x0FB8 | 0x0FB9 | 0x0FD0 | 0x0FD6 | 0x0FE6 | 0x0FF0
        | 0x0FFF => 0,
        _ => 1,
    }
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let m = i.modrm.unwrap_or(0);
    let destination = b.constant((m & 7) as u32, Type::I32);
    let source = b.constant((m >> 3 & 7) as u32, Type::I32);
    let width = b.constant(i.operand_size as u32, Type::I32);
    let (offset, segment) = if let Some(ea) = i.ea {
        let offset = effective_offset(b, &ea);
        (offset, b.constant(ea.segment as u32, Type::I32))
    }
    else {
        (b.constant(0, Type::I32), b.constant(u32::MAX, Type::I32))
    };
    let (name, args) = match i.encoding.opcode {
        0x63 if i.ea.is_some() => ("ir_arpl_mem", vec![offset, segment, source]),
        0x63 => ("ir_arpl_reg", vec![destination, source]),
        0x9B => ("ir_fwait", vec![]),
        0x0FC3 => ("ir_movnti", vec![offset, segment, source]),
        0x0FC7 => ("ir_rdrand", vec![destination, width]),
        op => {
            let behavior = b.constant(behavior(op, i.encoding.group, i.ea.is_some()), Type::I32);
            let guard = b.constant(i.encoding.sse as u32, Type::I32);
            ("ir_reserved_form", vec![behavior, guard, offset, segment])
        },
    };
    call(b, name, args, state, true);
}
