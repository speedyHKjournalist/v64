//! Explicit publication into the shared table pool and cold CPU dispatch.
//! No lock or artifact reference survives a guest activation. Dirty/reset hooks
//! retire immediately; slot reuse waits until that activation has returned.
use super::diagnostics::{self as diag, Admission, Scope, Stage};
use super::{
    compile::CapturedRegion,
    entry::{
        admission_epoch, ir_admission_barrier, matches_current as ir_entry_matches, EntryContract,
    },
    live::{self, Job},
    promotion::{self, Alias, Ticket},
    snapshot::{cached_match, capture, mappings_cached, CachedMatch, MergedValidation},
};
use crate::ir::frontend::{decode::GuestEip, region::PredictedEdge};
use crate::{
    cpu::{cpu, global_pointers as gp},
    jit,
    page::Page,
    profiler,
};
use std::{collections::BTreeMap, sync::Mutex};
type EntryIndexKey = (u32, u32, bool);
// A missing entry is not an execution certificate: it only says to use the
// ordinary interpreter path. Keep a bounded set of exact keys outside
// admission so multi-block interpreted loops do not repeatedly lock, collect
// and probe the same absent headers. Collisions only replace an absence hint.
// This CPU owns non-shared Wasm memory; no reference to
// these cells survives a host call. Publication and pending cache maintenance
// always clear the hints; code/mapping changes cannot create a published key.
const ENTRY_HINT_CAPACITY: usize = 64;
static mut MISSING_ENTRIES: [Option<super::entry::CpuEntryKey>; ENTRY_HINT_CAPACITY] =
    [None; ENTRY_HINT_CAPACITY];
static mut MISSING_HINT_ENABLED: bool = true;
static mut MISSING_HINT_HITS: u32 = 0;
// Single-CPU, quiescent-only A/B policy. Poll exits do not grant chaining.
static mut POLL_REUSE_ENABLED: bool = true;
static mut MERGED_VALIDATION_ENABLED: bool = true;
// Code-validity contract. Notified (the default) is the page-notification contract:
// every guest store into a registered code page takes the slow path and calls
// jit_dirty_page, and every host RAM writer (write_blob, DMA, zero_memory, the
// graphics reply ring) calls jit_dirty_cache. dirty_page retires each dependent
// owner synchronously, so admission needs only generation and mapping identity.
// Strict additionally compares every source byte at admission and after each
// continuing observer, detecting raw host writes that bypass both notifications.
static mut STRICT_VALIDATION: bool = false;
#[inline(always)]
pub(super) fn strict_validation() -> bool { unsafe { STRICT_VALIDATION } }
#[inline(always)]
fn clear_missing_hint() {
    unsafe {
        MISSING_ENTRIES = [None; ENTRY_HINT_CAPACITY];
    }
    fast_invalidate();
}

