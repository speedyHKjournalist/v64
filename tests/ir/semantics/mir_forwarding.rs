use super::{loop_plan, plan, verify, Forwarding, DEFAULT_WORK_LIMIT};
use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    hir::{Op, Terminator},
    ids::*,
    lowering::{lower, lower_draft},
    mir::memory::NativeMemory,
    passes::{run, PassConfig},
    types::Type,
};

fn region(bytes: &[u8]) -> crate::ir::hir::Region {
    let mut r = lift_cpu(bytes, GuestEip(0x100000), LinearAddress(0x100000), true).unwrap();
    run(&mut r, PassConfig::default()).unwrap();
    r
}
fn loads(r: &crate::ir::hir::Region) -> Vec<InstId> {
    r.blocks
        .iter()
        .flat_map(|b| b.instructions.iter())
        .copied()
        .filter(|id| matches!(r.instructions[id.index()].op, Op::GuestLoad { .. }))
        .collect()
}
fn stores(r: &crate::ir::hir::Region) -> Vec<InstId> {
    r.blocks
        .iter()
        .flat_map(|b| b.instructions.iter())
        .copied()
        .filter(|id| matches!(r.instructions[id.index()].op, Op::GuestStore { .. }))
        .collect()
}

#[test]
fn rmw_commit_seeds_only_exact_width_address_and_segment() {
    for bytes in [
        vec![0xFE, 0x06, 0x8A, 0x1E],
        vec![0x66, 0xFF, 0x06, 0x66, 0x8B, 0x1E],
        vec![0xFF, 0x06, 0x8B, 0x1E],
    ] {
        let r = region(&bytes);
        let commit = r
            .blocks
            .iter()
            .flat_map(|b| &b.instructions)
            .copied()
            .find(|id| matches!(r.instructions[id.index()].op, Op::RmwStore { .. }))
            .unwrap();
        let load = loads(&r)[0];
        let mut m = lower(&r).unwrap();
        drop(r);
        assert_eq!(m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(), 1);
        assert_eq!(m.ram_forwarding(commit), Some(Forwarding::Begin));
        assert_eq!(
            m.ram_forwarding(load),
            Some(Forwarding::Reuse { previous: commit })
        );
        emit_cpu(&m, 32).unwrap();
        let r = region(&bytes);
        let mut bad = lower_draft(&r).unwrap();
        bad.ram_forwarding = plan(&bad, DEFAULT_WORK_LIMIT).unwrap();
        bad.ram_forwarding[load.index()] = Some(Forwarding::Reuse { previous: load });
        assert!(
            bad.finish().is_err(),
            "forged RMW witness must not become an emittable artifact"
        );
    }
    for bytes in [
        vec![0xFE, 0x06, 0x8B, 0x1E],
        vec![0xFF, 0x06, 0x8B, 0x1F],
        vec![0xFF, 0x06, 0x64, 0x8B, 0x1E],
        vec![0xFF, 0x06, 0x8B, 0x07, 0x8B, 0x1E],
    ] {
        let r = region(&bytes);
        assert_eq!(
            lower(&r)
                .unwrap()
                .forward_ram_reads(DEFAULT_WORK_LIMIT)
                .unwrap(),
            0
        );
    }
}

#[test]
fn loop_optimization_does_not_enable_disabled_forwarding() {
    let r = region(&[0xFF, 0x06, 0x8B, 0x1E]);
    let mut m = lower(&r).unwrap();
    m.cache_loop_invariant_ram_reads(DEFAULT_WORK_LIMIT)
        .unwrap();
    assert!(!m.has_ram_forwarding());
    assert_eq!(m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(), 1);
    m.cache_loop_invariant_ram_reads(DEFAULT_WORK_LIMIT)
        .unwrap();
    assert!(
        m.has_ram_forwarding(),
        "an already enabled certificate remains valid after loop planning"
    );
    emit_cpu(&m, 32).unwrap();
}

