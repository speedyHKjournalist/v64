use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    frontend::{decode::GuestEip, integer::IntegerBuilder},
    hir::{Op, Region, Terminator},
    lowering::lower,
    mir::{
        materialize::{self, CountMode, Store},
        value::{Address, Scalar, Step},
    },
    passes::{run, PassConfig},
    state::{ResumeKind, StateMap},
    types::Type,
};
fn layout() -> StateLayout {
    StateLayout {
        gpr: 256,
        flags: 288,
        eip: 292,
        committed: 296,
        flag_operand: 300,
    }
}
fn region(mode: u8, xmm: bool, backing: bool) -> Region {
    let mut b = IntegerBuilder::new();
    let input = b.gpr;
    b.gpr.reverse();
    let vectors: Vec<_> = if xmm {
        (0..8)
            .map(|r| b.node(Op::ReadXmm(r), vec![], Type::V128))
            .collect()
    }
    else {
        vec![]
    };
    let vectors = if xmm { (0..8).map(|r| vectors[(r + 1) % 8]).collect() } else { vectors };
    b.flags.last_op1 = if backing { Some(input[0]) } else { None };
    if backing {
        // This fixture intentionally varies semantic ZF independently from
        // last_result/last_op_size, so it is not an exact v86 lazy-backing
        // certificate and must continue exercising canonical materialization.
        b.flags.backing_valid = Some(b.constant(0, Type::I1));
    }
    if !backing {
        b.flags.raw_zero = None;
        b.flags.zero_is_lazy = None;
        b.flags.raw_flags = None;
        b.flags.lazy_mask = None;
        b.flags.last_result = None;
        b.flags.last_op_size = None;
        b.flags.backing_valid = None;
    }
    let resume = match mode {
        0 => ResumeKind::BeforeInstruction,
        2 => ResumeKind::RepProgress,
        _ => ResumeKind::AfterInstruction,
    };
    let state = b.region.state(StateMap {
        instruction_pc: GuestEip(0x1000),
        next_pc: GuestEip(0x1004),
        next_value: if mode == 3 { Some(input[2]) } else { None },
        resume,
        gpr: b.gpr,
        flags: b.flags,
        xmm: vectors,
        x87: vec![],
        committed_instructions: 7,
        count_base: None,
        rep_progress: if mode == 2 { Some([b.gpr[1], b.gpr[6], b.gpr[7]]) } else { None },
    });
    b.region.terminate(b.block, Terminator::Exit(state));
    b.region
}
#[test]
fn state_plans_preserve_order_pc_backing_and_count_modes() {
    std::fs::create_dir_all("build/ir-mir-state").unwrap();
    let mut cases = vec![];
    for mode in 0..4 {
        for xmm in [false, true] {
            for backing in [false, true] {
                let mut r = region(mode, xmm, backing);
                let index = cases.len();
                cases.push(format!("[{mode},{xmm},{backing}]"));
                for opt in 0..2 {
                    if opt != 0 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    let mir = lower(&r).unwrap();
                    let p = &mir.states[0];
                    assert_eq!(p.requires_cpu, xmm);
                    assert_eq!(p.cpu.count.mode, CountMode::Delta);
                    assert_eq!(p.standalone.count.mode, CountMode::Absolute);
                    assert_eq!(p.cpu.count.snapshot, 7);
                    assert_eq!(p.cpu.writes.last().unwrap().address, Address::Eip);
                    assert_eq!(
                        p.cpu
                            .writes
                            .iter()
                            .filter(|w| w.store == Store::V128)
                            .count(),
                        if xmm { 8 } else { 0 }
                    );
                    assert_eq!(
                        p.cpu
                            .writes
                            .iter()
                            .filter(|w| w.address == Address::FlagOperand)
                            .count(),
                        usize::from(backing)
                    );
                    materialize::verify(&r, &mir.states).unwrap();
                    std::fs::write(
                        format!("build/ir-mir-state/{index}-{opt}-cpu.wasm"),
                        emit_cpu(&mir, 100).unwrap().bytes,
                    )
                    .unwrap();
                    if !xmm {
                        std::fs::write(
                            format!("build/ir-mir-state/{index}-{opt}-standalone.wasm"),
                            emit(&mir, layout(), 100).unwrap().bytes,
                        )
                        .unwrap();
                    }
                    else {
                        assert!(emit(&mir, layout(), 100).is_err());
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-mir-state/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn corrupted_materialization_plans_are_rejected() {
    for mutation in 0..12 {
        let r = region(3, true, true);
        let mut mir = crate::ir::lowering::lower_draft(&r).unwrap();
        let p = &mut mir.states[0];
        match mutation {
            0 => p.cpu.writes.swap(0, 1),
            1 => p.cpu.writes[0].address = Address::Gpr(7),
            2 => p.cpu.writes[0].expression = vec![Step::I64(0)],
            3 => p.cpu.count.mode = CountMode::Absolute,
            4 => p.cpu.count.snapshot = 8,
            5 => p.standalone.count.mode = CountMode::Delta,
            6 => p.cpu.writes.last_mut().unwrap().expression = vec![Step::I32(0x1004)],
            7 => p.decoded_next.expression = vec![Step::I32(0x1000)],
            8 => p.requires_cpu = false,
            9 => {
                p.cpu
                    .writes
                    .iter_mut()
                    .find(|w| w.store == Store::V128)
                    .unwrap()
                    .store = Store::I32
            },
            10 => p
                .cpu
                .writes
                .iter_mut()
                .find(|w| w.address == Address::Flags)
                .unwrap()
                .expression
                .push(Step::Scalar(Scalar::I32Add)),
            11 => {
                mir.states.clear();
            },
            _ => unreachable!(),
        }
        assert!(mir.finish().is_err(), "mutation {mutation}");
    }
    let r = region(0, false, true);
    let mut mir = crate::ir::lowering::lower_draft(&r).unwrap();
    let mut changed = r.clone();
    changed.states[0].instruction_pc = GuestEip(0x2000);
    mir.hir = &changed;
    assert!(mir.finish().is_err());
}
#[test]
fn rmw_observes_committed_values_with_prewrite_count() {
    use crate::ir::frontend::{decode::LinearAddress, lift::lift_cpu};
    for bytes in [vec![0x00, 0x06], vec![0x66, 0x01, 0x06], vec![0x01, 0x06]] {
        let r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), true).unwrap();
        let mir = lower(&r).unwrap();
        let observation = mir
            .effects
            .iter()
            .flatten()
            .find_map(|p| match p {
                crate::ir::mir::effect::EffectPlan::RmwCommit { observe, .. } => Some(observe),
                _ => None,
            })
            .unwrap();
        let values = &mir.states[observation.values.index()];
        let count = &mir.states[observation.count.index()];
        assert_eq!(values.cpu.count.snapshot, count.cpu.count.snapshot + 1);
        assert_eq!(values.decoded_next, count.decoded_next);
        assert_ne!(values.cpu.writes, count.cpu.writes);
        emit_cpu(&mir, 100).unwrap();
    }
}
