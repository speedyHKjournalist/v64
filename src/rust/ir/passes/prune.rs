//! Constant branch selection and removal of unreachable arenas, retaining live polls.
use super::{constant, rewrite_values, PassStats};
use crate::ir::{analysis::cfg::Cfg, hir::*, ids::*};
pub(super) fn run(region: &mut Region, stats: &mut PassStats) -> Result<(), String> {
    if region.blocks.len() > super::MAX_BLOCKS {
        return Err("CFG prune block budget exceeded".into());
    }
    for b in 0..region.blocks.len() {
        let selected = match region.blocks[b].terminator.as_ref().unwrap() {
            Terminator::CondBranch {
                condition,
                taken,
                not_taken,
            } => constant(region, *condition)
                .map(|v| {
                    if v != 0 {
                        taken.clone()
                    }
                    else {
                        not_taken.clone()
                    }
                })
                .or_else(|| {
                    (taken.target == not_taken.target && taken.args == not_taken.args)
                        .then(|| taken.clone())
                }),
            _ => None,
        };
        if let Some(edge) = selected {
            region.blocks[b].terminator = Some(Terminator::Branch(edge));
            stats.branches += 1;
        }
    }
    let (_, reachable) = Cfg::reachability(region)?;
    if reachable.iter().all(|&v| v) {
        return Ok(());
    }
    stats.unreachable += reachable.iter().filter(|&&v| !v).count();
    let mut block_ids = vec![None; region.blocks.len()];
    let mut next = 0;
    for (i, &live) in reachable.iter().enumerate() {
        if live {
            block_ids[i] = Some(BlockId(next));
            next += 1;
        }
    }
    let mut inst_live = vec![false; region.instructions.len()];
    let mut value_live = vec![false; region.values.len()];
    let mut state_live = vec![false; region.states.len()];
    for (b, block) in region.blocks.iter().enumerate() {
        if !reachable[b] {
            continue;
        }
        for v in &block.params {
            value_live[v.index()] = true;
        }
        if let Some(s) = block.entry_state {
            state_live[s.index()] = true;
        }
        if let Some(Terminator::Exit(s)) = block.terminator {
            state_live[s.index()] = true;
        }
        for id in &block.instructions {
            inst_live[id.index()] = true;
            let inst = &region.instructions[id.index()];
            for v in &inst.results {
                value_live[v.index()] = true;
            }
            for s in [inst.state, inst.commit].into_iter().flatten() {
                state_live[s.index()] = true;
            }
        }
    }
    fn mapping(live: &[bool]) -> Vec<Option<u32>> {
        let mut n = 0;
        live.iter()
            .map(|&v| {
                if v {
                    let id = n;
                    n += 1;
                    Some(id)
                }
                else {
                    None
                }
            })
            .collect()
    }
    let inst_ids = mapping(&inst_live);
    let value_ids = mapping(&value_live);
    let state_ids = mapping(&state_live);
    let take = |i: &mut usize, live: &[bool]| {
        let keep = live[*i];
        *i += 1;
        keep
    };
    let mut i = 0;
    region.blocks.retain(|_| take(&mut i, &reachable));
    let mut i = 0;
    region.instructions.retain(|_| take(&mut i, &inst_live));
    let mut i = 0;
    region.values.retain(|_| take(&mut i, &value_live));
    let mut i = 0;
    region.states.retain(|_| take(&mut i, &state_live));
    let remap_value = |v: &mut ValueId| {
        *v = ValueId(value_ids[v.index()].expect("live value definition"));
    };
    rewrite_values(region, remap_value);
    for entry in &mut region.entries {
        *entry = block_ids[entry.index()].unwrap();
    }
    for block in &mut region.blocks {
        for p in &mut block.params {
            remap_value(p);
        }
        for id in &mut block.instructions {
            *id = InstId(inst_ids[id.index()].unwrap());
        }
        if let Some(s) = &mut block.entry_state {
            *s = StateId(state_ids[s.index()].unwrap());
        }
        if let Some(Terminator::Exit(s)) = &mut block.terminator {
            *s = StateId(state_ids[s.index()].unwrap());
        }
        for edge in block.terminator.as_mut().unwrap().edges_mut() {
            edge.target = block_ids[edge.target.index()].unwrap();
        }
    }
    for inst in &mut region.instructions {
        inst.block = block_ids[inst.block.index()].unwrap();
        for value in &mut inst.results {
            remap_value(value);
        }
        for s in [&mut inst.state, &mut inst.commit].into_iter().flatten() {
            *s = StateId(state_ids[s.index()].unwrap());
        }
    }
    for value in &mut region.values {
        match &mut value.definition {
            Definition::Parameter(block, _) => *block = block_ids[block.index()].unwrap(),
            Definition::Instruction(id, _) => *id = InstId(inst_ids[id.index()].unwrap()),
        }
    }
    Ok(())
}
