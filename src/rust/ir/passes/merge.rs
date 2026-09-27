//! Eliminate straight-line dispatcher edges while preserving every budget boundary.
use super::{rewrite_values, PassStats};
use crate::ir::{hir::*, ids::*, types::Type};

use super::{MAX_BLOCKS, MAX_INSTRUCTIONS, MAX_VALUES};

pub(super) fn run(region: &mut Region, stats: &mut PassStats) -> Result<(), String> {
    let n = region.blocks.len();
    if n > MAX_BLOCKS {
        return Err("CFG merge block budget exceeded".into());
    }
    // One linear pass: find every uniquely reached straight-line successor,
    // absorb whole chains into their head, then rewrite values and block ids
    // once. Each absorbed boundary keeps its PollBudget and recovery map, so
    // the result equals repeatedly merging one pair at a time.
    let mut predecessors = vec![0u32; n];
    for block in &region.blocks {
        for edge in block.terminator.as_ref().unwrap().edges() {
            predecessors[edge.target.index()] += 1;
        }
    }
    let mut entry = vec![false; n];
    for e in &region.entries {
        entry[e.index()] = true;
    }
    let mut absorbed_by: Vec<Option<usize>> = vec![None; n];
    for (a, block) in region.blocks.iter().enumerate() {
        let Some(Terminator::Branch(edge)) = block.terminator.as_ref()
        else {
            continue;
        };
        let b = edge.target.index();
        let target = &region.blocks[b];
        // A recovery-free, non-entry head is a cold selector block: absorbing
        // guest code there would leave that code without a budget recovery map.
        if a != b
            && predecessors[b] == 1
            && !entry[b]
            && (entry[a] || block.entry_state.is_some())
            && target.entry_state.is_some()
            && target
                .params
                .iter()
                .any(|v| region.values[v.index()].ty == Type::Effect)
        {
            absorbed_by[b] = Some(a);
        }
    }
    let mut aliases: Vec<Option<ValueId>> = vec![None; region.values.len()];
    let mut root: Vec<usize> = (0..n).collect();
    let mut merged = vec![false; n];
    for head in 0..n {
        // Chain heads are never absorbed. Blocks reached only around an
        // unreachable single-predecessor cycle keep their original edges.
        if absorbed_by[head].is_some() {
            continue;
        }
        let mut tail = head;
        loop {
            let Some(Terminator::Branch(edge)) = region.blocks[head].terminator.as_ref()
            else {
                break;
            };
            let b = edge.target.index();
            if absorbed_by[b] != Some(tail) || merged[b] {
                break;
            }
            if region.instructions.len() >= MAX_INSTRUCTIONS || region.values.len() >= MAX_VALUES {
                break;
            }
            let args = edge.args.clone();
            let recovery = region.blocks[b].entry_state.unwrap();
            let params = region.blocks[b].params.clone();
            let effect_index = params
                .iter()
                .position(|v| region.values[v.index()].ty == Type::Effect)
                .unwrap();
            region.blocks[head].terminator = None;
            let effect = region.append(
                BlockId(head as u32),
                Op::PollBudget,
                vec![args[effect_index]],
                &[Type::Effect],
                Some(recovery),
            )[0];
            aliases.resize(region.values.len(), None);
            // Inputs cannot depend on the target's parameters: its only
            // predecessor is this chain and the verified graph has no entry there.
            for (p, (&param, &arg)) in params.iter().zip(&args).enumerate() {
                aliases[param.index()] = Some(if p == effect_index { effect } else { arg });
            }
            let instructions = std::mem::take(&mut region.blocks[b].instructions);
            region.blocks[head].instructions.extend(instructions);
            region.blocks[head].terminator = region.blocks[b].terminator.take();
            merged[b] = true;
            root[b] = head;
            tail = b;
            stats.merged += 1;
        }
    }
    if !merged.iter().any(|m| *m) {
        return Ok(());
    }
    let resolve = |mut value: ValueId| {
        while let Some(next) = aliases.get(value.index()).copied().flatten() {
            value = next;
        }
        value
    };
    rewrite_values(region, |value| *value = resolve(*value));
    let mut index = vec![0u32; n];
    let mut next = 0;
    for b in 0..n {
        if !merged[b] {
            index[b] = next;
            next += 1;
        }
    }
    for b in 0..n {
        if merged[b] {
            index[b] = index[root[b]];
        }
    }
    let remap = |id: &mut BlockId| *id = BlockId(index[id.index()]);
    for entry in &mut region.entries {
        remap(entry);
    }
    for inst in &mut region.instructions {
        remap(&mut inst.block);
    }
    for value in &mut region.values {
        if let Definition::Parameter(ref mut block, _) = value.definition {
            remap(block);
        }
    }
    let mut b = 0;
    region.blocks.retain(|_| {
        b += 1;
        !merged[b - 1]
    });
    for block in &mut region.blocks {
        for edge in block.terminator.as_mut().unwrap().edges_mut() {
            remap(&mut edge.target);
        }
    }
    Ok(())
}
