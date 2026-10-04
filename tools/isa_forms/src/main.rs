//! The instruction forms of docs/simd-xsave-plan.md, from iced-x86: every
//! legacy or VEX encoding whose CPUID features are the plan's extensions
//! (with nothing outside them and what v86 already implements). Also lists
//! the other legacy 0F38/0F3A and VEX encodings, which must stay #UD.
//!
//! Writes gen/isa_forms.json; `--check` fails if that file is stale:
//!   cargo run --release --manifest-path tools/isa_forms/Cargo.toml -- [--check] gen/isa_forms.json
use iced_x86::{Code, CpuidFeature, EncodingKind, MandatoryPrefix, OpCodeInfo, OpCodeTableKind};
use serde_json::{json, Value};

/// The extensions of the plan, in report order, and their names there
const TARGET: &[(CpuidFeature, &str)] = &[
    (CpuidFeature::SSSE3, "SSSE3"),
    (CpuidFeature::SSE4_1, "SSE4.1"),
    (CpuidFeature::SSE4_2, "SSE4.2"),
    (CpuidFeature::POPCNT, "POPCNT"),
    (CpuidFeature::XSAVE, "XSAVE"),
    (CpuidFeature::XSAVEOPT, "XSAVEOPT"),
    (CpuidFeature::XSAVEC, "XSAVEC"),
    (CpuidFeature::XSAVES, "XSAVES"),
    (CpuidFeature::AVX, "AVX"),
    (CpuidFeature::AVX2, "AVX2"),
    (CpuidFeature::FMA, "FMA"),
    (CpuidFeature::F16C, "F16C"),
    (CpuidFeature::BMI1, "BMI1"),
    (CpuidFeature::BMI2, "BMI2"),
    (CpuidFeature::LZCNT, "LZCNT"),
    (CpuidFeature::MOVBE, "MOVBE"),
];

/// Features v86 implements already, which a target form may list as well
fn implemented(feature: CpuidFeature) -> bool {
    use CpuidFeature::*;
    matches!(feature, INTEL8086 | INTEL186 | INTEL286 | INTEL386 | INTEL486 | X64 | MMX | SSE | SSE2 | SSE3)
}

fn target(feature: CpuidFeature) -> Option<usize> { TARGET.iter().position(|&(f, _)| f == feature) }

fn map(table: OpCodeTableKind) -> &'static str {
    match table {
        OpCodeTableKind::Normal => "-",
        OpCodeTableKind::T0F => "0F",
        OpCodeTableKind::T0F38 => "0F38",
        OpCodeTableKind::T0F3A => "0F3A",
        _ => "other",
    }
}

fn prefix(prefix: MandatoryPrefix) -> &'static str {
    match prefix {
        MandatoryPrefix::None => "",
        MandatoryPrefix::PNP => "NP",
        MandatoryPrefix::P66 => "66",
        MandatoryPrefix::PF3 => "F3",
        MandatoryPrefix::PF2 => "F2",
    }
}

fn encoding(kind: EncodingKind) -> &'static str {
    match kind {
        EncodingKind::Legacy => "legacy",
        EncodingKind::VEX => "VEX",
        EncodingKind::EVEX => "EVEX",
        EncodingKind::XOP => "XOP",
        EncodingKind::D3NOW => "3DNow",
        EncodingKind::MVEX => "MVEX",
        _ => "other",
    }
}

fn modes(op: &OpCodeInfo) -> Vec<u32> {
    [(16, op.mode16()), (32, op.mode32()), (64, op.mode64())].iter().filter(|m| m.1).map(|m| m.0).collect()
}

