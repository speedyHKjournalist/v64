//! Guest RAM beyond the wasm32 backing store
//! (docs/x86-64.md): "extended RAM" at guest
//! physical [base, base + pages * 4 KiB), above the RAM windows of
//! crate::x64::physical. Its pages live in a host store (JavaScript
//! ArrayBuffers, shared with vCPU workers: `js::extended_load` and
//! `js::extended_store` copy one page) and are cached in a pool of 4 KiB
//! frames in the wasm heap.
//!
//! The bus reports the range as neither RAM nor MMIO (`WindowKind::Extended`):
//! TLBs never treat it as RAM, and the interpreter's
//! accesses come here, so a frame can be written back and reused at any of
//! them. One exception makes extended RAM fast enough for an OS to keep its
//! own data there: the access cache of compiled page functions
//! (crate::x64::jac) and the 32-bit TLB of compatibility mode may map a page
//! to its frame (`cache_frame`, with cores on one thread only). Such a frame is marked CACHED and is never reused
//! while marked; when too many are, the dispatch loop's next safe point
//! (`safe_point`, no compiled code active) retires every access cache entry
//! and unmarks them all. A write entry marks the frame dirty up front, as
//! stores through it bypass this module. (Host copies outside the CPU pin
//! their frame, `x64_ext_pin`; with no reusable frame left, an access goes
//! through a separate bounce frame.)
//!
//! Page functions (crate::x64::pages) are compiled from extended pages too,
//! with cores on one thread only. Such a function is keyed by the page, not
//! its frame, so it survives the frame's eviction. The page is marked in
//! `code`; every write reaches it through `resident` (the interpreter, DMA,
//! the bounce frame), which retires the function, and the access cache gets
//! no write entry for it (`cache_frame`).
//! Compatibility-mode helpers, which work with 32-bit bus addresses, reach
//! extended pages through a small aperture in that bus (`aperture`).
//!
//! With cores in workers, one lock serializes the module. It is re-entrant
//! for its owner: a locked read-modify-write instruction holds it from the
//! operand's read to its write (crate::x64::memory::run_locked), which makes
//! the instruction atomic with respect to every other core's accesses here.

use crate::parallel::{machine, SpinLock};
use std::ptr;

mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        /// Copy extended page `page` (index from the start of the range) from
        /// the host store to `pointer` in wasm memory
        pub fn extended_load(page: u32, pointer: u32);
        /// Copy the page at `pointer` to the host store
        pub fn extended_store(page: u32, pointer: u32);
    }
}

pub const PAGE: u64 = 4096;
const NONE: u32 = u32::MAX;
const REFERENCED: u8 = 1;
const DIRTY: u8 = 2;
/// in the access cache of compiled code: not reusable before `safe_point`
const CACHED: u8 = 4;
/// in the replacement queue
const QUEUED: u8 = 8;

pub struct Extended {
    base: u64,
    pages: u32,
    pool: *mut u8,
    frames: u32,
    /// frame of each page, or NONE
    page_frame: Vec<u32>,
    /// page of each frame, or NONE
    frame_page: Vec<u32>,
    frame_state: Vec<u8>,
    frame_pins: Vec<u16>,
    /// Replacement order: a FIFO ring of resident frames with a second chance
    /// for referenced ones; cached frames leave it until released. Fixed
    /// capacity (one slot per frame): workers never allocate machine memory.
    queue: Vec<u32>,
    head: u32,
    queued: u32,
    /// frames below this were used since the pool was (re)set
    unused_from: u32,
    /// frames marked CACHED
    cached: u32,
    /// one more frame, for an access when no frame is reusable
    bounce: *mut u8,
    /// pages with page-tier code, one bit each (see `note_write`)
    code: Vec<u64>,
    pub stats: [u64; 9],
}
const STAT_HITS: usize = 0;
const STAT_LOADS: usize = 1;
const STAT_STORES: usize = 2;
const STAT_EVICTIONS: usize = 3;
const STAT_APERTURE: usize = 4;
const STAT_LOCKED: usize = 5;
const STAT_RELEASES: usize = 6;
const STAT_BOUNCES: usize = 7;
const STAT_CODE_WRITES: usize = 8;

