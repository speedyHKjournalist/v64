use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress},
        integer::IntegerBuilder,
        lift::lift_cpu,
    },
    hir::{Binary, Op, Region, Terminator},
    ids::ValueId,
    lowering::lower,
    mir::{
        memory::{NativeMemory, VectorCombine},
        value::{self, Scalar, Step},
        vector::{self, PackedPlan},
    },
    passes::{run, PassConfig},
    simd::PackedOp,
    state::{ResumeKind, StateMap},
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
fn scalar_region(ty: Type, operation: Binary) -> Region {
    let mut b = IntegerBuilder::new();
    let mut args = vec![];
    for reg in [0, 2] {
        let x = b.gpr[reg];
        args.push(if ty == Type::I64 {
            let low = b.node(Op::Extend { signed: false }, vec![x], Type::I64);
            b.node(Op::Insert { lsb: 32 }, vec![low, b.gpr[reg + 1]], Type::I64)
        }
        else if ty == Type::I32 {
            x
        }
        else {
            b.extract(x, 0, ty)
        });
    }
    let result = b.binary(operation, args[0], args[1]);
    b.gpr[0] = match b.ty(result) {
        Type::I32 => result,
        Type::I64 => b.extract(result, 0, Type::I32),
        _ => b.node(Op::Extend { signed: false }, vec![result], Type::I32),
    };
    b.gpr[1] = if b.ty(result) == Type::I64 {
        b.extract(result, 32, Type::I32)
    }
    else {
        b.constant(0, Type::I32)
    };
    let state = b.region.state(StateMap {
        instruction_pc: GuestEip(0x1000),
        next_pc: GuestEip(0x1002),
        next_value: None,
        resume: ResumeKind::AfterInstruction,
        gpr: b.gpr,
        flags: b.flags,
        xmm: vec![],
        x87: vec![],
        committed_instructions: 1,
        count_base: None,
        rep_progress: None,
    });
    b.region.terminate(b.block, Terminator::Exit(state));
    b.region
}
#[test]
fn scalar_widths_and_normalization_generate_typed_programs() {
    std::fs::create_dir_all("build/ir-mir-value").unwrap();
    let mut cases = vec![];
    for ty in [Type::I1, Type::I8, Type::I16, Type::I32, Type::I64] {
        for operation in [
            Binary::Add,
            Binary::Sub,
            Binary::Mul,
            Binary::And,
            Binary::Or,
            Binary::Xor,
            Binary::Shl,
            Binary::Shr,
            Binary::Sar,
            Binary::Eq,
            Binary::Ult,
            Binary::Slt,
        ] {
            let mut r = scalar_region(ty, operation);
            let index = cases.len();
            cases.push(format!("[{},\"{operation:?}\"]", ty.bits().unwrap()));
            for opt in 0..2 {
                if opt != 0 {
                    run(&mut r, PassConfig::default()).unwrap();
                }
                let mir = lower(&r).unwrap();
                for plan in mir.values.iter().flatten() {
                    value::verify_program(&r, plan).unwrap();
                }
                assert!(crate::ir::dump::mir(&mir).contains("Scalar("));
                std::fs::write(
                    format!("build/ir-mir-value/{index}-{opt}.wasm"),
                    emit(&mir, layout(), 100).unwrap().bytes,
                )
                .unwrap();
            }
        }
    }
    std::fs::write(
        "build/ir-mir-value/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    let r = scalar_region(Type::I8, Binary::Slt);
    let mir = lower(&r).unwrap();
    let inst = r
        .instructions
        .iter()
        .position(|i| i.op == Op::Binary(Binary::Slt))
        .unwrap();
    let steps = &mir.values[inst].as_ref().unwrap().steps;
    assert_eq!(
        steps
            .iter()
            .filter(|s| **s == Step::Scalar(Scalar::I32Sar))
            .count(),
        2
    );
    assert!(steps.ends_with(&[Step::I32(1), Step::Scalar(Scalar::I32And)]));
}
#[test]
fn packed_selection_is_shared_by_register_and_memory_paths() {
    let mut count = 0;
    for operation in (0..256).filter_map(PackedOp::from_id) {
        count += 1;
        for memory in [false, true] {
            let mut r = lift_cpu(
                &[
                    0x66,
                    0x0F,
                    operation as u8,
                    if memory { 0x06 } else { 0xC1 },
                ],
                GuestEip(0x8000),
                LinearAddress(0x8000),
                true,
            )
            .unwrap();
            for opt in 0..2 {
                if opt != 0 {
                    run(&mut r, PassConfig::default()).unwrap();
                }
                let mir = lower(&r).unwrap();
                let plan = if memory {
                    mir.memory
                        .iter()
                        .flatten()
                        .find_map(|m| match &m.native {
                            NativeMemory::VectorLoad {
                                combine: VectorCombine::Binary { plan, .. },
                                ..
                            } => Some(plan),
                            _ => None,
                        })
                        .unwrap()
                }
                else {
                    mir.values
                        .iter()
                        .flatten()
                        .flat_map(|p| &p.steps)
                        .find_map(|s| match s {
                            Step::Packed { plan, .. } => Some(plan),
                            _ => None,
                        })
                        .unwrap()
                };
                assert_eq!(*plan, vector::lower(operation));
                emit_cpu(&mir, 100).unwrap();
            }
        }
    }
    assert_eq!(count, 57);
    assert_eq!(
        vector::lower(PackedOp::AndNot),
        PackedPlan::Binary {
            opcode: 0x4F,
            reverse: true
        }
    );
    assert_eq!(
        vector::lower(PackedOp::Shr16),
        PackedPlan::Shift {
            maximum: 15,
            opcode: 0x8D,
            sign_fill: false
        }
    );
    assert_eq!(
        vector::lower(PackedOp::Sar32),
        PackedPlan::Shift {
            maximum: 31,
            opcode: 0xAC,
            sign_fill: true
        }
    );
    assert!(matches!(
        vector::lower(PackedOp::MulHighS16),
        PackedPlan::MultiplyHigh {
            low: 0xBC,
            high: 0xBD,
            ..
        }
    ));
    assert!(matches!(
        vector::lower(PackedOp::MulHighU16),
        PackedPlan::MultiplyHigh {
            low: 0xBE,
            high: 0xBF,
            ..
        }
    ));
}
#[test]
fn invalid_programs_fail_stack_and_contract_validation() {
    for mutation in 0..9 {
        let r = scalar_region(Type::I8, Binary::Slt);
        let mut mir = crate::ir::lowering::lower_draft(&r).unwrap();
        let inst = r
            .instructions
            .iter()
            .position(|i| i.op == Op::Binary(Binary::Slt))
            .unwrap();
        let plan = mir.values[inst].as_mut().unwrap();
        match mutation {
            0 => plan.steps.clear(),
            1 => plan.steps.reverse(),
            2 => plan.result = ValueId(u32::MAX),
            3 => plan.steps = vec![Step::I64(0)],
            4 => plan.steps.push(Step::I32(0)),
            5 => plan.steps = vec![Step::Value(ValueId(u32::MAX))],
            6 => plan.steps = vec![Step::I32(0), Step::I32(1), Step::Scalar(Scalar::I64Add)],
            7 => {
                plan.steps = vec![
                    Step::I64(0),
                    Step::I32(1),
                    Step::I32(0),
                    Step::Scalar(Scalar::Select),
                ]
            },
            8 => {
                plan.steps = vec![
                    Step::I32(0),
                    Step::Lane {
                        opcode: 0x19,
                        lane: 9,
                    },
                ]
            },
            _ => unreachable!(),
        }
        assert!(
            value::verify_program(&r, plan).is_err(),
            "stack mutation {mutation}"
        );
        assert!(mir.finish().is_err());
    }
    for mutation in 0..5 {
        let r = scalar_region(Type::I8, Binary::Slt);
        let mut mir = crate::ir::lowering::lower_draft(&r).unwrap();
        let inst = r
            .instructions
            .iter()
            .position(|i| i.op == Op::Binary(Binary::Slt))
            .unwrap();
        let plan = mir.values[inst].as_mut().unwrap();
        match mutation {
            0 => {
                let n = plan.steps.len();
                plan.steps[n - 2] = Step::I32(255);
            },
            1 => plan.requires_cpu = true,
            2 => {
                let i = plan
                    .steps
                    .iter()
                    .position(|s| *s == Step::Scalar(Scalar::I32Slt))
                    .unwrap();
                plan.steps[i] = Step::Scalar(Scalar::I32Ult);
            },
            3 => mir.values.clear(),
            4 => mir.values[inst] = None,
            _ => unreachable!(),
        }
        assert!(mir.finish().is_err(), "contract mutation {mutation}");
    }
    for memory in [false, true] {
        for mutation in 0..3 {
            let r = lift_cpu(
                &[0x66, 0x0F, 0xD1, if memory { 0x06 } else { 0xC1 }],
                GuestEip(0),
                LinearAddress(0),
                true,
            )
            .unwrap();
            let mut mir = crate::ir::lowering::lower_draft(&r).unwrap();
            let plan = if memory {
                mir.memory
                    .iter_mut()
                    .flatten()
                    .find_map(|m| match &mut m.native {
                        NativeMemory::VectorLoad {
                            combine: VectorCombine::Binary { plan, .. },
                            ..
                        } => Some(plan),
                        _ => None,
                    })
                    .unwrap()
            }
            else {
                mir.values
                    .iter_mut()
                    .flatten()
                    .flat_map(|p| &mut p.steps)
                    .find_map(|s| match s {
                        Step::Packed { plan, .. } => Some(plan),
                        _ => None,
                    })
                    .unwrap()
            };
            let PackedPlan::Shift {
                maximum,
                opcode,
                sign_fill,
            } = plan
            else {
                panic!()
            };
            match mutation {
                0 => *maximum = 63,
                1 => *opcode = 0xFF,
                2 => *sign_fill = true,
                _ => unreachable!(),
            }
            assert!(mir.finish().is_err());
        }
    }
}
