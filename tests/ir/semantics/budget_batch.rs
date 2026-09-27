use crate::ir::{
    backend::wasm::emit_cpu_with_code_pages,
    frontend::{
        decode::{GuestEip, LinearAddress},
        region::lift_cpu_cfg,
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn budget_batch_fixtures() {
    const PC: u32 = 0x100000;
    let programs: [&[u8]; 9] = [
        &[0x43, 0x01, 0xD8, 0x31, 0xD0, 0x46, 0x4A, 0x47],
        &[0x43, 0x01, 0xD8, 0x31, 0xD0, 0x46, 0x49, 0x75, 0xF6],
        // A forward diamond whose arms have pure work and join at a loop edge.
        &[
            0x40, 0xA9, 1, 0, 0, 0, 0x74, 6, 0x43, 0x46, 0x47, 0x4A, 0xEB, 4, 0x4B, 0x4E, 0x4F,
            0x42, 0x49, 0x75, 0xEB,
        ],
        &[0x8B, 0x06, 0x01, 0xC3, 0x43, 0x47, 0x49, 0x75, 0xF7],
        &[0x89, 0x06, 0x43, 0x47, 0x49, 0x75, 0xF9],
        &[0x0F, 0xA2, 0x43, 0x46, 0x47, 0x4A],
        // These three-instruction mixed loops had no pure suffix to batch.
        &[0x0F, 0x58, 0xC1, 0x49, 0x75, 0xFA],
        &[0x0F, 0x11, 0x06, 0x49, 0x75, 0xFA],
        &[0xFF, 0x06, 0x49, 0x75, 0xFB],
    ];
    std::fs::create_dir_all("build/ir-budget-batch").unwrap();
    let mut cases = vec![];
    for (program, bytes) in programs.into_iter().enumerate() {
        for mode in [true, false] {
            // The first two cases use 16-bit operands under the 16-bit CS. The
            // TEST imm32 diamond needs an operand prefix there, so keep it 32-bit.
            if !mode && program >= 2 {
                continue;
            }
            let mut hir =
                lift_cpu_cfg(bytes, GuestEip(0x8000), LinearAddress(PC), mode, 64).unwrap();
            run(&mut hir, PassConfig::default()).unwrap();
            let mut mir = lower(&hir).unwrap();
            drop(hir);
            mir.schedule_operand_stack(262_144).unwrap();
            mir.allocate_machine_locals(4_000_000).unwrap();
            mir.elide_redundant_cpu_state_writes(262_144).unwrap();
            mir.elide_dead_cpu_values(262_144).unwrap();
            for batch in [false, true] {
                if batch {
                    assert_eq!(
                        mir.batch_pure_budget_polls(262_144).unwrap() > 0,
                        true,
                        "program {program}/{mode}"
                    );
                }
                mir.verify().unwrap();
                for budget in (1..=36).chain([63, 64, 65, 127, 128, 129, 255, 256, 257]) {
                    let a = emit_cpu_with_code_pages(&mir, budget, &[PC]).unwrap();
                    assert_eq!(a.budget_batch_blocks > 0, batch);
                    std::fs::write(
                        format!("build/ir-budget-batch/{}.wasm", cases.len()),
                        &a.bytes,
                    )
                    .unwrap();
                    cases.push(format!(
                        "[{program},{bytes:?},{mode},{batch},{budget},{}]",
                        a.budget_batch_blocks
                    ));
                }
            }
        }
    }
    std::fs::write(
        "build/ir-budget-batch/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn budget_batch_public_compiler_obeys_tier_and_disable_mask() {
    use crate::ir::{
        backend::wasm::StateLayout,
        frontend::decode::PhysicalAddress,
        runtime::compile::{
            compile_cpu_cfg_region, CodeDependency, CodeMapping, CompileRequest,
            ImmutableCodeSnapshot, IrConfig, PublicationKey, Tier,
        },
    };
    let pc = 0x100000;
    let snapshot = ImmutableCodeSnapshot {
        bytes: vec![0x40, 0x43, 0x46, 0x4B, 0xEB, 0xFA],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(pc),
            version: 1,
        }],
        mappings: vec![CodeMapping {
            linear: LinearAddress(pc),
            physical: PhysicalAddress(pc),
        }],
    };
    // Per-instruction polls (sparse polls disabled) are what batches combine.
    let per_instruction = 1 << PassConfig::SPARSE_POLLS;
    for (tier, enabled) in [(Tier::One, false), (Tier::Two, true)] {
        for disabled in [0, 1 << 17, per_instruction, per_instruction | 1 << 17] {
            let request = CompileRequest {
                key: PublicationKey {
                    job: 1,
                    vm_generation: 1,
                    slot: 1,
                    slot_generation: 1,
                },
                pc: GuestEip(pc),
                linear: LinearAddress(pc),
                default_32: true,
                tier,
            };
            let config = IrConfig {
                optimize: true,
                passes: PassConfig::default().disable(disabled),
                execution_budget: 256,
                rep_iteration_budget: 64,
                max_code_bytes: 192,
                layout: StateLayout {
                    gpr: 0,
                    flags: 32,
                    eip: 36,
                    committed: 40,
                    flag_operand: 44,
                },
            };
            let artifact = compile_cpu_cfg_region(&request, &snapshot, &config).unwrap();
            // Default non-fused regions charge the budget at loop headers
            // only: no per-instruction polls remain to batch.
            let batched = enabled && disabled == per_instruction;
            assert_eq!(artifact.code.budget_batch_blocks > 0, batched);
            assert_eq!(artifact.passes.budget_batches > 0, batched);
        }
    }
}

#[test]
fn budget_batch_observer_fixtures() {
    use crate::ir::{backend::wasm::emit_cpu_fused_entry, runtime::entry::CpuEntryKey};
    const PC: u32 = 0x100000;
    let programs: [(&str, &[u8]); 7] = [
        ("load", &[0x40, 0x8B, 0x16, 0x43, 0x47]),
        ("store", &[0x40, 0x89, 0x0E, 0x43, 0x47]),
        ("rmw", &[0x40, 0xFF, 0x06, 0x43, 0x47]),
        ("xmm", &[0x40, 0x0F, 0x11, 0x06, 0x43, 0x47]),
        ("sse", &[0x40, 0x0F, 0x58, 0xC1, 0x43, 0x47]),
        ("divide", &[0x40, 0xF7, 0xF1, 0x43, 0x47]),
        ("second_load", &[0x40, 0x8B, 0x16, 0x43, 0x8B, 0x17, 0x45]),
    ];
    let dir = "build/ir-budget-observers";
    std::fs::create_dir_all(dir).unwrap();
    let mut cases = Vec::new();
    for (name, prefix) in programs {
        let mut bytes = prefix.to_vec();
        bytes.extend([0xEB, (-(prefix.len() as i32 + 2)) as u8]);
        let mut hir = lift_cpu_cfg(&bytes, GuestEip(PC), LinearAddress(PC), true, 64).unwrap();
        run(&mut hir, PassConfig::default()).unwrap();
        let mut mir = lower(&hir).unwrap();
        drop(hir);
        mir.schedule_operand_stack(262_144).unwrap();
        mir.allocate_machine_locals(4_000_000).unwrap();
        mir.elide_redundant_cpu_state_writes(262_144).unwrap();
        mir.elide_dead_cpu_values(262_144).unwrap();
        for batch in [false, true] {
            if batch {
                assert!(mir.batch_pure_budget_polls(262_144).unwrap() > 0, "{name}");
            }
            for fused in [false, true] {
                for budget in [1, 2, 3, 4, 5, 6, 7, 8, 16, 32] {
                    let artifact = if fused {
                        emit_cpu_fused_entry(
                            &mir,
                            budget,
                            CpuEntryKey {
                                pc: GuestEip(PC),
                                linear: LinearAddress(PC),
                                default_32: true,
                            },
                            &[PC],
                        )
                        .unwrap()
                    }
                    else {
                        emit_cpu_with_code_pages(&mir, budget, &[PC]).unwrap()
                    };
                    assert_eq!(
                        artifact.budget_batch_blocks > 0,
                        batch,
                        "{name}/{budget}/{fused}"
                    );
                    std::fs::write(format!("{dir}/{}.wasm", cases.len()), artifact.bytes).unwrap();
                    cases.push(format!("[\"{name}\",{bytes:?},{batch},{fused},{budget}]"));
                }
            }
        }
    }
    std::fs::write(
        format!("{dir}/cases.json"),
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
