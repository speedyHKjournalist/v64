//! BMI1, BMI2, LZCNT and MOVBE (docs/simd-xsave-plan.md 9.2, P10): the
//! general-purpose register instructions' results and flags, shared by the
//! three engines. Values are operand-size integers (`bits`: 16, 32 or 64) in
//! the low bits of a u64. Flags are cpu::FLAG_*'s positions (OF, SF, ZF, AF,
//! PF, CF). The SDM leaves some flags undefined; v86 gives them one value:
//! AF 0, PF the parity of the result's low byte (as the logical
//! instructions), and where SF or OF is undefined (BEXTR; TZCNT and LZCNT)
//! the result's sign and 0.

use crate::cpu::{cpu, global_pointers as gp};

pub const CF: u32 = 1;
pub const PF: u32 = 1 << 2;
pub const AF: u32 = 1 << 4;
pub const ZF: u32 = 1 << 6;
pub const SF: u32 = 1 << 7;
pub const OF: u32 = 1 << 11;
/// The flags these instructions write
pub const ARITHMETIC: u32 = CF | PF | AF | ZF | SF | OF;

fn mask(bits: u32) -> u64 { u64::MAX >> (64 - bits) }
/// ZF, SF and PF of `result`, AF and OF clear, and CF
pub fn logic_flags(result: u64, bits: u32, cf: bool) -> u32 {
    let result = result & mask(bits);
    (result == 0) as u32 * ZF
        | (result >> (bits - 1) & 1) as u32 * SF
        | ((result as u8).count_ones() % 2 == 0) as u32 * PF
        | cf as u32 * CF
}

/// ANDN: NOT `a` AND `b`; SF, ZF from the result, CF and OF clear
pub fn andn(a: u64, b: u64, bits: u32) -> (u64, u32) {
    let r = !a & b & mask(bits);
    (r, logic_flags(r, bits, false))
}
/// BEXTR: `src`'s bits from `control`[7:0] on, `control`[15:8] of them
/// (those beyond the operand size are 0); ZF from the result, CF and OF clear
pub fn bextr(src: u64, control: u64, bits: u32) -> (u64, u32) {
    let (start, length) = ((control & 0xFF) as u32, (control >> 8 & 0xFF) as u32);
    let r = if start >= bits {
        0
    }
    else {
        let v = (src & mask(bits)) >> start;
        if length >= 64 {
            v
        }
        else {
            v & ((1 << length) - 1)
        }
    };
    (r, logic_flags(r, bits, false))
}
/// BLSI: the lowest set bit; SF, ZF from the result, CF if `src` is not 0
pub fn blsi(src: u64, bits: u32) -> (u64, u32) {
    let s = src & mask(bits);
    let r = s.wrapping_neg() & s;
    (r, logic_flags(r, bits, s != 0))
}
/// BLSMSK: the bits up to the lowest set one; SF from the result, ZF clear
/// (the result is never 0), CF if `src` is 0
pub fn blsmsk(src: u64, bits: u32) -> (u64, u32) {
    let s = src & mask(bits);
    let r = (s.wrapping_sub(1) ^ s) & mask(bits);
    (r, logic_flags(r, bits, s == 0))
}
/// BLSR: the lowest set bit cleared; SF, ZF from the result, CF if `src` is 0
pub fn blsr(src: u64, bits: u32) -> (u64, u32) {
    let s = src & mask(bits);
    let r = s.wrapping_sub(1) & s;
    (r, logic_flags(r, bits, s == 0))
}
/// BZHI: `src` with its bits from `index`[7:0] on cleared; SF, ZF from the
/// result, CF if the index is beyond the operand size (then `src` whole)
pub fn bzhi(src: u64, index: u64, bits: u32) -> (u64, u32) {
    let n = (index & 0xFF) as u32;
    let s = src & mask(bits);
    let r = if n < bits { s & ((1 << n) - 1) } else { s };
    (r, logic_flags(r, bits, n > bits - 1))
}
/// MULX: the unsigned product of `a` (EDX or RDX) and `b`: (high, low)
pub fn mulx(a: u64, b: u64, bits: u32) -> (u64, u64) {
    let p = (a & mask(bits)) as u128 * (b & mask(bits)) as u128;
    ((p >> bits) as u64 & mask(bits), p as u64 & mask(bits))
}
/// PDEP: `src`'s low bits in turn at the set bits of `selector`
pub fn pdep(src: u64, selector: u64, bits: u32) -> u64 {
    let (mut r, mut k) = (0, 0);
    for i in 0..bits {
        if selector >> i & 1 != 0 {
            r |= (src >> k & 1) << i;
            k += 1;
        }
    }
    r
}
/// PEXT: `src`'s bits at the set bits of `selector`, in turn from bit 0
pub fn pext(src: u64, selector: u64, bits: u32) -> u64 {
    let (mut r, mut k) = (0, 0);
    for i in 0..bits {
        if selector >> i & 1 != 0 {
            r |= (src >> i & 1) << k;
            k += 1;
        }
    }
    r
}
/// RORX: `src` rotated right by `count` modulo the operand size
pub fn rorx(src: u64, count: u8, bits: u32) -> u64 {
    let (s, n) = (src & mask(bits), count as u32 & (bits - 1));
    if n == 0 {
        s
    }
    else {
        (s >> n | s << (bits - n)) & mask(bits)
    }
}
/// SARX, SHLX, SHRX: `src` shifted by `count` modulo the operand size
pub fn sarx(src: u64, count: u64, bits: u32) -> u64 {
    let n = count as u32 & (bits - 1);
    ((((src << (64 - bits)) as i64) >> n >> (64 - bits)) as u64) & mask(bits)
}
pub fn shlx(src: u64, count: u64, bits: u32) -> u64 {
    src << (count as u32 & (bits - 1)) & mask(bits)
}
pub fn shrx(src: u64, count: u64, bits: u32) -> u64 {
    (src & mask(bits)) >> (count as u32 & (bits - 1))
}
/// TZCNT: the trailing zeros, the operand size for 0; ZF if the result is
/// 0, CF if `src` is 0
pub fn tzcnt(src: u64, bits: u32) -> (u64, u32) {
    let s = src & mask(bits);
    let r = if s == 0 { bits as u64 } else { s.trailing_zeros() as u64 };
    (r, logic_flags(r, bits, s == 0))
}
/// LZCNT: the leading zeros, the operand size for 0; as TZCNT's flags
pub fn lzcnt(src: u64, bits: u32) -> (u64, u32) {
    let s = src & mask(bits);
    let r = if s == 0 { bits as u64 } else { (s.leading_zeros() - (64 - bits)) as u64 };
    (r, logic_flags(r, bits, s == 0))
}
/// MOVBE: the bytes of an operand reversed
pub fn byte_swap(value: u64, bits: u32) -> u64 { (value & mask(bits)).swap_bytes() >> (64 - bits) }

