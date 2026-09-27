use super::{run, DEFAULT_WORK_LIMIT};
use crate::ir::{
    backend::wasm::{emit, StateLayout},
    frontend::{decode::GuestEip, integer::IntegerBuilder},
    hir::*,
    ids::*,
    lowering::lower,
    state::{FlagState, ResumeKind, StateMap},
    types::Type,
    verify::verify,
};

fn snapshot(r: &mut Region, gpr: [ValueId; 8], flags: &FlagState, pc: u32) -> StateId {
    r.state(StateMap {
        instruction_pc: GuestEip(pc),
        next_pc: GuestEip(pc + 1),
        next_value: None,
        resume: ResumeKind::BeforeInstruction,
        gpr,
        flags: flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 0,
        count_base: None,
        rep_progress: None,
    })
}

// sum += (input[2] + input[3]) * input[4], repeated input[0] times.
// Exit is intentionally allocated before body, not in execution order.
fn counted_loop() -> (Region, ValueId, ValueId, ValueId) {
    let mut b = IntegerBuilder::new();
    let input = b.gpr;
    let flags = b.flags.clone();
    let entry = b.block;
    let zero = b.constant(0, Type::I32);
    let header = b.region.block(false);
    let exit = b.region.block(false);
    let body = b.region.block(false);
    let he = b.region.param(header, Type::Effect);
    let count = b.region.param(header, Type::I32);
    let sum = b.region.param(header, Type::I32);
    let be = b.region.param(body, Type::Effect);
    let _xe = b.region.param(exit, Type::Effect);
    b.region.terminate(
        entry,
        Terminator::Branch(Edge {
            target: header,
            args: vec![b.effect, input[0], zero],
        }),
    );
    b.gpr[0] = count;
    b.gpr[1] = sum;
    for block in [header, body, exit] {
        let state = snapshot(&mut b.region, b.gpr, &flags, 0x2000 + block.0);
        b.region.blocks[block.index()].entry_state = Some(state);
    }
    b.block = header;
    let done = b.binary(Binary::Eq, count, zero);
    b.region.terminate(
        header,
        Terminator::CondBranch {
            condition: done,
            taken: Edge {
                target: exit,
                args: vec![he],
            },
            not_taken: Edge {
                target: body,
                args: vec![he],
            },
        },
    );
    b.block = body;
    let invariant = b.binary(Binary::Add, input[2], input[3]);
    let dependent = b.binary(Binary::Mul, invariant, input[4]);
    let next_sum = b.binary(Binary::Add, sum, dependent);
    let one = b.constant(1, Type::I32);
    let next_count = b.binary(Binary::Sub, count, one);
    let poll = b.region.append(
        body,
        Op::PollBudget,
        vec![be],
        &[Type::Effect],
        b.region.blocks[body.index()].entry_state,
    )[0];
    b.region.terminate(
        body,
        Terminator::Branch(Edge {
            target: header,
            args: vec![poll, next_count, next_sum],
        }),
    );
    let state = snapshot(&mut b.region, b.gpr, &flags, 0x3000);
    b.region.terminate(exit, Terminator::Exit(state));
    (b.region, invariant, dependent, poll)
}

fn owner(region: &Region, value: ValueId) -> BlockId {
    let Definition::Instruction(id, _) = region.values[value.index()].definition
    else {
        panic!("expected instruction result")
    };
    region.instructions[id.index()].block
}

#[test]
fn hoists_transitive_invariants_but_not_loop_state_or_polls() {
    let (mut r, invariant, dependent, poll) = counted_loop();
    verify(&r).unwrap();
    let maps = format!("{:?}", r.states);
    let before = r.instructions.len();
    let stats = run(&mut r, DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.loops, 1);
    assert_eq!(stats.hoisted, 3);
    assert_eq!(owner(&r, invariant), BlockId(0));
    assert_eq!(owner(&r, dependent), BlockId(0));
    assert_eq!(owner(&r, poll), BlockId(3));
    assert_eq!(r.instructions.len(), before);
    assert_eq!(format!("{:?}", r.states), maps);
    verify(&r).unwrap();
    lower(&r).unwrap();
    assert_eq!(run(&mut r, DEFAULT_WORK_LIMIT).unwrap().hoisted, 0);
}

