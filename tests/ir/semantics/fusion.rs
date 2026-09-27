use crate::ir::{
    backend::wasm::StateLayout,
    frontend::{
        decode::{GuestEip, LinearAddress, PhysicalAddress},
        region::PredictedEdge,
    },
    runtime::{compile::*, entry::CpuEntryKey},
};
fn source(bytes: &[u8], address: u32) -> ImmutableCodeSnapshot {
    ImmutableCodeSnapshot {
        bytes: bytes.to_vec(),
        mappings: vec![CodeMapping {
            linear: LinearAddress(address),
            physical: PhysicalAddress(address),
        }],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(address),
            version: 1,
        }],
    }
}
#[test]
fn fused_sources_and_state_retention_fixtures() {
    std::fs::create_dir_all("build/ir-fusion").unwrap();
    let a = 0x100000u32;
    let b = a + 0x2000;
    for mode in [false, true] {
        let base = if mode { 0 } else { 0xFF000 };
        for kind in 0..4 {
            let left: &[u8] =
                if kind == 2 { &[0x66, 0x0F, 0xEF, 0xC1, 0xFF, 0xE2] } else { &[0x40, 0xFF, 0xE2] };
            let right: &[u8] = if kind == 3 && !mode {
                &[0x67, 0xC6, 0x06, 0x90, 0x47, 0xFF, 0xE3]
            }
            else if kind == 3 {
                &[0xC6, 0x06, 0x90, 0x47, 0xFF, 0xE3]
            }
            else if kind == 1 && !mode {
                &[0x67, 0x8B, 0x0E, 0x47, 0xFF, 0xE3]
            }
            else if kind == 1 {
                &[0x8B, 0x0E, 0x47, 0xFF, 0xE3]
            }
            else {
                &[0x41, 0xFF, 0xE3]
            };
            let primary = source(left, a);
            let peer = CapturedRegion {
                entry: CpuEntryKey {
                    pc: GuestEip(b - base),
                    linear: LinearAddress(b),
                    default_32: mode,
                },
                source: source(right, b),
            };
            let request = CompileRequest {
                key: PublicationKey {
                    job: 1,
                    vm_generation: 1,
                    slot: 1,
                    slot_generation: 1,
                },
                pc: GuestEip(a - base),
                linear: LinearAddress(a),
                default_32: mode,
                tier: Tier::Two,
            };
            let edges = [
                PredictedEdge {
                    from: GuestEip(a - base + left.len() as u32 - 2),
                    target: peer.entry.pc,
                },
                PredictedEdge {
                    from: GuestEip(b - base + right.len() as u32 - 2),
                    target: request.pc,
                },
            ];
            for optimize in [false, true] {
                for budget in [1, 2, 3, 4, 7, 32] {
                    let config = IrConfig {
                        optimize,
                        passes: Default::default(),
                        execution_budget: budget,
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
                    let artifact =
                        compile_cpu_fused(&request, &primary, &peer, &edges, &config).unwrap();
                    assert_eq!(artifact.dependencies.len(), 2);
                    assert_eq!(artifact.fused_sources.len(), 1);
                    assert_eq!(artifact.guest_bytes, left.len() + right.len());
                    std::fs::write(
                        format!("build/ir-fusion/{mode}-{kind}-{optimize}-{budget}.wasm"),
                        artifact.code.bytes,
                    )
                    .unwrap();
                    let mut incompatible = peer.clone();
                    incompatible.entry.default_32 = !mode;
                    assert!(
                        compile_cpu_fused(&request, &primary, &incompatible, &edges, &config)
                            .is_err()
                    );
                    assert!(compile_cpu_fused(&request, &primary, &peer, &[], &config).is_err());
                }
            }
        }
    }
}

#[test]
fn overlapping_fusion_snapshots_agree_and_preserve_instruction_boundaries() {
    use crate::ir::{
        backend::wasm::emit_cpu_with_code_pages,
        frontend::region::{lift_cpu_cfg_sources, CfgSource},
        lowering::lower,
    };
    let a = GuestEip(0x100000);
    let b = GuestEip(a.0 + 3);
    let bytes = [0x40, 0xFF, 0xE2, 0x41, 0xFF, 0xE3];
    let primary = CfgSource {
        bytes: &bytes,
        pc: a,
        linear: LinearAddress(a.0),
    };
    let peer = CfgSource {
        bytes: &bytes[3..],
        pc: b,
        linear: LinearAddress(b.0),
    };
    let edges = [
        PredictedEdge {
            from: GuestEip(a.0 + 1),
            target: b,
        },
        PredictedEdge {
            from: GuestEip(b.0 + 1),
            target: a,
        },
    ];
    let r = lift_cpu_cfg_sources(&[primary, peer], &edges, true, 8).unwrap();
    let code = emit_cpu_with_code_pages(&lower(&r).unwrap(), 32, &[a.0]).unwrap();
    std::fs::create_dir_all("build/ir-fusion").unwrap();
    std::fs::write("build/ir-fusion/overlap.wasm", code.bytes).unwrap();
    let conflict = CfgSource {
        bytes: &[0x48, 0xFF, 0xE3],
        ..peer
    };
    assert!(lift_cpu_cfg_sources(&[primary, conflict], &edges, true, 8).is_err());
    let middle = [PredictedEdge {
        from: GuestEip(a.0 + 1),
        target: GuestEip(a.0 + 2),
    }];
    assert!(lift_cpu_cfg_sources(&[primary, peer], &middle, true, 8).is_err());
}

#[test]
fn four_hot_sources_remain_bounded_and_preserve_all_dependencies() {
    let addresses = [0x100000, 0x102000, 0x104000, 0x106000];
    let bytes = [
        [0x40, 0xFF, 0xE2],
        [0x41, 0xFF, 0xE3],
        [0x45, 0xFF, 0xE6],
        [0x40, 0xFF, 0xE7],
    ];
    let peers: Vec<_> = (1..4)
        .map(|i| CapturedRegion {
            entry: CpuEntryKey {
                pc: GuestEip(addresses[i]),
                linear: LinearAddress(addresses[i]),
                default_32: true,
            },
            source: source(&bytes[i], addresses[i]),
        })
        .collect();
    let edges: Vec<_> = (0..4)
        .map(|i| PredictedEdge {
            from: GuestEip(addresses[i] + 1),
            target: GuestEip(addresses[(i + 1) % 4]),
        })
        .collect();
    let request = CompileRequest {
        key: PublicationKey {
            job: 1,
            vm_generation: 1,
            slot: 1,
            slot_generation: 1,
        },
        pc: GuestEip(addresses[0]),
        linear: LinearAddress(addresses[0]),
        default_32: true,
        tier: Tier::Two,
    };
    let config = IrConfig {
        optimize: true,
        passes: Default::default(),
        execution_budget: 32,
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
    let artifact = compile_cpu_fused_regions(
        &request,
        &source(&bytes[0], addresses[0]),
        &peers,
        &edges,
        &config,
    )
    .unwrap();
    assert_eq!(artifact.dependencies.len(), 4);
    assert_eq!(artifact.fused_edges.len(), 4);
    std::fs::create_dir_all("build/ir-fusion").unwrap();
    std::fs::write("build/ir-fusion/four.wasm", artifact.code.bytes).unwrap();
    // The fourth edge closes into an interior instruction already captured by
    // source zero. No fifth source or independently published entry is needed.
    let mut interior = edges.clone();
    interior[3].target = GuestEip(addresses[0] + 1);
    let artifact = compile_cpu_fused_regions(
        &request,
        &source(&bytes[0], addresses[0]),
        &peers,
        &interior,
        &config,
    )
    .unwrap();
    assert_eq!(artifact.dependencies.len(), 4);
    std::fs::write("build/ir-fusion/four-interior.wasm", artifact.code.bytes).unwrap();
    let mut observing = peers.clone();
    observing[2].source = source(&[0xFB, 0x90], addresses[3]);
    assert!(matches!(
        compile_cpu_fused_regions(
            &request,
            &source(&bytes[0], addresses[0]),
            &observing,
            &edges,
            &config
        ),
        Err(crate::ir::lowering::CompileError::Unsupported(
            "extended fusion observer boundary"
        ))
    ));
    let mut excess = peers.clone();
    excess.push(peers[0].clone());
    assert!(compile_cpu_fused_regions(
        &request,
        &source(&bytes[0], addresses[0]),
        &excess,
        &edges,
        &config
    )
    .is_err());
}

#[test]
fn audited_helpers_cross_three_and_four_sources() {
    std::fs::create_dir_all("build/ir-fusion").unwrap();
    let addresses = [0x100000, 0x102000, 0x104000, 0x106000];
    for mode in [false, true] {
        for count in [3, 4] {
            for simd in [false, true] {
                let base = if mode { 0 } else { 0xFF000 };
                let bytes: Vec<Vec<u8>> = (0..count)
                    .map(|i| {
                        let mut code = vec![[0x40, 0x41, 0x45, 0x40][i]];
                        code.extend(if simd { vec![0xF3, 0x0F, 0x51, 0xC0] } else { vec![0xFA] });
                        code.extend([
                            0xFF,
                            [0xE2, 0xE3, if count == 3 { 0xE7 } else { 0xE6 }, 0xE7][i],
                        ]);
                        code
                    })
                    .collect();
                let peers: Vec<_> = (1..count)
                    .map(|i| CapturedRegion {
                        entry: CpuEntryKey {
                            pc: GuestEip(addresses[i] - base),
                            linear: LinearAddress(addresses[i]),
                            default_32: mode,
                        },
                        source: source(&bytes[i], addresses[i]),
                    })
                    .collect();
                let edges: Vec<_> = (0..count)
                    .map(|i| PredictedEdge {
                        from: GuestEip(addresses[i] - base + bytes[i].len() as u32 - 2),
                        target: GuestEip(addresses[(i + 1) % count] - base),
                    })
                    .collect();
                let request = CompileRequest {
                    key: PublicationKey {
                        job: 1,
                        vm_generation: 1,
                        slot: 1,
                        slot_generation: 1,
                    },
                    pc: GuestEip(addresses[0] - base),
                    linear: LinearAddress(addresses[0]),
                    default_32: mode,
                    tier: Tier::Two,
                };
                for opt in [false, true] {
                    for budget in [1, 2, 3, 4, 7, 32] {
                        let config = IrConfig {
                            optimize: opt,
                            passes: Default::default(),
                            execution_budget: budget,
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
                        let artifact = compile_cpu_fused_regions(
                            &request,
                            &source(&bytes[0], addresses[0]),
                            &peers,
                            &edges,
                            &config,
                        )
                        .unwrap();
                        assert_eq!(artifact.dependencies.len(), count);
                        std::fs::write(
                            format!(
                                "build/ir-fusion/helpers-{mode}-{count}-{simd}-{opt}-{budget}.wasm"
                            ),
                            artifact.code.bytes,
                        )
                        .unwrap();
                    }
                }
            }
        }
    }
}
