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
/// Repeated prefixes accumulate; the last segment wins, and of F2 and F3 the
/// last one counts, as iced-x86 and XED decode (the SDM calls more than one
/// prefix of a group unpredictable).
pub fn apply_prefix(flags: u8, byte: u8) -> Option<u8> {
    Some(match prefix(byte)? {
        Prefix::Segment(s) => flags & !PREFIX_MASK_SEGMENT | (s + 1),
        Prefix::Operand => flags | PREFIX_66,
        Prefix::Address => flags | PREFIX_67,
        Prefix::Repne => flags & !PREFIX_F3 | PREFIX_F2,
        Prefix::Rep => flags & !PREFIX_F2 | PREFIX_F3,
        Prefix::Lock => flags | PREFIX_LOCK,
    })
}

/// LOCK is legal only on the read/modify/write memory-destination forms. Both
/// interpreter dispatch and side-effect-free JIT decoding use this list so a
/// register form or a read-only operand cannot silently become an unlocked op.
pub fn lock_allowed(opcode: u32, modrm: Option<u8>) -> bool {
    let Some(modrm) = modrm
    else {
        return false;
    };
    if modrm >= 0xC0 {
        return false;
    }
    let group = modrm >> 3 & 7;
    match opcode {
        0x00 | 0x01 | 0x08 | 0x09 | 0x10 | 0x11 | 0x18 | 0x19 | 0x20 | 0x21 | 0x28 | 0x29
        | 0x30 | 0x31 | 0x86 | 0x87 | 0x0FAB | 0x0FB0 | 0x0FB1 | 0x0FB3 | 0x0FBB | 0x0FC0
        | 0x0FC1 => true,
        0x80..=0x83 => group != 7,
        0xF6 | 0xF7 => group == 2 || group == 3,
        0xFE | 0xFF => group <= 1,
        0x0FBA => group >= 5,
        0x0FC7 => group == 1,
        _ => false,
    }
}
/// Which row of an opcode the 66/F2/F3 prefixes select
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    /// The unprefixed row: 66 is an operand-size prefix, F2/F3 are repeat
    /// prefixes (ignored by most instructions)
    Plain,
    /// The row keyed with this prefix (PREFIX_66, PREFIX_F2 or PREFIX_F3)
    Prefixed(u8),
    /// A mandatory prefix without a row of its own: #UD
    Undefined,
}
/// The variant of an opcode whose prefixed rows in the generated catalogue
/// are `available` (PREFIX_66/F2/F3). F2/F3 (the last one, see apply_prefix)
/// take precedence over 66, which with them is an operand-size prefix: MOVSS is
/// also 66 F3 0F 10, CRC32 r32, r/m16 is 66 F2 0F 38 F1 (iced-x86 and XED
/// decode the same). A `refining` prefix selects instructions (all three in
/// the SSE maps, F2/F3 at MOVBE/CRC32): one without a row of its own is #UD.
/// Otherwise F2/F3 are plain repeat prefixes and 66 sets the operand size.
#[inline]
pub fn mandatory_variant(flags: u8, available: u8, refining: u8) -> Variant {
    let rep = flags & (PREFIX_F2 | PREFIX_F3);
    if rep != 0 {
        if available & rep != 0 {
            return Variant::Prefixed(rep);
        }
        if refining & rep != 0 {
            return Variant::Undefined;
        }
    }
    if refining & PREFIX_66 != 0 && flags & PREFIX_66 != 0 {
        return if available & PREFIX_66 != 0 {
            Variant::Prefixed(PREFIX_66)
        }
        else {
            Variant::Undefined
        };
    }
    Variant::Plain
}
/// The refining prefixes (see mandatory_variant) of a row of the catalogue
pub const REFINING_ALL: u8 = PREFIX_66 | PREFIX_F2 | PREFIX_F3;
pub const REFINING_REP: u8 = PREFIX_F2 | PREFIX_F3;

/// The VEX fields a VEX row of the catalogue (key 0xC4_MM_PP_OO, see
/// Vex::key) accepts and what they encode (gen/vex_table.js)
pub mod vex {
    /// A VEX row
    pub const ROW: u16 = 1 << 0;
    /// VEX.L must be 0 or 1 (neither: ignored)
    pub const L0: u16 = 1 << 1;
    pub const L1: u16 = 1 << 2;
    /// VEX.W must be 0 or 1 (neither: ignored)
    pub const W0: u16 = 1 << 3;
    pub const W1: u16 = 1 << 4;
    /// W0/W1 hold only in 64-bit mode; VEX.W is ignored outside it
    pub const WIG32: u16 = 1 << 5;
    /// VEX.vvvv is an operand; otherwise it must be 1111b
    pub const VVVV: u16 = 1 << 6;
    /// 64-bit mode only
    pub const LONG: u16 = 1 << 7;
    /// imm8[7:4] is a register operand
    pub const IS4: u16 = 1 << 8;
    /// A VSIB memory operand: a SIB byte and 32/64-bit addressing
    pub const VSIB: u16 = 1 << 9;
    /// Destination, index and mask registers must differ
    pub const UNIQUE: u16 = 1 << 10;
    /// A general-purpose register instruction (BMI1, BMI2; SDM exception
    /// type 13): no AVX state requirements
    pub const GPR: u16 = 1 << 11;
}

