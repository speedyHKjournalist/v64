//! Runtime of the x64 page tier (x64::pagegen): which long-mode pages to
//! compile, publication into the shared Wasm table, entry, the helpers that
//! generated code calls, and invalidation.
//!
//! A function is keyed by its linear code page and that page's current RAM
//! backing page. Entry translates RIP for execution first, so a function only
//! runs while its page maps to the bytes it was compiled from; writes to the
//! backing page (CPU, DMA, host) retire it through jit::jit_dirty_page.
use super::{jac, memory, pagegen, paging, physical, state};
use crate::cpu::{apic, cpu, execution, global_pointers as gp};
use crate::page::Page;
use std::collections::{HashMap, HashSet};

mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn x64_page_publish(id: u64, slot: u32, pointer: u32, length: u32);
    }
}
extern "C" {
    fn call_indirect1_ret(f: i32, x: u16) -> i32;
}

/// Interpreted instructions on a page before it is compiled.
const HOT: u32 = 2000;
/// Unserved entries reached through a published function before recompiling.
const RECOMPILE_MISSES: u32 = 64;
const MAX_RECOMPILES: u32 = 12;
pub const MAX_FUNCTIONS: usize = 1500;
const MAX_TRACKED_PAGES: usize = 16384;
const FAST_SLOTS: usize = 4096;

#[derive(PartialEq, Eq, Clone, Copy)]
enum Phase {
    Pending,
    Ready,
    Dead,
}
struct Function {
    /// backing page number (a function serves every mapping of the page)
    page: u32,
    id: u64,
    slot: u32,
    phase: Phase,
    served: [u64; 64],
    last_used: u64,
    /// the source page's bytes (hash) when compiled: with cores in workers,
    /// checked again after the page is published (crate::parallel::code)
    source: u64,
}
fn bit(set: &[u64; 64], offset: u16) -> bool { set[offset as usize / 64] >> (offset % 64) & 1 != 0 }
struct PageState {
    heat: u32,
    entries: [u64; 64],
    entry_count: u32,
    misses: u32,
    compiles: u32,
}
impl Default for PageState {
    fn default() -> Self {
        Self {
            heat: 0,
            entries: [0; 64],
            entry_count: 0,
            misses: 0,
            compiles: 0,
        }
    }
}
/// Multiplicative hashing for page numbers.
#[derive(Default)]
struct PageHasher(u64);
impl std::hash::Hasher for PageHasher {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        }
    }
    fn write_u32(&mut self, value: u32) {
        self.0 = (value as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}
type PageMap<V> = HashMap<u32, V, std::hash::BuildHasherDefault<PageHasher>>;
struct Runtime {
    functions: Vec<Function>,
    by_page: PageMap<usize>,
    pages: PageMap<PageState>,
    /// slots of dead functions, released at the next cold point
    releases: Vec<(u32, u64)>,
    next_id: u64,
    clock: u64,
    last_rip: u64,
    enabled: bool,
    stats: [u64; 12],
}
static mut RUNTIME: Option<Runtime> = None;
/// Hot path lookup: backing page number and function index + 1, validated
/// against the function on every use.
static mut FAST: [(u32, u32); FAST_SLOTS] = [(0, 0); FAST_SLOTS];
// Statistics (x64_page_stat): compiled, native retired, retries, unknown
// exits, steps, invalidated, entries, compile failures, recompiles,
// instructions compiled, templated, evictions.
const COMPILED: usize = 0;
const RETIRED: usize = 1;
const RETRIES: usize = 2;
const UNKNOWN: usize = 3;
const INVALIDATED: usize = 5;
const ENTRIES: usize = 6;
const FAILED: usize = 7;
const RECOMPILED: usize = 8;
const INSTRUCTIONS: usize = 9;
const TEMPLATED: usize = 10;
const EVICTED: usize = 11;

/// A generated function is running.
static mut ACTIVE: bool = false;
/// Code-page invalidations; a step that changes it ends the activation.
static mut CODE_WRITES: u64 = 0;
static mut STEPS: u64 = 0;

/// The runtime state. Single-threaded, and no caller holds the reference
/// across a call that can re-enter this module (compilation, publication,
/// generated code, the interpreter or jit::).
fn rt() -> &'static mut Runtime {
    unsafe {
        (*(&raw mut RUNTIME)).get_or_insert_with(|| Runtime {
            functions: Vec::new(),
            by_page: PageMap::default(),
            pages: PageMap::default(),
            releases: Vec::new(),
            next_id: 1,
            clock: 0,
            last_rip: 0,
            enabled: true,
            stats: [0; 12],
        })
    }
}
fn fast_slot(page: u32) -> usize { (page as usize ^ (page as usize >> 12)) & (FAST_SLOTS - 1) }

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

