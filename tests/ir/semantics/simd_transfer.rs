use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
    simd::TransferOp,
    verify::verify,
};
fn emit_pair(bytes: &[u8], mode: bool, pc: u32, name: &str) {
    let mut r = lift_cpu(bytes, GuestEip(pc), LinearAddress(pc), mode).unwrap();
    for opt in 0..2 {
        if opt != 0 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-simd-transfer/{name}-{opt}.wasm"),
            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
        )
        .unwrap();
    }
}
#[test]
fn simd_transfer_fixtures() {
    std::fs::create_dir_all("build/ir-simd-transfer").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for asize in [16, 32] {
            for op in [
                0xf12u32,
                0x660f12u32,
                0xf16u32,
                0x660f16u32,
                0xf20f12u32,
                0xf30f12u32,
                0xf30f16u32,
                0xf13u32,
                0x660f13u32,
                0xf17u32,
                0x660f17u32,
                0x660f6eu32,
                0x660f7eu32,
                0xf30f7eu32,
                0x660fd6u32,
            ] {
                let store = matches!(
                    op,
                    0x0F13 | 0x660F13 | 0x0F17 | 0x660F17 | 0x660F7E | 0x660FD6
                );
                let width = if matches!(op, 0x660F6E | 0x660F7E) {
                    4
                }
                else if matches!(op, 0xF30F12 | 0xF30F16) {
                    16
                }
                else {
                    8
                };
                for register in 0..8 {
                    for operand in 0..15 {
                        if operand < 8
                            && matches!(
                                op,
                                0x660F12 | 0x660F16 | 0x0F13 | 0x660F13 | 0x0F17 | 0x660F17
                            )
                        {
                            continue;
                        }
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
                            bytes.extend(if asize == 32 { vec![0, 0, 0, 0] } else { vec![0, 0] });
                        }
                        emit_pair(&bytes, mode, 0x8000, &cases.len().to_string());
                        cases.push(format!("[{:?},{mode},{asize},{op},{width},{store},{register},{operand},{segment}]",bytes));
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-simd-transfer/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    let chain = [
        0x66, 0x0F, 0x6E, 0xC3, 0x0F, 0x12, 0xD1, 0x0F, 0x16, 0x16, 0xF3, 0x0F, 0x7E, 0xDA, 0xF3,
        0x0F, 0x12, 0xE2, 0x0F, 0x17, 0x27,
    ];
    emit_pair(&chain, true, 0x8000, "chain");
    emit_pair(&chain[10..], true, 0x800A, "resume");
    std::fs::write("build/ir-simd-transfer/chain.json", format!("{:?}", chain)).unwrap();
    let bridge = [0x66, 0x0F, 0x7E, 0xC0, 0x66, 0x0F, 0x6E, 0xC8];
    emit_pair(&bridge, true, 0x8000, "bridge");
    std::fs::write(
        "build/ir-simd-transfer/bridge.json",
        format!("{:?}", bridge),
    )
    .unwrap();
}
#[test]
fn simd_transfer_contracts() {
    for bytes in [
        vec![0x66, 0x0F, 0x12, 0xC0],
        vec![0x66, 0x0F, 0x16, 0xC0],
        vec![0x0F, 0x13, 0xC0],
        vec![0x0F, 0x17, 0xC0],
        vec![0xF0, 0x0F, 0x12, 0xC0],
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
    assert!(TransferOp::from_id(5).is_none());
    let mut r = lift_cpu(&[0x0F, 0x16, 0x06], GuestEip(0), LinearAddress(0), true).unwrap();
    let inst = r
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::XmmTransferLoad { .. }))
        .unwrap();
    inst.args[1] = r.states[inst.state.unwrap().index()].xmm[1];
    assert!(verify(&r)
        .unwrap_err()
        .0
        .contains("destination/state mismatch"));
    let mut r = lift_cpu(&[0x0F, 0x17, 0x06], GuestEip(0), LinearAddress(0), true).unwrap();
    let inst = r
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::XmmStore { .. }))
        .unwrap();
    if let Op::XmmStore { ref mut lane, .. } = inst.op {
        *lane = 2;
    }
    assert!(verify(&r).unwrap_err().0.contains("lane/width"));
}
