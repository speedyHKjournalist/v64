use crate::ir::{
    backend::wasm::{emit, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress},
        integer::IntegerBuilder,
        region::lift_cpu_cfg,
    },
    hir::*,
    ids::*,
    lowering::lower,
    passes::{self, scalar, PassConfig},
    state::{ResumeKind, StateMap},
    types::Type,
    verify::verify,
};

const CASES: [&str; 38] = [
    "add-r0",
    "add-l0",
    "sub-r0",
    "sub-self",
    "mul-r1",
    "mul-l1",
    "mul-r0",
    "mul-l0",
    "and-rmask",
    "and-lmask",
    "and-self",
    "and-r0",
    "and-l0",
    "or-r0",
    "or-l0",
    "or-self",
    "or-rmask",
    "or-lmask",
    "xor-r0",
    "xor-l0",
    "xor-self",
    "eq-self",
    "ult-self",
    "slt-self",
    "shl-zero",
    "shr-zero",
    "sar-zero",
    "shl-masked-zero",
    "shr-masked-zero",
    "sar-masked-zero",
    "select-same",
    "select-true",
    "select-false",
    "truncate-unsigned",
    "truncate-signed",
    "shl-nonzero",
    "shr-nonzero",
    "sar-nonzero",
];
fn config() -> PassConfig {
    PassConfig {
        debug: Default::default(),
        disabled: 0,
        prune: false,
        merge: false,
        phis: false,
        copy: true,
        flags: false,
        state_sync: false,
        helper_state: false,
        fold: true,
        gvn: false,
        dce: true,
        rounds: 1,
    }
}
fn ty(bits: u8) -> Type {
    match bits {
        1 => Type::I1,
        8 => Type::I8,
        16 => Type::I16,
        32 => Type::I32,
        64 => Type::I64,
        _ => panic!(),
    }
}
fn input(b: &mut IntegerBuilder, bits: u8, index: usize) -> ValueId {
    let low = b.gpr[index];
    match bits {
        32 => low,
        64 => {
            let high = b.gpr[index + 1];
            let low = b.node(Op::Extend { signed: false }, vec![low], Type::I64);
            let high = b.node(Op::Extend { signed: false }, vec![high], Type::I64);
            let shift = b.constant(32, Type::I64);
            let high = b.binary(Binary::Shl, high, shift);
            b.binary(Binary::Or, low, high)
        },
        _ => b.node(Op::Truncate, vec![low], ty(bits)),
    }
}
fn snapshot(b: &mut IntegerBuilder) -> StateId {
    b.region.state(StateMap {
        instruction_pc: GuestEip(0x9000),
        next_pc: GuestEip(0x9001),
        next_value: None,
        resume: ResumeKind::AfterInstruction,
        gpr: b.gpr,
        flags: b.flags.clone(),
        xmm: vec![],
        x87: vec![],
        committed_instructions: 1,
        count_base: None,
        rep_progress: None,
    })
}
fn finish(mut b: IntegerBuilder, value: ValueId) -> Region {
    if b.ty(value) == Type::I64 {
        b.gpr[0] = b.node(Op::Truncate, vec![value], Type::I32);
        let shift = b.constant(32, Type::I64);
        let high = b.binary(Binary::Shr, value, shift);
        b.gpr[1] = b.node(Op::Truncate, vec![high], Type::I32);
    }
    else {
        b.gpr[0] = if b.ty(value) == Type::I32 {
            value
        }
        else {
            b.node(Op::Extend { signed: false }, vec![value], Type::I32)
        };
        b.gpr[1] = b.constant(0, Type::I32);
    }
    let state = snapshot(&mut b);
    b.region.terminate(b.block, Terminator::Exit(state));
    b.region
}
fn fixture(bits: u8, name: &str) -> Region {
    let mut b = IntegerBuilder::new();
    let x = input(&mut b, bits, 0);
    let y = input(&mut b, bits, 2);
    let zero = b.constant(0, ty(bits));
    let one = b.constant(1, ty(bits));
    let mask = if bits == 64 { u64::MAX } else { (1u64 << bits) - 1 };
    let mask = b.node(Op::Const(mask), vec![], ty(bits));
    let count = b.constant(if bits == 64 { 64 } else { 32 }, ty(bits));
    // In particular, shifts by 8/16 are not identities for I8/I16 HIR.
    let nonzero = b.constant(if bits < 32 { bits as u32 } else { 1 }, ty(bits));
    let predicate_input = b.gpr[7];
    let predicate_zero = b.constant(0, Type::I32);
    let predicate = b.binary(Binary::Eq, predicate_input, predicate_zero);
    let value = match name {
        "add-r0" => b.binary(Binary::Add, x, zero),
        "add-l0" => b.binary(Binary::Add, zero, x),
        "sub-r0" => b.binary(Binary::Sub, x, zero),
        "sub-self" => b.binary(Binary::Sub, x, x),
        "mul-r1" => b.binary(Binary::Mul, x, one),
        "mul-l1" => b.binary(Binary::Mul, one, x),
        "mul-r0" => b.binary(Binary::Mul, x, zero),
        "mul-l0" => b.binary(Binary::Mul, zero, x),
        "and-rmask" => b.binary(Binary::And, x, mask),
        "and-lmask" => b.binary(Binary::And, mask, x),
        "and-self" => b.binary(Binary::And, x, x),
        "and-r0" => b.binary(Binary::And, x, zero),
        "and-l0" => b.binary(Binary::And, zero, x),
        "or-r0" => b.binary(Binary::Or, x, zero),
        "or-l0" => b.binary(Binary::Or, zero, x),
        "or-self" => b.binary(Binary::Or, x, x),
        "or-rmask" => b.binary(Binary::Or, x, mask),
        "or-lmask" => b.binary(Binary::Or, mask, x),
        "xor-r0" => b.binary(Binary::Xor, x, zero),
        "xor-l0" => b.binary(Binary::Xor, zero, x),
        "xor-self" => b.binary(Binary::Xor, x, x),
        "eq-self" => b.binary(Binary::Eq, x, x),
        "ult-self" => b.binary(Binary::Ult, x, x),
        "slt-self" => b.binary(Binary::Slt, x, x),
        "shl-zero" => b.binary(Binary::Shl, x, zero),
        "shr-zero" => b.binary(Binary::Shr, x, zero),
        "sar-zero" => b.binary(Binary::Sar, x, zero),
        "shl-masked-zero" => b.binary(Binary::Shl, x, count),
        "shr-masked-zero" => b.binary(Binary::Shr, x, count),
        "sar-masked-zero" => b.binary(Binary::Sar, x, count),
        "select-same" => b.node(Op::Select, vec![predicate, x, x], ty(bits)),
        "select-true" | "select-false" => {
            let condition = b.constant(u32::from(name == "select-true"), Type::I1);
            b.node(Op::Select, vec![condition, x, y], ty(bits))
        },
        "truncate-unsigned" | "truncate-signed" => {
            assert!(bits < 64);
            let extended = b.node(
                Op::Extend {
                    signed: name == "truncate-signed",
                },
                vec![x],
                Type::I64,
            );
            b.node(Op::Truncate, vec![extended], ty(bits))
        },
        "shl-nonzero" => b.binary(Binary::Shl, x, nonzero),
        "shr-nonzero" => b.binary(Binary::Shr, x, nonzero),
        "sar-nonzero" => b.binary(Binary::Sar, x, nonzero),
        _ => panic!("unknown fixture"),
    };
    finish(b, value)
}
#[test]
fn emit_scalar_identity_differentials() {
    std::fs::create_dir_all("build/ir-scalar").unwrap();
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    let mut manifest = Vec::new();
    for bits in [1, 8, 16, 32, 64] {
        for name in CASES {
            if bits == 64 && name.starts_with("truncate-") {
                continue;
            }
            let original = fixture(bits, name);
            verify(&original).unwrap();
            for optimized in [false, true] {
                let mut r = original.clone();
                if optimized {
                    passes::run(&mut r, config()).unwrap();
                }
                verify(&r).unwrap();
                let wasm = emit(&lower(&r).unwrap(), layout, 100).unwrap().bytes;
                std::fs::write(
                    format!("build/ir-scalar/{bits}-{name}-{optimized}.wasm"),
                    wasm,
                )
                .unwrap();
            }
            manifest.push(format!("[{bits},\"{name}\"]"));
        }
    }
    std::fs::write(
        "build/ir-scalar/cases.json",
        format!("[{}]\n", manifest.join(",")),
    )
    .unwrap();
}
#[test]
fn budget_exhaustion_never_partially_rewrites_the_region() {
    let original = fixture(32, "sub-self");
    let before = format!("{original:?}");
    let mut success = false;
    for limit in 0..10_000 {
        let mut r = original.clone();
        match scalar::run(&mut r, limit) {
            Err(message) => {
                assert!(message.contains("work budget"));
                assert_eq!(
                    format!("{r:?}"),
                    before,
                    "partial mutation at budget {limit}"
                );
            },
            Ok(stats) => {
                assert!(stats.constants > 0);
                verify(&r).unwrap();
                success = true;
                break;
            },
        }
    }
    assert!(success);
}
#[test]
fn scalar_rewrites_every_state_observation_without_removing_effects() {
    let mut b = IntegerBuilder::new();
    let x = b.gpr[0];
    let flag = b.flags.arithmetic[0];
    let zero = b.constant(0, Type::I32);
    let alias = b.binary(Binary::Add, x, zero);
    let fzero = b.constant(0, Type::I1);
    let falias = b.binary(Binary::Or, flag, fzero);
    b.gpr = [alias; 8];
    b.flags.arithmetic = [falias; 6];
    b.flags.system = alias;
    b.flags.last_op1 = Some(alias);
    b.flags.raw_zero = Some(falias);
    b.flags.zero_is_lazy = Some(falias);
    let rep = snapshot(&mut b);
    b.region.states[rep.index()].resume = ResumeKind::RepProgress;
    b.region.states[rep.index()].rep_progress = Some([alias; 3]);
    b.region.states[rep.index()].count_base = Some(alias);
    let effect = b.region.append(
        b.block,
        Op::PollBudget,
        vec![b.effect],
        &[Type::Effect],
        Some(rep),
    )[0];
    let after = snapshot(&mut b);
    b.region.states[after.index()].next_value = Some(alias);
    b.region.states[after.index()].count_base = Some(alias);
    b.region.append(
        b.block,
        Op::PollBudget,
        vec![effect],
        &[Type::Effect],
        Some(after),
    );
    b.region.terminate(b.block, Terminator::Exit(after));
    let before = b.region.blocks[0].instructions.clone();
    let stats = scalar::run(&mut b.region, scalar::DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.aliases, 2);
    assert_eq!(b.region.blocks[0].instructions, before);
    for state in &b.region.states {
        assert_eq!(state.gpr, [x; 8]);
        assert_eq!(state.flags.arithmetic, [flag; 6]);
        assert_eq!(state.flags.system, x);
        assert_eq!(state.flags.last_op1, Some(x));
        assert_eq!(state.flags.raw_zero, Some(flag));
        assert_eq!(state.flags.zero_is_lazy, Some(flag));
        assert_eq!(state.count_base, Some(x));
    }
    assert_eq!(b.region.states[rep.index()].rep_progress, Some([x; 3]));
    assert_eq!(b.region.states[after.index()].next_value, Some(x));
    verify(&b.region).unwrap();
}
#[test]
fn inverse_bitfield_updates_and_extensions_keep_exact_widths() {
    for lsb in [0, 8, 16, 24] {
        let mut b = IntegerBuilder::new();
        let base = b.gpr[0];
        let part = b.extract(base, lsb, Type::I8);
        let restored = b.node(Op::Insert { lsb }, vec![base, part], Type::I32);
        let mut r = finish(b, restored);
        scalar::run(&mut r, scalar::DEFAULT_WORK_LIMIT).unwrap();
        assert_eq!(r.states[0].gpr[0], base);
        verify(&r).unwrap();

        let mut b = IntegerBuilder::new();
        let base = b.gpr[0];
        let source = b.gpr[1];
        let part = b.extract(source, 0, Type::I8);
        let inserted = b.node(Op::Insert { lsb }, vec![base, part], Type::I32);
        let extracted = b.extract(inserted, lsb, Type::I8);
        let mut r = finish(b, extracted);
        let stats = scalar::run(&mut r, scalar::DEFAULT_WORK_LIMIT).unwrap();
        assert_eq!(stats.aliases, 1);
        let Definition::Instruction(id, _) = r.values[r.states[0].gpr[0].index()].definition
        else {
            panic!();
        };
        assert_eq!(r.instructions[id.index()].args, vec![part]);
        verify(&r).unwrap();
    }
    // A mismatched lane and a lossy extend(truncate(x)) must remain explicit.
    let mut b = IntegerBuilder::new();
    let base = b.gpr[0];
    let byte = b.extract(base, 0, Type::I8);
    let wide = b.node(Op::Extend { signed: false }, vec![byte], Type::I32);
    let mut r = finish(b, wide);
    assert_eq!(
        scalar::run(&mut r, scalar::DEFAULT_WORK_LIMIT)
            .unwrap()
            .aliases,
        0
    );
    assert_eq!(r.states[0].gpr[0], wide);
}
#[test]
fn dependency_order_is_independent_of_instruction_arena_order() {
    let mut b = IntegerBuilder::new();
    let x = b.gpr[0];
    let zero = b.constant(0, Type::I32);
    let a = b.binary(Binary::Add, x, zero);
    let one = b.constant(1, Type::I32);
    let c = b.binary(Binary::Mul, a, one);
    let d = b.binary(Binary::Xor, c, zero);
    let mut r = finish(b, d);
    let n = r.instructions.len();
    r.instructions.reverse();
    for block in &mut r.blocks {
        for id in &mut block.instructions {
            *id = InstId((n - 1 - id.index()) as u32);
        }
    }
    for value in &mut r.values {
        if let Definition::Instruction(ref mut id, _) = value.definition {
            *id = InstId((n - 1 - id.index()) as u32);
        }
    }
    let stats = scalar::run(&mut r, scalar::DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(stats.aliases, 3);
    assert_eq!(r.states[0].gpr[0], x);
    verify(&r).unwrap();
}
#[test]
fn ignored_load_result_does_not_erase_the_memory_observation() {
    let mut r = lift_cpu_cfg(
        &[0x8B, 0x03, 0x31, 0xC0],
        GuestEip(0x1000),
        LinearAddress(0x100000),
        true,
        8,
    )
    .unwrap();
    let ordered = |r: &Region| {
        r.blocks
            .iter()
            .flat_map(|b| &b.instructions)
            .map(|id| &r.instructions[id.index()])
            .filter(|i| i.op.ordered())
            .map(|i| i.op.clone())
            .collect::<Vec<_>>()
    };
    let before = ordered(&r);
    assert!(before.iter().any(|op| matches!(op, Op::GuestLoad { .. })));
    passes::run(&mut r, config()).unwrap();
    assert_eq!(ordered(&r), before);
    verify(&r).unwrap();
    lower(&r).unwrap();
}
#[test]
fn copy_and_fold_switches_are_independent() {
    let mut r = fixture(32, "add-r0");
    let stats = passes::run(
        &mut r,
        PassConfig {
            copy: false,
            ..config()
        },
    )
    .unwrap();
    assert_eq!(stats.scalar_aliases, 0);
    assert_eq!(stats.copied, 0);

    let mut r = fixture(32, "sub-self");
    let stats = passes::run(
        &mut r,
        PassConfig {
            fold: false,
            ..config()
        },
    )
    .unwrap();
    assert_eq!(stats.scalar_constants, 0);

    let mut r = fixture(32, "add-r0");
    let stats = passes::run(&mut r, config()).unwrap();
    assert!(stats.scalar_aliases > 0 && stats.copied > 0);
}
#[test]
fn cross_block_aliases_rewrite_edges_conditions_and_entry_states() {
    let mut b = IntegerBuilder::new();
    let entry = b.block;
    let x = b.gpr[0];
    let f = b.flags.arithmetic[0];
    // The join is allocated before the block that dominates it.
    let join = b.region.block(false);
    let middle = b.region.block(false);
    let me = b.region.param(middle, Type::Effect);
    let je = b.region.param(join, Type::Effect);
    b.region.param(join, Type::I32);
    let initial = snapshot(&mut b);
    b.region.blocks[middle.index()].entry_state = Some(initial);
    b.region.terminate(
        entry,
        Terminator::Branch(Edge {
            target: middle,
            args: vec![b.effect],
        }),
    );
    b.block = middle;
    let zero = b.constant(0, Type::I32);
    let a = b.binary(Binary::Add, x, zero);
    let fzero = b.constant(0, Type::I1);
    let condition = b.binary(Binary::Or, f, fzero);
    b.gpr[0] = a;
    let incoming = snapshot(&mut b);
    b.region.blocks[join.index()].entry_state = Some(incoming);
    let edge = Edge {
        target: join,
        args: vec![me, a],
    };
    b.region.terminate(
        middle,
        Terminator::CondBranch {
            condition,
            taken: edge.clone(),
            not_taken: edge,
        },
    );
    b.block = join;
    b.effect = je;
    let one = b.constant(1, Type::I32);
    let value = b.binary(Binary::Mul, a, one);
    let mut r = finish(b, value);
    assert_eq!(
        scalar::run(&mut r, scalar::DEFAULT_WORK_LIMIT)
            .unwrap()
            .aliases,
        3
    );
    let Terminator::CondBranch {
        condition,
        taken,
        not_taken,
    } = r.blocks[middle.index()].terminator.as_ref().unwrap()
    else {
        panic!();
    };
    assert_eq!(*condition, f);
    assert_eq!(taken.args, vec![me, x]);
    assert_eq!(not_taken.args, vec![me, x]);
    assert_eq!(r.states[incoming.index()].gpr[0], x);
    verify(&r).unwrap();
}
#[test]
fn self_xor_exposes_flags_for_branch_pruning_and_budget_recovery() {
    // xor eax,eax; jnz dead; inc eax; jmp end; dead: inc ebx; end: nop
    let bytes = [0x31, 0xC0, 0x75, 3, 0x40, 0xEB, 1, 0x43, 0x90];
    let original =
        lift_cpu_cfg(&bytes, GuestEip(0x1000), LinearAddress(0x100000), true, 16).unwrap();
    let mut optimized = original.clone();
    let stats = passes::run(
        &mut optimized,
        PassConfig {
            prune: true,
            phis: true,
            rounds: 2,
            ..config()
        },
    )
    .unwrap();
    assert!(stats.scalar_constants > 0);
    assert!(stats.branches > 0 && stats.unreachable > 0);
    let layout = StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    };
    std::fs::create_dir_all("build/ir-scalar").unwrap();
    for budget in [1, 2, 3, 100] {
        for (opt, r) in [(false, &original), (true, &optimized)] {
            let bytes = emit(&lower(r).unwrap(), layout, budget).unwrap().bytes;
            std::fs::write(format!("build/ir-scalar/cfg-{budget}-{opt}.wasm"), bytes).unwrap();
        }
    }
}
#[test]
fn unused_arena_slots_do_not_break_the_transaction() {
    let mut r = fixture(32, "add-r0");
    r.instructions.push(Instruction {
        block: BlockId(0),
        op: Op::Binary(Binary::Add),
        args: vec![ValueId(u32::MAX); 2],
        results: vec![],
        state: None,
        commit: None,
        trap_after_fault: false,
        unmasked_word_store: false,
    });
    verify(&r).unwrap();
    scalar::run(&mut r, scalar::DEFAULT_WORK_LIMIT).unwrap();
    verify(&r).unwrap();
    assert_eq!(
        r.instructions.last().unwrap().args,
        vec![ValueId(u32::MAX); 2]
    );
}
