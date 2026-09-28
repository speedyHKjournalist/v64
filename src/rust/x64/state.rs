//! A single architectural register file: existing legacy slots are the low
//! bank, not a second shadow copy. Wide helpers and future JIT materialization
//! address the same bytes as the existing 16/32-bit execution paths.
use crate::cpu::{cpu, global_pointers as gp};

#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct GuestIp(pub u64);
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LinearAddress(pub u64);
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PhysicalAddress(pub u64);
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct HostOffset(pub u32);

pub const EFER_SCE: u64 = 1;
pub const EFER_LME: u64 = 1 << 8;
pub const EFER_LMA: u64 = 1 << 10;
pub const EFER_NXE: u64 = 1 << 11;

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ExecutionMode {
    Real,
    Vm86,
    Protected16,
    Protected32,
    Compatibility16,
    Compatibility32,
    Long64,
}
impl ExecutionMode {
    pub fn is_long(self) -> bool {
        self == Self::Long64
    }
    pub fn operand_default(self) -> u8 {
        if matches!(
            self,
            Self::Protected32 | Self::Compatibility32 | Self::Long64
        ) {
            32
        } else {
            16
        }
    }
    pub fn address_default(self) -> u8 {
        if self.is_long() {
            64
        } else {
            self.operand_default()
        }
    }
}

pub fn derive_mode(
    pe: bool,
    vm: bool,
    lma: bool,
    cs_long: bool,
    cs_default32: bool,
) -> ExecutionMode {
    if !pe {
        ExecutionMode::Real
    } else if lma {
        if cs_long {
            ExecutionMode::Long64
        } else if cs_default32 {
            ExecutionMode::Compatibility32
        } else {
            ExecutionMode::Compatibility16
        }
    } else if vm {
        ExecutionMode::Vm86
    } else if cs_default32 {
        ExecutionMode::Protected32
    } else {
        ExecutionMode::Protected16
    }
}

pub fn canonical(address: u64, width: u8) -> bool {
    assert!((2..64).contains(&width));
    (((address << (64 - width)) as i64) >> (64 - width)) as u64 == address
}

/// The result of a register write, shared by live accessors and pure tests.
/// Legacy/compatibility paths retain inaccessible high bits; the architectural
/// zero-extension guarantee applies to 32-bit writes in the 64-bit submode.
pub fn merge_gpr(old: u64, value: u64, width: u8, mode: ExecutionMode) -> u64 {
    match width {
        8 => old & !0xFF | value & 0xFF,
        16 => old & !0xFFFF | value & 0xFFFF,
        32 if mode.is_long() => value as u32 as u64,
        32 => old & !0xFFFF_FFFF | value as u32 as u64,
        64 => value,
        _ => panic!("invalid GPR width"),
    }
}

pub unsafe fn mode() -> ExecutionMode {
    derive_mode(
        *gp::protected_mode,
        *gp::flags & cpu::FLAG_VM != 0,
        efer() & EFER_LMA != 0,
        *gp::x64_cs_long != 0,
        *gp::is_32,
    )
}
pub unsafe fn efer() -> u64 {
    *gp::x64_efer
}
pub unsafe fn set_efer_raw(value: u64) {
    *gp::x64_efer = value;
}
#[inline]
pub fn gpr_low_offset(r: usize) -> u32 {
    assert!(r < 16);
    if r < 8 {
        gp::reg32 as u32 + r as u32 * 4
    } else {
        gp::x64_gpr_ext_lo as u32 + (r as u32 - 8) * 4
    }
}
#[inline]
pub fn gpr_high_offset(r: usize) -> u32 {
    assert!(r < 16);
    gp::x64_gpr_hi as u32 + r as u32 * 4
}
#[inline]
pub unsafe fn read_gpr(r: usize) -> u64 {
    *(gpr_low_offset(r) as *const u32) as u64 | (*(gpr_high_offset(r) as *const u32) as u64) << 32
}
#[inline]
pub unsafe fn write_gpr(r: usize, value: u64, width: u8) {
    let value = merge_gpr(read_gpr(r), value, width, mode());
    *(gpr_low_offset(r) as *mut u32) = value as u32;
    *(gpr_high_offset(r) as *mut u32) = (value >> 32) as u32;
}
pub unsafe fn read_high_byte(r: usize) -> u8 {
    assert!(r < 4);
    (read_gpr(r) >> 8) as u8
}
pub unsafe fn write_high_byte(r: usize, value: u8) {
    assert!(r < 4);
    write_gpr(r, read_gpr(r) & !0xFF00 | (value as u64) << 8, 64);
}
pub fn xmm_offset(r: usize) -> u32 {
    assert!(r < 16);
    if r < 8 {
        gp::reg_xmm as u32 + r as u32 * 16
    } else {
        gp::x64_xmm_ext as u32 + (r as u32 - 8) * 16
    }
}
pub unsafe fn read_xmm(r: usize) -> cpu::reg128 {
    *(xmm_offset(r) as *const cpu::reg128)
}
pub unsafe fn write_xmm(r: usize, value: cpu::reg128) {
    *(xmm_offset(r) as *mut cpu::reg128) = value;
}

