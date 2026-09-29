//! Native wide register blocks. This is an explicitly bounded subset:
//! unsupported/faultable guest instructions stop capture before that opcode.
//! Arithmetic and flags are Wasm i64/i32 operations, never interpreter calls.
use super::{
    decode::{self, AddressBase, AddressExpr, ByteRegister, Decoded},
    state::{self, ExecutionMode, GuestIp},
};
use crate::cpu::global_pointers as gp;
use crate::wasmgen::wasm_builder::{Signature, WasmBuilder, WasmLocal, WasmLocalI64, WasmType};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Register {
    pub index: u8,
    pub shift: u8,
    pub width: u8,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Value {
    Register(Register),
    Constant(u64),
}
#[derive(Clone, Debug)]
pub enum Operation {
    Move {
        target: Register,
        source: Value,
    },
    Alu {
        code: u8,
        target: Option<Register>,
        lhs: Value,
        rhs: Value,
        width: u8,
    },
    Exchange(Register, Register),
    Shift {
        target: Register,
        code: u8,
        count: u8,
    },
    ConditionalMove {
        target: Register,
        source: Value,
        condition: u8,
    },
    SetCondition {
        target: Register,
        condition: u8,
    },
    Popcount {
        target: Register,
        source: Value,
    },
    Bit {
        action: u8,
        target: Register,
        index: Value,
    },
    Lea {
        target: Register,
        address: AddressExpr,
    },
    Jump {
        condition: Option<u8>,
        target: GuestIp,
    },
    Nop,
}
#[derive(Clone, Debug)]
pub struct Instruction {
    pub start: GuestIp,
    pub next: GuestIp,
    pub operation: Operation,
}
#[derive(Clone, Debug)]
pub struct Plan {
    pub start: GuestIp,
    pub end: GuestIp,
    pub source_bytes: usize,
    pub instructions: Vec<Instruction>,
}
#[derive(Clone, Debug)]
pub struct Artifact {
    pub bytes: Vec<u8>,
    pub plan: Plan,
    pub native_instructions: u32,
    pub locals: usize,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompileError {
    Empty,
    Budget,
    Unsupported,
}
fn mask(w: u8) -> u64 {
    if w == 64 {
        u64::MAX
    }
    else {
        (1u64 << w) - 1
    }
}
fn register(encoded: u8, width: u8, d: &Decoded) -> Register {
    if width == 8 {
        match decode::byte_register(encoded, d.prefixes.rex.is_some()) {
            ByteRegister::Low(index) => Register {
                index,
                shift: 0,
                width,
            },
            ByteRegister::HighLegacy(index) => Register {
                index,
                shift: 8,
                width,
            },
        }
    }
    else {
        Register {
            index: encoded,
            shift: 0,
            width,
        }
    }
}
fn operation(d: &Decoded) -> Option<Operation> {
    let op = d.base_opcode();
    let w = d.operand_size;
    if d.prefixes.lock || d.prefixes.rep.is_some() && op != 0x90 && d.opcode != 0xF30FB8 {
        return None;
    }
    let reg = |r, width| register(r, width, d);
    let value = |r, width| Value::Register(reg(r, width));
    let rm = |width| d.rm_register.map(|r| value(r, width));
    let immediate = || d.immediate.map(|v| Value::Constant(v.value));
    Some(match op {
        0x00..=0x3D if op & 7 <= 5 => {
            let code = (op >> 3) as u8;
            let width = if op & 1 == 0 { 8 } else { w };
            let form = op & 7;
            let (lhs, rhs, target) = if form <= 1 {
                (rm(width)?, value(d.reg?, width), d.rm_register?)
            }
            else if form <= 3 {
                (value(d.reg?, width), rm(width)?, d.reg?)
            }
            else {
                (value(0, width), immediate()?, 0)
            };
            Operation::Alu {
                code,
                target: if code == 7 { None } else { Some(reg(target, width)) },
                lhs,
                rhs,
                width,
            }
        },
        0x80 | 0x81 | 0x83 => {
            let code = d.modrm? >> 3 & 7;
            let width = if op == 0x80 { 8 } else { w };
            Operation::Alu {
                code,
                target: if code == 7 { None } else { Some(reg(d.rm_register?, width)) },
                lhs: rm(width)?,
                rhs: immediate()?,
                width,
            }
        },
        0x84 | 0x85 | 0xA8 | 0xA9 => {
            let width = if op & 1 == 0 { 8 } else { w };
            let (lhs, rhs) = if op < 0xA0 {
                (rm(width)?, value(d.reg?, width))
            }
            else {
                (value(0, width), immediate()?)
            };
            Operation::Alu {
                code: 4,
                target: None,
                lhs,
                rhs,
                width,
            }
        },
        0x88..=0x8B => {
            let width = if op & 1 == 0 { 8 } else { w };
            if op & 2 == 0 {
                Operation::Move {
                    target: reg(d.rm_register?, width),
                    source: value(d.reg?, width),
                }
            }
            else {
                Operation::Move {
                    target: reg(d.reg?, width),
                    source: rm(width)?,
                }
            }
        },
        0xB0..=0xBF => {
            let width = if op < 0xB8 { 8 } else { w };
            Operation::Move {
                target: reg(d.opcode_register?, width),
                source: immediate()?,
            }
        },
        0xC6 | 0xC7 => {
            let width = if op == 0xC6 { 8 } else { w };
            Operation::Move {
                target: reg(d.rm_register?, width),
                source: immediate()?,
            }
        },
        0x86 | 0x87 => {
            let width = if op == 0x86 { 8 } else { w };
            Operation::Exchange(reg(d.rm_register?, width), reg(d.reg?, width))
        },
        0x90..=0x97 => {
            let r = d.opcode_register?;
            if r == 0 {
                Operation::Nop
            }
            else {
                Operation::Exchange(reg(0, w), reg(r, w))
            }
        },
        0x0F40..=0x0F4F => Operation::ConditionalMove {
            target: reg(d.reg?, w),
            source: rm(w)?,
            condition: op as u8 & 15,
        },
        0x0F90..=0x0F9F => Operation::SetCondition {
            target: reg(d.rm_register?, 8),
            condition: op as u8 & 15,
        },
        0x0FB8 if d.opcode == 0xF30FB8 => Operation::Popcount {
            target: reg(d.reg?, w),
            source: rm(w)?,
        },
        0x0FA3 | 0x0FAB | 0x0FB3 | 0x0FBB | 0x0FBA => Operation::Bit {
            action: if op == 0x0FBA { (d.modrm? >> 3 & 7) - 4 } else { ((op >> 3) & 3) as u8 },
            target: reg(d.rm_register?, w),
            index: if op == 0x0FBA { immediate()? } else { value(d.reg?, w) },
        },
        0xC0 | 0xC1 | 0xD0 | 0xD1 => {
            let width = if op & 1 == 0 { 8 } else { w };
            Operation::Shift {
                target: reg(d.rm_register?, width),
                code: d.modrm? >> 3 & 7,
                count: if op < 0xD0 { d.immediate?.value as u8 } else { 1 },
            }
        },
        0x8D => Operation::Lea {
            target: reg(d.reg?, w),
            address: d.address?,
        },
        0xEB | 0xE9 | 0x70..=0x7F | 0x0F80..=0x0F8F => {
            let i = d.immediate?;
            let offset =
                if i.encoded_bytes == 1 { i.value as i8 as i64 } else { i.value as i32 as i64 };
            let target = GuestIp(d.next.0.wrapping_add(offset as u64));
            if !state::canonical(target.0, 48) {
                return None;
            }
            Operation::Jump {
                condition: if matches!(op, 0xEB | 0xE9) { None } else { Some(op as u8 & 15) },
                target,
            }
        },
        0x0F1F => Operation::Nop,
        _ => return None,
    })
}
pub fn plan(bytes: &[u8], start: GuestIp, max_instructions: usize) -> Result<Plan, CompileError> {
    if max_instructions == 0 || max_instructions > 256 || bytes.len() > 4096 {
        return Err(CompileError::Budget);
    }
    let mut instructions = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() && instructions.len() < max_instructions {
        let Ok(d) = decode::decode(
            &bytes[offset..],
            GuestIp(start.0.wrapping_add(offset as u64)),
            ExecutionMode::Long64,
        )
        else {
            break;
        };
        let Some(operation) = operation(&d)
        else {
            break;
        };
        let terminal = matches!(operation, Operation::Jump { .. });
        offset += d.length as usize;
        instructions.push(Instruction {
            start: d.start,
            next: d.next,
            operation,
        });
        if terminal {
            break;
        }
    }
    if instructions.is_empty() {
        return Err(CompileError::Unsupported);
    }
    Ok(Plan {
        start,
        end: GuestIp(start.0.wrapping_add(offset as u64)),
        source_bytes: offset,
        instructions,
    })
}
struct Emitter {
    w: WasmBuilder,
    gpr: Vec<WasmLocalI64>,
    flags: WasmLocal,
    count: WasmLocal,
    a: WasmLocalI64,
    b: WasmLocalI64,
    r: WasmLocalI64,
    flag: WasmLocal,
}
impl Emitter {
    fn value(&mut self, value: Value) {
        match value {
            Value::Constant(v) => self.w.const_i64(v as i64),
            Value::Register(r) => {
                self.w.get_local_i64(&self.gpr[r.index as usize]);
                if r.shift != 0 {
                    self.w.const_i64(r.shift as i64);
                    self.w.shr_u_i64();
                }
                if r.width < 64 {
                    self.w.const_i64(mask(r.width) as i64);
                    self.w.and_i64();
                }
            },
        }
    }
    fn target(&mut self, target: Register) {
        if target.width == 64 {
            self.w.get_local_i64(&self.r);
        }
        else if target.width == 32 {
            self.w.get_local_i64(&self.r);
            self.w.const_i64(0xFFFF_FFFF);
            self.w.and_i64();
        }
        else {
            self.w.get_local_i64(&self.gpr[target.index as usize]);
            self.w
                .const_i64(!(mask(target.width) << target.shift) as i64);
            self.w.and_i64();
            self.w.get_local_i64(&self.r);
            self.w.const_i64(mask(target.width) as i64);
            self.w.and_i64();
            if target.shift != 0 {
                self.w.const_i64(target.shift as i64);
                self.w.shl_i64();
            }
            self.w.or_i64();
        }
        self.w.set_local_i64(&self.gpr[target.index as usize]);
        self.commit_register(target.index);
    }
    fn commit_register(&mut self, r: u8) {
        self.w.const_i32(state::gpr_low_offset(r as usize) as i32);
        self.w.get_local_i64(&self.gpr[r as usize]);
        self.w.wrap_i64_to_i32();
        self.w.store_aligned_i32(0);
        self.w.const_i32(state::gpr_high_offset(r as usize) as i32);
        self.w.get_local_i64(&self.gpr[r as usize]);
        self.w.const_i64(32);
        self.w.shr_u_i64();
        self.w.wrap_i64_to_i32();
        self.w.store_aligned_i32(0);
    }
    fn fixed(&mut self, at: u32, value: u32) {
        self.w.const_i32(at as i32);
        self.w.const_i32(value as i32);
        self.w.store_aligned_i32(0);
    }
    fn rip(&mut self, rip: GuestIp) {
        self.fixed(gp::instruction_pointer as u32, rip.0 as u32);
        self.fixed(gp::x64_rip_hi as u32, (rip.0 >> 32) as u32);
    }
    fn flag_or(&mut self, bit: u32) {
        self.w.const_i32(bit as i32);
        self.w.mul_i32();
        self.w.get_local(&self.flag);
        self.w.or_i32();
        self.w.set_local(&self.flag);
    }
    fn arithmetic(&mut self, code: u8, width: u8) {
        self.w.get_local_i64(&self.a);
        self.w.get_local_i64(&self.b);
        match code {
            0 | 2 => self.w.add_i64(),
            1 => self.w.or_i64(),
            4 => self.w.and_i64(),
            3 | 5 | 7 => self.w.sub_i64(),
            6 => self.w.xor_i64(),
            _ => unreachable!(),
        };
        if matches!(code, 2 | 3) {
            self.w.get_local(&self.flags);
            self.w.const_i32(1);
            self.w.and_i32();
            self.w.extend_unsigned_i32_to_i64();
            if code == 2 {
                self.w.add_i64();
            }
            else {
                self.w.sub_i64();
            }
        }
        if width < 64 {
            self.w.const_i64(mask(width) as i64);
            self.w.and_i64();
        }
        self.w.set_local_i64(&self.r);
        self.w.get_local(&self.flags);
        self.w.const_i32(!0x8D5);
        self.w.and_i32();
        self.w.set_local(&self.flag);
        self.w.get_local_i64(&self.r);
        self.w.const_i64(0);
        self.w.eq_i64();
        self.flag_or(64);
        self.w.get_local_i64(&self.r);
        self.w.const_i64((width - 1) as i64);
        self.w.shr_u_i64();
        self.w.wrap_i64_to_i32();
        self.flag_or(128);
        self.w.get_local_i64(&self.r);
        self.w.wrap_i64_to_i32();
        self.w.const_i32(255);
        self.w.and_i32();
        self.w.popcnt_i32();
        self.w.const_i32(1);
        self.w.and_i32();
        self.w.eqz_i32();
        self.flag_or(4);
        if matches!(code, 0 | 2 | 3 | 5 | 7) {
            if code == 0 || code == 2 {
                self.w.get_local_i64(&self.r);
                self.w.get_local_i64(&self.a);
                self.w.ltu_i64();
            }
            else {
                self.w.get_local_i64(&self.a);
                self.w.get_local_i64(&self.b);
                self.w.ltu_i64();
            }
            if matches!(code, 2 | 3) {
                self.w.get_local(&self.flags);
                self.w.const_i32(1);
                self.w.and_i32();
                self.w.get_local_i64(&self.a);
                self.w
                    .get_local_i64(if code == 2 { &self.r } else { &self.b });
                self.w.eq_i64();
                self.w.and_i32();
                self.w.or_i32();
            }
            self.flag_or(1);
            self.w.get_local_i64(&self.a);
            self.w.get_local_i64(&self.b);
            self.w.xor_i64();
            if code == 0 || code == 2 {
                self.w.const_i64(-1);
                self.w.xor_i64();
            }
            self.w.get_local_i64(&self.a);
            self.w.get_local_i64(&self.r);
            self.w.xor_i64();
            self.w.and_i64();
            self.w.const_i64((width - 1) as i64);
            self.w.shr_u_i64();
            self.w.const_i64(1);
            self.w.and_i64();
            self.w.wrap_i64_to_i32();
            self.flag_or(2048);
            self.w.get_local_i64(&self.a);
            self.w.get_local_i64(&self.b);
            self.w.xor_i64();
            self.w.get_local_i64(&self.r);
            self.w.xor_i64();
            self.w.const_i64(16);
            self.w.and_i64();
            self.w.wrap_i64_to_i32();
            self.w.get_local(&self.flag);
            self.w.or_i32();
            self.w.set_local(&self.flag);
        }
        self.w.get_local(&self.flag);
        self.w.set_local(&self.flags);
        self.w.const_i32(gp::flags as i32);
        self.w.get_local(&self.flags);
        self.w.store_aligned_i32(0);
        self.fixed(gp::flags_changed as u32, 0);
    }
    fn commit_flags(&mut self) {
        self.w.get_local(&self.flag);
        self.w.set_local(&self.flags);
        self.w.const_i32(gp::flags as i32);
        self.w.get_local(&self.flags);
        self.w.store_aligned_i32(0);
        self.fixed(gp::flags_changed as u32, 0);
    }
    fn szp(&mut self, width: u8) {
        self.w.get_local_i64(&self.r);
        self.w.const_i64(0);
        self.w.eq_i64();
        self.flag_or(64);
        self.w.get_local_i64(&self.r);
        self.w.const_i64((width - 1) as i64);
        self.w.shr_u_i64();
        self.w.wrap_i64_to_i32();
        self.flag_or(128);
        self.w.get_local_i64(&self.r);
        self.w.wrap_i64_to_i32();
        self.w.const_i32(255);
        self.w.and_i32();
        self.w.popcnt_i32();
        self.w.const_i32(1);
        self.w.and_i32();
        self.w.eqz_i32();
        self.flag_or(4);
    }
    fn shift(&mut self, code: u8, count: u8, width: u8) {
        let raw = count & if width == 64 { 63 } else { 31 };
        let count = match code {
            0 | 1 => raw % width,
            2 | 3 if width < 32 => raw % (width + 1),
            _ => raw,
        };
        if count == 0 {
            self.w.get_local_i64(&self.a);
            self.w.set_local_i64(&self.r);
            if raw != 0 && code <= 1 {
                self.w.get_local(&self.flags);
                self.w.const_i32(!1);
                self.w.and_i32();
                self.w.set_local(&self.flag);
                self.w.get_local_i64(&self.r);
                self.w
                    .const_i64(if code == 0 { 0 } else { (width - 1) as i64 });
                self.w.shr_u_i64();
                self.w.const_i64(1);
                self.w.and_i64();
                self.w.wrap_i64_to_i32();
                self.flag_or(1);
                self.commit_flags();
            }
            return;
        }
        match code {
            0 | 1 => {
                self.w.get_local_i64(&self.a);
                self.w.const_i64(count as i64);
                if code == 0 {
                    self.w.shl_i64();
                }
                else {
                    self.w.shr_u_i64();
                }
                self.w.get_local_i64(&self.a);
                self.w.const_i64((width - count) as i64);
                if code == 0 {
                    self.w.shr_u_i64();
                }
                else {
                    self.w.shl_i64();
                }
                self.w.or_i64();
            },
            2 | 3 => {
                self.w.get_local_i64(&self.a);
                self.w.const_i64(count as i64);
                if code == 2 {
                    self.w.shl_i64();
                }
                else {
                    self.w.shr_u_i64();
                }
                self.w.get_local(&self.flags);
                self.w.const_i32(1);
                self.w.and_i32();
                self.w.extend_unsigned_i32_to_i64();
                self.w.const_i64(if code == 2 {
                    (count - 1) as i64
                }
                else {
                    (width - count) as i64
                });
                self.w.shl_i64();
                self.w.or_i64();
                if count > 1 {
                    self.w.get_local_i64(&self.a);
                    self.w.const_i64((width + 1 - count) as i64);
                    if code == 2 {
                        self.w.shr_u_i64();
                    }
                    else {
                        self.w.shl_i64();
                    }
                    self.w.or_i64();
                }
            },
            4 | 5 | 6 => {
                if count >= width {
                    self.w.const_i64(0);
                }
                else {
                    self.w.get_local_i64(&self.a);
                    self.w.const_i64(count as i64);
                    if code == 5 {
                        self.w.shr_u_i64();
                    }
                    else {
                        self.w.shl_i64();
                    }
                }
            },
            7 => {
                self.w.get_local_i64(&self.a);
                if width < 64 {
                    self.w.const_i64((64 - width) as i64);
                    self.w.shl_i64();
                    self.w.const_i64((64 - width) as i64);
                    self.w.shr_s_i64();
                }
                self.w.const_i64(count as i64);
                self.w.shr_s_i64();
            },
            _ => unreachable!(),
        }
        self.w.const_i64(mask(width) as i64);
        self.w.and_i64();
        self.w.set_local_i64(&self.r);
        self.w.get_local(&self.flags);
        self.w.const_i32(if code >= 4 { !0xC5 } else { !1 });
        self.w.and_i32();
        self.w.set_local(&self.flag);
        if code >= 4 {
            self.szp(width);
        }
        if code >= 4 && code != 7 && count > width {
            self.w.const_i32(0);
        }
        else {
            self.w
                .get_local_i64(if code <= 1 { &self.r } else { &self.a });
            let shift = match code {
                0 => 0,
                1 => width - 1,
                2 | 4 | 6 => width - count,
                3 | 5 => count - 1,
                7 => {
                    if count >= width {
                        width - 1
                    }
                    else {
                        count - 1
                    }
                },
                _ => unreachable!(),
            };
            self.w.const_i64(shift as i64);
            self.w.shr_u_i64();
            self.w.const_i64(1);
            self.w.and_i64();
            self.w.wrap_i64_to_i32();
        }
        self.flag_or(1);
        if raw == 1 {
            self.w.get_local(&self.flag);
            self.w.const_i32(!2048);
            self.w.and_i32();
            self.w.set_local(&self.flag);
            match code {
                0 | 2 | 4 | 6 => {
                    self.w.get_local_i64(&self.r);
                    self.w.const_i64((width - 1) as i64);
                    self.w.shr_u_i64();
                    self.w.wrap_i64_to_i32();
                    self.w.get_local(&self.flag);
                    self.w.const_i32(1);
                    self.w.and_i32();
                    self.w.xor_i32();
                },
                1 | 3 => {
                    self.w.get_local_i64(&self.r);
                    self.w.const_i64((width - 1) as i64);
                    self.w.shr_u_i64();
                    self.w.get_local_i64(&self.r);
                    self.w.const_i64((width - 2) as i64);
                    self.w.shr_u_i64();
                    self.w.xor_i64();
                    self.w.const_i64(1);
                    self.w.and_i64();
                    self.w.wrap_i64_to_i32();
                },
                5 => {
                    self.w.get_local_i64(&self.a);
                    self.w.const_i64((width - 1) as i64);
                    self.w.shr_u_i64();
                    self.w.wrap_i64_to_i32();
                },
                7 => self.w.const_i32(0),
                _ => unreachable!(),
            };
            self.flag_or(2048);
        }
        self.commit_flags();
    }
    fn flag_bool(&mut self, mask: u32) {
        self.w.get_local(&self.flags);
        self.w.const_i32(mask as i32);
        self.w.and_i32();
        self.w.const_i32(0);
        self.w.ne_i32();
    }
    fn condition(&mut self, cc: u8) {
        match cc >> 1 {
            0 => self.flag_bool(0x800),
            1 => self.flag_bool(1),
            2 => self.flag_bool(64),
            3 => self.flag_bool(65),
            4 => self.flag_bool(128),
            5 => self.flag_bool(4),
            6 => {
                self.flag_bool(128);
                self.flag_bool(2048);
                self.w.xor_i32();
            },
            7 => {
                self.flag_bool(128);
                self.flag_bool(2048);
                self.w.xor_i32();
                self.flag_bool(64);
                self.w.or_i32();
            },
            _ => unreachable!(),
        };
        if cc & 1 != 0 {
            self.w.eqz_i32();
        }
    }
    fn lea(&mut self, address: AddressExpr, next: GuestIp) {
        match address.base {
            AddressBase::None => self.w.const_i64(0),
            AddressBase::Register(r) => self.w.get_local_i64(&self.gpr[r as usize]),
            AddressBase::NextRip => self.w.const_i64(next.0 as i64),
        };
        if let Some(r) = address.index {
            self.w.get_local_i64(&self.gpr[r as usize]);
            self.w.const_i64(address.scale as i64);
            self.w.shl_i64();
            self.w.add_i64();
        }
        self.w.const_i64(address.displacement);
        self.w.add_i64();
        if address.address_size < 64 {
            self.w.const_i64(mask(address.address_size) as i64);
            self.w.and_i64();
        }
        self.w.set_local_i64(&self.r);
    }
}
pub fn compile(
    bytes: &[u8],
    start: GuestIp,
    guard_token: u64,
    max_instructions: usize,
) -> Result<Artifact, CompileError> {
    let plan = plan(bytes, start, max_instructions)?;
    let mut w = WasmBuilder::new();
    w.set_entry_result();
    let gpr = (0..16).map(|_| w.declare_zeroed_local_i64()).collect();
    let flags = w.declare_zeroed_local();
    let count = w.declare_zeroed_local();
    let a = w.declare_zeroed_local_i64();
    let b = w.declare_zeroed_local_i64();
    let r = w.declare_zeroed_local_i64();
    let flag = w.declare_zeroed_local();
    let mut e = Emitter {
        w,
        gpr,
        flags,
        count,
        a,
        b,
        r,
        flag,
    };
    e.w.const_i64(guard_token as i64);
    e.w.call_signature(
        "x64_native_guard",
        Signature::new(&[WasmType::I64], &[WasmType::I32]),
    );
    e.w.eqz_i32();
    e.w.if_void();
    e.w.const_i32(0);
    e.w.return_();
    e.w.block_end();
    for i in 0..16 {
        e.w.load_fixed_i32(state::gpr_low_offset(i));
        e.w.extend_unsigned_i32_to_i64();
        e.w.load_fixed_i32(state::gpr_high_offset(i));
        e.w.extend_unsigned_i32_to_i64();
        e.w.const_i64(32);
        e.w.shl_i64();
        e.w.or_i64();
        e.w.set_local_i64(&e.gpr[i]);
    }
    e.w.load_fixed_i32(gp::flags as u32);
    e.w.set_local(&e.flags);
    let exit = e.w.block_void();
    for inst in &plan.instructions {
        e.w.get_local(&e.count);
        let arg = e.w.arg_local_initial_state.unsafe_clone();
        e.w.get_local(&arg);
        e.w.geu_i32();
        e.w.br_if(exit);
        e.fixed(gp::previous_ip as u32, inst.start.0 as u32);
        e.fixed(gp::x64_previous_ip_hi as u32, (inst.start.0 >> 32) as u32);
        match inst.operation {
            Operation::Move { target, source } => {
                e.value(source);
                e.w.set_local_i64(&e.r);
                e.target(target);
            },
            Operation::Alu {
                code,
                target,
                lhs,
                rhs,
                width,
            } => {
                e.value(lhs);
                e.w.set_local_i64(&e.a);
                e.value(rhs);
                e.w.const_i64(mask(width) as i64);
                e.w.and_i64();
                e.w.set_local_i64(&e.b);
                e.arithmetic(code, width);
                if let Some(target) = target {
                    e.target(target);
                }
            },
            Operation::Exchange(first, second) => {
                e.value(Value::Register(first));
                e.w.set_local_i64(&e.a);
                e.value(Value::Register(second));
                e.w.set_local_i64(&e.r);
                e.target(first);
                e.w.get_local_i64(&e.a);
                e.w.set_local_i64(&e.r);
                e.target(second);
            },
            Operation::Shift {
                target,
                code,
                count,
            } => {
                e.value(Value::Register(target));
                e.w.set_local_i64(&e.a);
                e.shift(code, count, target.width);
                e.target(target);
            },
            Operation::ConditionalMove {
                target,
                source,
                condition,
            } => {
                e.condition(condition);
                e.w.if_void();
                e.value(source);
                e.w.set_local_i64(&e.r);
                e.target(target);
                if target.width == 32 {
                    e.w.else_();
                    e.value(Value::Register(target));
                    e.w.set_local_i64(&e.r);
                    e.target(target);
                }
                e.w.block_end();
            },
            Operation::SetCondition { target, condition } => {
                e.condition(condition);
                e.w.extend_unsigned_i32_to_i64();
                e.w.set_local_i64(&e.r);
                e.target(target);
            },
            Operation::Popcount { target, source } => {
                e.value(source);
                e.w.set_local_i64(&e.a);
                e.w.get_local_i64(&e.a);
                e.w.popcnt_i64();
                e.w.set_local_i64(&e.r);
                e.target(target);
                e.w.get_local(&e.flags);
                e.w.const_i32(!0x8D5);
                e.w.and_i32();
                e.w.set_local(&e.flag);
                e.w.get_local_i64(&e.a);
                e.w.const_i64(0);
                e.w.eq_i64();
                e.flag_or(64);
                e.commit_flags();
            },
            Operation::Bit {
                action,
                target,
                index,
            } => {
                e.value(Value::Register(target));
                e.w.set_local_i64(&e.a);
                e.value(index);
                e.w.const_i64((target.width - 1) as i64);
                e.w.and_i64();
                e.w.set_local_i64(&e.b);
                e.w.get_local(&e.flags);
                e.w.const_i32(!1);
                e.w.and_i32();
                e.w.get_local_i64(&e.a);
                e.w.get_local_i64(&e.b);
                e.w.shr_u_i64();
                e.w.const_i64(1);
                e.w.and_i64();
                e.w.wrap_i64_to_i32();
                e.w.or_i32();
                e.w.set_local(&e.flag);
                e.commit_flags();
                if action != 0 {
                    e.w.get_local_i64(&e.a);
                    e.w.const_i64(1);
                    e.w.get_local_i64(&e.b);
                    e.w.shl_i64();
                    match action {
                        1 => e.w.or_i64(),
                        2 => {
                            e.w.const_i64(-1);
                            e.w.xor_i64();
                            e.w.and_i64();
                        },
                        3 => e.w.xor_i64(),
                        _ => unreachable!(),
                    };
                    e.w.set_local_i64(&e.r);
                    e.target(target);
                }
            },
            Operation::Lea { target, address } => {
                e.lea(address, inst.next);
                e.target(target);
            },
            Operation::Nop => {},
            Operation::Jump { .. } => {},
        }
        e.rip(inst.next);
        if let Operation::Jump { condition, target } = inst.operation {
            if let Some(cc) = condition {
                e.condition(cc);
                e.w.if_void();
                e.rip(target);
                e.w.block_end();
            }
            else {
                e.rip(target);
            }
        }
        e.w.get_local(&e.count);
        e.w.const_i32(1);
        e.w.add_i32();
        e.w.set_local(&e.count);
    }
    e.w.block_end();
    e.w.get_local(&e.count);
    let Emitter {
        mut w,
        gpr,
        flags,
        count,
        a,
        b,
        r,
        flag,
    } = e;
    for register in gpr {
        w.free_local_i64(register);
    }
    for register in [flags, count, flag] {
        w.free_local(register);
    }
    for register in [a, b, r] {
        w.free_local_i64(register);
    }
    w.finish();
    Ok(Artifact {
        bytes: w.output().to_vec(),
        native_instructions: plan.instructions.len() as u32,
        locals: w.declared_local_count(),
        plan,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_capture_stops_before_memory_or_unsupported() {
        let p = plan(
            &[
                0x49, 0xB8, 1, 2, 3, 4, 5, 6, 7, 8, 0x4D, 0x01, 0xC8, 0x48, 0x8B, 0,
            ],
            GuestIp(0xFFFF800000001000),
            16,
        )
        .unwrap();
        assert_eq!(p.instructions.len(), 2);
        assert_eq!(p.source_bytes, 13);
        assert_eq!(p.end.0, 0xFFFF80000000100D);
        assert!(plan(&[0x48, 0x8B, 0], GuestIp(0), 16).is_err());
        assert!(plan(&[0x90], GuestIp(0), 0).is_err());
    }
    #[test]
    fn emit_native_fixture() {
        let root = std::path::Path::new("build/x64-native");
        std::fs::create_dir_all(root).unwrap();
        let bytes = [
            0x49, 0xB8, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0x49, 0xB9, 1, 0, 0, 0, 0,
            0, 0, 0, 0x4D, 0x01, 0xC8, 0x4D, 0x31, 0xC9, 0x49, 0x89, 0xC8,
        ];
        let artifact =
            compile(&bytes, GuestIp(0xFFFF800000001000), 0x123456789ABCDEF0, 32).unwrap();
        assert_eq!(artifact.native_instructions, 5);
        std::fs::write(root.join("registers.wasm"), artifact.bytes).unwrap();
        // All legacy byte register aliases and all REX banks are emitted by
        // the same typed register path, independently validated in Node.
        let mut manifest = Vec::new();
        for width in [8, 16, 32, 64] {
            for code in [0u8, 1, 2, 3, 4, 5, 6, 7] {
                let mut bytes = Vec::new();
                if width == 16 {
                    bytes.push(0x66);
                }
                bytes.push(if width == 64 { 0x4D } else { 0x45 });
                bytes.push(code * 8 + if width == 8 { 0 } else { 1 });
                bytes.push(0xC8);
                let a = compile(&bytes, GuestIp(0xFFFF800000001000), 7, 1).unwrap();
                let name = format!("alu-{width}-{code}.wasm");
                std::fs::write(root.join(&name), a.bytes).unwrap();
                manifest.push(format!("[\"{name}\",{width},{code}]"));
            }
        }
        std::fs::write(
            root.join("manifest.json"),
            format!("[{}]", manifest.join(",")),
        )
        .unwrap();
        let mut extra = Vec::new();
        let mut emit = |bytes: Vec<u8>, text: String| {
            let name = format!("extra-{}.wasm", extra.len());
            let artifact = compile(&bytes, GuestIp(0xFFFF800000001000), 7, 1).unwrap();
            std::fs::write(root.join(&name), artifact.bytes).unwrap();
            extra.push(format!("[\"{name}\",\"{text}\"]"));
        };
        for width in [8, 16, 32, 64] {
            let suffix = match width {
                8 => "b",
                16 => "w",
                32 => "d",
                _ => "",
            };
            for (code, name) in ["rol", "ror", "rcl", "rcr", "shl", "shr", "sal", "sar"]
                .into_iter()
                .enumerate()
            {
                if code == 6 {
                    continue;
                }
                for count in [0u8, 1, 2, 7, 8, 15, 16, 31, 32, 63, 64, 255] {
                    let mut bytes = Vec::new();
                    if width == 16 {
                        bytes.push(0x66);
                    }
                    bytes.extend([
                        if width == 64 { 0x49 } else { 0x41 },
                        if width == 8 { 0xC0 } else { 0xC1 },
                        0xC0 | (code as u8) << 3,
                        count,
                    ]);
                    emit(bytes, format!("{name} r8{suffix}, {count}"));
                }
            }
            if width == 8 {
                continue;
            }
            let prefix = if width == 16 { vec![0x66] } else { vec![] };
            let mut bytes = prefix.clone();
            bytes.extend([
                0xF3,
                if width == 64 { 0x4D } else { 0x45 },
                0x0F,
                0xB8,
                0xC1,
            ]);
            emit(bytes, format!("popcnt r8{suffix}, r9{suffix}"));
            for (action, name) in ["bt", "bts", "btr", "btc"].into_iter().enumerate() {
                for index in [0u8, 3, 15, 31, 63] {
                    let mut bytes = prefix.clone();
                    bytes.extend([
                        if width == 64 { 0x49 } else { 0x41 },
                        0x0F,
                        0xBA,
                        0xE0 | (action as u8) << 3,
                        index,
                    ]);
                    emit(bytes, format!("{name} r8{suffix}, {index}"));
                }
            }
            for (cc, name) in [(4, "z"), (5, "nz")] {
                let mut bytes = prefix.clone();
                bytes.extend([if width == 64 { 0x4D } else { 0x45 }, 0x0F, 0x40 | cc, 0xC1]);
                emit(bytes, format!("cmov{name} r8{suffix}, r9{suffix}"));
            }
        }
        for (cc, name) in [
            "o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g",
        ]
        .into_iter()
        .enumerate()
        {
            emit(
                vec![0x4D, 0x0F, 0x40 | cc as u8, 0xC1],
                format!("cmov{name} r8, r9"),
            );
            emit(
                vec![0x41, 0x0F, 0x90 | cc as u8, 0xC0],
                format!("set{name} r8b"),
            );
            let branch = compile(
                &[0x0F, 0x80 | cc as u8, 0, 1, 0, 0],
                GuestIp(0xFFFF8000FFFFFFF0),
                7,
                1,
            )
            .unwrap();
            std::fs::write(root.join(format!("branch-{cc}.wasm")), branch.bytes).unwrap();
        }
        std::fs::write(root.join("extra.json"), format!("[{}]", extra.join(","))).unwrap();
    }
}
