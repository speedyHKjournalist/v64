use super::{run, DEFAULT_WORK_LIMIT};
use crate::{
    cpu::global_pointers as gp,
    ir::{
        backend::wasm::emit_cpu,
        frontend::{decode::GuestEip, integer::IntegerBuilder},
        hir::*,
        ids::*,
        lowering::lower,
        passes::{self, PassConfig},
        simd::PackedOp,
        state::{ResumeKind, StateMap},
        types::Type,
        verify::verify,
    },
};
const CASES: usize = 20;
fn vector(b: &mut IntegerBuilder, op: Op, args: Vec<ValueId>) -> ValueId {
    b.node(op, args, Type::V128)
}
fn fixture(case: usize) -> Region {
    let mut b = IntegerBuilder::new();
    let a = vector(&mut b, Op::ReadXmm(0), vec![]);
    let c = vector(&mut b, Op::ReadXmm(1), vec![]);
    let d = vector(&mut b, Op::ReadXmm(2), vec![]);
    let result = match case {
        0 => vector(
            &mut b,
            Op::VectorShuffle(std::array::from_fn(|i| i as u8)),
            vec![a, c],
        ),
        1 => vector(
            &mut b,
            Op::VectorShuffle(std::array::from_fn(|i| i as u8 + 16)),
            vec![a, c],
        ),
        2 => vector(
            &mut b,
            Op::VectorShuffle(std::array::from_fn(|i| i as u8 + (i % 2) as u8 * 16)),
            vec![a, a],
        ),
        3 => {
            let reverse = std::array::from_fn(|i| 15 - i as u8);
            let x = vector(&mut b, Op::VectorShuffle(reverse), vec![a, c]);
            vector(&mut b, Op::VectorShuffle(reverse), vec![x, c])
        },
        4 | 5 => {
            let mask = std::array::from_fn(|i| (i * 7 % 32) as u8);
            let x = vector(&mut b, Op::VectorShuffle(mask), vec![a, c]);
            vector(
                &mut b,
                Op::VectorShuffle(std::array::from_fn(|i| (i * 3 % 32) as u8)),
                vec![x, if case == 4 { c } else { d }],
            )
        },
        6 => vector(&mut b, Op::VectorBinary(PackedOp::And), vec![a, a]),
        7..=12 => {
            let z = vector(&mut b, Op::VectorBinary(PackedOp::Xor), vec![c, c]);
            let op = [
                PackedOp::Or,
                PackedOp::Add32,
                PackedOp::And,
                PackedOp::AndNot,
                PackedOp::AndNot,
                PackedOp::Sub16,
            ][case - 7];
            vector(
                &mut b,
                Op::VectorBinary(op),
                if case == 11 { vec![z, a] } else { vec![a, z] },
            )
        },
        13 => vector(&mut b, Op::VectorBinary(PackedOp::AvgU8), vec![a, a]),
        14..=16 => {
            let bits = [16, 32, 64][case - 14];
            let x = b.node(
                Op::VectorExtract { bits, lane: 1 },
                vec![a],
                if bits == 64 { Type::I64 } else { Type::I32 },
            );
            vector(&mut b, Op::VectorReplace { bits, lane: 1 }, vec![a, x])
        },
        17 | 18 => {
            let input = b.gpr[4];
            let bits = if case == 17 { 32 } else { 16 };
            let x = vector(&mut b, Op::VectorReplace { bits, lane: 1 }, vec![a, input]);
            let x = b.node(Op::VectorExtract { bits, lane: 1 }, vec![x], Type::I32);
            vector(&mut b, Op::VectorReplace { bits: 32, lane: 0 }, vec![c, x])
        },
        19 => {
            // Same opcode but distinct input SSA must not be assumed all zero.
            let z = vector(&mut b, Op::VectorBinary(PackedOp::Xor), vec![c, d]);
            vector(&mut b, Op::VectorBinary(PackedOp::Add32), vec![a, z])
        },
        _ => unreachable!(),
    };
    for lane in 0..4 {
        b.gpr[lane as usize] = b.node(
            Op::VectorExtract { bits: 32, lane },
            vec![result],
            Type::I32,
        );
    }
    let state = b.region.state(StateMap {
        instruction_pc: GuestEip(0x5000),
        next_pc: GuestEip(0x5001),
        next_value: None,
        resume: ResumeKind::AfterInstruction,
        gpr: b.gpr,
        flags: b.flags,
        // Exercise vector references used only by a recovery snapshot.
        xmm: vec![result, a, c, d, a, c, d, result],
        x87: vec![],
        committed_instructions: 1,
        count_base: None,
        rep_progress: None,
    });
    b.region.terminate(b.block, Terminator::Exit(state));
    verify(&b.region).unwrap();
    b.region
}
#[test]
fn simd_identities_respect_lane_widths_operand_order_and_three_source_limit() {
    for case in 0..CASES {
        let mut region = fixture(case);
        let reads: Vec<_> = region
            .instructions
            .iter()
            .enumerate()
            .filter(|(_, i)| matches!(i.op, Op::ReadXmm(_)))
            .map(|(id, i)| (id, format!("{i:?}")))
            .collect();
        let stats = run(&mut region, DEFAULT_WORK_LIMIT).unwrap();
        if [5, 19].contains(&case) {
            // Three-source shuffle stays untouched, and a 16-bit extract must
            // keep its truncation even though the source scalar is 32 bits.
            assert_eq!(stats.shuffled + stats.eliminated, 0, "case {case}");
        }
        else {
            assert!(stats.shuffled + stats.eliminated > 0, "case {case}");
        }
        if case == 18 {
            assert!(
                region
                    .blocks
                    .iter()
                    .flat_map(|b| &b.instructions)
                    .any(|id| region.instructions[id.index()].op
                        == (Op::VectorExtract { bits: 16, lane: 1 })),
                "16-bit truncating extract must remain scheduled"
            );
        }
        for (id, before) in reads {
            assert_eq!(format!("{:?}", region.instructions[id]), before);
        }
        verify(&region).unwrap();
        lower(&region).unwrap();
    }
}
#[test]
fn simd_budget_exhaustion_and_invalid_input_are_atomic() {
    let original = fixture(3);
    let before = format!("{original:?}");
    let mut saw_early_failure = false;
    let mut saw_late_failure = false;
    let mut saw_success = false;
    for limit in (0..1200).step_by(17) {
        let mut region = original.clone();
        match run(&mut region, limit) {
            Err(_) => {
                assert_eq!(format!("{region:?}"), before);
                saw_early_failure = true;
                saw_late_failure |= limit > 200;
            },
            Ok(stats) => {
                assert!(stats.eliminated > 0);
                saw_success = true;
            },
        }
    }
    assert!(saw_early_failure && saw_late_failure && saw_success);
    let mut invalid = original;
    invalid.instructions[0].block = BlockId(100);
    let before = format!("{invalid:?}");
    assert!(run(&mut invalid, DEFAULT_WORK_LIMIT).is_err());
    assert_eq!(format!("{invalid:?}"), before);
}
#[test]
fn simd_observation_nodes_are_pinned_and_pass_can_be_disabled() {
    let mut region = fixture(6);
    let id = region
        .instructions
        .iter()
        .position(|i| i.op == Op::VectorBinary(PackedOp::And))
        .unwrap();
    let mut state = region.states[0].clone();
    // Only entry reads are available before the selected expression.
    let read = |r: u8| {
        region
            .instructions
            .iter()
            .find(|i| i.op == Op::ReadGpr(r))
            .unwrap()
            .results[0]
    };
    state.gpr = std::array::from_fn(|r| read(r as u8));
    state.xmm.clear();
    let state = region.state(state);
    region.instructions[id].state = Some(state);
    let before = format!("{:?}", region.instructions[id]);
    verify(&region).unwrap();
    run(&mut region, DEFAULT_WORK_LIMIT).unwrap();
    assert_eq!(format!("{:?}", region.instructions[id]), before);
    let mut disabled = fixture(6);
    let config = PassConfig {
        fold: false,
        ..PassConfig::default()
    };
    assert_eq!(
        passes::run(&mut disabled, config).unwrap().simd_eliminated,
        0
    );
    let mut enabled = fixture(6);
    assert!(
        passes::run(&mut enabled, PassConfig::default())
            .unwrap()
            .simd_eliminated
            > 0
    );
}
#[test]
fn simd_emits_before_and_after_for_independent_byte_oracle() {
    let directory = "build/ir-simd-peephole";
    std::fs::create_dir_all(directory).unwrap();
    std::fs::write(format!("{directory}/layout.json"),format!(
        "{{\"gpr\":{},\"flags\":{},\"changed\":{},\"operand\":{},\"eip\":{},\"counter\":{},\"xmm\":{},\"cases\":{CASES}}}",
        gp::reg32 as usize, gp::flags as usize, gp::flags_changed as usize, gp::last_op1 as usize,
        gp::instruction_pointer as usize, gp::instruction_counter as usize, gp::reg_xmm as usize,
    )).unwrap();
    for case in 0..CASES {
        for optimize in 0..=2 {
            let mut region = fixture(case);
            if optimize == 1 {
                run(&mut region, DEFAULT_WORK_LIMIT).unwrap();
            }
            if optimize == 2 {
                passes::run(&mut region, PassConfig::default()).unwrap();
            }
            let mir = lower(&region).unwrap();
            drop(region);
            std::fs::write(
                format!("{directory}/{case}-{optimize}.wasm"),
                emit_cpu(&mir, 100).unwrap().bytes,
            )
            .unwrap();
        }
    }
}