// Direct-mapped admission table for the notified contract. An entry is only a
// witness that, at `stamp`, the exact CpuEntryKey belonged to a Published owner
// in `index`/`slot` with these source mappings. Every retirement, publication,
// compaction, eviction and reset changes FAST_STAMP before the next admission,
// so a hit re-checks only the live CPU context and TLB mapping identity. No
// page walk, A-bit write, callback or byte comparison can happen on this path.
const FAST_CAPACITY: usize = 8192;
const FAST_MAPPINGS: usize = 4;
#[derive(Clone, Copy)]
struct FastEntry {
    stamp: u32,
    linear: u32,
    cs_base: u32,
    default_32: bool,
    tier_one: bool,
    primary: bool,
    /// Witness that no published owner has this exact key at `stamp`.
    negative: bool,
    map_count: u8,
    slot: u32,
    index: u32,
    id: u64,
    maps: [(u32, u32); FAST_MAPPINGS],
}
const EMPTY_FAST: FastEntry = FastEntry {
    stamp: 0,
    linear: 0,
    cs_base: 0,
    default_32: false,
    tier_one: false,
    primary: false,
    negative: false,
    map_count: 0,
    slot: 0,
    index: 0,
    id: 0,
    maps: [(0, 0); FAST_MAPPINGS],
};
static mut FAST: [FastEntry; FAST_CAPACITY] = [EMPTY_FAST; FAST_CAPACITY];
static mut FAST_STAMP: u32 = 1;
// Negative witnesses only become wrong when their own key is published, so
// publication clears exactly those slots; this stamp changes only on a full
// reset (generation change, contract switch).
static mut NEG_STAMP: u32 = 1;
static mut FAST_HITS: u32 = 0;
// Page witnesses: a Tier-0 page function accepts any block start of its page,
// so one witness per (linear page, CS base, mode) replaces a key per entry.
// Validity follows FAST_STAMP exactly like FAST; `blocks` points into the
// record's artifact, which is only freed by collection (a stamp change).
const PAGE_FAST_CAPACITY: usize = 4096;
#[derive(Clone, Copy)]
struct PageWitness {
    stamp: u32,
    /// The function's own page (its entries' page), not a covered neighbor.
    primary: bool,
    page: u32,
    cs_base: u32,
    default_32: bool,
    physical: u32,
    slot: u32,
    index: u32,
    id: u64,
    blocks: *const [u64; 64],
}
const EMPTY_PAGE: PageWitness = PageWitness {
    stamp: 0,
    primary: false,
    page: 0,
    cs_base: 0,
    default_32: false,
    physical: 0,
    slot: 0,
    index: 0,
    id: 0,
    blocks: std::ptr::null(),
};
static mut PAGE_FAST: [PageWitness; PAGE_FAST_CAPACITY] = [EMPTY_PAGE; PAGE_FAST_CAPACITY];
fn page_slot(page: u32, cs_base: u32, default_32: bool) -> usize {
    let bits = page ^ cs_base.rotate_left(9) ^ u32::from(default_32) << 31;
    (bits.wrapping_mul(0x9E3779B1) >> (32 - PAGE_FAST_CAPACITY.trailing_zeros())) as usize
}
fn page_fill(cache: &Cache, index: usize) {
    let record = &cache.records[index];
    let (Some(blocks), Some(_)) = (
        &record.job.artifact.page_blocks,
        record.job.artifact.source_origin,
    )
    else {
        return;
    };
    let EntryContract::Cpu(entry) = record.job.artifact.entry
    else {
        return;
    };
    let mappings = &record.job.source.mappings;
    if strict_validation() || mappings.len() != blocks.len() {
        return;
    }
    // Every covered page's blocks are entries of the function; a page's own
    // function (which covers what follows it) keeps its witness, and of two
    // functions for a page the newer (a recompilation with more entries).
    let id = record.job.artifact.key.job;
    for (mapping, bits) in mappings.iter().zip(blocks.iter()) {
        let page = mapping.linear.0 >> 12;
        let primary = entry.linear.0 >> 12 == page;
        unsafe {
            let slot = page_slot(page, entry.cs_base(), entry.default_32);
            let old = &PAGE_FAST[slot];
            if old.stamp == FAST_STAMP
                && old.page == page
                && old.cs_base == entry.cs_base()
                && old.default_32 == entry.default_32
                && (old.primary && !primary || old.primary == primary && old.id > id)
            {
                continue;
            }
            PAGE_FAST[slot] = PageWitness {
                stamp: FAST_STAMP,
                primary,
                page,
                cs_base: entry.cs_base(),
                default_32: entry.default_32,
                physical: mapping.physical.0,
                slot: record.slot,
                index: index as u32,
                id: record.job.artifact.key.job,
                blocks: bits,
            };
        }
    }
}
/// Page witnesses go stale with every FAST_STAMP change. Exact witnesses are
/// refilled by the complete admission path, but a page function's other block
/// starts are then served by the witnessed fast path, which never refills its
/// page witness: refill every published page function's witness at once.
static mut PAGE_REFILL: bool = false;
#[inline(never)]
unsafe fn refill_page_witnesses() {
    let Ok(cache) = CACHE.try_lock()
    else {
        return;
    };
    PAGE_REFILL = false;
    for index in 0..cache.records.len() {
        if cache.records[index].phase == Phase::Published
            && cache.records[index].job.artifact.page_blocks.is_some()
        {
            page_fill(&cache, index);
        }
    }
}
/// page_probe for chaining: the table slot only.
#[inline(always)]
unsafe fn page_chain_slot(linear: u32, cs_base: u32, default_32: bool) -> Option<u32> {
    let page = linear >> 12;
    let w = &PAGE_FAST[page_slot(page, cs_base, default_32)];
    if w.stamp != FAST_STAMP || w.page != page || w.cs_base != cs_base || w.default_32 != default_32
    {
        return None;
    }
    let offset = linear & 4095;
    if (*w.blocks)[offset as usize >> 6] >> (offset & 63) & 1 == 0 {
        return None;
    }
    let mask =
        cpu::TLB_VALID | cpu::TLB_IA32E_DATA | if *gp::cpl == 3 { cpu::TLB_NO_USER } else { 0 };
    let cached = cpu::tlb_data[page as usize];
    if cached & mask != cpu::TLB_VALID
        || ((cached as u32 & !4095) ^ (linear & !4095))
            .wrapping_sub(crate::cpu::memory::mem8 as u32)
            != w.physical
    {
        return None;
    }
    Some(w.slot)
}
/// page_chain_slot without the TLB check: a published page function's block
/// starts there.
#[inline(always)]
unsafe fn page_witness_matches(linear: u32, cs_base: u32, default_32: bool) -> bool {
    let page = linear >> 12;
    let w = &PAGE_FAST[page_slot(page, cs_base, default_32)];
    w.stamp == FAST_STAMP
        && w.page == page
        && w.cs_base == cs_base
        && w.default_32 == default_32
        && (*w.blocks)[(linear & 4095) as usize >> 6] >> (linear & 63) & 1 != 0
}
/// A block start of a witnessed page function at the current EIP.
#[inline(always)]
unsafe fn page_probe(linear: u32, cs_base: u32, default_32: bool) -> Option<FastEntry> {
    let page = linear >> 12;
    let w = PAGE_FAST[page_slot(page, cs_base, default_32)];
    if w.stamp != FAST_STAMP || w.page != page || w.cs_base != cs_base || w.default_32 != default_32
    {
        return None;
    }
    let offset = linear & 4095;
    if (*w.blocks)[offset as usize >> 6] >> (offset & 63) & 1 == 0 {
        return None;
    }
    let mask =
        cpu::TLB_VALID | cpu::TLB_IA32E_DATA | if *gp::cpl == 3 { cpu::TLB_NO_USER } else { 0 };
    let cached = cpu::tlb_data[page as usize];
    let base = crate::cpu::memory::mem8 as u32;
    if cached & mask != cpu::TLB_VALID
        || ((cached as u32 & !4095) ^ (linear & !4095)).wrapping_sub(base) != w.physical
    {
        return None;
    }
    let mut maps = [(0, 0); FAST_MAPPINGS];
    maps[0] = (linear & !4095, w.physical);
    Some(FastEntry {
        stamp: FAST_STAMP,
        linear,
        cs_base,
        default_32,
        tier_one: true,
        primary: false,
        negative: false,
        map_count: 1,
        slot: w.slot,
        index: w.index,
        id: w.id,
        maps,
    })
}
// The running activation. Owned by this single CPU thread; set immediately
// before a generated call and cleared after it, never across a host yield.
static mut ACTIVE: Option<Owner> = None;
static mut FAST_CHAINS: u32 = 0;
#[inline(always)]
fn fast_invalidate() {
    unsafe {
        PAGE_REFILL = true;
        FAST_STAMP = FAST_STAMP.wrapping_add(1);
        if FAST_STAMP == 0 {
            // Never let a wrapped stamp revalidate an ancient witness.
            fast_reset();
        }
    }
}
/// Full reset of both witness kinds (reset/restore, contract switch).
fn fast_reset() {
    unsafe {
        FAST = [EMPTY_FAST; FAST_CAPACITY];
        PAGE_FAST = [EMPTY_PAGE; PAGE_FAST_CAPACITY];
        PAGE_REFILL = true;
        FAST_STAMP = 1;
        NEG_STAMP = 1;
    }
}
/// A key becomes present: drop its negative witness (a positive one for the
/// key is already stale through FAST_STAMP).
fn fast_clear_key(entry: super::entry::CpuEntryKey) {
    let cs_base = entry.cs_base();
    unsafe {
        let slot = fast_slot(entry.linear.0, cs_base, entry.default_32);
        let e = FAST[slot];
        if e.linear == entry.linear.0 && e.cs_base == cs_base && e.default_32 == entry.default_32 {
            FAST[slot] = EMPTY_FAST;
        }
    }
}
#[inline(always)]
fn fast_slot(linear: u32, cs_base: u32, default_32: bool) -> usize {
    let bits = linear ^ cs_base.rotate_left(7) ^ u32::from(default_32) << 31;
    (bits.wrapping_mul(0x9E3779B1) >> (32 - FAST_CAPACITY.trailing_zeros())) as usize
}
/// Fill a witness after a complete admission under the cache guard.
fn fast_fill(cache: &Cache, index: usize, entry: super::entry::CpuEntryKey) {
    if strict_validation() || cache.resident_promotion {
        return;
    }
    let record = &cache.records[index];
    let mut maps = [(0, 0); FAST_MAPPINGS];
    let mut count = 0;
    let sources = std::iter::once(&record.job.source)
        .chain(record.job.artifact.fused_sources.iter().map(|s| &s.source));
    // A Tier-0 page function validates its other pages itself.
    let tier0 = record.job.artifact.page_blocks.is_some();
    for source in sources {
        for mapping in &source.mappings {
            if tier0 && mapping.linear.0 != entry.linear.0 & !4095 {
                continue;
            }
            let pair = (mapping.linear.0, mapping.physical.0);
            if maps[..count].contains(&pair) {
                continue;
            }
            if count == FAST_MAPPINGS {
                return;
            }
            maps[count] = pair;
            count += 1;
        }
    }
    let cs_base = entry.cs_base();
    unsafe {
        FAST[fast_slot(entry.linear.0, cs_base, entry.default_32)] = FastEntry {
            stamp: FAST_STAMP,
            linear: entry.linear.0,
            cs_base,
            default_32: entry.default_32,
            // Page functions are promoted from their own activation count.
            tier_one: record.job.artifact.tier == super::compile::Tier::One
                && record.job.artifact.source_origin.is_none(),
            primary: record.job.artifact.entry == EntryContract::Cpu(entry),
            negative: false,
            map_count: count as u8,
            slot: record.slot,
            index: index as u32,
            id: record.job.artifact.key.job,
            maps,
        };
    }
}
/// An exact key had no published owner. Only its own publication (which
/// clears this slot) or a full reset can make that stale.
fn fast_fill_negative(entry: super::entry::CpuEntryKey) {
    if strict_validation() {
        return;
    }
    let cs_base = entry.cs_base();
    unsafe {
        FAST[fast_slot(entry.linear.0, cs_base, entry.default_32)] = FastEntry {
            stamp: NEG_STAMP,
            linear: entry.linear.0,
            cs_base,
            default_32: entry.default_32,
            negative: true,
            ..EMPTY_FAST
        };
    }
}
enum Probe {
    Hit(FastEntry),
    Absent,
    Unknown,
}
/// Side-effect-free classification of the current CPU entry.
#[inline(always)]
unsafe fn fast_probe() -> Probe {
    let linear = *gp::instruction_pointer as u32;
    let cs_base = cpu::get_seg_cs() as u32;
    let default_32 = *gp::is_32;
    if *gp::prefixes != 0 || *gp::in_hlt {
        return Probe::Unknown;
    }
    let e = FAST[fast_slot(linear, cs_base, default_32)];
    if e.stamp != if e.negative { NEG_STAMP } else { FAST_STAMP }
        || e.linear != linear
        || e.cs_base != cs_base
        || e.default_32 != default_32
        || e.negative
    {
        // An exact witness is missing (or says no exact owner): a Tier-0
        // page function may still serve this block start.
        if let Some(page) = page_probe(linear, cs_base, default_32) {
            return Probe::Hit(page);
        }
        return if e.negative
            && e.stamp == NEG_STAMP
            && e.linear == linear
            && e.cs_base == cs_base
            && e.default_32 == default_32
        {
            Probe::Absent
        }
        else {
            Probe::Unknown
        };
    }
    let mask =
        cpu::TLB_VALID | cpu::TLB_IA32E_DATA | if *gp::cpl == 3 { cpu::TLB_NO_USER } else { 0 };
    let base = crate::cpu::memory::mem8 as u32;
    for &(linear, physical) in &e.maps[..e.map_count as usize] {
        let cached = cpu::tlb_data[(linear >> 12) as usize];
        if cached & mask != cpu::TLB_VALID
            || ((cached as u32 & !4095) ^ linear).wrapping_sub(base) != physical
        {
            return Probe::Unknown;
        }
    }
    Probe::Hit(e)
}
#[inline(always)]
fn missing_hint_slot(entry: super::entry::CpuEntryKey) -> usize {
    entry_hint_slot(index_key(entry))
}
fn index_key(entry: super::entry::CpuEntryKey) -> EntryIndexKey {
    (entry.linear.0, entry.pc.0, entry.default_32)
}
#[inline(always)]
fn entry_hint_slot(key: EntryIndexKey) -> usize {
    // Low-bit indexing collapses aligned headers within a page into a handful
    // of slots, and aliases 64-page strides. Mix all address bits before taking
    // the high product bits. The saved full key remains the sole lookup witness.
    let bits = key.0 ^ key.1.rotate_left(13) ^ u32::from(key.2);
    (bits.wrapping_mul(0x9E3779B1) >> (32 - ENTRY_HINT_CAPACITY.trailing_zeros())) as usize
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Pending,
    Validated,
    Published,
    Retired,
}
#[derive(Clone, Copy)]
struct Owner {
    index: usize,
    id: u64,
}
#[derive(Clone, Copy)]
struct Successor {
    key: EntryIndexKey,
    owner: Owner,
}
/// Keep both sides of a conditional edge warm. One last-target hint thrashes on
/// alternating branches even when both owners have current admission proofs.
/// These remain lookup hints: every use checks the full key and owner identity.
#[derive(Default)]
struct Successors {
    recent: Option<Successor>,
    other: Option<Successor>,
}
impl Successors {
    #[inline(always)]
    fn get(&self, key: EntryIndexKey) -> Option<Successor> {
        self.recent
            .filter(|s| s.key == key)
            .or_else(|| self.other.filter(|s| s.key == key))
    }
    #[inline(always)]
    fn remember(&mut self, successor: Successor) {
        if self.recent.is_some_and(|s| s.key != successor.key) {
            self.other = self.recent;
        }
        self.recent = Some(successor);
    }
}
struct Record {
    /// Active index aliases. A replacement may supersede one entry without
    /// destroying a shared owner still serving its other entries.
    entries: Vec<super::entry::CpuEntryKey>,
    promotion: Vec<Alias>,
    promotion_parent: Option<Ticket>,
    job: Job,
    /// Allocated only when overlapping fused windows save byte comparisons.
    validation: Option<Box<MergedValidation>>,
    slot: u32,
    phase: Phase,
    automatic: bool,
    /// Monotonic use stamp for deterministic cold-point eviction.
    last_used: u64,
    hits: u32,
    guest_steps: u32,
    max_guest_steps: u32,
    zero_step_exits: u32,
    validated_epoch: u64,
    hot_exit: Option<(PredictedEdge, super::entry::CpuEntryKey, u32)>,
    fusion_attempted: bool,
    /// Scheduling hint only. Full eligibility and source validation remain at
    /// cold selection. Refreshed when heat or the published owner set changes.
    fusion_candidate: bool,
    successors: Successors,
    /// A Tier-1 page function already produced its Tier-2 compilation request.
    page_promoted: bool,
    /// Activations since this record's publication or the last automatic
    /// policy configuration. Tier-1 upgrades are earned from recent activity
    /// (like the scheduler heat they replace), never from history before it.
    promotion_hits: u32,
}
struct Cache {
    records: Vec<Record>,
    resident_promotion: bool,
    promotion_enabled: bool,
    promotion_threshold: u32,
    promotion_cursor: promotion::Cursor,
    promotion_stats: [u32; 4],
    capacity: usize,
    evictions: u32,
    published: BTreeMap<EntryIndexKey, usize>,
    targets: [Option<(EntryIndexKey, usize)>; ENTRY_HINT_CAPACITY],
    missing_targets: [Option<EntryIndexKey>; ENTRY_HINT_CAPACITY],
    negative_hits: u32,
    fast_validation: bool,
    fast_checks: u32,
    full_checks: u32,
    post_fetch_reuses: u32,
    warm_admissions: u32,
    warm_chaining: bool,
    warm_handoffs: u32,
    poll_barriers_avoided: u32,
    target_hits: u32,
    successor_hits: u32,
    fusion_enabled: bool,
    fused_publications: u32,
    shared_publications: u32,
    fused_hits: u32,
    fused_steps: u32,
    needs_collection: bool,
    observer_checks: u32,
    observer_rejections: u32,
    hits: u32,
    rejected: u32,
    failed: u32,
    reclaimed: u32,
    clock: u64,
    links: u32,
    link_misses: u32,
    cached_checks: u32,
    capture_fallbacks: u32,
    guest_steps: u32,
    max_guest_steps: u32,
    zero_step_exits: u32,
    structured_publications: u32,
    generic_publications: u32,
    structured_backedges: u32,
    structured_edges: u32,
    generic_dispatch_edges: u32,
}
static CACHE: Mutex<Cache> = Mutex::new(Cache {
    records: Vec::new(),
    resident_promotion: false,
    promotion_enabled: false,
    promotion_threshold: 256,
    promotion_cursor: promotion::Cursor::new(),
    promotion_stats: [0; 4],
    // At the default heat threshold an XP boot once kept ~1000 regions hot
    // and 256 resident owners evicted and recompiled them; at 768, 256 or
    // 512 the XP desktop boot now evicts none (2026-10-09). The slots come
    // from the shared table (jit::WASM_TABLE_SIZE), which Tier-0 and the x64
    // page tier use too.
    capacity: 768,
    evictions: 0,
    published: BTreeMap::new(),
    targets: [None; ENTRY_HINT_CAPACITY],
    missing_targets: [None; ENTRY_HINT_CAPACITY],
    negative_hits: 0,
    fast_validation: true,
    fast_checks: 0,
    full_checks: 0,
    post_fetch_reuses: 0,
    warm_admissions: 0,
    warm_chaining: true,
    warm_handoffs: 0,
    poll_barriers_avoided: 0,
    target_hits: 0,
    successor_hits: 0,
    // Off by default: on an XP boot, hot-region fusion replaced ~25% of the
    // activations but its per-activation exit profiling and fused compiles
    // cost more (15.47 s vs 15.69 s, paired sync-disk runs). The mechanism
    // remains available through ir_cache_set_fusion and its tests.
    fusion_enabled: false,
    fused_publications: 0,
    shared_publications: 0,
    fused_hits: 0,
    fused_steps: 0,
    needs_collection: false,
    observer_checks: 0,
    observer_rejections: 0,
    hits: 0,
    rejected: 0,
    failed: 0,
    reclaimed: 0,
    clock: 0,
    links: 0,
    link_misses: 0,
    cached_checks: 0,
    capture_fallbacks: 0,
    guest_steps: 0,
    max_guest_steps: 0,
    zero_step_exits: 0,
    structured_publications: 0,
    generic_publications: 0,
    structured_backedges: 0,
    structured_edges: 0,
    generic_dispatch_edges: 0,
});
#[no_mangle]
pub fn ir_cache_capacity() -> u32 { CACHE.try_lock().unwrap().capacity as u32 }
/// Opt-in startup policy. A disabled scheduler and empty cache prevent changing
/// ownership of existing heat or pending promotion attempts.
#[no_mangle]
pub unsafe fn ir_cache_set_resident_promotion(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    super::schedule::set_resident_promotion(enabled != 0)
}
/// Called while the cold scheduler owns its guard. No cache guard calls back
/// into the scheduler; either both policy copies change or neither does.
pub(super) fn set_resident_promotion(enabled: bool) -> bool {
    let mut cache = CACHE.try_lock().unwrap();
    if !cache.records.is_empty() {
        return false;
    }
    cache.resident_promotion = enabled;
    cache.promotion_cursor = promotion::Cursor::new();
    true
}
pub(super) fn configure_promotion(enabled: bool, threshold: u32) {
    let mut cache = CACHE.try_lock().unwrap();
    cache.promotion_enabled = enabled;
    cache.promotion_threshold = threshold;
    cache.promotion_cursor = promotion::Cursor::new();
    for record in &mut cache.records {
        record.promotion_hits = 0;
        for alias in &mut record.promotion {
            alias.reset();
        }
    }
}
fn promotion_index(cache: &Cache, ticket: Ticket) -> Option<(usize, usize)> {
    let index = *cache.published.get(&index_key(ticket.entry))?;
    let record = cache.records.get(index)?;
    if record.phase != Phase::Published || record.job.artifact.key.job != ticket.owner {
        return None;
    }
    let alias = record
        .promotion
        .iter()
        .position(|a| a.entry == ticket.entry)?;
    Some((index, alias))
}
pub(super) fn promotion_current(ticket: Ticket) -> bool {
    promotion_index(&CACHE.try_lock().unwrap(), ticket).is_some()
}
pub(super) fn next_promotion(limit: usize) -> Option<Ticket> {
    let mut cache = CACHE.try_lock().unwrap();
    if !cache.resident_promotion || !cache.promotion_enabled {
        return None;
    }
    // Visit positions directly: no allocation or full-cache pre-scan. Inactive
    // records consume one position too, so they cannot defeat the scan bound.
    let mut first = None;
    for _ in 0..limit {
        let saved = cache.promotion_cursor;
        let position = {
            let Cache {
                records,
                promotion_cursor,
                ..
            } = &mut *cache;
            promotion_cursor.next(records.len(), |index| {
                let record = &records[index];
                if record.phase == Phase::Published {
                    record.promotion.len()
                }
                else {
                    0
                }
            })
        };
        let Some((record, alias)) = position
        else {
            break;
        };
        if first == position {
            // A short cache has completed one full turn. Leave its next cursor
            // at the first unscanned position instead of skipping it next frame.
            cache.promotion_cursor = saved;
            break;
        }
        first.get_or_insert((record, alias));
        cache.promotion_stats[0] = cache.promotion_stats[0].wrapping_add(1);
        let r = &cache.records[record];
        if r.phase != Phase::Published {
            continue;
        }
        let Some(a) = r.promotion.get(alias)
        else {
            continue;
        };
        if a.hits >= cache.promotion_threshold {
            let ticket = Ticket {
                entry: a.entry,
                owner: r.job.artifact.key.job,
            };
            cache.promotion_stats[1] = cache.promotion_stats[1].wrapping_add(1);
            return Some(ticket);
        }
    }
    None
}
pub(super) fn promotion_suppressed(
    ticket: Ticket,
    source: &Option<super::compile::ImmutableCodeSnapshot>,
) -> bool {
    let mut cache = CACHE.try_lock().unwrap();
    let suppressed = promotion_index(&cache, ticket)
        .is_some_and(|(r, a)| cache.records[r].promotion[a].suppressed(source));
    if suppressed {
        cache.promotion_stats[3] = cache.promotion_stats[3].wrapping_add(1);
    }
    suppressed
}
pub(super) fn promotion_failed(
    ticket: Ticket,
    source: Option<super::compile::ImmutableCodeSnapshot>,
) {
    let mut cache = CACHE.try_lock().unwrap();
    if let Some((r, a)) = promotion_index(&cache, ticket) {
        cache.records[r].promotion[a].failed = Some(source);
    }
}
/// Offline compiler replay inspection. The publication bridge copies these
/// immutable inputs synchronously; no pointer may survive a cache mutation.
/// This API never captures guest memory or grants execution authority.
#[no_mangle]
pub fn ir_cache_replay_info(id: u64, group: u32, index: u32, field: u32) -> u32 {
    let cache = CACHE.try_lock().unwrap();
    let Some(record) = cache.records.iter().find(|r| r.job.artifact.key.job == id)
    else {
        return 0;
    };
    let job = &record.job;
    let EntryContract::Cpu(entry) = job.artifact.entry
    else {
        return 0;
    };
    let source = |i: usize| {
        if i == 0 {
            Some((entry, &job.source))
        }
        else {
            job.artifact
                .fused_sources
                .get(i - 1)
                .map(|s| (s.entry, &s.source))
        }
    };
    match group {
        0 => match field {
            0 => 1 + job.artifact.fused_sources.len() as u32,
            1 => job.artifact.alternate_entries.len() as u32,
            2 => job.artifact.fused_edges.len() as u32,
            3 => {
                if job.artifact.tier == super::compile::Tier::One {
                    1
                }
                else {
                    2
                }
            },
            4 => entry.default_32 as u32,
            _ => 0,
        },
        1 => source(index as usize).map_or(0, |(entry, source)| match field {
            0 => entry.pc.0,
            1 => entry.linear.0,
            2 => source.bytes.as_ptr() as u32,
            3 => source.bytes.len() as u32,
            4 => source.mappings.len() as u32,
            _ => 0,
        }),
        2 => job
            .artifact
            .alternate_entries
            .get(index as usize)
            .map_or(0, |e| e.pc.0.wrapping_sub(entry.pc.0)),
        3 => job.artifact.fused_edges.get(index as usize).map_or(0, |e| {
            if field == 0 {
                e.from.0
            }
            else {
                e.target.0
            }
        }),
        4 => source((index >> 16) as usize)
            .and_then(|(_, s)| s.mappings.get((index & 65535) as usize))
            .map_or(0, |m| {
                if field == 0 {
                    m.linear.0
                }
                else {
                    m.physical.0
                }
            }),
        _ => 0,
    }
}
/// Host policy for bounded working-set experiments; does not grow the table pool.
#[no_mangle]
pub unsafe fn ir_cache_set_capacity(capacity: u32) -> bool {
    if !(256..=768).contains(&capacity) || !cold() {
        return false;
    }
    let mut cache = CACHE.try_lock().unwrap();
    if cache.records.len() > capacity as usize {
        return false;
    }
    cache.capacity = capacity as usize;
    true
}
use super::tier0::{t0_link, Link};
extern "C" {
    fn call_indirect1(f: i32, x: u16);
    fn call_indirect1_ret(f: i32, x: u16) -> i32;
}
/// Table slots holding Tier-0 page functions (signature (i32) -> i32: the
/// linear EIP they leave for, see tier0::emit). Set when a function is
/// installed; a slot is only called while its owner is published.
static mut T0_SLOTS: [bool; jit::WASM_TABLE_SIZE as usize] = [false; jit::WASM_TABLE_SIZE as usize];
/// Run the function in table `slot` (either signature).
#[inline(always)]
unsafe fn call_slot(slot: u32) {
    use crate::cpu::execution::{ledger_begin, ledger_end_native, Way};
    let span = ledger_begin();
    if T0_SLOTS[slot as usize] {
        call_indirect1_ret((slot + cpu::WASM_TABLE_OFFSET) as i32, 0);
        ledger_end_native(span, Way::Tier0Native);
    }
    else {
        call_indirect1((slot + cpu::WASM_TABLE_OFFSET) as i32, 0);
        ledger_end_native(span, Way::RegionNative);
    }
}

