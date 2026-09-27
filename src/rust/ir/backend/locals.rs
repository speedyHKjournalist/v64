//! Conservative typed interference allocation, including cold-exit StateMap references.
use crate::ir::{hir::*, ids::*, types::Type};
#[cfg(test)]
use std::collections::BTreeSet;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allocation {
    pub value_local: Vec<Option<usize>>,
    pub local_types: Vec<Type>,
}
/// Incremental cliques: pairs already present in the preceding live set are
/// already connected. Both allocators color ascending SSA IDs, so only the
/// lower-ID endpoint of each undirected edge can already own a local. Store
/// that edge once, in its higher-ID row, without allocating future-ID tails.
/// The symmetric representation is retained as a test oracle.
pub(crate) type Interference = InterferenceRows<true>;
pub(crate) struct InterferenceRows<const TRIANGULAR: bool> {
    rows: Vec<Vec<u64>>,
    last: Vec<usize>,
    generation: usize,
    words: usize,
}
impl<const TRIANGULAR: bool> InterferenceRows<TRIANGULAR> {
    pub(crate) fn new(values: usize) -> Self {
        Self {
            rows: vec![vec![]; values],
            last: vec![0; values],
            generation: 1,
            words: values.div_ceil(64),
        }
    }
    /// Charge the incremental algorithm actually executed by connect, rather
    /// than repeatedly charging old edges in otherwise identical live sets.
    pub(crate) fn connection_work_iter(
        &self,
        live: impl Iterator<Item = ValueId>,
        len: usize,
        scan_words: usize,
    ) -> usize {
        let added = live
            .filter(|v| self.last[v.index()] != self.generation)
            .count();
        // Dense sets also scan empty words. Include the accounting scan, outer
        // connection scan, each new-value inner scan and generation update.
        len.saturating_mul(added + 1)
            .saturating_add(scan_words.saturating_mul(added + 3))
    }
    fn insert(&mut self, a: usize, b: usize) {
        if self.rows[a].is_empty() {
            self.rows[a].resize(if TRIANGULAR { a.div_ceil(64) } else { self.words }, 0);
        }
        self.rows[a][b / 64] |= 1u64 << (b % 64);
    }
    #[cfg(test)]
    fn connect(&mut self, live: &BTreeSet<ValueId>, ty: impl Fn(ValueId) -> Type) {
        self.connect_iter(live.iter().copied(), ty);
    }
    pub(crate) fn connect_iter(
        &mut self,
        live: impl Iterator<Item = ValueId> + Clone,
        ty: impl Fn(ValueId) -> Type,
    ) {
        for a in live.clone() {
            if self.last[a.index()] == self.generation {
                continue;
            }
            for b in live.clone() {
                if a != b && ty(a) == ty(b) {
                    if TRIANGULAR {
                        self.insert(a.index().max(b.index()), a.index().min(b.index()));
                    }
                    else {
                        self.insert(a.index(), b.index());
                        self.insert(b.index(), a.index());
                    }
                }
            }
        }
        self.generation += 1;
        for a in live {
            self.last[a.index()] = self.generation;
        }
    }
    /// Private ascending-color query: only values below `value` may already
    /// have locals. HIR enumerates its value arena; owned MIR iterates LiveBits
    /// in ascending order. Do not use this triangular graph for another order.
    pub(crate) fn occupied(&self, value: usize, allocation: &Allocation) -> Vec<bool> {
        let mut occupied = vec![false; allocation.local_types.len()];
        for (word, &bits) in self.rows[value].iter().enumerate() {
            let mut bits = bits;
            while bits != 0 {
                let bit = bits.trailing_zeros() as usize;
                if let Some(slot) = allocation.value_local[word * 64 + bit] {
                    occupied[slot] = true;
                }
                bits &= bits - 1;
            }
        }
        occupied
    }
}

