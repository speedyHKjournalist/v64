import assert from "node:assert/strict";
import fs from "node:fs";

let executions = 0;
for(let code = 0; code < 27; code++) {
    const mapping = [code % 3, Math.floor(code / 3) % 3, Math.floor(code / 9)];
    for(const opt of [0, 1]) for(const budget of [1, 100]) {
        const bytes = fs.readFileSync(`build/ir-mir-control/${code}-${opt}-${budget}.wasm`);
        assert(WebAssembly.validate(bytes));
        const module = new WebAssembly.Module(bytes);
        for(const branch of [0, 1]) for(const seed of [0, 0x7FFFFFFF, 0xFFFFFFFF]) {
            const m = new WebAssembly.Memory({initial: 64});
            const state = new Uint32Array(m.buffer);
            const input = Array.from({length: 8}, (_, i) => (seed + Math.imul(i, 0x10203041)) >>> 0);
            input[7] = branch;
            state.set(input); state[8] = 0x8D7; state[11] = 0x76543210;
            new WebAssembly.Instance(module, {e: {m}}).exports.f(0);
            const expected = input.slice();
            const selected = branch === 0 ? mapping : mapping.slice().reverse();
            for(let i = 0; i < 3; i++) expected[i] = input[selected[i]];
            assert.deepEqual(Array.from(state.slice(0, 8)), expected, `mapping ${code}, opt ${opt}, budget ${budget}, branch ${branch}`);
            assert.equal(state[8], 0x8D7, "edge copies preserve FLAGS");
            assert.equal(state[9], 0x1002, "normal and budget exit PC");
            assert.equal(state[10], 1, "normal and budget commit state");
            assert.equal(state[11], 0x76543210, "recovery-only flag operand");
            executions++;
        }
    }
}
console.log(`PASS: ${executions} MIR scheduled critical-edge copies, fanout, aliases, branches and budget recovery executions`);
