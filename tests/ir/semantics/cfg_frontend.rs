use crate::ir::{
    backend::wasm::{emit_cpu, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress, PhysicalAddress},
        region::lift_cpu_cfg,
    },
    lowering::{lower, CompileError},
    passes::{licm, run, PassConfig},
    runtime::compile::*,
};
#[test]
fn reachable_cfg_fixtures() {
    std::fs::create_dir_all("build/ir-cfg").unwrap();
    let programs: Vec<Vec<u8>> = vec![
        vec![0x40, 0x49, 0x75, 0xFC],
        vec![0x03, 0x06, 0x49, 0x75, 0xFB],
        vec![0x66, 0x0F, 0xEF, 0xC1, 0xE2, 0xFA],
        vec![0xEB, 0xFE],
        vec![0x74, 0xFE],
        vec![0xE2, 0xFE],
        vec![0xE3, 3, 0x40, 0xEB, 1, 0x48, 0x90],
        vec![0xEB, 1, 0x0F, 0x40],
        vec![0x66, 0x40, 0x67, 0xE2, 0xFB],
        vec![0x8C, 0xD8, 0x49, 0x75, 0xFB],
        vec![0x89, 0x06, 0x0F], // Store owns completion; trailing byte isn't decoded.
        vec![0x0F, 0xA2, 0x40], // CPUID result and following SSA continuation.
        vec![0x40, 0x03, 0x06, 0x81, 0xC6, 0, 0x10, 0, 0, 0xE2, 0xF5],
        vec![
            0x66, 0x0F, 0xEF, 0xC1, 0xF3, 0x0F, 0x6F, 0x16, 0x81, 0xC6, 0, 0x10, 0, 0, 0xE2, 0xF0,
        ],
        vec![0xB9, 0, 0, 0, 0, 0xE3, 3, 0x03, 0x06, 0x90, 0x40],
        vec![
            0xB8, 1, 0, 0, 0, 0x83, 0xF8, 1, 0x75, 3, 0x40, 0xEB, 2, 0x03, 0x06, 0x90,
        ],
        vec![0xB9, 0, 0, 0, 0, 0xE3, 2, 0x0F, 0xA2, 0x40],
        // A real preheader enables LICM; the next iteration faults on another page.
        vec![
            0x90, 0x40, 0x03, 0x06, 0x81, 0xC6, 0, 0x10, 0, 0, 0xE2, 0xF5,
        ],
        vec![
            0x90, 0x66, 0x0F, 0xEF, 0xC1, 0xF3, 0x0F, 0x6F, 0x16, 0x81, 0xC6, 0, 0x10, 0, 0, 0xE2,
            0xF0,
        ],
        // Exact lazy backing: ADD; SUB; AND; CMP; JNZ; NOP.
        vec![
            0x01, 0xD8, 0x29, 0xD1, 0x83, 0xE0, 0x7F, 0x83, 0xF9, 0, 0x75, 0, 0x90,
        ],
        // Mixed eager/lazy backing: ADC; SBB; INC; DEC; JNZ; NOP.
        vec![0x11, 0xD8, 0x19, 0xD1, 0x40, 0x49, 0x75, 0, 0x90],
        // Same mixed backing in the byte-width forms.
        vec![
            0x10, 0xD8, 0x18, 0xD1, 0xFE, 0xC0, 0xFE, 0xC9, 0x75, 0, 0x90,
        ],
        // Carry/direction control must update raw backing without canonicalizing.
        vec![0xF8, 0xF9, 0xF5, 0xFC, 0xFD, 0x90],
        // Conditional loop with an in-region epilogue after the loop exit.
        vec![0x40, 0x49, 0x75, 0xFC, 0x90],
        // Nested reducible branch: the general IR-09 structurer must own it.
        vec![0x74, 0x02, 0x75, 0x02, 0x40, 0x90, 0x48, 0x90],
        // Irreducible SCC: block 0 enters the 1/2/3 cycle through two headers.
        vec![0x74, 0x02, 0xEB, 0x02, 0xEB, 0xFC, 0xEB, 0xFC],
        // Nested reducible loops: reset EDX for each outer ECX iteration.
        vec![0xBA, 2, 0, 0, 0, 0x4A, 0x75, 0xFD, 0x49, 0x75, 0xF5, 0x90],
        // System/raw FLAGS must remain distinct through a conditional join.
        vec![0xFD, 0x74, 0x01, 0xFC, 0x90],
        // LAHF plus SETO demand all six incoming flags through separate roots.
        vec![0x9F, 0x0F, 0x90, 0xC0],
        // Register rotations cross a backedge while concrete FLAGS phis are dead.
        vec![0x93, 0x92, 0x49, 0x75, 0xFB, 0x90],
    ];
    let mut cases = vec![];
    // A terminal write keeps its undecodable suffix outside the CFG. CPUID
    // now has a reachable fallthrough and must reject that same malformed tail.
    assert!(lift_cpu_cfg(&[0x0F, 0x30, 0x0F], GuestEip(0), LinearAddress(0), true, 64).is_ok());
    assert!(lift_cpu_cfg(&[0x0F, 0xA2, 0x0F], GuestEip(0), LinearAddress(0), true, 64).is_err());
    for (n, bytes) in programs.iter().enumerate() {
        for mode in [false, true] {
            // Memory fixture uses [ESI] and the vector prefix requires 32-bit default.
            if !mode && matches!(n, 1 | 2 | 10 | 12..=18 | 26) {
                continue;
            }
            for pc in [0x1000u32, 0xFFFFFFFC] {
                for budget in [1, 2, 3, 4, 5, 9, 16, 100] {
                    let original =
                        lift_cpu_cfg(bytes, GuestEip(pc), LinearAddress(0x100000), mode, 8)
                            .unwrap_or_else(|e| panic!("case {n}, mode {mode}, pc {pc:x}: {e:?}"));
                    for opt in [false, true] {
                        let mut r = original.clone();
                        if opt {
                            run(&mut r, PassConfig::default()).unwrap();
                            let moved = licm::run(&mut r, licm::DEFAULT_WORK_LIMIT).unwrap();
                            if matches!(n, 17 | 18) {
                                assert!(moved.hoisted > 0, "fault fixtures must exercise LICM");
                            }
                        }
                        let mut mir = lower(&r).unwrap();
                        drop(r);
                        if opt {
                            mir.fold_constants().unwrap();
                            mir.elide_redundant_cpu_state_writes(
                                crate::ir::mir::state_elision::DEFAULT_WORK_LIMIT,
                            )
                            .unwrap();
                            mir.elide_dead_cpu_values(
                                crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT,
                            )
                            .unwrap();
                            mir.forward_ram_reads(crate::ir::mir::forwarding::DEFAULT_WORK_LIMIT)
                                .unwrap();
                        }
                        assert!(mir.control.dynamic_counts);
                        let artifact = emit_cpu(&mir, budget).unwrap();
                        let control_edges: u32 = mir
                            .control
                            .blocks
                            .iter()
                            .map(|block| block.terminator.edges().len() as u32)
                            .sum();
                        if artifact.structured_cfg {
                            assert_eq!(
                                artifact.structured_edges, control_edges,
                                "structured metadata must account for every MIR edge"
                            );
                            assert_eq!(artifact.generic_dispatch_edges, 0);
                        }
                        else {
                            assert_eq!(artifact.structured_edges, 0);
                            assert_eq!(
                                artifact.generic_dispatch_edges, control_edges,
                                "fallback metadata must account for every MIR edge"
                            );
                        }
                        // Relative targets use architectural width and the CFG
                        // snapshot itself may cross the 32-bit EIP wrap. Self/back
                        // edges to the high start address leave the snapshot after
                        // 16-bit truncation, while the case-6 forward target wraps
                        // to offset 5 and remains inside the same byte snapshot.
                        let internal_backedge_target = mode || pc <= u16::MAX as u32;
                        if matches!(n, 3 | 4 | 5) {
                            assert!(
                                artifact.structured_cfg,
                                "self-loop or width-truncated acyclic CFG must use the general structurer: case {n}, mode {mode}, pc {pc:x}: {:?}",
                                mir.control
                            );
                            assert_eq!(
                                artifact.structured_backedges,
                                u32::from(internal_backedge_target)
                            );
                            if internal_backedge_target {
                                assert!(artifact.structured_edges > 0);
                            }
                        }
                        if matches!(n, 0 | 1 | 2 | 12 | 13 | 17 | 18 | 23) {
                            assert!(
                                artifact.structured_cfg,
                                "multi-block loop or width-truncated acyclic form must structure: case {n}, mode {mode}, pc {pc:x}: {:?}",
                                mir.control
                            );
                            if matches!(n, 0 | 23) && !internal_backedge_target {
                                assert_eq!(artifact.structured_backedges, 0);
                            }
                            else {
                                assert!(artifact.structured_backedges >= 1);
                            }
                            if artifact.structured_backedges > 0 {
                                assert!(artifact.structured_edges >= artifact.structured_backedges);
                            }
                        }
                        if matches!(n, 6 | 14 | 15) {
                            let expected = true;
                            assert_eq!(
                                artifact.structured_cfg, expected,
                                "diamond structuring: case {n}, mode {mode}, pc {pc:x}: {:?}",
                                mir.control
                            );
                            if expected {
                                assert_eq!(artifact.structured_backedges, 0);
                                if n == 6 || !opt {
                                    assert!(artifact.structured_edges > 0);
                                }
                            }
                        }
                        if n == 24 && mode && pc == 0x1000 {
                            assert!(
                                artifact.structured_cfg,
                                "nested reducible branch must use the general structurer: {:?}",
                                mir.control
                            );
                            assert!(artifact.structured_edges > 0);
                        }
                        if n == 25 && mode && pc == 0x1000 {
                            assert!(
                                !artifact.structured_cfg,
                                "multi-entry irreducible SCC must retain dispatcher fallback"
                            );
                            assert!(artifact.generic_dispatch_edges > 0);
                        }
                        if n == 26 && mode {
                            assert!(
                                artifact.structured_cfg,
                                "nested reducible loops must use the general structurer: {:?}",
                                mir.control
                            );
                            assert!(artifact.structured_backedges >= 2);
                            assert!(artifact.structured_edges > 0);
                            assert_eq!(artifact.generic_dispatch_edges, 0);
                        }
                        std::fs::write(
                            format!("build/ir-cfg/{}.wasm", cases.len()),
                            artifact.bytes,
                        )
                        .unwrap();
                        cases.push(format!("[{n},{bytes:?},{mode},{pc},{budget},{opt}]"));
                    }
                }
            }
        }
    }
    std::fs::write("build/ir-cfg/cases.json", format!("[{}]", cases.join(","))).unwrap();
}
#[test]
fn cfg_boundaries_and_immutable_compile() {
    let lift =
        |bytes: &[u8]| lift_cpu_cfg(bytes, GuestEip(0x1000), LinearAddress(0x100000), true, 8);
    assert!(lift(&[]).is_err());
    assert!(lift(&[0x0F]).is_err());
    assert!(matches!(
        lift(&[0x74, 1, 0xB8, 0, 0, 0, 0]),
        Err(CompileError::Unsupported(
            "overlapping guest instruction streams"
        ))
    ));
    assert!(
        lift(&vec![0x90; 65]).is_ok(),
        "straight-line leaders fit the CFG budget"
    );
    assert!(matches!(
        lift(&vec![0x90; 129]),
        Err(CompileError::Budget(_))
    ));
    let request = CompileRequest {
        key: PublicationKey {
            job: 1,
            vm_generation: 2,
            slot: 3,
            slot_generation: 4,
        },
        pc: GuestEip(0x1000),
        linear: LinearAddress(0x100000),
        default_32: true,
        tier: Tier::Two,
    };
    let mut snapshot = ImmutableCodeSnapshot {
        bytes: vec![0xEB, 0xFE],
        mappings: vec![CodeMapping {
            linear: LinearAddress(0x100000),
            physical: PhysicalAddress(0x2000),
        }],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(0x2000),
            version: 4,
        }],
    };
    let mut config = IrConfig {
        optimize: true,
        passes: PassConfig::default(),
        execution_budget: 16,
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
    assert!(
        artifact.passes.state_writes_elided > 0,
        "optimized pure CFG should elide entry-equivalent CPU state stores"
    );
    assert!(
        artifact.passes.cpu_values_elided > 0,
        "optimized pure CFG should elide CPU-only concrete FLAGS values"
    );
    let tier_one = CompileRequest {
        key: PublicationKey {
            job: 5,
            ..request.key
        },
        pc: request.pc,
        linear: request.linear,
        default_32: request.default_32,
        tier: Tier::One,
    };
    config.passes = PassConfig::tier1();
    let tier_one = compile_cpu_cfg_region(&tier_one, &snapshot, &config).unwrap();
    assert!(
        tier_one.code.structured_cfg,
        "Tier 1 and Tier 2 must share the structured IR backend"
    );
    assert!(
        tier_one.passes.state_writes_elided > 0,
        "Tier 1 should use entry-equivalent state writes already proved by lowering"
    );
    assert!(
        tier_one.passes.cpu_values_elided > 0,
        "Tier 1 should omit concrete FLAGS unused by exact lazy recovery"
    );
    assert_eq!(tier_one.passes.loop_hoisted, 0, "Tier 1 must not run LICM");
    assert_eq!(
        tier_one.passes.ram_forwarded, 0,
        "Tier 1 must not run RAM forwarding"
    );
    assert_eq!(
        tier_one.passes.helper_states_elided, 0,
        "Tier 1 must not run helper-state elision"
    );
    assert!(artifact.current(
        request.key,
        &snapshot.dependencies,
        artifact.entry,
        &snapshot.mappings
    ));
    snapshot.dependencies[0].version += 1;
    assert!(!artifact.current(
        request.key,
        &snapshot.dependencies,
        artifact.entry,
        &snapshot.mappings
    ));
    snapshot.dependencies.clear();
    assert!(compile_cpu_cfg_region(&request, &snapshot, &config).is_err());
}
