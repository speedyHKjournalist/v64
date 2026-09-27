use super::expression;
use crate::ir::{
    backend::{
        literal_fixture,
        wasm::{emit, emit_cpu, StateLayout},
    },
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    ids::ValueId,
    lowering::{lower, lower_draft},
    mir::value::{verify_program_types, Address, Load, Reading, Scalar, Step, ValuePlan},
    types::Type,
};
fn layout() -> StateLayout {
    StateLayout {
        gpr: 0,
        flags: 32,
        eip: 36,
        committed: 40,
        flag_operand: 44,
    }
}
#[test]
fn sealed_mir_owns_its_lifetime_and_folds_without_hir() {
    std::fs::create_dir_all("build/ir-mir-owned").unwrap();
    for (index, bytes) in [
        vec![0xB0, 0xFF],
        vec![0xB4, 0x80],
        vec![0x66, 0xB8, 0x34, 0x92],
    ]
    .iter()
    .enumerate()
    {
        let mut hir = lift(bytes, GuestEip(0x1000), LinearAddress(0x1000), true).unwrap();
        let mut mir = lower(&hir).unwrap();
        let before = emit(&mir, layout(), 100).unwrap().bytes;
        hir.instructions.clear();
        hir.states.clear();
        hir.values.clear();
        hir.blocks.clear();
        drop(hir);
        assert_eq!(emit(&mir, layout(), 100).unwrap().bytes, before);
        let control = mir.control.clone();
        let states = mir.states.clone();
        assert!(mir.fold_constants().unwrap() > 0);
        assert_eq!(
            mir.fold_constants().unwrap(),
            0,
            "machine fold is idempotent"
        );
        assert_eq!(mir.control, control);
        assert_eq!(mir.states, states);
        let after = emit(&mir, layout(), 100).unwrap().bytes;
        assert!(
            after.len() < before.len(),
            "literal normalization emitted fewer operations"
        );
        std::fs::write(format!("build/ir-mir-owned/mov-{index}-0.wasm"), before).unwrap();
        std::fs::write(format!("build/ir-mir-owned/mov-{index}-1.wasm"), after).unwrap();
        let dump = crate::ir::dump::mir(&mir);
        assert!(dump.contains("machine values") && dump.contains("materialize"));
    }
    for bytes in [vec![0x0F, 0x10, 0x00], vec![0x01, 0x00], vec![0x0F, 0xA2]] {
        let hir = lift_cpu(&bytes, GuestEip(0x1000), LinearAddress(0x1000), true).unwrap();
        let mir = lower(&hir).unwrap();
        drop(hir);
        emit_cpu(&mir, 100).unwrap();
    }
    let hir = crate::ir::core_tests::loop_region();
    let mir = lower(&hir).unwrap();
    drop(hir);
    emit(&mir, layout(), 100).unwrap();
}
#[test]
fn sealing_rejects_corrupt_machine_type_and_local_ownership() {
    let hir = crate::ir::core_tests::loop_region();
    for mutation in 0..4 {
        let mut draft = lower_draft(&hir).unwrap();
        match mutation {
            0 => draft.value_types.clear(),
            1 => draft.value_types[0] = Type::F80,
            2 => draft.allocation.value_local.iter_mut().for_each(|slot| {
                if slot.is_some() {
                    *slot = Some(0);
                }
            }),
            _ => draft.allocation.local_types.clear(),
        }
        assert!(draft.finish().is_err());
    }
}
#[test]
fn optimized_compile_request_runs_the_machine_pass() {
    use crate::ir::{frontend::decode::PhysicalAddress, runtime::compile::*};
    let request = CompileRequest {
        key: PublicationKey {
            job: 1,
            vm_generation: 1,
            slot: 0,
            slot_generation: 1,
        },
        pc: GuestEip(0x1000),
        linear: LinearAddress(0x1000),
        default_32: true,
        tier: Tier::Two,
    };
    let snapshot = ImmutableCodeSnapshot {
        bytes: vec![0xB0, 0xFF],
        mappings: vec![CodeMapping {
            linear: LinearAddress(0x1000),
            physical: PhysicalAddress(0x2000),
        }],
        dependencies: vec![CodeDependency {
            page: PhysicalAddress(0x2000),
            version: 1,
        }],
    };
    let mut config = IrConfig {
        optimize: false,
        passes: Default::default(),
        execution_budget: 100,
        rep_iteration_budget: 64,
        max_code_bytes: 128,
        layout: layout(),
    };
    assert_eq!(
        compile_region(&request, &snapshot, &config)
            .unwrap()
            .mir_folds,
        0
    );
    config.optimize = true;
    assert!(
        compile_region(&request, &snapshot, &config)
            .unwrap()
            .mir_folds
            > 0
    );
    assert!(
        compile_cpu_region(&request, &snapshot, &config)
            .unwrap()
            .mir_folds
            > 0
    );
    assert!(
        compile_cpu_cfg_region(&request, &snapshot, &config)
            .unwrap()
            .mir_folds
            > 0
    );
    let tier_one = CompileRequest {
        tier: Tier::One,
        ..request
    };
    assert_eq!(
        compile_cpu_region(&tier_one, &snapshot, &config)
            .unwrap()
            .mir_folds,
        0
    );
    assert_eq!(
        compile_cpu_cfg_region(&tier_one, &snapshot, &config)
            .unwrap()
            .mir_folds,
        0
    );
}
#[test]
fn folding_keeps_observations_and_rejects_machine_type_errors() {
    let reading = Reading::Memory {
        address: Address::Gpr(0),
        load: Load::I32,
    };
    let steps = vec![
        Step::Read {
            cpu: reading.clone(),
            standalone: reading,
        },
        Step::I32(0),
        Step::Scalar(Scalar::I32Mul),
    ];
    assert_eq!(
        expression(&steps),
        (steps.clone(), 0),
        "zero multiply must keep the observed read"
    );
    let plan = ValuePlan {
        result: ValueId(0),
        steps,
        requires_cpu: false,
    };
    verify_program_types(&[Type::I32], &plan).unwrap();
    assert!(verify_program_types(&[Type::I64], &plan).is_err());
    assert!(verify_program_types(&[], &plan).is_err());
    let steps = vec![
        Step::Value(ValueId(1)),
        Step::I32(i32::MAX),
        Step::I32(1),
        Step::Scalar(Scalar::I32Add),
        Step::Scalar(Scalar::I32Mul),
    ];
    assert_eq!(
        expression(&steps),
        (
            vec![
                Step::Value(ValueId(1)),
                Step::I32(i32::MIN),
                Step::Scalar(Scalar::I32Mul)
            ],
            1
        )
    );
    let nested = vec![
        Step::I32(31),
        Step::Scalar(Scalar::I64ExtendUnsignedI32),
        Step::I64(1),
        Step::Scalar(Scalar::I64Add),
        Step::Scalar(Scalar::I64Ctz),
    ];
    assert_eq!(expression(&nested), (vec![Step::I64(5)], 3));
}
#[test]
fn literal_machine_oracle_fixtures() {
    use Scalar::*;
    let samples = [
        0i64,
        1,
        -1,
        2,
        31,
        32,
        63,
        64,
        127,
        255,
        65535,
        i32::MIN as i64,
        i32::MAX as i64,
        0x100000001,
        i64::MIN,
        i64::MAX,
    ];
    let binary = [
        I32Add, I32Sub, I32Mul, I32And, I32Or, I32Xor, I32Shl, I32Shr, I32Sar, I32Eq, I32Ult,
        I32Slt, I64Add, I64Sub, I64Mul, I64And, I64Or, I64Xor, I64Shl, I64Shr, I64Sar, I64Eq,
        I64Ult, I64Slt,
    ];
    let unary = [
        I32Clz,
        I32Ctz,
        I32Popcnt,
        I64Clz,
        I64Ctz,
        I64Popcnt,
        I32WrapI64,
        I64ExtendSignedI32,
        I64ExtendUnsignedI32,
    ];
    let mut original = vec![];
    let mut optimized = vec![];
    let mut metadata = vec![];
    let mut add = |op: Scalar, a: i64, b: i64, condition: i32, steps: Vec<Step>, wide: bool| {
        let (folded, n) = expression(&steps);
        assert_eq!(n, 1);
        assert_eq!(folded.len(), 1);
        let types = [if wide { Type::I64 } else { Type::I32 }];
        for program in [&steps, &folded] {
            verify_program_types(
                &types,
                &ValuePlan {
                    result: ValueId(0),
                    steps: program.clone(),
                    requires_cpu: false,
                },
            )
            .unwrap();
        }
        original.push((steps, wide));
        optimized.push((folded, wide));
        metadata.push(format!("[\"{op:?}\",\"{a}\",\"{b}\",{condition},{wide}]"));
    };
    use crate::wasmgen::wasm_builder::WasmType;
    for op in binary {
        let (inputs, output) = op.signature().unwrap();
        let wide = inputs[0] == WasmType::I64;
        for a in samples {
            for b in samples {
                add(
                    op,
                    a,
                    b,
                    0,
                    vec![
                        if wide { Step::I64(a) } else { Step::I32(a as i32) },
                        if wide { Step::I64(b) } else { Step::I32(b as i32) },
                        Step::Scalar(op),
                    ],
                    output == WasmType::I64,
                );
            }
        }
    }
    for op in unary {
        let (inputs, output) = op.signature().unwrap();
        for a in samples {
            add(
                op,
                a,
                0,
                0,
                vec![
                    if inputs[0] == WasmType::I64 { Step::I64(a) } else { Step::I32(a as i32) },
                    Step::Scalar(op),
                ],
                output == WasmType::I64,
            );
        }
    }
    for wide in [false, true] {
        for a in samples {
            for condition in [0, 1, -1] {
                let b = !a;
                add(
                    Select,
                    a,
                    b,
                    condition,
                    vec![
                        if wide { Step::I64(a) } else { Step::I32(a as i32) },
                        if wide { Step::I64(b) } else { Step::I32(b as i32) },
                        Step::I32(condition),
                        Step::Scalar(Select),
                    ],
                    wide,
                );
            }
        }
    }
    std::fs::create_dir_all("build/ir-mir-owned").unwrap();
    std::fs::write(
        "build/ir-mir-owned/literals-0.wasm",
        literal_fixture(&original),
    )
    .unwrap();
    std::fs::write(
        "build/ir-mir-owned/literals-1.wasm",
        literal_fixture(&optimized),
    )
    .unwrap();
    std::fs::write(
        "build/ir-mir-owned/literals.json",
        format!("[{}]", metadata.join(",")),
    )
    .unwrap();
}