unsafe fn read_pair(lo: *const i32, hi: *const u32) -> u64 {
    *lo as u32 as u64 | (*hi as u64) << 32
}
unsafe fn write_pair(lo: *mut i32, hi: *mut u32, value: u64) {
    *lo = value as i32;
    *hi = (value >> 32) as u32;
}
pub unsafe fn read_rip() -> u64 {
    if mode().is_long() {
        read_pair(gp::instruction_pointer, gp::x64_rip_hi)
    } else {
        cpu::get_real_eip() as u32 as u64
    }
}
pub unsafe fn write_rip(value: u64) {
    if mode().is_long() {
        write_pair(gp::instruction_pointer, gp::x64_rip_hi, value);
    } else {
        let value = if *gp::is_32 { value as u32 } else { value as u16 as u32 };
        *gp::instruction_pointer = cpu::get_seg_cs().wrapping_add(value as i32);
        *gp::x64_rip_hi = 0;
    }
    *gp::last_virt_eip = -1;
}
pub unsafe fn read_previous_rip() -> u64 {
    if mode().is_long() {
        read_pair(gp::previous_ip, gp::x64_previous_ip_hi)
    } else {
        let offset = (*gp::previous_ip).wrapping_sub(cpu::get_seg_cs()) as u32;
        if *gp::is_32 {
            offset as u64
        } else {
            offset as u16 as u64
        }
    }
}
pub unsafe fn write_previous_rip(value: u64) {
    if mode().is_long() {
        write_pair(gp::previous_ip, gp::x64_previous_ip_hi, value);
    } else {
        *gp::previous_ip = cpu::get_seg_cs().wrapping_add(value as i32);
        *gp::x64_previous_ip_hi = 0;
    }
}
pub unsafe fn read_cr(r: usize) -> u64 {
    assert!(r <= 8);
    if r == 8 {
        // CR8 is TPR[7:4] of the local APIC, also written through its MMIO.
        (crate::cpu::apic::read32(0x80) >> 4 & 15) as u64
    } else {
        read_pair(gp::cr.add(r), gp::x64_cr_hi.add(r))
    }
}
pub unsafe fn write_cr_raw(r: usize, value: u64) {
    assert!(r <= 8);
    if r == 8 {
        *gp::x64_cr8 = value;
    } else {
        write_pair(gp::cr.add(r), gp::x64_cr_hi.add(r), value);
    }
}
pub unsafe fn read_dr(r: usize) -> u64 {
    assert!(r < 8);
    read_pair(gp::dreg.add(r), gp::x64_dr_hi.add(r))
}
pub unsafe fn write_dr(r: usize, value: u64) {
    assert!(r < 8);
    write_pair(gp::dreg.add(r), gp::x64_dr_hi.add(r), value);
}
pub unsafe fn read_segment_base(r: usize) -> u64 {
    assert!(r < 8);
    read_pair(gp::segment_offsets.add(r), gp::x64_segment_base_hi.add(r))
}
pub unsafe fn write_segment_base(r: usize, value: u64) {
    assert!(r < 8);
    write_pair(
        gp::segment_offsets.add(r),
        gp::x64_segment_base_hi.add(r),
        value,
    );
}
pub unsafe fn read_gdtr_base() -> u64 {
    read_pair(gp::gdtr_offset, gp::x64_gdtr_base_hi)
}
pub unsafe fn write_gdtr_base(value: u64) {
    write_pair(gp::gdtr_offset, gp::x64_gdtr_base_hi, value);
}
pub unsafe fn read_idtr_base() -> u64 {
    read_pair(gp::idtr_offset, gp::x64_idtr_base_hi)
}
pub unsafe fn write_idtr_base(value: u64) {
    write_pair(gp::idtr_offset, gp::x64_idtr_base_hi, value);
}
pub unsafe fn read_flags64() -> u64 {
    cpu::get_eflags() as u32 as u64
}
pub unsafe fn write_flags64(value: u64) {
    *gp::flags = value as i32 & cpu::FLAGS_MASK | cpu::FLAGS_DEFAULT;
    *gp::flags_changed = 0;
}
/// Used on machine reset/INIT and importing pre-wide snapshots. Ordinary mode
/// changes preserve banks; X2 owns transition validation and mode side effects.
pub unsafe fn reset_extension() {
    core::ptr::write_bytes(gp::x64_gpr_hi as *mut u8, 0, 1788 - 1360);
    *gp::x64_pat = 0x0007_0406_0007_0406;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_seven_modes_and_zero_extension() {
        let modes = [
            derive_mode(false, false, false, false, false),
            derive_mode(true, true, false, false, false),
            derive_mode(true, false, false, false, false),
            derive_mode(true, false, false, false, true),
            derive_mode(true, false, true, false, false),
            derive_mode(true, false, true, false, true),
            derive_mode(true, false, true, true, false),
        ];
        assert_eq!(
            modes,
            [
                ExecutionMode::Real,
                ExecutionMode::Vm86,
                ExecutionMode::Protected16,
                ExecutionMode::Protected32,
                ExecutionMode::Compatibility16,
                ExecutionMode::Compatibility32,
                ExecutionMode::Long64
            ]
        );
        for mode in modes {
            for old in [u64::MAX, 0x1234_5678_9ABC_DEF0, 0] {
                assert_eq!(merge_gpr(old, 0x12, 8, mode), old & !255 | 0x12);
                assert_eq!(merge_gpr(old, 0x1234, 16, mode), old & !65535 | 0x1234);
                assert_eq!(
                    merge_gpr(old, u64::MAX, 32, mode),
                    if mode.is_long() { 0xFFFF_FFFF } else { old | 0xFFFF_FFFF }
                );
                assert_eq!(
                    merge_gpr(old, 0xFEDC_BA98_7654_3210, 64, mode),
                    0xFEDC_BA98_7654_3210
                );
            }
        }
    }
    #[test]
    fn banks_are_unique_and_do_not_overlap_legacy_flags() {
        let mut bytes = std::collections::BTreeSet::new();
        for r in 0..16 {
            for base in [gpr_low_offset(r), gpr_high_offset(r)] {
                for b in base..base + 4 {
                    assert!(bytes.insert(b));
                }
            }
        }
        assert!(!bytes.contains(&96));
        assert_eq!(bytes.len(), 128);
        assert_eq!(xmm_offset(7), 944);
        assert_eq!(xmm_offset(8), 1456);
        assert_eq!(xmm_offset(15), 1568);
    }
    #[test]
    fn canonical_boundaries_keep_the_full_address() {
        for address in [0, 0x7FFF_FFFF_FFFF, 0xFFFF_8000_0000_0000, u64::MAX] {
            assert!(canonical(address, 48));
        }
        for address in [
            0x8000_0000_0000,
            0xFFFF_7FFF_FFFF_FFFF,
            0x1000_0000_0000_0000,
        ] {
            assert!(!canonical(address, 48));
        }
        assert_ne!(GuestIp(1), GuestIp(0x1_0000_0001));
        assert_ne!(PhysicalAddress(0), PhysicalAddress(0x1_0000_0000));
    }
}
