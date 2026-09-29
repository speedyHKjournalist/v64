#!/usr/bin/env node

// Cooperative scheduling boundaries and the single-core snapshot compatibility path.
// Architectural AP startup is covered separately by ap_startup.asm.
import assert from "node:assert/strict";
import { STATE_OFFSETS } from "../../src/state_layout.js";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

async function machine(cores)
{
    const emulator = new V86({ acpi: true, cpu_cores: cores, memory_size: 16 << 20,
        disable_jit: true, autostart: false, log_level: 0 });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    return emulator;
}

function entry(cpu, ip)
{
    cpu.sreg[1] = 0;
    cpu.segment_offsets[1] = 0;
    cpu.instruction_pointer[0] = ip;
    cpu.previous_ip[0] = ip;
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2;
    cpu.in_hlt[0] = 0;
    cpu.full_clear_tlb();
}

const emulator = await machine(2);
try
{
    const cpu = emulator.v86.cpu;
    entry(cpu, 0x1000);
    cpu.mem8.set([0xEB, 0xFE], 0x1000); // busy loop without PAUSE
    assert.equal(cpu.run_cpu_slice(17), 17, "a same-page busy loop obeys the exact dispatch budget");
    assert.equal(cpu.instruction_pointer[0], 0x1000);
    assert.equal(cpu.run_cpu_slice(0), 0);

    // STI's interrupt shadow may consume one extra instruction at the slice
    // boundary, but a chain of STI (IF already set) must not recurse forever.
    entry(cpu, 0x1000);
    cpu.mem8.fill(0xFB, 0x1000, 0x1064);
    cpu.mem8[0x1064] = 0xF4;
    assert.equal(cpu.run_cpu_slice(1), 2);
    assert.equal(cpu.instruction_pointer[0], 0x1002);
    assert.equal(cpu.in_hlt[0], 0);
    assert.equal(cpu.run_cpu_slice(1), 1);
    entry(cpu, 0x1000);
    cpu.mem8.set(Array.from({ length: 300 }, (_, i) => [0xFA, 0xFB, 0x90][i % 3]), 0x1000);
    assert.equal(cpu.run_cpu_slice(17), 18, "STI shadow steps count toward the dispatch budget");
    assert.equal(cpu.instruction_pointer[0], 0x1012);

    // A long REP yields with architectural progress retained, even though the
    // entire transfer fits in RAM and does not access a device.
    entry(cpu, 0x1000);
    cpu.mem8.set([0xF3, 0xAA, 0xF4], 0x1000); // rep stosb; hlt
    cpu.reg32[0] = 0x5A;
    cpu.reg32[1] = 1000;
    cpu.reg32[7] = 0x4000;
    assert.equal(cpu.run_cpu_slice(4096), 1);
    assert.equal(cpu.reg32[1], 744);
    assert.equal(cpu.instruction_pointer[0], 0x1000);
    assert.ok(cpu.mem8.slice(0x4000, 0x4100).every(x => x === 0x5A));
    assert.equal(cpu.mem8[0x4100], 0);

    entry(cpu, 0x1000);
    cpu.mem8.set([0xF4, 0xEB, 0xFD], 0x1000); // BSP: CLI+HLT
    cpu.run_cpu_slice(10);
    cpu.switch_core(1);
    cpu.cores[1].running = true;
    entry(cpu, 0x1100);
    cpu.flags[0] = 0x202;
    cpu.mem8.set([0xF4, 0xEB, 0xFD], 0x1100); // AP: STI+HLT
    cpu.mem8.set([0xFF, 0x06, 0x00, 0x50, 0xCF], 0x1200); // inc word [0x5000]; iret
    cpu.mem8.set([0x00, 0x12, 0x00, 0x00], 0x50 * 4); // real-mode timer vector
    cpu.run_cpu_slice(10);
    cpu.switch_core(0);
    const lapic = new Uint32Array(cpu.wasm_memory.buffer, cpu.apic_addr(1), 46);
    lapic[40] = 0x1FF; // software enable
    lapic[8] = 0x50; // unmasked one-shot timer
    lapic[3] = lapic[4] = 1;
    new Float64Array(cpu.wasm_memory.buffer, cpu.apic_addr(1) + 24, 1)[0] = 0;

    let timer_calls = 0;
    const timers = cpu.run_hardware_timers.bind(cpu);
    cpu.run_hardware_timers = (...args) => { timer_calls++; return timers(...args); };
    cpu.run_cores();
    assert.equal(timer_calls, 1, "one machine timer service per round, even with a CLI+HLT BSP");
    assert.equal(cpu.mem8[0x5000], 1, "a halted AP wakes for its LAPIC timer");
    assert.equal(cpu.in_hlt[0], 1, "the AP returned from its interrupt and halted again");
    cpu.run_cores();
    assert.equal(timer_calls, 2);
    assert.equal(cpu.mem8[0x5000], 1, "one-shot timer must not fire twice");

    cpu.flags[0] = 2;
    cpu.write32(0xFEE00300, 0x40060); // a maskable self IPI while IF=0
    assert.ok(cpu.run_cores() > 0, "a halted IF=0 core with a masked IPI must not busy-spin the host");

    const memory = cpu.mem8.slice(0, 0x6000);
    await assert.rejects(emulator.restore_state(new ArrayBuffer(0)), /Invalid snapshot length/);
    assert.deepEqual(cpu.mem8.slice(0, 0x6000), memory, "rejected restore leaves RAM untouched");
    const saved = await emulator.save_state();
    await emulator.restore_state(saved);
    assert.deepEqual(cpu.mem8.slice(0, 0x6000), memory);
}
finally
{
    await emulator.destroy();
}

const single = await machine(1);
try
{
    const cpu = single.v86.cpu;
    const bytes = new Uint8Array(cpu.wasm_memory.buffer);
    cpu.apic_enabled[0] = 0;
    bytes[cpu.state_base + STATE_OFFSETS.nmi_blocked] = 1;
    cpu.apic_restore_core_events(0, 1, true);
    const saved = await single.save_state();
    cpu.apic_enabled[0] = 1;
    bytes[cpu.state_base + STATE_OFFSETS.nmi_blocked] = 0;
    cpu.apic_restore_core_events(0, 0, false);
    await single.restore_state(saved);
    assert.equal(cpu.apic_enabled[0], 0);
    assert.equal(bytes[cpu.state_base + STATE_OFFSETS.nmi_blocked], 1);
    assert.equal(cpu.apic_core_nmi_pending(0), 1);
    assert.equal(cpu.apic_peek_core_events(0), 1);

    // The existing version-6 format accepts old positional arrays. Absent
    // new fields must reset the state, not retain NMI state from this machine.
    const set_state = cpu.set_state.bind(cpu);
    cpu.set_state = state => { state.length = 94; set_state(state); };
    await single.restore_state(saved);
    assert.equal(cpu.apic_enabled[0], 1);
    assert.equal(bytes[cpu.state_base + STATE_OFFSETS.nmi_blocked], 0);
    assert.equal(cpu.apic_core_nmi_pending(0), 0);
    assert.equal(cpu.apic_peek_core_events(0), 0);
}
finally
{
    await single.destroy();
}
console.log("SMP scheduler: exact busy-loop budget, bounded REP, halted-AP timer, snapshot restore and NMI state passed");
