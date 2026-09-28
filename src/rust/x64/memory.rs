//! Wide linear accesses. Validate every touched page before device reads or
//! writes; one element of an atomic/string operation is a complete transaction.
use super::{paging, physical, state};
use super::paging::{Access, Controls, Tlb, WalkMode};
use super::state::LinearAddress;
use crate::cpu::{apic, global_pointers as gp};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fault {
    pub vector: u8,
    pub error: Option<u32>,
    pub address: Option<u64>,
}
impl Fault {
    pub fn gp() -> Self { Self { vector: 13, error: Some(0), address: None } }
    pub fn ud() -> Self { Self { vector: 6, error: None, address: None } }
    pub fn de() -> Self { Self { vector: 0, error: None, address: None } }
}
static mut X64_TLBS: [Tlb; 8] = [const { Tlb::new() }; 8];
// Compiled-code access cache entries derive from these TLBs: retire them too.
pub unsafe fn invalidate_all_tlbs() { for core in 0..8 { X64_TLBS[core].clear(); } super::jac::flush_all(); }
pub unsafe fn invalidate_core(core: usize) { X64_TLBS[core].clear(); super::jac::flush(core); }
pub unsafe fn invlpg(address: u64) {
    let core = apic::current_core();
    X64_TLBS[core].invalidate(LinearAddress(address));
    super::jac::flush(core);
}

/// Compilation observes the same stale translations as execution, but never
/// fills a cache, updates A/D, reads an MMIO page table, or delivers a fault.
pub unsafe fn snapshot_translation(address: u64, access: Access) -> Option<paging::Translation> {
    let controls = Controls { cr3: state::read_cr(3), user: *gp::cpl == 3,
        write_protect: state::read_cr(0) & 0x10000 != 0, nx_enable: state::efer() & state::EFER_NXE != 0 };
    X64_TLBS[apic::current_core()].lookup(LinearAddress(address), access, controls).or_else(||
        paging::walk(&mut physical::PageTables, LinearAddress(address), access, controls, WalkMode::Snapshot).ok())
}

// Snapshot transfer buffers are host-owned allocations (v86_malloc/free), not
// guest physical addresses. Each valid record contains 18 portable DWORDs;
// zero records restores an empty cache. All callers run at a CPU safe point.
#[no_mangle]
pub unsafe extern "C" fn x64_tlb_snapshot_dwords(core: u32) -> i32 {
    if core >= 8 { return -1; }
    X64_TLBS[core as usize].snapshot().len() as i32
}

#[no_mangle]
pub unsafe extern "C" fn x64_tlb_snapshot_write(core: u32, data: u32, capacity: u32) -> i32 {
    if core >= 8 { return -1; }
    let records = X64_TLBS[core as usize].snapshot();
    if (capacity as usize) < records.len() || !records.is_empty() && (data == 0 || data & 3 != 0) {
        return -1;
    }
    if !records.is_empty() { std::ptr::copy_nonoverlapping(records.as_ptr(), data as *mut u32, records.len()); }
    records.len() as i32
}

unsafe fn snapshot_records<'a>(data: u32, count: u32) -> Option<&'a [u32]> {
    if count as usize > paging::TLB_CAPACITY * paging::TLB_SNAPSHOT_DWORDS ||
        count as usize % paging::TLB_SNAPSHOT_DWORDS != 0 { return None; }
    if count == 0 { return Some(&[]); }
    if data == 0 || data & 3 != 0 { return None; }
    Some(std::slice::from_raw_parts(data as *const u32, count as usize))
}

#[no_mangle]
pub unsafe extern "C" fn x64_tlb_snapshot_validate(data: u32, count: u32) -> bool {
    snapshot_records(data, count).is_some_and(|records| Tlb::new().restore_snapshot(records))
}

#[no_mangle]
pub unsafe extern "C" fn x64_tlb_snapshot_restore(core: u32, data: u32, count: u32) -> bool {
    if core >= 8 { return false; }
    let restored = snapshot_records(data, count).is_some_and(|records| X64_TLBS[core as usize].restore_snapshot(records));
    if restored { super::jac::flush(core as usize); }
    restored
}

