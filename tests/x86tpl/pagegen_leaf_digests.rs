//! Golden digests of the page tier's own leaf emitters (x64/pagegen.rs; see
//! tests/x86tpl/leaf_digests.rs for Tier-0's and the method). P2.3 replaces
//! them with x86tpl's, of the same output, and this test goes with them. The
//! grid of `packed` is every value pagegen's classifiers produce: packed_op
//! of every code, the shuffles of every imm8, PALIGNR's and the SSE4 forms'
//! of every imm8, and the operations sse() and vex() name directly.
use super::*;
use std::collections::BTreeMap;

/// FNV-1a, 64-bit
struct Fnv(u64);
impl Fnv {
    fn new() -> Self { Fnv(0xCBF2_9CE4_8422_2325) }
    fn bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 ^= byte as u64;
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01B3);
        }
    }
}

/// A leaf's outputs by their parameters
#[derive(Default)]
struct Grid(BTreeMap<String, Vec<u8>>);
impl Grid {
    /// Emit `f` into a fresh builder that has two v128 locals (zeros), and
    /// record the finished module under `key`
    fn emit(&mut self, key: String, f: impl FnOnce(&mut WasmBuilder, [&WasmLocalV128; 2])) {
        let mut w = WasmBuilder::new();
        let locals = [(); 2].map(|_| {
            w.simd_zero();
            w.set_new_local_v128()
        });
        f(&mut w, [&locals[0], &locals[1]]);
        for local in locals {
            w.free_local_v128(local);
        }
        w.finish();
        let output = w.output().to_vec();
        if let Some(previous) = self.0.insert(key.clone(), output.clone()) {
            assert!(previous == output, "{key}: two outputs");
        }
    }
    fn digest(&self) -> (usize, u64) {
        let mut hash = Fnv::new();
        for (key, output) in &self.0 {
            hash.bytes(key.as_bytes());
            hash.bytes(&(output.len() as u32).to_le_bytes());
            hash.bytes(output);
        }
        (self.0.len(), hash.0)
    }
}

/// Every Packed value the classifiers produce
fn packed_values() -> Vec<Packed> {
    let mut values: Vec<Packed> = (0..=255u8).filter_map(packed_op).collect();
    for op in [0x660F70, 0xF20F70, 0xF30F70, 0x0FC6, 0x660FC6] {
        values.extend((0..256).map(|imm| Packed::Shuffle(shuffle_lanes(op, imm))));
    }
    values.extend((0..256).map(palignr));
    values.extend((0x660F3800..=0x660F38FF).filter_map(|op| sse4_packed(op, None)));
    for op in 0x660F3A00..=0x660F3AFF {
        values.extend((0..256).filter_map(|imm| sse4_packed(op, Some(imm))));
    }
    values.extend([
        Packed::Swizzle,
        Packed::AndNot,
        Packed::Binary(0x4E),
        Packed::Binary(0x50),
        Packed::Binary(0x51),
        Packed::Unpack(4, false),
        Packed::Unpack(4, true),
        Packed::Unpack(8, false),
        Packed::Unpack(8, true),
    ]);
    values
}

/// (name, grid points, digest)
const GOLDEN: [(&str, usize, u64); 2] = [
    ("packed", 1372, 0xC7A7364F0E382A18),
    ("shift_immediate", 8192, 0x43F6712CA35E8767),
];

#[test]
fn pagegen_leaf_digests() {
    let mut packed_grid = Grid::default();
    for op in packed_values() {
        packed_grid.emit(format!("{op:?}"), |w, [a, b]| packed(w, op, a, b));
    }
    let mut shift = Grid::default();
    for bits in [16u8, 32, 64, 128] {
        for kind in 0..8u8 {
            for count in 0..=255u8 {
                shift.emit(format!("{bits} {kind} {count}"), |w, [a, _]| {
                    w.get_local_v128(a);
                    shift_immediate(w, bits, kind, count)
                });
            }
        }
    }
    let actual: Vec<(&str, usize, u64)> = [("packed", packed_grid), ("shift_immediate", shift)]
        .iter()
        .map(|(name, grid)| {
            let (points, digest) = grid.digest();
            (*name, points, digest)
        })
        .collect();
    for (name, points, digest) in &actual {
        println!("    (\"{name}\", {points}, 0x{digest:016X}),");
    }
    assert_eq!(
        actual, GOLDEN,
        "pagegen leaf digests changed (expected: GOLDEN; printed above)"
    );
}
