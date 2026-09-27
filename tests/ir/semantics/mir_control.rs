use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    frontend::{decode::GuestEip, integer::IntegerBuilder},
    hir::{Binary, Edge, Region, Terminator},
    ids::BlockId,
    lowering::lower,
    mir::control::{schedule, Copy, Source, Terminator as MirTerminator},
    passes::{run, PassConfig},
    state::{ResumeKind, StateMap},
    types::Type,
};
fn layout() -> StateLayout {
    StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    }
}
fn assignments(pairs: &[(usize, usize)], types: &[Type]) -> crate::ir::mir::control::Edge {
    let edge = schedule(BlockId(0), pairs, types).unwrap();
    // Symbolic tokens independently model simultaneous assignment, including fanout.
    let initial: Vec<_> = (0..types.len()).collect();
    let mut expected = initial.clone();
    for &(source, destination) in pairs {
        expected[destination] = initial[source];
    }
    let mut actual = initial;
    let mut scratch = vec![None; edge.scratch.len()];
    for copy in &edge.copies {
        match *copy {
            Copy::Save {
                local,
                scratch: slot,
            } => {
                assert_eq!(types[local], edge.scratch[slot]);
                assert!(scratch[slot].replace(actual[local]).is_none());
            },
            Copy::Move {
                source,
                destination,
            } => {
                actual[destination] = match source {
                    Source::Local(slot) => {
                        assert_eq!(types[slot], types[destination]);
                        actual[slot]
                    },
                    Source::Scratch(slot) => {
                        assert_eq!(edge.scratch[slot], types[destination]);
                        scratch[slot].expect("scratch must be saved before use")
                    },
                };
            },
        }
    }
    assert_eq!(actual, expected, "pairs {pairs:?}, schedule {edge:?}");
    edge
}
#[test]
fn parallel_copy_schedules_match_simultaneous_assignments() {
    // Every source mapping up to six destinations, including duplicate sources,
    // self-copies, chains, disjoint cycles and cycles with outgoing fanout.
    for ty in [Type::I32, Type::I64, Type::V128] {
        for n in 1usize..=6 {
            for mut encoding in 0..n.pow(n as u32) {
                let pairs: Vec<_> = (0..n)
                    .map(|destination| {
                        let source = encoding % n;
                        encoding /= n;
                        (source, destination)
                    })
                    .collect();
                assignments(&pairs, &vec![ty; n]);
            }
        }
        let chain = assignments(&[(0, 1), (1, 2), (2, 3)], &[ty; 4]);
        assert!(chain.scratch.is_empty());
        assert_eq!(chain.copies.len(), 3);
        let cycle = assignments(&[(0, 1), (1, 2), (2, 0), (2, 3)], &[ty; 4]);
        assert_eq!(cycle.scratch, vec![ty]);
        assert_eq!(cycle.copies.len(), 5);
        assert!(assignments(&[(0, 0), (1, 1)], &[ty; 2]).copies.is_empty());
    }
    let mixed = assignments(
        &[(0, 1), (1, 0), (2, 3), (3, 2), (4, 5), (5, 4)],
        &[
            Type::I32,
            Type::I32,
            Type::I64,
            Type::I64,
            Type::V128,
            Type::V128,
        ],
    );
    assert_eq!(mixed.scratch, vec![Type::I32, Type::I64, Type::V128]);
    assert!(schedule(BlockId(0), &[(0, 1)], &[Type::I32, Type::I64]).is_err());
    assert!(schedule(BlockId(0), &[(0, 1), (1, 1)], &[Type::I32; 2]).is_err());
    assert!(schedule(BlockId(0), &[(2, 1)], &[Type::I32; 2]).is_err());
    assert!(schedule(BlockId(0), &[(0, 0)], &[Type::Effect]).is_err());
}

