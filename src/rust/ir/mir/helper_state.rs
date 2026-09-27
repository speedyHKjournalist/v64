//! Audited helper-state observation trimming.
//!
//! A helper can skip pre-call CPU StateMap materialization only when its
//! descriptor proves that it neither reads nor writes architectural state,
//! cannot fault/transfer/yield/invalidate, and its normal ABI preserves state.
//! The certificate is derived at lowering and enabled explicitly for Tier 2.

use super::{call::CallPlan, MirData};
use crate::ir::{
    helper::{ExceptionOwner, HelperAbi},
    hir::{Op, Region},
    ids::InstId,
    lowering::CompileError,
};

pub const DEFAULT_WORK_LIMIT: usize = 16_384;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    eligible: Vec<bool>,
    enabled: bool,
}

fn derive(
    region: &Region,
    calls: &[Option<CallPlan>],
    work_limit: usize,
) -> Result<Plan, CompileError> {
    if calls.len() != region.instructions.len() {
        return Err(CompileError::InvalidIr(
            "helper-state call-plan mismatch".into(),
        ));
    }
    if region.instructions.len() > work_limit {
        return Err(CompileError::Budget("helper-state work"));
    }
    let mut eligible = vec![false; region.instructions.len()];
    for block in &region.blocks {
        for &id in &block.instructions {
            let inst = &region.instructions[id.index()];
            let Op::CallHelper(helper) = inst.op
            else {
                continue;
            };
            let descriptor = region
                .helpers
                .get(helper.index())
                .ok_or_else(|| CompileError::InvalidIr("helper-state descriptor missing".into()))?;
            let Some(plan) = calls.get(id.index()).and_then(Option::as_ref)
            else {
                return Err(CompileError::InvalidIr(
                    "helper-state call plan missing".into(),
                ));
            };
            let normal_preserves = matches!(
                descriptor.abi,
                HelperAbi::Outcome {
                    normal_preserves_state: true,
                    fault_delivery: None,
                }
            );
            eligible[id.index()] = descriptor.effects.is_pure()
                && descriptor.exception_owner == ExceptionOwner::CannotFault
                && normal_preserves
                && plan.delivery.is_none()
                && plan.exits.is_empty()
                && plan.normal.is_some();
        }
    }
    Ok(Plan {
        eligible,
        enabled: false,
    })
}

pub(crate) fn lower(
    region: &Region,
    calls: &[Option<CallPlan>],
    work_limit: usize,
) -> Result<Plan, CompileError> {
    match derive(region, calls, work_limit) {
        Ok(plan) => Ok(plan),
        Err(CompileError::Budget(_)) => Ok(Plan {
            eligible: vec![false; region.instructions.len()],
            enabled: false,
        }),
        Err(error) => Err(error),
    }
}

pub(super) fn verify(region: &Region, data: &MirData) -> Result<(), CompileError> {
    let expected = lower(region, &data.calls, DEFAULT_WORK_LIMIT)?;
    if data.helper_state.enabled || data.helper_state.eligible != expected.eligible {
        return Err(CompileError::InvalidIr(
            "invalid helper-state certificate".into(),
        ));
    }
    Ok(())
}

pub(super) fn enable(data: &mut MirData, work_limit: usize) -> Result<usize, CompileError> {
    if data.helper_state.eligible.len() > work_limit {
        return Err(CompileError::Budget("helper-state work"));
    }
    let count = data
        .helper_state
        .eligible
        .iter()
        .filter(|&&eligible| eligible)
        .count();
    data.helper_state.enabled = true;
    Ok(count)
}

pub(super) fn elided(data: &MirData, id: InstId) -> bool {
    data.helper_state.enabled
        && data
            .helper_state
            .eligible
            .get(id.index())
            .copied()
            .unwrap_or(false)
}

