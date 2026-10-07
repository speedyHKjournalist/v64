//! Packed integer semantics shared by every engine (docs/simd-xsave-plan.md
//! 3.1): the 32-bit interpreter, the IR helpers and the x64 engine pass the
//! operands they read and commit the result. No CPU state, no memory.
//!
//! Vectors are little-endian bytes: N is 8 for an MMX register, 16 for an XMM
//! register (and for each 128-bit lane of the VEX.256 forms).

/// The lane of `size` bytes at `index`, sign-extended
fn lane(v: &[u8], size: usize, index: usize) -> i64 {
    let bytes = &v[index * size..(index + 1) * size];
    let value = bytes.iter().rev().fold(0i64, |n, &b| n << 8 | b as i64);
    value << (64 - 8 * size) >> (64 - 8 * size)
}
/// Stores the low `size` bytes of `value` as the lane at `index`
fn put(v: &mut [u8], size: usize, index: usize, value: i64) {
    v[index * size..(index + 1) * size].copy_from_slice(&value.to_le_bytes()[..size]);
}
fn saturate_word(value: i64) -> i64 { value.clamp(i16::MIN as i64, i16::MAX as i64) }
/// The lane of `size` bytes at `index`, zero-extended
fn unsigned(v: &[u8], size: usize, index: usize) -> u64 {
    v[index * size..(index + 1) * size]
        .iter()
        .rev()
        .fold(0, |n, &b| n << 8 | b as u64)
}

/// The SSSE3 operations of the opcode map 0F 38, by their opcode byte:
/// PSHUFB (00), PHADDW/D/SW (01-03), PMADDUBSW (04), PHSUBW/D/SW (05-07),
/// PSIGNB/W/D (08-0A), PMULHRSW (0B) and PABSB/W/D (1C-1E).
/// `destination` is the first operand, `source` the second.
pub fn ssse3<const N: usize>(op: u8, destination: [u8; N], source: [u8; N]) -> [u8; N] {
    let mut result = [0; N];
    match op {
        // the index is the low 3 (MMX) or 4 bits; bit 7 selects zero
        0x00 => {
            for i in 0..N {
                result[i] =
                    if source[i] & 0x80 != 0 { 0 } else { destination[source[i] as usize % N] };
            }
        },
        // horizontal pairs: the destination's sums or differences fill the low
        // half of the result, the source's the high half
        0x01 | 0x02 | 0x03 | 0x05 | 0x06 | 0x07 => {
            let size = if op & 3 == 2 { 4 } else { 2 };
            let lanes = N / size;
            for i in 0..lanes {
                let (v, pair) =
                    if i < lanes / 2 { (&destination, i) } else { (&source, i - lanes / 2) };
                let (a, b) = (lane(v, size, 2 * pair), lane(v, size, 2 * pair + 1));
                let value = if op >= 0x05 { a - b } else { a + b };
                put(
                    &mut result,
                    size,
                    i,
                    if op & 3 == 3 { saturate_word(value) } else { value },
                );
            }
        },
        // unsigned bytes of the destination times signed bytes of the source
        0x04 => {
            for i in 0..N / 2 {
                let product = |j: usize| destination[j] as i64 * source[j] as i8 as i64;
                put(
                    &mut result,
                    2,
                    i,
                    saturate_word(product(2 * i) + product(2 * i + 1)),
                );
            }
        },
        // negated, zeroed or kept by the sign of the source (the most negative
        // number stays as it is)
        0x08 | 0x09 | 0x0A => {
            let size = 1 << (op - 0x08);
            for i in 0..N / size {
                let (a, sign) = (lane(&destination, size, i), lane(&source, size, i));
                put(&mut result, size, i, a * sign.signum());
            }
        },
        // bits 16:1 of the product rounded at bit 14 (no saturation)
        0x0B => {
            for i in 0..N / 2 {
                let product = lane(&destination, 2, i) * lane(&source, 2, i);
                put(&mut result, 2, i, ((product >> 14) + 1) >> 1);
            }
        },
        // of the source; the most negative number becomes its unsigned magnitude
        0x1C | 0x1D | 0x1E => {
            let size = 1 << (op - 0x1C);
            for i in 0..N / size {
                put(&mut result, size, i, lane(&source, size, i).abs());
            }
        },
        _ => unreachable!("SSSE3 opcode {op:02x}"),
    }
    result
}

