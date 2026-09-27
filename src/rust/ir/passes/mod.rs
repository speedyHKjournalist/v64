//! Bounded, verifier-checked pure dataflow passes. Memory and helpers never enter GVN.
use super::{hir::*, ids::*};
use std::collections::HashSet;
pub mod copy;
mod gvn;
pub mod licm;
mod merge;
mod prune;
pub mod scalar;
pub mod sccp;
pub mod simd;
#[derive(Clone, Copy)]
pub struct PassConfig {
    pub debug: super::debug::Config,
    /// Stable public pass-disable mask; base HIR flags are also cleared by disable().
    pub disabled: u32,
    pub prune: bool,
    pub merge: bool,
    pub phis: bool,
    pub copy: bool,
    pub fold: bool,
    /// CPU-only per-flag demand/liveness after exact backing lowering.
    pub flags: bool,
    /// Region-wide backing-state facts for exit-write elision; disabled, only
    /// entry-equivalence certificates already derived during lowering apply.
    pub state_sync: bool,
    /// Trim pre-call CPU StateMap observations for audited pure helpers.
    pub helper_state: bool,
    pub gvn: bool,
    pub dce: bool,
    pub rounds: usize,
}
impl Default for PassConfig {
    fn default() -> Self {
        Self {
            debug: Default::default(),
            disabled: 0,
            prune: true,
            merge: true,
            phis: true,
            copy: true,
            fold: true,
            flags: true,
            state_sync: true,
            helper_state: true,
            gvn: true,
            dce: true,
            rounds: 2,
        }
    }
}
impl PassConfig {
    /// Bit 18: loop-header budget polls in non-fused regions (sparse_polls).
    pub const SPARSE_POLLS: u32 = 18;
    pub const MASK: u32 = (1 << 19) - 1;
    pub fn enabled(&self, bit: u32) -> bool { self.disabled & (1 << bit) == 0 }
    pub fn disable(mut self, mask: u32) -> Self {
        self.disabled |= mask;
        self.prune &= self.enabled(0);
        self.merge &= self.enabled(1);
        self.phis &= self.enabled(2);
        self.copy &= self.enabled(3);
        self.fold &= self.enabled(4);
        self.flags &= self.enabled(5);
        self.helper_state &= self.enabled(6);
        self.gvn &= self.enabled(7);
        self.dce &= self.enabled(8);
        self
    }
    /// Low-latency Tier-1 canonicalization plus CPU demand from exact recovery
    /// plans and backing-state write elision. Global value dataflow, helper
    /// observation trimming and loop motion remain Tier 2.
    pub fn tier1() -> Self {
        Self {
            debug: Default::default(),
            disabled: Self::MASK & !(((1 << 9) - 1) | (1 << 13) | (1 << Self::SPARSE_POLLS)),
            prune: true,
            merge: true,
            phis: true,
            copy: true,
            fold: false,
            flags: true,
            // Region-wide backing facts remove exit writes of unchanged state;
            // they are cheaper than emitting and compiling those writes.
            state_sync: true,
            helper_state: false,
            gvn: false,
            dce: false,
            rounds: 1,
        }
    }
}
#[derive(Default, Debug)]
pub struct PassStats {
    pub branches: usize,
    pub unreachable: usize,
    pub cross_commoned: usize,
    pub merged: usize,
    pub phis: usize,
    pub copied: usize,
    pub folded: usize,
    pub commoned: usize,
    pub removed: usize,
    pub loop_hoisted: usize,
    pub ram_forwarded: usize,
    pub ram_guards_reused: usize,
    pub budget_batches: usize,
    pub state_writes_elided: usize,
    pub helper_states_elided: usize,
    pub cpu_values_elided: usize,
    pub simd_eliminated: usize,
    pub simd_shuffled: usize,
    pub scalar_aliases: usize,
    pub scalar_constants: usize,
    pub sccp_constants: usize,
    pub sccp_parameters: usize,
}
/// Absolute HIR arena caps shared by all passes. Page regions (the frontend's
/// CfgLimits::PAGE) stay below them; every pass also keeps its own work limit.
pub(crate) const MAX_BLOCKS: usize = 1024;
pub(crate) const MAX_INSTRUCTIONS: usize = 65536;
pub(crate) const MAX_VALUES: usize = 131072;
pub(crate) const MAX_STATES: usize = 65536;
pub fn run(region: &mut Region, config: PassConfig) -> Result<PassStats, String> {
    let config = config.disable(config.disabled);
    config.debug.check_hir(region, true)?;
    if config.rounds > 8 {
        return Err("pass iteration budget exceeded".into());
    }
    let mut stats = PassStats::default();
    for _ in 0..config.rounds {
        if config.merge {
            merge::run(region, &mut stats)?;
            config.debug.check_hir(region, false)?;
        }
        if config.phis {
            trivial_phis(region, &mut stats);
            config.debug.check_hir(region, false)?;
        }
        if config.copy {
            let copies = copy::run(region, copy::DEFAULT_WORK_LIMIT)?;
            stats.copied += copies.propagated;
            stats.scalar_aliases += copies.propagated;
            config.debug.check_hir(region, false)?;
        }
        if config.fold {
            let scalar = scalar::run_constants(region, scalar::DEFAULT_WORK_LIMIT)?;
            stats.scalar_constants += scalar.constants;
            config.debug.check_hir(region, false)?;
            fold(region, &mut stats);
            let vector = simd::run(region, simd::DEFAULT_WORK_LIMIT)?;
            stats.simd_eliminated += vector.eliminated;
            stats.simd_shuffled += vector.shuffled;
            config.debug.check_hir(region, false)?;
        }
        // Executable-edge facts require folding, phi analysis AND permission
        // to prune control flow. Do not silently bypass a disabled pass family.
        if config.fold && config.phis && config.prune {
            let propagated = sccp::run(region, sccp::DEFAULT_WORK_LIMIT)?;
            stats.sccp_constants += propagated.constants;
            stats.sccp_parameters += propagated.parameters;
            stats.branches += propagated.branches;
            stats.unreachable += propagated.unreachable;
        }
        if config.prune {
            prune::run(region, &mut stats)?;
            config.debug.check_hir(region, false)?;
        }
        if config.gvn {
            gvn::run(region, &mut stats)?;
            config.debug.check_hir(region, false)?;
        }
        if config.dce {
            dce(region, &mut stats);
            config.debug.check_hir(region, false)?;
        }
    }
    config.debug.check_hir(region, true)?;
    Ok(stats)
}
fn constant(region: &Region, value: ValueId) -> Option<u64> {
    match region.values[value.index()].definition {
        Definition::Instruction(id, _) => match region.instructions[id.index()].op {
            Op::Const(n) => Some(n),
            _ => None,
        },
        _ => None,
    }
}
/// Shared integer semantics for literal folding and executable-edge analysis.
/// The callers verify arity/types and restrict replacements to pure results.
fn evaluate_integer(region: &Region, inst: &Instruction, args: &[u64]) -> Option<u64> {
    let bits = region.values[inst.results[0].index()].ty.bits()?;
    let input_bits = inst
        .args
        .first()
        .and_then(|v| region.values[v.index()].ty.bits())
        .unwrap_or(bits);
    let mask = if bits == 64 { u64::MAX } else { (1u64 << bits) - 1 };
    let signed = |v: u64| ((v << (64 - input_bits)) as i64) >> (64 - input_bits);
    let value = match inst.op {
        Op::Const(n) => n,
        Op::Binary(op) => match op {
            Binary::Add => args[0].wrapping_add(args[1]),
            Binary::Sub => args[0].wrapping_sub(args[1]),
            Binary::Mul => args[0].wrapping_mul(args[1]),
            Binary::And => args[0] & args[1],
            Binary::Or => args[0] | args[1],
            Binary::Xor => args[0] ^ args[1],
            Binary::Shl => {
                args[0].wrapping_shl((args[1] & if bits == 64 { 63 } else { 31 }) as u32)
            },
            Binary::Shr => args[0] >> (args[1] & if bits == 64 { 63 } else { 31 }),
            Binary::Sar => (signed(args[0]) >> (args[1] & if bits == 64 { 63 } else { 31 })) as u64,
            Binary::Eq => (args[0] == args[1]) as u64,
            Binary::Ult => (args[0] < args[1]) as u64,
            Binary::Slt => (signed(args[0]) < signed(args[1])) as u64,
        },
        Op::CountLeadingZeros => {
            if bits == 64 {
                args[0].leading_zeros() as u64
            }
            else {
                (args[0] as u32).leading_zeros() as u64
            }
        },
        Op::CountTrailingZeros => {
            if bits == 64 {
                args[0].trailing_zeros() as u64
            }
            else {
                (args[0] as u32).trailing_zeros() as u64
            }
        },
        Op::PopulationCount => args[0].count_ones() as u64,
        Op::Select => {
            if args[0] != 0 {
                args[1]
            }
            else {
                args[2]
            }
        },
        Op::Extend { signed: true } => signed(args[0]) as u64,
        Op::Extend { signed: false } | Op::Truncate => args[0],
        Op::Extract { lsb } => args[0] >> lsb,
        Op::Insert { lsb } => {
            let width = region.values[inst.args[1].index()].ty.bits().unwrap();
            let part = if width == 64 { u64::MAX } else { ((1u64 << width) - 1) << lsb };
            (args[0] & !part) | args[1] << lsb
        },
        _ => return None,
    } & mask;
    Some(value)
}
fn fold(region: &mut Region, stats: &mut PassStats) {
    for block in region.blocks.clone() {
        for id in block.instructions {
            let inst = &region.instructions[id.index()];
            if inst.results.len() != 1 || inst.op.ordered() || matches!(inst.op, Op::Const(_)) {
                continue;
            }
            let args: Option<Vec<_>> = inst.args.iter().map(|&v| constant(region, v)).collect();
            let Some(args) = args
            else {
                continue;
            };
            let Some(value) = evaluate_integer(region, inst, &args)
            else {
                continue;
            };
            let inst = &mut region.instructions[id.index()];
            inst.op = Op::Const(value);
            inst.args.clear();
            stats.folded += 1;
        }
    }
}
fn replace(region: &mut Region, old: ValueId, new: ValueId) {
    rewrite_values(region, |v| {
        if *v == old {
            *v = new;
        }
    });
}
fn rewrite_values(region: &mut Region, replace: impl Fn(&mut ValueId)) {
    for inst in &mut region.instructions {
        for arg in &mut inst.args {
            replace(arg);
        }
    }
    for state in &mut region.states {
        for value in &mut state.gpr {
            replace(value);
        }
        for value in &mut state.flags.arithmetic {
            replace(value);
        }
        replace(&mut state.flags.system);
        if let Some(value) = &mut state.flags.last_op1 {
            replace(value);
        }
        if let Some(value) = &mut state.flags.raw_zero {
            replace(value);
        }
        if let Some(value) = &mut state.flags.zero_is_lazy {
            replace(value);
        }
        for value in [
            &mut state.flags.raw_flags,
            &mut state.flags.lazy_mask,
            &mut state.flags.last_result,
            &mut state.flags.last_op_size,
            &mut state.flags.backing_valid,
        ] {
            if let Some(value) = value {
                replace(value);
            }
        }
        if let Some(value) = &mut state.count_base {
            replace(value);
        }
        if let Some(value) = &mut state.next_value {
            replace(value);
        }
        for value in state.xmm.iter_mut().chain(&mut state.x87) {
            replace(value);
        }
        if let Some(rep) = &mut state.rep_progress {
            for value in rep {
                replace(value);
            }
        }
    }
    for block in &mut region.blocks {
        if let Some(term) = &mut block.terminator {
            if let Terminator::CondBranch { condition, .. } = term {
                replace(condition);
            }
            for edge in term.edges_mut() {
                for arg in &mut edge.args {
                    replace(arg);
                }
            }
        }
    }
}
/// Page functions poll only at loop headers (MIR sparse polls). Remove the
/// per-instruction and merged-boundary PollBudget operations: each carried a
/// cold full-state exit. Their recovery maps stay available to the other
/// operations that reference them; the effect chain skips the removed nodes.
/// Exact sparse budget accounting for non-fused regions. A block's weight
/// bounds the guest instructions it starts: its PollBudget count plus one for a
/// recovery map (the per-instruction scheme's block-entry credit). Poll points
/// are loop headers and the entry frontier (first weighted block reached from
/// an entry). Control lowering charges each with the longest weighted path to
/// the next poll point and exits before it when the remaining budget cannot
/// cover it; a frontier block without a recovery map (an entry) keeps its first
/// PollBudget, before any of its instructions, as that check. Retirement thus
/// stays within the budget without an exit per instruction. A region with a
/// poll point costing more than `budget` keeps per-instruction polls (None,
/// unchanged): it could never make progress on a fresh budget.
pub fn sparse_polls(region: &mut Region, budget: u32) -> Option<usize> {
    use crate::ir::mir::control::{back_edge_targets, entry_frontier, longest_guest_paths};
    let n = region.blocks.len();
    let successors = |b: usize| -> Vec<usize> {
        region.blocks[b]
            .terminator
            .as_ref()
            .map(|t| t.edges().iter().map(|e| e.target.index()).collect())
            .unwrap_or_default()
    };
    let weight: Vec<u32> = region
        .blocks
        .iter()
        .map(|block| {
            block
                .instructions
                .iter()
                .filter(|id| region.instructions[id.index()].op == Op::PollBudget)
                .count() as u32
                + u32::from(block.entry_state.is_some())
        })
        .collect();
    let headers = back_edge_targets(&region.entries, n, successors);
    let frontier = entry_frontier(&region.entries, n, &headers, successors, |b| weight[b]);
    let longest = longest_guest_paths(n, &headers, successors, |b| weight[b])?;
    if (0..n).any(|b| (frontier[b] || headers[b]) && longest[b] > budget) {
        return None;
    }
    let mut aliases: Vec<Option<ValueId>> = vec![None; region.values.len()];
    let mut removed = 0;
    for b in 0..n {
        let keep_first = frontier[b] && region.blocks[b].entry_state.is_none();
        let instructions = &region.instructions;
        let mut kept = false;
        region.blocks[b].instructions.retain(|id| {
            let inst = &instructions[id.index()];
            if inst.op != Op::PollBudget {
                return true;
            }
            if keep_first && !kept {
                kept = true;
                return true;
            }
            aliases[inst.results[0].index()] = Some(inst.args[0]);
            removed += 1;
            false
        });
        region.blocks[b].budget = weight[b];
    }
    if removed != 0 {
        let resolve = |mut value: ValueId| {
            while let Some(next) = aliases[value.index()] {
                value = next;
            }
            value
        };
        rewrite_values(region, |v| *v = resolve(*v));
    }
    Some(removed)
}
pub fn strip_polls(region: &mut Region) -> usize {
    let mut aliases: Vec<Option<ValueId>> = vec![None; region.values.len()];
    let mut removed = 0;
    for b in 0..region.blocks.len() {
        let instructions = &region.instructions;
        region.blocks[b].instructions.retain(|id| {
            let inst = &instructions[id.index()];
            if inst.op == Op::PollBudget {
                aliases[inst.results[0].index()] = Some(inst.args[0]);
                removed += 1;
                false
            }
            else {
                true
            }
        });
    }
    if removed != 0 {
        let resolve = |mut value: ValueId| {
            while let Some(next) = aliases[value.index()] {
                value = next;
            }
            value
        };
        rewrite_values(region, |v| *v = resolve(*v));
    }
    removed
}
fn dce(region: &mut Region, stats: &mut PassStats) {
    let mut live = HashSet::new();
    let mut work = Vec::new();
    for block in &region.blocks {
        if let Some(id) = block.entry_state {
            work.extend(region.states[id.index()].values());
        }
        let term = block.terminator.as_ref().unwrap();
        if let Terminator::Exit(id) = term {
            work.extend(region.states[id.index()].values());
        }
        if let Terminator::CondBranch { condition, .. } = term {
            work.push(*condition);
        }
        for edge in term.edges() {
            work.extend(&edge.args);
        }
        for id in &block.instructions {
            let inst = &region.instructions[id.index()];
            if inst.op.ordered() || inst.state.is_some() {
                live.insert(*id);
                work.extend(&inst.args);
                for id in [inst.state, inst.commit].into_iter().flatten() {
                    work.extend(region.states[id.index()].values());
                }
            }
        }
    }
    while let Some(value) = work.pop() {
        if let Definition::Instruction(id, _) = region.values[value.index()].definition {
            if live.insert(id) {
                work.extend(&region.instructions[id.index()].args);
            }
        }
    }
    for block in &mut region.blocks {
        let before = block.instructions.len();
        block.instructions.retain(|id| live.contains(id));
        stats.removed += before - block.instructions.len();
    }
}

