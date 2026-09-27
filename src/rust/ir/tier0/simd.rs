//! Tier-0 templates for MMX, SSE and SSE2: native Wasm SIMD over the CPU's
//! XMM/MMX registers in memory, with the interpreter's semantics.
//!
//! Every form reads its memory operand (with the interpreter's width) before
//! writing any state; operands outside one ordinary RAM page, and results the
//! interpreter might produce differently (NaNs, whose payloads Wasm leaves
//! open), take retry() instead. MMX registers alias the x87 mantissas: a read
//! first syncs that slot from the f64 shadow cache, a write invalidates it and
//! sets the exponent to 0xFFFF, and the form ends with
//! cpu::transition_fpu_to_mmx (all tags valid, TOP 0).
use super::Page;
use crate::cpu::{cpu::CR0_EM, cpu::CR0_TS, cpu::FLAGS_ALL, fpu, global_pointers as gp};
use crate::ir::frontend::decode::DecodedInstruction;
use crate::wasmgen::wasm_builder::{Signature, WasmLocalV128, WasmType};

#[derive(Clone, Copy)]
pub(super) enum Packed {
    Shuffle([u8; 16]),
    Binary(u32),
    AndNot,
    Unpack(u8, bool),
    Pack(u32),
    /// Shift by the source's low quadword: (opcode, lane bits, arithmetic).
    Shift(u32, u32, bool),
    MulHigh(bool),
    MulDwords,
    Sad,
}

#[derive(Clone, Copy)]
pub(super) enum Simd {
    /// MOVUPS/MOVAPS/MOVUPD/MOVAPD/MOVDQA/MOVDQU xmm, xmm/m128.
    Load128 { reg: u8 },
    /// The same, xmm/m128, xmm.
    Store128 { reg: u8 },
    /// MOVSS/MOVSD xmm, xmm/m: registers merge the low lane, memory zero-extends.
    LoadScalar { reg: u8, bytes: u8 },
    /// MOVSS/MOVSD xmm/m, xmm.
    StoreScalar { reg: u8, bytes: u8 },
    /// MOVQ xmm, xmm/m64 (upper quadword cleared).
    LoadQuad { reg: u8 },
    /// MOVQ xmm/m64, xmm (a register destination's upper quadword cleared).
    StoreQuad { reg: u8 },
    /// MOVQ mm, mm/m64.
    MmxLoad { reg: u8 },
    /// MOVQ mm/m64, mm.
    MmxStore { reg: u8 },
    /// MOVD mm/xmm, r/m32.
    MovdIn { reg: u8, mmx: bool },
    /// MOVD r/m32, mm/xmm.
    MovdOut { reg: u8, mmx: bool },
    /// reg = op(reg, source).
    Packed { op: Packed, reg: u8, mmx: bool, source: u8 },
    /// PSRLx/PSRAx/PSLLx/PSRLDQ/PSLLDQ reg, imm8 (`kind` is the ModRM reg).
    ShiftImmediate { reg: u8, mmx: bool, bits: u8, kind: u8, count: u8 },
    /// ADD/SUB/MUL/DIV/MIN/MAX/SQRT/RSQRT/RCP PS/PD/SS/SD.
    Float { opcode: u8, reg: u8, double: bool, scalar: bool },
    /// Float conversions: (Wasm opcode, source bytes, result bytes).
    Convert { opcode: u32, reg: u8, source: u8, result: u8 },
    /// CVT(T)PS2DQ/CVT(T)PD2DQ.
    ConvertInteger { reg: u8, double: bool, truncate: bool },
    /// CVTSI2SS/CVTSI2SD xmm, r/m32.
    ToScalar { reg: u8, double: bool },
    /// CVT(T)SS2SI/CVT(T)SD2SI r32, xmm/m.
    ToInteger { reg: u8, double: bool, truncate: bool },
    /// UCOMISS/COMISS/UCOMISD/COMISD.
    CompareFlags { reg: u8, double: bool },
    Emms,
}

/// Bytes of the r/m operand the interpreter reads (its instr_* source type).
fn source_bytes(op: u32) -> u8 {
    match op {
        0x0F14 | 0x660F14 | 0x0F16 | 0xF20F58 | 0xF20F59 | 0xF20F5C | 0xF20F5E | 0xF20F5D
        | 0xF20F5F | 0xF20F51 | 0xF20F5A | 0x0F5A | 0x660F2E | 0x660F2F | 0xF20F2C | 0xF20F2D
        | 0xF30FE6 => 8,
        0xF30F58 | 0xF30F59 | 0xF30F5C | 0xF30F5E | 0xF30F5D | 0xF30F5F | 0xF30F51 | 0xF30F52
        | 0xF30F53 | 0xF30F5A | 0x0F2E | 0x0F2F | 0xF30F2C | 0xF30F2D | 0x0F60 | 0x0F61
        | 0x0F62 => 4,
        0x0FC6 => 16,
        _ if op >> 16 == 0 && (0x0F60..=0x0FFF).contains(&op) => 8,
        _ => 16,
    }
}

