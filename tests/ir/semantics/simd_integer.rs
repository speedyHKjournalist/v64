use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
    simd::PackedOp,
    verify::verify,
};
fn emit_pair(bytes: &[u8], mode: bool, pc: u32, name: &str) {
    let mut r = lift_cpu(bytes, GuestEip(pc), LinearAddress(pc), mode).unwrap();
    for opt in 0..2 {
        if opt != 0 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        let mut mir = lower(&r).unwrap();
        if opt != 0 {
            mir.elide_redundant_cpu_state_writes(crate::ir::mir::state_elision::DEFAULT_WORK_LIMIT)
                .unwrap();
        }
        std::fs::write(
            format!("build/ir-simd-integer/{name}-{opt}.wasm"),
            emit_cpu(&mir, 100).unwrap().bytes,
        )
        .unwrap();
    }
}
#[test]
fn simd_integer_fixtures() {
    std::fs::create_dir_all("build/ir-simd-integer").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for asize in [16, 32] {
            for op in [
                0x660F60u32,
                0x660F61u32,
                0x660F62u32,
                0x660F68u32,
                0x660F69u32,
                0x660F6Au32,
                0x660F6Cu32,
                0x660F6Du32,
                0x660F63u32,
                0x660F67u32,
                0x660F6Bu32,
                0x660FD1u32,
                0x660FD2u32,
                0x660FD3u32,
                0x660FE1u32,
                0x660FE2u32,
                0x660FF1u32,
                0x660FF2u32,
                0x660FF3u32,
                0xF14u32,
                0xF15u32,
                0x660F14u32,
                0x660F15u32,
                0x660ffcu32,
                0x660ffdu32,
                0x660ffeu32,
                0x660fd4u32,
                0x660ff8u32,
                0x660ff9u32,
                0x660ffau32,
                0x660ffbu32,
                0x660fecu32,
                0x660fedu32,
                0x660fdcu32,
                0x660fddu32,
                0x660fe8u32,
                0x660fe9u32,
                0x660fd8u32,
                0x660fd9u32,
                0x660f64u32,
                0x660f65u32,
                0x660f66u32,
                0x660f74u32,
                0x660f75u32,
                0x660f76u32,
                0x660fdau32,
                0x660fdeu32,
                0x660feau32,
                0x660feeu32,
                0x660fe0u32,
                0x660fe3u32,
                0x660fe4u32,
                0x660fe5u32,
                0x660ff4u32,
                0x660ff6u32,
                0x660fd5u32,
                0x660ff5u32,
                0x660fdbu32,
                0x660fdfu32,
                0x660febu32,
                0x660fefu32,
                0xf54u32,
                0xf55u32,
                0xf56u32,
                0xf57u32,
                0x660f54u32,
                0x660f55u32,
                0x660f56u32,
                0x660f57u32,
            ] {
                let store = false;
                let width = if matches!(op, 0x0F14 | 0x660F14) { 8 } else { 16 };
                for register in 0..8 {
                    for operand in 0..15 {
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
        "build/ir-simd-integer/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn simd_integer_chains() {
    std::fs::create_dir_all("build/ir-simd-integer").unwrap();
    let bytes = [
        0x66, 0x0F, 0xEF, 0xC0, 0x66, 0x0F, 0xFC, 0xC1, 0x66, 0x0F, 0xF5, 0x0E, 0x66, 0x0F, 0xF5,
        0xD1, 0x66, 0x0F, 0xEB, 0xD0, 0x0F, 0x11, 0x17,
    ];
    emit_pair(&bytes, true, 0x8000, "chain");
    emit_pair(&bytes[12..], true, 0x800C, "resume");
    std::fs::write("build/ir-simd-integer/chain.json", format!("{:?}", bytes)).unwrap();
}

#[test]
fn simd_integer_contracts() {
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
    inst.args[1] = r.states[inst.state.unwrap().index()].xmm[1];
    assert!(verify(&r)
        .unwrap_err()
        .0
        .contains("destination/state mismatch"));
    assert!(PackedOp::from_id(0x1FC).is_none());
    assert!(
        PackedOp::from_encoding(0x0FFC).is_none(),
        "MMX is a distinct state model"
    );
    assert!(lift_cpu(
        &[0xF0, 0x66, 0x0F, 0xFC, 0xC0],
        GuestEip(0),
        LinearAddress(0),
        true
    )
    .is_err());
}