/// Native execution is exact only without instruction-level observers.
/// Deliverable interrupts were taken by handle_irqs before this point; any
/// that become pending meanwhile wait at most one activation budget (steps
/// that make one deliverable end the activation).
pub unsafe fn allowed() -> bool {
    if *gp::in_hlt
        || *gp::interrupt_shadow != 0
        || *gp::flags as u64 & (0x100 | 0x10000) != 0
        || state::read_dr(7) & 255 != 0
        || execution::is_deterministic()
        || !state::mode().is_long()
    {
        return false;
    }
    crate::ir::runtime::schedule::enabled() && !apic::has_core_events() && !apic::nmi_pending()
}

/// Per core: the last code page translation (access cache epoch | user,
/// linear page, backing). An x64 TLB invalidation changes the epoch.
static mut CODE_TLB: [(u64, u64, u32); 8] = [(0, 0, 0); 8];
unsafe fn code_page(rip: u64) -> Option<u32> {
    let core = apic::current_core();
    let tag = jac::epoch_bits(core) | (*gp::cpl == 3) as u64;
    let (cached_tag, linear, backing) = CODE_TLB[core];
    if cached_tag == tag && linear == rip >> 12 {
        return Some(backing);
    }
    let physical = memory::translate(rip, paging::Access::Execute, false, false).ok()?;
    let backing = code_backing(physical)?;
    CODE_TLB[core] = (tag, rip >> 12, backing);
    Some(backing)
}

/// RAM backing page of the code page at physical `address`.
unsafe fn code_backing(address: u64) -> Option<u32> {
    if physical::plain_ram(address & !4095, 4096) {
        return Some((address & !4095) as u32);
    }
    jac::ram_backing(address)
}

unsafe fn release_dead(r: &mut Runtime) {
    if ACTIVE {
        return;
    }
    for (slot, id) in r.releases.drain(..) {
        crate::jit::ir_release_slot(slot, id);
    }
}

