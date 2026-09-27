//! Bounded scalar identities, planned without mutating the input region.
//!
//! Only existing, dominating operands or in-place integer literals replace pure
//! SSA results. CPU reads, floating point, effects, guards and affine tickets
//! are never candidates. A single rewrite visits every StateMap and CFG use.
use super::rewrite_values;
use crate::ir::{hir::*, ids::*, verify::verify};

pub const DEFAULT_WORK_LIMIT: usize = 1_000_000;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Copies,
    Constants,
    All,
}
impl Mode {
    fn aliases(self) -> bool { matches!(self, Self::Copies | Self::All) }
    fn constants(self) -> bool { matches!(self, Self::Constants | Self::All) }
}
#[derive(Default, Debug)]
pub struct Stats {
    pub aliases: usize,
    pub constants: usize,
}
struct Work(usize);
impl Work {
    fn spend(&mut self, n: usize) -> Result<(), String> {
        self.0 = self
            .0
            .checked_sub(n)
            .ok_or("scalar simplification work budget exceeded")?;
        Ok(())
    }
}
#[derive(Clone, Copy)]
enum Rewrite {
    Value(ValueId),
    Constant(u64),
}
fn candidate(r: &Region, i: &Instruction) -> bool {
    i.results.len() == 1
        && r.values[i.results[0].index()].ty.bits().is_some()
        && i.state.is_none()
        && i.commit.is_none()
        && !i.trap_after_fault
        && !i.unmasked_word_store
        && matches!(
            i.op,
            Op::Const(_)
                | Op::Binary(_)
                | Op::Select
                | Op::Extend { .. }
                | Op::Truncate
                | Op::Extract { .. }
                | Op::Insert { .. }
        )
}
fn definition(r: &Region, v: ValueId) -> Option<&Instruction> {
    match r.values[v.index()].definition {
        Definition::Instruction(id, _) => Some(&r.instructions[id.index()]),
        Definition::Parameter(_, _) => None,
    }
}
fn identity(
    r: &Region,
    i: &Instruction,
    aliases: &[ValueId],
    constants: &[Option<u64>],
) -> Option<Rewrite> {
    let arg = |n: usize| aliases[i.args[n].index()];
    let literal = |v: ValueId| constants[v.index()];
    let ty = r.values[i.results[0].index()].ty;
    match i.op {
        Op::Binary(op) => {
            let a = arg(0);
            let b = arg(1);
            let ca = literal(a);
            let cb = literal(b);
            let bits = r.values[a.index()].ty.bits()?;
            let mask = if bits == 64 { u64::MAX } else { (1u64 << bits) - 1 };
            if a == b {
                match op {
                    Binary::And | Binary::Or => return Some(Rewrite::Value(a)),
                    Binary::Sub | Binary::Xor | Binary::Ult | Binary::Slt => {
                        return Some(Rewrite::Constant(0));
                    },
                    Binary::Eq => return Some(Rewrite::Constant(1)),
                    _ => {},
                }
            }
            match op {
                Binary::Add | Binary::Or | Binary::Xor => {
                    if cb == Some(0) {
                        return Some(Rewrite::Value(a));
                    }
                    if ca == Some(0) {
                        return Some(Rewrite::Value(b));
                    }
                    if op == Binary::Or && (ca == Some(mask) || cb == Some(mask)) {
                        return Some(Rewrite::Constant(mask));
                    }
                },
                Binary::Sub if cb == Some(0) => return Some(Rewrite::Value(a)),
                Binary::Mul => {
                    if ca == Some(0) || cb == Some(0) {
                        return Some(Rewrite::Constant(0));
                    }
                    if cb == Some(1) {
                        return Some(Rewrite::Value(a));
                    }
                    if ca == Some(1) {
                        return Some(Rewrite::Value(b));
                    }
                },
                Binary::And => {
                    if ca == Some(0) || cb == Some(0) {
                        return Some(Rewrite::Constant(0));
                    }
                    if cb == Some(mask) {
                        return Some(Rewrite::Value(a));
                    }
                    if ca == Some(mask) {
                        return Some(Rewrite::Value(b));
                    }
                },
                // HIR integer shifts use Wasm's 32/64-bit count mask, NOT the
                // guest's 8/16-bit operand width. Keep narrow nonzero shifts.
                Binary::Shl | Binary::Shr | Binary::Sar => {
                    if cb.is_some_and(|n| n & if bits == 64 { 63 } else { 31 } == 0) {
                        return Some(Rewrite::Value(a));
                    }
                },
                _ => {},
            }
        },
        Op::Select => {
            let yes = arg(1);
            let no = arg(2);
            if yes == no {
                return Some(Rewrite::Value(yes));
            }
            if let Some(condition) = literal(arg(0)) {
                return Some(Rewrite::Value(if condition != 0 { yes } else { no }));
            }
        },
        Op::Truncate | Op::Extract { lsb: 0 } => {
            let inner = definition(r, arg(0))?;
            if candidate(r, inner) && matches!(inner.op, Op::Extend { .. }) {
                let source = aliases[inner.args[0].index()];
                if r.values[source.index()].ty == ty {
                    return Some(Rewrite::Value(source));
                }
            }
            if let Op::Extract { lsb } = i.op {
                return extract_insert(r, arg(0), lsb, ty, aliases);
            }
        },
        Op::Extract { lsb } => return extract_insert(r, arg(0), lsb, ty, aliases),
        Op::Insert { lsb } => {
            let base = arg(0);
            let part = definition(r, arg(1))?;
            if candidate(r, part)
                && part.op == (Op::Extract { lsb })
                && aliases[part.args[0].index()] == base
            {
                return Some(Rewrite::Value(base));
            }
        },
        _ => {},
    }
    None
}
fn extract_insert(
    r: &Region,
    base: ValueId,
    lsb: u8,
    ty: crate::ir::types::Type,
    aliases: &[ValueId],
) -> Option<Rewrite> {
    let inner = definition(r, base)?;
    if candidate(r, inner) && inner.op == (Op::Insert { lsb }) {
        let part = aliases[inner.args[1].index()];
        if r.values[part.index()].ty == ty {
            return Some(Rewrite::Value(part));
        }
    }
    None
}

