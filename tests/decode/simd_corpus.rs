//! The SIMD decode corpus (docs/simd-xsave-plan.md P1d): VEX and the legacy
//! SIMD encodings in 16-, 32- and 64-bit mode. The x64 decoder and, outside
//! 64-bit mode, the IR decoder decode each with every feature and as if every
//! row had its semantics (TEST_FEATURES, TEST_DECODE_UNIMPLEMENTED). This test
//! checks that the two agree, and that without the features each encoding is
//! #UD (TZCNT and LZCNT: BSF and BSR); tests/x64/oracle compares the x64
//! decoder's results (build/x64-decode/simd.bin) with iced-x86.
use crate::cpu::features::{ALL, TEST_FEATURES};
use crate::decode::{self, form, DecodeStop, GuestEip, LinearAddress, TEST_DECODE_UNIMPLEMENTED};
use crate::x64::decode::{decode_with, DecodeError};
use crate::x64::state::{ExecutionMode, GuestIp};

/// The bytes after each corpus entry, also for tests/x64/oracle: SIB,
/// displacement and immediate bytes come from here
pub const FILLER: [u8; 8] = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x08];

/// A register and a memory ModRM byte for each ModRM.reg: [rcx], and
/// [rax+rcx*4] (VSIB index 1) or [si] in 16-bit addressing
fn modrms() -> Vec<Vec<u8>> {
    (0..8u8)
        .flat_map(|g| [vec![0xC1 | g << 3], vec![0x04 | g << 3, 0x88]])
        .collect()
}

/// (bits, bytes) of every corpus entry, without FILLER
pub fn corpus() -> Vec<(u8, Vec<u8>)> {
    let mut rows = Vec::new();
    for bits in [16u8, 32, 64] {
        let long = bits == 64;
        let mut push = |prefix: &[u8], body: &[u8], modrm: &[u8]| {
            let mut bytes = prefix.to_vec();
            bytes.extend(body);
            bytes.extend(modrm);
            rows.push((bits, bytes));
        };
        // C4: every opcode of maps 1-3 with each pp; VEX.L, W, vvvv (its low
        // and top bits) and R/X/B (B alone outside 64-bit mode) varied
        for map in 1..=3u8 {
            for pp in 0..4u8 {
                for opcode in 0..=255u8 {
                    for (l, w, vvvv, rxb) in [
                        (0, 0, 0, 7),
                        (1, 0, 0, 7),
                        (0, 1, 0, 7),
                        (1, 1, 0, 7),
                        (0, 0, 1, 7),
                        (1, 1, 1, 7),
                        (0, 0, 8, 7),
                        (0, 0, 0, if long { 0 } else { 6 }),
                    ] {
                        let byte2 = w << 7 | (!vvvv & 15) << 3 | l << 2 | pp;
                        for modrm in modrms() {
                            push(&[], &[0xC4, rxb << 5 | map, byte2, opcode], &modrm);
                        }
                    }
                }
            }
        }
        // C5
        for pp in 0..4u8 {
            for opcode in 0..=255u8 {
                for (l, vvvv) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    for modrm in modrms() {
                        push(
                            &[],
                            &[0xC5, 0x80 | (!vvvv & 15) << 3 | l << 2 | pp, opcode],
                            &modrm,
                        );
                    }
                }
            }
        }
        // reserved maps
        for map in [0u8, 4, 5, 31] {
            for opcode in [0x00, 0x10, 0x77, 0xF2, 0xF7] {
                push(&[], &[0xC4, 0xE0 | map, 0x78, opcode], &[0xC1]);
            }
        }
        // prefixes before VEX: vzeroupper, vpaddd ymm, andn, vpgatherdd
        let rex: &[u8] = if long { &[0x40, 0x48, 0x41] } else { &[] };
        for &prefix in [0x66, 0xF2, 0xF3, 0xF0, 0x2E, 0x67].iter().chain(rex) {
            for body in [
                &[0xC5, 0xF8, 0x77][..],
                &[0xC4, 0xE1, 0x7D, 0xFE, 0xC1],
                &[0xC4, 0xE2, 0x78, 0xF2, 0xC1],
                &[0xC4, 0xE2, 0x61, 0x90, 0x14, 0x88],
            ] {
                push(&[prefix], body, &[]);
                push(&[prefix, 0x2E], body, &[]);
            }
        }
        // the legacy maps 0F 38 and 0F 3A, and 0F BC, BD (TZCNT, LZCNT), with
        // mandatory-prefix orders, REX.W in 64-bit mode
        let mut prefix_sets: Vec<Vec<u8>> = [
            &[][..],
            &[0x66],
            &[0xF2],
            &[0xF3],
            &[0x66, 0xF2],
            &[0xF2, 0x66],
            &[0x66, 0xF3],
            &[0xF3, 0x66],
            &[0xF2, 0xF3],
            &[0xF3, 0xF2],
        ]
        .iter()
        .map(|p| p.to_vec())
        .collect();
        if long {
            for i in 0..prefix_sets.len() {
                let mut w = prefix_sets[i].clone();
                w.push(0x48);
                prefix_sets.push(w);
            }
        }
        for prefixes in &prefix_sets {
            for escape in [0x38u8, 0x3A] {
                for opcode in 0..=255u8 {
                    for modrm in modrms() {
                        push(prefixes, &[0x0F, escape, opcode], &modrm);
                    }
                }
            }
            for opcode in [0xBCu8, 0xBD] {
                for modrm in modrms() {
                    push(prefixes, &[0x0F, opcode], &modrm);
                }
            }
        }
    }
    rows
}