#[test]
fn work_budget_failure_does_not_commit_earlier_rewrites() {
    let hir = lift(&[0xB0, 0xFF], GuestEip(0), LinearAddress(0), true).unwrap();
    let mut mir = lower(&hir).unwrap();
    let first = mir
        .values
        .iter()
        .position(|p| p.as_ref().is_some_and(|p| expression(&p.steps).1 > 0))
        .unwrap();
    let original = mir.values[first].clone();
    let later = (first + 1..mir.values.len())
        .find(|&i| mir.values[i].is_some())
        .unwrap();
    // Test-only corruption simulates a future excessively expanded value plan.
    // The real pass limit is checked before allocating its replacement buffer.
    mir.data.values[later].as_mut().unwrap().steps = vec![Step::I32(0); 1_000_001];
    assert!(matches!(
        mir.fold_constants(),
        Err(crate::ir::lowering::CompileError::Budget(_))
    ));
    assert_eq!(
        mir.values[first], original,
        "an earlier valid fold was not partially committed"
    );
    assert_eq!(mir.values[later].as_ref().unwrap().steps.len(), 1_000_001);
}

#[test]
fn post_lowering_stack_and_local_allocation_are_owned_and_transactional() {
    std::fs::create_dir_all("build/ir-mir-owned").unwrap();
    let mut regions = vec![crate::ir::core_tests::loop_region()];
    for bytes in [
        vec![0xB8, 1, 0, 0, 0, 0x05, 0x78, 0x56, 0x34, 0x12],
        vec![0x31, 0xC0, 0x83, 0xC0, 7, 0xC1, 0xE0, 3],
        vec![0x40, 0x43, 0x31, 0xD8],
    ] {
        regions.push(lift(&bytes, GuestEip(0x1000), LinearAddress(0x1000), true).unwrap());
    }
    let count = regions.len();
    let mut total = 0;
    for (n, region) in regions.into_iter().enumerate() {
        let mut mir = lower(&region).unwrap();
        drop(region);
        let original = emit(&mir, layout(), 40).unwrap().bytes;
        assert!(mir.schedule_operand_stack(0).is_err());
        assert_eq!(emit(&mir, layout(), 40).unwrap().bytes, original);
        total += mir.schedule_operand_stack(262_144).unwrap();
        let fused = emit(&mir, layout(), 40).unwrap().bytes;
        assert!(mir.allocate_machine_locals(0).is_err());
        assert_eq!(emit(&mir, layout(), 40).unwrap().bytes, fused);
        mir.allocate_machine_locals(4_000_000).unwrap();
        let allocated = emit(&mir, layout(), 40).unwrap().bytes;
        assert_eq!(mir.schedule_operand_stack(262_144).unwrap(), 0);
        mir.allocate_machine_locals(4_000_000).unwrap();
        assert_eq!(emit(&mir, layout(), 40).unwrap().bytes, allocated);
        for (variant, bytes) in [original, fused, allocated].into_iter().enumerate() {
            std::fs::write(
                format!("build/ir-mir-owned/stack-{n}-{variant}.wasm"),
                bytes,
            )
            .unwrap();
        }
    }
    assert!(total > 0);
    std::fs::write("build/ir-mir-owned/stack.json", count.to_string()).unwrap();
}
