//! Golden digests of the x86 leaf emitters (docs/jit-unification-plan.md
//! P2.1), so that moving them (P2.2: into x86tpl) and handing them to the page
//! tier (P2.3, P2.4) provably leaves their output alone. Each leaf runs over
//! an exhaustive grid of its parameters: the values the Tier-0 classifiers
//! produce for every encoding (the maps 0F, 0F 38 and 0F 3A with each
//! mandatory prefix, VEX with each map, W, L and pp, register and memory
//! forms, every imm8, every feature present), and the whole domain of the
//! others. An output is the finished module of a fresh builder, keyed by its
//! parameters; a digest is FNV-1a over the keys and outputs in key order, so
//! it does not depend on how the classifiers reach a value. The register
//! facts (xmm_clean) are pure functions, hashed over nested loops of their
//! inputs. A commit that changes a leaf on purpose updates its digest here;
//! `cargo test leaf_digests -- --nocapture` prints them all.
use super::*;
use crate::cpu::features::{ALL, TEST_FEATURES};
use crate::ir::frontend::decode::{decode, GuestEip, LinearAddress};
use crate::ir::native_fp::Lanes;
use crate::x86tpl::mmx;
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
    /// Emit `f` into a fresh builder that has three v128 locals (zeros), and
    /// record the finished module under `key`
    fn emit(&mut self, key: String, f: impl FnOnce(&mut WasmBuilder, [&WasmLocalV128; 3])) {
        let mut w = WasmBuilder::new();
        let locals = [(); 3].map(|_| {
            w.simd_zero();
            w.set_new_local_v128()
        });
        f(&mut w, [&locals[0], &locals[1], &locals[2]]);
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

const BASE: u32 = 0x40_0000;

/// Every encoding the classifiers see (see the module comment): legacy
/// prefixes and maps, then VEX (C4, VEX.vvvv xmm2)
fn corpus() -> Vec<DecodedInstruction> {
    let mut out = Vec::new();
    let mut take = |head: &[u8]| {
        let decode_with = |imm8: u8| {
            let mut bytes = head.to_vec();
            bytes.extend_from_slice(&[imm8, 0x90, 0x90, 0x90, 0x90, 0x90]);
            decode(&bytes, GuestEip(BASE), LinearAddress(BASE), true).ok()
        };
        let Some(first) = decode_with(0)
        else {
            return;
        };
        // (the immediate follows `head`: ModRM forms without displacement)
        if first.immediate.is_some() && first.length as usize == head.len() + 1 {
            out.extend((0..=255).filter_map(decode_with));
        }
        else {
            out.push(first);
        }
    };
    let groups = |map: u8, opcode: u8, vex: bool| match (map, vex) {
        (1, _) => matches!(opcode, 0x71..=0x73 | 0xAE | 0xC7),
        (2, true) => opcode == 0xF3,
        _ => false,
    };
    let escapes: [&[u8]; 3] = [&[0x0F], &[0x0F, 0x38], &[0x0F, 0x3A]];
    for map in 1..=3u8 {
        for prefix in [None, Some(0x66u8), Some(0xF2), Some(0xF3)] {
            for opcode in 0..=255u8 {
                let regs: &[u8] =
                    if groups(map, opcode, false) { &[0, 1, 2, 3, 4, 5, 6, 7] } else { &[0, 2] };
                for &reg in regs {
                    for modrm in [0xC1 | reg << 3, 0x01 | reg << 3] {
                        let mut head: Vec<u8> = prefix.into_iter().collect();
                        head.extend_from_slice(escapes[map as usize - 1]);
                        head.extend_from_slice(&[opcode, modrm]);
                        take(&head);
                    }
                }
            }
        }
    }
    for map in 1..=3u8 {
        for w in 0..2u8 {
            for l in 0..2u8 {
                for pp in 0..4u8 {
                    for opcode in 0..=255u8 {
                        let regs: &[u8] = if groups(map, opcode, true) {
                            &[0, 1, 2, 3, 4, 5, 6, 7]
                        }
                        else {
                            &[0, 2]
                        };
                        for &reg in regs {
                            for modrm in [0xC1 | reg << 3, 0x01 | reg << 3] {
                                let byte2 = w << 7 | (!2u8 & 15) << 3 | l << 2 | pp;
                                take(&[0xC4, 0xE0 | map, byte2, opcode, modrm]);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// The forms of the corpus, by legacy_form and vex_form
fn forms() -> Vec<(DecodedInstruction, Simd)> {
    TEST_FEATURES.with(|f| f.set(ALL));
    let forms = corpus()
        .into_iter()
        .filter_map(|i| {
            let form = match i.vex {
                Some(_) => vex_form(&i).map(|(form, _)| form),
                None => legacy_form(&i),
            };
            form.map(|form| (i, form))
        })
        .collect();
    TEST_FEATURES.with(|f| f.set(0));
    forms
}

/// The catalogue key of exact's call (a VEX form's legacy one)
fn sse_fp_key(i: &DecodedInstruction) -> u32 {
    match i.vex {
        Some(_) => crate::cpu::avx::legacy(i.encoding.opcode),
        None => i.encoding.opcode,
    }
}

fn leaf_grids() -> Vec<(&'static str, Grid)> {
    let forms = forms();
    assert!(forms.len() > 10_000, "{} forms", forms.len());
    let mut mmx = Grid::default();
    for r in 0..8u8 {
        mmx.emit(format!("load {r}"), |w, _| mmx::load(w, r));
        mmx.emit(format!("store {r}"), |w, [a, ..]| mmx::store(w, r, a));
        mmx.emit(format!("invalidate {r}"), |w, _| mmx::invalidate(w, r));
    }
    mmx.emit("transition".into(), |w, _| mmx::transition(w));

    let (mut packed_grid, mut shift, mut float, mut relation, mut flags, mut convert, mut exact): (
        Grid,
        Grid,
        Grid,
        Grid,
        Grid,
        Grid,
        Grid,
    ) = Default::default();
    let mut shuffled = Vec::new();
    for (i, form) in &forms {
        let (op, bytes) = match *form {
            Simd::Packed { op, mmx, .. } => (Some(op), if mmx { 8 } else { 16 }),
            Simd::Packed256 { op, .. } => (Some(op), 16),
            _ => (None, 16),
        };
        if let Some(op) = op {
            Grid::emit(
                &mut packed_grid,
                format!("{op:?} {bytes}"),
                |w, [a, b, _]| packed(w, op, a, b, bytes),
            );
            if let Some(lanes) = op.lanes(bytes) {
                shuffled.push(lanes);
            }
        }
        match *form {
            Simd::ShiftImmediate {
                bits, kind, count, ..
            } => Grid::emit(
                &mut shift,
                format!("{bits} {kind} {count}"),
                |w, [a, ..]| shift_immediate(w, a, bits, kind, count),
            ),
            Simd::Float { opcode, double, .. } => Grid::emit(
                &mut float,
                format!("{opcode:02X} {double}"),
                |w, [a, b, _]| float_arithmetic(w, opcode, double, a, b),
            ),
            Simd::CompareMask {
                double, predicate, ..
            } => Grid::emit(
                &mut relation,
                format!("{double} {predicate}"),
                |w, [a, b, _]| compare_relation(w, double, predicate, a, b),
            ),
            Simd::CompareFlags { double, .. } => {
                Grid::emit(&mut flags, format!("{double}"), |w, [a, b, _]| {
                    compare_flags(w, double, a, b)
                })
            },
            Simd::ConvertInteger {
                double, truncate, ..
            } => Grid::emit(&mut convert, format!("{double} {truncate}"), |w, _| {
                let out_of_range = convert_integer(w, double, truncate);
                w.free_local(out_of_range);
            }),
            _ => {},
        }
        // (exact's call: the forms with an exact path, and imm8 as exact_if
        // and the CompareMask template pass it)
        let imm8 = match *form {
            Simd::CompareMask { predicate, .. } => Some(predicate as u32),
            Simd::Float { .. }
            | Simd::Convert { .. }
            | Simd::ConvertInteger { .. }
            | Simd::ToScalar { .. }
            | Simd::ToInteger { .. }
            | Simd::Round { .. } => Some(i.immediate.unwrap_or(0)),
            _ => None,
        };
        if let Some(imm8) = imm8 {
            let key = sse_fp_key(i);
            Grid::emit(&mut exact, format!("{key:08X} {imm8}"), |w, [a, b, _]| {
                sse_fp_call(w, 0x0E00, key, imm8, a, b)
            });
        }
    }
    Grid::emit(&mut exact, "result".into(), |w, _| sse_fp_result(w, 0x0E00));

    // native_fp, the admission (P2.4 moves it into x86tpl)
    let mut admission = Grid::default();
    admission.emit("mxcsr".into(), |w, _| {
        crate::ir::native_fp::mxcsr_refused(w)
    });
    let known_values = [[false, false], [false, true], [true, false], [true, true]];
    for opcode in [0x51u8, 0x58, 0x59, 0x5C, 0x5D, 0x5E, 0x5F] {
        for double in [false, true] {
            for scalar in [false, true] {
                for known in known_values {
                    let key = format!("{opcode:02X} {double} {scalar} {known:?}");
                    // (and whether it was unsure: an i32 at the end)
                    admission.emit(format!("unsure {key}"), |w, [a, b, r]| {
                        let unsure = crate::ir::native_fp::arithmetic_unsure(
                            w,
                            opcode,
                            double,
                            scalar,
                            [a, b],
                            known,
                            r,
                        );
                        w.const_i32(unsure as i32);
                    });
                    admission.emit(format!("refused {key}"), |w, [a, b, r]| {
                        crate::ir::native_fp::arithmetic_refused(
                            w,
                            opcode,
                            double,
                            scalar,
                            [a, b],
                            known,
                            r,
                        )
                    });
                }
            }
        }
    }
    for opcode in [0x52u8, 0x53] {
        for scalar in [false, true] {
            admission.emit(
                format!("reciprocal {opcode:02X} {scalar}"),
                |w, [x, r, _]| crate::ir::native_fp::reciprocal_refused(w, opcode, scalar, x, r),
            );
        }
    }
    for double in [false, true] {
        for (name, lanes) in [
            ("scalar", Lanes::Scalar),
            ("packed", Lanes::Packed),
            ("low pair", Lanes::LowPair),
        ] {
            for known in known_values {
                admission.emit(
                    format!("operands {double} {name} {known:?}"),
                    |w, [x, y, _]| {
                        crate::ir::native_fp::operands_refused(w, double, lanes, [x, y], known)
                    },
                );
            }
        }
        for scalar in [false, true] {
            admission.emit(
                format!("fused refused {double} {scalar}"),
                |w, [x, y, z]| {
                    w.simd_zero();
                    let r = w.set_new_local_v128();
                    crate::ir::native_fp::fused_refused(w, double, scalar, [x, y, z], &r);
                    w.free_local_v128(r);
                },
            );
            for op in (0x96..=0x9Fu8).chain(0xA6..=0xAF).chain(0xB6..=0xBF) {
                admission.emit(
                    format!("fused {op:02X} {double} {scalar}"),
                    |w, [d, f, t]| {
                        let r = crate::ir::native_fp::fused(w, op, double, scalar, [d, f, t]);
                        w.free_local_v128(r);
                    },
                );
            }
        }
    }
    for scalar in [false, true] {
        admission.emit(format!("narrowing {scalar}"), |w, [x, r, _]| {
            crate::ir::native_fp::narrowing_refused(w, scalar, x, r)
        });
    }

    // the register facts
    let mut facts = Grid::default();
    let mut hash = Fnv::new();
    for double in [false, true] {
        for scalar in [false, true] {
            hash.bytes(&[clean_bits(double, scalar)]);
        }
    }
    let sources = [None, Some(0u8), Some(1), Some(2)];
    for lanes in [CLEAN_SS, CLEAN_PS | CLEAN_SS, CLEAN_SD, CLEAN_PD | CLEAN_SD] {
        for (s0, s1) in (0..16u8).flat_map(|a| (0..16u8).map(move |b| (a, b))) {
            let start = [s0, s1, s0 ^ s1, 0, 0, 0, 0, 0];
            for source in sources {
                let known = known_clean(&start, lanes, 0, source);
                hash.bytes(&[known[0] as u8, known[1] as u8]);
                for first in 0..2u8 {
                    let mut clean = start;
                    operand_facts(&mut clean, lanes, first, source);
                    hash.bytes(&clean);
                }
            }
        }
    }
    for opcode in [0x51u8, 0x52, 0x53, 0x58, 0x59, 0x5C, 0x5D, 0x5E, 0x5F] {
        for source in sources {
            for known in known_values {
                hash.bytes(&[float_claims(opcode, source, known) as u8]);
            }
        }
        for double in [false, true] {
            for scalar in [false, true] {
                for reg in 0..2u8 {
                    for source in sources {
                        for before in 0..16u8 {
                            for (s0, s1) in (0..16u8).flat_map(|a| (0..16u8).map(move |b| (a, b))) {
                                let mut clean = [s0, s1, s0 ^ s1, 0, 0, 0, 0, 0];
                                float_facts(
                                    &mut clean, opcode, double, scalar, reg, source, before,
                                );
                                hash.bytes(&clean);
                            }
                        }
                    }
                }
            }
        }
    }
    shuffled.sort();
    shuffled.dedup();
    for lanes in &shuffled {
        hash.bytes(lanes);
        for destination in 0..16u8 {
            for source in std::iter::once(None).chain((0..16u8).map(Some)) {
                hash.bytes(&[shuffled_clean(lanes, destination, source)]);
            }
        }
    }
    facts
        .0
        .insert("facts".into(), hash.0.to_le_bytes().to_vec());
    facts.0.insert(
        "shuffles".into(),
        (shuffled.len() as u32).to_le_bytes().to_vec(),
    );

    vec![
        ("mmx", mmx),
        ("packed", packed_grid),
        ("shift_immediate", shift),
        ("float_arithmetic", float),
        ("compare_relation", relation),
        ("compare_flags", flags),
        ("convert_integer", convert),
        ("sse_fp_call", exact),
        ("native_fp", admission),
        ("facts", facts),
    ]
}

/// (name, grid points, digest)
const GOLDEN: [(&str, usize, u64); 10] = [
    ("mmx", 25, 0x9F55885E0F2B44C9),
    ("packed", 1703, 0x8DCC7F8E8A23DCB1),
    ("shift_immediate", 2560, 0x7F89662ACDFABC17),
    ("float_arithmetic", 16, 0x5DCF3929619B74CB),
    ("compare_relation", 64, 0xD2328CA5EBB08FA5),
    ("compare_flags", 2, 0xD6D808EC1276BCB6),
    ("convert_integer", 4, 0xE883AC06CA964907),
    ("sse_fp_call", 1201, 0x37F5908AFB347F22),
    ("native_fp", 379, 0xF5F21E48CC3FB9C2),
    ("facts", 2, 0xF3373D413E50BAA7),
];

#[test]
fn leaf_digests() {
    let actual: Vec<(&str, usize, u64)> = leaf_grids()
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
        "leaf digests changed (expected: GOLDEN; printed above)"
    );
}
