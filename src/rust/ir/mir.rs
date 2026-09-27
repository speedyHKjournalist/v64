//! Owned machine plans. HIR is borrowed only while checking the lowering boundary.
pub mod allocation;
pub mod arithmetic;
pub mod budget;
pub mod call;
pub mod control;
pub mod cpu_liveness;
pub mod effect;
pub mod forwarding;
pub mod helper_state;
pub mod materialize;
pub mod memory;
mod optimize;
pub mod stack;
pub mod state_elision;
pub mod value;
pub mod vector;
use super::{backend::locals::Allocation, hir::Region, lowering::CompileError, types::Type};
use crate::wasmgen::wasm_builder::Signature;
use std::ops::{Deref, DerefMut};
/// Legalized import and cold-path policy, distinct from the HIR descriptor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelperCall {
    pub name: String,
    /// CpuExit or CpuRep: no cached SSA state may resume after this call.
    pub cpu_exit: bool,
    pub starts_interrupt_shadow: bool,
    pub cpu_reload: bool,
    pub signature: Signature,
    pub fault_delivery: Option<String>,
    pub exit_outcomes: Vec<u32>,
}
pub struct MirData {
    pub value_types: Vec<Type>,
    /// Definition provenance retained as owned MIR data after HIR destruction.
    pub(super) value_blocks: Vec<Option<super::ids::BlockId>>,
    pub(super) value_definitions: Vec<Option<super::ids::InstId>>,
    pub allocation: Allocation,
    pub(super) allocation_graph: allocation::Graph,
    pub(super) stack_elided: Vec<bool>,
    pub helpers: Vec<Option<HelperCall>>,
    pub memory: Vec<Option<memory::MemoryPlan>>,
    pub effects: Vec<Option<effect::EffectPlan>>,
    pub calls: Vec<Option<call::CallPlan>>,
    pub control: control::ControlFlow,
    pub(super) poll_batches: Vec<Option<budget::Batch>>,
    pub values: Vec<Option<value::ValuePlan>>,
    pub states: Vec<materialize::StatePlan>,
    pub(super) ram_forwarding: Vec<Option<forwarding::Forwarding>>,
    pub(super) ram_guard_reuse: Vec<Option<forwarding::Forwarding>>,
    pub(super) ram_loop_cache: forwarding::LoopPlan,
    pub(super) state_elision: state_elision::Plan,
    pub(super) helper_state: helper_state::Plan,
    pub(super) cpu_liveness: cpu_liveness::Plan,
}

/// Verified, owned MIR. No mutable dereference: transformations must preserve the
/// checked machine contracts through an explicit MIR API.
pub struct MirRegion {
    data: MirData,
}
impl Deref for MirRegion {
    type Target = MirData;
    fn deref(&self) -> &MirData { &self.data }
}
impl MirRegion {
    /// Independent post-lowering graph, type, allocation and proof validation.
    pub fn verify(&self) -> Result<(), CompileError> {
        allocation::verify(&self.data, 4_000_000)?;
        super::helper::imports::verify(&self.data)?;
        forwarding::verify(&self.data)?;
        state_elision::verify_owned(&self.data)?;
        budget::verify(&self.data)?;
        cpu_liveness::verify_owned(&self.data)
    }

    /// Prove bounded unit-cost reservations using owned MIR. Mixed loops
    /// retain every epoch poll; only observer-free suffixes may omit them.
    pub fn batch_pure_budget_polls(&mut self, work_limit: usize) -> Result<usize, CompileError> {
        budget::enable(&mut self.data, work_limit)
    }
    pub(crate) fn budget_batch(&self, block: super::ids::BlockId) -> Option<budget::Batch> {
        self.data.poll_batches[block.index()]
    }