static mut EXTENDED: Extended = Extended {
    base: 0,
    pages: 0,
    pool: ptr::null_mut(),
    frames: 0,
    page_frame: Vec::new(),
    frame_page: Vec::new(),
    frame_state: Vec::new(),
    frame_pins: Vec::new(),
    queue: Vec::new(),
    head: 0,
    queued: 0,
    unused_from: 0,
    cached: 0,
    bounce: ptr::null_mut(),
    code: Vec::new(),
    stats: [0; 9],
};
/// Too many frames are CACHED, or none was reusable: retire the access
/// caches at the next safe point
static mut RELEASE_PENDING: bool = false;
/// a 32-bit TLB of compatibility mode holds a frame (crate::cpu::cpu::fill_ia32e_tlb)
static mut LEGACY_TLB_CACHED: bool = false;
pub unsafe fn note_legacy_tlb() { LEGACY_TLB_CACHED = true; }
// the machine instance's module state and its lock (crate::parallel)
fn ext() -> &'static mut Extended { unsafe { &mut *machine(&raw mut EXTENDED) } }

static mut LOCK: SpinLock = SpinLock::new();
/// Owner depth of LOCK (the lock word holds the owner's core + 1)
static mut DEPTH: [u32; crate::parallel::MAX_CORES] = [0; crate::parallel::MAX_CORES];

/// Take the module's lock (re-entrant); a no-op without cores in workers
pub unsafe fn lock() {
    if !crate::parallel::active() {
        return;
    }
    let core = crate::cpu::apic::current_core();
    let depth = machine(&raw mut DEPTH).cast::<u32>().add(core);
    if *depth == 0 {
        (*machine(&raw mut LOCK)).lock();
    }
    *depth += 1;
}
pub unsafe fn unlock() {
    if !crate::parallel::active() {
        return;
    }
    let core = crate::cpu::apic::current_core();
    let depth = machine(&raw mut DEPTH).cast::<u32>().add(core);
    dbg_assert!(*depth > 0);
    *depth -= 1;
    if *depth == 0 {
        (*machine(&raw mut LOCK)).unlock();
    }
}
/// A failed core's worker holds the lock no more (crate::parallel::parallel_fail)
pub unsafe fn release_held_by(core: usize) {
    *machine(&raw mut DEPTH).cast::<u32>().add(core) = 0;
    (*machine(&raw mut LOCK)).release_held_by(core);
}
struct Guard;
impl Guard {
    unsafe fn new() -> Guard {
        lock();
        Guard
    }
}
impl Drop for Guard {
    fn drop(&mut self) { unsafe { unlock() } }
}

/// Whether guest physical `address` is extended RAM
#[inline]
pub unsafe fn contains(address: u64) -> bool {
    let e = ext();
    address.wrapping_sub(e.base) < e.pages as u64 * PAGE
}
pub unsafe fn range() -> Option<(u64, u64)> {
    let e = ext();
    (e.pages != 0).then(|| (e.base, e.base + e.pages as u64 * PAGE))
}

/// The resident frame of `page` (loading it, and writing back and reusing
/// another frame when the pool is full), or None if no frame is reusable.
/// Under the lock. Every write to extended RAM comes here first.
unsafe fn resident(e: &mut Extended, page: u32, write: bool) -> Option<u32> {
    if write {
        note_write(e, page);
    }
    let mut frame = e.page_frame[page as usize];
    if frame == NONE {
        frame = victim(e)?;
        js::extended_load(page, e.pool.add(frame as usize * PAGE as usize) as u32);
        e.page_frame[page as usize] = frame;
        e.frame_page[frame as usize] = page;
        e.frame_state[frame as usize] = 0;
        enqueue(e, frame);
        e.stats[STAT_LOADS] += 1;
    }
    else {
        e.stats[STAT_HITS] += 1;
    }
    e.frame_state[frame as usize] |= REFERENCED | if write { DIRTY } else { 0 };
    Some(frame)
}

/// Run `access` on the bytes of `page`: in its frame, or, when no frame is
/// reusable, in the bounce frame (written back at once after a write)
unsafe fn with_page<T>(
    e: &mut Extended,
    page: u32,
    write: bool,
    access: impl FnOnce(*mut u8) -> T,
) -> T {
    if let Some(frame) = resident(e, page, write) {
        return access(e.pool.add(frame as usize * PAGE as usize));
    }
    RELEASE_PENDING = true;
    e.stats[STAT_BOUNCES] += 1;
    js::extended_load(page, e.bounce as u32);
    let result = access(e.bounce);
    if write {
        js::extended_store(page, e.bounce as u32);
    }
    result
}

