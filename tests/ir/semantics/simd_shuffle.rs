use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
    simd::ShuffleOp,
    verify::verify,
};
fn emit_pair(bytes: &[u8], mode: bool, pc: u32, name: &str) {
    let mut r = lift_cpu(bytes, GuestEip(pc), LinearAddress(pc), mode).unwrap();
    for opt in 0..2 {
        if opt == 1 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-simd-shuffle/{name}-{opt}.wasm"),
            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
        )
        .unwrap();
    }
}
#[test]
fn simd_shuffle_fixtures() {
    std::fs::create_dir_all("build/ir-simd-shuffle").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for asize in [16, 32] {
            for op in [0x660F70u32, 0xF20F70, 0xF30F70, 0x0FC6, 0x660FC6] {
                for register in 0..8u8 {
                    for operand in 0..15u8 {
                        for immediate in 0..=255u8 {
                            if !(register == 0 && [0, 1, 8].contains(&operand))
                                && ![0, 1, 0x1B, 0x4E, 0xE4, 0xFF].contains(&immediate)
                            {
                                continue;
                            }
                            let segment = if operand < 8 { -1 } else { operand as i32 - 9 };
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
                                register << 3
                                    | if operand < 8 {
                                        0xC0 | operand
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
                            bytes.push(immediate);
                            emit_pair(&bytes, mode, 0x8000, &cases.len().to_string());
                            cases.push(format!("[{:?},{mode},{asize},{op},16,false,{register},{operand},{segment},{immediate}]",bytes));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-simd-shuffle/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    let chain = [
        0x66, 0x0F, 0x70, 0xC1, 0x1B, 0xF3, 0x0F, 0x70, 0xC8, 0x4E, 0x0F, 0xC6, 0x16, 0xE4, 0xF2,
        0x0F, 0x70, 0xDA, 0x1B, 0x66, 0x0F, 0xC6, 0xD3, 3, 0x0F, 0x11, 0x17,
    ];
    emit_pair(&chain, true, 0x8000, "chain");
    emit_pair(&chain[14..], true, 0x800E, "resume");
    std::fs::write("build/ir-simd-shuffle/chain.json", format!("{:?}", chain)).unwrap();
}
#[test]
fn simd_shuffle_contracts() {
    let mut r = lift_cpu(
        &[0x0F, 0xC6, 0x06, 0xE4],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    let inst = r
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::XmmShuffle { .. }))
        .unwrap();
    inst.args[1] = r.states[inst.state.unwrap().index()].xmm[1];
    assert!(verify(&r)
        .unwrap_err()
        .0
        .contains("destination/state mismatch"));
    assert!(ShuffleOp::from_id(5).is_none());
    for bytes in [vec![0xF0, 0x66, 0x0F, 0x70, 0xC0, 0]] {
        assert!(lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
    }
    let mmx = lift_cpu(&[0x0F, 0x70, 0xC0, 0], GuestEip(0), LinearAddress(0), true).unwrap();
    assert!(mmx.helpers.iter().any(|h| h.name == "ir_mmx_reg_continue"));
}