/// SSA IDs are dense and bounded by the region. Avoid a tree allocation for
/// every live value at every recovery point in the cold compiler. Iteration
/// remains ascending, preserving the existing deterministic graph coloring.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct LiveBits {
    words: Vec<u64>,
    len: usize,
}
#[derive(Clone)]
struct LiveBitIter<'a> {
    words: &'a [u64],
    word: usize,
    bits: u64,
}
impl Iterator for LiveBitIter<'_> {
    type Item = ValueId;
    fn next(&mut self) -> Option<ValueId> {
        loop {
            if self.bits != 0 {
                let bit = self.bits.trailing_zeros();
                self.bits &= self.bits - 1;
                return Some(ValueId(((self.word - 1) * 64) as u32 + bit));
            }
            self.bits = *self.words.get(self.word)?;
            self.word += 1;
        }
    }
}
pub(crate) trait LiveValues: Clone + PartialEq + Extend<ValueId> {
    fn new(values: usize) -> Self;
    fn len(&self) -> usize;
    fn values(&self) -> impl Iterator<Item = ValueId> + Clone;
    /// Additional empty-word scans beyond the charged value cardinality.
    fn scan_words(&self) -> usize { 0 }
    fn insert(&mut self, value: ValueId);
    fn remove(&mut self, value: &ValueId);
    fn contains(&self, value: &ValueId) -> bool;
    fn retain(&mut self, keep: impl FnMut(&ValueId) -> bool);
}
impl Extend<ValueId> for LiveBits {
    fn extend<I: IntoIterator<Item = ValueId>>(&mut self, values: I) {
        for value in values {
            self.insert(value);
        }
    }
}
impl LiveValues for LiveBits {
    fn new(values: usize) -> Self {
        Self {
            words: vec![0; values.div_ceil(64)],
            len: 0,
        }
    }
    fn len(&self) -> usize {
        self.len
    }
    fn values(&self) -> impl Iterator<Item = ValueId> + Clone {
        LiveBitIter {
            words: &self.words,
            word: 0,
            bits: 0,
        }
    }
    fn scan_words(&self) -> usize { self.words.len() }
    fn insert(&mut self, value: ValueId) {
        let word = &mut self.words[value.index() / 64];
        let bit = 1u64 << (value.index() % 64);
        self.len += usize::from(*word & bit == 0);
        *word |= bit;
    }
    fn remove(&mut self, value: &ValueId) {
        let word = &mut self.words[value.index() / 64];
        let bit = 1u64 << (value.index() % 64);
        self.len -= usize::from(*word & bit != 0);
        *word &= !bit;
    }
    fn contains(&self, value: &ValueId) -> bool {
        self.words[value.index() / 64] & (1u64 << (value.index() % 64)) != 0
    }
    fn retain(&mut self, mut keep: impl FnMut(&ValueId) -> bool) {
        for (index, word) in self.words.iter_mut().enumerate() {
            let mut bits = *word;
            while bits != 0 {
                let bit = bits.trailing_zeros();
                bits &= bits - 1;
                if !keep(&ValueId((index * 64) as u32 + bit)) {
                    *word &= !(1u64 << bit);
                    self.len -= 1;
                }
            }
        }
    }
}
// Keep the previous data structure as a test oracle for the identical solver,
// including loops, phi edges, cold StateMaps and deterministic slot assignment.
#[cfg(test)]
impl LiveValues for BTreeSet<ValueId> {
    fn new(_: usize) -> Self {
        Self::new()
    }
    fn len(&self) -> usize {
        self.len()
    }
    fn values(&self) -> impl Iterator<Item = ValueId> + Clone {
        self.iter().copied()
    }
    fn insert(&mut self, value: ValueId) {
        self.insert(value);
    }
    fn remove(&mut self, value: &ValueId) {
        self.remove(value);
    }
    fn contains(&self, value: &ValueId) -> bool {
        self.contains(value)
    }
    fn retain(&mut self, keep: impl FnMut(&ValueId) -> bool) {
        self.retain(keep);
    }
}
fn state_uses(region: &Region, state: Option<StateId>, live: &mut impl Extend<ValueId>) {
    if let Some(id) = state {
        live.extend(region.states[id.index()].values());
    }
}
fn term_uses<S: LiveValues>(region: &Region, block: &Block) -> S {
    let mut uses = S::new(region.values.len());
    match block.terminator.as_ref().unwrap() {
        Terminator::Exit(id) => state_uses(region, Some(*id), &mut uses),
        Terminator::CondBranch { condition, .. } => {
            uses.insert(*condition);
        },
        _ => (),
    }
    for edge in block.terminator.as_ref().unwrap().edges() {
        uses.extend(edge.args.iter().copied());
    }
    uses
}
pub fn allocate(region: &Region) -> Result<Allocation, &'static str> {
    allocate_bounded(region, 4_000_000)
}
/// Graph coloring is quadratic in simultaneously live values. Only tiny graphs
/// keep it (edge coalescing); ordinary and page-sized regions use linear-scan
/// intervals, measured ~13% cheaper per Tier-1 compile at +0.3% code size.
const INTERVAL_VALUES: usize = 128;
fn allocate_bounded(region: &Region, remaining: usize) -> Result<Allocation, &'static str> {
    if region.blocks.len() == 1
        && region.entries == vec![BlockId(0)]
        && matches!(region.blocks[0].terminator, Some(Terminator::Exit(_)))
    {
        return allocate_linear(region, remaining);
    }
    if region.values.len() > INTERVAL_VALUES {
        // Linear in the region size: a page-sized graph gets a matching budget.
        return allocate_intervals(region, remaining.max(64_000_000));
    }
    allocate_graph(region, remaining)
}
/// Block liveness from the shared bitset dataflow, then one conservative
/// interval per value over a global block-order numbering. A value live into
/// or out of a block covers that block boundary, so every value live at any
/// point overlaps every other value live there; intervals have no holes. The
/// per-instruction positions follow allocate_linear: uses at 2p+1, results at
/// 2p+2 (2p+1 for a committing access whose after-state may name its results).
fn allocate_intervals(region: &Region, mut remaining: usize) -> Result<Allocation, &'static str> {
    use std::{
        cmp::Reverse,
        collections::{BinaryHeap, HashMap},
    };
    let (inputs, outputs) = block_liveness::<LiveBits>(region, &mut remaining)?;
    let mut spend = |n: usize| -> Result<(), &'static str> {
        remaining = remaining
            .checked_sub(n)
            .ok_or("local liveness work budget")?;
        Ok(())
    };
    let values = region.values.len();
    let mut first = vec![usize::MAX; values];
    let mut last = vec![0usize; values];
    let mut touch = |value: ValueId, position: usize| {
        let i = value.index();
        first[i] = first[i].min(position);
        last[i] = last[i].max(position);
    };
    let mut base = 0usize;
    for (b, block) in region.blocks.iter().enumerate() {
        let start = base;
        let end = start + 2 * block.instructions.len() + 2;
        spend(block.instructions.len() + inputs[b].len() + outputs[b].len() + 1)?;
        for value in inputs[b].values() {
            touch(value, start);
        }
        for &value in &block.params {
            touch(value, start);
        }
        if let Some(state) = block.entry_state {
            for value in region.states[state.index()].values() {
                touch(value, start);
            }
        }
        for (p, id) in block.instructions.iter().enumerate() {
            let inst = &region.instructions[id.index()];
            let at = start + 2 * p;
            for &value in &inst.args {
                touch(value, at + 1);
            }
            for state in inst.state.into_iter().chain(inst.commit) {
                for value in region.states[state.index()].values() {
                    touch(value, at + 1);
                }
            }
            let definition = at + if inst.commit.is_some() { 1 } else { 2 };
            for &value in &inst.results {
                touch(value, definition);
            }
        }
        let terminal = end - 1;
        match block.terminator.as_ref().unwrap() {
            Terminator::Exit(id) => {
                for value in region.states[id.index()].values() {
                    touch(value, terminal);
                }
            },
            Terminator::CondBranch { condition, .. } => touch(*condition, terminal),
            Terminator::Branch(_) => {},
        }
        for edge in block.terminator.as_ref().unwrap().edges() {
            for &value in &edge.args {
                touch(value, terminal);
            }
        }
        for value in outputs[b].values() {
            touch(value, end);
        }
        base = end + 1;
    }
    let mut intervals: Vec<_> = (0..values)
        .filter(|&v| first[v] != usize::MAX && region.values[v].ty != Type::Effect)
        .map(|v| (first[v], last[v], v))
        .collect();
    spend(intervals.len() * 4 + 1)?;
    intervals.sort_unstable();
    let mut allocation = Allocation {
        value_local: vec![None; values],
        local_types: vec![],
    };
    let mut active = BinaryHeap::<Reverse<(usize, usize)>>::new();
    let mut free = HashMap::<Type, Vec<usize>>::new();
    for (start, end, value) in intervals {
        while active.peek().is_some_and(|Reverse((end, _))| *end < start) {
            let Reverse((_, slot)) = active.pop().unwrap();
            free.entry(allocation.local_types[slot])
                .or_default()
                .push(slot);
        }
        // Same peak-live policy as graph coloring: a wider frame is a stop.
        if active.len() >= 512 {
            return Err("local allocation work budget");
        }
        let ty = region.values[value].ty;
        let slot = free.get_mut(&ty).and_then(Vec::pop).unwrap_or_else(|| {
            let slot = allocation.local_types.len();
            allocation.local_types.push(ty);
            slot
        });
        allocation.value_local[value] = Some(slot);
        active.push(Reverse((end, slot)));
    }
    // Arena values outside every block (removed instructions or orphaned
    // parameters) are never executed; give them a legal typed local.
    for (value, definition) in region.values.iter().enumerate() {
        if definition.ty != Type::Effect && allocation.value_local[value].is_none() {
            let slot = allocation
                .local_types
                .iter()
                .position(|&ty| ty == definition.ty)
                .unwrap_or_else(|| {
                    let slot = allocation.local_types.len();
                    allocation.local_types.push(definition.ty);
                    slot
                });
            allocation.value_local[value] = Some(slot);
        }
    }
    Ok(allocation)
}
fn allocate_graph(region: &Region, remaining: usize) -> Result<Allocation, &'static str> {
    allocate_graph_with::<LiveBits>(region, remaining)
}
fn allocate_graph_with<S: LiveValues>(
    region: &Region,
    remaining: usize,
) -> Result<Allocation, &'static str> {
    allocate_graph_rows::<S, true>(region, remaining)
}
/// Backward block liveness: (live-in, live-out) per block, with block
/// parameters excluded from their predecessors' live-out sets.
fn block_liveness<S: LiveValues>(
    region: &Region,
    remaining: &mut usize,
) -> Result<(Vec<S>, Vec<S>), &'static str> {
    let mut spend = |amount: usize| -> Result<(), &'static str> {
        *remaining = remaining
            .checked_sub(amount)
            .ok_or("local liveness work budget")?;
        Ok(())
    };
    let n = region.blocks.len();
    // Summarize the backwards transfer once. Fixed-point rounds then visit
    // block live sets, rather than every instruction and recovery StateMap.
    // This is the same (out - definitions) union upward-exposed-uses equation;
    // block parameters remain in inputs for the existing edge substitution.
    let mut transfers = Vec::with_capacity(n);
    for block in &region.blocks {
        let mut uses = S::new(region.values.len());
        let mut definitions = S::new(region.values.len());
        spend(uses.scan_words().saturating_mul(3))?;
        for id in block.instructions.iter().rev() {
            let inst = &region.instructions[id.index()];
            for result in &inst.results {
                uses.remove(result);
                definitions.insert(*result);
            }
            uses.extend(inst.args.iter().copied());
            state_uses(region, inst.state, &mut uses);
            state_uses(region, inst.commit, &mut uses);
            spend(uses.len() + inst.results.len() + inst.args.len() + 1)?;
        }
        state_uses(region, block.entry_state, &mut uses);
        transfers.push((uses, definitions, term_uses::<S>(region, block)));
    }
    let empty = S::new(region.values.len());
    spend(empty.scan_words().saturating_mul(2 * n + 1))?;
    let mut inputs = vec![empty; n];
    let mut outputs = inputs.clone();
    loop {
        let mut changed = false;
        for b in (0..n).rev() {
            let block = &region.blocks[b];
            let (uses, definitions, terminal) = &transfers[b];
            // Clone terminal/output, retain, compare input, and iterate uses.
            spend(terminal.scan_words().saturating_mul(4) + uses.scan_words())?;
            let mut live = terminal.clone();
            for edge in block.terminator.as_ref().unwrap().edges() {
                spend(
                    inputs[edge.target.index()]
                        .len()
                        .saturating_mul(region.blocks[edge.target.index()].params.len() + 1)
                        .saturating_add(inputs[edge.target.index()].scan_words()),
                )?;
                live.extend(
                    inputs[edge.target.index()]
                        .values()
                        .filter(|v| !region.blocks[edge.target.index()].params.contains(v)),
                );
            }
            spend(live.len() + 1)?;
            outputs[b] = live.clone();
            spend(live.len() + uses.len() + definitions.len() + 1)?;
            live.retain(|v| !definitions.contains(v));
            live.extend(uses.values());
            if live != inputs[b] {
                inputs[b] = live;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    Ok((inputs, outputs))
}
fn allocate_graph_rows<S: LiveValues, const TRIANGULAR: bool>(
    region: &Region,
    mut remaining: usize,
) -> Result<Allocation, &'static str> {
    let (_, outputs) = block_liveness::<S>(region, &mut remaining)?;
    let mut spend = |amount: usize| -> Result<(), &'static str> {
        remaining = remaining
            .checked_sub(amount)
            .ok_or("local liveness work budget")?;
        Ok(())
    };
    let mut interference = InterferenceRows::<TRIANGULAR>::new(region.values.len());
    let mut work = 0usize;
    let mut connect = |live: &S| -> Result<(), &'static str> {
        work = work.saturating_add(interference.connection_work_iter(
            live.values(),
            live.len(),
            live.scan_words(),
        ));
        if live.len() > 512 || work > 2_000_000 {
            return Err("local allocation work budget");
        }
        interference.connect_iter(live.values(), |v| region.values[v.index()].ty);
        Ok(())
    };
    for (b, block) in region.blocks.iter().enumerate() {
        spend(outputs[b].scan_words())?;
        let mut live = outputs[b].clone();
        connect(&live)?;
        for id in block.instructions.iter().rev() {
            let inst = &region.instructions[id.index()];
            live.extend(inst.results.iter().copied());
            connect(&live)?;
            for result in &inst.results {
                live.remove(result);
            }
            live.extend(inst.args.iter().copied());
            state_uses(region, inst.state, &mut live);
            state_uses(region, inst.commit, &mut live);
            connect(&live)?;
        }
        state_uses(region, block.entry_state, &mut live);
        live.extend(block.params.iter().copied());
        connect(&live)?;
    }
    let mut allocation = Allocation {
        value_local: vec![None; region.values.len()],
        local_types: vec![],
    };
    for (i, value) in region.values.iter().enumerate() {
        if value.ty == Type::Effect {
            continue;
        }
        let occupied = interference.occupied(i, &allocation);
        let slot = allocation
            .local_types
            .iter()
            .enumerate()
            .find(|(i, ty)| **ty == value.ty && !occupied[*i])
            .map(|(i, _)| i)
            .unwrap_or_else(|| {
                let i = allocation.local_types.len();
                allocation.local_types.push(value.ty);
                i
            });
        allocation.value_local[i] = Some(slot);
    }
    Ok(allocation)
}

