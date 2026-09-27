// Keep in sync with print_stats.js.
#[allow(non_camel_case_types)]
pub enum stat {
    RUN_INTERPRETED,
    RUN_INTERPRETED_STEPS,

    DIRTY_PAGE_DID_NOT_HAVE_CODE,

    PAGE_FAULT,
    TLB_MISS,

    MAIN_LOOP,
    MAIN_LOOP_IDLE,
    DO_MANY_CYCLES,
    CYCLE_INTERNAL,

    CLEAR_TLB,
    FULL_CLEAR_TLB,
    TLB_FULL,
    TLB_GLOBAL_FULL,
}

#[allow(non_upper_case_globals)]
pub static mut stat_array: [u64; 500] = [0; 500];

pub fn stat_increment(stat: stat) { stat_increment_by(stat, 1); }

pub fn stat_increment_by(stat: stat, by: u64) {
    if cfg!(feature = "profiler") {
        unsafe { stat_array[stat as usize] += by }
    }
}

#[no_mangle]
pub fn profiler_init() {
    unsafe {
        #[allow(static_mut_refs)]
        for x in stat_array.iter_mut() {
            *x = 0
        }
    }
}

#[no_mangle]
pub fn profiler_stat_get(stat: stat) -> f64 {
    if cfg!(feature = "profiler") {
        unsafe { stat_array[stat as usize] as f64 }
    }
    else {
        0.0
    }
}

#[no_mangle]
pub fn profiler_is_enabled() -> bool { cfg!(feature = "profiler") }

// Low-overhead, opt-in diagnostics: update at execution-chunk boundaries,
// never emit per-instruction instrumentation into generated Wasm.
static mut PERFORMANCE_RECORDING: bool = false;
// 0: interpreted steps, 1: compiled steps; 2..4 are unused (legacy table
// capacity events), kept so the export indices stay stable.
static mut PERFORMANCE_COUNTERS: [u64; 5] = [0; 5];
static mut PERFORMANCE_CODEGEN: [f64; 3] = [0.0; 3];
// Indices 8..23. Legacy per-chunk times at 18/19 are unavailable in v4.
static mut PERFORMANCE_EXECUTION: [f64; 16] = [0.0; 16];
static mut PERFORMANCE_RANDOM: u32 = 0xA341316C;
static mut PERFORMANCE_STARTED: f64 = 0.0;
static mut PERFORMANCE_NEXT_SAMPLE: f64 = 0.0;
static mut PERFORMANCE_SAMPLE_TIME: f64 = 0.0;
static mut PERFORMANCE_COUNTDOWN: u32 = 0;
static mut PERFORMANCE_PREVIOUS_CHUNKS: u32 = 1;
static mut PERFORMANCE_BATCH_CHUNKS: [u32; 2] = [0; 2];
static mut PERFORMANCE_PENDING_ROW: [f64; 10] = [0.0; 10];
static mut PERFORMANCE_ROWS: Vec<[f64; 10]> = Vec::new();

#[no_mangle]
pub fn performance_recording_version() -> u32 { 4 }

#[no_mangle]
pub unsafe fn performance_recording_enable(enabled: bool) {
    PERFORMANCE_RECORDING = enabled;
    PERFORMANCE_COUNTDOWN = 0;
    if enabled {
        PERFORMANCE_COUNTERS = [0; 5];
        PERFORMANCE_CODEGEN = [0.0; 3];
        PERFORMANCE_EXECUTION = [0.0; 16];
        PERFORMANCE_RANDOM = 0xA341316C;
        PERFORMANCE_STARTED = crate::cpu::cpu::js::microtick();
        PERFORMANCE_NEXT_SAMPLE = PERFORMANCE_STARTED;
        PERFORMANCE_PREVIOUS_CHUNKS = 1;
        PERFORMANCE_BATCH_CHUNKS = [0; 2];
        PERFORMANCE_ROWS = Vec::new();
    }
}

