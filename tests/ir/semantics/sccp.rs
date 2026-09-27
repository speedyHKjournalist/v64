use super::{run, Analysis, Lattice, DEFAULT_WORK_LIMIT};
use crate::ir::{
    backend::wasm::{emit, StateLayout},
    frontend::{decode::GuestEip, integer::IntegerBuilder},
    hir::*,
    ids::*,
    lowering::lower,
    passes::{self, PassConfig},
    state::{FlagState, ResumeKind, StateMap},
    types::Type,
    verify::verify,
};

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

fn diamond(a: u32, c: u32, forced: Option<bool>, parallel: bool) -> Region {
    let mut b = IntegerBuilder::new();
    let entry = b.block;
    let input = b.gpr;
    let flags = b.flags.clone();
    // Join deliberately precedes its predecessors in the arena.
    let join = b.region.block(false);
    let effect = b.region.param(join, Type::Effect);
    let incoming = b.region.param(join, Type::I32);
    let zero = b.constant(0, Type::I32);
    let condition = if let Some(value) = forced {
        b.constant(value as u32, Type::I1)
    }
    else {
        b.binary(Binary::Eq, input[7], zero)
    };
    let (taken, not_taken) = if parallel {
        let x = b.constant(a, Type::I32);
        let y = b.constant(c, Type::I32);
        (
            Edge {
                target: join,
                args: vec![b.effect, x],
            },
            Edge {
                target: join,
                args: vec![b.effect, y],
            },
        )
    }
    else {
        let left = b.region.block(false);
        let right = b.region.block(false);
        for (block, value) in [(left, a), (right, c)] {
            let e = b.region.param(block, Type::Effect);
            let s = snapshot(&mut b.region, input, &flags, 0x2000 + block.0);
            b.region.blocks[block.index()].entry_state = Some(s);
            b.block = block;
            let value = b.constant(value, Type::I32);
            b.region.terminate(
                block,
                Terminator::Branch(Edge {
                    target: join,
                    args: vec![e, value],
                }),
            );
        }
        (
            Edge {
                target: left,
                args: vec![b.effect],
            },
            Edge {
                target: right,
                args: vec![b.effect],
            },
        )
    };
    b.region.terminate(
        entry,
        Terminator::CondBranch {
            condition,
            taken,
            not_taken,
        },
    );
    b.block = join;
    b.effect = effect;
    b.gpr[0] = incoming;
    let s = snapshot(&mut b.region, b.gpr, &flags, 0x3000);
    b.region.blocks[join.index()].entry_state = Some(s);
    let one = b.constant(1, Type::I32);
    b.gpr[0] = b.binary(Binary::Add, incoming, one);
    let seven = b.constant(7, Type::I32);
    // CMP-derived ZF makes constant parameter facts useful to FLAGS and Jcc.
    b.arithmetic(7, incoming, seven);
    let condition = b.flags.arithmetic[3];
    let yes = b.region.block(false);
    let no = b.region.block(false);
    b.region.terminate(
        join,
        Terminator::CondBranch {
            condition,
            taken: Edge {
                target: yes,
                args: vec![effect],
            },
            not_taken: Edge {
                target: no,
                args: vec![effect],
            },
        },
    );
    for (block, pc) in [(yes, 0x4000), (no, 0x5000)] {
        b.region.param(block, Type::Effect);
        let s = snapshot(&mut b.region, b.gpr, &b.flags, pc);
        b.region.blocks[block.index()].entry_state = Some(s);
        let s = snapshot(&mut b.region, b.gpr, &b.flags, pc);
        b.region.states[s.index()].resume = ResumeKind::AfterInstruction;
        b.region.states[s.index()].committed_instructions = 3;
        b.region.terminate(block, Terminator::Exit(s));
    }
    b.region
}