fn mode(bits: u8) -> ExecutionMode {
    match bits {
        16 => ExecutionMode::Protected16,
        32 => ExecutionMode::Compatibility32,
        _ => ExecutionMode::Long64,
    }
}

/// The x64 decoder's result and the bytes it fetched
fn x64(bits: u8, bytes: &[u8]) -> (Result<crate::x64::decode::Decoded, DecodeError>, usize) {
    let mut fetched = 0;
    let result = decode_with(GuestIp(0x1000), mode(bits), |offset| {
        fetched = fetched.max(offset as usize + 1);
        bytes.get(offset as usize).copied().ok_or(())
    });
    (result, fetched)
}

#[test]
fn simd_decode_corpus() {
    let rows = corpus();
    let mut out = Vec::new();
    let mut names: Vec<&str> = Vec::new();
    let (mut valid, mut compared) = (0, 0);
    TEST_FEATURES.with(|f| f.set(ALL));
    TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(true));
    for (bits, bytes) in &rows {
        let mut full = bytes.clone();
        full.extend(FILLER);
        let (x, fetched) = x64(*bits, &full);
        // the IR decoder agrees outside 64-bit mode: the same row and length,
        // and #UD where the x64 decoder refuses, after the bytes it fetched
        if *bits != 64 {
            let i = decode::decode(&full, GuestEip(0x1000), LinearAddress(0x1000), *bits == 32);
            match (&x, &i) {
                (Ok(x), Ok(i)) => assert!(
                    !i.baseline_ud && i.length == x.length && i.encoding.id == x.encoding.id,
                    "{bits} {bytes:02X?}"
                ),
                (Err(DecodeError::InvalidOpcode), Ok(i)) => {
                    assert!(i.baseline_ud, "{bits} {bytes:02X?}");
                    assert!(
                        !i.early_ud || i.length as usize == fetched,
                        "{bits} {bytes:02X?}"
                    );
                },
                (
                    Err(DecodeError::UnknownOpcode(key)),
                    Err(DecodeStop::UnknownEncoding { opcode }),
                ) => {
                    assert_eq!(key, opcode, "{bits} {bytes:02X?}")
                },
                _ => panic!("{bits} {bytes:02X?}: x64 {x:?}, IR {i:?}"),
            }
            compared += 1;
        }
        // build/x64-decode/simd.bin: bits, length and bytes; valid, the
        // decoded length and the form (an index into simd-forms.json, or
        // 0xFFFF for legacy rows)
        out.extend([*bits, bytes.len() as u8]);
        out.extend(bytes);
        let form_index = match &x {
            Ok(d) if d.vex.is_some() => {
                let name = form(d.encoding);
                names.iter().position(|n| *n == name).unwrap_or_else(|| {
                    names.push(name);
                    names.len() - 1
                }) as u16
            },
            _ => 0xFFFF,
        };
        out.extend([x.is_ok() as u8, x.as_ref().map_or(0, |d| d.length)]);
        out.extend(form_index.to_le_bytes());
        valid += x.is_ok() as usize;
    }
    // Without the features every VEX and three-byte map encoding is #UD;
    // with them, so is every one whose row has no semantics yet (the release
    // contract until each phase); F3 0F BC/BD are BSF/BSR without BMI1/LZCNT
    for (features, all) in [(0, true), (ALL, false)] {
        TEST_FEATURES.with(|f| f.set(features));
        TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(all));
        for (bits, bytes) in &rows {
            let mut full = bytes.clone();
            full.extend(FILLER);
            let (x, _) = x64(*bits, &full);
            let at = bytes.iter().position(|&b| !matches!(b, 0x26 | 0x2E | 0x36 | 0x3E | 0x64..=0x67 | 0xF0 | 0xF2 | 0xF3 | 0x40..=0x4F)).unwrap();
            let opcode = &bytes[at..];
            let simd = matches!(opcode[0], 0xC4 | 0xC5) && (*bits == 64 || opcode[1] >= 0xC0)
                || opcode.starts_with(&[0x0F, 0x38])
                || opcode.starts_with(&[0x0F, 0x3A]);
            if simd {
                assert!(
                    matches!(
                        x,
                        Err(DecodeError::InvalidOpcode | DecodeError::UnknownOpcode(_))
                    ) || features != 0 && x.as_ref().is_ok_and(|d| d.encoding.implemented()),
                    "{features:x} {bits} {bytes:02X?}: {x:?}"
                );
            }
            else if features == 0 && matches!(opcode, [0x0F, 0xBC | 0xBD, ..]) {
                assert_eq!(
                    x.unwrap().opcode,
                    0x0F00 | opcode[1] as u32,
                    "{bits} {bytes:02X?}"
                );
            }
        }
    }
    TEST_FEATURES.with(|f| f.set(0));
    TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(false));
    std::fs::create_dir_all("build/x64-decode").unwrap();
    std::fs::write("build/x64-decode/simd.bin", out).unwrap();
    std::fs::write(
        "build/x64-decode/simd-forms.json",
        format!(
            "[{}]",
            names
                .iter()
                .map(|n| format!("{n:?}"))
                .collect::<Vec<_>>()
                .join(",")
        ),
    )
    .unwrap();
    println!("SIMD decode corpus: {} encodings, {valid} valid with every feature, {compared} also decoded by the IR decoder", rows.len());
    assert!(
        rows.len() > 1_000_000 && names.len() == 688,
        "{} {}",
        rows.len(),
        names.len()
    );
}
