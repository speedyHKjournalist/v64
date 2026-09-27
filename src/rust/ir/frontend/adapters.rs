//! Frontend construction of audited CPU helper calls.
use super::integer::IntegerBuilder;
use crate::ir::{
    helper::{cpu_registry, HelperAbi},
    hir::{Op, Terminator},
    ids::{HelperId, StateId, ValueId},
    types::Type,
};
pub(super) fn call(
    b: &mut IntegerBuilder,
    name: &str,
    args: Vec<ValueId>,
    state: StateId,
    terminal: bool,
) {
    call_abi(
        b,
        name,
        args,
        state,
        if terminal {
            HelperAbi::CpuExit
        }
        else {
            HelperAbi::Outcome {
                fault_delivery: None,
                normal_preserves_state: true,
            }
        },
    );
}
pub(super) fn call_abi(
    b: &mut IntegerBuilder,
    name: &str,
    args: Vec<ValueId>,
    state: StateId,
    abi: HelperAbi,
) {
    let selective = (name == "ir_sse_fp_reg_continue")
        .then(|| cpu_registry::xmm_register_operands(&b.region, &args))
        .flatten();
    let terminal = matches!(abi, HelperAbi::CpuExit | HelperAbi::CpuRep);
    let reload = matches!(abi, HelperAbi::CpuReload);
    let mut descriptor = cpu_registry::descriptor(name, args.iter().map(|&a| b.ty(a)).collect())
        .expect("byte frontend CPU helper must have a registered ABI");
    descriptor.abi = abi;
    descriptor
        .validate()
        .expect("byte frontend CPU helper ABI must match registry");
    let id = HelperId(b.region.helpers.len() as u32);
    let mut result_types = descriptor.results.clone();
    result_types.push(Type::Effect);
    b.region.helpers.push(descriptor);
    let mut args = args;
    args.push(b.effect);
    let values = b.region.append(
        b.block,
        Op::CallHelper(id),
        args,
        &result_types,
        Some(state),
    );
    b.effect = *values.last().unwrap();
    if reload {
        if let Some((_, destination)) = selective {
            b.xmm[destination as usize] = values[14 + destination as usize];
        }
        else {
            b.reload_cpu_state(&values[..values.len() - 1]);
        }
    }
    if terminal {
        b.region.terminate(b.block, Terminator::Exit(state));
    }
}
