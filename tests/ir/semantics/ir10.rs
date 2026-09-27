use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    effects::{Effects, StateSet},
    frontend::{
        decode::{GuestEip, LinearAddress},
        integer::IntegerBuilder,
        region::lift_cpu_cfg,
    },
    helper::{ExceptionOwner, HelperAbi, HelperDescriptor},
    hir::{Binary, Edge, Op, Terminator},
    ids::HelperId,
    lowering::lower,
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

fn config_none() -> PassConfig {
    PassConfig {
        debug: Default::default(),
        disabled: 0,
        prune: false,
        merge: false,
        phis: false,
        copy: false,
        fold: false,
        flags: false,
        state_sync: false,
        helper_state: false,
        gvn: false,
        dce: false,
        rounds: 1,
    }
}

fn state(
    b: &mut IntegerBuilder,
    pc: u32,
    gpr: [crate::ir::ids::ValueId; 8],
) -> crate::ir::ids::StateId {
    b.region.state(StateMap {
        instruction_pc: GuestEip(pc),
        next_pc: GuestEip(pc + 1),
        next_value: None,
        resume: ResumeKind::AfterInstruction,
        gpr,
        flags: b.flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 1,
        count_base: None,
        rep_progress: None,
    })
}

fn copy_region() -> crate::ir::hir::Region {
    let mut b = IntegerBuilder::new();
    let zero = b.constant(0, Type::I32);
    let add = b.binary(Binary::Add, b.gpr[0], zero);
    let cond = b.binary(Binary::Eq, b.gpr[1], zero);
    let selected = b.node(Op::Select, vec![cond, add, add], Type::I32);
    let mut gpr = b.gpr;
    gpr[0] = selected;
    let out = state(&mut b, 0x1000, gpr);
    b.region.terminate(b.block, Terminator::Exit(out));
    b.region
}

fn dce_region() -> crate::ir::hir::Region {
    let mut b = IntegerBuilder::new();
    let _dead0 = b.binary(Binary::Add, b.gpr[2], b.gpr[3]);
    let _dead1 = b.binary(Binary::Xor, b.gpr[4], b.gpr[5]);
    let gpr = b.gpr;
    let out = state(&mut b, 0x1100, gpr);
    b.region.terminate(b.block, Terminator::Exit(out));
    b.region
}

fn gvn_region() -> crate::ir::hir::Region {
    let mut b = IntegerBuilder::new();
    let a = b.binary(Binary::Add, b.gpr[0], b.gpr[1]);
    let c = b.binary(Binary::Add, b.gpr[0], b.gpr[1]);
    let mut gpr = b.gpr;
    gpr[0] = a;
    gpr[1] = c;
    let out = state(&mut b, 0x1200, gpr);
    b.region.terminate(b.block, Terminator::Exit(out));
    b.region
}

fn cfg_region() -> crate::ir::hir::Region {
    let mut b = IntegerBuilder::new();
    let entry = b.block;
    let left = b.region.block(false);
    let right = b.region.block(false);
    let gpr = b.gpr;
    let recovery = state(&mut b, 0x1300, gpr);
    b.region.blocks[left.index()].entry_state = Some(recovery);
    b.region.blocks[right.index()].entry_state = Some(recovery);
    let cond = b.constant(1, Type::I1);
    b.region.terminate(
        entry,
        Terminator::CondBranch {
            condition: cond,
            taken: Edge {
                target: left,
                args: vec![],
            },
            not_taken: Edge {
                target: right,
                args: vec![],
            },
        },
    );

    b.block = left;
    let one = b.constant(1, Type::I32);
    let value = b.binary(Binary::Add, b.gpr[0], one);
    let mut left_gpr = b.gpr;
    left_gpr[0] = value;
    let left_state = state(&mut b, 0x1300, left_gpr);
    b.region.terminate(left, Terminator::Exit(left_state));

    b.block = right;
    let two = b.constant(2, Type::I32);
    let value = b.binary(Binary::Add, b.gpr[0], two);
    let mut right_gpr = b.gpr;
    right_gpr[0] = value;
    let right_state = state(&mut b, 0x1300, right_gpr);
    b.region.terminate(right, Terminator::Exit(right_state));
    b.region
}

fn helper_region(reads_state: bool) -> crate::ir::hir::Region {
    let mut b = IntegerBuilder::new();
    let input = b.gpr;
    let one = b.constant(1, Type::I32);
    let dead = b.binary(Binary::Add, input[7], one);
    let mut before_gpr = input;
    before_gpr[7] = dead;
    let before = b.region.state(StateMap {
        instruction_pc: GuestEip(0x1400),
        next_pc: GuestEip(0x1401),
        next_value: None,
        resume: ResumeKind::BeforeInstruction,
        gpr: before_gpr,
        flags: b.flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 0,
        count_base: None,
        rep_progress: None,
    });
    let mut effects = Effects::pure();
    if reads_state {
        effects.reads_state = StateSet::ALL;
    }
    b.region.helpers.push(HelperDescriptor {
        name: "ir10_pure_helper".into(),
        params: vec![Type::I32],
        results: vec![Type::I32],
        effects,
        exception_owner: ExceptionOwner::CannotFault,
        abi: HelperAbi::Outcome {
            fault_delivery: None,
            normal_preserves_state: true,
        },
    });
    let values = b.region.append(
        b.block,
        Op::CallHelper(HelperId(0)),
        vec![input[0], b.effect],
        &[Type::I32, Type::Effect],
        Some(before),
    );
    let mut after_gpr = input;
    after_gpr[0] = values[0];
    let after = b.region.state(StateMap {
        instruction_pc: GuestEip(0x1400),
        next_pc: GuestEip(0x1401),
        next_value: None,
        resume: ResumeKind::AfterInstruction,
        gpr: after_gpr,
        flags: b.flags,
        xmm: vec![],
        x87: vec![],
        committed_instructions: 1,
        count_base: None,
        rep_progress: None,
    });
    b.region.terminate(b.block, Terminator::Exit(after));
    b.region
}