/// Run published code at RIP for up to `budget` instructions, or note the
/// interpreted instruction there. `retired` counts everything this call
/// retired (native instructions and interpreted steps).
pub unsafe fn run(budget: u32) -> Attempt {
    if budget == 0 || !allowed() {
        return miss();
    }
    let rip = state::read_rip();
    let Some(backing) = code_page(rip)
    else {
        return miss();
    };
    let page = backing >> 12;
    let offset = (rip & 4095) as u16;
    let r = rt();
    if !r.enabled {
        return miss();
    }
    if !r.releases.is_empty() {
        release_dead(r);
    }
    let last = r.last_rip;
    r.last_rip = rip;
    // Far transfers (not the next few bytes) start blocks.
    let far = !(last < rip && rip - last <= 15);
    let (fast_page, fast_index) = FAST[fast_slot(page)];
    let index = if fast_page == page && fast_index != 0 {
        Some(fast_index as usize - 1)
    }
    else {
        let found = r.by_page.get(&page).copied();
        if let Some(i) = found {
            FAST[fast_slot(page)] = (page, i as u32 + 1);
        }
        found
    };
    match index {
        Some(i)
            if r.functions[i].page == page
                && r.functions[i].phase == Phase::Ready
                && bit(&r.functions[i].served, offset) =>
        {
            r.clock += 1;
            r.functions[i].last_used = r.clock;
            let slot = r.functions[i].slot;
            execute(slot, budget, rip)
        },
        Some(i) if r.functions[i].page == page && r.functions[i].phase != Phase::Dead => {
            if r.functions[i].phase == Phase::Ready && far {
                // An entry the function does not serve: recompile once
                // enough such entries accumulate.
                note_entry(r, page, offset);
                let state = r.pages.entry(page).or_default();
                state.misses += 1;
                if state.misses >= RECOMPILE_MISSES && state.compiles < MAX_RECOMPILES {
                    state.misses = 0;
                    return compile(page, backing);
                }
            }
            miss()
        },
        _ => {
            if far {
                note_entry(r, page, offset);
            }
            let state = r.pages.entry(page).or_default();
            state.heat += 1;
            if state.heat >= HOT && state.compiles < MAX_RECOMPILES {
                state.heat = 0;
                if state.entry_count == 0 {
                    state.entries[offset as usize / 64] |= 1 << (offset % 64);
                    state.entry_count = 1;
                }
                return compile(page, backing);
            }
            miss()
        },
    }
}

fn note_entry(r: &mut Runtime, page: u32, offset: u16) {
    if r.pages.len() >= MAX_TRACKED_PAGES && !r.pages.contains_key(&page) {
        // Forget cold pages; published functions keep their own entries.
        r.pages.retain(|_, state| state.compiles != 0);
        if r.pages.len() >= MAX_TRACKED_PAGES / 2 {
            r.pages.clear();
        }
    }
    let state = r.pages.entry(page).or_default();
    let (word, mask) = (offset as usize / 64, 1u64 << (offset % 64));
    if state.entries[word] & mask == 0 {
        state.entries[word] |= mask;
        state.entry_count += 1;
        r.stats[ENTRIES] += 1;
    }
}

unsafe fn execute(slot: u32, budget: u32, rip: u64) -> Attempt {
    let before = *gp::instruction_counter;
    let core = apic::current_core();
    *gp::x64_jac_base = jac::base(core, *gp::cpl == 3);
    *gp::x64_jac_epoch = jac::epoch_bits(core);
    *gp::x64_page_linear = rip & !4095;
    *gp::x64_page_exit = pagegen::EXIT_NORMAL;
    // Generated code keeps EFLAGS materialized.
    if *gp::flags_changed != 0 {
        let flags = state::read_flags64();
        state::write_flags64(flags);
    }
    ACTIVE = true;
    let native = call_indirect1_ret(
        (slot + cpu::WASM_TABLE_OFFSET) as i32,
        budget.min(u16::MAX as u32) as u16,
    ) as u32;
    ACTIVE = false;
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(native);
    execution::note_native_retired(native, execution::jit_dispatches());
    let exit = *gp::x64_page_exit;
    let r = rt();
    r.stats[RETIRED] += native as u64;
    r.last_rip = state::read_rip();
    match exit {
        pagegen::EXIT_RETRY => {
            r.stats[RETRIES] += 1;
            profile_instruction(0x20000);
            // Native code resumes after the interpreted instruction.
            let before = page_of_rip();
            cpu::run_long_instruction();
            if let (Some(page), Some(after)) = (before, page_of_rip()) {
                if page == after {
                    let r = rt();
                    note_entry(r, after, (state::read_rip() & 4095) as u16);
                    r.pages.entry(after).or_default().misses += 1;
                }
            }
        },
        pagegen::EXIT_UNKNOWN => r.stats[UNKNOWN] += 1,
        _ => {},
    }
    cpu::handle_irqs();
    Attempt {
        retired: (*gp::instruction_counter).wrapping_sub(before),
        submitted: false,
    }
}

