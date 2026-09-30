mod ext {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn mmap_read8(addr: u32) -> i32;
        pub fn mmap_read32(addr: u32) -> i32;

        pub fn mmap_write8(addr: u32, value: i32);
        pub fn mmap_write16(addr: u32, value: i32);
        pub fn mmap_write32(addr: u32, value: i32);
        pub fn mmap_write64(addr: u32, v0: i32, v1: i32);
        pub fn mmap_write128(addr: u32, v0: i32, v1: i32, v2: i32, v3: i32);
    }
}

use crate::cpu::apic;
use crate::cpu::cpu::{
    handle_irqs, reg128, APIC_MEM_ADDRESS, APIC_MEM_SIZE, IOAPIC_MEM_ADDRESS, IOAPIC_MEM_SIZE,
};
use crate::cpu::global_pointers::memory_size;
use crate::cpu::ioapic;
use crate::cpu::mmio_ram;
use crate::jit;
use crate::page::Page;
use crate::parallel;

use std::alloc;
use std::ptr;

#[allow(non_upper_case_globals)]
pub static mut mem8: *mut u8 = ptr::null_mut();
// The first relocated low RAM byte, or memory_size when no RAM was relocated.
// Ordinary RAM below this threshold retains the original single bound check.
#[allow(non_upper_case_globals)]
pub static mut ram_fast_limit: u32 = 0;

#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(mem8.is_null());
    };
    dbg_log!("Allocate memory size={}m", size >> 20);
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) as u32 };
    unsafe {
        mem8 = ptr as *mut u8;
        ram_fast_limit = size;
    };
    ptr
}

#[no_mangle]
pub unsafe fn zero_memory(addr: u32, size: u32) {
    ptr::write_bytes(mem8.offset(addr as isize), 0, size as usize);
}

#[no_mangle]
pub fn in_mapped_range(addr: u32) -> bool {
    addr >= 0xA0000 && addr < 0xC0000
        || addr >= unsafe { ram_fast_limit }
            && (addr >= unsafe { *memory_size }
                || unsafe { crate::x64::physical::is_low_ram_hole(addr) })
}

#[inline]
fn low_ram_hole(addr: u32) -> bool {
    addr >= unsafe { ram_fast_limit }
        && addr < unsafe { *memory_size }
        && unsafe { crate::x64::physical::is_low_ram_hole(addr) }
}

#[inline]
fn mapped_width(addr: u32, bytes: u32) -> bool {
    in_mapped_range(addr)
        || addr & 4095 > 4096 - bytes && in_mapped_range(addr.wrapping_add(bytes - 1))
}

#[inline]
fn touches_low_hole(addr: u32, bytes: u32) -> bool {
    low_ram_hole(addr) || low_ram_hole(addr.wrapping_add(bytes - 1))
        // (and the extended RAM aperture: accessed byte by byte, or by aligned dwords)
        || aperture::contains(addr) || aperture::contains(addr.wrapping_add(bytes - 1))
}

use crate::x64::extended::aperture;
// Extended RAM through the aperture (crate::x64::extended), in long mode only;
// elsewhere the range reads as open bus
fn aperture_read8(addr: u32) -> i32 {
    unsafe {
        if long_mode() {
            aperture::read8(addr).map_or(0xFF, |v| v as i32)
        }
        else {
            0xFF
        }
    }
}
fn aperture_write8(addr: u32, value: i32) {
    unsafe {
        if long_mode() {
            aperture::write8(addr, value as u8);
        }
    }
}
unsafe fn long_mode() -> bool { crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 }

