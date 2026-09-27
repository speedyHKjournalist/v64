use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    helper::HelperAbi,
    lowering::lower,
    passes::{run, PassConfig},
};
fn emit(bytes: &[u8], mode: bool, name: &str) { emit_at(bytes, mode, name, 0x8000); }
fn emit_at(bytes: &[u8], mode: bool, name: &str, pc: u32) {
    let mut r = lift_cpu(bytes, GuestEip(pc), LinearAddress(pc), mode).unwrap();
    for opt in 0..2 {
        if opt != 0 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-verr/{name}-{opt}.wasm"),
            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
        )
        .unwrap();
    }
}
#[test]
fn verr_fixtures() {
    std::fs::create_dir_all("build/ir-verr").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for asize in [16, 32] {
                for group in [4, 5] {
                    for operand in 0..15 {
                        for rep in [0, 0xF2, 0xF3] {
                            let seg = if operand < 8 { -1 } else { operand - 9 };
                            let mut bytes = vec![0x40];
                            if (width == 32) != mode {
                                bytes.push(0x66);
                            }
                            if (asize == 32) != mode {
                                bytes.push(0x67);
                            }
                            if rep != 0 {
                                bytes.push(rep);
                            }
                            if seg >= 0 {
                                bytes.push([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][seg as usize]);
                            }
                            bytes.extend([
                                0x0F,
                                0,
                                group << 3
                                    | if operand < 8 {
                                        0xC0 | operand as u8
                                    }
                                    else if asize == 32 {
                                        6
                                    }
                                    else {
                                        7
                                    },
                            ]);
                            emit(&bytes, mode, &cases.len().to_string());
                            cases.push(format!(
                                "[{:?},{mode},{width},{asize},{group},{operand},{seg},{rep}]",
                                bytes
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write("build/ir-verr/cases.json", format!("[{}]", cases.join(","))).unwrap();
    // Explicit raw ZF writers followed by lazy arithmetic must retain the new
    // backing bit, even when exits split these into separate CPU/IR entries.
    let prefixes: &[(&str, &[u8], u32)] = &[
        ("nop", &[0x90], 1),
        ("inc", &[0x43], 1),
        ("dec", &[0x4B], 1),
        ("add", &[0x01, 0xCB], 1),
        ("or", &[0x09, 0xCB], 1),
        ("adc", &[0x11, 0xCB], 1),
        ("sbb", &[0x19, 0xCB], 1),
        ("and", &[0x21, 0xCB], 1),
        ("sub", &[0x29, 0xCB], 1),
        ("xor", &[0x31, 0xCB], 1),
        ("cmp", &[0x39, 0xCB], 1),
        ("test", &[0x85, 0xCB], 1),
        ("neg", &[0xF7, 0xDB], 1),
        ("shl", &[0xD3, 0xE3], 1),
        ("shr", &[0xD3, 0xEB], 1),
        ("sar", &[0xD3, 0xFB], 1),
        ("rol", &[0xD3, 0xC3], 1),
        ("rcr", &[0xD3, 0xDB], 1),
        ("shld", &[0x0F, 0xA5, 0xD3], 1),
        ("shrd", &[0x0F, 0xAD, 0xD3], 1),
        ("mul", &[0xF7, 0xE3], 1),
        ("imul", &[0x0F, 0xAF, 0xD9], 1),
        ("sahf", &[0x9E], 1),
        ("sahf-inc", &[0x9E, 0x43], 2),
        ("bsf", &[0x0F, 0xBC, 0xD9], 1),
        ("bsf-inc", &[0x0F, 0xBC, 0xD9, 0x43], 2),
        ("bsr-inc", &[0x0F, 0xBD, 0xD9, 0x43], 2),
        ("popcnt", &[0xF3, 0x0F, 0xB8, 0xD9], 1),
        ("popcnt-inc", &[0xF3, 0x0F, 0xB8, 0xD9, 0x43], 2),
        ("aad", &[0xD5, 10], 1),
        ("aam", &[0xD4, 10], 1),
        ("aaa", &[0x37], 1),
        ("aas", &[0x3F], 1),
        ("xadd", &[0x0F, 0xC1, 0xCB], 1),
        ("cmpxchg", &[0x0F, 0xB1, 0xCB], 1),
        ("slow-load", &[0x43, 0x8B, 0x16], 2),
    ];
    let mut raw = Vec::new();
    for &(name, bytes, count) in prefixes {
        emit(bytes, true, &format!("raw-{name}"));
        emit_at(
            &[0x90],
            true,
            &format!("bridge-{name}"),
            0x8000 + bytes.len() as u32,
        );
        for group in [4, 5] {
            let mut both = bytes.to_vec();
            both.extend([0x0F, 0, 0xC7 | group << 3]);
            emit(&both, true, &format!("raw-{name}-{group}"));
        }
        raw.push(format!("[\"{name}\",{:?},{count}]", bytes));
    }

    std::fs::write("build/ir-verr/raw.json", format!("[{}]", raw.join(","))).unwrap();
}
#[test]
fn verr_terminal_contract() {
    for group in [4, 5] {
        let modrm = 0xC0 | group << 3;
        assert!(lift(&[0x0F, 0, modrm], GuestEip(0), LinearAddress(0), true).is_err());
        for bytes in [vec![0xF0, 0x0F, 0, modrm], vec![0x0F, 0, modrm, 0x90]] {
            assert!(lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
        }
        let r = lift_cpu(&[0x0F, 0, modrm], GuestEip(0), LinearAddress(0), true).unwrap();
        assert!(matches!(r.helpers[0].abi, HelperAbi::CpuExit));
    }
}
