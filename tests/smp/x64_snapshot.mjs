#!/usr/bin/env node
// Full-machine persistence for high physical windows and per-core wide TLBs.
// Cache contents are injected to isolate snapshot semantics; paging.rs tests
// independently prove stale translations survive until architectural INVLPG.
import assert from "node:assert/strict";
const { V86 } = await import(process.env.V86_LIB_PATH || (+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js"));
const emulator = new V86({ graphics_adapter: "bochs_vga", wasm_path: process.env.WASM_PATH, memory_size: 16 << 20,
    acpi: true, cpu_cores: 2, disable_jit: true, autostart: false, log_level: 0,
    net_device: { type: "none" } });
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
try
{
    const cpu = emulator.v86.cpu, e = cpu.wm.exports;
    const HIGH = 2 ** 32;
    const generation = () => (e.x64_phys_generation(false) >>> 0) + (e.x64_phys_generation(true) >>> 0) * HIGH;
    const with_buffer = (words, operation) => {
        const pointer = e.v86_malloc(Math.max(4, words.byteLength));
        try
        {
            new Uint32Array(cpu.wasm_memory.buffer, pointer, words.length).set(words);
            return operation(pointer, words.length);
        }
        finally { e.v86_free(pointer); }
    };
    const restore_tlb = (core, words) => with_buffer(words,
        (pointer, count) => e.x64_tlb_snapshot_restore(core, pointer, count));
    assert.equal(e.x64_phys_set_window(0, 0, 1, 0x200000, 0x10000, 1), 1);
    const windows = cpu.get_physical_windows();
    const initial_generation = generation();
    assert.equal(with_buffer(windows, (pointer, count) => e.x64_phys_validate_windows(pointer, count)), 1);
    assert.equal(generation(), initial_generation, "validating windows cannot invalidate caches");
    const invalid_windows = windows.slice();
    invalid_windows[1] = 16;
    assert.equal(with_buffer(invalid_windows, (pointer, count) => e.x64_phys_validate_windows(pointer, count)), 0);
    assert.equal(generation(), initial_generation);
    assert.deepEqual(cpu.get_physical_windows(), windows);
    const records = [0, 1].map(core => {
        const linear_page = (0xFFFF800000100000n + BigInt(core) * 4096n) >> 12n;
        return new Uint32Array([
            Number(linear_page & 0xFFFFFFFFn), Number(linear_page >> 32n),
            0x1000 + core * 0x1000, 1, 24,
            0x5000 + core * 0x1000, 1, 12, 7 | core * 8, 4,
            0x1008, 1, 0x2008, 1, 0x3008, 1, 0x4008, 1,
        ]);
    });
    for(let core = 0; core < 2; core++)
    {
        cpu.switch_core(core);
        cpu.reg32[0] = 0xAB00 + core;
        assert.equal(with_buffer(records[core], (pointer, count) => e.x64_tlb_snapshot_validate(pointer, count)), 1);
        assert.equal(restore_tlb(core, records[core]), 1);
        assert.deepEqual(cpu.get_wide_tlb(core), records[core]);
    }
    cpu.switch_core(0);
    const payload = Uint8Array.from({ length: 32 }, (_, index) => index * 7 & 255);
    cpu.write_blob_physical(payload, HIGH + 0x5000);
    const snapshot = await emulator.save_state();
    assert.deepEqual(cpu.get_wide_tlb(0), records[0], "save does not flush an active core cache");
    assert.deepEqual(cpu.get_wide_tlb(1), records[1], "save does not flush an inactive core cache");
    assert.equal(e.x64_phys_set_window(0, 0, 0, 0, 0, 0), 1);
    cpu.write_blob_physical(new Uint8Array(payload.length).fill(0xEE), 0x205000);
    assert.equal(restore_tlb(0, new Uint32Array(0)), 1);
    assert.equal(restore_tlb(1, new Uint32Array(0)), 1);
    cpu.reg32[0] = 0xBAD;
    await emulator.restore_state(snapshot);
    assert.deepEqual(cpu.get_physical_windows(), windows);
    assert.deepEqual(cpu.read_blob_physical(HIGH + 0x5000, payload.length), payload);
    assert.throws(() => cpu.read8_physical(0x205000), RangeError);
    for(let core = 0; core < 2; core++)
    {
        assert.deepEqual(cpu.get_wide_tlb(core), records[core], "physical restore precedes per-core TLB restore");
        cpu.switch_core(core);
        assert.equal(cpu.reg32[0], 0xAB00 + core);
    }
    cpu.switch_core(0);
    console.log("PASS full-machine snapshot preserves high RAM/window and two independent wide TLB records");

    const original_set_state = cpu.set_state.bind(cpu);
    for(const kind of ["physical", "tlb"])
    {
        const old_generation = generation(), old_epoch = cpu.execution_epoch;
        cpu.set_state = state => {
            if(kind === "physical") state[97][1][1] = 16;
            else state[96][6][1][12][6] = 16;
            original_set_state(state);
        };
        try { await assert.rejects(emulator.restore_state(snapshot), /Invalid/); }
        finally { cpu.set_state = original_set_state; }
        assert.equal(generation(), old_generation);
        assert.equal(cpu.execution_epoch, old_epoch, "invalid snapshot rejected before architectural mutation");
        assert.deepEqual(cpu.get_physical_windows(), windows);
        for(let core = 0; core < 2; core++) assert.deepEqual(cpu.get_wide_tlb(core), records[core]);
        assert.deepEqual(cpu.read_blob_physical(HIGH + 0x5000, payload.length), payload);
    }
    console.log("PASS invalid physical/wide-TLB snapshot rejected before any live architectural state changes");

    cpu.set_state = state => {
        state.length = 97; // prior state images have no physical map extension
        for(const core of state[96][6]) core.length = 12; // no portable x64 TLB extension
        original_set_state(state);
    };
    try { await emulator.restore_state(snapshot); }
    finally { cpu.set_state = original_set_state; }
    assert.deepEqual(cpu.get_physical_windows(), new Uint32Array(80));
    assert.throws(() => cpu.read8_physical(HIGH + 0x5000), RangeError);
    assert.deepEqual(cpu.read_blob_physical(0x205000, payload.length), payload);
    for(let core = 0; core < 2; core++) assert.equal(cpu.get_wide_tlb(core).length, 0);
    console.log("PASS legacy missing physical/wide-TLB extensions clear destination mappings and cached translations");
}
finally { await emulator.destroy(); }
