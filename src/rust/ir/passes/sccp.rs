//! Executable-edge integer constant propagation with a bounded block worklist.
//!
//! Parameters are analysis facts, not rewritten definitions: entry StateMaps
//! must still observe the actual incoming values before the first instruction.
//! Only pure scalar instructions and proven conditional edges are rewritten.
use super::{evaluate_integer, prune, PassStats};
use crate::ir::{hir::*, ids::*, verify::verify};
use std::collections::VecDeque;

pub const DEFAULT_WORK_LIMIT: usize = 1_000_000;

#[derive(Default, Debug)]
pub struct Stats {
    pub constants: usize,
    pub parameters: usize,
    pub branches: usize,
    pub unreachable: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Lattice {
    Unknown,
    Constant(u64),
    Overdefined,
}
impl Lattice {
    fn join(self, other: Self) -> Self {
        match (self, other) {
            (Self::Unknown, value) | (value, Self::Unknown) => value,
            (Self::Constant(a), Self::Constant(b)) if a == b => self,
            _ => Self::Overdefined,
        }
    }
}
struct Work(usize);
impl Work {
    fn spend(&mut self, n: usize) -> Result<(), String> {
        self.0 = self.0.checked_sub(n).ok_or("SCCP work budget exceeded")?;
        Ok(())
    }
}
fn candidate(r: &Region, i: &Instruction) -> bool {
    i.results.len() == 1
        && r.values[i.results[0].index()].ty.bits().is_some()
        && i.state.is_none()
        && i.commit.is_none()
        && !i.trap_after_fault
        && !i.unmasked_word_store
        && matches!(
            i.op,
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
        )
}
fn evaluate(r: &Region, i: &Instruction, values: &[Lattice]) -> Lattice {
    if !candidate(r, i) {
        return Lattice::Overdefined;
    }
    if i.op == Op::Select {
        let yes = values[i.args[1].index()];
        let no = values[i.args[2].index()];
        return match values[i.args[0].index()] {
            Lattice::Constant(n) => {
                if n != 0 {
                    yes
                }
                else {
                    no
                }
            },
            Lattice::Overdefined => yes.join(no),
            Lattice::Unknown if yes == no => yes,
            Lattice::Unknown => Lattice::Unknown,
        };
    }
    let mut args = Vec::with_capacity(i.args.len());
    let mut unknown = false;
    for &value in &i.args {
        match values[value.index()] {
            Lattice::Constant(n) => args.push(n),
            Lattice::Unknown => unknown = true,
            Lattice::Overdefined => return Lattice::Overdefined,
        }
    }
    if unknown {
        return Lattice::Unknown;
    }
    evaluate_integer(r, i, &args).map_or(Lattice::Overdefined, Lattice::Constant)
}

struct Analysis<'a> {
    region: &'a Region,
    values: Vec<Lattice>,
    users: Vec<Vec<usize>>,
    reachable: Vec<bool>,
    edges: Vec<[bool; 2]>,
    queued: Vec<bool>,
    queue: VecDeque<usize>,
    work: Work,
}
impl<'a> Analysis<'a> {
    fn new(region: &'a Region, limit: usize) -> Result<Self, String> {
        let mut work = Work(limit);
        for n in [
            region.values.len(),
            region.instructions.len(),
            region.blocks.len(),
        ] {
            work.spend(n)?;
        }
        let mut users = vec![Vec::new(); region.values.len()];
        for (b, block) in region.blocks.iter().enumerate() {
            work.spend(block.params.len())?;
            for id in &block.instructions {
                let i = &region.instructions[id.index()];
                work.spend(1 + i.args.len() + i.results.len())?;
                for v in &i.args {
                    users[v.index()].push(b);
                }
            }
            let term = block.terminator.as_ref().unwrap();
            if let Terminator::CondBranch { condition, .. } = term {
                work.spend(1)?;
                users[condition.index()].push(b);
            }
            for edge in term.edges() {
                work.spend(1 + edge.args.len())?;
                for v in &edge.args {
                    // Rescan the source when a forwarded edge argument changes.
                    users[v.index()].push(b);
                }
            }
        }
        let mut this = Self {
            region,
            values: vec![Lattice::Unknown; region.values.len()],
            users,
            reachable: vec![false; region.blocks.len()],
            edges: vec![[false; 2]; region.blocks.len()],
            queued: vec![false; region.blocks.len()],
            queue: VecDeque::new(),
            work,
        };
        for entry in &region.entries {
            this.reachable[entry.index()] = true;
            this.enqueue(entry.index());
            // Every externally enterable block is a root, including entries
            // that also have incoming internal edges. Never specialize its ABI.
            for &param in &region.blocks[entry.index()].params {
                this.update(param, Lattice::Overdefined)?;
            }
        }
        Ok(this)
    }
    fn enqueue(&mut self, b: usize) {
        if self.reachable[b] && !self.queued[b] {
            self.queued[b] = true;
            self.queue.push_back(b);
        }
    }
    fn update(&mut self, value: ValueId, incoming: Lattice) -> Result<(), String> {
        self.work.spend(1)?;
        let index = value.index();
        let next = self.values[index].join(incoming);
        if next != self.values[index] {
            self.values[index] = next;
            self.work.spend(self.users[index].len())?;
            for n in 0..self.users[index].len() {
                self.enqueue(self.users[index][n]);
            }
        }
        Ok(())
    }
    fn edge(&mut self, source: usize, slot: usize) -> Result<(), String> {
        let r = self.region;
        let edge = r.blocks[source].terminator.as_ref().unwrap().edges()[slot];
        self.work.spend(1 + edge.args.len())?;
        self.edges[source][slot] = true;
        let target = edge.target.index();
        if !self.reachable[target] {
            self.reachable[target] = true;
            self.enqueue(target);
        }
        // Slots, not (source,target) pairs, distinguish parallel conditional
        // edges carrying different arguments into the same block.
        for (&arg, &param) in edge.args.iter().zip(&r.blocks[target].params) {
            self.update(param, self.values[arg.index()])?;
        }
        Ok(())
    }
    fn block(&mut self, b: usize) -> Result<(), String> {
        let r = self.region;
        self.work.spend(1)?;
        for id in &r.blocks[b].instructions {
            let i = &r.instructions[id.index()];
            self.work.spend(1 + i.args.len() + i.results.len())?;
            let result = evaluate(r, i, &self.values);
            for &v in &i.results {
                self.update(v, result)?;
            }
        }
        match r.blocks[b].terminator.as_ref().unwrap() {
            Terminator::Branch(_) => self.edge(b, 0)?,
            Terminator::CondBranch { condition, .. } => match self.values[condition.index()] {
                Lattice::Constant(n) => self.edge(b, if n != 0 { 0 } else { 1 })?,
                Lattice::Overdefined => {
                    self.edge(b, 0)?;
                    self.edge(b, 1)?;
                },
                Lattice::Unknown => {},
            },
            Terminator::Exit(_) => {},
        }
        Ok(())
    }
    fn solve(&mut self) -> Result<(), String> {
        loop {
            while let Some(b) = self.queue.pop_front() {
                self.queued[b] = false;
                self.block(b)?;
            }
            // An unresolved executable condition is not evidence of dead code.
            // Expand its edges conservatively before accepting a fixed point.
            let mut expanded = false;
            let r = self.region;
            self.work.spend(r.blocks.len())?;
            for (b, block) in r.blocks.iter().enumerate() {
                if !self.reachable[b] {
                    continue;
                }
                if let Some(Terminator::CondBranch { condition, .. }) = &block.terminator {
                    if self.values[condition.index()] == Lattice::Unknown {
                        for slot in 0..2 {
                            if !self.edges[b][slot] {
                                self.edge(b, slot)?;
                                expanded = true;
                            }
                        }
                    }
                }
            }
            if !expanded {
                return Ok(());
            }
        }
    }
}

