#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Type {
    I1,
    I8,
    I16,
    I32,
    I64,
    F32,
    F64,
    V128,
    F80,
    Effect,
    EffectiveAddress,
    LinearAddress,
    RamAddress,
    GuardProof,
    RmwTicket, // Affine, runtime i64; valid only between a matched RMW read/store.
}
impl Type {
    pub fn bits(self) -> Option<u8> {
        match self {
            Self::I1 => Some(1),
            Self::I8 => Some(8),
            Self::I16 => Some(16),
            Self::I32 => Some(32),
            Self::I64 => Some(64),
            _ => None,
        }
    }
}
