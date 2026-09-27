//! Conservative LICM for natural loops with an existing unconditional preheader.
//!
//! Only total, pure SSA expressions may move. CPU reads are NOT pure, even when
//! `Op::ordered()` is false. Memory, checks, helpers, polls and recovery points
//! retain their order. No address/permission proof is inferred by this pass.
use crate::ir::{analysis::cfg::Cfg, hir::*, ids::*, verify::verify};

pub const DEFAULT_WORK_LIMIT: usize = 1_000_000;

#[derive(Default, Debug, Clone, Copy, Eq, PartialEq)]
pub struct Stats {
    pub loops: usize,
    /// Motions, not unique instructions: a value can leave two nested loops.
    pub hoisted: usize,
    pub work: usize,
}

struct Work {
    remaining: usize,
    used: usize,
}
impl Work {
    fn spend(&mut self, amount: usize) -> Result<(), String> {
        self.remaining = self
            .remaining
            .checked_sub(amount)
            .ok_or("LICM work budget exceeded")?;
        self.used += amount;
        Ok(())
    }
}

struct NaturalLoop {
    header: usize,
    preheader: usize,
    members: Vec<bool>,
}

fn eligible(inst: &Instruction) -> bool {
    inst.results.len() == 1
        && inst.state.is_none()
        && inst.commit.is_none()
        && !inst.trap_after_fault
        && !inst.unmasked_word_store
        && matches!(
            inst.op,
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
                | Op::VectorBitmask { .. }
                | Op::VectorBinary(_)
                | Op::VectorShuffle(_)
                | Op::VectorExtract { .. }
                | Op::VectorReplace { .. }
        )
}

fn discover(region: &Region, cfg: &Cfg, work: &mut Work) -> Result<Vec<NaturalLoop>, String> {
    let n = region.blocks.len();
    let mut loops = Vec::new();
    for header in 0..n {
        work.spend(1)?;
        // An external entry has a synthetic predecessor, not a real preheader.
        if region.entries.contains(&BlockId(header as u32)) {
            continue;
        }
        let mut members = vec![false; n];
        members[header] = true;
        let mut stack = Vec::new();
        let mut has_backedge = false;
        for pred in &cfg.predecessors[header] {
            work.spend(1)?;
            if cfg.dominates(pred.index(), header) {
                has_backedge = true;
                if !members[pred.index()] {
                    members[pred.index()] = true;
                    stack.push(pred.index());
                }
            }
        }
        if !has_backedge {
            continue;
        }
        // Union all latches of this header; stop the reverse walk at the header.
        while let Some(block) = stack.pop() {
            for pred in &cfg.predecessors[block] {
                work.spend(1)?;
                if !members[pred.index()] {
                    members[pred.index()] = true;
                    stack.push(pred.index());
                }
            }
        }
        let mut valid = true;
        for block in 0..n {
            work.spend(1)?;
            if !members[block] {
                continue;
            }
            valid &=
                cfg.dominates(block, header) && !region.entries.contains(&BlockId(block as u32));
            if block != header {
                for pred in &cfg.predecessors[block] {
                    work.spend(1)?;
                    valid &= members[pred.index()];
                }
            }
        }
        if !valid {
            continue;
        }
        let mut outside: Vec<_> = cfg.predecessors[header]
            .iter()
            .map(|p| p.index())
            .filter(|&p| !members[p])
            .collect();
        outside.sort_unstable();
        outside.dedup();
        if outside.len() != 1 {
            continue;
        }
        let preheader = outside[0];
        if !matches!(
            region.blocks[preheader].terminator.as_ref(),
            Some(Terminator::Branch(edge)) if edge.target.index() == header
        ) || !cfg.dominates(header, preheader)
        {
            continue;
        }
        loops.push(NaturalLoop {
            header,
            preheader,
            members,
        });
    }
    // Inner first. The graph is unchanged, so dominance remains valid throughout.
    loops.sort_by_key(|l| (l.members.iter().filter(|&&member| member).count(), l.header));
    Ok(loops)
}

/// Atomically optimize a verified region. An error leaves the caller's arenas,
/// scheduling and recovery maps unchanged. The work limit covers discovery and
/// candidate/operand visits; fixed arena caps bound the verifier and cloning.
/// Loop discovery here is bounded to region-sized graphs; the compiler skips
/// LICM for larger (page) graphs instead of failing their compilation.
pub const MAX_BLOCKS: usize = 64;
pub fn run(region: &mut Region, work_limit: usize) -> Result<Stats, String> {
    if region.blocks.len() > MAX_BLOCKS
        || region.instructions.len() > 8192
        || region.values.len() > 16384
        || region.states.len() > 8192
        || region.helpers.len() > 1024
    {
        return Err("LICM region budget exceeded".into());
    }
    let mut work = Work {
        remaining: work_limit,
        used: 0,
    };
    work.spend(1)?;
    if crate::ir::debug::audit() {
        verify(region).map_err(|e| e.0)?;
    }
    let cfg = Cfg::compute(region)?;
    let loops = discover(region, &cfg, &mut work)?;
    if loops.is_empty() {
        return Ok(Stats {
            work: work.used,
            ..Stats::default()
        });
    }
    let mut staged = region.clone();
    let mut stats = Stats::default();
    for natural in loops {
        stats.loops += 1;
        let mut order: Vec<_> = (0..staged.blocks.len())
            .filter(|&b| natural.members[b])
            .collect();
        // A definition precedes a dominated use, regardless of arena numbering.
        order.sort_by_key(|&b| (cfg.dominator_count(b), b));
        let mut moved = vec![false; staged.instructions.len()];
        let mut hoisted = Vec::new();
        for &block in &order {
            for id in staged.blocks[block].instructions.clone() {
                work.spend(1)?;
                let inst = &staged.instructions[id.index()];
                if !eligible(inst) {
                    continue;
                }
                let mut invariant = true;
                for value in &inst.args {
                    work.spend(1)?;
                    let owner = match staged.values[value.index()].definition {
                        Definition::Parameter(owner, _) => owner.index(),
                        Definition::Instruction(def, _) => {
                            staged.instructions[def.index()].block.index()
                        },
                    };
                    invariant &= !natural.members[owner] && cfg.dominates(natural.preheader, owner);
                }
                if invariant {
                    // Updating ownership makes dependent expressions available
                    // later in this scan. Append in exactly that dependency order.
                    staged.instructions[id.index()].block = BlockId(natural.preheader as u32);
                    moved[id.index()] = true;
                    hoisted.push(id);
                    stats.hoisted += 1;
                }
            }
        }
        for block in order {
            work.spend(staged.blocks[block].instructions.len())?;
            staged.blocks[block]
                .instructions
                .retain(|id| !moved[id.index()]);
        }
        work.spend(hoisted.len())?;
        staged.blocks[natural.preheader]
            .instructions
            .extend(hoisted);
    }
    verify(&staged).map_err(|e| e.0)?;
    stats.work = work.used;
    *region = staged;
    Ok(stats)
}

#[cfg(test)]
#[path = "../../../../tests/ir/semantics/licm.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../../tests/ir/semantics/licm_acceptance.rs"]
mod acceptance;