/// C4 or C5 followed by `next` start a VEX prefix rather than LES or LDS:
/// always in 64-bit mode, elsewhere when `next` would be a register ModRM
/// byte (bits 7:6 11b). Real and virtual-8086 mode have no VEX; there the
/// register form of LES/LDS is #UD, which callers keep.
pub fn is_vex(next: u8, long: bool) -> bool { long || next >= 0xC0 }

/// Prefixes before a VEX prefix that make the instruction #UD (REX too, in
/// 64-bit mode)
pub fn vex_prefixes_ud(flags: u8) -> bool {
    flags & (PREFIX_66 | PREFIX_F2 | PREFIX_F3 | PREFIX_LOCK) != 0
}

/// The fields of a VEX prefix. R, X, B and vvvv are no longer inverted. Outside
/// 64-bit mode R, X and B are 0 and VEX.vvvv has three bits: the two-byte
/// prefix's fourth is 1 there (else LDS), and the three-byte prefix's is
/// ignored, also for the 1111b check (SDM 2.3.5.6; iced-x86 requires it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Vex {
    /// 1: 0F, 2: 0F38, 3: 0F3A (others are #UD)
    pub map: u8,
    /// 0: none, 1: 66, 2: F3, 3: F2
    pub pp: u8,
    pub l: bool,
    pub w: bool,
    pub vvvv: u8,
    pub r: bool,
    pub x: bool,
    pub b: bool,
}
impl Vex {
    /// C5 and its byte
    pub fn two(byte1: u8, long: bool) -> Vex {
        Vex {
            map: 1,
            pp: byte1 & 3,
            l: byte1 & 4 != 0,
            w: false,
            vvvv: !byte1 >> 3 & 15,
            r: long && byte1 & 0x80 == 0,
            x: false,
            b: false,
        }
    }
    /// C4 and its two bytes
    pub fn three(byte1: u8, byte2: u8, long: bool) -> Vex {
        Vex {
            map: byte1 & 0x1F,
            pp: byte2 & 3,
            l: byte2 & 4 != 0,
            w: byte2 & 0x80 != 0,
            vvvv: !byte2 >> 3 & if long { 15 } else { 7 },
            r: long && byte1 & 0x80 == 0,
            x: long && byte1 & 0x40 == 0,
            b: long && byte1 & 0x20 == 0,
        }
    }
    /// The catalogue key of the instruction with this opcode byte
    pub fn key(self, opcode: u8) -> u32 {
        0xC400_0000 | (self.map as u32) << 16 | (self.pp as u32) << 8 | opcode as u32
    }
}

/// The row of `rows` (the rows of one VEX key) that accepts these fields: its
/// ModRM.reg group, register or memory form, VEX.L, VEX.W and mode. No row:
/// #UD.
pub fn vex_row(
    rows: &'static [crate::decode::Encoding],
    v: Vex,
    modrm: Option<u8>,
    long: bool,
) -> Option<&'static crate::decode::Encoding> {
    rows.iter().find(|row| {
        let rule = row.vex;
        let w_counts = long || rule & vex::WIG32 == 0;
        (row.group < 0 || modrm.is_some_and(|m| (m >> 3 & 7) as i8 == row.group))
            && !match modrm {
                Some(m) if m < 0xC0 => row.mem_ud,
                Some(_) => row.reg_ud,
                None => false,
            }
            && !(rule & vex::L0 != 0 && v.l || rule & vex::L1 != 0 && !v.l)
            && !(w_counts && (rule & vex::W0 != 0 && v.w || rule & vex::W1 != 0 && !v.w))
            && (long || rule & vex::LONG == 0)
    })
}
/// Whether the row vex_row selected accepts the remaining fields, known
/// after the ModRM byte: VEX.vvvv is 1111b unless an operand, and a VSIB
/// operand has a SIB byte and 32/64-bit addressing. Otherwise #UD.
pub fn vex_valid(
    row: &crate::decode::Encoding,
    v: Vex,
    modrm: Option<u8>,
    address_size: u8,
) -> bool {
    (row.vex & vex::VVVV != 0 || v.vvvv == 0)
        && (row.vex & vex::VSIB == 0
            || modrm.is_some_and(|m| m < 0xC0 && m & 7 == 4) && address_size != 16)
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