/// Chained page functions: at most this many nested activations per dispatch.
const T0_CHAIN_DEPTH: u32 = 48;
/// A Tier-0 page function leaving its page has written back all state and
/// the target EIP. If a published page function serves the target block,
/// run it nested (the caller then returns at once) instead of returning to
/// the CPU loop. Same checks as a page-witness dispatch; the CPU batch budget
/// still bounds the chain so interrupts are serviced.
#[no_mangle]
pub unsafe fn ir_t0_chain(depth: u32) -> u32 {
    if t0_link() != Link::Nested
        || depth >= T0_CHAIN_DEPTH
        || COLLECTION_PENDING
        || *gp::prefixes != 0
        || *gp::in_hlt
        || !cpu::ir_link_budget_available()
    {
        return 0;
    }
    let linear = *gp::instruction_pointer as u32;
    let Some(slot) = page_chain_slot(linear, cpu::get_seg_cs() as u32, *gp::is_32)
    else {
        return 0;
    };
    *gp::previous_ip = linear as i32;
    T0_CHAINS = T0_CHAINS.wrapping_add(1);
    super::entry::take_link_request();
    // The callee skips ir_enter_page at depth > 0: the witness matched CS
    // and mode, and prefixes/HLT were checked above.
    call_indirect1_ret((slot + cpu::WASM_TABLE_OFFSET) as i32, (depth + 1) as u16);
    1
}
/// Mirrors Cache::needs_collection for ir_t0_chain (no lock on that path):
/// witnesses of retired owners stay filled until collection.
static mut COLLECTION_PENDING: bool = false;
/// A Tier-0 page function serving EIP runs directly: page functions own no
/// per-activation cache state (hits, fusion profile, LRU stamps), and chain
/// among themselves (ir_t0_chain). False: take the complete path.
unsafe fn t0_execute() -> bool {
    if strict_validation()
        || COLLECTION_PENDING
        || *gp::prefixes != 0
        || *gp::in_hlt
        || profiler::performance_recording_enabled()
        || !jit::ir_cache_quiescent()
    {
        return false;
    }
    if PAGE_REFILL && !busy() {
        refill_page_witnesses();
    }
    let linear = *gp::instruction_pointer as u32;
    let Some(slot) = page_chain_slot(linear, cpu::get_seg_cs() as u32, *gp::is_32).or_else(|| {
        // Page functions never fetch through the TLB, so a flush (a guest
        // context switch) leaves their code pages untranslated until the
        // interpreter runs there: translate EIP as it would next. A fetch
        // fault is delivered for the instruction at EIP, so previous_ip must
        // be EIP (not the last retired instruction, which after SYSEXIT or
        // IRET is kernel code the fault frame would return to in user mode).
        if !page_witness_matches(linear, cpu::get_seg_cs() as u32, *gp::is_32) {
            return None;
        }
        *gp::previous_ip = linear as i32;
        if cpu::get_phys_eip().is_err() {
            return None;
        }
        page_chain_slot(linear, cpu::get_seg_cs() as u32, *gp::is_32)
    })
    else {
        // A fault while translating EIP was delivered, as the interpreter's
        // fetch would have: that is progress.
        return *gp::instruction_pointer as u32 != linear;
    };
    *gp::previous_ip = linear as i32;
    let before = *gp::instruction_counter;
    super::entry::take_link_request();
    T0_ENTRIES = T0_ENTRIES.wrapping_add(1);
    T0_CONTROL = *gp::flags & T0_CONTROL_FLAGS;
    T0_CS = cpu::get_seg_cs() as u32;
    T0_LINKABLE = true;
    // The next linear EIP comes back in a register: a call target derived
    // from the EIP just stored to memory stalls (store-to-load into an
    // indirect call).
    let mut from = linear;
    let span = crate::cpu::execution::ledger_begin();
    let mut linear = call_indirect1_ret((slot + cpu::WASM_TABLE_OFFSET) as i32, 0) as u32;
    if t0_link() != Link::Nested {
        // Iterative linking (as the legacy JIT's jit_link_once): a page
        // function that left for another page's block returns, and this
        // loop enters the next one (depth 1: the checks below replace
        // ir_enter_page's). With tail calls, page functions link among
        // themselves (ir_t0_link) and this loop only retries.
        for _ in 0..64 {
            if !super::entry::link_requested() || !t0_linkable() {
                break;
            }
            sample_link(from, linear);
            let Some(slot) = page_chain_slot(linear, T0_CS, *gp::is_32)
            else {
                break;
            };
            *gp::previous_ip = linear as i32;
            T0_CHAINS = T0_CHAINS.wrapping_add(1);
            super::entry::take_link_request();
            from = linear;
            linear = call_indirect1_ret((slot + cpu::WASM_TABLE_OFFSET) as i32, 1) as u32;
        }
    }
    crate::cpu::execution::ledger_end_native(span, crate::cpu::execution::Way::Tier0Native);
    T0_LINKABLE = false;
    let poll_reuse = POLL_REUSE_ENABLED && super::entry::poll_exit();
    if !super::entry::link_requested() && !poll_reuse {
        ir_admission_barrier();
    }
    super::entry::take_link_request();
    // A page function always retires an instruction; never spin if not.
    *gp::instruction_counter != before
}
static mut T0_ENTRIES: u32 = 0;
/// Links out of a page function's entry page since the page's last
/// decision: the total, and the most frequent target pages (space-saving
/// counters: a new target replaces the least counted and inherits its count
/// as error, so count - error never overstates a target's links). A target
/// with T0_RANGE_LINKS links that are at least a fifth of the page's has the
/// source page recompiled with it: a neighbor its code continues into
/// (schedule::want_range), or any page it often calls or returns to
/// (schedule::want_partner, a cluster function), together with the pages
/// that partner mostly continues to. The page's counts then restart, so its
/// next hottest target is judged on its own; so do they when no target
/// qualified in 64 times that many links. Two ways per set, the page with
/// fewer links giving way.
#[derive(Clone, Copy)]
struct PageOut {
    page: u32,
    total: u32,
    /// Target page, count, error, and the last linear target address.
    targets: [(u32, u32, u32, u32); 4],
}
impl PageOut {
    const fn new(page: u32) -> PageOut {
        PageOut {
            page,
            total: 0,
            targets: [(!0, 0, 0, 0); 4],
        }
    }
}
const PAGE_OUT_SETS: usize = 2048;
static mut PAGE_OUT: [[PageOut; 2]; PAGE_OUT_SETS] = [[PageOut::new(!0); 2]; PAGE_OUT_SETS];
#[inline(always)]
unsafe fn page_out_set(page: u32) -> &'static mut [PageOut; 2] {
    &mut *core::ptr::addr_of_mut!(
        PAGE_OUT[page.wrapping_mul(0x9E3779B1) as usize >> 21 & PAGE_OUT_SETS - 1]
    )
}
/// Links counted per decision, in sampled links (see sample_link): 100K links.
const T0_RANGE_LINKS: u32 = 100_000 >> LINK_SAMPLE_SHIFT;
/// note_link sees a random 1 in 2^LINK_SAMPLE_SHIFT links: its table does not
/// fit in cache, and updating it on every one of ~10M links/s (3DMark06) cost
/// about 2% of all time. Random, not every n-th: a loop alternating between
/// two pages must not be seen in one direction only.
const LINK_SAMPLE_SHIFT: u32 = 3;
static mut LINK_RANDOM: u32 = 0x2545F491;
#[inline(always)]
unsafe fn sample_link(from: u32, to: u32) {
    let mut x = LINK_RANDOM;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    LINK_RANDOM = x;
    if x >> (32 - LINK_SAMPLE_SHIFT) == 0 {
        note_link(from, to);
    }
}
/// Where the page's function goes on to in at least half its links (of
/// enough of them to tell): a chain of pages, each jumping to the next,
/// joins a cluster in one recompilation instead of one per page.
unsafe fn dominant_successor(page: u32) -> Option<u32> {
    let out = page_out_set(page).iter().find(|o| o.page == page)?;
    let &(_, count, error, linear) = out.targets.iter().max_by_key(|t| t.1 - t.2)?;
    (out.total >= T0_RANGE_LINKS / 4 && (count - error) * 2 >= out.total).then_some(linear)
}
/// Whether the page function just left by RET: the address it popped is
/// still below ESP (a 32-bit stack in RAM mapped in the TLB; otherwise no).
/// A return makes its caller a partner only if the caller's page mostly
/// continues back into the returning page: taking a caller into its
/// callee's function copies the caller's code into every callee (a
/// dispatcher into each of its handlers, each copy tiering up on its own)
/// and saves only the return.
#[inline(always)]
unsafe fn link_is_return(to: u32) -> bool {
    if !*gp::stack_size_32 {
        return false;
    }
    let slot = (cpu::get_seg_ss() as u32)
        .wrapping_add(*gp::reg32.add(cpu::ESP as usize) as u32)
        .wrapping_sub(4);
    let mask = cpu::TLB_VALID
        | cpu::TLB_IN_MAPPED_RANGE
        | if *gp::cpl == 3 { cpu::TLB_NO_USER } else { 0 };
    let entry = cpu::tlb_data[(slot >> 12) as usize];
    if entry & mask != cpu::TLB_VALID || slot & 4095 > 4092 {
        return false;
    }
    (((entry as u32 & !4095) ^ slot) as *const u32).read_unaligned() == to
}
#[inline(always)]
unsafe fn note_link(from: u32, to: u32) {
    let (a, b) = (from >> 12, to >> 12);
    if a == b {
        return;
    }
    let set = page_out_set(a);
    let way = if set[0].page == a {
        0
    }
    else if set[1].page == a {
        1
    }
    else {
        let way = (set[1].total < set[0].total) as usize;
        set[way] = PageOut::new(a);
        way
    };
    let out = &mut set[way];
    if out.total >= T0_RANGE_LINKS << 6 {
        *out = PageOut::new(a);
    }
    out.total += 1;
    let mut k = 0;
    while k < 4 && out.targets[k].0 != b {
        k += 1;
    }
    if k == 4 {
        k = (0..4).min_by_key(|&k| out.targets[k].1).unwrap();
        let least = out.targets[k].1;
        out.targets[k] = (b, least, least, to);
    }
    let target = &mut out.targets[k];
    target.1 += 1;
    target.3 = to;
    if target.1 - target.2 < T0_RANGE_LINKS {
        return;
    }
    let total = out.total;
    *out = PageOut::new(a);
    if b.wrapping_sub(a).wrapping_add(1) <= 2 {
        super::schedule::want_range(a << 12, T0_CS, *gp::is_32);
    }
    // A call graph without dominant pairs gains little from clusters.
    else if total / 5 <= T0_RANGE_LINKS
        && (!link_is_return(to) || dominant_successor(b).is_some_and(|next| next >> 12 == a))
    {
        super::schedule::want_partner(a << 12, to, T0_CS, *gp::is_32);
        let mut page = b;
        for _ in 0..crate::ir::tier0::MAX_PAGES - 2 {
            let Some(next) =
                dominant_successor(page).filter(|&next| next >> 12 != a && next >> 12 != page)
            else {
                break;
            };
            super::schedule::want_partner(a << 12, next, T0_CS, *gp::is_32);
            page = next >> 12;
        }
    }
}
const T0_CONTROL_FLAGS: i32 = cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM;
/// State at the t0_execute entry that linking must preserve, and whether a
/// t0_execute activation is running (other callers never link).
static mut T0_CONTROL: i32 = 0;
static mut T0_CS: u32 = 0;
static mut T0_LINKABLE: bool = false;
#[inline(always)]
unsafe fn t0_linkable() -> bool {
    T0_LINKABLE
        && !COLLECTION_PENDING
        && *gp::prefixes == 0
        && !*gp::in_hlt
        && cpu::ir_link_budget_available()
        && *gp::flags & T0_CONTROL_FLAGS == T0_CONTROL
        && cpu::get_seg_cs() as u32 == T0_CS
}
/// An activation from the general paths: a Tier-0 page function may link.
#[inline(always)]
unsafe fn call_linkable(slot: u32) {
    T0_CONTROL = *gp::flags & T0_CONTROL_FLAGS;
    T0_CS = cpu::get_seg_cs() as u32;
    T0_LINKABLE = true;
    call_slot(slot);
    T0_LINKABLE = false;
}
/// Tail-call linking: the table index of the page function serving the
/// written-back EIP, which the leaving page function tail-calls (depth 1),
/// or -1: it then requests a link and returns.
#[no_mangle]
pub unsafe fn ir_t0_link() -> i32 {
    if t0_link() != Link::Tail || !t0_linkable() {
        return -1;
    }
    let linear = *gp::instruction_pointer as u32;
    let Some(slot) = page_chain_slot(linear, T0_CS, *gp::is_32)
    else {
        return -1;
    };
    *gp::previous_ip = linear as i32;
    T0_CHAINS = T0_CHAINS.wrapping_add(1);
    (slot + cpu::WASM_TABLE_OFFSET) as i32
}
#[no_mangle]
pub unsafe fn ir_t0_entries() -> u32 { T0_ENTRIES }
static mut T0_CHAINS: u32 = 0;
#[no_mangle]
pub unsafe fn ir_t0_chains() -> u32 { T0_CHAINS }
#[inline(always)]
fn active() -> Option<Owner> { unsafe { ACTIVE } }
pub fn busy() -> bool { active().is_some() }
pub fn invalidate() {
    ir_admission_barrier();
    fast_reset();
    let mut cache = CACHE.try_lock().unwrap();
    cache.promotion_cursor = promotion::Cursor::new();
    for record in &mut cache.records {
        record.phase = Phase::Retired;
    }
    clear_missing_hint();
    cache.needs_collection = true;
    unsafe { COLLECTION_PENDING = true };
}
pub fn dirty_page(page: u32) {
    super::entry::code_write_barrier();
    let mut cache = CACHE.try_lock().unwrap();
    let mut retired = false;
    for record in &mut cache.records {
        if record
            .job
            .artifact
            .dependencies
            .iter()
            .any(|d| d.page.0 == page)
        {
            record.phase = Phase::Retired;
            retired = true;
        }
    }
    if retired {
        clear_missing_hint();
    }
    cache.needs_collection |= retired;
    if retired {
        unsafe { COLLECTION_PENDING = true };
    }
}
unsafe fn cold() -> bool { !busy() && jit::ir_cache_quiescent() }
/// The values of this module's switches (crate::jit_switches)
pub unsafe fn switch_value(name: &str) -> Option<u32> {
    let cache = CACHE.try_lock().ok()?;
    Some(match name {
        "ir_cache_capacity" => cache.capacity as u32,
        "ir_fast_validation" => cache.fast_validation as u32,
        "ir_warm_chaining" => cache.warm_chaining as u32,
        "ir_fusion" => cache.fusion_enabled as u32,
        "ir_merged_validation" => MERGED_VALIDATION_ENABLED as u32,
        "ir_missing_hint" => MISSING_HINT_ENABLED as u32,
        "ir_poll_reuse" => POLL_REUSE_ENABLED as u32,
        "ir_strict_validation" => STRICT_VALIDATION as u32,
        _ => return None,
    })
}
/// Diagnostic A/B switch; disabling restores full pre/post-fetch validation.
#[no_mangle]
pub unsafe fn ir_cache_set_fast_validation(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    ir_admission_barrier();
    CACHE.try_lock().unwrap().fast_validation = enabled != 0;
    true
}
/// A/B control for the already-validated successor handoff only. This does not
/// change region formation, fusion, byte validation, or guest work budgets.
#[no_mangle]
pub unsafe fn ir_cache_set_warm_chaining(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    ir_admission_barrier();
    CACHE.try_lock().unwrap().warm_chaining = enabled != 0;
    true
}
/// A/B control for preserving already-current certificates at plain poll exits.
/// Turning it off restores the old conservative barrier at every budget exit.
#[no_mangle]
pub unsafe fn ir_cache_set_poll_reuse(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    ir_admission_barrier();
    POLL_REUSE_ENABLED = enabled != 0;
    true
}
/// Exact-overlap comparison A/B policy. Certificates still require every byte
/// and mapping; switching at a cold point invalidates the current reuse epoch.
#[no_mangle]
pub unsafe fn ir_cache_set_merged_validation(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    ir_admission_barrier();
    MERGED_VALIDATION_ENABLED = enabled != 0;
    true
}
/// Cold-point contract switch (see STRICT_VALIDATION). Switching retires no
/// owner: strict mode only adds byte checks, and notified mode relies on the
/// dirty notifications that both modes already apply.
#[no_mangle]
pub unsafe fn ir_cache_set_strict_validation(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    ir_admission_barrier();
    STRICT_VALIDATION = enabled != 0;
    clear_missing_hint();
    fast_reset();
    true
}
/// Startup/cold-point A/B control; absence hints never authorize guest code.
#[no_mangle]
pub unsafe fn ir_cache_set_missing_hint(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    clear_missing_hint();
    MISSING_HINT_ENABLED = enabled != 0;
    true
}
fn target(cache: &mut Cache, key: EntryIndexKey) -> Option<usize> {
    let slot = entry_hint_slot(key);
    if let Some((saved, index)) = cache.targets[slot] {
        if saved == key
            && cache.records.get(index).is_some_and(|r| {
                r.phase == Phase::Published
                    && r.entries.iter().any(|entry| index_key(*entry) == key)
            })
        {
            cache.target_hits = cache.target_hits.wrapping_add(1);
            return Some(index);
        }
    }
    // Misses dominate some interpreted loops. This only caches absence from the
    // published index, never an admission decision. Publication and compaction
    // clear these witnesses before a newly published owner can be dispatched.
    if cache.missing_targets[slot] == Some(key) {
        cache.negative_hits = cache.negative_hits.wrapping_add(1);
        return None;
    }
    let Some(index) = cache.published.get(&key).copied()
    else {
        cache.missing_targets[slot] = Some(key);
        return None;
    };
    if cache.records[index].phase != Phase::Published {
        return None;
    }
    cache.targets[slot] = Some((key, index));
    Some(index)
}
#[inline(always)]
fn successor_target(
    cache: &mut Cache,
    key: EntryIndexKey,
    previous: Option<Owner>,
) -> Option<usize> {
    // Indices are hints, never owners: compaction, replacement and slot reuse
    // must all fail the non-repeating publication identity check.
    let successor = previous.and_then(|p| {
        cache
            .records
            .get(p.index)
            .filter(|r| r.phase == Phase::Published && r.job.artifact.key.job == p.id)
            .and_then(|r| r.successors.get(key))
    });
    if let Some(s) = successor {
        if cache.records.get(s.owner.index).is_some_and(|r| {
            r.phase == Phase::Published
                && r.job.artifact.key.job == s.owner.id
                && r.entries.iter().any(|entry| index_key(*entry) == key)
        }) {
            cache.successor_hits = cache.successor_hits.wrapping_add(1);
            return Some(s.owner.index);
        }
    }
    target(cache, key)
}
unsafe fn cached_current(record: &Record) -> CachedMatch {
    let job = &record.job;
    if !live::generation_current(job.artifact.key) {
        return CachedMatch::Stale;
    }
    let EntryContract::Cpu(entry) = job.artifact.entry
    else {
        return CachedMatch::Stale;
    };
    if !strict_validation() {
        // Notified contract: every code write already retired this owner.
        // Missing translations still take the read-only capture fallback.
        if job.artifact.page_blocks.is_some() && job.artifact.fused_sources.is_empty() {
            // A Tier-0 page function checks each other page's translation
            // when control enters it: only the entry page must translate.
            let page = *gp::instruction_pointer as u32 & !4095;
            return match job.source.mappings.iter().find(|m| m.linear.0 == page) {
                Some(m) if super::snapshot::mapping_cached(m) => CachedMatch::Match,
                _ => CachedMatch::Unavailable,
            };
        }
        return if mappings_current(job) { CachedMatch::Match } else { CachedMatch::Unavailable };
    }
    if MERGED_VALIDATION_ENABLED
        && record
            .validation
            .as_ref()
            .is_some_and(|validation| validation.matches())
    {
        return CachedMatch::Match;
    }
    let _ = entry;
    let first = cached_match(job.artifact.source_linear().unwrap(), &job.source);
    if first != CachedMatch::Match {
        return first;
    }
    for peer in &job.artifact.fused_sources {
        let current = cached_match(peer.entry.linear.0, &peer.source);
        if current != CachedMatch::Match {
            return current;
        }
    }
    CachedMatch::Match
}
/// A host callback can mutate RAM without a dirty notification. Reuse no epoch
/// shortcut here: verify every source and mapping of the still-published owner.
/// Never perform a guest fetch, publish work, or run a second observer.
pub(super) unsafe fn observer_continuation() -> bool {
    let mut cache = CACHE.try_lock().unwrap();
    cache.observer_checks = cache.observer_checks.wrapping_add(1);
    let active = active();
    let valid = active.is_some_and(|owner| {
        cache.records.get(owner.index).is_some_and(|record| {
            record.job.artifact.key.job == owner.id
                && record.phase == Phase::Published
                && cached_current(record) == CachedMatch::Match
        })
    });
    if valid {
        // The observer just performed the same full source/mapping validation
        // used by cold admission. Reuse that certificate until the next host,
        // mapping or code barrier instead of repeating it on a normal exit.
        let index = active.unwrap().index;
        cache.records[index].validated_epoch = admission_epoch();
    }
    if !valid {
        cache.observer_rejections = cache.observer_rejections.wrapping_add(1);
    }
    valid
}
#[inline(always)]
unsafe fn mappings_current(job: &Job) -> bool {
    if !mappings_cached(&job.source) {
        return false;
    }
    for source in &job.artifact.fused_sources {
        if !mappings_cached(&source.source) {
            return false;
        }
    }
    true
}
unsafe fn source_current(linear: u32, source: &super::compile::ImmutableCodeSnapshot) -> bool {
    let current =
        if source.bytes.len() > 4096 && linear & 4095 == 0 && source.bytes.len() % 4096 == 0 {
            // A multi-page Tier-0 source: its pages need not be consecutive.
            let pages: Vec<u32> = source.mappings.iter().map(|m| m.linear.0).collect();
            super::snapshot::capture_page_list(&pages)
        }
        else {
            capture(linear, source.bytes.len())
        };
    current
        .is_ok_and(|current| current.bytes == source.bytes && current.mappings == source.mappings)
}
unsafe fn unchanged_full(job: &Job) -> bool {
    if !live::generation_current(job.artifact.key) {
        return false;
    }
    let EntryContract::Cpu(entry) = job.artifact.entry
    else {
        return false;
    };
    let _ = entry;
    job.artifact
        .source_linear()
        .is_some_and(|linear| source_current(linear, &job.source))
        && job
            .artifact
            .fused_sources
            .iter()
            .all(|s| source_current(s.entry.linear.0, &s.source))
}
/// At most four immutable sources, added one witnessed hot peer at a time.
/// the generated dynamic edge still tests the actual guest target.
pub(super) fn fusion_ready(entry: super::entry::CpuEntryKey) -> bool {
    let cache = CACHE.try_lock().unwrap();
    fusion_indices(&cache, entry).is_some()
}
fn fusion_indices(cache: &Cache, entry: super::entry::CpuEntryKey) -> Option<(usize, usize)> {
    if !cache.fusion_enabled {
        return None;
    }
    let a = *cache.published.get(&index_key(entry))?;
    let root = &cache.records[a];
    // The snapshot starts at the canonical root, not at an arbitrary alias.
    // Alias promotion may compile separately; never reinterpret root bytes at
    // an alias PC while constructing a fused source.
    if root.job.artifact.entry != EntryContract::Cpu(entry)
        || root.job.artifact.source_origin.is_some()
        || root.phase != Phase::Published
        || root.fusion_attempted
    {
        return None;
    }
    let (_, target, hits) = root.hot_exit?;
    // At the source cap, a later witnessed edge can still close the existing
    // trace. Reject only an already installed prediction, not its captured
    // target; otherwise four-source cycles remain permanently open.
    let (observed, _, _) = root.hot_exit?;
    if root
        .job
        .artifact
        .fused_edges
        .iter()
        .any(|edge| edge.from == observed.from && edge.target == observed.target)
    {
        return None;
    }
    if hits < 8
        || entry == target && root.job.artifact.fused_sources.is_empty()
        || entry.cs_base() != target.cs_base()
        || entry.default_32 != target.default_32
    {
        return None;
    }
    // Closing an edge into already captured bytes needs no additional owner or
    // source slot. The target may be an interior instruction, not a published
    // entry. The frontend still verifies the instruction boundary and the
    // generated dynamic edge still checks the actual target.
    if !root.job.artifact.fused_sources.is_empty()
        && (target.pc.0.wrapping_sub(entry.pc.0) < root.job.source.bytes.len() as u32
            || root
                .job
                .artifact
                .fused_sources
                .iter()
                .any(|s| target.pc.0.wrapping_sub(s.entry.pc.0) < s.source.bytes.len() as u32))
    {
        return Some((a, a));
    }
    let b = *cache.published.get(&index_key(target))?;
    let peer = &cache.records[b];
    // The root's witnessed edge is sufficient authority to attempt fusion.
    // A newly published peer need not wait for another eight activations: its
    // unknown successors remain ordinary guarded exits, never guessed links.
    if peer.phase != Phase::Published {
        return None;
    }
    let mut entries = vec![entry];
    entries.extend(root.job.artifact.fused_sources.iter().map(|s| s.entry));
    for candidate in
        std::iter::once(target).chain(peer.job.artifact.fused_sources.iter().map(|s| s.entry))
    {
        if !entries.contains(&candidate) {
            entries.push(candidate);
        }
    }
    if entries.len() > 4 {
        return None;
    }
    Some((a, b))
}
fn refresh_fusion_candidate(cache: &mut Cache, index: usize) {
    let candidate = match cache.records[index].job.artifact.entry {
        EntryContract::Cpu(entry) => {
            fusion_indices(cache, entry).is_some_and(|(root, _)| root == index)
        },
        _ => false,
    };
    cache.records[index].fusion_candidate = candidate;
}
fn refresh_fusion_candidates(cache: &mut Cache) {
    for index in 0..cache.records.len() {
        refresh_fusion_candidate(cache, index);
    }
}
pub(super) unsafe fn take_fusion(
    entry: super::entry::CpuEntryKey,
) -> Option<(
    super::compile::ImmutableCodeSnapshot,
    Vec<CapturedRegion>,
    Vec<PredictedEdge>,
)> {
    let mut cache = CACHE.try_lock().unwrap();
    let (a, b) = fusion_indices(&cache, entry)?;
    cache.records[a].fusion_attempted = true;
    cache.records[a].fusion_candidate = false;
    if !unchanged_full(&cache.records[a].job) || !unchanged_full(&cache.records[b].job) {
        return None;
    }
    let root = &cache.records[a];
    let mut sources = vec![CapturedRegion {
        entry,
        source: root.job.source.clone(),
    }];
    sources.extend(root.job.artifact.fused_sources.clone());
    let mut edges = root.job.artifact.fused_edges.clone();
    let mut visited = vec![a];
    let mut next = Some(b);
    // Close a witnessed chain in one cold compile instead of repeatedly
    // rebuilding A+B, then A+B+C, then A+B+C+D. Count/page/graph budgets and
    // exact dynamic-target guards remain unchanged.
    while let Some(index) = next {
        if visited.contains(&index) {
            break;
        }
        let record = &cache.records[index];
        if record.phase != Phase::Published || !unchanged_full(&record.job) {
            break;
        }
        let EntryContract::Cpu(peer_entry) = record.job.artifact.entry
        else {
            break;
        };
        if peer_entry.cs_base() != entry.cs_base() || peer_entry.default_32 != entry.default_32 {
            break;
        }
        let candidates = std::iter::once(CapturedRegion {
            entry: peer_entry,
            source: record.job.source.clone(),
        })
        .chain(record.job.artifact.fused_sources.iter().cloned());
        let mut additions = Vec::new();
        for candidate in candidates {
            if !sources.iter().any(|s| s.entry == candidate.entry)
                && !additions
                    .iter()
                    .any(|s: &CapturedRegion| s.entry == candidate.entry)
            {
                additions.push(candidate);
            }
        }
        if sources.len() + additions.len() > 4 {
            break;
        }
        sources.extend(additions);
        visited.push(index);
        next = record
            .hot_exit
            .filter(|(_, _, hits)| *hits >= 8)
            .and_then(|(_, target, _)| cache.published.get(&index_key(target)).copied());
    }
    for index in visited {
        let record = &cache.records[index];
        let observed = record.hot_exit.map(|(edge, _, _)| edge);
        for edge in record
            .job
            .artifact
            .fused_edges
            .iter()
            .copied()
            .chain(observed)
        {
            if let Some(old) = edges.iter_mut().find(|e| e.from == edge.from) {
                *old = edge;
            }
            else if edges.len() < 4 {
                edges.push(edge);
            }
        }
    }
    if sources.len() < 2 {
        return None;
    }
    let primary = sources.remove(0).source;
    Some((primary, sources, edges))
}
/// Mirrors Cache::fusion_enabled so activations can skip exit profiling
/// before taking the cache lock.
static mut FUSION_PROFILE: bool = false;
#[no_mangle]
pub unsafe fn ir_cache_set_fusion(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    ir_admission_barrier();
    let mut cache = CACHE.try_lock().unwrap();
    cache.fusion_enabled = enabled != 0;
    FUSION_PROFILE = enabled != 0;
    refresh_fusion_candidates(&mut cache);
    if enabled == 0 {
        for r in &mut cache.records {
            if !r.job.artifact.fused_sources.is_empty() {
                r.phase = Phase::Retired;
            }
        }
        clear_missing_hint();
        cache.needs_collection = true;
        unsafe { COLLECTION_PENDING = true };
    }
    true
}
/// Release only retired owners, outside any guest activation or CACHE lock.
#[no_mangle]
pub unsafe fn ir_cache_collect() -> u32 {
    // The normal activation path has nothing to reclaim. Avoid re-entering the
    // quiescence protocol several times per short region just to discover that.
    if !CACHE.try_lock().unwrap().needs_collection {
        return 0;
    }
    if !cold() {
        return 0;
    }
    let retired = {
        let mut cache = CACHE.try_lock().unwrap();
        if !cache.needs_collection {
            return 0;
        }
        let mut retired = Vec::new();
        // Vec compaction changes indices; never retain a slot-only hint.
        cache.targets.fill(None);
        cache.missing_targets.fill(None);
        cache.records.retain(|r| {
            if r.phase == Phase::Retired {
                retired.push((r.slot, r.job.artifact.key.job));
                false
            }
            else {
                true
            }
        });
        cache.published = cache
            .records
            .iter()
            .enumerate()
            .filter(|(_, record)| record.phase == Phase::Published)
            .flat_map(|(index, record)| {
                record
                    .entries
                    .iter()
                    .map(move |entry| (index_key(*entry), index))
            })
            .collect();
        cache.needs_collection = false;
        unsafe { COLLECTION_PENDING = false };
        if !retired.is_empty() {
            fast_invalidate();
        }
        refresh_fusion_candidates(&mut cache);
        cache.reclaimed = cache.reclaimed.wrapping_add(retired.len() as u32);
        retired
    };
    for &(slot, id) in &retired {
        jit::ir_release_slot(slot, id);
    }
    retired.len() as u32
}
/// Consumes the matching live result. Bytes must already have been copied by JS.
#[no_mangle]
pub unsafe fn ir_cache_reserve(id: u64) -> u32 {
    if !cold() {
        return 0;
    }
    ir_cache_collect();
    if {
        let c = CACHE.try_lock().unwrap();
        c.records.len() >= c.capacity
    } {
        return 0;
    }
    let Some(job) = live::take_for_cache(id)
    else {
        return 0;
    };
    reserve_job(job, false)
}
pub(super) unsafe fn reserve_job(job: Job, automatic: bool) -> u32 {
    reserve_with_promotion(job, automatic, None)
}
pub(super) unsafe fn reserve_with_promotion(
    mut job: Job,
    automatic: bool,
    promotion_parent: Option<Ticket>,
) -> u32 {
    if promotion_parent.is_some_and(|ticket| !promotion_current(ticket)) {
        return 0;
    }
    if !job.artifact.fused_sources.is_empty() && !CACHE.try_lock().unwrap().fusion_enabled {
        return 0;
    }
    if !cold() || !unchanged_full(&job) {
        return 0;
    }
    ir_cache_collect();
    if {
        let c = CACHE.try_lock().unwrap();
        c.records.len() >= c.capacity
    } {
        return 0;
    }
    let id = job.artifact.key.job;
    let pages = job
        .artifact
        .dependencies
        .iter()
        .map(|d| Page::page_of(d.page.0))
        .collect();
    let Some(slot) = jit::ir_reserve_slot(id, pages)
    else {
        return 0;
    };
    job.artifact.key.slot = slot;
    // IDs never repeat in this Wasm instance, including reset. They also identify
    // this reservation generation; a reused slot must have a different owner.
    job.artifact.key.slot_generation = id;
    let validation = if let EntryContract::Cpu(entry) = job.artifact.entry {
        if job.artifact.fused_sources.is_empty() {
            None
        }
        else {
            MergedValidation::build(
                std::iter::once((entry.linear.0, &job.source)).chain(
                    job.artifact
                        .fused_sources
                        .iter()
                        .map(|peer| (peer.entry.linear.0, &peer.source)),
                ),
            )
            .map(Box::new)
        }
    }
    else {
        None
    };
    let mut cache = CACHE.try_lock().unwrap();
    cache.clock = cache.clock.wrapping_add(1);
    let last_used = cache.clock;
    let entries: Vec<_> = job.artifact.cpu_entries().collect();
    let promotion = if cache.resident_promotion && job.artifact.tier == super::compile::Tier::One {
        entries.iter().copied().map(Alias::new).collect()
    }
    else {
        Vec::new()
    };
    cache.records.push(Record {
        entries,
        promotion,
        promotion_parent,
        job,
        validation,
        slot,
        phase: Phase::Pending,
        automatic,
        last_used,
        hits: 0,
        guest_steps: 0,
        max_guest_steps: 0,
        zero_step_exits: 0,
        validated_epoch: 0,
        hot_exit: None,
        fusion_attempted: false,
        fusion_candidate: false,
        successors: Successors::default(),
        page_promoted: false,
        promotion_hits: 0,
    });
    slot
}
/// A published Tier-1 region whose own activations earned Tier-2 promotion
/// (replaces per-activation scheduler heat). One request per publication.
pub(super) fn next_region_promotion(threshold: u32) -> Option<super::entry::CpuEntryKey> {
    let mut cache = CACHE.try_lock().unwrap();
    let record = cache.records.iter_mut().find(|r| {
        r.phase == Phase::Published
            && !r.page_promoted
            && r.job.artifact.source_origin.is_none()
            && r.job.artifact.fused_sources.is_empty()
            && r.job.artifact.tier == super::compile::Tier::One
            && r.promotion_hits >= threshold
    })?;
    record.page_promoted = true;
    match record.job.artifact.entry {
        EntryContract::Cpu(entry) => Some(entry),
        EntryContract::Standalone => None,
    }
}
/// Published Tier-1 region entries inside `span` bytes after `entry`, with
/// their owners' activation counts. Tier-1 promotion is earned from these
/// counts (not scheduler heat), so shared Tier-2 peers are selected from them.
pub(super) fn tier_one_peers(
    entry: super::entry::CpuEntryKey,
    span: usize,
) -> Vec<(super::entry::CpuEntryKey, u32)> {
    let cache = CACHE.try_lock().unwrap();
    let mut peers = vec![];
    for r in cache.records.iter().filter(|r| {
        r.phase == Phase::Published
            && r.job.artifact.source_origin.is_none()
            && r.job.artifact.fused_sources.is_empty()
            && r.job.artifact.tier == super::compile::Tier::One
    }) {
        for &peer in &r.entries {
            let offset = peer.linear.0.wrapping_sub(entry.linear.0);
            if peer.cs_base() == entry.cs_base()
                && peer.default_32 == entry.default_32
                && offset > 0
                && (offset as usize) < span
            {
                peers.push((peer, r.promotion_hits));
            }
        }
    }
    peers
}
/// A published Tier-1 page function whose activations earned a Tier-2 page
/// compilation. Returns its served entries (primary first); marks the owner so
/// one request is made per publication. Bounded by the cache capacity.
pub(super) fn next_page_promotion(threshold: u32) -> Option<Vec<super::entry::CpuEntryKey>> {
    let mut cache = CACHE.try_lock().unwrap();
    let record = cache.records.iter_mut().find(|r| {
        r.phase == Phase::Published
            && !r.page_promoted
            && r.job.artifact.source_origin.is_some()
            && r.job.artifact.tier == super::compile::Tier::One
            && r.promotion_hits >= threshold
    })?;
    record.page_promoted = true;
    Some(record.entries.clone())
}
/// Automatic policy can reclaim only its own published records, at a cold point.
pub(super) fn can_make_room(entry: super::entry::CpuEntryKey) -> bool {
    let cache = CACHE.try_lock().unwrap();
    let replaces = cache
        .published
        .get(&index_key(entry))
        .is_some_and(|&index| cache.records[index].phase == Phase::Published);
    cache.records.len() < cache.capacity + usize::from(replaces)
        || cache.records.iter().any(|r| {
            r.phase == Phase::Retired
                || r.automatic && r.phase == Phase::Published && !r.entries.contains(&entry)
        })
}
pub(super) unsafe fn make_room(entry: super::entry::CpuEntryKey) -> bool {
    if !cold() {
        return false;
    }
    ir_cache_collect();
    let evicted = {
        let mut cache = CACHE.try_lock().unwrap();
        // An upgrade supersedes the current owner of its entry, whose record
        // retires at publication: evicting another live region for it would
        // shrink the working set. The table keeps slots beyond the capacity.
        let replaces = cache
            .published
            .get(&index_key(entry))
            .is_some_and(|&index| cache.records[index].phase == Phase::Published);
        if cache.records.len() < cache.capacity + usize::from(replaces) {
            return true;
        }
        let victim = cache
            .records
            .iter()
            .enumerate()
            .filter(|(_, r)| {
                r.automatic && r.phase == Phase::Published && !r.entries.contains(&entry)
            })
            .min_by_key(|(_, r)| (r.last_used, r.job.artifact.key.job))
            .map(|(index, _)| index);
        if let Some(index) = victim {
            let r = &mut cache.records[index];
            r.phase = Phase::Retired;
            let entries = r.entries.clone();
            cache.evictions = cache.evictions.wrapping_add(1);
            clear_missing_hint();
            cache.needs_collection = true;
            unsafe { COLLECTION_PENDING = true };
            Some(entries)
        }
        else {
            None
        }
    };
    if let Some(entries) = evicted {
        for entry in entries {
            super::schedule::evicted(entry);
        }
    }
    ir_cache_collect();
    {
        let c = CACHE.try_lock().unwrap();
        c.records.len() < c.capacity
    }
}
pub(super) fn tier(entry: super::entry::CpuEntryKey) -> u32 {
    let cache = CACHE.try_lock().unwrap();
    cache
        .published
        .get(&index_key(entry))
        .map(|&index| &cache.records[index])
        .filter(|r| r.phase == Phase::Published)
        .map(|r| {
            if r.job.artifact.tier == super::compile::Tier::One {
                1
            }
            else {
                2
            }
        })
        .unwrap_or(0)
}
/// With cores in workers, the pages this code was compiled from must be
/// published to every other core first (crate::parallel::code): wait a
/// little for their acknowledgements, else the publication fails and the
/// code is compiled again later, when they have.
fn job_published(job: &Job) -> bool {
    jit::wait_pages_published(
        job.artifact
            .dependencies
            .iter()
            .map(|d| Page::page_of(d.page.0)),
        0.5,
    )
}