    pub fn reuse_ram_guards(&mut self, work_limit: usize) -> Result<usize, CompileError> {
        forwarding::optimize_guards(&mut self.data, work_limit)
    }
    pub(crate) fn ram_guard_reuse(&self, id: super::ids::InstId) -> Option<forwarding::Forwarding> {
        self.data.ram_guard_reuse[id.index()]
    }
    pub(crate) fn has_ram_guard_reuse(&self) -> bool {
        self.data.ram_guard_reuse.iter().any(Option::is_some)
    }
    pub(crate) fn verify_ram_guard_reuse(&self) -> Result<(), CompileError> {
        forwarding::verify_guards(&self.data)
    }
    /// Enable guarded repeated scalar reads from ordinary RAM. This transformation
    /// uses owned MIR only, with transactional work-budget failure.
    pub fn forward_ram_reads(&mut self, work_limit: usize) -> Result<usize, CompileError> {
        forwarding::optimize(&mut self.data, work_limit)
    }
    pub fn ram_forwarding(&self, id: super::ids::InstId) -> Option<forwarding::Forwarding> {
        self.data.ram_forwarding[id.index()]
    }
    pub fn has_ram_forwarding(&self) -> bool {
        self.data.ram_forwarding.iter().any(Option::is_some)
    }

    /// Cache loop-invariant ordinary-RAM loads only after their original native
    /// guard succeeds. Preheaders reset cache validity on every loop entry.
    pub fn cache_loop_invariant_ram_reads(
        &mut self,
        work_limit: usize,
    ) -> Result<usize, CompileError> {
        forwarding::optimize_loops(&mut self.data, work_limit)
    }
    pub(crate) fn ram_loop_cache(
        &self,
        id: super::ids::InstId,
    ) -> Option<forwarding::LoopForwarding> {
        self.data.ram_loop_cache.instructions[id.index()]
    }
    pub(crate) fn ram_loop_resets(&self, block: super::ids::BlockId) -> &[usize] {
        &self.data.ram_loop_cache.resets[block.index()]
    }
    pub(crate) fn ram_loop_cache_slots(&self) -> usize { self.data.ram_loop_cache.slots }

    /// Skip CPU state stores that are proven identical to the backing state at
    /// entry. The certificate is derived while HIR is still available; enabling
    /// it later is bounded and does not rewrite SSA, recovery maps or CFG edges.
    pub fn elide_redundant_cpu_state_writes(
        &mut self,
        work_limit: usize,
    ) -> Result<usize, CompileError> {
        state_elision::enable(&mut self.data, work_limit)
    }
    /// Cold Tier 1 reuses the lowering certificate without deriving additional
    /// post-observer facts. No SSA, memory or recovery point is rewritten.
    pub fn elide_entry_cpu_state_writes(
        &mut self,
        work_limit: usize,
    ) -> Result<usize, CompileError> {
        state_elision::enable_entry(&mut self.data, work_limit)
    }
    pub(crate) fn cpu_state_write_elided(&self, state: super::ids::StateId, write: usize) -> bool {
        state_elision::elided(&self.data, state, write)
    }

    /// Enable audited omission of pre-call CPU StateMap writes for helpers that
    /// are proven pure and state-independent.
    pub fn elide_helper_state_observations(
        &mut self,
        work_limit: usize,
    ) -> Result<usize, CompileError> {
        helper_state::enable(&mut self.data, work_limit)
    }
    pub(crate) fn helper_state_observation_elided(&self, id: super::ids::InstId) -> bool {
        helper_state::elided(&self.data, id)
    }

    /// Enable CPU-only post-lowering liveness. Standalone emission keeps the
    /// complete generic SSA graph; CPU emission may skip pure value programs
    /// not referenced by the CPU recovery plan or guest semantics.
    pub fn elide_dead_cpu_values(&mut self, work_limit: usize) -> Result<usize, CompileError> {
        cpu_liveness::enable(&mut self.data, work_limit)
    }
    pub(crate) fn cpu_instruction_live(&self, id: super::ids::InstId) -> bool {
        cpu_liveness::instruction_live(&self.data, id)
    }
    pub(crate) fn cpu_terminator(&self, id: super::ids::BlockId) -> &control::Terminator {
        cpu_liveness::terminator(&self.data, id)
    }

    /// Fuse adjacent single-use scalar programs after HIR has been discarded.
    pub fn schedule_operand_stack(&mut self, work_limit: usize) -> Result<usize, CompileError> {
        stack::schedule(&mut self.data, work_limit)
    }
    /// Recompute typed interference and phi-copy schedules from owned MIR facts.
    pub fn allocate_machine_locals(&mut self, work_limit: usize) -> Result<usize, CompileError> {
        let saved = allocation::reallocate(&mut self.data, work_limit)?;
        cpu_liveness::invalidate_control(&mut self.data);
        Ok(saved)
    }
    pub(crate) fn stack_instruction_elided(&self, id: super::ids::InstId) -> bool {
        self.data.stack_elided[id.index()]
    }

