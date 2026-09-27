//! Pure decode rules shared by the snapshot decoder and staged CPU interpreter.
use crate::prefix::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prefix {
    Segment(u8),
    Operand,
    Address,
    Lock,
    Repne,
    Rep,
}
pub fn prefix(byte: u8) -> Option<Prefix> {
    Some(match byte {
        0x26 => Prefix::Segment(0),
        0x2E => Prefix::Segment(1),
        0x36 => Prefix::Segment(2),
        0x3E => Prefix::Segment(3),
        0x64 => Prefix::Segment(4),
        0x65 => Prefix::Segment(5),
        0x66 => Prefix::Operand,
        0x67 => Prefix::Address,
        0xF0 => Prefix::Lock,
        0xF2 => Prefix::Repne,
        0xF3 => Prefix::Rep,
        _ => return None,
    })
}
/// Baseline repeats accumulate rather than toggle; the last segment wins.
pub fn apply_prefix(flags: u8, byte: u8) -> Option<u8> {
    Some(match prefix(byte)? {
        Prefix::Segment(s) => flags & !PREFIX_MASK_SEGMENT | (s + 1),
        Prefix::Operand => flags | PREFIX_66,
        Prefix::Address => flags | PREFIX_67,
        Prefix::Repne => flags | PREFIX_F2,
        Prefix::Rep => flags | PREFIX_F3,
        Prefix::Lock => flags,
    })
}
/// `available` describes variants from the single generated opcode catalogue.
#[inline]
pub fn mandatory_prefix(flags: u8, available: u8) -> u8 {
    let present = flags & available;
    if present & PREFIX_66 != 0 {
        PREFIX_66
    }
    else if present & PREFIX_F2 != 0 {
        PREFIX_F2
    }
    else {
        present & PREFIX_F3
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AddressForm {
    pub base: Option<u8>,
    pub index: Option<u8>,
    pub scale: u8,
    pub displacement_bytes: u8,
    pub segment: u8,
    /// The pinned interpreter checks SIB's segment before its trailing displacement.
    pub segment_before_displacement: bool,
}
pub fn address_form(modrm: u8, size: u8, sib: Option<u8>) -> AddressForm {
    assert!(modrm < 0xC0 && matches!(size, 16 | 32));
    let mode = modrm >> 6;
    let rm = modrm & 7;
    let (base, index, scale, absolute) = if size == 16 {
        let (base, index) = match rm {
            0 => (Some(3), Some(6)),
            1 => (Some(3), Some(7)),
            2 => (Some(5), Some(6)),
            3 => (Some(5), Some(7)),
            4 => (Some(6), None),
            5 => (Some(7), None),
            6 if mode == 0 => (None, None),
            6 => (Some(5), None),
            _ => (Some(3), None),
        };
        (base, index, 0, mode == 0 && rm == 6)
    }
    else if rm == 4 {
        let sib = sib.expect("SIB required");
        let b = sib & 7;
        let i = sib >> 3 & 7;
        (
            if b == 5 && mode == 0 { None } else { Some(b) },
            if i == 4 { None } else { Some(i) },
            sib >> 6,
            b == 5 && mode == 0,
        )
    }
    else {
        (
            if rm == 5 && mode == 0 { None } else { Some(rm) },
            None,
            0,
            rm == 5 && mode == 0,
        )
    };
    AddressForm {
        base,
        index,
        scale,
        displacement_bytes: if mode == 1 {
            1
        }
        else if mode == 2 || absolute {
            size / 8
        }
        else {
            0
        },
        segment: if base == Some(5) || size == 32 && base == Some(4) { 2 } else { 3 },
        segment_before_displacement: size == 32 && rm == 4 && mode != 0,
    }
}