#[test]
fn failure_is_atomic_even_after_partial_planning() {
    let (r, _, _, _) = counted_loop();
    let full = run(&mut r.clone(), DEFAULT_WORK_LIMIT).unwrap();
    for limit in [0, 1, full.work / 2, full.work - 1] {
        let mut candidate = r.clone();
        let before = format!("{candidate:?}");
        assert!(run(&mut candidate, limit).is_err(), "limit {limit}");
        assert_eq!(format!("{candidate:?}"), before);
    }
    let mut invalid = r;
    invalid.instructions[0].block = BlockId(999);
    let before = format!("{invalid:?}");
    assert!(run(&mut invalid, DEFAULT_WORK_LIMIT).is_err());
    assert_eq!(format!("{invalid:?}"), before);
    let mut oversized = Region::default();
    for _ in 0..65 {
        oversized.block(true);
    }
    assert_eq!(
        run(&mut oversized, DEFAULT_WORK_LIMIT).unwrap_err(),
        "LICM region budget exceeded"
    );
}

fn graph(edges: &[&[usize]], entries: &[usize]) -> Region {
    let mut r = Region::default();
    for b in 0..edges.len() {
        r.block(entries.contains(&b));
    }
    for (b, successors) in edges.iter().enumerate() {
        let block = BlockId(b as u32);
        r.append(block, Op::Const(42), vec![], &[Type::I32], None);
        let edge = |target: usize| Edge {
            target: BlockId(target as u32),
            args: vec![],
        };
        let term = match *successors {
            [target] => Terminator::Branch(edge(*target)),
            [taken, not_taken] => {
                let condition = r.append(block, Op::Const(1), vec![], &[Type::I1], None)[0];
                Terminator::CondBranch {
                    condition,
                    taken: edge(*taken),
                    not_taken: edge(*not_taken),
                }
            },
            _ => panic!("fixture needs one or two edges"),
        };
        r.terminate(block, term);
    }
    verify(&r).unwrap();
    r
}

#[test]
fn skips_external_headers_multiple_entries_and_conditional_preheaders() {
    for mut r in [
        graph(&[&[1], &[2], &[1]], &[0, 1]),
        graph(&[&[1, 2], &[2], &[1]], &[0]),
        graph(&[&[1, 2], &[1], &[2]], &[0]),
        graph(&[&[1], &[2], &[1], &[1]], &[0, 3]),
    ] {
        let before = format!("{r:?}");
        assert_eq!(run(&mut r, DEFAULT_WORK_LIMIT).unwrap().hoisted, 0);
        assert_eq!(format!("{r:?}"), before);
    }
}

#[test]
fn handles_self_loops_multiple_latches_and_nested_loops() {
    let mut self_loop = graph(&[&[1], &[1]], &[0]);
    assert_eq!(run(&mut self_loop, DEFAULT_WORK_LIMIT).unwrap().hoisted, 1);
    let mut latches = graph(&[&[1], &[2, 3], &[1], &[1]], &[0]);
    let stats = run(&mut latches, DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.loops, 1);
    assert_eq!(stats.hoisted, 4);
    let mut nested = graph(&[&[1], &[2], &[3, 4], &[2], &[1]], &[0]);
    let stats = run(&mut nested, DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.loops, 2);
    assert!(stats.hoisted >= 5);
    verify(&nested).unwrap();
    assert_eq!(run(&mut nested, DEFAULT_WORK_LIMIT).unwrap().hoisted, 0);
}

#[test]
fn whitelist_rejects_observations_faults_and_metadata() {
    let (r, invariant, _, _) = counted_loop();
    let Definition::Instruction(id, _) = r.values[invariant.index()].definition
    else {
        panic!()
    };
    let pure = &r.instructions[id.index()];
    assert!(super::eligible(pure));
    for op in [
        Op::ReadGpr(0),
        Op::ReadXmm(0),
        Op::ReadFlags,
        Op::ReadRawFlags,
        Op::ReadFlagChanges,
        Op::ReadFlagOperand,
        Op::ReadStack32,
        Op::ReadSegment(0),
        Op::GuestLoad { bytes: 4 },
        Op::GuestStore { bytes: 4 },
        Op::GuestCheck {
            bytes: 4,
            write: false,
        },
        Op::PollBudget,
        Op::SseCheck,
        Op::Divide {
            bits: 32,
            signed: true,
        },
        Op::CallHelper(HelperId(0)),
        Op::LinearOffset,
        Op::RmwLoad {
            bytes: 4,
            order: RmwOrder::Locked,
        },
    ] {
        let mut inst = pure.clone();
        inst.op = op;
        assert!(!super::eligible(&inst), "{:?}", inst.op);
    }
    for flag in 0..4 {
        let mut inst = pure.clone();
        match flag {
            0 => inst.state = Some(StateId(0)),
            1 => inst.commit = Some(StateId(0)),
            2 => inst.trap_after_fault = true,
            _ => inst.unmasked_word_store = true,
        }
        assert!(!super::eligible(&inst));
    }
}

