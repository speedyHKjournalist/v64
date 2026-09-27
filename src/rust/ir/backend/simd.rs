//! Encoding of selected packed kernels.
use crate::ir::mir::vector::PackedPlan;
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocalV128};
pub(super) fn binary(
    w: &mut WasmBuilder,
    plan: &PackedPlan,
    destination: &WasmLocalV128,
    source: &WasmLocalV128,
) {
    match plan {
        PackedPlan::Shuffle(lanes) => {
            w.get_local_v128(destination);
            w.get_local_v128(source);
            w.simd_shuffle(*lanes);
        },
        PackedPlan::Shift {
            maximum,
            opcode,
            sign_fill,
        } => {
            w.get_local_v128(source);
            w.simd_lane(0x1D, 0);
            let count = w.set_new_local_i64();
            w.get_local_i64(&count);
            w.const_i64(*maximum);
            w.gtu_i64();
            w.if_v128();
            if *sign_fill {
                w.get_local_v128(destination);
                w.const_i32(*maximum as i32);
                w.simd(*opcode);
            }
            else {
                w.simd_zero();
            }
            w.else_();
            w.get_local_v128(destination);
            w.get_local_i64(&count);
            w.wrap_i64_to_i32();
            w.simd(*opcode);
            w.block_end();
            w.free_local_i64(count);
        },
        PackedPlan::MultiplyHigh { low, high, lanes } => {
            w.get_local_v128(destination);
            w.get_local_v128(source);
            w.simd(*low);
            w.get_local_v128(destination);
            w.get_local_v128(source);
            w.simd(*high);
            w.simd_shuffle(*lanes);
        },
        PackedPlan::MultiplyEven { lanes, opcode } => {
            for value in [destination, source] {
                w.get_local_v128(value);
                w.simd_zero();
                w.simd_shuffle(*lanes);
            }
            w.simd(*opcode);
        },
        PackedPlan::Sad {
            difference,
            widen,
            swap,
            add,
            pack,
        } => {
            w.get_local_v128(destination);
            w.get_local_v128(source);
            w.simd(difference[0]);
            w.get_local_v128(destination);
            w.get_local_v128(source);
            w.simd(difference[1]);
            w.simd(difference[2]);
            for opcode in widen {
                w.simd(*opcode);
            }
            let sums = w.set_new_local_v128();
            for _ in 0..3 {
                w.get_local_v128(&sums);
            }
            w.simd_shuffle(*swap);
            w.simd(*add);
            w.simd_zero();
            w.simd_shuffle(*pack);
            w.free_local_v128(sums);
        },
        PackedPlan::Binary { opcode, reverse } => {
            let (a, b) = if *reverse { (source, destination) } else { (destination, source) };
            w.get_local_v128(a);
            w.get_local_v128(b);
            w.simd(*opcode);
        },
    }
}