#[test]
fn repeated_reads_use_owned_machine_certificates_and_separate_cache_locals() {
    for bytes in [
        vec![0x8A, 0x06, 0x8A, 0x1E],
        vec![0x66, 0x8B, 0x06, 0x66, 0x8B, 0x1E],
        vec![0x8B, 0x06, 0x8B, 0x1E],
        vec![0x8B, 0x06, 0x8B, 0x1E, 0x8B, 0x16],
    ] {
        let r = region(&bytes);
        let ids = loads(&r);
        let mut m = lower(&r).unwrap();
        drop(r);
        let plain = emit_cpu(&m, 32).unwrap();
        assert_eq!(
            m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(),
            ids.len() - 1
        );
        assert_eq!(m.ram_forwarding(ids[0]), Some(Forwarding::Begin));
        for pair in ids.windows(2) {
            assert_eq!(
                m.ram_forwarding(pair[1]),
                Some(Forwarding::Reuse { previous: pair[0] })
            );
        }
        let optimized = emit_cpu(&m, 32).unwrap();
        assert!(
            optimized.locals >= plain.locals + 2,
            "validity and cached data outlive coalesced SSA slots"
        );
        assert_eq!(
            m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(),
            ids.len() - 1
        );
    }
}

#[test]
fn committed_scalar_store_can_seed_same_address_load_forwarding() {
    for bytes in [
        vec![0x88, 0x06, 0x8A, 0x1E],
        vec![0x66, 0x89, 0x06, 0x66, 0x8B, 0x1E],
        vec![0x89, 0x06, 0x8B, 0x1E],
    ] {
        let r = region(&bytes);
        let store = stores(&r);
        let load = loads(&r);
        assert_eq!(store.len(), 1);
        assert_eq!(load.len(), 1);
        let store = store[0];
        let load = load[0];
        let mut m = lower(&r).unwrap();
        drop(r);
        assert_eq!(m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(), 1);
        assert_eq!(m.ram_forwarding(store), Some(Forwarding::Begin));
        assert_eq!(
            m.ram_forwarding(load),
            Some(Forwarding::Reuse { previous: store })
        );
        emit_cpu(&m, 32).unwrap();
    }

    for bytes in [
        vec![0x88, 0x06, 0x66, 0x8B, 0x1E], // different widths
        vec![0x89, 0x06, 0x8B, 0x1F],       // ESI vs EDI
        vec![0x89, 0x06, 0x64, 0x8B, 0x1E], // DS vs FS
    ] {
        let r = region(&bytes);
        assert_eq!(
            lower(&r)
                .unwrap()
                .forward_ram_reads(DEFAULT_WORK_LIMIT)
                .unwrap(),
            0
        );
    }
}

