//! Ordered state writes and count phases selected before Wasm emission.
use super::value::{self, Address, Load, Reading, Scalar, Step};
use crate::cpu::{cpu::CS, global_pointers as gp};
use crate::ir::{
    hir::{Definition, Op, Region},
    lowering::CompileError,
    state::{ResumeKind, StateMap},
};
use crate::wasmgen::wasm_builder::WasmType;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Store {
    I32,
    V128,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Write {
    pub address: Address,
    pub store: Store,
    pub expression: Vec<Step>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CountMode {
    Absolute,
    Delta,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Count {
    pub destination: Address,
    pub snapshot: u32,
    pub base: Option<crate::ir::ids::ValueId>,
    pub mode: CountMode,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Materialization {
    pub writes: Vec<Write>,
    pub count: Count,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatePlan {
    pub after_instruction: bool,
    pub cpu: Materialization,
    pub standalone: Materialization,
    pub decoded_next: Write,
    pub requires_cpu: bool,
    /// CPU recovery writes exact v86 lazy-FLAGS backing instead of six
    /// canonical concrete arithmetic flags.
    pub lazy_flags: bool,
}
fn write(address: Address, expression: Vec<Step>) -> Write {
    Write {
        address,
        store: Store::I32,
        expression,
    }
}
fn cs_base() -> Step {
    let read = Reading::Memory {
        address: Address::Absolute(gp::get_seg_offset(CS as u32)),
        load: Load::I32,
    };
    Step::Read {
        cpu: read.clone(),
        standalone: read,
    }
}
fn constant_true(region: &Region, value: crate::ir::ids::ValueId) -> bool {
    constant_bool(region, value, true)
}
fn constant_bool(region: &Region, value: crate::ir::ids::ValueId, expected: bool) -> bool {
    BackingFacts::new(region).constant_bool(value, expected)
}
/// Shared predecessor index and memo for proving backing-validity constants
/// across every StateMap of one region. A page graph has thousands of states;
/// rescanning all block edges per phi and per state is quadratic.
pub(crate) struct BackingFacts<'a> {
    region: &'a Region,
    incoming: Vec<Vec<(u32, u8)>>,
    memo: std::collections::HashMap<(u32, bool), bool>,
}
impl<'a> BackingFacts<'a> {
    pub(crate) fn new(region: &'a Region) -> Self {
        let mut incoming = vec![Vec::new(); region.blocks.len()];
        for (b, block) in region.blocks.iter().enumerate() {
            match block.terminator.as_ref() {
                Some(crate::ir::hir::Terminator::Branch(edge)) => {
                    incoming[edge.target.index()].push((b as u32, 0))
                },
                Some(crate::ir::hir::Terminator::CondBranch {
                    taken, not_taken, ..
                }) => {
                    incoming[taken.target.index()].push((b as u32, 0));
                    incoming[not_taken.target.index()].push((b as u32, 1));
                },
                _ => {},
            }
        }
        Self {
            region,
            incoming,
            memo: Default::default(),
        }
    }
    fn arg(&self, (b, k): (u32, u8), index: usize) -> crate::ir::ids::ValueId {
        match self.region.blocks[b as usize].terminator.as_ref().unwrap() {
            crate::ir::hir::Terminator::Branch(edge) => edge.args[index],
            crate::ir::hir::Terminator::CondBranch {
                taken, not_taken, ..
            } => {
                if k == 0 {
                    taken.args[index]
                }
                else {
                    not_taken.args[index]
                }
            },
            crate::ir::hir::Terminator::Exit(_) => unreachable!(),
        }
    }
    // Prove a constant through phi cycles only when every external input agrees.
    // Unknown inputs and exhausted work retain the dynamic recovery path.
    pub(crate) fn constant_bool(&mut self, value: crate::ir::ids::ValueId, expected: bool) -> bool {
        if let Some(&known) = self.memo.get(&(value.0, expected)) {
            return known;
        }
        let region = self.region;
        let mut pending = vec![value];
        let mut seen = std::collections::HashSet::new();
        let mut found_constant = false;
        let mut work = 4096usize;
        let result = 'walk: {
            while let Some(value) = pending.pop() {
                if !seen.insert(value) {
                    continue;
                }
                let Some(left) = work.checked_sub(1)
                else {
                    break 'walk false;
                };
                work = left;
                match region.values[value.index()].definition {
                    Definition::Instruction(id, result) => {
                        if result != 0
                            || !matches!(region.instructions[id.index()].op, Op::Const(n) if n == expected as u64)
                        {
                            break 'walk false;
                        }
                        found_constant = true;
                    },
                    Definition::Parameter(block, index) => {
                        if region.entries.contains(&block) {
                            break 'walk false;
                        }
                        let edges = &self.incoming[block.index()];
                        if edges.is_empty() {
                            break 'walk false;
                        }
                        let Some(left) = work.checked_sub(edges.len())
                        else {
                            break 'walk false;
                        };
                        work = left;
                        for &edge in edges {
                            pending.push(self.arg(edge, index as usize));
                        }
                    },
                }
            }
            found_constant
        };
        self.memo.insert((value.0, expected), result);
        result
    }
}

#[cfg(test)]
mod backing_tests {
    use super::*;
    use crate::ir::{
        hir::{Edge, Terminator},
        types::Type,
    };

    #[test]
    fn phi_backing_requires_agreeing_external_constants() {
        let mut r = Region::default();
        let entry = r.block(true);
        let loop_block = r.block(false);
        let external = r.param(entry, Type::I1);
        let valid = r.append(entry, Op::Const(1), vec![], &[Type::I1], None)[0];
        let invalid = r.append(entry, Op::Const(0), vec![], &[Type::I1], None)[0];
        let phi = r.param(loop_block, Type::I1);
        r.terminate(
            entry,
            Terminator::Branch(Edge {
                target: loop_block,
                args: vec![valid],
            }),
        );
        r.terminate(
            loop_block,
            Terminator::Branch(Edge {
                target: loop_block,
                args: vec![phi],
            }),
        );
        assert!(constant_bool(&r, phi, true));
        assert!(!constant_bool(&r, phi, false));
        assert!(!constant_bool(&r, external, true));
        r.blocks[loop_block.index()].terminator = Some(Terminator::Branch(Edge {
            target: loop_block,
            args: vec![invalid],
        }));
        assert!(!constant_bool(&r, phi, true));
        assert!(!constant_bool(&r, phi, false));
        r.blocks[entry.index()].terminator = Some(Terminator::Branch(Edge {
            target: loop_block,
            args: vec![external],
        }));
        assert!(!constant_bool(&r, phi, false));
    }

    #[test]
    fn dynamic_backing_without_raw_zero_restores_all_slots() {
        use crate::ir::frontend::{
            decode::{GuestEip, LinearAddress},
            lift::lift_cpu,
        };
        let mut r = lift_cpu(&[0x90], GuestEip(0), LinearAddress(0), true).unwrap();
        let valid = r.param(r.entries[0], Type::I1);
        let mut state = r.states.last().unwrap().clone();
        state.flags.backing_valid = Some(valid);
        state.flags.raw_zero = None;
        state.flags.zero_is_lazy = None;
        let plan = lower(&r, &state);
        assert!(!plan.lazy_flags);
        for (address, value) in [
            (gp::last_result as u32, state.flags.last_result.unwrap()),
            (gp::last_op_size as u32, state.flags.last_op_size.unwrap()),
        ] {
            let write = plan
                .cpu
                .writes
                .iter()
                .find(|w| w.address == Address::Absolute(address))
                .unwrap();
            assert_eq!(write.expression.first(), Some(&Step::Value(value)));
            assert_eq!(write.expression.last(), Some(&Step::Scalar(Scalar::Select)));
        }
    }
}
fn exact_lazy_backing(facts: &mut BackingFacts, state: &StateMap) -> bool {
    state
        .flags
        .backing_valid
        .is_some_and(|value| facts.constant_bool(value, true))
        && state.flags.raw_flags.is_some()
        && state.flags.lazy_mask.is_some()
        && state.flags.last_result.is_some()
        && state.flags.last_op_size.is_some()
        && state.flags.last_op1.is_some()
}
fn target(state: &StateMap, cpu: bool, lazy_flags: bool, dynamic_backing: bool) -> Materialization {
    use Step::{Value, I32};
    let mut writes: Vec<_> = state
        .gpr
        .iter()
        .enumerate()
        .map(|(reg, &value)| write(Address::Gpr(reg as u8), vec![Value(value)]))
        .collect();
    for (reg, &value) in state.xmm.iter().enumerate() {
        writes.push(Write {
            address: Address::Absolute(gp::get_reg_xmm_offset(reg as u32)),
            store: Store::V128,
            expression: vec![Value(value)],
        });
    }
    if let Some(value) = state.flags.last_op1 {
        writes.push(write(Address::FlagOperand, vec![Value(value)]));
    }
    let raw_zero = if cpu { state.flags.raw_zero } else { None };
    if cpu && lazy_flags {
        writes.push(write(
            Address::Flags,
            vec![Value(state.flags.raw_flags.unwrap())],
        ));
        writes.push(write(
            Address::Absolute(gp::last_result as u32),
            vec![Value(state.flags.last_result.unwrap())],
        ));
        writes.push(write(
            Address::Absolute(gp::last_op_size as u32),
            vec![Value(state.flags.last_op_size.unwrap())],
        ));
        writes.push(write(
            Address::Absolute(gp::flags_changed as u32),
            vec![Value(state.flags.lazy_mask.unwrap())],
        ));
    }
    else {
        let mut flags = vec![
            Value(state.flags.system),
            I32(!0x8D5),
            Step::Scalar(Scalar::I32And),
        ];
        for (&value, shift) in state.flags.arithmetic.iter().zip([0, 2, 4, 6, 7, 11]) {
            flags.extend([
                Value(if shift == 6 { raw_zero.unwrap_or(value) } else { value }),
                I32(shift),
                Step::Scalar(Scalar::I32Shl),
                Step::Scalar(Scalar::I32Or),
            ]);
        }
        writes.push(write(Address::Flags, flags));
        if cpu {
            if raw_zero.is_some() {
                writes.push(write(
                    Address::Absolute(gp::last_result as u32),
                    vec![
                        Value(state.flags.arithmetic[3]),
                        I32(1),
                        Step::Scalar(Scalar::I32Xor),
                    ],
                ));
                writes.push(write(
                    Address::Absolute(gp::last_op_size as u32),
                    vec![I32(31)],
                ));
            }
            let lazy = if let Some(value) = state.flags.zero_is_lazy {
                vec![Value(value), I32(6), Step::Scalar(Scalar::I32Shl)]
            }
            else {
                vec![I32(0)]
            };
            writes.push(write(Address::Absolute(gp::flags_changed as u32), lazy));
        }
    }
    // A CFG phi or normal helper reload can carry valid backing dynamically.
    // Preserve the whole backing tuple when that certificate is true; retain
    // concrete/raw-ZF reconstruction for paths that invalidated it.
    if cpu && dynamic_backing {
        if let (Some(valid), Some(raw), Some(mask), Some(result), Some(size)) = (
            state.flags.backing_valid,
            state.flags.raw_flags,
            state.flags.lazy_mask,
            state.flags.last_result,
            state.flags.last_op_size,
        ) {
            for (address, value) in [
                (Address::Flags, raw),
                (Address::Absolute(gp::flags_changed as u32), mask),
                (Address::Absolute(gp::last_result as u32), result),
                (Address::Absolute(gp::last_op_size as u32), size),
            ] {
                if let Some(write) = writes.iter_mut().find(|write| write.address == address) {
                    let fallback = std::mem::take(&mut write.expression);
                    write.expression = vec![Value(value)];
                    write.expression.extend(fallback);
                    write
                        .expression
                        .extend([Value(valid), Step::Scalar(Scalar::Select)]);
                }
                else {
                    // Generic maps need not carry raw-ZF compatibility fields.
                    // Restore valid backing, retaining the old unused slot on
                    // the invalid path.
                    let reading = Reading::Memory {
                        address: address.clone(),
                        load: Load::I32,
                    };
                    writes.push(write(
                        address,
                        vec![
                            Value(value),
                            Step::Read {
                                cpu: reading.clone(),
                                standalone: reading,
                            },
                            Value(valid),
                            Step::Scalar(Scalar::Select),
                        ],
                    ));
                }
            }
        }
    }
    if cpu {
        writes.push(write(
            Address::Absolute(gp::previous_ip as u32),
            vec![
                cs_base(),
                I32(state.instruction_pc.0 as i32),
                Step::Scalar(Scalar::I32Add),
            ],
        ));
    }
    let mut eip = vec![if let Some(value) = state.next_value {
        Value(value)
    }
    else {
        I32(if state.resume == ResumeKind::AfterInstruction {
            state.next_pc.0
        }
        else {
            state.instruction_pc.0
        } as i32)
    }];
    if cpu {
        eip.extend([cs_base(), Step::Scalar(Scalar::I32Add)]);
    }
    writes.push(write(Address::Eip, eip));
    Materialization {
        writes,
        count: Count {
            destination: Address::Committed,
            snapshot: state.committed_instructions,
            base: state.count_base,
            mode: if cpu { CountMode::Delta } else { CountMode::Absolute },
        },
    }
}
pub fn lower(region: &Region, state: &StateMap) -> StatePlan {
    lower_with(&mut BackingFacts::new(region), state)
}
/// Every StateMap of one region, sharing one backing-validity analysis.
pub fn lower_all(region: &Region) -> Vec<StatePlan> {
    let mut facts = BackingFacts::new(region);
    region
        .states
        .iter()
        .map(|state| lower_with(&mut facts, state))
        .collect()
}
fn lower_with(facts: &mut BackingFacts, state: &StateMap) -> StatePlan {
    let lazy_flags = exact_lazy_backing(facts, state);
    let dynamic_backing = !lazy_flags
        && state.flags.last_op1.is_some()
        && state
            .flags
            .backing_valid
            .is_some_and(|value| !facts.constant_bool(value, false));
    StatePlan {
        after_instruction: state.resume == ResumeKind::AfterInstruction,
        cpu: target(state, true, lazy_flags, dynamic_backing),
        standalone: target(state, false, false, false),
        requires_cpu: !state.xmm.is_empty(),
        lazy_flags,
        decoded_next: write(
            Address::Absolute(gp::instruction_pointer as u32),
            vec![
                cs_base(),
                Step::I32(state.next_pc.0 as i32),
                Step::Scalar(Scalar::I32Add),
            ],
        ),
    }
}
pub fn verify(region: &Region, plans: &[StatePlan]) -> Result<(), CompileError> {
    let mut facts = BackingFacts::new(region);
    if plans.len() != region.states.len()
        || region
            .states
            .iter()
            .zip(plans)
            .any(|(s, p)| lower_with(&mut facts, s) != *p)
    {
        return Err(CompileError::InvalidIr(
            "invalid state materialization plan".into(),
        ));
    }
    for plan in plans {
        for count in [&plan.cpu.count, &plan.standalone.count] {
            if let Some(base) = count.base {
                value::verify_expression(region, &[Step::Value(base)], WasmType::I32)?;
            }
        }
        for write in plan
            .cpu
            .writes
            .iter()
            .chain(&plan.standalone.writes)
            .chain(std::iter::once(&plan.decoded_next))
        {
            value::verify_expression(
                region,
                &write.expression,
                match write.store {
                    Store::I32 => WasmType::I32,
                    Store::V128 => WasmType::V128,
                },
            )?;
        }
    }
    Ok(())
}