fn trivial_phis(region: &mut Region, stats: &mut PassStats) {
    // A parameter is trivial when every incoming argument other than itself
    // resolves to one value. Collect all such aliases to a fixed point, then
    // rewrite the arenas and drop the parameters/arguments once.
    let n = region.blocks.len();
    let mut incoming: Vec<Vec<(usize, usize)>> = vec![vec![]; n];
    for (a, block) in region.blocks.iter().enumerate() {
        for (k, edge) in block.terminator.as_ref().unwrap().edges().into_iter().enumerate() {
            incoming[edge.target.index()].push((a, k));
        }
    }
    fn arg(region: &Region, (a, k): (usize, usize), p: usize) -> ValueId {
        match region.blocks[a].terminator.as_ref().unwrap() {
            Terminator::Branch(edge) => edge.args[p],
            Terminator::CondBranch {
                taken, not_taken, ..
            } => {
                if k == 0 {
                    taken.args[p]
                }
                else {
                    not_taken.args[p]
                }
            },
            Terminator::Exit(_) => unreachable!(),
        }
    }
    let mut aliases: Vec<Option<ValueId>> = vec![None; region.values.len()];
    let resolve = |aliases: &[Option<ValueId>], mut value: ValueId| {
        while let Some(next) = aliases[value.index()] {
            value = next;
        }
        value
    };
    let mut removed: Vec<Vec<bool>> = region.blocks.iter().map(|b| vec![false; b.params.len()]).collect();
    let mut count = 0;
    loop {
        let mut changed = false;
        for b in 0..n {
            if region.entries.contains(&BlockId(b as u32)) {
                continue;
            }
            for p in 0..region.blocks[b].params.len() {
                if removed[b][p] {
                    continue;
                }
                let param = region.blocks[b].params[p];
                // Effect phis remain explicit chain roots until effect-aware CFG simplification.
                if region.values[param.index()].ty == super::types::Type::Effect {
                    continue;
                }
                let mut candidate = None;
                let mut differs = false;
                for &edge in &incoming[b] {
                    let value = resolve(&aliases, arg(region, edge, p));
                    if value == param {
                        continue;
                    }
                    if candidate.is_some() && candidate != Some(value) {
                        differs = true;
                        break;
                    }
                    candidate = Some(value);
                }
                if differs {
                    continue;
                }
                let Some(value) = candidate
                else {
                    continue;
                };
                aliases[param.index()] = Some(value);
                removed[b][p] = true;
                changed = true;
                count += 1;
            }
        }
        if !changed {
            break;
        }
    }
    if count == 0 {
        return;
    }
    rewrite_values(region, |v| *v = resolve(&aliases, *v));
    for (b, block) in region.blocks.iter_mut().enumerate() {
        if let Some(term) = block.terminator.as_mut() {
            for edge in term.edges_mut() {
                let drop = &removed[edge.target.index()];
                if drop.iter().any(|d| *d) {
                    let mut i = 0;
                    edge.args.retain(|_| {
                        i += 1;
                        !drop[i - 1]
                    });
                }
            }
        }
        let _ = b;
    }
    for b in 0..n {
        if !removed[b].iter().any(|d| *d) {
            continue;
        }
        let mut i = 0;
        let drop = &removed[b];
        region.blocks[b].params.retain(|_| {
            i += 1;
            !drop[i - 1]
        });
        for (i, &v) in region.blocks[b].params.iter().enumerate() {
            region.values[v.index()].definition = Definition::Parameter(BlockId(b as u32), i as u32);
        }
    }
    stats.phis += count;
}
