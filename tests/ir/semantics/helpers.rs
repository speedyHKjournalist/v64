use crate::ir::{
    backend::wasm::{emit, StateLayout},
    effects::Effects,
    frontend::decode::GuestEip,
    helper::*,
    hir::*,
    ids::*,
    lowering::lower,
    passes::{run, PassConfig},
    state::*,
    types::Type,
};
pub(super) fn fixture(owner: ExceptionOwner) -> Region {
    let mut r = Region::default();
    let b = r.block(true);
    let effect = r.param(b, Type::Effect);
    let x = r.append(b, Op::Const(77), vec![], &[Type::I32], None)[0];
    let zero = r.append(b, Op::Const(0), vec![], &[Type::I32], None)[0];
    let flag = r.append(b, Op::Const(1), vec![], &[Type::I1], None)[0];
    let before = r.state(StateMap {
        instruction_pc: GuestEip(0x1000),
        next_pc: GuestEip(0x1002),
        next_value: None,
        resume: ResumeKind::BeforeInstruction,
        gpr: [x, zero, zero, zero, zero, zero, zero, zero],
        flags: FlagState {
            arithmetic: [flag; 6],
            system: zero,
            last_op1: None,
            raw_zero: None,
            zero_is_lazy: None,
            raw_flags: None,
            lazy_mask: None,
            last_result: None,
            last_op_size: None,
            backing_valid: None,
        },
        xmm: vec![],
        x87: vec![],
        committed_instructions: 7,
        count_base: None,
        rep_progress: None,
    });
    r.helpers.push(HelperDescriptor {
        name: "audited_operation".into(),
        params: vec![Type::I32],
        results: vec![Type::I32, Type::I8],
        effects: if owner == ExceptionOwner::CannotFault {
            Effects::pure()
        }
        else {
            Effects::conservative()
        },
        exception_owner: owner,
        abi: HelperAbi::Outcome {
            fault_delivery: (owner == ExceptionOwner::Caller).then(|| "deliver_fault".into()),
            normal_preserves_state: true,
        },
    });
    let values = r.append(
        b,
        Op::CallHelper(HelperId(0)),
        vec![x, effect],
        &[Type::I32, Type::I8, Type::Effect],
        Some(before),
    );
    let byte = r.append(
        b,
        Op::Extend { signed: false },
        vec![values[1]],
        &[Type::I32],
        None,
    )[0];
    let mut after = r.states[before.index()].clone();
    after.gpr[0] = values[0];
    after.gpr[1] = byte;
    after.resume = ResumeKind::AfterInstruction;
    after.committed_instructions = 8;
    let after = r.state(after);
    r.terminate(b, Terminator::Exit(after));
    r
}
#[test]
fn helper_outcome_modules_and_snapshot_slot_reuse() {
    std::fs::create_dir_all("build/ir-helpers").unwrap();
    for (name, owner) in [
        ("caller", ExceptionOwner::Caller),
        ("helper", ExceptionOwner::Helper),
        ("pure", ExceptionOwner::CannotFault),
    ] {
        let mut r = fixture(owner);
        for opt in [0, 1] {
            if opt == 1 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            let mir = lower(&r).unwrap();
            let call = r
                .instructions
                .iter()
                .find(|i| matches!(i.op, Op::CallHelper(_)))
                .unwrap();
            let snapshot = &r.states[call.state.unwrap().index()];
            assert!(
                call.results[..2].iter().any(|result| snapshot
                    .values()
                    .iter()
                    .any(|source| mir.allocation.value_local[result.index()]
                        == mir.allocation.value_local[source.index()])),
                "exercise result/snapshot slot reuse across faulting call"
            );
            let artifact = emit(
                &mir,
                StateLayout {
                    gpr: 0,
                    flags: 32,
                    eip: 36,
                    committed: 40,
                    flag_operand: 44,
                },
                100,
            )
            .unwrap();
            assert!(
                artifact.structured_cfg,
                "single-entry helper fixture should use the completed structured backend"
            );
            assert_eq!(artifact.generic_dispatch_edges, 0);
            assert!(
                artifact.locals >= mir.allocation.local_types.len() + 4,
                "local metrics include execution budget, helper outcome and staged return values without a pc dispatcher local"
            );
            std::fs::write(
                format!("build/ir-helpers/{name}-{opt}.wasm"),
                artifact.bytes,
            )
            .unwrap();
        }
    }
}
#[test]
fn helper_legalization_requires_audited_abi_and_complete_materialization() {
    let mut r = fixture(ExceptionOwner::Caller);
    r.states[0].resume = ResumeKind::AfterInstruction;
    assert!(lower(&r).is_err(), "faulting calls cannot restore next EIP");
    let mut r = fixture(ExceptionOwner::Caller);
    r.helpers[0].abi = HelperAbi::Unadapted;
    assert!(
        lower(&r).err().unwrap()
            == crate::ir::lowering::CompileError::Unsupported("unadapted helper ABI")
    );
    let mut r = fixture(ExceptionOwner::Caller);
    r.helpers[0].abi = HelperAbi::Outcome {
        fault_delivery: None,
        normal_preserves_state: true,
    };
    assert!(lower(&r).is_err());
    let mut r = fixture(ExceptionOwner::Helper);
    r.helpers[0].abi = HelperAbi::Outcome {
        fault_delivery: None,
        normal_preserves_state: false,
    };
    assert!(lower(&r).is_err());
    let mut r = fixture(ExceptionOwner::Caller);
    r.helpers[0].name = "deliver_fault".into();
    assert!(
        lower(&r).is_err(),
        "conflicting ABI must be a compile error, not a builder panic"
    );
    let mut r = fixture(ExceptionOwner::Caller);
    let map = &mut r.states[0];
    map.resume = ResumeKind::RepProgress;
    map.rep_progress = Some([map.gpr[1], map.gpr[6], map.gpr[7]]);
    assert!(
        lower(&r).is_ok(),
        "aliased REP GPR progress has complete materialization"
    );
    r.states[0].rep_progress.as_mut().unwrap()[0] = r.states[0].gpr[0];
    assert!(
        lower(&r).is_err(),
        "never silently omit distinct REP values"
    );
}