/// Packed integer and logic operations (Wasm SIMD opcodes).
fn packed(code: u8, mmx: bool) -> Option<Packed> {
    Some(match code {
        0xFC => Packed::Binary(0x6E),
        0xFD => Packed::Binary(0x8E),
        0xFE => Packed::Binary(0xAE),
        0xD4 => Packed::Binary(0xCE),
        0xF8 => Packed::Binary(0x71),
        0xF9 => Packed::Binary(0x91),
        0xFA => Packed::Binary(0xB1),
        0xFB => Packed::Binary(0xD1),
        0xEC => Packed::Binary(0x6F),
        0xED => Packed::Binary(0x8F),
        0xDC => Packed::Binary(0x70),
        0xDD => Packed::Binary(0x90),
        0xE8 => Packed::Binary(0x72),
        0xE9 => Packed::Binary(0x92),
        0xD8 => Packed::Binary(0x73),
        0xD9 => Packed::Binary(0x93),
        0x64 => Packed::Binary(0x27),
        0x65 => Packed::Binary(0x31),
        0x66 => Packed::Binary(0x3B),
        0x74 => Packed::Binary(0x23),
        0x75 => Packed::Binary(0x2D),
        0x76 => Packed::Binary(0x37),
        0xDA => Packed::Binary(0x77),
        0xDE => Packed::Binary(0x79),
        0xEA => Packed::Binary(0x96),
        0xEE => Packed::Binary(0x98),
        0xE0 => Packed::Binary(0x7B),
        0xE3 => Packed::Binary(0x9B),
        0xE4 => Packed::MulHigh(false),
        0xE5 => Packed::MulHigh(true),
        0xF4 => Packed::MulDwords,
        0xF6 => Packed::Sad,
        0xD5 => Packed::Binary(0x95),
        0xF5 => Packed::Binary(0xBA),
        0xDB => Packed::Binary(0x4E),
        0xDF => Packed::AndNot,
        0xEB => Packed::Binary(0x50),
        0xEF => Packed::Binary(0x51),
        0x60 => Packed::Unpack(1, false),
        0x61 => Packed::Unpack(2, false),
        0x62 => Packed::Unpack(4, false),
        0x68 => Packed::Unpack(1, true),
        0x69 => Packed::Unpack(2, true),
        0x6A => Packed::Unpack(4, true),
        0x6C if !mmx => Packed::Unpack(8, false),
        0x6D if !mmx => Packed::Unpack(8, true),
        0x63 => Packed::Pack(0x65),
        0x67 => Packed::Pack(0x66),
        0x6B => Packed::Pack(0x85),
        0xD1 => Packed::Shift(0x8D, 16, false),
        0xD2 => Packed::Shift(0xAD, 32, false),
        0xD3 => Packed::Shift(0xCD, 64, false),
        0xE1 => Packed::Shift(0x8C, 16, true),
        0xE2 => Packed::Shift(0xAC, 32, true),
        0xF1 => Packed::Shift(0x8B, 16, false),
        0xF2 => Packed::Shift(0xAB, 32, false),
        0xF3 => Packed::Shift(0xCB, 64, false),
        _ => return None,
    })
}

/// Shuffle lanes of PSHUFW/PSHUFD/PSHUFLW/PSHUFHW/SHUFPS/SHUFPD over
/// (first, source); `two`: the first operand is the destination, else the
/// source itself.
fn shuffle_lanes(op: u32, imm: u32) -> ([u8; 16], bool) {
    let mut lanes = [0; 16];
    for i in 0..16u32 {
        lanes[i as usize] = match op {
            0x0F70 => ((imm >> (2 * (i / 2 % 4)) & 3) * 2 + i % 2) as u8,
            0x660F70 => ((imm >> (2 * (i / 4)) & 3) * 4 + i % 4) as u8,
            0xF20F70 if i < 8 => ((imm >> (2 * (i / 2)) & 3) * 2 + i % 2) as u8,
            0xF30F70 if i >= 8 => (8 + (imm >> (2 * ((i - 8) / 2)) & 3) * 2 + i % 2) as u8,
            0x0FC6 => ((imm >> (2 * (i / 4)) & 3) * 4 + i % 4 + if i >= 8 { 16 } else { 0 }) as u8,
            0x660FC6 => ((imm >> (i / 8) & 1) * 8 + i % 8 + if i >= 8 { 16 } else { 0 }) as u8,
            _ => i as u8,
        };
    }
    (lanes, matches!(op, 0x0FC6 | 0x660FC6))
}

