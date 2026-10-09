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
/// The features of the plan (docs/simd-xsave-plan.md) and the baseline's:
/// iced-x86 forms that need others are #UD
fn plan_feature(feature: CpuidFeature) -> bool {
    use CpuidFeature::*;
    advertised(feature)
        || matches!(feature, SSSE3 | SSE4_1 | SSE4_2 | AVX | AVX2 | FMA | F16C | BMI1 | BMI2 | LZCNT | MOVBE)
}
/// The bytes after each entry of the SIMD corpus (tests/decode/simd_corpus.rs FILLER)
const FILLER: [u8; 8] = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x08];
/// The SIMD decode corpus (tests/decode/simd_corpus.rs): VEX and legacy SIMD
/// encodings in 16-, 32- and 64-bit mode, decoded by the x64 decoder with
/// every feature as if all rows had semantics. Validity, length and VEX form
/// must match iced-x86, except where the SDM and iced-x86 differ (counted).
fn simd_corpus(path: &str) {
    let Ok(data) = std::fs::read(path) else { return; };
    let names: Vec<String> =
        serde_json::from_slice(&std::fs::read("build/x64-decode/simd-forms.json").unwrap()).unwrap();
    let (mut at, mut rows, mut valid, mut vvvv_top) = (0, 0, 0, 0);
    let mut differences: BTreeMap<String, (usize, String)> = BTreeMap::new();
    while at < data.len() {
        let (bits, n) = (data[at] as u32, data[at + 1] as usize);
        let bytes = &data[at + 2..at + 2 + n];
        let ok = data[at + 2 + n] == 1;
        let length = data[at + 3 + n] as usize;
        let form = u16::from_le_bytes([data[at + 4 + n], data[at + 5 + n]]);
        at += 6 + n;
        rows += 1;
        let mut full = bytes.to_vec();
        full.extend(FILLER);
        let decode = |b: &[u8]| Decoder::with_ip(bits, b, 0x1000, DecoderOptions::NONE).decode();
        let i = decode(&full);
        let expected = !i.is_invalid() && i.cpuid_features().iter().all(|&f| plan_feature(f));
        let name = |form: u16| if form == 0xFFFF { "-".to_string() } else { names[form as usize].clone() };
        // the opcode, after the legacy prefixes and REX
        let start = bytes
            .iter()
            .position(|&b| !(matches!(b, 0x26 | 0x2E | 0x36 | 0x3E | 0x64..=0x67 | 0xF0 | 0xF2 | 0xF3) || bits == 64 && b & 0xF0 == 0x40))
            .unwrap();
        let problem = if ok == expected {
            if ok && (length != i.len() || form != 0xFFFF && name(form) != format!("{:?}", i.code())) {
                Some(format!("v86 {} length {length}, iced {:?} length {}", name(form), i.code(), i.len()))
            } else {
                None
            }
        } else if ok && bits != 64 && bytes[start] == 0xC4 && bytes[start + 2] & 0x40 == 0 && {
            // SDM 2.3.5.6: outside 64-bit mode the three-byte prefix's top
            // VEX.vvvv bit is ignored; iced-x86 requires it to be 1
            let mut set = full.clone();
            set[start + 2] |= 0x40;
            let j = decode(&set);
            !j.is_invalid() && j.len() == length && format!("{:?}", j.code()) == name(form)
        } {
            vvvv_top += 1;
            None
        } else {
            Some(format!("v86 {} ({}), iced {} ({:?} {:?})", if ok { "valid" } else { "#UD" }, name(form),
                if expected { "valid" } else { "#UD" }, i.code(), i.cpuid_features()))
        };
        valid += ok as usize;
        if let Some(problem) = problem {
            let key = format!("{bits}-bit {:02X?}", &bytes[..(start + 4).min(bytes.len())]);
            differences.entry(key).or_insert((0, problem)).0 += 1;
        }
    }
    for (key, (count, problem)) in differences.iter().take(40) {
        println!("DIFF {key}: {problem} x{count}");
    }
    println!(
        "SIMD corpus: {rows} VEX and legacy SIMD encodings in 16/32/64-bit mode, {valid} valid; \
         {vvvv_top} differ from iced-x86 by SDM 2.3.5.6 (the top VEX.vvvv bit outside 64-bit mode)"
    );
    assert!(differences.is_empty(), "{} groups of SIMD encodings differ from iced-x86", differences.len());
    println!("PASS: the SIMD decode corpus agrees with iced-x86 1.21.0 in validity, length and VEX form");
}
fn main() {
    opcode_map("build/x64-decode/opcodes.json");
    simd_corpus("build/x64-decode/simd.bin");
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