/// Pending/validated results have not completed the publication transaction.
pub(super) fn completion_state(id: u64) -> u32 {
    match CACHE
        .try_lock()
        .unwrap()
        .records
        .iter()
        .find(|r| r.job.artifact.key.job == id)
        .map(|r| r.phase)
    {
        Some(Phase::Published) => 1,
        Some(Phase::Pending | Phase::Validated) => 2,
        _ => 0,
    }
}
/// Validate immediately before table.set. No guest memory/MMIO writes or callbacks.
/// IP may have moved while the browser compiled; lookup checks the saved entry key.
#[no_mangle]
pub unsafe fn ir_cache_validate(id: u64, slot: u32) -> bool {
    if !cold() {
        return false;
    }
    let mut cache = CACHE.try_lock().unwrap();
    let index = cache
        .records
        .iter()
        .position(|r| r.job.artifact.key.job == id && r.slot == slot);
    let valid = if let Some(index) = index {
        let parent_current = cache.records[index]
            .promotion_parent
            .is_none_or(|ticket| promotion_index(&cache, ticket).is_some());
        let r = &mut cache.records[index];
        // (other cores' translations mark the pages before the bytes are checked)
        if r.phase == Phase::Pending
            && parent_current
            && job_published(&r.job)
            && unchanged_full(&r.job)
        {
            r.phase = Phase::Validated;
            true
        }
        else {
            if r.phase == Phase::Pending {
                r.phase = Phase::Retired;
            }
            false
        }
    }
    else {
        false
    };
    if !valid {
        clear_missing_hint();
        cache.needs_collection = true;
        unsafe { COLLECTION_PENDING = true };
        cache.rejected = cache.rejected.wrapping_add(1);
    }
    valid
}
#[no_mangle]
pub unsafe fn ir_cache_finish(id: u64, slot: u32) -> bool {
    if !cold() {
        return false;
    }
    let mut cache = CACHE.try_lock().unwrap();
    let Some(index) = cache
        .records
        .iter()
        .position(|r| r.job.artifact.key.job == id && r.slot == slot)
    else {
        return false;
    };
    if cache.records[index].phase != Phase::Validated {
        return false;
    }
    T0_SLOTS[slot as usize] = cache.records[index].job.artifact.page_blocks.is_some();
    if !unchanged_full(&cache.records[index].job)
        || cache.records[index]
            .promotion_parent
            .is_some_and(|ticket| promotion_index(&cache, ticket).is_none())
    {
        cache.records[index].phase = Phase::Retired;
        clear_missing_hint();
        cache.needs_collection = true;
        unsafe { COLLECTION_PENDING = true };
        return false;
    }
    let entries = cache.records[index].entries.clone();
    // A page function has up to 256 entries: look them up, not scan them.
    let keys: std::collections::HashSet<EntryIndexKey> =
        entries.iter().map(|e| index_key(*e)).collect();
    let mut superseded = false;
    for (i, record) in cache.records.iter_mut().enumerate() {
        if i != index && record.phase == Phase::Published {
            let before = record.entries.len();
            record
                .entries
                .retain(|entry| !keys.contains(&index_key(*entry)));
            superseded |= record.entries.len() != before;
            record
                .promotion
                .retain(|alias| !keys.contains(&index_key(alias.entry)));
            if record.entries.is_empty() {
                record.phase = Phase::Retired;
            }
        }
    }
    cache.records[index].phase = Phase::Published;
    unsafe {
        MISSING_ENTRIES = [None; ENTRY_HINT_CAPACITY];
    }
    // A new owner is visible through its own keys only (cleared below);
    // other owners' witnesses stay valid unless this one took their keys.
    if superseded {
        fast_invalidate();
        cache.needs_collection = true;
        unsafe { COLLECTION_PENDING = true };
    }
    for entry in &entries {
        cache.published.insert(index_key(*entry), index);
        fast_clear_key(*entry);
    }
    page_fill(&cache, index);
    refresh_fusion_candidates(&mut cache);
    // Cached predecessor hints must not retain authority over superseded aliases.
    cache.targets.fill(None);
    cache.missing_targets.fill(None);
    if entries.len() > 1 {
        cache.shared_publications = cache.shared_publications.wrapping_add(1);
    }
    let structured = cache.records[index].job.artifact.code.structured_cfg;
    if !cache.records[index].job.artifact.fused_sources.is_empty() {
        cache.fused_publications = cache.fused_publications.wrapping_add(1);
    }
    let backedges = cache.records[index].job.artifact.code.structured_backedges;
    let structured_edges = cache.records[index].job.artifact.code.structured_edges;
    let dispatch_edges = cache.records[index]
        .job
        .artifact
        .code
        .generic_dispatch_edges;
    if structured {
        cache.structured_publications = cache.structured_publications.wrapping_add(1);
        cache.structured_backedges = cache.structured_backedges.wrapping_add(backedges);
        cache.structured_edges = cache.structured_edges.wrapping_add(structured_edges);
    }
    else {
        cache.generic_publications = cache.generic_publications.wrapping_add(1);
        cache.generic_dispatch_edges = cache.generic_dispatch_edges.wrapping_add(dispatch_edges);
    }
    true
}
#[no_mangle]
pub unsafe fn ir_cache_cancel(id: u64, slot: u32) -> bool {
    let mut cache = CACHE.try_lock().unwrap();
    let Some(r) = cache
        .records
        .iter_mut()
        .find(|r| r.job.artifact.key.job == id && r.slot == slot && r.phase != Phase::Retired)
    else {
        return false;
    };
    r.phase = Phase::Retired;
    clear_missing_hint();
    cache.needs_collection = true;
    unsafe { COLLECTION_PENDING = true };
    cache.failed = cache.failed.wrapping_add(1);
    true
}
#[no_mangle]
pub fn ir_cache_stat(field: u32) -> u32 {
    let cache = CACHE.try_lock().unwrap();
    match field {
        0 => cache
            .records
            .iter()
            .filter(|r| r.phase == Phase::Published)
            .count() as u32,
        1 => cache.records.len() as u32,
        2 => cache.hits,
        3 => cache.rejected,
        4 => cache.failed,
        5 => cache.reclaimed,
        6 => cache.links,
        7 => cache.link_misses,
        8 => cache.cached_checks,
        9 => cache.capture_fallbacks,
        10 => cache.guest_steps,
        11 => cache.max_guest_steps,
        12 => cache.zero_step_exits,
        13 => cache.structured_publications,
        14 => cache.generic_publications,
        15 => cache.structured_backedges,
        16 => cache.generic_dispatch_edges,
        17 => cache.structured_edges,
        18 => cache.fast_checks,
        19 => cache.full_checks,
        20 => cache.post_fetch_reuses,
        21 => cache.target_hits,
        22 => u32::from(cache.fast_validation),
        23 => cache.fused_publications,
        24 => cache.fused_hits,
        25 => cache.fused_steps,
        26 => u32::from(cache.fusion_enabled),
        27 => cache.evictions,
        28 => cache.negative_hits,
        29 => cache.successor_hits,
        30 => cache
            .records
            .iter()
            .filter(|r| r.phase == Phase::Published)
            .map(|r| r.entries.len() as u32)
            .sum(),
        31 => cache.shared_publications,
        32 => cache.observer_checks,
        33 => cache.observer_rejections,
        34 => cache.warm_admissions,
        35 => cache.warm_handoffs,
        36 => u32::from(cache.warm_chaining),
        37 => unsafe { MISSING_HINT_HITS },
        38 => unsafe { u32::from(MISSING_HINT_ENABLED) },
        39 => cache.poll_barriers_avoided,
        40 => unsafe { u32::from(POLL_REUSE_ENABLED) },
        41 => u32::from(cache.resident_promotion),
        42..=45 => cache.promotion_stats[(field - 42) as usize],
        46 => unsafe { FAST_HITS },
        47 => unsafe { FAST_CHAINS },
        48 => u32::from(strict_validation()),
        _ => 0,
    }
}

