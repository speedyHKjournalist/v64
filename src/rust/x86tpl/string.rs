//! Leaves of the REP string templates (docs/jit-unification-plan.md P3.1b):
//! the bulk operations a REP MOVS or STOS becomes when it is done at once,
//! for every x86 engine (Tier-0's template, the page tier's Op::Movs and
//! Op::Stos)
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocal};

/// memory.copy over the guest memory: (destination, source, length) on
/// the stack, host addresses
pub fn memory_copy(w: &mut WasmBuilder) {
    w.op(0xFC);
    w.op(10);
    w.op(0);
    w.op(0);
}
/// memory.fill over the guest memory: (destination, byte, length) on the
/// stack
pub fn memory_fill(w: &mut WasmBuilder) {
    w.op(0xFC);
    w.op(11);
    w.op(0);
}
/// Push nonzero if a forward REP MOVS of `length` bytes from `source` to
/// `destination` would read bytes it has already written (the destination
/// starts inside the source): its elements then repeat the source's start,
/// which memory.copy does not
pub fn overlaps_forward(
    w: &mut WasmBuilder,
    destination: &WasmLocal,
    source: &WasmLocal,
    length: &WasmLocal,
) {
    w.get_local(destination);
    w.get_local(source);
    w.gtu_i32();
    w.get_local(destination);
    w.get_local(source);
    w.get_local(length);
    w.add_i32();
    w.ltu_i32();
    w.and_i32();
}
/// A STOS element of `size` bytes in `value`: push its low byte and above
/// it nonzero unless the value is that byte repeated (what memory.fill can
/// store)
pub fn fill_byte(w: &mut WasmBuilder, size: u8, value: &WasmLocal) {
    w.get_local(value);
    w.const_i32(0xFF);
    w.and_i32();
    if size > 1 {
        w.get_local(value);
        w.get_local(value);
        w.const_i32(0xFF);
        w.and_i32();
        w.const_i32(if size == 2 { 0x0101 } else { 0x0101_0101 });
        w.mul_i32();
        w.ne_i32();
    }
    else {
        w.const_i32(0);
    }
}