    /// Fold literal machine operations without changing definitions, effects,
    /// local assignments or recovery points. The update is transactional.
    pub fn fold_constants(&mut self) -> Result<usize, CompileError> {
        optimize::fold_constants(&mut self.data)
    }
}

/// Transient lowering transaction. It cannot be emitted and never clones HIR.
pub struct Draft<'a> {
    pub(super) hir: &'a Region,
    hir_witness: &'a Region,
    pub(super) data: MirData,
    // The allocator runs once on the immutably borrowed, verified HIR. Keep its
    // result private so Draft mutations can be checked without reallocating.
    allocation_witness: Allocation,
}
impl Deref for Draft<'_> {
    type Target = MirData;
    fn deref(&self) -> &MirData { &self.data }
}
impl DerefMut for Draft<'_> {
    fn deref_mut(&mut self) -> &mut MirData { &mut self.data }
}
impl<'a> Draft<'a> {
    pub(super) fn new(hir: &'a Region, data: MirData) -> Self {
        let allocation_witness = data.allocation.clone();
        Self {
            hir,
            hir_witness: hir,
            data,
            allocation_witness,
        }
    }
    pub fn finish(self) -> Result<MirRegion, CompileError> {
        if !std::ptr::eq(self.hir, self.hir_witness) {
            return Err(CompileError::InvalidIr(
                "lowering source changed after allocation".into(),
            ));
        }
        let data = &self.data;
        if data.allocation != self.allocation_witness {
            return Err(CompileError::InvalidIr(
                "invalid machine types or local allocation".into(),
            ));
        }
        if !crate::ir::debug::audit() {
            // Release: lowering built every plan from this same verified HIR
            // in one transaction; recomputing and comparing them is an audit.
            return Ok(MirRegion { data: self.data });
        }
        super::verify::verify(self.hir).map_err(|e| CompileError::InvalidIr(e.0))?;
        let value_blocks = self
            .hir
            .values
            .iter()
            .map(|value| match value.definition {
                super::hir::Definition::Parameter(block, _) => Some(block),
                super::hir::Definition::Instruction(id, _) => {
                    Some(self.hir.instructions[id.index()].block)
                },
            })
            .collect::<Vec<_>>();
        let value_definitions = self
            .hir
            .values
            .iter()
            .map(|value| match value.definition {
                super::hir::Definition::Parameter(_, _) => None,
                super::hir::Definition::Instruction(id, _) => Some(id),
            })
            .collect::<Vec<_>>();
        if data.value_types != self.hir.values.iter().map(|v| v.ty).collect::<Vec<_>>()
            || data.value_blocks != value_blocks
            || data.value_definitions != value_definitions
            || data.allocation != self.allocation_witness
        {
            return Err(CompileError::InvalidIr(
                "invalid machine types or local allocation".into(),
            ));
        }
        if data.allocation_graph != allocation::capture(self.hir)
            || data.stack_elided != vec![false; self.hir.instructions.len()]
        {
            return Err(CompileError::InvalidIr(
                "invalid initial machine use/definition facts".into(),
            ));
        }
        super::helper::imports::verify(data)?;
        memory::verify(self.hir, &data.memory)?;
        effect::verify(self.hir, &data.effects)?;
        call::verify(self.hir, &data.helpers, &data.calls)?;
        control::verify(self.hir, &data.allocation, &data.control)?;
        value::verify(self.hir, &data.values)?;
        materialize::verify(self.hir, &data.states)?;
        forwarding::verify(data)?;
        state_elision::verify(self.hir, data)?;
        helper_state::verify(self.hir, data)?;
        cpu_liveness::verify(self.hir, data)?;
        if data.poll_batches.iter().any(Option::is_some) {
            return Err(CompileError::InvalidIr(
                "initial budget batches must be disabled".into(),
            ));
        }
        budget::verify(data)?;
        Ok(MirRegion { data: self.data })
    }
}

/// Built-in emitter/plan adapters cannot be redeclared as generic helpers.
pub use super::helper::imports::NAMES as CPU_IMPORTS;