/// Straight-line SSA has exact definition/last-use intervals. Include every
/// before/after recovery operand, not merely normal dataflow. Two positions per
/// instruction allow normal results to reuse dying pre-call snapshot slots only
/// after the emitter has staged returns and checked the fault outcome.
/// The independent owned-MIR verifier still checks all live-set interference.
fn allocate_linear(region: &Region, mut remaining: usize) -> Result<Allocation, &'static str> {
    use std::{
        cmp::Reverse,
        collections::{BinaryHeap, HashMap},
    };
    let mut spend = |n: usize| -> Result<(), &'static str> {
        remaining = remaining
            .checked_sub(n)
            .ok_or("local liveness work budget")?;
        Ok(())
    };
    let block = &region.blocks[0];
    spend(region.values.len() + block.instructions.len() + 1)?;
    let mut first = vec![None; region.values.len()];
    let mut last = vec![0; region.values.len()];
    for &value in &block.params {
        first[value.index()] = Some(0);
    }
    for (position, id) in block.instructions.iter().enumerate() {
        let inst = &region.instructions[id.index()];
        // A committing access's after-state can reference its own results while
        // the before-state and address remain live. Keep that overlap intact.
        let definition = position * 2 + if inst.commit.is_some() { 1 } else { 2 };
        for value in &inst.results {
            first[value.index()] = Some(definition);
            last[value.index()] = definition;
        }
    }
    let mut observe = |value: ValueId, position: usize| -> Result<(), &'static str> {
        spend(1)?;
        if region.values[value.index()].ty == Type::Effect {
            return Ok(());
        }
        if first[value.index()].is_none_or(|start| start > position) {
            return Err("invalid linear allocation use");
        }
        last[value.index()] = last[value.index()].max(position);
        Ok(())
    };
    if let Some(state) = block.entry_state {
        for value in region.states[state.index()].values() {
            observe(value, 0)?;
        }
    }
    for (position, id) in block.instructions.iter().enumerate() {
        let inst = &region.instructions[id.index()];
        for &value in &inst.args {
            observe(value, position * 2 + 1)?;
        }
        for state in inst.state.into_iter().chain(inst.commit) {
            for value in region.states[state.index()].values() {
                observe(value, position * 2 + 1)?;
            }
        }
    }
    let Terminator::Exit(state) = block.terminator.as_ref().unwrap() else {
        unreachable!()
    };
    for value in region.states[state.index()].values() {
        observe(value, block.instructions.len() * 2 + 1)?;
    }
    let mut intervals: Vec<_> = first
        .iter()
        .enumerate()
        .filter_map(|(value, &start)| {
            start
                .filter(|_| region.values[value].ty != Type::Effect)
                .map(|start| (start, last[value], value))
        })
        .collect();
    intervals.sort_unstable();
    let mut allocation = Allocation {
        value_local: vec![None; region.values.len()],
        local_types: vec![],
    };
    let mut active = BinaryHeap::<Reverse<(usize, usize)>>::new();
    let mut free = HashMap::<Type, Vec<usize>>::new();
    for (start, end, value) in intervals {
        while active.peek().is_some_and(|Reverse((end, _))| *end < start) {
            let Reverse((_, slot)) = active.pop().unwrap();
            free.entry(allocation.local_types[slot])
                .or_default()
                .push(slot);
        }
        if active.len() >= 4096 {
            return Err("local allocation work budget");
        }
        let ty = region.values[value].ty;
        let slot = free.get_mut(&ty).and_then(Vec::pop).unwrap_or_else(|| {
            let slot = allocation.local_types.len();
            allocation.local_types.push(ty);
            slot
        });
        allocation.value_local[value] = Some(slot);
        active.push(Reverse((end, slot)));
    }
    // Removed arena instructions are never executed but still have typed plans.
    // Give their dead values a legal local without extending any live interval.
    for (value, definition) in region.values.iter().enumerate() {
        if definition.ty != Type::Effect && allocation.value_local[value].is_none() {
            let slot = allocation
                .local_types
                .iter()
                .position(|&ty| ty == definition.ty)
                .unwrap_or_else(|| {
                    let slot = allocation.local_types.len();
                    allocation.local_types.push(definition.ty);
                    slot
                });
            allocation.value_local[value] = Some(slot);
        }
    }
    Ok(allocation)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_dense_sets_charge_empty_word_scans() {
        let mut bits = LiveBits::new(16_384);
        let graph = Interference::new(16_384);
        assert_eq!(bits.scan_words(), 256);
        assert_eq!(
            graph.connection_work_iter(bits.values(), bits.len(), bits.scan_words()),
            3 * 256,
        );
        bits.insert(ValueId(16_383));
        assert_eq!(bits.values().collect::<Vec<_>>(), [ValueId(16_383)]);
        assert_eq!(
            graph.connection_work_iter(bits.values(), bits.len(), bits.scan_words()),
            2 + 4 * 256,
        );
    }
    #[test]
    fn dense_liveness_matches_tree_sets_and_coloring() {
        let mut bits = LiveBits::new(1031);
        let mut tree = BTreeSet::new();
        let mut seed = 47u32;
        for step in 0..4096 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let value = ValueId(seed % 1031);
            if step % 3 == 0 {
                bits.remove(&value);
                tree.remove(&value);
            } else {
                bits.insert(value);
                tree.insert(value);
            }
            if step % 97 == 0 {
                bits.retain(|v| v.0 % 7 != 0);
                tree.retain(|v| v.0 % 7 != 0);
            }
            assert_eq!(bits.len(), tree.len());
            assert_eq!(bits.contains(&value), tree.contains(&value));
            assert!(bits.values().eq(tree.iter().copied()));
        }
        use crate::ir::frontend::{
            decode::{GuestEip, LinearAddress},
            region::lift_cpu_cfg,
        };
        // Loops, diamonds, irreducible edges, lazy flags, RMW recovery, vector
        // values and observer reloads exercise cross-block and cold liveness.
        let programs: &[&[u8]] = &[
            &[0x40, 0x49, 0x75, 0xFC],
            &[0x03, 0x06, 0x49, 0x75, 0xFB],
            &[0x66, 0x0F, 0xEF, 0xC1, 0xE2, 0xFA],
            &[0x74, 0x02, 0x75, 0x02, 0x40, 0x90, 0x48, 0x90],
            &[0x74, 0x02, 0xEB, 0x02, 0xEB, 0xFC, 0xEB, 0xFC],
            &[0x11, 0xD8, 0x19, 0xD1, 0x40, 0x49, 0x75, 0xF8],
            &[0xFF, 0x06, 0x8B, 0x06, 0x49, 0x75, 0xF9],
            &[0xEC, 0x43, 0x49, 0x75, 0xFB],
            &[0x0F, 0x31, 0x43, 0x49, 0x75, 0xFA],
        ];
        for (index, bytes) in programs.iter().enumerate() {
            for mode in [false, true] {
                // These encodings use [ESI], while 16-bit ModRM 06 consumes a
                // displacement and would make the deliberately short loop invalid.
                if !mode && matches!(index, 1 | 6) { continue; }
                let original =
                    lift_cpu_cfg(bytes, GuestEip(0x1000), LinearAddress(0x201000), mode, 8)
                        .unwrap();
                for pass in [
                    None,
                    Some(crate::ir::passes::PassConfig::tier1()),
                    Some(crate::ir::passes::PassConfig::default()),
                ] {
                    let mut region = original.clone();
                    if let Some(pass) = pass {
                        crate::ir::passes::run(&mut region, pass).unwrap();
                    }
                    let dense = allocate_graph_with::<LiveBits>(&region, 4_000_000);
                    let reference = allocate_graph_rows::<BTreeSet<ValueId>, false>(&region, 4_000_000);
                    let symmetric = allocate_graph_rows::<LiveBits, false>(&region, 4_000_000);
                    assert_eq!(dense, reference, "mode={mode}, bytes={bytes:x?}");
                    assert_eq!(dense, symmetric, "triangular/symmetric: mode={mode}, bytes={bytes:x?}");
                    assert_eq!(
                        allocate_graph_with::<LiveBits>(&region, 1),
                        allocate_graph_with::<BTreeSet<ValueId>>(&region, 1)
                    );
                    crate::ir::lowering::lower(&region)
                        .unwrap()
                        .verify()
                        .unwrap();
                }
            }
        }
    }

    #[test]
    #[ignore = "allocator timing only, not an XP performance gate"]
    fn graph_allocation_paired_benchmark() {
        use crate::ir::frontend::{
            decode::{GuestEip, LinearAddress},
            region::lift_cpu_cfg,
        };
        for size in [8, 32, 64] {
            let mut bytes = vec![0x40; size];
            bytes.extend([0x49, 0x75, (-(size as i32 + 3)) as u8]);
            let region = lift_cpu_cfg(&bytes, GuestEip(0), LinearAddress(0), true, 8).unwrap();
            let mut samples = [vec![], vec![]];
            for round in 0..7 {
                for which in [round % 2, 1 - round % 2] {
                    let start = std::time::Instant::now();
                    for _ in 0..20 {
                        let result = if which == 0 {
                            allocate_graph_rows::<LiveBits, false>(&region, 4_000_000)
                        } else {
                            allocate_graph_with::<LiveBits>(&region, 4_000_000)
                        };
                        std::hint::black_box(result.unwrap());
                    }
                    samples[which].push(start.elapsed().as_secs_f64() * 1e6 / 20.0);
                }
            }
            for sample in &mut samples {
                sample.sort_by(f64::total_cmp);
            }
            println!(
                "{size} instructions: symmetric {:.1} us, triangular {:.1} us",
                samples[0][3], samples[1][3]
            );
        }
    }
    #[test]
    fn liveness_has_a_bounded_failure_path() {
        use crate::ir::frontend::{
            decode::{GuestEip, LinearAddress},
            lift::lift_cpu,
        };
        let region = lift_cpu(&[0x40, 0x43], GuestEip(0), LinearAddress(0), true).unwrap();
        assert_eq!(
            allocate_bounded(&region, 1).unwrap_err(),
            "local liveness work budget"
        );
        assert!(allocate(&region).is_ok());
    }
    #[test]
    fn linear_intervals_preserve_cold_uses_and_typed_results() {
        use crate::ir::frontend::{
            decode::{GuestEip, LinearAddress},
            lift::lift_cpu,
        };
        for bytes in [
            vec![0x40; 96],
            vec![0x8B, 0x06, 0x40, 0x89, 0x06],
            vec![0xF0, 0x01, 0x06],
            vec![0x0F, 0x31, 0x40],
            vec![0xEC, 0x43],
            vec![0x66, 0x0F, 0xEF, 0xC0, 0x40],
        ] {
            let mut region =
                lift_cpu(&bytes, GuestEip(0x1000), LinearAddress(0x1000), true).unwrap();
            for optimized in [false, true] {
                if optimized {
                    crate::ir::passes::run(&mut region, crate::ir::passes::PassConfig::tier1())
                        .unwrap();
                }
                let fast = allocate_linear(&region, 4_000_000).unwrap();
                let reference = allocate_graph(&region, 4_000_000).unwrap();
                assert!(fast.local_types.len() <= reference.local_types.len() + 16);
                // Independently verifies dominance, hidden recovery uses,
                // simultaneous live locals and helper normal-result ownership.
                crate::ir::lowering::lower(&region)
                    .unwrap()
                    .verify()
                    .unwrap();
            }
        }
    }
    /// Opt-in allocator-only microbenchmark; never a host-dependent CI gate.
    #[test]
    #[ignore]
    fn linear_allocation_paired_benchmark() {
        use crate::ir::frontend::{
            decode::{GuestEip, LinearAddress},
            lift::lift_cpu,
        };
        for size in [16, 32, 96] {
            let region = lift_cpu(&vec![0x40; size], GuestEip(0), LinearAddress(0), true).unwrap();
            let mut timings = [Vec::new(), Vec::new()];
            for round in 0..7 {
                for index in [round % 2, 1 - round % 2] {
                    let start = std::time::Instant::now();
                    for _ in 0..40 {
                        let allocation = if index == 0 {
                            allocate_graph(&region, 4_000_000)
                        } else {
                            allocate_linear(&region, 4_000_000)
                        }
                        .unwrap();
                        std::hint::black_box(allocation);
                    }
                    timings[index].push(start.elapsed().as_secs_f64() * 1e6 / 40.0);
                }
            }
            for times in &mut timings {
                times.sort_by(f64::total_cmp);
            }
            println!("{size} instructions: graph {:.1} us, intervals {:.1} us (paired median, allocation only)",
                timings[0][3], timings[1][3]);
        }
    }
    #[test]
    fn triangular_rows_preserve_far_values_types_and_reentry() {
        let n = 16_384;
        let mut triangular = Interference::new(n);
        let mut symmetric = InterferenceRows::<false>::new(n);
        let types: Vec<_> = (0..n).map(|i| if i % 3 == 0 { Type::I64 } else { Type::I32 }).collect();
        let cases: &[&[u32]] = &[
            &[0, 1, 63, 64, 65, 4095, 4096, 8192, 16383],
            &[0, 1, 64, 4095, 8192], &[1, 63, 65, 4096, 16383], &[],
            &[1, 4095, 4096], &[0, 1, 63, 64, 65, 4095, 4096, 8192, 16383],
        ];
        for case in cases.iter().cycle().take(48) {
            let live: BTreeSet<_> = case.iter().copied().map(ValueId).collect();
            triangular.connect(&live, |v| types[v.index()]);
            symmetric.connect(&live, |v| types[v.index()]);
            let mut allocation = Allocation { value_local: vec![None; n], local_types: types.clone() };
            for &value in cases[0] {
                assert_eq!(triangular.occupied(value as usize, &allocation), symmetric.occupied(value as usize, &allocation));
                allocation.value_local[value as usize] = Some(value as usize);
            }
        }
        for (value, row) in triangular.rows.iter().enumerate() {
            assert!(row.len() <= value.div_ceil(64));
        }
        assert!(triangular.rows[0].is_empty());
        let triangular_words: usize = triangular.rows.iter().map(Vec::len).sum();
        let symmetric_words: usize = symmetric.rows.iter().map(Vec::len).sum();
        assert!(triangular_words * 2 < symmetric_words);
    }
    #[test]
    fn incremental_interference_matches_full_cliques() {
        let n = 137;
        let mut graph = Interference::new(n);
        let mut reference = vec![BTreeSet::new(); n];
        let types: Vec<_> = (0..n)
            .map(|i| if i % 3 == 0 { Type::I64 } else { Type::I32 })
            .collect();
        let mut rng = 17u32;
        let mut live = BTreeSet::new();
        for step in 0..2000 {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            let value = ValueId(rng % n as u32);
            if step % 37 == 0 {
                live.clear();
            }
            if step % 3 == 0 {
                live.remove(&value);
            } else {
                live.insert(value);
            }
            graph.connect(&live, |v| types[v.index()]);
            for &a in &live {
                for &b in &live {
                    if a != b && types[a.index()] == types[b.index()] {
                        reference[a.index()].insert(b);
                    }
                }
            }
        }
        let mut allocation = Allocation {
            value_local: vec![None; n],
            local_types: types,
        };
        for i in 0..n {
            let actual = graph.occupied(i, &allocation);
            for j in 0..n {
                assert_eq!(
                    actual[j],
                    j < i && reference[i].contains(&ValueId(j as u32)),
                    "{i}/{j}"
                );
                let (row, bit) = (i.max(j), i.min(j));
                let edge = graph.rows[row].get(bit / 64).is_some_and(|word| word & (1u64 << (bit % 64)) != 0);
                assert_eq!(edge, reference[i].contains(&ValueId(j as u32)), "undirected edge {i}/{j}");
            }
            allocation.value_local[i] = Some(i);
        }
    }
}
