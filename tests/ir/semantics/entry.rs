use crate::ir::{
    backend::wasm::StateLayout,
    frontend::decode::{GuestEip, LinearAddress, PhysicalAddress},
    runtime::{compile::*, entry::EntryContract},
};
fn config(optimize: bool) -> IrConfig {
    IrConfig {
        optimize,
        passes: Default::default(),
        execution_budget: 32,
        rep_iteration_budget: 8,
        max_code_bytes: 128,
        layout: StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
    }
}

#[test]
fn optimization_policy_disables_all_optional_stages_and_caps_level_one() {
    use crate::ir::passes::PassConfig;
    for bytes in [
        vec![0x40, 0x49, 0x75, 0xFC],
        vec![0xFF, 0x06, 0x8B, 0x1E, 0x43],
        vec![0x31, 0xC0, 0x83, 0xC0, 0x01],
    ] {
        let mut req = request(0x100000, 0x100000, true);
        req.tier = Tier::Two;
        let snapshot = ImmutableCodeSnapshot {
            bytes,
            dependencies: vec![CodeDependency {
                page: PhysicalAddress(0x100000),
                version: 1,
            }],
            mappings: vec![CodeMapping {
                linear: LinearAddress(0x100000),
                physical: PhysicalAddress(0x100000),
            }],
        };
        let plain = compile_cpu_cfg_region(&req, &snapshot, &config(false)).unwrap();
        let mut disabled = config(true);
        disabled.passes = PassConfig::default().disable(PassConfig::MASK);
        let off = compile_cpu_cfg_region(&req, &snapshot, &disabled).unwrap();
        assert_eq!(
            plain.code.bytes, off.code.bytes,
            "every optional stage can be disabled independently of correctness checks"
        );
        let mut small = config(true);
        small.passes = PassConfig::tier1();
        let mut cold = request(0x100000, 0x100000, true);
        cold.tier = Tier::One;
        let one = compile_cpu_cfg_region(&cold, &snapshot, &small).unwrap();
        let capped = compile_cpu_cfg_region(&req, &snapshot, &small).unwrap();
        assert_eq!(
            one.code.bytes, capped.code.bytes,
            "level one must not run Tier-2-only machine or loop passes"
        );
    }
}