/// PALIGNR (0F 3A 0F): the destination above the source, shifted right by
/// `imm8` bytes; bytes beyond both are zero
pub fn palignr<const N: usize>(destination: [u8; N], source: [u8; N], imm8: u8) -> [u8; N] {
    std::array::from_fn(|i| {
        let n = i + imm8 as usize;
        if n < N {
            source[n]
        }
        else if n < 2 * N {
            destination[n - N]
        }
        else {
            0
        }
    })
}

/// The SSE4.1 and SSE4.2 operations of the opcode map 66 0F 38 but PTEST and
/// MOVNTDQA, by their opcode byte: PBLENDVB, BLENDVPS, BLENDVPD (10, 14, 15:
/// the sign of each lane of `xmm0` selects the source), PMOVSX and PMOVZX
/// (20-25, 30-35: the low lanes of the source, extended), PMULDQ (28),
/// PCMPEQQ (29), PACKUSDW (2B), PCMPGTQ (37), PMINSB/SD/UW/UD and
/// PMAXSB/SD/UW/UD (38-3F), PMULLD (40) and PHMINPOSUW (41).
pub fn sse4(op: u8, destination: [u8; 16], source: [u8; 16], xmm0: [u8; 16]) -> [u8; 16] {
    let mut result = [0; 16];
    match op {
        0x10 | 0x14 | 0x15 => {
            let size = match op {
                0x10 => 1,
                0x14 => 4,
                _ => 8,
            };
            for i in 0..16 / size {
                let selected =
                    if xmm0[(i + 1) * size - 1] & 0x80 != 0 { &source } else { &destination };
                result[i * size..(i + 1) * size]
                    .copy_from_slice(&selected[i * size..(i + 1) * size]);
            }
        },
        // (from, to): BW, BD, BQ, WD, WQ, DQ
        0x20..=0x25 | 0x30..=0x35 => {
            let (from, to) = [(1, 2), (1, 4), (1, 8), (2, 4), (2, 8), (4, 8)][(op & 7) as usize];
            for i in 0..16 / to {
                let value = if op < 0x30 {
                    lane(&source, from, i)
                }
                else {
                    unsigned(&source, from, i) as i64
                };
                put(&mut result, to, i, value);
            }
        },
        // the even signed dwords, multiplied to quadwords
        0x28 => {
            for i in 0..2 {
                put(
                    &mut result,
                    8,
                    i,
                    lane(&destination, 4, 2 * i) * lane(&source, 4, 2 * i),
                );
            }
        },
        0x29 | 0x37 => {
            for i in 0..2 {
                let (a, b) = (lane(&destination, 8, i), lane(&source, 8, i));
                put(
                    &mut result,
                    8,
                    i,
                    -((if op == 0x29 { a == b } else { a > b }) as i64),
                );
            }
        },
        // signed dwords to unsigned saturated words: the destination's, then the source's
        0x2B => {
            for i in 0..8 {
                let value = if i < 4 { lane(&destination, 4, i) } else { lane(&source, 4, i - 4) };
                put(&mut result, 2, i, value.clamp(0, 0xFFFF));
            }
        },
        // (lane size, signed) by the low two bits: SB, SD, UW, UD
        0x38..=0x3F => {
            let size = [1, 4, 2, 4][(op & 3) as usize];
            let signed = op & 3 < 2;
            for i in 0..16 / size {
                let (a, b) = if signed {
                    (lane(&destination, size, i), lane(&source, size, i))
                }
                else {
                    (
                        unsigned(&destination, size, i) as i64,
                        unsigned(&source, size, i) as i64,
                    )
                };
                put(
                    &mut result,
                    size,
                    i,
                    if op >= 0x3C { a.max(b) } else { a.min(b) },
                );
            }
        },
        // the low halves of the products
        0x40 => {
            for i in 0..4 {
                put(
                    &mut result,
                    4,
                    i,
                    lane(&destination, 4, i) * lane(&source, 4, i),
                );
            }
        },
        // the smallest unsigned word of the source and its index (the lowest on ties)
        0x41 => {
            let (index, value) = (0..8)
                .map(|i| (i, unsigned(&source, 2, i)))
                .min_by_key(|&(i, value)| (value, i))
                .unwrap();
            put(&mut result, 2, 0, value as i64);
            put(&mut result, 2, 1, index as i64);
        },
        _ => unreachable!("SSE4 opcode 66 0F 38 {op:02x}"),
    }
    result
}

/// PTEST (66 0F 38 17): (ZF, CF), whether source AND destination and source
/// AND NOT destination are zero
pub fn ptest(destination: [u8; 16], source: [u8; 16]) -> (bool, bool) {
    (
        (0..16).all(|i| destination[i] & source[i] == 0),
        (0..16).all(|i| !destination[i] & source[i] == 0),
    )
}

