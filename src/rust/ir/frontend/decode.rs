//! Side-effect-free decoding over caller-owned code bytes. Never reads live CPU memory.
#[path = "encodings.rs"]
mod generated;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuestEip(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LinearAddress(pub u32);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PhysicalAddress(pub u32);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Prefixes {
    pub operand: bool,
    pub address: bool,
    pub lock: bool,
    // Baseline accumulates F2/F3 and chooses F2 first if both are present.
    pub repne: bool,
    pub rep: bool,
    pub segment: Option<u8>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImmediateKind {
    None,
    Byte,
    SignedByte,
    Word,
    Operand,
    Address,
}
#[derive(Debug)]
pub struct Encoding {
    pub id: u32,
    pub opcode: u32,
    pub group: i8,
    pub immediate: ImmediateKind,
    pub extra_bytes: u8,
    // Interpreter dispatch fetches ModRM before selecting the mandatory-prefix form.
    pub fetch_modrm: bool,
    pub group_ud: bool,
    pub task_switch_test: bool,
    pub custom: bool,
    pub e: bool,
    pub ignore_mod: bool,
    pub reg_ud: bool,
    pub mem_ud: bool,
    pub os: bool,
    pub block_boundary: bool,
    pub no_next_instruction: bool,
    pub absolute_jump: bool,
    pub jump_offset_imm: bool,
    pub conditional_jump: bool,
    pub custom_sti: bool,
    pub is_fpu: bool,
    pub sse: bool,
    pub is_string: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EffectiveAddress {
    pub base: Option<u8>,
    pub index: Option<u8>,
    pub scale: u8,
    pub displacement: u32,
    pub address_size: u8,
    pub segment: u8,
}
impl EffectiveAddress {
    /// Offset arithmetic only. Segmentation and translation belong to runtime lowering.
    pub fn offset(&self, gpr: &[u32; 8]) -> u32 {
        let result = self
            .displacement
            .wrapping_add(self.base.map_or(0, |r| gpr[r as usize]))
            .wrapping_add(
                self.index
                    .map_or(0, |r| gpr[r as usize].wrapping_shl(self.scale as u32)),
            );
        if self.address_size == 16 {
            result & 0xFFFF
        }
        else {
            result
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Flow {
    Next,
    Boundary,
    Stop,
    Sti,
    Relative {
        displacement: i32,
        conditional: bool,
        call: bool,
    },
}
#[derive(Clone, Debug)]
pub struct DecodedInstruction {
    pub encoding: &'static Encoding,
    pub instruction_pc: GuestEip,
    pub next_pc: GuestEip,
    pub linear_pc: LinearAddress,
    pub bytes: [u8; 15],
    pub length: u8,
    pub operand_size: u8,
    pub address_size: u8,
    pub prefixes: Prefixes,
    pub modrm: Option<u8>,
    pub modrm_offset: Option<u8>,
    pub ea: Option<EffectiveAddress>,
    pub immediate: Option<u32>,
    pub extra_immediate: Option<u16>,
    pub baseline_ud: bool,
    pub debug_prefix_assert: bool,
    pub flow: Flow,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeStop {
    Incomplete { available: usize },
    TooLong,
    UnknownEncoding { opcode: u32 },
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl Cursor<'_> {
    fn read(&mut self) -> Result<u8, DecodeStop> {
        if self.position == 15 {
            return Err(DecodeStop::TooLong);
        }
        let byte = *self
            .bytes
            .get(self.position)
            .ok_or(DecodeStop::Incomplete {
                available: self.bytes.len(),
            })?;
        self.position += 1;
        Ok(byte)
    }
    fn integer(&mut self, bytes: u8) -> Result<u32, DecodeStop> {
        let mut value = 0;
        for shift in 0..bytes {
            value |= (self.read()? as u32) << (shift * 8);
        }
        Ok(value)
    }
}

pub fn encodings() -> &'static [Encoding] { generated::ENCODINGS }
fn candidates(opcode: u32) -> &'static [Encoding] {
    match generated::OPCODES.binary_search_by_key(&opcode, |&(key, _, _)| key) {
        Ok(i) => {
            let (_, start, end) = generated::OPCODES[i];
            &generated::ENCODINGS[start..end]
        },
        Err(_) => &[],
    }
}

/// `bytes` is a logical contiguous instruction snapshot; it may span physical pages.
/// Missing bytes return a compile stop. The caller must deliver fetch faults during execution.
pub fn decode(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
) -> Result<DecodedInstruction, DecodeStop> {
    let mut c = Cursor { bytes, position: 0 };
    let mut prefixes = Prefixes::default();
    let mut debug_prefix_assert = false;
    let first = loop {
        let byte = c.read()?;
        use crate::decode_rules::{prefix, Prefix};
        match prefix(byte) {
            Some(Prefix::Segment(s)) => prefixes.segment = Some(s),
            Some(Prefix::Operand) => prefixes.operand = true,
            Some(Prefix::Address) => prefixes.address = true,
            Some(Prefix::Lock) => prefixes.lock = true,
            Some(Prefix::Repne) => {
                debug_prefix_assert |= prefixes.rep || prefixes.repne;
                prefixes.repne = true;
            },
            Some(Prefix::Rep) => {
                debug_prefix_assert |= prefixes.rep || prefixes.repne;
                prefixes.rep = true;
            },
            None => break byte,
        }
    };
    let base_opcode = if first == 0x0F { 0x0F00 | c.read()? as u32 } else { first as u32 };
    let operand_size = if default_32 != prefixes.operand { 32 } else { 16 };
    let address_size = if default_32 != prefixes.address { 32 } else { 16 };
    let mut available = 0;
    let variants = [
        (0x66, crate::prefix::PREFIX_66),
        (0xF2, crate::prefix::PREFIX_F2),
        (0xF3, crate::prefix::PREFIX_F3),
    ];
    let shift = if first == 0x0F { 16 } else { 8 };
    for (prefix, mask) in variants {
        if (prefix != 0x66 || first == 0x0F)
            && !candidates(prefix << shift | base_opcode).is_empty()
        {
            available |= mask;
        }
    }
    let flags = if prefixes.operand { crate::prefix::PREFIX_66 } else { 0 }
        | if prefixes.repne { crate::prefix::PREFIX_F2 } else { 0 }
        | if prefixes.rep { crate::prefix::PREFIX_F3 } else { 0 };
    let selected = crate::decode_rules::mandatory_prefix(flags, available);
    let opcode = variants
        .iter()
        .find(|(_, mask)| *mask == selected)
        .map_or(base_opcode, |(prefix, _)| prefix << shift | base_opcode);
    let rows = candidates(opcode);
    let first = rows.first().ok_or(DecodeStop::UnknownEncoding { opcode })?;
    let modrm_offset = if first.fetch_modrm { Some(c.position as u8) } else { None };
    let modrm = if first.fetch_modrm { Some(c.read()?) } else { None };
    let encoding = rows
        .iter()
        .find(|row| row.group < 0 || modrm.map(|m| (m >> 3 & 7) as i8) == Some(row.group))
        .ok_or(DecodeStop::UnknownEncoding { opcode })?;
    debug_prefix_assert |= available != 0
        && selected == 0
        && flags
            & if encoding.sse {
                crate::prefix::PREFIX_66 | crate::prefix::PREFIX_F2 | crate::prefix::PREFIX_F3
            }
            else {
                crate::prefix::PREFIX_F2 | crate::prefix::PREFIX_F3
            }
            != 0;
    let ea = match modrm {
        Some(m) if encoding.e && m < 0xC0 && !encoding.ignore_mod => {
            Some(decode_ea(&mut c, m, address_size, prefixes.segment)?)
        },
        _ => None,
    };
    let immediate = match encoding.immediate {
        ImmediateKind::None => None,
        ImmediateKind::Byte => Some(c.integer(1)?),
        ImmediateKind::SignedByte => Some(c.read()? as i8 as i32 as u32),
        ImmediateKind::Word => Some(c.integer(2)?),
        ImmediateKind::Operand => Some(c.integer(operand_size / 8)?),
        ImmediateKind::Address => Some(c.integer(address_size / 8)?),
    };
    let extra_immediate =
        if encoding.extra_bytes > 0 { Some(c.integer(encoding.extra_bytes)? as u16) } else { None };
    let baseline_ud = (if ea.is_some() { encoding.mem_ud } else { encoding.reg_ud })
        || prefixes.lock && !crate::decode_rules::lock_allowed(base_opcode, modrm);
    let flow = if encoding.jump_offset_imm {
        Flow::Relative {
            displacement: immediate.unwrap() as i32,
            conditional: encoding.conditional_jump,
            call: base_opcode == 0xE8,
        }
    }
    else if encoding.custom_sti {
        Flow::Sti
    }
    else if encoding.no_next_instruction {
        Flow::Stop
    }
    else if encoding.block_boundary || !encoding.custom && encoding.e || baseline_ud {
        Flow::Boundary
    }
    else {
        Flow::Next
    };
    let mut raw = [0; 15];
    raw[..c.position].copy_from_slice(&bytes[..c.position]);
    Ok(DecodedInstruction {
        encoding,
        instruction_pc: pc,
        next_pc: GuestEip(pc.0.wrapping_add(c.position as u32)),
        linear_pc: linear,
        bytes: raw,
        length: c.position as u8,
        operand_size,
        address_size,
        prefixes,
        modrm,
        modrm_offset,
        ea,
        immediate,
        extra_immediate,
        baseline_ud,
        debug_prefix_assert,
        flow,
    })
}

fn decode_ea(
    c: &mut Cursor<'_>,
    modrm: u8,
    size: u8,
    segment: Option<u8>,
) -> Result<EffectiveAddress, DecodeStop> {
    let sib = if size == 32 && modrm & 7 == 4 { Some(c.read()?) } else { None };
    let form = crate::decode_rules::address_form(modrm, size, sib);
    let displacement = if form.displacement_bytes == 1 {
        c.read()? as i8 as i32 as u32
    }
    else {
        c.integer(form.displacement_bytes)?
    };
    Ok(EffectiveAddress {
        base: form.base,
        index: form.index,
        scale: form.scale,
        displacement,
        address_size: size,
        segment: segment.unwrap_or(form.segment),
    })
}

#[cfg(test)]
#[path = "../../../../tests/ir/decode/decode.rs"]
mod tests;
