//! Access cache for compiled page functions. Per core, per privilege and per
//! access kind, a direct-mapped table of linear 4 KiB pages whose current
//! translation is plain RAM (and, for writes, holds no compiled code). Page
//! functions look entries up inline; a miss goes to `pages::x64_page_access`.
//!
//! Entries are only ever derived from a successful runtime translation, so a
//! hit is as valid as the x64 TLB entry it came from: every invalidation of a
//! core's x64 TLB (CR writes, INVLPG, EFER, mapping changes, restore) retires
//! that core's entries, and a page that gains compiled code retires the write
//! entries of all cores. Retiring is an epoch step, part of each entry's tag.
use super::physical;
use crate::cpu::memory;

pub const ENTRIES: usize = 1024;
pub const ENTRY_BYTES: u32 = 16;
pub const TABLE_BYTES: u32 = ENTRIES as u32 * ENTRY_BYTES;
/// Write tables follow the two read tables (supervisor, user).
pub const WRITE_OFFSET: u32 = 2 * TABLE_BYTES;
/// Tag bits above the largest linear page number of a canonical address.
pub const EPOCH_SHIFT: u32 = 52;
const EPOCH_LIMIT: u64 = 1 << (64 - EPOCH_SHIFT);

#[derive(Clone, Copy)]
#[repr(C)]
struct Entry {
    tag: u64,
    host: u32,
    _pad: u32,
}
#[repr(C, align(16))]
struct Core {
    /// read supervisor, read user, write supervisor, write user
    tables: [[Entry; ENTRIES]; 4],
    /// Never 0, so zeroed entries never match.
    epoch: u64,
}
const EMPTY: Entry = Entry {
    tag: 0,
    host: 0,
    _pad: 0,
};
static mut JAC: [Core; 8] = [const {
    Core {
        tables: [[EMPTY; ENTRIES]; 4],
        epoch: 1,
    }
}; 8];

/// Read table base of `core` for the given privilege (host address).
pub unsafe fn base(core: usize, user: bool) -> u32 {
    std::ptr::addr_of!(JAC[core].tables[user as usize]) as u32
}
/// Tag bits for entries of `core` in its current epoch.
pub unsafe fn epoch_bits(core: usize) -> u64 { JAC[core].epoch << EPOCH_SHIFT }

pub unsafe fn flush(core: usize) {
    let c = &mut JAC[core];
    c.epoch += 1;
    if c.epoch == EPOCH_LIMIT {
        c.tables = [[EMPTY; ENTRIES]; 4];
        c.epoch = 1;
    }
}
pub unsafe fn flush_all() {
    for core in 0..8 {
        flush(core);
    }
}

/// Record that the linear page of `address` translates to the RAM backing
/// page `backing` (page aligned) for this access kind and privilege.
pub unsafe fn fill(core: usize, user: bool, write: bool, address: u64, backing: u32) {
    let page = address >> 12;
    let c = &mut JAC[core];
    c.tables[write as usize * 2 + user as usize][page as usize & (ENTRIES - 1)] = Entry {
        tag: page | c.epoch << EPOCH_SHIFT,
        host: (memory::mem8 as u32).wrapping_add(backing),
        _pad: 0,
    };
}

/// The backing page of a guest physical page that page functions may access
/// directly: RAM through the physical bus, never a device or the VGA hole.
pub unsafe fn ram_backing(physical: u64) -> Option<u32> {
    // ram_page refuses device windows. Not in_mapped_range: the backing of
    // RAM relocated above 4 GiB is a hole of the low bus, yet plain RAM here.
    let page = physical::ram_page(physical & !4095).ok()?;
    if (0xA0000..0xC0000).contains(&page.backing) {
        return None;
    }
    Some(page.backing)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tags_retire_by_epoch_and_never_match_zeroed_entries() {
        unsafe {
            let before = epoch_bits(3);
            assert_ne!(before, 0);
            fill(3, true, true, 0xFFFF_8000_1234_5678, 0x5000);
            let page = 0xFFFF_8000_1234_5678u64 >> 12;
            let e = JAC[3].tables[3][page as usize & (ENTRIES - 1)];
            assert_eq!(e.tag, page | before);
            // the largest canonical page number stays below the epoch bits
            assert_eq!((u64::MAX >> 12) >> EPOCH_SHIFT, 0);
            flush(3);
            assert_ne!(epoch_bits(3), before);
            assert_ne!(e.tag, page | epoch_bits(3));
            for _ in 0..EPOCH_LIMIT {
                flush(3);
            }
            assert_ne!(JAC[3].epoch, 0);
            assert_eq!(
                JAC[3].tables[3][page as usize & (ENTRIES - 1)].tag & !(!0 << EPOCH_SHIFT),
                0
            );
        }
    }
}
