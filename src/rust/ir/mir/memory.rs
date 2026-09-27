//! Explicit RAM guard, physical action and CPU slow edge produced by lowering.
use crate::cpu::cpu::{TLB_HAS_CODE, TLB_IN_MAPPED_RANGE, TLB_NO_USER, TLB_READONLY, TLB_VALID};
use crate::ir::{
    hir::{Instruction, Op, Region},
    ids::{StateId, ValueId},
    lowering::CompileError,
    types::Type,
};
use crate::wasmgen::wasm_builder::{Signature, WasmType};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RamGuard {
    pub bytes: u8,
    pub flags_mask: i32,
    pub required_flags: i32,
    pub user_mask: i32,
    pub page_offset_limit: i32,
}
impl RamGuard {
    pub fn new(bytes: u8, write: bool) -> Self {
        Self {
            bytes,
            flags_mask: TLB_VALID
                | TLB_IN_MAPPED_RANGE
                | if write { TLB_HAS_CODE | TLB_READONLY } else { 0 },
            required_flags: TLB_VALID,
            user_mask: TLB_NO_USER,
            page_offset_limit: 4097 - bytes as i32,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Argument {
    Value(ValueId),
    I32(i32),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCall {
    pub name: &'static str,
    pub signature: Signature,
    pub args: Vec<Argument>,
}
impl RuntimeCall {
    pub(super) fn i32(name: &'static str, args: Vec<Argument>, result: WasmType) -> Self {
        Self {
            name,
            signature: Signature::new(&vec![WasmType::I32; args.len()], &[result]),
            args,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VectorCombine {
    None,
    ReplaceWord {
        old: ValueId,
        lane: u8,
    },
    Shuffle {
        old: ValueId,
        lanes: [u8; 16],
    },
    Binary {
        old: ValueId,
        plan: super::vector::PackedPlan,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NativeMemory {
    ScalarLoad {
        result: ValueId,
        ticket: Option<ValueId>,
    },
    ScalarStore {
        value: ValueId,
        commit: Option<StateId>,
    },
    VectorLoad {
        result: ValueId,
        combine: VectorCombine,
    },
    VectorStore {
        value: ValueId,
        lane: u8,
        mask: Option<ValueId>,
        commit: StateId,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SlowResult {
    Packed {
        result: ValueId,
        trap_after_fault: bool,
    },
    Rmw {
        result: ValueId,
        ticket: ValueId,
        read_value: RuntimeCall,
    },
    Store {
        commit: Option<StateId>,
        trap_after_fault: bool,
    },
    /// Both success and fault leave authoritative CPU state; no SSA restoration.
    CpuExit { accepted: [i32; 2] },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryPlan {
    pub address: ValueId,
    pub before: StateId,
    pub guard: RamGuard,
    pub native: NativeMemory,
    pub call: RuntimeCall,
    pub result: SlowResult,
}
pub fn lower(inst: &Instruction) -> Option<MemoryPlan> {
    use Argument::{Value, I32};
    let (bytes, write, native, call, result) = match inst.op {
        Op::GuestLoad { bytes } | Op::RmwLoad { bytes, .. } => {
            let rmw = matches!(inst.op, Op::RmwLoad { .. });
            let result = inst.results[0];
            let ticket = rmw.then(|| inst.results[1]);
            (
                bytes,
                rmw,
                NativeMemory::ScalarLoad { result, ticket },
                RuntimeCall::i32(
                    if rmw { "ir_rmw_read" } else { "ir_memory_read" },
                    vec![Value(inst.args[0]), I32(bytes as i32)],
                    WasmType::I64,
                ),
                if let Some(ticket) = ticket {
                    SlowResult::Rmw {
                        result,
                        ticket,
                        read_value: RuntimeCall::i32("ir_rmw_value", vec![], WasmType::I32),
                    }
                }
                else {
                    SlowResult::Packed {
                        result,
                        trap_after_fault: inst.trap_after_fault,
                    }
                },
            )
        },
        Op::GuestStore { bytes } | Op::PartialStore { bytes } => (
            bytes,
            true,
            NativeMemory::ScalarStore {
                value: inst.args[1],
                commit: inst.commit,
            },
            RuntimeCall::i32(
                if inst.unmasked_word_store {
                    "ir_memory_write_unmasked_word"
                }
                else {
                    "ir_memory_write"
                },
                vec![Value(inst.args[0]), Value(inst.args[1]), I32(bytes as i32)],
                WasmType::I32,
            ),
            SlowResult::Store {
                commit: inst.commit,
                trap_after_fault: inst.trap_after_fault,
            },
        ),
        Op::XmmLoad { bytes, register } => (
            bytes,
            false,
            NativeMemory::VectorLoad {
                result: inst.results[0],
                combine: VectorCombine::None,
            },
            RuntimeCall::i32(
                "ir_xmm_load",
                vec![Value(inst.args[0]), I32(register as i32), I32(bytes as i32)],
                WasmType::I32,
            ),
            SlowResult::CpuExit { accepted: [2, 4] },
        ),
        Op::XmmInsertWord { register, lane } => (
            2,
            false,
            NativeMemory::VectorLoad {
                result: inst.results[0],
                combine: VectorCombine::ReplaceWord {
                    old: inst.args[1],
                    lane,
                },
            },
            RuntimeCall::i32(
                "ir_xmm_insert_word",
                vec![Value(inst.args[0]), I32(register as i32), I32(lane as i32)],
                WasmType::I32,
            ),
            SlowResult::CpuExit { accepted: [2, 4] },
        ),
        Op::XmmShuffle {
            operation,
            immediate,
            register,
        } => (
            16,
            false,
            NativeMemory::VectorLoad {
                result: inst.results[0],
                combine: VectorCombine::Shuffle {
                    old: inst.args[1],
                    lanes: operation.lanes(immediate),
                },
            },
            RuntimeCall::i32(
                "ir_xmm_shuffle",
                vec![
                    Value(inst.args[0]),
                    I32(register as i32),
                    I32(operation as i32),
                    I32(immediate as i32),
                ],
                WasmType::I32,
            ),
            SlowResult::CpuExit { accepted: [2, 4] },
        ),
        Op::XmmTransferLoad {
            operation,
            register,
        } => (
            operation.bytes(),
            false,
            NativeMemory::VectorLoad {
                result: inst.results[0],
                combine: VectorCombine::Shuffle {
                    old: inst.args[1],
                    lanes: operation.lanes(),
                },
            },
            RuntimeCall::i32(
                "ir_xmm_transfer_load",
                vec![
                    Value(inst.args[0]),
                    I32(register as i32),
                    I32(operation as i32),
                ],
                WasmType::I32,
            ),
            SlowResult::CpuExit { accepted: [2, 4] },
        ),
        Op::XmmBinary {
            operation,
            bytes,
            register,
        } => (
            bytes,
            false,
            NativeMemory::VectorLoad {
                result: inst.results[0],
                combine: VectorCombine::Binary {
                    old: inst.args[1],
                    plan: super::vector::lower(operation),
                },
            },
            RuntimeCall::i32(
                "ir_xmm_binary",
                vec![
                    Value(inst.args[0]),
                    I32(register as i32),
                    I32(operation as i32),
                    I32(bytes as i32),
                ],
                WasmType::I32,
            ),
            SlowResult::CpuExit { accepted: [2, 4] },
        ),
        Op::XmmStore {
            bytes,
            register,
            lane,
        } => (
            bytes,
            true,
            NativeMemory::VectorStore {
                value: inst.args[1],
                lane,
                mask: None,
                commit: inst.commit.unwrap(),
            },
            RuntimeCall::i32(
                "ir_xmm_store",
                vec![
                    Value(inst.args[0]),
                    I32(register as i32),
                    I32(bytes as i32),
                    I32(lane as i32),
                ],
                WasmType::I32,
            ),
            SlowResult::CpuExit { accepted: [2, 4] },
        ),
        Op::XmmMaskedStore { source, mask } => (
            16,
            true,
            NativeMemory::VectorStore {
                value: inst.args[1],
                lane: 0,
                mask: Some(inst.args[2]),
                commit: inst.commit.unwrap(),
            },
            RuntimeCall::i32(
                "ir_xmm_masked_store",
                vec![Value(inst.args[0]), I32(source as i32), I32(mask as i32)],
                WasmType::I32,
            ),
            SlowResult::CpuExit { accepted: [2, 4] },
        ),
        _ => return None,
    };
    Some(MemoryPlan {
        address: inst.args[0],
        before: inst.state.unwrap(),
        guard: RamGuard::new(bytes, write),
        native,
        call,
        result,
    })
}
pub fn verify(region: &Region, plans: &[Option<MemoryPlan>]) -> Result<(), CompileError> {
    let invalid = || CompileError::InvalidIr("invalid lowered memory plan".into());
    if plans.len() != region.instructions.len() {
        return Err(invalid());
    }
    for (inst, plan) in region.instructions.iter().zip(plans) {
        // The HIR association prevents stale plans after edits to state/value arenas.
        if lower(inst).as_ref() != plan.as_ref() {
            return Err(invalid());
        }
        if let Some(plan) = plan {
            let ty = region
                .values
                .get(plan.address.index())
                .ok_or_else(invalid)?
                .ty;
            if ty != Type::LinearAddress || !matches!(plan.guard.bytes, 1 | 2 | 4 | 8 | 16) {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