#[no_mangle]
pub unsafe fn performance_recording_get(index: u32) -> f64 {
    if index < 5 {
        PERFORMANCE_COUNTERS[index as usize] as f64
    }
    else if index < 8 {
        PERFORMANCE_CODEGEN[index as usize - 5]
    }
    else if index < 24 {
        PERFORMANCE_EXECUTION[index as usize - 8]
    }
    else {
        0.0
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe fn performance_recording_hotspot_count() -> u32 { PERFORMANCE_ROWS.len() as u32 }

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe fn performance_recording_hotspot_get(row: u32, field: u32) -> f64 {
    PERFORMANCE_ROWS
        .get(row as usize)
        .and_then(|row| row.get(field as usize))
        .copied()
        .unwrap_or(0.0)
}

#[inline]
pub fn performance_recording_enabled() -> bool { unsafe { PERFORMANCE_RECORDING } }

#[inline]
pub fn performance_execution_add(index: usize, value: f64) {
    unsafe {
        if PERFORMANCE_RECORDING {
            PERFORMANCE_EXECUTION[index] += value;
        }
    }
}

pub fn performance_timer_finish(start: Option<f64>, index: usize) {
    if let Some(start) = start {
        let elapsed = unsafe { crate::cpu::cpu::js::microtick() } - start;
        performance_execution_add(index, elapsed.max(0.0));
        performance_execution_add(index + 2, 1.0);
        if index == 0 {
            unsafe {
                PERFORMANCE_PREVIOUS_CHUNKS =
                    (PERFORMANCE_BATCH_CHUNKS[0] + PERFORMANCE_BATCH_CHUNKS[1]).max(1);
                PERFORMANCE_EXECUTION[8] += PERFORMANCE_BATCH_CHUNKS[0] as f64;
                PERFORMANCE_EXECUTION[9] += PERFORMANCE_BATCH_CHUNKS[1] as f64;
                if PERFORMANCE_COUNTDOWN != 0 {
                    PERFORMANCE_EXECUTION[15] += 1.0;
                }
                PERFORMANCE_COUNTDOWN = 0;
            }
        }
    }
}

pub fn performance_main_loop_exit(delay: f64, halted: bool) -> f64 {
    performance_execution_add(if delay > 0.0 { 6 } else { 5 }, 1.0);
    if halted {
        performance_execution_add(7, 1.0);
    }
    delay
}

fn performance_random() -> u32 {
    unsafe {
        let mut random = PERFORMANCE_RANDOM;
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        PERFORMANCE_RANDOM = random;
        random
    }
}

// Arm at most one position per 10 ms, using the existing batch clock. Choose a
// position from the previous batch length, avoiding a fixed first-chunk bias.
// Shorter batches may miss it; this is NOT uniform per-chunk/time sampling.
pub fn performance_batch_start() -> Option<f64> {
    let start = performance_timer_start();
    if let Some(now) = start {
        unsafe {
            PERFORMANCE_BATCH_CHUNKS = [0; 2];
            if now >= PERFORMANCE_NEXT_SAMPLE {
                PERFORMANCE_NEXT_SAMPLE = now + 10.0;
                PERFORMANCE_SAMPLE_TIME = now - PERFORMANCE_STARTED;
                PERFORMANCE_COUNTDOWN = 1 + performance_random() % PERFORMANCE_PREVIOUS_CHUNKS;
            }
        }
    }
    start
}

// No per-chunk PRNG, timestamps, map lookup or stack-allocated sample token.
#[inline]
pub fn performance_chunk_start(jit: bool, eip: u32, cr3: u32, cpl: u8) -> bool {
    unsafe {
        if !PERFORMANCE_RECORDING {
            return false;
        }
        PERFORMANCE_BATCH_CHUNKS[if jit { 0 } else { 1 }] += 1;
        if PERFORMANCE_COUNTDOWN == 0 {
            return false;
        }
        PERFORMANCE_COUNTDOWN -= 1;
        if PERFORMANCE_COUNTDOWN != 0 {
            return false;
        }
        PERFORMANCE_PENDING_ROW = [
            cr3 as f64,
            (eip & !0xFFF) as f64,
            cpl as f64,
            jit as u8 as f64,
            1.0,
            0.0,
            0.0,
            PERFORMANCE_SAMPLE_TIME,
            PERFORMANCE_SAMPLE_TIME,
            eip as f64,
        ];
        true
    }
}

#[inline]
pub fn performance_chunk_finish(selected: bool, steps: u32) {
    if selected {
        performance_store_sample(steps);
    }
}

// Reservoir sampling bounds memory without permanently excluding later pages.
// No duration is assigned to tiny chunks: browser clock resolution and timing
// overhead overwhelmed their actual execution time in the v3 game recording.
#[allow(static_mut_refs)]
fn performance_store_sample(steps: u32) {
    unsafe {
        PERFORMANCE_EXECUTION[if PERFORMANCE_PENDING_ROW[3] == 1.0 { 12 } else { 13 }] += 1.0;
        let mut row = PERFORMANCE_PENDING_ROW;
        row[6] = steps as f64;
        if PERFORMANCE_ROWS.len() < 8192 {
            PERFORMANCE_ROWS.push(row);
        }
        else {
            PERFORMANCE_EXECUTION[14] += 1.0;
            let total = (PERFORMANCE_EXECUTION[12] + PERFORMANCE_EXECUTION[13]) as u32;
            let index = (performance_random() % total) as usize;
            if index < 8192 {
                PERFORMANCE_ROWS[index] = row;
            }
        }
    }
}

#[inline]
pub fn performance_recording_add(index: usize, count: u64) {
    unsafe {
        if PERFORMANCE_RECORDING {
            PERFORMANCE_COUNTERS[index] = PERFORMANCE_COUNTERS[index].wrapping_add(count);
        }
    }
}

// Timing only runs during an explicit recording and surrounds synchronous
// analysis/code generation, not the later asynchronous WebAssembly compilation.
pub fn performance_codegen_start() -> Option<f64> { performance_timer_start() }

#[inline]
pub fn performance_timer_start() -> Option<f64> {
    if unsafe { PERFORMANCE_RECORDING } {
        Some(unsafe { crate::cpu::cpu::js::microtick() })
    }
    else {
        None
    }
}

pub fn performance_codegen_finish(start: Option<f64>) {
    if let Some(start) = start {
        let ms = unsafe { crate::cpu::cpu::js::microtick() } - start;
        unsafe {
            PERFORMANCE_CODEGEN[0] += ms;
            PERFORMANCE_CODEGEN[1] = PERFORMANCE_CODEGEN[1].max(ms);
            PERFORMANCE_CODEGEN[2] += 1.0;
        }
    }
}
