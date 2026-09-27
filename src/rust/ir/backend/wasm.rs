use super::structure::{self, Structure};
use crate::cpu::global_pointers as gp;
use crate::ir::mir::arithmetic::{
    ArithmeticPlan, CompareExchange, Division, QuotientRange, RegisterPair,
};
use crate::ir::mir::call::{CallPlan, Observation};
use crate::ir::mir::control::{Copy, Edge as MirEdge, Source, Terminator as MirTerminator};
use crate::ir::mir::effect::EffectPlan;
use crate::ir::mir::forwarding::{Forwarding, LoopForwarding};
use crate::ir::mir::materialize::{Count, CountMode, Store, Write};
use crate::ir::mir::memory::{
    Argument, MemoryPlan, NativeMemory, RamGuard, RuntimeCall, SlowResult, VectorCombine,
};
use crate::ir::mir::value::{Address, Load, Reading, Step, ValuePlan};
use crate::ir::runtime::diagnostics::{
    self as diag, Exit as DiagnosticExit, Stage as DiagnosticStage,
};
use crate::ir::runtime::entry::CpuEntryKey;
use crate::ir::{ids::*, lowering::CompileError, mir::MirRegion, types::Type};
use crate::wasmgen::wasm_builder::{Label, WasmBuilder, WasmLocal, WasmLocalI64, WasmLocalV128};
use std::collections::{BTreeMap, VecDeque};

pub(crate) mod x87;
#[derive(Clone, Copy)]
pub struct StateLayout {
    pub gpr: u32,
    pub flags: u32,
    pub eip: u32,
    pub committed: u32,
    pub flag_operand: u32,
}
pub struct Artifact {
    pub bytes: Vec<u8>,
    pub locals: usize,
    /// True when this CPU CFG bypasses the generic pc-local block dispatcher.
    pub structured_cfg: bool,
    pub structured_backedges: u32,
    /// Number of MIR control edges emitted directly rather than through the pc dispatcher.
    pub structured_edges: u32,
    pub generic_dispatch_edges: u32,
    /// Emitted guarded poll batches (zero for diagnostic/STI/size fallback).
    pub budget_batch_blocks: u32,
}