fn enqueue(e: &mut Extended, frame: u32) {
    dbg_assert!(e.frame_state[frame as usize] & QUEUED == 0 && e.queued < e.frames);
    let at = (e.head + e.queued) % e.frames;
    e.queue[at as usize] = frame;
    e.queued += 1;
    e.frame_state[frame as usize] |= QUEUED;
}
fn dequeue(e: &mut Extended) -> Option<u32> {
    if e.queued == 0 {
        return None;
    }
    let frame = e.queue[e.head as usize];
    e.head = (e.head + 1) % e.frames;
    e.queued -= 1;
    e.frame_state[frame as usize] &= !QUEUED;
    Some(frame)
}

/// A frame to reuse: an unused one, else the oldest resident frame that is
/// not referenced (referenced ones get a second chance), not pinned and not
/// cached (a cached frame leaves the queue until it is released)
unsafe fn victim(e: &mut Extended) -> Option<u32> {
    if e.unused_from < e.frames {
        e.unused_from += 1;
        return Some(e.unused_from - 1);
    }
    for _ in 0..2 * e.queued + 1 {
        let frame = dequeue(e)?;
        let state = e.frame_state[frame as usize];
        if state & CACHED != 0 {
            continue;
        }
        if e.frame_pins[frame as usize] != 0 || state & REFERENCED != 0 {
            e.frame_state[frame as usize] &= !REFERENCED;
            enqueue(e, frame);
            continue;
        }
        evict(e, frame);
        return Some(frame);
    }
    None
}

/// The host address of the frame of the extended page at `address` for the
/// access cache of compiled page functions (crate::x64::pages), or None:
/// with cores in workers (their access caches cannot be retired at one
/// safe point), when no frame is reusable before the next safe point, or
/// for a write to a page with page-tier code (the interpreter's write
/// retires that code)
pub unsafe fn cache_frame(address: u64, write: bool) -> Option<u32> {
    if crate::parallel::active() || !contains(address) {
        return None;
    }
    let e = ext();
    let page = ((address - e.base) / PAGE) as u32;
    if write && has_code(e, page) {
        return None;
    }
    let frame = resident(e, page, write)?;
    let state = &mut e.frame_state[frame as usize];
    if *state & CACHED == 0 {
        *state |= CACHED;
        e.cached += 1;
        // (released while half the pool is still reusable)
        if e.cached > e.frames / 2 {
            RELEASE_PENDING = true;
        }
    }
    // (stores through the entry are not seen here)
    if write {
        *state |= DIRTY;
    }
    Some(e.pool.add(frame as usize * PAGE as usize) as u32)
}

/// Page functions of extended pages have keys from here on
/// (crate::x64::pages): above every RAM backing page number
pub const CODE_KEY_BASE: u32 = 1 << 20;

/// The page-tier key of the extended page at `address`, or None: not
/// extended RAM, or cores run in workers (their writes are not tracked in
/// `code`; see crate::x64::pages::retire_extended)
pub unsafe fn code_key(address: u64) -> Option<u32> {
    if crate::parallel::active() || !contains(address) {
        return None;
    }
    Some(CODE_KEY_BASE + ((address - ext().base) / PAGE) as u32)
}

/// The bytes of extended page `page`, to compile from
pub unsafe fn copy_page(page: u32) -> Vec<u8> {
    let _guard = Guard::new();
    with_page(ext(), page, false, |frame| {
        std::slice::from_raw_parts(frame, PAGE as usize).to_vec()
    })
}

fn has_code(e: &Extended, page: u32) -> bool { e.code[page as usize / 64] >> (page % 64) & 1 != 0 }

