//! Wide native publication and entry checks. Keys retain complete architectural
//! addresses. Generated register-only blocks cannot call devices or modify guest
//! memory, and every entry rechecks bytes and the current core's translation.
use super::{compiler, memory, paging, physical, state};
use crate::cpu::{apic, cpu, execution, global_pointers as gp};
use std::sync::Mutex;

mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn x64_native_publish(token: u64, pointer: u32, length: u32);
        pub fn x64_native_execute(token: u64, budget: u32) -> u32;
        pub fn x64_native_discard();
    }
}
#[derive(Clone, Copy, Eq, PartialEq)]
struct Key {
    rip: u64,
    cr0: u64,
    cr3: u64,
    cr4: u64,
    efer: u64,
    fs: u64,
    gs: u64,
    cs_base: u64,
    cs_limit: u32,
    cs: u16,
    cs_access: u8,
    cpl: u8,
    core: u8,
    generation: u64,
}
impl Key {
    unsafe fn current() -> Self {
        Self {
            rip: state::read_rip(),
            cr0: state::read_cr(0),
            cr3: state::read_cr(3),
            cr4: state::read_cr(4),
            efer: state::efer(),
            fs: state::read_segment_base(4),
            gs: state::read_segment_base(5),
            cs_base: state::read_segment_base(1),
            cs_limit: *gp::segment_limits.add(1),
            cs: *gp::sreg.add(1),
            cs_access: *gp::segment_access_bytes.add(1),
            cpl: *gp::cpl,
            core: apic::current_core() as u8,
            generation: physical::generation(),
        }
    }
}
#[derive(Clone)]
// `source` is shared so the guard's per-entry snapshot does not copy bytes.
struct Entry {
    key: Key,
    token: u64,
    source: std::sync::Arc<[u8]>,
    physical: u64,
    backing: u32,
    ready: bool,
}
// Direct-mapped by RIP. A token carries its slot in the low bits, so entry,
// guard and publication lookups are constant time; a replaced slot makes the
// old token unknown, and its late publication is refused.
const SLOT_BITS: u32 = 12;
const SLOTS: usize = 1 << SLOT_BITS;
struct Cache {
    slots: Vec<Option<Entry>>,
    heat: Vec<(u64, u32)>,
    live: usize,
    evicted: usize,
    next_token: u64,
    compiled: u64,
    retired: u64,
    rejected: u64,
}
static CACHE: Mutex<Cache> = Mutex::new(Cache {
    slots: Vec::new(),
    heat: Vec::new(),
    live: 0,
    evicted: 0,
    next_token: 1,
    compiled: 0,
    retired: 0,
    rejected: 0,
});
// Each compile is a separate host module instantiation; cold code stays in
// the interpreter until its RIP has been reached this many times.
const HOT_THRESHOLD: u32 = 64;
fn slot_of(rip: u64) -> usize { (rip ^ rip >> SLOT_BITS ^ rip >> 32) as usize & (SLOTS - 1) }
impl Cache {
    fn by_token(&self, token: u64) -> Option<&Entry> {
        self.slots
            .get(token as usize & (SLOTS - 1))?
            .as_ref()
            .filter(|entry| entry.token == token)
    }
}