/// The fields of one form; VEX ones have W/L, legacy ones an operand size
fn form(code: Code, isa: Vec<&str>) -> Value {
    let op = code.op_code();
    let mut value = json!({
        "id": format!("{code:?}"),
        "isa": isa,
        "mnemonic": format!("{:?}", code.mnemonic()).to_uppercase(),
        "instruction": op.instruction_string(),
        "opcode": op.op_code_string(),
        "encoding": encoding(op.encoding()),
        "map": map(op.table()),
        "prefix": prefix(op.mandatory_prefix()),
        "byte": op.op_code(),
        "modes": modes(op),
        "real_v86": op.real_mode() || op.virtual8086_mode(),
        "operands": op.op_kinds().iter().map(|k| format!("{k:?}")).collect::<Vec<_>>(),
        "memory": format!("{:?}", op.memory_size()),
    });
    let object = value.as_object_mut().unwrap();
    if op.is_group() {
        object.insert("group".into(), json!(op.group_index()));
    }
    if op.is_rm_group() {
        object.insert("rm_group".into(), json!(op.rm_group_index()));
    }
    if op.encoding() == EncodingKind::VEX {
        let w = if op.is_wig() { "WIG".into() } else if op.is_wig32() { format!("W{}/WIG32", op.w()) } else { format!("W{}", op.w()) };
        let l = if op.is_lig() { "LIG".into() } else { format!("L{}", op.l()) };
        object.insert("w".into(), json!(w));
        object.insert("l".into(), json!(l));
    }
    else if op.operand_size() != 0 {
        object.insert("operand_size".into(), json!(op.operand_size()));
    }
    if op.can_use_lock_prefix() {
        object.insert("lock".into(), json!(true));
    }
    if op.requires_unique_reg_nums() {
        object.insert("unique_regs".into(), json!(true));
    }
    if op.is_privileged() {
        object.insert("privileged".into(), json!(true));
    }
    value
}

/// The plan's extensions (indexes into TARGET) of a form in scope, else None
fn in_scope(code: Code) -> Option<Vec<usize>> {
    let op = code.op_code();
    if !op.is_instruction() || !matches!(op.encoding(), EncodingKind::Legacy | EncodingKind::VEX) {
        return None;
    }
    let features = code.cpuid_features();
    let mut targets: Vec<usize> = features.iter().filter_map(|&f| target(f)).collect();
    targets.sort();
    let other = features.iter().any(|&f| target(f).is_none() && !implemented(f));
    (!targets.is_empty() && !other).then_some(targets)
}

fn generate() -> String {
    let mut forms: Vec<(usize, u32, Value)> = Vec::new();
    let mut outside: Vec<Value> = Vec::new();
    let mut counts = vec![0; TARGET.len()];
    for code in Code::values() {
        let op = code.op_code();
        let features = code.cpuid_features();
        if let Some(targets) = in_scope(code) {
            for &t in &targets {
                counts[t] += 1;
            }
            forms.push((targets[0], code as u32, form(code, targets.iter().map(|&t| TARGET[t].1).collect())));
        }
        else if op.is_instruction() && (op.encoding() == EncodingKind::VEX
            || op.encoding() == EncodingKind::Legacy && matches!(op.table(), OpCodeTableKind::T0F38 | OpCodeTableKind::T0F3A)) {
            outside.push(json!({
                "id": format!("{code:?}"),
                "cpuid": features.iter().map(|f| format!("{f:?}")).collect::<Vec<_>>(),
                "instruction": op.instruction_string(),
                "opcode": op.op_code_string(),
            }));
        }
    }
    forms.sort_by_key(|f| (f.0, f.1));
    let mut text = String::new();
    text += "{\n";
    text += "\"about\": \"Instruction forms of docs/simd-xsave-plan.md, one per iced-x86 Code (the id). Generated by tools/isa_forms from iced-x86 1.21.0; regenerate with `make isa-forms`. forms: legacy and VEX encodings whose CPUID features are the plan's extensions; outside_scope: the other legacy 0F38/0F3A and VEX encodings, which stay #UD.\",\n";
    text += &format!("\"counts\": {},\n", json!(TARGET.iter().zip(&counts).map(|(t, c)| (t.1.to_string(), json!(c))).collect::<serde_json::Map<_, _>>()));
    text += &format!("\"total\": {},\n", forms.len());
    text += "\"forms\": [\n";
    text += &forms.iter().map(|f| f.2.to_string()).collect::<Vec<_>>().join(",\n");
    text += "\n],\n\"outside_scope\": [\n";
    text += &outside.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",\n");
    text += "\n]\n}\n";
    text
}

