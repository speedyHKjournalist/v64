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
fn bit_fixtures() {
    std::fs::create_dir_all("build/ir-bits").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for kind in 0..8 {
                for dst in if kind == 7 { (0..8).collect() } else { vec![0, 1, 2, 8, 9, 10] } {
                    for imm in if kind < 4 && matches!(dst, 0 | 8) {
                        vec![-1, 0, 7, 8, 15, 16, 31, 32, 255]
                    }
                    else {
                        vec![-1]
                    } {
                        let mut bytes = Vec::new();
                        if kind == 6 {
                            bytes.push(0xF3);
                        }
                        if mode == (width == 16) {
                            bytes.push(0x66);
                        }
                        if dst >= 8 && (dst != 9) != mode {
                            bytes.push(0x67);
                        }
                        if dst == 10 {
                            bytes.push(0x64);
                        }
                        bytes.push(0x0F);
                        bytes.push(if kind == 7 {
                            0xC8 + dst
                        }
                        else if imm >= 0 {
                            0xBA
                        }
                        else {
                            [0xA3, 0xAB, 0xB3, 0xBB, 0xBC, 0xBD, 0xB8][kind]
                        });
                        if kind != 7 {
                            bytes.push(
                                (if dst < 8 {
                                    0xC0 | dst
                                }
                                else if dst == 9 {
                                    4
                                }
                                else {
                                    6
                                }) | (if imm >= 0 { kind as u8 + 4 } else { 1 }) << 3,
                            );
                        }
                        if imm >= 0 {
                            bytes.push(imm as u8);
                        }
                        let mut r =
                            lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), mode)
                                .unwrap();
                        for opt in 0..2 {
                            if opt != 0 {
                                run(&mut r, PassConfig::default()).unwrap();
                            }
                            std::fs::write(
                                format!("build/ir-bits/{}-{opt}.wasm", cases.len()),
                                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                            )
                            .unwrap();
                        }
                        cases.push(format!("[{:?},{mode},{width},{kind},{dst},{imm}]", bytes));
                    }
                }
            }
        }
    }
    std::fs::write("build/ir-bits/cases.json", format!("[{}]", cases.join(","))).unwrap();
}

#[test]
fn bit_count_widths_folding_and_memory_access_contract() {
    use crate::ir::{
        backend::wasm::{emit, StateLayout},
        frontend::integer::IntegerBuilder,
        hir::{Op, Terminator},
        state::{ResumeKind, StateMap},
        types::Type,
        verify::verify,
    };
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    std::fs::create_dir_all("build/ir-bits").unwrap();
    let samples = [
        0,
        1,
        2,
        0x80000000,
        0x100000000,
        0x8000000000000000,
        u64::MAX,
    ];
    for sample in std::iter::once(None).chain(samples.into_iter().map(Some)) {
        let mut b = IntegerBuilder::new();
        let low =
            if let Some(value) = sample { b.constant(value as u32, Type::I32) } else { b.gpr[0] };
        let wide = if let Some(value) = sample {
            b.node(Op::Const(value), vec![], Type::I64)
        }
        else {
            let low = b.node(Op::Extend { signed: false }, vec![low], Type::I64);
            b.node(Op::Insert { lsb: 32 }, vec![low, b.gpr[1]], Type::I64)
        };
        for (width, value) in [low, wide].into_iter().enumerate() {
            for (index, op) in [
                Op::CountLeadingZeros,
                Op::CountTrailingZeros,
                Op::PopulationCount,
            ]
            .into_iter()
            .enumerate()
            {
                let ty = b.ty(value);
                let count = b.node(op, vec![value], ty);
                b.gpr[width * 3 + index] =
                    if width == 0 { count } else { b.node(Op::Truncate, vec![count], Type::I32) };
            }
        }
        let map = b.region.state(StateMap {
            instruction_pc: GuestEip(0x1000),
            next_pc: GuestEip(0x1001),
            next_value: None,
            resume: ResumeKind::AfterInstruction,
            gpr: b.gpr,
            flags: b.flags.clone(),
            xmm: vec![],
            x87: vec![],
            committed_instructions: 1,
            count_base: None,
            rep_progress: None,
        });
        b.region.terminate(b.block, Terminator::Exit(map));
        for opt in 0..2 {
            if opt != 0 {
                let stats = run(&mut b.region, PassConfig::default()).unwrap();
                if sample.is_some() {
                    assert!(stats.folded >= 6);
                }
            }
            std::fs::write(
                format!(
                    "build/ir-bits/count-{}-{opt}.wasm",
                    sample.map_or("input".into(), |v| v.to_string())
                ),
                emit(&lower(&b.region).unwrap(), layout, 100).unwrap().bytes,
            )
            .unwrap();
        }
        let id = b
            .region
            .instructions
            .iter()
            .position(|i| matches!(i.op, Op::ReadFlagOperand))
            .unwrap();
        let mut broken = b.region.clone();
        broken.instructions[id].op = Op::PopulationCount;
        assert!(verify(&broken).is_err(), "count needs a typed operand");
    }
    for (bytes, rmw) in [
        (vec![0x66, 0x0F, 0xA3, 0x0E], false),
        (vec![0x0F, 0xAB, 0x0E], true),
    ] {
        let r = lift_cpu(&bytes, GuestEip(0x1000), LinearAddress(0x1000), true).unwrap();
        assert_eq!(
            r.instructions
                .iter()
                .filter(|i| matches!(i.op, Op::GuestLoad { bytes: 1 }) && !rmw
                    || matches!(i.op, Op::RmwLoad { bytes: 1, .. }) && rmw)
                .count(),
            1
        );
        assert!(!r.instructions.iter().any(|i| matches!(
            i.op,
            Op::GuestLoad { bytes: 2 | 4 } | Op::RmwLoad { bytes: 2 | 4, .. }
        )));
    }
    let invalid = lift_cpu(&[0x0F, 0xB8, 0xC0], GuestEip(0), LinearAddress(0), true).unwrap();
    assert!(
        invalid.helpers.iter().any(|h| h.name == "ir_reserved_form"),
        "missing F3 must lower to explicit #UD, never POPCNT"
    );
}