#[no_mangle]
pub fn ir_cache_entry_stat(linear: u32, cs_base: u32, default_32: u32, field: u32) -> u32 {
    let cache = CACHE.try_lock().unwrap();
    let Some(record) = cache.records.iter().find(|record| {
        if record.phase != Phase::Published {
            return false;
        }
        record.entries.iter().any(|entry| {
            entry.linear.0 == linear
                && entry.cs_base() == cs_base
                && u32::from(entry.default_32) == default_32
        })
    })
    else {
        return 0;
    };
    match field {
        0 => 1,
        1 => record.hits,
        2 => record.guest_steps,
        3 => record.max_guest_steps,
        4 => record.zero_step_exits,
        5 => {
            if record.job.artifact.tier == super::compile::Tier::One {
                1
            }
            else {
                2
            }
        },
        6 => u32::from(record.job.artifact.code.structured_cfg),
        7 => record.job.artifact.code.structured_backedges,
        8 => record.job.artifact.code.generic_dispatch_edges,
        9 => record.job.artifact.code.structured_edges,
        10 => 1 + record.job.artifact.fused_sources.len() as u32,
        11 => record.entries.len() as u32,
        12 => record.slot,
        13 => record.job.artifact.code.budget_batch_blocks,
        14 => record
            .validation
            .as_ref()
            .map_or(0, |validation| validation.saved_bytes),
        15..=17 => record
            .promotion
            .iter()
            .find(|a| {
                a.entry.linear.0 == linear
                    && a.entry.cs_base() == cs_base
                    && u32::from(a.entry.default_32) == default_32
            })
            .map_or(0, |a| match field {
                15 => a.hits,
                16 => u32::from(a.failed.is_some()),
                _ => u32::from(cache.promotion_enabled && a.hits >= cache.promotion_threshold),
            }),
        18 => record.job.artifact.key.job as u32,
        19 => (record.job.artifact.key.job >> 32) as u32,
        _ => 0,
    }
}

