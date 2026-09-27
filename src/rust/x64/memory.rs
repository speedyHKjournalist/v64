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
pub unsafe fn invalidate_all_tlbs() { for core in 0..8 { X64_TLBS[core].clear(); } }
pub unsafe fn invalidate_core(core: usize) { X64_TLBS[core].clear(); }
pub unsafe fn invlpg(address: u64) { X64_TLBS[apic::current_core()].invalidate(LinearAddress(address)); }

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
    snapshot_records(data, count).is_some_and(|records| X64_TLBS[core as usize].restore_snapshot(records))
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
    if let Some(hit) = cache.lookup(LinearAddress(address), access, c) { return Ok(hit.physical.0); }
    let result = paging::walk(&mut physical::PageTables, LinearAddress(address), access, c, WalkMode::Runtime)
        .map_err(|fault| match fault {
            paging::Fault::Page { address, error, .. } => Fault { vector: 14, error: Some(error), address: Some(address.0) },
            paging::Fault::NonCanonical(_) => Fault { vector: if stack { 12 } else { 13 }, error: Some(0), address: None },
            paging::Fault::Unavailable(_) => Fault::gp(),
        })?;
    cache.insert(LinearAddress(address), access, c, result);
    Ok(result.physical.0)
}

unsafe fn preflight(address: u64, size: usize, access: Access, stack: bool, supervisor: bool) -> Result<[u64; 16], Fault> {
    assert!(matches!(size, 1 | 2 | 4 | 8 | 16));
    let mut addresses = [0; 16];
    let first = translate(address, access, stack, supervisor)?;
    let mut base = first & !4095;
    for (i, target) in addresses[..size].iter_mut().enumerate() {
        let at = address.wrapping_add(i as u64);
        if i != 0 && at & 4095 == 0 { base = translate(at, access, stack, supervisor)? & !4095; }
        *target = base | (at & 4095);
        physical::probe(*target, 1).map_err(|_| Fault::gp())?;
    }
    Ok(addresses)
}
fn read_physical(addresses: &[u64]) -> Result<u128, Fault> {
    let size = addresses.len();
    unsafe {
        if addresses[size - 1] == addresses[0] + size as u64 - 1 {
            return match size {
                1 => physical::read8(addresses[0]).map(|v| v as u128),
                2 => physical::read16(addresses[0]).map(|v| v as u128),
                4 => physical::read32(addresses[0]).map(|v| v as u128),
                8 => physical::read64(addresses[0]).map(|v| v as u128),
                16 => {
                    let lo = physical::read64(addresses[0]).map_err(|_| Fault::gp())?;
                    let hi = physical::read64(addresses[8]).map_err(|_| Fault::gp())?;
                    return Ok(lo as u128 | (hi as u128) << 64);
                },
                _ => unreachable!(),
            }.map_err(|_| Fault::gp());
        }
        let mut value = 0;
        for (i, &physical_address) in addresses.iter().enumerate() {
            value |= (physical::read8(physical_address).map_err(|_| Fault::gp())? as u128) << (i * 8);
        }
        Ok(value)
    }
}
fn write_physical(addresses: &[u64], value: u128) -> Result<(), Fault> {
    let size = addresses.len();
    unsafe {
        if addresses[size - 1] == addresses[0] + size as u64 - 1 {
            return match size {
                1 => physical::write8(addresses[0], value as u8),
                2 => physical::write16(addresses[0], value as u16),
                4 => physical::write32(addresses[0], value as u32),
                8 => physical::write64(addresses[0], value as u64),
                16 => {
                    physical::write64(addresses[0], value as u64).map_err(|_| Fault::gp())?;
                    return physical::write64(addresses[8], (value >> 64) as u64).map_err(|_| Fault::gp());
                },
                _ => unreachable!(),
            }.map_err(|_| Fault::gp());
        }
        for (i, &physical_address) in addresses.iter().enumerate() {
            physical::write8(physical_address, (value >> (i * 8)) as u8).map_err(|_| Fault::gp())?;
        }
        Ok(())
    }
}
pub unsafe fn read(address: u64, width: u8, stack: bool) -> Result<u64, Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    let addresses = preflight(address, size, Access::Read, stack, false)?;
    let value = read_physical(&addresses[..size])? as u64;
    super::debug::data(address, size, false);
    Ok(value)
}
pub unsafe fn write(address: u64, width: u8, value: u64, stack: bool) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    let addresses = preflight(address, size, Access::Write, stack, false)?;
    write_physical(&addresses[..size], value as u128)?;
    super::debug::data(address, size, true);
    Ok(())
}
pub unsafe fn read128(address: u64, stack: bool) -> Result<u128, Fault> {
    let addresses = preflight(address, 16, Access::Read, stack, false)?;
    let value = read_physical(&addresses)?;
    super::debug::data(address, 16, false);
    Ok(value)
}
pub unsafe fn write128(address: u64, value: u128, stack: bool) -> Result<(), Fault> {
    let addresses = preflight(address, 16, Access::Write, stack, false)?;
    write_physical(&addresses, value)?;
    super::debug::data(address, 16, true);
    Ok(())
}
pub unsafe fn fetch(address: u64) -> Result<u8, Fault> {
    let address = translate(address, Access::Execute, false, false)?;
    physical::read8(address).map_err(|_| Fault::gp())
}
pub unsafe fn read_system(address: u64, width: u8) -> Result<u64, Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    let addresses = preflight(address, size, Access::Read, false, true)?;
    Ok(read_physical(&addresses[..size])? as u64)
}
pub unsafe fn write_system(address: u64, width: u8, value: u64) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    let addresses = preflight(address, size, Access::Write, true, true)?;
    write_physical(&addresses[..size], value as u128)
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