pub fn run(region: &mut Region, work_limit: usize) -> Result<Stats, String> {
    if crate::ir::debug::audit() {
        verify(region).map_err(|e| e.0)?;
    }
    let mut analysis = Analysis::new(region, work_limit)?;
    analysis.solve()?;
    let mut constants = Vec::new();
    let mut branches = Vec::new();
    let mut stats = Stats::default();
    for (b, block) in region.blocks.iter().enumerate() {
        analysis
            .work
            .spend(1 + block.params.len() + block.instructions.len())?;
        if !analysis.reachable[b] {
            continue;
        }
        for v in &block.params {
            if matches!(analysis.values[v.index()], Lattice::Constant(_)) {
                stats.parameters += 1;
            }
        }
        for &id in &block.instructions {
            let i = &region.instructions[id.index()];
            if candidate(region, i) && !matches!(i.op, Op::Const(_)) {
                if let Lattice::Constant(n) = analysis.values[i.results[0].index()] {
                    constants.push((id, n));
                }
            }
        }
        if let Some(Terminator::CondBranch {
            condition,
            taken,
            not_taken,
        }) = &block.terminator
        {
            if let Lattice::Constant(n) = analysis.values[condition.index()] {
                let edge = if n != 0 { taken } else { not_taken };
                analysis.work.spend(1 + edge.args.len())?;
                branches.push((b, edge.clone()));
            }
        }
    }
    if constants.is_empty() && branches.is_empty() {
        return Ok(stats);
    }
    // Charge the final arena/state traversal before the transactional clone.
    // Verification and CFG compaction also retain their own structural limits.
    for n in [
        region.values.len(),
        region.instructions.len(),
        region.states.len(),
        region.helpers.len(),
    ] {
        analysis.work.spend(n)?;
    }
    for i in &region.instructions {
        analysis.work.spend(i.args.len() + i.results.len())?;
    }
    for state in &region.states {
        analysis.work.spend(state.values().len())?;
    }
    analysis.work.spend(constants.len() + branches.len())?;
    let mut next = region.clone();
    for (id, n) in constants {
        let i = &mut next.instructions[id.index()];
        i.op = Op::Const(n);
        i.args.clear();
        stats.constants += 1;
    }
    for (b, edge) in branches {
        next.blocks[b].terminator = Some(Terminator::Branch(edge));
        stats.branches += 1;
    }
    // Prune before verification: dead predecessor definitions cannot be left
    // behind while installing facts derived only from executable edges.
    let mut cfg = PassStats::default();
    prune::run(&mut next, &mut cfg)?;
    stats.branches += cfg.branches;
    stats.unreachable = cfg.unreachable;
    verify(&next).map_err(|e| e.0)?;
    *region = next;
    Ok(stats)
}

#[cfg(test)]
#[path = "../../../../tests/ir/semantics/sccp.rs"]
mod tests;