#[test]
fn widths_addresses_segments_and_runtime_barriers_are_not_alias_guesses() {
    for bytes in [
        vec![0x8B, 0x06, 0x8A, 0x1E],             // different widths
        vec![0x8B, 0x06, 0x8B, 0x1F],             // ESI vs EDI
        vec![0x8B, 0x06, 0x64, 0x8B, 0x1E],       // DS vs FS
        vec![0x8B, 0x06, 0x46, 0x8B, 0x1E],       // changed offset
        vec![0x8B, 0x06, 0x8B, 0x17, 0x8B, 0x1E], // unrelated read may be MMIO
        vec![0x8B, 0x06, 0x01, 0x1E],             // RMW never reuses ordinary load
    ] {
        let r = region(&bytes);
        assert_eq!(
            lower(&r)
                .unwrap()
                .forward_ram_reads(DEFAULT_WORK_LIMIT)
                .unwrap(),
            0
        );
    }
    // Insert an ordered check/poll between the same-width, same-address reads.
    // A check remains a barrier. A one-unit PollBudget stays in place but its
    // continuation has no guest effect; its observation arm leaves the frame.
    for op in [
        Op::PollBudget,
        Op::GuestCheck {
            bytes: 4,
            write: false,
        },
    ] {
        let mut r = region(&[0x8B, 0x06, 0x8B, 0x1E]);
        let ids = loads(&r);
        let second = ids[1];
        let block = r.instructions[second.index()].block;
        let old_effect = *r.instructions[second.index()].args.last().unwrap();
        let state = r.instructions[second.index()].state;
        let term = r.blocks[block.index()].terminator.take().unwrap();
        let mut args = if matches!(op, Op::GuestCheck { .. }) {
            vec![r.instructions[second.index()].args[0]]
        }
        else {
            vec![]
        };
        args.push(old_effect);
        let new_effect = r.append(block, op, args, &[Type::Effect], state)[0];
        let added = r.blocks[block.index()].instructions.pop().unwrap();
        let at = r.blocks[block.index()]
            .instructions
            .iter()
            .position(|id| *id == second)
            .unwrap();
        r.blocks[block.index()].instructions.insert(at, added);
        *r.instructions[second.index()].args.last_mut().unwrap() = new_effect;
        r.terminate(block, term);
        crate::ir::verify::verify(&r).unwrap();
        let poll = r.instructions[added.index()].op == Op::PollBudget;
        assert_eq!(
            lower(&r)
                .unwrap()
                .forward_ram_reads(DEFAULT_WORK_LIMIT)
                .unwrap(),
            usize::from(poll)
        );
    }
}

#[test]
fn forwarding_failures_are_atomic_and_forged_certificates_are_rejected() {
    let r = region(&[0x8B, 0x06, 0x8B, 0x1E]);
    let ids = loads(&r);
    let mut m = lower(&r).unwrap();
    assert!(m.forward_ram_reads(0).is_err());
    assert!(!m.has_ram_forwarding());
    assert_eq!(m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(), 1);
    let before: Vec<_> = ids.iter().map(|id| m.ram_forwarding(*id)).collect();
    assert!(m.forward_ram_reads(1).is_err());
    assert_eq!(
        before,
        ids.iter()
            .map(|id| m.ram_forwarding(*id))
            .collect::<Vec<_>>()
    );
    for mutation in 0..4 {
        let mut draft = lower_draft(&r).unwrap();
        draft.ram_forwarding = plan(&draft, DEFAULT_WORK_LIMIT).unwrap();
        match mutation {
            0 => draft.ram_forwarding[ids[0].index()] = None,
            1 => {
                draft.ram_forwarding[ids[1].index()] = Some(Forwarding::Reuse { previous: ids[1] })
            },
            2 => draft.ram_forwarding[0] = Some(Forwarding::Begin),
            _ => {
                draft.ram_forwarding.pop();
            },
        }
        assert!(verify(&draft).is_err());
        assert!(draft.finish().is_err(), "forged certificate {mutation}");
    }
}

#[test]
fn forwarding_never_crosses_a_block_boundary_or_external_entry() {
    let bytes = [0x8B, 0x06, 0xEB, 0, 0x8B, 0x1E];
    let r = crate::ir::frontend::region::lift_cpu_cfg(
        &bytes,
        GuestEip(0x100000),
        LinearAddress(0x100000),
        true,
        8,
    )
    .unwrap();
    let ids = loads(&r);
    assert_ne!(
        r.instructions[ids[0].index()].block,
        r.instructions[ids[1].index()].block
    );
    assert_eq!(
        lower(&r)
            .unwrap()
            .forward_ram_reads(DEFAULT_WORK_LIMIT)
            .unwrap(),
        0
    );
    assert!(r
        .blocks
        .iter()
        .any(|b| matches!(b.terminator, Some(Terminator::Branch(_)))));
}

