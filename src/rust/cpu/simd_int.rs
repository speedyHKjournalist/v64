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
