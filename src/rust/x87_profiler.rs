// Recording-only F80 arithmetic counts. No clocks, allocation, or guest state.
static mut ENABLED: bool = false;
// add/sub/mul/div; compatible fast/SoftFloat/approximate f64;
// guest precision 32/64/80 and SoftFloat rounding 0..3.
static mut COUNTS: [[[[u64; 4]; 3]; 3]; 4] = [[[[0; 4]; 3]; 3]; 4];
// Accepted/rejected regions, native arithmetic ops, initial conversions,
// architectural writebacks, local reads, native comparisons and their regions.
static mut CACHE: [u64; 10] = [0; 10];

#[no_mangle]
pub fn performance_recording_x87_version() -> u32 { 5 }

#[no_mangle]
pub unsafe fn performance_recording_x87_enable(enabled: bool) {
    ENABLED = enabled;
    if enabled {
        COUNTS = [[[[0; 4]; 3]; 3]; 4];
        CACHE = [0; 10];
    }
}

#[inline(always)]
pub fn enabled() -> bool { unsafe { ENABLED } }

// Called only after the recording guard in softfloat.rs.
#[inline]
pub fn record(op: usize, path: usize, precision: u8, rounding: u8) {
    record_count(op, path, precision, rounding, 1);
}

#[inline]
pub fn record_count(op: usize, path: usize, precision: u8, rounding: u8, count: u64) {
    let precision = match precision {
        32 => 0,
        64 => 1,
        80 => 2,
        _ => return,
    };
    if rounding > 3 {
        return;
    }
    unsafe {
        COUNTS[op][path][precision][rounding as usize] += count;
    }
}

#[inline]
pub fn cache_add(index: usize, count: u64) {
    unsafe {
        if ENABLED {
            CACHE[index] += count;
        }
    }
}

#[no_mangle]
pub unsafe fn performance_recording_x87_cache_get(index: u32) -> f64 {
    if index < 10 {
        CACHE[index as usize] as f64
    }
    else {
        0.0
    }
}

#[no_mangle]
pub unsafe fn performance_recording_x87_get(
    op: u32,
    path: u32,
    precision: u32,
    rounding: u32,
) -> f64 {
    if op >= 4 || path >= 3 || precision >= 3 || rounding >= 4 {
        return 0.0;
    }
    COUNTS[op as usize][path as usize][precision as usize][rounding as usize] as f64
}
