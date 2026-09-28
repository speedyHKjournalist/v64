#!/usr/bin/env node
// C3 machine snapshots must preserve every core, including stopped APs and
// cached translations. Topology mismatches are rejected before any mutation.
import assert from "node:assert/strict";
import { STATE_OFFSETS } from "../../src/state_layout.js";
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
async function machine(count)
{
    const vm = new V86({ acpi: true, cpu_cores: count, memory_size: 16 << 20,
        disable_jit: true, autostart: false, log_level: 0,
        cpu_clock: { mode: "deterministic", instructions_per_ms: 100 }, cpu_schedule_seed: 42 });
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    return vm;
}
for(const count of [1, 2, 3, 4, 8])
{
    const vm = await machine(count);
    const cpu = vm.v86.cpu;
    try
    {
        cpu.clock.resume();
        cpu.clock.advance_instructions(250);
        const bytes = new Uint8Array(cpu.wasm_memory.buffer);
        for(let core = 0; core < count; core++)
        {
            cpu.switch_core(core);
            cpu.reg32[0] = 0x12340000 + core;
            cpu.cr[2] = 0xABCD000 + core;
            cpu.cores[core].running = core % 2 === 0;
            cpu.in_hlt[0] = core % 3 === 0 ? 1 : 0;
            bytes[cpu.state_base + STATE_OFFSETS.nmi_blocked] = core % 2;
            bytes[cpu.state_base + STATE_OFFSETS.interrupt_shadow] = core % 2;
            cpu.set_tsc(5555 + core, 0);
            cpu.set_tsc(1000 + core, 0);
            cpu.apic_restore_core_events(core, core % 2 ? 1 : 0, core % 3 === 0);
            cpu.wm.exports["apic_restore_extint"](core, core % 2 !== 0);
            cpu.cores[core].steps = 100 + core;
            cpu.cores[core].slices = 10 + core;
        }
        cpu.clock.pause();
        const before = cpu.get_machine_core_state();
        const clock = cpu.clock.get_state();
        const saved = await vm.save_state();
        for(let core = 0; core < count; core++)
        {
            cpu.switch_core(core);
            cpu.reg32.fill(0);
            cpu.apic_init_core(core);
            cpu.apic_restore_core_events(core, 0, false);
        }
        cpu.mem8.fill(0xFF, 0x1000, 0x2000);
        await vm.restore_state(saved);
        assert.deepEqual(cpu.get_machine_core_state(), before, "all per-core state round trips");
        assert.deepEqual(cpu.clock.get_state(), clock, "clock epoch and progress round trip while stopped");
        assert.equal(cpu.clock.paused, true);
        for(let core = 0; core < count; core++)
        {
            cpu.switch_core(core);
            cpu.store_current_tsc();
            assert.equal(cpu.current_tsc[0], 1000 + core, "per-core TSC offset survives switches and restore");
        }
        const other = await machine(count === 1 ? 2 : 1);
        try
        {
            const target = other.v86.cpu;
            const state = target.get_machine_core_state();
            const memory = target.mem8.slice();
            const time = target.clock.get_state();
            await assert.rejects(other.restore_state(saved), /topology mismatch/);
            assert.deepEqual(target.get_machine_core_state(), state);
            assert.equal(Buffer.compare(target.mem8.slice(), memory), 0);
            assert.deepEqual(target.clock.get_state(), time);
        }
        finally { await other.destroy(); }
        cpu.write32(0xFEC00000, 0x10);
        cpu.write32(0xFEC00010, 0x30); // previous Linux's unmasked timer route
        if(count > 1)
        {
            cpu.apic_restore_core_events(1, 1, false);
            cpu.take_core_events(1);
            assert.equal(cpu.read32s(0xFEC00010), 0x30, "AP INIT preserves machine routing");
        }
        cpu.reboot_internal();
        assert.equal(cpu.active_core, 0);
        cpu.write32(0xFEC00000, 0x10);
        assert.equal(cpu.read32s(0xFEC00010), 1 << 16, "board reset masks stale timer routing before firmware reprograms it");
        assert.equal(cpu.get_state_pic()[2], 0, "board reset clears PIC ISR");
        assert.deepEqual(cpu.cores.map(core => core.running), Array.from({ length: count }, (_, i) => i === 0));
        for(let core = 0; core < count; core++)
        {
            assert.equal(cpu.apic_peek_core_events(core), 0);
            assert.equal(cpu.apic_core_nmi_pending(core), 0);
        }
        console.log(`${count} cores: whole-machine state, NMI/ExtINT, TSC offsets, topology rejection and reset passed`);
    }
    finally { await vm.destroy(); }
}

