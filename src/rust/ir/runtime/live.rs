//! A bounded, explicitly requested compiler inside the experimental CPU Wasm.
//! This owns one unpublished artifact; it does not reserve/install a JIT slot.
use super::{
    compile::*,
    entry::{ir_entry_matches, CpuEntryKey, EntryContract},
    snapshot::{capture, CaptureError},
};
use crate::{
    cpu::{cpu, global_pointers as gp},
    ir::{
        backend::wasm::StateLayout,
        frontend::decode::{GuestEip, LinearAddress},
        lowering::CompileError,
    },
};
use std::sync::Mutex;
pub(super) struct Job {
    pub artifact: CompiledArtifact,
    pub source: ImmutableCodeSnapshot,
    pub observed: Vec<CodeDependency>,
    pub stale: bool,
}
struct LiveState {
    serial: u64,
    generation: u64,
    continuation_epoch: u64,
    exhausted: bool,
    job: Option<Job>,
    error: u32,
}
static LIVE: Mutex<LiveState> = Mutex::new(LiveState {
    serial: 0,
    generation: 0,
    continuation_epoch: 0,
    exhausted: false,
    job: None,
    error: 0,
});
/// Reset/cache-clear invalidation is independent of the CPU snapshot format.
pub fn invalidate() {
    let mut state = LIVE.try_lock().unwrap();
    state.continuation_epoch = state.continuation_epoch.saturating_add(1);
    state.job = None;
    state.error = 0;
    match state.generation.checked_add(1) {
        Some(n) => state.generation = n,
        None => state.exhausted = true,
    }
}
pub fn dirty_page(page: u32) {
    let mut state = LIVE.try_lock().unwrap();
    state.continuation_epoch = state.continuation_epoch.saturating_add(1);
    if let Some(job) = &mut state.job {
        for dependency in &mut job.observed {
            if dependency.page.0 == page {
                match dependency.version.checked_add(1) {
                    Some(n) => dependency.version = n,
                    None => job.stale = true,
                }
            }
        }
    }
}
/// Returning observers may continue only if no code write/reset occurred during
/// the call. Exhaustion permanently forces a cold exit, without wrapping.
pub(super) fn continuation_epoch() -> u64 { LIVE.try_lock().unwrap().continuation_epoch }
#[inline(always)]
pub unsafe fn entry() -> CpuEntryKey {
    let linear = *gp::instruction_pointer as u32;
    CpuEntryKey {
        pc: GuestEip(linear.wrapping_sub(cpu::get_seg_cs() as u32)),
        linear: LinearAddress(linear),
        default_32: *gp::is_32,
    }
}
/// Shares the non-wrapping instance identity allocator with explicit compilation.
pub(super) fn publication_key() -> Option<PublicationKey> {
    let mut state = LIVE.try_lock().unwrap();
    if state.exhausted || state.serial == u64::MAX {
        return None;
    }
    state.serial += 1;
    Some(PublicationKey {
        job: state.serial,
        vm_generation: state.generation,
        slot: 0,
        slot_generation: 0,
    })
}
#[inline(always)]
pub(super) fn generation_current(key: PublicationKey) -> bool {
    let state = LIVE.try_lock().unwrap();
    !state.exhausted && state.generation == key.vm_generation
}
/// Error: 1 arguments, 2 active/invalid CPU context, 3 unreadable mapping, 4 non-RAM,
/// 5 unsupported paging, 6 unsupported lowering, 7 compiler budget, 8 invalid IR,
/// 9 exhausted identity space. Failure returns zero and discards the old result.
#[no_mangle]
pub unsafe fn ir_compile_live(
    length: u32,
    tier: u32,
    optimize: u32,
    cfg: u32,
    budget: u32,
    rep_budget: u32,
) -> u64 {
    if super::cache::busy() {
        let mut state = LIVE.try_lock().unwrap();
        state.job = None;
        state.error = 2;
        return 0;
    }
    let mut state = LIVE.try_lock().unwrap();
    state.job = None;
    state.error = 0;
    if length == 0
        || length > 1920
        || !matches!(tier, 1 | 2)
        || optimize > 1
        || cfg > 1
        || budget == 0
        || budget > i32::MAX as u32
        || rep_budget > 4096
    {
        state.error = 1;
        return 0;
    }
    let context = entry();
    if !ir_entry_matches(
        context.linear.0,
        context.cs_base(),
        context.default_32 as u32,
    ) {
        state.error = 2;
        return 0;
    }
    if state.exhausted || state.serial == u64::MAX {
        state.error = 9;
        return 0;
    }
    let source = match capture(context.linear.0, length as usize) {
        Ok(source) => source,
        Err(error) => {
            state.error = match error {
                CaptureError::Size => 1,
                CaptureError::Unreadable => 3,
                CaptureError::NonRam => 4,
                CaptureError::UnsupportedPaging => 5,
            };
            return 0;
        },
    };
    state.serial += 1;
    let request = CompileRequest {
        key: PublicationKey {
            job: state.serial,
            vm_generation: state.generation,
            slot: 0,
            slot_generation: 0,
        },
        pc: context.pc,
        linear: context.linear,
        default_32: context.default_32,
        tier: if tier == 1 { Tier::One } else { Tier::Two },
    };
    let config = IrConfig {
        optimize: optimize != 0,
        passes: if tier == 1 { crate::ir::passes::PassConfig::tier1() } else { Default::default() },
        execution_budget: budget,
        rep_iteration_budget: rep_budget,
        max_code_bytes: 1920,
        layout: StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
    };
    let result = if cfg != 0 {
        compile_cpu_cfg_region(&request, &source, &config)
    }
    else {
        compile_cpu_region(&request, &source, &config)
    };
    match result {
        Ok(artifact) => {
            state.job = Some(Job {
                observed: source.dependencies.clone(),
                artifact,
                source,
                stale: false,
            });
            state.serial
        },
        Err(error) => {
            state.error = match error {
                CompileError::Unsupported(_) => 6,
                CompileError::Budget(_) => 7,
                CompileError::InvalidIr(_) => 8,
            };
            0
        },
    }
}
#[no_mangle]
pub fn ir_live_error() -> u32 { LIVE.try_lock().unwrap().error }
/// The caller copies bytes synchronously before replacing, releasing or resetting the job.
/// Returning bytes is not evidence that they are still valid for execution.
#[no_mangle]
pub fn ir_live_info(id: u64, field: u32) -> u32 {
    let state = LIVE.try_lock().unwrap();
    let Some(job) = state.job.as_ref().filter(|j| j.artifact.key.job == id)
    else {
        return 0;
    };
    let EntryContract::Cpu(entry) = job.artifact.entry
    else {
        unreachable!()
    };
    match field {
        0 => job.artifact.code.bytes.as_ptr() as u32,
        1 => job.artifact.code.bytes.len() as u32,
        2 => job.source.mappings.len() as u32,
        3 => job.source.dependencies.len() as u32,
        4 => entry.linear.0,
        5 => entry.pc.0,
        6 => entry.default_32 as u32,
        7 => job.artifact.guest_bytes as u32,
        8 => job.artifact.code.locals as u32,
        _ => 0,
    }
}
#[no_mangle]
pub fn ir_live_mapping(id: u64, index: u32, physical: u32) -> u32 {
    let state = LIVE.try_lock().unwrap();
    let Some(job) = state.job.as_ref().filter(|j| j.artifact.key.job == id)
    else {
        return 0;
    };
    match job.source.mappings.get(index as usize) {
        Some(mapping) => {
            if physical == 1 {
                mapping.physical.0
            }
            else if physical == 0 {
                mapping.linear.0
            }
            else {
                0
            }
        },
        None => 0,
    }
}
/// Uses job-local write versions AND exact code/mapping re-observation. The latter
/// covers writes that did not pass through the code-page notifications (jit_dirty_page).
#[no_mangle]
pub unsafe fn ir_live_validate(id: u64) -> bool {
    let state = LIVE.try_lock().unwrap();
    let Some(job) = state
        .job
        .as_ref()
        .filter(|j| j.artifact.key.job == id && !j.stale)
    else {
        return false;
    };
    let context = entry();
    if state.exhausted
        || state.generation != job.artifact.key.vm_generation
        || !ir_entry_matches(
            context.linear.0,
            context.cs_base(),
            context.default_32 as u32,
        )
    {
        return false;
    }
    let Ok(current) = capture(context.linear.0, job.source.bytes.len())
    else {
        return false;
    };
    job.artifact.current(
        job.artifact.key,
        &job.observed,
        EntryContract::Cpu(context),
        &current.mappings,
    ) && current.bytes == job.source.bytes
}
#[no_mangle]
pub fn ir_live_release(id: u64) -> bool {
    let mut state = LIVE.try_lock().unwrap();
    if !state.job.as_ref().is_some_and(|j| j.artifact.key.job == id) {
        return false;
    }
    state.job = None;
    true
}

pub(super) unsafe fn take_for_cache(id: u64) -> Option<Job> {
    if !ir_live_validate(id) {
        return None;
    }
    LIVE.try_lock().unwrap().job.take()
}
