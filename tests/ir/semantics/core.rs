use crate::ir::{
    backend::wasm::{emit, StateLayout},
    builder::SsaBuilder,
    effects::Effects,
    frontend::decode::GuestEip,
    helper::*,
    hir::*,
    ids::*,
    lowering::lower,
    state::*,
    types::Type,
    verify::verify,
};
fn constant(r: &mut Region, b: BlockId, n: u64, ty: Type) -> ValueId {
    r.append(b, Op::Const(n), vec![], &[ty], None)[0]
}
fn state(
    r: &mut Region,
    x: ValueId,
    y: ValueId,
    n: ValueId,
    zero: ValueId,
    flag: ValueId,
) -> StateId {
    r.state(StateMap {
        instruction_pc: GuestEip(0x1000),
        next_pc: GuestEip(0x1002),
        next_value: None,
        resume: ResumeKind::BeforeInstruction,
        gpr: [x, y, n, zero, zero, zero, zero, zero],
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
        committed_instructions: 0,
        count_base: None,
        rep_progress: None,
    })
}
fn edge(target: BlockId, args: Vec<ValueId>) -> Edge { Edge { target, args } }
pub(super) fn loop_region() -> Region {
    let mut r = Region::default();
    let a = r.block(true);
    let b = r.block(true);
    let h = r.block(false);
    let out = r.block(false);
    let x = r.param(h, Type::I32);
    let y = r.param(h, Type::I32);
    let n = r.param(h, Type::I32);
    let zero = r.param(h, Type::I32);
    let flag = r.param(h, Type::I1);
    for (entry, initial) in [(a, [1, 2, 5]), (b, [10, 20, 4])] {
        let mut args: Vec<_> = initial
            .iter()
            .map(|&n| constant(&mut r, entry, n, Type::I32))
            .collect();
        args.push(constant(&mut r, entry, 0, Type::I32));
        args.push(constant(&mut r, entry, 0, Type::I1));
        r.terminate(entry, Terminator::Branch(edge(h, args)));
    }
    let map = state(&mut r, x, y, n, zero, flag);
    r.blocks[h.index()].entry_state = Some(map);
    r.blocks[out.index()].entry_state = Some(map);
    let one = constant(&mut r, h, 1, Type::I32);
    let next = r.append(h, Op::Binary(Binary::Sub), vec![n, one], &[Type::I32], None)[0];
    let condition = r.append(h, Op::Binary(Binary::Eq), vec![n, zero], &[Type::I1], None)[0];
    r.terminate(
        h,
        Terminator::CondBranch {
            condition,
            taken: edge(out, vec![]),
            not_taken: edge(h, vec![y, x, next, zero, flag]),
        },
    );
    r.terminate(out, Terminator::Exit(map));
    r
}
#[test]
fn executable_loops_multientry_parallel_copies_and_budget_maps() {
    let r = loop_region();
    verify(&r).unwrap();
    let mir = lower(&r).unwrap();
    assert!(
        crate::ir::backend::wasm::emit_cpu(&mir, 100).is_err(),
        "CPU loops require dynamic commit accounting"
    );
    assert!(mir.allocation.local_types.len() < r.values.len());
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    std::fs::create_dir_all("build/ir-wasm").unwrap();
    for budget in [3, 100] {
        let artifact = emit(&mir, layout, budget).unwrap();
        std::fs::write(
            format!("build/ir-wasm/ssa-loop-{budget}.wasm"),
            artifact.bytes,
        )
        .unwrap();
    }
}
#[test]
fn verifier_rejects_bad_edges_types_and_dominance() {
    let mut r = loop_region();
    r.blocks[0].terminator.as_mut().unwrap().edges_mut()[0]
        .args
        .pop();
    assert!(verify(&r).unwrap_err().0.contains("edge arity"));
    let mut r = loop_region();
    r.values[0].ty = Type::F64;
    assert!(verify(&r).is_err());
    let mut r = loop_region();
    let from_entry_a = r.instructions[r.blocks[0].instructions[0].index()].results[0];
    let id = r.blocks[1].instructions[0];
    r.instructions[id.index()].op = Op::Binary(Binary::Add);
    r.instructions[id.index()].args = vec![from_entry_a, from_entry_a];
    assert!(verify(&r).unwrap_err().0.contains("dominate"));
    let mut r = loop_region();
    let id = r.blocks[0].instructions[0];
    let own = r.instructions[id.index()].results[0];
    r.instructions[id.index()].op = Op::Binary(Binary::Add);
    r.instructions[id.index()].args = vec![own, own];
    assert!(verify(&r).unwrap_err().0.contains("before definition"));
}
#[test]
fn effects_and_helper_exception_ownership() {
    let mut r = Region::default();
    let a = r.block(true);
    let token = r.param(a, Type::Effect);
    let zero = constant(&mut r, a, 0, Type::I32);
    let flag = constant(&mut r, a, 0, Type::I1);
    let map = state(&mut r, zero, zero, zero, zero, flag);
    r.helpers.push(HelperDescriptor::conservative(
        "legacy_system".into(),
        vec![],
        vec![],
    ));
    let token2 = r.append(
        a,
        Op::CallHelper(HelperId(0)),
        vec![token],
        &[Type::Effect],
        Some(map),
    )[0];
    r.append(a, Op::PollBudget, vec![token2], &[Type::Effect], Some(map));
    r.terminate(a, Terminator::Exit(map));
    verify(&r).unwrap();
    let id = *r.blocks[0].instructions.last().unwrap();
    r.instructions[id.index()].args[0] = token;
    assert!(verify(&r).unwrap_err().0.contains("effect chain"));
    assert_eq!(
        after_call(&r.helpers[0], Outcome::ControlTransferred),
        Ok(AdapterAction::ExitWithoutRestore)
    );
    assert!(after_call(&r.helpers[0], Outcome::FaultNeedsDelivery).is_err());
    assert_eq!(
        after_call(&r.helpers[0], Outcome::Yield),
        Ok(AdapterAction::ExitWithoutRestore)
    );
    assert_eq!(
        after_call(&r.helpers[0], Outcome::Invalidated),
        Ok(AdapterAction::ExitWithoutRestore)
    );
    let mut caller = r.helpers[0].clone();
    caller.exception_owner = ExceptionOwner::Caller;
    assert_eq!(
        after_call(&caller, Outcome::FaultNeedsDelivery),
        Ok(AdapterAction::RestoreAndDeliver)
    );
    let pure = HelperDescriptor {
        name: "pure".into(),
        params: vec![],
        results: vec![],
        effects: Effects::pure(),
        exception_owner: ExceptionOwner::CannotFault,
        abi: HelperAbi::Unadapted,
    };
    assert!(after_call(&pure, Outcome::ControlTransferred).is_err());
}
#[test]
fn sealed_ssa_loop_and_uninitialized_entry() {
    let mut s = SsaBuilder::new(vec![Type::I32, Type::I1]);
    let entry = s.block(true);
    let header = s.block(false);
    let body = s.block(false);
    let out = s.block(false);
    let zero = constant(&mut s.region, entry, 0, Type::I32);
    let flag = constant(&mut s.region, entry, 0, Type::I1);
    s.write(entry, 0, zero);
    s.write(entry, 1, flag);
    s.terminate(entry, Terminator::Branch(edge(header, vec![])))
        .unwrap();
    s.seal(entry);
    let x = s.read(header, 0).unwrap();
    let f = s.read(header, 1).unwrap();
    let ten = constant(&mut s.region, header, 10, Type::I32);
    let c = s.region.append(
        header,
        Op::Binary(Binary::Eq),
        vec![x, ten],
        &[Type::I1],
        None,
    )[0];
    s.terminate(
        header,
        Terminator::CondBranch {
            condition: c,
            taken: edge(out, vec![]),
            not_taken: edge(body, vec![]),
        },
    )
    .unwrap();
    s.seal(body);
    let bx = s.read(body, 0).unwrap();
    let one = constant(&mut s.region, body, 1, Type::I32);
    let next = s.region.append(
        body,
        Op::Binary(Binary::Add),
        vec![bx, one],
        &[Type::I32],
        None,
    )[0];
    s.write(body, 0, next);
    s.terminate(body, Terminator::Branch(edge(header, vec![])))
        .unwrap();
    s.seal(header);
    s.seal(out);
    let result = s.read(out, 0).unwrap();
    let map = state(&mut s.region, result, result, result, zero, f);
    s.terminate(out, Terminator::Exit(map)).unwrap();
    let mut r = s.finish().unwrap();
    verify(&r).unwrap();
    let stats = crate::ir::passes::run(&mut r, Default::default()).unwrap();
    assert!(stats.phis > 0);
    let mut s = SsaBuilder::new(vec![Type::I32]);
    let a = s.block(true);
    s.seal(a);
    assert!(s.read(a, 0).is_err());
}