/// The SSE4.1 operations with imm8 of the map 66 0F 3A that move or combine
/// integer lanes: BLENDPS, BLENDPD, PBLENDW (0C-0E: imm8 bit i takes lane i
/// of the source) and MPSADBW (42: eight sums of absolute byte differences
/// against the source's 4-byte block imm8[1:0], from the destination's byte
/// 4 * imm8[2] on)
pub fn sse4_imm(op: u8, destination: [u8; 16], source: [u8; 16], imm8: u8) -> [u8; 16] {
    let mut result = destination;
    match op {
        0x0C | 0x0D | 0x0E => {
            let size = [4, 8, 2][(op - 0x0C) as usize];
            for i in 0..16 / size {
                if imm8 >> i & 1 != 0 {
                    result[i * size..(i + 1) * size]
                        .copy_from_slice(&source[i * size..(i + 1) * size]);
                }
            }
        },
        0x42 => {
            let (s, d) = ((imm8 & 3) as usize * 4, (imm8 >> 2 & 1) as usize * 4);
            for i in 0..8 {
                let sum = (0..4)
                    .map(|j| (destination[d + i + j] as i64 - source[s + j] as i64).abs())
                    .sum();
                put(&mut result, 2, i, sum);
            }
        },
        _ => unreachable!("SSE4 opcode 66 0F 3A {op:02x}"),
    }
    result
}

/// INSERTPS (66 0F 3A 21): `value` (the source register's dword imm8[7:6],
/// or the m32) into dword imm8[5:4], then the dwords of imm8[3:0] zeroed
pub fn insertps(destination: [u8; 16], value: u32, imm8: u8) -> [u8; 16] {
    let mut result = destination;
    put(&mut result, 4, (imm8 >> 4 & 3) as usize, value as i64);
    for i in 0..4 {
        if imm8 >> i & 1 != 0 {
            put(&mut result, 4, i, 0);
        }
    }
    result
}

/// PALIGNR as one i8x16.shuffle for compiled code (`n`: 8 or 16 bytes): the
/// lanes over (destination, source), or over (destination, zero) when the
/// second result is true (imm8 reaches beyond the source)
pub fn palignr_lanes(imm8: u8, n: usize) -> ([u8; 16], bool) {
    let imm8 = imm8 as usize;
    let zero = imm8 >= n;
    let mut lanes = [0; 16];
    for (i, lane) in lanes.iter_mut().enumerate().take(n) {
        let k = i + imm8;
        *lane = if zero {
            if k < 2 * n {
                k - n
            }
            else {
                16
            }
        }
        else if k < n {
            16 + k
        }
        else {
            k - n
        } as u8;
    }
    (lanes, zero)
}

/// What PCMPESTRI/PCMPESTRM/PCMPISTRI/PCMPISTRM (66 0F 3A 60-63) produce
/// (`compare_strings`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StringCompare {
    /// IntRes2: a bit per element of the second operand
    pub mask: u16,
    /// xSTRI's ECX: the lowest (imm8[6] clear) or highest set bit of `mask`,
    /// else the number of elements
    pub index: u32,
    /// xSTRM's XMM0: `mask` (imm8[6] clear) or a byte or word mask of it
    pub xmm0: [u8; 16],
    /// EFLAGS: CF (mask not zero), ZF (the second operand shorter than
    /// the register), SF (the first operand shorter), OF (mask bit 0); AF and
    /// PF clear
    pub flags: i32,
}

