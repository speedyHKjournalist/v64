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
fn multiply_divide_fixtures() {
    std::fs::create_dir_all("build/ir-multiply").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [8, 16, 32] {
            for kind in 4..11 {
                if kind >= 8 && width == 8 {
                    continue;
                }
                for src in 0..10 {
                    for dst in if kind < 8 { vec![0] } else { vec![0, 1, 2] } {
                        let mut bytes = Vec::new();
                        if width != 8 && mode == (width == 16) {
                            bytes.push(0x66);
                        }
                        if src >= 8 && (src == 8) != mode {
                            bytes.push(0x67);
                        }
                        if kind == 8 {
                            bytes.extend([0x0F, 0xAF]);
                        }
                        else {
                            bytes.push(if kind < 8 {
                                if width == 8 {
                                    0xF6
                                }
                                else {
                                    0xF7
                                }
                            }
                            else if kind == 9 {
                                0x69
                            }
                            else {
                                0x6B
                            });
                        }
                        bytes.push(
                            (if src < 8 {
                                0xC0 | src
                            }
                            else if src == 8 {
                                6
                            }
                            else {
                                4
                            }) | if kind < 8 { kind << 3 } else { dst << 3 },
                        );
                        if kind == 9 {
                            bytes.extend(&0x89ABCDEFu32.to_le_bytes()[..width / 8]);
                        }
                        if kind == 10 {
                            bytes.push(0x80);
                        }
                        let mut r =
                            lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), mode)
                                .unwrap();
                        for opt in 0..2 {
                            if opt != 0 {
                                run(&mut r, PassConfig::default()).unwrap();
                            }
                            std::fs::write(
                                format!("build/ir-multiply/{}-{opt}.wasm", cases.len()),
                                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                            )
                            .unwrap();
                        }
                        cases.push(format!("[{:?},{mode},{width},{kind},{src},{dst}]", bytes));
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-multiply/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn wide_cfg_and_helper_abi() {
    use crate::ir::{
        backend::wasm::{emit, StateLayout},
        effects::Effects,
        frontend::integer::IntegerBuilder,
        helper::{ExceptionOwner, HelperAbi, HelperDescriptor},
        hir::{Binary, Edge, Op, Terminator},
        ids::HelperId,
        types::Type,
    };
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    std::fs::create_dir_all("build/ir-multiply").unwrap();
    // All entry registers are captured before a loop with cyclic i64 phi copies.
    let mut b = IntegerBuilder::new();
    let x = b.node(Op::Extend { signed: false }, vec![b.gpr[0]], Type::I64);
    let x = b.node(Op::Insert { lsb: 32 }, vec![x, b.gpr[1]], Type::I64);
    let y = b.node(Op::Extend { signed: false }, vec![b.gpr[2]], Type::I64);
    let y = b.node(Op::Insert { lsb: 32 }, vec![y, b.gpr[3]], Type::I64);
    let entry = b.block;
    let h = b.region.block(false);
    let out = b.region.block(false);
    let hx = b.region.param(h, Type::I64);
    let hy = b.region.param(h, Type::I64);
    let n = b.region.param(h, Type::I32);
    b.region.terminate(
        entry,
        Terminator::Branch(Edge {
            target: h,
            args: vec![x, y, b.gpr[4]],
        }),
    );
    let map = b.region.state(crate::ir::state::StateMap {
        instruction_pc: GuestEip(0x1000),
        next_pc: GuestEip(0x1001),
        next_value: None,
        resume: crate::ir::state::ResumeKind::AfterInstruction,
        gpr: b.gpr,
        flags: b.flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 1,
        count_base: None,
        rep_progress: None,
    });
    b.region.blocks[h.index()].entry_state = Some(map);
    b.region.blocks[out.index()].entry_state = Some(map);
    b.block = h;
    let zero = b.constant(0, Type::I32);
    let one = b.constant(1, Type::I32);
    let done = b.binary(Binary::Eq, n, zero);
    let next = b.binary(Binary::Sub, n, one);
    b.region.terminate(
        h,
        Terminator::CondBranch {
            condition: done,
            taken: Edge {
                target: out,
                args: vec![],
            },
            not_taken: Edge {
                target: h,
                args: vec![hy, hx, next],
            },
        },
    );
    b.block = out;
    let sum = b.binary(Binary::Add, hx, hy);
    let product = b.binary(Binary::Mul, hx, hy);
    let difference = b.binary(Binary::Sub, hx, hy);
    for (r, value) in [hx, sum, product, difference].into_iter().enumerate() {
        b.gpr[r * 2] = b.extract(value, 0, Type::I32);
        b.gpr[r * 2 + 1] = b.extract(value, 32, Type::I32);
    }
    let mut final_state = b.region.states[map.index()].clone();
    final_state.gpr = b.gpr;
    let final_map = b.region.state(final_state);
    b.region.terminate(out, Terminator::Exit(final_map));
    for opt in 0..2 {
        if opt != 0 {
            run(&mut b.region, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-multiply/wide-loop-{opt}.wasm"),
            emit(&lower(&b.region).unwrap(), layout, 100).unwrap().bytes,
        )
        .unwrap();
    }
    let mut b = IntegerBuilder::new();
    let x = b.node(Op::Extend { signed: false }, vec![b.gpr[0]], Type::I64);
    let x = b.node(Op::Insert { lsb: 32 }, vec![x, b.gpr[1]], Type::I64);
    let y = b.node(Op::Extend { signed: true }, vec![b.gpr[2]], Type::I64);
    let map = b.region.state(crate::ir::state::StateMap {
        instruction_pc: GuestEip(0x1000),
        next_pc: GuestEip(0x1001),
        next_value: None,
        resume: crate::ir::state::ResumeKind::BeforeInstruction,
        gpr: b.gpr,
        flags: b.flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 0,
        count_base: None,
        rep_progress: None,
    });
    b.region.helpers.push(HelperDescriptor {
        name: "wide_operation".into(),
        params: vec![Type::I64, Type::I64],
        results: vec![Type::I64, Type::I32, Type::I64],
        effects: Effects::pure(),
        exception_owner: ExceptionOwner::CannotFault,
        abi: HelperAbi::Outcome {
            fault_delivery: None,
            normal_preserves_state: true,
        },
    });
    let values = b.region.append(
        b.block,
        Op::CallHelper(HelperId(0)),
        vec![x, y, b.effect],
        &[Type::I64, Type::I32, Type::I64, Type::Effect],
        Some(map),
    );
    b.gpr[0] = b.extract(values[0], 0, Type::I32);
    b.gpr[1] = b.extract(values[0], 32, Type::I32);
    b.gpr[2] = values[1];
    b.gpr[3] = b.extract(values[2], 0, Type::I32);
    b.gpr[4] = b.extract(values[2], 32, Type::I32);
    let mut final_state = b.region.states[map.index()].clone();
    final_state.gpr = b.gpr;
    final_state.resume = crate::ir::state::ResumeKind::AfterInstruction;
    let final_map = b.region.state(final_state);
    b.region.terminate(b.block, Terminator::Exit(final_map));
    for opt in 0..2 {
        if opt != 0 {
            run(&mut b.region, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-multiply/wide-helper-{opt}.wasm"),
            emit(&lower(&b.region).unwrap(), layout, 100).unwrap().bytes,
        )
        .unwrap();
    }
}

#[test]
fn division_contract_and_completed_prefix() {
    use crate::ir::{hir::Op, state::ResumeKind, verify::verify};
    let r = lift_cpu(
        &[0x45, 0xF7, 0xF9],
        GuestEip(0x100000),
        LinearAddress(0x100000),
        true,
    )
    .unwrap();
    let id = r
        .instructions
        .iter()
        .position(|i| matches!(i.op, Op::Divide { .. }))
        .unwrap();
    let mut broken = r.clone();
    broken.instructions[id].op = Op::Divide {
        bits: 64,
        signed: true,
    };
    assert!(verify(&broken).unwrap_err().0.contains("divide types"));
    let mut broken = r.clone();
    let map = broken.instructions[id].state.unwrap();
    broken.states[map.index()].resume = ResumeKind::AfterInstruction;
    assert!(lower(&broken).is_err());
    let mut r = r;
    for opt in 0..2 {
        if opt != 0 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        std::fs::create_dir_all("build/ir-multiply").unwrap();
        std::fs::write(
            format!("build/ir-multiply/prelude-{opt}.wasm"),
            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
        )
        .unwrap();
    }
}