fn write_standalone(name: &str, region: &crate::ir::hir::Region, opt: usize) {
    std::fs::write(
        format!("build/ir10/{name}-{opt}.wasm"),
        emit(&lower(region).unwrap(), layout(), 100).unwrap().bytes,
    )
    .unwrap();
}

#[test]
fn ir10_per_pass_modules_and_stats() {
    std::fs::create_dir_all("build/ir10").unwrap();

    let baseline = copy_region();
    write_standalone("copy", &baseline, 0);
    let mut optimized = baseline.clone();
    let stats = run(
        &mut optimized,
        PassConfig {
            copy: true,
            ..config_none()
        },
    )
    .unwrap();
    assert!(stats.copied >= 2);
    assert_eq!(
        stats.folded + stats.commoned + stats.removed + stats.branches,
        0
    );
    write_standalone("copy", &optimized, 1);

    let baseline = dce_region();
    write_standalone("dce", &baseline, 0);
    let mut optimized = baseline.clone();
    let stats = run(
        &mut optimized,
        PassConfig {
            dce: true,
            ..config_none()
        },
    )
    .unwrap();
    assert!(stats.removed >= 2);
    assert_eq!(stats.copied + stats.commoned + stats.branches, 0);
    write_standalone("dce", &optimized, 1);

    let baseline = gvn_region();
    write_standalone("gvn", &baseline, 0);
    let mut optimized = baseline.clone();
    let stats = run(
        &mut optimized,
        PassConfig {
            gvn: true,
            ..config_none()
        },
    )
    .unwrap();
    assert!(stats.commoned >= 1);
    assert_eq!(stats.copied + stats.removed + stats.branches, 0);
    write_standalone("gvn", &optimized, 1);

    let baseline = cfg_region();
    write_standalone("cfg", &baseline, 0);
    let mut optimized = baseline.clone();
    let stats = run(
        &mut optimized,
        PassConfig {
            prune: true,
            ..config_none()
        },
    )
    .unwrap();
    assert_eq!(stats.branches, 1);
    assert_eq!(stats.unreachable, 1);
    write_standalone("cfg", &optimized, 1);

    let flags = lift_cpu_cfg(
        &[0x01, 0xD8, 0x01, 0xD1, 0x75, 0x00, 0x90],
        GuestEip(0x1000),
        LinearAddress(0x100000),
        true,
        8,
    )
    .unwrap();
    let baseline = lower(&flags).unwrap();
    std::fs::write(
        "build/ir10/flags-0.wasm",
        emit_cpu(&baseline, 100).unwrap().bytes,
    )
    .unwrap();
    let mut optimized = lower(&flags).unwrap();
    let dead = optimized
        .elide_dead_cpu_values(crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT)
        .unwrap();
    assert!(dead > 0);
    std::fs::write(
        "build/ir10/flags-1.wasm",
        emit_cpu(&optimized, 100).unwrap().bytes,
    )
    .unwrap();

    let helper = helper_region(false);
    let baseline = lower(&helper).unwrap();
    std::fs::write(
        "build/ir10/helper-0.wasm",
        emit_cpu(&baseline, 100).unwrap().bytes,
    )
    .unwrap();
    let mut optimized = lower(&helper).unwrap();
    assert_eq!(
        optimized
            .elide_helper_state_observations(crate::ir::mir::helper_state::DEFAULT_WORK_LIMIT)
            .unwrap(),
        1
    );
    let helper_dead = optimized
        .elide_dead_cpu_values(crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT)
        .unwrap();
    assert!(helper_dead > 0);
    std::fs::write(
        "build/ir10/helper-1.wasm",
        emit_cpu(&optimized, 100).unwrap().bytes,
    )
    .unwrap();
}

#[test]
fn ir10_negative_preconditions_remain_conservative() {
    let helper = helper_region(true);
    let mut mir = lower(&helper).unwrap();
    assert_eq!(
        mir.elide_helper_state_observations(crate::ir::mir::helper_state::DEFAULT_WORK_LIMIT)
            .unwrap(),
        0,
        "state-reading helper is a hard helper-state barrier"
    );

    // SAHF remains a deliberate exact-backing precondition failure. The pass
    // must canonicalize rather than invent a lazy recipe for this special form.
    let sahf = lift_cpu_cfg(
        &[0x9E, 0x75, 0x00, 0x90],
        GuestEip(0x2000),
        LinearAddress(0x100000),
        true,
        8,
    )
    .unwrap();
    let mir = lower(&sahf).unwrap();
    assert!(
        mir.states.iter().any(|state| !state.lazy_flags),
        "unsupported special FLAGS backing must retain canonical recovery"
    );
}