/// The VEX-encoded BMI1 and BMI2 instructions
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vex {
    Andn,
    Bextr,
    Blsi,
    Blsmsk,
    Blsr,
    Bzhi,
    Mulx,
    Pdep,
    Pext,
    Rorx,
    Sarx,
    Shlx,
    Shrx,
}
impl Vex {
    /// The instruction of a VEX key (0xC4_MM_PP_OO: map, pp, opcode) and
    /// ModRM.reg (VEX.0F38 F3's group)
    pub fn of(key: u32, group: u8) -> Option<Vex> {
        use Vex::*;
        Some(match (key >> 16 & 0xFF, key >> 8 & 0xFF, key & 0xFF) {
            (2, 0, 0xF2) => Andn,
            (2, 0, 0xF3) => match group {
                1 => Blsr,
                2 => Blsmsk,
                3 => Blsi,
                _ => return None,
            },
            (2, 0, 0xF5) => Bzhi,
            (2, 2, 0xF5) => Pext,
            (2, 3, 0xF5) => Pdep,
            (2, 3, 0xF6) => Mulx,
            (2, 0, 0xF7) => Bextr,
            (2, 1, 0xF7) => Shlx,
            (2, 2, 0xF7) => Sarx,
            (2, 3, 0xF7) => Shrx,
            (3, 3, 0xF0) => Rorx,
            _ => return None,
        })
    }
}

/// An engine's operands of a VEX BMI instruction
pub trait Machine {
    type Fault;
    /// The r/m operand: a register's or memory's `bits` bits
    unsafe fn source(&mut self, bits: u32) -> Result<u64, Self::Fault>;
    unsafe fn gpr(&mut self, r: u8) -> u64;
    /// The low `bits` bits of `value` to register `r` (32 bits: the upper half
    /// zeroed in 64-bit mode)
    unsafe fn set_gpr(&mut self, r: u8, value: u64, bits: u32);
    /// OF, SF, ZF, AF, PF and CF to those of `flags`
    unsafe fn set_flags(&mut self, flags: u32);
}
/// The 32-bit engines (the interpreter, the IR's helper): the r/m operand a
/// register, or the dword at the linear address `address`
pub struct Interpreter {
    pub rm: Option<u8>,
    pub address: i32,
}
impl Machine for Interpreter {
    type Fault = ();
    unsafe fn source(&mut self, _bits: u32) -> Result<u64, ()> {
        Ok(match self.rm {
            Some(r) => cpu::read_reg32(r as i32) as u32 as u64,
            None => cpu::safe_read32s(self.address)? as u32 as u64,
        })
    }
    unsafe fn gpr(&mut self, r: u8) -> u64 { cpu::read_reg32(r as i32) as u32 as u64 }
    unsafe fn set_gpr(&mut self, r: u8, value: u64, _bits: u32) {
        cpu::write_reg32(r as i32, value as i32)
    }
    unsafe fn set_flags(&mut self, flags: u32) { set_flags(flags) }
}
/// The arithmetic flags of `flags`, the others kept (32-bit engines)
pub unsafe fn set_flags(flags: u32) {
    *gp::flags = *gp::flags & !cpu::FLAGS_ALL | flags as i32;
    *gp::flags_changed = 0;
}