#[test]
fn tier_one_cpu_demand_preserves_switches_and_precise_recovery() {
    use crate::ir::passes::PassConfig;
    // Arithmetic, conditional CFG, faulting memory and continuing helper cases
    // all retain their recovery maps; only CPU-dead value programs disappear.
    for bytes in [
        vec![0x01, 0xD8, 0x01, 0xD1, 0x90],
        vec![0x40, 0x49, 0x75, 0xFC],
        vec![0x40, 0x8B, 0x06, 0x49],
        vec![0x40, 0xFA, 0x49],
    ] {
        let req = request(0x100000, 0x100000, true);
        let snapshot = snapshot(bytes, req.linear.0);
        let mut cfg = config(true);
        cfg.passes = PassConfig::tier1();
        let optimized = compile_cpu_cfg_region(&req, &snapshot, &cfg).unwrap();
        assert!(optimized.passes.cpu_values_elided > 0);
        cfg.passes = cfg.passes.disable((1 << 5) | (1 << 13));
        let untrimmed = compile_cpu_cfg_region(&req, &snapshot, &cfg).unwrap();
        assert_eq!(untrimmed.passes.cpu_values_elided, 0);
        assert_eq!(untrimmed.passes.state_writes_elided, 0);
        assert!(optimized.code.bytes.len() < untrimmed.code.bytes.len());

        cfg.passes = PassConfig::tier1();
        cfg.passes.rounds = 0;
        let no_rounds = compile_cpu_cfg_region(&req, &snapshot, &cfg).unwrap();
        assert_eq!(no_rounds.passes.cpu_values_elided, 0);
        assert_eq!(no_rounds.passes.state_writes_elided, 0);
        cfg.optimize = false;
        let disabled = compile_cpu_cfg_region(&req, &snapshot, &cfg).unwrap();
        assert_eq!(disabled.code.bytes, no_rounds.code.bytes);
    }
}
fn request(pc: u32, linear: u32, mode: bool) -> CompileRequest {
    CompileRequest {
        key: PublicationKey {
            job: 17,
            vm_generation: 2,
            slot: 3,
            slot_generation: 9,
        },
        pc: GuestEip(pc),
        linear: LinearAddress(linear),
        default_32: mode,
        tier: Tier::One,
    }
}
fn snapshot(bytes: Vec<u8>, linear: u32) -> ImmutableCodeSnapshot {
    ImmutableCodeSnapshot {
        bytes,
        mappings: vec![CodeMapping {
            linear: LinearAddress(linear),
            physical: PhysicalAddress(0x100000),
        }],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(0x100000),
            version: 7,
        }],
    }
}
#[test]
fn automatic_cfg_budget_shrinks_without_weakening_snapshot_checks() {
    let mut req = request(0x1FFC0, 0x1FFC0, true);
    req.tier = Tier::Two;
    let mut program = vec![0x40; 95];
    program.extend([0x75, (-97i8) as u8]); // genuine internal backedge requires CFG
    let mut bytes = snapshot(program, 0x1F000);
    bytes.mappings.push(CodeMapping {
        linear: LinearAddress(0x20000),
        physical: PhysicalAddress(0x101000),
    });
    bytes.dependencies.push(CodeDependency {
        page: PhysicalAddress(0x101000),
        version: 8,
    });
    let options = config(true);
    compile_cpu_cfg_region(&req, &bytes, &options).unwrap();
    let (artifact, shortened, retries) = compile_cpu_cfg_bounded(&req, &bytes, &options).unwrap();
    assert_eq!(retries, 0, "compact CFG retains the whole hot loop");
    assert_eq!(shortened.bytes.len(), 97);
    assert_eq!(shortened.mappings.len(), 2);
    assert_eq!(shortened.dependencies.len(), 2);
    assert_eq!(artifact.guest_bytes, shortened.bytes.len());
    assert!(artifact.current(
        req.key,
        &shortened.dependencies,
        EntryContract::Cpu(req.cpu_entry()),
        &shortened.mappings
    ));
    assert_eq!(
        bytes.bytes.len(),
        97,
        "original failed-input fingerprint survives"
    );

    bytes.mappings[1].physical = PhysicalAddress(0x102000);
    assert!(matches!(
        compile_cpu_cfg_bounded(&req, &bytes, &options),
        Err(crate::ir::lowering::CompileError::InvalidIr(_))
    ));

    // A byte-budget split inside MOV's immediate must stop at the previous
    // complete instruction, never publish a truncated instruction.
    let mut req = request(0x100000, 0x100000, true);
    req.tier = Tier::Two;
    let mut program = [0xB8, 1, 0, 0, 0].repeat(95);
    program.extend([0xEB, (-37i8) as u8]); // backedge to a complete MOV inside the window
    let bytes = snapshot(program, 0x100000);
    let mut options = config(true);
    options.max_code_bytes = 512;
    let (_, shortened, retries) = compile_cpu_cfg_bounded(&req, &bytes, &options).unwrap();
    assert_eq!(retries, 0);
    assert_eq!(
        shortened.bytes.len(),
        477,
        "instruction-aligned internal target survives"
    );

    // Branch-heavy graphs still exercise the bounded fallback; compacting
    // fallthrough must not bypass decode/graph limits or publish partial opcodes.
    let bytes = snapshot([0xEB, 0].repeat(95), 0x100000);
    let (_, shortened, retries) = compile_cpu_cfg_bounded(&req, &bytes, &options).unwrap();
    assert!(retries > 0);
    assert_eq!(shortened.bytes.len() % 2, 0);
    assert!(shortened.bytes.len() < bytes.bytes.len());

    // The automatic path should never construct a 96-block CFG for straight
    // code that the existing linear CPU frontend represents in one block.
    let bytes = snapshot(vec![0x40; 96], 0x100000);
    let (artifact, selected, retries) = compile_cpu_cfg_bounded(&req, &bytes, &options).unwrap();
    assert_eq!(retries, 0);
    assert_eq!(selected.bytes.len(), 96);
    assert_eq!(artifact.guest_bytes, 96);
}