fn loop_region(changing: bool) -> Region {
    let mut b = IntegerBuilder::new();
    let input = b.gpr;
    let flags = b.flags.clone();
    let header = b.region.block(false);
    let exit = b.region.block(false);
    let effect = b.region.param(header, Type::Effect);
    let count = b.region.param(header, Type::I32);
    let invariant = b.region.param(header, Type::I32);
    let end_effect = b.region.param(exit, Type::Effect);
    let end_count = b.region.param(exit, Type::I32);
    let end_value = b.region.param(exit, Type::I32);
    let zero = b.constant(0, Type::I32);
    let seven = b.constant(7, Type::I32);
    b.region.terminate(
        b.block,
        Terminator::Branch(Edge {
            target: header,
            args: vec![b.effect, zero, seven],
        }),
    );
    b.block = header;
    b.effect = effect;
    b.gpr[0] = count;
    b.gpr[1] = invariant;
    let s = snapshot(&mut b.region, b.gpr, &flags, 0x6000);
    b.region.states[s.index()].count_base = Some(count);
    b.region.blocks[header.index()].entry_state = Some(s);
    let one = b.constant(1, Type::I32);
    let step = b.constant(changing as u32, Type::I32);
    let next_count = b.binary(Binary::Add, count, one);
    let next_value = b.binary(Binary::Add, invariant, step);
    let condition = b.binary(Binary::Ult, next_count, input[2]);
    b.region.terminate(
        header,
        Terminator::CondBranch {
            condition,
            taken: Edge {
                target: header,
                args: vec![effect, next_count, next_value],
            },
            not_taken: Edge {
                target: exit,
                args: vec![effect, next_count, next_value],
            },
        },
    );
    b.block = exit;
    b.effect = end_effect;
    b.gpr[0] = end_count;
    b.gpr[1] = end_value;
    let s = snapshot(&mut b.region, b.gpr, &flags, 0x7000);
    b.region.states[s.index()].count_base = Some(end_count);
    b.region.blocks[exit.index()].entry_state = Some(s);
    b.gpr[3] = b.binary(Binary::Add, end_value, one);
    let base = b.constant(0x8000, Type::I32);
    let target = b.binary(Binary::Add, end_value, base);
    let s = snapshot(&mut b.region, b.gpr, &flags, 0x7000);
    let state = &mut b.region.states[s.index()];
    state.resume = ResumeKind::AfterInstruction;
    state.next_value = Some(target);
    state.count_base = Some(end_count);
    b.region.terminate(exit, Terminator::Exit(s));
    b.region
}

fn config() -> PassConfig {
    PassConfig {
        merge: false,
        gvn: false,
        dce: false,
        rounds: 1,
        ..PassConfig::default()
    }
}
fn conditions(r: &Region) -> usize {
    r.blocks
        .iter()
        .filter(|b| matches!(b.terminator, Some(Terminator::CondBranch { .. })))
        .count()
}

#[test]
fn lattice_is_monotone_and_merges_equal_literals() {
    let values = [
        Lattice::Unknown,
        Lattice::Constant(0),
        Lattice::Constant(7),
        Lattice::Overdefined,
    ];
    for &a in &values {
        assert_eq!(a.join(a), a);
        for &b in &values {
            assert_eq!(a.join(b), b.join(a));
            for &c in &values {
                assert_eq!(a.join(b).join(c), a.join(b.join(c)));
            }
        }
    }
}

#[test]
fn equal_phi_literals_fold_flags_and_branch_without_rewriting_entry_state() {
    let mut r = diamond(7, 7, None, false);
    verify(&r).unwrap();
    let param = r.blocks[1].params[1];
    let state = r.blocks[1].entry_state.unwrap();
    assert_eq!(r.states[state.index()].gpr[0], param);
    let stats = run(&mut r, DEFAULT_WORK_LIMIT).unwrap();
    assert!(
        stats.constants > 4,
        "CMP flag expressions should fold through the phi"
    );
    assert_eq!(stats.parameters, 1);
    assert_eq!(stats.branches, 1);
    assert_eq!(stats.unreachable, 1);
    assert_eq!(
        conditions(&r),
        1,
        "the input-dependent entry branch survives"
    );
    let param = r.blocks[1].params[1];
    let state = r.blocks[1].entry_state.unwrap();
    assert_eq!(r.states[state.index()].gpr[0], param);
    assert!(matches!(
        r.values[param.index()].definition,
        Definition::Parameter(_, _)
    ));
    verify(&r).unwrap();
}

