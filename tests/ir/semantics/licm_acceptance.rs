use crate::ir::{
    backend::wasm::StateLayout,
    frontend::{
        decode::{GuestEip, LinearAddress, PhysicalAddress},
        region::lift_cpu_cfg,
    },
    hir::Op,
    lowering::lower,
    passes::{self, licm, PassConfig},
    runtime::compile::{
        compile_cpu_cfg_region, CodeDependency, CodeMapping, CompileRequest, ImmutableCodeSnapshot,
        IrConfig, PublicationKey, Tier,
    },
    verify::verify,
};

// NOP; loop: MOV EAX, EBX; ADD EAX, EDX; DEC ECX; JNZ loop.
const REGISTER_LOOP: &[u8] = &[0x90, 0x89, 0xD8, 0x01, 0xD0, 0x49, 0x75, 0xF9];

#[test]
fn cpu_compilation_runs_licm_only_in_optimized_tier_two() {
    let snapshot = ImmutableCodeSnapshot {
        bytes: REGISTER_LOOP.to_vec(),
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(0x100000),
            version: 1,
        }],
        mappings: vec![CodeMapping {
            linear: LinearAddress(0x100000),
            physical: PhysicalAddress(0x100000),
        }],
    };
    for tier in [Tier::One, Tier::Two] {
        for optimize in [false, true] {
            for rounds in [0, 2] {
                let request = CompileRequest {
                    key: PublicationKey {
                        job: 1,
                        vm_generation: 1,
                        slot: 3,
                        slot_generation: 1,
                    },
                    pc: GuestEip(0x1000),
                    linear: LinearAddress(0x100000),
                    default_32: true,
                    tier,
                };
                let config = IrConfig {
                    optimize,
                    passes: PassConfig {
                        rounds,
                        ..PassConfig::default()
                    },
                    execution_budget: 100,
                    rep_iteration_budget: 8,
                    max_code_bytes: 1920,
                    layout: StateLayout {
                        gpr: 0,
                        flags: 32,
                        eip: 36,
                        committed: 40,
                        flag_operand: 44,
                    },
                };
                let artifact = compile_cpu_cfg_region(&request, &snapshot, &config).unwrap();
                let enabled = tier == Tier::Two && optimize && rounds != 0;
                assert_eq!(
                    artifact.passes.loop_hoisted > 0,
                    enabled,
                    "tier={tier:?}, optimize={optimize}, rounds={rounds}"
                );
            }
        }
    }
}

#[test]
fn actual_lifted_polls_memory_fault_maps_and_commit_maps_are_not_moved() {
    for bytes in [REGISTER_LOOP, &[0x90, 0x03, 0x06, 0x49, 0x75, 0xFB]] {
        let mut region =
            lift_cpu_cfg(bytes, GuestEip(0x1000), LinearAddress(0x100000), true, 8).unwrap();
        passes::run(&mut region, PassConfig::default()).unwrap();
        let states = format!("{:?}", region.states);
        let observations: Vec<_> = region
            .instructions
            .iter()
            .enumerate()
            .filter(|(_, i)| i.op.ordered() || i.state.is_some() || i.commit.is_some())
            .map(|(id, i)| (id, format!("{i:?}")))
            .collect();
        assert!(region.instructions.iter().any(|i| i.op == Op::PollBudget));
        let stats = licm::run(&mut region, licm::DEFAULT_WORK_LIMIT).unwrap();
        if bytes == REGISTER_LOOP {
            assert!(stats.hoisted > 0);
        }
        else {
            assert!(region
                .instructions
                .iter()
                .any(|i| matches!(i.op, Op::GuestLoad { .. })));
        }
        for (id, before) in observations {
            assert_eq!(format!("{:?}", region.instructions[id]), before);
        }
        assert_eq!(format!("{:?}", region.states), states);
        verify(&region).unwrap();
        lower(&region).unwrap();
    }
}

#[path = "licm_pipeline.rs"]
mod pipeline;
