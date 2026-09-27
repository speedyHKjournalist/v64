//! Explicit packed XMM integer semantics. IDs are the canonical 66 0F opcode byte.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
#[repr(u8)]
pub enum PackedOp {
    UnpackLow8 = 0x60,
    UnpackLow16 = 0x61,
    UnpackLow32 = 0x62,
    UnpackHigh8 = 0x68,
    UnpackHigh16 = 0x69,
    UnpackHigh32 = 0x6A,
    UnpackLow64 = 0x6C,
    UnpackHigh64 = 0x6D,
    PackS16S8 = 0x63,
    PackS16U8 = 0x67,
    PackS32S16 = 0x6B,
    Shr16 = 0xD1,
    Shr32 = 0xD2,
    Shr64 = 0xD3,
    Sar16 = 0xE1,
    Sar32 = 0xE2,
    Shl16 = 0xF1,
    Shl32 = 0xF2,
    Shl64 = 0xF3,

    Add8 = 0xFC,
    Add16 = 0xFD,
    Add32 = 0xFE,
    Add64 = 0xD4,
    Sub8 = 0xF8,
    Sub16 = 0xF9,
    Sub32 = 0xFA,
    Sub64 = 0xFB,
    AddSatS8 = 0xEC,
    AddSatS16 = 0xED,
    AddSatU8 = 0xDC,
    AddSatU16 = 0xDD,
    SubSatS8 = 0xE8,
    SubSatS16 = 0xE9,
    SubSatU8 = 0xD8,
    SubSatU16 = 0xD9,
    GtS8 = 0x64,
    GtS16 = 0x65,
    GtS32 = 0x66,
    Eq8 = 0x74,
    Eq16 = 0x75,
    Eq32 = 0x76,
    MinU8 = 0xDA,
    MaxU8 = 0xDE,
    MinS16 = 0xEA,
    MaxS16 = 0xEE,
    AvgU8 = 0xE0,
    AvgU16 = 0xE3,
    MulHighU16 = 0xE4,
    MulHighS16 = 0xE5,
    MulU32 = 0xF4,
    SadU8 = 0xF6,
    MulLow16 = 0xD5,
    MaddS16 = 0xF5,
    And = 0xDB,
    AndNot = 0xDF,
    Or = 0xEB,
    Xor = 0xEF,
}
impl PackedOp {
    pub fn from_id(id: u32) -> Option<Self> {
        Some(match id {
            0x60 => Self::UnpackLow8,
            0x61 => Self::UnpackLow16,
            0x62 => Self::UnpackLow32,
            0x68 => Self::UnpackHigh8,
            0x69 => Self::UnpackHigh16,
            0x6A => Self::UnpackHigh32,
            0x6C => Self::UnpackLow64,
            0x6D => Self::UnpackHigh64,
            0x63 => Self::PackS16S8,
            0x67 => Self::PackS16U8,
            0x6B => Self::PackS32S16,
            0xD1 => Self::Shr16,
            0xD2 => Self::Shr32,
            0xD3 => Self::Shr64,
            0xE1 => Self::Sar16,
            0xE2 => Self::Sar32,
            0xF1 => Self::Shl16,
            0xF2 => Self::Shl32,
            0xF3 => Self::Shl64,

            0xFC => Self::Add8,
            0xFD => Self::Add16,
            0xFE => Self::Add32,
            0xD4 => Self::Add64,
            0xF8 => Self::Sub8,
            0xF9 => Self::Sub16,
            0xFA => Self::Sub32,
            0xFB => Self::Sub64,
            0xEC => Self::AddSatS8,
            0xED => Self::AddSatS16,
            0xDC => Self::AddSatU8,
            0xDD => Self::AddSatU16,
            0xE8 => Self::SubSatS8,
            0xE9 => Self::SubSatS16,
            0xD8 => Self::SubSatU8,
            0xD9 => Self::SubSatU16,
            0x64 => Self::GtS8,
            0x65 => Self::GtS16,
            0x66 => Self::GtS32,
            0x74 => Self::Eq8,
            0x75 => Self::Eq16,
            0x76 => Self::Eq32,
            0xDA => Self::MinU8,
            0xDE => Self::MaxU8,
            0xEA => Self::MinS16,
            0xEE => Self::MaxS16,
            0xE0 => Self::AvgU8,
            0xE3 => Self::AvgU16,
            0xE4 => Self::MulHighU16,
            0xE5 => Self::MulHighS16,
            0xF4 => Self::MulU32,
            0xF6 => Self::SadU8,
            0xD5 => Self::MulLow16,
            0xF5 => Self::MaddS16,
            0xDB => Self::And,
            0xDF => Self::AndNot,
            0xEB => Self::Or,
            0xEF => Self::Xor,
            _ => return None,
        })
    }
    pub fn from_encoding(op: u32) -> Option<Self> {
        match op {
            0x0F14 => Some(Self::UnpackLow32),
            0x0F15 => Some(Self::UnpackHigh32),
            0x660F14 => Some(Self::UnpackLow64),
            0x660F15 => Some(Self::UnpackHigh64),
            0x0F54 | 0x660F54 => Some(Self::And),
            0x0F55 | 0x660F55 => Some(Self::AndNot),
            0x0F56 | 0x660F56 => Some(Self::Or),
            0x0F57 | 0x660F57 => Some(Self::Xor),
            _ if op >> 8 == 0x660F => Self::from_id(op & 255),
            _ => None,
        }
    }
    pub fn wasm_opcode(self) -> Option<u32> {
        Some(match self {
            Self::PackS16S8 => 0x65,
            Self::PackS16U8 => 0x66,
            Self::PackS32S16 => 0x85,
            Self::Add8 => 0x6E,
            Self::Add16 => 0x8E,
            Self::Add32 => 0xAE,
            Self::Add64 => 0xCE,
            Self::Sub8 => 0x71,
            Self::Sub16 => 0x91,
            Self::Sub32 => 0xB1,
            Self::Sub64 => 0xD1,
            Self::AddSatS8 => 0x6F,
            Self::AddSatS16 => 0x8F,
            Self::AddSatU8 => 0x70,
            Self::AddSatU16 => 0x90,
            Self::SubSatS8 => 0x72,
            Self::SubSatS16 => 0x92,
            Self::SubSatU8 => 0x73,
            Self::SubSatU16 => 0x93,
            Self::GtS8 => 0x27,
            Self::GtS16 => 0x31,
            Self::GtS32 => 0x3B,
            Self::Eq8 => 0x23,
            Self::Eq16 => 0x2D,
            Self::Eq32 => 0x37,
            Self::MinU8 => 0x77,
            Self::MaxU8 => 0x79,
            Self::MinS16 => 0x96,
            Self::MaxS16 => 0x98,
            Self::AvgU8 => 0x7B,
            Self::AvgU16 => 0x9B,
            Self::MulLow16 => 0x95,
            Self::MaddS16 => 0xBA,
            Self::And => 0x4E,
            Self::AndNot => 0x4F,
            Self::Or => 0x50,
            Self::Xor => 0x51,
            _ => return None,
        })
    }
    pub fn unpack(self) -> Option<(u8, bool)> {
        use PackedOp::*;
        Some(match self {
            UnpackLow8 => (1, false),
            UnpackLow16 => (2, false),
            UnpackLow32 => (4, false),
            UnpackLow64 => (8, false),
            UnpackHigh8 => (1, true),
            UnpackHigh16 => (2, true),
            UnpackHigh32 => (4, true),
            UnpackHigh64 => (8, true),
            _ => return None,
        })
    }
    /// (lane bits, arithmetic right, left, Wasm opcode). Count is unsigned u64.
    pub fn shift(self) -> Option<(u8, bool, bool, u32)> {
        use PackedOp::*;
        Some(match self {
            Shr16 => (16, false, false, 0x8D),
            Shr32 => (32, false, false, 0xAD),
            Shr64 => (64, false, false, 0xCD),
            Sar16 => (16, true, false, 0x8C),
            Sar32 => (32, true, false, 0xAC),
            Shl16 => (16, false, true, 0x8B),
            Shl32 => (32, false, true, 0xAB),
            Shl64 => (64, false, true, 0xCB),
            _ => return None,
        })
    }
    /// CPU slow completion: destination is sampled after the entire source read.
    pub fn apply(self, destination: [u8; 16], source: [u8; 16]) -> [u8; 16] {
        use PackedOp::*;
        fn lane(v: &[u8; 16], bytes: usize, index: usize) -> u64 {
            let mut value = [0; 8];
            value[..bytes].copy_from_slice(&v[index * bytes..(index + 1) * bytes]);
            u64::from_le_bytes(value)
        }
        fn signed(value: u64, bits: usize) -> i64 { ((value << (64 - bits)) as i64) >> (64 - bits) }
        if let Some((width, high)) = self.unpack() {
            let width = width as usize;
            let start = if high { 8 } else { 0 };
            let mut result = [0; 16];
            for i in 0..8 / width {
                for (side, value) in [destination, source].iter().enumerate() {
                    result[(2 * i + side) * width..(2 * i + side + 1) * width]
                        .copy_from_slice(&value[start + i * width..start + (i + 1) * width]);
                }
            }
            return result;
        }
        if matches!(self, PackS16S8 | PackS16U8 | PackS32S16) {
            let width = if self == PackS32S16 { 2 } else { 1 };
            let (min, max) = if self == PackS16U8 {
                (0, 255)
            }
            else {
                (-(1i64 << (width * 8 - 1)), (1i64 << (width * 8 - 1)) - 1)
            };
            let mut result = [0; 16];
            for (half, value) in [destination, source].iter().enumerate() {
                for i in 0..8 / width {
                    let n = signed(lane(value, width * 2, i), width * 16).clamp(min, max);
                    result[8 * half + i * width..8 * half + (i + 1) * width]
                        .copy_from_slice(&n.to_le_bytes()[..width]);
                }
            }
            return result;
        }
        if let Some((bits, arithmetic, left, _)) = self.shift() {
            let count = lane(&source, 8, 0);
            let bits = bits as usize;
            let width = bits / 8;
            let mut result = [0; 16];
            for i in 0..16 / width {
                let n = lane(&destination, width, i);
                let n = if arithmetic {
                    (signed(n, bits) >> count.min((bits - 1) as u64)) as u64
                }
                else if count >= bits as u64 {
                    0
                }
                else if left {
                    n << count
                }
                else {
                    n >> count
                };
                result[i * width..(i + 1) * width].copy_from_slice(&n.to_le_bytes()[..width]);
            }
            return result;
        }
        let bytes = match self {
            Add64 | Sub64 | MulU32 | SadU8 => 8,
            Add32 | Sub32 | GtS32 | Eq32 | MaddS16 => 4,
            Add16 | Sub16 | AddSatS16 | AddSatU16 | SubSatS16 | SubSatU16 | GtS16 | Eq16
            | MinS16 | MaxS16 | AvgU16 | MulHighU16 | MulHighS16 | MulLow16 => 2,
            _ => 1,
        };
        let bits = bytes * 8;
        let mask = u64::MAX >> (64 - bits);
        let mut result = [0; 16];
        for i in 0..16 / bytes {
            let a = lane(&destination, bytes, i);
            let b = lane(&source, bytes, i);
            let sa = signed(a, bits);
            let sb = signed(b, bits);
            let value = match self {
                Add8 | Add16 | Add32 | Add64 => a.wrapping_add(b),
                Sub8 | Sub16 | Sub32 | Sub64 => a.wrapping_sub(b),
                AddSatS8 | AddSatS16 => {
                    (sa + sb).clamp(-(1 << (bits - 1)), (1 << (bits - 1)) - 1) as u64
                },
                SubSatS8 | SubSatS16 => {
                    (sa - sb).clamp(-(1 << (bits - 1)), (1 << (bits - 1)) - 1) as u64
                },
                AddSatU8 | AddSatU16 => (a + b).min(mask),
                SubSatU8 | SubSatU16 => a.saturating_sub(b),
                GtS8 | GtS16 | GtS32 => {
                    if sa > sb {
                        mask
                    }
                    else {
                        0
                    }
                },
                Eq8 | Eq16 | Eq32 => {
                    if a == b {
                        mask
                    }
                    else {
                        0
                    }
                },
                MinU8 => a.min(b),
                MaxU8 => a.max(b),
                MinS16 => sa.min(sb) as u64,
                MaxS16 => sa.max(sb) as u64,
                AvgU8 | AvgU16 => (a + b + 1) >> 1,
                MulHighU16 => a * b >> 16,
                MulHighS16 => (sa * sb >> 16) as u64,
                MulLow16 => a * b,
                MulU32 => lane(&destination, 4, 2 * i) * lane(&source, 4, 2 * i),
                MaddS16 => (0..2)
                    .map(|j| {
                        signed(lane(&destination, 2, 2 * i + j), 16)
                            * signed(lane(&source, 2, 2 * i + j), 16)
                    })
                    .sum::<i64>() as u64,
                SadU8 => (0..8)
                    .map(|j| {
                        (destination[8 * i + j] as i64 - source[8 * i + j] as i64).unsigned_abs()
                    })
                    .sum(),
                And => a & b,
                AndNot => !a & b,
                Or => a | b,
                Xor => a ^ b,
                _ => unreachable!("packed operation handled above"),
            };
            result[i * bytes..(i + 1) * bytes].copy_from_slice(&value.to_le_bytes()[..bytes]);
        }
        result
    }
}

