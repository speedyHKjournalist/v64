import assert from "node:assert/strict";
import fs from "node:fs";

const cases = ["equal", "different", "taken", "not-taken", "parallel-equal", "parallel-different", "loop-invariant", "loop-changing"];
const budgets = [1, 2, 3, 4, 8, 100];
const modes = ["before", "sccp", "pipeline"];
const memory = new WebAssembly.Memory({initial: 64});
const words = new Uint32Array(memory.buffer, 0, 16);
let executions = 0;
let modules = 0;

for(const name of cases) {
    for(const budget of budgets) {
        const functions = modes.map(mode => {
            // Require every fixture; a missing Rust-generated module is a failure.
            const path = `build/ir-sccp/${name}-${mode}-${budget}.wasm`;
            const bytes = fs.readFileSync(path);
            assert(WebAssembly.validate(bytes), `${path}: Wasm validation`);
            modules++;
            return new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {m: memory}}).exports.f;
        });
        for(const branch of [0, 1, 0xFFFFFFFF]) {
            for(const count of [0, 1, 2, 7, 15]) {
                for(const flags of [2, 0x8D7, 0x202, 0xAD7]) {
                    const initial = new Uint32Array(16).fill(0xCDCDCDCD);
                    initial.set([0xFFFFFFFF, 0x80000000, count, 0x12345678, 0x90000, 0xFFFFFFFF, 17, branch]);
                    initial[8] = flags;
                    initial[10] = 99;
                    initial[11] = 0x76543210;
                    let reference;
                    for(let mode = 0; mode < functions.length; mode++) {
                        words.set(initial);
                        functions[mode](0);
                        const state = Array.from(words);
                        const context = `${name}/${budget}/${branch}/${count}/${flags}/${modes[mode]}`;
                        assert.deepEqual(state.slice(12), Array.from(initial.slice(12)), `${context}: boundary canaries`);
                        if(reference) assert.deepEqual(state, reference, `${context}: full StateMap and exact budget exit`);
                        else reference = state;
                        if(budget === 100) {
                            if(name.startsWith("loop-")) {
                                const iterations = Math.max(1, count);
                                const invariant = name === "loop-changing" ? 7 + iterations : 7;
                                assert.equal(words[0], iterations, `${context}: iteration count`);
                                assert.equal(words[1], invariant, `${context}: loop-carried value`);
                                assert.equal(words[3], invariant + 1, `${context}: exit computation`);
                                assert.equal(words[9], 0x8000 + invariant, `${context}: dynamic EIP`);
                                assert.equal(words[10], iterations, `${context}: dynamic count base`);
                                assert.equal(words[8], flags, `${context}: flags preserved`);
                            }
                            else {
                                const taken = name === "taken" || name !== "not-taken" && branch === 0;
                                const different = ["different", "taken", "not-taken", "parallel-different"].includes(name);
                                const incoming = different && !taken ? 9 : 7;
                                assert.equal(words[0], incoming + 1, `${context}: arithmetic result`);
                                assert.equal(words[9], incoming === 7 ? 0x4001 : 0x5001, `${context}: CMP/Jcc target`);
                                assert.equal(words[10], 3, `${context}: committed instructions`);
                                // Independent unsigned 32-bit CMP incoming,7 flag oracle.
                                const result = (incoming - 7) >>> 0;
                                let byte = result & 255;
                                let parity = 1;
                                while(byte) { parity ^= byte & 1; byte >>>= 1; }
                                const expected = (flags & ~0x8D5) |
                                    Number(incoming < 7) | parity << 2 |
                                    ((incoming ^ 7 ^ result) & 16) |
                                    Number(result === 0) << 6 | (result >>> 31) << 7 |
                                    (((incoming ^ 7) & (incoming ^ result)) >>> 31) << 11;
                                assert.equal(words[8], expected >>> 0, `${context}: independent CMP FLAGS`);
                            }
                        }
                        executions++;
                    }
                    for(const entry of [-1, 1, 2]) {
                        for(const f of functions) {
                            words.set(initial);
                            f(entry);
                            assert.deepEqual(Array.from(words), Array.from(initial), "invalid entry preserves state");
                        }
                    }
                }
            }
        }
    }
}
console.log(`PASS: ${modules} SCCP modules, ${executions} before/SCCP/pipeline executions; phi joins, parallel edges, loops, FLAGS, dynamic EIP/count and exact budget recovery`);

const widths = JSON.parse(fs.readFileSync("build/ir-sccp/widths.json"));
assert.equal(widths.length, 240);
let width_executions = 0;
for(let id = 0; id < widths.length; id++) {
    const [width, op, a_text, b_text] = widths[id];
    const bits = BigInt(width);
    const mask = (1n << bits) - 1n;
    const a = BigInt(a_text);
    const b = BigInt(b_text);
    const shift = b & (width === 64 ? 63n : 31n);
    const signed = n => n & (1n << (bits - 1n)) ? n - (1n << bits) : n;
    let expected;
    switch(op) {
        case "Add": expected = a + b; break;
        case "Sub": expected = a - b; break;
        case "Mul": expected = a * b; break;
        case "And": expected = a & b; break;
        case "Or": expected = a | b; break;
        case "Xor": expected = a ^ b; break;
        case "Shl": expected = a << shift; break;
        case "Shr": expected = a >> shift; break;
        case "Sar": expected = signed(a) >> shift; break;
        case "Eq": expected = BigInt(a === b); break;
        case "Ult": expected = BigInt(a < b); break;
        case "Slt": expected = BigInt(signed(a) < signed(b)); break;
        default: assert.fail(`unknown operation ${op}`);
    }
    expected &= mask;
    const functions = [false, true].map(optimized => {
        const bytes = fs.readFileSync(`build/ir-sccp/width-${id}-${optimized}.wasm`);
        assert(WebAssembly.validate(bytes), `width case ${id}: valid Wasm`);
        return new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {m: memory}}).exports.f;
    });
    for(const branch of [0, 1]) {
        let reference;
        for(const f of functions) {
            const input = new Uint32Array(16).fill(0xA5A5A5A5);
            input[7] = branch;
            input[8] = 0xAD7;
            words.set(input);
            f(0);
            const state = Array.from(words);
            assert.equal(words[0], Number(expected & 0xFFFFFFFFn), `${id}: low result`);
            assert.equal(words[1], Number(expected >> 32n), `${id}: high result`);
            assert.equal(words[9], 0x9001, `${id}: exit EIP`);
            assert.equal(words[10], 1, `${id}: committed count`);
            assert.equal(words[8], input[8], `${id}: unchanged FLAGS`);
            assert.deepEqual(state.slice(12), Array.from(input.slice(12)), `${id}: canaries`);
            if(reference) assert.deepEqual(state, reference, `${id}: complete StateMap`);
            else reference = state;
            width_executions++;
        }
    }
}
console.log(`PASS: 480 typed phi modules and ${width_executions} independent BigInt executions at I1/I8/I16/I32/I64, including overflow and narrow/Wasm shift masks`);
