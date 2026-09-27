use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn counter_branch_fixtures() {
    std::fs::create_dir_all("build/ir-loops").unwrap();
    let mut cases = Vec::new();
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    for mode in [false, true] {
        for operand in [16, 32] {
            for address in [16, 32] {
                for op in 0xE0..=0xE3u8 {
                    for disp in [-128i8, -17, -1, 0, 1, 127] {
                        for pc in [0u32, 1, 0xFFFC, 0x100000, 0xFFFFFFFC] {
                            let mut bytes = Vec::new();
                            if mode != (operand == 32) {
                                bytes.push(0x66);
                            }
                            if mode != (address == 32) {
                                bytes.push(0x67);
                            }
                            bytes.extend([op, disp as u8]);
                            let mut r =
                                lift_cpu(&bytes, GuestEip(pc), LinearAddress(0x100000), mode)
                                    .unwrap();
                            for opt in 0..2 {
                                if opt != 0 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                let mir = lower(&r).unwrap();
                                std::fs::write(
                                    format!("build/ir-loops/{}-{opt}.wasm", cases.len()),
                                    emit_cpu(&mir, 100).unwrap().bytes,
                                )
                                .unwrap();
                                std::fs::write(
                                    format!("build/ir-loops/{}-{opt}-standalone.wasm", cases.len()),
                                    emit(&mir, layout, 100).unwrap().bytes,
                                )
                                .unwrap();
                            }
                            cases.push(format!(
                                "[{:?},{mode},{operand},{address},{op},{disp},{pc}]",
                                bytes
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-loops/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    let chains = [
        vec![0x01, 0xD8, 0xE0, 0xF8],
        vec![0x29, 0xD8, 0xE1, 0xF8],
        vec![0x41, 0xE2, 0xF8],
        vec![0x66, 0x49, 0x67, 0xE0, 0xF8],
        vec![0xB9, 1, 0, 0, 0, 0xE2, 0xF8],
        vec![0xB9, 0, 0, 0, 0, 0xE3, 0xF8],
    ];
    for (n, bytes) in chains.iter().enumerate() {
        let mut r = lift_cpu(bytes, GuestEip(0x100000), LinearAddress(0x100000), true).unwrap();
        for opt in 0..2 {
            if opt != 0 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-loops/chain-{n}-{opt}.wasm"),
                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
            )
            .unwrap();
        }
    }
    std::fs::write("build/ir-loops/chains.json", format!("{:?}", chains)).unwrap();
}
#[test]
fn counter_branch_boundaries() {
    for op in 0xE0..=0xE3 {
        assert!(lift(&[op, 0], GuestEip(0), LinearAddress(0), true).is_ok());
        assert!(lift(&[op, 0, 0x90], GuestEip(0), LinearAddress(0), true).is_err());
        assert!(lift(&[0xF0, op, 0], GuestEip(0), LinearAddress(0), true).is_err());
    }
}