/// PCMPxSTRx (SDM Vol. 2, 4.1): compare the strings `a` (xmm1) and `b`
/// (xmm2/m128) as imm8 says: its elements (bits 1:0: unsigned or signed
/// bytes or words), the aggregation (3:2: equal any, ranges, equal each,
/// equal ordered), the polarity (5:4) and the output (6). The explicit
/// lengths `la` and `lb` (EAX and EDX, RAX and RDX with REX.W) count in
/// absolute value, at most the elements of a register; without them
/// (PCMPISTRx) a string ends before its first zero element.
pub fn compare_strings(
    imm8: u8,
    a: [u8; 16],
    b: [u8; 16],
    la: Option<i64>,
    lb: Option<i64>,
) -> StringCompare {
    let words = imm8 & 1 != 0;
    let signed = imm8 & 2 != 0;
    let n = if words { 8 } else { 16 };
    let element = |v: &[u8; 16], i: usize| -> i32 {
        match (words, signed) {
            (true, true) => i16::from_le_bytes([v[2 * i], v[2 * i + 1]]) as i32,
            (true, false) => u16::from_le_bytes([v[2 * i], v[2 * i + 1]]) as i32,
            (false, true) => v[i] as i8 as i32,
            (false, false) => v[i] as i32,
        }
    };
    let length = |v: &[u8; 16], explicit: Option<i64>| match explicit {
        Some(l) => l.unsigned_abs().min(n as u64) as usize,
        None => (0..n).find(|&i| element(v, i) == 0).unwrap_or(n),
    };
    let (valid_a, valid_b) = (length(&a, la), length(&b, lb));
    let aggregation = imm8 >> 2 & 3;
    // BoolRes of element j of b and element i of a; with an invalid element
    // the value SDM table 4-7 forces
    let compare = |j: usize, i: usize| -> bool {
        if i >= valid_a || j >= valid_b {
            return match aggregation {
                2 => i >= valid_a && j >= valid_b,
                3 => i >= valid_a,
                _ => false,
            };
        }
        let (x, y) = (element(&a, i), element(&b, j));
        if aggregation != 1 {
            x == y
        }
        else if i % 2 == 0 {
            y >= x
        }
        else {
            y <= x
        }
    };
    let mut intres1 = 0u16;
    for j in 0..n {
        let r = match aggregation {
            0 => (0..n).any(|i| compare(j, i)),
            1 => (0..n)
                .step_by(2)
                .any(|i| compare(j, i) && compare(j, i + 1)),
            2 => compare(j, j),
            _ => (0..n - j).all(|k| compare(j + k, k)),
        };
        intres1 |= (r as u16) << j;
    }
    let mask = match imm8 >> 4 & 3 {
        1 => !intres1 & (u16::MAX >> (16 - n)),
        // (masked: only the valid elements of b)
        3 => intres1 ^ ((1u32 << valid_b) - 1) as u16,
        _ => intres1,
    };
    let index = if mask == 0 {
        n as u32
    }
    else if imm8 & 0x40 != 0 {
        15 - mask.leading_zeros()
    }
    else {
        mask.trailing_zeros()
    };
    let mut xmm0 = [0; 16];
    if imm8 & 0x40 != 0 {
        let size = 16 / n;
        for i in 0..n {
            if mask >> i & 1 != 0 {
                xmm0[i * size..(i + 1) * size].fill(0xFF);
            }
        }
    }
    else {
        xmm0[..2].copy_from_slice(&mask.to_le_bytes());
    }
    let flags = (mask != 0) as i32
        | ((valid_b < n) as i32) << 6
        | ((valid_a < n) as i32) << 7
        | ((mask & 1) as i32) << 11;
    StringCompare {
        mask,
        index,
        xmm0,
        flags,
    }
}