fn control_edge_count(mir: &MirRegion) -> u32 {
    mir.control
        .blocks
        .iter()
        .map(|block| match &block.terminator {
            MirTerminator::Exit(_) => 0,
            MirTerminator::Jump(_) => 1,
            MirTerminator::Branch { .. } => 2,
        })
        .sum()
}
/// Within a block, only an observing instruction can invalidate a code epoch
/// already checked by its entry/previous poll. Wasm executes synchronously on
/// one agent; plain SSA operations and backing-state loads cannot run a host
/// callback. Keep the first poll after *every* memory/effect/helper operation,
/// including operations whose native path happens not to observe anything.
/// Block entries remain unconditional, so no assumption crosses a CFG edge.
fn required_epoch_polls(mir: &MirRegion) -> Vec<bool> {
    let mut required = vec![true; mir.control.polls.len()];
    for block in &mir.control.blocks {
        // A block with no recovery cannot have established an epoch check.
        let mut observed = block.recovery.is_none();
        for &id in &block.instructions {
            let i = id.index();
            if mir.control.polls[i].is_some() {
                required[i] = observed;
                observed = false;
            }
            else if mir.memory[i].is_some() || mir.effects[i].is_some() || mir.calls[i].is_some() {
                observed = true;
            }
            else {
                observed |= mir.values[i].as_ref().is_none_or(|value| {
                    value.steps.iter().any(|step| {
                        matches!(
                            step,
                            Step::Read {
                                cpu: Reading::Call { .. },
                                ..
                            }
                        )
                    })
                });
            }
        }
    }
    required
}
/// CPU adapters whose task guard can log before the interpreter finishes
/// decoding operands. Constant non-SSE invalid/reserved forms do not observe
/// this warning; unknown hand-built arguments conservatively retain the guard.
fn debug_sse_call(mir: &MirRegion, plan: &CallPlan) -> bool {
    let name = mir.helpers[plan.helper.index()].as_ref().unwrap().name.as_str();
    if name.starts_with("ir_sse_fp_") || name.starts_with("ir_mmx_")
        || matches!(name, "ir_ldmxcsr" | "ir_stmxcsr")
    {
        return true;
    }
    let argument = match name {
        "ir_invalid_form" => 0,
        "ir_reserved_form" => 1,
        _ => return false,
    };
    mir.values.iter().flatten().find(|value| value.result == plan.args[argument])
        .and_then(|value| match value.steps.as_slice() {
            [Step::I32(n)] => Some(if argument == 0 { *n == 2 } else { *n != 0 }),
            _ => None,
        })
        .unwrap_or(true)
}
fn debug_sse_effect(plan: &EffectPlan) -> bool {
    matches!(plan, EffectPlan::Check { call, .. } if call.name == "ir_sse_guard")
}
enum Local {
    I32(WasmLocal),
    I64(WasmLocalI64),
    V128(WasmLocalV128),
}
#[derive(Clone, Copy)]
enum MemoryCache {
    Chain,
    Loop(usize),
}
struct Emitter<'a> {
    w: WasmBuilder,
    mir: &'a MirRegion,
    locals: Vec<Option<Local>>,
    layout: StateLayout,
    cpu: bool,
    linkable_entry: bool,
    entry: Option<CpuEntryKey>,
    accounted: Option<WasmLocal>,
    tlb: Option<WasmLocal>,
    read_cache: Option<(WasmLocal, WasmLocal)>,
    guard_cache: Option<(WasmLocal, WasmLocal)>,
    loop_read_caches: Vec<(WasmLocal, WasmLocal)>,
    code_pages: &'a [u32],
    memory_base: Option<WasmLocal>,
    interrupt_shadow: Option<WasmLocal>,
    fused_epoch: Option<(WasmLocal, WasmLocalI64)>,
    epoch_polls: Vec<bool>,
    diagnostic: Option<(WasmLocal, WasmLocal)>,
    debug_sse_observer: bool,
    batch_polls: bool,
    budget_batch_blocks: u32,
}
impl Emitter<'_> {
    fn instruction_epoch_check(&self, id: InstId) -> bool {
        self.epoch_polls.get(id.index()).copied().unwrap_or(true)
    }
    fn diagnostic_begin(&mut self, stage: DiagnosticStage) {
        if let Some((_, active)) = &self.diagnostic {
            self.w.get_local(active);
            self.w.if_void();
            self.w.const_i32(stage as i32);
            self.w.call_signature(
                "ir_diagnostic_begin",
                crate::ir::helper::imports::signature("ir_diagnostic_begin"),
            );
            self.w.block_end();
        }
    }
    fn diagnostic_end(&mut self) {
        if let Some((_, active)) = &self.diagnostic {
            self.w.get_local(active);
            self.w.if_void();
            self.w.call_signature(
                "ir_diagnostic_end",
                crate::ir::helper::imports::signature("ir_diagnostic_end"),
            );
            self.w.block_end();
        }
    }
    fn diagnostic_exit(&mut self, reason: DiagnosticExit) {
        if let Some((base, _)) = &self.diagnostic {
            self.w.get_local(base);
            self.w.const_i32(reason as i32);
            self.w.store_aligned_i32(4);
        }
    }
    fn admission_barrier(&mut self) {
        if self.linkable_entry {
            self.w.call_signature(
                "ir_admission_barrier",
                crate::ir::helper::imports::signature("ir_admission_barrier"),
            );
        }
    }
    fn normal_exit(&mut self, state: StateId) {
        self.diagnostic_exit(DiagnosticExit::Normal);
        self.state(state);
        if self.linkable_entry && self.mir.states[state.index()].after_instruction {
            if let Some(depth) = &self.interrupt_shadow {
                self.w.get_local(depth);
                self.w.eqz_i32();
                self.w.if_void();
            }
            self.w.call_signature(
                "ir_request_link",
                crate::ir::helper::imports::signature("ir_request_link"),
            );
            if self.interrupt_shadow.is_some() {
                self.w.block_end();
            }
        }
        self.return_to_cpu_with_link(true);
    }
    fn return_to_cpu(&mut self) { self.return_to_cpu_with_link(false); }
    fn return_to_cpu_with_link(&mut self, completed: bool) {
        if let Some(depth) = &self.interrupt_shadow {
            self.w.get_local(depth);
            self.w.if_void();
            let depth = depth.unsafe_clone();
            self.diagnostic_exit(DiagnosticExit::InterruptShadow);
            self.w.get_local(&depth);
            let name = if completed && self.linkable_entry {
                "ir_sti_finish_link"
            }
            else {
                "ir_sti_finish"
            };
            self.w
                .call_signature(name, crate::ir::helper::imports::signature(name));
            self.w.block_end();
        }
        self.w.return_();
    }
    fn get(&mut self, value: ValueId) {
        self.get_local(self.mir.allocation.value_local[value.index()].unwrap());
    }
    fn declare_local(&mut self, slot: usize) {
        if self.locals[slot].is_none() {
            let ty = self.mir.allocation.local_types[slot];
            self.locals[slot] = Some(if ty == Type::V128 {
                Local::V128(self.w.declare_zeroed_local_v128())
            }
            else if matches!(ty, Type::I64 | Type::RmwTicket) {
                Local::I64(self.w.declare_zeroed_local_i64())
            }
            else {
                Local::I32(self.w.declare_zeroed_local())
            });
        }
    }
    fn get_local(&mut self, slot: usize) {
        self.declare_local(slot);
        match self.locals[slot].as_ref().unwrap() {
            Local::I32(local) => self.w.get_local(local),
            Local::I64(local) => self.w.get_local_i64(local),
            Local::V128(local) => self.w.get_local_v128(local),
        }
    }
    fn set(&mut self, value: ValueId) {
        self.set_local(self.mir.allocation.value_local[value.index()].unwrap());
    }
    fn set_local(&mut self, slot: usize) {
        self.declare_local(slot);
        match self.locals[slot].as_ref().unwrap() {
            Local::I32(local) => self.w.set_local(local),
            Local::I64(local) => self.w.set_local_i64(local),
            Local::V128(local) => self.w.set_local_v128(local),
        }
    }
    fn temporary(&mut self, ty: Type) -> Local {
        if ty == Type::V128 {
            Local::V128(self.w.set_new_local_v128())
        }
        else if matches!(ty, Type::I64 | Type::RmwTicket) {
            Local::I64(self.w.set_new_local_i64())
        }
        else {
            Local::I32(self.w.set_new_local())
        }
    }
    fn get_temporary(&mut self, local: &Local) {
        match local {
            Local::I32(l) => self.w.get_local(l),
            Local::I64(l) => self.w.get_local_i64(l),
            Local::V128(l) => self.w.get_local_v128(l),
        }
    }
    fn free_temporary(&mut self, local: Local) {
        match local {
            Local::I32(l) => self.w.free_local(l),
            Local::I64(l) => self.w.free_local_i64(l),
            Local::V128(l) => self.w.free_local_v128(l),
        }
    }
    fn cache_valid(&mut self, cache: MemoryCache) {
        match cache {
            MemoryCache::Chain => self.w.get_local(&self.read_cache.as_ref().unwrap().0),
            MemoryCache::Loop(slot) => self.w.get_local(&self.loop_read_caches[slot].0),
        }
    }
    fn cache_value(&mut self, cache: MemoryCache) {
        match cache {
            MemoryCache::Chain => self.w.get_local(&self.read_cache.as_ref().unwrap().1),
            MemoryCache::Loop(slot) => self.w.get_local(&self.loop_read_caches[slot].1),
        }
    }
    fn cache_set_value(&mut self, cache: MemoryCache) {
        match cache {
            MemoryCache::Chain => self.w.set_local(&self.read_cache.as_ref().unwrap().1),
            MemoryCache::Loop(slot) => self.w.set_local(&self.loop_read_caches[slot].1),
        }
    }
    fn cache_mark_valid(&mut self, cache: MemoryCache) {
        self.w.const_i32(1);
        match cache {
            MemoryCache::Chain => self.w.set_local(&self.read_cache.as_ref().unwrap().0),
            MemoryCache::Loop(slot) => self.w.set_local(&self.loop_read_caches[slot].0),
        }
    }
    fn cache_clear(&mut self, cache: MemoryCache) {
        self.w.const_i32(0);
        match cache {
            MemoryCache::Chain => self.w.set_local(&self.read_cache.as_ref().unwrap().0),
            MemoryCache::Loop(slot) => self.w.set_local(&self.loop_read_caches[slot].0),
        }
    }
    fn clear_loop_caches(&mut self) {
        if let Some((valid, _)) = &self.guard_cache {
            self.w.const_i32(0);
            self.w.set_local(valid);
        }
        for slot in 0..self.loop_read_caches.len() {
            self.w.const_i32(0);
            self.w.set_local(&self.loop_read_caches[slot].0);
        }
    }
    fn mask(&mut self, ty: Type) {
        if ty == Type::V128 {
            return;
        }
        let bits = if ty == Type::LinearAddress { 32 } else { ty.bits().unwrap() };
        if bits < 32 {
            self.w.const_i32((1i32 << bits) - 1);
            self.w.and_i32();
        }
    }
    fn state_write(&mut self, write: &Write) {
        self.w.const_i32(self.address(write.address) as i32);
        self.value_steps(&write.expression);
        match write.store {
            Store::I32 => self.w.store_aligned_i32(0),
            Store::V128 => self.w.simd_memory(0x0B, 2),
        }
    }
    fn count_value(&mut self, count: &Count) {
        self.w.const_i32(count.snapshot as i32);
        if let Some(base) = count.base {
            self.get(base);
            self.w.add_i32();
        }
    }
    fn count(&mut self, count: &Count) {
        let destination = self.address(count.destination);
        self.w.const_i32(destination as i32);
        self.count_value(count);
        if count.mode == CountMode::Delta {
            self.w.get_local(self.accounted.as_ref().unwrap());
            self.w.sub_i32();
            self.w.load_fixed_i32(destination);
            self.w.add_i32();
        }
        self.w.store_aligned_i32(0);
        if count.mode == CountMode::Delta {
            self.count_value(count);
            self.w.set_local(self.accounted.as_ref().unwrap());
        }
    }
    fn observe_state(&mut self, values: StateId, count: StateId, decoded_next: bool) {
        self.diagnostic_begin(DiagnosticStage::StateWrite);
        let states = &self.mir.states;
        let plan = &states[values.index()];
        let materialization = if self.cpu { &plan.cpu } else { &plan.standalone };
        for (index, write) in materialization.writes.iter().enumerate() {
            if self.cpu && self.mir.cpu_state_write_elided(values, index) {
                continue;
            }
            self.state_write(write);
        }
        let count = &states[count.index()];
        self.count(if self.cpu { &count.cpu.count } else { &count.standalone.count });
        if decoded_next {
            self.state_write(&plan.decoded_next);
        }
        self.diagnostic_end();
    }
    fn state(&mut self, state: StateId) { self.observe_state(state, state, false); }
    fn terminator(&self, id: BlockId) -> &MirTerminator {
        if self.cpu {
            self.mir.cpu_terminator(id)
        }
        else {
            &self.mir.control.blocks[id.index()].terminator
        }
    }
    fn copy_edge_values(&mut self, edge: &MirEdge) {
        let mut scratch = Vec::new();
        for copy in &edge.copies {
            match *copy {
                Copy::Save {
                    local,
                    scratch: slot,
                } => {
                    self.get_local(local);
                    scratch.push(self.temporary(edge.scratch[slot]));
                },
                Copy::Move {
                    source,
                    destination,
                } => {
                    match source {
                        Source::Local(slot) => self.get_local(slot),
                        Source::Scratch(slot) => self.get_temporary(&scratch[slot]),
                    }
                    self.set_local(destination);
                },
            }
        }
        for temp in scratch {
            self.free_temporary(temp);
        }
    }
    fn copy_edge(&mut self, edge: &MirEdge, pc: &WasmLocal) {
        self.copy_edge_values(edge);
        self.w.const_i32(edge.target.0 as i32);
        self.w.set_local(pc);
    }
    fn emit_block_body(&mut self, id: BlockId, remaining: &WasmLocal, allow_batch: bool) {
        let resets = self.mir.ram_loop_resets(id).to_vec();
        for slot in resets {
            self.cache_clear(MemoryCache::Loop(slot));
        }
        let block = self.mir.control.blocks[id.index()].clone();
        // Sparse (page) functions charge the budget only at loop headers.
        if block.budget_cost != 0 || !self.mir.control.sparse_polls {
            self.poll(block.recovery, block.budget_cost, remaining);
        }
        let batch = self.mir.budget_batch(id).filter(|_| {
            allow_batch
                && self.cpu
                && self.batch_polls
                && self.interrupt_shadow.is_none()
                && self.diagnostic.is_none()
        });
        if let Some(batch) = batch {
            for &id in &block.instructions[..batch.start] {
                self.instruction(id, remaining);
            }
            let cost = batch.cost;
            // Reserve dispatcher work, not guest retirement. Every StateMap and
            // fault/observer path is unchanged. Mixed bodies keep the first
            // original epoch check after each possible observer, so a callback
            // cannot execute stale subsequent code.
            self.w.get_local(remaining);
            self.w.const_i32(cost as i32);
            self.w.geu_i32();
            self.w.if_void();
            self.w.get_local(remaining);
            self.w.const_i32(cost as i32);
            self.w.sub_i32();
            self.w.set_local(remaining);
            for &id in &block.instructions[batch.start..] {
                if let Some(poll) = &self.mir.control.polls[id.index()] {
                    if !batch.pure {
                        self.check_poll(
                            Some(poll.recovery),
                            None,
                            self.instruction_epoch_check(id),
                        );
                    }
                }
                else {
                    self.instruction(id, remaining);
                }
            }
            self.w.else_();
            for &id in &block.instructions[batch.start..] {
                self.instruction(id, remaining);
            }
            self.w.block_end();
            self.budget_batch_blocks += 1;
        }
        else {
            for id in block.instructions {
                self.instruction(id, remaining);
            }
        }
    }
    fn emit_structured_edge(
        &mut self,
        edge: &MirEdge,
        next: &[BlockId],
        labels: &BTreeMap<BlockId, Label>,
    ) {
        self.copy_edge_values(edge);
        if next.contains(&edge.target) {
            return;
        }
        let label = *labels
            .get(&edge.target)
            .expect("verified structure provides a branch label");
        self.w.br(label);
    }
    fn emit_structured_terminator(
        &mut self,
        id: BlockId,
        next: &[BlockId],
        labels: &BTreeMap<BlockId, Label>,
    ) {
        match self.terminator(id).clone() {
            MirTerminator::Exit(state) => self.normal_exit(state),
            MirTerminator::Jump(edge) => self.emit_structured_edge(&edge, next, labels),
            MirTerminator::Branch {
                condition,
                taken,
                not_taken,
            } => {
                self.get_local(condition);
                self.w.if_void();
                self.emit_structured_edge(&taken, next, labels);
                self.w.else_();
                self.emit_structured_edge(&not_taken, next, labels);
                self.w.block_end();
            },
        }
    }
    /// Emit a body whose original dispatcher credits have already been reserved.
    /// Epoch and fault checks still occur at their original recovery points.
    fn emit_reserved_body(&mut self, id: BlockId, pure: bool, remaining: &WasmLocal) {
        let block = self.mir.control.blocks[id.index()].clone();
        for slot in self.mir.ram_loop_resets(id).to_vec() {
            self.cache_clear(MemoryCache::Loop(slot));
        }
        self.check_poll(block.recovery, None, true);
        for &inst in &block.instructions {
            if let Some(poll) = &self.mir.control.polls[inst.index()] {
                if !pure {
                    self.check_poll(Some(poll.recovery), None, self.instruction_epoch_check(inst));
                }
            }
            else {
                self.instruction(inst, remaining);
            }
        }
    }
    fn emit_prepaid_edge(
        &mut self,
        edge: &MirEdge,
        header: BlockId,
        backedge: crate::ir::mir::budget::LoopBackedge,
        hot: Label,
        labels: &BTreeMap<BlockId, Label>,
        remaining: &WasmLocal,
    ) {
        if edge.target == backedge.target {
            self.copy_edge_values(edge);
            if backedge.target != header {
                self.emit_reserved_body(backedge.target, true, remaining);
                let MirTerminator::Jump(back) = self.terminator(backedge.target).clone()
                else {
                    unreachable!("verified budget latch")
                };
                self.copy_edge_values(&back);
            }
            self.w.br(hot);
        }
        else {
            // Only the loop-taking arm consumes the prepaid latch. Other normal
            // successors must see precisely the original remaining budget.
            if backedge.cost != 0 {
                self.w.get_local(remaining);
                self.w.const_i32(backedge.cost as i32);
                self.w.add_i32();
                self.w.set_local(remaining);
            }
            self.emit_structured_edge(edge, &[], labels);
        }
    }
    /// Keep the residual-budget body outside the hot backedge. Duplicating both
    /// arms *inside* a loop increases host phi/register pressure even when the
    /// residual arm is rarely taken. The original body is still the exact oracle
    /// for every small budget, and observer/fault boundaries are retained.
    fn emit_prepaid_loop(
        &mut self,
        id: BlockId,
        remaining: &WasmLocal,
        next: &[BlockId],
        labels: &BTreeMap<BlockId, Label>,
    ) -> bool {
        let block = &self.mir.control.blocks[id.index()];
        let Some(batch) = self.mir.budget_batch(id).filter(|b| {
            b.start == 0
                && b.backedge.is_some()
                && self.cpu
                && self.batch_polls
                && self.interrupt_shadow.is_none()
                && self.diagnostic.is_none()
                && block.recovery.is_some()
        })
        else {
            return false;
        };
        let block = block.clone();
        let backedge = batch.backedge.unwrap();
        let cost = batch.cost + block.budget_cost + backedge.cost;
        let done = self.w.block_void();
        let residual = self.w.block_void();
        let hot = self.w.loop_void();
        self.w.get_local(remaining);
        self.w.const_i32(cost as i32);
        self.w.ltu_i32();
        self.w.br_if(residual);
        self.w.get_local(remaining);
        self.w.const_i32(cost as i32);
        self.w.sub_i32();
        self.w.set_local(remaining);
        self.emit_reserved_body(id, batch.pure, remaining);
        let mut hot_labels = labels.clone();
        for target in next {
            hot_labels.insert(*target, done);
        }
        // A normal loop exit must skip the residual body, including fallthrough.
        match self.terminator(id).clone() {
            MirTerminator::Jump(edge) => {
                self.emit_prepaid_edge(&edge, id, backedge, hot, &hot_labels, remaining)
            },
            MirTerminator::Branch {
                condition,
                taken,
                not_taken,
            } => {
                self.get_local(condition);
                self.w.if_void();
                self.emit_prepaid_edge(&taken, id, backedge, hot, &hot_labels, remaining);
                self.w.else_();
                self.emit_prepaid_edge(&not_taken, id, backedge, hot, &hot_labels, remaining);
                self.w.block_end();
            },
            MirTerminator::Exit(_) => unreachable!("verified loop budget certificate"),
        }
        self.w.block_end(); // hot loop
        self.w.block_end(); // residual entry
        self.emit_block_body(id, remaining, false);
        self.emit_structured_terminator(id, next, labels);
        self.w.block_end(); // normal continuation
        self.budget_batch_blocks += 1;
        true
    }
    fn emit_structured(&mut self, roots: &[Structure], remaining: &WasmLocal) {
        #[derive(Clone)]
        enum Work {
            Node(Structure),
            BlockEnd {
                label: Label,
                targets: Vec<BlockId>,
                old: Vec<(BlockId, Label)>,
            },
            LoopEnd {
                label: Label,
                entries: Vec<BlockId>,
                old: Vec<(BlockId, Label)>,
            },
        }

        let mut labels = BTreeMap::<BlockId, Label>::new();
        let mut work: VecDeque<Work> = roots.iter().cloned().map(Work::Node).collect();
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
                    if !self.emit_prepaid_loop(id, remaining, &next, &labels) {
                        self.emit_block_body(id, remaining, true);
                        self.emit_structured_terminator(id, &next, &labels);
                    }
                },
                Work::Node(Structure::Loop(children)) => {
                    let entries = children.first().expect("verified non-empty loop").head();
                    let label = self.w.loop_void();
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
                        debug_assert!(labels.remove(&target) == Some(label));
                    }
                    for (target, previous) in old {
                        debug_assert!(labels.insert(target, previous).is_none());
                    }
                    self.w.block_end();
                },
                Work::Node(Structure::Block(children)) => {
                    debug_assert!(!children.is_empty());
                    debug_assert!(!next.is_empty());
                    let label = self.w.block_void();
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
                        debug_assert!(labels.remove(&target) == Some(label));
                    }
                    for (target, previous) in old {
                        debug_assert!(labels.insert(target, previous).is_none());
                    }
                    self.w.block_end();
                },
            }
        }
        debug_assert!(labels.is_empty());
    }
    /// Decode the packed CPU adapter result without touching any SSA result slot.
    fn packed_cpu_result(&mut self, result: ValueId, trap_after_fault: bool) {
        let packed = self.w.set_new_local_i64();
        self.w.get_local_i64(&packed);
        self.w.const_i64(32);
        self.w.shr_u_i64();
        self.w.wrap_i64_to_i32();
        let outcome = self.w.set_new_local();
        self.w.get_local(&outcome);
        self.w.const_i32(2);
        self.w.eq_i32();
        self.w.if_void();
        if trap_after_fault {
            self.w.unreachable();
        }
        else {
            self.diagnostic_exit(DiagnosticExit::Fault);
            self.return_to_cpu();
        }
        self.w.block_end();
        self.w.get_local(&outcome);
        self.w.if_void();
        self.w.unreachable();
        self.w.block_end();
        self.w.get_local_i64(&packed);
        self.w.wrap_i64_to_i32();
        self.mask(self.mir.value_types[result.index()]);
        self.set(result);
        self.w.free_local(outcome);
        self.w.free_local_i64(packed);
    }
    fn prepare_memory_call(&mut self, state: StateId) { self.observe_state(state, state, true); }
    fn planned_ram_guard(&mut self, address: ValueId, guard: &RamGuard) -> WasmLocal {
        self.w.get_local(self.tlb.as_ref().unwrap());
        self.get(address);
        self.w.const_i32(12);
        self.w.shr_u_i32();
        self.w.const_i32(2);
        self.w.shl_i32();
        self.w.add_i32();
        self.w.load_aligned_i32(0);
        let entry = self.w.set_new_local();
        self.w.get_local(&entry);
        self.w.const_i32(guard.flags_mask);
        self.w.load_fixed_u8(gp::cpl as u32); // CPL
        self.w.const_i32(3);
        self.w.eq_i32();
        self.w.const_i32(guard.user_mask);
        self.w.mul_i32();
        self.w.or_i32();
        self.w.and_i32();
        self.w.const_i32(guard.required_flags);
        self.w.eq_i32();
        self.get(address);
        self.w.const_i32(4095);
        self.w.and_i32();
        self.w.const_i32(guard.page_offset_limit);
        self.w.ltu_i32();
        self.w.and_i32();
        entry
    }
    fn finish_ram_store(&mut self, commit: StateId, pointer: &WasmLocal, fallback: DiagnosticExit) {
        // Native ordinary RAM has no observer. Keep architectural values in SSA
        // on continuation; later faults/polls/helpers materialize their own
        // verified StateMap, whose count already includes this completed store.
        if self.code_pages.is_empty() {
            // Standalone/test emitters without an immutable code snapshot keep
            // the historical conservative boundary.
            self.state(commit);
            self.diagnostic_exit(fallback);
            self.return_to_cpu();
            return;
        }
        // TLB entries contain Wasm-linear pointers (`mem8 + physical`), while
        // immutable dependencies are guest-physical page addresses. Compare in
        // the same address space so a writable virtual alias of the running code
        // cannot continue into stale bytes even when its TLB_HAS_CODE bit is clear.
        let memory_base = self.memory_base.as_ref().unwrap();
        for (index, page) in self.code_pages.iter().enumerate() {
            self.w.get_local(pointer);
            self.w.const_i32(!4095);
            self.w.and_i32();
            self.w.get_local(memory_base);
            self.w.const_i32(*page as i32);
            self.w.add_i32();
            self.w.eq_i32();
            if index != 0 {
                self.w.or_i32();
            }
        }
        self.w.if_void();
        self.state(commit);
        self.diagnostic_exit(DiagnosticExit::CodeStore);
        self.return_to_cpu();
        self.w.block_end();
    }
    fn compare_exchange8b(&mut self, plan: &CompareExchange) {
        self.prepare_memory_call(plan.before);
        self.diagnostic_exit(DiagnosticExit::RmwCommit);
        let entry = self.planned_ram_guard(plan.address, &plan.guard);
        self.w.if_void();
        self.w.get_local(&entry);
        self.w.const_i32(!4095);
        self.w.and_i32();
        self.get(plan.address);
        self.w.xor_i32();
        let pointer = self.w.set_new_local();
        self.w.get_local(&pointer);
        self.w.load_unaligned_i64(0);
        let value = self.w.set_new_local_i64();
        self.w.get_local_i64(&value);
        self.cpu_register_pair(&plan.expected); // EDX:EAX, read after the memory-read point.
        self.w.eq_i64();
        let equal = self.w.set_new_local();
        self.w.get_local(&equal);
        self.w.if_void();
        self.w.get_local(&pointer);
        self.cpu_register_pair(&plan.replacement); // ECX:EBX
        self.w.store_unaligned_i64(0);
        self.w.else_();
        self.w.const_i32(plan.expected.low as i32);
        self.w.get_local_i64(&value);
        self.w.wrap_i64_to_i32();
        self.w.store_aligned_i32(0);
        self.w.const_i32(plan.expected.high as i32);
        self.w.get_local_i64(&value);
        self.w.const_i64(32);
        self.w.shr_u_i64();
        self.w.wrap_i64_to_i32();
        self.w.store_aligned_i32(0);
        self.w.block_end();
        // No observer/fault can occur between the checked RAM access and these
        // updates. Slow paths retain the baseline's earlier raw-ZF write timing.
        self.w.const_i32(plan.flags as i32);
        self.w.load_fixed_i32(plan.flags);
        self.w.const_i32(!plan.zero_mask);
        self.w.and_i32();
        self.w.get_local(&equal);
        self.w.const_i32(plan.zero_shift);
        self.w.shl_i32();
        self.w.or_i32();
        self.w.store_aligned_i32(0);
        self.w.const_i32(plan.flags_changed as i32);
        self.w.load_fixed_i32(plan.flags_changed);
        self.w.const_i32(!plan.zero_mask);
        self.w.and_i32();
        self.w.store_aligned_i32(0);
        self.w.const_i32(plan.counter as i32);
        self.w.load_fixed_i32(plan.counter);
        self.w.const_i32(plan.increment);
        self.w.add_i32();
        self.w.store_aligned_i32(0);
        self.w.free_local(equal);
        self.w.free_local_i64(value);
        self.w.free_local(pointer);
        self.w.else_();
        self.runtime_call(&plan.call);
        let outcome = self.w.set_new_local();
        self.w.get_local(&outcome);
        self.w.const_i32(plan.outcomes[0]);
        self.w.ne_i32();
        self.w.get_local(&outcome);
        self.w.const_i32(plan.outcomes[1]);
        self.w.ne_i32();
        self.w.and_i32();
        self.w.if_void();
        self.w.unreachable();
        self.w.block_end();
        if self.diagnostic.is_some() {
            self.w.get_local(&outcome);
            self.w.const_i32(2);
            self.w.eq_i32();
            self.w.if_void();
            self.diagnostic_exit(DiagnosticExit::Fault);
            self.w.block_end();
        }
        self.w.free_local(outcome);
        self.w.block_end();
        self.w.free_local(entry);
        self.return_to_cpu();
    }
    fn cpu_register_pair(&mut self, pair: &RegisterPair) {
        self.w.load_fixed_i32(pair.low);
        self.w.extend_unsigned_i32_to_i64();
        self.w.load_fixed_i32(pair.high);
        self.w.extend_unsigned_i32_to_i64();
        self.w.const_i64(32);
        self.w.shl_i64();
        self.w.or_i64();
    }
    fn divide_fault_if(&mut self, plan: &Division) {
        self.w.if_void();
        self.prepare_memory_call(plan.before);
        self.runtime_call(&plan.fault);
        self.diagnostic_exit(DiagnosticExit::Fault);
        self.return_to_cpu();
        self.w.block_end();
    }
    fn divide(&mut self, plan: &Division) {
        self.get(plan.divisor);
        self.w.const_i64(0);
        self.w.eq_i64();
        if let Some((dividend, divisor)) = plan.overflow_pair {
            self.get(plan.dividend);
            self.w.const_i64(dividend);
            self.w.eq_i64();
            self.get(plan.divisor);
            self.w.const_i64(divisor);
            self.w.eq_i64();
            self.w.and_i32();
            self.w.or_i32();
        }
        self.divide_fault_if(plan);
        self.get(plan.dividend);
        self.get(plan.divisor);
        if plan.signed {
            self.w.div_s_i64();
        }
        else {
            self.w.div_i64();
        }
        let quotient = self.w.set_new_local_i64();
        self.w.get_local_i64(&quotient);
        match plan.range {
            QuotientRange::Signed { minimum, maximum } => {
                self.w.const_i64(minimum);
                self.w.lt_i64();
                self.w.const_i64(maximum);
                self.w.get_local_i64(&quotient);
                self.w.lt_i64();
                self.w.or_i32();
            },
            QuotientRange::Unsigned { maximum } => {
                self.w.const_i64(maximum);
                self.w.gtu_i64();
            },
        }
        self.divide_fault_if(plan);
        // Stage both outputs after the last possible fault, before assigning SSA
        // slots. The dividend/divisor may share result slots after legalization.
        self.get(plan.dividend);
        self.get(plan.divisor);
        if plan.signed {
            self.w.rem_s_i64();
        }
        else {
            self.w.rem_i64();
        }
        let remainder = self.w.set_new_local_i64();
        for (value, local) in [(plan.quotient, quotient), (plan.remainder, remainder)] {
            self.w.get_local_i64(&local);
            self.w.wrap_i64_to_i32();
            self.mask(self.mir.value_types[value.index()]);
            self.set(value);
            self.w.free_local_i64(local);
        }
    }
    fn runtime_call(&mut self, call: &RuntimeCall) {
        // These three imports cannot observe host state on success. Segment
        // faults terminate the activation, whose admission interval is revoked.
        if !matches!(
            call.name,
            "ir_segment_address" | "ir_pop_address" | "ir_rmw_value" | "ir_x87_op"
        ) {
            self.admission_barrier();
        }
        self.diagnostic_begin(
            if call.name.starts_with("ir_memory")
                || call.name.starts_with("ir_rmw")
                || call.name.starts_with("ir_xmm")
            {
                DiagnosticStage::MemorySlow
            }
            else {
                DiagnosticStage::Helper
            },
        );
        for arg in &call.args {
            match *arg {
                Argument::Value(value) => self.get(value),
                Argument::I32(value) => self.w.const_i32(value),
            }
        }
        self.w.call_signature(call.name, call.signature.clone());
        self.diagnostic_end();
    }
    fn memory_with_forwarding(
        &mut self,
        plan: &MemoryPlan,
        proof: Option<Forwarding>,
        loop_proof: Option<LoopForwarding>,
        guard_proof: Option<Forwarding>,
    ) {
        if let Some(loop_proof) = loop_proof {
            let cache = MemoryCache::Loop(loop_proof.slot);
            self.cache_valid(cache);
            self.w.if_void();
            self.cache_value(cache);
            let NativeMemory::ScalarLoad {
                result,
                ticket: None,
            } = plan.native
            else {
                unreachable!("verified loop RAM cache certificate")
            };
            self.set(result);
            self.w.else_();
            self.planned_memory(plan, Some(cache), None);
            self.w.block_end();
            return;
        }
        match proof {
            Some(Forwarding::Begin) => {
                self.cache_clear(MemoryCache::Chain);
                self.planned_memory(plan, Some(MemoryCache::Chain), None);
            },
            Some(Forwarding::Reuse { .. }) => {
                self.cache_valid(MemoryCache::Chain);
                self.w.if_void();
                self.cache_value(MemoryCache::Chain);
                let NativeMemory::ScalarLoad {
                    result,
                    ticket: None,
                } = plan.native
                else {
                    unreachable!("verified scalar forwarding certificate")
                };
                self.set(result);
                self.w.else_();
                self.planned_memory(plan, Some(MemoryCache::Chain), None);
                self.w.block_end();
            },
            None => self.planned_memory(plan, None, guard_proof),
        }
    }
    fn planned_memory(
        &mut self,
        plan: &MemoryPlan,
        cache: Option<MemoryCache>,
        guard_proof: Option<Forwarding>,
    ) {
        let bytes = plan.guard.bytes;
        if matches!(guard_proof, Some(Forwarding::Begin)) {
            self.w.const_i32(0);
            self.w.set_local(&self.guard_cache.as_ref().unwrap().0);
        }
        let entry = if matches!(guard_proof, Some(Forwarding::Reuse { .. })) {
            self.w.const_i32(0);
            let entry = self.w.set_new_local();
            self.w.get_local(&self.guard_cache.as_ref().unwrap().0);
            self.w.if_i32();
            self.w.get_local(&self.guard_cache.as_ref().unwrap().1);
            self.w.set_local(&entry);
            self.w.const_i32(1);
            self.w.else_();
            let checked = self.planned_ram_guard(plan.address, &plan.guard);
            self.w.get_local(&checked);
            self.w.set_local(&entry);
            self.w.free_local(checked);
            self.w.block_end();
            entry
        }
        else {
            self.planned_ram_guard(plan.address, &plan.guard)
        };
        self.w.if_void();
        if guard_proof.is_some() {
            self.w.get_local(&entry);
            self.w.set_local(&self.guard_cache.as_ref().unwrap().1);
            self.w.const_i32(1);
            self.w.set_local(&self.guard_cache.as_ref().unwrap().0);
        }
        self.w.get_local(&entry);
        self.w.const_i32(!4095);
        self.w.and_i32();
        self.get(plan.address);
        self.w.xor_i32();
        match &plan.native {
            NativeMemory::ScalarLoad { result, ticket } => {
                if let Some(ticket) = ticket {
                    let pointer = self.w.set_new_local();
                    self.w.get_local(&pointer);
                    self.w.extend_unsigned_i32_to_i64();
                    self.set(*ticket);
                    self.w.get_local(&pointer);
                    self.w.free_local(pointer);
                }
                match bytes {
                    1 => self.w.load_u8(0),
                    2 => self.w.load_unaligned_u16(0),
                    4 => self.w.load_unaligned_i32(0),
                    _ => unreachable!(),
                }
                if let Some(cache) = cache {
                    // Only the successful native ordinary-RAM path establishes
                    // validity for either an intra-block or loop cache.
                    self.cache_set_value(cache);
                    self.cache_mark_valid(cache);
                    self.cache_value(cache);
                }
                self.set(*result);
            },
            NativeMemory::ScalarStore { value, commit } => {
                let pointer = commit.map(|_| {
                    let pointer = self.w.set_new_local();
                    self.w.get_local(&pointer);
                    pointer
                });
                self.get(*value);
                match bytes {
                    1 => self.w.store_u8(0),
                    2 => self.w.store_aligned_u16(0),
                    4 => self.w.store_unaligned_i32(0),
                    _ => unreachable!(),
                }
                if let Some(cache) = cache {
                    // Store seeding is used only by the intra-block certificate.
                    // The write has completed on canonical same-page RAM.
                    self.get(*value);
                    self.mask(self.mir.value_types[value.index()]);
                    self.cache_set_value(cache);
                    self.cache_mark_valid(cache);
                }
                if let Some(commit) = commit {
                    let pointer = pointer.unwrap();
                    self.finish_ram_store(*commit, &pointer, DiagnosticExit::ScalarStore);
                    self.w.free_local(pointer);
                }
            },
            NativeMemory::VectorStore {
                value,
                lane,
                mask,
                commit,
            } => {
                let pointer = self.w.set_new_local();
                if let Some(mask) = mask {
                    self.get(*mask);
                    self.w.simd(0x64);
                    let mask = self.w.set_new_local();
                    for lane in 0..16 {
                        self.w.get_local(&mask);
                        self.w.const_i32(1 << lane);
                        self.w.and_i32();
                        self.w.if_void();
                        self.w.get_local(&pointer);
                        self.get(*value);
                        self.w.simd_lane(0x16, lane);
                        self.w.store_u8(lane as u32);
                        self.w.block_end();
                    }
                    self.w.free_local(mask);
                }
                else {
                    self.w.get_local(&pointer);
                    self.get(*value);
                    match bytes {
                        4 => {
                            self.w.simd_lane(0x1B, 0);
                            self.w.store_unaligned_i32(0);
                        },
                        8 => {
                            self.w.simd_lane(0x1D, *lane);
                            self.w.store_unaligned_i64(0);
                        },
                        16 => self.w.simd_memory(0x0B, 0),
                        _ => unreachable!(),
                    }
                }
                self.finish_ram_store(*commit, &pointer, DiagnosticExit::VectorMemory);
                self.w.free_local(pointer);
            },
            NativeMemory::VectorLoad { result, combine } => {
                if let VectorCombine::ReplaceWord { old, lane } = combine {
                    self.w.load_unaligned_u16(0);
                    let word = self.w.set_new_local();
                    self.get(*old);
                    self.w.get_local(&word);
                    self.w.simd_lane(0x1A, *lane);
                    self.set(*result);
                    self.w.free_local(word);
                }
                else {
                    self.w.simd_memory(
                        match bytes {
                            4 => 0x5C,
                            8 => 0x5D,
                            16 => 0,
                            _ => unreachable!(),
                        },
                        0,
                    );
                    match combine {
                        VectorCombine::None => (),
                        VectorCombine::Shuffle { old, .. } | VectorCombine::Binary { old, .. } => {
                            let source = self.w.set_new_local_v128();
                            self.get(*old);
                            let destination = self.w.set_new_local_v128();
                            match combine {
                                VectorCombine::Shuffle { lanes, .. } => {
                                    self.w.get_local_v128(&destination);
                                    self.w.get_local_v128(&source);
                                    self.w.simd_shuffle(*lanes);
                                },
                                VectorCombine::Binary { plan, .. } => {
                                    super::simd::binary(&mut self.w, plan, &destination, &source)
                                },
                                _ => unreachable!(),
                            }
                            self.w.free_local_v128(destination);
                            self.w.free_local_v128(source);
                        },
                        _ => unreachable!(),
                    }
                    self.set(*result);
                }
            },
        }
        self.w.else_();
        if matches!(cache, Some(MemoryCache::Chain)) {
            self.cache_clear(MemoryCache::Chain);
        }
        // Any slow guest-memory path can enter a page walk or MMIO callback that
        // changes mappings. Invalidate every loop cache before that observation.
        self.clear_loop_caches();
        self.prepare_memory_call(plan.before);
        self.runtime_call(&plan.call);
        match &plan.result {
            SlowResult::Packed {
                result,
                trap_after_fault,
            } => self.packed_cpu_result(*result, *trap_after_fault),
            SlowResult::Rmw {
                result,
                ticket,
                read_value,
            } => {
                let staged = self.w.set_new_local_i64();
                self.w.get_local_i64(&staged);
                self.w.const_i64(-1);
                self.w.eq_i64();
                self.w.if_void();
                self.diagnostic_exit(DiagnosticExit::Fault);
                self.return_to_cpu();
                self.w.block_end();
                self.w.get_local_i64(&staged);
                self.set(*ticket);
                self.w.free_local_i64(staged);
                self.runtime_call(read_value);
                self.mask(self.mir.value_types[result.index()]);
                self.set(*result);
            },
            SlowResult::Store {
                commit,
                trap_after_fault,
            } => {
                let outcome = self.w.set_new_local();
                self.w.get_local(&outcome);
                self.w.const_i32(4);
                self.w.eq_i32();
                self.w.if_void();
                if let Some(commit) = commit {
                    self.state(*commit);
                    self.diagnostic_exit(DiagnosticExit::ScalarStore);
                    self.return_to_cpu();
                }
                self.w.else_();
                self.w.get_local(&outcome);
                self.w.const_i32(2);
                self.w.ne_i32();
                self.w.if_void();
                self.w.unreachable();
                self.w.block_end();
                if *trap_after_fault {
                    self.w.unreachable();
                }
                else {
                    self.diagnostic_exit(DiagnosticExit::Fault);
                    self.return_to_cpu();
                }
                self.w.block_end();
                self.w.free_local(outcome);
            },
            SlowResult::CpuExit { accepted } => {
                let outcome = self.w.set_new_local();
                self.w.get_local(&outcome);
                self.w.const_i32(accepted[0]);
                self.w.ne_i32();
                self.w.get_local(&outcome);
                self.w.const_i32(accepted[1]);
                self.w.ne_i32();
                self.w.and_i32();
                self.w.if_void();
                self.w.unreachable();
                self.w.block_end();
                self.diagnostic_exit(DiagnosticExit::VectorMemory);
                if self.diagnostic.is_some() {
                    self.w.get_local(&outcome);
                    self.w.const_i32(2);
                    self.w.eq_i32();
                    self.w.if_void();
                    self.diagnostic_exit(DiagnosticExit::Fault);
                    self.w.block_end();
                }
                self.w.free_local(outcome);
                self.return_to_cpu();
            },
        }
        self.w.block_end();
        self.w.free_local(entry);
    }
    fn planned_effect(&mut self, plan: &EffectPlan) {
        match plan {
            EffectPlan::Arithmetic(plan) => match plan {
                ArithmeticPlan::Division(p) => self.divide(p),
                ArithmeticPlan::CompareExchange(p) => self.compare_exchange8b(p),
            },
            EffectPlan::Address {
                null_byte,
                base,
                offset,
                result,
                before,
                call,
                trap_after_fault,
            } => {
                self.w.load_fixed_u8(*null_byte);
                self.w.if_void();
                self.prepare_memory_call(*before);
                self.runtime_call(call);
                self.packed_cpu_result(*result, *trap_after_fault);
                self.w.else_();
                self.get(*offset);
                self.w.load_fixed_i32(*base);
                self.w.add_i32();
                self.set(*result);
                self.w.block_end();
            },
            EffectPlan::Check {
                guard,
                before,
                call,
                success,
                fault,
            } => {
                if cfg!(debug_assertions) && self.cpu && debug_sse_effect(plan) {
                    self.defer_debug_sse(*before);
                }
                if let Some(guard) = guard {
                    self.w.load_fixed_i32(guard.address);
                    self.w.const_i32(guard.mask);
                    self.w.and_i32();
                    self.w.if_void();
                }
                self.prepare_memory_call(*before);
                self.runtime_call(call);
                let outcome = self.w.set_new_local();
                if let Some(success) = success {
                    self.w.get_local(&outcome);
                    self.w.const_i32(*success);
                    self.w.ne_i32();
                    self.w.if_void();
                }
                self.w.get_local(&outcome);
                self.w.const_i32(*fault);
                self.w.ne_i32();
                self.w.if_void();
                self.w.unreachable();
                self.w.block_end();
                self.diagnostic_exit(DiagnosticExit::Fault);
                self.return_to_cpu();
                if success.is_some() {
                    self.w.block_end();
                }
                self.w.free_local(outcome);
                if guard.is_some() {
                    self.w.block_end();
                }
            },
            EffectPlan::X87 {
                opcode,
                modrm,
                outputs,
                call,
            } => {
                let inputs: Vec<_> = call.args[2..]
                    .iter()
                    .filter_map(|arg| match arg {
                        Argument::Value(value) => Some(*value),
                        Argument::I32(_) => None,
                    })
                    .collect();
                self.x87(*opcode, *modrm, &inputs, outputs, call);
            },
            EffectPlan::RmwCommit {
                bytes,
                ticket,
                value,
                observe,
                commit,
                call,
            } => {
                self.get(*ticket);
                self.w.const_i64(32);
                self.w.shr_u_i64();
                self.w.wrap_i64_to_i32();
                self.w.if_void();
                self.observe_state(observe.values, observe.count, true);
                self.runtime_call(call);
                self.state(*commit);
                self.diagnostic_exit(DiagnosticExit::RmwCommit);
                self.return_to_cpu();
                self.w.else_();
                self.get(*ticket);
                self.w.wrap_i64_to_i32();
                let pointer = self.w.set_new_local();
                self.w.get_local(&pointer);
                self.get(*value);
                match bytes {
                    1 => self.w.store_u8(0),
                    2 => self.w.store_aligned_u16(0),
                    4 => self.w.store_unaligned_i32(0),
                    _ => unreachable!(),
                }
                self.finish_ram_store(*commit, &pointer, DiagnosticExit::ScalarStore);
                self.w.free_local(pointer);
                self.w.block_end();
            },
        }
    }
    /// Nonzero when SSE task checking can fault or observe the host. A debug
    /// OSFXSR warning is an observer even when CR0 permits the instruction.
    fn sse_task_observation(&mut self) {
        self.w.load_fixed_i32(gp::cr as u32);
        self.w.const_i32(12);
        self.w.and_i32();
        if cfg!(debug_assertions) {
            self.w.load_fixed_i32(gp::cr as u32 + 4 * 4);
            self.w.const_i32(crate::cpu::cpu::CR4_OSFXSR);
            self.w.and_i32();
            self.w.eqz_i32();
            self.w.or_i32();
        }
    }
    fn defer_debug_sse(&mut self, state: StateId) {
        if cfg!(debug_assertions) && self.cpu {
            // Commit only the completed prefix and return at the opcode. No
            // observer or retirement may precede the interpreter's own decode.
            // The pre-STI guard and diagnostic entry rejection keep this from
            // unwinding an already-active indivisible interrupt shadow.
            self.w.load_fixed_i32(gp::cr as u32 + 4 * 4);
            self.w.const_i32(crate::cpu::cpu::CR4_OSFXSR);
            self.w.and_i32();
            self.w.eqz_i32();
            if let Some(depth) = &self.interrupt_shadow {
                self.w.get_local(depth);
                self.w.eqz_i32();
                self.w.and_i32();
            }
            self.w.if_void();
            self.state(state);
            self.admission_barrier();
            self.diagnostic_exit(DiagnosticExit::HelperYield);
            self.return_to_cpu();
            self.w.block_end();
        }
    }
    fn planned_call(&mut self, id: InstId, plan: &CallPlan) {
        if cfg!(debug_assertions) && self.cpu {
            let call = self.mir.helpers[plan.helper.index()].as_ref().unwrap();
            if debug_sse_call(self.mir, plan)
                || call.starts_interrupt_shadow && self.debug_sse_observer
            {
                self.defer_debug_sse(plan.state);
            }
        }
        if self.cpu
            && self.mir.helpers[plan.helper.index()].as_ref().unwrap().name
                == "ir_sti_finish_continue"
        {
            self.w.call_signature(
                "ir_sti_no_pending_irq",
                crate::ir::helper::imports::signature("ir_sti_no_pending_irq"),
            );
            // Clear before either arm: the slow helper owns the entire unwind,
            // and return_to_cpu must not deliver the same IRQ scope twice.
            self.w.const_i32(0);
            self.w
                .set_local(self.interrupt_shadow.as_ref().expect("completed STI scope"));
            self.w.eqz_i32();
            self.w.if_void();
            self.planned_call_slow(id, plan);
            self.w.block_end();
            return;
        }
        if let Some(fp) = plan.native_fp.filter(|_| self.cpu) {
            let (source, destination) = plan.xmm_observation.unwrap();
            let operand = |reg: u8| {
                self.mir.states[plan.state.index()]
                    .cpu
                    .writes
                    .iter()
                    .find(|w| w.address == Address::Absolute(gp::get_reg_xmm_offset(reg as u32)))
                    .unwrap()
                    .expression
                    .clone()
            };
            let left_steps = operand(destination);
            let right_steps = operand(source);
            self.value_steps(&left_steps);
            let left = self.w.set_new_local_v128();
            self.value_steps(&right_steps);
            let right = self.w.set_new_local_v128();
            self.w.get_local_v128(&left);
            self.w.get_local_v128(&right);
            self.w.simd(fp.opcode);
            let result = self.w.set_new_local_v128();
            // Scalar and ordinary SIMD add/sub/mul/div have the same IEEE
            // result bits except for the permitted choice of NaN payload/sign.
            // Test the result once: result != result detects every NaN lane,
            // including invalid operations with non-NaN operands. Signed zero,
            // subnormals, infinities and overflow remain exact, not fast-math.
            // These baseline arithmetic forms do not update MXCSR. Keep task
            // faults, debug observers and scalar NaNs before architectural writes.
            self.sse_task_observation();
            self.w.get_local_v128(&result);
            self.w.get_local_v128(&result);
            self.w.simd(if fp.double { 0x48 } else { 0x42 }); // f64x2.ne / f32x4.ne
            if fp.scalar {
                // Only lane zero is architecturally evaluated. Upper lanes may
                // contain signalling NaNs and must neither reject nor change.
                self.w.simd_lane(0x1B, 0); // i32x4.extract_lane (low mask word)
            }
            else {
                self.w.simd(0x53);
            } // v128.any_true
            self.w.or_i32();
            self.w.eqz_i32();
            self.w.if_void();
            self.w.get_local_v128(&result);
            if fp.scalar {
                self.w.get_local_v128(&left);
                let bytes = if fp.double { 8 } else { 4 };
                self.w.simd_shuffle(std::array::from_fn(|i| {
                    if i < bytes {
                        i as u8
                    }
                    else {
                        i as u8 + 16
                    }
                }));
            }
            self.set(plan.reload[0].0);
            self.w.else_();
            self.planned_call_slow(id, plan);
            self.w.block_end();
            self.w.free_local_v128(result);
            self.w.free_local_v128(right);
            self.w.free_local_v128(left);
        }
        else {
            self.planned_call_slow(id, plan);
        }
    }
    fn planned_call_slow(&mut self, id: InstId, plan: &CallPlan) {
        // Generic helpers may return after an MMIO/host callback. Revoke before
        // the call, even when its CpuReload continuation keeps executing IR.
        let selective = if self.cpu { plan.xmm_observation } else { None };
        let call = self.mir.helpers[plan.helper.index()].as_ref().unwrap();
        let code_preserved = crate::ir::helper::cpu_registry::preserves_code_on_success(&call.name);
        let segment_continue = self.cpu && call.name == "ir_mov_segment_continue";
        let interrupt_check =
            self.cpu && matches!(call.name.as_str(), "ir_cli_check" | "ir_sti_check");
        if selective.is_none() && !code_preserved && !segment_continue && !interrupt_check {
            self.admission_barrier();
        }
        let trim_state = self.cpu && self.mir.helper_state_observation_elided(id);
        if segment_continue {
            // Real/VM86 segment transfers cannot observe SSA state or host RAM.
            // A descriptor walk can: materialize the full precise snapshot and
            // revoke all certificates before entering that terminal path.
            self.w.load_fixed_u8(gp::protected_mode as u32);
            self.w.load_fixed_i32(gp::flags as u32);
            self.w.const_i32(crate::cpu::cpu::FLAG_VM);
            self.w.and_i32();
            self.w.eqz_i32();
            self.w.and_i32();
            self.w.if_void();
            self.admission_barrier();
            self.prepare_memory_call(plan.state);
            self.w.block_end();
        }
        else if interrupt_check {
            // The normal real-mode / ring-0 non-VM86 path reads only backing
            // privilege bits and cannot observe GPRs, arithmetic flags or RAM.
            // Other paths retain full precise materialization before any fault.
            self.w.load_fixed_u8(gp::protected_mode as u32);
            self.w.eqz_i32();
            self.w.load_fixed_u8(gp::cpl as u32);
            self.w.eqz_i32();
            self.w.load_fixed_i32(gp::flags as u32);
            self.w.const_i32(crate::cpu::cpu::FLAG_VM);
            self.w.and_i32();
            self.w.eqz_i32();
            self.w.and_i32();
            self.w.or_i32();
            self.w.eqz_i32();
            self.w.if_void();
            self.admission_barrier();
            self.prepare_memory_call(plan.state);
            self.w.block_end();
        }
        else if let Some((source, destination)) = selective {
            // Faults and debug OSFXSR logging must see the entire precise
            // state. The ordinary register path synchronizes only operands.
            self.sse_task_observation();
            self.w.if_void();
            self.admission_barrier();
            self.prepare_memory_call(plan.state);
            self.w.else_();
            self.diagnostic_begin(DiagnosticStage::StateWrite);
            for write in &self.mir.states[plan.state.index()].cpu.writes {
                if write.address == Address::Absolute(gp::get_reg_xmm_offset(source as u32))
                    || write.address
                        == Address::Absolute(gp::get_reg_xmm_offset(destination as u32))
                {
                    self.state_write(write);
                }
            }
            self.diagnostic_end();
            self.w.block_end();
        }
        else if !trim_state {
            let observation =
                if self.cpu { plan.cpu_observation } else { plan.standalone_observation };
            match observation {
                Observation::CapturedState => self.state(plan.state),
                Observation::DecodedNextPc => self.prepare_memory_call(plan.state),
            }
        }
        // Observers retain full state synchronization. Only a successful,
        // unchanged execution context may request another cold admission. The
        // pre-call barrier forces source/mapping validation after raw host writes.
        let observer_link = self
            .entry
            .filter(|_| {
                matches!(
                    call.name.as_str(),
                    "ir_in"
                        | "ir_out"
                        | "ir_rdtsc"
                        | "ir_in_continue"
                        | "ir_out_continue"
                        | "ir_rdtsc_continue"
                )
            })
            .map(|entry| {
                self.w.load_fixed_i32(gp::instruction_pointer as u32);
                let next = self.w.set_new_local();
                self.w.load_fixed_u8(gp::cpl as u32);
                let cpl = self.w.set_new_local();
                (entry, next, cpl)
            });
        self.diagnostic_begin(DiagnosticStage::Helper);
        for &arg in &plan.args {
            self.get(arg);
        }
        self.w.call_signature(&call.name, call.signature.clone());
        self.diagnostic_end();
        // Do not assign SSA result slots until the outcome is checked: the
        // allocator may reuse pre-call snapshot slots for normal results.
        let mut staged = Vec::new();
        for slot in &plan.staged {
            staged.push((slot, self.temporary(slot.ty)));
        }
        let outcome = self.w.set_new_local();
        if let Some(delivery) = &plan.delivery {
            self.w.get_local(&outcome);
            self.w.const_i32(delivery.outcome as i32);
            self.w.eq_i32();
            self.w.if_void();
            self.state(delivery.restore);
            self.w
                .call_signature(&delivery.name, delivery.signature.clone());
            self.diagnostic_exit(DiagnosticExit::Fault);
            self.return_to_cpu();
            self.w.block_end();
        }
        for &exit in &plan.exits {
            self.w.get_local(&outcome);
            self.w.const_i32(exit as i32);
            self.w.eq_i32();
            self.w.if_void();
            if code_preserved {
                // CpuExit's Invalidated is its normal committed success. For
                // CpuReload it means continuation failed (e.g. an observer),
                // so CPU-owned post-state must leave this execution chain.
                if exit == 4 && call.cpu_exit && self.linkable_entry {
                    if let Some(depth) = &self.interrupt_shadow {
                        self.w.get_local(depth);
                        self.w.eqz_i32();
                        self.w.if_void();
                    }
                    self.w.call_signature(
                        "ir_request_link",
                        crate::ir::helper::imports::signature("ir_request_link"),
                    );
                    if self.interrupt_shadow.is_some() {
                        self.w.block_end();
                    }
                }
                else {
                    self.admission_barrier();
                }
            }
            if exit == 4 {
                if let Some((entry, next, cpl)) = &observer_link {
                    self.w.get_local(next);
                    self.w.const_i32(entry.cs_base() as i32);
                    self.w.const_i32(i32::from(entry.default_32));
                    self.w.call_signature(
                        "ir_entry_matches",
                        crate::ir::helper::imports::signature("ir_entry_matches"),
                    );
                    self.w.load_fixed_u8(gp::cpl as u32);
                    self.w.get_local(cpl);
                    self.w.eq_i32();
                    self.w.and_i32();
                    if let Some(depth) = &self.interrupt_shadow {
                        self.w.get_local(depth);
                        self.w.eqz_i32();
                        self.w.and_i32();
                    }
                    self.w.if_void();
                    self.w.call_signature(
                        "ir_request_observer_link",
                        crate::ir::helper::imports::signature("ir_request_observer_link"),
                    );
                    self.w.block_end();
                }
            }
            if let Some((base, _)) = &self.diagnostic {
                self.w.get_local(base);
                self.w
                    .const_i32(crate::ir::runtime::diagnostics::helper_category(&call.name) as i32);
                self.w.store_aligned_i32(8);
            }
            self.diagnostic_exit(match exit as u32 {
                3 => DiagnosticExit::HelperYield,
                4 => DiagnosticExit::HelperInvalidated,
                _ => DiagnosticExit::HelperTransfer,
            });
            self.return_to_cpu();
            self.w.block_end();
        }
        if let Some(normal) = plan.normal {
            self.w.get_local(&outcome);
            self.w.const_i32(normal as i32);
            self.w.ne_i32();
            self.w.if_void();
            self.w.unreachable();
            self.w.block_end();
        }
        else {
            self.w.unreachable();
        }
        // A checked observer explicitly revalidated this exact active owner.
        // Refresh the fused poll certificate only on its verified Normal path.
        if crate::ir::helper::cpu_registry::checked_scalar_continuation(&call.name) {
            if let Some((address, epoch)) = &self.fused_epoch {
                self.w.get_local(address);
                self.w.load_unaligned_i64(0);
                self.w.set_local_i64(epoch);
            }
        }
        if call.starts_interrupt_shadow {
            let depth = self.interrupt_shadow.as_ref().expect("STI local");
            self.w.get_local(depth);
            self.w.const_i32(1);
            self.w.add_i32();
            self.w.set_local(depth);
        }
        if !plan.reload.is_empty() {
            self.diagnostic_begin(DiagnosticStage::StateReload);
        }
        for (value, reading) in &plan.reload {
            self.read_value(reading);
            self.set(*value);
        }
        if !plan.reload.is_empty() {
            self.diagnostic_end();
        }
        for (slot, temp) in staged {
            self.get_temporary(&temp);
            self.mask(slot.ty);
            self.set(slot.value);
            self.free_temporary(temp);
        }
        self.w.free_local(outcome);
        if let Some((_, next, cpl)) = observer_link {
            self.w.free_local(next);
            self.w.free_local(cpl);
        }
    }
    fn address(&self, address: Address) -> u32 {
        match address {
            Address::Absolute(n) => n,
            Address::Gpr(reg) => self.layout.gpr + reg as u32 * 4,
            Address::Flags => self.layout.flags,
            Address::FlagOperand => self.layout.flag_operand,
            Address::Eip => self.layout.eip,
            Address::Committed => self.layout.committed,
        }
    }
    fn read_value(&mut self, reading: &Reading) {
        match reading {
            Reading::Constant(n) => self.w.const_i32(*n),
            Reading::Call { name, signature } => self.w.call_signature(name, signature.clone()),
            Reading::Memory { address, load } => {
                let address = self.address(*address);
                match load {
                    Load::U8 => self.w.load_fixed_u8(address),
                    Load::U16 => self.w.load_fixed_u16(address),
                    Load::I32 => self.w.load_fixed_i32(address),
                    Load::V128 => {
                        self.w.const_i32(address as i32);
                        self.w.simd_memory(0, 2);
                    },
                }
            },
        }
    }
    fn value_steps(&mut self, steps: &[Step]) {
        for step in steps {
            match step {
                Step::Value(value) => self.get(*value),
                Step::I32(n) => self.w.const_i32(*n),
                Step::I64(n) => self.w.const_i64(*n),
                Step::Scalar(op) => super::scalar::emit(&mut self.w, *op),
                Step::Read { cpu, standalone } => {
                    self.read_value(if self.cpu { cpu } else { standalone })
                },
                Step::Simd(opcode) => self.w.simd(*opcode),
                Step::Lane { opcode, lane } => self.w.simd_lane(*opcode, *lane),
                Step::Shuffle(lanes) => self.w.simd_shuffle(*lanes),
                Step::Packed {
                    destination,
                    source,
                    plan,
                } => {
                    self.get(*destination);
                    let destination = self.w.set_new_local_v128();
                    self.get(*source);
                    let source = self.w.set_new_local_v128();
                    super::simd::binary(&mut self.w, plan, &destination, &source);
                    self.w.free_local_v128(destination);
                    self.w.free_local_v128(source);
                },
            }
        }
    }
    fn planned_value(&mut self, plan: &ValuePlan) {
        self.value_steps(&plan.steps);
        self.set(plan.result);
    }
    /// Epoch invalidation after an observer is still checked at the original
    /// instruction boundary, including bodies with prepaid dispatcher credits.
    fn check_poll(
        &mut self,
        state: Option<StateId>,
        remaining: Option<&WasmLocal>,
        check_epoch: bool,
    ) {
        self.check_poll_cost(state, remaining, 1, check_epoch)
    }
    /// A poll charging `cost` credits exits first when fewer remain.
    fn check_poll_cost(
        &mut self,
        state: Option<StateId>,
        remaining: Option<&WasmLocal>,
        cost: u32,
        check_epoch: bool,
    ) {
        // Diagnostic callbacks and deferred interrupt-shadow checks are kept
        // conservative. Their observation/deferral is not part of the local
        // straight-line proof above.
        let check_epoch =
            check_epoch || self.diagnostic.is_some() || self.interrupt_shadow.is_some();
        let epoch = self.fused_epoch.as_ref().filter(|_| check_epoch);
        if let Some(state) = state.filter(|_| remaining.is_some() || epoch.is_some()) {
            if let Some(remaining) = remaining {
                self.w.get_local(remaining);
                if cost > 1 {
                    self.w.const_i32(cost as i32);
                    self.w.ltu_i32();
                }
                else {
                    self.w.eqz_i32();
                }
            }
            if let Some((address, epoch)) = epoch {
                self.w.get_local(address);
                self.w.load_unaligned_i64(0);
                self.w.get_local_i64(epoch);
                self.w.ne_i64();
                if remaining.is_some() {
                    self.w.or_i32();
                }
            }
            if let Some(depth) = &self.interrupt_shadow {
                self.w.get_local(depth);
                self.w.eqz_i32();
                self.w.and_i32();
            }
            self.w.if_void();
            self.diagnostic_exit(DiagnosticExit::Budget);
            if let Some((address, epoch)) = self
                .fused_epoch
                .as_ref()
                .filter(|_| self.diagnostic.is_some())
            {
                self.w.get_local(address);
                self.w.load_unaligned_i64(0);
                self.w.get_local_i64(epoch);
                self.w.ne_i64();
                self.w.if_void();
                self.diagnostic_exit(DiagnosticExit::Epoch);
                self.w.block_end();
            }
            self.state(state);
            // Polls are distinct from opaque helper/fault exits. Do not revoke a
            // still-current byte certificate solely because local credits ran
            // out. No link is requested and no epoch is refreshed. Shadow and
            // diagnostic exits retain the conservative observer treatment.
            if self.linkable_entry && self.interrupt_shadow.is_none() && self.diagnostic.is_none() {
                self.w.call_signature(
                    "ir_request_poll_exit",
                    crate::ir::helper::imports::signature("ir_request_poll_exit"),
                );
            }
            self.return_to_cpu();
            self.w.block_end();
        }
    }
    fn poll(&mut self, state: Option<StateId>, cost: u32, remaining: &WasmLocal) {
        self.poll_with_epoch(state, cost, remaining, true);
    }
    fn poll_with_epoch(
        &mut self,
        state: Option<StateId>,
        cost: u32,
        remaining: &WasmLocal,
        check_epoch: bool,
    ) {
        self.check_poll_cost(state, Some(remaining), cost, check_epoch);
        self.w.get_local(remaining);
        self.w.const_i32(cost as i32);
        self.w.sub_i32();
        self.w.set_local(remaining);
    }
    fn instruction(&mut self, id: InstId, remaining: &WasmLocal) {
        if self.mir.stack_instruction_elided(id) {
            return;
        }
        let mir = self.mir;
        if let Some(plan) = &mir.control.polls[id.index()] {
            self.poll_with_epoch(
                Some(plan.recovery),
                plan.cost,
                remaining,
                self.instruction_epoch_check(id),
            );
        }
        else if let Some(plan) = &mir.memory[id.index()] {
            self.memory_with_forwarding(
                plan,
                mir.ram_forwarding(id),
                mir.ram_loop_cache(id),
                mir.ram_guard_reuse(id),
            );
        }
        else if let Some(plan) = &mir.effects[id.index()] {
            self.planned_effect(plan);
            if mir.ram_forwarding(id) == Some(Forwarding::Begin) {
                let EffectPlan::RmwCommit { value, .. } = plan
                else {
                    unreachable!("verified RMW forwarding certificate")
                };
                // Slow tickets and code aliases already returned. Seed only
                // after the successful native write and continuation guard.
                self.get(*value);
                self.mask(mir.value_types[value.index()]);
                self.cache_set_value(MemoryCache::Chain);
                self.cache_mark_valid(MemoryCache::Chain);
            }
        }
        else if let Some(plan) = &mir.calls[id.index()] {
            self.planned_call(id, plan);
        }
        else {
            if self.cpu && !mir.cpu_instruction_live(id) {
                return;
            }
            self.planned_value(mir.values[id.index()].as_ref().unwrap());
        }
    }
}

