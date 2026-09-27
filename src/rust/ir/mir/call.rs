//! Per-call-site observation, staged results and outcome edges.
use crate::ir::{
    helper::{after_call, AdapterAction, HelperAbi, HelperDescriptor, Outcome},
    hir::{Instruction, Op, Region},
    ids::{HelperId, StateId, ValueId},
    lowering::CompileError,
    mir::HelperCall,
    state::ResumeKind,
    types::Type,
};
use crate::wasmgen::wasm_builder::{Signature, WasmType};
pub fn legalize(descriptor: &HelperDescriptor) -> Result<HelperCall, CompileError> {
    descriptor
        .validate()
        .map_err(|message| CompileError::InvalidIr(message.into()))?;
    let reload = matches!(descriptor.abi, HelperAbi::CpuReload);
    if descriptor.params.iter().any(|t| *t == Type::V128)
        || !reload && descriptor.results.iter().any(|t| *t == Type::V128)
    {
        return Err(CompileError::Unsupported(
            "vector helper requires explicit scratch ABI",
        ));
    }
    let (fault_delivery, normal_preserves_state, cpu_exit) = match &descriptor.abi {
        HelperAbi::Outcome {
            fault_delivery,
            normal_preserves_state,
        } => (fault_delivery.clone(), *normal_preserves_state, false),
        HelperAbi::CpuReload => (None, true, false),
        HelperAbi::CpuExit | HelperAbi::CpuRep => (None, false, true),
        HelperAbi::Unadapted => return Err(CompileError::Unsupported("unadapted helper ABI")),
    };
    // Continuing SSA cannot observe writes without explicit reloads.
    if !normal_preserves_state && !cpu_exit {
        return Err(CompileError::Unsupported("helper state reload pending"));
    }
    let caller_fault =
        after_call(descriptor, Outcome::FaultNeedsDelivery) == Ok(AdapterAction::RestoreAndDeliver);
    if caller_fault != fault_delivery.is_some() {
        return Err(CompileError::InvalidIr(
            "helper fault delivery adapter mismatch".into(),
        ));
    }
    let wasm_type = |t: &Type| if *t == Type::I64 { WasmType::I64 } else { WasmType::I32 };
    let params: Vec<_> = descriptor.params.iter().map(wasm_type).collect();
    let results: Vec<_> = std::iter::once(WasmType::I32)
        .chain(descriptor.results.iter().filter(|_| !reload).map(wasm_type))
        .collect();
    let signature = Signature::new(&params, &results);
    Ok(HelperCall {
        name: descriptor.name.clone(),
        cpu_exit,
        cpu_reload: reload,
        starts_interrupt_shadow: descriptor.name == "ir_sti_check",
        signature,
        fault_delivery: fault_delivery.clone(),
        exit_outcomes: [
            Outcome::ControlTransferred,
            Outcome::Yield,
            Outcome::Invalidated,
        ]
        .into_iter()
        .filter(|&outcome| after_call(descriptor, outcome) == Ok(AdapterAction::ExitWithoutRestore))
        .map(|outcome| outcome as u32)
        .collect(),
    })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation {
    CapturedState,
    DecodedNextPc,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultSlot {
    pub value: ValueId,
    pub ty: Type,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delivery {
    pub outcome: u32,
    pub restore: StateId,
    pub name: String,
    pub signature: Signature,
}
/// Audited ordinary IEEE arithmetic. This is a MIR choice, not an opcode
/// decision in the emitter; memory operands and conversions keep their helpers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeFp {
    pub opcode: u32,
    pub double: bool,
    pub scalar: bool,
}
impl NativeFp {
    fn from_guest(opcode: u64) -> Option<Self> {
        let (double, scalar) = match opcode >> 16 {
            0 => (false, false),
            0x66 => (true, false),
            0xF3 => (false, true),
            0xF2 => (true, true),
            _ => return None,
        };
        if opcode & 0xFF00 != 0x0F00 {
            return None;
        }
        let operation = match opcode & 255 {
            0x58 => 0,
            0x5C => 1,
            0x59 => 2,
            0x5E => 3,
            _ => return None,
        };
        Some(Self {
            opcode: if double { 0xF0 } else { 0xE4 } + operation,
            double,
            scalar,
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallPlan {
    pub helper: HelperId,
    pub state: StateId,
    pub cpu_observation: Observation,
    pub standalone_observation: Observation,
    pub args: Vec<ValueId>,
    /// Pop order for multi-results; assignments occur only after the outcome check.
    pub staged: Vec<ResultSlot>,
    pub reload: Vec<(ValueId, super::value::Reading)>,
    pub xmm_observation: Option<(u8, u8)>,
    /// Non-NaN-result arithmetic; active NaN lanes retain scalar helper semantics.
    pub native_fp: Option<NativeFp>,
    pub delivery: Option<Delivery>,
    pub exits: Vec<u32>,
    pub normal: Option<u32>,
}
pub fn lower(
    region: &Region,
    inst: &Instruction,
    helpers: &[Option<HelperCall>],
) -> Option<CallPlan> {
    let Op::CallHelper(helper) = inst.op
    else {
        return None;
    };
    let call = helpers[helper.index()].as_ref()?;
    let state = inst.state.unwrap();
    let xmm_observation = if call.cpu_reload && call.name == "ir_sse_fp_reg_continue" {
        crate::ir::helper::cpu_registry::xmm_register_operands(region, &inst.args).filter(|&(_, destination)| {
            // Hand-built HIR may use every ABI result. Restrict narrowing to
            // calls whose only live data result is the audited destination.
            let other: Vec<_> = inst.results[..inst.results.len()-1].iter().enumerate()
                .filter(|(n, _)| *n != 14 + destination as usize).map(|(_, v)| *v).collect();
            !region.instructions.iter().any(|i| i.args.iter().any(|v| other.contains(v)))
                && !region.states.iter().any(|s| s.values().iter().any(|v| other.contains(v)))
                && !region.blocks.iter().any(|b| b.terminator.as_ref().is_some_and(|t|
                    t.edges().iter().any(|e| e.args.iter().any(|v| other.contains(v)))
                    || matches!(b.terminator, Some(crate::ir::hir::Terminator::CondBranch { condition, .. }) if other.contains(&condition))))
        })
    }
    else {
        None
    };
    let native_fp = xmm_observation.and_then(|_| {
        let crate::ir::hir::Definition::Instruction(id, 0) =
            region.values[inst.args[0].index()].definition
        else {
            return None;
        };
        match region.instructions[id.index()].op {
            Op::Const(opcode) => NativeFp::from_guest(opcode),
            _ => None,
        }
    });
    Some(CallPlan {
        xmm_observation,
        native_fp,
        helper,
        state,
        cpu_observation: if matches!(
            region.states[state.index()].resume,
            ResumeKind::BeforeInstruction | ResumeKind::RepProgress
        ) {
            Observation::DecodedNextPc
        }
        else {
            Observation::CapturedState
        },
        standalone_observation: Observation::CapturedState,
        args: inst.args[..inst.args.len() - 1].to_vec(),
        staged: inst.results[..inst.results.len() - 1]
            .iter()
            .rev()
            .filter(|_| !call.cpu_reload)
            .map(|&value| ResultSlot {
                value,
                ty: region.values[value.index()].ty,
            })
            .collect(),
        reload: if call.cpu_reload {
            inst.results[..inst.results.len() - 1]
                .iter()
                .copied()
                .zip(reload_readings())
                .enumerate()
                .filter(|(n, _)| xmm_observation.is_none_or(|(_, d)| *n == 14 + d as usize))
                .map(|(_, pair)| pair)
                .collect()
        }
        else {
            vec![]
        },
        delivery: call.fault_delivery.as_ref().map(|name| Delivery {
            outcome: Outcome::FaultNeedsDelivery as u32,
            restore: state,
            name: name.clone(),
            signature: Signature::new(&[], &[]),
        }),
        exits: call.exit_outcomes.clone(),
        normal: (!call.cpu_exit).then_some(Outcome::Normal as u32),
    })
}
pub fn verify(
    region: &Region,
    helpers: &[Option<HelperCall>],
    plans: &[Option<CallPlan>],
) -> Result<(), CompileError> {
    let invalid = || CompileError::InvalidIr("invalid lowered helper call plan".into());
    if helpers.len() != region.helpers.len() || plans.len() != region.instructions.len() {
        return Err(invalid());
    }
    for (descriptor, call) in region.helpers.iter().zip(helpers) {
        if let Some(call) = call {
            if legalize(descriptor)? != *call {
                return Err(invalid());
            }
        }
    }
    let mut live = vec![false; region.instructions.len()];
    for block in &region.blocks {
        for id in &block.instructions {
            live[id.index()] = true;
        }
    }
    for (index, (inst, plan)) in region.instructions.iter().zip(plans).enumerate() {
        if live[index] && matches!(inst.op, Op::CallHelper(_)) && plan.is_none()
            || lower(region, inst, helpers).as_ref() != plan.as_ref()
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn reload_readings() -> Vec<super::value::Reading> {
    use super::value::{Address, Load, Reading};
    use crate::cpu::global_pointers as gp;
    let read = |address| Reading::Memory {
        address,
        load: Load::I32,
    };
    let mut reads: Vec<_> = (0..8).map(|r| read(Address::Gpr(r))).collect();
    reads.push(Reading::Call {
        name: "get_eflags",
        signature: Signature::new(&[], &[WasmType::I32]),
    });
    reads.extend([
        read(Address::Flags),
        read(Address::Absolute(gp::flags_changed as u32)),
        read(Address::FlagOperand),
        read(Address::Absolute(gp::last_result as u32)),
        read(Address::Absolute(gp::last_op_size as u32)),
    ]);
    reads.extend((0..8).map(|r| Reading::Memory {
        address: Address::Absolute(gp::get_reg_xmm_offset(r)),
        load: Load::V128,
    }));
    reads
}
