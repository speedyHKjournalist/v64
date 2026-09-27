//! Deterministic MIR control-flow structuring for the Wasm backend.
//!
//! Reducible single-entry SCCs become nested Loop/Block structures. Multi-entry
//! regions and irreducible SCCs are rejected so wasm.rs can use its correctness
//! dispatcher fallback. This module never emits Wasm.
use crate::ir::{
    ids::BlockId,
    mir::control::{ControlFlow, Terminator},
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

type Set = BTreeSet<BlockId>;
type Graph = BTreeMap<BlockId, Set>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Structure {
    BasicBlock(BlockId),
    Loop(Vec<Structure>),
    Block(Vec<Structure>),
}
impl Structure {
    pub fn head(&self) -> Vec<BlockId> {
        match self {
            Self::BasicBlock(id) => vec![*id],
            Self::Loop(children) | Self::Block(children) => {
                children.first().map_or_else(Vec::new, Structure::head)
            },
        }
    }
    fn branches(&self, graph: &Graph, result: &mut Set) {
        match self {
            Self::BasicBlock(id) => {
                if let Some(edges) = graph.get(id) {
                    result.extend(edges);
                }
            },
            Self::Loop(children) | Self::Block(children) => {
                for child in children {
                    child.branches(graph, result);
                }
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub roots: Vec<Structure>,
    pub backedges: u32,
    pub edges: u32,
}

fn graph(control: &ControlFlow) -> Option<Graph> {
    let mut graph = Graph::new();
    for (index, block) in control.blocks.iter().enumerate() {
        let id = BlockId(index as u32);
        let mut edges = Set::new();
        match &block.terminator {
            Terminator::Exit(_) => {},
            Terminator::Jump(edge) => {
                if edge.target.index() >= control.blocks.len() {
                    return None;
                }
                edges.insert(edge.target);
            },
            Terminator::Branch {
                taken, not_taken, ..
            } => {
                if taken.target.index() >= control.blocks.len()
                    || not_taken.target.index() >= control.blocks.len()
                {
                    return None;
                }
                edges.insert(taken.target);
                edges.insert(not_taken.target);
            },
        }
        graph.insert(id, edges);
    }
    Some(graph)
}

fn reverse(graph: &Graph) -> Graph {
    let mut reverse = Graph::new();
    for id in graph.keys() {
        reverse.entry(*id).or_default();
    }
    for (from, tos) in graph {
        for to in tos {
            reverse.entry(*to).or_default().insert(*from);
        }
    }
    reverse
}

fn reachable(graph: &Graph, entries: &[BlockId]) -> Set {
    let mut result = Set::new();
    let mut work = entries.to_vec();
    while let Some(id) = work.pop() {
        if !result.insert(id) {
            continue;
        }
        if let Some(edges) = graph.get(&id) {
            work.extend(edges.iter().copied());
        }
    }
    result
}

fn scc(graph: &Graph) -> Vec<Vec<BlockId>> {
    fn visit(id: BlockId, graph: &Graph, seen: &mut Set, order: &mut Vec<BlockId>) {
        if !seen.insert(id) {
            return;
        }
        if let Some(edges) = graph.get(&id) {
            for next in edges {
                visit(*next, graph, seen, order);
            }
        }
        order.push(id);
    }
    fn assign(id: BlockId, reverse: &Graph, seen: &mut Set, group: &mut Vec<BlockId>) {
        if !seen.insert(id) {
            return;
        }
        group.push(id);
        if let Some(edges) = reverse.get(&id) {
            for next in edges {
                assign(*next, reverse, seen, group);
            }
        }
    }

    let reverse = reverse(graph);
    let mut order = Vec::new();
    let mut seen = Set::new();
    for id in graph.keys() {
        visit(*id, graph, &mut seen, &mut order);
    }
    let mut assigned = Set::new();
    let mut groups = Vec::new();
    for id in order.into_iter().rev() {
        let mut group = Vec::new();
        assign(id, &reverse, &mut assigned, &mut group);
        if !group.is_empty() {
            group.sort();
            groups.push(group);
        }
    }
    groups
}

fn loopify(graph: &Graph, external_entries: &Set, backedges: &mut u32) -> Option<Vec<Structure>> {
    let reverse = reverse(graph);
    let mut result = Vec::new();
    for group in scc(graph) {
        if group.len() == 1 {
            let id = group[0];
            let node = Structure::BasicBlock(id);
            if graph.get(&id).is_some_and(|edges| edges.contains(&id)) {
                *backedges = backedges.wrapping_add(1);
                result.push(Structure::Loop(vec![node]));
            }
            else {
                result.push(node);
            }
            continue;
        }

        let members: Set = group.iter().copied().collect();
        let entries: Vec<_> = group
            .iter()
            .copied()
            .filter(|id| {
                external_entries.contains(id)
                    || reverse
                        .get(id)
                        .is_some_and(|preds| preds.iter().any(|pred| !members.contains(pred)))
            })
            .collect();
        // A cyclic SCC with more than one externally reachable header is
        // irreducible for this backend. Never duplicate MIR blocks/state maps.
        if entries.len() != 1 {
            return None;
        }
        let header = entries[0];
        let mut subgraph = Graph::new();
        for id in &group {
            let edges = graph[id]
                .iter()
                .copied()
                .filter(|target| members.contains(target) && *target != header)
                .collect();
            subgraph.insert(*id, edges);
        }
        let nested_entries = Set::from([header]);
        let mut children = loopify(&subgraph, &nested_entries, backedges)?;
        if children.is_empty() {
            return None;
        }
        // Removing all edges to the unique header makes each such edge a
        // structured continue to this loop.
        let removed = group
            .iter()
            .map(|id| graph[id].contains(&header) as u32)
            .sum::<u32>();
        if removed == 0 {
            return None;
        }
        *backedges = backedges.wrapping_add(removed);
        // The header must be the first executable head of the loop.
        let position = children
            .iter()
            .position(|child| child.head().contains(&header))?;
        if position != 0 {
            children.rotate_left(position);
        }
        result.push(Structure::Loop(children));
    }
    Some(result)
}

fn blockify(nodes: &mut Vec<Structure>, graph: &Graph) {
    let mut cached = Vec::<Set>::with_capacity(nodes.len());
    for node in nodes.iter() {
        let mut branches = Set::new();
        node.branches(graph, &mut branches);
        cached.push(branches);
    }

    let mut index = 0;
    while index < nodes.len() {
        match &mut nodes[index] {
            Structure::BasicBlock(_) => {},
            Structure::Loop(children) | Structure::Block(children) => blockify(children, graph),
        }

        let heads: Set = nodes[index].head().into_iter().collect();
        let Some(source) = (0..index).find(|source| !cached[*source].is_disjoint(&heads))
        else {
            index += 1;
            continue;
        };

        // Consecutive single basic blocks already have a natural fallthrough.
        if source + 1 == index && matches!(nodes[source], Structure::BasicBlock(_)) {
            index += 1;
            continue;
        }

        let children: Vec<_> = nodes.drain(source..index).collect();
        nodes.insert(source, Structure::Block(children));
        let mut branches = Set::new();
        for old in cached.drain(source..index) {
            branches.extend(old);
        }
        cached.insert(source, branches);
        index = source + 2;
    }
}

fn verify_structure(nodes: &[Structure], blocks: usize, expected: &Set) -> bool {
    fn collect(node: &Structure, seen: &mut Set) -> bool {
        match node {
            Structure::BasicBlock(id) => seen.insert(*id),
            Structure::Loop(children) | Structure::Block(children) => {
                !children.is_empty() && children.iter().all(|child| collect(child, seen))
            },
        }
    }
    let mut seen = Set::new();
    nodes.iter().all(|node| collect(node, &mut seen))
        && seen == *expected
        && seen.iter().all(|id| id.index() < blocks)
}

fn verify_control_targets(nodes: &[Structure], graph: &Graph) -> bool {
    #[derive(Clone)]
    enum Work {
        Node(Structure),
        BlockEnd {
            label: usize,
            targets: Vec<BlockId>,
            old: Vec<(BlockId, usize)>,
        },
        LoopEnd {
            label: usize,
            entries: Vec<BlockId>,
            old: Vec<(BlockId, usize)>,
        },
    }

    let mut labels = BTreeMap::<BlockId, usize>::new();
    let mut next_label = 0usize;
    let mut work: VecDeque<Work> = nodes.iter().cloned().map(Work::Node).collect();
    while let Some(item) = work.pop_front() {
        let next = work
            .iter()
            .find_map(|item| match item {
                Work::Node(node) => Some(node.head()),
                Work::BlockEnd { .. } | Work::LoopEnd { .. } => None,
            })
            .unwrap_or_default();

        match item {
            Work::Node(Structure::BasicBlock(id)) => {
                let Some(edges) = graph.get(&id)
                else {
                    return false;
                };
                if edges
                    .iter()
                    .any(|target| !next.contains(target) && !labels.contains_key(target))
                {
                    return false;
                }
            },
            Work::Node(Structure::Loop(children)) => {
                let Some(first) = children.first()
                else {
                    return false;
                };
                let entries = first.head();
                if entries.is_empty() {
                    return false;
                }
                let label = next_label;
                next_label = next_label.saturating_add(1);
                let mut old = Vec::new();
                for target in &entries {
                    if let Some(previous) = labels.insert(*target, label) {
                        old.push((*target, previous));
                    }
                }
                work.push_front(Work::LoopEnd {
                    label,
                    entries,
                    old,
                });
                for child in children.into_iter().rev() {
                    work.push_front(Work::Node(child));
                }
            },
            Work::LoopEnd {
                label,
                entries,
                old,
            } => {
                for target in entries {
                    if labels.remove(&target) != Some(label) {
                        return false;
                    }
                }
                for (target, previous) in old {
                    if labels.insert(target, previous).is_some() {
                        return false;
                    }
                }
            },
            Work::Node(Structure::Block(children)) => {
                if children.is_empty() || next.is_empty() {
                    return false;
                }
                let label = next_label;
                next_label = next_label.saturating_add(1);
                let mut old = Vec::new();
                for target in &next {
                    if let Some(previous) = labels.insert(*target, label) {
                        old.push((*target, previous));
                    }
                }
                work.push_front(Work::BlockEnd {
                    label,
                    targets: next,
                    old,
                });
                for child in children.into_iter().rev() {
                    work.push_front(Work::Node(child));
                }
            },
            Work::BlockEnd {
                label,
                targets,
                old,
            } => {
                for target in targets {
                    if labels.remove(&target) != Some(label) {
                        return false;
                    }
                }
                for (target, previous) in old {
                    if labels.insert(target, previous).is_some() {
                        return false;
                    }
                }
            },
        }
    }
    labels.is_empty()
}

pub fn structure(control: &ControlFlow) -> Option<Plan> {
    if control.entries.len() != 1 || control.blocks.is_empty() {
        return None;
    }
    let graph = graph(control)?;
    let reachable = reachable(&graph, &control.entries);
    if reachable.len() != control.blocks.len() {
        return None;
    }
    let entries = Set::from([control.entries[0]]);
    let mut backedges = 0;
    let mut roots = loopify(&graph, &entries, &mut backedges)?;
    blockify(&mut roots, &graph);
    if !verify_structure(&roots, control.blocks.len(), &reachable)
        || !verify_control_targets(&roots, &graph)
    {
        return None;
    }
    let edges = graph.values().map(|edges| edges.len() as u32).sum();
    Some(Plan {
        roots,
        backedges,
        edges,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{
        ids::StateId,
        mir::control::{Block, Edge},
    };

    fn edge(target: u32) -> Edge {
        Edge {
            target: BlockId(target),
            scratch: vec![],
            copies: vec![],
        }
    }
    fn block(term: Terminator) -> Block {
        Block {
            params: vec![],
            instructions: vec![],
            recovery: Some(StateId(0)),
            budget_cost: 1,
            terminator: term,
        }
    }
    fn control(blocks: Vec<Block>) -> ControlFlow {
        ControlFlow {
            entries: vec![BlockId(0)],
            blocks,
            dynamic_counts: true,
            polls: vec![],
            sparse_polls: false,
        }
    }

    #[test]
    fn structures_nested_reducible_cfgs() {
        let diamond = control(vec![
            block(Terminator::Branch {
                condition: 0,
                taken: edge(1),
                not_taken: edge(2),
            }),
            block(Terminator::Jump(edge(3))),
            block(Terminator::Jump(edge(3))),
            block(Terminator::Exit(StateId(0))),
        ]);
        let plan = structure(&diamond).unwrap();
        assert_eq!(plan.edges, 4);
        assert_eq!(plan.backedges, 0);

        let loop_with_diamond = control(vec![
            block(Terminator::Jump(edge(1))),
            block(Terminator::Branch {
                condition: 0,
                taken: edge(2),
                not_taken: edge(3),
            }),
            block(Terminator::Jump(edge(4))),
            block(Terminator::Jump(edge(4))),
            block(Terminator::Branch {
                condition: 0,
                taken: edge(1),
                not_taken: edge(5),
            }),
            block(Terminator::Exit(StateId(0))),
        ]);
        let plan = structure(&loop_with_diamond).unwrap();
        assert!(plan.backedges >= 1);
        assert_eq!(plan.edges, 7);

        let nested_loops = control(vec![
            block(Terminator::Jump(edge(1))),
            block(Terminator::Jump(edge(2))),
            block(Terminator::Branch {
                condition: 0,
                taken: edge(2),
                not_taken: edge(3),
            }),
            block(Terminator::Branch {
                condition: 0,
                taken: edge(1),
                not_taken: edge(4),
            }),
            block(Terminator::Exit(StateId(0))),
        ]);
        assert!(structure(&nested_loops).is_some());

        // Two distinct latches continue to one loop header while the header
        // also has a side exit. Both continues and the exit must have an open
        // structured label when their MIR edges are emitted.
        let multiple_latches = control(vec![
            block(Terminator::Jump(edge(1))),
            block(Terminator::Branch {
                condition: 0,
                taken: edge(2),
                not_taken: edge(4),
            }),
            block(Terminator::Branch {
                condition: 0,
                taken: edge(3),
                not_taken: edge(1),
            }),
            block(Terminator::Jump(edge(1))),
            block(Terminator::Exit(StateId(0))),
        ]);
        let plan = structure(&multiple_latches).unwrap();
        assert_eq!(plan.edges, 6);
        assert!(plan.backedges >= 2);

        // The inner loop exits to an outer-loop latch, while the outer header
        // can leave the complete region. This exercises nested continue and
        // break label scopes without duplicating MIR blocks.
        let nested_side_exits = control(vec![
            block(Terminator::Jump(edge(1))),
            block(Terminator::Branch {
                condition: 0,
                taken: edge(2),
                not_taken: edge(6),
            }),
            block(Terminator::Jump(edge(3))),
            block(Terminator::Branch {
                condition: 0,
                taken: edge(4),
                not_taken: edge(5),
            }),
            block(Terminator::Jump(edge(3))),
            block(Terminator::Jump(edge(1))),
            block(Terminator::Exit(StateId(0))),
        ]);
        let plan = structure(&nested_side_exits).unwrap();
        assert_eq!(plan.edges, 8);
        assert!(plan.backedges >= 2);
    }

    #[test]
    fn rejects_irreducible_and_multi_entry_graphs() {
        // 1<->2 is entered from both 0->1 and 0->2.
        let irreducible = control(vec![
            block(Terminator::Branch {
                condition: 0,
                taken: edge(1),
                not_taken: edge(2),
            }),
            block(Terminator::Jump(edge(2))),
            block(Terminator::Jump(edge(1))),
        ]);
        assert!(structure(&irreducible).is_none());

        let mut multi = control(vec![
            block(Terminator::Exit(StateId(0))),
            block(Terminator::Exit(StateId(0))),
        ]);
        multi.entries = vec![BlockId(0), BlockId(1)];
        assert!(structure(&multi).is_none());
    }
}
