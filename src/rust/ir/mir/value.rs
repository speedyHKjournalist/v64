//! Selected value programs: widths, normalization and lane opcodes fixed by lowering.
use crate::cpu::global_pointers as gp;
use crate::ir::{
    hir::{Binary, Instruction, Op, Region},
    ids::ValueId,
    lowering::CompileError,
    types::Type,
};
use crate::wasmgen::wasm_builder::{Signature, WasmType};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scalar {
    I32Add,
    I32Sub,
    I32Mul,
    I32And,
    I32Or,
    I32Xor,
    I32Shl,
    I32Shr,
    I32Sar,
    I32Eq,
    I32Ult,
    I32Slt,
    I32Clz,
    I32Ctz,
    I32Popcnt,
    I64Add,
    I64Sub,
    I64Mul,
    I64And,
    I64Or,
    I64Xor,
    I64Shl,
    I64Shr,
    I64Sar,
    I64Eq,
    I64Ult,
    I64Slt,
    I64Clz,
    I64Ctz,
    I64Popcnt,
    I32WrapI64,
    I64ExtendSignedI32,
    I64ExtendUnsignedI32,
    Select,
}
fn binary(op: Binary, wide: bool) -> Scalar {
    match (wide, op) {
        (false, Binary::Add) => Scalar::I32Add,
        (false, Binary::Sub) => Scalar::I32Sub,
        (false, Binary::Mul) => Scalar::I32Mul,
        (false, Binary::And) => Scalar::I32And,
        (false, Binary::Or) => Scalar::I32Or,
        (false, Binary::Xor) => Scalar::I32Xor,
        (false, Binary::Shl) => Scalar::I32Shl,
        (false, Binary::Shr) => Scalar::I32Shr,
        (false, Binary::Sar) => Scalar::I32Sar,
        (false, Binary::Eq) => Scalar::I32Eq,
        (false, Binary::Ult) => Scalar::I32Ult,
        (false, Binary::Slt) => Scalar::I32Slt,
        (true, Binary::Add) => Scalar::I64Add,
        (true, Binary::Sub) => Scalar::I64Sub,
        (true, Binary::Mul) => Scalar::I64Mul,
        (true, Binary::And) => Scalar::I64And,
        (true, Binary::Or) => Scalar::I64Or,
        (true, Binary::Xor) => Scalar::I64Xor,
        (true, Binary::Shl) => Scalar::I64Shl,
        (true, Binary::Shr) => Scalar::I64Shr,
        (true, Binary::Sar) => Scalar::I64Sar,
        (true, Binary::Eq) => Scalar::I64Eq,
        (true, Binary::Ult) => Scalar::I64Ult,
        (true, Binary::Slt) => Scalar::I64Slt,
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Address {
    Absolute(u32),
    Gpr(u8),
    Flags,
    FlagOperand,
    Eip,
    Committed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Load {
    U8,
    U16,
    I32,
    V128,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reading {
    Memory {
        address: Address,
        load: Load,
    },
    Constant(i32),
    Call {
        name: &'static str,
        signature: Signature,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Value(ValueId),
    I32(i32),
    I64(i64),
    Scalar(Scalar),
    Read {
        cpu: Reading,
        standalone: Reading,
    },
    Simd(u32),
    Lane {
        opcode: u32,
        lane: u8,
    },
    Shuffle([u8; 16]),
    Packed {
        destination: ValueId,
        source: ValueId,
        plan: super::vector::PackedPlan,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValuePlan {
    pub result: ValueId,
    pub steps: Vec<Step>,
    pub requires_cpu: bool,
}
fn signed(steps: &mut Vec<Step>, ty: Type) {
    let bits = ty.bits().unwrap();
    if bits < 32 {
        steps.extend([
            Step::I32((32 - bits) as i32),
            Step::Scalar(Scalar::I32Shl),
            Step::I32((32 - bits) as i32),
            Step::Scalar(Scalar::I32Sar),
        ]);
    }
}
fn read(steps: &mut Vec<Step>, address: Address, load: Load) {
    let r = Reading::Memory { address, load };
    steps.push(Step::Read {
        cpu: r.clone(),
        standalone: r,
    });
}
pub fn lower(region: &Region, inst: &Instruction) -> Option<ValuePlan> {
    let ty = |v: ValueId| region.values[v.index()].ty;
    let mut steps = vec![];
    let requires_cpu = matches!(
        inst.op,
        Op::ReadEntryLinear | Op::ReadSegment(_) | Op::ReadStack32 | Op::ReadXmm(_)
    );
    match inst.op {
        Op::Const(n) => steps.push(if ty(inst.results[0]) == Type::I64 {
            Step::I64(n as i64)
        }
        else {
            Step::I32(n as i32)
        }),
        Op::ReadSegment(segment) => read(
            &mut steps,
            Address::Absolute(gp::get_sreg_offset(segment as u32)),
            Load::U16,
        ),
        Op::ReadStack32 => read(
            &mut steps,
            Address::Absolute(gp::stack_size_32 as u32),
            Load::U8,
        ),
        Op::ReadEntryLinear => read(&mut steps, Address::Eip, Load::I32),
        Op::ReadGpr(reg) => read(&mut steps, Address::Gpr(reg), Load::I32),
        Op::ReadXmm(reg) => read(
            &mut steps,
            Address::Absolute(gp::get_reg_xmm_offset(reg as u32)),
            Load::V128,
        ),
        Op::ReadRawFlags => read(&mut steps, Address::Flags, Load::I32),
        Op::ReadSystemFlags => {
            read(&mut steps, Address::Flags, Load::I32);
            steps.extend([Step::I32(!0x8D5), Step::Scalar(Scalar::I32And)]);
        },
        Op::ReadFlag(bit) => {
            let name = match bit {
                0 => "ir_read_cf",
                2 => "ir_read_pf",
                4 => "ir_read_af",
                6 => "ir_read_zf",
                7 => "ir_read_sf",
                11 => "ir_read_of",
                _ => return None,
            };
            steps.push(Step::Read {
                cpu: Reading::Call {
                    name,
                    signature: Signature::new(&[], &[WasmType::I32]),
                },
                standalone: Reading::Memory {
                    address: Address::Flags,
                    load: Load::I32,
                },
            });
            // The tiny CPU adapters return the flag in its architectural bit
            // position, so both ABIs share extraction and I1 normalization.
            steps.extend([Step::I32(bit as i32), Step::Scalar(Scalar::I32Shr)]);
        },
        Op::ReadFlagOperand => read(&mut steps, Address::FlagOperand, Load::I32),
        Op::ReadFlagChanges => steps.push(Step::Read {
            cpu: Reading::Memory {
                address: Address::Absolute(gp::flags_changed as u32),
                load: Load::I32,
            },
            standalone: Reading::Constant(0),
        }),
        Op::ReadFlagResult => steps.push(Step::Read {
            cpu: Reading::Memory {
                address: Address::Absolute(gp::last_result as u32),
                load: Load::I32,
            },
            standalone: Reading::Constant(0),
        }),
        Op::ReadFlagSize => steps.push(Step::Read {
            cpu: Reading::Memory {
                address: Address::Absolute(gp::last_op_size as u32),
                load: Load::I32,
            },
            standalone: Reading::Constant(0),
        }),
        Op::ReadFlags => steps.push(Step::Read {
            cpu: Reading::Call {
                name: "get_eflags",
                signature: Signature::new(&[], &[WasmType::I32]),
            },
            standalone: Reading::Memory {
                address: Address::Flags,
                load: Load::I32,
            },
        }),
        Op::Binary(op) => {
            let t = ty(inst.args[0]);
            steps.push(Step::Value(inst.args[0]));
            if matches!(op, Binary::Slt | Binary::Sar) {
                signed(&mut steps, t);
            }
            steps.push(Step::Value(inst.args[1]));
            if op == Binary::Slt {
                signed(&mut steps, t);
            }
            steps.push(Step::Scalar(binary(op, t == Type::I64)));
        },
        Op::CountLeadingZeros | Op::CountTrailingZeros | Op::PopulationCount => {
            steps.push(Step::Value(inst.args[0]));
            steps.push(Step::Scalar(match (&inst.op, ty(inst.args[0])) {
                (Op::CountLeadingZeros, Type::I64) => Scalar::I64Clz,
                (Op::CountTrailingZeros, Type::I64) => Scalar::I64Ctz,
                (Op::PopulationCount, Type::I64) => Scalar::I64Popcnt,
                (Op::CountLeadingZeros, _) => Scalar::I32Clz,
                (Op::CountTrailingZeros, _) => Scalar::I32Ctz,
                (Op::PopulationCount, _) => Scalar::I32Popcnt,
                _ => unreachable!(),
            }));
        },
        Op::LinearOffset => steps.extend([
            Step::Value(inst.args[0]),
            Step::Value(inst.args[1]),
            Step::Scalar(Scalar::I32Add),
        ]),
        Op::Select => steps.extend([
            Step::Value(inst.args[1]),
            Step::Value(inst.args[2]),
            Step::Value(inst.args[0]),
            Step::Scalar(Scalar::Select),
        ]),
        Op::Extend { signed: sign } => {
            steps.push(Step::Value(inst.args[0]));
            if sign {
                signed(&mut steps, ty(inst.args[0]));
            }
            if ty(inst.results[0]) == Type::I64 {
                steps.push(Step::Scalar(if sign {
                    Scalar::I64ExtendSignedI32
                }
                else {
                    Scalar::I64ExtendUnsignedI32
                }));
            }
        },
        Op::Truncate => {
            steps.push(Step::Value(inst.args[0]));
            if ty(inst.args[0]) == Type::I64 {
                steps.push(Step::Scalar(Scalar::I32WrapI64));
            }
        },
        Op::Extract { lsb } => {
            steps.push(Step::Value(inst.args[0]));
            if ty(inst.args[0]) == Type::I64 {
                steps.extend([Step::I64(lsb as i64), Step::Scalar(Scalar::I64Shr)]);
                if ty(inst.results[0]) != Type::I64 {
                    steps.push(Step::Scalar(Scalar::I32WrapI64));
                }
            }
            else {
                steps.extend([Step::I32(lsb as i32), Step::Scalar(Scalar::I32Shr)]);
            }
        },
        Op::Insert { lsb } => {
            let bits = ty(inst.args[1]).bits().unwrap();
            let mask = if bits == 64 { u64::MAX } else { ((1u64 << bits) - 1) << lsb };
            steps.push(Step::Value(inst.args[0]));
            if ty(inst.results[0]) == Type::I64 {
                steps.extend([
                    Step::I64(!mask as i64),
                    Step::Scalar(Scalar::I64And),
                    Step::Value(inst.args[1]),
                ]);
                if ty(inst.args[1]) != Type::I64 {
                    steps.push(Step::Scalar(Scalar::I64ExtendUnsignedI32));
                }
                steps.extend([
                    Step::I64(lsb as i64),
                    Step::Scalar(Scalar::I64Shl),
                    Step::Scalar(Scalar::I64Or),
                ]);
            }
            else {
                steps.extend([
                    Step::I32(!mask as i32),
                    Step::Scalar(Scalar::I32And),
                    Step::Value(inst.args[1]),
                    Step::I32(lsb as i32),
                    Step::Scalar(Scalar::I32Shl),
                    Step::Scalar(Scalar::I32Or),
                ]);
            }
        },
        Op::VectorShuffle(lanes) => steps.extend([
            Step::Value(inst.args[0]),
            Step::Value(inst.args[1]),
            Step::Shuffle(lanes),
        ]),
        Op::VectorBinary(operation) => steps.push(Step::Packed {
            destination: inst.args[0],
            source: inst.args[1],
            plan: super::vector::lower(operation),
        }),
        Op::VectorBitmask { bits } => steps.extend([
            Step::Value(inst.args[0]),
            Step::Simd(match bits {
                8 => 0x64,
                32 => 0xA4,
                64 => 0xC4,
                _ => unreachable!(),
            }),
        ]),
        Op::VectorExtract { bits, lane } => steps.extend([
            Step::Value(inst.args[0]),
            Step::Lane {
                lane,
                opcode: match bits {
                    16 => 0x19,
                    32 => 0x1B,
                    64 => 0x1D,
                    _ => unreachable!(),
                },
            },
        ]),
        Op::VectorReplace { bits, lane } => steps.extend([
            Step::Value(inst.args[0]),
            Step::Value(inst.args[1]),
            Step::Lane {
                lane,
                opcode: match bits {
                    16 => 0x1A,
                    32 => 0x1C,
                    64 => 0x1E,
                    _ => unreachable!(),
                },
            },
        ]),
        _ => return None,
    }
    let result = inst.results[0];
    if let Some(bits) = ty(result).bits() {
        if bits < 32 {
            steps.extend([Step::I32((1i32 << bits) - 1), Step::Scalar(Scalar::I32And)]);
        }
    }
    Some(ValuePlan {
        result,
        steps,
        requires_cpu,
    })
}
pub fn verify(region: &Region, plans: &[Option<ValuePlan>]) -> Result<(), CompileError> {
    if plans.len() != region.instructions.len()
        || region
            .instructions
            .iter()
            .zip(plans)
            .any(|(inst, plan)| lower(region, inst).as_ref() != plan.as_ref())
    {
        return Err(CompileError::InvalidIr(
            "invalid lowered value program".into(),
        ));
    }
    for plan in plans.iter().flatten() {
        verify_program(region, plan)?;
    }
    Ok(())
}

impl Scalar {
    pub(super) fn signature(self) -> Option<(Vec<WasmType>, WasmType)> {
        use WasmType::{I32, I64};
        Some(match self {
            Self::I32Add => (vec![I32, I32], I32),
            Self::I32Sub => (vec![I32, I32], I32),
            Self::I32Mul => (vec![I32, I32], I32),
            Self::I32And => (vec![I32, I32], I32),
            Self::I32Or => (vec![I32, I32], I32),
            Self::I32Xor => (vec![I32, I32], I32),
            Self::I32Shl => (vec![I32, I32], I32),
            Self::I32Shr => (vec![I32, I32], I32),
            Self::I32Sar => (vec![I32, I32], I32),
            Self::I32Eq => (vec![I32, I32], I32),
            Self::I32Ult => (vec![I32, I32], I32),
            Self::I32Slt => (vec![I32, I32], I32),
            Self::I32Clz => (vec![I32], I32),
            Self::I32Ctz => (vec![I32], I32),
            Self::I32Popcnt => (vec![I32], I32),
            Self::I64Add => (vec![I64, I64], I64),
            Self::I64Sub => (vec![I64, I64], I64),
            Self::I64Mul => (vec![I64, I64], I64),
            Self::I64And => (vec![I64, I64], I64),
            Self::I64Or => (vec![I64, I64], I64),
            Self::I64Xor => (vec![I64, I64], I64),
            Self::I64Shl => (vec![I64, I64], I64),
            Self::I64Shr => (vec![I64, I64], I64),
            Self::I64Sar => (vec![I64, I64], I64),
            Self::I64Eq => (vec![I64, I64], I32),
            Self::I64Ult => (vec![I64, I64], I32),
            Self::I64Slt => (vec![I64, I64], I32),
            Self::I64Clz => (vec![I64], I64),
            Self::I64Ctz => (vec![I64], I64),
            Self::I64Popcnt => (vec![I64], I64),
            Self::I32WrapI64 => (vec![I64], I32),
            Self::I64ExtendSignedI32 | Self::I64ExtendUnsignedI32 => (vec![I32], I64),
            Self::Select => return None,
        })
    }
}
fn invalid() -> CompileError { CompileError::InvalidIr("invalid value program stack".into()) }
fn machine_type(ty: Type) -> Result<WasmType, CompileError> {
    match ty {
        Type::I1 | Type::I8 | Type::I16 | Type::I32 | Type::LinearAddress => Ok(WasmType::I32),
        Type::I64 | Type::RmwTicket => Ok(WasmType::I64),
        Type::V128 => Ok(WasmType::V128),
        _ => Err(invalid()),
    }
}
fn reading_type(reading: &Reading) -> Result<WasmType, CompileError> {
    match reading {
        Reading::Memory {
            load: Load::V128, ..
        } => Ok(WasmType::V128),
        Reading::Memory { .. } | Reading::Constant(_) => Ok(WasmType::I32),
        Reading::Call { signature, .. } => {
            if signature.params.is_empty() && signature.results.len() == 1 {
                Ok(signature.results[0])
            }
            else {
                Err(invalid())
            }
        },
    }
}
fn apply(
    stack: &mut Vec<WasmType>,
    params: &[WasmType],
    result: WasmType,
) -> Result<(), CompileError> {
    for ty in params.iter().rev() {
        if stack.pop().as_ref() != Some(ty) {
            return Err(invalid());
        }
    }
    stack.push(result);
    Ok(())
}
/// Stack typing consumes selected operations and value types, without HIR opcodes.
pub fn verify_program(region: &Region, plan: &ValuePlan) -> Result<(), CompileError> {
    let result = machine_type(
        region
            .values
            .get(plan.result.index())
            .ok_or_else(invalid)?
            .ty,
    )?;
    verify_expression(region, &plan.steps, result)
}
pub fn verify_expression(
    region: &Region,
    steps: &[Step],
    result: WasmType,
) -> Result<(), CompileError> {
    verify_expression_with(
        |value| machine_type(region.values.get(value.index()).ok_or_else(invalid)?.ty),
        steps,
        result,
    )
}
/// Post-lowering verification needs only the owned machine value types.
pub fn verify_program_types(types: &[Type], plan: &ValuePlan) -> Result<(), CompileError> {
    let ty = |value: ValueId| machine_type(*types.get(value.index()).ok_or_else(invalid)?);
    verify_expression_with(ty, &plan.steps, ty(plan.result)?)
}
pub(super) fn verify_expression_types(
    types: &[Type],
    steps: &[Step],
    result: WasmType,
) -> Result<(), CompileError> {
    verify_expression_with(
        |v| machine_type(*types.get(v.index()).ok_or_else(invalid)?),
        steps,
        result,
    )
}
fn verify_expression_with(
    ty: impl Fn(ValueId) -> Result<WasmType, CompileError>,
    steps: &[Step],
    result: WasmType,
) -> Result<(), CompileError> {
    use WasmType::{I32, I64, V128};
    let mut stack = vec![];
    for step in steps {
        match step {
            Step::Value(value) => stack.push(ty(*value)?),
            Step::I32(_) => stack.push(I32),
            Step::I64(_) => stack.push(I64),
            Step::Scalar(Scalar::Select) => {
                if stack.pop() != Some(I32) {
                    return Err(invalid());
                }
                let right = stack.pop().ok_or_else(invalid)?;
                if stack.pop() != Some(right) {
                    return Err(invalid());
                }
                stack.push(right);
            },
            Step::Scalar(op) => {
                let (params, result) = op.signature().unwrap();
                apply(&mut stack, &params, result)?;
            },
            Step::Read { cpu, standalone } => {
                let cpu = reading_type(cpu)?;
                if cpu != reading_type(standalone)? {
                    return Err(invalid());
                }
                stack.push(cpu);
            },
            Step::Simd(opcode) => {
                if !matches!(*opcode, 0x64 | 0xA4 | 0xC4) {
                    return Err(invalid());
                }
                apply(&mut stack, &[V128], I32)?;
            },
            Step::Lane { opcode, lane } => {
                let (limit, scalar, replace) = match *opcode {
                    0x19 => (8, I32, false),
                    0x1A => (8, I32, true),
                    0x1B => (4, I32, false),
                    0x1C => (4, I32, true),
                    0x1D => (2, I64, false),
                    0x1E => (2, I64, true),
                    _ => return Err(invalid()),
                };
                if *lane >= limit {
                    return Err(invalid());
                }
                if replace {
                    apply(&mut stack, &[V128, scalar], V128)?;
                }
                else {
                    apply(&mut stack, &[V128], scalar)?;
                }
            },
            Step::Shuffle(lanes) => {
                if lanes.iter().any(|&lane| lane >= 32) {
                    return Err(invalid());
                }
                apply(&mut stack, &[V128, V128], V128)?;
            },
            Step::Packed {
                destination,
                source,
                ..
            } => {
                if ty(*destination)? != V128 || ty(*source)? != V128 {
                    return Err(invalid());
                }
                stack.push(V128);
            },
        }
    }
    if stack != vec![result] {
        return Err(invalid());
    }
    Ok(())
}
