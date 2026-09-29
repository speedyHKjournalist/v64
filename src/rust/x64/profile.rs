//! Diagnostic instruction-count sampling for the wide interpreter: every
//! `period`-th executed instruction records its full RIP and core. Unlike
//! host-side polling, samples are not biased toward slice or IRQ boundaries.
static mut PERIOD: u32 = 0;
static mut COUNTDOWN: u32 = 0;
static mut SAMPLES: Vec<(u64, u8)> = Vec::new();
const LIMIT: usize = 1 << 20;

#[inline(always)]
pub unsafe fn tick(rip: u64) {
    if PERIOD == 0 {
        return;
    }
    COUNTDOWN -= 1;
    if COUNTDOWN == 0 {
        COUNTDOWN = PERIOD;
        let samples = &mut *(&raw mut SAMPLES);
        if samples.len() < LIMIT {
            samples.push((rip, crate::cpu::apic::current_core() as u8));
        }
    }
}

/// period 0 stops sampling; any other value clears and restarts it.
#[no_mangle]
pub unsafe fn x64_profile_start(period: u32) {
    PERIOD = period;
    COUNTDOWN = period;
    if period != 0 {
        (&mut *(&raw mut SAMPLES)).clear();
    }
}
#[no_mangle]
pub unsafe fn x64_profile_count() -> u32 { (&*(&raw const SAMPLES)).len() as u32 }
/// field 0: RIP low DWORD, 1: RIP high DWORD, 2: core.
#[no_mangle]
pub unsafe fn x64_profile_sample(index: u32, field: u32) -> u32 {
    let Some(&(rip, core)) = (&*(&raw const SAMPLES)).get(index as usize)
    else {
        return 0;
    };
    match field {
        0 => rip as u32,
        1 => (rip >> 32) as u32,
        _ => core as u32,
    }
}