unsafe fn page_of_rip() -> Option<u32> {
    let physical = memory::snapshot_translation(state::read_rip(), paging::Access::Execute)?
        .physical
        .0;
    Some(code_backing(physical)? >> 12)
}

unsafe fn compile(page: u32, backing: u32) -> Attempt {
    let r = rt();
    let state = r.pages.entry(page).or_default();
    state.compiles += 1;
    let recompile = state.compiles > 1;
    let entries: Vec<u16> = (0..4096u16).filter(|&o| bit(&state.entries, o)).collect();
    let bytes =
        std::slice::from_raw_parts(crate::cpu::memory::mem8.add(backing as usize), 4096).to_vec();
    let Some(code) = pagegen::compile(&bytes, &entries)
    else {
        rt().stats[FAILED] += 1;
        return miss();
    };
    let r = rt();
    if recompile {
        r.stats[RECOMPILED] += 1;
    }
    // Room in the table: retire the least recently used function.
    let live = r
        .functions
        .iter()
        .filter(|f| f.phase != Phase::Dead)
        .count();
    if live >= MAX_FUNCTIONS {
        if let Some(i) = r
            .functions
            .iter()
            .enumerate()
            .filter(|(_, f)| f.phase == Phase::Ready)
            .min_by_key(|(_, f)| f.last_used)
            .map(|(i, _)| i)
        {
            retire(r, i);
            r.stats[EVICTED] += 1;
        }
    }
    release_dead(r);
    let id = r.next_id;
    r.next_id += 1;
    // Watching the page retires cached write translations to it (jac).
    let Some(slot) = crate::jit::ir_reserve_slot(id, HashSet::from([Page::page_of(backing)]))
    else {
        rt().stats[FAILED] += 1;
        return miss();
    };
    let r = rt();
    if let Some(&old) = r.by_page.get(&page) {
        retire(r, old);
    }
    let reusable = |f: &Function, releases: &Vec<(u32, u64)>| {
        f.phase == Phase::Dead && !releases.iter().any(|&(s, i)| s == f.slot && i == f.id)
    };
    let index = match r.functions.iter().position(|f| reusable(f, &r.releases)) {
        Some(i) => i,
        None => {
            r.functions.push(Function {
                page,
                id: 0,
                slot: 0,
                phase: Phase::Dead,
                served: [0; 64],
                last_used: 0,
                source: 0,
            });
            r.functions.len() - 1
        },
    };
    r.clock += 1;
    r.functions[index] = Function {
        page,
        id,
        slot,
        phase: Phase::Pending,
        served: code.served,
        last_used: r.clock,
        source: source_hash(&bytes),
    };
    r.by_page.insert(page, index);
    FAST[fast_slot(page)] = (page, index as u32 + 1);
    r.stats[COMPILED] += 1;
    r.stats[INSTRUCTIONS] += code.instructions as u64;
    r.stats[TEMPLATED] += code.templated as u64;
    // The host installs it synchronously when it can (x64_page_install).
    js::x64_page_publish(
        id,
        slot,
        code.bytes.as_ptr() as u32,
        code.bytes.len() as u32,
    );
    Attempt {
        retired: 0,
        submitted: false,
    }
}

fn retire(r: &mut Runtime, index: usize) {
    let f = &mut r.functions[index];
    if f.phase == Phase::Dead {
        return;
    }
    f.phase = Phase::Dead;
    let (page, slot, id) = (f.page, f.slot, f.id);
    if r.by_page.get(&page) == Some(&index) {
        r.by_page.remove(&page);
    }
    unsafe {
        if FAST[fast_slot(page)].0 == page {
            FAST[fast_slot(page)] = (0, 0);
        }
    }
    r.releases.push((slot, id));
}