pub(super) fn classify(i: &DecodedInstruction) -> Option<Simd> {
    if !cfg!(target_feature = "simd128") {
        return None;
    }
    let op = i.encoding.opcode;
    if op & 0xFF00 != 0x0F00 || i.prefixes.lock || i.baseline_ud {
        return None;
    }
    let prefix = op >> 16;
    // A REP/REPNE prefix that selected no form is left to the interpreter.
    if prefix == 0 && (i.prefixes.rep || i.prefixes.repne) {
        return None;
    }
    let code = op as u8;
    if op == 0x0F77 {
        return Some(Simd::Emms);
    }
    let modrm = i.modrm?;
    let reg = modrm >> 3 & 7;
    let memory = i.ea.is_some();
    Some(match op {
        0x0F10 | 0x0F28 | 0x660F10 | 0x660F28 | 0x660F6F | 0xF30F6F => Simd::Load128 { reg },
        0x0F11 | 0x0F29 | 0x660F11 | 0x660F29 | 0x660F7F | 0xF30F7F => Simd::Store128 { reg },
        0xF30F10 | 0xF20F10 => Simd::LoadScalar { reg, bytes: if prefix == 0xF3 { 4 } else { 8 } },
        0xF30F11 | 0xF20F11 => Simd::StoreScalar { reg, bytes: if prefix == 0xF3 { 4 } else { 8 } },
        0xF30F7E => Simd::LoadQuad { reg },
        0x660FD6 => Simd::StoreQuad { reg },
        0x0F6F => Simd::MmxLoad { reg },
        0x0F7F => Simd::MmxStore { reg },
        0x0F6E | 0x660F6E => Simd::MovdIn { reg, mmx: prefix == 0 },
        0x0F7E | 0x660F7E => Simd::MovdOut { reg, mmx: prefix == 0 },
        0x0F71 | 0x0F72 | 0x0F73 | 0x660F71 | 0x660F72 | 0x660F73 if !memory => {
            let kind = reg;
            let bytes = matches!(kind, 3 | 7);
            let valid = matches!(kind, 2 | 4 | 6) && !(code == 0x73 && kind == 4)
                || bytes && code == 0x73 && prefix == 0x66;
            if !valid {
                return None;
            }
            Simd::ShiftImmediate {
                reg: modrm & 7,
                mmx: prefix == 0,
                bits: if bytes { 128 } else { 16 << (code - 0x71) },
                kind,
                count: i.immediate? as u8,
            }
        },
        0x0F51 | 0x0F52 | 0x0F53 | 0x0F58 | 0x0F59 | 0x0F5C | 0x0F5D | 0x0F5E | 0x0F5F
        | 0x660F51 | 0x660F58 | 0x660F59 | 0x660F5C | 0x660F5D | 0x660F5E | 0x660F5F
        | 0xF20F51 | 0xF20F58 | 0xF20F59 | 0xF20F5C | 0xF20F5D | 0xF20F5E | 0xF20F5F
        | 0xF30F51 | 0xF30F52 | 0xF30F53 | 0xF30F58 | 0xF30F59 | 0xF30F5C | 0xF30F5D
        | 0xF30F5E | 0xF30F5F => Simd::Float {
            opcode: code,
            reg,
            double: matches!(prefix, 0x66 | 0xF2),
            scalar: matches!(prefix, 0xF2 | 0xF3),
        },
        0x0F5A => Simd::Convert { opcode: 0x5F, reg, source: 8, result: 16 },
        0x660F5A => Simd::Convert { opcode: 0x5E, reg, source: 16, result: 16 },
        0xF20F5A => Simd::Convert { opcode: 0x5E, reg, source: 8, result: 4 },
        0xF30F5A => Simd::Convert { opcode: 0x5F, reg, source: 4, result: 8 },
        0x0F5B => Simd::Convert { opcode: 0xFA, reg, source: 16, result: 16 },
        0xF30FE6 => Simd::Convert { opcode: 0xFE, reg, source: 8, result: 16 },
        0x660F5B | 0xF30F5B | 0x660FE6 | 0xF20FE6 => Simd::ConvertInteger {
            reg,
            double: code == 0xE6,
            truncate: matches!(op, 0xF30F5B | 0x660FE6),
        },
        0xF20F2A | 0xF30F2A => Simd::ToScalar { reg, double: prefix == 0xF2 },
        0xF20F2C | 0xF30F2C | 0xF20F2D | 0xF30F2D => Simd::ToInteger {
            reg,
            double: prefix == 0xF2,
            truncate: code == 0x2C,
        },
        0x0F2E | 0x0F2F | 0x660F2E | 0x660F2F => Simd::CompareFlags { reg, double: prefix == 0x66 },
        0x0F70 | 0x660F70 | 0xF20F70 | 0xF30F70 | 0x0FC6 | 0x660FC6 => {
            // Packed pushes (destination, source): one-operand shuffles
            // select from the source only.
            let (mut lanes, two) = shuffle_lanes(op, i.immediate?);
            if !two {
                for lane in &mut lanes {
                    *lane += 16;
                }
            }
            Simd::Packed {
                op: Packed::Shuffle(lanes),
                reg,
                mmx: op == 0x0F70,
                source: source_bytes(op),
            }
        },
        0x0F14 => Simd::Packed { op: Packed::Unpack(4, false), reg, mmx: false, source: 8 },
        0x0F15 => Simd::Packed { op: Packed::Unpack(4, true), reg, mmx: false, source: 16 },
        0x660F14 => Simd::Packed { op: Packed::Unpack(8, false), reg, mmx: false, source: 8 },
        0x660F15 => Simd::Packed { op: Packed::Unpack(8, true), reg, mmx: false, source: 16 },
        0x0F16 => Simd::Packed {
            op: Packed::Shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]),
            reg,
            mmx: false,
            source: 8,
        },
        0x0F54 | 0x660F54 => Simd::Packed { op: Packed::Binary(0x4E), reg, mmx: false, source: 16 },
        0x0F55 | 0x660F55 => Simd::Packed { op: Packed::AndNot, reg, mmx: false, source: 16 },
        0x0F56 | 0x660F56 => Simd::Packed { op: Packed::Binary(0x50), reg, mmx: false, source: 16 },
        0x0F57 | 0x660F57 => Simd::Packed { op: Packed::Binary(0x51), reg, mmx: false, source: 16 },
        _ if prefix == 0 || prefix == 0x66 => Simd::Packed {
            op: packed(code, prefix == 0)?,
            reg,
            mmx: prefix == 0,
            source: source_bytes(op),
        },
        _ => return None,
    })
}

