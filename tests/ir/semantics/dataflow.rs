use crate::ir::{
    backend::wasm::{emit, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress},
        integer::IntegerBuilder,
        region::lift_cpu_cfg,
    },
    hir::*,
    ids::*,
    lowering::lower,
    passes::{run, PassConfig},
    state::{FlagState, ResumeKind, StateMap},
    types::Type,
    verify::verify,
};
fn config() -> PassConfig {
    PassConfig {
        debug: Default::default(),
        disabled: 0,
        prune: false,
        merge: false,
        phis: false,
        copy: false,
        flags: false,
        state_sync: false,
        helper_state: false,
        fold: false,
        gvn: true,
        dce: false,
        rounds: 1,
    }
}
fn snapshot(r: &mut Region, gpr: [ValueId; 8], flags: &FlagState, pc: u32) -> StateId {
    r.state(StateMap {
        instruction_pc: GuestEip(pc),
        next_pc: GuestEip(pc + 1),
        next_value: None,
        resume: ResumeKind::BeforeInstruction,
        gpr,
        flags: flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 0,
        count_base: None,
        rep_progress: None,
    })
}
fn diamond() -> Region {
    let mut b = IntegerBuilder::new();
    let input = b.gpr;
    let flags = b.flags.clone();
    let entry = b.block;
    // Deliberately allocate the join before its dominators.
    let join = b.region.block(false);
    let left = b.region.block(false);
    let right = b.region.block(false);
    let je = b.region.param(join, Type::Effect);
    let incoming = b.region.param(join, Type::I32);
    let le = b.region.param(left, Type::Effect);
    let re = b.region.param(right, Type::Effect);
    for block in [join, left, right] {
        let s = snapshot(&mut b.region, input, &flags, 0x8000 + block.0);
        b.region.blocks[block.index()].entry_state = Some(s);
    }
    b.binary(Binary::Add, input[0], input[1]);
    let a = b.node(Op::Extend { signed: false }, vec![input[0]], Type::I64);
    let c = b.node(Op::Extend { signed: false }, vec![input[1]], Type::I64);
    b.binary(Binary::Add, a, c);
    let zero = b.constant(0, Type::I32);
    let condition = b.binary(Binary::Eq, input[7], zero);
    b.region.terminate(
        entry,
        Terminator::CondBranch {
            condition,
            taken: Edge {
                target: left,
                args: vec![b.effect],
            },
            not_taken: Edge {
                target: right,
                args: vec![b.effect],
            },
        },
    );
    for (block, effect) in [(left, le), (right, re)] {
        b.block = block;
        b.binary(Binary::Add, input[0], input[1]);
        let y = b.binary(Binary::Add, input[2], input[3]);
        b.region.terminate(
            block,
            Terminator::Branch(Edge {
                target: join,
                args: vec![effect, y],
            }),
        );
    }
    b.block = join;
    b.effect = je;
    b.gpr[0] = b.binary(Binary::Add, input[0], input[1]);
    b.gpr[1] = b.binary(Binary::Add, input[2], input[3]);
    b.gpr[3] = incoming;
    let wide = b.binary(Binary::Add, a, c);
    let shift = b.node(Op::Const(32), vec![], Type::I64);
    let high = b.binary(Binary::Shr, wide, shift);
    b.gpr[2] = b.node(Op::Truncate, vec![high], Type::I32);
    let state = snapshot(&mut b.region, b.gpr, &flags, 0x9000);
    b.region.terminate(join, Terminator::Exit(state));
    b.region
}
#[test]
fn dominator_gvn_respects_siblings_and_machine_widths() {
    let mut r = diamond();
    verify(&r).unwrap();
    let before = r.blocks.iter().map(|b| b.instructions.len()).sum::<usize>();
    let stats = run(&mut r, config()).unwrap();
    assert_eq!(stats.commoned, 4);
    assert_eq!(stats.cross_commoned, 4);
    assert_eq!(
        r.blocks.iter().map(|b| b.instructions.len()).sum::<usize>(),
        before - 4
    );
    // Three unrelated y computations (left, right, join) must survive.
    let y = r.blocks[1..]
        .iter()
        .flat_map(|b| &b.instructions)
        .filter(|id| r.instructions[id.index()].op == Op::Binary(Binary::Add))
        .count();
    assert_eq!(y, 3);
    let mut no_gvn = diamond();
    assert_eq!(
        run(
            &mut no_gvn,
            PassConfig {
                gvn: false,
                ..config()
            }
        )
        .unwrap()
        .commoned,
        0
    );
    std::fs::create_dir_all("build/ir-dataflow").unwrap();
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    for budget in [1, 2, 3, 4, 5, 9, 16, 100] {
        for opt in [false, true] {
            let mut r = diamond();
            if opt {
                run(&mut r, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-dataflow/diamond-{budget}-{opt}.wasm"),
                emit(&lower(&r).unwrap(), layout, budget).unwrap().bytes,
            )
            .unwrap();
        }
    }
}
#[test]
fn independent_entries_and_cpu_reads_are_not_commoned() {
    let mut b = IntegerBuilder::new();
    b.node(Op::ReadGpr(0), vec![], Type::I32);
    b.node(Op::ReadFlags, vec![], Type::I32);
    b.node(Op::ReadSegment(3), vec![], Type::I16);
    b.node(Op::ReadSegment(3), vec![], Type::I16);
    b.node(Op::ReadStack32, vec![], Type::I1);
    b.node(Op::ReadStack32, vec![], Type::I1);
    let state = snapshot(&mut b.region, b.gpr, &b.flags, 0x1000);
    b.region.terminate(b.block, Terminator::Exit(state));
    assert_eq!(run(&mut b.region, config()).unwrap().commoned, 0);
    let mut r = Region::default();
    let a = r.block(true);
    let b = r.block(true);
    let join = r.block(false);
    for entry in [a, b] {
        r.append(entry, Op::Const(7), vec![], &[Type::I32], None);
        r.terminate(
            entry,
            Terminator::Branch(Edge {
                target: join,
                args: vec![],
            }),
        );
    }
    let value = r.append(join, Op::Const(7), vec![], &[Type::I32], None)[0];
    let flag = r.append(join, Op::Const(0), vec![], &[Type::I1], None)[0];
    let flags = FlagState {
        arithmetic: [flag; 6],
        system: value,
        last_op1: None,
        raw_zero: None,
        zero_is_lazy: None,
        raw_flags: None,
        lazy_mask: None,
        last_result: None,
        last_op_size: None,
        backing_valid: None,
    };
    let state = snapshot(&mut r, [value; 8], &flags, 0x1000);
    r.terminate(join, Terminator::Exit(state));
    assert_eq!(run(&mut r, config()).unwrap().commoned, 0);
    let old = r.blocks[a.index()].terminator.take().unwrap();
    let condition = r.append(a, Op::Const(1), vec![], &[Type::I1], None)[0];
    let Terminator::Branch(taken) = old
    else {
        panic!()
    };
    r.terminate(
        a,
        Terminator::CondBranch {
            condition,
            taken,
            not_taken: Edge {
                target: b,
                args: vec![],
            },
        },
    );
    let stats = run(
        &mut r,
        PassConfig {
            prune: true,
            ..config()
        },
    )
    .unwrap();
    assert_eq!(stats.branches, 1);
    assert_eq!(stats.unreachable, 0);
    assert_eq!(r.entries.len(), 2, "external roots survive pruning");
}
#[test]
fn pruning_removes_dead_memory_and_rewrites_all_arenas() {
    let bytes = [0xB9, 0, 0, 0, 0, 0xE3, 3, 0x03, 0x06, 0x90, 0x40];
    let mut r = lift_cpu_cfg(&bytes, GuestEip(0x1000), LinearAddress(0x100000), true, 8).unwrap();
    let before = (
        r.blocks.len(),
        r.instructions.len(),
        r.values.len(),
        r.states.len(),
    );
    let stats = run(
        &mut r,
        PassConfig {
            merge: false,
            gvn: false,
            dce: false,
            ..PassConfig::default()
        },
    )
    .unwrap();
    assert!(stats.branches > 0 && stats.unreachable > 0);
    assert!(
        r.blocks.len() < before.0
            && r.instructions.len() < before.1
            && r.values.len() < before.2
            && r.states.len() < before.3
    );
    assert!(!r
        .instructions
        .iter()
        .any(|i| matches!(i.op, Op::GuestLoad { .. })));
    verify(&r).unwrap();
    lower(&r).unwrap();
    let r = diamond();
    let mut dynamic = r.clone();
    assert_eq!(
        run(
            &mut dynamic,
            PassConfig {
                gvn: false,
                prune: true,
                ..config()
            }
        )
        .unwrap()
        .branches,
        0
    );
    for selected in [0, 1] {
        let mut r = r.clone();
        let Terminator::CondBranch { condition, .. } = r.blocks[0].terminator.as_ref().unwrap()
        else {
            panic!()
        };
        let Definition::Instruction(id, _) = r.values[condition.index()].definition
        else {
            panic!()
        };
        r.instructions[id.index()].op = Op::Const(selected);
        r.instructions[id.index()].args.clear();
        let stats = run(
            &mut r,
            PassConfig {
                gvn: false,
                prune: true,
                ..config()
            },
        )
        .unwrap();
        assert_eq!(stats.branches, 1);
        assert_eq!(stats.unreachable, 1);
        verify(&r).unwrap();
        assert_eq!(
            run(
                &mut r,
                PassConfig {
                    prune: true,
                    ..config()
                }
            )
            .unwrap()
            .branches,
            0
        );
    }
    let mut builder = IntegerBuilder::new();
    let join = builder.region.block(false);
    let value = builder.region.param(join, Type::I32);
    let zero = builder.constant(0, Type::I32);
    let condition = builder.binary(Binary::Eq, builder.gpr[0], zero);
    let edge = Edge {
        target: join,
        args: vec![builder.gpr[0]],
    };
    builder.region.terminate(
        builder.block,
        Terminator::CondBranch {
            condition,
            taken: edge.clone(),
            not_taken: edge,
        },
    );
    builder.gpr[0] = value;
    let state = snapshot(&mut builder.region, builder.gpr, &builder.flags, 0x1234);
    builder.region.terminate(join, Terminator::Exit(state));
    let stats = run(
        &mut builder.region,
        PassConfig {
            prune: true,
            gvn: false,
            ..config()
        },
    )
    .unwrap();
    assert_eq!(stats.branches, 1);
    assert_eq!(stats.unreachable, 0);

    let mut dead_helper = diamond();
    let Some(Terminator::CondBranch { condition, .. }) = &dead_helper.blocks[0].terminator
    else {
        panic!()
    };
    let Definition::Instruction(id, _) = dead_helper.values[condition.index()].definition
    else {
        panic!()
    };
    dead_helper.instructions[id.index()].op = Op::Const(0);
    dead_helper.instructions[id.index()].args.clear();
    let left = BlockId(2);
    let term = dead_helper.blocks[left.index()].terminator.take().unwrap();
    let effect = dead_helper.blocks[left.index()].params[0];
    let state = dead_helper.blocks[left.index()].entry_state;
    dead_helper
        .helpers
        .push(crate::ir::helper::HelperDescriptor::conservative(
            "unadapted_dead_call".into(),
            vec![],
            vec![],
        ));
    let after = dead_helper.append(
        left,
        Op::CallHelper(HelperId(0)),
        vec![effect],
        &[Type::Effect],
        state,
    )[0];
    let Terminator::Branch(mut edge) = term
    else {
        panic!()
    };
    edge.args[0] = after;
    dead_helper.terminate(left, Terminator::Branch(edge));
    verify(&dead_helper).unwrap();
    assert!(lower(&dead_helper).is_err());
    run(
        &mut dead_helper,
        PassConfig {
            prune: true,
            gvn: false,
            ..config()
        },
    )
    .unwrap();
    let mir = lower(&dead_helper).unwrap();
    assert!(mir.helpers.iter().all(Option::is_none));
    assert!(!dead_helper
        .instructions
        .iter()
        .any(|i| matches!(i.op, Op::CallHelper(_))));
}