#[test]
fn cpu_helper_registry_rejects_forged_contracts() {
    use crate::ir::helper::cpu_registry;
    assert!(cpu_registry::descriptor("ir_unknown", vec![]).is_err());
    assert!(cpu_registry::descriptor("ir_fxsave", vec![Type::I32]).is_err());
    assert!(cpu_registry::descriptor("ir_fxsave", vec![Type::I64, Type::I32]).is_err());
    let mut d = cpu_registry::descriptor("ir_fxsave", vec![Type::I32, Type::I32]).unwrap();
    assert!(d.validate().is_ok());
    d.effects = Effects::pure();
    assert!(
        d.validate().is_err(),
        "FXSAVE cannot be forged into a deletable call"
    );
    let mut d = cpu_registry::descriptor("ir_io_check", vec![Type::I32, Type::I32]).unwrap();
    assert!(d.validate().is_ok());
    d.abi = HelperAbi::CpuExit;
    assert!(
        d.validate().is_err(),
        "I/O permission check must preserve normal continuation"
    );
    let mut d = cpu_registry::descriptor("ir_x87_mem", vec![Type::I32; 5]).unwrap();
    d.exception_owner = ExceptionOwner::Caller;
    assert!(
        d.validate().is_err(),
        "CPU-owned faults cannot be delivered twice"
    );
}

#[test]
fn cpu_reload_contract_and_continuation_fixtures() {
    use crate::ir::{
        backend::wasm::emit_cpu,
        frontend::{
            decode::{GuestEip, LinearAddress},
            lift::lift_cpu,
            region::lift_cpu_cfg,
        },
        passes::{run, PassConfig},
    };
    let mut descriptor =
        crate::ir::helper::cpu_registry::descriptor("ir_sse_fp_reg_continue", vec![Type::I32; 4])
            .unwrap();
    assert!(descriptor.validate().is_ok());
    descriptor.results.pop();
    assert!(descriptor.validate().is_err());
    std::fs::create_dir_all("build/ir-reload").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for kind in 0..7 {
            let mut bytes = vec![0x46];
            let (opcode, memory) = match kind {
                0 => {
                    bytes.extend([0xF3, 0x0F, 0x2C, 0xC0, 0x83, 0xC0, 1]);
                    (0xF30F2C, false)
                },
                1 => {
                    bytes.extend([0x0F, 0x2E, 0xC8, 0x83, 0xD0, 0]);
                    (0x0F2E, false)
                },
                2 => {
                    bytes.extend([0xF3, 0x0F, 0x58, 0xC1, 0x66, 0x0F, 0xEF, 0xC8]);
                    (0xF30F58, false)
                },
                3 => {
                    bytes.extend([0xF3, 0x0F, 0x58, if mode { 5 } else { 6 }]);
                    bytes.extend_from_slice(&0x6000u32.to_le_bytes()[..if mode { 4 } else { 2 }]);
                    bytes.push(0x40);
                    (0xF30F58, true)
                },
                4 => {
                    bytes.extend([
                        0xF3, 0x0F, 0x58, 0xC1, 0xF3, 0x0F, 0x59, 0xC1, 0x66, 0x0F, 0x6F, 0xC8,
                    ]);
                    (0xF30F58, false)
                },
                5 => {
                    bytes.extend([0xF3, 0x0F, 0x58, 0xC1, 0x49, 0x75, 0xF9]);
                    (0xF30F58, false)
                },
                _ => {
                    bytes.extend([0xF3, 0x0F, 0x2C, 0xC0, 0x8B, if mode { 0x1D } else { 0x1E }]);
                    bytes.extend_from_slice(&0x7000u32.to_le_bytes()[..if mode { 4 } else { 2 }]);
                    (0xF30F2C, true)
                },
            };
            for variant in 0..4 {
                let mut r = if kind == 5 || variant >= 2 {
                    lift_cpu_cfg(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode, 128)
                }
                else {
                    lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                }
                .unwrap();
                if variant & 1 != 0 {
                    run(&mut r, PassConfig::default()).unwrap();
                }
                let mut mir = lower(&r).unwrap();
                drop(r);
                if variant & 1 != 0 {
                    mir.schedule_operand_stack(262_144).unwrap();
                    mir.allocate_machine_locals(4_000_000).unwrap();
                    mir.elide_redundant_cpu_state_writes(262_144).unwrap();
                    mir.elide_dead_cpu_values(262_144).unwrap();
                }
                std::fs::write(
                    format!("build/ir-reload/{}-{variant}.wasm", cases.len()),
                    emit_cpu(&mir, 100).unwrap().bytes,
                )
                .unwrap();
            }
            cases.push(format!(
                "[{:?},{mode},{opcode},false,{memory},4,{kind}]",
                bytes
            ));
        }
    }
    std::fs::write(
        "build/ir-reload/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
