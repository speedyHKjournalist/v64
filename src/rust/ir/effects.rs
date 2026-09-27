#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StateSet(pub u64);
impl StateSet {
    pub const ALL: Self = Self(u64::MAX);
    pub fn contains(self, other: Self) -> bool { self.0 & other.0 == other.0 }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AliasClass {
    GuestRam,
    CpuState,
    Mmio,
    Io,
    SharedMemory,
    Unknown,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Effects {
    pub reads_state: StateSet,
    pub writes_state: StateSet,
    pub reads_memory: bool,
    pub writes_memory: bool,
    pub may_fault: bool,
    pub may_transfer: bool,
    pub may_yield: bool,
    pub changes_translation: bool,
    pub invalidates_code: bool,
    pub io: bool,
}
impl Effects {
    pub fn conservative() -> Self {
        Self {
            reads_state: StateSet::ALL,
            writes_state: StateSet::ALL,
            reads_memory: true,
            writes_memory: true,
            may_fault: true,
            may_transfer: true,
            may_yield: true,
            changes_translation: true,
            invalidates_code: true,
            io: true,
        }
    }
    pub fn pure() -> Self {
        Self {
            reads_state: StateSet(0),
            writes_state: StateSet(0),
            reads_memory: false,
            writes_memory: false,
            may_fault: false,
            may_transfer: false,
            may_yield: false,
            changes_translation: false,
            invalidates_code: false,
            io: false,
        }
    }
    pub fn is_pure(&self) -> bool { self == &Self::pure() }
}
