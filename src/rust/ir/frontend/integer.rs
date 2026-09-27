//! Register integer semantics. Each arithmetic flag is an independent SSA source.
use crate::ir::{hir::*, ids::*, state::FlagState, types::Type};
pub struct IntegerBuilder {
    pub region: Region,
    pub block: BlockId,
    pub gpr: [ValueId; 8],
    pub flags: FlagState,
    pub effect: ValueId,
    pub xmm: Vec<ValueId>,
}
impl IntegerBuilder {
    pub fn new() -> Self {
        let mut region = Region::default();
        let block = region.block(true);
        let effect = region.param(block, Type::Effect);
        let gpr = std::array::from_fn(|r| {
            region.append(block, Op::ReadGpr(r as u8), vec![], &[Type::I32], None)[0]
        });
        // Keep system/raw roots distinct: CFG grafting maps them to different
        // block parameters, which may diverge after guest FLAGS changes.
        let flags = region.append(block, Op::ReadSystemFlags, vec![], &[Type::I32], None)[0];
        let raw_flags = region.append(block, Op::ReadRawFlags, vec![], &[Type::I32], None)[0];
        let raw_zero = region.append(
            block,
            Op::Extract { lsb: 6 },
            vec![raw_flags],
            &[Type::I1],
            None,
        )[0];
        let changes = region.append(block, Op::ReadFlagChanges, vec![], &[Type::I32], None)[0];
        let zero_is_lazy = region.append(
            block,
            Op::Extract { lsb: 6 },
            vec![changes],
            &[Type::I1],
            None,
        )[0];
        let last_op1 = region.append(block, Op::ReadFlagOperand, vec![], &[Type::I32], None)[0];
        let last_result = region.append(block, Op::ReadFlagResult, vec![], &[Type::I32], None)[0];
        let last_op_size = region.append(block, Op::ReadFlagSize, vec![], &[Type::I32], None)[0];
        let backing_valid = region.append(block, Op::Const(1), vec![], &[Type::I1], None)[0];
        let bits = std::array::from_fn(|i| {
            region.append(
                block,
                Op::ReadFlag([0, 2, 4, 6, 7, 11][i]),
                vec![],
                &[Type::I1],
                None,
            )[0]
        });
        Self {
            region,
            block,
            effect,
            gpr,
            xmm: vec![],
            flags: FlagState {
                arithmetic: bits,
                system: flags,
                last_op1: Some(last_op1),
                raw_zero: Some(raw_zero),
                zero_is_lazy: Some(zero_is_lazy),
                raw_flags: Some(raw_flags),
                lazy_mask: Some(changes),
                last_result: Some(last_result),
                last_op_size: Some(last_op_size),
                backing_valid: Some(backing_valid),
            },
        }
    }
    pub fn reload_cpu_state(&mut self, values: &[ValueId]) {
        assert!(matches!(values.len(), 14 | 22));
        self.gpr.copy_from_slice(&values[..8]);
        let flags = values[8];
        let raw = values[9];
        let changes = values[10];
        let arithmetic =
            std::array::from_fn(|i| self.extract(flags, [0, 2, 4, 6, 7, 11][i], Type::I1));
        let raw_zero = self.extract(raw, 6, Type::I1);
        let zero_is_lazy = self.extract(changes, 6, Type::I1);
        let valid = self.constant(1, Type::I1);
        self.flags = FlagState {
            arithmetic,
            system: raw,
            last_op1: Some(values[11]),
            raw_zero: Some(raw_zero),
            zero_is_lazy: Some(zero_is_lazy),
            raw_flags: Some(raw),
            lazy_mask: Some(changes),
            last_result: Some(values[12]),
            last_op_size: Some(values[13]),
            backing_valid: Some(valid),
        };
        if values.len() == 22 {
            self.xmm = values[14..].to_vec();
        }
    }
    pub fn ty(&self, value: ValueId) -> Type { self.region.values[value.index()].ty }
    pub fn node(&mut self, op: Op, args: Vec<ValueId>, ty: Type) -> ValueId {
        self.region.append(self.block, op, args, &[ty], None)[0]
    }
    pub fn constant(&mut self, n: u32, ty: Type) -> ValueId {
        let bits = ty.bits().unwrap();
        let mask = if bits >= 32 { u32::MAX } else { (1u32 << bits) - 1 };
        self.node(Op::Const((n & mask) as u64), vec![], ty)
    }
    pub fn binary(&mut self, op: Binary, a: ValueId, b: ValueId) -> ValueId {
        let ty = if matches!(op, Binary::Eq | Binary::Ult | Binary::Slt) {
            Type::I1
        }
        else {
            self.ty(a)
        };
        self.node(Op::Binary(op), vec![a, b], ty)
    }
    pub fn extract(&mut self, value: ValueId, lsb: u8, ty: Type) -> ValueId {
        self.node(Op::Extract { lsb }, vec![value], ty)
    }
    fn as_i32(&mut self, value: ValueId) -> ValueId {
        if self.ty(value) == Type::I32 {
            value
        }
        else {
            self.node(Op::Extend { signed: false }, vec![value], Type::I32)
        }
    }
    pub fn invalidate_flag_backing(&mut self) {
        let invalid = self.constant(0, Type::I1);
        self.flags.backing_valid = Some(invalid);
    }
    fn write_raw_flag_bit(&mut self, raw: ValueId, value: ValueId, bit: u8) -> ValueId {
        let mask = self.constant(!(1u32 << bit), Type::I32);
        let cleared = self.binary(Binary::And, raw, mask);
        let value = self.node(Op::Extend { signed: false }, vec![value], Type::I32);
        let value = if bit == 0 {
            value
        }
        else {
            let shift = self.constant(bit as u32, Type::I32);
            self.binary(Binary::Shl, value, shift)
        };
        self.binary(Binary::Or, cleared, value)
    }
    fn select_backing(&mut self, condition: ValueId, yes: ValueId, no: ValueId) -> ValueId {
        self.node(Op::Select, vec![condition, yes, no], self.ty(yes))
    }
    pub fn preserve_shift_backing(
        &mut self,
        unchanged: ValueId,
        raw_result: ValueId,
        carry: ValueId,
        overflow: ValueId,
        width: u8,
    ) {
        use crate::cpu::cpu::{FLAGS_ALL, FLAG_CARRY, FLAG_OVERFLOW};
        let (Some(old_raw), Some(old_mask), Some(old_result), Some(old_size)) = (
            self.flags.raw_flags,
            self.flags.lazy_mask,
            self.flags.last_result,
            self.flags.last_op_size,
        )
        else {
            self.invalidate_flag_backing();
            return;
        };
        let mut raw = self.write_raw_flag_bit(old_raw, carry, 0);
        raw = self.write_raw_flag_bit(raw, overflow, 11);
        let mask = self.constant((FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW) as u32, Type::I32);
        let result = self.as_i32(raw_result);
        let size = self.constant((width - 1) as u32, Type::I32);
        self.flags.raw_flags = Some(self.select_backing(unchanged, old_raw, raw));
        self.flags.lazy_mask = Some(self.select_backing(unchanged, old_mask, mask));
        self.flags.last_result = Some(self.select_backing(unchanged, old_result, result));
        self.flags.last_op_size = Some(self.select_backing(unchanged, old_size, size));
    }
    pub fn preserve_rotate_backing(
        &mut self,
        unchanged: ValueId,
        carry: ValueId,
        overflow: ValueId,
    ) {
        use crate::cpu::cpu::{FLAG_CARRY, FLAG_OVERFLOW};
        let (Some(old_raw), Some(old_mask)) = (self.flags.raw_flags, self.flags.lazy_mask)
        else {
            self.invalidate_flag_backing();
            return;
        };
        let mut raw = self.write_raw_flag_bit(old_raw, carry, 0);
        raw = self.write_raw_flag_bit(raw, overflow, 11);
        let clear = self.constant(!(FLAG_CARRY | FLAG_OVERFLOW) as u32, Type::I32);
        let mask = self.binary(Binary::And, old_mask, clear);
        self.flags.raw_flags = Some(self.select_backing(unchanged, old_raw, raw));
        self.flags.lazy_mask = Some(self.select_backing(unchanged, old_mask, mask));
    }
    pub fn preserve_raw_flag_bit(&mut self, value: ValueId, bit: u8) {
        let Some(raw) = self.flags.raw_flags
        else {
            self.invalidate_flag_backing();
            return;
        };
        self.flags.raw_flags = Some(self.write_raw_flag_bit(raw, value, bit));
    }
    pub fn preserve_cf_backing(&mut self, carry: ValueId) {
        use crate::cpu::cpu::FLAG_CARRY;
        let (Some(raw), Some(mask)) = (self.flags.raw_flags, self.flags.lazy_mask)
        else {
            self.invalidate_flag_backing();
            return;
        };
        self.flags.raw_flags = Some(self.write_raw_flag_bit(raw, carry, 0));
        let clear = self.constant(!FLAG_CARRY as u32, Type::I32);
        self.flags.lazy_mask = Some(self.binary(Binary::And, mask, clear));
    }
    pub fn preserve_mul_backing(&mut self, result: ValueId, overflow: ValueId, width: u8) {
        use crate::cpu::cpu::{FLAGS_ALL, FLAG_CARRY, FLAG_OVERFLOW};
        let Some(mut raw) = self.flags.raw_flags
        else {
            self.invalidate_flag_backing();
            return;
        };
        raw = self.write_raw_flag_bit(raw, overflow, 0);
        raw = self.write_raw_flag_bit(raw, overflow, 11);
        self.flags.raw_flags = Some(raw);
        self.flags.lazy_mask =
            Some(self.constant((FLAGS_ALL & !FLAG_CARRY & !FLAG_OVERFLOW) as u32, Type::I32));
        self.flags.last_result = Some(self.as_i32(result));
        self.flags.last_op_size = Some(self.constant((width - 1) as u32, Type::I32));
    }
    pub fn preserve_scan_backing(&mut self, result: ValueId, is_zero: ValueId, width: u8) {
        use crate::cpu::cpu::{FLAGS_ALL, FLAG_CARRY, FLAG_ZERO};
        let Some(mut raw) = self.flags.raw_flags
        else {
            self.invalidate_flag_backing();
            return;
        };
        let clear = self.constant(0, Type::I1);
        raw = self.write_raw_flag_bit(raw, clear, 0);
        raw = self.write_raw_flag_bit(raw, is_zero, 6);
        self.flags.raw_flags = Some(raw);
        self.flags.lazy_mask =
            Some(self.constant((FLAGS_ALL & !FLAG_ZERO & !FLAG_CARRY) as u32, Type::I32));
        self.flags.last_result = Some(self.as_i32(result));
        self.flags.last_op_size = Some(self.constant((width - 1) as u32, Type::I32));
    }
    pub fn preserve_popcnt_backing(&mut self, is_zero: ValueId) {
        use crate::cpu::cpu::FLAGS_ALL;
        let Some(raw) = self.flags.raw_flags
        else {
            self.invalidate_flag_backing();
            return;
        };
        let clear = self.constant(!(FLAGS_ALL as u32), Type::I32);
        let raw = self.binary(Binary::And, raw, clear);
        self.flags.raw_flags = Some(self.write_raw_flag_bit(raw, is_zero, 6));
        self.flags.lazy_mask = Some(self.constant(0, Type::I32));
    }
    pub fn preserve_incdec_backing(&mut self, carry: ValueId, dec: bool) {
        use crate::cpu::cpu::{FLAGS_ALL, FLAG_CARRY, FLAG_SUB};
        let Some(raw) = self.flags.raw_flags
        else {
            self.invalidate_flag_backing();
            return;
        };
        self.flags.raw_flags = Some(self.write_raw_flag_bit(raw, carry, 0));
        let mut mask = FLAGS_ALL & !FLAG_CARRY;
        if dec {
            mask |= FLAG_SUB;
        }
        self.flags.lazy_mask = Some(self.constant(mask as u32, Type::I32));
    }
    fn update_lazy_backing(&mut self, group: u8, result: ValueId, width: u8) {
        use crate::cpu::cpu::{FLAGS_ALL, FLAG_ADJUST, FLAG_CARRY, FLAG_OVERFLOW, FLAG_SUB};
        let result = self.as_i32(result);
        self.flags.last_result = Some(result);
        self.flags.last_op_size = Some(self.constant((width - 1) as u32, Type::I32));
        let logical = matches!(group, 1 | 4 | 6);
        if logical {
            let clear = !(FLAG_CARRY | FLAG_ADJUST | FLAG_OVERFLOW) as u32;
            let raw = self.flags.raw_flags.unwrap();
            let clear = self.constant(clear, Type::I32);
            self.flags.raw_flags = Some(self.binary(Binary::And, raw, clear));
            self.flags.lazy_mask = Some(self.constant(
                (FLAGS_ALL & !FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW) as u32,
                Type::I32,
            ));
        }
        else if matches!(group, 0 | 5 | 7) {
            let mask = if matches!(group, 5 | 7) {
                (FLAGS_ALL | FLAG_SUB) as u32
            }
            else {
                FLAGS_ALL as u32
            };
            self.flags.lazy_mask = Some(self.constant(mask, Type::I32));
        }
        else if matches!(group, 2 | 3) {
            let Some(mut raw) = self.flags.raw_flags
            else {
                self.invalidate_flag_backing();
                return;
            };
            for (index, bit) in [(0usize, 0u8), (2, 4), (5, 11)] {
                raw = self.write_raw_flag_bit(raw, self.flags.arithmetic[index], bit);
            }
            self.flags.raw_flags = Some(raw);
            let mut mask = FLAGS_ALL & !FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW;
            if group == 3 {
                mask |= FLAG_SUB;
            }
            self.flags.lazy_mask = Some(self.constant(mask as u32, Type::I32));
        }
        else {
            self.invalidate_flag_backing();
        }
    }
    pub fn read(&mut self, register: u8, width: u8) -> ValueId {
        let (r, lsb) = if width == 8 {
            (register & 3, if register >= 4 { 8 } else { 0 })
        }
        else {
            (register, 0)
        };
        if width == 32 {
            self.gpr[r as usize]
        }
        else {
            self.extract(self.gpr[r as usize], lsb, width_type(width))
        }
    }
    pub fn write(&mut self, register: u8, width: u8, value: ValueId) {
        let (r, lsb) = if width == 8 {
            (register & 3, if register >= 4 { 8 } else { 0 })
        }
        else {
            (register, 0)
        };
        self.gpr[r as usize] = if width == 32 {
            value
        }
        else {
            self.node(
                Op::Insert { lsb },
                vec![self.gpr[r as usize], value],
                Type::I32,
            )
        };
    }
    pub fn arithmetic(&mut self, group: u8, a: ValueId, b: ValueId) -> ValueId {
        let ty = self.ty(a);
        let width = ty.bits().unwrap();
        let sub = matches!(group, 3 | 5 | 7);
        let op = match group {
            0 | 2 => Binary::Add,
            1 => Binary::Or,
            3 | 5 | 7 => Binary::Sub,
            4 => Binary::And,
            6 => Binary::Xor,
            _ => unreachable!(),
        };
        if !matches!(group, 1 | 4 | 6) {
            self.flags.last_op1 = Some(if ty == Type::I32 {
                a
            }
            else {
                self.node(Op::Extend { signed: false }, vec![a], Type::I32)
            });
        }
        let first = self.binary(op, a, b);
        let result = if group == 2 || group == 3 {
            let carry = self.node(
                Op::Extend { signed: false },
                vec![self.flags.arithmetic[0]],
                ty,
            );
            self.binary(op, first, carry)
        }
        else {
            first
        };
        let zero = self.constant(0, ty);
        let cf;
        let af;
        let of;
        if matches!(group, 1 | 4 | 6) {
            cf = self.constant(0, Type::I1);
            of = cf;
            af = cf; // Baseline logical AF is zero.
        }
        else {
            let c1 = if sub {
                self.binary(Binary::Ult, a, b)
            }
            else {
                self.binary(Binary::Ult, first, a)
            };
            cf = if group == 2 || group == 3 {
                let c2 = if sub {
                    self.binary(Binary::Ult, first, result)
                }
                else {
                    self.binary(Binary::Ult, result, first)
                };
                self.binary(Binary::Or, c1, c2)
            }
            else {
                c1
            };
            let ab = self.binary(Binary::Xor, a, b);
            let ar = self.binary(Binary::Xor, a, result);
            let af_bits = self.binary(Binary::Xor, ab, result);
            af = self.extract(af_bits, 4, Type::I1);
            let rhs = if sub { ab } else { self.binary(Binary::Xor, b, result) };
            let overflow = self.binary(Binary::And, ar, rhs);
            of = self.extract(overflow, width - 1, Type::I1);
        }
        let zf = self.binary(Binary::Eq, result, zero);
        let sf = self.extract(result, width - 1, Type::I1);
        let mut parity = self.extract(result, 0, Type::I1);
        for bit in 1..8 {
            let v = self.extract(result, bit, Type::I1);
            parity = self.binary(Binary::Xor, parity, v);
        }
        let one = self.constant(1, Type::I1);
        let pf = self.binary(Binary::Xor, parity, one);
        self.flags.arithmetic = [cf, pf, af, zf, sf, of];
        self.flags.zero_is_lazy = Some(one);
        self.update_lazy_backing(group, result, width);
        result
    }
    pub fn condition(&mut self, cc: u8) -> ValueId {
        let [cf, pf, _, zf, sf, of] = self.flags.arithmetic;
        let value = match cc >> 1 {
            0 => of,
            1 => cf,
            2 => zf,
            3 => self.binary(Binary::Or, cf, zf),
            4 => sf,
            5 => pf,
            6 => self.binary(Binary::Xor, sf, of),
            7 => {
                let ne = self.binary(Binary::Xor, sf, of);
                self.binary(Binary::Or, zf, ne)
            },
            _ => unreachable!(),
        };
        if cc & 1 == 0 {
            value
        }
        else {
            let one = self.constant(1, Type::I1);
            self.binary(Binary::Xor, value, one)
        }
    }
}
pub fn width_type(width: u8) -> Type {
    match width {
        8 => Type::I8,
        16 => Type::I16,
        32 => Type::I32,
        _ => unreachable!(),
    }
}
