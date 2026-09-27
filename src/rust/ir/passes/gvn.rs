//! Pure-expression reuse from dominating definitions; never speculate or read CPU state.
use super::{rewrite_values, PassStats};
use crate::ir::{analysis::cfg::Cfg, hir::*, ids::*};
use std::collections::{HashMap, HashSet};
fn eligible(op: &Op) -> bool {
    matches!(
        op,
        Op::Const(_)
            | Op::Binary(_)
            | Op::Select
            | Op::Extend { .. }
            | Op::Truncate
            | Op::Extract { .. }
            | Op::Insert { .. }
            | Op::CountLeadingZeros
            | Op::CountTrailingZeros
            | Op::PopulationCount
            | Op::LinearOffset
            | Op::VectorBitmask { .. }
            | Op::VectorBinary(_)
            | Op::VectorShuffle(_)
            | Op::VectorExtract { .. }
            | Op::VectorReplace { .. }
    )
}
pub(super) fn run(region: &mut Region, stats: &mut PassStats) -> Result<(), String> {
    if region.blocks.len() > super::MAX_BLOCKS
        || region.instructions.len() > super::MAX_INSTRUCTIONS
        || region.values.len() > super::MAX_VALUES
    {
        return Err("GVN region budget exceeded".into());
    }
    let cfg = Cfg::compute(region)?;
    let mut order: Vec<_> = (0..region.blocks.len()).collect();
    // Strict dominators have fewer dominators than the blocks they dominate.
    // Independent entries and siblings never supply one another's expressions.
    order.sort_by_key(|&b| cfg.dominator_count(b));
    let mut known: HashMap<_, Vec<(usize, ValueId)>> = HashMap::new();
    let mut aliases = vec![None; region.values.len()];
    let mut removed = HashSet::new();
    for b in order {
        for id in region.blocks[b].instructions.clone() {
            let inst = &mut region.instructions[id.index()];
            for arg in &mut inst.args {
                if let Some(value) = aliases[arg.index()] {
                    *arg = value;
                }
            }
            if !eligible(&inst.op) || inst.results.len() != 1 || inst.state.is_some() {
                continue;
            }
            let result = inst.results[0];
            let key = (
                inst.op.clone(),
                inst.args.clone(),
                region.values[result.index()].ty,
            );
            let choices = known.entry(key).or_default();
            if let Some(&(owner, previous)) = choices
                .iter()
                .rev()
                .find(|(owner, _)| cfg.dominates(b, *owner))
            {
                aliases[result.index()] = Some(previous);
                removed.insert(id);
                stats.commoned += 1;
                stats.cross_commoned += usize::from(owner != b);
            }
            else {
                choices.push((b, result));
            }
        }
    }
    // Alias destinations were kept as canonical definitions, so one simultaneous
    // rewrite updates instruction/edge arguments and every recovery-only value.
    rewrite_values(region, |value| {
        if let Some(new) = aliases[value.index()] {
            *value = new;
        }
    });
    for block in &mut region.blocks {
        block.instructions.retain(|id| !removed.contains(id));
    }
    Ok(())
}