#[test]
fn emits_guarded_forwarding_cpu_corpus_after_dropping_hir() {
    std::fs::create_dir_all("build/ir-forwarding").unwrap();
    let programs = [
        vec![0x8A, 0x06, 0x8A, 0x1E, 0x8A, 0x16],
        vec![0x66, 0x8B, 0x06, 0x66, 0x8B, 0x1E, 0x66, 0x8B, 0x16],
        vec![0x8B, 0x06, 0x8B, 0x1E, 0x8B, 0x16],
        // Reuse the address proof, but still load each distinct access width.
        vec![0x8B, 0x06, 0x66, 0x8B, 0x1E, 0x8A, 0x16],
    ];
    let mut cases = vec![];
    for (n, bytes) in programs.iter().enumerate() {
        for forward in [false, true] {
            let r = region(bytes);
            let mut m = lower(&r).unwrap();
            drop(r);
            if forward {
                if n == 3 {
                    assert_eq!(m.reuse_ram_guards(DEFAULT_WORK_LIMIT).unwrap(), 2);
                }
                else {
                    assert_eq!(m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(), 2);
                }
            }
            assert_eq!(
                m.memory
                    .iter()
                    .flatten()
                    .filter(|p| matches!(p.native, NativeMemory::ScalarLoad { ticket: None, .. }))
                    .count(),
                3
            );
            std::fs::write(
                format!("build/ir-forwarding/{n}-{forward}.wasm"),
                emit_cpu(&m, 32).unwrap().bytes,
            )
            .unwrap();
        }
        for budget in [1, 2, 3, 4, 8] {
            for forward in [false, true] {
                let mut r = crate::ir::frontend::region::lift_cpu_cfg(
                    bytes,
                    GuestEip(0x100000),
                    LinearAddress(0x100000),
                    true,
                    8,
                )
                .unwrap();
                run(&mut r, PassConfig::default()).unwrap();
                let mut m = lower(&r).unwrap();
                drop(r);
                assert!(m.control.polls.iter().any(Option::is_some));
                if forward {
                    if n == 3 {
                        assert_eq!(m.reuse_ram_guards(DEFAULT_WORK_LIMIT).unwrap(), 2);
                    }
                    else {
                        assert_eq!(m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(), 2);
                    }
                }
                std::fs::write(
                    format!("build/ir-forwarding/cfg-{n}-{budget}-{forward}.wasm"),
                    emit_cpu(&m, budget).unwrap().bytes,
                )
                .unwrap();
            }
        }
        cases.push(format!("{bytes:?}"));
    }
    std::fs::write(
        "build/ir-forwarding/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn emits_guarded_loop_cache_cpu_corpus_after_dropping_hir() {
    std::fs::create_dir_all("build/ir-forwarding").unwrap();
    let budgets = [1u32, 2, 3, 4, 8, 64];
    let addresses = [0x310040u32, 0x0A0040u32];
    let mut programs = Vec::new();

    for (case, address) in addresses.into_iter().enumerate() {
        // NOP; loop: MOV EAX,moffs32; DEC ECX; JNZ loop.
        // The NOP is a real unique preheader. The first load stays at its
        // original fault point; only later successful native-RAM iterations
        // may reuse the loop cache.
        let bytes = vec![
            0x90,
            0xA1,
            address as u8,
            (address >> 8) as u8,
            (address >> 16) as u8,
            (address >> 24) as u8,
            0x49,
            0x75,
            0xF8,
        ];
        for budget in budgets {
            for cached in [false, true] {
                let mut r = crate::ir::frontend::region::lift_cpu_cfg(
                    &bytes,
                    GuestEip(0x100000),
                    LinearAddress(0x100000),
                    true,
                    16,
                )
                .unwrap();
                run(&mut r, PassConfig::default()).unwrap();
                let mut m = lower(&r).unwrap();
                drop(r);
                if cached {
                    assert_eq!(
                        m.cache_loop_invariant_ram_reads(DEFAULT_WORK_LIMIT)
                            .unwrap(),
                        1
                    );
                    assert_eq!(m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(), 0);
                }
                std::fs::write(
                    format!("build/ir-forwarding/loop-{case}-{budget}-{cached}.wasm"),
                    emit_cpu(&m, budget).unwrap().bytes,
                )
                .unwrap();
            }
        }
        programs.push(format!("{{\"address\":{address},\"bytes\":{bytes:?}}}"));
    }
    std::fs::write(
        "build/ir-forwarding/loops.json",
        format!(
            "{{\"budgets\":{:?},\"cases\":[{}]}}",
            budgets,
            programs.join(",")
        ),
    )
    .unwrap();
}

#[test]
fn disjoint_constant_store_preserves_an_existing_load_chain() {
    // MOV EAX,[0x2000]; MOV [0x2010],EBX; MOV ECX,[0x2000].
    // The middle store has a distinct page offset even if two virtual pages
    // alias the same physical page. Its slow path returns; only the proven
    // disjoint native continuation can reach the final load.
    let bytes = [
        0x8B, 0x05, 0x00, 0x20, 0x00, 0x00, 0x89, 0x1D, 0x10, 0x20, 0x00, 0x00, 0x8B, 0x0D, 0x00,
        0x20, 0x00, 0x00,
    ];
    let r = region(&bytes);
    let ids = loads(&r);
    assert_eq!(ids.len(), 2);
    let mut m = lower(&r).unwrap();
    assert_eq!(m.forward_ram_reads(DEFAULT_WORK_LIMIT).unwrap(), 1);
    assert_eq!(m.ram_forwarding(ids[0]), Some(Forwarding::Begin));
    assert_eq!(
        m.ram_forwarding(ids[1]),
        Some(Forwarding::Reuse { previous: ids[0] })
    );
    emit_cpu(&m, 32).unwrap();

    // A different virtual page with the same page offset may physically alias
    // the first load, so it is deliberately MayAlias and kills the old proof.
    let page_alias = [
        0x8B, 0x05, 0x00, 0x20, 0x00, 0x00, 0x89, 0x1D, 0x00, 0x30, 0x00, 0x00, 0x8B, 0x0D, 0x00,
        0x20, 0x00, 0x00,
    ];
    let r = region(&page_alias);
    assert_eq!(
        lower(&r)
            .unwrap()
            .forward_ram_reads(DEFAULT_WORK_LIMIT)
            .unwrap(),
        0
    );

    // Overlap in the same page is also MayAlias.
    let overlapping = [
        0x8B, 0x05, 0x00, 0x20, 0x00, 0x00, 0x89, 0x1D, 0x02, 0x20, 0x00, 0x00, 0x8B, 0x0D, 0x00,
        0x20, 0x00, 0x00,
    ];
    let r = region(&overlapping);
    assert_eq!(
        lower(&r)
            .unwrap()
            .forward_ram_reads(DEFAULT_WORK_LIMIT)
            .unwrap(),
        0
    );
}

#[test]
fn loop_invariant_load_cache_keeps_first_fault_point_and_resets_at_preheader() {
    // Entry preheader JMPs into:
    //   mov eax,[0x2000]
    //   dec ecx
    //   jnz loop
    // The load itself remains in place. Only after a successful native RAM
    // access may later iterations reuse its dedicated cache.
    let bytes = [0x90, 0x8B, 0x05, 0x00, 0x20, 0x00, 0x00, 0x49, 0x75, 0xF7];
    let r = crate::ir::frontend::region::lift_cpu_cfg(
        &bytes,
        GuestEip(0x100000),
        LinearAddress(0x100000),
        true,
        16,
    )
    .unwrap();
    let ids = loads(&r);
    assert_eq!(ids.len(), 1);
    let mut m = lower(&r).unwrap();
    assert_eq!(
        m.cache_loop_invariant_ram_reads(DEFAULT_WORK_LIMIT)
            .unwrap(),
        1
    );
    let proof = m.ram_loop_cache(ids[0]).expect("loop cache proof");
    assert_eq!(proof.slot, 0);
    let reset_blocks: Vec<_> = (0..m.control.blocks.len())
        .filter(|&block| {
            m.ram_loop_resets(BlockId(block as u32))
                .contains(&proof.slot)
        })
        .collect();
    assert_eq!(reset_blocks.len(), 1);
    emit_cpu(&m, 32).unwrap();

    // A guest store in the loop prevents loop caching rather than guessing
    // alias or mapping stability.
    let with_store = [
        0x90, 0x8B, 0x05, 0x00, 0x20, 0x00, 0x00, 0xA3, 0x00, 0x30, 0x00, 0x00, 0x49, 0x75, 0xF2,
    ];
    let r = crate::ir::frontend::region::lift_cpu_cfg(
        &with_store,
        GuestEip(0x100000),
        LinearAddress(0x100000),
        true,
        24,
    )
    .unwrap();
    let mut m = lower(&r).unwrap();
    assert_eq!(
        m.cache_loop_invariant_ram_reads(DEFAULT_WORK_LIMIT)
            .unwrap(),
        0
    );
}

#[test]
fn forged_loop_cache_certificate_is_rejected_atomically() {
    let bytes = [0x90, 0x8B, 0x05, 0x00, 0x20, 0x00, 0x00, 0x49, 0x75, 0xF7];
    let r = crate::ir::frontend::region::lift_cpu_cfg(
        &bytes,
        GuestEip(0x100000),
        LinearAddress(0x100000),
        true,
        16,
    )
    .unwrap();
    let mut draft = lower_draft(&r).unwrap();
    draft.ram_loop_cache = loop_plan(&draft, DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(draft.ram_loop_cache.slots, 1);
    let reset = draft
        .ram_loop_cache
        .resets
        .iter()
        .position(|slots| !slots.is_empty())
        .unwrap();
    draft.ram_loop_cache.resets[reset].clear();
    assert!(verify(&draft).is_err());
    assert!(draft.finish().is_err());
}

#[test]
fn guard_reuse_proves_range_permission_and_rejects_forgery() {
    for bytes in [
        vec![0x8A, 0x06, 0x8B, 0x1E], // narrow read does not prove wider access
        vec![0x8B, 0x06, 0x89, 0x1E], // read does not prove write permission
        vec![0x8B, 0x06, 0x66, 0x8B, 0x1F], // different offset
        vec![0x8B, 0x06, 0x64, 0x66, 0x8B, 0x1E], // different segment
        vec![0x8B, 0x06, 0x8B, 0x17, 0x66, 0x8B, 0x1E], // intervening possible MMIO
    ] {
        assert_eq!(
            lower(&region(&bytes))
                .unwrap()
                .reuse_ram_guards(DEFAULT_WORK_LIMIT)
                .unwrap(),
            0
        );
    }
    let r = region(&[0x89, 0x06, 0x66, 0x8B, 0x1E]);
    let mut m = lower(&r).unwrap();
    assert!(m.reuse_ram_guards(0).is_err());
    assert_eq!(m.reuse_ram_guards(DEFAULT_WORK_LIMIT).unwrap(), 1);
    assert!(m.reuse_ram_guards(0).is_err());
    emit_cpu(&m, 32).unwrap();
    let ids = loads(&r);
    for mutation in 0..3 {
        let mut draft = lower_draft(&r).unwrap();
        draft.ram_guard_reuse = super::guard_plan(&draft, DEFAULT_WORK_LIMIT).unwrap();
        match mutation {
            0 => {
                draft.ram_guard_reuse[ids[0].index()] = Some(Forwarding::Reuse { previous: ids[0] })
            },
            1 => {
                draft.ram_guard_reuse.pop();
            },
            _ => {
                for p in &mut draft.ram_guard_reuse {
                    if *p == Some(Forwarding::Begin) {
                        *p = None;
                    }
                }
            },
        }
        assert!(draft.finish().is_err());
    }
}