pub fn emit(mir: &MirRegion, layout: StateLayout, budget: u32) -> Result<Artifact, CompileError> {
    emit_inner(mir, layout, budget, false, None, &[], false, &[], false)
}
/// Cold CPU entry. Uses actual CPU globals and MMU.
pub fn emit_cpu(mir: &MirRegion, budget: u32) -> Result<Artifact, CompileError> {
    emit_cpu_inner(mir, budget, None, &[], false, &[], false)
}
/// CPU ABI fixture with an explicit immutable physical code dependency set.
pub(crate) fn emit_cpu_with_code_pages(
    mir: &MirRegion,
    budget: u32,
    code_pages: &[u32],
) -> Result<Artifact, CompileError> {
    emit_cpu_inner(mir, budget, None, code_pages, false, &[], false)
}
/// CompileRequest owns the association between this key and the lifted guest bytes.
pub(crate) fn emit_cpu_entry(
    mir: &MirRegion,
    budget: u32,
    entry: CpuEntryKey,
    code_pages: &[u32],
) -> Result<Artifact, CompileError> {
    if mir.control.entries.len() != 1 {
        return Err(CompileError::Unsupported(
            "CPU entry key requires a single external entry",
        ));
    }
    emit_cpu_inner(mir, budget, Some(entry), code_pages, false, &[], false)
}
pub(crate) fn emit_cpu_fused_entry(
    mir: &MirRegion,
    budget: u32,
    entry: CpuEntryKey,
    code_pages: &[u32],
) -> Result<Artifact, CompileError> {
    if mir.control.entries.len() != 1 {
        return Err(CompileError::Unsupported(
            "fused entry requires one cold root",
        ));
    }
    emit_cpu_inner(mir, budget, Some(entry), code_pages, true, &[], false)
}
/// A single function/table owner for several instruction-aligned cold entries.
/// The runtime still validates the whole immutable code snapshot on admission.
pub(crate) fn emit_cpu_shared_entry(
    mir: &MirRegion,
    budget: u32,
    entry: CpuEntryKey,
    aliases: &[CpuEntryKey],
    code_pages: &[u32],
    fused: bool,
) -> Result<Artifact, CompileError> {
    if aliases.is_empty() || aliases.len() > 7 || mir.control.entries.len() != 1 {
        return Err(CompileError::Budget("shared CPU entry count"));
    }
    for (i, alias) in aliases.iter().enumerate() {
        if *alias == entry
            || aliases[..i].contains(alias)
            || alias.cs_base() != entry.cs_base()
            || alias.default_32 != entry.default_32
        {
            return Err(CompileError::InvalidIr(
                "incompatible shared CPU entry".into(),
            ));
        }
    }
    emit_cpu_inner(mir, budget, Some(entry), code_pages, fused, aliases, false)
}
/// A page function: one exact-PC membership test over every served entry and
/// a single context guard, instead of one guarded import call per alias.
pub(crate) fn emit_cpu_page_entry(
    mir: &MirRegion,
    budget: u32,
    entry: CpuEntryKey,
    aliases: &[CpuEntryKey],
    code_pages: &[u32],
) -> Result<Artifact, CompileError> {
    if aliases.len() >= crate::ir::frontend::region::CfgLimits::PAGE.entries
        || mir.control.entries.len() != 1
    {
        return Err(CompileError::Budget("page CPU entry count"));
    }
    for (i, alias) in aliases.iter().enumerate() {
        if *alias == entry
            || aliases[..i].contains(alias)
            || alias.cs_base() != entry.cs_base()
            || alias.default_32 != entry.default_32
        {
            return Err(CompileError::InvalidIr(
                "incompatible page CPU entry".into(),
            ));
        }
    }
    emit_cpu_inner(mir, budget, Some(entry), code_pages, false, aliases, true)
}
fn emit_cpu_inner(
    mir: &MirRegion,
    budget: u32,
    entry: Option<CpuEntryKey>,
    code_pages: &[u32],
    fused: bool,
    aliases: &[CpuEntryKey],
    page: bool,
) -> Result<Artifact, CompileError> {
    emit_inner(
        mir,
        StateLayout {
            gpr: gp::reg32 as u32,
            flags: gp::flags as u32,
            eip: gp::instruction_pointer as u32,
            committed: gp::instruction_counter as u32,
            flag_operand: gp::last_op1 as u32,
        },
        budget,
        true,
        entry,
        code_pages,
        fused,
        aliases,
        page,
    )
}
fn emit_inner(
    mir: &MirRegion,
    layout: StateLayout,
    budget: u32,
    cpu: bool,
    entry: Option<CpuEntryKey>,
    code_pages: &[u32],
    fused: bool,
    aliases: &[CpuEntryKey],
    page: bool,
) -> Result<Artifact, CompileError> {
    emit_inner_with_batches(
        mir, layout, budget, cpu, entry, code_pages, fused, aliases, page, true, true,
    )
}
fn emit_inner_with_batches(
    mir: &MirRegion,
    layout: StateLayout,
    budget: u32,
    cpu: bool,
    entry: Option<CpuEntryKey>,
    code_pages: &[u32],
    fused: bool,
    aliases: &[CpuEntryKey],
    page: bool,
    batch_polls: bool,
    elide_epoch_polls: bool,
) -> Result<Artifact, CompileError> {
    #[cfg(test)]
    if crate::ir::debug::audit() {
        mir.verify()?;
    }
    // MirRegion can only be constructed by the checked lowering transaction.
    // Its machine plans and allocation are immutable across this boundary.
    require_features(
        mir,
        cfg!(not(target_arch = "wasm32")) || cfg!(target_feature = "simd128"),
    )?;
    crate::ir::helper::imports::verify(mir)?;
    mir.verify_ram_guard_reuse()?;
    mir.control.check_target(cpu)?;
    if !cpu && !code_pages.is_empty() {
        return Err(CompileError::InvalidIr(
            "standalone emitter cannot own CPU code dependencies".into(),
        ));
    }
    if code_pages.len() > 8 {
        return Err(CompileError::Budget("code dependency pages"));
    }
    for (index, page) in code_pages.iter().enumerate() {
        if page & 4095 != 0 || code_pages[..index].contains(page) {
            return Err(CompileError::InvalidIr(
                "invalid or duplicate physical code page".into(),
            ));
        }
    }
    if !cpu && mir.states.iter().any(|state| state.requires_cpu) {
        return Err(CompileError::Unsupported("XMM state requires CPU ABI"));
    }
    if !cpu
        && mir
            .helpers
            .iter()
            .flatten()
            .any(|call| call.cpu_exit || call.cpu_reload)
    {
        return Err(CompileError::Unsupported(
            "terminal helper requires CPU ABI",
        ));
    }
    if !cpu
        && (mir.memory.iter().any(Option::is_some)
            || mir.effects.iter().any(Option::is_some)
            || mir.values.iter().flatten().any(|plan| plan.requires_cpu))
    {
        return Err(CompileError::Unsupported("guest memory requires CPU ABI"));
    }
    if budget == 0 || budget > i32::MAX as u32 {
        return Err(CompileError::Budget("invalid execution budget"));
    }
    if [
        layout.gpr,
        layout.flags,
        layout.eip,
        layout.committed,
        layout.flag_operand,
    ]
    .iter()
    .any(|a| a % 4 != 0 || *a > 64 * 65536 - 32)
    {
        return Err(CompileError::Unsupported(
            "state layout outside imported memory minimum",
        ));
    }
    let fields = [
        (layout.gpr, 32),
        (layout.flags, 4),
        (layout.eip, 4),
        (layout.committed, 4),
        (layout.flag_operand, 4),
    ];
    for (i, &(start, len)) in fields.iter().enumerate() {
        if fields[..i]
            .iter()
            .any(|&(other, size)| start < other + size && other < start + len)
        {
            return Err(CompileError::Unsupported("overlapping state layout"));
        }
    }
    if cpu {
        let reserved = crate::ir::mir::CPU_IMPORTS;
        for helper in mir.helpers.iter().flatten() {
            if reserved.contains(&helper.name.as_str())
                || helper
                    .fault_delivery
                    .as_ref()
                    .is_some_and(|n| reserved.contains(&n.as_str()))
            {
                return Err(CompileError::InvalidIr(
                    "helper shadows CPU ABI import".into(),
                ));
            }
        }
    }
    let mut e = Emitter {
        w: WasmBuilder::new(),
        mir,
        locals: (0..mir.allocation.local_types.len()).map(|_| None).collect(),
        layout,
        cpu,
        linkable_entry: entry.is_some(),
        entry,
        accounted: None,
        tlb: None,
        read_cache: None,
        guard_cache: None,
        loop_read_caches: vec![],
        code_pages,
        memory_base: None,
        interrupt_shadow: None,
        fused_epoch: None,
        epoch_polls: if fused && elide_epoch_polls {
            required_epoch_polls(mir)
        }
        else {
            Vec::new()
        },
        diagnostic: None,
        debug_sse_observer: cfg!(debug_assertions) && cpu
            && (mir.effects.iter().flatten().any(debug_sse_effect)
                || mir.calls.iter().flatten().any(|plan| debug_sse_call(mir, plan))),
        batch_polls,
        budget_batch_blocks: 0,
    };
    if e.debug_sse_observer {
        // Debug OSFXSR warnings are host observers before operand/immediate
        // decoding. Decline before ir_enter, state materialization or STI.
        // Diagnostic imports could clear OSFXSR after a later guard, even
        // inside an indivisible shadow, so that debug combination always
        // defers before invoking its first diagnostic observer. The existing
        // zero-step cache rule retires the owner and permits interpretation.
        if diag::enabled() {
            e.w.const_i32(1);
        }
        else {
            e.w.load_fixed_i32(gp::cr as u32 + 4 * 4);
            e.w.const_i32(crate::cpu::cpu::CR4_OSFXSR);
            e.w.and_i32();
            e.w.eqz_i32();
        }
        e.w.if_void();
        e.w.return_();
        e.w.block_end();
    }
    // Diagnostic policy is fixed at compilation; changing it invalidates all
    // artifacts. Ordinary builds emit no diagnostic instructions/imports.
    if entry.is_some() && diag::enabled() {
        e.w.call_signature(
            "ir_diagnostic_address",
            crate::ir::helper::imports::signature("ir_diagnostic_address"),
        );
        let base = e.w.set_new_local();
        e.w.get_local(&base);
        e.w.load_aligned_i32(0);
        let active = e.w.set_new_local();
        e.diagnostic = Some((base, active));
    }
    if mir
        .helpers
        .iter()
        .flatten()
        .any(|call| call.starts_interrupt_shadow)
    {
        if !cpu {
            return Err(CompileError::Unsupported("STI requires CPU ABI"));
        }
        e.w.const_i32(0);
        e.interrupt_shadow = Some(e.w.set_new_local());
    }
    if let Some(entry) = entry {
        // Reject before ir_enter (which writes previous_ip and clears REP results),
        // before any state loads/materialization, and before any guest access/helper.
        e.w.get_local(&e.w.arg_local_initial_state.unsafe_clone());
        e.w.if_void();
        e.diagnostic_exit(DiagnosticExit::EntryGuard);
        e.return_to_cpu();
        e.w.block_end();
        if page {
            // Exact-PC membership over every served entry, then one import for
            // the remaining context and entry initialization. Both rejections
            // happen before any state load and leave CPU/REP state untouched.
            e.w.load_fixed_i32(gp::instruction_pointer as u32);
            let eip = e.w.set_new_local();
            for (i, key) in std::iter::once(&entry).chain(aliases).enumerate() {
                e.w.get_local(&eip);
                e.w.const_i32(key.linear.0 as i32);
                e.w.eq_i32();
                if i != 0 {
                    e.w.or_i32();
                }
            }
            e.w.free_local(eip);
            e.w.eqz_i32();
            e.w.if_void();
            e.diagnostic_exit(DiagnosticExit::EntryGuard);
            e.return_to_cpu();
            e.w.block_end();
            e.w.const_i32(entry.cs_base() as i32);
            e.w.const_i32(i32::from(entry.default_32));
            e.w.call_signature(
                "ir_enter_page",
                crate::ir::helper::imports::signature("ir_enter_page"),
            );
            e.w.eqz_i32();
            e.w.if_void();
            e.diagnostic_exit(DiagnosticExit::EntryGuard);
            e.return_to_cpu();
            e.w.block_end();
        }
        else {
        e.w.const_i32(entry.linear.0 as i32);
        e.w.const_i32(entry.cs_base() as i32);
        e.w.const_i32(i32::from(entry.default_32));
        // Single-entry modules need only one opaque Wasm-to-Wasm import for
        // context validation plus REP/previous-IP initialization. Rejections
        // must remain effect-free; shared aliases retain their separate guard.
        let guard = if aliases.is_empty() { "ir_enter_checked" } else { "ir_entry_matches" };
        e.w.call_signature(guard, crate::ir::helper::imports::signature(guard));
        for alias in aliases {
            e.w.const_i32(alias.linear.0 as i32);
            e.w.const_i32(alias.cs_base() as i32);
            e.w.const_i32(i32::from(alias.default_32));
            e.w.call_signature(
                "ir_entry_matches",
                crate::ir::helper::imports::signature("ir_entry_matches"),
            );
            e.w.or_i32();
        }
        e.w.eqz_i32();
        e.w.if_void();
        e.diagnostic_exit(DiagnosticExit::EntryGuard);
        e.return_to_cpu();
        e.w.block_end();
        }
    }
    if cpu {
        if entry.is_none() || !aliases.is_empty() && !page {
            e.w.call_signature(
                "ir_enter",
                crate::ir::helper::imports::signature("ir_enter"),
            );
        }
        if fused {
            e.w.call_signature(
                "ir_admission_epoch_address",
                crate::ir::helper::imports::signature("ir_admission_epoch_address"),
            );
            let address = e.w.set_new_local();
            e.w.get_local(&address);
            e.w.load_unaligned_i64(0);
            let epoch = e.w.set_new_local_i64();
            e.w.get_local_i64(&epoch);
            e.w.const_i64(-1);
            e.w.eq_i64();
            e.w.if_void();
            e.diagnostic_exit(DiagnosticExit::EntryGuard);
            e.return_to_cpu();
            e.w.block_end();
            e.fused_epoch = Some((address, epoch));
        }
        e.w.const_i32(0);
        e.accounted = Some(e.w.set_new_local());
        // Imported functions are opaque to the host Wasm optimizer, even when
        // they only return a pointer. Do not pay two imports on every register-
        // only region. Derive requirements from the owned, verified machine
        // plans, including CMPXCHG8B and RMW's separate commit effect.
        let needs_tlb = mir.memory.iter().any(Option::is_some)
            || mir.effects.iter().flatten().any(|plan| {
                matches!(
                    plan,
                    EffectPlan::Arithmetic(ArithmeticPlan::CompareExchange(_))
                )
            });
        let needs_memory_base = mir.memory.iter().flatten().any(|plan| {
            matches!(
                plan.native,
                NativeMemory::ScalarStore {
                    commit: Some(_),
                    ..
                } | NativeMemory::VectorStore { .. }
            )
        }) || mir
            .effects
            .iter()
            .flatten()
            .any(|plan| matches!(plan, EffectPlan::RmwCommit { .. }));
        if needs_tlb {
            // One load from a fixed CPU slot instead of an import call: code
            // generated by another build of the core stays position-independent.
            e.w.load_fixed_i32(gp::ir_tlb_base as u32);
            e.tlb = Some(e.w.set_new_local());
        }
        if needs_memory_base && !code_pages.is_empty() {
            e.w.call_signature(
                "ir_memory_base",
                crate::ir::helper::imports::signature("ir_memory_base"),
            );
            e.memory_base = Some(e.w.set_new_local());
        }
    }
    if mir.has_ram_forwarding() {
        e.w.const_i32(0);
        let valid = e.w.set_new_local();
        e.w.const_i32(0);
        let value = e.w.set_new_local();
        e.read_cache = Some((valid, value));
    }
    if mir.has_ram_guard_reuse() {
        e.w.const_i32(0);
        let valid = e.w.set_new_local();
        e.w.const_i32(0);
        let entry = e.w.set_new_local();
        e.guard_cache = Some((valid, entry));
    }
    for _ in 0..mir.ram_loop_cache_slots() {
        e.w.const_i32(0);
        let valid = e.w.set_new_local();
        e.w.const_i32(0);
        let value = e.w.set_new_local();
        e.loop_read_caches.push((valid, value));
    }
    let structured = structure::structure(&mir.control);
    let structured_cfg = structured.is_some();
    let structured_backedges = structured.as_ref().map_or(0, |plan| plan.backedges);
    let structured_edges = structured.as_ref().map_or(0, |plan| plan.edges);
    let generic_dispatch_edges = if structured_cfg { 0 } else { control_edge_count(mir) };

    e.w.const_i32(budget as i32);
    let remaining = e.w.set_new_local();
    let mut pc = None;
    if let Some(plan) = &structured {
        if mir.control.entries.len() == 1 {
            // A direct structured function has exactly one external entry.
            // Preserve the generic dispatcher's initial_state ABI: entry zero is
            // valid, every other selector returns without guest side effects.
            e.w.get_local(&e.w.arg_local_initial_state.unsafe_clone());
            e.w.if_void();
            e.diagnostic_exit(DiagnosticExit::EntryGuard);
            e.return_to_cpu();
            e.w.block_end();
        }
        e.emit_structured(&plan.roots, &remaining);
    }
    else {
        e.w.const_i32(-1);
        let pc_local = e.w.set_new_local();
        for (i, entry) in mir.control.entries.iter().enumerate() {
            e.w.get_local(&e.w.arg_local_initial_state.unsafe_clone());
            e.w.const_i32(i as i32);
            e.w.eq_i32();
            e.w.if_void();
            e.w.const_i32(entry.0 as i32);
            e.w.set_local(&pc_local);
            e.w.block_end();
        }
        e.w.get_local(&pc_local);
        e.w.const_i32(-1);
        e.w.eq_i32();
        e.w.if_void();
        e.diagnostic_exit(DiagnosticExit::EntryGuard);
        e.return_to_cpu();
        e.w.block_end();
        // O(1) dispatch: a br_table jump table over nested blocks, each block
        // body placed after its block's end. Every body ends in a branch back
        // to the dispatcher or a return, so bodies never fall through.
        let dispatch = e.w.loop_void();
        let n = mir.control.blocks.len();
        let mut labels: Vec<_> = (0..n).map(|_| e.w.block_void()).collect();
        labels.reverse();
        let invalid = e.w.block_void();
        e.w.get_local(&pc_local);
        e.w.brtable(invalid, &mut labels.iter());
        e.w.block_end();
        e.w.unreachable();
        for b in 0..n {
            e.w.block_end();
            e.emit_block_body(BlockId(b as u32), &remaining, true);
            let terminator = e.terminator(BlockId(b as u32)).clone();
            match &terminator {
                MirTerminator::Exit(state) => {
                    e.normal_exit(*state);
                },
                MirTerminator::Jump(edge) => {
                    e.copy_edge(edge, &pc_local);
                    e.w.br(dispatch);
                },
                MirTerminator::Branch {
                    condition,
                    taken,
                    not_taken,
                } => {
                    e.get_local(*condition);
                    e.w.if_void();
                    e.copy_edge(taken, &pc_local);
                    e.w.else_();
                    e.copy_edge(not_taken, &pc_local);
                    e.w.block_end();
                    e.w.br(dispatch);
                },
            }
        }
        e.w.block_end();
        e.w.unreachable();
        pc = Some(pc_local);
    }
    let locals = e.w.declared_local_count();
    for local in e.locals.into_iter().flatten() {
        match local {
            Local::I32(local) => e.w.free_local(local),
            Local::I64(local) => e.w.free_local_i64(local),
            Local::V128(local) => e.w.free_local_v128(local),
        }
    }
    if let Some(pc) = pc {
        e.w.free_local(pc);
    }
    e.w.free_local(remaining);
    if let Some(local) = e.interrupt_shadow {
        e.w.free_local(local);
    }
    if let Some((base, active)) = e.diagnostic {
        e.w.free_local(base);
        e.w.free_local(active);
    }
    if let Some((address, epoch)) = e.fused_epoch {
        e.w.free_local(address);
        e.w.free_local_i64(epoch);
    }
    if let Some(local) = e.accounted {
        e.w.free_local(local);
    }
    if let Some(local) = e.tlb {
        e.w.free_local(local);
    }
    if let Some((valid, value)) = e.read_cache {
        e.w.free_local(valid);
        e.w.free_local(value);
    }
    if let Some((valid, entry)) = e.guard_cache {
        e.w.free_local(valid);
        e.w.free_local(entry);
    }
    for (valid, value) in e.loop_read_caches {
        e.w.free_local(valid);
        e.w.free_local(value);
    }
    if let Some(local) = e.memory_base {
        e.w.free_local(local);
    }
    e.w.finish();
    let bytes = e.w.output().to_vec();
    // Page functions cover a whole code page; hot-window regions stay small.
    if bytes.len() > if page { 1024 * 1024 } else { 256 * 1024 } {
        // Duplication must not turn an otherwise compilable region into a stop.
        // Roll back at most once; no half-built artifact can be published.
        if e.budget_batch_blocks != 0 {
            return emit_inner_with_batches(
                mir, layout, budget, cpu, entry, code_pages, fused, aliases, page, false,
                elide_epoch_polls,
            );
        }
        return Err(CompileError::Budget("Wasm bytes"));
    }
    Ok(Artifact {
        bytes,
        locals,
        structured_cfg,
        structured_backedges,
        structured_edges,
        generic_dispatch_edges,
        budget_batch_blocks: e.budget_batch_blocks,
    })
}