#[test]
fn register_lowering_corpus() {
    use crate::ir::frontend::decode::LinearAddress;
    use crate::ir::{
        frontend::lift::lift,
        passes::{run, PassConfig},
    };
    let mut programs: Vec<Vec<u8>> = Vec::new();
    for group in 0..8u8 {
        for width in [8, 16, 32] {
            for direction in [0, 2] {
                for (a, b) in [
                    (0, 3),
                    (3, 3),
                    (
                        if width == 8 { 4 } else { 1 },
                        if width == 8 { 7 } else { 2 },
                    ),
                ] {
                    let mut bytes = if width == 16 { vec![0x66] } else { vec![] };
                    bytes.extend([
                        group * 8 + direction + (width != 8) as u8,
                        0xC0 | b << 3 | a,
                    ]);
                    programs.push(bytes);
                }
            }
        }
    }
    for group in 0..8u8 {
        for (prefix, opcode, imm) in [
            (vec![], 0x80, vec![0xFF]),
            (vec![], 0x82, vec![0x81]),
            (vec![0x66], 0x82, vec![0x7F]),
            (vec![0x66], 0x81, vec![0xFF, 0x7F]),
            (vec![], 0x81, vec![0xFF, 0xFF, 0xFF, 0x7F]),
            (vec![], 0x83, vec![0xFF]),
        ] {
            let mut bytes = prefix;
            bytes.extend([opcode, 0xC0 | group << 3]);
            bytes.extend(imm);
            programs.push(bytes);
        }
    }
    for cc in 0..16u8 {
        for producer in [vec![0x01, 0xD8], vec![0x19, 0xD8], vec![0x66, 0x39, 0xD8]] {
            let mut p = producer.clone();
            p.extend([0xB4, 0x12, 0x0F, 0x90 | cc, 0xC2]);
            programs.push(p);
            let mut p = producer;
            p.extend([0x0F, 0x40 | cc, 0xCB]);
            programs.push(p);
        }
    }
    programs.extend([
        vec![0x40],
        vec![0x48],
        vec![0x66, 0x40],
        vec![0x66, 0x48],
        vec![0xFE, 0xC4],
        vec![0xFE, 0xCC],
        vec![0xF6, 0xCC, 0xA5], // TEST AH, imm8: baseline group-1 alias
        vec![0x66, 0xF7, 0xCB, 0x01, 0x80],
        vec![0xF7, 0xCA, 0x01, 0x00, 0x00, 0x80],
        vec![0xF6, 0xD4],
        vec![0xF6, 0xDC],
        vec![0xF7, 0xD0],
        vec![0xF7, 0xD8],
        vec![0xF9, 0x40, 0x14, 0xFF],
        vec![0xF8, 0x48, 0x1C, 1],
        vec![0xF5],
        vec![0x84, 0xFC],
        vec![0xA9, 0xFF, 0xFF, 0, 0],
        vec![0xB4, 0xFE, 0xB0, 0xEF, 0x66, 0x89, 0xD8],
        vec![0x86, 0xE0],
        vec![0x93],
        vec![0x0F, 0xBE, 0xC4],
        vec![0x0F, 0xB7, 0xD8],
        vec![0x66, 0x0F, 0xBF, 0xD8],
        vec![0x8D, 0x44, 0x98, 0xFC],
        vec![0x67, 0x66, 0x8D, 0x40, 0xFD],
        vec![0xC6, 0xC4, 7, 0x66, 0xC7, 0xC3, 0x34, 0x12],
    ]);
    std::fs::create_dir_all("build/ir-integer").unwrap();
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    let mut manifest = Vec::new();
    for (i, bytes) in programs.iter().enumerate() {
        let mut r = lift(bytes, GuestEip(0x1000), LinearAddress(0x1000), true).unwrap();
        for optimized in [false, true] {
            if optimized {
                run(&mut r, PassConfig::default()).unwrap();
            }
            let artifact = emit(&lower(&r).unwrap(), layout, 100).unwrap();
            std::fs::write(
                format!("build/ir-integer/{i}-{}.wasm", optimized as u8),
                artifact.bytes,
            )
            .unwrap();
        }
        manifest.push(format!("{:?}", bytes));
    }
    std::fs::write(
        "build/ir-integer/programs.json",
        format!("[{}]", manifest.join(",")),
    )
    .unwrap();
    // Faulting and privileged forms must be explicit pending work.
    for bytes in [
        vec![0x8B, 0x00],
        vec![0xF0, 0x01, 0xD8],
        vec![0xF7, 0xF3],
        vec![0x0F, 0x20, 0xC0],
    ] {
        assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
    }
}