/// A page function was compiled from `page`: its next write retires it.
/// Stores through write entries of the access caches (and of the 32-bit
/// TLBs of compatibility mode) would not come here: retire those.
pub unsafe fn watch_code(page: u32) {
    let e = ext();
    e.code[page as usize / 64] |= 1 << (page % 64);
    let frame = e.page_frame[page as usize];
    // (only a CACHED frame can be in an access cache or a 32-bit TLB)
    if frame != NONE && e.frame_state[frame as usize] & CACHED != 0 {
        super::jac::retire_writes_to_host(e.pool.add(frame as usize * PAGE as usize) as u32);
        if LEGACY_TLB_CACHED {
            LEGACY_TLB_CACHED = false;
            crate::cpu::context::invalidate_legacy_tlbs();
        }
    }
}
/// The page function of `page` was retired
pub unsafe fn unwatch_code(page: u32) {
    let e = ext();
    e.code[page as usize / 64] &= !(1 << (page % 64));
}
/// `page` is about to be written: retire the page function compiled from it
#[inline]
unsafe fn note_write(e: &mut Extended, page: u32) {
    if has_code(e, page) {
        e.code[page as usize / 64] &= !(1 << (page % 64));
        e.stats[STAT_CODE_WRITES] += 1;
        super::pages::dirty_page(CODE_KEY_BASE + page);
    }
}

/// A safe point of the dispatch loop: no compiled code is active
#[inline(always)]
pub unsafe fn safe_point() {
    if RELEASE_PENDING {
        release_cached();
    }
}

/// Retire every access cache entry, so that no frame is CACHED any more
unsafe fn release_cached() {
    RELEASE_PENDING = false;
    let e = ext();
    if e.cached == 0 {
        return;
    }
    // the access caches of page functions (an epoch step) and, if they
    // hold frames, the 32-bit TLBs of compatibility mode
    super::jac::flush_all();
    if LEGACY_TLB_CACHED {
        LEGACY_TLB_CACHED = false;
        crate::cpu::context::invalidate_legacy_tlbs();
    }
    e.stats[STAT_RELEASES] += 1;
    for frame in 0..e.frames {
        let state = e.frame_state[frame as usize];
        if state & CACHED != 0 {
            e.frame_state[frame as usize] &= !CACHED;
            if state & QUEUED == 0 && e.frame_page[frame as usize] != NONE {
                enqueue(e, frame);
            }
        }
    }
    e.cached = 0;
}

unsafe fn evict(e: &mut Extended, frame: u32) {
    let page = e.frame_page[frame as usize];
    if e.frame_state[frame as usize] & DIRTY != 0 {
        js::extended_store(page, e.pool.add(frame as usize * PAGE as usize) as u32);
        e.stats[STAT_STORES] += 1;
    }
    e.page_frame[page as usize] = NONE;
    e.frame_page[frame as usize] = NONE;
    e.frame_state[frame as usize] = 0;
    e.stats[STAT_EVICTIONS] += 1;
}

/// `width` (1, 2, 4 or 8) bytes at `address`, within one page
pub unsafe fn read(address: u64, width: usize) -> u64 {
    let _guard = Guard::new();
    let e = ext();
    let offset = address - e.base;
    dbg_assert!(offset % PAGE + width as u64 <= PAGE);
    with_page(e, (offset / PAGE) as u32, false, |frame| {
        let at = frame.add((offset % PAGE) as usize);
        match width {
            1 => *at as u64,
            2 => ptr::read_unaligned(at as *const u16) as u64,
            4 => ptr::read_unaligned(at as *const u32) as u64,
            _ => ptr::read_unaligned(at as *const u64),
        }
    })
}

pub unsafe fn write(address: u64, width: usize, value: u64) {
    let _guard = Guard::new();
    let e = ext();
    let offset = address - e.base;
    dbg_assert!(offset % PAGE + width as u64 <= PAGE);
    with_page(e, (offset / PAGE) as u32, true, |frame| {
        let at = frame.add((offset % PAGE) as usize);
        match width {
            1 => *at = value as u8,
            2 => ptr::write_unaligned(at as *mut u16, value as u16),
            4 => ptr::write_unaligned(at as *mut u32, value as u32),
            _ => ptr::write_unaligned(at as *mut u64, value),
        }
    })
}

/// Set bits of a qword (paging entry accessed/dirty bits): one step for the
/// other cores, which access extended RAM only under the same lock
pub unsafe fn or64(address: u64, bits: u64) {
    let _guard = Guard::new();
    let value = read(address, 8);
    write(address, 8, value | bits);
}

/// A locked instruction's operand is here: keep the lock until it ends
pub unsafe fn begin_locked_operand() {
    lock();
    ext().stats[STAT_LOCKED] += 1;
}