/// Called by the host before table.set: false if the function was retired
/// meanwhile (its source changed, or reset).
#[no_mangle]
pub fn x64_page_install(id: u64, slot: u32) -> bool {
    let r = rt();
    let Some(f) = r
        .functions
        .iter()
        .find(|f| f.id == id && f.slot == slot && f.phase == Phase::Pending)
    else {
        return false;
    };
    if !crate::parallel::active() {
        return true;
    }
    // other cores mark the page first, then its bytes are checked once more
    let (page, source) = (f.page, f.source);
    let backing = match r.by_page.get(&page) {
        Some(_) => page,
        None => return false,
    };
    if !crate::jit::wait_pages_published(std::iter::once(Page::page_of(backing << 12)), 0.5) {
        return false;
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(crate::cpu::memory::mem8.add((backing << 12) as usize), 4096)
    };
    source_hash(bytes) == source
}

/// FNV-1a over a code page
fn source_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xCBF29CE484222325u64;
    for &byte in bytes {
        hash = (hash ^ byte as u64).wrapping_mul(0x100000001B3);
    }
    hash
}
#[no_mangle]
pub fn x64_page_ready(id: u64, slot: u32) -> bool {
    let r = rt();
    match r
        .functions
        .iter_mut()
        .find(|f| f.id == id && f.slot == slot && f.phase == Phase::Pending)
    {
        Some(f) => {
            f.phase = Phase::Ready;
            true
        },
        None => false,
    }
}
#[no_mangle]
pub fn x64_page_cancel(id: u64, slot: u32) {
    let r = rt();
    if let Some(i) = r
        .functions
        .iter()
        .position(|f| f.id == id && f.slot == slot && f.phase != Phase::Dead)
    {
        retire(r, i);
        r.stats[FAILED] += 1;
    }
    unsafe { release_dead(r) };
}

/// A write to a watched backing page (see jit::jit_dirty_page).
pub fn dirty_page(page: u32) {
    let r = rt();
    let Some(&index) = r.by_page.get(&page)
    else {
        return;
    };
    let dead = [index];
    unsafe {
        CODE_WRITES += 1;
    }
    for i in dead {
        retire(r, i);
        r.stats[INVALIDATED] += 1;
    }
    // Slots are released at the next entry, outside the JIT state lock.
}

/// Retire everything (jit_clear_cache: reset, restore, mapping changes).
pub fn reset() {
    let r = rt();
    for i in 0..r.functions.len() {
        retire(r, i);
    }
    r.pages.clear();
    r.last_rip = 0;
    unsafe {
        CODE_WRITES += 1;
    }
}

#[no_mangle]
pub fn x64_page_set_enabled(enabled: bool) {
    rt().enabled = enabled;
    if !enabled {
        reset();
    }
}
#[no_mangle]
pub fn x64_page_stat(field: u32) -> f64 {
    let r = rt();
    match field as usize {
        4 => unsafe { STEPS as f64 },
        12 => r
            .functions
            .iter()
            .filter(|f| f.phase == Phase::Ready)
            .count() as f64,
        f if f < 12 => r.stats[f] as f64,
        _ => 0.0,
    }
}

// Helpers called by generated code -------------------------------------