#[test]
fn dce_keeps_snapshot_only_values_and_ordered_helpers() {
    use crate::ir::passes::{run, PassConfig};
    let mut r = Region::default();
    let a = r.block(true);
    let effect = r.param(a, Type::Effect);
    let zero = constant(&mut r, a, 0, Type::I32);
    let flag = constant(&mut r, a, 0, Type::I1);
    let one = constant(&mut r, a, 1, Type::I32);
    let snapshot_only = r.append(
        a,
        Op::Binary(Binary::Add),
        vec![one, one],
        &[Type::I32],
        None,
    )[0];
    let map = state(&mut r, snapshot_only, zero, zero, zero, flag);
    r.helpers.push(HelperDescriptor::conservative(
        "observer".into(),
        vec![],
        vec![],
    ));
    r.append(
        a,
        Op::CallHelper(HelperId(0)),
        vec![effect],
        &[Type::Effect],
        Some(map),
    );
    let exit = state(&mut r, zero, zero, zero, zero, flag);
    r.terminate(a, Terminator::Exit(exit));
    let stats = run(
        &mut r,
        PassConfig {
            debug: Default::default(),
            disabled: 0,
            prune: false,
            merge: false,
            phis: false,
            copy: false,
            flags: false,
            state_sync: false,
            helper_state: false,
            fold: false,
            gvn: false,
            dce: true,
            rounds: 1,
        },
    )
    .unwrap();
    assert_eq!(stats.removed, 0);
    let Definition::Instruction(id, _) = r.values[snapshot_only.index()].definition
    else {
        panic!()
    };
    assert!(r.blocks[0].instructions.contains(&id));
}

