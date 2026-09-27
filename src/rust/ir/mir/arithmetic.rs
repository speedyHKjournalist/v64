//! Checked i64 division and CPU-register compare/exchange selected by lowering.
use super::memory::{Argument, RamGuard, RuntimeCall};
use crate::wasmgen::wasm_builder::{Signature, WasmType};
use crate::{
    cpu::global_pointers as gp,
    ir::{
        hir::{Instruction, Op},
        ids::{StateId, ValueId},
    },
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuotientRange {
    Signed { minimum: i64, maximum: i64 },
    Unsigned { maximum: i64 },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Division {
    pub dividend: ValueId,
    pub divisor: ValueId,
    pub quotient: ValueId,
    pub remainder: ValueId,
    pub signed: bool,
    pub overflow_pair: Option<(i64, i64)>,
    pub range: QuotientRange,
    pub before: StateId,
    pub fault: RuntimeCall,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisterPair {
    pub low: u32,
    pub high: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompareExchange {
    pub address: ValueId,
    pub before: StateId,
    pub guard: RamGuard,
    pub expected: RegisterPair,
    pub replacement: RegisterPair,
    pub flags: u32,
    pub flags_changed: u32,
    pub zero_mask: i32,
    pub zero_shift: i32,
    pub counter: u32,
    pub increment: i32,
    pub call: RuntimeCall,
    pub outcomes: [i32; 2],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArithmeticPlan {
    Division(Division),
    CompareExchange(CompareExchange),
}
impl ArithmeticPlan {
    pub fn call(&self) -> &RuntimeCall {
        match self {
            Self::Division(p) => &p.fault,
            Self::CompareExchange(p) => &p.call,
        }
    }
}
pub fn lower(inst: &Instruction) -> Option<ArithmeticPlan> {
    Some(match inst.op {
        Op::Divide { bits, signed } => ArithmeticPlan::Division(Division {
            dividend: inst.args[0],
            divisor: inst.args[1],
            quotient: inst.results[0],
            remainder: inst.results[1],
            signed,
            overflow_pair: signed.then_some((i64::MIN, -1)),
            range: if signed {
                QuotientRange::Signed {
                    minimum: -(1i64 << (bits - 1)),
                    maximum: (1i64 << (bits - 1)) - 1,
                }
            }
            else {
                QuotientRange::Unsigned {
                    maximum: (1i64 << bits) - 1,
                }
            },
            before: inst.state.unwrap(),
            fault: RuntimeCall {
                name: "ir_divide_fault",
                signature: Signature::new(&[], &[]),
                args: vec![],
            },
        }),
        Op::CompareExchange8B { .. } => ArithmeticPlan::CompareExchange(CompareExchange {
            address: inst.args[0],
            before: inst.state.unwrap(),
            guard: RamGuard::new(8, true),
            expected: RegisterPair {
                low: gp::get_reg32_offset(0),
                high: gp::get_reg32_offset(2),
            },
            replacement: RegisterPair {
                low: gp::get_reg32_offset(3),
                high: gp::get_reg32_offset(1),
            },
            flags: gp::flags as u32,
            flags_changed: gp::flags_changed as u32,
            zero_mask: 64,
            zero_shift: 6,
            counter: gp::instruction_counter as u32,
            increment: 1,
            call: RuntimeCall {
                name: "ir_cmpxchg8b",
                signature: Signature::new(&[WasmType::I32], &[WasmType::I32]),
                args: vec![Argument::Value(inst.args[0])],
            },
            outcomes: [2, 4],
        }),
        _ => return None,
    })
}
