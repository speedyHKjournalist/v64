use iced_x86::{Decoder, DecoderOptions, OpKind, Register};
fn reg(r: Register) -> i64 {
    match r {
        Register::None => -1,
        Register::RIP | Register::EIP => -2,
        _ => r.number() as i64,
    }
}
fn main() {
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
