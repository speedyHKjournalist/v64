//! Fixed storage for the scheduler's bounded entry set. Backshift deletion keeps
//! unsuccessful probes bounded after arbitrary replacement, without tombstones.
use super::entry::CpuEntryKey;
const SIZE: usize = 2048;
pub struct HotIndex {
    slots: [Option<(CpuEntryKey, usize)>; SIZE],
}
impl HotIndex {
    pub const fn new() -> Self {
        Self {
            slots: [None; SIZE],
        }
    }
    pub fn clear(&mut self) { self.slots.fill(None); }
    fn hash(key: CpuEntryKey) -> usize {
        let n = key.linear.0 ^ key.pc.0.rotate_left(13) ^ u32::from(key.default_32);
        (n.wrapping_mul(0x9E3779B1) >> (32 - SIZE.trailing_zeros())) as usize
    }
    pub fn get(&self, key: CpuEntryKey) -> Option<usize> {
        let mut at = Self::hash(key);
        for _ in 0..SIZE {
            let (saved, index) = self.slots[at]?;
            if saved == key {
                return Some(index);
            }
            at = (at + 1) & (SIZE - 1);
        }
        None
    }
    pub fn insert(&mut self, key: CpuEntryKey, index: usize) {
        let mut at = Self::hash(key);
        for _ in 0..SIZE {
            if self.slots[at].is_none_or(|(saved, _)| saved == key) {
                self.slots[at] = Some((key, index));
                return;
            }
            at = (at + 1) & (SIZE - 1);
        }
        unreachable!("scheduler entry bound must leave empty index slots");
    }
    pub fn remove(&mut self, key: CpuEntryKey) {
        let mut hole = Self::hash(key);
        for _ in 0..SIZE {
            match self.slots[hole] {
                None => return,
                Some((saved, _)) if saved == key => break,
                _ => hole = (hole + 1) & (SIZE - 1),
            }
        }
        self.slots[hole] = None;
        let mut at = (hole + 1) & (SIZE - 1);
        while let Some((saved, index)) = self.slots[at] {
            let home = Self::hash(saved);
            if hole.wrapping_sub(home) & (SIZE - 1) < at.wrapping_sub(home) & (SIZE - 1) {
                self.slots[hole] = Some((saved, index));
                self.slots[at] = None;
                hole = at;
            }
            at = (at + 1) & (SIZE - 1);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::frontend::decode::{GuestEip, LinearAddress};
    #[test]
    fn replacement_compaction_and_collisions_match_reference() {
        let mut index = HotIndex::new();
        let mut reference = std::collections::BTreeMap::new();
        let mut random = 0xA341316Cu32;
        let key = |n: u32| CpuEntryKey {
            linear: LinearAddress(0x100000 + (n % 128) * 4096),
            pc: GuestEip(0x100000 + (n % 512) * 4096),
            default_32: n & 512 != 0,
        };
        for step in 0..20000 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let n = random & 1023;
            if step % 509 == 0 {
                index.clear();
                reference.clear();
            }
            else if random & 1024 != 0 && reference.len() < 512 {
                index.insert(key(n), step);
                reference.insert(n, step);
            }
            else {
                index.remove(key(n));
                reference.remove(&n);
            }
            for probe in 0..1024 {
                assert_eq!(index.get(key(probe)), reference.get(&probe).copied());
            }
        }
    }
}