/// Cold lookup used by a compiled-exit/link bridge. The returned slot is only a
/// hint: the callee still performs its normal entry/generation/mapping admission
/// before execution. This never publishes, compiles or holds a cache lock across
/// guest activation.
pub unsafe fn link_target() -> Option<(u32, u64)> {
    // This is a cold graph lookup, not a guest activation. Unlike execute(),
    // requiring JIT_STATE try_lock here would race the immediately following
    // dependency query with our own short-lived cache inspection and makes the
    // diagnostic/link API spuriously miss. All mutation/publication still uses
    // the normal quiescent protocols.
    if busy() {
        return None;
    }
    let entry = live::entry();
    let candidate = {
        let cache = CACHE.try_lock().unwrap();
        cache
            .records
            .iter()
            .find(|r| r.phase == Phase::Published && r.entries.contains(&entry))
            .map(|r| {
                (
                    r.job.artifact.key.job,
                    r.job.artifact.key,
                    r.job.artifact.entry,
                    (r.job.artifact.source_linear(), r.job.source.clone()),
                    r.job.artifact.fused_sources.clone(),
                )
            })
    };
    let Some((id, key, EntryContract::Cpu(canonical), source, peers)) = candidate
    else {
        let mut cache = CACHE.try_lock().unwrap();
        cache.link_misses = cache.link_misses.wrapping_add(1);
        return None;
    };
    let _ = canonical;
    let valid = live::generation_current(key)
        && source
            .0
            .is_some_and(|linear| source_current(linear, &source.1))
        && peers
            .iter()
            .all(|s| source_current(s.entry.linear.0, &s.source));
    let mut cache = CACHE.try_lock().unwrap();
    let Some(index) = cache
        .records
        .iter()
        .position(|r| r.job.artifact.key.job == id && r.phase == Phase::Published)
    else {
        cache.link_misses = cache.link_misses.wrapping_add(1);
        return None;
    };
    if !valid {
        cache.records[index].phase = Phase::Retired;
        clear_missing_hint();
        cache.needs_collection = true;
        unsafe { COLLECTION_PENDING = true };
        cache.link_misses = cache.link_misses.wrapping_add(1);
        return None;
    }
    cache.clock = cache.clock.wrapping_add(1);
    let stamp = cache.clock;
    cache.records[index].last_used = stamp;
    cache.links = cache.links.wrapping_add(1);
    Some((cache.records[index].slot, id))
}

