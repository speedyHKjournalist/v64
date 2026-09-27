pub mod locals;
pub mod structure;
pub mod wasm;

mod simd;

mod scalar;

#[cfg(test)]
pub(crate) fn literal_fixture(programs: &[(Vec<crate::ir::mir::value::Step>, bool)]) -> Vec<u8> {
    use crate::{ir::mir::value::Step, wasmgen::wasm_builder::WasmBuilder};
    let mut w = WasmBuilder::new();
    for (index, (steps, wide)) in programs.iter().enumerate() {
        w.const_i32((index * 8) as i32);
        for step in steps {
            match step {
                Step::I32(value) => w.const_i32(*value),
                Step::I64(value) => w.const_i64(*value),
                Step::Scalar(op) => scalar::emit(&mut w, *op),
                _ => panic!("literal fixture contains an observation"),
            }
        }
        if *wide {
            w.store_aligned_i64(0);
        }
        else {
            w.store_aligned_i32(0);
        }
    }
    w.finish();
    w.output().to_vec()
}
