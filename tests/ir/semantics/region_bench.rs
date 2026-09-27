//! Offline replay of captured automatic region compilations (xp_boot.mjs
//! IR_CAPTURE_FILE format) through the scheduler's compile entry points.
//! `IR_REGION_CORPUS=file cargo test --release region_bench -- --ignored --nocapture`
use crate::ir::{
    backend::wasm::StateLayout,
    frontend::decode::{GuestEip, LinearAddress, PhysicalAddress},
    passes::PassConfig,
    runtime::compile::*,
};
use std::time::Instant;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}

#[test]
#[ignore]
fn region_bench() {
    let Ok(path) = std::env::var("IR_REGION_CORPUS")
    else {
        return;
    };
    crate::ir::debug::force_audit(std::env::var("IR_PAGE_AUDIT").is_ok());
    let repeat: usize = std::env::var("IR_REGION_REPEAT").map_or(1, |v| v.parse().unwrap());
    let text = std::fs::read_to_string(path).unwrap();
    let (mut ok, mut failed, mut bytes, mut job) = (0, 0, 0usize, 1u64);
    let mut errors = std::collections::BTreeMap::<String, usize>::new();
    let started = Instant::now();
    for _ in 0..repeat {
        let only: Option<usize> = std::env::var("IR_REGION_ONLY").ok().map(|v| v.parse().unwrap());
        for (line_index, line) in text.lines().enumerate() {
            if only.is_some_and(|k| k != line_index) {
                continue;
            }
            let f: Vec<&str> = line.split(' ').collect();
            if f.len() < 8 || f.len() > 8 {
                continue; // fused multi-source records are not replayed here
            }
            let tier = if f[0] == "1" { Tier::One } else { Tier::Two };
            let default_32 = f[1] == "1";
            let pc: u32 = f[4].parse().unwrap();
            let linear: u32 = f[5].parse().unwrap();
            let code = hex(f[6]);
            let mut mappings = vec![];
            let mut dependencies: Vec<CodeDependency> = vec![];
            for m in f[7].split(',') {
                let (l, p) = m.split_once(':').unwrap();
                let physical = PhysicalAddress(p.parse().unwrap());
                mappings.push(CodeMapping {
                    linear: LinearAddress(l.parse().unwrap()),
                    physical,
                });
                if !dependencies.iter().any(|d| d.page == physical) {
                    dependencies.push(CodeDependency { page: physical, version: 1 });
                }
            }
            let snapshot = ImmutableCodeSnapshot {
                bytes: code,
                dependencies,
                mappings,
            };
            let key = |job: u64| PublicationKey {
                job,
                vm_generation: 1,
                slot: 0,
                slot_generation: 0,
            };
            job += 1;
            let request = CompileRequest {
                key: key(job),
                pc: GuestEip(pc),
                linear: LinearAddress(linear),
                default_32,
                tier,
            };
            let config = IrConfig {
                optimize: true,
                passes: if tier == Tier::One { PassConfig::tier1() } else { Default::default() },
                execution_budget: 256,
                rep_iteration_budget: 64,
                max_code_bytes: if tier == Tier::One { 192 } else { 384 },
                layout: StateLayout {
                    gpr: 0,
                    flags: 32,
                    eip: 36,
                    committed: 40,
                    flag_operand: 44,
                },
            };
            let dump = std::env::var("IR_REGION_DUMP").ok();
            let result = if f[2] != "-" {
                let mut entries = vec![CpuEntryRequest { offset: 0, key: request.key }];
                for offset in f[2].split(',') {
                    job += 1;
                    entries.push(CpuEntryRequest {
                        offset: offset.parse().unwrap(),
                        key: key(job),
                    });
                }
                compile_cpu_shared_entries(&request, &snapshot, &entries, &config)
                    .map(|a| a.code.bytes.len())
            }
            else {
                compile_cpu_cfg_bounded(&request, &snapshot, &config).map(|(a, _, _)| {
                    if let Some(dir) = &dump {
                        if ok < 64 {
                            std::fs::write(format!("{}/r{}.wasm", dir, ok), &a.code.bytes).unwrap();
                        }
                    }
                    a.code.bytes.len()
                })
            };
            match result {
                Ok(len) => {
                    ok += 1;
                    bytes += len;
                },
                Err(error) => {
                    failed += 1;
                    *errors.entry(format!("{:?}", error)).or_default() += 1;
                },
            }
        }
    }
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    println!(
        "regions ok={} failed={} wasm_bytes={} total_ms={:.1} per_region_us={:.1}",
        ok,
        failed,
        bytes,
        ms,
        ms * 1000.0 / (ok + failed).max(1) as f64
    );
    for (e, n) in errors {
        println!("  error {} x{}", e, n);
    }
}
