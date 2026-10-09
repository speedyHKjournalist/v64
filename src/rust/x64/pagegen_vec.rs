//! The page tier's operands for the x86tpl::ops templates
//! (docs/jit-unification-plan.md P2.4, P2.5): the XMM registers in the CPU
//! state, memory operands through the access cache (vector_address, which
//! retries an aligned form's misaligned address), and no exact path: a
//! refused instruction retries in the interpreter, which leaves the CPU as
//! the templates found it (they write after their last retry point). MXCSR.PE
//! may be clear: the templates set it for an inexact result. The page tier
//! keeps no register facts. Integer results are i64 here: store_int
//! extends a template's i32 explicitly.
use super::{Emitter, Inst, Reg, Xmm, HOST};
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocalV128};
use crate::x86tpl::native_fp;
use crate::x86tpl::ops::VecOperands;

/// One instruction's operands: destination `dst`, first source `first` (the
/// destination, or VEX.vvvv), r/m operand `src`
pub(super) struct Operands<'e> {
    pub e: &'e mut Emitter,
    pub inst: &'e Inst,
    /// the instruction's offset, where a retry resumes
    pub start: u64,
    pub dst: u8,
    pub first: u8,
    pub src: Xmm,
}

impl VecOperands for Operands<'_> {
    fn w(&mut self) -> &mut WasmBuilder { &mut self.e.b }
    fn first(&mut self) {
        self.e.c32(Emitter::xmm(self.first) as i32);
        self.e.b.simd_memory(0x00, 0); // v128.load
    }
    fn source(&mut self, bytes: u8, whole: bool) {
        match self.src {
            Xmm::Reg(s) => {
                self.e.c32(Emitter::xmm(s) as i32);
                self.e.b.simd_memory(0x00, 0); // v128.load
                if bytes < 16 && !whole {
                    // the low `bytes`, zero-extended
                    self.e.b.simd_zero();
                    let mut lanes = [0; 16];
                    for (k, lane) in lanes.iter_mut().enumerate() {
                        *lane = if k < bytes as usize { k as u8 } else { 16 + k as u8 };
                    }
                    self.e.b.simd_shuffle(lanes);
                }
            },
            Xmm::Mem(a) => {
                // (legacy SSE's m128 operands are aligned)
                let aligned = bytes == 16 && self.inst.d.vex.is_none();
                self.e
                    .vector_address(&a, bytes * 8, aligned, false, self.inst);
                if bytes == 16 {
                    self.e.gi(HOST);
                    let scratch = self.e.b.set_new_local();
                    self.e.b.get_local(&scratch);
                    self.e.b.guest_load_v128(&scratch);
                    self.e.b.free_local(scratch);
                    return;
                }
                // (exactly the operand's bytes: a broadcast's may be 1 or 2)
                self.e.b.simd_zero();
                self.e.gi(HOST);
                self.e.b.guest_load_i64_bits(bytes as u32 * 8, 0);
                if bytes == 8 {
                    self.e.b.simd_lane(0x1E, 0); // i64x2.replace_lane
                }
                else {
                    self.e.b.wrap_i64_to_i32();
                    self.e.b.simd_lane(0x1C, 0); // i32x4.replace_lane
                }
            },
        }
    }
    fn register(&mut self, r: u8) {
        self.e.c32(Emitter::xmm(r) as i32);
        self.e.b.simd_memory(0x00, 0); // v128.load
    }
    fn registers(&self) -> u8 { 16 }
    fn memory(&self) -> bool { matches!(self.src, Xmm::Mem(_)) }
    fn first_high(&mut self) {
        self.e.c32(Emitter::ymm(self.first, 16) as i32);
        self.e.b.simd_memory(0x00, 0); // v128.load
    }
    fn source_high(&mut self) {
        let Xmm::Reg(s) = self.src
        else {
            unreachable!("a register form's");
        };
        self.e.c32(Emitter::ymm(s, 16) as i32);
        self.e.b.simd_memory(0x00, 0); // v128.load
    }
    fn source256(&mut self, aligned: bool) -> [WasmLocalV128; 2] {
        let Xmm::Mem(a) = self.src
        else {
            unreachable!("a memory form's");
        };
        self.e
            .vector_address_bytes(&a, 32, aligned, false, self.inst);
        [0, 16].map(|offset| {
            self.e.gi(HOST);
            self.e.c32(offset);
            self.e.b.add_i32();
            let scratch = self.e.b.set_new_local();
            self.e.b.get_local(&scratch);
            self.e.b.guest_load_v128(&scratch);
            self.e.b.free_local(scratch);
            self.e.b.set_new_local_v128()
        })
    }
    fn store256(&mut self, low: &WasmLocalV128, high: &WasmLocalV128) {
        for (half, offset) in [(low, 0), (high, 16)] {
            self.e.c32(Emitter::ymm(self.dst, offset) as i32);
            self.e.b.get_local_v128(half);
            self.e.b.simd_memory(0x0B, 0); // v128.store
        }
    }
    fn store256_rm(&mut self, halves: &[WasmLocalV128; 2], aligned: bool) {
        match self.src {
            Xmm::Reg(s) => {
                for (half, offset) in [(&halves[0], 0), (&halves[1], 16)] {
                    self.e.c32(Emitter::ymm(s, offset) as i32);
                    self.e.b.get_local_v128(half);
                    self.e.b.simd_memory(0x0B, 0); // v128.store
                }
            },
            Xmm::Mem(a) => {
                self.e
                    .vector_address_bytes(&a, 32, aligned, true, self.inst);
                for (half, offset) in [(&halves[0], 0), (&halves[1], 16)] {
                    self.e.gi(HOST);
                    self.e.c32(offset);
                    self.e.b.add_i32();
                    let address = self.e.b.set_new_local();
                    self.e.b.guest_store_v128(&address, half);
                    self.e.b.free_local(address);
                }
            },
        }
    }
    fn zero_upper(&mut self, r: u8) { self.e.ymm_zero(r) }
    fn store_register(&mut self, r: u8, value: &WasmLocalV128) {
        self.e.c32(Emitter::xmm(r) as i32);
        self.e.b.get_local_v128(value);
        self.e.b.simd_memory(0x0B, 0); // v128.store
        self.e.ymm_zero(r);
    }
    fn source_int(&mut self, _wide: bool) {
        unreachable!("the page tier converts integers in Op::Vconvert")
    }
    fn store_vec(&mut self, value: &WasmLocalV128, bytes: u8) {
        if bytes < 16 && self.first != self.dst {
            // (a scalar form's other lanes from VEX.vvvv)
            self.e.xmm_copy(self.first, self.dst);
        }
        self.e.c32(Emitter::xmm(self.dst) as i32);
        self.e.b.get_local_v128(value);
        match bytes {
            16 => self.e.b.simd_memory(0x0B, 0), // v128.store
            8 => {
                self.e.b.simd_lane(0x1D, 0); // i64x2.extract_lane
                self.e.b.store_aligned_i64(0);
            },
            _ => {
                self.e.b.simd_lane(0x1B, 0); // i32x4.extract_lane
                self.e.b.store_aligned_i32(0);
            },
        }
    }
    fn store_int(&mut self, wide: bool) {
        if !wide {
            self.e.b.extend_unsigned_i32_to_i64();
        }
        let r = Reg {
            index: self.dst,
            high: false,
        };
        self.e.set_reg(r, if wide { 64 } else { 32 });
    }
    fn retry_if(&mut self) { self.e.retry_if(self.start) }
    fn mxcsr_refused(&mut self) { native_fp::mxcsr_refused_any_pe(&mut self.e.b) }
    fn in_place(&self) -> bool { false }
    fn detects_inexact(&self) -> bool { true }
    fn exact_open(&mut self, _: &WasmLocalV128, _: &WasmLocalV128, _: Option<u32>) {
        unreachable!("the page tier retries refused instructions")
    }
    fn exact_result(&mut self) { unreachable!("the page tier retries refused instructions") }
}
