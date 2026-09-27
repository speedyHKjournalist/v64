use crate::ir::{
    backend::wasm::emit_cpu,
    effects::Effects,
    frontend::{
        decode::{GuestEip, LinearAddress},
        integer::IntegerBuilder,
        lift::lift_cpu,
    },
    helper::{ExceptionOwner, HelperAbi, HelperDescriptor},
    hir::{Binary, Edge, Op, Region, Terminator},
    ids::{HelperId, ValueId},
    lowering::lower,
    passes::{run, PassConfig},
    state::{ResumeKind, StateMap},
    types::Type,
    verify::verify,
};
fn loop_region() -> Region {
    let mut b = IntegerBuilder::new();
    let input = b.gpr;
    let entry = b.block;
    let h = b.region.block(false);
    let body = b.region.block(false);
    let out = b.region.block(false);
    let x = b.region.param(h, Type::I32);
    let n = b.region.param(h, Type::I32);
    let count = b.region.param(h, Type::I32);
    let effect = b.region.param(h, Type::Effect);
    let body_effect = b.region.param(body, Type::Effect);
    let zero = b.constant(0, Type::I32);
    let one = b.constant(1, Type::I32);
    b.region.terminate(
        entry,
        Terminator::Branch(Edge {
            target: h,
            args: vec![input[0], input[1], zero, b.effect],
        }),
    );
    b.gpr[0] = x;
    b.gpr[1] = n;
    let before = b.region.state(StateMap {
        instruction_pc: GuestEip(0x8000),
        next_pc: GuestEip(0x8001),
        next_value: None,
        resume: ResumeKind::BeforeInstruction,
        gpr: b.gpr,
        flags: b.flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 0,
        count_base: Some(count),
        rep_progress: None,
    });
    b.region.blocks[h.index()].entry_state = Some(before);
    b.region.blocks[body.index()].entry_state = Some(before);
    b.region.blocks[out.index()].entry_state = Some(before);
    b.block = h;
    let done = b.binary(Binary::Eq, n, zero);
    b.region.terminate(
        h,
        Terminator::CondBranch {
            condition: done,
            taken: Edge {
                target: out,
                args: vec![],
            },
            not_taken: Edge {
                target: body,
                args: vec![effect],
            },
        },
    );
    b.region.helpers.push(HelperDescriptor {
        name: "audit_count".into(),
        params: vec![Type::I32],
        results: vec![Type::I32],
        effects: Effects::conservative(),
        exception_owner: ExceptionOwner::Caller,
        abi: HelperAbi::Outcome {
            fault_delivery: Some("deliver_fault".into()),
            normal_preserves_state: true,
        },
    });
    let result = b.region.append(
        body,
        Op::CallHelper(HelperId(0)),
        vec![x, body_effect],
        &[Type::I32, Type::Effect],
        Some(before),
    );
    b.block = body;
    let next_n = b.binary(Binary::Sub, n, one);
    let next_count = b.binary(Binary::Add, count, one);
    let mut completed_state = b.region.states[before.index()].clone();
    completed_state.resume = ResumeKind::AfterInstruction;
    completed_state.gpr[0] = result[0];
    completed_state.gpr[1] = next_n;
    completed_state.committed_instructions = 1;
    let completed_state = b.region.state(completed_state);
    b.region.helpers.push(HelperDescriptor {
        name: "after_count".into(),
        params: vec![],
        results: vec![],
        effects: Effects::pure(),
        exception_owner: ExceptionOwner::CannotFault,
        abi: HelperAbi::Outcome {
            fault_delivery: None,
            normal_preserves_state: true,
        },
    });
    let after_effect = b.region.append(
        body,
        Op::CallHelper(HelperId(1)),
        vec![result[1]],
        &[Type::Effect],
        Some(completed_state),
    )[0];
    b.region.terminate(
        body,
        Terminator::Branch(Edge {
            target: h,
            args: vec![result[0], next_n, next_count, after_effect],
        }),
    );
    let mut after = b.region.states[before.index()].clone();
    after.resume = ResumeKind::AfterInstruction;
    let after = b.region.state(after);
    b.region.terminate(out, Terminator::Exit(after));
    b.region
}
#[test]
fn dynamic_cpu_loops_keep_counter_phis_and_generate_budget_exits() {
    std::fs::create_dir_all("build/ir-dynamic-count").unwrap();
    let mut r = loop_region();
    for opt in 0..2 {
        if opt != 0 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        verify(&r).unwrap();
        let m = lower(&r).unwrap();
        assert!(m.control.dynamic_counts);
        m.control.check_target(true).unwrap();
        assert!(m.states.iter().all(|s| s.cpu.count.base.is_some()));
        let count = r.states[0].count_base.unwrap();
        assert!(m.allocation.value_local[count.index()].is_some());
        for budget in [1, 2, 3, 4, 5, 9, 16, 100] {
            std::fs::write(
                format!("build/ir-dynamic-count/{opt}-{budget}.wasm"),
                emit_cpu(&m, budget).unwrap().bytes,
            )
            .unwrap();
        }
    }
}
#[test]
fn count_bases_are_checked_for_type_dominance_and_commit_phase() {
    for mutation in 0..4 {
        let mut r = loop_region();
        match mutation {
            0 => r.states[0].count_base = Some(r.states[0].flags.arithmetic[0]),
            1 => r.states[0].count_base = Some(ValueId(u32::MAX)),
            2 => {
                let value = r
                    .instructions
                    .iter()
                    .find(|i| i.op == Op::Binary(Binary::Add))
                    .unwrap()
                    .results[0];
                r.states[0].count_base = Some(value);
            },
            3 => r.states[0].count_base = None,
            _ => unreachable!(),
        }
        if mutation == 3 {
            assert!(emit_cpu(&lower(&r).unwrap(), 100).is_err());
        }
        else {
            assert!(verify(&r).is_err());
        }
    }
    let mut r = loop_region();
    let mut orphan = r.states[0].clone();
    orphan.count_base = None;
    r.state(orphan);
    assert!(
        lower(&r).unwrap().control.dynamic_counts,
        "orphan state is not a live observer"
    );
    let mut m = crate::ir::lowering::lower_draft(&r).unwrap();
    m.control.dynamic_counts = false;
    assert!(m.finish().is_err());
    let mut m = crate::ir::lowering::lower_draft(&r).unwrap();
    m.states[0].cpu.count.base = None;
    assert!(m.finish().is_err());
    let mut r = lift_cpu(&[0x01, 0x06], GuestEip(0), LinearAddress(0), true).unwrap();
    let base = r.states[0].gpr[3];
    for s in &mut r.states {
        s.count_base = Some(base);
    }
    verify(&r).unwrap();
    emit_cpu(&lower(&r).unwrap(), 100).unwrap();
    let commit = r.instructions.iter().find_map(|i| i.commit).unwrap();
    r.states[commit.index()].count_base = Some(r.states[commit.index()].gpr[6]);
    assert!(verify(&r).unwrap_err().0.contains("dynamic count base"));
}
#[test]
fn count_only_values_survive_rewrite_and_dead_code_elimination() {
    let mut r = lift_cpu(&[0x89, 0xC0], GuestEip(0), LinearAddress(0), true).unwrap();
    let block = r.entries[0];
    let terminator = r.blocks[block.index()].terminator.take().unwrap();
    let first = r.append(block, Op::Const(7), vec![], &[Type::I32], None)[0];
    let second = r.append(block, Op::Const(7), vec![], &[Type::I32], None)[0];
    // Only the exit references these late definitions; other snapshots are arena records.
    let exit = match &terminator {
        Terminator::Exit(s) => *s,
        _ => panic!(),
    };
    r.terminate(block, terminator);
    r.states[exit.index()].count_base = Some(second);
    let stats = run(&mut r, PassConfig::default()).unwrap();
    assert!(stats.commoned > 0);
    assert_eq!(r.states[exit.index()].count_base, Some(first));
    let m = lower(&r).unwrap();
    assert!(m.allocation.value_local[first.index()].is_some());
    emit_cpu(&m, 100).unwrap();
}