pub mod aperture {
    //! Compatibility-mode (32-bit) memory helpers take 32-bit bus
    //! addresses (crate::x64::memory::legacy_translate). An extended page
    //! gets a slot of this aperture, a range of the 32-bit bus the platform
    //! leaves unused (above the local APIC, below the BIOS; not between the
    //! IOAPIC and the local APIC, where Q35 has its HPET at 0xFED00000 and
    //! its root complex registers at 0xFED1C000): an address in it reaches
    //! the page through crate::cpu::memory's mapped (MMIO) path, never
    //! cached, never compiled from. Each core reuses its own slots in order,
    //! so the few pages one instruction touches keep theirs.
    use super::*;

    pub const BASE: u32 = 0xFEF0_0000;
    const SLOTS_PER_CORE: u32 = 32;
    pub const SIZE: u32 = crate::parallel::MAX_CORES as u32 * SLOTS_PER_CORE * PAGE as u32;

    static mut SLOT_PAGE: [u64; crate::parallel::MAX_CORES * SLOTS_PER_CORE as usize] =
        [u64::MAX; crate::parallel::MAX_CORES * SLOTS_PER_CORE as usize];
    static mut NEXT: [u32; crate::parallel::MAX_CORES] = [0; crate::parallel::MAX_CORES];

    #[inline]
    pub fn contains(address: u32) -> bool { address.wrapping_sub(BASE) < SIZE }

    /// The bus address of the extended RAM byte at `address`
    pub unsafe fn map(address: u64) -> u32 {
        let core = crate::cpu::apic::current_core();
        let page = address & !(PAGE - 1);
        let slots = machine(&raw mut SLOT_PAGE)
            .cast::<u64>()
            .add(core * SLOTS_PER_CORE as usize);
        let mut slot = SLOTS_PER_CORE;
        for i in 0..SLOTS_PER_CORE {
            if *slots.add(i as usize) == page {
                slot = i;
                break;
            }
        }
        if slot == SLOTS_PER_CORE {
            let next = machine(&raw mut NEXT).cast::<u32>().add(core);
            slot = *next;
            *next = (slot + 1) % SLOTS_PER_CORE;
            *slots.add(slot as usize) = page;
            ext().stats[STAT_APERTURE] += 1;
        }
        BASE + (core as u32 * SLOTS_PER_CORE + slot) * PAGE as u32 + (address % PAGE) as u32
    }

    /// The guest physical address behind an aperture address, if it has one
    pub unsafe fn guest(address: u32) -> Option<u64> {
        if !contains(address) {
            return None;
        }
        let index = ((address - BASE) / PAGE as u32) as usize;
        let page = *machine(&raw mut SLOT_PAGE).cast::<u64>().add(index);
        (page != u64::MAX && super::contains(page)).then_some(page + (address as u64 % PAGE))
    }

    pub unsafe fn clear() {
        let slots = machine(&raw mut SLOT_PAGE).cast::<u64>();
        for i in 0..crate::parallel::MAX_CORES * SLOTS_PER_CORE as usize {
            *slots.add(i) = u64::MAX;
        }
    }

    /// An aperture byte (for the mapped path of crate::cpu::memory)
    pub unsafe fn read8(address: u32) -> Option<u8> {
        guest(address).map(|at| super::read(at, 1) as u8)
    }
    pub unsafe fn write8(address: u32, value: u8) -> bool {
        guest(address)
            .map(|at| super::write(at, 1, value as u64))
            .is_some()
    }
    /// An aligned dword within one aperture page
    pub unsafe fn read32(address: u32) -> Option<u32> {
        guest(address).map(|at| super::read(at, 4) as u32)
    }
    pub unsafe fn write32(address: u32, value: u32) -> bool {
        guest(address)
            .map(|at| super::write(at, 4, value as u64))
            .is_some()
    }
}

/// Configure extended RAM (machine instance, before the cores run): `pages`
/// pages at guest physical `base`, cached in `frames` frames. 0 pages removes it.
#[no_mangle]
pub unsafe fn x64_ext_configure(base_low: u32, base_high: u32, pages: u32, frames: u32) -> bool {
    let base = (base_high as u64) << 32 | base_low as u64;
    if base % PAGE != 0 || pages != 0 && (frames < 64 || base < 1 << 32) {
        return false;
    }
    let e = &mut *(&raw mut EXTENDED);
    if e.pages != 0 || pages == 0 {
        return pages == 0 && e.pages == 0;
    }
    // (and the bounce frame)
    let layout =
        std::alloc::Layout::from_size_align((frames as usize + 1) * PAGE as usize, PAGE as usize)
            .unwrap();
    let pool = std::alloc::alloc(layout);
    if pool.is_null() {
        return false;
    }
    e.base = base;
    e.pages = pages;
    e.pool = pool;
    e.frames = frames;
    e.page_frame = vec![NONE; pages as usize];
    e.frame_page = vec![NONE; frames as usize];
    e.frame_state = vec![0; frames as usize];
    e.frame_pins = vec![0; frames as usize];
    e.queue = vec![0; frames as usize];
    e.head = 0;
    e.queued = 0;
    e.unused_from = 0;
    e.cached = 0;
    e.bounce = pool.add(frames as usize * PAGE as usize);
    e.code = vec![0; (pages as usize).div_ceil(64)];
    true
}