/// Plan in SSA dependency order, even when block/arena order is not dominance
/// order. Phi parameters are opaque roots; no edge facts or memory proofs are
/// inferred. Budget failure (including the final rewrite visit) is atomic.
pub fn run_mode(r: &mut Region, work_limit: usize, mode: Mode) -> Result<Stats, String> {
    let mut work = Work(work_limit);
    // Charge the arena/CFG sizes before asking the existing verifier to inspect
    // them. The verifier has its own contract; this is a pass work budget.
    for n in [
        r.values.len(),
        r.instructions.len(),
        r.blocks.len(),
        r.states.len(),
    ] {
        work.spend(n)?;
    }
    // The pipeline verified its input (lifting) and verifies its output
    // (lowering); per-pass re-verification is a debug/every_pass audit.
    if crate::ir::debug::audit() {
        verify(r).map_err(|e| e.0)?;
    }
    let mut active = vec![false; r.instructions.len()];
    for block in &r.blocks {
        work.spend(block.instructions.len())?;
        for id in &block.instructions {
            active[id.index()] = candidate(r, &r.instructions[id.index()]);
        }
    }
    let mut aliases: Vec<_> = (0..r.values.len()).map(|v| ValueId(v as u32)).collect();
    let mut constants = vec![None; r.values.len()];
    let mut users = vec![Vec::new(); r.instructions.len()];
    let mut pending = vec![0usize; r.instructions.len()];
    let mut ready = Vec::new();
    let mut expected = 0;
    for (n, i) in r.instructions.iter().enumerate() {
        // Charge all references, including inactive arena nodes, because the
        // final StateMap-aware rewrite visits them too.
        work.spend(1)?;
        work.spend(i.args.len())?;
        if !active[n] {
            continue;
        }
        expected += 1;
        if let Op::Const(value) = i.op {
            constants[i.results[0].index()] = Some(value);
        }
        for arg in &i.args {
            if let Definition::Instruction(producer, _) = r.values[arg.index()].definition {
                if active[producer.index()] {
                    users[producer.index()].push(n);
                    pending[n] += 1;
                }
            }
        }
        if pending[n] == 0 {
            ready.push(n);
        }
    }
    // Reserve the complete remaining rewrite traversal before changing anything.
    for state in &r.states {
        work.spend(state.values().len())?;
    }
    for block in &r.blocks {
        work.spend(1)?;
        for edge in block.terminator.as_ref().unwrap().edges() {
            work.spend(edge.args.len())?;
        }
    }
    let mut edits = Vec::new();
    let mut visited = 0;
    let mut stats = Stats::default();
    while let Some(n) = ready.pop() {
        work.spend(1)?;
        visited += 1;
        let i = &r.instructions[n];
        let result = i.results[0];
        if let Some(edit) = identity(r, i, &aliases, &constants) {
            match edit {
                Rewrite::Value(value) if mode.aliases() => {
                    if r.values[result.index()].ty != r.values[value.index()].ty {
                        return Err("scalar simplification type mismatch".into());
                    }
                    aliases[result.index()] = value;
                    stats.aliases += 1;
                },
                Rewrite::Constant(value) if mode.constants() => {
                    constants[result.index()] = Some(value);
                    edits.push((n, value));
                    stats.constants += 1;
                },
                _ => {},
            }
        }
        work.spend(users[n].len())?;
        for &user in &users[n] {
            pending[user] -= 1;
            if pending[user] == 0 {
                ready.push(user);
            }
        }
    }
    if visited != expected {
        return Err("cycle in scalar SSA dependencies".into());
    }
    // No fallible work follows. Existing operand dominance and exact type equality
    // make aliases valid at all old uses; literal replacements keep the old ID.
    for (n, value) in edits {
        r.instructions[n].op = Op::Const(value);
        r.instructions[n].args.clear();
    }
    rewrite_values(r, |v| {
        // The verifier permits unused arena slots; never dereference a stale
        // out-of-range operand in such a slot. All live uses were verified.
        if let Some(&value) = aliases.get(v.index()) {
            *v = value;
        }
    });
    Ok(stats)
}
pub fn run_copies(r: &mut Region, work_limit: usize) -> Result<Stats, String> {
    run_mode(r, work_limit, Mode::Copies)
}
pub fn run_constants(r: &mut Region, work_limit: usize) -> Result<Stats, String> {
    run_mode(r, work_limit, Mode::Constants)
}
pub fn run(r: &mut Region, work_limit: usize) -> Result<Stats, String> {
    run_mode(r, work_limit, Mode::All)
}

#[cfg(test)]
#[path = "../../../../tests/ir/semantics/scalar.rs"]
mod tests;
