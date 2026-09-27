//! Lowered observer/commit points and guarded CPU adapters.
use super::memory::{Argument, RuntimeCall};
use crate::wasmgen::wasm_builder::{Signature, WasmType};
use crate::{
    cpu::global_pointers as gp,
    ir::{
        hir::{Instruction, Op, Region},
        ids::{StateId, ValueId},
        lowering::CompileError,
    },
};
/// State values and the instruction count may come from different commit phases.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    pub values: StateId,
    pub count: StateId,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlobalGuard {
    pub address: u32,
    pub mask: i32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EffectPlan {
    Arithmetic(super::arithmetic::ArithmeticPlan),
    Address {
        null_byte: u32,
        base: u32,
        offset: ValueId,
        result: ValueId,
        before: StateId,
        call: RuntimeCall,
        trap_after_fault: bool,
    },
    Check {
        guard: Option<GlobalGuard>,
        before: StateId,
        call: RuntimeCall,
        success: Option<i32>,
        fault: i32,
    },
    RmwCommit {
        bytes: u8,
        ticket: ValueId,
        value: ValueId,
        observe: Observation,
        commit: StateId,
        call: RuntimeCall,
    },
    /// Continuing x87 operation. `call` is the canonical fallback; loaded
    /// operand words are its arguments, stored words its packed i64 result.
    X87 {
        opcode: u8,
        modrm: u8,
        outputs: Vec<ValueId>,
        call: RuntimeCall,
    },
}
impl EffectPlan {
    pub fn call(&self) -> &RuntimeCall {
        match self {
            Self::Arithmetic(plan) => plan.call(),
            Self::Address { call, .. }
            | Self::Check { call, .. }
            | Self::RmwCommit { call, .. }
            | Self::X87 { call, .. } => call,
        }
    }
}
pub fn lower(inst: &Instruction) -> Option<EffectPlan> {
    use Argument::{Value, I32};
    Some(match inst.op {
        Op::SegmentAddress { segment } | Op::PopAddress { segment, .. } => {
            let mut args = vec![Value(inst.args[0]), I32(segment as i32)];
            let name = if let Op::PopAddress { bytes, .. } = inst.op {
                args.push(I32(bytes as i32));
                "ir_pop_address"
            }
            else {
                "ir_segment_address"
            };
            EffectPlan::Address {
                null_byte: gp::get_segment_is_null_offset(segment as u32),
                base: gp::get_seg_offset(segment as u32),
                offset: inst.args[0],
                result: inst.results[0],
                before: inst.state.unwrap(),
                call: RuntimeCall::i32(name, args, WasmType::I64),
                trap_after_fault: inst.trap_after_fault,
            }
        },
        Op::GuestCheck { bytes, write } => EffectPlan::Check {
            guard: None,
            before: inst.state.unwrap(),
            call: RuntimeCall::i32(
                "ir_memory_check",
                vec![Value(inst.args[0]), I32(bytes as i32), I32(write as i32)],
                WasmType::I32,
            ),
            success: Some(0),
            fault: 2,
        },
        Op::SseCheck => EffectPlan::Check {
            guard: Some(GlobalGuard {
                address: gp::cr as u32,
                mask: 12,
            }),
            before: inst.state.unwrap(),
            call: RuntimeCall::i32("ir_sse_guard", vec![], WasmType::I32),
            success: None,
            fault: 2,
        },
        Op::FpuCheck => EffectPlan::Check {
            guard: Some(GlobalGuard {
                address: gp::cr as u32,
                mask: 12,
            }),
            before: inst.state.unwrap(),
            call: RuntimeCall::i32("ir_fpu_guard", vec![], WasmType::I32),
            success: Some(0),
            fault: 2,
        },
        Op::X87 { opcode, modrm } => {
            let inputs = &inst.args[..inst.args.len() - 1];
            let operand = |n: usize| inputs.get(n).map_or(I32(0), |&v| Value(v));
            EffectPlan::X87 {
                opcode,
                modrm,
                outputs: inst.results[..inst.results.len() - 1].to_vec(),
                call: RuntimeCall {
                    name: "ir_x87_op",
                    signature: Signature::new(
                        &[WasmType::I32, WasmType::I32, WasmType::I32, WasmType::I32],
                        &[WasmType::I64],
                    ),
                    args: vec![I32(opcode as i32), I32(modrm as i32), operand(0), operand(1)],
                },
            }
        },
        Op::RmwStore { bytes, .. } => EffectPlan::RmwCommit {
            bytes,
            ticket: inst.args[0],
            value: inst.args[1],
            observe: Observation {
                values: inst.commit.unwrap(),
                count: inst.state.unwrap(),
            },
            commit: inst.commit.unwrap(),
            call: RuntimeCall {
                name: "ir_rmw_write",
                signature: Signature::new(&[WasmType::I64, WasmType::I32, WasmType::I32], &[]),
                args: vec![Value(inst.args[0]), Value(inst.args[1]), I32(bytes as i32)],
            },
        },
        _ => return super::arithmetic::lower(inst).map(EffectPlan::Arithmetic),
    })
}
pub fn verify(region: &Region, plans: &[Option<EffectPlan>]) -> Result<(), CompileError> {
    if plans.len() != region.instructions.len()
        || region
            .instructions
            .iter()
            .zip(plans)
            .any(|(inst, plan)| lower(inst).as_ref() != plan.as_ref())
    {
        return Err(CompileError::InvalidIr(
            "invalid lowered effect plan".into(),
        ));
    }
    Ok(())
}