pub(super) fn eligible(data: &MirData, id: InstId) -> bool {
    data.helper_state
        .eligible
        .get(id.index())
        .copied()
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{
        backend::wasm::{emit, emit_cpu, StateLayout},
        effects::{Effects, StateSet},
        frontend::{decode::GuestEip, integer::IntegerBuilder},
        helper::{ExceptionOwner, HelperAbi, HelperDescriptor},
        hir::{Binary, Op, Terminator},
        ids::HelperId,
        lowering::lower,
        state::{ResumeKind, StateMap},
        types::Type,
    };

    fn region(reads_state: bool) -> crate::ir::hir::Region {
        let mut b = IntegerBuilder::new();
        let input = b.gpr;
        let one = b.constant(1, Type::I32);
        let dead = b.binary(Binary::Add, input[7], one);
        let mut before_gpr = input;
        before_gpr[7] = dead;
        let before = b.region.state(StateMap {
            instruction_pc: GuestEip(0x1000),
            next_pc: GuestEip(0x1001),
            next_value: None,
            resume: ResumeKind::BeforeInstruction,
            gpr: before_gpr,
            flags: b.flags.clone(),
            xmm: vec![],
            x87: vec![],
            committed_instructions: 0,
            count_base: None,
            rep_progress: None,
        });
        let mut effects = Effects::pure();
        if reads_state {
            effects.reads_state = StateSet::ALL;
        }
        b.region.helpers.push(HelperDescriptor {
            name: "ir10_pure_helper".into(),
            params: vec![Type::I32],
            results: vec![Type::I32],
            effects,
            exception_owner: ExceptionOwner::CannotFault,
            abi: HelperAbi::Outcome {
                fault_delivery: None,
                normal_preserves_state: true,
            },
        });
        let values = b.region.append(
            b.block,
            Op::CallHelper(HelperId(0)),
            vec![input[0], b.effect],
            &[Type::I32, Type::Effect],
            Some(before),
        );
        b.effect = values[1];
        let mut after_gpr = input;
        after_gpr[0] = values[0];
        let after = b.region.state(StateMap {
            instruction_pc: GuestEip(0x1000),
            next_pc: GuestEip(0x1001),
            next_value: None,
            resume: ResumeKind::AfterInstruction,
            gpr: after_gpr,
            flags: b.flags,
            xmm: vec![],
            x87: vec![],
            committed_instructions: 1,
            count_base: None,
            rep_progress: None,
        });
        b.region.terminate(b.block, Terminator::Exit(after));
        b.region
    }

    fn layout() -> StateLayout {
        StateLayout {
            gpr: 256,
            flags: 288,
            eip: 292,
            committed: 296,
            flag_operand: 300,
        }
    }

    #[test]
    fn pure_helper_trim_reduces_cpu_state_and_liveness_only() {
        let region = region(false);

        let mut baseline = lower(&region).unwrap();
        let baseline_dead = baseline
            .elide_dead_cpu_values(crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT)
            .unwrap();
        let baseline_cpu = emit_cpu(&baseline, 100).unwrap().bytes;
        let baseline_standalone = emit(&baseline, layout(), 100).unwrap().bytes;

        let mut optimized = lower(&region).unwrap();
        assert_eq!(
            optimized
                .elide_helper_state_observations(DEFAULT_WORK_LIMIT)
                .unwrap(),
            1
        );
        let optimized_dead = optimized
            .elide_dead_cpu_values(crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT)
            .unwrap();
        assert!(
            optimized_dead > baseline_dead,
            "trimmed helper snapshot should release recovery-only SSA"
        );
        let optimized_cpu = emit_cpu(&optimized, 100).unwrap().bytes;
        let optimized_standalone = emit(&optimized, layout(), 100).unwrap().bytes;
        assert!(optimized_cpu.len() < baseline_cpu.len());
        assert_eq!(optimized_standalone, baseline_standalone);
    }

    #[test]
    fn helper_state_reads_are_a_hard_negative_barrier() {
        let region = region(true);
        let mut mir = lower(&region).unwrap();
        assert_eq!(
            mir.elide_helper_state_observations(DEFAULT_WORK_LIMIT)
                .unwrap(),
            0
        );
        emit_cpu(&mir, 100).unwrap();
    }
}
