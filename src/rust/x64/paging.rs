//! Four-level translation for the 48-linear/36-physical Intel profile.
//! The same walk serves execution and compilation. Snapshot walks never set
//! A/D or deliver an exception, and a bus can reject unsafe (MMIO) peeks.
use super::state::{canonical, LinearAddress, PhysicalAddress};

pub const PHYSICAL_BITS: u8 = 36;
pub const PHYSICAL_MASK: u64 = (1 << PHYSICAL_BITS) - 1;
const ADDRESS: u64 = 0x000F_FFFF_FFFF_F000;
const NX: u64 = 1 << 63;
pub const TLB_SNAPSHOT_DWORDS: usize = 18;
pub const TLB_CAPACITY: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Access { Read, Write, Execute }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalkMode { Runtime, Snapshot }
#[derive(Clone, Copy, Debug)]
pub struct Controls {
    pub cr3: u64,
    pub user: bool,
    pub write_protect: bool,
    pub nx_enable: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Fault {
    NonCanonical(LinearAddress),
    Page { address: LinearAddress, error: u32, level: u8 },
    Unavailable(PhysicalAddress),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Translation {
    pub physical: PhysicalAddress,
    pub page_shift: u8,
    pub writable: bool,
    pub user: bool,
    pub executable: bool,
    pub global: bool,
    // Complete physical witnesses, including paging structures above 4 GiB.
    pub witnesses: [PhysicalAddress; 4],
    pub witness_count: u8,
}
pub trait PageTableMemory {
    fn read_entry(&mut self, address: PhysicalAddress, mode: WalkMode) -> Option<u64>;
    fn write_entry(&mut self, address: PhysicalAddress, value: u64) -> bool;
}

pub fn walk<M: PageTableMemory>(memory: &mut M, address: LinearAddress,
    access: Access, controls: Controls, mode: WalkMode) -> Result<Translation, Fault> {
    if !canonical(address.0, 48) { return Err(Fault::NonCanonical(address)); }
    let error = (access == Access::Write) as u32 * 2 | (controls.user as u32) * 4 |
        ((access == Access::Execute && controls.nx_enable) as u32) * 16;
    let page_fault = |present, reserved, level| Fault::Page {
        address, error: error | present as u32 | ((reserved as u32) << 3), level,
    };
    let mut table = controls.cr3 & PHYSICAL_MASK & !0xFFF;
    let mut writable = true;
    let mut user = true;
    let mut executable = true;
    let mut witnesses = [PhysicalAddress(0); 4];
    for level in (1u8..=4).rev() {
        let shift = 12 + (level - 1) * 9;
        let entry_address = PhysicalAddress(table + ((address.0 >> shift) & 511) * 8);
        witnesses[(4 - level) as usize] = entry_address;
        let entry = memory.read_entry(entry_address, mode).ok_or(Fault::Unavailable(entry_address))?;
        if entry & 1 == 0 { return Err(page_fault(false, false, level)); }
        let large = level > 1 && entry & 0x80 != 0;
        if entry & ADDRESS & !PHYSICAL_MASK != 0 || !controls.nx_enable && entry & NX != 0 ||
            large && level != 2 || large && entry & 0x1F_E000 != 0 {
            return Err(page_fault(true, true, level));
        }
        writable &= entry & 2 != 0;
        user &= entry & 4 != 0;
        executable &= entry & NX == 0;
        if mode == WalkMode::Runtime && entry & 0x20 == 0 &&
            !memory.write_entry(entry_address, entry | 0x20) {
            return Err(Fault::Unavailable(entry_address));
        }
        if level == 1 || large {
            if controls.user && !user || access == Access::Write && !writable &&
                (controls.user || controls.write_protect) || access == Access::Execute && !executable {
                return Err(page_fault(true, false, level));
            }
            if mode == WalkMode::Runtime && access == Access::Write && entry & 0x40 == 0 &&
                !memory.write_entry(entry_address, entry | 0x60) {
                return Err(Fault::Unavailable(entry_address));
            }
            let page_shift = if large { 21 } else { 12 };
            let offset_mask = (1u64 << page_shift) - 1;
            return Ok(Translation { physical: PhysicalAddress((entry & ADDRESS & !offset_mask) | (address.0 & offset_mask)),
                page_shift, writable, user, executable, global: entry & 0x100 != 0,
                witnesses, witness_count: 5 - level });
        }
        table = entry & ADDRESS;
    }
    unreachable!()
}

/// A bounded, full-tag translation cache. No allocation proportional to the
/// guest linear page number, and no low-32-bit address aliases.
pub struct Tlb {
    entries: [Option<Cached>; TLB_CAPACITY],
    epoch: u64,
}
#[derive(Clone, Copy)]
struct Cached { linear_page: u64, cr3: u64, control: u8, epoch: u64, value: Translation }
impl Default for Tlb { fn default() -> Self { Self::new() } }
impl Tlb {
    pub const fn new() -> Self { Self { entries: [None; 256], epoch: 1 } }
    fn control(access: Access, c: Controls) -> u8 {
        access as u8 | (c.user as u8) << 2 | (c.write_protect as u8) << 3 | (c.nx_enable as u8) << 4
    }
    fn slot(address: LinearAddress) -> usize { ((address.0 >> 12) ^ (address.0 >> 32)) as usize & 255 }
    pub fn lookup(&self, address: LinearAddress, access: Access, c: Controls) -> Option<Translation> {
        let entry = self.entries[Self::slot(address)]?;
        if entry.epoch != self.epoch || entry.linear_page != address.0 >> 12 ||
            entry.cr3 != c.cr3 || entry.control != Self::control(access, c) { return None; }
        let mut value = entry.value;
        value.physical.0 = (value.physical.0 & !4095) | (address.0 & 4095);
        Some(value)
    }
    pub fn insert(&mut self, address: LinearAddress, access: Access, c: Controls, value: Translation) {
        self.entries[Self::slot(address)] = Some(Cached { linear_page: address.0 >> 12,
            cr3: c.cr3, control: Self::control(access, c), epoch: self.epoch, value });
    }
    pub fn invalidate(&mut self, address: LinearAddress) {
        for slot in &mut self.entries {
            if slot.is_some_and(|entry| (entry.linear_page << 12) >> entry.value.page_shift == address.0 >> entry.value.page_shift) {
                *slot = None;
            }
        }
    }
    pub fn clear(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 { self.entries = [None; 256]; }
    }

    /// Portable architectural cache state. Keep stale translations until an
    /// architectural invalidation, rather than re-walking modified tables on
    /// restore. Epochs and native layout/pointers are deliberately excluded.
    pub fn snapshot(&self) -> Vec<u32> {
        let mut records = Vec::new();
        for entry in self.entries.iter().flatten().filter(|entry| entry.epoch == self.epoch) {
            let value = entry.value;
            records.extend_from_slice(&[
                entry.linear_page as u32, (entry.linear_page >> 32) as u32,
                entry.cr3 as u32, (entry.cr3 >> 32) as u32, entry.control as u32,
                value.physical.0 as u32, (value.physical.0 >> 32) as u32,
                value.page_shift as u32,
                value.writable as u32 | (value.user as u32) << 1 |
                    (value.executable as u32) << 2 | (value.global as u32) << 3,
                value.witness_count as u32,
            ]);
            for witness in value.witnesses {
                records.push(witness.0 as u32);
                records.push((witness.0 >> 32) as u32);
            }
        }
        records
    }

    /// Validate the entire portable cache before committing. No page-table
    /// access, A/D update, guest exception, or implicit invalidation occurs.
    pub fn restore_snapshot(&mut self, records: &[u32]) -> bool {
        if records.len() % TLB_SNAPSHOT_DWORDS != 0 ||
            records.len() / TLB_SNAPSHOT_DWORDS > TLB_CAPACITY { return false; }
        let mut candidate = Tlb::new();
        for record in records.chunks_exact(TLB_SNAPSHOT_DWORDS) {
            let wide = |index: usize| record[index] as u64 | (record[index + 1] as u64) << 32;
            let linear_page = wide(0);
            let cr3 = wide(2);
            let control = record[4];
            let physical = wide(5);
            let page_shift = record[7];
            let flags = record[8];
            let witness_count = record[9];
            if linear_page > u64::MAX >> 12 || !canonical(linear_page << 12, 48) ||
                cr3 > PHYSICAL_MASK || physical > PHYSICAL_MASK ||
                control & !31 != 0 || control & 3 == 3 || flags & !15 != 0 ||
                !matches!((page_shift, witness_count), (12, 4) | (21, 3)) {
                return false;
            }
            let address = LinearAddress(linear_page << 12);
            let slot = Self::slot(address);
            if candidate.entries[slot].is_some() { return false; }
            let mut witnesses = [PhysicalAddress(0); 4];
            for (index, witness) in witnesses.iter_mut().enumerate() {
                let physical = wide(10 + index * 2);
                if index < witness_count as usize {
                    if physical > PHYSICAL_MASK - 7 || physical & 7 != 0 { return false; }
                } else if physical != 0 { return false; }
                *witness = PhysicalAddress(physical);
            }
            let value = Translation { physical: PhysicalAddress(physical), page_shift: page_shift as u8,
                writable: flags & 1 != 0, user: flags & 2 != 0, executable: flags & 4 != 0,
                global: flags & 8 != 0, witnesses, witness_count: witness_count as u8 };
            let user = control & 4 != 0;
            let write_protect = control & 8 != 0;
            let nx_enable = control & 16 != 0;
            if user && !value.user || control & 3 == Access::Write as u32 && !value.writable &&
                (user || write_protect) || control & 3 == Access::Execute as u32 && !value.executable ||
                !nx_enable && !value.executable ||
                page_shift == 21 && physical & 0x1FF000 != address.0 & 0x1FF000 { return false; }
            candidate.entries[slot] = Some(Cached { linear_page, cr3, control: control as u8,
                epoch: candidate.epoch, value });
        }
        *self = candidate;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[derive(Clone)]
    struct Memory { words: BTreeMap<u64, u64>, writes: usize }
    impl PageTableMemory for Memory {
        fn read_entry(&mut self, address: PhysicalAddress, _: WalkMode) -> Option<u64> { self.words.get(&address.0).copied() }
        fn write_entry(&mut self, address: PhysicalAddress, value: u64) -> bool {
            self.writes += 1; self.words.insert(address.0, value); true
        }
    }
    fn fixture(address: u64, large: bool) -> (Memory, Controls, Vec<u64>) {
        let c = Controls { cr3: 0x1_0000_1000, user: false, write_protect: true, nx_enable: true };
        let mut words = BTreeMap::new();
        let mut entries = Vec::new();
        for level in (if large { 2 } else { 1 }..=4).rev() {
            let table = 0x1_0000_1000 + (4 - level) * 4096;
            let at = table + ((address >> (12 + (level - 1) * 9)) & 511) * 8;
            let value = if level == 1 || large && level == 2 { 0xF_1000_0000 | if large { 0x87 } else { 7 } }
                else { table + 4096 | 7 };
            words.insert(at, value); entries.push(at);
        }
        (Memory { words, writes: 0 }, c, entries)
    }
    #[test]
    fn full_addresses_small_large_pages_and_snapshot_purity() {
        for linear in [0x1234, 0x7FFF_FFFF_F234, 0xFFFF_8000_0000_1234, 0xFFFF_FFFF_FFFF_F234] {
            for large in [false, true] {
                let (mut memory, controls, entries) = fixture(linear, large);
                let before = memory.words.clone();
                let result = walk(&mut memory, LinearAddress(linear), Access::Write, controls, WalkMode::Snapshot).unwrap();
                assert_eq!(result.physical.0, 0xF_1000_0000 | linear & if large { 0x1F_FFFF } else { 4095 });
                assert_eq!(memory.words, before);
                assert_eq!(memory.writes, 0);
                assert!(result.witnesses[0].0 > u32::MAX as u64);
                assert_eq!(walk(&mut memory, LinearAddress(linear), Access::Write, controls, WalkMode::Runtime), Ok(result));
                for at in &entries { assert_ne!(memory.words[at] & 0x20, 0); }
                assert_ne!(memory.words[entries.last().unwrap()] & 0x40, 0);
            }
        }
    }
    #[test]
    fn faults_permissions_reserved_nx_and_canonical_priority() {
        for level in 0..4 {
            for (bits, access, expected) in [(0, Access::Read, 4), (1, Access::Read, 5),
                (5, Access::Write, 7), (7 | NX, Access::Execute, 21), (7 | 1 << 36, Access::Read, 13)] {
                let (mut memory, mut c, entries) = fixture(0x1234, false);
                c.user = true;
                memory.words.insert(entries[level], (memory.words[&entries[level]] & ADDRESS) | bits);
                assert!(matches!(walk(&mut memory, LinearAddress(0x1234), access, c, WalkMode::Runtime),
                    Err(Fault::Page { error, .. }) if error == expected));
            }
        }
        let (mut memory, c, _) = fixture(0, false);
        assert!(matches!(walk(&mut memory, LinearAddress(0x8000_0000_0000), Access::Read, c, WalkMode::Runtime), Err(Fault::NonCanonical(_))));
        assert_eq!(memory.writes, 0);
        for nx in [false, true] {
            let (mut memory, mut c, entries) = fixture(0, false);
            c.nx_enable = nx;
            memory.words.insert(entries[0], memory.words[&entries[0]] | NX);
            assert!(matches!(walk(&mut memory, LinearAddress(0), Access::Execute, c, WalkMode::Runtime),
                Err(Fault::Page { error, .. }) if error == if nx { 17 } else { 9 }));
        }
    }
    #[test]
    fn rejects_unadvertised_gigabyte_pages_and_reserved_large_address_bits() {
        for (level, bit) in [(0, 7), (1, 7), (2, 13), (2, 20), (2, 36)] {
            let (mut memory, c, entries) = fixture(0, true);
            memory.words.insert(entries[level], memory.words[&entries[level]] | 1 << bit);
            assert!(matches!(walk(&mut memory, LinearAddress(0), Access::Read, c, WalkMode::Snapshot), Err(Fault::Page { error: 9, .. })));
        }
    }
    #[test]
    fn supervisor_write_protect_and_full_tag_tlb_isolation() {
        let (mut memory, mut c, entries) = fixture(0x1234, false);
        let last = *entries.last().unwrap();
        memory.words.insert(last, memory.words[&last] & !2);
        c.write_protect = false;
        let translated = walk(&mut memory, LinearAddress(0x1234), Access::Write, c, WalkMode::Runtime).unwrap();
        let mut a = Tlb::new(); let mut b = Tlb::new();
        a.insert(LinearAddress(0x1234), Access::Write, c, translated);
        b.insert(LinearAddress(0x1234), Access::Write, c, translated);
        assert_eq!(a.lookup(LinearAddress(0x1_0000_1234), Access::Write, c), None);
        assert_eq!(a.lookup(LinearAddress(0xFFFF_8000_0000_1234), Access::Write, c), None);
        assert_eq!(a.lookup(LinearAddress(0x1235), Access::Write, c).unwrap().physical.0, translated.physical.0 + 1);
        a.invalidate(LinearAddress(0x1234));
        assert!(a.lookup(LinearAddress(0x1234), Access::Write, c).is_none());
        assert!(b.lookup(LinearAddress(0x1234), Access::Write, c).is_some());
        b.clear(); assert!(b.lookup(LinearAddress(0x1234), Access::Write, c).is_none());
    }

    #[test]
    fn portable_tlb_preserves_high_tags_witnesses_and_stale_translation() {
        for linear in [0x1234, 0x7FFF_FFFF_F234, 0xFFFF_8000_0000_1234] {
            for large in [false, true] {
                let address = LinearAddress(linear);
                let (mut memory, controls, entries) = fixture(linear, large);
                let translated = walk(&mut memory, address, Access::Write, controls, WalkMode::Runtime).unwrap();
                let mut before = Tlb::new();
                before.insert(address, Access::Write, controls, translated);
                let records = before.snapshot();
                assert_eq!(records.len(), TLB_SNAPSHOT_DWORDS);
                assert_eq!(records[6], 15, "physical high DWORD survives");
                assert_eq!(records[11], 1, "page-table witness high DWORD survives");
                let leaf = *entries.last().unwrap();
                memory.words.insert(leaf, memory.words[&leaf] ^ 0x200000);
                let writes_before_restore = memory.writes;
                let mut after = Tlb::new();
                assert!(after.restore_snapshot(&records));
                assert_eq!(after.snapshot(), records);
                assert_eq!(after.lookup(address, Access::Write, controls), Some(translated));
                assert_eq!(after.lookup(LinearAddress(linear + 1), Access::Write, controls),
                    before.lookup(LinearAddress(linear + 1), Access::Write, controls));
                assert!(after.lookup(address, Access::Read, controls).is_none());
                let other_cr3 = Controls { cr3: controls.cr3 + 4096, ..controls };
                assert!(after.lookup(address, Access::Write, other_cr3).is_none());
                assert_eq!(memory.writes, writes_before_restore, "restore performs no page walk or A/D updates");
                after.invalidate(address);
                assert!(after.lookup(address, Access::Write, controls).is_none());
                let fresh = walk(&mut memory, address, Access::Write, controls, WalkMode::Runtime).unwrap();
                assert_ne!(fresh.physical, translated.physical);
            }
        }
    }

    #[test]
    fn portable_tlb_exports_only_live_epoch_and_empty_restore_clears() {
        let address = LinearAddress(0x1234);
        let (mut memory, controls, _) = fixture(address.0, false);
        let value = walk(&mut memory, address, Access::Read, controls, WalkMode::Runtime).unwrap();
        let mut cache = Tlb::new();
        cache.insert(address, Access::Read, controls, value);
        cache.clear();
        assert!(cache.snapshot().is_empty());
        cache.insert(address, Access::Read, controls, value);
        assert!(cache.restore_snapshot(&[]));
        assert!(cache.lookup(address, Access::Read, controls).is_none());
        assert!(cache.snapshot().is_empty());
    }

    #[test]
    fn portable_tlb_invalid_record_rejects_entire_transaction() {
        let address = LinearAddress(0x1234);
        let (mut memory, controls, _) = fixture(address.0, false);
        let value = walk(&mut memory, address, Access::Write, controls, WalkMode::Runtime).unwrap();
        let mut cache = Tlb::new();
        cache.insert(address, Access::Write, controls, value);
        let records = cache.snapshot();
        for (index, invalid) in [(1, 8), (1, 0x100000), (3, 16), (4, 32), (4, 3),
            (6, 16), (7, 13), (8, 16), (8, 6), (9, 3), (10, 1), (11, 16)] {
            let mut bad = records.clone();
            bad[index] = invalid;
            assert!(!cache.restore_snapshot(&bad), "field {index}, invalid {invalid}");
            assert_eq!(cache.snapshot(), records);
            assert_eq!(cache.lookup(address, Access::Write, controls), Some(value));
        }
        for bad in [records[..17].to_vec(), records.repeat(2), records.repeat(TLB_CAPACITY + 1)] {
            assert!(!cache.restore_snapshot(&bad));
            assert_eq!(cache.snapshot(), records);
        }
        let mut colliding = records.repeat(2);
        colliding[TLB_SNAPSHOT_DWORDS] += 256;
        assert!(!cache.restore_snapshot(&colliding), "different tags cannot occupy the same direct-mapped slot");
        assert_eq!(cache.snapshot(), records);
    }

    #[test]
    fn portable_large_page_invlpg_and_unused_witness_validation() {
        let controls = fixture(0, true).1;
        let mut cache = Tlb::new();
        for linear in [0x1234, 0x2345] {
            let (mut memory, _, _) = fixture(linear, true);
            let mut value = walk(&mut memory, LinearAddress(linear), Access::Read, controls, WalkMode::Runtime).unwrap();
            value.global = true;
            cache.insert(LinearAddress(linear), Access::Read, controls, value);
        }
        let records = cache.snapshot();
        let mut restored = Tlb::new();
        assert!(restored.restore_snapshot(&records));
        assert!(restored.lookup(LinearAddress(0x1234), Access::Read, controls).unwrap().global);
        let mut bad = records.clone();
        bad[16] = 8;
        assert!(!restored.restore_snapshot(&bad), "unused witness must remain zero");
        assert_eq!(restored.snapshot(), records);
        bad = records.clone();
        bad[5] ^= 4096;
        assert!(!restored.restore_snapshot(&bad), "large page must preserve the linear subpage offset");
        restored.invalidate(LinearAddress(0x1F_F000));
        assert!(restored.snapshot().is_empty(), "INVLPG evicts all cached subpages of the large translation");
    }

    #[test]
    fn portable_tlb_preserves_supervisor_wp_bypass_permissions() {
        let address = LinearAddress(0x1234);
        let (mut memory, mut controls, entries) = fixture(address.0, false);
        controls.write_protect = false;
        let leaf = *entries.last().unwrap();
        memory.words.insert(leaf, memory.words[&leaf] & !2);
        let value = walk(&mut memory, address, Access::Write, controls, WalkMode::Runtime).unwrap();
        assert!(!value.writable);
        let mut cache = Tlb::new();
        cache.insert(address, Access::Write, controls, value);
        let records = cache.snapshot();
        assert!(cache.restore_snapshot(&records));
        assert_eq!(cache.lookup(address, Access::Write, controls), Some(value));
        let protected = Controls { write_protect: true, ..controls };
        assert!(cache.lookup(address, Access::Write, protected).is_none());
    }
}
