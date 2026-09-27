//! Shared address forms with baseline-ordered instruction fetch and segment checks.
use crate::cpu::cpu::*;
use crate::paging::OrPageFault;
unsafe fn resolve(modrm: i32, size: u8) -> OrPageFault<i32> {
    let sib = if size == 32 && modrm & 7 == 4 { Some(read_imm8()? as u8) } else { None };
    let form = crate::decode_rules::address_form(modrm as u8, size, sib);
    let base = form.base.map_or(0, |r| {
        if size == 16 {
            read_reg16(r as i32)
        }
        else {
            read_reg32(r as i32)
        }
    });
    let index = form
        .index
        .map_or(0, |r| {
            if size == 16 {
                read_reg16(r as i32)
            }
            else {
                read_reg32(r as i32)
            }
        })
        .wrapping_shl(form.scale as u32);
    let early_segment = if form.segment_before_displacement {
        Some(get_seg_prefix(form.segment as i32)?)
    }
    else {
        None
    };
    let displacement = match form.displacement_bytes {
        0 => 0,
        1 => read_imm8s()?,
        2 => read_imm16()?,
        4 => read_imm32s()?,
        _ => unreachable!(),
    };
    let offset = base.wrapping_add(index).wrapping_add(displacement);
    let offset = if size == 16 { offset & 65535 } else { offset };
    Ok(early_segment
        .unwrap_or(0)
        .wrapping_add(offset)
        .wrapping_add(if early_segment.is_none() {
            get_seg_prefix(form.segment as i32)?
        }
        else {
            0
        }))
}
pub unsafe fn resolve_modrm16(m: i32) -> OrPageFault<i32> { resolve(m, 16) }
pub unsafe fn resolve_modrm32(m: i32) -> OrPageFault<i32> { resolve(m, 32) }
pub unsafe fn resolve_modrm32_(m: i32) -> OrPageFault<i32> { resolve(m, 32) }
#[cfg(feature = "ir-test-hooks")]
#[path = "../../../tests/ir/decode/legacy_modrm.rs"]
pub mod legacy;

#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_resolve_modrm(modrm: u32, size: u32, old: u32) -> u64 {
    let result = match (size, old != 0) {
        (16, true) => legacy::resolve_modrm16(modrm as i32),
        (32, true) => legacy::resolve_modrm32(modrm as i32),
        (16, false) => resolve_modrm16(modrm as i32),
        (32, false) => resolve_modrm32(modrm as i32),
        _ => panic!("invalid test mode"),
    };
    match result {
        Ok(address) => address as u32 as u64,
        Err(()) => 1u64 << 32,
    }
}
