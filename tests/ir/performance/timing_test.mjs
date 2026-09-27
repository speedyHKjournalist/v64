import assert from "node:assert/strict";
import { finish_halted_timing } from "./timing.mjs";
for(const delay of [0, 1, 100, 1000]) {
    let now = 125, calls = 0;
    const vm = { stop: async () => { calls++; now += delay; } };
    const result = await finish_halted_timing(vm, 100, () => now);
    assert.equal(calls, 1);
    assert.deepEqual(result, { ms: 25, stop_wait_ms: delay,
        timing_scope: "start-to-observed-halt" });
}
await assert.rejects(finish_halted_timing({ stop: async () => { throw new Error("stop failed"); } }, 0, () => 1), /stop failed/);
console.log("PASS: observed-halt timings exclude arbitrary stop acknowledgement delay and preserve stop failures");