// The RAM path of the reads is always inlined; mapped ranges (VGA, MMIO,
// the low hole left by RAM relocated above 4 GiB) are handled out of line.
#[export_name = "read8"]
pub fn read8_export(addr: u32) -> i32 { read8(addr) }
#[inline(always)]
pub fn read8(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        read8_mapped(addr)
    }
    else {
        read8_no_mmap_check(addr)
    }
}
#[inline(never)]
fn read8_mapped(addr: u32) -> i32 {
    {
        if low_ram_hole(addr) {
            0xFF
        }
        else if aperture::contains(addr) {
            aperture_read8(addr)
        }
        else if let Some(host) = unsafe { mmio_ram::read_host(addr, 1) } {
            unsafe { *host as i32 }
        }
        else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
            apic::read32((addr - APIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
            ioapic::read32((addr - IOAPIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else {
            unsafe { ext::mmap_read8(addr) }
        }
    }
}
// RAM accesses go through crate::parallel: ordered atomics when cores run in
// workers, plain accesses in the normal build.
pub fn read8_no_mmap_check(addr: u32) -> i32 {
    unsafe { parallel::load8(mem8.offset(addr as isize)) as i32 }
}

#[export_name = "read16"]
pub fn read16_export(addr: u32) -> i32 { read16(addr) }
#[inline(always)]
pub fn read16(addr: u32) -> i32 {
    if mapped_width(addr, 2) {
        read16_mapped(addr)
    }
    else {
        read16_no_mmap_check(addr)
    }
}
#[inline(never)]
fn read16_mapped(addr: u32) -> i32 {
    {
        if let Some(host) = unsafe { mmio_ram::read_host(addr, 2) } {
            unsafe { ptr::read_unaligned(host as *const u16) as i32 }
        }
        else {
            read8(addr) | read8(addr.wrapping_add(1)) << 8
        }
    }
}
pub fn read16_no_mmap_check(addr: u32) -> i32 {
    unsafe { parallel::load16(mem8.offset(addr as isize)) as i32 }
}

#[export_name = "read32s"]
pub fn read32s_export(addr: u32) -> i32 { read32s(addr) }
#[inline(always)]
pub fn read32s(addr: u32) -> i32 {
    if mapped_width(addr, 4) {
        read32s_mapped(addr)
    }
    else {
        read32_no_mmap_check(addr)
    }
}
#[inline(never)]
fn read32s_mapped(addr: u32) -> i32 {
    {
        if aperture::contains(addr) && addr & 3 == 0 && unsafe { long_mode() } {
            return unsafe { aperture::read32(addr) }.map_or(-1, |v| v as i32);
        }
        if addr & 4095 > 4092 || touches_low_hole(addr, 4) {
            read8(addr)
                | read8(addr.wrapping_add(1)) << 8
                | read8(addr.wrapping_add(2)) << 16
                | read8(addr.wrapping_add(3)) << 24
        }
        else if let Some(host) = unsafe { mmio_ram::read_host(addr, 4) } {
            unsafe { ptr::read_unaligned(host as *const i32) }
        }
        else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
            apic::read32(addr - APIC_MEM_ADDRESS) as i32
        }
        else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
            ioapic::read32(addr - IOAPIC_MEM_ADDRESS) as i32
        }
        else {
            unsafe { ext::mmap_read32(addr) }
        }
    }
}
pub fn read32_no_mmap_check(addr: u32) -> i32 {
    unsafe { parallel::load32(mem8.offset(addr as isize)) as i32 }
}

pub unsafe fn read64s(addr: u32) -> i64 {
    if mapped_width(addr, 8) {
        if let Some(host) = mmio_ram::read_host(addr, 8) {
            ptr::read_unaligned(host as *const i64)
        }
        else {
            // Preserve the low dword's bits without sign-extending into the
            // high dword. MMIO exposes two independent 32-bit bus reads.
            read32s(addr) as u32 as i64 | (read32s(addr.wrapping_add(4)) as i64) << 32
        }
    }
    else {
        parallel::load64(mem8.offset(addr as isize)) as i64
    }
}

pub unsafe fn read128(addr: u32) -> reg128 {
    if mapped_width(addr, 16) {
        if let Some(host) = mmio_ram::read_host(addr, 16) {
            ptr::read_unaligned(host as *const reg128)
        }
        else {
            reg128 {
                i32: [
                    read32s(addr + 0),
                    read32s(addr.wrapping_add(4)),
                    read32s(addr.wrapping_add(8)),
                    read32s(addr.wrapping_add(12)),
                ],
            }
        }
    }
    else {
        let [low, high] = parallel::load128(mem8.offset(addr as isize));
        reg128 { u64: [low, high] }
    }
}

#[no_mangle]
pub unsafe fn write8(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write8(addr, value & 0xFF);
    }
    else {
        write8_ram(addr, value);
    };
}

#[inline]
pub unsafe fn write8_ram(addr: u32, value: i32) {
    jit::jit_dirty_page(Page::page_of(addr));
    write8_no_mmap_or_dirty_check(addr, value);
}

pub unsafe fn write8_no_mmap_or_dirty_check(addr: u32, value: i32) {
    parallel::store8(mem8.offset(addr as isize), value as u8)
}

/// Set accessed/dirty bits in the low byte of a page table entry: a locked
/// OR, as the processor does it, so that another core's concurrent update of
/// the entry is not overwritten
pub unsafe fn set_page_entry_bits(addr: u32, bits: u8) {
    if in_mapped_range(addr) {
        mmap_write8(addr, read8(addr) | bits as i32);
        return;
    }
    jit::jit_dirty_page(Page::page_of(addr));
    parallel::or8(mem8.offset(addr as isize), bits);
}

pub fn read64_no_mmap_check(addr: u32) -> u64 {
    unsafe { parallel::load64(mem8.offset(addr as isize)) }
}

#[no_mangle]
pub unsafe fn write16(addr: u32, value: i32) {
    if mapped_width(addr, 2) {
        mmap_write16(addr, value & 0xFFFF);
    }
    else {
        write16_ram(addr, value);
    };
}
#[inline]
pub unsafe fn write16_ram(addr: u32, value: i32) {
    jit::jit_dirty_cache_small(addr, addr + 2);
    write16_no_mmap_or_dirty_check(addr, value);
}
pub unsafe fn write16_no_mmap_or_dirty_check(addr: u32, value: i32) {
    parallel::store16(mem8.offset(addr as isize), value as u16)
}

#[no_mangle]
pub unsafe fn write32(addr: u32, value: i32) {
    if mapped_width(addr, 4) {
        mmap_write32(addr, value);
    }
    else {
        write32_ram(addr, value);
    }
}

#[inline]
pub unsafe fn write32_ram(addr: u32, value: i32) {
    jit::jit_dirty_cache_small(addr, addr + 4);
    write32_no_mmap_or_dirty_check(addr, value);
}

pub unsafe fn write32_no_mmap_or_dirty_check(addr: u32, value: i32) {
    parallel::store32(mem8.offset(addr as isize), value as u32)
}

pub unsafe fn write64_no_mmap_or_dirty_check(addr: u32, value: u64) {
    parallel::store64(mem8.offset(addr as isize), value)
}

pub unsafe fn write128_no_mmap_or_dirty_check(addr: u32, value: reg128) {
    parallel::store128(mem8.offset(addr as isize), value.u64)
}

/// Replace the naturally aligned RAM value `expected` by `value` if another
/// core has not changed it in between (the commit of a locked
/// read-modify-write). Always succeeds when no other core runs concurrently.
pub unsafe fn compare_exchange_no_mmap_or_dirty_check(
    addr: u32,
    bytes: u32,
    expected: u64,
    value: u64,
) -> bool {
    parallel::compare_exchange(mem8.offset(addr as isize), bytes, expected, value)
}

// Bulk copies and fills: x86 string stores are not ordered among themselves,
// but with respect to the surrounding instructions (fences in parallel builds)
pub unsafe fn memset_no_mmap_or_dirty_check(addr: u32, value: u8, count: u32) {
    parallel::full_fence();
    ptr::write_bytes(mem8.offset(addr as isize), value, count as usize);
    parallel::full_fence();
}

/// The caller has checked the entire, page-bounded writable RAM range and
/// invalidated generated code if necessary. Repeat an x86 word/dword pattern.
#[inline]
pub unsafe fn memset_pattern_no_mmap_or_dirty_check(addr: u32, value: u32, size: u32, count: u32) {
    dbg_assert!(size == 2 || size == 4);
    let pattern = if size == 2 { (value & 0xFFFF) * 0x10001 } else { value };
    let bytes = count * size;
    parallel::full_fence();
    if pattern == (pattern & 255) * 0x01010101 {
        memset_no_mmap_or_dirty_check(addr, pattern as u8, bytes);
        return;
    }
    let mut offset = 0;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::{i32x4_splat, v128_store};
        let vector = i32x4_splat(pattern as i32);
        while offset + 16 <= bytes {
            v128_store(mem8.add((addr + offset) as usize).cast(), vector);
            offset += 16;
        }
    }
    while offset + 4 <= bytes {
        write32_no_mmap_or_dirty_check(addr + offset, pattern as i32);
        offset += 4;
    }
    if offset < bytes {
        write16_no_mmap_or_dirty_check(addr + offset, pattern as i32);
    }
    parallel::full_fence();
}

