//! Offline compiler-scaling experiment over captured XP code pages.
//! `IR_PAGE_CORPUS=file cargo test --release page_bench -- --ignored --nocapture`
use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        region::{lift_cpu_cfg_page, CfgLimits, CfgSource},
    },
    lowering::{lower_limited, CompileError},
    passes::{licm, run, PassConfig},
};
use std::time::Instant;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}
fn field<'a>(line: &'a str, key: &str) -> &'a str {
    let at = line.find(&format!("\"{}\":", key)).unwrap() + key.len() + 3;
    let rest = &line[at..];
    let end = rest.find([',', '}']).unwrap();
    if rest.starts_with('"') {
        let end = rest[1..].find('"').unwrap();
        &rest[1..1 + end]
    }
    else if rest.starts_with('[') {
        &rest[1..rest.find(']').unwrap()]
    }
    else {
        &rest[..end]
    }
}

#[test]
#[ignore]
fn page_bench() {
    let Ok(path) = std::env::var("IR_PAGE_CORPUS")
    else {
        return;
    };
    let tier2 = std::env::var("IR_PAGE_TIER").map_or(false, |t| t == "2");
    // Measure the release pipeline: no debug/test audits.
    crate::ir::debug::force_audit(std::env::var("IR_PAGE_AUDIT").is_ok());
    let max_entries: usize = std::env::var("IR_PAGE_ENTRIES").map_or(64, |v| v.parse().unwrap());
    let repeat: usize = std::env::var("IR_PAGE_REPEAT").map_or(1, |v| v.parse().unwrap());
    let text = std::fs::read_to_string(path).unwrap().repeat(repeat);
    let mut totals = [0f64; 5];
    let (mut ok, mut failed) = (0, 0);
    let mut errors = std::collections::BTreeMap::<String, usize>::new();
    let (mut instructions, mut blocks, mut bytes_out, mut entries_in, mut entries_served) = (0, 0, 0, 0, 0);
    let mut worst = vec![];
    for line in text.lines().filter(|l| l.starts_with('{')) {
        let linear: u32 = field(line, "linear").parse().unwrap();
        let cs_base: u32 = field(line, "cs_base").parse().unwrap();
        let default_32 = field(line, "default_32") == "1";
        let mut code = hex(field(line, "bytes"));
        code.extend(hex(field(line, "next")));
        let entries: Vec<GuestEip> = field(line, "entries")
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| GuestEip(linear.wrapping_add(s.parse::<u32>().unwrap()).wrapping_sub(cs_base)))
            .take(max_entries)
            .collect();
        entries_in += entries.len();
        let source = CfgSource {
            bytes: &code,
            pc: GuestEip(linear.wrapping_sub(cs_base)),
            linear: LinearAddress(linear),
        };
        let mut clock = Instant::now();
        let mut lap = |slot: usize, clock: &mut Instant| {
            let now = Instant::now();
            totals[slot] += (now - *clock).as_secs_f64() * 1000.0;
            *clock = now;
        };
        let started = Instant::now();
        let result = (|| -> Result<(usize, usize, usize, usize), CompileError> {
            let (mut region, served) = lift_cpu_cfg_page(source, &entries, default_32, 64, CfgLimits::PAGE)?;
            if std::env::var("IR_PAGE_DEBUG").is_ok() {
                let mut preds = vec![0; region.blocks.len()];
                for b in &region.blocks {
                    for e in b.terminator.as_ref().unwrap().edges() {
                        preds[e.target.index()] += 1;
                    }
                }
                for (i, b) in region.blocks.iter().enumerate() {
                    if b.entry_state.is_none() && preds[i] > 1 {
                        let ops: Vec<_> = b.instructions.iter().take(4).map(|id| format!("{:?}", region.instructions[id.index()].op)).collect();
                        let pcs: Vec<_> = b.instructions.iter().filter_map(|id| region.instructions[id.index()].state).take(1).map(|s| region.states[s.index()].instruction_pc.0).collect();
                        println!("join-without-recovery page={:#x} block={} preds={} pcs={:x?} ops={:?}", linear, i, preds[i], pcs, ops);
                    }
                }
            }
            let n = region.instructions.len();
            let b = region.blocks.len();
            lap(0, &mut clock);
            let config = if tier2 { PassConfig::default() } else { PassConfig::tier1() };
            run(&mut region, config).map_err(CompileError::InvalidIr)?;
            if tier2 {
                licm::run(&mut region, licm::DEFAULT_WORK_LIMIT).map_err(CompileError::InvalidIr)?;
            }
            crate::ir::passes::strip_polls(&mut region);
            lap(1, &mut clock);
            if std::env::var("IR_PAGE_DEBUG").is_ok() {
                let mut preds = vec![vec![]; region.blocks.len()];
                for (i, b) in region.blocks.iter().enumerate() {
                    for e in b.terminator.as_ref().unwrap().edges() {
                        preds[e.target.index()].push(i);
                    }
                }
                for (i, b) in region.blocks.iter().enumerate() {
                    if b.entry_state.is_none() && !region.entries.contains(&crate::ir::ids::BlockId(i as u32)) {
                        let ops: Vec<_> = b.instructions.iter().take(3).map(|id| format!("{:?}", region.instructions[id.index()].op)).collect();
                        let term = match b.terminator.as_ref().unwrap() { crate::ir::hir::Terminator::Branch(_) => "br", crate::ir::hir::Terminator::CondBranch{..} => "cond", crate::ir::hir::Terminator::Exit(_) => "exit" };
                        println!("norecovery page={:#x} block={} preds={:?} params={} insts={} term={} ops={:?}", linear, i, preds[i], b.params.len(), b.instructions.len(), term, ops);
                    }
                }
            }
            let mut mir = lower_limited(&region, CfgLimits::PAGE)?;
            lap(2, &mut clock);
            if tier2 {
                mir.fold_constants()?;
                mir.schedule_operand_stack(262_144)?;
                mir.allocate_machine_locals(4_000_000)?;
            }
            lap(3, &mut clock);
            let artifact = emit_cpu(&mir, 256)?;
            if let Ok(dir) = std::env::var("IR_PAGE_DUMP_ALL") {
                std::fs::write(format!("{}/{:08x}.wasm", dir, linear), &artifact.bytes).unwrap();
            }
            if let Ok(dump) = std::env::var("IR_PAGE_DUMP") {
                if u32::from_str_radix(&dump, 16).unwrap() == linear {
                    std::fs::write("/tmp/page.wasm", &artifact.bytes).unwrap();
                    println!("dumped {:#x}: {} bytes, {} locals", linear, artifact.bytes.len(), artifact.locals);
                }
            }
            lap(4, &mut clock);
            Ok((n, b, artifact.bytes.len(), served.len()))
        })();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok((n, b, len, served)) => {
                ok += 1;
                instructions += n;
                blocks += b;
                bytes_out += len;
                entries_served += served;
                worst.push((ms, linear, n, b, served));
            },
            Err(error) => {
                failed += 1;
                *errors.entry(format!("{:?}", error)).or_default() += 1;
            },
        }
    }
    worst.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!(
        "pages ok={} failed={} hir_insts={} blocks={} wasm_bytes={} entries {}/{}",
        ok, failed, instructions, blocks, bytes_out, entries_served, entries_in
    );
    println!(
        "ms lift={:.1} passes={:.1} lower={:.1} machine={:.1} emit={:.1} total={:.1}",
        totals[0],
        totals[1],
        totals[2],
        totals[3],
        totals[4],
        totals.iter().sum::<f64>()
    );
    for (e, n) in &errors {
        println!("  error {} x{}", e, n);
    }
    for w in worst.iter().take(8) {
        println!("  slow {:.1}ms linear={:#x} insts={} blocks={} entries={}", w.0, w.1, w.2, w.3, w.4);
    }
}
