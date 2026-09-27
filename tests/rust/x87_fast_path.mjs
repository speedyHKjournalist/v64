import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { PerformanceRecorder } from "../../src/browser/performance_recorder.js";
const bios = Uint8Array.from(fs.readFileSync("build/x87-fast-test.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(wasm, interpreted, fast_math = false) {
    const vm = new V86({ wasm_path: wasm, bios: { buffer: bios }, memory_size: 32 << 20,
        disable_jit: interpreted, disable_keyboard: true, disable_mouse: true,
        x87_fast_math: fast_math,
        disable_speaker: true, net_device: { type: "none" }, autostart: false });
    try {
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        const e = vm.v86.cpu.wm.exports;
        const recorder = new PerformanceRecorder(vm);
        recorder.start();
        const cycles = () => { const bytes = vm.read_memory(0x400, 2); return bytes[0] | bytes[1] << 8; };
        const until = async predicate => {
            const deadline = performance.now() + 10000;
            while(!predicate()) {
                assert(performance.now() < deadline, "x87 guest timed out");
                await sleep(10);
            }
        };
        vm.run();
        await until(() => cycles() >= 20 && (interpreted || e.performance_recording_get(1) > 0));
        await vm.stop();
        const report = JSON.parse(JSON.stringify(recorder.stop()));
        assert(report.duration_ms > 0);
        if(e.performance_recording_x87_get) {
            assert.equal(report.x87_counters_available, true);
            for(const op of ["add", "sub", "mul"]) {
                const row = report.x87.operations[op];
                if(fast_math) {
                    assert(row.approximate_f64 > 0, op + " executes native f64");
                    assert.equal(row.approximate_f64, row.total);
                    assert.equal(row.softfloat_fallback, 0);
                    assert.equal(report.x87.current_state.arithmetic_mode, "fast_f64");
                } else assert(row.fast_path > 0 && row.softfloat_fallback > 0, op + " exercises both paths");
                assert.equal(row.total, row.fast_path + row.softfloat_fallback);
                assert.equal(row.modes.length, 12, op + " observes all control modes");
            }
        } else assert.equal(report.x87, null);
        const result = Uint8Array.from(vm.read_memory(0x500, 12 * (9 * 6 * 12 + 16 * 18 + 12 * 6)));
        const state = await vm.save_state();
        const before = cycles();
        vm.run();
        await until(() => cycles() > before + 5);
        await vm.stop();
        await vm.restore_state(state);
        if(e.set_x87_fast_math) assert.equal(e.performance_recording_x87_state(2), +fast_math,
            "guest state restore preserves selected host arithmetic policy");
        assert.equal(cycles(), before, "save/restore preserves the guest timeline");
        vm.run();
        await until(() => cycles() > before + 5);
        await vm.stop();
        assert.deepEqual(Uint8Array.from(vm.read_memory(0x500, result.length)), result,
            "x87 arithmetic after state restore preserves results and status words");
        return result;
    } finally { await vm.destroy(); }
}
const candidate = process.argv[3] || "build/v86.wasm";
const interpreted = await run(candidate, true);
const jit = await run(candidate, false);
assert.deepEqual(jit, interpreted, "interpreter and actual JIT must match arithmetic/comparison and binary32 conversion results/status");
if(process.argv[2]) {
    assert.deepEqual(jit, await run(process.argv[2], false), "before/after Wasm results must match");
}
const fast_interpreted = await run(candidate, true, true);
const fast_jit = await run(candidate, false, true);
assert.deepEqual(fast_jit, fast_interpreted, "fast f64 interpreter/JIT results and state restore agree");
assert.notDeepEqual(fast_jit, jit, "extended precision/rounding cases expose the intentional semantic difference");
// Per control: nine pairs with four arithmetic results then two comparisons,
// followed by load/store conversion tests. These remain byte-for-byte intact.
const stride = 9 * 6 * 12 + 16 * 18 + 12 * 6;
for(let mode = 0; mode < 12; mode++) {
    for(let pair = 0; pair < 9; pair++) {
        const offset = mode * stride + pair * 72 + 48;
        assert.deepEqual(fast_jit.slice(offset, offset + 24), jit.slice(offset, offset + 24),
            "comparison semantics are unchanged");
    }
    assert.deepEqual(fast_jit.slice(mode * stride + 648, (mode + 1) * stride),
        jit.slice(mode * stride + 648, (mode + 1) * stride), "load/store conversion semantics are unchanged");
}
console.log("PASS: compatible and fast-f64 x87, all 12 controls, interpreter/JIT and save/restore; comparisons and conversions unchanged" +
    (process.argv[2] ? "; compatible mode matches previous Wasm" : ""));
