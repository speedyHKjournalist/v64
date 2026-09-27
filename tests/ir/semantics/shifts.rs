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
fn shift_fixtures() {
    std::fs::create_dir_all("build/ir-shifts").unwrap();
    let mut cases = Vec::new();
    for mode32 in [false, true] {
        for width in [8, 16, 32] {
            for group in 0..10u8 {
                if group >= 8 && width == 8 {
                    continue;
                }
                for dst in [0, 1, 4, 7, 8, 9] {
                    for count in [-2, -1, 0, 1, 8, 9, 16, 17, 31, 32, 255] {
                        if count == -2 && group >= 8 || count >= 0 && !matches!(dst, 0 | 8) {
                            continue;
                        }
                        let mut bytes = Vec::new();
                        if width != 8 && mode32 == (width == 16) {
                            bytes.push(0x66);
                        }
                        let address32 = dst != 9;
                        if dst >= 8 && address32 != mode32 {
                            bytes.push(0x67);
                        }
                        if group >= 8 {
                            bytes.extend([
                                0x0F,
                                (if group == 8 { 0xA4 } else { 0xAC }) + (count == -1) as u8,
                            ]);
                        }
                        else {
                            bytes.push(
                                (if count == -2 {
                                    0xD0
                                }
                                else if count == -1 {
                                    0xD2
                                }
                                else {
                                    0xC0
                                }) + (width != 8) as u8,
                            );
                        }
                        let field = if group >= 8 { 1 } else { group };
                        bytes.push(
                            (if dst < 8 {
                                0xC0 | dst
                            }
                            else if dst == 8 {
                                6
                            }
                            else {
                                4
                            }) | field << 3,
                        );
                        if count >= 0 {
                            bytes.push(count as u8);
                        }
                        let mut r =
                            lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), mode32)
                                .unwrap();
                        for opt in 0..2 {
                            if opt != 0 {
                                run(&mut r, PassConfig::default()).unwrap();
                            }
                            let artifact = emit_cpu(&lower(&r).unwrap(), 100).unwrap();
                            std::fs::write(
                                format!("build/ir-shifts/{}-{opt}.wasm", cases.len()),
                                artifact.bytes,
                            )
                            .unwrap();
                        }
                        cases.push(format!(
                            "[{:?},{mode32},{width},{group},{dst},{count}]",
                            bytes
                        ));
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-shifts/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    // Exiting to the interpreter must retain provenance even if AF was materialized.
    let mut prefixes = vec![
        vec![0x01, 0xD8],
        vec![0x29, 0xD8],
        vec![0x11, 0xD8],
        vec![0x19, 0xD8],
        vec![0x40],
        vec![0x48],
        vec![0xF7, 0xD8],
        vec![0x21, 0xD8],
    ];
    for bytes in prefixes.clone() {
        let mut word = vec![0x66];
        word.extend(bytes);
        prefixes.push(word);
    }
    prefixes.extend([
        vec![0x00, 0xD8],
        vec![0x28, 0xD8],
        vec![0x10, 0xD8],
        vec![0x18, 0xD8],
        vec![0xFE, 0xC0],
        vec![0xFE, 0xC8],
        vec![0xF6, 0xD8],
        vec![0x20, 0xD8],
        vec![0x00, 0xFC],
        vec![0x28, 0xFC],
        vec![0xFE, 0xC4],
        vec![0xF6, 0xDC],
    ]);
    for (id, bytes) in prefixes.iter().enumerate() {
        let mut r = lift_cpu(bytes, GuestEip(0x100000), LinearAddress(0x100000), true).unwrap();
        for opt in 0..2 {
            if opt != 0 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-shifts/chain-{id}-{opt}.wasm"),
                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
            )
            .unwrap();
        }
    }
    for (id, bytes) in prefixes.iter().enumerate() {
        let mut combined = bytes.clone();
        combined.extend([0xD3, 0xE2]);
        let mut r = lift_cpu(&combined, GuestEip(0x100000), LinearAddress(0x100000), true).unwrap();
        for opt in 0..2 {
            if opt != 0 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-shifts/combined-{id}-{opt}.wasm"),
                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
            )
            .unwrap();
        }
    }
    std::fs::write("build/ir-shifts/chains.json", format!("{:?}", prefixes)).unwrap();
    let mut r = lift(
        &[0xC1, 0xE0, 1],
        GuestEip(0x1000),
        LinearAddress(0x1000),
        true,
    )
    .unwrap();
    run(&mut r, PassConfig::default()).unwrap();
    std::fs::write(
        "build/ir-shifts/standalone.wasm",
        emit(
            &lower(&r).unwrap(),
            StateLayout {
                gpr: 0,
                flags: 32,
                eip: 36,
                committed: 40,
                flag_operand: 44,
            },
            100,
        )
        .unwrap()
        .bytes,
    )
    .unwrap();
}

#[test]
fn flag_provenance_types_and_layout_are_verified() {
    use crate::ir::verify::verify;
    let r = lift(&[0xD3, 0xE0], GuestEip(0x1000), LinearAddress(0x1000), true).unwrap();
    let mut broken = r.clone();
    broken.states[0].flags.last_op1 = Some(broken.states[0].flags.arithmetic[0]);
    assert!(verify(&broken).unwrap_err().0.contains("flag operand type"));
    let mut broken = r.clone();
    broken.states[0].flags.raw_zero = Some(broken.states[0].gpr[0]);
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("raw zero flag type"));
    let result = emit(
        &lower(&r).unwrap(),
        StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 32,
        },
        100,
    );
    assert!(matches!(
        result,
        Err(crate::ir::lowering::CompileError::Unsupported(
            "overlapping state layout"
        ))
    ));
}
