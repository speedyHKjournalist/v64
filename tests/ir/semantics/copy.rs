use crate::ir::{
    frontend::{decode::GuestEip, integer::IntegerBuilder},
    hir::{Binary, Op, Terminator},
    passes::{copy, run, PassConfig},
    state::{ResumeKind, StateMap},
    types::Type,
    verify::verify,
};

fn finish(mut b: IntegerBuilder, value: crate::ir::ids::ValueId) -> crate::ir::hir::Region {
    b.gpr[0] = value;
    let state = b.region.state(StateMap {
        instruction_pc: GuestEip(0x1000),
        next_pc: GuestEip(0x1001),
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
    b.region.terminate(b.block, Terminator::Exit(state));
    b.region
}

#[test]
fn copy_propagates_identity_chains_into_state_maps() {
    let mut b = IntegerBuilder::new();
    let input = b.gpr[0];
    let zero = b.constant(0, Type::I32);
    let add = b.binary(Binary::Add, input, zero);
    let condition = b.binary(Binary::Eq, b.gpr[1], zero);
    let selected = b.node(Op::Select, vec![condition, add, add], Type::I32);
    let mut region = finish(b, selected);

    let stats = copy::run(&mut region, copy::DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.propagated, 2);
    let Terminator::Exit(state) = region.blocks[0].terminator.as_ref().unwrap()
    else {
        panic!()
    };
    assert_eq!(region.states[state.index()].gpr[0], input);
    verify(&region).unwrap();

    let before = region.blocks[0].instructions.len();
    let stats = run(
        &mut region,
        PassConfig {
            debug: Default::default(),
            disabled: 0,
            copy: false,
            fold: false,
            gvn: false,
            prune: false,
            merge: false,
            phis: false,
            dce: true,
            flags: false,
            state_sync: false,
            helper_state: false,
            rounds: 1,
        },
    )
    .unwrap();
    assert!(stats.removed >= 2);
    assert!(region.blocks[0].instructions.len() < before);
    verify(&region).unwrap();
}

#[test]
fn copy_does_not_alias_cpu_reads_or_stateful_values() {
    let mut b = IntegerBuilder::new();
    let read = b.node(Op::ReadGpr(0), vec![], Type::I32);
    let state = b.region.state(StateMap {
        instruction_pc: GuestEip(0x2000),
        next_pc: GuestEip(0x2001),
        next_value: None,
        resume: ResumeKind::BeforeInstruction,
        gpr: b.gpr,
        flags: b.flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 0,
        count_base: None,
        rep_progress: None,
    });
    let zero = b.constant(0, Type::I32);
    let guarded = b.region.append(
        b.block,
        Op::Binary(Binary::Add),
        vec![read, zero],
        &[Type::I32],
        Some(state),
    )[0];
    let mut region = finish(b, guarded);
    let stats = copy::run(&mut region, copy::DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.propagated, 0);
    verify(&region).unwrap();
}
