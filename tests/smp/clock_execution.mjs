#!/usr/bin/env node

// Machine clock integration tests: real interpreter/Wasm dispatch and real device ports.
import assert from "node:assert/strict";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
let passed = 0;
async function test(name, run)
{
    await run();
    passed++;
    console.log("PASS " + name);
}

async function machine(cores = 1, extra = {})
{
    const emulator = new V86({ acpi: true, cpu_cores: cores, memory_size: 16 << 20,
        autostart: false, log_level: 0, cpu_quantum: 17, cpu_schedule_seed: 0x12345678,
        cpu_clock: { mode: "deterministic", instructions_per_ms: 1000 }, ...extra });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    emulator.v86.cpu.clock.resume();
    return emulator;
}

function entry(cpu, bytes, ip = 0x1000)
{
    cpu.sreg[1] = 0;
    cpu.segment_offsets[1] = 0;
    cpu.instruction_pointer[0] = cpu.previous_ip[0] = ip;
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2;
    cpu.in_hlt[0] = 0;
    cpu.mem8.set(bytes, ip);
    cpu.full_clear_tlb();
}

function work(cpu)
{
    cpu.clock.now();
    return cpu.clock.get_diagnostics().committed_instructions;
}

function interrupt(cpu, vector, target = 0x1200)
{
    cpu.mem8.set([target & 255, target >> 8, 0, 0], vector * 4);
    cpu.mem8[target] = 0xF4; // handler: hlt
}

await test("ordinary and prefixed instructions retire once; faulting dispatch does not", async () => {
    const emulator = await machine();
    try
    {
        const cpu = emulator.v86.cpu;
        entry(cpu, [0x90, 0x66, 0x90, 0xF4]);
        const before = work(cpu);
        cpu.run_cpu_slice(100);
        assert.equal(work(cpu) - before, 3);
        assert.equal(cpu.clock.now(), 0.003);

        interrupt(cpu, 6);
        entry(cpu, [0x0F, 0x0B]); // UD2 -> #UD
        const fault_before = work(cpu);
        cpu.run_cpu_slice(1);
        assert.equal(cpu.instruction_pointer[0], 0x1200);
        assert.equal(work(cpu), fault_before, "#UD dispatch must not retire");
        cpu.run_cpu_slice(1);
        assert.equal(work(cpu) - fault_before, 1, "handler HLT retires normally");
    }
    finally { await emulator.destroy(); }
});

await test("REP counts completed elements across bounded slices, including empty REP", async () => {
    const emulator = await machine(2);
    try
    {
        const cpu = emulator.v86.cpu;
        entry(cpu, [0xF3, 0xAA, 0xF4]);
        cpu.reg32[0] = 0x5A;
        cpu.reg32[1] = 1000;
        cpu.reg32[7] = 0x4000;
        const before = work(cpu);
        cpu.run_cpu_slice(1000);
        assert.equal(cpu.reg32[1], 744);
        assert.equal(work(cpu) - before, 256);
        assert.equal(cpu.instruction_pointer[0], 0x1000);
        cpu.run_cpu_slice(1000);
        cpu.run_cpu_slice(1000);
        cpu.run_cpu_slice(1000);
        assert.equal(cpu.reg32[1], 0);
        assert.equal(work(cpu) - before, 1001); // elements plus final HLT
        assert.ok(cpu.mem8.slice(0x4000, 0x4000 + 1000).every(x => x === 0x5A));

        entry(cpu, [0xF3, 0xAA, 0xF4]);
        cpu.reg32[1] = 0;
        const empty_before = work(cpu);
        cpu.run_cpu_slice(100);
        assert.equal(work(cpu) - empty_before, 2);
    }
    finally { await emulator.destroy(); }
});

await test("STI shadow permits its successor before pending IPI, without duplicate retirement", async () => {
    const emulator = await machine();
    try
    {
        const cpu = emulator.v86.cpu;
        interrupt(cpu, 0x50);
        entry(cpu, [0xFB, 0x40, 0xF4]); // sti; inc ax; hlt
        cpu.reg32[0] = 0;
        cpu.write32(0xFEE000F0, 0x1FF);
        cpu.write32(0xFEE00300, 0x40050); // fixed self IPI, initially IF=0
        const before = work(cpu);
        cpu.run_cpu_slice(1);
        assert.equal(work(cpu) - before, 1);
        assert.equal(cpu.instruction_pointer[0], 0x1001);
        assert.equal(cpu.reg32[0], 0);
        cpu.run_cpu_slice(1);
        assert.equal(cpu.reg32[0], 1);
        assert.equal(cpu.instruction_pointer[0], 0x1200);
        assert.equal(work(cpu) - before, 2, "IPI delivery is not an instruction");
        cpu.run_cpu_slice(1);
        assert.equal(work(cpu) - before, 3);
    }
    finally { await emulator.destroy(); }
});

