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
        if opt == 1 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-simd-masked/{name}-{opt}.wasm"),
            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
        )
        .unwrap();
    }
}
#[test]
fn simd_masked_fixtures() {
    std::fs::create_dir_all("build/ir-simd-masked").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for asize in [16, 32] {
            for source in 0..8 {
                for mask in 0..8 {
                    for segment in -1..6 {
                        let mut bytes = vec![0x43];
                        if (asize == 32) != mode {
                            bytes.push(0x67);
                        }
                        if segment >= 0 {
                            bytes.push([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][segment as usize]);
                        }
                        bytes.extend([0x66, 0x0F, 0xF7, 0xC0 | source << 3 | mask]);
                        emit_pair(&bytes, mode, 0x8000, &cases.len().to_string());
                        cases.push(format!(
                            "[{:?},{mode},{asize},6688759,16,true,{source},{},{segment},{mask}]",
                            bytes,
                            segment + 9
                        ));
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-simd-masked/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    let chain = [
        0x66, 0x0F, 0xEF, 0xC0, 0x66, 0x0F, 0xC4, 0xC3, 0x02, 0x66, 0x0F, 0xF7, 0xC1,
    ];
    emit_pair(&chain, true, 0x8000, "chain");
    std::fs::write("build/ir-simd-masked/chain.json", format!("{:?}", chain)).unwrap();
    // An explicit next region consumes the CPU state committed by the first store.
    emit_pair(&[0x66, 0x0F, 0xD7, 0xD0], true, 0x800D, "resume");
}
#[test]
fn simd_masked_contracts() {
    for bytes in [
        vec![0x66, 0x0F, 0xF7, 0x00],
        vec![0xF0, 0x66, 0x0F, 0xF7, 0xC0],
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
    let mmx = lift_cpu(&[0x0F, 0xF7, 0xC0], GuestEip(0), LinearAddress(0), true).unwrap();
    assert!(mmx.helpers.iter().any(|h| h.name == "ir_mmx_mask"));
    let valid = lift_cpu(
        &[0x66, 0x0F, 0xF7, 0xC1],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    for mutation in 0..4 {
        let mut r = valid.clone();
        let inst = r
            .instructions
            .iter_mut()
            .find(|i| matches!(i.op, Op::XmmMaskedStore { .. }))
            .unwrap();
        match mutation {
            0 => inst.args[2] = inst.args[1],
            1 => {
                if let Op::XmmMaskedStore { ref mut source, .. } = inst.op {
                    *source = 8;
                }
            },
            2 => inst.commit = None,
            3 => {
                r.states[inst.commit.unwrap().index()].committed_instructions += 1;
            },
            _ => unreachable!(),
        }
        assert!(verify(&r).is_err());
    }
}
