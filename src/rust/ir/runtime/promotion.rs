//! Cache-resident promotion heat is scheduling evidence only. Every alias keeps
//! independent saturating heat; failure fingerprints include the entire Tier-2
//! capture, which may extend beyond the existing Tier-1 owner's source.
use super::{compile::ImmutableCodeSnapshot, entry::CpuEntryKey};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Ticket {
    pub entry: CpuEntryKey,
    pub owner: u64,
}

pub(super) struct Alias {
    pub entry: CpuEntryKey,
    pub hits: u32,
    pub failed: Option<Option<ImmutableCodeSnapshot>>,
}
impl Alias {
    pub fn new(entry: CpuEntryKey) -> Self {
        Self {
            entry,
            hits: 0,
            failed: None,
        }
    }
    #[inline(always)]
    pub fn visit(&mut self) { self.hits = self.hits.saturating_add(1); }
    pub fn reset(&mut self) {
        self.hits = 0;
        self.failed = None;
    }
    pub fn suppressed(&self, source: &Option<ImmutableCodeSnapshot>) -> bool {
        self.failed.as_ref().is_some_and(|old| match (old, source) {
            (Some(a), Some(b)) => a.bytes == b.bytes && a.mappings == b.mappings,
            (None, None) => true,
            _ => false,
        })
    }
}

#[derive(Clone)]
pub(super) struct Attempt {
    pub ticket: Ticket,
    pub source: ImmutableCodeSnapshot,
}

/// Record and alias positions are only scan cursors, never owner identities.
/// Compaction may move them; each returned candidate still carries a full ticket.
#[derive(Clone, Copy, Default)]
pub(super) struct Cursor {
    record: usize,
    alias: usize,
}
impl Cursor {
    pub const fn new() -> Self {
        Self {
            record: 0,
            alias: 0,
        }
    }
    pub fn next(&mut self, records: usize, aliases: impl FnOnce(usize) -> usize) -> Option<(usize, usize)> {
        if records == 0 {
            return None;
        }
        self.record %= records;
        let count = aliases(self.record);
        if self.alias >= count.max(1) {
            self.alias = 0;
        }
        let position = (self.record, self.alias);
        self.alias += 1;
        if self.alias >= count.max(1) {
            self.alias = 0;
            self.record = (self.record + 1) % records;
        }
        Some(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::frontend::decode::{GuestEip, LinearAddress};
    fn key(pc: u32) -> CpuEntryKey {
        CpuEntryKey {
            pc: GuestEip(pc),
            linear: LinearAddress(pc),
            default_32: true,
        }
    }
    #[test]
    fn alias_heat_saturates_independently_and_reset_clears_failure() {
        let mut a = Alias::new(key(1));
        let mut b = Alias::new(key(2));
        for _ in 0..9 {
            a.visit();
        }
        b.visit();
        assert_eq!((a.hits, b.hits), (9, 1));
        a.hits = u32::MAX;
        a.visit();
        assert_eq!(a.hits, u32::MAX);
        a.failed = Some(None);
        assert!(a.suppressed(&None));
        a.reset();
        assert_eq!(a.hits, 0);
        assert!(!a.suppressed(&None));
        assert_eq!(b.hits, 1);
        assert_ne!(
            Ticket {
                entry: key(1),
                owner: 1
            },
            Ticket {
                entry: key(1),
                owner: 1 << 32 | 1
            }
        );
    }
    #[test]
    fn failed_capture_compares_full_bytes_and_mappings() {
        use super::super::compile::CodeMapping;
        use crate::ir::frontend::decode::PhysicalAddress;
        let source = ImmutableCodeSnapshot {
            bytes: vec![0x40, 0x90, 0x90],
            dependencies: vec![],
            mappings: vec![CodeMapping {
                linear: LinearAddress(0x1000),
                physical: PhysicalAddress(0x2000),
            }],
        };
        let mut a = Alias::new(key(0x1000));
        assert!(!a.suppressed(&Some(source.clone())));
        a.failed = Some(None);
        assert!(!a.suppressed(&Some(source.clone())));
        a.failed = Some(Some(source.clone()));
        assert!(a.suppressed(&Some(source.clone())));
        assert!(!a.suppressed(&None));
        let mut bytes = source.clone();
        bytes.bytes[2] = 0xF8;
        assert!(!a.suppressed(&Some(bytes)));
        let mut mapping = source;
        mapping.mappings[0].physical = PhysicalAddress(0x3000);
        assert!(!a.suppressed(&Some(mapping)));
    }
    #[test]
    fn bounded_scan_keeps_ready_entries_beyond_the_hot_ring() {
        let counts: Vec<_> = (0..160).map(|i| if i == 10 { 4 } else { 1 }).collect();
        let mut cursor = Cursor::new();
        let mut seen = std::collections::BTreeSet::new();
        for _frame in 0..2 {
            for _ in 0..128 {
                seen.insert(cursor.next(counts.len(), |i| counts[i]).unwrap());
            }
        }
        assert_eq!(seen.len(), 163);
        // Compaction and partial alias supersession cannot leave an invalid cursor.
        assert_eq!(cursor.next(1, |_| 1), Some((0, 0)));
        assert_eq!(cursor.next(0, |_| unreachable!()), None);
    }
}
