// A model of the SSSE3 instructions written from the SDM's pseudocode,
// independent of src/rust/cpu/simd_int.rs (tests/rust/ssse3.mjs, tests/x64/ssse3.mjs)
import assert from "node:assert/strict";

// The opcode bytes (0F 38 xx, and PALIGNR: 0F 3A 0F) and names
export const OPS = [[0x00, "pshufb"], [0x01, "phaddw"], [0x02, "phaddd"], [0x03, "phaddsw"], [0x04, "pmaddubsw"],
    [0x05, "phsubw"], [0x06, "phsubd"], [0x07, "phsubsw"], [0x08, "psignb"], [0x09, "psignw"], [0x0A, "psignd"],
    [0x0B, "pmulhrsw"], [0x1C, "pabsb"], [0x1D, "pabsw"], [0x1E, "pabsd"], [0x0F, "palignr"]];
export const PALIGNR = 0x0F;

/** The SDM's pseudocode for `op` with N-byte operands (8: MMX, 16: XMM) */
export function model(op, destination, source, imm8)
{
    // (copies: typed array views need aligned offsets)
    destination = Uint8Array.from(destination);
    source = Uint8Array.from(source);
    const n = destination.length, result = new Uint8Array(n);
    const view = (a, T) => new T(a.buffer, a.byteOffset, a.length / T.BYTES_PER_ELEMENT);
    const clamp = x => Math.max(-0x8000, Math.min(0x7FFF, x));
    if(op === PALIGNR)
    {
        // temp = DEST:SRC >> imm8 * 8
        const temp = new Uint8Array(2 * n);
        temp.set(source, 0);
        temp.set(destination, n);
        for(let i = 0; i < n; i++) result[i] = i + imm8 < 2 * n ? temp[i + imm8] : 0;
        return result;
    }
    switch(op)
    {
        case 0x00:
            for(let i = 0; i < n; i++) result[i] = source[i] & 0x80 ? 0 : destination[source[i] & (n === 8 ? 7 : 15)];
            break;
        case 0x01: case 0x03: case 0x05: case 0x07: case 0x02: case 0x06:
        {
            const T = op === 0x02 || op === 0x06 ? Int32Array : Int16Array;
            const d = view(destination, T), s = view(source, T), r = view(result, T), half = d.length / 2;
            for(let i = 0; i < half; i++)
            {
                for(const [v, k] of [[d, i], [s, half + i]])
                {
                    // PHADD: the sum of the pair; PHSUB: the low element minus the high one
                    let x = op <= 0x03 ? v[2 * i] + v[2 * i + 1] : v[2 * i] - v[2 * i + 1];
                    if(op === 0x03 || op === 0x07) x = clamp(x);
                    r[k] = x;
                }
            }
            break;
        }
        case 0x04:
        {
            // unsigned destination bytes times signed source bytes, pairs saturated
            const s = view(source, Int8Array), r = view(result, Int16Array);
            for(let i = 0; i < n / 2; i++) r[i] = clamp(destination[2 * i] * s[2 * i] + destination[2 * i + 1] * s[2 * i + 1]);
            break;
        }
        case 0x08: case 0x09: case 0x0A:
        {
            const T = [Int8Array, Int16Array, Int32Array][op - 0x08];
            const d = view(destination, T), s = view(source, T), r = view(result, T);
            for(let i = 0; i < d.length; i++) r[i] = s[i] < 0 ? -d[i] : s[i] === 0 ? 0 : d[i];
            break;
        }
        case 0x0B:
        {
            const d = view(destination, Int16Array), s = view(source, Int16Array), r = view(result, Int16Array);
            // temp = ((DEST * SRC) >> 14) + 1; DEST = temp[16:1]
            for(let i = 0; i < d.length; i++) r[i] = ((d[i] * s[i] >> 14) + 1) >> 1;
            break;
        }
        case 0x1C: case 0x1D: case 0x1E:
        {
            const [S, U] = [[Int8Array, Uint8Array], [Int16Array, Uint16Array], [Int32Array, Uint32Array]][op - 0x1C];
            const s = view(source, S), r = view(result, U);
            for(let i = 0; i < s.length; i++) r[i] = Math.abs(s[i]);
            break;
        }
        default: assert.fail(op);
    }
    return result;
}