#[test]
fn entry_publication_contract() {
    let req = request(0xFFFFFFFC, 0x100000, true);
    assert_eq!(req.cpu_entry().cs_base(), 0x100004);
    let bytes = snapshot(vec![0x40], 0x100000);
    let cpu = compile_cpu_region(&req, &bytes, &config(true)).unwrap();
    assert!(cpu.current(
        req.key,
        &bytes.dependencies,
        EntryContract::Cpu(req.cpu_entry()),
        &bytes.mappings
    ));
    for other in [
        request(0, 0x100000, true),
        request(0xFFFFFFFC, 0x800000, true),
        request(0xFFFFFFFC, 0x100000, false),
    ] {
        assert!(!cpu.current(
            req.key,
            &bytes.dependencies,
            EntryContract::Cpu(other.cpu_entry()),
            &bytes.mappings
        ));
    }
    assert!(!cpu.current(
        req.key,
        &bytes.dependencies,
        EntryContract::Standalone,
        &bytes.mappings
    ));
    let standalone = compile_region(&req, &bytes, &config(true)).unwrap();
    assert!(!standalone.current(req.key, &bytes.dependencies, cpu.entry, &bytes.mappings));
    let mut changed = bytes.dependencies.clone();
    changed[0].version += 1;
    assert!(!cpu.current(req.key, &changed, cpu.entry, &bytes.mappings));
    assert!(!cpu.current(
        PublicationKey {
            slot_generation: 10,
            ..req.key
        },
        &bytes.dependencies,
        cpu.entry,
        &bytes.mappings
    ));
}
#[test]
fn entry_execution_fixtures() {
    std::fs::create_dir_all("build/ir-entry").unwrap();
    let mut cases = vec![];
    for mode in [false, true] {
        let address_prefix = if mode { vec![] } else { vec![0x67] };
        let mut load = address_prefix.clone();
        load.extend([0x8B, 0x06]);
        let mut store = address_prefix;
        store.extend([0x89, 0x06]);
        let mut dirty_load = vec![0x40];
        dirty_load.extend(&load);
        let programs = [
            vec![0x40],
            load,
            store,
            vec![0x0F, 0xA2],
            vec![0x40, 0x49, 0x75, 0xFC],
            vec![0x66, 0x0F, 0xEF, 0xC1],
            vec![0x01, 0xD8, 0x11, 0xC8, 0x83, 0xE0, 0x03, 0x49],
            dirty_load,
        ];
        for (kind, bytes) in programs.iter().enumerate() {
            for cfg in [false, true] {
                if kind == 4 && !cfg {
                    continue;
                }
                for pc in [0x1000, 0xFFFFFFFC] {
                    for linear in [0x100000, 0x800000] {
                        for opt in [false, true] {
                            let req = request(pc, linear, mode);
                            let source = snapshot(bytes.clone(), linear);
                            let mut options = config(opt);
                            options.passes = crate::ir::passes::PassConfig::tier1();
                            let artifact = if cfg {
                                compile_cpu_cfg_region(&req, &source, &options)
                            }
                            else {
                                compile_cpu_region(&req, &source, &options)
                            }
                            .unwrap();
                            assert_eq!(artifact.entry, EntryContract::Cpu(req.cpu_entry()));
                            std::fs::write(
                                format!("build/ir-entry/{}.wasm", cases.len()),
                                artifact.code.bytes,
                            )
                            .unwrap();
                            cases.push(format!(
                                "[{kind},{mode},{pc},{linear},{opt},{cfg},{bytes:?}]"
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-entry/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn explicit_code_mappings_and_physical_aliases() {
    let req = request(0x1FFF, 0x1FFF, true);
    let mut source = snapshot(vec![0xB8, 1, 0, 0, 0], 0x1000);
    source.mappings.push(CodeMapping {
        linear: LinearAddress(0x2000),
        physical: PhysicalAddress(0x100000),
    });
    let artifact = compile_cpu_region(&req, &source, &config(true)).unwrap();
    assert_eq!(artifact.dependencies.len(), 1);
    assert_eq!(artifact.mappings.len(), 2);
    assert!(artifact.current(
        req.key,
        &source.dependencies,
        artifact.entry,
        &source.mappings
    ));
    for change in 0..6 {
        let mut bad = source.clone();
        match change {
            0 => {
                bad.mappings.pop();
            },
            1 => bad.mappings.swap(0, 1),
            2 => bad.mappings[1].linear = LinearAddress(0x1000),
            3 => bad.mappings[1].physical = PhysicalAddress(0x100001),
            4 => bad.mappings[1].physical = PhysicalAddress(0x200000),
            _ => bad.dependencies.push(CodeDependency {
                page: PhysicalAddress(0x300000),
                version: 1,
            }),
        }
        assert!(compile_cpu_region(&req, &bad, &config(true)).is_err());
        assert!(!artifact.current(req.key, &bad.dependencies, artifact.entry, &bad.mappings));
    }
    let wrap = request(0xFFFFFFFF, 0xFFFFFFFF, true);
    source.mappings[0].linear = LinearAddress(0xFFFFF000);
    source.mappings[1].linear = LinearAddress(0);
    assert!(compile_cpu_region(&wrap, &source, &config(false)).is_ok());
}

#[test]
fn loop_motion_is_tier_two_only_and_honors_diagnostic_disable() {
    // A direct preheader followed by an invariant add in a counted loop.
    // mov ebp,0; mov eax,edx; add eax,ebx; add ebp,eax; dec ecx; jnz loop
    let bytes = snapshot(
        vec![
            0xBD, 0, 0, 0, 0, 0x89, 0xD0, 0x01, 0xD8, 0x01, 0xC5, 0x49, 0x75, 0xF7,
        ],
        0x100000,
    );
    for tier in [Tier::One, Tier::Two] {
        for optimize in [false, true] {
            for rounds in [0, 2] {
                let mut req = request(0x1000, 0x100000, true);
                req.tier = tier;
                let mut options = config(optimize);
                options.passes.rounds = rounds;
                let artifact = compile_cpu_cfg_region(&req, &bytes, &options).unwrap();
                if tier == Tier::Two && optimize && rounds != 0 {
                    assert!(
                        artifact.passes.loop_hoisted > 0,
                        "optimized Tier 2 must actually run LICM"
                    );
                }
                else {
                    assert_eq!(artifact.passes.loop_hoisted, 0);
                }
                assert_eq!(artifact.entry, EntryContract::Cpu(req.cpu_entry()));
            }
        }
    }
}

#[test]
fn guarded_ram_forwarding_is_tier_two_only_in_both_cpu_compile_entry_points() {
    let bytes = snapshot(vec![0x8B, 0x06, 0x8B, 0x1E], 0x100000);
    for tier in [Tier::One, Tier::Two] {
        for optimize in [false, true] {
            for rounds in [0, 2] {
                for cfg in [false, true] {
                    let mut req = request(0x1000, 0x100000, true);
                    req.tier = tier;
                    let mut options = config(optimize);
                    options.passes.rounds = rounds;
                    let artifact = if cfg {
                        compile_cpu_cfg_region(&req, &bytes, &options)
                    }
                    else {
                        compile_cpu_region(&req, &bytes, &options)
                    }
                    .unwrap();
                    assert_eq!(
                        artifact.passes.ram_forwarded,
                        usize::from(tier == Tier::Two && optimize && rounds != 0)
                    );
                    assert_eq!(artifact.entry, EntryContract::Cpu(req.cpu_entry()));
                }
            }
        }
    }
}

#[test]
fn multiple_cpu_entries_split_and_validate_independently() {
    let req = request(0x1FFD, 0x1FFD, true);
    // Alternate entry 1 decodes INC bytes embedded in entry 0's immediate.
    let mut source = snapshot(vec![0xB8, 0x40, 0x40, 0x40, 0x40, 0x40], 0x1000);
    source.mappings.push(CodeMapping {
        linear: LinearAddress(0x2000),
        physical: PhysicalAddress(0x200000),
    });
    source.dependencies.push(CodeDependency {
        page: PhysicalAddress(0x200000),
        version: 19,
    });
    std::fs::create_dir_all("build/ir-multientry").unwrap();
    let entries = [0, 1, 5].map(|offset| CpuEntryRequest {
        offset,
        key: PublicationKey {
            job: offset as u64 + 20,
            slot: offset as u32 + 4,
            ..req.key
        },
    });
    for opt in [false, true] {
        let compiled = compile_cpu_entries(&req, &source, &entries, &config(opt)).unwrap();
        assert_eq!(compiled.len(), 3);
        for (i, artifact) in compiled.iter().enumerate() {
            let expected = request(
                req.pc.0 + entries[i].offset as u32,
                req.linear.0 + entries[i].offset as u32,
                true,
            )
            .cpu_entry();
            assert_eq!(artifact.entry, EntryContract::Cpu(expected));
            assert_eq!(artifact.key, entries[i].key);
            std::fs::write(
                format!("build/ir-multientry/{i}-{}.wasm", u8::from(opt)),
                &artifact.code.bytes,
            )
            .unwrap();
            assert_eq!(artifact.dependencies.len(), if i == 2 { 1 } else { 2 });
            let mut stale = artifact.dependencies.clone();
            stale[0].version += 1;
            assert!(!artifact.current(artifact.key, &stale, artifact.entry, &artifact.mappings));
        }
    }
    for mutation in 0..5 {
        let mut bad = entries;
        match mutation {
            0 => bad[1].offset = bad[0].offset,
            1 => bad[1].key.slot = bad[0].key.slot,
            2 => bad[1].key.job = bad[0].key.job,
            3 => bad[1].key.vm_generation += 1,
            _ => bad[1].offset = source.bytes.len(),
        };
        assert!(compile_cpu_entries(&req, &source, &bad, &config(true)).is_err());
    }
    source.bytes.push(0x0F); // A later entry cannot publish a partially successful batch.
    assert!(compile_cpu_entries(&req, &source, &entries, &config(true)).is_err());
}

#[test]
fn shared_entries_compile_one_guarded_body() {
    std::fs::create_dir_all("build/ir-shared-entry").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for budget in [1, 2, 5, 40] {
            for optimize in [false, true] {
                let req = request(0x1000, 0x100000, mode);
                let bytes = snapshot(vec![0x40, 0x43, 0x49, 0x75, 0xFB], 0x100000);
                let entries: Vec<_> = [0, 1, 2]
                    .iter()
                    .enumerate()
                    .map(|(i, &offset)| CpuEntryRequest {
                        offset,
                        key: PublicationKey {
                            job: req.key.job + i as u64,
                            slot: req.key.slot + i as u32,
                            ..req.key
                        },
                    })
                    .collect();
                let mut options = config(optimize);
                options.execution_budget = budget;
                let artifact =
                    compile_cpu_shared_entries(&req, &bytes, &entries, &options).unwrap();
                assert_eq!(artifact.alternate_entries.len(), 2);
                assert_eq!(artifact.cpu_entries().count(), 3);
                assert_eq!(artifact.guest_bytes, bytes.bytes.len());
                assert_eq!(artifact.dependencies, bytes.dependencies);
                for entry in artifact.cpu_entries() {
                    assert!(artifact.accepts_entry(entry));
                }
                assert!(!artifact.accepts_entry(request(0x1003, 0x100003, mode).cpu_entry()));
                std::fs::write(
                    format!("build/ir-shared-entry/{}.wasm", cases.len()),
                    &artifact.code.bytes,
                )
                .unwrap();
                cases.push(format!("[{mode},{budget},{optimize}]"));
            }
        }
    }
    std::fs::write(
        "build/ir-shared-entry/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn shared_entries_reject_ambiguous_streams_and_bad_identity() {
    let req = request(0x1000, 0x100000, true);
    let bytes = snapshot(vec![0xB8, 0x40, 0x40, 0x40, 0x40, 0x40], 0x100000);
    let first = CpuEntryRequest {
        offset: 0,
        key: req.key,
    };
    let second = CpuEntryRequest {
        offset: 1,
        key: PublicationKey {
            job: 18,
            slot: 4,
            ..req.key
        },
    };
    assert!(matches!(
        compile_cpu_shared_entries(&req, &bytes, &[first.clone(), second], &config(true)),
        Err(crate::ir::lowering::CompileError::Unsupported(
            "overlapping guest instruction streams"
        ))
    ));
    for (offset, key) in [
        (
            0,
            PublicationKey {
                job: 18,
                slot: 4,
                ..req.key
            },
        ),
        (
            6,
            PublicationKey {
                job: 18,
                slot: 4,
                ..req.key
            },
        ),
        (5, req.key),
        (
            5,
            PublicationKey {
                job: 18,
                slot: 4,
                vm_generation: 3,
                ..req.key
            },
        ),
    ] {
        assert!(compile_cpu_shared_entries(
            &req,
            &bytes,
            &[first.clone(), CpuEntryRequest { offset, key }],
            &config(true)
        )
        .is_err());
    }
    let artifact = compile_cpu_shared_entries(
        &req,
        &bytes,
        &[
            first,
            CpuEntryRequest {
                offset: 5,
                key: PublicationKey {
                    job: 18,
                    slot: 4,
                    ..req.key
                },
            },
        ],
        &config(true),
    )
    .unwrap();
    assert_eq!(
        artifact.alternate_entries.len(),
        1,
        "instruction-aligned sibling shares the body"
    );
}

#[test]
fn cpu_prologue_imports_only_pointer_bases_used_by_machine_plans() {
    // The emitter owns these names in the import section; register-only code
    // must not call opaque imports whose results have no machine-plan consumer.
    let programs: &[(&[u8], bool, bool)] = &[
        (&[0x40, 0x43], false, false),             // GPR arithmetic
        (&[0x66, 0x0F, 0xEF, 0xC0], false, false), // PXOR XMM0,XMM0
        (&[0x8B, 0x06], true, false),              // scalar load
        (&[0x89, 0x06], true, true),               // scalar store + code guard
        (&[0xFF, 0x06], true, true),               // RMW read + separate commit
        (&[0x0F, 0xC7, 0x0E], true, false),        // CMPXCHG8B guarded effect
    ];
    for &(code, tlb, ram) in programs {
        let req = request(0x1000, 0x100000, true);
        let input = snapshot(code.to_vec(), 0x100000);
        for optimize in [false, true] {
            let artifact = compile_cpu_region(&req, &input, &config(optimize)).unwrap();
            let contains = |pattern: &[u8]| {
                artifact.code.bytes.windows(pattern.len()).any(|w| w == pattern)
            };
            // The TLB base is a load of the fixed CPU slot, not an import.
            let slot = crate::cpu::global_pointers::ir_tlb_base as u32;
            assert_eq!(slot, 2048, "the fixture encoding below assumes this slot");
            assert!(!contains(b"ir_tlb_base"), "{code:02X?}: no TLB base import");
            assert_eq!(
                contains(&[0x41, 0x80, 0x10, 0x28]), // i32.const 2048; i32.load
                tlb,
                "{code:02X?}, optimized={optimize}: TLB base slot"
            );
            assert_eq!(
                contains(b"ir_memory_base"),
                ram,
                "{code:02X?}, optimized={optimize}: ir_memory_base"
            );
        }
    }
}
