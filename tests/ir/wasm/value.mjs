import assert from "node:assert/strict";
import fs from "node:fs";

const samples = [0n, 1n, 2n, 0x7Fn, 0x80n, 0x8000n, 0x7FFFFFFFn, 0x80000000n,
    0xFFFFFFFFn, 0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn];
const cases = JSON.parse(fs.readFileSync("build/ir-mir-value/cases.json"));
function expected(operation, bits, a, b) {
    const x = BigInt.asUintN(bits, a), y = BigInt.asUintN(bits, b);
    const shift = y & (bits === 64 ? 63n : 31n);
    let result;
    switch(operation) {
        case "Add": result = x + y; break;
        case "Sub": result = x - y; break;
        case "Mul": result = x * y; break;
        case "And": result = x & y; break;
        case "Or": result = x | y; break;
        case "Xor": result = x ^ y; break;
        case "Shl": result = x << shift; break;
        case "Shr": result = x >> shift; break;
        case "Sar": result = BigInt.asIntN(bits, x) >> shift; break;
        case "Eq": return BigInt(x === y);
        case "Ult": return BigInt(x < y);
        case "Slt": return BigInt(BigInt.asIntN(bits, x) < BigInt.asIntN(bits, y));
        default: throw new Error(operation);
    }
    return BigInt.asUintN(bits, result);
}
let executions = 0;
for(const [index, [bits, operation]] of cases.entries()) for(const opt of [0, 1]) {
    const bytes = fs.readFileSync(`build/ir-mir-value/${index}-${opt}.wasm`);
    assert(WebAssembly.validate(bytes));
    const module = new WebAssembly.Module(bytes);
    const m = new WebAssembly.Memory({initial: 64});
    const words = new Uint32Array(m.buffer);
    const f = new WebAssembly.Instance(module, {e: {m}}).exports.f;
    for(const a of samples) for(const b of samples) {
        const input = [Number(a & 0xFFFFFFFFn), Number(a >> 32n), Number(b & 0xFFFFFFFFn), Number(b >> 32n),
            0x12345678, 0x87654321, 0xFEDCBA98, 0x89ABCDEF];
        words.set(input); words[8] = 0x8D7; words[11] = 0xAABBCCDD;
        f(0);
        const result = BigInt(words[0]) | BigInt(words[1]) << 32n;
        assert.equal(result, expected(operation, bits, a, b), `${bits} ${operation}, opt ${opt}, ${a}/${b}`);
        assert.deepEqual(Array.from(words.slice(2, 8)), input.slice(2));
        assert.equal(words[8], 0x8D7);
        assert.equal(words[9], 0x1002);
        assert.equal(words[10], 1);
        assert.equal(words[11], 0xAABBCCDD);
        executions++;
    }
}
console.log(`PASS: ${executions} MIR scalar value executions against independent BigInt widths, signs, shifts and normalization`);
