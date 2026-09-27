use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu_with_rep_budget},
    },
    helper::{after_call, HelperAbi, Outcome},
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
    verify::verify,
};
#[test]
fn rep_fixtures() {
    std::fs::create_dir_all("build/ir-rep").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for asize in [false, true] {
            for width in [1u8, 2, 4] {
                for kind in 0..7 {
                    for repne in [false, true] {
                        for seg in -1i32..6 {
                            let mut bytes = vec![0x43];
                            if width != 1 && mode == (width == 2) {
                                bytes.push(0x66);
                            }
                            if mode != asize {
                                bytes.push(0x67);
                            }
                            if seg >= 0 {
                                bytes.push([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][seg as usize]);
                            }
                            bytes.push(if repne { 0xF2 } else { 0xF3 });
                            bytes.push(
                                [0xA4, 0xA6, 0xAA, 0xAC, 0xAE, 0x6C, 0x6E][kind]
                                    + u8::from(width != 1),
                            );
                            for limit in [0, 1, 3, 128] {
                                for entry in 0..2 {
                                    let mut r = lift_cpu_with_rep_budget(
                                        &bytes[entry..],
                                        GuestEip(0x8000 + entry as u32),
                                        LinearAddress(0x8000 + entry as u32),
                                        mode,
                                        limit,
                                    )
                                    .unwrap();
                                    for opt in 0..2 {
                                        if opt != 0 {
                                            run(&mut r, PassConfig::default()).unwrap();
                                        }
                                        std::fs::write(
                                            format!(
                                                "build/ir-rep/{}-{limit}-{entry}-{opt}.wasm",
                                                cases.len()
                                            ),
                                            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                                        )
                                        .unwrap();
                                    }
                                }
                            }
                            cases.push(format!(
                                "[{:?},{mode},{width},{asize},{kind},{repne},{seg}]",
                                bytes
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write("build/ir-rep/cases.json", format!("[{}]", cases.join(","))).unwrap();
}
#[test]
fn rep_contract_and_progress_maps() {
    for bytes in [
        &[0xF3, 0xA4][..],
        &[0xF2, 0x6C][..],
        &[0xF3, 0xF2, 0xA6][..],
        &[0xF2, 0xF3, 0xA6][..],
    ] {
        assert!(lift(bytes, GuestEip(0), LinearAddress(0), true).is_err());
        if cfg!(debug_assertions) && bytes.len() == 3 {
            assert!(
                lift_cpu_with_rep_budget(bytes, GuestEip(0), LinearAddress(0), true, 3).is_err()
            );
            continue;
        }
        let r = lift_cpu_with_rep_budget(bytes, GuestEip(0), LinearAddress(0), true, 3).unwrap();
        verify(&r).unwrap();
        let call = r
            .instructions
            .iter()
            .find(|i| matches!(i.op, Op::CallHelper(_)))
            .unwrap();
        let Op::CallHelper(id) = call.op
        else {
            unreachable!()
        };
        let helper = &r.helpers[id.index()];
        assert!(matches!(helper.abi, HelperAbi::CpuRep));
        for outcome in [
            Outcome::ControlTransferred,
            Outcome::Yield,
            Outcome::Invalidated,
        ] {
            assert!(after_call(helper, outcome).is_ok());
        }
        for outcome in [Outcome::Normal, Outcome::FaultNeedsDelivery] {
            assert!(after_call(helper, outcome).is_err());
        }
        let mut broken = r.clone();
        broken.helpers[id.index()].effects.may_yield = false;
        assert!(verify(&broken).is_err());
        let state = call.state.unwrap();
        let mut broken = r.clone();
        broken.states[state.index()].rep_progress = None;
        assert!(verify(&broken).is_err());
        let mut broken = r.clone();
        broken.states[state.index()].rep_progress.as_mut().unwrap()[0] =
            broken.states[state.index()].gpr[0];
        assert!(verify(&broken).is_err());
        let mut broken = r.clone();
        broken.states[state.index()].resume = crate::ir::state::ResumeKind::BeforeInstruction;
        assert!(verify(&broken).is_err());
        assert!(emit(
            &lower(&r).unwrap(),
            StateLayout {
                gpr: 0,
                flags: 32,
                eip: 36,
                committed: 40,
                flag_operand: 44
            },
            100
        )
        .is_err());
        let mut extended = bytes.to_vec();
        extended.push(0x90);
        assert!(
            lift_cpu_with_rep_budget(&extended, GuestEip(0), LinearAddress(0), true, 3).is_err()
        );
        assert!(
            lift_cpu_with_rep_budget(bytes, GuestEip(0), LinearAddress(0), true, 4097).is_err()
        );
        if bytes.len() == 4 {
            let arg = call.args[3];
            assert!(r
                .instructions
                .iter()
                .any(|i| i.results.contains(&arg) && matches!(i.op, Op::Const(1))))
        }
    }
}

#[test]
fn rep_compile_request_budget() {
    use crate::ir::frontend::decode::PhysicalAddress;
    use crate::ir::runtime::compile::*;
    let request = CompileRequest {
        key: PublicationKey {
            job: 1,
            vm_generation: 1,
            slot: 0,
            slot_generation: 1,
        },
        pc: GuestEip(0x8000),
        linear: LinearAddress(0x8000),
        default_32: true,
        tier: Tier::One,
    };
    let snapshot = ImmutableCodeSnapshot {
        bytes: vec![0x43, 0xF3, 0xA4],
        mappings: vec![CodeMapping {
            linear: LinearAddress(0x8000),
            physical: PhysicalAddress(0x8000),
        }],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(0x8000),
            version: 1,
        }],
    };
    let mut config = IrConfig {
        optimize: true,
        passes: PassConfig::default(),
        execution_budget: 100,
        rep_iteration_budget: 3,
        max_code_bytes: 128,
        layout: StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
    };
    let artifact = compile_cpu_region(&request, &snapshot, &config).unwrap();
    std::fs::create_dir_all("build/ir-rep").unwrap();
    std::fs::write("build/ir-rep/request-3.wasm", artifact.code.bytes).unwrap();
    config.rep_iteration_budget = 4097;
    assert!(compile_cpu_region(&request, &snapshot, &config).is_err());
}
