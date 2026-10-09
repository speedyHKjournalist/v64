#!/usr/bin/env node
// XSAVE-managed state across the machine's lifecycle (docs/simd-xsave-plan.md
// 6.4): per-core XCR0, YMM0_H-YMM15_H, XMM and x87 state round trip through
// snapshots; INIT keeps them (and the rest resets), RESET sets XCR0 to 1;
// snapshots from before the XSAVE range restore XCR0 1 and zero YMM halves,
// also the single-core snapshots from before machine core state; and a
// snapshot restores only into a machine with its CPU features.
import assert from "node:assert/strict";
import { CORE_STATE_RANGES, STATE_OFFSETS } from "../../src/state_layout.js";
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const FEATURES = ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"];
async function machine(count, cpu_features)
{
    const vm = new V86({ graphics_adapter: "bochs_vga", acpi: true, cpu_cores: count, memory_size: 16 << 20,
        disable_jit: true, autostart: false, log_level: 0, cpu_features, cpu_features_unreleased: true,
        cpu_clock: { mode: "deterministic", instructions_per_ms: 100 }, cpu_schedule_seed: 42 });
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    return vm;
}
/** A field of the active core */
const field = (cpu, offset, size) => new Uint8Array(cpu.wasm_memory.buffer, cpu.state_base + offset, size);
const u32 = (cpu, offset) => new DataView(cpu.wasm_memory.buffer, cpu.state_base + offset, 4).getUint32(0, true);
/** Distinct XSAVE state on each core */
function fingerprint(cpu, core)
{
    cpu.switch_core(core);
    new DataView(cpu.wasm_memory.buffer, cpu.state_base + STATE_OFFSETS.xcr0, 8).setUint32(0, 7, true);
    field(cpu, STATE_OFFSETS.ymm_hi, 256).set(Uint8Array.from({ length: 256 }, (_, i) => i + core * 37));
    field(cpu, STATE_OFFSETS.reg_xmm, 128).set(Uint8Array.from({ length: 128 }, (_, i) => i * 3 + core));
    cpu.mxcsr[0] = 0x1F80 | core << 5;
    new DataView(cpu.wasm_memory.buffer, cpu.state_base + STATE_OFFSETS.fpu_control_word, 2).setUint16(0, 0x27F + core, true);
    cpu.reg32[0] = 0x12340000 + core;
}
function check_fingerprint(cpu, core, label)
{
    cpu.switch_core(core);
    assert.equal(u32(cpu, STATE_OFFSETS.xcr0), 7, `${label}: core ${core} XCR0`);
    assert.deepEqual(field(cpu, STATE_OFFSETS.ymm_hi, 256), Uint8Array.from({ length: 256 }, (_, i) => i + core * 37), `${label}: core ${core} YMM_H`);
    assert.deepEqual(field(cpu, STATE_OFFSETS.reg_xmm, 128), Uint8Array.from({ length: 128 }, (_, i) => i * 3 + core), `${label}: core ${core} XMM`);
    assert.equal(cpu.mxcsr[0], 0x1F80 | core << 5, `${label}: core ${core} MXCSR`);
    assert.equal(u32(cpu, STATE_OFFSETS.fpu_control_word) & 0xFFFF, 0x27F + core, `${label}: core ${core} FCW`);
}
function check_reset_xstate(cpu, core, label)
{
    cpu.switch_core(core);
    assert.equal(u32(cpu, STATE_OFFSETS.xcr0), 1, `${label}: core ${core} XCR0 1`);
    assert.ok(field(cpu, STATE_OFFSETS.ymm_hi, 256).every(b => b === 0), `${label}: core ${core} YMM_H 0`);
}
/** A snapshot with its state (the JSON part) edited */
function rewrite(snapshot, edit)
{
    const header = new Int32Array(snapshot, 0, 4);
    const info = JSON.parse(new TextDecoder().decode(new Uint8Array(snapshot, 16, header[3])));
    edit(info.state);
    const json = new TextEncoder().encode(JSON.stringify(info));
    const old_start = 16 + header[3] + 3 & ~3, start = 16 + json.length + 3 & ~3;
    const result = new Uint8Array(start + snapshot.byteLength - old_start);
    result.set(new Uint8Array(snapshot, 0, 16));
    result.set(json, 16);
    result.set(new Uint8Array(snapshot, old_start), start);
    const out = new Int32Array(result.buffer, 0, 4);
    out[2] = result.length;
    out[3] = json.length;
    return result.buffer;
}
const XSTATE_RANGE = CORE_STATE_RANGES.findIndex(([start]) => start === STATE_OFFSETS.xcr0);
assert.ok(XSTATE_RANGE !== -1 && CORE_STATE_RANGES[XSTATE_RANGE][1] === STATE_OFFSETS.ymm_hi + 256);

