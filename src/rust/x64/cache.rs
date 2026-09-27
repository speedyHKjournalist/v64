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
    rip: u64, cr0: u64, cr3: u64, cr4: u64, efer: u64,
    fs: u64, gs: u64, cs_base: u64, cs_limit: u32, cs: u16, cs_access: u8,
    cpl: u8, core: u8, generation: u64,
}
impl Key {
    unsafe fn current() -> Self {
        Self { rip: state::read_rip(), cr0: state::read_cr(0), cr3: state::read_cr(3), cr4: state::read_cr(4), efer: state::efer(),
            fs: state::read_segment_base(4), gs: state::read_segment_base(5), cs_base: state::read_segment_base(1),
            cs_limit: *gp::segment_limits.add(1), cs: *gp::sreg.add(1), cs_access: *gp::segment_access_bytes.add(1),
            cpl: *gp::cpl, core: apic::current_core() as u8, generation: physical::generation() }
    }
}
#[derive(Clone)]
struct Entry { key: Key, token: u64, source: Vec<u8>, physical: u64, backing: u32, ready: bool }
struct Cache { entries: Vec<Entry>, next_token: u64, compiled: u64, retired: u64, rejected: u64 }
static CACHE: Mutex<Cache> = Mutex::new(Cache { entries: Vec::new(), next_token: 1, compiled: 0, retired: 0, rejected: 0 });

pub struct Attempt { pub retired: u32, pub submitted: bool }
fn miss() -> Attempt { Attempt { retired: 0, submitted: false } }
unsafe fn allowed() -> bool {
    if state::read_dr(7) & 255 != 0 { return false; }
    state::mode().is_long() && !execution::is_deterministic() && crate::ir::runtime::schedule::enabled() &&
        !*gp::in_hlt && *gp::interrupt_shadow == 0 && state::read_flags64() & (0x100 | 0x10000) == 0 &&
        (state::read_flags64() & 0x200 == 0 || !apic::has_pending_irq() && !apic::routed_pic_pending(apic::current_core() as u32)) &&
        !apic::has_core_events() && !apic::nmi_pending()
}
unsafe fn source(key: Key) -> Option<(Vec<u8>, u64, u32)> {
    let translation = memory::snapshot_translation(key.rip, paging::Access::Execute)?;
    let page = physical::ram_page(translation.physical.0 & !4095).ok()?;
    let offset = translation.physical.0 as usize & 4095;
    let count = (4096 - offset).min(256);
    let backing = page.backing + offset as u32;
    let bytes = std::slice::from_raw_parts(crate::cpu::memory::mem8.add(backing as usize), count).to_vec();
    Some((bytes, translation.physical.0, backing))
}
unsafe fn matches(entry: &Entry, key: Key, runtime: bool) -> bool {
    if entry.key != key { return false; }
    let address = if runtime {
        match memory::translate(key.rip, paging::Access::Execute, false, false) { Ok(p) => p, Err(_) => return false }
    } else {
        match memory::snapshot_translation(key.rip, paging::Access::Execute) { Some(p) => p.physical.0, None => return false }
    };
    if address != entry.physical { return false; }
    let Ok(page) = physical::ram_page(address & !4095) else { return false; };
    let backing = page.backing + (address & 4095) as u32;
    if backing != entry.backing { return false; }
    let current = std::slice::from_raw_parts(crate::cpu::memory::mem8.add(backing as usize), entry.source.len());
    current == entry.source
}
/// The generated prologue calls this directly as a Wasm-to-Wasm import.
#[no_mangle]
pub unsafe fn x64_native_guard(token: u64) -> bool {
    if !allowed() { return false; }
    let key = Key::current();
    let entry = CACHE.try_lock().unwrap().entries.iter().find(|entry| entry.token == token && entry.ready).cloned();
    let Some(entry) = entry else { return false; };
    // Reject side-effecting page tables before a runtime walk and never keep
    // a lock alive across any operation that could enter a device callback.
    if !matches(&entry, key, false) || !matches(&entry, key, true) { return false; }
    if !CACHE.try_lock().unwrap().entries.iter().any(|entry| entry.token == token && entry.ready) { return false; }
    // Native flags code must never consume an unmaterialized legacy lazy flag.
    let flags = state::read_flags64();
    state::write_flags64(flags);
    true
}
#[no_mangle]
pub unsafe fn x64_native_ready(token: u64, success: bool) -> bool {
    let mut cache = CACHE.try_lock().unwrap();
    if let Some(entry) = cache.entries.iter_mut().find(|entry| entry.token == token) {
        entry.ready = success;
        return success;
    }
    false
}
#[no_mangle]
pub unsafe fn x64_native_reset() {
    CACHE.try_lock().unwrap().entries.clear();
    js::x64_native_discard();
}
#[no_mangle]
pub fn x64_native_stat(field: u32) -> f64 {
    let cache = CACHE.try_lock().unwrap();
    match field { 0 => cache.compiled as f64, 1 => cache.retired as f64, 2 => cache.rejected as f64, _ => cache.entries.len() as f64 }
}
pub unsafe fn run(budget: u32) -> Attempt {
    if budget == 0 || !allowed() { return miss(); }
    let key = Key::current();
    let found = {
        let mut cache = CACHE.try_lock().unwrap();
        if let Some(index) = cache.entries.iter().position(|entry| entry.key == key) {
            if matches(&cache.entries[index], key, false) {
                let entry = &cache.entries[index];
                Some((entry.token, entry.ready))
            } else { cache.entries.swap_remove(index); cache.rejected += 1; None }
        } else { None }
    };
    if let Some((token, ready)) = found {
        if !ready || token == 0 { return miss(); }
        // No Rust cache reference or lock may cross this callback: the native
        // prologue re-enters x64_native_guard on the same module.
        let retired = js::x64_native_execute(token, budget).min(budget);
        if retired != 0 {
            *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(retired);
            execution::note_native_retired(retired, execution::jit_dispatches());
            CACHE.try_lock().unwrap().retired += retired as u64;
            cpu::handle_irqs();
        }
        return Attempt { retired, submitted: false };
    }
    let Some((bytes, physical, backing)) = source(key) else { return miss(); };
    let token = {
        let mut cache = CACHE.try_lock().unwrap();
        if cache.entries.len() >= 1024 { drop(cache); x64_native_reset(); cache = CACHE.try_lock().unwrap(); }
        let Some(next) = cache.next_token.checked_add(1) else { return miss(); };
        let token = cache.next_token; cache.next_token = next; token
    };
    let artifact = compiler::compile(&bytes, state::GuestIp(key.rip), token, 32).ok();
    let compiled = artifact.is_some();
    let used = artifact.as_ref().map_or(bytes.len().min(15), |a| a.plan.source_bytes);
    {
        let mut cache = CACHE.try_lock().unwrap();
        cache.entries.push(Entry { key, token: if compiled { token } else { 0 }, source: bytes[..used].to_vec(), physical, backing, ready: false });
        if compiled { cache.compiled += 1; }
    }
    if let Some(artifact) = artifact {
        js::x64_native_publish(token, artifact.bytes.as_ptr() as u32, artifact.bytes.len() as u32);
        Attempt { retired: 0, submitted: true }
    } else { miss() }
}