/// A portable core must reject vector artifacts before handing bytes to the host.
/// The automatic compiler records a compile stop and resumes the interpreter.
pub(crate) fn require_features(mir: &MirRegion, simd128: bool) -> Result<(), CompileError> {
    // Include eliminated/stack-only vector values conservatively: local allocation
    // alone is not a complete inventory of instructions and reload temporaries.
    if !simd128 && mir.value_types.contains(&Type::V128) {
        return Err(CompileError::Unsupported(
            "Wasm SIMD unavailable; interpreter fallback",
        ));
    }
    Ok(())
}
#[cfg(test)]
#[path = "../../../../tests/ir/semantics/epoch_poll.rs"]
mod epoch_poll_tests;

#[cfg(test)]
mod feature_tests {
    use super::*;
    use crate::ir::{
        frontend::{
            decode::{GuestEip, LinearAddress},
            lift::lift_cpu,
        },
        lowering::lower,
    };
    #[test]
    fn portable_core_rejects_vector_artifacts_before_publication() {
        for (bytes, vector) in [
            (&[0x40][..], false),
            (&[0x66, 0x0F, 0xFC, 0xC1][..], true),
            (&[0x0F, 0x58, 0xC1][..], true),
        ] {
            let r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
            let mir = lower(&r).unwrap();
            require_features(&mir, true).unwrap();
            assert_eq!(require_features(&mir, false).is_err(), vector);
        }
    }
}