#[no_mangle]
pub unsafe fn ir_cache_link_target() -> u64 {
    let Some((slot, id)) = link_target()
    else {
        return 0;
    };
    // Slot zero is never allocated. Pack slot and a truncated owner witness for
    // diagnostics; execution must still use normal cache admission, never this
    // value as an unchecked call target.
    ((id as u32 as u64) << 32) | slot as u64
}

/// Called by the CPU loop before it interprets.
/// No request means no IR entry; compilation policy/tier promotion remain separate.
#[inline(always)]
pub unsafe fn execute() -> bool {
    let executed = execute_any();
    // A device access of a page function made an interrupt deliverable
    // (tier0::held): the activation stopped linking and left at this
    // instruction boundary, where it is delivered (which, as an interpreted
    // instruction, reads descriptor tables and writes the stack).
    if crate::cpu::execution::deliver_held_irqs() {
        ir_admission_barrier();
    }
    executed
}
unsafe fn execute_any() -> bool {
    if diag::enabled() {
        return execute_mode::<true>();
    }
    if super::schedule::tier0() && t0_execute() {
        return true;
    }
    if !strict_validation() {
        match fast_probe() {
            Probe::Absent => {
                super::entry::take_link_request();
                MISSING_HINT_HITS = MISSING_HINT_HITS.wrapping_add(1);
                return false;
            },
            Probe::Hit(witness) => {
                if fast_execute(witness) {
                    return true;
                }
            },
            Probe::Unknown => {},
        }
    }
    if MISSING_HINT_ENABLED {
        let entry = live::entry();
        if MISSING_ENTRIES[missing_hint_slot(entry)] == Some(entry) {
            super::entry::take_link_request();
            MISSING_HINT_HITS = MISSING_HINT_HITS.wrapping_add(1);
            return false;
        }
    }
    execute_mode::<false>()
}
unsafe fn execute_mode<const PROFILE: bool>() -> bool {
    use super::entry::take_link_request;
    take_link_request();
    let control = *gp::flags & (cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM);
    let mut activation = match admit_one::<PROFILE>(false, None) {
        AdmissionResult::Ready(activation) => activation,
        AdmissionResult::Miss => return false,
        AdmissionResult::Fault => return true,
    };
    // One cold admission starts a bounded execution interval. Ordinary warm
    // successors can hand off under the finishing activation's cache guard;
    // no Rust reference/guard survives a generated-code call. This is still a
    // CPU-state ABI, not cross-module SSA retention or unchecked table chaining.
    for index in 0..=64 {
        let previous = activation.owner;
        if let Some(next) = run_activation::<PROFILE>(activation, control, index < 64) {
            activation = next;
            continue;
        }
        if index == 64 {
            if PROFILE {
                diag::chain(5);
            }
            break;
        }
        let stop = if !take_link_request() {
            Some(0)
        }
        else if !cpu::ir_link_budget_available() {
            Some(1)
        }
        else if *gp::in_hlt {
            Some(2)
        }
        else if *gp::flags & (cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM) != control {
            Some(3)
        }
        else {
            None
        };
        if let Some(reason) = stop {
            if PROFILE {
                diag::chain(reason);
            }
            break;
        }
        match admit_one::<PROFILE>(true, Some(previous)) {
            AdmissionResult::Ready(next) => activation = next,
            AdmissionResult::Miss => {
                if PROFILE {
                    diag::chain(4);
                }
                break;
            },
            AdmissionResult::Fault => break,
        }
    }
    take_link_request();
    true
}
/// Notified-contract dispatch of witnessed entries, including their bounded
/// chain. Returns false when no witness applies; the complete admission then
/// decides (and refills the witness after a successful admission). Timing and
/// recording imports are observers and keep the complete path.
#[inline(always)]
unsafe fn fast_execute(mut witness: FastEntry) -> bool {
    if strict_validation() || profiler::performance_recording_enabled() {
        return false;
    }
    if !jit::ir_cache_quiescent() {
        return false;
    }
    {
        let cache = CACHE.try_lock().unwrap();
        if active().is_some() || cache.needs_collection {
            return false;
        }
    }
    use super::entry::take_link_request;
    take_link_request();
    let control = *gp::flags & (cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM);
    let mut linked = false;
    for index in 0..=64 {
        // A retirement during the activation (e.g. a zero-step exit, which
        // still requests a link) leaves witnesses of retired owners until
        // collection; the chain must not enter one.
        let current = fast_run(witness, linked);
        if index == 64
            || !current
            || !take_link_request()
            || !cpu::ir_link_budget_available()
            || *gp::in_hlt
            || *gp::flags & (cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM) != control
        {
            break;
        }
        // Tier-0 page functions chain among themselves in t0_execute, without
        // this loop's per-activation accounting.
        if super::schedule::tier0() && t0_execute() {
            break;
        }
        match fast_probe() {
            Probe::Hit(next) => {
                witness = next;
                linked = true;
                FAST_CHAINS = FAST_CHAINS.wrapping_add(1);
            },
            Probe::Absent => break,
            Probe::Unknown => {
                // No current witness: the complete admission and its own
                // bounded chain decide, under the same CPU link budget.
                collect_if_needed();
                execute_mode::<false>();
                break;
            },
        }
    }
    take_link_request();
    collect_if_needed();
    true
}
/// One witnessed activation. Mirrors run_activation's accounting, retirement
/// and fusion profiling without the complete admission or warm handoff.
/// Returns false once any owner awaits collection: no witness may then chain.
#[inline(always)]
unsafe fn fast_run(witness: FastEntry, linked: bool) -> bool {
    // Every source translation is CPU-visible: this fetch reads only the TLB.
    *gp::previous_ip = *gp::instruction_pointer;
    cpu::get_phys_eip().expect("witnessed IR fetch must hit the CPU TLB");
    let entry = super::entry::CpuEntryKey {
        pc: GuestEip(witness.linear.wrapping_sub(witness.cs_base)),
        linear: crate::ir::frontend::decode::LinearAddress(witness.linear),
        default_32: witness.default_32,
    };
    let index = witness.index as usize;
    ACTIVE = Some(Owner {
        index,
        id: witness.id,
    });
    FAST_HITS = FAST_HITS.wrapping_add(1);
    let before = *gp::instruction_counter;
    super::entry::take_link_request();
    call_linkable(witness.slot);
    ACTIVE = None;
    let poll_reuse = POLL_REUSE_ENABLED && super::entry::poll_exit();
    if !super::entry::link_requested() && !poll_reuse {
        ir_admission_barrier();
    }
    let steps = (*gp::instruction_counter).wrapping_sub(before);
    let observed_exit = if FUSION_PROFILE && steps != 0 && super::entry::profile_link_requested() {
        let target = live::entry();
        Some((
            PredictedEdge {
                from: GuestEip((*gp::previous_ip as u32).wrapping_sub(witness.cs_base)),
                target: target.pc,
            },
            target,
        ))
    }
    else {
        None
    };
    let mut cache = CACHE.try_lock().unwrap();
    cache.clock = cache.clock.wrapping_add(1);
    let stamp = cache.clock;
    cache.hits = cache.hits.wrapping_add(1);
    if linked {
        cache.links = cache.links.wrapping_add(1);
    }
    if poll_reuse {
        cache.poll_barriers_avoided = cache.poll_barriers_avoided.wrapping_add(1);
    }
    cache.guest_steps = cache.guest_steps.wrapping_add(steps);
    cache.max_guest_steps = cache.max_guest_steps.max(steps);
    if steps == 0 {
        cache.zero_step_exits = cache.zero_step_exits.wrapping_add(1);
    }
    let fused = cache.records.get(index).is_some_and(|r| {
        r.job.artifact.key.job == witness.id && !r.job.artifact.fused_sources.is_empty()
    });
    let mut needs_heat = false;
    if fused {
        cache.fused_hits = cache.fused_hits.wrapping_add(1);
        cache.fused_steps = cache.fused_steps.wrapping_add(steps);
    }
    let profile = cache.fusion_enabled;
    let mut refresh_fusion = false;
    if let Some(record) = cache
        .records
        .get_mut(index)
        .filter(|record| record.job.artifact.key.job == witness.id)
    {
        record.last_used = stamp;
        record.hits = record.hits.wrapping_add(1);
        record.promotion_hits = record.promotion_hits.saturating_add(1);
        record.guest_steps = record.guest_steps.wrapping_add(steps);
        record.max_guest_steps = record.max_guest_steps.max(steps);
        // Tier-1 regions are promoted from their own activation count; only a
        // Tier-2 fusion candidate still earns scheduler heat.
        needs_heat = !witness.tier_one && witness.primary && record.fusion_candidate;
        if let Some((edge, target)) = observed_exit.filter(|_| profile) {
            let was_hot = record.hot_exit.is_some_and(|(_, _, hits)| hits >= 8);
            match &mut record.hot_exit {
                Some((old, old_target, hits)) if old.from == edge.from && *old_target == target => {
                    *hits = hits.saturating_add(1)
                },
                Some((_, _, hits)) if *hits > 1 => *hits -= 1,
                _ => record.hot_exit = Some((edge, target, 1)),
            }
            refresh_fusion = was_hot != record.hot_exit.is_some_and(|(_, _, hits)| hits >= 8);
        }
        if steps == 0 {
            // Zero-budget REP and other no-retirement exits must not trap
            // scheduling in a repeatedly admitted entry.
            record.zero_step_exits = record.zero_step_exits.wrapping_add(1);
            record.phase = Phase::Retired;
        }
    }
    if refresh_fusion {
        refresh_fusion_candidate(&mut cache, index);
    }
    if steps == 0 {
        clear_missing_hint();
        cache.needs_collection = true;
        unsafe { COLLECTION_PENDING = true };
    }
    let current = !cache.needs_collection;
    drop(cache);
    if needs_heat || linked {
        super::schedule::note_cached(entry, linked, needs_heat);
    }
    current
}
/// Collection is almost always unnecessary on an ordinary control-flow edge.
/// Inline only that decision; leave compaction, alias reconstruction and table
/// reclamation in the existing cold collector, with all its quiescence checks.
#[inline(always)]
unsafe fn collect_if_needed() {
    let needed = CACHE.try_lock().unwrap().needs_collection;
    if needed {
        ir_cache_collect();
    }
}
/// A published owner admitted under a single cache guard. No guard/reference
/// survives the subsequent generated-code call.
struct Activation {
    entry: super::entry::CpuEntryKey,
    linked: bool,
    slot: u32,
    owner: Owner,
    needs_heat: bool,
}
enum AdmissionResult {
    Ready(Activation),
    Miss,
    Fault,
}
enum Selected {
    Ready(Activation),
    Fetch {
        slot: u32,
        owner: Owner,
        warm: bool,
        epoch: u64,
    },
}
#[inline(always)]
fn activate<const PROFILE: bool>(
    cache: &mut Cache,
    index: usize,
    entry: super::entry::CpuEntryKey,
    previous: Option<Owner>,
    linked: bool,
) -> Activation {
    if PROFILE {
        diag::admission(Admission::Accepted);
    }
    cache.clock = cache.clock.wrapping_add(1);
    let stamp = cache.clock;
    let record = &mut cache.records[index];
    record.last_used = stamp;
    let owner = Owner {
        index,
        id: record.job.artifact.key.job,
    };
    let tier_one = record.job.artifact.tier == super::compile::Tier::One;
    let resident = cache.resident_promotion && tier_one;
    if resident && cache.promotion_enabled {
        if let Some(alias) = record.promotion.iter_mut().find(|a| a.entry == entry) {
            alias.visit();
            cache.promotion_stats[2] = cache.promotion_stats[2].wrapping_add(1);
        }
    }
    // Tier-1 regions and pages are promoted from record.hits; only a Tier-2
    // fusion candidate's primary entry still earns scheduler heat.
    let needs_heat = !tier_one
        && record.fusion_candidate
        && record.job.artifact.entry == EntryContract::Cpu(entry);
    let slot = record.slot;
    if !PROFILE {
        fast_fill(cache, index, entry);
        page_fill(cache, index);
    }
    unsafe {
        ACTIVE = Some(owner);
    }
    cache.hits = cache.hits.wrapping_add(1);
    if linked {
        cache.links = cache.links.wrapping_add(1);
    }
    if let Some(p) = previous {
        if let Some(r) = cache
            .records
            .get_mut(p.index)
            .filter(|r| r.phase == Phase::Published && r.job.artifact.key.job == p.id)
        {
            r.successors.remember(Successor {
                key: index_key(entry),
                owner,
            });
        }
    }
    Activation {
        entry,
        linked,
        slot,
        owner,
        needs_heat,
    }
}
// Keep the Activation return in SSA instead of materializing an aggregate
// return slot on each budget-ended admission. No guards are removed.
#[inline(always)]
unsafe fn admit_one<const PROFILE: bool>(linked: bool, previous: Option<Owner>) -> AdmissionResult {
    let admission_scope = PROFILE.then(|| Scope::new(Stage::Admission));
    if PROFILE {
        diag::admission(Admission::Attempt);
    }
    if !cold() {
        if PROFILE {
            diag::admission(Admission::Busy);
        }
        return AdmissionResult::Miss;
    }
    collect_if_needed();
    let entry = live::entry();
    let selected = {
        let mut cache = CACHE.try_lock().unwrap();
        let mut selected = None;
        let index = successor_target(&mut cache, index_key(entry), previous);
        if index.is_none() {
            if !PROFILE && MISSING_HINT_ENABLED && !cache.needs_collection {
                MISSING_ENTRIES[missing_hint_slot(entry)] = Some(entry);
            }
            if !PROFILE && !cache.needs_collection {
                fast_fill_negative(entry);
            }
            if PROFILE {
                diag::admission(Admission::Missing);
                super::schedule::diagnose_missing(entry);
            }
        }
        let index = index.filter(|_| {
            let valid = ir_entry_matches(entry.linear.0, entry.cs_base(), entry.default_32 as u32);
            if !valid {
                if PROFILE {
                    diag::admission(Admission::Context);
                }
            }
            valid
        });
        if let Some(index) = index {
            let epoch = admission_epoch();
            let reuse = cache.fast_validation
                && epoch != u64::MAX
                && cache.records[index].validated_epoch == epoch
                && live::generation_current(cache.records[index].job.artifact.key)
                && mappings_current(&cache.records[index].job);
            let cached = if reuse {
                cache.fast_checks = cache.fast_checks.wrapping_add(1);
                CachedMatch::Match
            }
            else {
                cache.full_checks = cache.full_checks.wrapping_add(1);
                let _scope = PROFILE.then(|| Scope::new(Stage::ByteValidation));
                cached_current(&cache.records[index])
            };
            let valid = match cached {
                CachedMatch::Match => {
                    cache.cached_checks = cache.cached_checks.wrapping_add(1);
                    true
                },
                CachedMatch::Unavailable => {
                    cache.capture_fallbacks = cache.capture_fallbacks.wrapping_add(1);
                    if PROFILE {
                        diag::admission(Admission::Capture);
                    }
                    let _scope = PROFILE.then(|| Scope::new(Stage::SourceCapture));
                    unchanged_full(&cache.records[index].job)
                },
                CachedMatch::Stale => false,
            };
            if !valid {
                if PROFILE {
                    diag::admission(Admission::StaleBefore);
                }
                cache.records[index].phase = Phase::Retired;
                clear_missing_hint();
                cache.needs_collection = true;
                unsafe { COLLECTION_PENDING = true };
            }
            else {
                let warm =
                    cache.fast_validation && cached == CachedMatch::Match && epoch != u64::MAX;
                selected = Some(if !PROFILE && warm {
                    // All source translations (including this actual alias PC)
                    // have just passed mappings_cached. Thus get_phys_eip can
                    // only read the instruction cache/TLB: no page walk, A-bit
                    // write, fault delivery or host callback can occur here.
                    // Keep real fetch semantics, but avoid dropping/reacquiring
                    // the cache and rediscovering the same owner afterwards.
                    // Instrumented fetches stay on the reference path below:
                    // their timing imports are host observations, not TLB reads.
                    *gp::previous_ip = *gp::instruction_pointer;
                    cpu::get_phys_eip().expect("validated IR fetch must hit the CPU TLB");
                    cache.post_fetch_reuses = cache.post_fetch_reuses.wrapping_add(1);
                    cache.cached_checks = cache.cached_checks.wrapping_add(1);
                    cache.records[index].validated_epoch = epoch;
                    cache.warm_admissions = cache.warm_admissions.wrapping_add(1);
                    Selected::Ready(activate::<PROFILE>(
                        &mut cache, index, entry, previous, linked,
                    ))
                }
                else {
                    Selected::Fetch {
                        slot: cache.records[index].slot,
                        owner: Owner {
                            index,
                            id: cache.records[index].job.artifact.key.job,
                        },
                        warm,
                        epoch,
                    }
                });
            }
        }
        selected
    };
    let Some(selected) = selected
    else {
        collect_if_needed();
        return AdmissionResult::Miss;
    };
    let activation = match selected {
        Selected::Ready(activation) => activation,
        Selected::Fetch {
            slot,
            owner: Owner {
                index: selected_index,
                id,
            },
            warm: warm_fetch,
            epoch,
        } => {
            // Preserve the dispatcher's actual initial fetch translation and A-bit
            // updates. A cached fast check above is sufficient only when every source
            // mapping is already CPU-visible; otherwise the read-only capture fallback
            // validates without creating A-bit side effects.
            *gp::previous_ip = *gp::instruction_pointer;
            let fetch = {
                let _scope = PROFILE.then(|| Scope::new(Stage::Fetch));
                cpu::get_phys_eip()
            };
            if fetch.is_err() {
                if PROFILE {
                    diag::admission(Admission::FetchFault);
                }
                ir_admission_barrier();
                return AdmissionResult::Fault;
            }
            let admitted = {
                let mut cache = CACHE.try_lock().unwrap();
                let index = cache
                    .records
                    .get(selected_index)
                    .filter(|r| r.job.artifact.key.job == id && r.phase == Phase::Published)
                    .map(|_| selected_index);
                let valid = if let Some(index) = index {
                    // Page tables can themselves alias code: the A-bit update must not
                    // leave a module compiled from the pre-fetch bytes admissible. After
                    // the architectural fetch, admission requires cached mapping identity;
                    // an unavailable secondary mapping remains published for a later hit.
                    let current = if warm_fetch && epoch == admission_epoch() && epoch != u64::MAX {
                        // All translations were already visible: get_phys_eip cannot
                        // walk page tables, write A bits or invoke a device callback.
                        cache.post_fetch_reuses = cache.post_fetch_reuses.wrapping_add(1);
                        CachedMatch::Match
                    }
                    else {
                        cache.full_checks = cache.full_checks.wrapping_add(1);
                        let _scope = PROFILE.then(|| Scope::new(Stage::ByteValidation));
                        cached_current(&cache.records[index])
                    };
                    match current {
                        CachedMatch::Match => {
                            cache.cached_checks = cache.cached_checks.wrapping_add(1);
                            cache.records[index].validated_epoch = admission_epoch();
                            true
                        },
                        CachedMatch::Unavailable => {
                            if PROFILE {
                                diag::admission(Admission::UnavailableAfter);
                            }
                            false
                        },
                        CachedMatch::Stale => {
                            if PROFILE {
                                diag::admission(Admission::StaleAfter);
                            }
                            cache.records[index].phase = Phase::Retired;
                            clear_missing_hint();
                            cache.needs_collection = true;
                            unsafe { COLLECTION_PENDING = true };
                            false
                        },
                    }
                }
                else {
                    if PROFILE {
                        diag::admission(Admission::LostOwner);
                    }
                    false
                };
                if valid {
                    Some(activate::<PROFILE>(
                        &mut cache,
                        index.unwrap(),
                        entry,
                        previous,
                        linked,
                    ))
                }
                else {
                    None
                }
            };
            let Some(activation) = admitted
            else {
                collect_if_needed();
                return AdmissionResult::Miss;
            };
            debug_assert_eq!(activation.slot, slot);
            activation
        },
    };
    drop(admission_scope);
    AdmissionResult::Ready(activation)
}

