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
    /// GLOBAL: from a global translation (kept by MOV CR3)
    flags: u32,
}
const GLOBAL: u32 = 1;
#[repr(C, align(16))]
struct Core {
    /// read supervisor, read user, write supervisor, write user
    tables: [[Entry; ENTRIES]; 4],
    /// Never 0, so zeroed entries never match.
    epoch: u64,
    /// 2 MiB linear regions (hashed to 1024 bits) with entries that came
    /// from a large page since the last flush: INVLPG in such a region
    /// flushes the core, anywhere else it retires one page's entries.
    large: [u64; LARGE_WORDS],
}
const LARGE_WORDS: usize = 16;
const EMPTY: Entry = Entry {
    tag: 0,
    host: 0,
    flags: 0,
};
static mut JAC: [Core; 8] = [const {
    Core {
        tables: [[EMPTY; ENTRIES]; 4],
        epoch: 1,
        large: [0; LARGE_WORDS],
    }
}; 8];
/// Some write entry maps the VGA frame buffer (see retire_frame_buffer_writes).
static mut FRAME_BUFFER_WRITES: bool = false;
fn region_bit(address: u64) -> (usize, u64) {
    let region = (address >> 21) as usize & (LARGE_WORDS * 64 - 1);
    (region / 64, 1 << (region % 64))
}

/// Read table base of `core` for the given privilege (host address).
pub unsafe fn base(core: usize, user: bool) -> u32 {
    std::ptr::addr_of!(JAC[core].tables[user as usize]) as u32
}
/// Tag bits for entries of `core` in its current epoch.
pub unsafe fn epoch_bits(core: usize) -> u64 { JAC[core].epoch << EPOCH_SHIFT }

pub unsafe fn flush(core: usize) {
    let c = &mut JAC[core];
    c.epoch += 1;
    c.large = [0; LARGE_WORDS];
    if c.epoch == EPOCH_LIMIT {
        c.tables = [[EMPTY; ENTRIES]; 4];
        c.epoch = 1;
    }
}
/// MOV CR3 on `core`: only the entries of global translations stay.
pub unsafe fn flush_nonglobal(core: usize) {
    let c = &mut JAC[core];
    for table in c.tables.iter_mut() {
        for entry in table.iter_mut() {
            if entry.flags & GLOBAL == 0 {
                entry.tag = 0;
            }
        }
    }
}
/// INVLPG `address` on `core`: its x64 TLB entries were invalidated. Entries
/// of 4 KiB translations live only in the page's own slot of each table; an
/// entry from a large page could be in any slot of the large page's range.
pub unsafe fn invlpg(core: usize, address: u64) {
    let c = &mut JAC[core];
    let (word, bit) = region_bit(address);
    if c.large[word] & bit != 0 {
        super::pages::COUNTERS[super::pages::COUNT_JAC_LARGE_FLUSH] += 1;
        flush(core);
        return;
    }
    let page = address >> 12;
    let tag = page | c.epoch << EPOCH_SHIFT;
    for table in c.tables.iter_mut() {
        let entry = &mut table[page as usize & (ENTRIES - 1)];
        if entry.tag == tag {
            entry.tag = 0;
        }
    }
}
/// The RAM backing page `backing` gained compiled code: page functions must
/// no longer store to it directly (on any core of this instance).
pub unsafe fn retire_writes_to(backing: u32) {
    retire_writes_to_host((memory::mem8 as u32).wrapping_add(backing));
}
/// The same for a page at host address `host` (an extended RAM frame)
pub unsafe fn retire_writes_to_host(host: u32) { retire_writes(|entry| entry.host == host); }
unsafe fn retire_writes(retire: impl Fn(&Entry) -> bool) {
    for core in 0..crate::cpu::apic::core_count().clamp(1, 8) {
        let c = &mut JAC[core];
        for table in c.tables[2..].iter_mut() {
            for entry in table.iter_mut() {
                if entry.tag != 0 && retire(entry) {
                    entry.tag = 0;
                }
            }
        }
    }
}
/// With cores in workers: another core published code from the RAM backing
/// page `backing` (crate::parallel::code::poll). Only `core` (this
/// instance's) has entries; its read entries and chaining stay valid.
pub unsafe fn retire_writes_on(core: usize, backing: u32) {
    let host = (memory::mem8 as u32).wrapping_add(backing);
    for table in JAC[core].tables[2..].iter_mut() {
        for entry in table.iter_mut() {
            if entry.tag != 0 && entry.host == host {
                entry.tag = 0;
            }
        }
    }
}
/// Write entries of device memory (a frame buffer) mark their page dirty
/// when they are filled. Once the device has taken its written pages, the
/// next write must mark them again.
pub unsafe fn retire_frame_buffer_writes() {
    if !FRAME_BUFFER_WRITES {
        return;
    }
    FRAME_BUFFER_WRITES = false;
    retire_writes(|entry| crate::cpu::mmio_ram::backs(entry.host));
}
pub unsafe fn flush_all() {
    for core in 0..8 {
        flush(core);
    }
}

/// Record that the linear page of `address` translates to the RAM backing
/// page `backing` (page aligned) for this access kind and privilege; `large`:
/// the translation is part of a 2 MiB or 1 GiB page.
pub unsafe fn fill(
    core: usize,
    user: bool,
    write: bool,
    address: u64,
    backing: u32,
    large: bool,
    global: bool,
) {
    let page = address >> 12;
    let c = &mut JAC[core];
    if large {
        let (word, bit) = region_bit(address);
        c.large[word] |= bit;
    }
    c.tables[write as usize * 2 + user as usize][page as usize & (ENTRIES - 1)] = Entry {
        tag: page | c.epoch << EPOCH_SHIFT,
        host: (memory::mem8 as u32).wrapping_add(backing),
        flags: if global { GLOBAL } else { 0 },
    };
}

/// The backing (relative to mem8) of the device memory page (a frame buffer,
/// crate::cpu::mmio_ram) at physical `address`, which page functions may
/// access directly: it is plain memory in the wasm heap. A write translation
/// marks the page dirty now (retire_frame_buffer_writes undoes it after the
/// device took the page). Not with cores in workers, whose caches the device
/// cannot reach.
pub unsafe fn frame_buffer_backing(address: u64, write: bool) -> Option<u32> {
    let page = address & !4095;
    // (with cores in workers, only the machine instance: it draws the screen)
    if crate::parallel::active() && !crate::parallel::machine_instance() || page >= 1 << 32 {
        return None;
    }
    // decoded by the legacy bus: no relocated RAM or aperture there
    if physical::resolve_backing(page).ok()? != page as u32 {
        return None;
    }
    let host = if write {
        let host = crate::cpu::mmio_ram::write_host(page as u32, 4096)?;
        FRAME_BUFFER_WRITES = true;
        host
    }
    else {
        crate::cpu::mmio_ram::read_host(page as u32, 4096)?
    };
    Some((host as u32).wrapping_sub(memory::mem8 as u32))
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
            fill(3, true, true, 0xFFFF_8000_1234_5678, 0x5000, false, false);
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
