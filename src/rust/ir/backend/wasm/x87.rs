//! The region backend's x87 forms: the inlined fast-math path of
//! x86tpl::x87 (docs/jit-unification-plan.md P2.2) on the region's values,
//! else the canonical `ir_x87_op`.
use super::Emitter;
use crate::cpu::global_pointers as gp;
use crate::ir::ids::ValueId;
use crate::ir::mir::memory::RuntimeCall;
use crate::ir::x87;
use crate::wasmgen::wasm_builder::WasmBuilder;
use crate::x86tpl::x87::{x87_native, X87Words};

impl Emitter<'_> {
    pub(super) fn x87(
        &mut self,
        opcode: u8,
        modrm: u8,
        inputs: &[ValueId],
        outputs: &[ValueId],
        call: &RuntimeCall,
    ) {
        let Some(native) = x87::native(opcode, modrm).filter(|_| self.cpu)
        else {
            self.x87_fallback(outputs, call);
            return;
        };
        let done = self.w.block_void();
        let slow = self.w.block_void();
        self.w.load_fixed_u8(gp::x87_native_policy as u32);
        self.w.eqz_i32();
        self.w.hint(false);
        self.w.br_if(slow);
        let mut words = EmitterWords {
            e: self,
            inputs,
            outputs,
        };
        x87_native(&mut words, native, slow);
        self.w.br(done);
        self.w.block_end();
        self.x87_fallback(outputs, call);
        self.w.block_end();
    }

    fn x87_fallback(&mut self, outputs: &[ValueId], call: &RuntimeCall) {
        self.runtime_call(call);
        if outputs.is_empty() {
            self.w.drop_();
            return;
        }
        let packed = self.w.set_new_local_i64();
        self.w.get_local_i64(&packed);
        self.w.wrap_i64_to_i32();
        self.set(outputs[0]);
        self.w.get_local_i64(&packed);
        self.w.const_i64(32);
        self.w.shr_u_i64();
        self.w.wrap_i64_to_i32();
        self.set(outputs[1]);
        self.w.free_local_i64(packed);
    }
}

struct EmitterWords<'e, 'a> {
    e: &'e mut Emitter<'a>,
    inputs: &'e [ValueId],
    outputs: &'e [ValueId],
}
impl X87Words for EmitterWords<'_, '_> {
    fn w(&mut self) -> &mut WasmBuilder { &mut self.e.w }
    fn input(&mut self, k: usize) { self.e.get(self.inputs[k]) }
    fn output(&mut self, k: usize) { self.e.set(self.outputs[k]) }
}
