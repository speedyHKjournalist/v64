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
fn misc_fixtures() {
    std::fs::create_dir_all("build/ir-misc").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for op in [
            0x27u8, 0x2F, 0x37, 0x3F, 0x98, 0x99, 0x9E, 0x9F, 0xD4, 0xD5, 0xD6, 0xFC, 0xFD,
        ] {
            for width in if matches!(op, 0x98 | 0x99) { vec![16, 32] } else { vec![0] } {
                for imm in if matches!(op, 0xD4 | 0xD5) { (0..=255).collect() } else { vec![-1] } {
                    let mut bytes = Vec::new();
                    if width != 0 && mode == (width == 16) {
                        bytes.push(0x66);
                    }
                    bytes.push(op);
                    if imm >= 0 {
                        bytes.push(imm as u8);
                    }
                    let mut r = lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), mode)
                        .unwrap();
                    for opt in 0..2 {
                        if opt != 0 {
                            run(&mut r, PassConfig::default()).unwrap();
                        }
                        std::fs::write(
                            format!("build/ir-misc/{}-{opt}.wasm", cases.len()),
                            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                        )
                        .unwrap();
                    }
                    cases.push(format!("[{:?},{mode},{op},{width},{imm},0,3,0]", bytes));
                }
            }
        }
        for op in [0xA0u8, 0xA1, 0xA2, 0xA3, 0xD7] {
            for width in if matches!(op, 0xA0 | 0xA2 | 0xD7) { vec![8] } else { vec![16, 32] } {
                for address in [16, 32] {
                    for segment in [3, 4] {
                        for offset in if address == 32 {
                            vec![0u32, 0x40, 0xFFFF, 0xFFFFFFFF]
                        }
                        else {
                            vec![0u32, 0x40, 0xFFFF]
                        } {
                            let mut bytes = Vec::new();
                            if width != 8 && mode == (width == 16) {
                                bytes.push(0x66);
                            }
                            if mode != (address == 32) {
                                bytes.push(0x67);
                            }
                            if segment == 4 {
                                bytes.push(0x64);
                            }
                            bytes.push(op);
                            if op != 0xD7 {
                                bytes.extend(&offset.to_le_bytes()[..address / 8]);
                            }
                            let mut r =
                                lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), mode)
                                    .unwrap();
                            for opt in 0..2 {
                                if opt != 0 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                std::fs::write(
                                    format!("build/ir-misc/{}-{opt}.wasm", cases.len()),
                                    emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                                )
                                .unwrap();
                            }
                            cases.push(format!(
                                "[{:?},{mode},{op},{width},-1,{address},{segment},{offset}]",
                                bytes
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write("build/ir-misc/cases.json", format!("[{}]", cases.join(","))).unwrap();
    let programs = [
        vec![0x01, 0xD8, 0x27, 0x9F],
        vec![0x29, 0xD8, 0x2F, 0x9F],
        vec![0x14, 0xFF, 0x37, 0xD6],
        vec![0x1C, 0xFF, 0x3F, 0x9F],
        vec![0x04, 0xFF, 0xD5, 0x0A, 0x9F],
        vec![0x04, 0xFF, 0xD4, 0x0A, 0x9F],
        vec![0x40, 0xD4, 0],
        vec![0xFD, 0x9E, 0x9F, 0xFC],
        vec![0x98, 0x99],
    ];
    for (n, bytes) in programs.iter().enumerate() {
        let mut r = lift_cpu(bytes, GuestEip(0x100000), LinearAddress(0x100000), true).unwrap();
        for opt in 0..2 {
            if opt != 0 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-misc/chain-{n}-{opt}.wasm"),
                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
            )
            .unwrap();
        }
    }
    std::fs::write("build/ir-misc/chains.json", format!("{:?}", programs)).unwrap();
}
#[test]
fn misc_abi_contracts() {
    for bytes in [&[0xD4, 10][..], &[0xA0, 0, 0, 0, 0][..], &[0xD7][..]] {
        assert!(lift(bytes, GuestEip(0), LinearAddress(0), true).is_err());
        let r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert!(emit(
            &lower(&r).unwrap(),
            StateLayout {
                gpr: 0,
                flags: 32,
                eip: 36,
                committed: 40,
                flag_operand: 44
            },
            100
        )
        .is_err());
    }
    for bytes in [
        &[0x9E][..],
        &[0x9F][..],
        &[0x98, 0x99][..],
        &[0x27, 0x2F, 0x37, 0x3F][..],
        &[0xD5, 10, 0xD6, 0xFC, 0xFD][..],
    ] {
        let mut r = lift(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        run(&mut r, PassConfig::default()).unwrap();
        assert!(emit(
            &lower(&r).unwrap(),
            StateLayout {
                gpr: 0,
                flags: 32,
                eip: 36,
                committed: 40,
                flag_operand: 44
            },
            100
        )
        .is_ok());
    }
}
