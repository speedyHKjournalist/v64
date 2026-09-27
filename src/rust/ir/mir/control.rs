//! Dispatcher CFG and typed parallel-copy schedules after local allocation.
use crate::ir::{
    backend::locals::Allocation,
    hir::{self, Region},
    ids::{BlockId, InstId, StateId, ValueId},
    lowering::CompileError,
    types::Type,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Local(usize),
    Scratch(usize),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Copy {
    Save { local: usize, scratch: usize },
    Move { source: Source, destination: usize },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edge {
    pub target: BlockId,
    pub scratch: Vec<Type>,
    pub copies: Vec<Copy>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Terminator {
    Jump(Edge),
    Branch {
        condition: usize,
        taken: Edge,
        not_taken: Edge,
    },
    Exit(StateId),
}
impl Terminator {
    pub fn edges(&self) -> Vec<&Edge> {
        match self {
            Self::Jump(edge) => vec![edge],
            Self::Branch {
                taken, not_taken, ..
            } => vec![taken, not_taken],
            Self::Exit(_) => vec![],
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub params: Vec<usize>,
    pub instructions: Vec<InstId>,
    pub recovery: Option<StateId>,
    /// Dispatcher work units, distinct from committed guest instructions.
    pub budget_cost: u32,
    pub terminator: Terminator,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlFlow {
    pub entries: Vec<BlockId>,
    pub blocks: Vec<Block>,
    /// Every live recovery/observer count has an SSA base, including cycle exits.
    pub dynamic_counts: bool,
    pub polls: Vec<Option<Poll>>,
    /// Page functions poll the execution budget only at loop headers (every
    /// cycle contains one); acyclic paths between them are bounded by the
    /// page. Instruction counts remain exact through the SSA count bases.
    pub sparse_polls: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Poll {
    pub recovery: StateId,
    pub cost: u32,
}
fn invalid() -> CompileError { CompileError::InvalidIr("invalid lowered control flow".into()) }

/// Resolve simultaneous local assignments. Sinks are safe to write immediately;
/// a cycle saves one source and redirects every use of that old source to scratch.
pub(crate) fn schedule(
    target: BlockId,
    pairs: &[(usize, usize)],
    types: &[Type],
) -> Result<Edge, CompileError> {
    let mut pending = Vec::new();
    let mut uses = vec![0usize; types.len()];
    let mut destinations = std::collections::BTreeSet::new();
    for &(source, destination) in pairs {
        let ty = types.get(source).ok_or_else(invalid)?;
        if Some(ty) != types.get(destination)
            || *ty == Type::Effect
            || !destinations.insert(destination)
        {
            return Err(invalid());
        }
        if source != destination {
            pending.push((Source::Local(source), destination));
            uses[source] += 1;
        }
    }
    let mut edge = Edge {
        target,
        scratch: vec![],
        copies: vec![],
    };
    while !pending.is_empty() {
        if let Some(index) = pending
            .iter()
            .position(|&(_, destination)| uses[destination] == 0)
        {
            let (source, destination) = pending.remove(index);
            if let Source::Local(local) = source {
                uses[local] -= 1;
            }
            edge.copies.push(Copy::Move {
                source,
                destination,
            });
        }
        else {
            // No sink: every remaining destination supplies another assignment.
            let Source::Local(local) = pending[0].0
            else {
                return Err(invalid());
            };
            let scratch = edge.scratch.len();
            edge.scratch.push(types[local]);
            edge.copies.push(Copy::Save { local, scratch });
            uses[local] = 0;
            for (source, _) in &mut pending {
                if *source == Source::Local(local) {
                    *source = Source::Scratch(scratch);
                }
            }
        }
    }
    Ok(edge)
}

pub fn lower(region: &Region, allocation: &Allocation) -> Result<ControlFlow, CompileError> {
    lower_with(region, allocation, false)
}
/// Longest sum of block budgets from each block to the next loop header or
/// exit. Non-header edges form an acyclic graph (every cycle has a header);
/// None if they do not. Shared by HIR sparse stripping and MIR lowering.
pub(crate) fn longest_guest_paths(
    n: usize,
    headers: &[bool],
    successors: impl Fn(usize) -> Vec<usize>,
    budget: impl Fn(usize) -> u32,
) -> Option<Vec<u32>> {
    let mut longest = vec![0u32; n];
    let mut state = vec![0u8; n]; // 0 new, 1 on stack, 2 done
    for root in 0..n {
        if state[root] != 0 {
            continue;
        }
        let mut stack = vec![(root, 0usize, successors(root))];
        state[root] = 1;
        while let Some((b, next, edges)) = stack.last_mut() {
            if let Some(&t) = edges.get(*next) {
                *next += 1;
                if headers[t] || state[t] == 2 {
                    continue;
                }
                if state[t] == 1 {
                    return None;
                }
                state[t] = 1;
                stack.push((t, 0, successors(t)));
            }
            else {
                let b = *b;
                let tail = edges
                    .iter()
                    .filter(|&&t| !headers[t])
                    .map(|&t| longest[t])
                    .max()
                    .unwrap_or(0);
                longest[b] = budget(b).saturating_add(tail);
                state[b] = 2;
                stack.pop();
            }
        }
    }
    Some(longest)
}
/// Blocks where sparse accounting charges an entry path: the first weighted
/// non-header block on each path from an entry through weightless blocks.
pub(crate) fn entry_frontier(
    entries: &[BlockId],
    n: usize,
    headers: &[bool],
    successors: impl Fn(usize) -> Vec<usize>,
    weight: impl Fn(usize) -> u32,
) -> Vec<bool> {
    let mut frontier = vec![false; n];
    let mut seen = vec![false; n];
    let mut queue: Vec<usize> = entries.iter().map(|e| e.index()).collect();
    while let Some(b) = queue.pop() {
        if std::mem::replace(&mut seen[b], true) || headers[b] {
            continue;
        }
        if weight(b) != 0 {
            frontier[b] = true;
        }
        else {
            queue.extend(successors(b));
        }
    }
    frontier
}
fn hir_successors(region: &Region, b: usize) -> Vec<usize> {
    region.blocks[b]
        .terminator
        .as_ref()
        .map(|t| t.edges().iter().map(|e| e.target.index()).collect())
        .unwrap_or_default()
}
/// Targets of depth-first back edges from every entry: each cycle has one.
/// HIR sparse-poll stripping and MIR lowering share this exact traversal (the
/// two graphs have the same blocks and edge order), so they agree on headers.
pub(crate) fn back_edge_targets(
    entries: &[BlockId],
    n: usize,
    successors: impl Fn(usize) -> Vec<usize>,
) -> Vec<bool> {
    let mut headers = vec![false; n];
    let mut state = vec![0u8; n]; // 0 new, 1 on stack, 2 done
    for entry in entries {
        if state[entry.index()] != 0 {
            continue;
        }
        let mut stack = vec![(entry.index(), 0usize, successors(entry.index()))];
        state[entry.index()] = 1;
        while let Some((b, next, edges)) = stack.last_mut() {
            if let Some(&t) = edges.get(*next) {
                *next += 1;
                match state[t] {
                    0 => {
                        state[t] = 1;
                        stack.push((t, 0, successors(t)));
                    },
                    1 => headers[t] = true,
                    _ => {},
                }
            }
            else {
                state[*b] = 2;
                stack.pop();
            }
        }
    }
    headers
}
fn loop_headers(entries: &[BlockId], blocks: &[Block]) -> Vec<bool> {
    back_edge_targets(entries, blocks.len(), |b| {
        blocks[b].terminator.edges().iter().map(|e| e.target.index()).collect()
    })
}
pub fn lower_with(
    region: &Region,
    allocation: &Allocation,
    sparse_polls: bool,
) -> Result<ControlFlow, CompileError> {
    let local = |value: ValueId| -> Result<usize, CompileError> {
        let slot = allocation
            .value_local
            .get(value.index())
            .copied()
            .flatten()
            .ok_or_else(invalid)?;
        if allocation.local_types.get(slot) != region.values.get(value.index()).map(|v| &v.ty) {
            return Err(invalid());
        }
        Ok(slot)
    };
    let edge = |edge: &hir::Edge| -> Result<Edge, CompileError> {
        let params = &region
            .blocks
            .get(edge.target.index())
            .ok_or_else(invalid)?
            .params;
        if params.len() != edge.args.len() {
            return Err(invalid());
        }
        let pairs = edge
            .args
            .iter()
            .zip(params)
            .filter(|(_, param)| region.values[param.index()].ty != Type::Effect)
            .map(|(&arg, &param)| Ok((local(arg)?, local(param)?)))
            .collect::<Result<Vec<_>, CompileError>>()?;
        schedule(edge.target, &pairs, &allocation.local_types)
    };
    let mut blocks = region
        .blocks
        .iter()
        .map(|block| {
            let terminator = match block.terminator.as_ref().ok_or_else(invalid)? {
                hir::Terminator::Exit(state) => Terminator::Exit(*state),
                hir::Terminator::Branch(next) => Terminator::Jump(edge(next)?),
                hir::Terminator::CondBranch {
                    condition,
                    taken,
                    not_taken,
                } => Terminator::Branch {
                    condition: local(*condition)?,
                    taken: edge(taken)?,
                    not_taken: edge(not_taken)?,
                },
            };
            Ok(Block {
                params: block
                    .params
                    .iter()
                    .filter(|v| region.values[v.index()].ty != Type::Effect)
                    .map(|&v| local(v))
                    .collect::<Result<Vec<_>, _>>()?,
                instructions: block.instructions.clone(),
                recovery: block.entry_state,
                budget_cost: 1,
                terminator,
            })
        })
        .collect::<Result<Vec<_>, CompileError>>()?;
    let mut states = std::collections::BTreeSet::new();
    for block in &region.blocks {
        states.extend(block.entry_state);
        if let Some(hir::Terminator::Exit(state)) = block.terminator {
            states.insert(state);
        }
        for id in &block.instructions {
            let inst = &region.instructions[id.index()];
            states.extend(inst.state);
            states.extend(inst.commit);
        }
    }
    let dynamic_counts = !states.is_empty()
        && states
            .iter()
            .all(|id| region.states[id.index()].count_base.is_some());
    let cold = cold_dispatch(&region.entries, &blocks)?;
    let headers = if sparse_polls {
        loop_headers(&region.entries, &blocks)
    }
    else {
        vec![true; blocks.len()]
    };
    // Sparse accounting charges each poll point (loop header or entry
    // frontier block) with the longest weighted path through unpolled blocks,
    // so an activation never retires more than its budget. Page functions
    // record no weights and keep one credit per header.
    let n = region.blocks.len();
    let (longest, frontier) = if sparse_polls {
        let weight = |b: usize| region.blocks[b].budget;
        (
            longest_guest_paths(n, &headers, |b| hir_successors(region, b), weight)
                .ok_or_else(invalid)?,
            entry_frontier(&region.entries, n, &headers, |b| hir_successors(region, b), weight),
        )
    }
    else {
        (vec![], vec![])
    };
    for (index, block) in blocks.iter_mut().enumerate() {
        // A frontier block with a recovery map is checked at its start; one
        // without (an entry) keeps its first PollBudget as the check.
        let polled = headers[index]
            || sparse_polls && frontier[index] && region.blocks[index].entry_state.is_some();
        if cold[index] || !polled {
            block.budget_cost = 0;
        }
        else if sparse_polls {
            block.budget_cost = longest[index].max(1);
        }
    }
    // A poll retained by sparse stripping precedes every guest instruction of
    // its (recovery-free frontier) block and charges its longest path.
    let mut poll_cost = vec![1u32; region.instructions.len()];
    if sparse_polls {
        for (b, block) in region.blocks.iter().enumerate() {
            for id in &block.instructions {
                poll_cost[id.index()] = longest[b].max(1);
            }
        }
    }
    Ok(ControlFlow {
        entries: region.entries.clone(),
        blocks,
        dynamic_counts,
        sparse_polls,
        polls: region
            .instructions
            .iter()
            .enumerate()
            .map(|(id, inst)| {
                if inst.op == hir::Op::PollBudget {
                    Some(Poll {
                        recovery: inst.state.unwrap(),
                        cost: poll_cost[id],
                    })
                }
                else {
                    None
                }
            })
            .collect(),
    })
}

pub fn verify(
    region: &Region,
    allocation: &Allocation,
    graph: &ControlFlow,
) -> Result<(), CompileError> {
    if lower_with(region, allocation, graph.sparse_polls)? != *graph {
        return Err(invalid());
    }
    Ok(())
}
/// Empty, recovery-free blocks may only extend an acyclic cold prologue.
/// Require every predecessor to be an entry or an already certified dispatcher;
/// an ordinary guest edge, an orphan, and a recovery-free cycle all fail closed.
/// The proof uses machine CFG data and is repeated after machine optimization.
fn cold_dispatch(entries: &[BlockId], blocks: &[Block]) -> Result<Vec<bool>, CompileError> {
    let mut incoming = vec![Vec::new(); blocks.len()];
    for (index, block) in blocks.iter().enumerate() {
        for edge in block.terminator.edges() {
            incoming
                .get_mut(edge.target.index())
                .ok_or_else(invalid)?
                .push(index);
        }
    }
    let mut admitted = vec![false; blocks.len()];
    for entry in entries {
        if !incoming.get(entry.index()).ok_or_else(invalid)?.is_empty() {
            return Err(invalid());
        }
        *admitted.get_mut(entry.index()).ok_or_else(invalid)? = true;
    }
    let mut cold = vec![false; blocks.len()];
    loop {
        let mut changed = false;
        for (index, block) in blocks.iter().enumerate() {
            if !admitted[index]
                && block.recovery.is_none()
                && block.instructions.is_empty()
                && block.params.is_empty()
                && !block.terminator.edges().is_empty()
                && !incoming[index].is_empty()
                && incoming[index].iter().all(|&from| admitted[from])
            {
                admitted[index] = true;
                cold[index] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    Ok(cold)
}
impl ControlFlow {
    pub(super) fn cold_dispatch(&self) -> Result<Vec<bool>, CompileError> {
        cold_dispatch(&self.entries, &self.blocks)
    }
    /// Target restrictions use the lowered graph, not HIR control-flow policy.
    pub fn check_target(&self, cpu: bool) -> Result<(), CompileError> {
        let mut degrees = vec![0usize; self.blocks.len()];
        for block in &self.blocks {
            for edge in block.terminator.edges() {
                *degrees.get_mut(edge.target.index()).ok_or_else(invalid)? += 1;
            }
        }
        let cold = self.cold_dispatch()?;
        if self.sparse_polls {
            // Unpolled blocks must form an acyclic subgraph: every cycle
            // passes a loop-header poll, so each activation stays bounded.
            let mut indegree = vec![0usize; self.blocks.len()];
            for block in self.blocks.iter().filter(|b| b.budget_cost == 0) {
                for edge in block.terminator.edges() {
                    if self.blocks[edge.target.index()].budget_cost == 0 {
                        indegree[edge.target.index()] += 1;
                    }
                }
            }
            let mut queue: Vec<_> = (0..self.blocks.len())
                .filter(|&b| self.blocks[b].budget_cost == 0 && indegree[b] == 0)
                .collect();
            let mut seen = 0;
            while let Some(b) = queue.pop() {
                seen += 1;
                for edge in self.blocks[b].terminator.edges() {
                    let t = edge.target.index();
                    if self.blocks[t].budget_cost == 0 {
                        indegree[t] -= 1;
                        if indegree[t] == 0 {
                            queue.push(t);
                        }
                    }
                }
            }
            if seen != self.blocks.iter().filter(|b| b.budget_cost == 0).count() {
                return Err(invalid());
            }
        }
        for (index, block) in self.blocks.iter().enumerate() {
            if !self.sparse_polls && block.budget_cost != if cold[index] { 0 } else { 1 }
                || cold[index] && block.budget_cost != 0
            {
                return Err(invalid());
            }
            if self.entries.contains(&BlockId(index as u32)) {
                if degrees[index] != 0 || !block.params.is_empty() {
                    return Err(CompileError::Unsupported(
                        "entry prologue with internal predecessors/parameters",
                    ));
                }
            }
            else if block.recovery.is_none() && !cold[index] {
                return Err(CompileError::Unsupported(
                    "block budget recovery map missing",
                ));
            }
        }
        if cpu && !self.dynamic_counts {
            // Static recovery counts are valid only for the current acyclic CPU frontend.
            let mut queue: Vec<_> = degrees
                .iter()
                .enumerate()
                .filter(|(_, n)| **n == 0)
                .map(|(b, _)| b)
                .collect();
            let mut visited = 0;
            while let Some(b) = queue.pop() {
                visited += 1;
                for edge in self.blocks[b].terminator.edges() {
                    degrees[edge.target.index()] -= 1;
                    if degrees[edge.target.index()] == 0 {
                        queue.push(edge.target.index());
                    }
                }
            }
            if visited != self.blocks.len() {
                return Err(CompileError::Unsupported(
                    "CPU loop commit accounting pending",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod cold_dispatch_tests {
    use super::*;
    fn edge(target: u32) -> Edge {
        Edge {
            target: BlockId(target),
            scratch: vec![],
            copies: vec![],
        }
    }
    #[test]
    fn only_bounded_cold_scaffolding_can_have_zero_budget_cost() {
        let entry = Block {
            params: vec![],
            instructions: vec![InstId(0)],
            recovery: None,
            budget_cost: 1,
            terminator: Terminator::Jump(edge(1)),
        };
        let cold = Block {
            params: vec![],
            instructions: vec![],
            recovery: None,
            budget_cost: 0,
            terminator: Terminator::Jump(edge(2)),
        };
        let guest = Block {
            params: vec![],
            instructions: vec![InstId(1)],
            recovery: Some(StateId(0)),
            budget_cost: 1,
            terminator: Terminator::Exit(StateId(0)),
        };
        let graph = ControlFlow {
            entries: vec![BlockId(0)],
            blocks: vec![entry, cold, guest],
            dynamic_counts: true,
            polls: vec![],
            sparse_polls: false,
        };
        assert_eq!(graph.cold_dispatch().unwrap(), vec![false, true, false]);
        graph.check_target(true).unwrap();
        for variant in 0..5 {
            let mut invalid = graph.clone();
            match variant {
                0 => invalid.blocks[1].instructions.push(InstId(2)),
                1 => invalid.blocks[1].params.push(0),
                2 => invalid.blocks[1].terminator = Terminator::Jump(edge(1)),
                3 => invalid.blocks[2].terminator = Terminator::Jump(edge(1)),
                _ => invalid.blocks[0].terminator = Terminator::Jump(edge(2)),
            }
            assert!(
                invalid.check_target(true).is_err(),
                "variant {variant} must pay normal budget and provide recovery"
            );
        }
    }
}
