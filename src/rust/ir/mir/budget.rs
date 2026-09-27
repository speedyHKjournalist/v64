//! Bounded reservation of dispatcher work, not guest retirement. A fast body is
//! entered only when all of its original poll credits are available. Exceptions,
//! helper outcomes, memory guards and StateMaps execute unchanged; unused credits
//! on an early exit are local to that activation and are not guest instructions.
//! Mixed bodies retain polls after every possible observer. The backend may
//! elide later redundant epoch tests along observer-free straight-line spans;
//! recovery after an observer remains at its original instruction boundary.
use super::{
    value::{Reading, Step},
    MirData,
};
use crate::ir::{ids::BlockId, lowering::CompileError};
pub const DEFAULT_WORK_LIMIT: usize = 262_144;
const MAX_BODY_INSTRUCTIONS: usize = 512;
const MAX_POLLS: u32 = 31;
const MAX_BATCHES: usize = 4;
const MAX_LATCH_INSTRUCTIONS: usize = 8;
const MAX_LATCH_STEPS: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LoopBackedge {
    /// The header itself, or a small observer-free bookkeeping latch.
    pub target: BlockId,
    /// Original dispatcher credits in the latch; zero for a direct self edge.
    pub cost: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Batch {
    /// First duplicated instruction. Its preceding poll (or the block-entry
    /// poll for zero) remains on the mandatory, unspeculated path.
    pub start: usize,
    pub cost: u32,
    /// Only observer-free bodies may omit the original code-epoch checks.
    pub pure: bool,
    pub backedge: Option<LoopBackedge>,
}
fn observes(data: &MirData, id: crate::ir::ids::InstId) -> bool {
    let i = id.index();
    if data.memory[i].is_some() || data.effects[i].is_some() || data.calls[i].is_some() {
        return true;
    }
    if data.control.polls[i].is_some() {
        return false;
    }
    let Some(value) = &data.values[i]
    else {
        return true;
    };
    // Backing-state loads do not observe the host. Opaque imports do, even
    // when a particular implementation happens to preserve CPU state.
    value.steps.iter().any(|step| {
        matches!(
            step,
            Step::Read {
                cpu: Reading::Call { .. },
                ..
            } | Step::Read {
                standalone: Reading::Call { .. },
                ..
            }
        )
    })
}
fn loop_backedge(data: &MirData, id: BlockId) -> Option<LoopBackedge> {
    let edges = data.control.blocks[id.index()].terminator.edges();
    if edges.iter().any(|edge| edge.target == id) {
        return Some(LoopBackedge {
            target: id,
            cost: 0,
        });
    }
    for edge in edges {
        let latch = &data.control.blocks[edge.target.index()];
        if !matches!(&latch.terminator, super::control::Terminator::Jump(back) if back.target == id)
            || latch.instructions.len() > MAX_LATCH_INSTRUCTIONS
            || latch.budget_cost > 1
        {
            continue;
        }
        let mut cost = latch.budget_cost;
        let mut valid = true;
        for &inst in &latch.instructions {
            valid &= !observes(data, inst);
            if let Some(value) = &data.values[inst.index()] {
                valid &= value.steps.len() <= MAX_LATCH_STEPS;
            }
            if let Some(poll) = &data.control.polls[inst.index()] {
                valid &= poll.cost == 1;
                cost = cost.checked_add(poll.cost)?;
            }
        }
        if valid {
            return Some(LoopBackedge {
                target: edge.target,
                cost,
            });
        }
    }
    None
}
fn certificate(data: &MirData, id: BlockId) -> Option<Batch> {
    let block = &data.control.blocks[id.index()];
    if block.budget_cost != 1
        || data
            .helpers
            .iter()
            .flatten()
            .any(|h| h.starts_interrupt_shadow)
    {
        return None;
    }
    // A complete loop body can use a fast loop plus one cold residual
    // iteration, rather than carrying two bodies and their merge through the
    // hot backedge. Conditional branches may have a separate count/PC latch;
    // reserve its original credits too and refund them on the other edge.
    if let Some(backedge) = loop_backedge(data, id) {
        if let Some(mut batch) = body(data, &block.instructions, 0) {
            if batch.cost + block.budget_cost + backedge.cost <= MAX_POLLS + 1 {
                batch.backedge = Some(backedge);
                return Some(batch);
            }
        }
    }
    // Keep the old bounded pure-suffix opportunity when a large mixed body is
    // too costly to duplicate. Its preceding poll remains mandatory.
    let last_observer = block
        .instructions
        .iter()
        .rposition(|&id| observes(data, id));
    let after = last_observer.map_or(0, |i| i + 1);
    let start = after
        + block.instructions[after..].iter().position(|id| {
            data.control.polls[id.index()]
                .as_ref()
                .is_some_and(|p| p.cost == 1)
        })?
        + 1;
    body(data, &block.instructions, start)
}
fn body(data: &MirData, instructions: &[crate::ir::ids::InstId], start: usize) -> Option<Batch> {
    if instructions.len() - start > MAX_BODY_INSTRUCTIONS {
        return None;
    }
    let mut cost = 0u32;
    let mut pure = true;
    for &id in &instructions[start..] {
        pure &= !observes(data, id);
        if let Some(poll) = &data.control.polls[id.index()] {
            if poll.cost != 1 {
                return None;
            }
            cost = cost.checked_add(1)?;
        }
    }
    (2..=MAX_POLLS).contains(&cost).then_some(Batch {
        start,
        cost,
        pure,
        backedge: None,
    })
}
pub(super) fn enable(data: &mut MirData, work_limit: usize) -> Result<usize, CompileError> {
    let values = data
        .values
        .iter()
        .flatten()
        .try_fold(0usize, |n, v| n.checked_add(v.steps.len()))
        .ok_or(CompileError::Budget("budget batch work"))?;
    let work = data
        .control
        .blocks
        .iter()
        .try_fold(values, |total, b| {
            total
                .checked_add(b.instructions.len())
                .and_then(|n| n.checked_add(data.helpers.len()))
                .and_then(|n| n.checked_add(2 * MAX_LATCH_INSTRUCTIONS * MAX_LATCH_STEPS))
        })
        .ok_or(CompileError::Budget("budget batch work"))?;
    if work > work_limit {
        return Err(CompileError::Budget("budget batch work"));
    }
    let mut batches = vec![None; data.control.blocks.len()];
    let mut count = 0;
    for (index, batch) in batches.iter_mut().enumerate() {
        if count == MAX_BATCHES {
            break;
        }
        *batch = certificate(data, BlockId(index as u32));
        count += usize::from(batch.is_some());
    }
    data.poll_batches = batches;
    Ok(count)
}
pub(super) fn verify(data: &MirData) -> Result<(), CompileError> {
    if data.poll_batches.len() != data.control.blocks.len()
        || data.poll_batches.iter().flatten().count() > MAX_BATCHES
        || data.poll_batches.iter().enumerate().any(|(index, batch)| {
            batch.is_some() && *batch != certificate(data, BlockId(index as u32))
        })
    {
        return Err(CompileError::InvalidIr(
            "invalid budget reservation certificate".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{
        frontend::{
            decode::{GuestEip, LinearAddress},
            region::lift_cpu_cfg,
        },
        lowering::lower,
        passes::{run, PassConfig},
    };
    fn make(bytes: &[u8]) -> crate::ir::mir::MirRegion {
        let mut r =
            lift_cpu_cfg(bytes, GuestEip(0x100000), LinearAddress(0x100000), true, 64).unwrap();
        run(&mut r, PassConfig::default()).unwrap();
        lower(&r).unwrap()
    }
    #[test]
    fn bounded_owned_proof_rejects_forged_cost_and_budget_failure_is_transactional() {
        let mut mir = make(&[0x40, 0x43, 0x46, 0x4B, 0xEB, 0xFA]);
        assert!(mir.batch_pure_budget_polls(0).is_err());
        assert!(mir.poll_batches.iter().all(Option::is_none));
        assert!(mir.batch_pure_budget_polls(DEFAULT_WORK_LIMIT).unwrap() > 0);
        mir.verify().unwrap();
        let saved = mir.poll_batches.clone();
        assert!(mir.batch_pure_budget_polls(0).is_err());
        assert_eq!(mir.poll_batches, saved);
        let at = saved.iter().position(Option::is_some).unwrap();
        let original = saved[at].unwrap();
        mir.data.poll_batches[at] = Some(Batch {
            cost: original.cost + 1,
            ..original
        });
        assert!(mir.verify().is_err());
        mir.data.poll_batches = saved;
        mir.verify().unwrap();
    }
    #[test]
    fn mixed_bodies_reserve_budget_but_cannot_claim_purity() {
        for bytes in [
            &[0x40, 0x43, 0x46, 0x89, 0x06, 0x47, 0xEB, 0xF8][..],
            &[0x40, 0x43, 0x46, 0x8B, 0x06, 0x47, 0xEB, 0xF8][..],
            &[0x0F, 0x58, 0xC1, 0x49, 0x75, 0xFA][..],
        ] {
            let mut mir = make(bytes);
            mir.batch_pure_budget_polls(DEFAULT_WORK_LIMIT).unwrap();
            let at = mir
                .poll_batches
                .iter()
                .position(|b| b.is_some_and(|b| !b.pure))
                .unwrap_or_else(|| {
                    panic!(
                        "mixed block must exercise reservation: {bytes:02X?}; {:?}",
                        mir.control
                            .blocks
                            .iter()
                            .map(|b| (b.budget_cost, &b.terminator, b.instructions.len()))
                            .collect::<Vec<_>>()
                    )
                });
            mir.verify().unwrap();
            let saved = mir.poll_batches[at].unwrap();
            mir.data.poll_batches[at] = Some(Batch {
                pure: true,
                ..saved
            });
            assert!(
                mir.verify().is_err(),
                "forged purity must not skip epoch checks"
            );
            mir.data.poll_batches[at] = Some(saved);
            mir.verify().unwrap();
        }
    }
    #[test]
    fn interrupt_shadow_and_oversized_bodies_keep_original_polls() {
        let mut mir = make(&[0xFB, 0x40, 0x43, 0x46, 0x47]);
        mir.batch_pure_budget_polls(DEFAULT_WORK_LIMIT).unwrap();
        assert!(mir.poll_batches.iter().all(Option::is_none));
        mir.verify().unwrap();
        let mut mir = make(&[0x40, 0x43, 0x46, 0x47, 0x4B]);
        let block = mir
            .control
            .blocks
            .iter()
            .position(|b| b.instructions.len() > 4)
            .unwrap();
        let instructions = mir.control.blocks[block].instructions.clone();
        let repeated = instructions.repeat(MAX_BODY_INSTRUCTIONS);
        assert!(body(&mir.data, &repeated, 0).is_none());
        assert!(mir.batch_pure_budget_polls(0).is_err());
        assert!(mir.poll_batches.iter().all(Option::is_none));
    }
}
