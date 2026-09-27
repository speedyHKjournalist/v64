use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn exchange_fixtures() {
    std::fs::create_dir_all("build/ir-exchange").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [8, 16, 32] {
            for kind in 0..3 {
                for source in 0..8 {
                    for target in 0..11 {
                        for lock in if target >= 8 { vec![false, true] } else { vec![false] } {
                            let mut bytes = Vec::new();
                            if lock {
                                bytes.push(0xF0);
                            }
                            if width != 8 && mode == (width == 16) {
                                bytes.push(0x66);
                            }
                            if target >= 8 && (target != 9) != mode {
                                bytes.push(0x67);
                            }
                            if target == 10 {
                                bytes.push(0x64);
                            }
                            if kind != 0 {
                                bytes.push(0x0F);
                            }
                            bytes.push(
                                (if kind == 0 {
                                    0x86
                                }
                                else if kind == 1 {
                                    0xC0
                                }
                                else {
                                    0xB0
                                }) + (width != 8) as u8,
                            );
                            bytes.push(
                                (if target < 8 {
                                    0xC0 | target
                                }
                                else if target == 9 {
                                    4
                                }
                                else {
                                    6
                                }) | source << 3,
                            );
                            let mut r =
                                lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), mode)
                                    .unwrap();
                            for opt in 0..2 {
                                if opt != 0 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                std::fs::write(
                                    format!("build/ir-exchange/{}-{opt}.wasm", cases.len()),
                                    emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                                )
                                .unwrap();
                            }
                            cases.push(format!(
                                "[{:?},{mode},{width},{kind},{source},{target},{lock}]",
                                bytes
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-exchange/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    // Reuse the earlier exact memory and bit corpora to exercise every newly
    // accepted LOCK family, while preserving their separate runtime oracles.
    let families = [
        vec![0x01, 0x1E],
        vec![0x09, 0x1E],
        vec![0x11, 0x1E],
        vec![0x19, 0x1E],
        vec![0x21, 0x1E],
        vec![0x29, 0x1E],
        vec![0x31, 0x1E],
        vec![0x83, 0x06, 0xFF],
        vec![0x83, 0x0E, 0xFF],
        vec![0x83, 0x16, 0xFF],
        vec![0x83, 0x1E, 0xFF],
        vec![0x83, 0x26, 0xFF],
        vec![0x83, 0x2E, 0xFF],
        vec![0x83, 0x36, 0xFF],
        vec![0xFF, 0x06],
        vec![0xFF, 0x0E],
        vec![0xF7, 0x16],
        vec![0xF7, 0x1E],
        vec![0x0F, 0xAB, 0x0E],
        vec![0x0F, 0xB3, 0x0E],
        vec![0x0F, 0xBB, 0x0E],
        vec![0x0F, 0xBA, 0x2E, 7],
        vec![0x0F, 0xBA, 0x36, 7],
        vec![0x0F, 0xBA, 0x3E, 7],
    ];
    let mut forms = Vec::new();
    for bytes in families {
        let mut bytes = bytes;
        bytes.insert(0, 0xF0);
        let mut r = lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), true).unwrap();
        for opt in 0..2 {
            if opt != 0 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-exchange/locked-{}-{opt}.wasm", forms.len()),
                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
            )
            .unwrap();
        }
        forms.push(bytes);
    }
    std::fs::write("build/ir-exchange/locked.json", format!("{:?}", forms)).unwrap();
}
#[test]
fn locked_pairs_and_illegal_forms_are_verified() {
    use crate::ir::{
        hir::{Op, RmwOrder},
        verify::verify,
    };
    for bytes in [
        &[0xF0, 0x01, 0x1E][..],
        &[0x87, 0x1E][..],
        &[0xF0, 0x0F, 0xB1, 0x1E][..],
    ] {
        let r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert_eq!(
            r.instructions
                .iter()
                .filter(|i| matches!(
                    i.op,
                    Op::RmwLoad {
                        order: RmwOrder::Locked,
                        ..
                    } | Op::RmwStore {
                        order: RmwOrder::Locked,
                        ..
                    }
                ))
                .count(),
            2
        );
        let mut broken = r.clone();
        let store = broken
            .instructions
            .iter_mut()
            .find(|i| matches!(i.op, Op::RmwStore { .. }))
            .unwrap();
        let Op::RmwStore { order, .. } = &mut store.op
        else {
            unreachable!()
        };
        *order = RmwOrder::Plain;
        assert!(verify(&broken).unwrap_err().0.contains("order"));
    }
    for bytes in [
        &[0xF0, 0x01, 0xD8][..],
        &[0xF0, 0x89, 0x1E][..],
        &[0xF0, 0x39, 0x1E][..],
        &[0xF0, 0xD1, 0x26][..],
        &[0xF0, 0x0F, 0xA3, 0x0E][..],
    ] {
        assert!(lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).is_err());
    }
}