pub struct Attempt {
    pub retired: u32,
    pub submitted: bool,
}
fn miss() -> Attempt {
    Attempt {
        retired: 0,
        submitted: false,
    }
}
unsafe fn allowed() -> bool {
    if state::read_dr(7) & 255 != 0 {
        return false;
    }
    state::mode().is_long()
        && !execution::is_deterministic()
        && crate::ir::runtime::schedule::enabled()
        && !*gp::in_hlt
        && *gp::interrupt_shadow == 0
        && *gp::flags as u64 & (0x100 | 0x10000) == 0
        && (*gp::flags & 0x200 == 0
            || !apic::has_pending_irq() && !apic::routed_pic_pending(apic::current_core() as u32))
        && !apic::has_core_events()
        && !apic::nmi_pending()
}
unsafe fn source(key: Key) -> Option<(Vec<u8>, u64, u32)> {
    let translation = memory::snapshot_translation(key.rip, paging::Access::Execute)?;
    let page = physical::ram_page(translation.physical.0 & !4095).ok()?;
    let offset = translation.physical.0 as usize & 4095;
    let count = (4096 - offset).min(256);
    let backing = page.backing + offset as u32;
    let bytes =
        std::slice::from_raw_parts(crate::cpu::memory::mem8.add(backing as usize), count).to_vec();
    Some((bytes, translation.physical.0, backing))
}
unsafe fn matches(entry: &Entry, key: Key, runtime: bool) -> bool {
    if entry.key != key {
        return false;
    }
    let address = if runtime {
        match memory::translate(key.rip, paging::Access::Execute, false, false) {
            Ok(p) => p,
            Err(_) => return false,
        }
    }
    else {
        match memory::snapshot_translation(key.rip, paging::Access::Execute) {
            Some(p) => p.physical.0,
            None => return false,
        }
    };
    if address != entry.physical {
        return false;
    }
    let Ok(page) = physical::ram_page(address & !4095)
    else {
        return false;
    };
    let backing = page.backing + (address & 4095) as u32;
    if backing != entry.backing {
        return false;
    }
    let current = std::slice::from_raw_parts(
        crate::cpu::memory::mem8.add(backing as usize),
        entry.source.len(),
    );
    current == &entry.source[..]
}
/// The generated prologue calls this directly as a Wasm-to-Wasm import.
#[no_mangle]
pub unsafe fn x64_native_guard(token: u64) -> bool {
    if !allowed() {
        return false;
    }
    let key = Key::current();
    let entry = CACHE
        .try_lock()
        .unwrap()
        .by_token(token)
        .filter(|entry| entry.ready)
        .cloned();
    let Some(entry) = entry
    else {
        return false;
    };
    // Reject side-effecting page tables before a runtime walk and never keep
    // a lock alive across any operation that could enter a device callback.
    if !matches(&entry, key, false) || !matches(&entry, key, true) {
        return false;
    }
    if !CACHE
        .try_lock()
        .unwrap()
        .by_token(token)
        .is_some_and(|entry| entry.ready)
    {
        return false;
    }
    // Native flags code must never consume an unmaterialized legacy lazy flag.
    let flags = state::read_flags64();
    state::write_flags64(flags);
    true
}
#[no_mangle]
pub unsafe fn x64_native_ready(token: u64, success: bool) -> bool {
    let mut cache = CACHE.try_lock().unwrap();
    match cache.slots.get_mut(token as usize & (SLOTS - 1)) {
        Some(Some(entry)) if entry.token == token => {
            entry.ready = success;
            success
        },
        _ => false,
    }
}
#[no_mangle]
pub unsafe fn x64_native_reset() {
    let mut cache = CACHE.try_lock().unwrap();
    cache.slots.clear();
    cache.heat.clear();
    cache.live = 0;
    cache.evicted = 0;
    drop(cache);
    js::x64_native_discard();
}
#[no_mangle]
pub fn x64_native_stat(field: u32) -> f64 {
    let cache = CACHE.try_lock().unwrap();
    match field {
        0 => cache.compiled as f64,
        1 => cache.retired as f64,
        2 => cache.rejected as f64,
        _ => cache.live as f64,
    }
}
pub unsafe fn run(budget: u32) -> Attempt {
    if budget == 0 || !allowed() {
        return miss();
    }
    let key = Key::current();
    let found = {
        let cache = CACHE.try_lock().unwrap();
        match cache.slots.get(slot_of(key.rip)) {
            Some(Some(entry)) if entry.key == key => Some((entry.token, entry.ready)),
            _ => None,
        }
    };
    if let Some((token, ready)) = found {
        // Uncompilable code is remembered without revalidation: a stale
        // negative entry only forgoes a compile until its slot is reused.
        if !ready || token == 0 {
            return miss();
        }
        // No Rust cache reference or lock may cross this callback: the native
        // prologue re-enters x64_native_guard on the same module, which
        // revalidates bytes and translation before any architectural effect.
        let retired = js::x64_native_execute(token, budget).min(budget);
        if retired == 0 {
            let mut cache = CACHE.try_lock().unwrap();
            let slot = slot_of(key.rip);
            if cache.slots[slot]
                .as_ref()
                .is_some_and(|entry| entry.token == token && !matches(entry, key, false))
            {
                cache.slots[slot] = None;
                cache.live -= 1;
                cache.evicted += 1;
                cache.rejected += 1;
            }
        }
        if retired != 0 {
            *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(retired);
            execution::note_native_retired(retired, execution::jit_dispatches());
            CACHE.try_lock().unwrap().retired += retired as u64;
            cpu::handle_irqs();
        }
        return Attempt {
            retired,
            submitted: false,
        };
    }
    {
        let mut cache = CACHE.try_lock().unwrap();
        if cache.heat.is_empty() {
            cache.heat.resize(SLOTS, (u64::MAX, 0));
        }
        let heat = &mut cache.heat[slot_of(key.rip)];
        if heat.0 != key.rip {
            *heat = (key.rip, 0);
        }
        heat.1 += 1;
        if heat.1 < HOT_THRESHOLD {
            return miss();
        }
        heat.1 = 0;
    }
    let Some((bytes, physical, backing)) = source(key)
    else {
        return miss();
    };
    let token = {
        let mut cache = CACHE.try_lock().unwrap();
        // Replaced entries leave published host functions behind; bound them.
        if cache.evicted >= SLOTS {
            drop(cache);
            x64_native_reset();
            cache = CACHE.try_lock().unwrap();
        }
        let Some(next) = cache.next_token.checked_add(1)
        else {
            return miss();
        };
        if next >> (64 - SLOT_BITS) != 0 {
            return miss();
        }
        let token = cache.next_token << SLOT_BITS | slot_of(key.rip) as u64;
        cache.next_token = next;
        token
    };
    let artifact = compiler::compile(&bytes, state::GuestIp(key.rip), token, 32).ok();
    let compiled = artifact.is_some();
    let used = artifact
        .as_ref()
        .map_or(bytes.len().min(15), |a| a.plan.source_bytes);
    {
        let mut cache = CACHE.try_lock().unwrap();
        if cache.slots.is_empty() {
            cache.slots.resize(SLOTS, None);
        }
        let slot = slot_of(key.rip);
        match &cache.slots[slot] {
            Some(old) => {
                if old.token != 0 {
                    cache.evicted += 1;
                }
            },
            None => cache.live += 1,
        }
        cache.slots[slot] = Some(Entry {
            key,
            token: if compiled { token } else { 0 },
            source: bytes[..used].into(),
            physical,
            backing,
            ready: false,
        });
        if compiled {
            cache.compiled += 1;
        }
    }
    if let Some(artifact) = artifact {
        js::x64_native_publish(
            token,
            artifact.bytes.as_ptr() as u32,
            artifact.bytes.len() as u32,
        );
        Attempt {
            retired: 0,
            submitted: true,
        }
    }
    else {
        miss()
    }
}