#[test]
fn immutable_compile_requests_and_stale_publication_checks() {
    use crate::ir::frontend::decode::{LinearAddress, PhysicalAddress};
    use crate::ir::runtime::compile::*;
    use crate::ir::runtime::entry::EntryContract;
    let key = PublicationKey {
        job: 1,
        vm_generation: 1,
        slot: 7,
        slot_generation: 1,
    };
    let request = CompileRequest {
        key,
        pc: GuestEip(0x2000),
        linear: LinearAddress(0x2000),
        default_32: true,
        tier: Tier::One,
    };
    let config = IrConfig {
        optimize: true,
        passes: Default::default(),
        execution_budget: 100,
        rep_iteration_budget: 128,
        max_code_bytes: 128,
        layout: StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
    };
    let snapshot = ImmutableCodeSnapshot {
        bytes: vec![0x40],
        mappings: vec![CodeMapping {
            linear: LinearAddress(0x2000),
            physical: PhysicalAddress(0x3000),
        }],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(0x3000),
            version: 1,
        }],
    };
    let artifact = compile_region(&request, &snapshot, &config).unwrap();
    assert!(artifact.current(
        key,
        &snapshot.dependencies,
        EntryContract::Standalone,
        &snapshot.mappings
    ));
    for stale in [
        PublicationKey { job: 2, ..key },
        PublicationKey {
            vm_generation: 2,
            ..key
        },
        PublicationKey { slot: 8, ..key },
        PublicationKey {
            slot_generation: 2,
            ..key
        },
    ] {
        assert!(!artifact.current(
            stale,
            &snapshot.dependencies,
            EntryContract::Standalone,
            &snapshot.mappings
        ));
    }
    assert!(!artifact.current(
        key,
        &[CodeDependency {
            version: 2,
            ..snapshot.dependencies[0]
        }],
        EntryContract::Standalone,
        &snapshot.mappings
    ));
    let bad = ImmutableCodeSnapshot {
        bytes: vec![0x8B, 0x00],
        ..snapshot.clone()
    };
    assert!(compile_region(&request, &bad, &config).is_err());
    let bad = ImmutableCodeSnapshot {
        dependencies: vec![],
        ..snapshot
    };
    assert!(compile_region(&request, &bad, &config).is_err());
}