#[test]
fn parallel_edges_and_late_live_predecessors_are_not_conflated() {
    for parallel in [false, true] {
        let mut equal = diamond(7, 7, None, parallel);
        assert_eq!(run(&mut equal, DEFAULT_WORK_LIMIT).unwrap().branches, 1);
        let mut different = diamond(7, 9, None, parallel);
        let stats = run(&mut different, DEFAULT_WORK_LIMIT).unwrap();
        assert_eq!(stats.parameters, 0);
        assert_eq!(stats.branches, 0);
        assert_eq!(conditions(&different), 2);
        for forced in [false, true] {
            let mut r = diamond(7, 9, Some(forced), parallel);
            let stats = run(&mut r, DEFAULT_WORK_LIMIT).unwrap();
            assert_eq!(stats.parameters, 1);
            assert_eq!(stats.branches, 2);
            assert_eq!(conditions(&r), 0);
            verify(&r).unwrap();
        }
    }
}

#[test]
fn loop_carried_constants_widen_when_the_backedge_changes_them() {
    for changing in [false, true] {
        let mut r = loop_region(changing);
        verify(&r).unwrap();
        let mut analysis = Analysis::new(&r, DEFAULT_WORK_LIMIT).unwrap();
        analysis.solve().unwrap();
        let count = r.blocks[1].params[1];
        let invariant = r.blocks[1].params[2];
        assert_eq!(analysis.values[count.index()], Lattice::Overdefined);
        assert_eq!(
            analysis.values[invariant.index()],
            if changing { Lattice::Overdefined } else { Lattice::Constant(7) }
        );
        let stats = run(&mut r, DEFAULT_WORK_LIMIT).unwrap();
        assert_eq!(stats.branches, 0);
        assert_eq!(stats.parameters, if changing { 0 } else { 2 });
        if !changing {
            assert!(stats.constants >= 3);
        }
    }
}

#[test]
fn independent_entry_parameters_are_always_unknown_runtime_inputs() {
    let mut r = Region::default();
    let a = r.block(true);
    let b = r.block(true);
    let input = r.param(b, Type::I32);
    let seven = r.append(a, Op::Const(7), vec![], &[Type::I32], None)[0];
    r.terminate(
        a,
        Terminator::Branch(Edge {
            target: b,
            args: vec![seven],
        }),
    );
    let one = r.append(b, Op::Const(1), vec![], &[Type::I32], None)[0];
    let result = r.append(
        b,
        Op::Binary(Binary::Add),
        vec![input, one],
        &[Type::I32],
        None,
    )[0];
    let flag = r.append(b, Op::Const(0), vec![], &[Type::I1], None)[0];
    let flags = FlagState {
        arithmetic: [flag; 6],
        system: one,
        last_op1: None,
        raw_zero: None,
        zero_is_lazy: None,
        raw_flags: None,
        lazy_mask: None,
        last_result: None,
        last_op_size: None,
        backing_valid: None,
    };
    let s = snapshot(&mut r, [result; 8], &flags, 0x1000);
    r.terminate(b, Terminator::Exit(s));
    let stats = run(&mut r, DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.constants, 0);
    assert_eq!(stats.parameters, 0);
    assert_eq!(r.entries.len(), 2);
}

#[test]
fn budget_exhaustion_is_atomic_even_at_the_commit_boundary() {
    let original = diamond(7, 9, Some(true), false);
    let expected = format!("{original:?}");
    let mut lower = 0;
    let mut upper = DEFAULT_WORK_LIMIT;
    while lower < upper {
        let limit = lower + (upper - lower) / 2;
        let mut r = original.clone();
        if run(&mut r, limit).is_ok() {
            upper = limit;
        }
        else {
            assert_eq!(format!("{r:?}"), expected);
            lower = limit + 1;
        }
    }
    assert!(lower > 0 && lower < DEFAULT_WORK_LIMIT);
    let mut r = original.clone();
    assert!(run(&mut r, lower - 1).unwrap_err().contains("budget"));
    assert_eq!(format!("{r:?}"), expected);
    assert!(run(&mut r, lower).unwrap().constants > 0);
    let mut invalid = original.clone();
    invalid.blocks[0].terminator = None;
    let before = format!("{invalid:?}");
    assert!(run(&mut invalid, DEFAULT_WORK_LIMIT).is_err());
    assert_eq!(format!("{invalid:?}"), before);
}