impl Page {
    /// #UD (CR0.EM) and #NM (CR0.TS) belong to the interpreter.
    fn simd_guard(&mut self) {
        self.w.load_fixed_i32(gp::cr as u32);
        self.w.const_i32(CR0_EM | CR0_TS);
        self.w.and_i32();
        self.retry_if();
    }
    fn load_xmm(&mut self, r: u8) { self.load_xmm_bytes(r, 16) }
    /// The low `bytes` of XMM `r`, zero-extended, from the block's register
    /// cache (see Page::xmm).
    fn load_xmm_bytes(&mut self, r: u8, bytes: u8) {
        self.xmm_cached(r);
        let local = self.xmm[r as usize].as_ref().unwrap().unsafe_clone();
        self.w.get_local_v128(&local);
        if bytes < 16 {
            self.w.simd_zero();
            let mut lanes = [0; 16];
            for (k, lane) in lanes.iter_mut().enumerate() {
                *lane = if k < bytes as usize { k as u8 } else { 16 + k as u8 };
            }
            self.w.simd_shuffle(lanes);
        }
    }
    /// Cache XMM `r` in a local (loaded from the CPU state when first used).
    fn xmm_cached(&mut self, r: u8) {
        if self.xmm[r as usize].is_none() {
            self.w.const_i32(gp::get_reg_xmm_offset(r as u32) as i32);
            self.w.simd_memory(0x00, 0);
            self.xmm[r as usize] = Some(self.w.set_new_local_v128());
        }
    }
    fn store_xmm(&mut self, r: u8, value: &WasmLocalV128) {
        self.w.get_local_v128(value);
        match &self.xmm[r as usize] {
            Some(local) => self.w.set_local_v128(&local.unsafe_clone()),
            None => self.xmm[r as usize] = Some(self.w.set_new_local_v128()),
        }
        self.xmm_dirty |= 1 << r;
    }
    /// Store the low `bytes` of `value` into the low lane of XMM `r`.
    fn store_xmm_low(&mut self, r: u8, value: &WasmLocalV128, bytes: u8) {
        if bytes == 16 {
            self.store_xmm(r, value);
            return;
        }
        self.xmm_cached(r);
        let local = self.xmm[r as usize].as_ref().unwrap().unsafe_clone();
        self.w.get_local_v128(value);
        self.w.get_local_v128(&local);
        let mut lanes = [0; 16];
        for (k, lane) in lanes.iter_mut().enumerate() {
            *lane = if k < bytes as usize { k as u8 } else { 16 + k as u8 };
        }
        self.w.simd_shuffle(lanes);
        self.w.set_local_v128(&local);
        self.xmm_dirty |= 1 << r;
    }
    /// MMX `r` (cpu::read_mmx64s: sync the slot from the f64 cache first).
    fn load_mmx(&mut self, r: u8) {
        let [_, _, dirty] = fpu::x87_cache_addresses();
        self.w.load_fixed_i32(dirty);
        self.w.const_i32(1 << r);
        self.w.and_i32();
        self.w.hint(false);
        self.w.if_void();
        self.w.const_i32(r as i32);
        self.w.call_signature("fpu_sync_slot", Signature::new(&[WasmType::I32], &[]));
        self.w.block_end();
        self.w.const_i32(gp::get_reg_mmx_offset(r as u32) as i32);
        self.w.simd_memory(0x5D, 0);
    }
    /// cpu::write_mmx_reg64 of the low quadword of `value`.
    fn store_mmx(&mut self, r: u8, value: &WasmLocalV128) {
        self.mmx_invalidate(r);
        let address = gp::get_reg_mmx_offset(r as u32);
        self.w.const_i32(address as i32);
        self.w.get_local_v128(value);
        self.w.simd_lane(0x1D, 0);
        self.w.store_unaligned_i64(0);
        self.w.const_i32(address as i32 + 8);
        self.w.const_i32(0xFFFF);
        self.w.store_unaligned_u16(0);
    }
    /// fpu_invalidate_slot(r).
    fn mmx_invalidate(&mut self, r: u8) {
        let [_, valid, dirty] = fpu::x87_cache_addresses();
        for address in [valid, dirty] {
            self.w.const_i32(address as i32);
            self.w.load_fixed_i32(address);
            self.w.const_i32(!(1 << r));
            self.w.and_i32();
            self.w.store_aligned_i32(0);
        }
    }
    /// cpu::transition_fpu_to_mmx: all tags valid, TOP 0.
    fn mmx_transition(&mut self) {
        for address in [gp::fpu_stack_empty as u32, gp::fpu_stack_ptr as u32] {
            self.w.const_i32(address as i32);
            self.w.const_i32(0);
            self.w.store_u8(0);
        }
    }
    /// Push `bytes` (zero-extended) at addr: one ordinary RAM page, else retry.
    fn load_vector(&mut self, bytes: u8) {
        self.tlb_miss(bytes as u32, false);
        self.retry_if();
        self.host_address();
        self.w.simd_memory(
            match bytes {
                16 => 0x00,
                8 => 0x5D,
                _ => 0x5C,
            },
            0,
        );
    }
    /// Store the low `bytes` of `value` at addr (writable RAM without code,
    /// else retry: the interpreter handles MMIO and code writes).
    fn store_vector(&mut self, bytes: u8, value: &WasmLocalV128) {
        self.tlb_miss(bytes as u32, true);
        self.retry_if();
        self.host_address();
        self.w.get_local_v128(value);
        match bytes {
            16 => self.w.simd_memory(0x0B, 0),
            8 => {
                self.w.simd_lane(0x1D, 0);
                self.w.store_unaligned_i64(0);
            },
            _ => {
                self.w.simd_lane(0x1B, 0);
                self.w.store_unaligned_i32(0);
            },
        }
    }
    /// simd_source for forms that use only the low `bytes` lane (registers
    /// are read whole: no zero extension needed).
    fn scalar_source(&mut self, i: &DecodedInstruction, bytes: u8) {
        match &i.ea {
            Some(_) => self.simd_source(i, false, bytes),
            None => self.load_xmm(i.modrm.unwrap() & 7),
        }
    }
    /// Push the r/m operand: an MMX/XMM register or `bytes` of memory.
    fn simd_source(&mut self, i: &DecodedInstruction, mmx: bool, bytes: u8) {
        match &i.ea {
            Some(ea) => {
                self.linear(ea);
                self.load_vector(bytes);
            },
            None if mmx => self.load_mmx(i.modrm.unwrap() & 7),
            None => self.load_xmm_bytes(i.modrm.unwrap() & 7, bytes),
        }
    }
    fn simd_result(&mut self, reg: u8, mmx: bool, value: &WasmLocalV128) {
        if mmx {
            self.store_mmx(reg, value);
            self.mmx_transition();
        }
        else {
            self.store_xmm(reg, value);
        }
    }
    /// retry() if any of the low `bytes` lanes of the float vector is a NaN.
    fn retry_on_nan(&mut self, value: &WasmLocalV128, double: bool, bytes: u8) {
        self.w.get_local_v128(value);
        self.w.get_local_v128(value);
        self.w.simd(if double { 0x48 } else { 0x42 }); // ne
        self.w.simd(if double { 0xC4 } else { 0xA4 }); // bitmask
        if bytes < 16 {
            self.w.const_i32(1);
            self.w.and_i32();
        }
        self.retry_if();
    }