/// Resolve the exact successor while the finishing activation already owns the
/// cache guard. A saved index is a hint, not authority: validate both owners,
/// the live alias, entry context, generation and ALL current TLB mappings. An
/// expired byte certificate can be refreshed by the same complete comparison
/// used by cold admission; it does not require another dispatch/lock round trip.
/// Missing translations and stale sources retain the full admission fallback.
/// The actual fetch still runs after the mapping proof and cannot invoke the
/// host or walk page tables while the cache guard is held.
#[inline(always)]
unsafe fn warm_handoff(cache: &mut Cache, previous: Owner) -> Option<Activation> {
    if !cache.warm_chaining
        || !cache.fast_validation
        || cache.needs_collection
        || active().is_some()
    {
        return None;
    }
    let epoch = admission_epoch();
    if epoch == u64::MAX {
        return None;
    }
    let entry = live::entry();
    let predecessor = cache.records.get(previous.index)?;
    if predecessor.phase != Phase::Published || predecessor.job.artifact.key.job != previous.id {
        return None;
    }
    if !ir_entry_matches(entry.linear.0, entry.cs_base(), entry.default_32 as u32) {
        return None;
    }
    let index = successor_target(cache, index_key(entry), Some(previous))?;
    let target = &cache.records[index];
    let reuse = target.validated_epoch == epoch
        && live::generation_current(target.job.artifact.key)
        && mappings_current(&target.job);
    if reuse {
        cache.fast_checks = cache.fast_checks.wrapping_add(1);
    }
    else {
        cache.full_checks = cache.full_checks.wrapping_add(1);
        if cached_current(target) != CachedMatch::Match {
            return None;
        }
        cache.records[index].validated_epoch = epoch;
    }
    *gp::previous_ip = *gp::instruction_pointer;
    cpu::get_phys_eip().expect("certified IR handoff must hit the CPU TLB");
    cache.cached_checks = cache.cached_checks.wrapping_add(2);
    cache.post_fetch_reuses = cache.post_fetch_reuses.wrapping_add(1);
    cache.warm_admissions = cache.warm_admissions.wrapping_add(1);
    cache.warm_handoffs = cache.warm_handoffs.wrapping_add(1);
    Some(activate::<false>(cache, index, entry, Some(previous), true))
}

#[inline(always)]
unsafe fn run_activation<const PROFILE: bool>(
    activation: Activation,
    control: i32,
    allow_handoff: bool,
) -> Option<Activation> {
    let Activation {
        entry,
        linked,
        slot,
        owner: current,
        needs_heat,
    } = activation;
    let Owner {
        index: admitted_index,
        id,
    } = current;
    let before = *gp::instruction_counter;
    let diagnostic_cr3 = if PROFILE { diag::cr3() } else { 0 };
    super::entry::take_link_request();
    super::schedule::note_cached(entry, linked, needs_heat);
    let sample = if profiler::performance_recording_enabled() {
        Some(profiler::performance_chunk_start(
            true,
            *gp::instruction_pointer as u32,
            *gp::cr.add(3) as u32,
            *gp::cpl,
        ))
    }
    else {
        None
    };
    if PROFILE {
        diag::activation_start();
    }
    let execution_scope = PROFILE.then(|| Scope::new(Stage::Generated));
    if PROFILE {
        call_slot(slot);
    }
    else {
        call_linkable(slot);
    }
    let duration = execution_scope.and_then(Scope::finish);
    // Terminal helpers/fault delivery can observe the host even when they do
    // not pass through an emitted continuing-call barrier. A plain recovered
    // poll cannot: keep its existing certificate (never refresh it) until the
    // next actual host/interpreter/batch/mapping/code barrier. Profiling imports
    // are observations and deliberately keep the conservative path.
    let poll_reuse =
        !PROFILE && sample.is_none() && POLL_REUSE_ENABLED && super::entry::poll_exit();
    if !super::entry::link_requested() && !poll_reuse {
        ir_admission_barrier();
    }
    let steps = (*gp::instruction_counter).wrapping_sub(before);
    let observed_exit = if FUSION_PROFILE && steps != 0 && super::entry::profile_link_requested() {
        let target = live::entry();
        Some((
            PredictedEdge {
                from: GuestEip((*gp::previous_ip as u32).wrapping_sub(entry.cs_base())),
                target: target.pc,
            },
            target,
        ))
    }
    else {
        None
    };
    if let Some(sample) = sample {
        profiler::performance_chunk_finish(sample, steps);
        profiler::performance_recording_add(1, steps as u64);
    }
    let next = {
        let mut cache = CACHE.try_lock().unwrap();
        ACTIVE = None;
        if poll_reuse {
            cache.poll_barriers_avoided = cache.poll_barriers_avoided.wrapping_add(1);
        }
        cache.guest_steps = cache.guest_steps.wrapping_add(steps);
        cache.max_guest_steps = cache.max_guest_steps.max(steps);
        if steps == 0 {
            cache.zero_step_exits = cache.zero_step_exits.wrapping_add(1);
        }
        let profile = cache.fusion_enabled;
        let mut refresh_fusion = false;
        let fused = cache.records.get(admitted_index).is_some_and(|r| {
            r.job.artifact.key.job == id && !r.job.artifact.fused_sources.is_empty()
        });
        if fused {
            cache.fused_hits = cache.fused_hits.wrapping_add(1);
            cache.fused_steps = cache.fused_steps.wrapping_add(steps);
        }
        if let Some(record) = cache
            .records
            .get_mut(admitted_index)
            .filter(|record| record.job.artifact.key.job == id)
        {
            if PROFILE {
                diag::activation_end(
                    entry.linear.0,
                    diagnostic_cr3,
                    steps,
                    duration,
                    if record.job.artifact.tier == super::compile::Tier::One { 1 } else { 2 },
                    fused,
                );
            }
            record.hits = record.hits.wrapping_add(1);
            record.promotion_hits = record.promotion_hits.saturating_add(1);
            record.guest_steps = record.guest_steps.wrapping_add(steps);
            record.max_guest_steps = record.max_guest_steps.max(steps);
            if let Some((edge, target)) = observed_exit.filter(|_| profile) {
                let was_hot = record.hot_exit.is_some_and(|(_, _, hits)| hits >= 8);
                match &mut record.hot_exit {
                    Some((old, old_target, hits))
                        if old.from == edge.from && *old_target == target =>
                    {
                        *hits = hits.saturating_add(1)
                    },
                    Some((_, _, hits)) if *hits > 1 => *hits -= 1,
                    _ => record.hot_exit = Some((edge, target, 1)),
                }
                refresh_fusion = was_hot != record.hot_exit.is_some_and(|(_, _, hits)| hits >= 8);
            }
            if steps == 0 {
                record.zero_step_exits = record.zero_step_exits.wrapping_add(1);
            }
        }
        if refresh_fusion {
            refresh_fusion_candidate(&mut cache, admitted_index);
        }
        // Zero-budget REP and other no-retirement exits must not trap scheduling
        // in a repeatedly admitted entry. The next cycle may interpret instead.
        if steps == 0 {
            if let Some(r) = cache
                .records
                .get_mut(admitted_index)
                .filter(|r| r.job.artifact.key.job == id)
            {
                r.phase = Phase::Retired;
            }
            clear_missing_hint();
            cache.needs_collection = true;
            unsafe { COLLECTION_PENDING = true };
        }
        // A normal completed edge may reuse an admission certificate. Timing
        // imports are observable, so diagnostics/recording retain full admission.
        // IRQ/control and batch/chain limits are identical to the outer loop.
        if !PROFILE
            && allow_handoff
            && steps != 0
            && !profiler::performance_recording_enabled()
            && super::entry::profile_link_requested()
            && cpu::ir_link_budget_available()
            && !*gp::in_hlt
            && *gp::flags & (cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM) == control
        {
            warm_handoff(&mut cache, current)
        }
        else {
            None
        }
    };
    if next.is_some() {
        super::entry::take_link_request();
    }
    else {
        collect_if_needed();
    }
    next
}
