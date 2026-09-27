//! Selected Wasm kernels for packed operations; no guest opcode selection in emission.
use crate::ir::simd::PackedOp;
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PackedPlan {
    Shuffle([u8; 16]),
    Shift {
        maximum: i64,
        opcode: u32,
        sign_fill: bool,
    },
    MultiplyHigh {
        low: u32,
        high: u32,
        lanes: [u8; 16],
    },
    MultiplyEven {
        lanes: [u8; 16],
        opcode: u32,
    },
    Sad {
        difference: [u32; 3],
        widen: [u32; 2],
        swap: [u8; 16],
        add: u32,
        pack: [u8; 16],
    },
    Binary {
        opcode: u32,
        reverse: bool,
    },
}
pub fn lower(operation: PackedOp) -> PackedPlan {
    use PackedOp::*;
    if let Some((width, high)) = operation.unpack() {
        let mut lanes = [0; 16];
        for i in 0..16u8 {
            lanes[i as usize] = (if high { 8 } else { 0 })
                + i / (width * 2) * width
                + i % width
                + (i / width % 2) * 16;
        }
        return PackedPlan::Shuffle(lanes);
    }
    if let Some((bits, arithmetic, _, opcode)) = operation.shift() {
        return PackedPlan::Shift {
            maximum: (bits - 1) as i64,
            opcode,
            sign_fill: arithmetic,
        };
    }
    match operation {
        MulHighS16 | MulHighU16 => PackedPlan::MultiplyHigh {
            low: if operation == MulHighS16 { 0xBC } else { 0xBE },
            high: if operation == MulHighS16 { 0xBD } else { 0xBF },
            lanes: [2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31],
        },
        MulU32 => PackedPlan::MultiplyEven {
            lanes: [0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23],
            opcode: 0xDE,
        },
        SadU8 => PackedPlan::Sad {
            difference: [0x79, 0x77, 0x71],
            widen: [0x7D, 0x7F],
            swap: [4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11],
            add: 0xAE,
            pack: [0, 1, 2, 3, 16, 17, 18, 19, 8, 9, 10, 11, 16, 17, 18, 19],
        },
        _ => PackedPlan::Binary {
            opcode: operation.wasm_opcode().unwrap(),
            reverse: operation == AndNot,
        },
    }
}
