//! Owned use/definition facts for allocation after machine rewrites.
//! Recovery uses are conservative for both CPU and standalone ABIs.
use super::{control, value::Step, MirData};
use crate::ir::{
    backend::locals::{Allocation, Interference, LiveBits, LiveValues},
    hir,
    ids::*,
    lowering::CompileError,
    types::Type,
};
use std::collections::BTreeSet;
#[derive(Clone, Debug, PartialEq, Eq)]
struct Instruction {
    ordered: bool,
    uses: Vec<ValueId>,
    recovery: Vec<ValueId>,
    definitions: Vec<ValueId>,
    before: Option<StateId>,
    after: Option<StateId>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Edge {
    target: BlockId,
    arguments: Vec<ValueId>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Terminator {
    Exit(StateId),
    Jump(Edge),
    Branch(ValueId, Edge, Edge),
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Block {
    params: Vec<ValueId>,
    instructions: Vec<InstId>,
    recovery: Vec<ValueId>,
    recovery_id: Option<StateId>,
    exit_uses: Vec<ValueId>,
    terminator: Terminator,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Graph {
    instructions: Vec<Instruction>,
    blocks: Vec<Block>,
    entries: Vec<BlockId>,
}
fn state(region: &hir::Region, id: Option<StateId>) -> Vec<ValueId> {
    id.map(|s| region.states[s.index()].values())
        .unwrap_or_default()
}
pub fn capture(region: &hir::Region) -> Graph {
    let edge = |e: &hir::Edge| Edge {
        target: e.target,
        arguments: e.args.clone(),
    };
    Graph {
        entries: region.entries.clone(),
        instructions: region
            .instructions
            .iter()
            .map(|i| Instruction {
                ordered: i.op.ordered(),
                uses: i.args.clone(),
                recovery: state(region, i.state)
                    .into_iter()
                    .chain(state(region, i.commit))
                    .collect(),
                definitions: i.results.clone(),
                before: i.state,
                after: i.commit,
            })
            .collect(),
        blocks: region
            .blocks
            .iter()
            .map(|b| {
                let t = b.terminator.as_ref().unwrap();
                Block {
                    params: b.params.clone(),
                    instructions: b.instructions.clone(),
                    recovery: state(region, b.entry_state),
                    recovery_id: b.entry_state,
                    exit_uses: if let hir::Terminator::Exit(s) = t {
                        state(region, Some(*s))
                    }
                    else {
                        vec![]
                    },
                    terminator: match t {
                        hir::Terminator::Exit(s) => Terminator::Exit(*s),
                        hir::Terminator::Branch(e) => Terminator::Jump(edge(e)),
                        hir::Terminator::CondBranch {
                            condition,
                            taken,
                            not_taken,
                        } => Terminator::Branch(*condition, edge(taken), edge(not_taken)),
                    },
                }
            })
            .collect(),
    }
}
fn spend(left: &mut usize, n: usize) -> Result<(), CompileError> {
    *left = left
        .checked_sub(n)
        .ok_or(CompileError::Budget("machine allocation/scheduling work"))?;
    Ok(())
}
pub(super) fn expression(steps: &[Step]) -> Vec<ValueId> {
    let mut values = Vec::new();
    for step in steps {
        match step {
            Step::Value(v) => values.push(*v),
            Step::Packed {
                destination,
                source,
                ..
            } => values.extend([*destination, *source]),
            _ => (),
        }
    }
    values
}
fn uses(data: &MirData, id: InstId) -> Vec<ValueId> {
    if data.stack_elided[id.index()] {
        return vec![];
    }
    let i = &data.allocation_graph.instructions[id.index()];
    let mut out =
        if let Some(p) = &data.values[id.index()] { expression(&p.steps) } else { i.uses.clone() };
    out.extend(&i.recovery);
    out
}
fn edges(t: &Terminator) -> Vec<&Edge> {
    match t {
        Terminator::Exit(_) => vec![],
        Terminator::Jump(e) => vec![e],
        Terminator::Branch(_, a, b) => vec![a, b],
    }
}
fn term_uses(b: &Block) -> Vec<ValueId> {
    let mut out = b.exit_uses.clone();
    if let Terminator::Branch(v, _, _) = b.terminator {
        out.push(v);
    }
    for edge in edges(&b.terminator) {
        out.extend(&edge.arguments);
    }
    out
}
pub(super) fn use_counts(data: &MirData, limit: &mut usize) -> Result<Vec<usize>, CompileError> {
    let mut counts = vec![0; data.value_types.len()];
    for b in &data.allocation_graph.blocks {
        let mut values = term_uses(b);
        values.extend(&b.recovery);
        for &i in &b.instructions {
            values.extend(uses(data, i));
        }
        spend(limit, values.len() + 1)?;
        for v in values {
            counts[v.index()] += 1;
        }
    }
    Ok(counts)
}
pub(super) fn blocks(data: &MirData) -> Vec<Vec<InstId>> {
    data.allocation_graph
        .blocks
        .iter()
        .map(|b| b.instructions.clone())
        .collect()
}
pub fn reallocate(data: &mut MirData, work_limit: usize) -> Result<usize, CompileError> {
    reallocate_with::<LiveBits>(data, work_limit)
}
fn reallocate_with<S: LiveValues>(
    data: &mut MirData,
    work_limit: usize,
) -> Result<usize, CompileError> {
    let graph = &data.allocation_graph;
    let mut left = work_limit;
    spend(
        &mut left,
        data.value_types.len() + graph.instructions.len() + graph.blocks.len(),
    )?;
    let empty = S::new(data.value_types.len());
    spend(
        &mut left,
        empty.scan_words().saturating_mul(2 * graph.blocks.len() + 1),
    )?;
    let mut inputs = vec![empty; graph.blocks.len()];
    let mut outputs = inputs.clone();
    let dependencies: Vec<_> = (0..graph.instructions.len())
        .map(|n| uses(data, InstId(n as u32)))
        .collect();
    loop {
        let mut changed = false;
        for (n, b) in graph.blocks.iter().enumerate().rev() {
            let mut live = S::new(data.value_types.len());
            // Initialize live, clone output and compare the final input. Dense
            // sets scan their empty words too, including sparse high SSA IDs.
            spend(&mut left, live.scan_words().saturating_mul(3))?;
            live.extend(term_uses(b));
            for edge in edges(&b.terminator) {
                let target = &graph.blocks[edge.target.index()];
                let incoming = &inputs[edge.target.index()];
                // Vec::contains may compare every target parameter for each
                // incoming value. Charge before filtering, including values
                // removed by the edge; the resulting live set can be tiny.
                spend(
                    &mut left,
                    incoming.len()
                        .saturating_mul(target.params.len().saturating_add(1))
                        .saturating_add(incoming.scan_words()),
                )?;
                live.extend(
                    incoming.values().filter(|v| !target.params.contains(v)),
                );
            }
            spend(&mut left, live.len() + 1)?;
            outputs[n] = live.clone();
            for &id in b.instructions.iter().rev() {
                if data.stack_elided[id.index()] {
                    continue;
                }
                for v in &graph.instructions[id.index()].definitions {
                    live.remove(v);
                }
                live.extend(dependencies[id.index()].iter().copied());
                spend(&mut left, live.len() + 1)?;
            }
            live.extend(b.recovery.iter().copied());
            if inputs[n] != live {
                inputs[n] = live;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut interference = Interference::new(data.value_types.len());
    let mut connect = |live: &S, left: &mut usize| -> Result<(), CompileError> {
        spend(
            left,
            interference.connection_work_iter(live.values(), live.len(), live.scan_words()),
        )?;
        interference.connect_iter(live.values(), |v| data.value_types[v.index()]);
        Ok(())
    };
    let mut active = S::new(data.value_types.len());
    spend(&mut left, active.scan_words().saturating_mul(2))?;
    for (n, b) in graph.blocks.iter().enumerate() {
        spend(&mut left, outputs[n].scan_words().saturating_mul(2))?;
        let mut live = outputs[n].clone();
        connect(&live, &mut left)?;
        active.extend(live.values());
        for &id in b.instructions.iter().rev() {
            if data.stack_elided[id.index()] {
                continue;
            }
            let defs = &graph.instructions[id.index()].definitions;
            live.extend(defs.iter().copied());
            active.extend(defs.iter().copied());
            connect(&live, &mut left)?;
            for v in defs {
                live.remove(v);
            }
            live.extend(dependencies[id.index()].iter().copied());
            spend(&mut left, live.scan_words())?;
            active.extend(live.values());
            connect(&live, &mut left)?;
        }
        live.extend(b.recovery.iter().copied());
        live.extend(b.params.iter().copied());
        spend(&mut left, live.scan_words())?;
        active.extend(live.values());
        connect(&live, &mut left)?;
    }
    let mut allocation = Allocation {
        value_local: vec![None; data.value_types.len()],
        local_types: vec![],
    };
    for v in active.values() {
        let ty = data.value_types[v.index()];
        if ty == Type::Effect {
            continue;
        }
        let occupied = interference.occupied(v.index(), &allocation);
        let slot = allocation
            .local_types
            .iter()
            .enumerate()
            .find(|(n, t)| **t == ty && !occupied[*n])
            .map(|(n, _)| n)
            .unwrap_or_else(|| {
                let n = allocation.local_types.len();
                allocation.local_types.push(ty);
                n
            });
        allocation.value_local[v.index()] = Some(slot);
    }
    let local = |v: ValueId| {
        allocation.value_local[v.index()]
            .ok_or_else(|| CompileError::InvalidIr("missing machine local".into()))
    };
    let edge = |e: &Edge| -> Result<control::Edge, CompileError> {
        let pairs = e
            .arguments
            .iter()
            .zip(&graph.blocks[e.target.index()].params)
            .filter(|(_, v)| data.value_types[v.index()] != Type::Effect)
            .map(|(&a, &b)| Ok((local(a)?, local(b)?)))
            .collect::<Result<Vec<_>, CompileError>>()?;
        control::schedule(e.target, &pairs, &allocation.local_types)
    };
    let mut control = data.control.clone();
    for (b, source) in control.blocks.iter_mut().zip(&graph.blocks) {
        b.params = source
            .params
            .iter()
            .filter(|v| data.value_types[v.index()] != Type::Effect)
            .map(|&v| local(v))
            .collect::<Result<_, _>>()?;
        b.terminator = match &source.terminator {
            Terminator::Exit(s) => control::Terminator::Exit(*s),
            Terminator::Jump(e) => control::Terminator::Jump(edge(e)?),
            Terminator::Branch(v, a, b) => control::Terminator::Branch {
                condition: local(*v)?,
                taken: edge(a)?,
                not_taken: edge(b)?,
            },
        };
    }
    let saved = data
        .allocation
        .local_types
        .len()
        .saturating_sub(allocation.local_types.len());
    data.allocation = allocation;
    data.control = control;
    Ok(saved)
}

/// Validate the owned graph after HIR has been destroyed. In particular, a
/// well-typed Wasm expression is insufficient: its SSA inputs must dominate it
/// and simultaneously live values must not alias an allocated local.
pub(super) fn verify(data: &MirData, work_limit: usize) -> Result<(), CompileError> {
    use super::materialize::Store;
    use crate::wasmgen::wasm_builder::WasmType;
    let invalid = || CompileError::InvalidIr("invalid owned MIR graph".into());
    let require = |ok| if ok { Ok(()) } else { Err(invalid()) };
    let graph = &data.allocation_graph;
    let n = graph.blocks.len();
    let ni = graph.instructions.len();
    let nv = data.value_types.len();
    let mut left = work_limit;
    spend(&mut left, n.saturating_mul(n) + ni + nv)?;
    require(n > 0 && !graph.entries.is_empty() && data.control.entries == graph.entries)?;
    require(
        data.control.blocks.len() == n
            && data.control.polls.len() == ni
            && data.values.len() == ni
            && data.memory.len() == ni
            && data.effects.len() == ni
            && data.calls.len() == ni
            && data.stack_elided.len() == ni
            && data.value_blocks.len() == nv
            && data.value_definitions.len() == nv
            && data.allocation.value_local.len() == nv,
    )?;
    let ty = |v: ValueId| data.value_types.get(v.index()).copied().ok_or_else(invalid);
    let local = |v: ValueId| -> Result<usize, CompileError> {
        let t = ty(v)?;
        let slot = data
            .allocation
            .value_local
            .get(v.index())
            .copied()
            .flatten()
            .ok_or_else(invalid)?;
        require(t != Type::Effect && data.allocation.local_types.get(slot) == Some(&t))?;
        Ok(slot)
    };
    for (v, slot) in data.allocation.value_local.iter().enumerate() {
        if slot.is_some() {
            local(ValueId(v as u32))?;
        }
    }
    let mut owners = vec![None; nv];
    let mut positions = vec![None; ni];
    let mut produced = vec![false; nv];
    let mut predecessors = vec![vec![]; n];
    let mut entries = vec![false; n];
    for e in &graph.entries {
        let is_entry = entries.get_mut(e.index()).ok_or_else(invalid)?;
        require(!*is_entry)?;
        *is_entry = true;
    }
    let cold_dispatch = data.control.cold_dispatch()?;
    for (b, block) in graph.blocks.iter().enumerate() {
        let control = &data.control.blocks[b];
        require(
            control.instructions == block.instructions
                && control.recovery == block.recovery_id
                && (control.budget_cost == if cold_dispatch[b] { 0 } else { 1 }
                    || data.control.sparse_polls
                        && (control.budget_cost == 0 || !cold_dispatch[b])),
        )?;
        for &v in &block.params {
            require(ty(v)? != Type::RmwTicket)?;
            produced[v.index()] = true;
            require(
                owners[v.index()].replace((b, None)).is_none()
                    && data.value_blocks[v.index()] == Some(BlockId(b as u32))
                    && data.value_definitions[v.index()].is_none(),
            )?;
        }
        let params = block
            .params
            .iter()
            .filter(|v| data.value_types[v.index()] != Type::Effect)
            .map(|&v| local(v))
            .collect::<Result<Vec<_>, _>>()?;
        require(control.params == params)?;
        for (p, &id) in block.instructions.iter().enumerate() {
            let inst = graph.instructions.get(id.index()).ok_or_else(invalid)?;
            require(positions[id.index()].replace((b, p)).is_none())?;
            let machine_effects = usize::from(data.memory[id.index()].is_some())
                + usize::from(data.effects[id.index()].is_some())
                + usize::from(data.calls[id.index()].is_some())
                + usize::from(data.control.polls[id.index()].is_some());
            require(if inst.ordered {
                machine_effects == 1 && data.values[id.index()].is_none()
            }
            else {
                machine_effects == 0
            })?;
            let (_, mut outputs, _) = plan_references(data, id);
            if let Some(value) = &data.values[id.index()] {
                outputs.push(value.result);
            }
            for output in outputs {
                ty(output)?;
                produced[output.index()] = true;
            }

            for &v in &inst.definitions {
                ty(v)?;
                require(
                    owners[v.index()].replace((b, Some(p))).is_none()
                        && data.value_blocks[v.index()] == Some(BlockId(b as u32))
                        && data.value_definitions[v.index()] == Some(id),
                )?;
            }
        }
        let edge = |e: &Edge| -> Result<control::Edge, CompileError> {
            let target = graph.blocks.get(e.target.index()).ok_or_else(invalid)?;
            require(e.arguments.len() == target.params.len())?;
            let mut pairs = vec![];
            for (&a, &p) in e.arguments.iter().zip(&target.params) {
                require(ty(a)? == ty(p)?)?;
                if ty(a)? != Type::Effect {
                    pairs.push((local(a)?, local(p)?));
                }
            }
            control::schedule(e.target, &pairs, &data.allocation.local_types)
        };
        let expected = match &block.terminator {
            Terminator::Exit(s) => {
                require(s.index() < data.states.len())?;
                control::Terminator::Exit(*s)
            },
            Terminator::Jump(e) => control::Terminator::Jump(edge(e)?),
            Terminator::Branch(v, a, b) => {
                require(ty(*v)? == Type::I1)?;
                control::Terminator::Branch {
                    condition: local(*v)?,
                    taken: edge(a)?,
                    not_taken: edge(b)?,
                }
            },
        };
        require(control.terminator == expected)?;
        for e in edges(&block.terminator) {
            predecessors[e.target.index()].push(b);
        }
    }
    let mut reachable = entries.clone();
    let mut pending = graph.entries.clone();
    while let Some(b) = pending.pop() {
        for e in edges(&graph.blocks[b.index()].terminator) {
            if !reachable[e.target.index()] {
                reachable[e.target.index()] = true;
                pending.push(e.target);
            }
        }
    }
    require(reachable.iter().all(|&r| r))?;
    let mut dom = vec![vec![true; n]; n];
    for b in 0..n {
        if entries[b] {
            dom[b].fill(false);
            dom[b][b] = true;
        }
    }
    loop {
        let mut changed = false;
        for b in 0..n {
            if entries[b] {
                continue;
            }
            spend(&mut left, n.saturating_mul(predecessors[b].len() + 1))?;
            let mut next = vec![true; n];
            for &p in &predecessors[b] {
                for v in 0..n {
                    next[v] &= dom[p][v];
                }
            }
            next[b] = true;
            if next != dom[b] {
                dom[b] = next;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let available = |v: ValueId, b: usize, p: usize| -> Result<(), CompileError> {
        let (owner, at) = owners
            .get(v.index())
            .copied()
            .flatten()
            .ok_or_else(invalid)?;
        require(dom[b][owner] && (owner != b || at.is_none_or(|at| at < p)))?;
        if let Some(id) = data.value_definitions[v.index()] {
            require(!data.stack_elided[id.index()])?;
        }
        if ty(v)? != Type::Effect {
            require(produced[v.index()])?;
            local(v)?;
        }
        Ok(())
    };
    let state_values = |id: StateId| -> Result<Vec<ValueId>, CompileError> {
        let state = data.states.get(id.index()).ok_or_else(invalid)?;
        let mut values = vec![];
        for materialization in [&state.cpu, &state.standalone] {
            for w in &materialization.writes {
                super::value::verify_expression_types(
                    &data.value_types,
                    &w.expression,
                    if w.store == Store::I32 { WasmType::I32 } else { WasmType::V128 },
                )?;
                values.extend(expression(&w.expression));
            }
            if let Some(v) = materialization.count.base {
                require(ty(v)? == Type::I32)?;
                values.push(v);
            }
        }
        super::value::verify_expression_types(
            &data.value_types,
            &state.decoded_next.expression,
            WasmType::I32,
        )?;
        values.extend(expression(&state.decoded_next.expression));
        Ok(values)
    };
    let mut materialized_values = Vec::with_capacity(data.states.len());
    for (i, state) in data.states.iter().enumerate() {
        spend(
            &mut left,
            state
                .cpu
                .writes
                .iter()
                .chain(&state.standalone.writes)
                .map(|w| w.expression.len() + 1)
                .sum::<usize>()
                + state.decoded_next.expression.len()
                + 1,
        )?;
        materialized_values.push(state_values(StateId(i as u32))?);
    }
    let check_state = |id: StateId, b, p| -> Result<(), CompileError> {
        for &v in materialized_values.get(id.index()).ok_or_else(invalid)? {
            available(v, b, p)?;
        }
        Ok(())
    };
    for (b, block) in graph.blocks.iter().enumerate() {
        if let Some(s) = block.recovery_id {
            check_state(s, b, 0)?;
        }
        let roots: Vec<_> = block
            .params
            .iter()
            .copied()
            .filter(|v| data.value_types[v.index()] == Type::Effect)
            .collect();
        require(roots.len() <= 1)?;
        let mut effect = roots.first().copied();
        let mut pending_rmw = None;
        for (p, &id) in block.instructions.iter().enumerate() {
            let inst = &graph.instructions[id.index()];
            if data.stack_elided[id.index()] {
                require(
                    data.values[id.index()].is_some()
                        && data.memory[id.index()].is_none()
                        && data.effects[id.index()].is_none()
                        && data.calls[id.index()].is_none()
                        && inst.before.is_none()
                        && inst.after.is_none(),
                )?;
                continue;
            }
            let input_effects: Vec<_> = inst
                .uses
                .iter()
                .copied()
                .filter(|v| ty(*v) == Ok(Type::Effect))
                .collect();
            let output_effects: Vec<_> = inst
                .definitions
                .iter()
                .copied()
                .filter(|v| ty(*v) == Ok(Type::Effect))
                .collect();
            if !input_effects.is_empty() || !output_effects.is_empty() {
                require(
                    inst.ordered
                        && input_effects.len() == 1
                        && output_effects.len() == 1
                        && input_effects.first().copied() == effect
                        && inst.uses.last().copied() == effect
                        && inst.definitions.last() == output_effects.first(),
                )?;
                effect = output_effects.first().copied();
                require(
                    pending_rmw.is_none()
                        || matches!(
                            data.effects[id.index()],
                            Some(super::effect::EffectPlan::RmwCommit { .. })
                        ),
                )?;
            }
            if let Some(memory) = &data.memory[id.index()] {
                if let super::memory::NativeMemory::ScalarLoad {
                    ticket: Some(ticket),
                    ..
                } = memory.native
                {
                    require(
                        pending_rmw.is_none()
                            && ty(ticket)? == Type::RmwTicket
                            && matches!(memory.guard.bytes, 1 | 2 | 4)
                            && memory.guard
                                == super::memory::RamGuard::new(memory.guard.bytes, true),
                    )?;
                    pending_rmw = Some((ticket, memory.guard.bytes, memory.before));
                }
            }
            if let Some(super::effect::EffectPlan::RmwCommit {
                ticket,
                bytes,
                value,
                observe,
                commit,
                ..
            }) = &data.effects[id.index()]
            {
                require(
                    pending_rmw == Some((*ticket, *bytes, observe.count))
                        && ty(*value)?.bits() == Some(*bytes * 8)
                        && observe.values == *commit
                        && inst.after == Some(*commit),
                )?;
                pending_rmw = None;
            }
            // Non-value plans are sealed but still checked against owned operand,
            // definition and observation facts, independently of the original HIR.
            if let Some(call) = &data.calls[id.index()] {
                let helper = data
                    .helpers
                    .get(call.helper.index())
                    .and_then(Option::as_ref)
                    .ok_or_else(invalid)?;
                require(
                    call.args.len() == helper.signature.params.len()
                        && call.exits == helper.exit_outcomes
                        && call.normal == if helper.cpu_exit { None } else { Some(0) },
                )?;
                for result in &call.staged {
                    require(ty(result.value)? == result.ty)?;
                }
            }
            let (plan_uses, plan_defs, plan_states) = plan_references(data, id);
            for v in plan_uses {
                require(inst.uses.contains(&v))?;
                available(v, b, p)?;
            }
            for v in plan_defs {
                require(inst.definitions.contains(&v))?;
                ty(v)?;
            }
            for state in plan_states {
                require(Some(state) == inst.before || Some(state) == inst.after)?;
            }
            let input = if let Some(plan) = &data.values[id.index()] {
                require(inst.definitions.contains(&plan.result))?;
                super::value::verify_program_types(&data.value_types, plan)?;
                expression(&plan.steps)
            }
            else {
                inst.uses.clone()
            };
            spend(&mut left, input.len() + inst.recovery.len() + 1)?;
            for v in input {
                available(v, b, p)?;
            }
            if let Some(s) = inst.before {
                check_state(s, b, p)?;
            }
            if let Some(s) = inst.after {
                check_state(s, b, p + 1)?;
            }
            if let Some(poll) = &data.control.polls[id.index()] {
                require(Some(poll.recovery) == inst.before && poll.cost >= 1)?;
                check_state(poll.recovery, b, p)?;
            }
        }
        require(pending_rmw.is_none())?;
        for edge in edges(&block.terminator) {
            for &arg in &edge.arguments {
                if ty(arg)? == Type::Effect {
                    require(Some(arg) == effect)?;
                }
            }
        }
        for v in term_uses(block) {
            available(v, b, block.instructions.len())?;
        }
        if let Terminator::Exit(s) = block.terminator {
            check_state(s, b, block.instructions.len())?;
        }
    }
    // Recompute liveness independently from the current value programs. Check
    // existing allocation instead of requiring a particular allocator's colors.
    let mut inputs = vec![BTreeSet::new(); n];
    let mut outputs = inputs.clone();
    loop {
        let mut changed = false;
        for (b, block) in graph.blocks.iter().enumerate().rev() {
            let mut live: BTreeSet<_> = term_uses(block).into_iter().collect();
            for e in edges(&block.terminator) {
                // The independent tree solver also performs a linear parameter
                // membership search. Do not meter only surviving live values.
                spend(
                    &mut left,
                    inputs[e.target.index()].len().saturating_mul(
                        graph.blocks[e.target.index()].params.len().saturating_add(1),
                    ),
                )?;
                live.extend(
                    inputs[e.target.index()]
                        .iter()
                        .filter(|v| !graph.blocks[e.target.index()].params.contains(v)),
                );
            }
            outputs[b] = live.clone();
            for &id in block.instructions.iter().rev() {
                if data.stack_elided[id.index()] {
                    continue;
                }
                for v in &graph.instructions[id.index()].definitions {
                    live.remove(v);
                }
                live.extend(uses(data, id));
                spend(&mut left, live.len() + 1)?;
            }
            live.extend(&block.recovery);
            if inputs[b] != live {
                inputs[b] = live;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut check_live = |live: &BTreeSet<ValueId>| -> Result<(), CompileError> {
        spend(&mut left, live.len() + 1)?;
        let mut occupied = BTreeSet::new();
        for &v in live {
            if ty(v)? != Type::Effect {
                require(occupied.insert(local(v)?))?;
            }
        }
        Ok(())
    };
    for (b, block) in graph.blocks.iter().enumerate() {
        let mut live = outputs[b].clone();
        check_live(&live)?;
        for &id in block.instructions.iter().rev() {
            if data.stack_elided[id.index()] {
                continue;
            }
            live.extend(&graph.instructions[id.index()].definitions);
            check_live(&live)?;
            for v in &graph.instructions[id.index()].definitions {
                live.remove(v);
            }
            live.extend(uses(data, id));
            check_live(&live)?;
        }
        live.extend(&block.recovery);
        live.extend(&block.params);
        check_live(&live)?;
    }
    Ok(())
}

fn plan_references(data: &MirData, id: InstId) -> (Vec<ValueId>, Vec<ValueId>, Vec<StateId>) {
    use super::{
        arithmetic::ArithmeticPlan,
        effect::EffectPlan,
        memory::{Argument, NativeMemory, SlowResult, VectorCombine},
    };
    let mut uses = vec![];
    let mut defs = vec![];
    let mut states = vec![];
    let args = |call: &super::memory::RuntimeCall| {
        call.args
            .iter()
            .filter_map(|a| match a {
                Argument::Value(v) => Some(*v),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    if let Some(m) = &data.memory[id.index()] {
        uses.push(m.address);
        uses.extend(args(&m.call));
        states.push(m.before);
        match &m.native {
            NativeMemory::ScalarLoad { result, ticket } => {
                defs.push(*result);
                defs.extend(ticket);
            },
            NativeMemory::ScalarStore { value, commit } => {
                uses.push(*value);
                states.extend(commit);
            },
            NativeMemory::VectorLoad { result, combine } => {
                defs.push(*result);
                match combine {
                    VectorCombine::None => (),
                    VectorCombine::ReplaceWord { old, .. }
                    | VectorCombine::Shuffle { old, .. }
                    | VectorCombine::Binary { old, .. } => uses.push(*old),
                }
            },
            NativeMemory::VectorStore {
                value,
                mask,
                commit,
                ..
            } => {
                uses.push(*value);
                uses.extend(mask);
                states.push(*commit);
            },
        }
        match &m.result {
            SlowResult::Packed { result, .. } => defs.push(*result),
            SlowResult::Rmw {
                result,
                ticket,
                read_value,
            } => {
                defs.extend([*result, *ticket]);
                uses.extend(args(read_value));
            },
            SlowResult::Store { commit, .. } => states.extend(commit),
            SlowResult::CpuExit { .. } => (),
        }
    }
    if let Some(e) = &data.effects[id.index()] {
        uses.extend(args(e.call()));
        match e {
            EffectPlan::Address {
                offset,
                result,
                before,
                ..
            } => {
                uses.push(*offset);
                defs.push(*result);
                states.push(*before);
            },
            EffectPlan::Check { before, .. } => states.push(*before),
            EffectPlan::RmwCommit {
                ticket,
                value,
                observe,
                commit,
                ..
            } => {
                uses.extend([*ticket, *value]);
                states.extend([observe.values, observe.count, *commit]);
            },
            EffectPlan::Arithmetic(ArithmeticPlan::Division(d)) => {
                uses.extend([d.dividend, d.divisor]);
                defs.extend([d.quotient, d.remainder]);
                states.push(d.before);
            },
            EffectPlan::Arithmetic(ArithmeticPlan::CompareExchange(c)) => {
                uses.push(c.address);
                states.push(c.before);
            },
            EffectPlan::X87 { outputs, .. } => defs.extend(outputs),
        }
    }
    if let Some(c) = &data.calls[id.index()] {
        uses.extend(&c.args);
        states.push(c.state);
        defs.extend(c.staged.iter().map(|s| s.value));
        defs.extend(c.reload.iter().map(|(v, _)| *v));
        if let Some(d) = &c.delivery {
            states.push(d.restore);
        }
    }
    (uses, defs, states)
}

#[cfg(test)]
#[path = "../../../../tests/ir/semantics/mir_allocation.rs"]
mod allocator_tests;

#[cfg(test)]
mod verifier_tests {
    use super::*;
    use crate::ir::{
        frontend::{
            decode::{GuestEip, LinearAddress},
            lift::lift_cpu,
        },
        lowering::lower,
    };
    fn fixture() -> super::super::MirRegion {
        lower(
            &lift_cpu(
                &[0x40, 0x01, 0x00, 0x8B, 0x08],
                GuestEip(0x1000),
                LinearAddress(0x1000),
                true,
            )
            .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn owned_verifier_rejects_corrupt_graphs_without_hir() {
        for mutation in 0..13 {
            let mut mir = fixture();
            mir.verify().unwrap();
            let data = &mut mir.data;
            match mutation {
                0 => data.control.entries[0] = BlockId(u32::MAX),
                1 => data.control.blocks[0].instructions.push(InstId(u32::MAX)),
                2 => data.allocation.value_local.iter_mut().for_each(|s| {
                    if s.is_some() {
                        *s = Some(0);
                    }
                }),
                3 => {
                    let p = data.values.iter_mut().flatten().next().unwrap();
                    p.steps = vec![Step::Value(p.result)];
                },
                4 => data.states[0].cpu.count.base = Some(ValueId(u32::MAX)),
                5 => data.memory.iter_mut().flatten().next().unwrap().address = ValueId(u32::MAX),
                6 => data.value_blocks.clear(),
                7 => data.allocation_graph.blocks[0]
                    .params
                    .push(ValueId(u32::MAX)),
                8 => data.control.blocks[0].budget_cost = 0,
                9 => {
                    data.control.blocks[0].terminator = control::Terminator::Exit(StateId(u32::MAX))
                },
                10 => {
                    let root = data.allocation_graph.blocks[0]
                        .params
                        .iter()
                        .copied()
                        .find(|v| data.value_types[v.index()] == Type::Effect)
                        .unwrap();
                    let last = data
                        .allocation_graph
                        .instructions
                        .iter_mut()
                        .rev()
                        .find(|i| {
                            i.uses
                                .last()
                                .is_some_and(|v| data.value_types[v.index()] == Type::Effect)
                        })
                        .unwrap();
                    *last.uses.last_mut().unwrap() = root;
                },
                11 => {
                    let commit = data
                        .effects
                        .iter_mut()
                        .flatten()
                        .find(|p| matches!(p, super::super::effect::EffectPlan::RmwCommit { .. }))
                        .unwrap();
                    if let super::super::effect::EffectPlan::RmwCommit { bytes, .. } = commit {
                        *bytes = 2;
                    }
                },
                _ => data.memory.iter_mut().for_each(|m| *m = None),
            }
            assert!(mir.verify().is_err(), "mutation {mutation}");
        }
    }
    #[test]
    fn owned_verifier_accepts_every_machine_stage_and_bounds_work() {
        let mut mir = fixture();
        mir.verify().unwrap();
        mir.fold_constants().unwrap();
        mir.verify().unwrap();
        mir.schedule_operand_stack(262_144).unwrap();
        mir.verify().unwrap();
        mir.allocate_machine_locals(4_000_000).unwrap();
        mir.verify().unwrap();
        mir.forward_ram_reads(262_144).unwrap();
        mir.verify().unwrap();
        assert!(matches!(verify(&mir, 1), Err(CompileError::Budget(_))));
    }
}

fn cpu_state_demand(
    data: &MirData,
    id: StateId,
    work: &mut Vec<ValueId>,
    left: &mut usize,
) -> Result<(), CompileError> {
    let state = &data.states[id.index()];
    for (index, write) in state.cpu.writes.iter().enumerate() {
        if super::state_elision::elided(data, id, index) {
            continue;
        }
        spend(left, write.expression.len() + 1)?;
        work.extend(expression(&write.expression));
    }
    work.extend(state.cpu.count.base);
    work.extend(expression(&state.decoded_next.expression));
    Ok(())
}
/// CPU roots come from the actual machine materializations after optional write
/// trimming. Derive demand once, after trimming, instead of precomputing alternative
/// HIR masks twice during every Tier-1 lowering and lowering verification.
pub(super) struct CpuDemand {
    pub instructions: Vec<bool>,
    pub values: Vec<bool>,
}
pub(super) fn cpu_demand(data: &MirData, work_limit: usize) -> Result<CpuDemand, CompileError> {
    let graph = &data.allocation_graph;
    let mut left = work_limit;
    spend(
        &mut left,
        graph.instructions.len() + data.value_types.len() + graph.blocks.len(),
    )?;
    let mut live = vec![false; graph.instructions.len()];
    let mut seen = vec![false; data.value_types.len()];
    let mut work = vec![];
    let mut states = BTreeSet::new();
    for block in &graph.blocks {
        states.extend(block.recovery_id);
        match block.terminator {
            Terminator::Exit(s) => {
                states.insert(s);
            },
            Terminator::Branch(v, ..) => work.push(v),
            _ => (),
        }
        for &id in &block.instructions {
            let inst = &graph.instructions[id.index()];
            states.extend(inst.after);
            if !super::helper_state::elided(data, id) {
                states.extend(inst.before);
            }
            // Every non-value instruction remains pinned. Its explicit inputs
            // include effect ordering; CPU snapshots are separate roots above.
            if data.values[id.index()].is_none() {
                live[id.index()] = true;
                work.extend(&inst.uses);
            }
            // Selective SSE adapters (and their native arm) consume operands
            // directly from the StatePlan even when a full CPU state store is
            // redundant. Those reads are explicit machine roots, not merely
            // observation writes that state elision can remove.
            if let Some(call) = &data.calls[id.index()] {
                if let Some((source, destination)) = call.xmm_observation {
                    for write in &data.states[call.state.index()].cpu.writes {
                        if [source, destination].iter().any(|&reg| {
                            write.address
                                == super::value::Address::Absolute(
                                    crate::cpu::global_pointers::get_reg_xmm_offset(reg as u32),
                                )
                        }) {
                            spend(&mut left, write.expression.len() + 1)?;
                            work.extend(expression(&write.expression));
                        }
                    }
                }
            }
        }
    }
    for state in states {
        cpu_state_demand(data, state, &mut work, &mut left)?;
    }
    while let Some(v) = work.pop() {
        spend(&mut left, 1)?;
        if seen[v.index()] {
            continue;
        }
        seen[v.index()] = true;
        if let Some(id) = data.value_definitions[v.index()] {
            if !live[id.index()] {
                live[id.index()] = true;
                if let Some(plan) = &data.values[id.index()] {
                    work.extend(expression(&plan.steps));
                }
                else {
                    work.extend(&graph.instructions[id.index()].uses);
                }
            }
        }
        else if let Some(owner) = data.value_blocks[v.index()] {
            let parameter = graph.blocks[owner.index()]
                .params
                .iter()
                .position(|&p| p == v)
                .ok_or_else(|| CompileError::InvalidIr("missing machine block parameter".into()))?;
            for block in &graph.blocks {
                for edge in edges(&block.terminator) {
                    spend(&mut left, 1)?;
                    if edge.target == owner {
                        work.push(edge.arguments[parameter]);
                    }
                }
            }
        }
    }
    Ok(CpuDemand { instructions: live, values: seen })
}

/// Rebuild simultaneous CPU edge assignments from SSA pairs. Filtering the
/// already scheduled moves would break cycles and scratch dependencies.
pub(super) fn cpu_copy_control(
    data: &MirData,
    demanded: &[bool],
    work_limit: usize,
) -> Result<Vec<control::Terminator>, CompileError> {
    let invalid = || CompileError::InvalidIr("invalid CPU edge demand".into());
    if demanded.len() != data.value_types.len() {
        return Err(invalid());
    }
    let graph = &data.allocation_graph;
    let mut left = work_limit;
    spend(&mut left, graph.blocks.len() + demanded.len())?;
    let local = |value: ValueId| data.allocation.value_local[value.index()].ok_or_else(invalid);
    let mut edge = |edge: &Edge| -> Result<control::Edge, CompileError> {
        let params = &graph.blocks[edge.target.index()].params;
        if params.len() != edge.arguments.len() {
            return Err(invalid());
        }
        spend(&mut left, params.len() + data.allocation.local_types.len())?;
        let mut pairs = Vec::new();
        for (&arg, &param) in edge.arguments.iter().zip(params) {
            if data.value_types[param.index()] != Type::Effect && demanded[param.index()] {
                pairs.push((local(arg)?, local(param)?));
            }
        }
        // Parallel-copy scheduling has bounded quadratic cycle/sink searches.
        spend(&mut left, pairs.len().saturating_mul(pairs.len() + 1))?;
        control::schedule(edge.target, &pairs, &data.allocation.local_types)
    };
    graph.blocks.iter().map(|block| Ok(match &block.terminator {
        Terminator::Exit(state) => control::Terminator::Exit(*state),
        Terminator::Jump(next) => control::Terminator::Jump(edge(next)?),
        Terminator::Branch(condition, taken, not_taken) => control::Terminator::Branch {
            condition: local(*condition)?,
            taken: edge(taken)?,
            not_taken: edge(not_taken)?,
        },
    })).collect()
}

/// Region-wide CPU backing knowledge: "backing address A currently holds SSA
/// value V". A plain backing read establishes a fact; a normal CpuReload after
/// a call establishes fresh facts; a call or effect discards all of them. A
/// recovery materialization may or may not execute on the continuing path (a
/// slow-path fault check, a budget exit), so it keeps only facts whose value it
/// would write unchanged. Facts meet by intersection at control-flow merges.
/// Only architectural state words take part: PC, retirement and every other
/// absolute address are neither remembered nor elided. State IDs may be used
/// at multiple sites, so their certificates intersect.
pub(super) fn backing_sync(
    data: &MirData,
    work_limit: usize,
) -> Result<Vec<Vec<bool>>, CompileError> {
    use super::{
        materialize::Store,
        value::{Address, Load, Reading},
    };
    type Facts = Vec<(Address, Store, ValueId)>;
    let tracked = |address: Address| match address {
        Address::Gpr(_) | Address::Flags | Address::FlagOperand => true,
        Address::Absolute(a) => {
            use crate::cpu::global_pointers as gp;
            a == gp::flags_changed as u32
                || a == gp::last_result as u32
                || a == gp::last_op_size as u32
                || (0..8).any(|r| a == gp::get_reg_xmm_offset(r))
        },
        Address::Eip | Address::Committed => false,
    };
    let graph = &data.allocation_graph;
    let mut left = work_limit;
    spend(&mut left, data.states.len() + data.values.len() + graph.blocks.len())?;
    let written = |id: StateId, address: Address| -> Option<(Store, Option<ValueId>)> {
        data.states[id.index()]
            .cpu
            .writes
            .iter()
            .rev()
            .find(|w| w.address == address)
            .map(|w| {
                (
                    w.store,
                    match w.expression[..] {
                        [Step::Value(v)] => Some(v),
                        _ => None,
                    },
                )
            })
    };
    // A materialization that might execute leaves a fact only when it would
    // rewrite the same value with the same width.
    let materialize = |id: StateId, known: &mut Facts, left: &mut usize| -> Result<(), CompileError> {
        spend(left, known.len().saturating_mul(data.states[id.index()].cpu.writes.len() + 1))?;
        known.retain(|&(address, store, v)| match written(id, address) {
            None => true,
            Some((s, value)) => s == store && value == Some(v),
        });
        Ok(())
    };
    let remember = |reading: &Reading, v, known: &mut Facts| {
        if let Reading::Memory { address, load } = reading {
            let store = match load {
                Load::I32 => Store::I32,
                Load::V128 => Store::V128,
                _ => return,
            };
            if !tracked(*address) {
                return;
            }
            known.retain(|&(a, _, _)| a != *address);
            known.push((*address, store, v));
        }
    };
    // One block's transfer. `observe` sees the facts at each recovery use.
    let transfer = |block: &Block,
                    known: &mut Facts,
                    left: &mut usize,
                    observe: &mut dyn FnMut(StateId, &Facts, &mut usize) -> Result<(), CompileError>|
     -> Result<(), CompileError> {
        if let Some(s) = block.recovery_id {
            observe(s, known, left)?;
            materialize(s, known, left)?;
        }
        for &id in &block.instructions {
            spend(left, 1)?;
            if data.stack_elided[id.index()] {
                continue;
            }
            let inst = &graph.instructions[id.index()];
            // Caller-owned fault delivery can restore the same state after the
            // callee has changed backing. That restoration must retain all writes.
            if data.calls[id.index()]
                .as_ref()
                .is_some_and(|c| c.delivery.is_some())
            {
                known.clear();
            }
            for s in [inst.before, inst.after].into_iter().flatten() {
                observe(s, known, left)?;
                materialize(s, known, left)?;
            }
            if let Some(value) = &data.values[id.index()] {
                if let [Step::Read { cpu, .. }] = &value.steps[..] {
                    remember(cpu, value.result, known);
                }
            }
            // Segment/memory/SSE checks, RMW commits and division write CPU
            // backing only on a fault path, which never continues here; their
            // slow-path recovery writes were applied above. CMPXCHG8B updates
            // EAX/EDX/FLAGS backing on its normal path.
            if data.effects[id.index()].as_ref().is_some_and(|plan| {
                !matches!(
                    plan,
                    super::effect::EffectPlan::Address { .. }
                        | super::effect::EffectPlan::Check { .. }
                        | super::effect::EffectPlan::RmwCommit { .. }
                        | super::effect::EffectPlan::X87 { .. }
                        | super::effect::EffectPlan::Arithmetic(
                            super::arithmetic::ArithmeticPlan::Division(_)
                        )
                )
            }) {
                known.clear();
            }
            if let Some(call) = &data.calls[id.index()] {
                known.clear();
                // A native FP branch can assign SSA without writing CPU memory.
                // Its helper-only sibling cannot authorize a joint certificate.
                if call.native_fp.is_none() && call.normal.is_some() {
                    for (v, reading) in &call.reload {
                        remember(reading, *v, known);
                    }
                }
            }
        }
        if let Terminator::Exit(s) = block.terminator {
            observe(s, known, left)?;
        }
        Ok(())
    };
    let successors = |block: &Block| -> Vec<BlockId> {
        match &block.terminator {
            Terminator::Exit(_) => vec![],
            Terminator::Jump(e) => vec![e.target],
            Terminator::Branch(_, a, b) => vec![a.target, b.target],
        }
    };
    // Forward fixpoint over block entry facts; None is "not yet reached".
    let n = graph.blocks.len();
    let mut entry: Vec<Option<Facts>> = vec![None; n];
    for e in &graph.entries {
        entry[e.index()] = Some(vec![]);
    }
    let mut work: Vec<usize> = graph.entries.iter().map(|e| e.index()).collect();
    let mut queued = vec![false; n];
    for &b in &work {
        queued[b] = true;
    }
    while let Some(b) = work.pop() {
        queued[b] = false;
        let mut known = entry[b].clone().unwrap_or_default();
        transfer(&graph.blocks[b], &mut known, &mut left, &mut |_, _, _| Ok(()))?;
        for next in successors(&graph.blocks[b]) {
            let t = next.index();
            spend(&mut left, known.len() + 1)?;
            let merged = match &entry[t] {
                None => known.clone(),
                Some(old) => old.iter().copied().filter(|f| known.contains(f)).collect(),
            };
            if entry[t].as_ref() != Some(&merged) {
                entry[t] = Some(merged);
                if !queued[t] {
                    queued[t] = true;
                    work.push(t);
                }
            }
        }
    }
    let mut masks: Vec<Option<Vec<bool>>> = vec![None; data.states.len()];
    let mut observe = |id: StateId, known: &Facts, left: &mut usize| -> Result<(), CompileError> {
        let state = &data.states[id.index()];
        spend(left, state.cpu.writes.len().saturating_mul(known.len() + 1))?;
        let next: Vec<bool> = state
            .cpu
            .writes
            .iter()
            .map(|w| {
                tracked(w.address)
                    && known.iter().any(|&(address, store, v)| {
                        address == w.address && store == w.store && w.expression == [Step::Value(v)]
                    })
            })
            .collect();
        if let Some(mask) = &mut masks[id.index()] {
            for (old, new) in mask.iter_mut().zip(next) {
                *old &= new;
            }
        }
        else {
            masks[id.index()] = Some(next);
        }
        Ok(())
    };
    for (b, block) in graph.blocks.iter().enumerate() {
        // Unreached blocks keep an empty certificate: no write is skipped.
        let mut known = entry[b].clone().unwrap_or_default();
        transfer(block, &mut known, &mut left, &mut observe)?;
    }
    Ok(masks
        .into_iter()
        .zip(&data.states)
        .map(|(mask, state)| mask.unwrap_or_else(|| vec![false; state.cpu.writes.len()]))
        .collect())
}
