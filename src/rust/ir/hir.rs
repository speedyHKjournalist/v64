use super::{helper::HelperDescriptor, ids::*, state::StateMap, types::Type};
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Binary {
    Add,
    Sub,
    Mul,
    And,
    Or,
    Xor,
    Shl,
    Shr,
    Sar,
    Eq,
    Ult,
    Slt,
}
/// Locked pairs require the audited non-shared, single-owner CPU ABI.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RmwOrder {
    Plain,
    Locked,
}
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Op {
    Const(u64),
    Binary(Binary),
    Select,
    Extend {
        signed: bool,
    },
    Truncate,
    Extract {
        lsb: u8,
    },
    Insert {
        lsb: u8,
    },
    /// Read the already-validated CPU entry's linear PC in the cold prologue.
    /// This is not an x86 register and cannot appear after a guest instruction.
    ReadEntryLinear,
    ReadGpr(u8),
    ReadXmm(u8),
    /// Terminal selective byte stores, following a full sixteen-byte write preflight.
    XmmMaskedStore {
        source: u8,
        mask: u8,
    },
    VectorBitmask {
        bits: u8,
    },
    XmmInsertWord {
        register: u8,
        lane: u8,
    },
    VectorBinary(super::simd::PackedOp),
    VectorShuffle([u8; 16]),
    XmmTransferLoad {
        operation: super::simd::TransferOp,
        register: u8,
    },
    XmmShuffle {
        operation: super::simd::ShuffleOp,
        immediate: u8,
        register: u8,
    },
    XmmBinary {
        operation: super::simd::PackedOp,
        bytes: u8,
        register: u8,
    },
    VectorExtract {
        bits: u8,
        lane: u8,
    },
    VectorReplace {
        bits: u8,
        lane: u8,
    },
    /// CR0.EM/#UD then CR0.TS/#NM, before EA resolution.
    SseCheck,
    /// x87 #NM for CR0.EM or CR0.TS, before EA resolution.
    FpuCheck,
    /// One x87 stack/control operation on CPU-owned FPU state (see ir::x87).
    /// Memory operands are loaded/stored by ordinary guest-memory ops; this
    /// never faults, exits, or observes GPRs, FLAGS or guest memory.
    X87 {
        opcode: u8,
        modrm: u8,
    },
    /// RAM returns V128 SSA; CPU slow completion exits at this instruction's next PC.
    XmmLoad {
        bytes: u8,
        register: u8,
    },
    /// Terminal store; its CPU slow path retains callback/fault authority.
    XmmStore {
        lane: u8,
        bytes: u8,
        register: u8,
    },
    ReadFlags,
    /// Only non-arithmetic FLAGS bits; separate from the raw backing SSA root.
    ReadSystemFlags,
    /// One architectural arithmetic flag, evaluated only when CPU demand needs it.
    ReadFlag(u8),
    /// CPU backing flags without evaluating lazy arithmetic flags.
    ReadRawFlags,
    ReadFlagChanges,
    ReadFlagOperand,
    ReadFlagResult,
    ReadFlagSize,
    CountLeadingZeros,
    CountTrailingZeros,
    PopulationCount,
    /// Checked quotient/remainder. Fault delivery belongs to the CPU adapter.
    Divide {
        bits: u8,
        signed: bool,
    },
    ReadStack32,
    ReadSegment(u8),
    PopAddress {
        segment: u8,
        bytes: u8,
    },
    SegmentAddress {
        segment: u8,
    },
    /// Wrapping displacement within a resolved linear address. No proof.
    LinearOffset,
    GuestLoad {
        bytes: u8,
    },
    GuestStore {
        bytes: u8,
    },
    /// Intermediate write of one guest instruction; must reach a committing store.
    PartialStore {
        bytes: u8,
    },
    /// Page permission preflight without reading RAM or invoking a device.
    GuestCheck {
        bytes: u16,
        write: bool,
    },
    CallHelper(HelperId),
    RmwLoad {
        bytes: u8,
        order: RmwOrder,
    },
    RmwStore {
        bytes: u8,
        order: RmwOrder,
    },
    /// Terminal eight-byte conditional exchange. CPU state owns callback/fault results.
    CompareExchange8B {
        order: RmwOrder,
    },
    PollBudget,
}
impl Op {
    pub fn ordered(&self) -> bool {
        matches!(
            self,
            Self::GuestLoad { .. }
                | Self::SegmentAddress { .. }
                | Self::PopAddress { .. }
                | Self::GuestStore { .. }
                | Self::PartialStore { .. }
                | Self::GuestCheck { .. }
                | Self::CallHelper(_)
                | Self::Divide { .. }
                | Self::RmwLoad { .. }
                | Self::RmwStore { .. }
                | Self::CompareExchange8B { .. }
                | Self::SseCheck
                | Self::FpuCheck
                | Self::X87 { .. }
                | Self::XmmLoad { .. }
                | Self::XmmBinary { .. }
                | Self::XmmShuffle { .. }
                | Self::XmmTransferLoad { .. }
                | Self::XmmInsertWord { .. }
                | Self::XmmStore { .. }
                | Self::XmmMaskedStore { .. }
                | Self::PollBudget
        )
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Definition {
    Parameter(BlockId, u32),
    Instruction(InstId, u32),
}
#[derive(Clone, Debug)]
pub struct Value {
    pub ty: Type,
    pub definition: Definition,
}
#[derive(Clone, Debug)]
pub struct Instruction {
    pub block: BlockId,
    pub op: Op,
    pub args: Vec<ValueId>,
    pub results: Vec<ValueId>,
    pub state: Option<StateId>,
    /// Architectural state after a successful committing store, distinct from
    /// the fault snapshot. Values remain live through both success/fault paths.
    pub commit: Option<StateId>,
    /// Pinned ENTER nested accesses abort the host call after CPU fault delivery.
    /// Only GuestLoad/PartialStore may opt into this compatibility behavior.
    pub trap_after_fault: bool,
    /// ENTER16 passes its full frame pointer to the baseline word MMIO write.
    pub unmasked_word_store: bool,
}
#[derive(Clone, Debug)]
pub struct Edge {
    pub target: BlockId,
    pub args: Vec<ValueId>,
}
#[derive(Clone, Debug)]
pub enum Terminator {
    Branch(Edge),
    CondBranch {
        condition: ValueId,
        taken: Edge,
        not_taken: Edge,
    },
    Exit(StateId),
}
impl Terminator {
    pub fn edges(&self) -> Vec<&Edge> {
        match self {
            Self::Branch(edge) => vec![edge],
            Self::CondBranch {
                taken, not_taken, ..
            } => vec![taken, not_taken],
            Self::Exit(_) => vec![],
        }
    }
    pub fn edges_mut(&mut self) -> Vec<&mut Edge> {
        match self {
            Self::Branch(edge) => vec![edge],
            Self::CondBranch {
                taken, not_taken, ..
            } => vec![taken, not_taken],
            Self::Exit(_) => vec![],
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Block {
    pub entry_state: Option<StateId>,
    pub params: Vec<ValueId>,
    pub instructions: Vec<InstId>,
    pub terminator: Option<Terminator>,
    /// Guest instruction boundaries whose PollBudget was removed by sparse
    /// polling; charged at the dominating entry or loop-header poll point.
    pub budget: u32,
}
#[derive(Clone, Debug, Default)]
pub struct Region {
    pub entries: Vec<BlockId>,
    pub blocks: Vec<Block>,
    pub values: Vec<Value>,
    pub instructions: Vec<Instruction>,
    pub states: Vec<StateMap>,
    pub helpers: Vec<HelperDescriptor>,
}
impl Region {
    pub fn block(&mut self, entry: bool) -> BlockId {
        let id = BlockId(arena_index(self.blocks.len()));
        self.blocks.push(Block::default());
        if entry {
            self.entries.push(id);
        }
        id
    }
    pub fn param(&mut self, block: BlockId, ty: Type) -> ValueId {
        let params = &mut self.blocks[block.index()].params;
        let id = ValueId(arena_index(self.values.len()));
        self.values.push(Value {
            ty,
            definition: Definition::Parameter(block, arena_index(params.len())),
        });
        params.push(id);
        id
    }
    pub fn append(
        &mut self,
        block: BlockId,
        op: Op,
        args: Vec<ValueId>,
        types: &[Type],
        state: Option<StateId>,
    ) -> Vec<ValueId> {
        assert!(
            self.blocks[block.index()].terminator.is_none(),
            "instruction after terminator"
        );
        let id = InstId(arena_index(self.instructions.len()));
        let results: Vec<_> = types
            .iter()
            .enumerate()
            .map(|(i, &ty)| {
                let value = ValueId(arena_index(self.values.len()));
                self.values.push(Value {
                    ty,
                    definition: Definition::Instruction(id, i as u32),
                });
                value
            })
            .collect();
        self.instructions.push(Instruction {
            block,
            op,
            args,
            results: results.clone(),
            state,
            commit: None,
            trap_after_fault: false,
            unmasked_word_store: false,
        });
        self.blocks[block.index()].instructions.push(id);
        results
    }
    pub fn state(&mut self, state: StateMap) -> StateId {
        let id = StateId(arena_index(self.states.len()));
        self.states.push(state);
        id
    }
    pub fn terminate(&mut self, block: BlockId, terminator: Terminator) {
        assert!(
            self.blocks[block.index()]
                .terminator
                .replace(terminator)
                .is_none(),
            "second terminator"
        );
    }
}
