//! Bounded, transactional identities for integer/vector SSA values.
//!
//! These rules never fold CPU reads, floating point, memory or architectural
//! checks. Rewrites retain observation nodes and update all StateMap/edge uses.
use super::rewrite_values;
use crate::ir::{analysis::cfg::Cfg, hir::*, ids::*, simd::PackedOp, verify::verify};

pub const DEFAULT_WORK_LIMIT: usize = 1_000_000;
#[derive(Default, Debug)]
pub struct Stats {
    pub eliminated: usize,
    pub shuffled: usize,
}
struct Work(usize);
impl Work {
    fn spend(&mut self, n: usize) -> Result<(), String> {
        self.0 = self
            .0
            .checked_sub(n)
            .ok_or("SIMD simplification work budget exceeded")?;
        Ok(())
    }
}
fn pure(i: &Instruction) -> bool {
    i.results.len() == 1
        && i.state.is_none()
        && i.commit.is_none()
        && !i.trap_after_fault
        && !i.unmasked_word_store
}
fn definition(r: &Region, v: ValueId) -> Option<&Instruction> {
    match r.values[v.index()].definition {
        Definition::Instruction(id, _) => Some(&r.instructions[id.index()]),
        Definition::Parameter(_, _) => None,
    }
}
fn resolve(mut v: ValueId, aliases: &[ValueId], work: &mut Work) -> Result<ValueId, String> {
    loop {
        work.spend(1)?;
        let next = aliases[v.index()];
        if next == v {
            return Ok(v);
        }
        v = next;
    }
}
fn zero(r: &Region, v: ValueId) -> bool {
    definition(r, v).is_some_and(|i| {
        pure(i)
            && i.args.len() == 2
            && i.args[0] == i.args[1]
            && matches!(
                i.op,
                Op::VectorBinary(
                    PackedOp::Xor
                        | PackedOp::AndNot
                        | PackedOp::Sub8
                        | PackedOp::Sub16
                        | PackedOp::Sub32
                        | PackedOp::Sub64
                )
            )
    })
}
fn identity(r: &Region, i: &Instruction) -> Option<ValueId> {
    match i.op {
        Op::VectorBinary(op) => {
            let a = i.args[0];
            let b = i.args[1];
            if a == b
                && matches!(
                    op,
                    PackedOp::And
                        | PackedOp::Or
                        | PackedOp::MinU8
                        | PackedOp::MaxU8
                        | PackedOp::MinS16
                        | PackedOp::MaxS16
                        | PackedOp::AvgU8
                        | PackedOp::AvgU16
                )
            {
                return Some(a);
            }
            if zero(r, b)
                && matches!(
                    op,
                    PackedOp::Or
                        | PackedOp::Xor
                        | PackedOp::Add8
                        | PackedOp::Add16
                        | PackedOp::Add32
                        | PackedOp::Add64
                        | PackedOp::Sub8
                        | PackedOp::Sub16
                        | PackedOp::Sub32
                        | PackedOp::Sub64
                )
            {
                return Some(a);
            }
            if zero(r, a)
                && matches!(
                    op,
                    PackedOp::Or
                        | PackedOp::Xor
                        | PackedOp::Add8
                        | PackedOp::Add16
                        | PackedOp::Add32
                        | PackedOp::Add64
                )
            {
                return Some(b);
            }
            // x86 PANDN is (~a) & b, not Wasm andnot(a,b).
            if op == PackedOp::AndNot {
                if zero(r, a) || zero(r, b) {
                    return Some(b);
                }
            }
            if op == PackedOp::And {
                if zero(r, a) {
                    return Some(a);
                }
                if zero(r, b) {
                    return Some(b);
                }
            }
            None
        },
        Op::VectorReplace { bits, lane } => {
            let scalar = definition(r, i.args[1])?;
            if pure(scalar)
                && scalar.op == (Op::VectorExtract { bits, lane })
                && scalar.args[0] == i.args[0]
            {
                Some(i.args[0])
            }
            else {
                None
            }
        },
        Op::VectorExtract { bits, lane } if bits == 32 || bits == 64 => {
            let vector = definition(r, i.args[0])?;
            if pure(vector) && vector.op == (Op::VectorReplace { bits, lane }) {
                Some(vector.args[1])
            }
            else {
                None
            }
        },
        _ => None,
    }
}
// Resolve one shuffle layer into exact (SSA source, byte) provenance. A legal
// i8x16.shuffle has only two inputs, so refuse a composition needing >2 leaves.
fn shuffle(r: &Region, i: &Instruction, mask: [u8; 16]) -> Option<(Vec<ValueId>, [u8; 16])> {
    let mut leaves = Vec::new();
    let mut output = [0; 16];
    for (index, byte) in mask.into_iter().enumerate() {
        let mut source = i.args[usize::from(byte / 16)];
        let mut offset = byte % 16;
        if let Some(inner) = definition(r, source).filter(|inner| pure(inner)) {
            if let Op::VectorShuffle(inner_mask) = inner.op {
                let selected = inner_mask[usize::from(offset)];
                source = inner.args[usize::from(selected / 16)];
                offset = selected % 16;
            }
        }
        let position = if let Some(p) = leaves.iter().position(|&v| v == source) {
            p
        }
        else {
            leaves.push(source);
            leaves.len() - 1
        };
        if position > 1 {
            return None;
        }
        output[index] = position as u8 * 16 + offset;
    }
    if leaves.len() == 1 {
        leaves.push(leaves[0]);
    }
    Some((leaves, output))
}