/// Host address for a `kind & 255`-byte access (bit 8: write) at linear
/// `address` for the current privilege, filling the access cache; 0 when the
/// instruction must be interpreted instead (fault, device or VGA memory,
/// page with compiled code, page crossing). No guest-visible effects except
/// the A/D updates of a successful translation.
#[no_mangle]
pub unsafe fn x64_page_access(address: u64, kind: u32) -> u32 {
    let size = (kind & 0xFF) as u64;
    let write = kind & 0x100 != 0;
    if (address & 4095) + size > 4096 {
        ACCESS_REFUSED[0] += 1;
        return 0;
    }
    // generated accesses are atomic with cores in workers: aligned only
    if crate::wasmgen::wasm_builder::WasmBuilder::ATOMIC_GUEST_MEMORY
        && address & (size.min(8) - 1) != 0
    {
        ACCESS_REFUSED[0] += 1;
        return 0;
    }
    let access = if write { paging::Access::Write } else { paging::Access::Read };
    let Ok(physical) = memory::translate(address, access, false, false)
    else {
        ACCESS_REFUSED[1] += 1;
        return 0;
    };
    let Some(backing) = jac::ram_backing(physical)
    else {
        // extended RAM (never code): its frame, while cores share this thread
        if let Some(host) = super::extended::cache_frame(physical, write) {
            let backing = host.wrapping_sub(crate::cpu::memory::mem8 as u32);
            jac::fill(apic::current_core(), *gp::cpl == 3, write, address, backing);
            return host.wrapping_add((address & 4095) as u32);
        }
        ACCESS_REFUSED[2] += 1;
        return 0;
    };
    if write && crate::jit::page_needs_notification(Page::page_of(backing)) {
        ACCESS_REFUSED[3] += 1;
        return 0;
    }
    jac::fill(apic::current_core(), *gp::cpl == 3, write, address, backing);
    (crate::cpu::memory::mem8 as u32)
        .wrapping_add(backing)
        .wrapping_add((address & 4095) as u32)
}

#[derive(PartialEq)]
struct Context {
    cpl: u8,
    cs: u16,
    long: bool,
    cr0: u64,
    cr3: u64,
    cr4: u64,
    efer: u64,
    control: i32,
    dr7: u64,
    epoch: u64,
}
unsafe fn context() -> Context {
    Context {
        cpl: *gp::cpl,
        cs: *gp::sreg.add(1),
        long: state::mode().is_long(),
        cr0: state::read_cr(0),
        cr3: state::read_cr(3),
        cr4: state::read_cr(4),
        efer: state::efer(),
        // IF, TF, AC, VM, RF and IOPL change what may run natively
        control: *gp::flags & (0x200 | 0x100 | 0x40000 | 0x20000 | 0x10000 | 0x3000),
        dr7: state::read_dr(7),
        epoch: jac::epoch_bits(apic::current_core()),
    }
}

/// Interpret the instruction at RIP (state was written back). Continue the
/// activation only if nothing it depends on changed.
/// Refused cache fills (then retried in the interpreter): page crossing,
/// translation fault, device or VGA memory, page with compiled code.
static mut ACCESS_REFUSED: [u64; 4] = [0; 4];
/// Opt-in histogram of stepped instructions by opcode (x64_page_profile).
static mut STEP_PROFILE: Option<Vec<u32>> = None;
#[no_mangle]
pub unsafe fn x64_page_profile(enabled: bool) { STEP_PROFILE = enabled.then(|| vec![0; 0x40000]); }
/// Steps of opcode `key` (one-byte opcodes 0..255, 0F xx as 0x100 | xx,
/// 0F 38/3A xx as 0x200/0x300 | xx; +0x10000 with a REP prefix; retries at
/// key + 0x20000), or with key >= 0x40000 the refused access counter
/// key - 0x40000.
#[no_mangle]
pub unsafe fn x64_page_profile_get(key: u32) -> f64 {
    if key >= 0x40000 {
        return (*(&raw const ACCESS_REFUSED))
            .get(key as usize - 0x40000)
            .copied()
            .unwrap_or(0) as f64;
    }
    (*(&raw const STEP_PROFILE))
        .as_ref()
        .map_or(0.0, |p| p.get(key as usize).copied().unwrap_or(0) as f64)
}
unsafe fn profile_step() { profile_instruction(0); }
unsafe fn profile_instruction(base: usize) {
    let Some(profile) = (*(&raw mut STEP_PROFILE)).as_mut()
    else {
        return;
    };
    let rip = state::read_rip();
    let mut bytes = [0u8; 15];
    for (i, b) in bytes.iter_mut().enumerate() {
        let Some(t) =
            memory::snapshot_translation(rip.wrapping_add(i as u64), paging::Access::Execute)
        else {
            return;
        };
        let Ok(page) = physical::ram_page(t.physical.0 & !4095)
        else {
            return;
        };
        *b = *crate::cpu::memory::mem8.add((page.backing + (t.physical.0 & 4095) as u32) as usize);
    }
    let mut at = 0;
    let mut rep = 0;
    while at < 14
        && matches!(bytes[at], 0x26 | 0x2E | 0x36 | 0x3E | 0x40..=0x4F | 0x64..=0x67 | 0xF0 | 0xF2 | 0xF3)
    {
        if matches!(bytes[at], 0xF2 | 0xF3) {
            rep = 0x10000;
        }
        at += 1;
    }
    let key = match (bytes[at], bytes[at + 1]) {
        (0x0F, 0x38) => 0x200 | bytes[(at + 2).min(14)] as usize,
        (0x0F, 0x3A) => 0x300 | bytes[(at + 2).min(14)] as usize,
        (0x0F, b) => 0x100 | b as usize,
        (b, _) => b as usize,
    };
    profile[base + (key | rep)] += 1;
}

