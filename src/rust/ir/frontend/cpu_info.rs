//! CPU identification, timestamp and model-specific state transitions.
use super::{adapters::call, decode::DecodedInstruction, integer::IntegerBuilder, lift::snapshot};
use crate::ir::state::ResumeKind;
pub fn supports(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0x0FA2 | 0x0F30 | 0x0F31 | 0x0F32)
}
pub fn terminal(i: &DecodedInstruction) -> bool {
    matches!(i.encoding.opcode, 0x0F30 | 0x0F32)
}
pub fn lift(b: &mut IntegerBuilder, i: &DecodedInstruction, count: u32) {
    let state = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
    let name = match i.encoding.opcode {
        0x0FA2 => "ir_cpuid_continue",
        0x0F30 => "ir_wrmsr",
        0x0F31 => "ir_rdtsc_continue",
        0x0F32 => "ir_rdmsr",
        _ => unreachable!(),
    };
    if !terminal(i) {
        super::adapters::call_abi(
            b,
            name,
            vec![],
            state,
            crate::ir::helper::HelperAbi::CpuReload,
        );
    }
    else {
        call(b, name, vec![], state, true);
    }
}