/// Address and contents of the .text section of an ELF64 file
fn elf_text(path: &str) -> (u64, Vec<u8>) {
    let data = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    assert!(data.starts_with(b"\x7fELF") && data[4] == 2, "{path}: not an ELF64 file");
    let u16_at = |o: usize| u16::from_le_bytes(data[o..o + 2].try_into().unwrap()) as usize;
    let u32_at = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap()) as usize;
    let u64_at = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    let (shoff, shentsize, shnum, shstrndx) = (u64_at(0x28) as usize, u16_at(0x3A), u16_at(0x3C), u16_at(0x3E));
    let section = |i: usize| shoff + i * shentsize;
    let names = u64_at(section(shstrndx) + 0x18) as usize;
    for i in 0..shnum {
        let s = section(i);
        let name = &data[names + u32_at(s)..];
        if name.starts_with(b".text\0") {
            let (address, offset, size) = (u64_at(s + 0x10), u64_at(s + 0x18) as usize, u64_at(s + 0x20) as usize);
            return (address, data[offset..offset + size].to_vec());
        }
    }
    panic!("{path}: no .text section");
}

/// Forms in scope that x86-64 libraries use, by occurrences in their .text
/// (a linear sweep with iced-x86): `--hot out.json lib...`
fn hot(out: &str, libraries: &[String]) {
    use std::collections::BTreeMap;
    let mut uses: BTreeMap<u32, BTreeMap<String, u64>> = BTreeMap::new();
    let mut sources = Vec::new();
    for path in libraries {
        let name = path.rsplit('/').next().unwrap().to_string();
        let (address, text) = elf_text(path);
        let mut decoder = iced_x86::Decoder::with_ip(64, &text, address, iced_x86::DecoderOptions::NONE);
        let mut instructions = 0u64;
        while decoder.can_decode() {
            let code = decoder.decode().code();
            instructions += 1;
            if in_scope(code).is_some() {
                *uses.entry(code as u32).or_default().entry(name.clone()).or_default() += 1;
            }
        }
        sources.push(json!({ "file": name, "text_bytes": text.len(), "instructions": instructions }));
    }
    let mut forms: Vec<(u64, u32, Value)> = uses.iter().map(|(&code, by_file)| {
        let code = Code::values().nth(code as usize).unwrap();
        let total = by_file.values().sum::<u64>();
        let isa: Vec<&str> = in_scope(code).unwrap().iter().map(|&t| TARGET[t].1).collect();
        (total, code as u32, json!({ "id": format!("{code:?}"), "isa": isa, "instruction": code.op_code().instruction_string(), "uses": by_file }))
    }).collect();
    forms.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut text = String::new();
    text += "{\n";
    text += "\"about\": \"Hot forms of docs/simd-xsave-plan.md (5.1): the forms in scope that the x86-64 glibc uses, which only run once the guest sees the extension (its baseline code is SSE2). uses: occurrences in each library's .text. Generated by tools/isa_forms --hot from the libc6 package below; see the plan's implementation record for the command.\",\n";
    text += "\"package\": \"libc6_2.39-0ubuntu8.9_amd64.deb (Ubuntu 24.04, sha256 ff5557d99b51f761c4b7c92368b9cc45565eda17df9bf9eb4b134d09825008be)\",\n";
    text += &format!("\"sources\": {},\n", json!(sources));
    text += &format!("\"total\": {},\n", forms.len());
    text += "\"forms\": [\n";
    text += &forms.iter().map(|f| f.2.to_string()).collect::<Vec<_>>().join(",\n");
    text += "\n]\n}\n";
    std::fs::write(out, text).unwrap();
    println!("wrote {out}: {} forms in scope used by {}", forms.len(), libraries.len());
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--hot") {
        return hot(&args[1], &args[2..]);
    }
    let check = args.iter().any(|a| a == "--check");
    let path = args.iter().find(|a| !a.starts_with("--")).cloned().unwrap_or("gen/isa_forms.json".into());
    let text = generate();
    let summary: Value = serde_json::from_str(&text).unwrap();
    println!("{} forms; per extension {}; {} encodings outside the plan's scope",
        summary["total"], summary["counts"], summary["outside_scope"].as_array().unwrap().len());
    if check {
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        if current != text {
            eprintln!("{path} is stale: run `make isa-forms`");
            std::process::exit(1);
        }
    }
    else {
        std::fs::write(&path, text).unwrap();
        println!("wrote {path}");
    }
}