fn branch_region(mapping: [usize; 3]) -> Region {
    let mut b = IntegerBuilder::new();
    let join = b.region.block(false);
    let inputs = b.gpr;
    let zero = b.constant(0, Type::I32);
    let condition = b.binary(Binary::Eq, inputs[7], zero);
    let params: Vec<_> = (0..3).map(|_| b.region.param(join, Type::I32)).collect();
    b.region.terminate(
        b.block,
        Terminator::CondBranch {
            condition,
            taken: Edge {
                target: join,
                args: mapping.iter().map(|&i| inputs[i]).collect(),
            },
            not_taken: Edge {
                target: join,
                args: mapping.iter().rev().map(|&i| inputs[i]).collect(),
            },
        },
    );
    b.gpr[..3].copy_from_slice(&params);
    let state = b.region.state(StateMap {
        instruction_pc: GuestEip(0x1000),
        next_pc: GuestEip(0x1002),
        next_value: None,
        resume: ResumeKind::AfterInstruction,
        gpr: b.gpr,
        flags: b.flags,
        xmm: vec![],
        x87: vec![],
        committed_instructions: 1,
        count_base: None,
        rep_progress: None,
    });
    b.region.blocks[join.index()].entry_state = Some(state);
    b.region.terminate(join, Terminator::Exit(state));
    b.region
}
#[test]
fn lowered_graphs_preserve_entries_edges_and_budget_recovery() {
    let r = crate::ir::core_tests::loop_region();
    let mir = lower(&r).unwrap();
    assert_eq!(mir.control.entries, vec![BlockId(0), BlockId(1)]);
    assert_eq!(mir.control.blocks.len(), 4);
    mir.control.check_target(false).unwrap();
    assert!(emit_cpu(&mir, 100).is_err());
    let MirTerminator::Branch { not_taken, .. } = &mir.control.blocks[2].terminator
    else {
        panic!()
    };
    assert_eq!(not_taken.target, BlockId(2));
    assert_eq!(not_taken.scratch, vec![Type::I32]);
    assert!(crate::ir::dump::mir(&mir).contains("Scratch"));
    std::fs::create_dir_all("build/ir-mir-control").unwrap();
    for code in 0..27 {
        let mut r = branch_region([code % 3, code / 3 % 3, code / 9]);
        for opt in 0..2 {
            if opt != 0 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            let mir = lower(&r).unwrap();
            mir.control.check_target(true).unwrap();
            for budget in [1, 100] {
                std::fs::write(
                    format!("build/ir-mir-control/{code}-{opt}-{budget}.wasm"),
                    emit(&mir, layout(), budget).unwrap().bytes,
                )
                .unwrap();
            }
        }
    }
}
#[test]
fn stale_graphs_and_unsafe_copy_schedules_are_rejected() {
    for mutation in 0..12 {
        let r = crate::ir::core_tests::loop_region();
        let mut mir = crate::ir::lowering::lower_draft(&r).unwrap();
        match mutation {
            0 => mir.control.entries.reverse(),
            1 => {
                mir.control.blocks.pop();
            },
            2 => mir.control.blocks[2].recovery = None,
            3 => mir.control.blocks[2].budget_cost = 0,
            4 => mir.control.blocks[0].instructions.reverse(),
            5 => mir.control.blocks[2].params.clear(),
            _ => {
                let MirTerminator::Branch {
                    condition,
                    taken,
                    not_taken,
                } = &mut mir.control.blocks[2].terminator
                else {
                    panic!()
                };
                match mutation {
                    6 => *condition = usize::MAX,
                    7 => taken.target = BlockId(99),
                    8 => not_taken.copies.reverse(),
                    9 => not_taken.scratch[0] = Type::I64,
                    10 => not_taken.copies.clear(),
                    11 => std::mem::swap(taken, not_taken),
                    _ => unreachable!(),
                }
            },
        }
        assert!(mir.finish().is_err(), "mutation {mutation}");
    }
    let r = crate::ir::core_tests::loop_region();
    let mut mir = crate::ir::lowering::lower_draft(&r).unwrap();
    let mut changed = r.clone();
    changed.blocks[0].terminator.as_mut().unwrap().edges_mut()[0]
        .args
        .swap(0, 1);
    mir.hir = &changed;
    assert!(mir.finish().is_err());
}
