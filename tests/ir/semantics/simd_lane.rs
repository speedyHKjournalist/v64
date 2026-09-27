use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
    verify::verify,
};
fn emit_pair(bytes: &[u8], mode: bool, pc: u32, name: &str) {
    let mut r = lift_cpu(bytes, GuestEip(pc), LinearAddress(pc), mode).unwrap();
    for opt in 0..2 {
        if opt != 0 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-simd-lane/{name}-{opt}.wasm"),
            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
        )
        .unwrap();
    }
}
#[test]
fn simd_lane_fixtures() {
    std::fs::create_dir_all("build/ir-simd-lane").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for asize in [16, 32] {
            for op in [
                0x0F50u32, 0x660F50, 0x660FD7, 0x660FC4, 0x660FC5, 0x0F2B, 0x660F2B, 0x660FE7,
                0xF20FF0,
            ] {
                let store = matches!(op, 0x0F2B | 0x660F2B | 0x660FE7);
                let width = if matches!(op, 0x660FC4 | 0x660FC5) { 2 } else { 16 };
                for register in 0..8 {
                    for operand in 0..15 {
                        if operand < 8 && (store || op == 0xF20FF0)
                            || operand >= 8 && matches!(op, 0x0F50 | 0x660F50 | 0x660FD7 | 0x660FC5)
                        {
                            continue;
                        }
                        let immediates: Vec<u8> = if matches!(op, 0x660FC4 | 0x660FC5) {
                            if register == 0 && [0, 1, 8].contains(&operand) {
                                (0..=255).collect()
                            }
                            else {
                                vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 255]
                            }
                        }
                        else {
                            vec![0]
                        };
                        for immediate in immediates {
                            let segment = if operand < 8 { -1 } else { operand - 9 };
                            let mut bytes = vec![0x43];
                            if (asize == 32) != mode {
                                bytes.push(0x67);
                            }
                            if segment >= 0 {
                                bytes.push([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][segment as usize]);
                            }
                            if op > 65535 {
                                bytes.push((op >> 16) as u8);
                            }
                            bytes.extend([
                                0x0F,
                                op as u8,
                                (register << 3)
                                    | if operand < 8 {
                                        0xC0 | operand as u8
                                    }
                                    else if asize == 32 {
                                        0x86
                                    }
                                    else {
                                        0x85
                                    },
                            ]);
                            if operand >= 8 {
                                bytes.extend(if asize == 32 {
                                    vec![0, 0, 0, 0]
                                }
                                else {
                                    vec![0, 0]
                                });
                            }
                            if matches!(op, 0x660FC4 | 0x660FC5) {
                                bytes.push(immediate);
                            }
                            emit_pair(&bytes, mode, 0x8000, &cases.len().to_string());
                            cases.push(format!("[{:?},{mode},{asize},{op},{width},{store},{register},{operand},{segment},{immediate}]",bytes));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-simd-lane/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    let chain = [
        0x66, 0x0F, 0xC4, 0xC3, 0xFF, 0x66, 0x0F, 0xC4, 0x06, 0x02, 0x66, 0x0F, 0xC5, 0xC8, 0x02,
        0x66, 0x0F, 0xD7, 0xD0, 0x66, 0x0F, 0xE7, 0x07,
    ];
    emit_pair(&chain, true, 0x8000, "chain");
    emit_pair(&chain[10..], true, 0x800A, "resume");
    std::fs::write("build/ir-simd-lane/chain.json", format!("{:?}", chain)).unwrap();
}
#[test]
fn simd_lane_contracts() {
    for bytes in [
        vec![0x0F, 0x50, 0x00],
        vec![0x66, 0x0F, 0xC5, 0x00, 0],
        vec![0x66, 0x0F, 0xD7, 0x00],
        vec![0x0F, 0x2B, 0xC0],
        vec![0x66, 0x0F, 0xE7, 0xC0],
        vec![0xF2, 0x0F, 0xF0, 0xC0],
        vec![0xF0, 0x66, 0x0F, 0xC4, 0xC0, 0],
    ] {
        let result = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true);
        if bytes[0] == 0xF0 {
            assert!(result.is_err());
        }
        else {
            assert!(result
                .unwrap()
                .helpers
                .iter()
                .any(|h| h.name == "ir_invalid_form"));
        }
    }
    let mmx = lift_cpu(&[0x0F, 0xC4, 0xC0, 0], GuestEip(0), LinearAddress(0), true).unwrap();
    assert!(mmx.helpers.iter().any(|h| h.name == "ir_mmx_reg_continue"));
    for (bytes, kind) in [
        (&[0x66, 0x0F, 0xC4, 0x00, 0][..], 0),
        (&[0x66, 0x0F, 0xC4, 0xC0, 0][..], 1),
        (&[0x66, 0x0F, 0xC5, 0xC0, 0][..], 2),
        (&[0x66, 0x0F, 0xD7, 0xC0][..], 3),
    ] {
        let mut r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        let inst = r
            .instructions
            .iter_mut()
            .find(|i| {
                matches!(
                    i.op,
                    Op::XmmInsertWord { .. }
                        | Op::VectorReplace { .. }
                        | Op::VectorExtract { .. }
                        | Op::VectorBitmask { .. }
                )
            })
            .unwrap();
        match &mut inst.op {
            Op::XmmInsertWord { lane, .. }
            | Op::VectorReplace { lane, .. }
            | Op::VectorExtract { lane, .. } => *lane = 8,
            Op::VectorBitmask { bits } => *bits = 16,
            _ => unreachable!(),
        }
        assert!(verify(&r).is_err(), "invalid lane/bits {kind}");
    }
    let mut r = lift_cpu(
        &[0x66, 0x0F, 0xC4, 0x00, 0],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    let inst = r
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::XmmInsertWord { .. }))
        .unwrap();
    inst.args[1] = r.states[inst.state.unwrap().index()].xmm[1];
    assert!(verify(&r)
        .unwrap_err()
        .0
        .contains("destination/state mismatch"));
}