pub unsafe fn translate(address: u64, access: Access, stack: bool, supervisor: bool) -> Result<u64, Fault> {
    translate_user(address, access, stack, !supervisor && *gp::cpl == 3)
}
pub unsafe fn translate_user(address: u64, access: Access, stack: bool, user: bool) -> Result<u64, Fault> {
    if !state::canonical(address, 48) {
        return Err(Fault { vector: if stack { 12 } else { 13 }, error: Some(0), address: None });
    }
    let c = Controls { cr3: state::read_cr(3), user,
        write_protect: state::read_cr(0) & 0x10000 != 0, nx_enable: state::efer() & state::EFER_NXE != 0 };
    let cache = &mut X64_TLBS[apic::current_core()];
    if let Some(physical) = cache.lookup_physical(LinearAddress(address), access, c) { return Ok(physical); }
    let result = paging::walk(&mut physical::PageTables, LinearAddress(address), access, c, WalkMode::Runtime)
        .map_err(|fault| match fault {
            paging::Fault::Page { address, error, .. } => Fault { vector: 14, error: Some(error), address: Some(address.0) },
            paging::Fault::NonCanonical(_) => Fault { vector: if stack { 12 } else { 13 }, error: Some(0), address: None },
            paging::Fault::Unavailable(_) => Fault::gp(),
        })?;
    cache.insert(LinearAddress(address), access, c, result);
    Ok(result.physical.0)
}

/// Physical bytes of one linear access: `head` bytes from `first`, the rest
/// from `second` when the access crosses a page.
#[derive(Clone, Copy)]
struct Span { first: u64, second: u64, head: usize, size: usize }
impl Span {
    fn byte(&self, i: usize) -> u64 {
        if i < self.head { self.first + i as u64 } else { self.second + (i - self.head) as u64 }
    }
    fn contiguous(&self) -> bool {
        self.head == self.size || self.second == self.first + self.head as u64
    }
}
unsafe fn preflight(address: u64, size: usize, access: Access, stack: bool, supervisor: bool) -> Result<Span, Fault> {
    assert!(matches!(size, 1 | 2 | 4 | 8 | 16));
    let first = translate(address, access, stack, supervisor)?;
    // Page order: the first page's bus check precedes the second page's walk.
    let head = size.min(4096 - (address & 4095) as usize);
    physical::probe(first, head).map_err(|_| Fault::gp())?;
    let mut second = 0;
    if head < size {
        second = translate(address.wrapping_add(head as u64), access, stack, supervisor)?;
        physical::probe(second, size - head).map_err(|_| Fault::gp())?;
    }
    Ok(Span { first, second, head, size })
}
fn read_physical(span: Span) -> Result<u128, Fault> {
    unsafe {
        if span.contiguous() {
            let at = span.first;
            return match span.size {
                1 => physical::read8(at).map(|v| v as u128),
                2 => physical::read16(at).map(|v| v as u128),
                4 => physical::read32(at).map(|v| v as u128),
                8 => physical::read64(at).map(|v| v as u128),
                16 => {
                    let lo = physical::read64(at).map_err(|_| Fault::gp())?;
                    let hi = physical::read64(at + 8).map_err(|_| Fault::gp())?;
                    return Ok(lo as u128 | (hi as u128) << 64);
                },
                _ => unreachable!(),
            }.map_err(|_| Fault::gp());
        }
        let mut value = 0;
        for i in 0..span.size {
            value |= (physical::read8(span.byte(i)).map_err(|_| Fault::gp())? as u128) << (i * 8);
        }
        Ok(value)
    }
}
fn write_physical(span: Span, value: u128) -> Result<(), Fault> {
    unsafe {
        if span.contiguous() {
            let at = span.first;
            return match span.size {
                1 => physical::write8(at, value as u8),
                2 => physical::write16(at, value as u16),
                4 => physical::write32(at, value as u32),
                8 => physical::write64(at, value as u64),
                16 => {
                    physical::write64(at, value as u64).map_err(|_| Fault::gp())?;
                    return physical::write64(at + 8, (value >> 64) as u64).map_err(|_| Fault::gp());
                },
                _ => unreachable!(),
            }.map_err(|_| Fault::gp());
        }
        for i in 0..span.size {
            physical::write8(span.byte(i), (value >> (i * 8)) as u8).map_err(|_| Fault::gp())?;
        }
        Ok(())
    }
}
pub unsafe fn read(address: u64, width: u8, stack: bool) -> Result<u64, Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    let value = read_physical(preflight(address, size, Access::Read, stack, false)?)? as u64;
    super::debug::data(address, size, false);
    Ok(value)
}
pub unsafe fn write(address: u64, width: u8, value: u64, stack: bool) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    write_physical(preflight(address, size, Access::Write, stack, false)?, value as u128)?;
    super::debug::data(address, size, true);
    Ok(())
}
pub unsafe fn read128(address: u64, stack: bool) -> Result<u128, Fault> {
    let value = read_physical(preflight(address, 16, Access::Read, stack, false)?)?;
    super::debug::data(address, 16, false);
    Ok(value)
}
pub unsafe fn write128(address: u64, value: u128, stack: bool) -> Result<(), Fault> {
    write_physical(preflight(address, 16, Access::Write, stack, false)?, value)?;
    super::debug::data(address, 16, true);
    Ok(())
}
pub unsafe fn fetch(address: u64) -> Result<u8, Fault> {
    let address = translate(address, Access::Execute, false, false)?;
    physical::read8(address).map_err(|_| Fault::gp())
}
/// Instruction fetch within one decode: `page` remembers the last linear to
/// physical code page, so each page is translated once per instruction.
pub unsafe fn fetch_cached(address: u64, page: &mut Option<(u64, u64)>) -> Result<u8, Fault> {
    let physical = match *page {
        Some((linear, physical)) if linear == address >> 12 => physical | (address & 4095),
        _ => {
            let physical = translate(address, Access::Execute, false, false)?;
            *page = Some((address >> 12, physical & !4095));
            physical
        },
    };
    if physical::plain_ram(physical, 1) {
        return Ok(*crate::cpu::memory::mem8.add(physical as usize));
    }
    physical::read8(physical).map_err(|_| Fault::gp())
}
pub unsafe fn read_system(address: u64, width: u8) -> Result<u64, Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    Ok(read_physical(preflight(address, size, Access::Read, false, true)?)? as u64)
}
pub unsafe fn write_system(address: u64, width: u8, value: u64) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    write_physical(preflight(address, size, Access::Write, true, true)?, value as u128)
}