#[test]
fn disabled_pass_families_disable_conditional_constant_propagation() {
    for disabled in 0..3 {
        let mut cfg = config();
        match disabled {
            0 => cfg.fold = false,
            1 => cfg.phis = false,
            _ => cfg.prune = false,
        }
        let mut r = diamond(7, 7, None, false);
        let stats = passes::run(&mut r, cfg).unwrap();
        assert_eq!(stats.sccp_constants, 0);
        assert_eq!(stats.sccp_parameters, 0);
        assert_eq!(conditions(&r), 2);
    }
    let mut r = diamond(7, 7, None, false);
    assert!(passes::run(&mut r, config()).unwrap().sccp_constants > 0);
}

#[test]
fn ordered_helpers_and_unused_arena_slots_remain_safe() {
    use crate::ir::helper::ExceptionOwner;
    for owner in [
        ExceptionOwner::CannotFault,
        ExceptionOwner::Caller,
        ExceptionOwner::Helper,
    ] {
        let mut r = crate::ir::helper_tests::fixture(owner);
        let end = r.blocks[0].terminator.take().unwrap();
        let a = r.append(BlockId(0), Op::Const(11), vec![], &[Type::I32], None)[0];
        r.append(
            BlockId(0),
            Op::Binary(Binary::Add),
            vec![a, a],
            &[Type::I32],
            None,
        );
        // A DCE tombstone must not enter the worklist or become a definition.
        r.append(BlockId(0), Op::Const(99), vec![], &[Type::I32], None);
        r.blocks[0].instructions.pop();
        r.terminate(BlockId(0), end);
        let call = r
            .instructions
            .iter()
            .find(|i| matches!(i.op, Op::CallHelper(_)))
            .unwrap()
            .clone();
        let state = format!("{:?}", r.states[call.state.unwrap().index()]);
        assert_eq!(run(&mut r, DEFAULT_WORK_LIMIT).unwrap().constants, 1);
        let after = r
            .instructions
            .iter()
            .find(|i| matches!(i.op, Op::CallHelper(_)))
            .unwrap();
        assert_eq!(format!("{after:?}"), format!("{call:?}"));
        assert_eq!(
            format!("{:?}", r.states[after.state.unwrap().index()]),
            state
        );
        verify(&r).unwrap();
    }
}

#[test]
fn emit_conditional_constant_propagation_differentials() {
    let cases = [
        ("equal", diamond(7, 7, None, false)),
        ("different", diamond(7, 9, None, false)),
        ("taken", diamond(7, 9, Some(true), false)),
        ("not-taken", diamond(7, 9, Some(false), false)),
        ("parallel-equal", diamond(7, 7, None, true)),
        ("parallel-different", diamond(7, 9, None, true)),
        ("loop-invariant", loop_region(false)),
        ("loop-changing", loop_region(true)),
    ];
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    std::fs::create_dir_all("build/ir-sccp").unwrap();
    for (name, original) in cases {
        for mode in ["before", "sccp", "pipeline"] {
            let mut r = original.clone();
            if mode == "sccp" {
                run(&mut r, DEFAULT_WORK_LIMIT).unwrap();
            }
            else if mode == "pipeline" {
                passes::run(&mut r, PassConfig::default()).unwrap();
            }
            verify(&r).unwrap();
            for budget in [1, 2, 3, 4, 8, 100] {
                let bytes = emit(&lower(&r).unwrap(), layout, budget).unwrap().bytes;
                std::fs::write(format!("build/ir-sccp/{name}-{mode}-{budget}.wasm"), bytes)
                    .unwrap();
            }
        }
    }
}

#[test]
fn a_late_predecessor_revokes_optimistic_phi_and_branch_facts() {
    let mut r = diamond(7, 9, None, false);
    let delayed = r.block(false);
    let e = r.param(delayed, Type::Effect);
    let v = r.param(delayed, Type::I32);
    let Some(Terminator::Branch(mut edge)) = r.blocks[3].terminator.take()
    else {
        panic!("right predecessor must branch to the join")
    };
    let target = edge.target;
    edge.target = delayed;
    r.terminate(BlockId(3), Terminator::Branch(edge));
    r.terminate(
        delayed,
        Terminator::Branch(Edge {
            target,
            args: vec![e, v],
        }),
    );
    let mut analysis = Analysis::new(&r, DEFAULT_WORK_LIMIT).unwrap();
    analysis.solve().unwrap();
    assert_eq!(
        analysis.values[r.blocks[1].params[1].index()],
        Lattice::Overdefined
    );
    let stats = run(&mut r, DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.branches, 0);
    assert_eq!(conditions(&r), 2);
}

