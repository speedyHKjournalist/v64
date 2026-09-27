use super::{analysis::cfg::Cfg, helper::ExceptionOwner, hir::*, ids::*, types::Type};
#[derive(Debug, Eq, PartialEq)]
pub struct VerifyError(pub String);
impl From<&str> for VerifyError {
    fn from(s: &str) -> Self { Self(s.to_owned()) }
}
type Result<T> = std::result::Result<T, VerifyError>;
fn require(ok: bool, reason: &str) -> Result<()> {
    if ok {
        Ok(())
    }
    else {
        Err(reason.into())
    }
}

pub fn verify(region: &Region) -> Result<()> {
    let cfg = Cfg::compute(region).map_err(VerifyError::from)?;
    let mut positions = vec![None; region.instructions.len()];
    let mut defined = vec![false; region.values.len()];
    for (b, block) in region.blocks.iter().enumerate() {
        require(cfg.reachable[b], "unreachable block must be removed")?;
        for (i, &value) in block.params.iter().enumerate() {
            let data = region
                .values
                .get(value.index())
                .ok_or("invalid parameter")?;
            require(
                data.definition == Definition::Parameter(BlockId(b as u32), i as u32),
                "parameter definition mismatch",
            )?;
            require(
                data.ty != Type::RmwTicket,
                "RMW ticket cannot be a block parameter",
            )?;
            require(!defined[value.index()], "duplicate value definition")?;
            defined[value.index()] = true;
        }
        for (p, &id) in block.instructions.iter().enumerate() {
            let inst = region
                .instructions
                .get(id.index())
                .ok_or("invalid instruction")?;
            require(inst.block.index() == b, "instruction owner mismatch")?;
            require(
                positions[id.index()].replace(p).is_none(),
                "duplicate instruction",
            )?;
            for (r, &value) in inst.results.iter().enumerate() {
                let data = region.values.get(value.index()).ok_or("invalid result")?;
                require(
                    data.definition == Definition::Instruction(id, r as u32),
                    "result definition mismatch",
                )?;
                require(!defined[value.index()], "duplicate value definition")?;
                defined[value.index()] = true;
            }
        }
    }
    // Dead arena slots are allowed after DCE, but uses must still refer to a live definition.
    let available = |value: ValueId, block: usize, position: usize| -> Result<()> {
        let data = region
            .values
            .get(value.index())
            .ok_or("value outside arena")?;
        require(defined[value.index()], "use of removed definition")?;
        let (owner, at) = match data.definition {
            Definition::Parameter(owner, _) => (owner.index(), None),
            Definition::Instruction(id, _) => {
                let inst = region
                    .instructions
                    .get(id.index())
                    .ok_or("bad value definition")?;
                (inst.block.index(), positions[id.index()])
            },
        };
        require(
            cfg.dominates(block, owner),
            "definition does not dominate use",
        )?;
        if owner == block {
            if let Some(at) = at {
                require(at < position, "use before definition")?;
            }
        }
        Ok(())
    };
    let ty = |value: ValueId| {
        region
            .values
            .get(value.index())
            .map(|v| v.ty)
            .ok_or_else(|| VerifyError::from("invalid value"))
    };
    let state = |id: StateId, b: usize, p: usize| -> Result<()> {
        let map = region.states.get(id.index()).ok_or("missing state map")?;
        for value in map.values_iter() {
            available(value, b, p)?;
        }
        if let Some(base) = map.count_base {
            require(ty(base)? == Type::I32, "count base must be i32")?;
        }
        if let Some(target) = map.next_value {
            require(
                ty(target)? == Type::I32
                    && map.resume == super::state::ResumeKind::AfterInstruction,
                "dynamic EIP requires i32 after-instruction state",
            )?;
        }
        for value in map.gpr {
            require(ty(value)? == Type::I32, "GPR state type")?;
        }
        for value in map.flags.arithmetic {
            require(ty(value)? == Type::I1, "flag state type")?;
        }
        require(ty(map.flags.system)? == Type::I32, "system flags type")?;
        if let Some(value) = map.flags.last_op1 {
            require(ty(value)? == Type::I32, "flag operand type")?;
        }
        require(
            map.flags.raw_zero.is_some() == map.flags.zero_is_lazy.is_some(),
            "incomplete raw zero state",
        )?;
        let backing = [
            map.flags.raw_flags,
            map.flags.lazy_mask,
            map.flags.last_result,
            map.flags.last_op_size,
        ];
        require(
            backing.iter().all(Option::is_some) || backing.iter().all(Option::is_none),
            "incomplete lazy flags backing",
        )?;
        require(
            map.flags.backing_valid.is_some() == backing[0].is_some(),
            "lazy flags validity/backing mismatch",
        )?;
        if let Some(value) = map.flags.zero_is_lazy {
            require(ty(value)? == Type::I1, "zero lazy flag type")?;
        }
        if let Some(value) = map.flags.raw_zero {
            require(ty(value)? == Type::I1, "raw zero flag type")?;
        }
        for value in backing.into_iter().flatten() {
            require(ty(value)? == Type::I32, "lazy flags backing type")?;
        }
        if let Some(value) = map.flags.backing_valid {
            require(ty(value)? == Type::I1, "lazy flags validity type")?;
        }
        require(
            map.xmm.is_empty() || map.xmm.len() == 8,
            "partial XMM state map",
        )?;
        for &value in &map.xmm {
            require(ty(value)? == Type::V128, "XMM state type")?;
        }
        for &value in &map.x87 {
            require(ty(value)? == Type::F80, "x87 state type")?;
        }
        if let Some(rep) = map.rep_progress {
            for value in rep {
                require(ty(value)? == Type::I32, "REP state type")?;
            }
            require(
                map.resume == super::state::ResumeKind::RepProgress,
                "REP resume mismatch",
            )?;
            require(
                rep == [map.gpr[1], map.gpr[6], map.gpr[7]] && map.next_value.is_none(),
                "REP progress must match materialized GPRs",
            )?;
        }
        else {
            require(
                map.resume != super::state::ResumeKind::RepProgress,
                "REP state missing progress",
            )?;
        }
        Ok(())
    };
    for helper in &region.helpers {
        helper.validate().map_err(VerifyError::from)?;
    }
    // Signature checks visit every instruction on every verification pass.
    // Reuse their scratch storage without changing type/error validation order.
    let mut args = Vec::new();
    let mut results = Vec::new();
    for (b, block) in region.blocks.iter().enumerate() {
        if let Some(id) = block.entry_state {
            state(id, b, 0)?;
        }
        let mut effects = block
            .params
            .iter()
            .copied()
            .filter(|&v| ty(v) == Ok(Type::Effect));
        let mut effect = effects.next();
        require(effects.next().is_none(), "multiple effect roots")?;
        let mut rmw = None;
        let mut partial = None;
        for (p, &id) in block.instructions.iter().enumerate() {
            let inst = &region.instructions[id.index()];
            require(
                inst.commit.is_some()
                    == matches!(
                        inst.op,
                        Op::GuestStore { .. }
                            | Op::RmwStore { .. }
                            | Op::XmmStore { .. }
                            | Op::XmmMaskedStore { .. }
                    ),
                "store needs explicit commit map; other operations cannot commit",
            )?;
            require(
                !inst.trap_after_fault
                    || matches!(inst.op, Op::GuestLoad { .. } | Op::PartialStore { .. }),
                "fault trap policy requires a load or partial store",
            )?;
            require(
                !inst.unmasked_word_store || matches!(inst.op, Op::PartialStore { bytes: 2 }),
                "unmasked word payload requires partial word store",
            )?;
            if let Some(commit) = inst.commit {
                state(commit, b, p)?;
                let before = region
                    .states
                    .get(inst.state.ok_or("store needs before state")?.index())
                    .ok_or("missing state map")?;
                require(
                    before.count_base == region.states[commit.index()].count_base,
                    "store changed dynamic count base",
                )?;
                require(
                    region.states[commit.index()].resume
                        == super::state::ResumeKind::AfterInstruction,
                    "store commit must resume after instruction",
                )?;
            }
            for &arg in &inst.args {
                available(arg, b, p)?;
            }
            args.clear();
            results.clear();
            for &value in &inst.args {
                args.push(ty(value)?);
            }
            for &value in &inst.results {
                results.push(ty(value)?);
            }
            require(
                !args.contains(&Type::RmwTicket) || matches!(inst.op, Op::RmwStore { .. }),
                "RMW ticket escapes to another operation",
            )?;
            require(
                !results.contains(&Type::RmwTicket) || matches!(inst.op, Op::RmwLoad { .. }),
                "RMW ticket needs validated read",
            )?;
            if inst.op.ordered() {
                require(
                    rmw.is_none() || matches!(inst.op, Op::RmwStore { .. }),
                    "effect invalidates pending RMW ticket",
                )?;
                require(
                    effect.is_some() && inst.args.last().copied() == effect,
                    "broken effect chain",
                )?;
                require(
                    args.pop() == Some(Type::Effect) && results.pop() == Some(Type::Effect),
                    "missing effect input/output",
                )?;
                effect = inst.results.last().copied();
                state(inst.state.ok_or("ordered operation needs state map")?, b, p)?;
            }
            else {
                require(
                    !args.contains(&Type::Effect) && !results.contains(&Type::Effect),
                    "pure operation consumes effect",
                )?;
                if let Some(map) = inst.state {
                    state(map, b, p)?;
                }
            }
            if inst.op.ordered() {
                let map = &region.states[inst.state.unwrap().index()];
                let identity = (
                    map.instruction_pc,
                    map.next_pc,
                    map.committed_instructions,
                    map.count_base,
                );
                if let Some(expected) = partial {
                    require(
                        identity == expected,
                        "partial store crossed guest instruction",
                    )?;
                    require(
                        matches!(
                            inst.op,
                            Op::SegmentAddress { .. }
                                | Op::GuestLoad { .. }
                                | Op::PartialStore { .. }
                                | Op::GuestStore { .. }
                        ),
                        "effect interrupts partial store sequence",
                    )?;
                    if let Some(commit) = inst.commit {
                        let commit = &region.states[commit.index()];
                        require(
                            commit.instruction_pc == map.instruction_pc
                                && commit.next_pc == map.next_pc
                                && commit.count_base == map.count_base
                                && map.committed_instructions.checked_add(1)
                                    == Some(commit.committed_instructions),
                            "partial store commit mismatch",
                        )?;
                        partial = None;
                    }
                }
                if matches!(inst.op, Op::PartialStore { .. }) {
                    partial = Some(identity);
                }
            }
            match &inst.op {
                Op::Const(value) => {
                    require(args.is_empty() && results.len() == 1, "constant arity")?;
                    let bits = results[0].bits().ok_or("noninteger constant")?;
                    require(
                        bits == 64 || *value < 1u64 << bits,
                        "constant width overflow",
                    )?;
                },
                Op::Binary(op) => {
                    require(args.len() == 2 && results.len() == 1, "binary arity")?;
                    require(
                        args[0].bits().is_some() && args[0] == args[1],
                        "binary operand types",
                    )?;
                    let result = if matches!(op, Binary::Eq | Binary::Ult | Binary::Slt) {
                        Type::I1
                    }
                    else {
                        args[0]
                    };
                    require(results[0] == result, "binary result type")?;
                },
                Op::CountLeadingZeros | Op::CountTrailingZeros | Op::PopulationCount => require(
                    args.len() == 1 && matches!(args[0], Type::I32 | Type::I64) && results == args,
                    "bit-count types",
                )?,
                Op::Select => {
                    require(args.len() == 3 && results.len() == 1, "select arity")?;
                    require(
                        args[0] == Type::I1 && args[1] == args[2] && results[0] == args[1],
                        "select types",
                    )?;
                },
                Op::Extend { .. } | Op::Truncate | Op::Extract { .. } => {
                    require(args.len() == 1 && results.len() == 1, "conversion arity")?;
                    let a = args[0].bits().ok_or("conversion source")?;
                    let r = results[0].bits().ok_or("conversion target")?;
                    require(
                        match inst.op {
                            Op::Extend { .. } => a < r,
                            Op::Extract { lsb } => lsb as u16 + r as u16 <= a as u16,
                            _ => a > r,
                        },
                        "conversion width",
                    )?;
                },
                Op::Insert { lsb } => {
                    require(args.len() == 2 && results.len() == 1, "insert arity")?;
                    let a = args[0].bits().ok_or("insert base type")?;
                    let part = args[1].bits().ok_or("insert part type")?;
                    require(
                        results[0] == args[0] && *lsb as u16 + part as u16 <= a as u16,
                        "insert width",
                    )?;
                },
                Op::ReadXmm(reg) => require(
                    *reg < 8
                        && args.is_empty()
                        && results == [Type::V128]
                        && region.entries.contains(&BlockId(b as u32)),
                    "XMM initialization outside entry",
                )?,
                Op::VectorShuffle(lanes) => require(
                    args == [Type::V128, Type::V128]
                        && results == [Type::V128]
                        && lanes.iter().all(|lane| *lane < 32),
                    "vector shuffle signature/lanes",
                )?,
                Op::VectorBinary(_) => require(
                    args == [Type::V128, Type::V128] && results == [Type::V128],
                    "vector binary signature",
                )?,
                Op::XmmBinary {
                    operation,
                    bytes,
                    register,
                } => {
                    require(
                        *bytes == 16
                            || *bytes == 8
                                && matches!(
                                    operation,
                                    crate::ir::simd::PackedOp::UnpackLow32
                                        | crate::ir::simd::PackedOp::UnpackLow64
                                ),
                        "XMM binary read width",
                    )?;
                    require(
                        *register < 8
                            && args == [Type::LinearAddress, Type::V128]
                            && results == [Type::V128],
                        "XMM binary signature",
                    )?;
                    let map = &region.states[inst.state.unwrap().index()];
                    require(map.xmm.len() == 8, "XMM binary needs complete state")?;
                    require(
                        inst.args[1] == map.xmm[*register as usize],
                        "XMM binary destination/state mismatch",
                    )?;
                },
                Op::XmmShuffle { register, .. } | Op::XmmTransferLoad { register, .. } => {
                    require(
                        *register < 8
                            && args == [Type::LinearAddress, Type::V128]
                            && results == [Type::V128],
                        "XMM shuffle signature",
                    )?;
                    let map = &region.states[inst.state.unwrap().index()];
                    require(map.xmm.len() == 8, "XMM shuffle needs complete state")?;
                    require(
                        inst.args[1] == map.xmm[*register as usize],
                        "XMM shuffle destination/state mismatch",
                    )?;
                },
                Op::XmmInsertWord { register, lane } => {
                    require(
                        *register < 8
                            && *lane < 8
                            && args == [Type::LinearAddress, Type::V128]
                            && results == [Type::V128],
                        "XMM word insert signature/lane",
                    )?;
                    let map = &region.states[inst.state.unwrap().index()];
                    require(map.xmm.len() == 8, "XMM word insert needs complete state")?;
                    require(
                        inst.args[1] == map.xmm[*register as usize],
                        "XMM word insert destination/state mismatch",
                    )?;
                },
                Op::XmmMaskedStore { source, mask } => {
                    require(
                        *source < 8
                            && *mask < 8
                            && args == [Type::LinearAddress, Type::V128, Type::V128]
                            && results.is_empty(),
                        "XMM masked store signature",
                    )?;
                    let map = &region.states[inst.state.unwrap().index()];
                    require(map.xmm.len() == 8, "XMM masked store needs complete state")?;
                    require(
                        inst.args[1] == map.xmm[*source as usize]
                            && inst.args[2] == map.xmm[*mask as usize],
                        "XMM masked store source/mask state mismatch",
                    )?;
                    let commit = &region.states[inst.commit.unwrap().index()];
                    require(
                        commit.gpr == map.gpr
                            && commit.flags == map.flags
                            && commit.xmm == map.xmm
                            && commit.instruction_pc == map.instruction_pc
                            && commit.next_pc == map.next_pc
                            && commit.count_base == map.count_base
                            && map.committed_instructions.checked_add(1)
                                == Some(commit.committed_instructions),
                        "XMM masked store commit mismatch",
                    )?;
                },
                Op::VectorBitmask { bits } => require(
                    matches!(bits, 8 | 32 | 64) && args == [Type::V128] && results == [Type::I32],
                    "vector bitmask signature/width",
                )?,
                Op::VectorExtract { bits, lane } => require(
                    matches!(bits, 16 | 32 | 64)
                        && (*lane as u16) * (*bits as u16) < 128
                        && args == [Type::V128]
                        && results == [if *bits == 64 { Type::I64 } else { Type::I32 }],
                    "vector extract types/lane",
                )?,
                Op::VectorReplace { bits, lane } => require(
                    matches!(bits, 16 | 32 | 64)
                        && (*lane as u16) * (*bits as u16) < 128
                        && args == [Type::V128, if *bits == 64 { Type::I64 } else { Type::I32 }]
                        && results == [Type::V128],
                    "vector replace types/lane",
                )?,
                Op::SseCheck | Op::FpuCheck => {
                    require(args.is_empty() && results.is_empty(), "FP guard signature")?
                },
                Op::X87 { opcode, modrm } => {
                    let (inputs, outputs) = match crate::ir::x87::io(*opcode, *modrm) {
                        Some(crate::ir::x87::Io::Load { .. }) => (2, 0),
                        Some(crate::ir::x87::Io::Store { .. }) => (0, 2),
                        Some(crate::ir::x87::Io::Stack) => (0, 0),
                        None => (usize::MAX, 0),
                    };
                    require(
                        args.len() == inputs
                            && args.iter().all(|t| *t == Type::I32)
                            && results.len() == outputs
                            && results.iter().all(|t| *t == Type::I32),
                        "x87 operation signature",
                    )?
                },
                Op::XmmLoad { bytes, register }
                | Op::XmmStore {
                    bytes, register, ..
                } => {
                    let store = matches!(inst.op, Op::XmmStore { .. });
                    if let Op::XmmStore { bytes, lane, .. } = inst.op {
                        require(lane == 0 || bytes == 8 && lane == 1, "XMM store lane/width")?;
                    }
                    require(
                        *register < 8
                            && matches!(bytes, 4 | 8 | 16)
                            && args.as_slice()
                                == if store {
                                    &[Type::LinearAddress, Type::V128][..]
                                }
                                else {
                                    &[Type::LinearAddress][..]
                                }
                            && results.as_slice()
                                == if store { &[][..] } else { &[Type::V128][..] },
                        "XMM memory signature",
                    )?;
                    let map = &region.states[inst.state.unwrap().index()];
                    require(map.xmm.len() == 8, "XMM memory needs complete state")?;
                    if store {
                        require(
                            inst.args[1] == map.xmm[*register as usize],
                            "XMM store source/state mismatch",
                        )?;
                        let commit = &region.states[inst.commit.unwrap().index()];
                        require(
                            commit.gpr == map.gpr
                                && commit.flags == map.flags
                                && commit.xmm == map.xmm
                                && commit.instruction_pc == map.instruction_pc
                                && commit.next_pc == map.next_pc
                                && commit.count_base == map.count_base
                                && map.committed_instructions.checked_add(1)
                                    == Some(commit.committed_instructions),
                            "XMM store commit mismatch",
                        )?;
                    }
                },
                Op::ReadGpr(reg) => require(
                    *reg < 8
                        && args.is_empty()
                        && results == [Type::I32]
                        && region.entries.contains(&BlockId(b as u32)),
                    "GPR initialization outside entry",
                )?,
                Op::ReadEntryLinear
                | Op::ReadFlags
                | Op::ReadSystemFlags
                | Op::ReadRawFlags
                | Op::ReadFlagChanges
                | Op::ReadFlagOperand
                | Op::ReadFlagResult
                | Op::ReadFlagSize => require(
                    args.is_empty()
                        && results == [Type::I32]
                        && region.entries.contains(&BlockId(b as u32)),
                    "flags initialization outside entry",
                )?,
                Op::ReadFlag(bit) => require(
                    matches!(bit, 0 | 2 | 4 | 6 | 7 | 11)
                        && args.is_empty()
                        && results == [Type::I1]
                        && region.entries.contains(&BlockId(b as u32)),
                    "arithmetic flag initialization outside entry",
                )?,
                Op::ReadSegment(segment) => require(
                    *segment < 6
                        && args.is_empty()
                        && results == [Type::I16]
                        && region.entries.contains(&BlockId(b as u32)),
                    "segment selector initialization",
                )?,
                Op::ReadStack32 => require(
                    args.is_empty()
                        && results == [Type::I1]
                        && region.entries.contains(&BlockId(b as u32)),
                    "stack-mode initialization outside entry",
                )?,
                Op::PopAddress { segment, bytes } => require(
                    *segment < 6
                        && matches!(bytes, 2 | 4)
                        && args == [Type::I32]
                        && results == [Type::LinearAddress],
                    "POP address types",
                )?,
                Op::SegmentAddress { segment } => require(
                    *segment < 6 && args == [Type::I32] && results == [Type::LinearAddress],
                    "segment address types",
                )?,
                Op::RmwLoad { bytes, order } => {
                    require(
                        matches!(bytes, 1 | 2 | 4)
                            && args == [Type::LinearAddress]
                            && results.len() == 2
                            && memory_width(results[0]) == Some(*bytes)
                            && results[1] == Type::RmwTicket,
                        "RMW read types",
                    )?;
                    rmw = Some((inst.results[1], *bytes, *order, inst.state));
                },
                Op::RmwStore { bytes, order } => {
                    require(
                        args.len() == 2
                            && args[0] == Type::RmwTicket
                            && memory_width(args[1]) == Some(*bytes)
                            && results.is_empty(),
                        "RMW store types",
                    )?;
                    require(
                        rmw == Some((inst.args[0], *bytes, *order, inst.state)),
                        "RMW ticket, width, order or fault map mismatch",
                    )?;
                    rmw = None;
                },
                Op::Divide { bits, .. } => require(
                    matches!(bits, 8 | 16 | 32)
                        && args == [Type::I64; 2]
                        && results.len() == 2
                        && results[0] == results[1]
                        && results[0].bits() == Some(*bits),
                    "divide types",
                )?,
                Op::GuestCheck { bytes, .. } => require(
                    *bytes > 0
                        && *bytes < 4096
                        && args == [Type::LinearAddress]
                        && results.is_empty(),
                    "page preflight types or range",
                )?,
                Op::LinearOffset => require(
                    args == [Type::LinearAddress, Type::I32] && results == [Type::LinearAddress],
                    "linear offset types",
                )?,
                Op::GuestLoad { bytes } => require(
                    matches!(bytes, 1 | 2 | 4 | 8 | 16)
                        && args == [Type::LinearAddress]
                        && results.len() == 1
                        && memory_width(results[0]) == Some(*bytes),
                    "load types",
                )?,
                Op::GuestStore { bytes } | Op::PartialStore { bytes } => require(
                    matches!(bytes, 1 | 2 | 4 | 8 | 16)
                        && args.len() == 2
                        && args[0] == Type::LinearAddress
                        && (if inst.unmasked_word_store {
                            args[1] == Type::I32
                        }
                        else {
                            memory_width(args[1]) == Some(*bytes)
                        })
                        && results.is_empty(),
                    "store types",
                )?,
                Op::CallHelper(helper) => {
                    let helper = region
                        .helpers
                        .get(helper.index())
                        .ok_or("unknown helper contract")?;
                    if matches!(
                        helper.abi,
                        super::helper::HelperAbi::CpuExit | super::helper::HelperAbi::CpuRep
                    ) {
                        require(
                            p + 1 == block.instructions.len()
                                && matches!(block.terminator, Some(Terminator::Exit(id)) if Some(id) == inst.state)
                                && region.states[inst.state.unwrap().index()].resume
                                    == if matches!(helper.abi, super::helper::HelperAbi::CpuRep) {
                                        super::state::ResumeKind::RepProgress
                                    }
                                    else {
                                        super::state::ResumeKind::BeforeInstruction
                                    },
                            "CPU exit helper must terminate at its pre-instruction state",
                        )?;
                    }
                    require(
                        args == helper.params && results == helper.results,
                        "helper signature",
                    )?;
                    require(
                        !helper.effects.may_fault
                            || helper.exception_owner != ExceptionOwner::CannotFault,
                        "helper exception owner",
                    )?;
                    if helper.effects.may_fault && helper.exception_owner == ExceptionOwner::Caller
                    {
                        require(
                            region.states[inst.state.unwrap().index()].resume
                                != super::state::ResumeKind::AfterInstruction,
                            "caller fault cannot resume after faulting instruction",
                        )?;
                    }
                },
                Op::CompareExchange8B { .. } => {
                    require(
                        args == [Type::LinearAddress] && results.is_empty(),
                        "CMPXCHG8B signature",
                    )?;
                    require(
                        p + 1 == block.instructions.len()
                            && matches!(block.terminator, Some(Terminator::Exit(id)) if Some(id) == inst.state)
                            && region.states[inst.state.unwrap().index()].resume
                                == super::state::ResumeKind::BeforeInstruction,
                        "CMPXCHG8B must terminate at its pre-instruction state",
                    )?;
                },
                Op::PollBudget => require(args.is_empty() && results.is_empty(), "poll arity")?,
            }
        }
        require(rmw.is_none(), "uncommitted RMW ticket")?;
        require(partial.is_none(), "uncommitted partial store sequence")?;
        let p = block.instructions.len();
        let term = block.terminator.as_ref().unwrap();
        match term {
            Terminator::Exit(id) => state(*id, b, p)?,
            Terminator::CondBranch { condition, .. } => {
                available(*condition, b, p)?;
                require(ty(*condition)? == Type::I1, "branch condition type")?;
            },
            _ => (),
        }
        for edge in term.edges() {
            let target = &region.blocks[edge.target.index()];
            require(target.params.len() == edge.args.len(), "edge arity")?;
            for (&arg, &param) in edge.args.iter().zip(&target.params) {
                available(arg, b, p)?;
                require(ty(arg)? == ty(param)?, "edge type")?;
                if ty(param)? == Type::Effect {
                    require(Some(arg) == effect, "stale effect on edge")?;
                }
            }
        }
    }
    Ok(())
}
fn memory_width(ty: Type) -> Option<u8> {
    match ty {
        Type::V128 => Some(16),
        Type::F32 => Some(4),
        Type::F64 => Some(8),
        _ => ty.bits().map(|n| n / 8),
    }
}
