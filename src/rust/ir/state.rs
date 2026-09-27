use super::frontend::decode::GuestEip;
use super::ids::ValueId;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResumeKind {
    BeforeInstruction,
    AfterInstruction,
    RepProgress,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FlagState {
    /// CF, PF, AF, ZF, SF, OF. Each source is an I1 SSA value (or an extracted input bit).
    pub arithmetic: [ValueId; 6],
    /// Only non-arithmetic bits are significant. Consumers must mask/rebuild
    /// arithmetic bits from their independent sources above.
    pub system: ValueId,
    /// Pinned CPU provenance read by undefined AF after shifts.
    pub last_op1: Option<ValueId>,
    /// Raw CPU ZF backing bit, observed by VERR/VERW before descriptor lookup.
    /// None requests ordinary architectural materialization (standalone states).
    pub raw_zero: Option<ValueId>,
    /// Whether CPU getzf uses the computed value instead of the backing bit.
    pub zero_is_lazy: Option<ValueId>,
    /// Exact CPU lazy-FLAGS backing captured at region entry. These values are
    /// proof inputs for preserving an unchanged lazy representation; ordinary
    /// materialization may still canonicalize changed arithmetic FLAGS.
    pub raw_flags: Option<ValueId>,
    pub lazy_mask: Option<ValueId>,
    pub last_result: Option<ValueId>,
    pub last_op_size: Option<ValueId>,
    /// I1 proof bit: when true, the backing fields above exactly
    /// describe the current CPU lazy-FLAGS representation. Unsupported flag
    /// mutations set this false; flag-neutral code preserves it. CFG joins may
    /// retain a dynamic bit, selecting exact backing during CPU materialization.
    pub backing_valid: Option<ValueId>,
}
#[derive(Clone, Debug)]
pub struct StateMap {
    pub instruction_pc: GuestEip,
    pub next_pc: GuestEip,
    /// Optional SSA CS-relative destination for a completed control transfer.
    pub next_value: Option<ValueId>,
    pub resume: ResumeKind,
    pub gpr: [ValueId; 8],
    pub flags: FlagState,
    pub xmm: Vec<ValueId>,
    pub x87: Vec<ValueId>,
    pub committed_instructions: u32,
    /// Dynamic completed-work base relative to this entry; the static field is an offset.
    pub count_base: Option<ValueId>,
    pub rep_progress: Option<[ValueId; 3]>, // ECX, ESI, EDI
}
impl StateMap {
    /// Recovery operands in the same order as `values`, without allocating a
    /// temporary vector for read-only visitors such as the HIR verifier.
    pub fn values_iter(&self) -> impl Iterator<Item = ValueId> + '_ {
        self.gpr
            .iter()
            .chain(&self.flags.arithmetic)
            .copied()
            .chain(std::iter::once(self.flags.system))
            .chain(
                [
                    self.flags.last_op1,
                    self.flags.raw_zero,
                    self.flags.zero_is_lazy,
                    self.flags.raw_flags,
                    self.flags.lazy_mask,
                    self.flags.last_result,
                    self.flags.last_op_size,
                    self.flags.backing_valid,
                ]
                .into_iter()
                .flatten(),
            )
            .chain(self.xmm.iter().chain(&self.x87).copied())
            .chain(self.next_value)
            .chain(self.count_base)
            .chain(self.rep_progress.into_iter().flatten())
    }
    pub fn values(&self) -> Vec<ValueId> { self.values_iter().collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_values_preserve_all_optional_operands_and_order() {
        let mut state = StateMap {
            instruction_pc: GuestEip(0),
            next_pc: GuestEip(1),
            next_value: Some(ValueId(39)),
            resume: ResumeKind::RepProgress,
            gpr: std::array::from_fn(|n| ValueId(n as u32)),
            flags: FlagState {
                arithmetic: std::array::from_fn(|n| ValueId(n as u32 + 8)),
                system: ValueId(14),
                last_op1: Some(ValueId(15)),
                raw_zero: Some(ValueId(16)),
                zero_is_lazy: Some(ValueId(17)),
                raw_flags: Some(ValueId(18)),
                lazy_mask: Some(ValueId(19)),
                last_result: Some(ValueId(20)),
                last_op_size: Some(ValueId(21)),
                backing_valid: Some(ValueId(22)),
            },
            xmm: (23..31).map(ValueId).collect(),
            x87: (31..39).map(ValueId).collect(),
            committed_instructions: 1,
            count_base: Some(ValueId(40)),
            rep_progress: Some([ValueId(41), ValueId(42), ValueId(43)]),
        };
        let expected: Vec<_> = (0..44).map(ValueId).collect();
        assert_eq!(state.values_iter().collect::<Vec<_>>(), expected);
        assert_eq!(state.values(), expected);

        state.flags.last_op1 = None;
        state.flags.zero_is_lazy = None;
        state.flags.lazy_mask = None;
        state.flags.last_op_size = None;
        state.xmm.clear();
        state.x87.clear();
        state.next_value = None;
        state.count_base = None;
        state.rep_progress = None;
        let expected: Vec<_> = (0..15).chain([16, 18, 20, 22]).map(ValueId).collect();
        assert_eq!(state.values_iter().collect::<Vec<_>>(), expected);
        assert_eq!(state.values(), expected);
    }
}