pub unsafe fn memcpy_no_mmap_or_dirty_check(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(src_addr < *memory_size);
    dbg_assert!(dst_addr < *memory_size);
    parallel::full_fence();
    ptr::copy(
        mem8.offset(src_addr as isize),
        mem8.offset(dst_addr as isize),
        count as usize,
    );
    parallel::full_fence();
}

/// Copy RAM into device memory (mmio_ram) within one page
pub unsafe fn memcpy_into_mmio_ram(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(src_addr < *memory_size);
    dbg_assert!(Page::page_of(dst_addr) == Page::page_of(dst_addr + count - 1));
    let destination = mmio_ram::write_host(dst_addr, count).expect("device memory");
    ptr::copy_nonoverlapping(mem8.offset(src_addr as isize), destination, count as usize)
}

pub unsafe fn mmap_write8(addr: u32, value: i32) {
    if low_ram_hole(addr) {
        return;
    }
    if aperture::contains(addr) {
        aperture_write8(addr, value);
        return;
    }
    if let Some(host) = mmio_ram::write_host(addr, 1) {
        *host = value as u8
    }
    else {
        ext::mmap_write8(addr, value)
    }
}
pub unsafe fn mmap_write16(addr: u32, value: i32) {
    if addr & 4095 > 4094 || touches_low_hole(addr, 2) {
        write8(addr, value & 0xFF);
        write8(addr.wrapping_add(1), value >> 8 & 0xFF);
        return;
    }
    if let Some(host) = mmio_ram::write_host(addr, 2) {
        ptr::write_unaligned(host as *mut u16, value as u16)
    }
    else {
        ext::mmap_write16(addr, value)
    }
}
pub unsafe fn mmap_write32(addr: u32, value: i32) {
    if aperture::contains(addr) && addr & 3 == 0 && long_mode() {
        aperture::write32(addr, value as u32);
        return;
    }
    if addr & 4095 > 4092 || touches_low_hole(addr, 4) {
        for index in 0..4 {
            write8(addr.wrapping_add(index), value >> (index * 8) & 0xFF);
        }
        return;
    }
    if let Some(host) = mmio_ram::write_host(addr, 4) {
        ptr::write_unaligned(host as *mut i32, value)
    }
    else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
        apic::write32(addr - APIC_MEM_ADDRESS, value as u32);
        handle_irqs();
    }
    else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
        ioapic::write32(addr - IOAPIC_MEM_ADDRESS, value as u32);
        handle_irqs();
    }
    else {
        ext::mmap_write32(addr, value)
    }
}
pub unsafe fn mmap_write64(addr: u32, value: u64) {
    if addr & 4095 > 4088 || touches_low_hole(addr, 8) {
        for index in 0..8 {
            write8(
                addr.wrapping_add(index),
                (value >> (index * 8)) as u8 as i32,
            );
        }
        return;
    }
    if let Some(host) = mmio_ram::write_host(addr, 8) {
        ptr::write_unaligned(host as *mut u64, value)
    }
    else {
        ext::mmap_write64(addr, value as i32, (value >> 32) as i32)
    }
}
pub unsafe fn mmap_write128(addr: u32, v0: u64, v1: u64) {
    if addr & 4095 > 4080 || touches_low_hole(addr, 16) {
        for (offset, value) in [(0, v0), (8, v1)] {
            for index in 0..8 {
                write8(
                    addr.wrapping_add(offset + index),
                    (value >> (index * 8)) as u8 as i32,
                );
            }
        }
        return;
    }
    if let Some(host) = mmio_ram::write_host(addr, 16) {
        ptr::write_unaligned(host as *mut u64, v0);
        ptr::write_unaligned(host.add(8) as *mut u64, v1)
    }
    else {
        ext::mmap_write128(
            addr,
            v0 as i32,
            (v0 >> 32) as i32,
            v1 as i32,
            (v1 >> 32) as i32,
        )
    }
}

#[no_mangle]
pub unsafe fn is_memory_zeroed(addr: u32, length: u32) -> bool {
    dbg_assert!(addr % 8 == 0);
    dbg_assert!(length % 8 == 0);
    for i in (addr..addr + length).step_by(8) {
        if *(mem8.offset(i as isize) as *const i64) != 0 {
            return false;
        }
    }
    return true;
}