#[test]
fn terminal_branch_corpus() {
    use crate::ir::frontend::{decode::LinearAddress, lift::lift};
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    std::fs::create_dir_all("build/ir-branches").unwrap();
    let mut manifest = Vec::new();
    for cc in 0..16u8 {
        for (mode32, bytes, displacement, operand32) in [
            (true, vec![0x70 | cc, 0xFE], -2i32, true),
            (false, vec![0x0F, 0x80 | cc, 0xFC, 0xFF], -4, false),
            (true, vec![0x66, 0x0F, 0x80 | cc, 0xFC, 0xFF], -4, false),
            (
                true,
                vec![0x0F, 0x80 | cc, 0xFC, 0xFF, 0xFF, 0xFF],
                -4,
                true,
            ),
        ] {
            let index = manifest.len();
            let mut r = lift(&bytes, GuestEip(0xFFFC), LinearAddress(0x1FFFC), mode32).unwrap();
            for opt in 0..2 {
                if opt == 1 {
                    crate::ir::passes::run(&mut r, Default::default()).unwrap();
                }
                let artifact = emit(&lower(&r).unwrap(), layout, 100).unwrap();
                std::fs::write(
                    format!("build/ir-branches/{index}-{opt}.wasm"),
                    artifact.bytes,
                )
                .unwrap();
            }
            manifest.push(format!("[{cc},{},{displacement},{operand32}]", bytes.len()));
        }
    }
    std::fs::write(
        "build/ir-branches/cases.json",
        format!("[{}]", manifest.join(",")),
    )
    .unwrap();
}

#[test]
fn allocator_budget_is_a_compile_stop() {
    let mut r = Region::default();
    let a = r.block(true);
    let b = r.block(false);
    let zero = constant(&mut r, a, 0, Type::I32);
    let flag = constant(&mut r, a, 0, Type::I1);
    let mut args = Vec::new();
    for i in 0..513 {
        r.param(b, Type::I32);
        args.push(constant(&mut r, a, i, Type::I32));
    }
    r.terminate(a, Terminator::Branch(edge(b, args)));
    let map = state(&mut r, zero, zero, zero, zero, flag);
    r.blocks[b.index()].entry_state = Some(map);
    r.terminate(b, Terminator::Exit(map));
    verify(&r).unwrap();
    assert!(matches!(
        lower(&r),
        Err(crate::ir::lowering::CompileError::Budget(_))
    ));
}