#[no_mangle]
pub unsafe fn x64_page_step() -> i32 {
    STEPS += 1;
    profile_step();
    let before = context();
    let writes = CODE_WRITES;
    ACTIVE = false;
    cpu::run_long_instruction();
    ACTIVE = true;
    let flags = state::read_flags64();
    state::write_flags64(flags);
    if *gp::in_hlt
        || cpu::core_yield
        || *gp::interrupt_shadow != 0
        || apic::has_core_events()
        || CODE_WRITES != writes
        || context() != before
        || *gp::flags & 0x200 != 0
            && (apic::has_pending_irq() || apic::routed_pic_pending(apic::current_core() as u32))
        || apic::nmi_pending()
    {
        pagegen::STEP_EXIT
    }
    else {
        pagegen::STEP_CONTINUE
    }
}

/// EFLAGS with the pending bits of a lazy record (pagegen::Emitter::record)
/// computed: record = ALU code << 16 | log2(width / 8) << 20 | carry << 23 |
/// pending bits; `a`, `b` the operands.
#[no_mangle]
pub fn x64_page_flags(record: u32, a: u64, b: u64, flags: u32) -> u32 {
    let code = (record >> 16 & 7) as u8;
    let width = 8u8 << (record >> 20 & 3);
    let carry = (record >> 23 & 1) as u64;
    let pending = record & 0x8D5;
    let (_, computed) = super::execute::alu(code, a, b, width, carry);
    flags & !pending | computed as u32 & pending
}

/// RDTSC for generated code (the privilege check is inline).
#[no_mangle]
pub unsafe fn x64_page_rdtsc() -> u64 { cpu::read_tsc() }

/// MOV r64, CR8 for generated code (CPL 0 is checked inline).
#[no_mangle]
pub unsafe fn x64_page_cr8() -> u64 { state::read_cr(8) }
/// MOV CR8, r64 for generated code: 0 continue, 1 retry (reserved bits are
/// #GP), 2 leave after the instruction (an interrupt the new task priority
/// admits is taken at the next boundary).
#[no_mangle]
pub unsafe fn x64_page_set_cr8(value: u64) -> i32 {
    if super::system::write_cr(8, value).is_err() {
        return 1;
    }
    if *gp::flags & cpu::FLAG_INTERRUPT != 0 && apic::has_pending_irq() {
        2
    }
    else {
        0
    }
}

/// Whether the signed 64x64 product of IMUL overflows 64 bits.
#[no_mangle]
pub fn x64_page_imul_overflow(a: u64, b: u64) -> bool { (a as i64).checked_mul(b as i64).is_none() }
/// High 64 bits of the 128-bit product of MUL (or IMUL when `signed`).
#[no_mangle]
pub fn x64_page_mul_high(a: u64, b: u64, signed: bool) -> u64 {
    if signed {
        ((a as i64 as i128 * b as i64 as i128) >> 64) as u64
    }
    else {
        ((a as u128 * b as u128) >> 64) as u64
    }
}