fn width_phi(ty: Type, a: u64, rhs: u64, op: Binary) -> Region {
    let mut b = IntegerBuilder::new();
    let join = b.region.block(false);
    let effect = b.region.param(join, Type::Effect);
    let param = b.region.param(join, ty);
    let x = b.node(Op::Const(a), vec![], ty);
    let y = b.node(Op::Const(a), vec![], ty);
    let zero = b.constant(0, Type::I32);
    let condition = b.binary(Binary::Eq, b.gpr[7], zero);
    b.region.terminate(
        b.block,
        Terminator::CondBranch {
            condition,
            taken: Edge {
                target: join,
                args: vec![b.effect, x],
            },
            not_taken: Edge {
                target: join,
                args: vec![b.effect, y],
            },
        },
    );
    b.block = join;
    b.effect = effect;
    let entry = snapshot(&mut b.region, b.gpr, &b.flags, 0x9000);
    b.region.blocks[join.index()].entry_state = Some(entry);
    let rhs = b.node(Op::Const(rhs), vec![], ty);
    let result = b.binary(op, param, rhs);
    let result_ty = b.ty(result);
    b.gpr[1] = b.constant(0, Type::I32);
    b.gpr[0] = match result_ty {
        Type::I64 => {
            let shift = b.node(Op::Const(32), vec![], Type::I64);
            let high = b.binary(Binary::Shr, result, shift);
            b.gpr[1] = b.node(Op::Truncate, vec![high], Type::I32);
            b.node(Op::Truncate, vec![result], Type::I32)
        },
        Type::I32 => result,
        _ => b.node(Op::Extend { signed: false }, vec![result], Type::I32),
    };
    let exit = snapshot(&mut b.region, b.gpr, &b.flags, 0x9000);
    b.region.states[exit.index()].resume = ResumeKind::AfterInstruction;
    b.region.states[exit.index()].committed_instructions = 1;
    b.region.terminate(join, Terminator::Exit(exit));
    b.region
}

#[test]
fn integer_phi_widths_emit_independent_arithmetic_oracles() {
    let types = [Type::I1, Type::I8, Type::I16, Type::I32, Type::I64];
    let ops = [
        Binary::Add,
        Binary::Sub,
        Binary::Mul,
        Binary::And,
        Binary::Or,
        Binary::Xor,
        Binary::Shl,
        Binary::Shr,
        Binary::Sar,
        Binary::Eq,
        Binary::Ult,
        Binary::Slt,
    ];
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    let mut manifest = Vec::new();
    std::fs::create_dir_all("build/ir-sccp").unwrap();
    for ty in types {
        let bits = ty.bits().unwrap();
        let mask = if bits == 64 { u64::MAX } else { (1u64 << bits) - 1 };
        let sign = 1u64 << (bits - 1);
        for op in ops {
            for (a, rhs) in [(0, 0), (1, 1), (mask, mask), (sign, 63 & mask)] {
                let id = manifest.len();
                manifest.push(format!("[{},\"{:?}\",\"{}\",\"{}\"]", bits, op, a, rhs));
                for optimized in [false, true] {
                    let mut r = width_phi(ty, a, rhs, op);
                    if optimized {
                        assert!(run(&mut r, DEFAULT_WORK_LIMIT).unwrap().constants > 0);
                    }
                    let bytes = emit(&lower(&r).unwrap(), layout, 100).unwrap().bytes;
                    std::fs::write(format!("build/ir-sccp/width-{id}-{optimized}.wasm"), bytes)
                        .unwrap();
                }
            }
        }
    }
    assert_eq!(manifest.len(), 240);
    std::fs::write(
        "build/ir-sccp/widths.json",
        format!("[{}]", manifest.join(",")),
    )
    .unwrap();
}
