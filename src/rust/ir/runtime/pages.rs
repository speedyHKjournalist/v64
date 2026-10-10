//! Page-granular heat for automatic compilation, the legacy JIT's unit of work.
//! Interpreted visits heat the linear code page they start in and record their
//! exact entry; a hot page is compiled once with every observed entry. Later
//! misses on the same page (new entries) accumulate fresh heat and recompile it
//! with the enlarged entry set. This table only selects work: admission
//! authority stays in the cache's exact-key publication records.
use super::entry::CpuEntryKey;
use crate::state_flags::CachedStateFlags;
use std::collections::{BTreeMap, VecDeque};

/// Primary plus aliases; the page lifter accepts CfgLimits::PAGE.entries.
const MAX_ENTRIES: usize = 63;
/// Tier-0 page functions (tier0::compile_page) take more: recompilations
/// seed only the entries that find the other blocks, plus new ones.
const MAX_TIER0_ENTRIES: usize = 255;
/// Pages a cluster function adds to its own (see want_partner).
const MAX_PARTNERS: usize = 5;
const CAPACITY: usize = 2048;
/// Compilations of one page per code version; misses beyond this bound stay
/// interpreted instead of recompiling a page whose entries keep changing.
const MAX_ATTEMPTS: u8 = 8;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(super) struct PageKey {
    pub base: u32,
    pub cs_base: u32,
    pub default_32: bool,
}
impl PageKey {
    pub fn of(entry: CpuEntryKey) -> Self {
        Self {
            base: entry.linear.0 & !4095,
            cs_base: entry.cs_base(),
            default_32: entry.default_32,
        }
    }
}
struct Page {
    key: PageKey,
    visits: u32,
    entries: Vec<(CpuEntryKey, u32)>,
    /// Entries a published page function already serves (no new heat needed).
    served: Vec<CpuEntryKey>,
    /// The served entries that find all of its blocks (Tier-0; empty: all).
    seeds: Vec<CpuEntryKey>,
    /// Requested entries the page function could not serve; they keep the
    /// region compiler as their fallback instead of reheating the page.
    declined: Vec<CpuEntryKey>,
    attempts: u8,
    /// Code-page writes since the page was first compiled. Pages that mix
    /// code with frequently written data need exponentially more heat before
    /// each recompilation (the removed legacy JIT restarted its large page threshold).
    invalidations: u8,
    failed: bool,
    queued: bool,
    physical: Option<u32>,
    stamp: u64,
    /// Tier-0: compile with the neighbor pages its code continues into
    /// (tier0::range), after frequent page-function links to a neighbor;
    /// `range_pending`: that recompilation is queued.
    range: bool,
    range_pending: bool,
    /// The queued recompilation only adds the range (no new entries).
    range_only: bool,
    /// Pages (linear bases) this page's function often links to, with an
    /// entry each (the link target): compiled into its function (a cluster).
    partners: Vec<(u32, u32)>,
    /// Where the page was queued from IA-32e compatibility mode (P4.6)
    context: Option<QueuedContext>,
}
/// The address space, privilege and state flags of code queued in IA-32e
/// compatibility mode (WOW64): a long-mode frame may compile it in that
/// context (docs/jit-unification-plan.md P4.6, Pages::take_ready_if)
#[derive(Clone, Copy)]
pub(super) struct QueuedContext {
    pub cr3: u64,
    pub cpl: u8,
    pub state_flags: CachedStateFlags,
}
/// The live context, in compatibility mode
fn queued_context() -> Option<QueuedContext> {
    use crate::x64::state;
    unsafe {
        (state::efer() & state::EFER_LMA != 0 && !state::mode().is_long()).then(|| QueuedContext {
            cr3: state::read_cr(3),
            cpl: *crate::cpu::global_pointers::cpl,
            state_flags: *crate::cpu::global_pointers::state_flags,
        })
    }
}
pub(super) struct Pages {
    pages: Vec<Page>,
    index: BTreeMap<PageKey, usize>,
    /// Index of the page slot() found last (checked against its key).
    last: usize,
    ready: VecDeque<PageKey>,
    clock: u64,
    pub compiles: u32,
    pub failures: u32,
    pub first: u32,
    pub again: u32,
    pub dirty_resets: u32,
    pub declined_entries: u32,
    /// Entries kept per page (MAX_ENTRIES or MAX_TIER0_ENTRIES).
    max_entries: usize,
    /// Tier-0: recompilations need the first compile's heat (their entry
    /// sets only grow), except after repeated attempts.
    tier0: bool,
}
impl Pages {
    pub const fn new() -> Self {
        Self {
            pages: Vec::new(),
            index: BTreeMap::new(),
            last: usize::MAX,
            ready: VecDeque::new(),
            clock: 0,
            compiles: 0,
            failures: 0,
            first: 0,
            again: 0,
            dirty_resets: 0,
            declined_entries: 0,
            max_entries: MAX_ENTRIES,
            tier0: false,
        }
    }
    pub fn set_tier0(&mut self, tier0: bool) {
        self.tier0 = tier0;
        self.max_entries = if tier0 { MAX_TIER0_ENTRIES } else { MAX_ENTRIES };
    }
    pub fn clear(&mut self) {
        self.pages.clear();
        self.index.clear();
        self.ready.clear();
    }
    fn slot(&mut self, key: PageKey) -> usize {
        // Consecutive visits mostly stay on one page.
        if let Some(page) = self.pages.get(self.last) {
            if page.key == key {
                return self.last;
            }
        }
        let i = self.slot_uncached(key);
        self.last = i;
        i
    }
    fn slot_uncached(&mut self, key: PageKey) -> usize {
        if let Some(&i) = self.index.get(&key) {
            return i;
        }
        let page = Page {
            key,
            visits: 0,
            entries: Vec::new(),
            served: Vec::new(),
            seeds: Vec::new(),
            declined: Vec::new(),
            attempts: 0,
            invalidations: 0,
            failed: false,
            queued: false,
            physical: None,
            stamp: self.clock,
            range: false,
            range_pending: false,
            range_only: false,
            partners: Vec::new(),
            context: None,
        };
        if self.pages.len() < CAPACITY {
            self.pages.push(page);
            self.index.insert(key, self.pages.len() - 1);
            return self.pages.len() - 1;
        }
        // Replace the least recently visited page that is not queued.
        let victim = self
            .pages
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.queued)
            .min_by_key(|(_, p)| p.stamp)
            .map(|(i, _)| i)
            .unwrap_or(0);
        let old = std::mem::replace(&mut self.pages[victim], page);
        self.index.remove(&old.key);
        self.ready.retain(|k| *k != old.key);
        self.index.insert(key, victim);
        victim
    }
    /// One interpreted visit starting at `entry`. Returns whether the page may
    /// still use region compilation (its page compilation failed).
    pub fn visit(&mut self, entry: CpuEntryKey, threshold: u32) -> bool {
        self.visit_weighted(entry, threshold, 1)
    }
    /// A visit worth `weight` heat (Tier-0 counts executed instructions,
    /// like the legacy JIT's page hotness).
    pub fn visit_weighted(&mut self, entry: CpuEntryKey, threshold: u32, weight: u32) -> bool {
        self.clock += 1;
        let i = self.slot(PageKey::of(entry));
        let clock = self.clock;
        let page = &mut self.pages[i];
        page.stamp = clock;
        if page.failed || page.declined.contains(&entry) {
            return true;
        }
        if page.served.contains(&entry) {
            // A published entry reached through interpretation (admission
            // declined it once): heat does not justify a recompilation.
            return false;
        }
        match page.entries.iter_mut().find(|(e, _)| *e == entry) {
            Some((_, hits)) => *hits = hits.saturating_add(1),
            None => {
                if page.entries.len() == self.max_entries {
                    // Keep the hottest entries; a new one replaces the coldest.
                    let (at, _) = page
                        .entries
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, (_, hits))| *hits)
                        .unwrap();
                    if page.entries[at].1 > 1 {
                        page.entries[at].1 -= 1;
                        page.visits = page.visits.saturating_add(weight);
                        return false;
                    }
                    page.entries[at] = (entry, 1);
                }
                else {
                    page.entries.push((entry, 1));
                }
            },
        }
        page.visits = page.visits.saturating_add(weight);
        // Each recompilation of the same code version doubles the heat its new
        // entries must earn; each code-page write quadruples it.
        let attempts = if self.tier0 { page.attempts.saturating_sub(2) } else { page.attempts };
        let shift = attempts.min(6) as u32 + 2 * page.invalidations.min(8) as u32;
        let needed = threshold.saturating_mul(1 << shift);
        if page.visits >= needed && !page.queued && page.attempts < MAX_ATTEMPTS {
            page.queued = true;
            page.context = queued_context();
            let key = page.key;
            self.ready.push_back(key);
        }
        false
    }
    /// Whether pages wait in the ready queue (take_ready may still drop some)
    pub fn has_ready(&self) -> bool { !self.ready.is_empty() }
    /// Whether a page waits that was queued in compatibility mode under `cr3`
    pub fn ready_in(&self, cr3: u64) -> bool {
        self.ready.iter().any(|key| {
            self.index
                .get(key)
                .and_then(|&i| self.pages[i].context)
                .is_some_and(|c| c.cr3 == cr3)
        })
    }
    /// Next page whose heat justifies a (re)compilation, with its entries in
    /// descending heat order (the first is the primary entry).
    pub fn take_ready(&mut self) -> Option<(PageKey, Vec<CpuEntryKey>)> {
        while let Some(key) = self.ready.pop_front() {
            if let Some(work) = self.take(key) {
                return Some(work);
            }
        }
        None
    }
    /// take_ready's next page among those queued in compatibility mode under
    /// `cr3` (at privilege `cpl` unless `any_cpl`), with the state flags they
    /// were queued with (P4.6: a long-mode frame compiles it); the other
    /// pages keep their places in the queue and their attempts.
    pub fn take_ready_if(
        &mut self,
        cr3: u64,
        cpl: u8,
        any_cpl: bool,
    ) -> Option<(PageKey, Vec<CpuEntryKey>, CachedStateFlags)> {
        let (pages, index) = (&self.pages, &self.index);
        let context = |key: &PageKey| {
            index
                .get(key)
                .and_then(|&i| pages[i].context)
                .filter(|c| c.cr3 == cr3 && (any_cpl || c.cpl == cpl))
        };
        let position = self.ready.iter().position(|key| context(key).is_some())?;
        let key = self.ready.remove(position)?;
        let flags = context(&key)?.state_flags;
        self.take(key).map(|(key, entries)| (key, entries, flags))
    }
    /// The page `key`, taken from the queue: its entries to compile, or None
    /// when it has nothing left to compile
    fn take(&mut self, key: PageKey) -> Option<(PageKey, Vec<CpuEntryKey>)> {
        let Some(&i) = self.index.get(&key)
        else {
            return None;
        };
        let page = &mut self.pages[i];
        page.queued = false;
        let range = std::mem::take(&mut page.range_pending);
        if page.failed || page.attempts >= MAX_ATTEMPTS || page.entries.is_empty() && !range {
            return None;
        }
        page.range_only = page.entries.is_empty();
        if page.served.is_empty() {
            self.first += 1;
        }
        else {
            self.again += 1;
        }
        page.attempts += 1;
        page.visits = 0;
        let mut entries = page.entries.clone();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.linear.0.cmp(&b.0.linear.0)));
        let mut keys: Vec<CpuEntryKey> = entries.into_iter().map(|(e, _)| e).collect();
        // Seeds first: other served entries are found from them.
        for served in page.seeds.iter().chain(&page.served) {
            if keys.len() < self.max_entries && !keys.contains(served) {
                keys.push(*served);
            }
        }
        // A range or partner request for a page whose function was
        // retired: its entries earn heat again first.
        if keys.is_empty() {
            return None;
        }
        Some((key, keys))
    }
    /// Record the entries a compiled page function serves, or that the page
    /// cannot be compiled at all (its entries then use region compilation).
    pub fn compiled(
        &mut self,
        key: PageKey,
        requested: &[CpuEntryKey],
        served: Option<(&[CpuEntryKey], u32)>,
        seeds: &[CpuEntryKey],
    ) {
        let Some(&i) = self.index.get(&key)
        else {
            return;
        };
        let page = &mut self.pages[i];
        match served {
            Some((served, physical)) => {
                self.compiles = self.compiles.wrapping_add(1);
                page.physical = Some(physical);
                page.seeds = seeds.to_vec();
                for entry in served {
                    if !page.served.contains(entry) {
                        page.served.push(*entry);
                    }
                }
                for entry in requested {
                    if !served.contains(entry) && !page.declined.contains(entry) {
                        page.declined.push(*entry);
                        self.declined_entries += 1;
                    }
                }
                page.entries
                    .retain(|(e, _)| !served.contains(e) && !page.declined.contains(e));
            },
            None => {
                self.failures = self.failures.wrapping_add(1);
                page.failed = true;
            },
        }
    }
    /// The page's code could not be captured now (not mapped in the current
    /// address space): not a failure, a later heat batch may compile it.
    pub fn capture_missed(&mut self, key: PageKey) {
        if let Some(&i) = self.index.get(&key) {
            let page = &mut self.pages[i];
            page.queued = false;
            page.range_pending = false;
        }
    }
    /// Recompile a compiled page with its neighbors (see Page::range).
    pub fn want_range(&mut self, key: PageKey) -> bool {
        let Some(&i) = self.index.get(&key)
        else {
            return false;
        };
        let page = &mut self.pages[i];
        if page.range || page.failed || page.physical.is_none() || page.attempts >= MAX_ATTEMPTS {
            return false;
        }
        page.range = true;
        page.range_pending = true;
        if !page.queued {
            page.queued = true;
            page.context = queued_context();
            self.ready.push_back(key);
        }
        true
    }
    pub fn range(&self, key: PageKey) -> bool {
        self.index.get(&key).is_some_and(|&i| self.pages[i].range)
    }
    /// Recompile a compiled page with `partner` (the page of the linear
    /// address `target`) in its function.
    pub fn want_partner(&mut self, key: PageKey, target: u32) -> bool {
        let Some(&i) = self.index.get(&key)
        else {
            return false;
        };
        let page = &mut self.pages[i];
        let partner = target & !4095;
        if page.failed
            || page.physical.is_none()
            || page.attempts >= MAX_ATTEMPTS
            || page.partners.len() >= MAX_PARTNERS
            || page.partners.iter().any(|&(p, _)| p == partner)
        {
            return false;
        }
        page.partners.push((partner, target));
        page.range_pending = true;
        if !page.queued {
            page.queued = true;
            page.context = queued_context();
            self.ready.push_back(key);
        }
        true
    }
    /// The page's partners, each with its known entries (the link target
    /// and the partner page's own seeds).
    pub fn partners(&self, key: PageKey) -> Vec<(u32, Vec<u32>)> {
        let Some(&i) = self.index.get(&key)
        else {
            return vec![];
        };
        self.pages[i]
            .partners
            .iter()
            .map(|&(partner, target)| {
                let mut entries = vec![target];
                if let Some(&j) = self.index.get(&PageKey {
                    base: partner,
                    ..key
                }) {
                    let other = &self.pages[j];
                    entries.extend(
                        other
                            .seeds
                            .iter()
                            .chain(&other.served)
                            .map(|e| e.linear.0)
                            .take(64),
                    );
                }
                (partner, entries)
            })
            .collect()
    }
    pub fn range_only(&self, key: PageKey) -> bool {
        self.index
            .get(&key)
            .is_some_and(|&i| self.pages[i].range_only)
    }
    /// The published function was retired or evicted: its entries need heat.
    pub fn unserve(&mut self, entries: &[CpuEntryKey]) {
        for entry in entries {
            if let Some(&i) = self.index.get(&PageKey::of(*entry)) {
                self.pages[i].served.retain(|e| e != entry);
                self.pages[i].seeds.retain(|e| e != entry);
            }
        }
    }
    /// Code bytes changed: allow new attempts and forget stale service claims.
    /// Whether the page has run code (interpreted or compiled) and never had
    /// that code written: a neighbor a page function may cover without
    /// turning a data page into watched code.
    pub fn known_code(&self, key: PageKey) -> bool {
        self.index.get(&key).is_some_and(|&i| {
            let page = &self.pages[i];
            page.invalidations == 0
                && (page.visits > 0 || !page.entries.is_empty() || page.physical.is_some())
        })
    }
    pub fn dirty(&mut self, physical: u32) {
        for page in &mut self.pages {
            if page.physical == Some(physical) {
                self.dirty_resets += 1;
                page.invalidations = page.invalidations.saturating_add(1);
                page.visits = 0;
                page.attempts = 0;
                page.failed = false;
                page.served.clear();
                page.seeds.clear();
                page.declined.clear();
                page.range = false;
                page.partners.clear();
                page.physical = None;
            }
        }
    }
}