/// Immediate-controlled shuffles. Pure semantics select bytes from old destination/source.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
#[repr(u8)]
pub enum ShuffleOp {
    Dwords = 0,
    LowWords = 1,
    HighWords = 2,
    Singles = 3,
    Doubles = 4,
}
impl ShuffleOp {
    pub fn from_id(id: u32) -> Option<Self> {
        Some(match id {
            0 => Self::Dwords,
            1 => Self::LowWords,
            2 => Self::HighWords,
            3 => Self::Singles,
            4 => Self::Doubles,
            _ => return None,
        })
    }
    pub fn from_encoding(op: u32) -> Option<Self> {
        Some(match op {
            0x660F70 => Self::Dwords,
            0xF20F70 => Self::LowWords,
            0xF30F70 => Self::HighWords,
            0x0FC6 => Self::Singles,
            0x660FC6 => Self::Doubles,
            _ => return None,
        })
    }
    pub fn lanes(self, immediate: u8) -> [u8; 16] {
        let mut lanes = [0; 16];
        for byte in 0..16u8 {
            lanes[byte as usize] = match self {
                Self::Dwords => 16 + ((immediate >> (byte / 4 * 2)) & 3) * 4 + byte % 4,
                Self::LowWords if byte < 8 => {
                    16 + ((immediate >> (byte / 2 * 2)) & 3) * 2 + byte % 2
                },
                Self::HighWords if byte >= 8 => {
                    24 + ((immediate >> ((byte - 8) / 2 * 2)) & 3) * 2 + byte % 2
                },
                Self::LowWords | Self::HighWords => 16 + byte,
                Self::Singles => {
                    (if byte < 8 { 0 } else { 16 })
                        + ((immediate >> (byte / 4 * 2)) & 3) * 4
                        + byte % 4
                },
                Self::Doubles => {
                    (if byte < 8 { 0 } else { 16 }) + ((immediate >> (byte / 8)) & 1) * 8 + byte % 8
                },
            };
        }
        lanes
    }
    pub fn apply(self, destination: [u8; 16], source: [u8; 16], immediate: u8) -> [u8; 16] {
        let inputs = [destination, source];
        self.lanes(immediate)
            .map(|index| inputs[index as usize / 16][index as usize % 16])
    }
}

