//! Literal-only postfix rewrites. No CPU reads, helpers or SSA operations move.
use super::{
    value::{verify_program_types, Scalar, Step},
    MirData,
};
use crate::ir::lowering::CompileError;

#[cfg(test)]
#[path = "../../../../tests/ir/semantics/mir_owned.rs"]
mod tests;

fn unary(value: &Step, op: Scalar) -> Option<Step> {
    use Scalar::*;
    Some(match (value, op) {
        (Step::I32(n), I32Clz) => Step::I32(n.leading_zeros() as i32),
        (Step::I32(n), I32Ctz) => Step::I32(n.trailing_zeros() as i32),
        (Step::I32(n), I32Popcnt) => Step::I32(n.count_ones() as i32),
        (Step::I32(n), I64ExtendSignedI32) => Step::I64(*n as i64),
        (Step::I32(n), I64ExtendUnsignedI32) => Step::I64(*n as u32 as i64),
        (Step::I64(n), I64Clz) => Step::I64(n.leading_zeros() as i64),
        (Step::I64(n), I64Ctz) => Step::I64(n.trailing_zeros() as i64),
        (Step::I64(n), I64Popcnt) => Step::I64(n.count_ones() as i64),
        (Step::I64(n), I32WrapI64) => Step::I32(*n as i32),
        _ => return None,
    })
}
fn binary(left: &Step, right: &Step, op: Scalar) -> Option<Step> {
    use Scalar::*;
    Some(match (left, right) {
        (Step::I32(a), Step::I32(b)) => Step::I32(match op {
            I32Add => a.wrapping_add(*b),
            I32Sub => a.wrapping_sub(*b),
            I32Mul => a.wrapping_mul(*b),
            I32And => a & b,
            I32Or => a | b,
            I32Xor => a ^ b,
            I32Shl => a.wrapping_shl(*b as u32),
            I32Shr => (*a as u32).wrapping_shr(*b as u32) as i32,
            I32Sar => a.wrapping_shr(*b as u32),
            I32Eq => i32::from(a == b),
            I32Ult => i32::from((*a as u32) < (*b as u32)),
            I32Slt => i32::from(a < b),
            _ => return None,
        }),
        (Step::I64(a), Step::I64(b)) => match op {
            I64Eq => Step::I32(i32::from(a == b)),
            I64Ult => Step::I32(i32::from((*a as u64) < (*b as u64))),
            I64Slt => Step::I32(i32::from(a < b)),
            _ => Step::I64(match op {
                I64Add => a.wrapping_add(*b),
                I64Sub => a.wrapping_sub(*b),
                I64Mul => a.wrapping_mul(*b),
                I64And => a & b,
                I64Or => a | b,
                I64Xor => a ^ b,
                I64Shl => a.wrapping_shl(*b as u32),
                I64Shr => (*a as u64).wrapping_shr(*b as u32) as i64,
                I64Sar => a.wrapping_shr(*b as u32),
                _ => return None,
            }),
        },
        _ => return None,
    })
}
pub(super) fn expression(steps: &[Step]) -> (Vec<Step>, usize) {
    let mut out = Vec::with_capacity(steps.len());
    let mut folds = 0;
    for step in steps {
        out.push(step.clone());
        let Step::Scalar(op) = step
        else {
            continue;
        };
        let n = out.len();
        let replacement = if *op == Scalar::Select && n >= 4 {
            match (&out[n - 4], &out[n - 3], &out[n - 2]) {
                (Step::I32(_), Step::I32(_), Step::I32(condition))
                | (Step::I64(_), Step::I64(_), Step::I32(condition)) => {
                    Some((4, out[n - if *condition != 0 { 4 } else { 3 }].clone()))
                },
                _ => None,
            }
        }
        else {
            None
        }
        .or_else(|| {
            (n >= 2)
                .then(|| unary(&out[n - 2], *op))
                .flatten()
                .map(|v| (2, v))
        })
        .or_else(|| {
            (n >= 3)
                .then(|| binary(&out[n - 3], &out[n - 2], *op))
                .flatten()
                .map(|v| (3, v))
        });
        if let Some((removed, value)) = replacement {
            out.truncate(n - removed);
            out.push(value);
            folds += 1;
        }
    }
    (out, folds)
}
pub(super) fn fold_constants(data: &mut MirData) -> Result<usize, CompileError> {
    let mut changed = Vec::new();
    let mut folds = 0;
    let mut work = 0usize;
    for (index, plan) in data.values.iter().enumerate() {
        let Some(plan) = plan
        else {
            continue;
        };
        work = work.saturating_add(plan.steps.len());
        if work > 1_000_000 {
            return Err(CompileError::Budget("MIR constant folding work"));
        }
        let (steps, count) = expression(&plan.steps);
        if count != 0 {
            let mut replacement = plan.clone();
            replacement.steps = steps;
            verify_program_types(&data.value_types, &replacement)?;
            changed.push((index, replacement));
            folds += count;
        }
    }
    for (index, plan) in changed {
        data.values[index] = Some(plan);
    }
    Ok(folds)
}