await test("REP preserves completed elements before a same-dispatch page fault", async () => {
    const emulator = await machine();
    try
    {
        const cpu = emulator.v86.cpu;
        entry(cpu, [0x67, 0xF3, 0xAA, 0xF4]); // address16 REP STOSB uses the element path
        const memory = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
        const set32 = (address, value) => memory.setUint32(address, value >>> 0, true);
        set32(0x3008, 0xFFFF);
        set32(0x300C, 0xCF9B00); // flat ring-0 32-bit code
        set32(0x3010, 0xFFFF);
        set32(0x3014, 0xCF9300); // flat ring-0 32-bit data
        cpu.gdtr_offset[0] = 0x3000;
        cpu.gdtr_size[0] = 23;
        cpu.idtr_offset[0] = 0x2000;
        cpu.idtr_size[0] = 0x7FF;
        set32(0x2000 + 14 * 8, 0x81200);
        set32(0x2004 + 14 * 8, 0x8E00); // #PF -> 08:1200
        cpu.mem8[0x1200] = 0xF4;
        set32(0x10000, 0x11003);
        for(let page = 0; page < 256; page++) set32(0x11000 + page * 4, page << 12 | 3);
        set32(0x11000 + 5 * 4, 0); // 0x5000 absent, five elements beyond 0x4FFB
        cpu.cr[0] = 0x80010011 | 0;
        cpu.cr[3] = 0x10000;
        cpu.protected_mode[0] = cpu.is_32[0] = cpu.stack_size_32[0] = 1;
        cpu.segment_offsets.fill(0, 0, 6);
        cpu.segment_limits.fill(-1, 0, 6);
        cpu.segment_is_null.fill(0, 0, 6);
        cpu.sreg.set([16, 8, 16, 16, 16, 16]);
        cpu.segment_access_bytes.set([0x93, 0x9B, 0x93, 0x93, 0x93, 0x93]);
        cpu.reg32[0] = 0x5A;
        cpu.reg32[1] = 10;
        cpu.reg32[7] = 0x4FFB;
        cpu.update_state_flags();
        cpu.full_clear_tlb();
        const before = work(cpu);
        cpu.run_cpu_slice(1);
        assert.equal(cpu.cr[2], 0x5000);
        assert.equal(cpu.instruction_pointer[0], 0x1200);
        assert.equal(cpu.reg32[1], 5);
        assert.equal(cpu.reg32[7], 0x5000);
        assert.equal(work(cpu) - before, 5);
        assert.deepEqual(Array.from(cpu.mem8.slice(0x4FFB, 0x5001)), [0x5A, 0x5A, 0x5A, 0x5A, 0x5A, 0]);
    }
    finally { await emulator.destroy(); }
});

await test("PIO PM polling observes prior commits inside a single Wasm slice", async () => {
    const emulator = await machine();
    try
    {
        const cpu = emulator.v86.cpu;
        const acpi = cpu.devices.acpi;
        acpi.pci_config[0x40 >> 2] = 0x601;
        acpi.pci_config[0x80 >> 2] |= 1;
        acpi.update_pm_decode();
        entry(cpu, [0xBA, 0x08, 0x06, 0xBF, 0x00, 0x40, 0xB9, 8, 0,
            0x66, 0xED, 0x66, 0xAB, 0xE2, 0xFA, 0xF4]);
        const before = work(cpu);
        cpu.run_cpu_slice(1000);
        assert.equal(work(cpu) - before, 28);
        const samples = Array.from(new Uint32Array(cpu.mem8.buffer, cpu.mem8.byteOffset + 0x4000, 8));
        assert.ok(samples[0] > 0);
        for(let i = 1; i < samples.length; i++) assert.ok(samples[i] > samples[i - 1]);
        assert.equal(acpi.pm_read(8, 4), acpi.pm_read(8, 4), "host reads do not create guest work");
    }
    finally { await emulator.destroy(); }
});

await test("paused snapshot restores virtual time, pending progress and RTC calendar", async () => {
    const emulator = await machine();
    try
    {
        const cpu = emulator.v86.cpu;
        entry(cpu, [0x90, 0x90, 0xF4]);
        cpu.run_cpu_slice(100);
        cpu.clock.pause();
        const saved_time = cpu.clock.now();
        const saved_wall = cpu.clock.wall_time();
        const saved_work = work(cpu);
        const saved = await emulator.save_state();
        cpu.clock.resume();
        entry(cpu, [0x90, 0xF4]);
        cpu.run_cpu_slice(100);
        assert.ok(cpu.clock.now() > saved_time);
        cpu.clock.pause();
        await emulator.restore_state(saved);
        assert.equal(cpu.clock.now(), saved_time);
        assert.equal(cpu.clock.wall_time(), saved_wall);
        assert.equal(work(cpu), saved_work);
        assert.equal(cpu.clock.paused, true);
        cpu.clock.advance_to(1000);
        assert.equal(cpu.clock.now(), saved_time);
        cpu.clock.resume();
        entry(cpu, [0x90, 0xF4]);
        cpu.run_cpu_slice(100);
        assert.equal(work(cpu), saved_work + 2);
    }
    finally { await emulator.destroy(); }
});

