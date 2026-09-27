//! Test the real immutable compiler API, not only a directly invoked pass.
use crate::ir::{
    backend::wasm::StateLayout,
    frontend::decode::{GuestEip, LinearAddress, PhysicalAddress},
    passes::PassConfig,
    runtime::compile::{
        compile_cpu_cfg_region, CodeDependency, CodeMapping, CompileRequest, ImmutableCodeSnapshot,
        IrConfig, PublicationKey, Tier,
    },
};

#[test]
fn licm_is_a_tier_two_optimization_and_respects_disabled_passes() {
    // mov ecx,3; loop: imul ebx,esi,7; add eax,ebx; dec ecx; jnz loop; nop
    let snapshot = ImmutableCodeSnapshot {
        bytes: vec![
            0xB9, 3, 0, 0, 0, 0x6B, 0xDE, 7, 0x01, 0xD8, 0x49, 0x75, 0xF8, 0x90,
        ],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(0x1000),
            version: 1,
        }],
        mappings: vec![CodeMapping {
            linear: LinearAddress(0x1000),
            physical: PhysicalAddress(0x1000),
        }],
    };
    let mut request = CompileRequest {
        key: PublicationKey {
            job: 1,
            vm_generation: 1,
            slot: 0,
            slot_generation: 1,
        },
        pc: GuestEip(0x1000),
        linear: LinearAddress(0x1000),
        default_32: true,
        tier: Tier::One,
    };
    let mut config = IrConfig {
        optimize: true,
        passes: PassConfig::default(),
        execution_budget: 512,
        rep_iteration_budget: 8,
        max_code_bytes: 64,
        layout: StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
    };
    let unchanged_snapshot = format!("{snapshot:?}");
    let tier_one = compile_cpu_cfg_region(&request, &snapshot, &config).unwrap();
    assert_eq!(tier_one.passes.loop_hoisted, 0);
    request.tier = Tier::Two;
    let tier_two = compile_cpu_cfg_region(&request, &snapshot, &config).unwrap();
    assert!(
        tier_two.passes.loop_hoisted > 0,
        "no invariant reached the production compiler API"
    );
    assert_eq!(tier_two.tier, Tier::Two);
    assert!(tier_two.current(
        request.key,
        &snapshot.dependencies,
        tier_two.entry,
        &snapshot.mappings
    ));
    config.optimize = false;
    assert_eq!(
        compile_cpu_cfg_region(&request, &snapshot, &config)
            .unwrap()
            .passes
            .loop_hoisted,
        0
    );
    config.optimize = true;
    config.passes.rounds = 0;
    assert_eq!(
        compile_cpu_cfg_region(&request, &snapshot, &config)
            .unwrap()
            .passes
            .loop_hoisted,
        0
    );
    assert_eq!(format!("{snapshot:?}"), unchanged_snapshot);
}
