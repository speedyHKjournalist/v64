use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
    verify::verify,
};
#[test]
fn segment_fixtures() {
    std::fs::create_dir_all("build/ir-segments").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for op in [0x8Cu32, 0x8E, 0xC4, 0xC5, 0x0FB2, 0x0FB4, 0x0FB5] {
                let regs: Vec<u8> = if op == 0x8C {
                    (0..6).collect()
                }
                else if op == 0x8E {
                    vec![0, 2, 3, 4, 5]
                }
                else {
                    (0..8).collect()
                };
                for reg in regs {
                    for operand in if matches!(op, 0x8C | 0x8E) {
                        (0u8..12).collect::<Vec<_>>()
                    }
                    else {
                        (8u8..12).collect()
                    } {
                        let mut bytes = vec![0x40];
                        if mode == (width == 16) {
                            bytes.push(0x66);
                        }
                        if operand >= 8 && mode != (operand != 10) {
                            bytes.push(0x67);
                        }
                        if operand == 11 {
                            bytes.push(0x64);
                        }
                        if op > 255 {
                            bytes.push(0x0F);
                        }
                        bytes.push(op as u8);
                        bytes.push(
                            reg << 3
                                | if operand < 8 {
                                    0xC0 | operand
                                }
                                else {
                                    match operand {
                                        8 | 11 => 6,
                                        9 => 4,
                                        10 => 2,
                                        _ => unreachable!(),
                                    }
                                },
                        );
                        if operand == 9 {
                            bytes.push(0x24);
                        }
                        if op == 0x8C {
                            bytes.push(0x43);
                        }
                        let mut r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                            .unwrap();
                        for opt in 0..2 {
                            if opt != 0 {
                                run(&mut r, PassConfig::default()).unwrap();
                            }
                            std::fs::write(
                                format!("build/ir-segments/{}-{opt}.wasm", cases.len()),
                                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                            )
                            .unwrap();
                        }
                        cases.push(format!("[{:?},{mode},{width},{op},{reg},{operand}]", bytes));
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-segments/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn segment_access_and_invalid_forms() {
    for bytes in [&[0x8C, 0xF0][..], &[0x8E, 0xC8][..], &[0x8E, 0xF0][..]] {
        assert!(lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).is_err());
    }
    for bytes in [&[0xC4, 0xC0][..], &[0x0F, 0xB2, 0xC0][..]] {
        let r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert_eq!(r.helpers[0].name, "ir_far_control_ud");
    }
    for bytes in [&[0x8C, 0xD8][..], &[0x8E, 0xD8][..], &[0xC5, 0x06][..]] {
        assert!(lift(bytes, GuestEip(0), LinearAddress(0), true).is_err());
    }
    let r = lift_cpu(&[0xC5, 0x06], GuestEip(0), LinearAddress(0), true).unwrap();
    let widths: Vec<_> = r
        .instructions
        .iter()
        .filter_map(|i| {
            if let Op::GuestLoad { bytes } = i.op {
                Some(bytes)
            }
            else {
                None
            }
        })
        .collect();
    assert_eq!(widths, vec![4, 2]);
    assert_eq!(
        r.instructions
            .iter()
            .filter(|i| matches!(i.op, Op::SegmentAddress { .. }))
            .count(),
        1
    );
    let mut broken = r.clone();
    let offset = broken
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::LinearOffset))
        .unwrap();
    offset.args.swap(0, 1);
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("linear offset types"));
    for prefix in [vec![], vec![0x66]] {
        let mut bytes = prefix;
        bytes.extend([0x8C, 0x06]);
        let r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert!(r
            .instructions
            .iter()
            .any(|i| matches!(i.op, Op::GuestStore { bytes: 2 })));
    }
}

#[test]
fn real_segment_continuation_fixtures() {
    std::fs::create_dir_all("build/ir-segments").unwrap();
    for segment in [0u8, 2, 3, 4, 5] {
        // Dirty ECX; MOV segment,AX; MOV EBX,segment:[400h]; INC EBX.
        let prefix = [0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][segment as usize];
        let bytes = [
            0x41,
            0x8E,
            0xC0 | segment << 3,
            prefix,
            0x8B,
            0x1D,
            0,
            4,
            0,
            0,
            0x43,
        ];
        let mut r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), true).unwrap();
        for opt in 0..2 {
            if opt == 1 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-segments/continue-{segment}-{opt}.wasm"),
                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
            )
            .unwrap();
        }
    }
}
