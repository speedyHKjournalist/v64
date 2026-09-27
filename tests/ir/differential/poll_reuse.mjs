// A budget exit may retain an existing certificate, never grant a new one.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const vm = new V86({ wasm_path: wasm, jit_backend: "ir", memory_size: 32 << 20,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "none" }, autostart: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PC = 0x8000, N = 6000, INITIAL = 0xFFFFFFF0;
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // These cases exercise the strict (byte-validating) admission contract and
    // its slow-path machinery; notified_validation.mjs covers the default.
    assert.equal(e.ir_cache_set_strict_validation(1), 1);
    const count = () => vm.get_instruction_counter() >>> 0;
    vm.run();
    const deadline = performance.now() + 10000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout"); await sleep(1);
    }
    await vm.stop();
    assert.equal(e.ir_cache_set_poll_reuse(2), 0, "reject invalid policy");
    const prepare = (mode, cs) => {
        cpu.in_hlt[0] = 0; cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
        cpu.is_32[0] = mode; cpu.stack_size_32[0] = 1;
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_offsets[1] = cs;
        cpu.segment_is_null.fill(0, 0, 6);
        cpu.reg32.set([0, N, 0, 0, 0x90000, 0, 0, 0]);
        cpu.instruction_pointer[0] = PC;
        new Uint32Array(e.memory.buffer)[664 >> 2] = INITIAL;
        e.update_state_flags();
    };
    const run = (expected, length = 5, work = N * 3 + 1) => {
        const end = performance.now() + 10000;
        while(!cpu.in_hlt[0]) { assert(performance.now() < end, "guest progress"); e.main_loop(); }
        assert.equal(count(), (INITIAL + work) >>> 0, "exact wrapped retirement");
        assert.equal(cpu.reg32[3], expected); assert.equal(cpu.reg32[1], 0);
        assert.equal(cpu.instruction_pointer[0], PC + length);
        return { gpr: Array.from(cpu.reg32), flags: e.get_eflags(), count: count(), ip: cpu.instruction_pointer[0] };
    };
    let compared = 0, avoided = 0, fast = 0;
    for(const [mode, cs] of [[1, 0], [0, 0], [1, 0x1000]]) {
        for(const budget of [8, 17, 32, 65, 256, 257]) {
            for(const kind of ["ordinary", "full_validation", "recording", "diagnostics", "raw_between_batches", "notified_between_batches"]) {
                const states = [], counters = [];
                for(const enabled of [0, 1]) {
                    assert.equal(await vm.configure_ir_diagnostics(kind === "diagnostics" ? 1 : 0), true);
                    assert.equal(e.ir_auto_config(0, 2, 4, 192, 256, 64), 1);
                    cpu.jit_clear_cache(); e.ir_cache_collect();
                    assert.equal(e.ir_cache_set_fusion(0), 1);
                    assert.equal(e.ir_cache_set_warm_chaining(0), 1);
                    assert.equal(e.ir_cache_set_fast_validation(kind === "full_validation" ? 0 : 1), 1);
                    assert.equal(e.ir_cache_set_poll_reuse(enabled), 1);
                    e.performance_recording_enable(kind === "recording" ? 1 : 0);
                    prepare(mode, cs);
                    vm.write_memory(Uint8Array.of(0x43, 0x49, 0x75, 0xFC, 0xF4), PC);
                    assert(await cpu.ir_compile_cached(5, 2, 1, 1, budget, 64));
                    prepare(mode, cs);
                    const before = [18, 19, 39].map(field => e.ir_cache_stat(field));
                    let result = run(N);
                    const after = [18, 19, 39].map((field, i) => (e.ir_cache_stat(field) - before[i]) >>> 0);
                    counters.push(after);
                    if(!enabled || ["diagnostics", "recording"].includes(kind)) assert.equal(after[2], 0, `${kind}: conservative mode`);
                    if(kind === "raw_between_batches" || kind === "notified_between_batches") {
                        // No generation notification for the raw case. A new CPU
                        // batch still revokes the previous validation interval.
                        if(kind === "raw_between_batches") cpu.mem8[PC] = 0x4B;
                        else vm.write_memory(Uint8Array.of(0x4B), PC);
                        prepare(mode, cs); result = run(mode ? -N : 65536 - N);
                    }
                    states.push(result);
                    assert.equal(e.ir_cache_stat(40), enabled);
                    e.performance_recording_enable(0);
                }
                assert.deepEqual(states[1], states[0], `${mode}/${cs}/${budget}/${kind}: exact A/B`);
                if(kind === "ordinary") { avoided += counters[1][2]; fast += counters[1][0]; }
                // Compare full checks only for aligned exits that actually reused
                // a certificate; an interpreter bridge legitimately revokes it.
                if(kind === "ordinary" && counters[1][0] > counters[0][0]) {
                    assert(counters[1][1] < counters[0][1], "reuse reduces complete byte scans");
                }
                compared++;
            }
        }
    }
    // Observing callbacks cannot change the policy while an owner is held.
    for(const enabled of [0, 1]) {
        assert.equal(await vm.configure_ir_diagnostics(0), true);
        cpu.jit_clear_cache();
        assert.equal(e.ir_cache_set_poll_reuse(enabled), 1);
        prepare(1, 0);
        vm.write_memory(Uint8Array.of(0x43, 0xE4, 0x93, 0x49, 0x75, 0xFA, 0xF4), PC);
        assert(await cpu.ir_compile_cached(7, 2, 1, 1, 65, 64));
        let calls = 0;
        cpu.io.register_read(0x93, null, () => {
            calls++;
            assert.equal(e.ir_cache_set_poll_reuse(1 - enabled), 0, "active observer rejects policy mutation");
            return 0;
        });
        prepare(1, 0); run(N, 7, N * 4 + 1); assert.equal(calls, N);
        assert.equal(e.ir_cache_stat(40), enabled);
    }
    assert(avoided > 0, "exercise certified poll exits");
    assert(fast > 0, "exercise actual next-entry certificate reuse");
    console.log(`PASS: ${wasm}: ${compared} exact poll-exit A/B cases; ${avoided} barriers avoided, ${fast} fast validations; modes, CS, wrapped counts, host batches, raw/notified code and instrumentation fallback`);
} finally { await vm.destroy(); }