/// A decoded VEX BMI instruction: ModRM.reg, VEX.vvvv, the operand size (64
/// with VEX.W1 in 64-bit mode, otherwise 32) and RORX's imm8
#[derive(Clone, Copy, Debug)]
pub struct Instruction {
    pub op: Vex,
    pub reg: u8,
    pub vvvv: u8,
    pub bits: u32,
    pub imm8: u8,
}
/// Execute `i`: the r/m operand first (a fault before any register changes),
/// then the destinations; MULX writes VEX.vvvv (the low half) before
/// ModRM.reg (the high half), which so wins when they are the same
pub unsafe fn execute<M: Machine>(m: &mut M, i: &Instruction) -> Result<(), M::Fault> {
    use Vex::*;
    let bits = i.bits;
    let source = m.source(bits)?;
    let (destination, value, flags) = match i.op {
        Andn => {
            let (r, f) = andn(m.gpr(i.vvvv), source, bits);
            (i.reg, r, Some(f))
        },
        Bextr => {
            let (r, f) = bextr(source, m.gpr(i.vvvv), bits);
            (i.reg, r, Some(f))
        },
        Blsi | Blsmsk | Blsr => {
            let (r, f) = match i.op {
                Blsi => blsi(source, bits),
                Blsmsk => blsmsk(source, bits),
                _ => blsr(source, bits),
            };
            (i.vvvv, r, Some(f))
        },
        Bzhi => {
            let (r, f) = bzhi(source, m.gpr(i.vvvv), bits);
            (i.reg, r, Some(f))
        },
        Mulx => {
            let (high, low) = mulx(m.gpr(2), source, bits);
            m.set_gpr(i.vvvv, low, bits);
            (i.reg, high, None)
        },
        Pdep => (i.reg, pdep(m.gpr(i.vvvv), source, bits), None),
        Pext => (i.reg, pext(m.gpr(i.vvvv), source, bits), None),
        Rorx => (i.reg, rorx(source, i.imm8, bits), None),
        Sarx => (i.reg, sarx(source, m.gpr(i.vvvv), bits), None),
        Shlx => (i.reg, shlx(source, m.gpr(i.vvvv), bits), None),
        Shrx => (i.reg, shrx(source, m.gpr(i.vvvv), bits), None),
    };
    m.set_gpr(destination, value, bits);
    if let Some(f) = flags {
        m.set_flags(f);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bit_fields_and_their_edges() {
        for bits in [32, 64] {
            let all = mask(bits);
            assert_eq!(andn(0xF0, 0xFF, bits), (0x0F, PF));
            assert_eq!(andn(all, all, bits), (0, ZF | PF));
            assert_eq!(andn(0, 1 << (bits - 1), bits).1, SF | PF);
            // BEXTR: start and length beyond the operand size, length 0
            assert_eq!(bextr(0xABCD, 0x0804, bits).0, 0xBC);
            assert_eq!(bextr(all, (bits as u64) << 0, bits), (0, ZF | PF));
            assert_eq!(bextr(all, 0xFF00 | 8, bits).0, all >> 8);
            assert_eq!(bextr(all, 0x0000, bits), (0, ZF | PF), "length 0");
            assert_eq!(bextr(all, 0x40_00, bits).0, all, "length 64");
            assert_eq!(
                bextr(0x8000_0000, 0x2000, 32).1,
                SF | PF,
                "SF from the result"
            );
            // BLSI, BLSMSK, BLSR
            assert_eq!(blsi(0b1011000, bits), (0b1000, CF));
            assert_eq!(blsi(0, bits), (0, ZF | PF));
            assert_eq!(blsmsk(0b1011000, bits), (0b1111, PF));
            assert_eq!(
                blsmsk(0, bits),
                (all, SF | PF | CF),
                "all ones for 0, ZF clear"
            );
            assert_eq!(blsr(0b1011000, bits), (0b1010000, PF));
            assert_eq!(blsr(0, bits), (0, ZF | PF | CF));
            assert_eq!(blsr(1 << (bits - 1), bits), (0, ZF | PF));
            // BZHI: the index from bits 7:0 only; beyond the operand size CF
            assert_eq!(bzhi(all, 4, bits), (0xF, PF));
            assert_eq!(bzhi(all, 0, bits), (0, ZF | PF));
            assert_eq!(bzhi(all, bits as u64 - 1, bits), (all >> 1, PF));
            assert_eq!(bzhi(all, bits as u64, bits), (all, SF | PF | CF));
            assert_eq!(bzhi(all, 0x1_04, bits), (0xF, PF), "index 7:0");
            assert_eq!(bzhi(all, 0xFF, bits).1 & CF, CF);
        }
    }
    #[test]
    fn multiply_deposit_extract_rotate_shift() {
        assert_eq!(mulx(u32::MAX as u64, u32::MAX as u64, 32), (0xFFFF_FFFE, 1));
        assert_eq!(mulx(u64::MAX, u64::MAX, 64), (u64::MAX - 1, 1));
        assert_eq!(mulx(1 << 40 | 3, 7, 32), (0, 21), "32 bits of each operand");
        for bits in [32, 64] {
            let all = mask(bits);
            assert_eq!(pdep(all, 0, bits), 0);
            assert_eq!(pdep(all, all, bits), all);
            assert_eq!(pdep(0b101, 0b1110_0000, bits), 0b1010_0000);
            assert_eq!(pext(all, 0, bits), 0);
            assert_eq!(pext(0b1010_0000, 0b1110_0000, bits), 0b101);
            assert_eq!(pext(all, all, bits), all);
            assert_eq!(
                pext(
                    pdep(0x1234_5678, 0xF0F0_F0F0_F0F0_F0F0, bits),
                    0xF0F0_F0F0_F0F0_F0F0,
                    bits
                ),
                0x1234_5678 & mask(bits / 2)
            );
            assert_eq!(rorx(1, 1, bits), 1 << (bits - 1));
            assert_eq!(rorx(0x12, bits as u8, bits), 0x12, "count modulo the size");
            assert_eq!(
                rorx(0x12, 4 + bits as u8, bits),
                0x12 >> 4 | 2 << (bits - 4)
            );
            assert_eq!(shlx(1, bits as u64 + 3, bits), 8);
            assert_eq!(shrx(all, bits as u64 - 1, bits), 1);
            assert_eq!(sarx(1 << (bits - 1), bits as u64 - 1, bits), all);
            assert_eq!(
                sarx(1 << (bits - 1), bits as u64, bits),
                1 << (bits - 1),
                "count modulo the size"
            );
            assert_eq!(sarx(0x40, 3, bits), 8);
        }
    }
    #[test]
    fn counts_and_byte_swaps() {
        for bits in [16, 32, 64] {
            assert_eq!(
                tzcnt(0, bits),
                (bits as u64, logic_flags(bits as u64, bits, true))
            );
            assert_eq!(
                lzcnt(0, bits),
                (bits as u64, logic_flags(bits as u64, bits, true))
            );
            assert_eq!(tzcnt(1, bits), (0, ZF | PF));
            assert_eq!(lzcnt(1 << (bits - 1), bits), (0, ZF | PF));
            assert_eq!(lzcnt(1, bits).0, bits as u64 - 1);
            assert_eq!(tzcnt(1 << (bits - 1), bits).0, bits as u64 - 1);
            assert_eq!(
                tzcnt(1 << bits.min(63), bits).0,
                if bits == 64 { 63 } else { bits as u64 },
                "only the operand's bits"
            );
        }
        assert_eq!(byte_swap(0x1234, 16), 0x3412);
        assert_eq!(byte_swap(0xFFFF_1234, 16), 0x3412);
        assert_eq!(byte_swap(0x1234_5678, 32), 0x7856_3412);
        assert_eq!(byte_swap(0x0102_0304_0506_0708, 64), 0x0807_0605_0403_0201);
    }
    #[test]
    fn vex_keys() {
        assert_eq!(Vex::of(0xC402_00F2, 0), Some(Vex::Andn));
        assert_eq!(Vex::of(0xC402_00F3, 1), Some(Vex::Blsr));
        assert_eq!(Vex::of(0xC402_00F3, 3), Some(Vex::Blsi));
        assert_eq!(Vex::of(0xC402_00F3, 4), None);
        assert_eq!(Vex::of(0xC402_03F5, 0), Some(Vex::Pdep));
        assert_eq!(Vex::of(0xC402_02F7, 0), Some(Vex::Sarx));
        assert_eq!(Vex::of(0xC403_03F0, 0), Some(Vex::Rorx));
        assert_eq!(Vex::of(0xC402_01F5, 0), None);
    }
}
