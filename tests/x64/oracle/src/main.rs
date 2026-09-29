use iced_x86::{CpuidFeature, Decoder, DecoderOptions, OpKind, Register};
use std::collections::BTreeMap;
fn reg(r: Register) -> i64 {
    match r {
        Register::None => -1,
        Register::RIP | Register::EIP => -2,
        _ => r.number() as i64,
    }
}
/// CPUID features of the x64 qualification profile (instructions_0f.rs
/// cpuid + apply_x64_test_capabilities). ENDBR is a hint NOP without CET.
fn advertised(feature: CpuidFeature) -> bool {
    use CpuidFeature::*;
    matches!(feature, INTEL8086 | INTEL186 | INTEL286 | INTEL386 | INTEL486 | X64 | CMOV | CMPXCHG16B | CPUID | CX8
        | FPU | FPU287 | FPU387 | FXSR | MMX | MSR | MULTIBYTENOP | PAUSE | POPCNT | RDRAND | SEP | SSE | SSE2 | SSE3
        | SYSCALL | TSC | CET_IBT | RDTSCP | CLFSH)
}
/// Long-mode opcode map: validity (after CPUID gating) and length of every
/// row of build/x64-decode/opcodes.json (x64::decode::tests::opcode_map_corpus).
fn opcode_map(path: &str) {
    let Ok(text) = std::fs::read(path) else { return; };
    let rows: Vec<Vec<serde_json::Value>> = serde_json::from_slice(&text).unwrap();
    let mut differences: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let mut valid = 0;
    // Per-row expectations for tests/x64/opcode_matrix.mjs (execution).
    let mut expected_rows = Vec::with_capacity(rows.len());
    for row in &rows {
        let bytes: Vec<u8> = row[0].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
        let ok = row[1].as_u64().unwrap() == 1;
        let length = row[2].as_u64().unwrap() as usize;
        let i = Decoder::with_ip(64, &bytes, 0xFFFF_8000_0000_1000, DecoderOptions::NONE).decode();
        let expected = !i.is_invalid() && i.cpuid_features().iter().all(|&f| advertised(f));
        valid += expected as usize;
        expected_rows.push(format!("[\"{}\",{},{},\"{:?}\"]", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            expected as u8, if i.is_invalid() { length } else { i.len() }, i.code()));
        let problem = if ok != expected {
            Some(format!("v86 {} iced {} ({:?} {:?})", if ok { "valid" } else { "#UD" }, if expected { "valid" } else { "#UD" }, i.code(), i.cpuid_features()))
        } else if ok && length != i.len() {
            Some(format!("length v86 {} iced {} ({:?})", length, i.len(), i.code()))
        } else {
            None
        };
        if let Some(problem) = problem {
            // key: prefixes and opcode bytes, without ModRM/SIB/immediates
            let mut key = String::new();
            let mut at = 0;
            while matches!(bytes[at], 0x66 | 0x67 | 0xF0 | 0xF2 | 0xF3 | 0x40..=0x4F) { key += &format!("{:02X} ", bytes[at]); at += 1; }
            let opcode_len = if bytes[at] != 0x0F { 1 } else if matches!(bytes[at + 1], 0x38 | 0x3A) { 3 } else { 2 };
            for b in &bytes[at..at + opcode_len] { key += &format!("{:02X}", b); }
            key += &format!(" /{}{}", bytes[at + opcode_len] >> 3 & 7, if bytes[at + opcode_len] >= 0xC0 { "r" } else { "m" });
            let entry = differences.entry(key).or_insert((0, problem));
            entry.0 += 1;
        }
    }
    // The shared decoder gives undefined and unadvertised opcodes a length and
    // leaves #UD to the executors (tests/x64/opcode_matrix.mjs checks that at
    // run time); anything else is a failure.
    let mut decoded_undefined = 0;
    let mut failures = 0;
    for (key, (count, problem)) in &differences {
        if problem.starts_with("v86 valid iced #UD") {
            decoded_undefined += count;
            if std::env::var("OPCODE_MAP_VERBOSE").is_ok() { println!("UNDEFINED {key}: {problem} x{count}"); }
        } else {
            failures += 1;
            println!("DIFF {key}: {problem} x{count}");
        }
    }
    std::fs::write("build/x64-decode/expected.json", format!("[{}]", expected_rows.join(","))).unwrap();
    println!("opcode map: {} rows, {} valid per iced-x86 and the CPUID profile; {} rows of undefined/unadvertised opcodes decoded for executor #UD", rows.len(), valid, decoded_undefined);
    assert_eq!(failures, 0, "long-mode opcode map validity/length differs from iced-x86");
}
fn main() {
    opcode_map("build/x64-decode/opcodes.json");
    let path = std::env::args()
        .nth(1)
        .unwrap_or("build/x64-decode/corpus.json".into());
    let rows: Vec<Vec<serde_json::Value>> =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for (n, row) in rows.iter().enumerate() {
        let bytes: Vec<u8> = row[0]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        let bitness = row[1].as_u64().unwrap() as u32;
        let i =
            Decoder::with_ip(bitness, &bytes, 0xFFFF_8000_0000_1000, DecoderOptions::NONE).decode();
        let expected: Vec<u64> = row[2..]
            .iter()
            .map(|v| v.as_u64().unwrap_or_else(|| v.as_i64().unwrap() as u64))
            .collect();
        assert!(!i.is_invalid(), "invalid oracle row {n}: {bytes:02X?}");
        let memory = i.op1_kind() == OpKind::Memory;
        let segment =
            if memory { (i.memory_segment() as u32 - Register::ES as u32) as u64 } else { 0 };
        let mut displacement = if memory { i.memory_displacement64() } else { 0 };
        let address_size = expected[2];
        if address_size == 16 {
            displacement = displacement as u16 as u64;
        } else if address_size == 32 {
            displacement = displacement as u32 as u64;
        }
        let actual = vec![
            i.len() as u64,
            (i.op0_register().size() * 8) as u64,
            address_size,
            reg(i.op0_register()) as u64,
            if memory { u64::MAX } else { reg(i.op1_register()) as u64 },
            if memory { reg(i.memory_base()) as u64 } else { u64::MAX },
            if memory { reg(i.memory_index()) as u64 } else { u64::MAX },
            if memory { i.memory_index_scale().ilog2() as u64 } else { 0 },
            segment,
            displacement,
        ];
        assert_eq!(actual, expected, "oracle row {n}: {bytes:02X?}, {i:?}");
    }
    println!(
        "PASS: {} mode/prefix/REX/ModRM/SIB rows agree with iced-x86 1.21.0",
        rows.len()
    );
}