/// CRC32 (SSE4.2, F2 0F 38 F0/F1; general-purpose registers only): `crc`
/// updated with the low `bytes` bytes of `value`, least significant first,
/// by CRC-32C (the polynomial 11EDC6F41H, bit-reflected)
pub fn crc32c(crc: u32, value: u64, bytes: u32) -> u32 {
    const TABLE: [u32; 256] = {
        let mut table = [0; 256];
        let mut i = 0;
        while i < 256 {
            let mut c = i as u32;
            let mut k = 0;
            while k < 8 {
                c = if c & 1 != 0 { c >> 1 ^ 0x82F6_3B78 } else { c >> 1 };
                k += 1;
            }
            table[i] = c;
            i += 1;
        }
        table
    };
    (0..bytes).fold(crc, |crc, i| {
        TABLE[(crc ^ (value >> (8 * i)) as u32) as u8 as usize] ^ crc >> 8
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn words<const N: usize>(v: [u8; N]) -> Vec<i16> {
        v.chunks(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect()
    }
    fn from_words<const N: usize>(w: &[i16]) -> [u8; N] {
        let bytes: Vec<u8> = w.iter().flat_map(|x| x.to_le_bytes()).collect();
        bytes.try_into().unwrap()
    }
    /// sse4 without a mask in XMM0
    fn s4(op: u8, d: [u8; 16], s: [u8; 16]) -> [u8; 16] { sse4(op, d, s, [0; 16]) }
    #[test]
    fn pshufb_zeroes_with_bit_7_and_wraps_the_index() {
        let a: [u8; 16] = std::array::from_fn(|i| 0xA0 + i as u8);
        let b: [u8; 16] = [
            0x80, 0x0F, 0x10, 0x1F, 0x7F, 0xFF, 0x00, 0x8F, 1, 2, 3, 4, 5, 6, 7, 0x41,
        ];
        let r = ssse3(0x00, a, b);
        assert_eq!(&r[..8], &[0, 0xAF, 0xA0, 0xAF, 0xAF, 0, 0xA0, 0]);
        assert_eq!(r[15], 0xA1);
        // MMX: three index bits
        let a8: [u8; 8] = std::array::from_fn(|i| 0x10 + i as u8);
        assert_eq!(
            ssse3(0x00, a8, [8, 9, 0x0F, 0x80, 0x87, 0x7F, 0, 1]),
            [0x10, 0x11, 0x17, 0, 0, 0x17, 0x10, 0x11]
        );
    }
    #[test]
    fn horizontal_add_and_subtract() {
        let d = from_words::<16>(&[1, 2, 3, 4, 0x7FFF, 1, -0x8000, -1]);
        let s = from_words::<16>(&[10, 20, 30, 40, 50, 60, 70, 80]);
        assert_eq!(
            words(ssse3(0x01, d, s)),
            [3, 7, -0x8000, 0x7FFF, 30, 70, 110, 150]
        );
        assert_eq!(
            words(ssse3(0x03, d, s)),
            [3, 7, 0x7FFF, -0x8000, 30, 70, 110, 150]
        );
        assert_eq!(
            words(ssse3(0x05, d, s)),
            [-1, -1, 0x7FFE, -0x7FFF, -10, -10, -10, -10]
        );
        let d = from_words::<16>(&[0x7FFF, -1, -0x8000, 1, 0, 0, 0, 0]);
        assert_eq!(words(ssse3(0x07, d, s))[..2], [0x7FFF, -0x8000]);
        // dwords, and the MMX halves
        let d: [u8; 16] = [1, 0, 0, 0, 2, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0x7F, 1, 0, 0, 0];
        assert_eq!(&ssse3(0x02, d, [0; 16])[..8], &[3, 0, 0, 0, 0, 0, 0, 0x80]);
        assert_eq!(
            &ssse3(0x06, d, [0; 16])[..8],
            &[0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xFF, 0xFF, 0x7F]
        );
        let d8 = from_words::<8>(&[1, 2, 3, 4]);
        let s8 = from_words::<8>(&[5, 6, 7, 8]);
        assert_eq!(words(ssse3(0x01, d8, s8)), [3, 7, 11, 15]);
    }
    #[test]
    fn pmaddubsw_takes_unsigned_destination_and_signed_source_bytes() {
        let mut d = [0u8; 16];
        let mut s = [0u8; 16];
        d[..4].copy_from_slice(&[0xFF, 0xFF, 0x80, 0x01]);
        s[..4].copy_from_slice(&[0x7F, 0x7F, 0x80, 0xFF]);
        let r = words(ssse3(0x04, d, s));
        assert_eq!(r[0], 0x7FFF); // 255 * 127 * 2 saturates
        assert_eq!(r[1], -0x4001); // 128 * -128 + 1 * -1
        d[4..6].copy_from_slice(&[0xFF, 0xFF]);
        s[4..6].copy_from_slice(&[0x80, 0x80]);
        assert_eq!(words(ssse3(0x04, d, s))[2], -0x8000);
    }
    #[test]
    fn psign_pmulhrsw_and_pabs_edges() {
        let d = from_words::<16>(&[5, 5, 5, -0x8000, -0x8000, 0, 7, -7]);
        let s = from_words::<16>(&[1, 0, -1, -1, 1, -5, -0x8000, 0x7FFF]);
        assert_eq!(
            words(ssse3(0x09, d, s)),
            [5, 0, -5, -0x8000, -0x8000, 0, -7, -7]
        );
        let d = from_words::<16>(&[-0x8000, 0x4000, -0x8000, 1, 0x7FFF, 0x7FFF, -1, 3]);
        let s = from_words::<16>(&[-0x8000, 0x4000, 0x7FFF, 0x4000, 0x7FFF, -0x8000, 1, 0x2AAB]);
        assert_eq!(
            words(ssse3(0x0B, d, s)),
            [-0x8000, 0x2000, -0x7FFF, 1, 0x7FFE, -0x7FFF, 0, 1]
        );
        let mut s = [0u8; 16];
        s[..4].copy_from_slice(&[0x80, 0x7F, 0xFF, 0x00]);
        assert_eq!(&ssse3(0x1C, [0; 16], s)[..4], &[0x80, 0x7F, 0x01, 0x00]);
        assert_eq!(
            words(ssse3(
                0x1D,
                [0; 16],
                from_words::<16>(&[-0x8000, -1, 0, 1, 0, 0, 0, 0])
            ))[..4],
            [-0x8000, 1, 0, 1]
        );
        let s: [u8; 16] = [
            0, 0, 0, 0x80, 0xFF, 0xFF, 0xFF, 0xFF, 5, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(
            &ssse3(0x1E, [0; 16], s)[..12],
            &[0, 0, 0, 0x80, 1, 0, 0, 0, 5, 0, 0, 0]
        );
    }
    #[test]
    fn palignr_lanes_select_what_palignr_computes() {
        let d: [u8; 16] = std::array::from_fn(|i| 0x20 + i as u8);
        let s: [u8; 16] = std::array::from_fn(|i| 0x40 + i as u8);
        for n in [8, 16] {
            for imm in 0..=255u8 {
                let (lanes, zero) = palignr_lanes(imm, n);
                let second = if zero { [0; 16] } else { s };
                let shuffled: Vec<u8> = lanes[..n]
                    .iter()
                    .map(|&l| {
                        if l < 16 {
                            d[l as usize]
                        }
                        else {
                            second[l as usize - 16]
                        }
                    })
                    .collect();
                let expected: Vec<u8> = if n == 8 {
                    palignr::<8>(d[..8].try_into().unwrap(), s[..8].try_into().unwrap(), imm)
                        .to_vec()
                }
                else {
                    palignr(d, s, imm).to_vec()
                };
                assert_eq!(shuffled, expected, "{n} {imm}");
            }
        }
    }
    #[test]
    fn blendv_takes_the_sign_of_each_xmm0_lane() {
        let d = [0x11; 16];
        let s = [0x22; 16];
        let mut mask = [0u8; 16];
        mask[0] = 0x80;
        mask[7] = 0x80; // the sign of dword 1 and of quadword 0
        mask[3] = 0x7F;
        let r = sse4(0x10, d, s, mask);
        assert_eq!((r[0], r[1], r[3], r[7]), (0x22, 0x11, 0x11, 0x22));
        assert_eq!(
            &sse4(0x14, d, s, mask)[..8],
            &[0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x22, 0x22]
        );
        assert_eq!(
            &sse4(0x15, d, s, mask)[..9],
            &[0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x11]
        );
    }
    #[test]
    fn pmovsx_and_pmovzx_extend_the_low_lanes() {
        let s: [u8; 16] = [
            0x80, 0x7F, 0xFF, 1, 0, 0, 0, 0x80, 0xFF, 0xFF, 0xFF, 0xFF, 9, 9, 9, 9,
        ];
        assert_eq!(
            words(s4(0x20, [0; 16], s)),
            [-128, 127, -1, 1, 0, 0, 0, -128]
        );
        assert_eq!(
            words(s4(0x30, [0; 16], s)),
            [128, 127, 255, 1, 0, 0, 0, 128]
        );
        assert_eq!(
            &s4(0x22, [0; 16], s)[..16],
            &[0x80, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0, 0, 0, 0, 0, 0, 0]
        );
        // DQ: the low two dwords
        let r = s4(0x25, [0; 16], s);
        assert_eq!(
            (lane(&r, 8, 0), lane(&r, 8, 1)),
            (0x01FF_7F80, i32::MIN as i64)
        );
        let r = s4(0x35, [0; 16], s);
        assert_eq!(
            (unsigned(&r, 8, 0), unsigned(&r, 8, 1)),
            (0x01FF_7F80, 0x8000_0000)
        );
        // WD and WQ
        assert_eq!(lane(&s4(0x23, [0; 16], s), 4, 1), 0x01FF);
        assert_eq!(lane(&s4(0x24, [0; 16], s), 8, 0), 0x7F80);
        assert_eq!(lane(&s4(0x21, [0; 16], s), 4, 2), -1);
        assert_eq!(unsigned(&s4(0x31, [0; 16], s), 4, 2), 0xFF);
    }
    #[test]
    fn quadword_compare_multiply_and_pack() {
        let mut d = [0u8; 16];
        let mut s = [0u8; 16];
        put(&mut d, 8, 0, -1);
        put(&mut s, 8, 0, -1);
        put(&mut d, 8, 1, i64::MIN);
        put(&mut s, 8, 1, i64::MAX);
        assert_eq!(
            (lane(&s4(0x29, d, s), 8, 0), lane(&s4(0x29, d, s), 8, 1)),
            (-1, 0)
        );
        assert_eq!(
            (lane(&s4(0x37, d, s), 8, 0), lane(&s4(0x37, d, s), 8, 1)),
            (0, 0)
        );
        assert_eq!(lane(&s4(0x37, s, d), 8, 1), -1);
        // PMULDQ: the even dwords, signed
        let mut d = [0u8; 16];
        let mut s = [0u8; 16];
        put(&mut d, 4, 0, i32::MIN as i64);
        put(&mut s, 4, 0, i32::MIN as i64);
        put(&mut d, 4, 1, 7);
        put(&mut d, 4, 2, -3);
        put(&mut s, 4, 2, 0x7FFF_FFFF);
        let r = s4(0x28, d, s);
        assert_eq!(
            (lane(&r, 8, 0), lane(&r, 8, 1)),
            (1 << 62, -3 * 0x7FFF_FFFF)
        );
        // PMULLD keeps the low half; PACKUSDW saturates to unsigned words
        assert_eq!(lane(&s4(0x40, d, s), 4, 0), 0);
        assert_eq!(lane(&s4(0x40, d, s), 4, 2), -3i64 * 0x7FFF_FFFF << 32 >> 32);
        let mut d = [0u8; 16];
        for (i, v) in [-1i64, 0x10000, 0xFFFF, 0x8000].iter().enumerate() {
            put(&mut d, 4, i, *v);
        }
        assert_eq!(
            words(s4(0x2B, d, [0; 16])),
            [0, -1, -1, -0x8000, 0, 0, 0, 0]
        );
    }
    #[test]
    fn min_max_signedness_and_phminposuw() {
        let mut d = [0u8; 16];
        let mut s = [0u8; 16];
        put(&mut d, 4, 0, -1);
        put(&mut s, 4, 0, 1);
        assert_eq!(lane(&s4(0x39, d, s), 4, 0), -1); // PMINSD
        assert_eq!(lane(&s4(0x3B, d, s), 4, 0), 1); // PMINUD
        assert_eq!(lane(&s4(0x3D, d, s), 4, 0), 1); // PMAXSD
        assert_eq!(lane(&s4(0x3F, d, s), 4, 0), -1); // PMAXUD
        assert_eq!(s4(0x38, [0x80; 16], [0x7F; 16])[0], 0x80); // PMINSB
        assert_eq!(s4(0x3C, [0x80; 16], [0x7F; 16])[0], 0x7F); // PMAXSB
        assert_eq!(
            words(s4(0x3A, from_words(&[-1; 8]), from_words(&[1; 8])))[0],
            1
        ); // PMINUW
        assert_eq!(
            words(s4(0x3E, from_words(&[-1; 8]), from_words(&[1; 8])))[0],
            -1
        ); // PMAXUW
           // the first of equal minimums; the rest zero
        let s = from_words::<16>(&[9, 3, -1, 3, 4, 3, 8, 3]);
        assert_eq!(words(s4(0x41, [0xFF; 16], s)), [3, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(
            words(s4(0x41, [0; 16], from_words(&[-1; 8]))),
            [-1, 0, 0, 0, 0, 0, 0, 0]
        );
    }
    #[test]
    fn ptest_flags() {
        assert_eq!(ptest([0xF0; 16], [0x0F; 16]), (true, false));
        assert_eq!(ptest([0xFF; 16], [0x0F; 16]), (false, true));
        assert_eq!(ptest([0; 16], [0; 16]), (true, true));
        let mut s = [0u8; 16];
        s[15] = 0x80;
        assert_eq!(ptest([0x7F; 16], s), (true, false));
    }
    #[test]
    fn blends_mpsadbw_and_insertps() {
        let d: [u8; 16] = std::array::from_fn(|i| i as u8);
        let s: [u8; 16] = std::array::from_fn(|i| 0x80 + i as u8);
        assert_eq!(
            &sse4_imm(0x0C, d, s, 0b1010)[..8],
            &[0, 1, 2, 3, 0x84, 0x85, 0x86, 0x87]
        );
        assert_eq!(sse4_imm(0x0D, d, s, 0b10)[8], 0x88);
        assert_eq!(sse4_imm(0x0E, d, s, 0x81)[..4], [0x80, 0x81, 2, 3]);
        assert_eq!(sse4_imm(0x0E, d, s, 0x81)[14], 0x8E);
        // MPSADBW: |d[off + i + j] - s[4k + j]|
        let r = words(sse4_imm(0x42, d, s, 0b110));
        let expected: Vec<i16> = (0..8)
            .map(|i| (0..4).map(|j| (0x80 + 8 + j - (4 + i + j)) as i16).sum())
            .collect();
        assert_eq!(r, expected);
        // INSERTPS: dword 2 := value, then dwords 0 and 3 zeroed
        let r = insertps(d, 0xAABBCCDD, 0b10_1001);
        assert_eq!(unsigned(&r, 4, 2), 0xAABBCCDD);
        assert_eq!(
            (unsigned(&r, 4, 0), unsigned(&r, 4, 1), unsigned(&r, 4, 3)),
            (0, 0x07060504, 0)
        );
    }
    #[test]
    fn crc32c_check_value_and_widths() {
        // the check value of CRC-32C, "123456789": from all ones, inverted after
        let crc = b"123456789"
            .iter()
            .fold(!0, |crc, &b| crc32c(crc, b as u64, 1));
        assert_eq!(!crc, 0xE306_9283);
        // wider operands: their bytes, least significant first; only `bytes` of them
        let bytewise = b"12345678"
            .iter()
            .fold(!0, |crc, &b| crc32c(crc, b as u64, 1));
        assert_eq!(crc32c(!0, u64::from_le_bytes(*b"12345678"), 8), bytewise);
        assert_eq!(
            crc32c(5, 0xFFFF_0000_1234, 2),
            crc32c(crc32c(5, 0x34, 1), 0x12, 1)
        );
    }
    #[test]
    fn compare_strings_examples() {
        let s = |text: &[u8]| -> [u8; 16] {
            let mut v = [0; 16];
            v[..text.len()].copy_from_slice(text);
            v
        };
        // equal any: the vowels of "hello world"; both strings end early
        let r = compare_strings(0x00, s(b"aeiou"), s(b"hello world"), None, None);
        assert_eq!((r.mask, r.index, r.flags), (0x92, 1, 0xC1));
        // ... as a byte mask (PCMPxSTRM, imm8[6])
        let r = compare_strings(0x40, s(b"aeiou"), s(b"hello world"), None, None);
        assert_eq!(r.xmm0, s(b"\0\xFF\0\0\xFF\0\0\xFF"));
        // ranges: the lower-case letters
        let r = compare_strings(0x04, s(b"az"), s(b"Hello1"), None, None);
        assert_eq!(r.mask, 0x1E);
        // equal ordered: "lo" at 3; a needle running off the end of a full
        // haystack matches there, but not past the end of a shorter one
        let r = compare_strings(0x0C, s(b"lo"), s(b"hello world"), None, None);
        assert_eq!((r.mask, r.index), (0x08, 3));
        let r = compare_strings(0x0C, s(b"bcd"), *b"aaaaaaaaaaaaaaab", None, None);
        assert_eq!(r.mask, 0x8000);
        let r = compare_strings(0x0C, s(b"bcd"), s(b"aaaab"), None, None);
        assert_eq!(r.mask, 0);
        // equal each, masked negative: the first difference (strcmp), the
        // elements after both strings equal
        let r = compare_strings(0x38, s(b"abcd"), s(b"abxd"), None, None);
        assert_eq!((r.mask, r.index, r.flags & 1), (0xFFF4, 2, 1));
        // signed words, explicit lengths: absolute values, at most 8
        let w = |words: &[i16]| -> [u8; 16] {
            let mut v = [0; 16];
            for (i, x) in words.iter().enumerate() {
                v[2 * i..2 * i + 2].copy_from_slice(&x.to_le_bytes());
            }
            v
        };
        let r = compare_strings(0x03, w(&[-1, 5, 9]), w(&[5, -1, 7, 9]), Some(-2), Some(3));
        assert_eq!((r.mask, r.flags), (0b011, 0xC1 | 0x800));
        let r = compare_strings(0x03, w(&[-1, 5]), w(&[5]), Some(i64::MIN), Some(100));
        // (both saturate to 8 elements, the zero words valid too: they match;
        // no ZF or SF)
        assert_eq!((r.mask, r.flags & 0xC0), (0xFF, 0));
        // no match: the index is the element count
        let r = compare_strings(0x01, w(&[3]), w(&[4]), None, None);
        assert_eq!((r.mask, r.index), (0, 8));
    }
    #[test]
    fn palignr_every_shift() {
        let d: [u8; 16] = std::array::from_fn(|i| 0x20 + i as u8);
        let s: [u8; 16] = std::array::from_fn(|i| 0x10 + i as u8);
        for imm in 0..=255u8 {
            let r = palignr(d, s, imm);
            for i in 0..16 {
                let n = i + imm as usize;
                assert_eq!(r[i], if n < 32 { 0x10 + n as u8 } else { 0 });
            }
        }
        let r = palignr([0x21u8; 8], [0x11; 8], 7);
        assert_eq!(r, [0x11, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21]);
        assert_eq!(palignr([1u8; 8], [2; 8], 16), [0; 8]);
    }
}