await test("repeated per-core TSC writes use machine ticks, including nonzero initial offsets", async () => {
    const emulator = await machine(2);
    try
    {
        const cpu = emulator.v86.cpu;
        cpu.clock.advance_instructions(1000);
        for(let core = 0; core < 2; core++)
        {
            cpu.switch_core(core);
            cpu.set_tsc(100 + core, 0);
            cpu.store_current_tsc();
            assert.equal(cpu.current_tsc[0], 100 + core);
            cpu.set_tsc(200 + core, 0);
            cpu.store_current_tsc();
            assert.equal(cpu.current_tsc[0], 200 + core);
        }
        cpu.clock.advance_instructions(1000);
        cpu.switch_core(0);
        cpu.set_tsc(400, 0);
        cpu.store_current_tsc();
        assert.equal(cpu.current_tsc[0], 400);
    }
    finally { await emulator.destroy(); }

    let host = 0;
    const normal = await machine(1, { cpu_clock: { mode: "normal", now: () => host } });
    try
    {
        const cpu = normal.v86.cpu;
        host = 100;
        cpu.reboot_internal(); // reset stores a nonzero machine-time offset
        cpu.set_tsc(321, 0);
        cpu.store_current_tsc();
        assert.equal(cpu.current_tsc[0], 321);
    }
    finally { await normal.destroy(); }
});

await test("guest CF9 reset yields the active instruction before resetting commit state", async () => {
    const emulator = await machine(2);
    try
    {
        const cpu = emulator.v86.cpu;
        entry(cpu, [0xBA, 0xF9, 0x0C, 0xB0, 6, 0xEE, 0x40, 0xF4]);
        const before = work(cpu);
        cpu.run_cpu_slice(100);
        assert.equal(cpu.active_core, 0);
        assert.equal(cpu.instruction_pointer[0], 0xFFFF0, "reset occurs at the safe return boundary");
        assert.equal(work(cpu) - before, 3, "the resetting OUT retires once, successor does not execute");
        assert.deepEqual(cpu.cores.map(core => core.running), [true, false]);
        assert.equal(cpu.clock.paused, false);
    }
    finally { await emulator.destroy(); }
});

await test("guest programs PIT then halts without jumping to an obsolete 100ms deadline", async () => {
    const emulator = await machine();
    try
    {
        const cpu = emulator.v86.cpu;
        entry(cpu, [0xB0, 0x34, 0xE6, 0x43, // counter0 periodic, low/high
            0xB0, 17, 0xE6, 0x40, 0xB0, 0, 0xE6, 0x40, 0xF4]);
        cpu.run_cores();
        assert.equal(cpu.in_hlt[0], 1);
        assert.equal(work(cpu), 7);
        assert.equal(cpu.clock.now(), 0.007, "executing then halting does not use the earlier deadline");
        cpu.run_cores();
        assert.ok(cpu.clock.now() > 0.007 && cpu.clock.now() < 0.1, "idle round uses the newly programmed PIT");
    }
    finally { await emulator.destroy(); }
});

await test("normal-mode save and restore freeze one timestamp across all devices", async () => {
    let host = 0;
    const epoch = 946684800000;
    const emulator = await machine(1, { cpu_clock: { mode: "normal", now: () => host, wall_epoch_ms: epoch } });
    try
    {
        const cpu = emulator.v86.cpu;
        // Advancing this source on each sample exposes any unfrozen time reads
        // during serialization. It models host time spent collecting devices.
        cpu.clock.host_now = () => ++host;
        const saved = await emulator.save_state();
        const header = new Int32Array(saved, 0, 4);
        const state = JSON.parse(new TextDecoder().decode(new Uint8Array(saved, 16, header[3]))).state;
        const saved_time = state[95][2];
        assert.equal(state[47][2], epoch + saved_time, "RTC matches the saved machine timestamp");
        assert.equal(state[50][5], Math.floor(saved_time * 3579.545), "PM matches that same timestamp");
        assert.equal(cpu.clock.paused, false, "saving keeps the prior run/pause lifecycle");
        await emulator.restore_state(saved);
        assert.equal(cpu.clock.time_ms, saved_time, "restore excludes its host-side processing time");
        assert.equal(cpu.devices.rtc.rtc_time, epoch + saved_time);
        assert.equal(cpu.devices.acpi.timer_last, state[50][5]);
        assert.equal(cpu.clock.paused, false);
    }
    finally { await emulator.destroy(); }
});