pub fn run(region: &mut Region, limit: usize) -> Result<Stats, String> {
    if region.blocks.len() > super::MAX_BLOCKS
        || region.instructions.len() > super::MAX_INSTRUCTIONS
        || region.values.len() > super::MAX_VALUES
        || region.states.len() > super::MAX_STATES
    {
        return Err("SIMD simplification region budget exceeded".into());
    }
    let mut work = Work(limit);
    work.spend(region.instructions.len() + region.values.len() + region.states.len() + 1)?;
    if crate::ir::debug::audit() {
        verify(region).map_err(|e| e.0)?;
    }
    // Scalar-only regions do not need dominance analysis or a private copy.
    if !region
        .blocks
        .iter()
        .flat_map(|b| &b.instructions)
        .any(|id| {
            matches!(
                region.instructions[id.index()].op,
                Op::VectorBinary(_)
                    | Op::VectorShuffle(_)
                    | Op::VectorReplace { .. }
                    | Op::VectorExtract { .. }
            )
        })
    {
        return Ok(Stats::default());
    }
    let cfg = Cfg::compute(region)?;
    let mut draft = region.clone();
    let mut aliases: Vec<_> = (0..draft.values.len()).map(|n| ValueId(n as u32)).collect();
    let mut removed = vec![false; draft.instructions.len()];
    let mut stats = Stats::default();
    let mut order: Vec<_> = (0..draft.blocks.len()).collect();
    order.sort_by_key(|&b| (cfg.dominator_count(b), b));
    for b in order {
        for id in draft.blocks[b].instructions.clone() {
            work.spend(1)?;
            for arg in &mut draft.instructions[id.index()].args {
                *arg = resolve(*arg, &aliases, &mut work)?;
            }
            let mut inst = draft.instructions[id.index()].clone();
            if !pure(&inst) {
                continue;
            }
            let mut replacement = identity(&draft, &inst);
            if let Op::VectorShuffle(mask) = inst.op {
                work.spend(16)?;
                if let Some((args, next)) = shuffle(&draft, &inst, mask) {
                    if next.iter().enumerate().all(|(n, &v)| usize::from(v) == n) {
                        replacement = Some(args[0]);
                    }
                    else if args != inst.args || next != mask {
                        inst.args = args;
                        inst.op = Op::VectorShuffle(next);
                        draft.instructions[id.index()] = inst.clone();
                        stats.shuffled += 1;
                    }
                }
            }
            if let Some(value) = replacement {
                let value = resolve(value, &aliases, &mut work)?;
                aliases[inst.results[0].index()] = value;
                removed[id.index()] = true;
                stats.eliminated += 1;
            }
        }
    }
    if stats.eliminated == 0 && stats.shuffled == 0 {
        return Ok(stats);
    }
    for index in 0..aliases.len() {
        aliases[index] = resolve(aliases[index], &aliases, &mut work)?;
    }
    // Account for every reference visited by the common rewrite routine.
    for i in &draft.instructions {
        work.spend(i.args.len())?;
    }
    for state in &draft.states {
        work.spend(state.values().len())?;
    }
    for block in &draft.blocks {
        work.spend(1 + block.instructions.len())?;
        for edge in block.terminator.as_ref().unwrap().edges() {
            work.spend(edge.args.len())?;
        }
    }
    rewrite_values(&mut draft, |v| *v = aliases[v.index()]);
    for block in &mut draft.blocks {
        block.instructions.retain(|id| !removed[id.index()]);
    }
    verify(&draft).map_err(|e| e.0)?;
    *region = draft;
    Ok(stats)
}

#[cfg(test)]
#[path = "../../../../tests/ir/semantics/simd_peephole.rs"]
mod tests;
