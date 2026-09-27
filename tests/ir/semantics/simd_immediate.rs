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
#[test]
fn simd_immediate_fixtures() {
    std::fs::create_dir_all("build/ir-simd-immediate").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for asize in [16, 32] {
            for op in [0x660F71u32, 0x660F72, 0x660F73] {
                for group in if op == 0x660F73 { vec![2, 3, 6, 7] } else { vec![2, 4, 6] } {
                    for register in 0..8u8 {
                        for count in 0..=255u8 {
                            if register != 0
                                && ![
                                    0, 1, 7, 8, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 255,
                                ]
                                .contains(&count)
                            {
                                continue;
                            }
                            let mut bytes = vec![0x43];
                            if (asize == 32) != mode {
                                bytes.push(0x67);
                            }
                            bytes.extend([
                                0x66,
                                0x0F,
                                op as u8,
                                0xC0 | group << 3 | register,
                                count,
                            ]);
                            let mut r =
                                lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                    .unwrap();
                            for opt in 0..2 {
                                if opt == 1 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                std::fs::write(
                                    format!("build/ir-simd-immediate/{}-{opt}.wasm", cases.len()),
                                    emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                                )
                                .unwrap();
                            }
                            cases.push(format!("[{:?},{mode},{asize},{op},16,false,{register},{register},-1,{count},{group}]",bytes));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-simd-immediate/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    let chain = [
        0x66, 0x0F, 0x73, 0xF8, 3, 0x66, 0x0F, 0x61, 0xC1, 0x0F, 0x14, 0x16, 0x66, 0x0F, 0x71,
        0xE0, 17, 0x66, 0x0F, 0x6B, 0xD0, 0x0F, 0x11, 0x17,
    ];
    for (bytes, pc, name) in [
        (&chain[..], 0x8000, "chain"),
        (&chain[12..], 0x800C, "resume"),
    ] {
        let mut r = lift_cpu(bytes, GuestEip(pc), LinearAddress(pc), true).unwrap();
        for opt in 0..2 {
            if opt == 1 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-simd-immediate/{name}-{opt}.wasm"),
                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
            )
            .unwrap();
        }
    }
    std::fs::write("build/ir-simd-immediate/chain.json", format!("{:?}", chain)).unwrap();
}
#[test]
fn simd_immediate_contracts() {
    let mut r = lift_cpu(
        &[0x66, 0x0F, 0x73, 0xD8, 0],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    assert!(r.instructions.iter().any(|i| matches!(i.op, Op::SseCheck)));
    let inst = r
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::VectorShuffle(_)))
        .unwrap();
    inst.op = Op::VectorShuffle([32; 16]);
    assert!(verify(&r).unwrap_err().0.contains("vector shuffle"));
    for bytes in [
        vec![0x66, 0x0F, 0x71, 0x10, 1],
        vec![0xF0, 0x66, 0x0F, 0x71, 0xD0, 1],
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
    let mmx = lift_cpu(&[0x0F, 0x71, 0xD0, 1], GuestEip(0), LinearAddress(0), true).unwrap();
    assert!(mmx.helpers.iter().any(|h| h.name == "ir_mmx_reg_continue"));
    let mut r = lift_cpu(
        &[0x66, 0x0F, 0xFC, 0x06],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    let inst = r
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::XmmBinary { .. }))
        .unwrap();
    if let Op::XmmBinary { ref mut bytes, .. } = inst.op {
        *bytes = 8;
    }
    assert!(verify(&r).unwrap_err().0.contains("read width"));
}