pub unsafe fn probe_write(address: u64, width: u8, stack: bool) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64 | 128));
    preflight(address, (width / 8) as usize, Access::Write, stack, false).map(|_| ())
}

pub unsafe fn probe_read(address: u64, width: u8, stack: bool) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64 | 128));
    preflight(address, (width / 8) as usize, Access::Read, stack, false).map(|_| ())
}

pub unsafe fn probe_system_write(address: u64, width: u8) -> Result<(), Fault> {
    preflight(address, (width / 8) as usize, Access::Write, true, true).map(|_| ())
}

/// Bridge compatibility-mode instructions to the wide walker while preserving
/// the legacy memory helper ABI. A remapped page resolves to its backing page;
/// mapping changes flush all translations before this identity can change.
pub unsafe fn legacy_translate(address: u32, access: Access, user: bool, side_effects: bool) -> Result<u32, ()> {
    let physical = if side_effects {
        match translate_user(address as u64, access, false, user) {
            Ok(address) => address,
            Err(fault) => { super::system::raise(fault); return Err(()); },
        }
    } else {
        let c = Controls { cr3: state::read_cr(3), user,
            write_protect: state::read_cr(0) & 0x10000 != 0, nx_enable: state::efer() & state::EFER_NXE != 0 };
        paging::walk(&mut physical::PageTables, LinearAddress(address as u64), access, c, WalkMode::Snapshot)
            .map_err(|_| ())?.physical.0
    };
    physical::resolve_backing(physical).map_err(|_| ())
}
