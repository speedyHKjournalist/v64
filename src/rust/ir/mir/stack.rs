//! Fuse adjacent, single-use scalar value programs onto the Wasm operand stack.
//! No read, helper, fault, state observation or CFG edge is moved.
use super::{
    allocation,
    value::{verify_program_types, Step},
    MirData,
};
use crate::ir::{lowering::CompileError, types::Type};
pub fn schedule(data: &mut MirData, work_limit: usize) -> Result<usize, CompileError> {
    let mut left = work_limit;
    let mut counts = allocation::use_counts(data, &mut left)?;
    let mut values = data.values.clone();
    let mut elided = data.stack_elided.clone();
    let mut fused = 0;
    loop {
        let start = fused;
        for block in allocation::blocks(data) {
            let mut previous: Option<usize> = None;
            for id in block {
                left = left
                    .checked_sub(1)
                    .ok_or(CompileError::Budget("machine stack scheduling work"))?;
                if elided[id.index()] {
                    continue;
                }
                let Some(consumer) = values[id.index()].as_ref()
                else {
                    previous = None;
                    continue;
                };
                if let Some(before) = previous {
                    let producer = values[before].as_ref().unwrap();
                    let result = producer.result;
                    if counts[result.index()] == 1
                        && matches!(data.value_types[result.index()], Type::I32 | Type::I64)
                        && producer.steps.iter().all(|s| {
                            matches!(
                                s,
                                Step::Value(_) | Step::I32(_) | Step::I64(_) | Step::Scalar(_)
                            )
                        })
                        && consumer.steps.iter().any(|s| *s == Step::Value(result))
                    {
                        let size = consumer.steps.len() + producer.steps.len() - 1;
                        left = left
                            .checked_sub(size)
                            .ok_or(CompileError::Budget("machine stack scheduling work"))?;
                        if size <= 256 {
                            let mut rewritten = consumer.clone();
                            rewritten.steps = consumer
                                .steps
                                .iter()
                                .flat_map(|s| {
                                    if *s == Step::Value(result) {
                                        producer.steps.clone()
                                    }
                                    else {
                                        vec![s.clone()]
                                    }
                                })
                                .collect();
                            verify_program_types(&data.value_types, &rewritten)?;
                            values[id.index()] = Some(rewritten);
                            elided[before] = true;
                            counts[result.index()] = 0;
                            fused += 1;
                        }
                    }
                }
                previous = Some(id.index());
            }
        }
        if fused == start {
            break;
        }
    }
    data.values = values;
    data.stack_elided = elided;
    Ok(fused)
}