/// Write back every dirty frame (the store is then complete: snapshots)
#[no_mangle]
pub unsafe fn x64_ext_flush() {
    let _guard = Guard::new();
    // (so that no store bypasses the dirty bits cleared here)
    release_cached();
    let e = ext();
    for frame in 0..e.frames {
        let page = e.frame_page[frame as usize];
        if page != NONE && e.frame_state[frame as usize] & DIRTY != 0 {
            js::extended_store(page, e.pool.add(frame as usize * PAGE as usize) as u32);
            e.frame_state[frame as usize] &= !DIRTY;
            e.stats[STAT_STORES] += 1;
        }
    }
}

/// Forget every frame without writing it back (the store was replaced:
/// snapshot restore, power-on). Every core is stopped.
#[no_mangle]
pub unsafe fn x64_ext_discard() {
    release_cached();
    let e = ext();
    for frame in 0..e.frames as usize {
        dbg_assert!(e.frame_pins[frame] == 0);
        e.frame_page[frame] = NONE;
        e.frame_state[frame] = 0;
    }
    for page in e.page_frame.iter_mut() {
        *page = NONE;
    }
    // (the page functions go too: jit_clear_cache follows)
    e.code.fill(0);
    e.head = 0;
    e.queued = 0;
    e.unused_from = 0;
    aperture::clear();
}

/// The frame of extended page `page` for a host copy (DMA, debugging),
/// resident until x64_ext_unpin: its address in wasm memory
#[no_mangle]
pub unsafe fn x64_ext_pin(page: u32, write: bool) -> u32 {
    let _guard = Guard::new();
    let e = ext();
    if page >= e.pages {
        return 0;
    }
    // (the host calls this outside compiled code: a safe point)
    let frame = match resident(e, page, write) {
        Some(frame) => frame,
        None => {
            release_cached();
            resident(e, page, write).expect("extended RAM: every frame is pinned")
        },
    };
    e.frame_pins[frame as usize] += 1;
    e.pool.add(frame as usize * PAGE as usize) as u32
}
#[no_mangle]
pub unsafe fn x64_ext_unpin(page: u32) {
    let _guard = Guard::new();
    let e = ext();
    let frame = e.page_frame[page as usize];
    dbg_assert!(frame != NONE && e.frame_pins[frame as usize] > 0);
    e.frame_pins[frame as usize] -= 1;
}

/// 0 hits, 1 loads, 2 write-backs, 3 evictions, 4 aperture mappings,
/// 5 locked instructions; 6 pages, 7 frames; 8 releases of cached frames,
/// 9 accesses through the bounce frame; now: 10 queued frames, 11 frames
/// counted as cached, 12 frames marked CACHED, 13 pinned frames; 14 pages
/// with page-tier code now, 15 page-tier code retired by writes
#[no_mangle]
pub unsafe fn x64_ext_stat(field: u32) -> f64 {
    let e = ext();
    let frames = || 0..e.frames as usize;
    match field {
        0..=5 => e.stats[field as usize] as f64,
        6 => e.pages as f64,
        7 => e.frames as f64,
        8 => e.stats[STAT_RELEASES] as f64,
        9 => e.stats[STAT_BOUNCES] as f64,
        10 => e.queued as f64,
        11 => e.cached as f64,
        12 => frames().filter(|&f| e.frame_state[f] & CACHED != 0).count() as f64,
        13 => frames().filter(|&f| e.frame_pins[f] != 0).count() as f64,
        14 => e.code.iter().map(|word| word.count_ones()).sum::<u32>() as f64,
        15 => e.stats[STAT_CODE_WRITES] as f64,
        _ => -1.0,
    }
}
