import assert from "node:assert/strict";
import fs from "node:fs";

const memory = new WebAssembly.Memory({initial: 64});
const words = new Uint32Array(memory.buffer);
let executions = 0;
for(const budget of [1, 2, 3, 4, 5, 8, 17, 100]) {
    const instances = [false, true].map(opt => {
        const bytes = fs.readFileSync(`build/ir-licm/loop-${budget}-${opt}.wasm`);
        assert(WebAssembly.validate(bytes), `valid LICM module: budget ${budget}, opt ${opt}`);
        return new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {m: memory}});
    });
    for(const count of [0, 1, 2, 7, 16, 31])
    for(const a of [0, 1, 0x7FFFFFFF, 0xFFFFFFFF])
    for(const b of [0, 3, 0x80000000, 0xFFFFFFFF])
    for(const c of [0, 1, 17, 0xFFFFFFFF])
    for(const flags of [2, 0x8D7]) {
        const input = [count, 123, a, b, c, 0x13579BDF, 0x2468ACE0, 0xDEADBEEF];
        const outputs = [];
        for(const instance of instances) {
            words.fill(0xA5A5A5A5, 0, 32);
            words.set(input);
            words[8] = flags;
            words[9] = 0;
            words[10] = 123;
            words[11] = 0x76543210;
            instance.exports.f(0);
            const output = Array.from(words.slice(0, 32));
            outputs.push(output);
            assert(output[0] <= count, "remaining iterations cannot increase");
            const completed = count - output[0];
            const increment = ((BigInt(a) + BigInt(b)) * BigInt(c)) & 0xFFFFFFFFn;
            assert.equal(output[1], Number((BigInt(completed) * increment) & 0xFFFFFFFFn));
            assert.deepEqual(output.slice(2, 8), input.slice(2));
            assert.equal(output[8], flags, "arithmetic FLAGS preserved at all exits");
            assert([0x2001, 0x2003, 0x2002, 0x3000].includes(output[9]), "known recovery PC");
            assert.equal(output[10], 0, "fixture has no guest instruction commits");
            assert.equal(output[11], 0x76543210, "lazy flag operand preserved");
            assert(output.slice(12).every(v => v === 0xA5A5A5A5), "no unrelated state writes");
            if(output[9] === 0x3000) assert.equal(output[0], 0, "normal exit completed all iterations");
            if(budget === 100) assert.equal(output[9], 0x3000, "ample budget reaches normal exit");
            executions++;
        }
        assert.deepEqual(outputs[1], outputs[0], `exact recovery: budget ${budget}, count ${count}`);
    }
    for(const instance of instances) {
        for(const entry of [-1, 1, 0x7FFFFFFF]) {
            words.fill(0xA5A5A5A5, 0, 32);
            instance.exports.f(entry);
            assert(words.slice(0, 32).every(v => v === 0xA5A5A5A5), "invalid entry has no effect");
        }
    }
}
console.log(`PASS: ${executions} LICM Wasm executions: zero trips, wrapping arithmetic, polls, exact budget recovery and invalid entries`);
