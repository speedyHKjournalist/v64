//! One byte decoder for runtime fetch and immutable compiler snapshots. It
//! never performs memory I/O; `decode_with` requests only the bytes required by
//! the opcode and preserves fetch-fault versus #UD/#GP ordering.
use super::state::{ExecutionMode, GuestIp};
use crate::decode::{Encoding, ImmediateKind};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PrefixState {
    pub operand: bool,
    pub address: bool,
    pub lock: bool,
    pub rep: Option<u8>,
    pub segment: Option<u8>,
    pub rex: Option<u8>,
}
impl PrefixState {
    pub fn w(self) -> bool { self.rex.is_some_and(|r| r & 8 != 0) }
    pub fn r(self) -> u8 { self.rex.map_or(0, |r| (r >> 2 & 1) << 3) }
    pub fn x(self) -> u8 { self.rex.map_or(0, |r| (r >> 1 & 1) << 3) }
    pub fn b(self) -> u8 { self.rex.map_or(0, |r| (r & 1) << 3) }
    /// Returns true only if byte is a prefix in the current execution mode.
    pub fn consume(&mut self, byte: u8, mode: ExecutionMode) -> bool {
        if mode.is_long() && (0x40..=0x4F).contains(&byte) {
            self.rex = Some(byte);
            return true;
        }
        use crate::decode_rules::Prefix;
        match crate::decode_rules::prefix(byte) {
            Some(Prefix::Operand) => self.operand = true,
            Some(Prefix::Address) => self.address = true,
            Some(Prefix::Lock) => self.lock = true,
            Some(Prefix::Repne) => self.rep = Some(0xF2),
            Some(Prefix::Rep) => self.rep = Some(0xF3),
            Some(Prefix::Segment(s)) => self.segment = Some(s),
            None => return false,
        }
        // A legacy prefix after REX makes the earlier REX ineffective.
        self.rex = None;
        true
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ByteRegister {
    Low(u8),
    HighLegacy(u8),
}
pub fn byte_register(encoded: u8, rex_present: bool) -> ByteRegister {
    assert!(encoded < 16 && (rex_present || encoded < 8));
    if !rex_present && (4..8).contains(&encoded) {
        ByteRegister::HighLegacy(encoded - 4)
    }
    else {
        ByteRegister::Low(encoded)
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AddressBase {
    None,
    Register(u8),
    NextRip,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AddressExpr {
    pub base: AddressBase,
    pub index: Option<u8>,
    pub scale: u8,
    pub displacement: i64,
    pub address_size: u8,
    pub segment: u8,
}
impl AddressExpr {
    /// Segmentation/canonical/page permission checks happen at the access. In long
    /// mode only FS/GS have a nonzero effective base; address32 wraps first.
    pub fn offset(self, registers: &[u64; 16], next_rip: GuestIp) -> u64 {
        let base = match self.base {
            AddressBase::None => 0,
            AddressBase::Register(r) => registers[r as usize],
            AddressBase::NextRip => next_rip.0,
        };
        let value = base
            .wrapping_add(
                self.index
                    .map_or(0, |r| registers[r as usize].wrapping_shl(self.scale as u32)),
            )
            .wrapping_add(self.displacement as u64);
        match self.address_size {
            16 => value as u16 as u64,
            32 => value as u32 as u64,
            64 => value,
            _ => unreachable!(),
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Immediate {
    pub value: u64,
    pub encoded_bytes: u8,
    pub sign_extended: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct Decoded {
    pub encoding: &'static Encoding,
    pub opcode: u32,
    pub prefixes: PrefixState,
    pub mode: ExecutionMode,
    pub operand_size: u8,
    pub address_size: u8,
    pub length: u8,
    pub start: GuestIp,
    pub next: GuestIp,
    pub modrm: Option<u8>,
    pub reg: Option<u8>,
    pub rm_register: Option<u8>,
    pub opcode_register: Option<u8>,
    pub address: Option<AddressExpr>,
    pub immediate: Option<Immediate>,
    pub extra_immediate: Option<u16>,
    pub bytes: [u8; 15],
    /// The VEX prefix (decode_rules::is_vex); `opcode` is its key
    pub vex: Option<crate::decode_rules::Vex>,
}
impl Decoded {
    /// Remove the catalog's mandatory/repeat prefix key while retaining the
    /// 0F opcode map. Executors still inspect `opcode` to distinguish SIMD
    /// variants and `prefixes` for architectural REP/operand semantics.
    pub fn base_opcode(&self) -> u32 {
        if self.vex.is_some() {
            self.opcode
        }
        else if matches!(self.opcode >> 8 & 0xFFFF, 0x0F38 | 0x0F3A) {
            self.opcode & 0xFF_FFFF
        }
        else if self.opcode & 0xFF00 == 0x0F00 {
            self.opcode & 0xFFFF
        }
        else {
            self.opcode & 0xFF
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeError<E = ()> {
    Fetch { offset: u8, error: E },
    TooLong,
    InvalidOpcode,
    UnknownOpcode(u32),
}
struct Cursor<F> {
    fetch: F,
    bytes: [u8; 15],
    length: u8,
}
impl<F, E> Cursor<F>
where
    F: FnMut(u8) -> Result<u8, E>,
{
    fn byte(&mut self) -> Result<u8, DecodeError<E>> {
        if self.length == 15 {
            return Err(DecodeError::TooLong);
        }
        let byte = (self.fetch)(self.length).map_err(|error| DecodeError::Fetch {
            offset: self.length,
            error,
        })?;
        self.bytes[self.length as usize] = byte;
        self.length += 1;
        Ok(byte)
    }
    /// The next byte, which the instruction includes whatever it is
    fn peek(&mut self) -> Result<u8, DecodeError<E>> {
        if self.length == 15 {
            return Err(DecodeError::TooLong);
        }
        (self.fetch)(self.length).map_err(|error| DecodeError::Fetch {
            offset: self.length,
            error,
        })
    }
    fn integer(&mut self, bytes: u8) -> Result<u64, DecodeError<E>> {
        let mut value = 0;
        for shift in 0..bytes {
            value |= (self.byte()? as u64) << (shift * 8);
        }
        Ok(value)
    }
    fn signed(&mut self, bytes: u8) -> Result<i64, DecodeError<E>> {
        let value = self.integer(bytes)?;
        Ok(((value << (64 - bytes * 8)) as i64) >> (64 - bytes * 8))
    }
}
fn candidates(opcode: u32) -> &'static [Encoding] {
    let all = crate::decode::encodings();
    let first = all.partition_point(|row| row.opcode < opcode);
    let last = all.partition_point(|row| row.opcode <= opcode);
    &all[first..last]
}
fn invalid_long_opcode(opcode: u32) -> bool {
    matches!(
        opcode,
        0x06 | 0x07
            | 0x0E
            | 0x16
            | 0x17
            | 0x1E
            | 0x1F
            | 0x27
            | 0x2F
            | 0x37
            | 0x3F
            | 0x60
            | 0x61
            | 0x62
            | 0x82
            | 0x9A
            | 0xCE
            | 0xD4
            | 0xD5
            | 0xD6
            | 0xEA
            | 0x0F24
            | 0x0F26
    )
}
fn operand_size(mode: ExecutionMode, prefixes: PrefixState, opcode: u32, modrm: Option<u8>) -> u8 {
    if !mode.is_long() {
        return if prefixes.operand { 48 - mode.operand_default() } else { mode.operand_default() };
    }
    let group = modrm.map_or(0, |m| m >> 3 & 7);
    // Near CALL/JMP/RET, CR/DR transfers, and IRETQ's REX.W are distinct from
    // ordinary GPR defaults. PUSH/POP/ENTER/LEAVE permit a 16-bit override.
    if matches!(opcode, 0xE8 | 0xE9 | 0xEB | 0xC2 | 0xC3 | 0x0F20..=0x0F23)
        || opcode == 0xFF && matches!(group, 2 | 4)
    {
        return 64;
    }
    if opcode == 0x0FC7 && group == 1 {
        return if prefixes.w() { 128 } else { 64 };
    }
    if prefixes.w() {
        return 64;
    }
    if prefixes.operand {
        return 16;
    }
    if matches!(
        opcode,
        0x50..=0x5F
            | 0x68
            | 0x6A
            | 0x8F
            | 0x9C
            | 0x9D
            | 0xC8
            | 0xC9
            | 0x0FA0
            | 0x0FA1
            | 0x0FA8
            | 0x0FA9
    ) || opcode == 0xFF && group == 6
    {
        64
    }
    else {
        32
    }
}
fn address<F, E>(
    c: &mut Cursor<F>,
    m: u8,
    size: u8,
    p: PrefixState,
    mode: ExecutionMode,
) -> Result<AddressExpr, DecodeError<E>>
where
    F: FnMut(u8) -> Result<u8, E>,
{
    let md = m >> 6;
    let rm = m & 7;
    if size == 16 {
        let rule = crate::decode_rules::address_form(m, size, None);
        let disp = match rule.displacement_bytes {
            0 => 0,
            1 => c.signed(1)?,
            2 if md == 2 => c.signed(2)?,
            2 => c.integer(2)? as i64,
            _ => unreachable!(),
        };
        return Ok(AddressExpr {
            base: rule.base.map_or(AddressBase::None, AddressBase::Register),
            index: rule.index,
            scale: 0,
            displacement: disp,
            address_size: size,
            segment: p.segment.unwrap_or(rule.segment),
        });
    }
    let mut base = AddressBase::Register(rm | p.b());
    let mut index = None;
    let mut scale = 0;
    let mut disp32 = md == 2;
    if rm == 4 {
        let sib = c.byte()?;
        let raw_base = sib & 7;
        let raw_index = sib >> 3 & 7;
        scale = sib >> 6;
        if raw_index != 4 || p.x() != 0 {
            index = Some(raw_index | p.x());
        }
        if md == 0 && raw_base == 5 {
            base = AddressBase::None;
            disp32 = true;
        }
        else {
            base = AddressBase::Register(raw_base | p.b());
        }
    }
    else if md == 0 && rm == 5 {
        base = if mode.is_long() { AddressBase::NextRip } else { AddressBase::None };
        disp32 = true;
    }
    let displacement = if md == 1 {
        c.signed(1)?
    }
    else if disp32 {
        c.signed(4)?
    }
    else {
        0
    };
    let segment = p
        .segment
        .unwrap_or(if matches!(base,AddressBase::Register(r) if r == 4 || r == 5) { 2 } else { 3 });
    Ok(AddressExpr {
        base,
        index,
        scale,
        displacement,
        address_size: size,
        segment,
    })
}

pub fn decode(bytes: &[u8], start: GuestIp, mode: ExecutionMode) -> Result<Decoded, DecodeError> {
    decode_with(start, mode, |offset| {
        bytes.get(offset as usize).copied().ok_or(())
    })
}
pub fn decode_with<F, E>(
    start: GuestIp,
    mode: ExecutionMode,
    fetch: F,
) -> Result<Decoded, DecodeError<E>>
where
    F: FnMut(u8) -> Result<u8, E>,
{
    let mut c = Cursor {
        fetch,
        bytes: [0; 15],
        length: 0,
    };
    let mut prefixes = PrefixState::default();
    let first = loop {
        let b = c.byte()?;
        if !prefixes.consume(b, mode) {
            break b;
        }
    };
    // C4/C5: a VEX prefix in 64-bit mode, and with a register ModRM byte in
    // protected and compatibility mode (decode_rules::is_vex). Real and
    // virtual-8086 mode have no VEX: LES/LDS, whose register form is #UD.
    if (first == 0xC4 || first == 0xC5)
        && !matches!(mode, ExecutionMode::Real | ExecutionMode::Vm86)
        && crate::decode_rules::is_vex(c.peek()?, mode.is_long())
    {
        return decode_vex(c, start, mode, prefixes, first);
    }
    // 0F 38 and 0F 3A lead to the three-byte maps (key 0x0F38xx, 0x0F3Axx)
    let base_opcode = if first == 0x0F {
        let second = c.byte()?;
        if second == 0x38 || second == 0x3A {
            0x0F0000 | (second as u32) << 8 | c.byte()? as u32
        }
        else {
            0x0F00 | second as u32
        }
    }
    else {
        first as u32
    };
    if mode.is_long() && invalid_long_opcode(base_opcode) {
        return Err(DecodeError::InvalidOpcode);
    }
    if !mode.is_long() && matches!(base_opcode, 0x0F05 | 0x0F07) {
        return Err(DecodeError::InvalidOpcode);
    }
    // The 66/F2/F3 variants of the opcode in the shared catalogue, chosen by
    // the rule all three decoders share (decode_rules::mandatory_variant): a
    // refining prefix without a row of its own, a row whose CPUID feature is
    // absent or an unimplemented row is #UD after the ModRM byte, as in the
    // 32-bit interpreter.
    use crate::prefix::{PREFIX_66, PREFIX_F2, PREFIX_F3};
    let shift = if base_opcode > 0xFFFF {
        24
    }
    else if first == 0x0F {
        16
    }
    else {
        8
    };
    let variants = [(0x66u32, PREFIX_66), (0xF2, PREFIX_F2), (0xF3, PREFIX_F3)];
    let mut available = 0;
    let mut refining = candidates(base_opcode)
        .iter()
        .fold(0, |m, row| m | row.refining);
    let mut family = candidates(base_opcode).first();
    for (prefix, mask) in variants {
        if prefix != 0x66 || first == 0x0F {
            let rows = candidates(prefix << shift | base_opcode);
            refining |= rows.iter().fold(0, |m, row| m | row.refining);
            family = family.or(rows.first());
            if rows.iter().any(Encoding::exists) {
                available |= mask;
            }
        }
    }
    let flags = if prefixes.operand { PREFIX_66 } else { 0 }
        | match prefixes.rep {
            Some(0xF2) => PREFIX_F2,
            Some(0xF3) => PREFIX_F3,
            _ => 0,
        };
    use crate::decode_rules::Variant;
    let variant = crate::decode_rules::mandatory_variant(flags, available, refining);
    let opcode = match variant {
        Variant::Prefixed(selected) => {
            let prefix = variants.iter().find(|v| v.1 == selected).unwrap().0;
            prefix << shift | base_opcode
        },
        Variant::Plain | Variant::Undefined => base_opcode,
    };
    let rows = candidates(opcode);
    let first_row = family.ok_or(DecodeError::UnknownOpcode(opcode))?;
    // ModRM-taking forms the shared catalog lists without one: the 0F0D
    // prefetch hint, the reserved-NOP hints 0F1A/0F1B (MPX space, NOPs
    // without MPX) and UD1/UD0 (whose length bounds the #UD encoding).
    let hint_0f0d =
        mode.is_long() && matches!(base_opcode, 0x0F0D | 0x0F1A | 0x0F1B | 0x0FB9 | 0x0FFF);
    let modrm = if first_row.fetch_modrm || hint_0f0d { Some(c.byte()?) } else { None };
    let row = rows
        .iter()
        .find(|row| row.group < 0 || modrm.is_some_and(|m| (m >> 3 & 7) as i8 == row.group))
        .ok_or(DecodeError::InvalidOpcode)?;
    if variant == Variant::Undefined || !row.exists() || !row.implemented() {
        return Err(DecodeError::InvalidOpcode);
    }
    if prefixes.lock && !crate::decode_rules::lock_allowed(base_opcode, modrm) {
        return Err(DecodeError::InvalidOpcode);
    }
    let special_0f01 =
        base_opcode == 0x0F01 && (modrm == Some(0xF9) || modrm == Some(0xF8) && mode.is_long());
    if base_opcode == 0x0F01 && modrm == Some(0xF8) && !mode.is_long() {
        return Err(DecodeError::InvalidOpcode);
    }
    let memory = modrm.is_some_and(|m| m < 0xC0) && (row.e || hint_0f0d) && !row.ignore_mod;
    if !special_0f01 && (row.group_ud || if memory { row.mem_ud } else { row.reg_ud }) {
        return Err(DecodeError::InvalidOpcode);
    }
    let operand_size = operand_size(mode, prefixes, base_opcode, modrm);
    let address_size = if prefixes.address {
        if mode.is_long() {
            32
        }
        else {
            48 - mode.address_default()
        }
    }
    else {
        mode.address_default()
    };
    let address = if memory {
        Some(address(
            &mut c,
            modrm.unwrap(),
            address_size,
            prefixes,
            mode,
        )?)
    }
    else {
        None
    };
    let (encoded_bytes, sign_extended) = match row.immediate {
        ImmediateKind::None => (0, false),
        ImmediateKind::Byte => (1, false),
        ImmediateKind::SignedByte => (1, true),
        ImmediateKind::Word => (2, false),
        ImmediateKind::Address => (address_size / 8, false),
        ImmediateKind::Operand => {
            if mode.is_long() && matches!(base_opcode, 0xE8 | 0xE9 | 0x0F80..=0x0F8F) {
                (4, true)
            }
            else if operand_size == 64 && (0xB8..=0xBF).contains(&base_opcode) {
                (8, false)
            }
            else if operand_size == 64 {
                (4, true)
            }
            else {
                (operand_size / 8, false)
            }
        },
    };
    let immediate = if encoded_bytes == 0 {
        None
    }
    else {
        let value = c.integer(encoded_bytes)?;
        let signed = sign_extended
            || mode.is_long()
                && (base_opcode == 0x6A
                    || base_opcode == 0xEB
                    || (0x70..=0x7F).contains(&base_opcode));
        let value = if signed && encoded_bytes < 8 {
            (((value << (64 - encoded_bytes * 8)) as i64) >> (64 - encoded_bytes * 8)) as u64
        }
        else {
            value
        };
        Some(Immediate {
            value,
            encoded_bytes,
            sign_extended: signed,
        })
    };
    let extra_immediate =
        if row.extra_bytes != 0 { Some(c.integer(row.extra_bytes)? as u16) } else { None };
    let next = next_ip(start, c.length, mode);
    Ok(Decoded {
        encoding: row,
        opcode,
        prefixes,
        mode,
        operand_size,
        address_size,
        length: c.length,
        start,
        next,
        modrm,
        reg: modrm.map(|m| (m >> 3 & 7) | prefixes.r()),
        rm_register: modrm
            .filter(|m| *m >= 0xC0 || row.ignore_mod)
            .map(|m| (m & 7) | prefixes.b()),
        opcode_register: if matches!(base_opcode,0x50..=0x5F|0x90..=0x97|0xB0..=0xBF) {
            Some((base_opcode as u8 & 7) | prefixes.b())
        }
        else {
            None
        },
        address,
        immediate,
        extra_immediate,
        bytes: c.bytes,
        vex: None,
    })
}

fn next_ip(start: GuestIp, length: u8, mode: ExecutionMode) -> GuestIp {
    let next = start.0.wrapping_add(length as u64);
    GuestIp(if mode.is_long() {
        next
    }
    else if mode.operand_default() == 16 {
        next as u16 as u64
    }
    else {
        next as u32 as u64
    })
}

/// A VEX instruction: `first` (C4 or C5) and its prefixes are read. #UD (the
/// order the 32-bit interpreter and IR decoder share): a 66/F2/F3/LOCK/REX
/// prefix at the first VEX byte, a key without rows at the opcode byte, and
/// after the ModRM byte when no row accepts the VEX fields
/// (decode_rules::vex_row, vex_valid), the row's feature is absent or its
/// semantics come later. Gathers whose destination, index and mask registers
/// are not distinct are #UD after the SIB byte.
fn decode_vex<F, E>(
    mut c: Cursor<F>,
    start: GuestIp,
    mode: ExecutionMode,
    prefixes: PrefixState,
    first: u8,
) -> Result<Decoded, DecodeError<E>>
where
    F: FnMut(u8) -> Result<u8, E>,
{
    use crate::decode_rules::{vex, vex_row, vex_valid, Vex};
    let long = mode.is_long();
    let byte1 = c.byte()?;
    if prefixes.operand || prefixes.rep.is_some() || prefixes.lock || prefixes.rex.is_some() {
        return Err(DecodeError::InvalidOpcode);
    }
    let v = if first == 0xC4 { Vex::three(byte1, c.byte()?, long) } else { Vex::two(byte1, long) };
    let key = v.key(c.byte()?);
    let rows = candidates(key);
    let family = rows.first().ok_or(DecodeError::UnknownOpcode(key))?;
    let modrm = if family.fetch_modrm { Some(c.byte()?) } else { None };
    let address_size = if !prefixes.address {
        mode.address_default()
    }
    else if long {
        32
    }
    else {
        48 - mode.address_default()
    };
    let row = vex_row(rows, v, modrm, long)
        .filter(|row| row.exists() && row.implemented() && vex_valid(row, v, modrm, address_size))
        .ok_or(DecodeError::InvalidOpcode)?;
    // VEX.R, X and B extend the ModRM and SIB fields as REX does
    let extended = PrefixState {
        rex: Some(0x40 | (v.r as u8) << 2 | (v.x as u8) << 1 | v.b as u8),
        ..prefixes
    };
    let modrm_at = c.length as usize - 1;
    let mut address = match modrm {
        Some(m) if m < 0xC0 => Some(address(&mut c, m, address_size, extended, mode)?),
        _ => None,
    };
    if let (Some(a), true) = (address.as_mut(), row.vex & vex::VSIB != 0) {
        // (a VSIB index names a vector register, xmm4/ymm4 included)
        a.index = Some((c.bytes[modrm_at + 1] >> 3 & 7) | extended.x());
    }
    let immediate = match row.immediate {
        ImmediateKind::None => None,
        ImmediateKind::Byte => Some(Immediate {
            value: c.integer(1)?,
            encoded_bytes: 1,
            sign_extended: false,
        }),
        _ => unreachable!("VEX rows have no other immediates"),
    };
    let reg = modrm.map(|m| (m >> 3 & 7) | extended.r());
    if row.vex & vex::UNIQUE != 0 {
        let (index, mask) = (address.and_then(|a| a.index), v.vvvv);
        if reg == index || Some(mask) == index || reg == Some(mask) {
            return Err(DecodeError::InvalidOpcode);
        }
    }
    Ok(Decoded {
        encoding: row,
        opcode: key,
        prefixes,
        mode,
        // general-purpose operands: 64-bit with W1 rows in 64-bit mode
        operand_size: if long && row.vex & vex::W1 != 0 { 64 } else { 32 },
        address_size,
        length: c.length,
        start,
        next: next_ip(start, c.length, mode),
        modrm,
        reg,
        rm_register: modrm.filter(|m| *m >= 0xC0).map(|m| (m & 7) | extended.b()),
        opcode_register: None,
        address,
        immediate,
        extra_immediate: None,
        bytes: c.bytes,
        vex: Some(v),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d(bytes: &[u8]) -> Decoded {
        decode(bytes, GuestIp(0xFFFF_8000_0000_1000), ExecutionMode::Long64).unwrap()
    }
    #[test]
    fn prefixed_catalog_keys_preserve_base_opcode() {
        let movs = d(&[0xF3, 0x48, 0xA5]);
        assert_eq!(movs.base_opcode(), 0xA5);
        assert_eq!(movs.prefixes.rep, Some(0xF3));
        assert_eq!(movs.operand_size, 64);
        assert_eq!(d(&[0xF3, 0x90]).base_opcode(), 0x90);
        assert_eq!(d(&[0x0F, 0x05]).base_opcode(), 0x0F05);
        assert_eq!(d(&[0x0F, 0x07]).base_opcode(), 0x0F07);
        assert_eq!(d(&[0x0F, 0x01, 0xF9]).modrm, Some(0xF9));
        assert_eq!(d(&[0xF3, 0x48, 0x0F, 0xB8, 0xC1]).base_opcode(), 0x0FB8);
    }
    #[test]
    fn mandatory_prefixes_follow_the_shared_rule_in_every_mode() {
        for mode in [
            ExecutionMode::Long64,
            ExecutionMode::Compatibility32,
            ExecutionMode::Protected32,
        ] {
            let decode = |bytes: &[u8]| decode(bytes, GuestIp(0x1000), mode);
            // 66 with F3/F2 is an operand-size prefix (iced-x86, XED): MOVSS/MOVSD
            assert_eq!(
                decode(&[0x66, 0xF3, 0x0F, 0x10, 0xC1]).unwrap().opcode,
                0xF30F10
            );
            assert_eq!(
                decode(&[0xF3, 0x66, 0x0F, 0x10, 0xC1]).unwrap().opcode,
                0xF30F10
            );
            assert_eq!(
                decode(&[0x66, 0xF2, 0x0F, 0x10, 0xC1]).unwrap().opcode,
                0xF20F10
            );
            // of F2 and F3 the last one counts
            assert_eq!(
                decode(&[0xF2, 0xF3, 0x0F, 0x10, 0xC1]).unwrap().opcode,
                0xF30F10
            );
            assert_eq!(
                decode(&[0xF3, 0xF2, 0x0F, 0x10, 0xC1]).unwrap().opcode,
                0xF20F10
            );
            // a mandatory prefix without a row is #UD in every mode, after ModRM
            for bytes in [
                &[0xF3, 0x0F, 0x2B, 0x00][..],
                &[0x66, 0x0F, 0xC3, 0x00],
                &[0xF2, 0x0F, 0x77],
            ] {
                assert_eq!(
                    decode(bytes).unwrap_err(),
                    DecodeError::InvalidOpcode,
                    "{bytes:02X?} {mode:?}"
                );
                if bytes.len() == 4 {
                    assert!(matches!(
                        decode(&bytes[..3]),
                        Err(DecodeError::Fetch { offset: 3, .. })
                    ));
                }
            }
            // outside the SSE maps F2/F3 are repeat prefixes
            assert_eq!(decode(&[0xF3, 0x0F, 0xAF, 0xC1]).unwrap().opcode, 0x0FAF);
        }
    }
    #[test]
    fn three_byte_maps_are_undefined_after_modrm_until_implemented() {
        use crate::cpu::features::{ALL, TEST_FEATURES};
        for features in [0, ALL] {
            TEST_FEATURES.with(|f| f.set(features));
            for mode in [
                ExecutionMode::Long64,
                ExecutionMode::Compatibility32,
                ExecutionMode::Protected32,
            ] {
                let decode = |bytes: &[u8]| decode(bytes, GuestIp(0x1000), mode);
                for bytes in [
                    &[0x66, 0x0F, 0x3A, 0x61, 0xC1][..],
                    &[0x66, 0x0F, 0x3A, 0x08, 0xC1],
                    &[0x0F, 0x38, 0xF1, 0x04],
                    &[0x66, 0xF2, 0x0F, 0x38, 0xF1, 0xC1],
                    &[0x0F, 0x38, 0xF0, 0x00],
                    &[0xF3, 0x0F, 0x38, 0xF0, 0x00],
                ] {
                    assert_eq!(
                        decode(bytes).unwrap_err(),
                        DecodeError::InvalidOpcode,
                        "{bytes:02X?} {mode:?}"
                    );
                    // ... after the ModRM byte, which is fetched first
                    let n = bytes.len() - 1;
                    assert!(
                        matches!(decode(&bytes[..n]), Err(DecodeError::Fetch { offset, .. }) if offset as usize == n)
                    );
                }
                assert!(matches!(
                    decode(&[0x0F, 0x38, 0xFF, 0xC1]),
                    Err(DecodeError::UnknownOpcode(0x0F38FF))
                ));
            }
        }
        TEST_FEATURES.with(|f| f.set(0));
    }
    #[test]
    fn ssse3_forms_decode_with_their_feature() {
        use crate::cpu::features::{SSSE3, TEST_FEATURES};
        for features in [0, SSSE3] {
            TEST_FEATURES.with(|f| f.set(features));
            for mode in [
                ExecutionMode::Long64,
                ExecutionMode::Compatibility32,
                ExecutionMode::Protected16,
            ] {
                let decode = |bytes: &[u8]| decode(bytes, GuestIp(0x1000), mode);
                for (bytes, opcode, imm8) in [
                    (&[0x66, 0x0F, 0x38, 0x00, 0xC1][..], 0x660F3800, None), // pshufb xmm
                    (&[0x0F, 0x38, 0x1E, 0x08], 0x0F381E, None),             // pabsd mm, [..]
                    (
                        &[0x66, 0x0F, 0x3A, 0x0F, 0xC1, 0x83],
                        0x660F3A0F,
                        Some(0x83),
                    ), // palignr
                    (&[0x0F, 0x3A, 0x0F, 0xC1, 0xFF], 0x0F3A0F, Some(0xFF)),
                ] {
                    if features == 0 {
                        // #UD after the ModRM byte (and before the immediate)
                        let n = if imm8.is_some() { bytes.len() - 1 } else { bytes.len() };
                        assert_eq!(decode(&bytes[..n]).unwrap_err(), DecodeError::InvalidOpcode);
                        continue;
                    }
                    let d = decode(bytes).unwrap();
                    assert_eq!(
                        (d.opcode, d.length as usize),
                        (opcode, bytes.len()),
                        "{bytes:02X?}"
                    );
                    assert_eq!(d.immediate.map(|i| i.value as u8), imm8);
                    assert!(matches!(
                        decode(&bytes[..bytes.len() - 1]),
                        Err(DecodeError::Fetch { .. })
                    ));
                }
                // F2/F3 select no SSSE3 form: #UD, also with 66 (decode_rules::mandatory_variant)
                for bytes in [
                    &[0xF3, 0x0F, 0x38, 0x00, 0xC1][..],
                    &[0x66, 0xF2, 0x0F, 0x38, 0x00, 0xC1],
                    &[0xF3, 0x0F, 0x3A, 0x0F, 0xC1],
                ] {
                    assert_eq!(decode(bytes).unwrap_err(), DecodeError::InvalidOpcode);
                }
            }
            // REX.R and REX.B reach XMM8-15
            if features != 0 {
                let d = decode(
                    &[0x66, 0x45, 0x0F, 0x38, 0x00, 0xC1],
                    GuestIp(0x1000),
                    ExecutionMode::Long64,
                )
                .unwrap();
                assert_eq!(
                    (d.opcode, d.reg, d.rm_register),
                    (0x660F3800, Some(8), Some(9))
                );
            }
        }
        TEST_FEATURES.with(|f| f.set(0));
    }
    #[test]
    fn vex_by_mode_prefixes_and_fields() {
        use crate::cpu::features::{ALL, TEST_FEATURES};
        use crate::decode::{form, TEST_DECODE_UNIMPLEMENTED};
        use ExecutionMode::*;
        TEST_FEATURES.with(|f| f.set(ALL));
        TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(true));
        let at = |bytes: &[u8], mode| decode(bytes, GuestIp(0x1000), mode);
        // C4/C5 with a register ModRM byte: VEX, except in real and
        // virtual-8086 mode (LES/LDS, whose register form is #UD)
        for mode in [
            Long64,
            Compatibility32,
            Compatibility16,
            Protected32,
            Protected16,
        ] {
            let v = at(&[0xC5, 0xF8, 0x77], mode).unwrap();
            assert_eq!(
                (form(v.encoding), v.length, v.opcode),
                ("VEX_Vzeroupper", 3, 0xC4010077)
            );
            assert_eq!(v.base_opcode(), 0xC4010077);
        }
        for mode in [Real, Vm86] {
            let lds = at(&[0xC5, 0xF8, 0x77], mode).unwrap();
            assert!(lds.opcode == 0xC5 && lds.vex.is_none() && lds.length == 2);
        }
        // a memory ModRM byte: LES/LDS outside 64-bit mode (where it is
        // VEX, here with a reserved map)
        assert_eq!(
            at(&[0xC4, 0x00, 0x78, 0x77], Compatibility32)
                .unwrap()
                .opcode,
            0xC4
        );
        assert_eq!(
            at(&[0xC4, 0x00, 0x78, 0x77], Long64).unwrap_err(),
            DecodeError::UnknownOpcode(0xC4000077)
        );
        // 66, F2, F3, LOCK and REX before VEX: #UD at the first VEX byte; a
        // REX followed by another prefix is not in effect
        for prefix in [0x66, 0xF2, 0xF3, 0xF0, 0x40, 0x4F] {
            let bytes = [prefix, 0xC4, 0xE1, 0x7C, 0x77];
            let mut seen = Vec::new();
            let result = decode_with(GuestIp(0), Long64, |offset| {
                seen.push(offset);
                bytes.get(offset as usize).copied().ok_or(())
            });
            assert_eq!(result.unwrap_err(), DecodeError::InvalidOpcode);
            assert_eq!(seen.iter().max(), Some(&2));
        }
        assert_eq!(
            form(
                at(&[0x48, 0x2E, 0xC5, 0xF8, 0x77], Long64)
                    .unwrap()
                    .encoding
            ),
            "VEX_Vzeroupper"
        );
        // VPADDD ymm9, ymm10, [r12+r13*2+0x10]: R, X, B and all of VEX.vvvv
        let v = at(&[0xC4, 0x01, 0x2D, 0xFE, 0x4C, 0x6C, 0x10], Long64).unwrap();
        assert_eq!(
            (form(v.encoding), v.length, v.reg),
            ("VEX_Vpaddd_ymm_ymm_ymmm256", 7, Some(9))
        );
        let a = v.address.unwrap();
        assert_eq!(
            (a.base, a.index, a.scale, a.displacement),
            (AddressBase::Register(12), Some(13), 1, 0x10)
        );
        assert_eq!(v.vex.unwrap().vvvv, 10);
        // ... and the same bytes in compatibility mode are LES eax, [ecx]
        let les = at(&[0xC4, 0x01, 0x2D, 0xFE], Compatibility32).unwrap();
        assert!(les.opcode == 0xC4 && les.length == 2);
        // W1: 64-bit operands in 64-bit mode, ignored outside it
        for (bytes, long, compat) in [
            (
                &[0xC4, 0xE1, 0xF9, 0x6E, 0xC8][..],
                "VEX_Vmovq_xmm_rm64",
                "VEX_Vmovd_xmm_rm32",
            ),
            (
                &[0xC4, 0xE2, 0xF0, 0xF2, 0xC1],
                "VEX_Andn_r64_r64_rm64",
                "VEX_Andn_r32_r32_rm32",
            ),
            (
                &[0xC4, 0xE2, 0xB0, 0xF2, 0xC1],
                "VEX_Andn_r64_r64_rm64",
                "VEX_Andn_r32_r32_rm32",
            ),
        ] {
            let (l, c) = (
                at(bytes, Long64).unwrap(),
                at(bytes, Compatibility32).unwrap(),
            );
            assert_eq!((form(l.encoding), l.operand_size), (long, 64));
            assert_eq!((form(c.encoding), c.operand_size), (compat, 32));
        }
        // ANDN's VEX.vvvv names r9 in 64-bit mode, ecx outside it
        let andn = at(&[0xC4, 0xE2, 0xB0, 0xF2, 0xC1], Long64).unwrap();
        assert_eq!(andn.vex.unwrap().vvvv, 9);
        let andn = at(&[0xC4, 0xE2, 0xB0, 0xF2, 0xC1], Compatibility32).unwrap();
        assert_eq!(andn.vex.unwrap().vvvv, 1);
        // VEX.vvvv must be 1111b where it is not an operand; outside 64-bit
        // mode the three-byte prefix's top bit is ignored (SDM 2.3.5.6)
        for mode in [Long64, Compatibility32] {
            assert_eq!(
                at(&[0xC5, 0xF0, 0x77], mode).unwrap_err(),
                DecodeError::InvalidOpcode
            );
            assert_eq!(
                at(&[0xC4, 0xE1, 0x74, 0x77], mode).unwrap_err(),
                DecodeError::InvalidOpcode
            );
        }
        assert_eq!(
            at(&[0xC4, 0xE1, 0x3C, 0x77], Long64).unwrap_err(),
            DecodeError::InvalidOpcode
        );
        assert_eq!(
            form(
                at(&[0xC4, 0xE1, 0x3C, 0x77], Compatibility32)
                    .unwrap()
                    .encoding
            ),
            "VEX_Vzeroall"
        );
        // reserved maps and opcodes without rows: after the opcode byte
        let mut seen = Vec::new();
        let result = decode_with(GuestIp(0), Long64, |offset| {
            seen.push(offset);
            [0xC4, 0xE4, 0x78, 0x77, 0xC0]
                .get(offset as usize)
                .copied()
                .ok_or(())
        });
        assert_eq!(result.unwrap_err(), DecodeError::UnknownOpcode(0xC4040077));
        assert_eq!(seen.iter().max(), Some(&3));
        assert_eq!(
            at(&[0xC5, 0xF8, 0x00], Long64).unwrap_err(),
            DecodeError::UnknownOpcode(0xC4010000)
        );
        // VPGATHERDD xmm2, [rax+xmm9*4], xmm3; the index may not be the
        // destination or mask register
        let g = at(&[0xC4, 0xA2, 0x61, 0x90, 0x14, 0x88], Long64).unwrap();
        assert_eq!(
            (form(g.encoding), g.address.unwrap().index),
            ("VEX_Vpgatherdd_xmm_vm32x_xmm", Some(9))
        );
        assert_eq!(
            at(&[0xC4, 0xE2, 0x61, 0x90, 0x14, 0x98], Long64).unwrap_err(),
            DecodeError::InvalidOpcode
        );
        assert_eq!(
            at(&[0xC4, 0xE2, 0x61, 0x90, 0x14, 0xA0], Long64)
                .unwrap()
                .address
                .unwrap()
                .index,
            Some(4)
        );
        assert_eq!(
            at(&[0xC4, 0xE2, 0x61, 0x90, 0x10], Long64).unwrap_err(),
            DecodeError::InvalidOpcode
        );
        assert_eq!(
            at(&[0x67, 0xC4, 0xE2, 0x61, 0x90, 0x14, 0x88], Compatibility32).unwrap_err(),
            DecodeError::InvalidOpcode
        );
        // without the features or the semantics: #UD after the ModRM byte
        for (features, all) in [(0, true), (ALL, false)] {
            TEST_FEATURES.with(|f| f.set(features));
            TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(all));
            let bytes = [0xC4, 0x01, 0x2D, 0xFE, 0x4C];
            assert_eq!(at(&bytes, Long64).unwrap_err(), DecodeError::InvalidOpcode);
            assert!(matches!(
                at(&bytes[..4], Long64),
                Err(DecodeError::Fetch { offset: 4, .. })
            ));
        }
        TEST_FEATURES.with(|f| f.set(0));
        TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(false));
    }
    #[test]
    fn vex_rows_decode_from_their_own_encodings_in_every_mode() {
        use crate::cpu::features::{ALL, TEST_FEATURES};
        use crate::decode::{encodings, form, TEST_DECODE_UNIMPLEMENTED};
        use crate::decode_rules::vex;
        TEST_FEATURES.with(|f| f.set(ALL));
        TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(true));
        let mut count = 0;
        for row in encodings().iter().filter(|e| e.vex != 0) {
            let (map, pp) = ((row.opcode >> 16) as u8, (row.opcode >> 8 & 3) as u8);
            let (l, w) = (row.vex & vex::L1 != 0, row.vex & vex::W1 != 0);
            let vvvv = if row.vex & vex::VVVV != 0 { 3 } else { 0 };
            let group = if row.group >= 0 { row.group as u8 } else { 2 };
            let vsib = row.vex & vex::VSIB != 0;
            let mut operands = Vec::new();
            if row.fetch_modrm && !row.reg_ud {
                operands.push(vec![0xC0 | group << 3 | 1]);
            }
            if row.fetch_modrm && !row.mem_ud {
                operands.push(if vsib {
                    vec![0x44 | group << 3, 0x08, 0x10]
                }
                else {
                    vec![0x40 | group << 3, 0x10]
                });
            }
            if !row.fetch_modrm {
                operands.push(vec![]);
            }
            for mode in [
                ExecutionMode::Long64,
                ExecutionMode::Compatibility32,
                ExecutionMode::Protected16,
            ] {
                if row.vex & vex::LONG != 0 && !mode.is_long()
                    || vsib && mode == ExecutionMode::Protected16
                {
                    continue;
                }
                for operand in &operands {
                    let mut bytes = vec![
                        0xC4,
                        0xE0 | map,
                        (w as u8) << 7 | (!vvvv & 15) << 3 | (l as u8) << 2 | pp,
                        row.opcode as u8,
                    ];
                    bytes.extend(operand);
                    if row.immediate == ImmediateKind::Byte {
                        bytes.push(0x5A);
                    }
                    let d = decode(&bytes, GuestIp(0x1000), mode)
                        .unwrap_or_else(|e| panic!("{} {bytes:02X?} {mode:?} {e:?}", form(row)));
                    assert_eq!(
                        (form(d.encoding), d.length as usize),
                        (form(row), bytes.len()),
                        "{bytes:02X?} {mode:?}"
                    );
                    assert_eq!(
                        d.address.is_some(),
                        operand.first().is_some_and(|&m| m < 0xC0)
                    );
                    assert_eq!(
                        d.immediate.map(|i| i.value),
                        (row.immediate == ImmediateKind::Byte).then_some(0x5A)
                    );
                    if vsib {
                        assert_eq!(d.address.unwrap().index, Some(1));
                    }
                    count += 1;
                }
            }
        }
        TEST_FEATURES.with(|f| f.set(0));
        TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(false));
        assert!(count > 2000, "{count}");
    }
    #[test]
    fn prefetchw_consumes_the_complete_address_without_reading_data() {
        let prefetch = d(&[0x41, 0x0F, 0x0D, 0x8C, 0x24, 0xFF, 0xFF, 0xFF, 0x7F]);
        assert_eq!(prefetch.length, 9);
        assert_eq!(prefetch.reg, Some(1));
        assert!(prefetch.address.is_some());
    }
    #[test]
    fn rex_order_byte_registers_and_modes() {
        assert_eq!(d(&[0x48, 0x66, 0x89, 0xC0]).operand_size, 16);
        assert_eq!(d(&[0x66, 0x48, 0x89, 0xC0]).operand_size, 64);
        assert_eq!(d(&[0x48, 0x40, 0x89, 0xC0]).operand_size, 32);
        assert_eq!(d(&[0x40, 0x48, 0x89, 0xC0]).operand_size, 64);
        for r in 0..16 {
            assert_eq!(byte_register(r, true), ByteRegister::Low(r));
        }
        for r in 4..8 {
            assert_eq!(byte_register(r, false), ByteRegister::HighLegacy(r - 4));
        }
        for mode in [
            ExecutionMode::Real,
            ExecutionMode::Vm86,
            ExecutionMode::Protected16,
            ExecutionMode::Protected32,
            ExecutionMode::Compatibility16,
            ExecutionMode::Compatibility32,
        ] {
            let decoded = decode(&[0x48], GuestIp(0), mode).unwrap();
            assert_eq!(decoded.opcode, 0x48);
            assert_eq!(decoded.length, 1);
            assert_eq!(decoded.prefixes.rex, None);
        }
        assert_eq!(d(&[0x4D, 0x89, 0xFC]).reg, Some(15));
        assert_eq!(d(&[0x4D, 0x89, 0xFC]).rm_register, Some(12));
    }
    #[test]
    fn full_addresses_sib_and_rip_relative() {
        let decoded = d(&[0x48, 0x8B, 0x05, 0xFF, 0xFF, 0xFF, 0xFF]);
        assert_eq!(
            decoded.address.unwrap().offset(&[0; 16], decoded.next),
            decoded.next.0 - 1
        );
        let decoded = d(&[0x67, 0x48, 0x8B, 0x05, 0xFF, 0xFF, 0xFF, 0xFF]);
        assert_eq!(
            decoded.address.unwrap().offset(&[0; 16], decoded.next),
            ((decoded.next.0 - 1) as u32) as u64
        );
        let decoded = d(&[0x4B, 0x8B, 0x04, 0xA5, 0xFF, 0xFF, 0xFF, 0xFF]);
        let ea = decoded.address.unwrap();
        assert_eq!(ea.base, AddressBase::None);
        assert_eq!(ea.index, Some(12));
        let mut registers = [0; 16];
        registers[12] = 0x1_0000_0000;
        assert_eq!(ea.offset(&registers, decoded.next), 0x3_FFFF_FFFF);
        let ea = d(&[0x49, 0x8B, 0x44, 0x25, 0]).address.unwrap();
        assert_eq!(ea.base, AddressBase::Register(13));
        assert_eq!(ea.segment, 3);
        let decoded = d(&[0x64, 0x48, 0x8B, 0x00]);
        assert_eq!(decoded.address.unwrap().segment, 4);
    }
    #[test]
    fn immediate_width_sign_and_instruction_length() {
        assert_eq!(
            d(&[0x48, 0xB8, 1, 2, 3, 4, 5, 6, 7, 8])
                .immediate
                .unwrap()
                .value,
            0x0807_0605_0403_0201
        );
        let i = d(&[0x48, 0xC7, 0xC0, 0xFF, 0xFF, 0xFF, 0xFF])
            .immediate
            .unwrap();
        assert_eq!(i.value, u64::MAX);
        assert_eq!(i.encoded_bytes, 4);
        assert_eq!(
            d(&[0x48, 0xA1, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
                .immediate
                .unwrap()
                .value,
            u64::MAX
        );
        assert_eq!(
            d(&[0x67, 0xA1, 0xFF, 0xFF, 0xFF, 0xFF])
                .immediate
                .unwrap()
                .encoded_bytes,
            4
        );
        assert_eq!(
            d(&[0x66, 0xE8, 0xFF, 0xFF, 0xFF, 0xFF])
                .immediate
                .unwrap()
                .encoded_bytes,
            4
        );
        assert_eq!(d(&[0x41, 0x50]).operand_size, 64);
        assert_eq!(d(&[0x66, 0x41, 0x50]).operand_size, 16);
        assert_eq!(d(&[0x48, 0x0F, 0xC7, 0x0F]).operand_size, 128);
    }
    #[test]
    fn fetch_fault_priority_and_no_speculative_operand_reads() {
        let mut seen = Vec::new();
        let result = decode_with(GuestIp(4095), ExecutionMode::Long64, |offset| {
            seen.push(offset);
            if offset == 0 {
                Ok(0x48)
            }
            else {
                Err(14)
            }
        });
        assert_eq!(
            result.unwrap_err(),
            DecodeError::Fetch {
                offset: 1,
                error: 14
            }
        );
        assert_eq!(seen, vec![0, 1]);
        let mut seen = Vec::new();
        let result = decode_with(GuestIp(0), ExecutionMode::Long64, |offset| {
            seen.push(offset);
            Ok::<_, u8>(0x66)
        });
        assert_eq!(result.unwrap_err(), DecodeError::TooLong);
        assert_eq!(seen.len(), 15);
        // Invalid LOCK must not fetch an EA displacement or immediate.
        let mut seen = Vec::new();
        let result = decode_with(GuestIp(0), ExecutionMode::Long64, |offset| {
            seen.push(offset);
            [0xF0, 0x89, 0x05].get(offset as usize).copied().ok_or(14)
        });
        assert_eq!(result.unwrap_err(), DecodeError::InvalidOpcode);
        assert_eq!(seen, vec![0, 1, 2]);
        // (C4 and C5 are VEX prefixes in 64-bit mode)
        for byte in [0x06, 0x60, 0x62, 0x82, 0x9A, 0xCE, 0xD4, 0xEA] {
            assert!(matches!(
                decode(&[byte], GuestIp(0), ExecutionMode::Long64),
                Err(DecodeError::InvalidOpcode)
            ));
        }
        assert!(decode(&[0x0F, 0x01, 0xF8], GuestIp(0), ExecutionMode::Long64).is_ok());
    }
    #[test]
    fn independent_decoder_corpus() {
        let root = std::path::Path::new("build/x64-decode");
        std::fs::create_dir_all(root).unwrap();
        let mut rows = Vec::new();
        let mut add = |bytes: Vec<u8>, mode: ExecutionMode| {
            let decoded = decode(&bytes, GuestIp(0xFFFF_8000_0000_1000), mode).unwrap();
            let ea = decoded.address;
            let base = ea.map_or(-1, |ea| match ea.base {
                AddressBase::None => -1,
                AddressBase::NextRip => -2,
                AddressBase::Register(r) => r as i32,
            });
            let index = ea.and_then(|ea| ea.index).map_or(-1, |r| r as i32);
            let disp = ea.map_or(0, |ea| ea.offset(&[0; 16], decoded.next));
            let scale = ea.map_or(0, |ea| ea.scale);
            let segment = ea.map_or(0, |ea| ea.segment);
            let bitness = if mode.is_long() { 64 } else { mode.operand_default() };
            rows.push(format!(
                "[{:?},{},{},{},{},{},{},{},{},{},{},{}]",
                bytes,
                bitness,
                decoded.length,
                decoded.operand_size,
                decoded.address_size,
                decoded.reg.map_or(-1, |r| r as i32),
                decoded.rm_register.map_or(-1, |r| r as i32),
                base,
                index,
                scale,
                segment,
                disp
            ));
        };
        for mode in [
            ExecutionMode::Real,
            ExecutionMode::Vm86,
            ExecutionMode::Protected16,
            ExecutionMode::Protected32,
            ExecutionMode::Compatibility16,
            ExecutionMode::Compatibility32,
            ExecutionMode::Long64,
        ] {
            for address_override in [false, true] {
                for operand_override in [false, true] {
                    for rex in if mode.is_long() { 0x40..0x50 } else { 0..1 } {
                        for modrm in 0..=255u8 {
                            let sibs: &[u8] = if modrm & 7 == 4 && modrm < 0xC0 {
                                &[0, 0x24, 0x25, 0xA5, 0xFC, 0xFF]
                            }
                            else {
                                &[0]
                            };
                            for &sib in sibs {
                                let mut bytes = Vec::new();
                                if operand_override {
                                    bytes.push(0x66);
                                }
                                if address_override {
                                    bytes.push(0x67);
                                }
                                if mode.is_long() {
                                    bytes.push(rex);
                                }
                                bytes
                                    .extend([0x8B, modrm, sib, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]);
                                add(bytes, mode);
                            }
                        }
                    }
                }
            }
        }
        std::fs::write(root.join("corpus.json"), format!("[{}]", rows.join(","))).unwrap();
        assert!(rows.len() > 30_000);
    }
    /// Every one-byte, 0F, 0F38 and 0F3A opcode in long mode under common
    /// prefixes and ModRM forms, for tests/x64/oracle (iced-x86 validity,
    /// length and ModRM fields, gated by the advertised CPUID profile).
    #[test]
    fn opcode_map_corpus() {
        let root = std::path::Path::new("build/x64-decode");
        std::fs::create_dir_all(root).unwrap();
        let prefix_byte = |b: u8| matches!(b, 0x26 | 0x2E | 0x36 | 0x3E | 0x40..=0x4F | 0x64..=0x67 | 0xF0 | 0xF2 | 0xF3);
        let mut maps: Vec<Vec<u8>> = (0..=255u8)
            .filter(|&b| !prefix_byte(b) && b != 0x0F)
            .map(|b| vec![b])
            .collect();
        maps.extend(
            (0..=255u8)
                .filter(|&b| b != 0x38 && b != 0x3A)
                .map(|b| vec![0x0F, b]),
        );
        maps.extend((0..=255u8).map(|b| vec![0x0F, 0x38, b]));
        maps.extend((0..=255u8).map(|b| vec![0x0F, 0x3A, b]));
        let prefixes: [&[u8]; 11] = [
            &[],
            &[0x66],
            &[0xF2],
            &[0xF3],
            &[0x48],
            &[0x66, 0x48],
            &[0x67],
            &[0xF3, 0x48],
            &[0x41],
            &[0x44],
            &[0xF0],
        ];
        let mut rows = Vec::new();
        for opcode in &maps {
            for prefix in prefixes {
                for reg in 0..8u8 {
                    // register form, [rsp] via SIB, RIP+disp32, [rsp+disp8] via SIB
                    for modrm in [
                        0xC0 | reg << 3 | 1,
                        reg << 3 | 4,
                        reg << 3 | 5,
                        0x44 | reg << 3,
                    ] {
                        let mut bytes = prefix.to_vec();
                        bytes.extend(opcode);
                        bytes.push(modrm);
                        if modrm & 0xC7 == 0x04 || modrm & 0xC7 == 0x44 {
                            bytes.push(0x24);
                        }
                        bytes.resize(bytes.len() + 12, 0x11);
                        let (ok, length, width, r, rm) = match decode(
                            &bytes,
                            GuestIp(0xFFFF_8000_0000_1000),
                            ExecutionMode::Long64,
                        ) {
                            Ok(d) => (
                                1,
                                d.length as i32,
                                d.operand_size as i32,
                                d.reg.map_or(-1, |r| r as i32),
                                d.rm_register.map_or(-1, |r| r as i32),
                            ),
                            Err(_) => (0, 0, 0, -1, -1),
                        };
                        rows.push(format!(
                            "[{:?},{},{},{},{},{}]",
                            bytes, ok, length, width, r, rm
                        ));
                    }
                }
            }
        }
        std::fs::write(root.join("opcodes.json"), format!("[{}]", rows.join(","))).unwrap();
        assert!(rows.len() > 100_000);
    }
    #[test]
    fn rex_modrm_sib_product() {
        for rex in 0x40..=0x4F {
            for md in 0..4 {
                for rm in 0..8 {
                    for reg in 0..8 {
                        let bytes = [
                            rex,
                            0x8B,
                            md << 6 | reg << 3 | rm,
                            0x24,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                            0,
                        ];
                        let i = d(&bytes);
                        assert_eq!(i.reg, Some(reg | ((rex >> 2 & 1) << 3)));
                        if md == 3 {
                            assert_eq!(i.rm_register, Some(rm | ((rex & 1) << 3)));
                            assert!(i.address.is_none());
                        }
                        else {
                            assert!(i.address.is_some());
                        }
                    }
                }
            }
        }
    }
}