/// Fixed transfers that merge with old target lanes or duplicate source lanes.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
#[repr(u8)]
pub enum TransferOp {
    Low64 = 0,
    High64 = 1,
    Duplicate64 = 2,
    DuplicateLow32 = 3,
    DuplicateHigh32 = 4,
}
impl TransferOp {
    pub fn from_id(id: u32) -> Option<Self> {
        Some(match id {
            0 => Self::Low64,
            1 => Self::High64,
            2 => Self::Duplicate64,
            3 => Self::DuplicateLow32,
            4 => Self::DuplicateHigh32,
            _ => return None,
        })
    }
    pub fn from_encoding(op: u32) -> Option<Self> {
        Some(match op {
            0x0F12 | 0x660F12 => Self::Low64,
            0x0F16 | 0x660F16 => Self::High64,
            0xF20F12 => Self::Duplicate64,
            0xF30F12 => Self::DuplicateLow32,
            0xF30F16 => Self::DuplicateHigh32,
            _ => return None,
        })
    }
    pub fn bytes(self) -> u8 {
        if matches!(self, Self::DuplicateLow32 | Self::DuplicateHigh32) {
            16
        }
        else {
            8
        }
    }
    pub fn lanes(self) -> [u8; 16] {
        let mut lanes = [0; 16];
        for n in 0..16u8 {
            lanes[n as usize] = match self {
                Self::Low64 => {
                    if n < 8 {
                        16 + n
                    }
                    else {
                        n
                    }
                },
                Self::High64 => {
                    if n < 8 {
                        n
                    }
                    else {
                        16 + n - 8
                    }
                },
                Self::Duplicate64 => 16 + n % 8,
                Self::DuplicateLow32 => 16 + n / 8 * 8 + n % 4,
                Self::DuplicateHigh32 => 20 + n / 8 * 8 + n % 4,
            };
        }
        lanes
    }
    pub fn apply(self, destination: [u8; 16], source: [u8; 16]) -> [u8; 16] {
        let values = [destination, source];
        self.lanes()
            .map(|i| values[i as usize / 16][i as usize % 16])
    }
}