await test("legacy UTC RTC and host-monotonic timer snapshots rebase without host-age delay", async () => {
    const emulator = await machine();
    try
    {
        const cpu = emulator.v86.cpu;
        cpu.clock.advance_instructions(25000);
        cpu.devices.rtc.cmos_index = 0xB;
        cpu.devices.rtc.cmos_port_write(0x42);
        cpu.devices.pit.port43_write(0x34);
        cpu.devices.pit.counter_write(0, 0xA9);
        cpu.devices.pit.counter_write(0, 4);
        cpu.clock.pause();
        const rtc_time = cpu.devices.rtc.rtc_time;
        const interval = cpu.devices.rtc.next_interrupt - cpu.clock.now();
        const saved = await emulator.save_state();
        cpu.clock.resume();
        cpu.clock.advance_instructions(5000000);
        cpu.clock.pause();
        const destination_time = cpu.clock.now();
        const set_state = cpu.set_state.bind(cpu);
        cpu.set_state = state => {
            // Emulate the positional format from before the machine clock, not merely a modern state
            // with optional slots removed: RTC deadlines were host UTC and
            // PIT/LAPIC anchors were unrelated host performance.now values.
            const epoch = state[47][2] - state[47][3];
            state[47][3] += epoch;
            state[47][4] += epoch;
            state[47].length = 15;
            state[58][7].fill(1000000000);
            const lapic = new DataView(state[46].buffer, state[46].byteOffset);
            lapic.setUint32(8, 0, true); // divider shift
            lapic.setUint32(12, 1000000, true);
            lapic.setUint32(16, 1000000, true);
            lapic.setFloat64(24, 1000000000, true);
            lapic.setUint32(32, 0x50, true);
            lapic.setUint32(160, 0x1FF, true);
            state.length = 95;
            set_state(state);
        };
        await emulator.restore_state(saved);
        assert.equal(cpu.clock.now(), destination_time);
        assert.equal(cpu.clock.wall_time(), rtc_time);
        assert.equal(cpu.devices.rtc.rtc_time, rtc_time);
        assert.equal(cpu.devices.rtc.next_interrupt - cpu.clock.now(), interval);
        assert.ok(cpu.devices.pit.counter_start_time.every(time => time === destination_time));
        assert.equal(cpu.read32s(0xFEE00390), 1000000, "restored LAPIC count is immediately meaningful");
        cpu.clock.resume();
        cpu.clock.advance_to(destination_time + 1);
        cpu.run_hardware_timers(true, cpu.clock.now());
        assert.equal(cpu.read32s(0xFEE00390), 0, "old host age does not postpone the restored timer");
    }
    finally { await emulator.destroy(); }
});

await test("fixed image, inputs and seed repeat IRQ sequence, PM samples and serial output", async () => {
    const run = async () => {
        const emulator = await machine(2);
        try
        {
            const cpu = emulator.v86.cpu;
            const irqs = [];
            let serial = "";
            emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
            const raise = cpu.device_raise_irq;
            cpu.device_raise_irq = irq => { irqs.push([cpu.clock.now(), irq]); raise(irq); };
            const acpi = cpu.devices.acpi;
            acpi.pci_config[0x40 >> 2] = 0x601;
            acpi.pci_config[0x80 >> 2] |= 1;
            acpi.update_pm_decode();
            cpu.devices.pit.port43_write(0x34);
            cpu.devices.pit.counter_write(0, 17);
            cpu.devices.pit.counter_write(0, 0);
            entry(cpu, [0xBA, 0x08, 0x06, 0xBF, 0x00, 0x40, 0xB9, 64, 0,
                0x66, 0xED, 0x66, 0xAB, 0xE2, 0xFA,
                0xBA, 0xF8, 0x03, 0xB0, 0x4B, 0xEE, 0xB0, 0x0A, 0xEE, 0xF4]);
            for(let round = 0; round < 20; round++) cpu.run_cores();
            const samples = Array.from(new Uint32Array(cpu.mem8.buffer, cpu.mem8.byteOffset + 0x4000, 64));
            assert.ok(irqs.some(e => e[1] === 0));
            assert.equal(serial, "K\n");
            assert.equal(cpu.in_hlt[0], 1);
            return { irqs, samples, serial, work: work(cpu), time: cpu.clock.now() };
        }
        finally { await emulator.destroy(); }
    };
    assert.deepEqual(await run(), await run());
});

console.log(JSON.stringify({ suite: "machine-clock-execution", passed }));
