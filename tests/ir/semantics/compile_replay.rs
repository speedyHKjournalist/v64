//! Replay immutable XP compiler inputs, without guest execution or hot selection.
//! Explicit ignored benchmark; normal CI does not compare machine-dependent time.
use crate::ir::{
    backend::wasm::StateLayout,
    frontend::{
        decode::{GuestEip, LinearAddress, PhysicalAddress},
        region::PredictedEdge,
    },
    runtime::{compile::*, diagnostics, entry::CpuEntryKey},
};
use std::{hint::black_box, time::Instant};

fn number(s: &str) -> u32 { s.parse().unwrap() }
fn list(s: &str) -> impl Iterator<Item = &str> { s.split(',').filter(|s| *s != "-") }

#[test]
#[ignore = "explicit immutable-capture compiler benchmark"]
fn compile_capture_replay() {
    let path = std::env::var("IR_CAPTURE_FILE").expect("set IR_CAPTURE_FILE from xp_boot.mjs");
    let corpus = std::fs::read_to_string(path).unwrap();
    let repeats = std::env::var("IR_REPLAY_RUNS").map_or(3, |s| number(&s)) as usize;
    assert!((1..=10).contains(&repeats));
    let mut totals = Vec::new();
    for repeat in 0..repeats {
        let mut elapsed = 0.0;
        let mut successes = 0;
        let mut failures = 0;
        let mut code_bytes = 0;
        let mut fingerprint = 0u64;
        diagnostics::compiler_benchmark_reset();
        for (index, line) in corpus.lines().enumerate() {
            let words: Vec<_> = line.split_whitespace().collect();
            assert!(words.len() >= 8 && (words.len() - 4) % 4 == 0);
            let tier = if words[0] == "1" { Tier::One } else { Tier::Two };
            let mode = words[1] == "1";
            let sources: Vec<_> = words[4..]
                .chunks_exact(4)
                .map(|row| {
                    let mappings: Vec<_> = list(row[3])
                        .map(|s| {
                            let (linear, physical) = s.split_once(':').unwrap();
                            CodeMapping {
                                linear: LinearAddress(number(linear)),
                                physical: PhysicalAddress(number(physical)),
                            }
                        })
                        .collect();
                    let mut dependencies = Vec::new();
                    for m in &mappings {
                        if !dependencies
                            .iter()
                            .any(|d: &CodeDependency| d.page == m.physical)
                        {
                            dependencies.push(CodeDependency {
                                page: m.physical,
                                version: 1,
                            });
                        }
                    }
                    CapturedRegion {
                        entry: CpuEntryKey {
                            pc: GuestEip(number(row[0])),
                            linear: LinearAddress(number(row[1])),
                            default_32: mode,
                        },
                        source: ImmutableCodeSnapshot {
                            bytes: (0..row[2].len())
                                .step_by(2)
                                .map(|i| u8::from_str_radix(&row[2][i..i + 2], 16).unwrap())
                                .collect(),
                            mappings,
                            dependencies,
                        },
                    }
                })
                .collect();
            let key = PublicationKey {
                job: index as u64 + 1,
                vm_generation: 1,
                slot: 1,
                slot_generation: 1,
            };
            let request = CompileRequest {
                key,
                pc: sources[0].entry.pc,
                linear: sources[0].entry.linear,
                default_32: mode,
                tier,
            };
            let config = IrConfig {
                optimize: true,
                passes: if tier == Tier::One {
                    crate::ir::passes::PassConfig::tier1()
                }
                else {
                    Default::default()
                },
                execution_budget: 256,
                rep_iteration_budget: 64,
                max_code_bytes: 1920,
                layout: StateLayout {
                    gpr: 0,
                    flags: 32,
                    eip: 36,
                    committed: 40,
                    flag_operand: 44,
                },
            };
            let edges: Vec<_> = list(words[3])
                .map(|s| {
                    let (a, b) = s.split_once(':').unwrap();
                    PredictedEdge {
                        from: GuestEip(number(a)),
                        target: GuestEip(number(b)),
                    }
                })
                .collect();
            let mut entries = vec![CpuEntryRequest { offset: 0, key }];
            for offset in list(words[2]) {
                let n = entries.len() as u64;
                entries.push(CpuEntryRequest {
                    offset: number(offset) as usize,
                    key: PublicationKey {
                        job: key.job + n + 100000,
                        slot: n as u32 + 1,
                        ..key
                    },
                });
            }
            let start = Instant::now();
            let result = if sources.len() > 1 {
                compile_cpu_fused_regions(
                    &request,
                    &sources[0].source,
                    &sources[1..],
                    &edges,
                    &config,
                )
            }
            else if entries.len() > 1 {
                compile_cpu_shared_entries(&request, &sources[0].source, &entries, &config)
            }
            else {
                compile_cpu_cfg_bounded(&request, &sources[0].source, &config).map(|(a, _, _)| a)
            };
            elapsed += start.elapsed().as_secs_f64() * 1000.0;
            match black_box(result) {
                Ok(artifact) => {
                    successes += 1;
                    code_bytes += artifact.code.bytes.len();
                    for byte in artifact.code.bytes {
                        fingerprint = fingerprint.wrapping_mul(1099511628211) ^ u64::from(byte);
                    }
                },
                Err(error) => {
                    failures += 1;
                    if repeat == 0 {
                        eprintln!("replay failure {index}: {error:?}");
                    }
                },
            }
        }
        let phases: Vec<_> = (0..20)
            .map(|i| unsafe { diagnostics::ir_diagnostic_get(5, i, 0) })
            .collect();
        println!("REPLAY {{\"round\":{repeat},\"ms\":{elapsed},\"successes\":{successes},\"failures\":{failures},\"code_bytes\":{code_bytes},\"fingerprint\":\"{fingerprint:016x}\",\"phases_ms\":{phases:?}}}");
        assert_eq!(failures, 0, "captured published inputs must compile");
        assert!(successes > 0);
        totals.push((code_bytes, fingerprint));
    }
    assert!(
        totals.iter().all(|r| *r == totals[0]),
        "replay code must be deterministic"
    );
}