for(const count of [1, 2])
{
    const vm = await machine(count, FEATURES);
    const cpu = vm.v86.cpu;
    try
    {
        for(let core = 0; core < count; core++) check_reset_xstate(cpu, core, "after creation");
        for(let core = 0; core < count; core++) fingerprint(cpu, core);
        const saved = await vm.save_state();
        for(let core = 0; core < count; core++)
        {
            cpu.switch_core(core);
            field(cpu, STATE_OFFSETS.xcr0, 272).fill(0x55);
            cpu.mxcsr[0] = 0x1F80;
        }
        await vm.restore_state(saved);
        for(let core = 0; core < count; core++) check_fingerprint(cpu, core, "snapshot");

        // a snapshot from before the XSAVE range: XCR0 1, YMM_H 0, the rest restored
        await vm.restore_state(rewrite(saved, state => {
            state[96][7].splice(XSTATE_RANGE, 1);
            for(const core of state[96][6]) core[1].splice(XSTATE_RANGE, 1);
        }));
        for(let core = 0; core < count; core++)
        {
            check_reset_xstate(cpu, core, "snapshot without the XSAVE range");
            assert.equal(cpu.reg32[0], 0x12340000 + core, "the other state is restored");
            assert.equal(cpu.mxcsr[0], 0x1F80 | core << 5);
        }
        if(count === 1)
        {
            // ... and from before machine core state (one core)
            await vm.restore_state(saved);
            await vm.restore_state(rewrite(saved, state => { state[96] = null; }));
            check_reset_xstate(cpu, 0, "snapshot without machine core state");
        }
        else
        {
            // INIT keeps x87, SSE and XSAVE state; the rest resets
            await vm.restore_state(saved);
            cpu.apic_restore_core_events(1, 1, false);
            cpu.take_core_events(1);
            check_fingerprint(cpu, 1, "INIT");
            cpu.switch_core(1);
            assert.equal(cpu.reg32[0], 0, "INIT resets the general registers");
        }
        // RESET: XCR0 1, YMM_H 0, MXCSR 1F80
        await vm.restore_state(saved);
        cpu.reboot_internal();
        for(let core = 0; core < count; core++)
        {
            check_reset_xstate(cpu, core, "reset");
            assert.equal(cpu.mxcsr[0], 0x1F80, "reset: MXCSR");
        }

        // the CPU features: a machine without them refuses the snapshot, and
        // this one a snapshot from before features were recorded
        const plain = await machine(count);
        try
        {
            const target = plain.v86.cpu, before = target.get_machine_core_state();
            await assert.rejects(plain.restore_state(saved), /CPU features SSSE3 SSE4.1 SSE4.2 XSAVE AVX .*this one has none/);
            assert.deepEqual(target.get_machine_core_state(), before, "nothing restored");
        }
        finally { await plain.destroy(); }
        await assert.rejects(vm.restore_state(rewrite(saved, state => { delete state[106]; })), /CPU features none/);
        console.log(`${count} core${count > 1 ? "s" : ""}: XSAVE state through snapshots, ${count > 1 ? "INIT, " : ""}reset, older snapshots and the feature check`);
    }
    finally { await vm.destroy(); }
}
