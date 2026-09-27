use super::runtime::diagnostics::CompileScope;
use super::{
    backend::locals::allocate,
    hir::{Op, Region},
    mir::{Draft, HelperCall, MirData, MirRegion},
    types::Type,
    verify::verify,
};
use crate::wasmgen::wasm_builder::Signature;
use std::collections::HashMap;
#[derive(Debug, Eq, PartialEq)]
pub enum CompileError {
    InvalidIr(String),
    Unsupported(&'static str),
    Budget(&'static str),
}
pub fn lower(region: &Region) -> Result<MirRegion, CompileError> {
    let draft = lower_draft(region)?;
    let _clock = CompileScope::new(10);
    draft.finish()
}
pub fn lower_draft(region: &Region) -> Result<Draft<'_>, CompileError> {
    lower_draft_limited(region, crate::ir::frontend::region::CfgLimits::REGION)
}
/// Page regions may exceed the bounded hot-window shape; every other lowering
/// contract and verifier remains identical.
pub fn lower_limited(
    region: &Region,
    limits: crate::ir::frontend::region::CfgLimits,
) -> Result<MirRegion, CompileError> {
    let draft = lower_draft_limited(region, limits)?;
    let _clock = CompileScope::new(10);
    draft.finish()
}
pub fn lower_draft_limited(
    region: &Region,
    limits: crate::ir::frontend::region::CfgLimits,
) -> Result<Draft<'_>, CompileError> {
    if region.blocks.len() > limits.blocks
        || region.instructions.len() > limits.instructions
        || region.values.len() > limits.values
    {
        return Err(CompileError::Budget("IR region size"));
    }
    verify(region).map_err(|e| CompileError::InvalidIr(e.0))?;
    for state in &region.states {
        if !state.x87.is_empty() {
            return Err(CompileError::Unsupported(
                "extended state materialization pending",
            ));
        }
    }
    let mut imports = HashMap::new();
    let mut helpers: Vec<Option<HelperCall>> = (0..region.helpers.len()).map(|_| None).collect();
    for value in &region.values {
        if !matches!(
            value.ty,
            Type::I1
                | Type::I8
                | Type::I16
                | Type::I32
                | Type::I64
                | Type::V128
                | Type::LinearAddress
                | Type::RmwTicket
                | Type::Effect
        ) {
            return Err(CompileError::Unsupported("unsupported backend value"));
        }
    }
    for block in &region.blocks {
        for id in &block.instructions {
            let inst = &region.instructions[id.index()];
            if matches!(
                inst.op,
                Op::GuestLoad { .. }
                    | Op::Divide { .. }
                    | Op::GuestStore { .. }
                    | Op::PartialStore { .. }
                    | Op::GuestCheck { .. }
                    | Op::SegmentAddress { .. }
                    | Op::PopAddress { .. }
                    | Op::RmwLoad { .. }
                    | Op::RmwStore { .. }
                    | Op::CompareExchange8B { .. }
                    | Op::SseCheck
                    | Op::FpuCheck
                    | Op::XmmLoad { .. }
                    | Op::XmmBinary { .. }
                    | Op::XmmShuffle { .. }
                    | Op::XmmTransferLoad { .. }
                    | Op::XmmInsertWord { .. }
                    | Op::XmmStore { .. }
                    | Op::XmmMaskedStore { .. }
            ) {
                if matches!(inst.op, Op::GuestLoad { bytes } | Op::GuestStore { bytes } | Op::PartialStore { bytes } if !matches!(bytes, 1 | 2 | 4))
                {
                    return Err(CompileError::Unsupported(
                        "wide guest memory lowering pending",
                    ));
                }
                if region.states[inst.state.unwrap().index()].resume
                    != super::state::ResumeKind::BeforeInstruction
                {
                    return Err(CompileError::InvalidIr(
                        "memory fault needs pre-instruction state".into(),
                    ));
                }
            }
            if let Op::CallHelper(id) = region.instructions[id.index()].op {
                if helpers[id.index()].is_some() {
                    continue;
                }
                let descriptor = &region.helpers[id.index()];
                let call = super::mir::call::legalize(descriptor)?;
                let fault_delivery = &call.fault_delivery;
                let signature = call.signature.clone();
                for (name, signature) in std::iter::once((&descriptor.name, signature.clone()))
                    .chain(
                        fault_delivery
                            .iter()
                            .map(|name| (name, Signature::new(&[], &[]))),
                    )
                {
                    if name.is_empty()
                        || name == "m"
                        || imports.get(name).is_some_and(|s| *s != signature)
                    {
                        return Err(CompileError::InvalidIr(
                            "helper import name/signature conflict".into(),
                        ));
                    }
                    imports.insert(name.clone(), signature);
                }
                helpers[id.index()] = Some(call);
            }
        }
    }
    let memory: Vec<_> = region
        .instructions
        .iter()
        .map(super::mir::memory::lower)
        .collect();
    for plan in memory.iter().flatten() {
        let extra = if let super::mir::memory::SlowResult::Rmw { read_value, .. } = &plan.result {
            Some(read_value)
        }
        else {
            None
        };
        for call in std::iter::once(&plan.call).chain(extra) {
            if imports
                .get(call.name)
                .is_some_and(|signature| *signature != call.signature)
            {
                return Err(CompileError::InvalidIr(
                    "memory/helper import signature conflict".into(),
                ));
            }
            imports.insert(call.name.to_owned(), call.signature.clone());
        }
    }
    let effects: Vec<_> = region
        .instructions
        .iter()
        .map(super::mir::effect::lower)
        .collect();
    for plan in effects.iter().flatten() {
        let call = plan.call();
        if imports
            .get(call.name)
            .is_some_and(|signature| *signature != call.signature)
        {
            return Err(CompileError::InvalidIr(
                "effect/helper import signature conflict".into(),
            ));
        }
        imports.insert(call.name.to_owned(), call.signature.clone());
    }
    let calls: Vec<_> = region
        .instructions
        .iter()
        .map(|inst| super::mir::call::lower(region, inst, &helpers))
        .collect();
    let values = region
        .instructions
        .iter()
        .map(|inst| super::mir::value::lower(region, inst))
        .collect();
    let state_clock = CompileScope::new(8);
    let states = super::mir::materialize::lower_all(region);
    drop(state_clock);
    let proof_clock = CompileScope::new(9);
    let helper_state = super::mir::helper_state::lower(
        region,
        &calls,
        super::mir::helper_state::DEFAULT_WORK_LIMIT,
    )?;
    let cpu_liveness = super::mir::cpu_liveness::Plan::disabled(region.instructions.len());
    let state_elision = super::mir::state_elision::lower(
        region,
        &states,
        super::mir::state_elision::DEFAULT_WORK_LIMIT,
    )?;
    drop(proof_clock);
    let allocation = {
        let _clock = CompileScope::new(7);
        allocate(region).map_err(CompileError::Budget)?
    };
    let control = super::mir::control::lower_with(region, &allocation, limits.sparse_polls)?;
    Ok(Draft::new(
        region,
        MirData {
            ram_forwarding: vec![None; region.instructions.len()],
            ram_guard_reuse: vec![None; region.instructions.len()],
            ram_loop_cache: super::mir::forwarding::LoopPlan::disabled(
                region.instructions.len(),
                region.blocks.len(),
            ),
            state_elision,
            helper_state,
            cpu_liveness,
            value_types: region.values.iter().map(|v| v.ty).collect(),
            value_blocks: region
                .values
                .iter()
                .map(|value| match value.definition {
                    super::hir::Definition::Parameter(block, _) => Some(block),
                    super::hir::Definition::Instruction(id, _) => {
                        Some(region.instructions[id.index()].block)
                    },
                })
                .collect(),
            value_definitions: region
                .values
                .iter()
                .map(|value| match value.definition {
                    super::hir::Definition::Parameter(_, _) => None,
                    super::hir::Definition::Instruction(id, _) => Some(id),
                })
                .collect(),
            allocation,
            allocation_graph: super::mir::allocation::capture(region),
            stack_elided: vec![false; region.instructions.len()],
            helpers,
            memory,
            effects,
            calls,
            poll_batches: vec![None; region.blocks.len()],
            control,
            values,
            states,
        },
    ))
}