#[test]
fn emits_optimized_and_unoptimized_budgeted_loops() {
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    std::fs::create_dir_all("build/ir-licm").unwrap();
    for budget in [1, 2, 3, 4, 5, 8, 17, 100] {
        for opt in [false, true] {
            let (mut r, _, _, _) = counted_loop();
            if opt {
                assert_eq!(run(&mut r, DEFAULT_WORK_LIMIT).unwrap().hoisted, 3);
            }
            let mir = lower(&r).unwrap();
            drop(r);
            std::fs::write(
                format!("build/ir-licm/loop-{budget}-{opt}.wasm"),
                emit(&mir, layout, budget).unwrap().bytes,
            )
            .unwrap();
        }
    }
}

#[test]
fn recovery_bearing_pure_value_and_dependents_stay_in_loop() {
    let (mut r, invariant, dependent, _) = counted_loop();
    let Definition::Instruction(id, _) = r.values[invariant.index()].definition
    else {
        panic!()
    };
    r.instructions[id.index()].state = r.blocks[3].entry_state;
    verify(&r).unwrap();
    assert_eq!(run(&mut r, DEFAULT_WORK_LIMIT).unwrap().hoisted, 1);
    assert_eq!(owner(&r, invariant), BlockId(3));
    assert_eq!(owner(&r, dependent), BlockId(3));
}

#[test]
fn actual_cpu_compiler_only_moves_code_in_optimized_tier_two() {
    use crate::ir::{
        frontend::decode::{LinearAddress, PhysicalAddress},
        runtime::compile::*,
    };
    let bytes = vec![
        0xB8, 0, 0, 0, 0, 0x89, 0xDA, 0x01, 0xF2, 0x01, 0xD0, 0xE2, 0xF8,
    ];
    let snapshot = ImmutableCodeSnapshot {
        bytes: bytes.clone(),
        mappings: vec![CodeMapping {
            linear: LinearAddress(0x100000),
            physical: PhysicalAddress(0x100000),
        }],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(0x100000),
            version: 1,
        }],
    };
    let mut config = IrConfig {
        optimize: true,
        passes: Default::default(),
        execution_budget: 100,
        rep_iteration_budget: 8,
        max_code_bytes: 128,
        layout: StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
    };
    let mut request = CompileRequest {
        key: PublicationKey {
            job: 1,
            vm_generation: 1,
            slot: 1,
            slot_generation: 1,
        },
        pc: GuestEip(0x100000),
        linear: LinearAddress(0x100000),
        default_32: true,
        tier: Tier::One,
    };
    std::fs::create_dir_all("build/ir-licm").unwrap();
    for budget in [1, 2, 3, 4, 5, 8, 17, 100] {
        config.execution_budget = budget;
        for tier in [Tier::One, Tier::Two] {
            request.tier = tier;
            let artifact = compile_cpu_cfg_region(&request, &snapshot, &config).unwrap();
            if tier == Tier::One {
                assert_eq!(artifact.passes.loop_hoisted, 0);
            }
            else {
                assert!(artifact.passes.loop_hoisted > 0);
            }
            std::fs::write(
                format!("build/ir-licm/cpu-{budget}-{}.wasm", tier == Tier::Two),
                artifact.code.bytes,
            )
            .unwrap();
        }
    }
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
    std::fs::write("build/ir-licm/cpu.json", format!("{bytes:?}")).unwrap();
}

#[test]
fn all_reachable_three_block_cfgs_preserve_ssa_and_are_idempotent() {
    let successors: [&[usize]; 6] = [&[0], &[1], &[2], &[0, 1], &[0, 2], &[1, 2]];
    let mut checked = 0;
    for a in successors {
        for b in successors {
            for c in successors {
                let edges = [a, b, c];
                for mask in 1..8 {
                    let entries: Vec<_> = (0..3).filter(|&i| mask & (1 << i) != 0).collect();
                    let mut reachable = [false; 3];
                    let mut queue = entries.clone();
                    while let Some(block) = queue.pop() {
                        if !reachable[block] {
                            reachable[block] = true;
                            queue.extend(edges[block]);
                        }
                    }
                    if reachable.iter().any(|&seen| !seen) {
                        continue;
                    }
                    let mut r = graph(&edges, &entries);
                    run(&mut r, DEFAULT_WORK_LIMIT).unwrap();
                    verify(&r).unwrap();
                    assert_eq!(run(&mut r, DEFAULT_WORK_LIMIT).unwrap().hoisted, 0);
                    checked += 1;
                }
            }
        }
    }
    assert!(checked > 500);
}