    pub(super) fn simd(&mut self, form: Simd, i: &DecodedInstruction) {
        self.simd_guard();
        let rm = i.modrm.unwrap_or(0) & 7;
        match form {
            Simd::Load128 { reg } => {
                self.simd_source(i, false, 16);
                let v = self.w.set_new_local_v128();
                self.store_xmm(reg, &v);
                self.w.free_local_v128(v);
            },
            Simd::Store128 { reg } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                self.load_xmm(reg);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(16, &v);
                }
                else {
                    self.store_xmm(rm, &v);
                }
                self.w.free_local_v128(v);
            },
            Simd::LoadScalar { reg, bytes } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                    self.load_vector(bytes);
                    let v = self.w.set_new_local_v128();
                    self.store_xmm(reg, &v);
                    self.w.free_local_v128(v);
                }
                else {
                    self.load_xmm_bytes(rm, bytes);
                    let v = self.w.set_new_local_v128();
                    self.store_xmm_low(reg, &v, bytes);
                    self.w.free_local_v128(v);
                }
            },
            Simd::StoreScalar { reg, bytes } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                self.load_xmm_bytes(reg, bytes);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(bytes, &v);
                }
                else {
                    self.store_xmm_low(rm, &v, bytes);
                }
                self.w.free_local_v128(v);
            },
            Simd::LoadQuad { reg } => {
                // Both forms zero-extend the low quadword.
                self.simd_source(i, false, 8);
                let v = self.w.set_new_local_v128();
                self.store_xmm(reg, &v);
                self.w.free_local_v128(v);
            },
            Simd::StoreQuad { reg } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                self.load_xmm_bytes(reg, 8);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(8, &v);
                }
                else {
                    self.store_xmm(rm, &v);
                }
                self.w.free_local_v128(v);
            },
            Simd::MmxLoad { reg } => {
                self.simd_source(i, true, 8);
                let v = self.w.set_new_local_v128();
                self.simd_result(reg, true, &v);
                self.w.free_local_v128(v);
            },
            Simd::MmxStore { reg } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                self.load_mmx(reg);
                let v = self.w.set_new_local_v128();
                if i.ea.is_some() {
                    self.store_vector(8, &v);
                    self.mmx_transition();
                }
                else {
                    self.simd_result(rm, true, &v);
                }
                self.w.free_local_v128(v);
            },
            Simd::MovdIn { reg, mmx } => {
                match &i.ea {
                    Some(ea) => {
                        self.linear(ea);
                        self.read_mem(32, false);
                    },
                    None => self.read_reg(rm, 32),
                }
                let value = self.value.unsafe_clone();
                self.w.set_local(&value);
                self.w.simd_zero();
                self.w.get_local(&value);
                self.w.simd_lane(0x1C, 0); // i32x4.replace_lane
                let v = self.w.set_new_local_v128();
                self.simd_result(reg, mmx, &v);
                self.w.free_local_v128(v);
            },
            Simd::MovdOut { reg, mmx } => {
                if let Some(ea) = &i.ea {
                    self.linear(ea);
                }
                if mmx {
                    self.load_mmx(reg);
                }
                else {
                    self.load_xmm(reg);
                }
                self.w.simd_lane(0x1B, 0);
                let value = self.value.unsafe_clone();
                self.w.set_local(&value);
                match &i.ea {
                    Some(_) => self.write_mem(32, &value),
                    None => {
                        self.w.get_local(&value);
                        self.write_reg(rm, 32);
                    },
                }
                if mmx {
                    self.mmx_transition();
                }
            },
            Simd::Emms => {
                // fpu_set_tag_word(0xFFFF): all registers empty.
                self.w.const_i32(gp::fpu_stack_empty as i32);
                self.w.const_i32(0xFF);
                self.w.store_u8(0);
            },
            Simd::Packed { op, reg, mmx, source } => {
                self.simd_source(i, mmx, source);
                let src = self.w.set_new_local_v128();
                if mmx {
                    self.load_mmx(reg);
                }
                else {
                    self.load_xmm(reg);
                }
                let dst = self.w.set_new_local_v128();
                self.packed(op, &dst, &src, if mmx { 8 } else { 16 });
                let result = self.w.set_new_local_v128();
                self.simd_result(reg, mmx, &result);
                for v in [src, dst, result] {
                    self.w.free_local_v128(v);
                }
            },
            Simd::ShiftImmediate { reg, mmx, bits, kind, count } => {
                if mmx {
                    self.load_mmx(reg);
                }
                else {
                    self.load_xmm(reg);
                }
                let dst = self.w.set_new_local_v128();
                let count = count as u32;
                if bits == 128 {
                    self.w.get_local_v128(&dst);
                    self.w.simd_zero();
                    let mut lanes = [16; 16];
                    for (k, lane) in lanes.iter_mut().enumerate() {
                        let index = if kind == 3 { k as i32 + count as i32 } else { k as i32 - count as i32 };
                        if (0..16).contains(&index) {
                            *lane = index as u8;
                        }
                    }
                    self.w.simd_shuffle(lanes);
                }
                else if count >= bits as u32 && kind != 4 {
                    self.w.simd_zero();
                }
                else {
                    self.w.get_local_v128(&dst);
                    self.w.const_i32(count.min(bits as u32 - 1) as i32);
                    let base = match bits {
                        16 => 0x8B,
                        32 => 0xAB,
                        _ => 0xCB,
                    };
                    self.w.simd(base + match kind {
                        6 => 0,
                        4 => 1,
                        _ => 2,
                    });
                }
                let result = self.w.set_new_local_v128();
                self.simd_result(reg, mmx, &result);
                self.w.free_local_v128(dst);
                self.w.free_local_v128(result);
            },
            Simd::Float { opcode, reg, double, scalar } => {
                let bytes = if !scalar { 16 } else if double { 8 } else { 4 };
                // Scalar forms compute (and NaN-check) only the low lane.
                self.scalar_source(i, bytes);
                let src = self.w.set_new_local_v128();
                self.load_xmm(reg);
                let dst = self.w.set_new_local_v128();
                let base = if double { 0xF0 } else { 0xE4 };
                match opcode {
                    0x51 => {
                        self.w.get_local_v128(&src);
                        self.w.simd(base - 1); // sqrt
                    },
                    0x52 | 0x53 => {
                        // rsqrt/rcp as the interpreter computes them: 1 / sqrt(x), 1 / x.
                        self.w.const_i32(0x3F800000);
                        self.w.simd(0x11); // i32x4.splat of 1.0f
                        self.w.get_local_v128(&src);
                        if opcode == 0x52 {
                            self.w.simd(0xE3);
                        }
                        self.w.simd(0xE7);
                    },
                    0x5D | 0x5F => {
                        // dst where dst < src (> for max), else src (NaNs, zeros).
                        self.w.get_local_v128(&dst);
                        self.w.get_local_v128(&src);
                        self.w.get_local_v128(&dst);
                        self.w.get_local_v128(&src);
                        self.w.simd(if double { 0x49 } else { 0x43 } + (opcode == 0x5F) as u32);
                        self.w.simd(0x52);
                    },
                    _ => {
                        self.w.get_local_v128(&dst);
                        self.w.get_local_v128(&src);
                        self.w.simd(base + match opcode {
                            0x58 => 0,
                            0x5C => 1,
                            0x59 => 2,
                            _ => 3,
                        });
                    },
                }
                let result = self.w.set_new_local_v128();
                self.retry_on_nan(&result, double, bytes);
                self.store_xmm_low(reg, &result, bytes);
                for v in [src, dst, result] {
                    self.w.free_local_v128(v);
                }
            },
            Simd::Convert { opcode, reg, source, result } => {
                self.simd_source(i, false, source);
                self.w.simd(opcode);
                let v = self.w.set_new_local_v128();
                // The result type: promote/convert-to-double yield f64 lanes.
                self.retry_on_nan(&v, matches!(opcode, 0x5F | 0xFE), result);
                self.store_xmm_low(reg, &v, result);
                self.w.free_local_v128(v);
            },
            Simd::ConvertInteger { reg, double, truncate } => {
                self.simd_source(i, false, 16);
                self.convert_integer(double, truncate);
                let v = self.w.set_new_local_v128();
                self.store_xmm(reg, &v);
                self.w.free_local_v128(v);
            },
            Simd::ToScalar { reg, double } => {
                match &i.ea {
                    Some(ea) => {
                        self.linear(ea);
                        self.read_mem(32, false);
                    },
                    None => self.read_reg(rm, 32),
                }
                self.w.simd(0x11); // i32x4.splat
                self.w.simd(if double { 0xFE } else { 0xFA });
                let v = self.w.set_new_local_v128();
                self.store_xmm_low(reg, &v, if double { 8 } else { 4 });
                self.w.free_local_v128(v);
            },
            Simd::ToInteger { reg, double, truncate } => {
                self.scalar_source(i, if double { 8 } else { 4 });
                if double {
                    self.w.simd_lane(0x21, 0); // f64x2.extract_lane
                }
                else {
                    self.w.simd_lane(0x1F, 0); // f32x4.extract_lane
                    self.w.promote_f32_to_f64();
                }
                let x = self.w.set_new_local_f64();
                // sse_convert(_with_truncation)_f64_to_i32: round (MXCSR.RC
                // or toward zero), then 0x80000000 outside the i32 range.
                if truncate {
                    self.w.get_local_f64(&x);
                    self.w.round_f64(3);
                }
                else {
                    self.round_by_mxcsr(&x);
                }
                self.w.set_local_f64(&x);
                self.w.get_local_f64(&x);
                self.w.const_f64(-2147483648.0);
                self.w.ge_f64();
                self.w.get_local_f64(&x);
                self.w.const_f64(2147483648.0);
                self.w.compare_f64(1);
                self.w.and_i32();
                self.w.if_i32();
                self.w.get_local_f64(&x);
                self.w.trunc_f64_to_i32();
                self.w.else_();
                self.w.const_i32(i32::MIN);
                self.w.block_end();
                self.w.free_local_f64(x);
                self.write_reg(reg, 32);
            },
            Simd::CompareFlags { reg, double } => {
                // flags = ZF (equal), CF (less), ZF|PF|CF (unordered); others clear.
                self.scalar_source(i, if double { 8 } else { 4 });
                let src = self.w.set_new_local_v128();
                self.load_xmm(reg);
                let dst = self.w.set_new_local_v128();
                let base = if double { 0x47 } else { 0x41 };
                self.w.const_i32(gp::flags as i32);
                self.w.load_fixed_i32(gp::flags as u32);
                self.w.const_i32(!FLAGS_ALL);
                self.w.and_i32();
                for (compare, flag) in [(0, 0x40), (2, 1)] {
                    self.w.get_local_v128(&dst);
                    self.w.get_local_v128(&src);
                    self.w.simd(base + compare);
                    self.w.simd_lane(0x1B, 0);
                    self.w.const_i32(flag);
                    self.w.and_i32();
                    self.w.or_i32();
                }
                for v in [&dst, &src] {
                    self.w.get_local_v128(v);
                    self.w.get_local_v128(v);
                    self.w.simd(base + 1);
                }
                self.w.simd(0x50);
                self.w.simd_lane(0x1B, 0);
                self.w.const_i32(0x45);
                self.w.and_i32();
                self.w.or_i32();
                self.w.store_aligned_i32(0);
                self.w.const_i32(gp::flags_changed as i32);
                self.w.const_i32(0);
                self.w.store_aligned_i32(0);
                self.known = super::Known::None;
                self.w.free_local_v128(src);
                self.w.free_local_v128(dst);
            },
        }
    }

    /// Push op(dst, src) on `bytes`-wide registers (8: MMX, low quadword).
    fn packed(&mut self, op: Packed, dst: &WasmLocalV128, src: &WasmLocalV128, bytes: u8) {
        let w = &mut self.w;
        match op {
            Packed::MulHigh(signed) => {
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(if signed { 0xBC } else { 0xBE });
                if bytes == 16 {
                    w.get_local_v128(dst);
                    w.get_local_v128(src);
                    w.simd(if signed { 0xBD } else { 0xBF });
                }
                else {
                    w.simd_zero();
                }
                w.simd_shuffle([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]);
            },
            Packed::MulDwords => {
                for v in [dst, src] {
                    w.get_local_v128(v);
                    w.simd_zero();
                    w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
                }
                w.simd(0xDE);
            },
            Packed::Sad => {
                // |dst - src| per byte, summed per quadword.
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(0x79);
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(0x77);
                w.simd(0x71);
                w.simd(0x7D);
                w.simd(0x7F);
                let sums = w.set_new_local_v128();
                w.get_local_v128(&sums);
                w.get_local_v128(&sums);
                w.get_local_v128(&sums);
                w.simd_shuffle([4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11]);
                w.simd(0xAE);
                w.simd_zero();
                w.simd_shuffle([0, 1, 2, 3, 16, 17, 18, 19, 8, 9, 10, 11, 16, 17, 18, 19]);
                w.free_local_v128(sums);
            },
            Packed::Shift(opcode, bits, arithmetic) => {
                w.get_local_v128(src);
                w.simd_lane(0x1D, 0);
                let count = w.set_new_local_i64();
                w.get_local_i64(&count);
                w.const_i64((bits - 1) as i64);
                w.gtu_i64();
                w.if_v128();
                if arithmetic {
                    w.get_local_v128(dst);
                    w.const_i32((bits - 1) as i32);
                    w.simd(opcode);
                }
                else {
                    w.simd_zero();
                }
                w.else_();
                w.get_local_v128(dst);
                w.get_local_i64(&count);
                w.wrap_i64_to_i32();
                w.simd(opcode);
                w.block_end();
                w.free_local_i64(count);
            },
            _ => {
                if let Packed::AndNot = op {
                    w.get_local_v128(src);
                    w.get_local_v128(dst);
                }
                else {
                    w.get_local_v128(dst);
                    w.get_local_v128(src);
                }
                match op {
                    Packed::Shuffle(lanes) => w.simd_shuffle(lanes),
                    Packed::Binary(opcode) => w.simd(opcode),
                    Packed::AndNot => w.simd(0x4F),
                    Packed::Pack(opcode) => {
                        w.simd(opcode);
                        if bytes == 8 {
                            w.simd_zero();
                            w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
                        }
                    },
                    Packed::Unpack(width, high) => {
                        let mut lanes = [0; 16];
                        let half = bytes / 2;
                        for k in 0..bytes {
                            let element = k / (width * 2);
                            let side = k / width % 2;
                            lanes[k as usize] =
                                (if high { half } else { 0 }) + element * width + k % width + side * 16;
                        }
                        w.simd_shuffle(lanes);
                    },
                    _ => unreachable!(),
                }
            },
        }
    }

    /// Replace the f64 in `x` with it rounded by MXCSR.RC (sse_integer_round).
    fn round_by_mxcsr(&mut self, x: &crate::wasmgen::wasm_builder::WasmLocalF64) {
        self.w.load_fixed_i32(gp::mxcsr as u32);
        self.w.const_i32(13);
        self.w.shr_u_i32();
        self.w.const_i32(3);
        self.w.and_i32();
        let mode = self.w.set_new_local();
        self.w.get_local_f64(x);
        self.w.round_f64(0);
        let rounded = self.w.set_new_local_f64();
        for rc in 1..4 {
            self.w.get_local_f64(x);
            self.w.round_f64(rc);
            self.w.get_local_f64(&rounded);
            self.w.get_local(&mode);
            self.w.const_i32(rc as i32);
            self.w.eq_i32();
            self.w.select();
            self.w.set_local_f64(&rounded);
        }
        self.w.get_local_f64(&rounded);
        self.w.free_local_f64(rounded);
        self.w.free_local(mode);
    }

    /// CVT(T)PS2DQ/CVT(T)PD2DQ of the vector on the stack: MXCSR rounding (or
    /// truncation), 0x80000000 for NaNs and out-of-range lanes.
    fn convert_integer(&mut self, double: bool, truncate: bool) {
        let w = &mut self.w;
        let input = w.set_new_local_v128();
        if truncate {
            w.get_local_v128(&input);
            w.simd(if double { 0x7A } else { 0x69 });
        }
        else {
            w.load_fixed_i32(gp::mxcsr as u32);
            w.const_i32(13);
            w.shr_u_i32();
            w.const_i32(3);
            w.and_i32();
            let mode = w.set_new_local();
            for (k, op) in (if double { [0x94, 0x75, 0x74, 0x7A] } else { [0x6A, 0x68, 0x67, 0x69] })
                .iter()
                .enumerate()
            {
                if k < 3 {
                    w.get_local(&mode);
                    w.const_i32(k as i32);
                    w.eq_i32();
                    w.if_v128();
                }
                w.get_local_v128(&input);
                w.simd(*op);
                if k < 3 {
                    w.else_();
                }
            }
            for _ in 0..3 {
                w.block_end();
            }
            w.free_local(mode);
        }
        let rounded = w.set_new_local_v128();
        w.get_local_v128(&rounded);
        if double {
            w.const_i64(0xC1E0000000000000u64 as i64);
            w.simd(0x12);
        }
        else {
            w.const_i32(0xCF000000u32 as i32);
            w.simd(0x11);
        }
        w.simd(if double { 0x4C } else { 0x46 });
        w.get_local_v128(&rounded);
        if double {
            w.const_i64(0x41E0000000000000);
            w.simd(0x12);
        }
        else {
            w.const_i32(0x4F000000);
            w.simd(0x11);
        }
        w.simd(if double { 0x49 } else { 0x43 });
        w.simd(0x4E);
        if double {
            w.simd_zero();
            w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
        }
        let valid = w.set_new_local_v128();
        w.get_local_v128(&rounded);
        w.simd(if double { 0xFC } else { 0xF8 });
        w.const_i32(i32::MIN);
        w.simd(0x11);
        w.get_local_v128(&valid);
        w.simd(0x52);
        if double {
            w.simd_zero();
            w.simd_shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
        }
        w.free_local_v128(input);
        w.free_local_v128(rounded);
        w.free_local_v128(valid);
    }
}
