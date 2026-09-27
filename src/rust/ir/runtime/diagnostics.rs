//! Opt-in IR diagnostics. Random whole-batch sampling preserves cold chaining.
//! All stage times are exclusive; publication latency is a separate wall measure.
#![allow(static_mut_refs)]
#[cfg(target_arch = "wasm32")]
use crate::cpu::cpu;
use crate::cpu::global_pointers as gp;
#[derive(Clone, Copy)]
#[repr(u32)]
pub enum Stage {
    Dispatch,
    Scheduler,
    Admission,
    Fetch,
    Generated,
    StateWrite,
    StateReload,
    MemorySlow,
    Helper,
    Interpreter,
    Compile,
    ByteValidation,
    SourceCapture,
}
pub const STAGES: usize = 13;
#[derive(Clone, Copy)]
#[repr(u32)]
pub enum Exit {
    Unclassified,
    Normal,
    Budget,
    Epoch,
    Fault,
    ScalarStore,
    CodeStore,
    RmwCommit,
    VectorMemory,
    HelperTransfer,
    HelperYield,
    HelperInvalidated,
    EntryGuard,
    InterruptShadow,
}
pub const EXITS: usize = 14;
#[derive(Clone, Copy)]
#[repr(u32)]
pub enum Admission {
    Attempt,
    Busy,
    Missing,
    Context,
    StaleBefore,
    Capture,
    FetchFault,
    LostOwner,
    UnavailableAfter,
    StaleAfter,
    Accepted,
}
pub const ADMISSIONS: usize = 11;
#[repr(C)]
struct Cells {
    active: u32,
    reason: u32,
    helper: u32,
}
static mut CELLS: Cells = Cells {
    active: 0,
    reason: 0,
    helper: 0,
};
static mut PERIOD: u32 = 0;
static mut SESSION: u32 = 0;
static mut RANDOM: u32 = 0xA341316C;
static mut IN_BATCH: bool = false;
static mut CALIBRATION: [f64; 2] = [0.0; 2];
static mut CLOCK: f64 = 0.0;
static mut CURRENT: usize = 0;
static mut STACK: [usize; 32] = [0; 32];
static mut DEPTH: usize = 0;
static mut TIMES: [f64; STAGES] = [0.0; STAGES];
static mut CALLS: [u64; STAGES] = [0; STAGES];
static mut REASONS: [[u64; 2]; EXITS] = [[0; 2]; EXITS];
static mut CHAIN: [u64; 6] = [0; 6];
static mut ADMISSION: [u64; ADMISSIONS] = [0; ADMISSIONS];
// batches, sampled batches, total batch ms, sampled batch ms, interpreter steps,
// IR activations, IR steps, instrumentation errors, sample activations.
static mut TOTALS: [f64; 9] = [0.0; 9];
// Overall synchronous compile and phase wall times: capture, lift, passes, lower,
// machine optimization, emit. Not additive with sampled CPU attribution.
const COMPILE_PHASES: usize = 20;
// ms, calls, maximum ms, PC and tier associated with that maximum.
static mut COMPILER: [[f64; 5]; COMPILE_PHASES] = [[0.0; 5]; COMPILE_PHASES];
// tier (unknown/1/2) x kind (unknown/ordinary/shared/fused) x shape
// (unknown/single/multi). Unknown is explicit for capture and pre-lift failures.
static mut COMPILER_BUCKETS: [[[f64; 5]; COMPILE_PHASES]; 36] = [[[0.0; 5]; COMPILE_PHASES]; 36];
static mut COMPILE_CONTEXT: (u32, u32, u32, u32) = (0, 0, 0, 0);
#[cfg(test)]
static mut COMPILER_BENCHMARK: bool = false;
fn compiler_enabled() -> bool {
    #[cfg(test)]
    if unsafe { COMPILER_BENCHMARK } {
        return true;
    }
    enabled()
}
/// Only the explicitly invoked, single-threaded offline compiler benchmark.
#[cfg(test)]
pub fn compiler_benchmark_reset() {
    unsafe {
        COMPILER_BENCHMARK = true;
        COMPILER = [[0.0; 5]; COMPILE_PHASES];
        COMPILER_BUCKETS = [[[0.0; 5]; COMPILE_PHASES]; 36];
    }
}
static mut PUBLICATION: [f64; 3] = [0.0; 3];
// Discovery-to-publication latency for retained entries: total ms, count, max.
static mut DISCOVERY: [[f64; 3]; 2] = [[0.0; 3]; 2];
static mut MISSING: [u64; 5] = [0; 5];
// Direct-mapped sampled hotspots: PC, CR3, exit, samples, steps, inclusive IR ms,
// tier, fused. Collisions replace a row; aggregate reason totals never lose events.
static mut HOT: [[f64; 8]; 512] = [[0.0; 8]; 512];
static mut HOT_REPLACEMENTS: u64 = 0;
// Sampled interpreter entry PC/CR3/physical PC, batches, retired work and time.
static mut INTERPRETER_HOT: [[f64; 6]; 256] = [[0.0; 6]; 256];
static mut HELPER_EXITS: [[u64; 2]; 12] = [[0; 2]; 12];
static mut CONTROL_EXITS: [[u64; 2]; 6] = [[0; 2]; 6];
pub fn helper_category(name: &str) -> u32 {
    match name {
        "ir_load_segment" | "ir_pop_segment" | "ir_mov_segment_continue" => 1,
        "ir_in" | "ir_in_continue" | "ir_ins" | "ir_ins_once" => 2,
        "ir_out" | "ir_out_continue" | "ir_outs" | "ir_outs_once" => 3,
        n if n.starts_with("ir_rep_") => 4,
        n if n.starts_with("ir_far_") || n == "ir_iret" || n == "ir_software_interrupt" => 5,
        "ir_pop_flags" | "ir_cli" | "ir_cli_check" | "ir_sti_finish_continue" => 6,
        "ir_lgdt" | "ir_lidt" | "ir_ltr_reg" | "ir_lldt_reg" | "ir_invlpg" => 7,
        "ir_rdtsc" | "ir_rdtsc_continue" => 12,
        "ir_cpuid" | "ir_cpuid_continue" => 13,
        "ir_read_cr" | "ir_read_cr_continue" => 14,
        "ir_write_cr" => 15,
        "ir_clts" => 16,
        "ir_sti_check" => 17,
        n if n.starts_with("ir_x87") || n.starts_with("ir_sse") || n.starts_with("ir_mmx") => 9,
        "ir_hlt" => 10,
        "ir_invalid_form" | "ir_reserved_form" => 11,
        _ => 0,
    }
}
pub fn interpreter(pc: u32, cr3: u32, physical: u32, steps: u32, duration: Option<f64>) {
    let Some(ms) = duration
    else {
        return;
    };
    unsafe {
        let row = &mut INTERPRETER_HOT[((pc >> 1) ^ cr3.rotate_right(12)) as usize & 255];
        if row[0] != pc as f64 || row[1] != cr3 as f64 || row[2] != physical as f64 {
            *row = [pc as f64, cr3 as f64, physical as f64, 0.0, 0.0, 0.0];
        }
        row[3] += 1.0;
        row[4] += steps as f64;
        row[5] += ms;
    }
}
#[inline]
pub fn enabled() -> bool { unsafe { PERIOD != 0 } }
#[inline]
fn now() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        unsafe { cpu::js::microtick() }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_secs_f64()
            * 1000.0
    }
}
pub fn discovery_start() -> Option<f64> { enabled().then(now) }
pub fn discovery_complete(start: Option<f64>, tier: u32) {
    if let Some(start) = start.filter(|_| enabled()) {
        let ms = (now() - start).max(0.0);
        unsafe {
            let row = &mut DISCOVERY[(tier - 1).min(1) as usize];
            row[0] += ms;
            row[1] += 1.0;
            row[2] = row[2].max(ms);
        }
    }
}
pub fn missing(reason: usize) {
    unsafe {
        if enabled() {
            MISSING[reason] += 1;
        }
    }
}
#[no_mangle]
pub fn ir_diagnostic_address() -> u32 { core::ptr::addr_of!(CELLS) as u32 }
/// A new session clears compiled artifacts so off mode emits no diagnostic code.
#[no_mangle]
pub unsafe fn ir_diagnostic_config(period: u32) -> bool {
    if period > 65536
        || (period != 0 && !period.is_power_of_two())
        || IN_BATCH
        || super::cache::busy()
        || !crate::jit::ir_cache_quiescent()
        || SESSION == u32::MAX
    {
        return false;
    }
    crate::jit::jit_clear_cache_js();
    super::cache::ir_cache_collect();
    PERIOD = period;
    SESSION += 1;
    RANDOM = 0xA341316C;
    CALIBRATION = [0.0; 2];
    if period != 0 {
        CELLS.active = 1;
        DEPTH = 0;
        CURRENT = 0;
        CLOCK = now();
        TIMES = [0.0; STAGES];
        let start = now();
        for _ in 0..4096 {
            ir_diagnostic_begin(Stage::Generated as u32);
            ir_diagnostic_end();
        }
        CALIBRATION = [
            TIMES[Stage::Generated as usize] / 4096.0,
            (now() - start) / 4096.0,
        ];
    }
    CELLS = Cells {
        active: 0,
        reason: 0,
        helper: 0,
    };
    DEPTH = 0;
    TIMES = [0.0; STAGES];
    CALLS = [0; STAGES];
    REASONS = [[0; 2]; EXITS];
    ADMISSION = [0; ADMISSIONS];
    CHAIN = [0; 6];
    TOTALS = [0.0; 9];
    COMPILER = [[0.0; 5]; COMPILE_PHASES];
    COMPILER_BUCKETS = [[[0.0; 5]; COMPILE_PHASES]; 36];
    INTERPRETER_HOT = [[0.0; 6]; 256];
    HELPER_EXITS = [[0; 2]; 12];
    CONTROL_EXITS = [[0; 2]; 6];
    PUBLICATION = [0.0; 3];
    HOT = [[0.0; 8]; 512];
    HOT_REPLACEMENTS = 0;
    DISCOVERY = [[0.0; 3]; 2];
    MISSING = [0; 5];
    true
}
#[no_mangle]
pub unsafe fn ir_diagnostic_get(group: u32, index: u32, field: u32) -> f64 {
    let i = index as usize;
    let f = field as usize;
    match group {
        0 => match index {
            0 => PERIOD as f64,
            1 => SESSION as f64,
            2 => HOT_REPLACEMENTS as f64,
            3 => DEPTH as f64,
            4 => CALIBRATION[0],
            5 => CALIBRATION[1],
            6 => 1.0,
            _ => 0.0,
        },
        1 => {
            if f == 0 {
                TIMES.get(i).copied().unwrap_or(0.0)
            }
            else {
                CALLS.get(i).copied().unwrap_or(0) as f64
            }
        },
        2 => REASONS.get(i).and_then(|r| r.get(f)).copied().unwrap_or(0) as f64,
        3 => ADMISSION.get(i).copied().unwrap_or(0) as f64,
        4 => TOTALS.get(i).copied().unwrap_or(0.0),
        5 => COMPILER
            .get(i)
            .and_then(|r| r.get(f))
            .copied()
            .unwrap_or(0.0),
        6 => PUBLICATION.get(i).copied().unwrap_or(0.0),
        8 => CHAIN.get(i).copied().unwrap_or(0) as f64,
        9 => INTERPRETER_HOT
            .get(i)
            .and_then(|r| r.get(f))
            .copied()
            .unwrap_or(0.0),
        10 => HELPER_EXITS
            .get(i)
            .and_then(|r| r.get(f))
            .copied()
            .unwrap_or(0) as f64,
        11 => DISCOVERY
            .get(i)
            .and_then(|r| r.get(f))
            .copied()
            .unwrap_or(0.0),
        12 => MISSING.get(i).copied().unwrap_or(0) as f64,
        13 => CONTROL_EXITS
            .get(i)
            .and_then(|r| r.get(f))
            .copied()
            .unwrap_or(0) as f64,
        14 => COMPILER_BUCKETS
            .get(i / COMPILE_PHASES)
            .and_then(|b| b[i % COMPILE_PHASES].get(f))
            .copied()
            .unwrap_or(0.0),
        7 => HOT.get(i).and_then(|r| r.get(f)).copied().unwrap_or(0.0),
        _ => 0.0,
    }
}
#[no_mangle]
pub unsafe fn ir_diagnostic_publication(session: u32, ms: f64, success: u32) {
    if enabled() && session == SESSION && ms.is_finite() && ms >= 0.0 {
        PUBLICATION[0] += ms;
        PUBLICATION[1] += 1.0;
        PUBLICATION[2] += f64::from(success != 0);
    }
}
#[inline]
pub fn admission(reason: Admission) {
    unsafe {
        if enabled() {
            ADMISSION[reason as usize] += 1;
        }
    }
}
#[inline]
pub fn interpreter_steps(count: u32) {
    unsafe {
        if enabled() {
            TOTALS[4] += count as f64;
        }
    }
}
pub fn chain(reason: usize) {
    unsafe {
        if enabled() {
            CHAIN[reason] += 1;
        }
    }
}
pub fn batch_start() -> Option<f64> {
    unsafe {
        if IN_BATCH {
            TOTALS[7] += 1.0;
            return None;
        }
    }
    if !enabled() {
        return None;
    }
    unsafe {
        let t = now();
        IN_BATCH = true;
        TOTALS[0] += 1.0;
        let mut r = RANDOM;
        r ^= r << 13;
        r ^= r >> 17;
        r ^= r << 5;
        RANDOM = r;
        CELLS.active = u32::from(r & (PERIOD - 1) == 0);
        if CELLS.active != 0 {
            TOTALS[1] += 1.0;
            CURRENT = Stage::Dispatch as usize;
            CLOCK = t;
            DEPTH = 0;
        }
        Some(t)
    }
}
pub fn batch_end(start: Option<f64>) {
    if let Some(start) = start {
        unsafe {
            let t = now();
            TOTALS[2] += (t - start).max(0.0);
            if CELLS.active != 0 {
                TIMES[CURRENT] += (t - CLOCK).max(0.0);
                TOTALS[3] += (t - start).max(0.0);
                if DEPTH != 0 {
                    TOTALS[7] += 1.0;
                    DEPTH = 0;
                }
            }
            CELLS.active = 0;
            IN_BATCH = false;
        }
    }
}
fn enter(stage: usize) -> Option<f64> {
    unsafe {
        if CELLS.active == 0 {
            return None;
        }
        if stage >= STAGES || DEPTH == STACK.len() {
            TOTALS[7] += 1.0;
            return None;
        }
        let t = now();
        TIMES[CURRENT] += (t - CLOCK).max(0.0);
        STACK[DEPTH] = CURRENT;
        DEPTH += 1;
        CURRENT = stage;
        CLOCK = t;
        CALLS[stage] += 1;
        Some(t)
    }
}
fn leave() -> f64 {
    unsafe {
        let t = now();
        TIMES[CURRENT] += (t - CLOCK).max(0.0);
        CLOCK = t;
        if DEPTH == 0 {
            TOTALS[7] += 1.0;
        }
        else {
            DEPTH -= 1;
            CURRENT = STACK[DEPTH];
        }
        t
    }
}
#[no_mangle]
pub fn ir_diagnostic_begin(stage: u32) { enter(stage as usize); }
#[no_mangle]
pub fn ir_diagnostic_end() {
    unsafe {
        if CELLS.active != 0 {
            leave();
        }
    }
}
pub struct Scope(Option<f64>);
impl Scope {
    #[inline]
    pub fn new(stage: Stage) -> Self { Self(enter(stage as usize)) }
    pub fn finish(mut self) -> Option<f64> { self.0.take().map(|start| (leave() - start).max(0.0)) }
}
impl Drop for Scope {
    fn drop(&mut self) {
        if self.0.is_some() {
            leave();
        }
    }
}
pub struct CompileScope {
    field: usize,
    start: Option<f64>,
    context: (u32, u32, u32, u32),
}
impl CompileScope {
    pub fn new(field: usize) -> Self {
        let start = compiler_enabled().then(now);
        Self {
            field,
            start,
            context: if start.is_some() { unsafe { COMPILE_CONTEXT } } else { (0, 0, 0, 0) },
        }
    }
}
impl Drop for CompileScope {
    fn drop(&mut self) {
        if let Some(t) = self.start {
            unsafe {
                let elapsed = (now() - t).max(0.0);
                let (pc, tier, kind, shape) = self.context;
                let bucket = ((tier.min(2) * 4 + kind.min(3)) * 3 + shape.min(2)) as usize;
                for row in [
                    &mut COMPILER[self.field],
                    &mut COMPILER_BUCKETS[bucket][self.field],
                ] {
                    row[0] += elapsed;
                    row[1] += 1.0;
                    if elapsed > row[2] {
                        row[2] = elapsed;
                        row[3] = pc as f64;
                        row[4] = tier as f64;
                    }
                }
            }
        }
    }
}
pub fn activation_start() {
    unsafe {
        if enabled() {
            CELLS.reason = Exit::Unclassified as u32;
            CELLS.helper = 0;
        }
    }
}
pub unsafe fn activation_end(
    pc: u32,
    cr3: u32,
    count: u32,
    duration: Option<f64>,
    tier: u32,
    fused: bool,
) {
    if !enabled() {
        return;
    }
    let reason = (CELLS.reason as usize).min(EXITS - 1);
    if (Exit::HelperTransfer as usize..=Exit::HelperInvalidated as usize).contains(&reason) {
        let category = CELLS.helper as usize;
        if (12..18).contains(&category) {
            let row = &mut CONTROL_EXITS[category - 12];
            row[0] += 1;
            row[1] += count as u64;
        }
        let parent = if category == 17 {
            6
        }
        else if category >= 12 {
            8
        }
        else {
            category
        };
        let row = &mut HELPER_EXITS[parent.min(11)];
        row[0] += 1;
        row[1] += count as u64;
    }
    REASONS[reason][0] += 1;
    REASONS[reason][1] += count as u64;
    TOTALS[5] += 1.0;
    TOTALS[6] += count as f64;
    if let Some(ms) = duration {
        TOTALS[8] += 1.0;
        let slot = ((pc >> 1) ^ (pc >> 12) ^ (cr3 >> 12) ^ (reason as u32 * 31)) as usize & 511;
        let row = &mut HOT[slot];
        if row[3] != 0.0
            && (row[0] != pc as f64
                || row[1] != cr3 as f64
                || row[2] != reason as f64
                || row[6] != tier as f64
                || row[7] != f64::from(fused))
        {
            HOT_REPLACEMENTS += 1;
            *row = [0.0; 8];
        }
        row[0] = pc as f64;
        row[1] = cr3 as f64;
        row[2] = reason as f64;
        row[3] += 1.0;
        row[4] += count as f64;
        row[5] += ms;
        row[6] = tier as f64;
        row[7] = f64::from(fused);
    }
}
/// Snapshot entry context before executing a helper which may switch address space.
pub fn cr3() -> u32 { unsafe { *gp::cr.add(3) as u32 } }

/// Compiler diagnostics never change the optimizer policy or work budgets.
pub struct CompileContext(Option<(u32, u32, u32, u32)>);
impl CompileContext {
    pub fn new(pc: u32, tier: u32) -> Self { Self::classified(pc, tier, 0, 0) }
    pub fn classified(pc: u32, tier: u32, kind: u32, shape: u32) -> Self {
        unsafe {
            Self(
                compiler_enabled()
                    .then(|| std::mem::replace(&mut COMPILE_CONTEXT, (pc, tier, kind, shape))),
            )
        }
    }
}
impl Drop for CompileContext {
    fn drop(&mut self) {
        if let Some(previous) = self.0 {
            unsafe {
                COMPILE_CONTEXT = previous;
            }
        }
    }
}