// A snapshot in the middle of REP preserves partial writes, remaining count,
// continuation EIP, scheduling seed and the machine's committed-work clock.
const rep_vm = await machine(2);
try
{
    const cpu = rep_vm.v86.cpu;
    cpu.clock.resume();
    for(let core = 0; core < 2; core++)
    {
        cpu.switch_core(core);
        cpu.cores[core].running = true;
        cpu.sreg[1] = cpu.segment_offsets[1] = 0;
        cpu.instruction_pointer[0] = cpu.previous_ip[0] = 0x1000;
        cpu.mem8.set([0xF3, 0xAA, 0xF4], 0x1000);
        cpu.flags[0] = 2;
        cpu.in_hlt[0] = 0;
        cpu.reg32[0] = 0xA0 + core;
        cpu.reg32[1] = 1000;
        cpu.reg32[7] = 0x4000 + core * 0x1000;
    }
    cpu.run_cores();
    for(let core = 0; core < 2; core++)
    {
        cpu.switch_core(core);
        assert.equal(cpu.reg32[1], 744);
    }
    const saved = await rep_vm.save_state();
    const finish = () => {
        for(let i = 0; i < 10 && cpu.cores.some((_, id) => cpu.core_runnable(id)); i++) cpu.run_cores();
        assert.ok(cpu.cores.every((_, id) => !cpu.core_runnable(id)));
        return { memory: cpu.mem8.slice(0x4000, 0x6000), clock: cpu.clock.get_state(),
            cores: cpu.get_machine_core_state().map((part, index) => index !== 6 ? part :
                part.map(core => core.map((field, slot) => slot === 10 ? field.slice(0, 32) : field))) };
    };
    const first = finish();
    await rep_vm.restore_state(saved);
    const second = finish();
    assert.deepEqual(second, first);
    console.log("SMP lifecycle: pending REP/HLT replay preserves RAM, every core, scheduler seed and committed clock exactly");
}
finally { await rep_vm.destroy(); }

// Public save invoked by a synchronous device listener must wait until the
// current OUT and the machine round finish, never copy a live Wasm frame.
const reentrant_vm = await machine(2);
try
{
    const cpu = reentrant_vm.v86.cpu;
    cpu.clock.resume();
    cpu.sreg[1] = cpu.segment_offsets[1] = 0;
    cpu.instruction_pointer[0] = cpu.previous_ip[0] = 0x1000;
    cpu.mem8.set([0xE6, 0x80, 0xF4], 0x1000); // out 80h, al; hlt
    cpu.flags[0] = 2;
    let pending;
    let captured = false;
    const get_state = cpu.get_state.bind(cpu);
    cpu.get_state = () => {
        assert.equal(cpu.in_cpu, false, "snapshot is outside the active Wasm frame");
        captured = true;
        return get_state();
    };
    cpu.io.register_write(0x80, {}, () => {
        pending = reentrant_vm.save_state();
        assert.equal(captured, false, "save is deferred inside the device callback");
    });
    cpu.run_cores();
    await pending;
    assert.equal(captured, true);
    assert.equal(cpu.instruction_pointer[0], 0x1003);
    console.log("SMP lifecycle: snapshot requested inside a device callback waits for a machine safe point");
}
finally { await reentrant_vm.destroy(); }
