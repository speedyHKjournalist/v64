import assert from "node:assert/strict";
import fs from "node:fs";
let executions = 0;
const before = [77, 0, 0, 0, 0, 0, 0, 0, 0x8D5, 0x1000, 7];
for(const owner of ["caller", "helper", "pure"]) for(const opt of [0, 1]) {
    const bytes = fs.readFileSync(`build/ir-helpers/${owner}-${opt}.wasm`);
    assert(WebAssembly.validate(bytes));
    const module = new WebAssembly.Module(bytes);
    for(const outcome of [0, 1, 2, 3, 4, 5, -1]) {
        const m = new WebAssembly.Memory({initial: 64}), words = new Uint32Array(m.buffer);
        words.fill(0xDEADBEEF, 0, 11);
        let calls = 0, deliveries = 0;
        const instance = new WebAssembly.Instance(module, {e: {
            m,
            audited_operation: x => {
                calls++;
                assert.equal(x, 77);
                assert.deepEqual(Array.from(words.slice(0, 11)), before, "pre-call state is fully observable");
                if(outcome !== 0) words.fill(0xC0FFEE, 0, 11);
                return [outcome, 0xF00D, 0x1FF];
            },
            deliver_fault: () => {
                deliveries++;
                assert.deepEqual(Array.from(words.slice(0, 11)), before,
                    "fault restores snapshot even when results reuse its local slots");
                words.fill(0xBADF00D, 0, 11); // Model delivery replacing CPU state/EIP.
            },
        }});
        const valid = outcome === 0 || owner === "caller" && outcome === 1
            || owner !== "pure" && outcome >= 2 && outcome <= 4;
        if(valid) instance.exports.f(0);
        else assert.throws(() => instance.exports.f(0), WebAssembly.RuntimeError,
            "invalid outcomes cannot resume guest execution");
        assert.equal(calls, 1);
        assert.equal(deliveries, owner === "caller" && outcome === 1 ? 1 : 0, "single exception owner");
        if(outcome === 0) assert.deepEqual(Array.from(words.slice(0, 11)),
            [0xF00D, 255, 0, 0, 0, 0, 0, 0, 0x8D5, 0x1002, 8]);
        else assert(words.slice(0, 11).every(x => x === (deliveries ? 0xBADF00D : 0xC0FFEE)),
            "post-transfer/yield/invalidation state must not be overwritten");
        executions++;
    }
}
console.log(`PASS: ${executions} IR helper ABI executions: outcomes, observation, result normalization, snapshot-slot reuse, single fault delivery and no stale restoration`);
