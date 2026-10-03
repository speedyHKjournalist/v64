#!/usr/bin/env node

// AP startup: real guest INIT/SIPI through the low-memory trampoline,
// independent AP registers/stacks, physical/shorthand IPIs and HLT wakeup.
// The host supplies only mailbox commands; it never loads an AP context or
// changes an AP's CS, IP, registers, interrupt state or runnable state.
// Build: nasm -f bin tests/smp/ap_startup.asm -o build/smp/ap_startup.bin

import assert from "node:assert/strict";
import url from "node:url";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { CORE_STATE_RANGES, STATE_OFFSETS } = await import("../../src/state_layout.js");
const KERNEL = url.fileURLToPath(new URL("../../build/smp/ap_startup.bin", import.meta.url));
const CONTROL = 0x380000;
const RECORDS = CONTROL + 0x100;
const STRIDE = 64;
const SLICE_LIMIT = 1000;
const TIME_LIMIT_MS = 15000;
const fields = ["boots", "signature", "vector", "real_cr0", "real_cs", "reserved", "stack", "errors",
    "irqs", "resumes", "ready", "cpuid_id", "protected_cr0", "reserved2", "protected_cs", "reserved3"];

async function test(count)
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        multiboot: { url: KERNEL },
        memory_size: 32 * 1024 * 1024,
        cpu_cores: count,
        acpi: true,
        autostart: false,
        disable_jit: true,
        log_level: 0,
    });
    let load_timeout;
    try
    {
        await new Promise((resolve, reject) => {
            load_timeout = setTimeout(() => reject(new Error(`${count} cores: loading timed out`)), TIME_LIMIT_MS);
            emulator.add_listener("emulator-loaded", resolve);
        });
    }
    catch(error)
    {
        await emulator.destroy();
        throw error;
    }
    finally
    {
        clearTimeout(load_timeout);
    }
    const cpu = emulator.v86.cpu;
    const memory = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    const read = address => memory.getUint32(address, true);
    const write = (address, value) => memory.setUint32(address, value, true);
    const record = id => Object.fromEntries(fields.map((name, index) => [name, read(RECORDS + id * STRIDE + index * 4)]));
    const records = () => Array.from({ length: count }, (_, id) => record(id));
    let slices = 0;
    let request = 0;
    let phase = "load";

    // Inspect saved state without switching cores or touching guest state.
    function core_field(id, offset, size = 4)
    {
        if(id === cpu.active_core)
        {
            const view = new DataView(cpu.wasm_memory.buffer);
            return size === 1 ? view.getUint8(cpu.state_base + offset) : view.getUint32(cpu.state_base + offset, true);
        }
        const index = CORE_STATE_RANGES.findIndex(([start, end]) => start <= offset && offset + size <= end);
        assert.notEqual(index, -1, `core field ${offset} is saved`);
        const bytes = cpu.cores[id].saved[index];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const local = offset - CORE_STATE_RANGES[index][0];
        return size === 1 ? view.getUint8(local) : view.getUint32(local, true);
    }

    function run_until(label, predicate)
    {
        phase = label;
        const deadline = performance.now() + TIME_LIMIT_MS;
        for(let i = 0; i < SLICE_LIMIT; i++)
        {
            cpu.run_cores();
            slices++;
            assert.equal(read(CONTROL + 24), 0, `${label}: guest error`);
            assert.ok(records().every(r => r.errors === 0), `${label}: AP register/stack corruption`);
            if(predicate()) return;
            assert.ok(performance.now() < deadline, `${label}: wall-clock timeout`);
        }
        assert.fail(`${label}: timed out after ${SLICE_LIMIT} scheduler rounds`);
    }

    function command(kind, target = 0, vector = 8)
    {
        write(CONTROL + 4, kind);
        write(CONTROL + 8, target);
        write(CONTROL + 20, vector);
        write(CONTROL + 12, ++request);
        run_until(`command ${kind}, target ${target}, vector ${vector}`, () => read(CONTROL + 16) === request);
    }

    function verify_ap(id, boots, vector)
    {
        const r = record(id);
        assert.equal(r.boots, boots, `AP ${id}: boot count`);
        assert.equal(r.signature, 0xA9000000 + id, `AP ${id}: signature`);
        assert.equal(r.vector, vector, `AP ${id}: first accepted SIPI vector`);
        assert.equal(r.real_cr0 & 1, 0, `AP ${id}: trampoline entered in real mode`);
        assert.equal(r.real_cs, vector << 8, `AP ${id}: real-mode CS`);
        assert.equal(r.protected_cr0 & 1, 1, `AP ${id}: switched to protected mode`);
        assert.equal(r.protected_cs, 8, `AP ${id}: protected-mode code selector`);
        assert.equal(r.stack, 0x300000 + (id + 1) * 0x10000, `AP ${id}: private stack`);
        assert.equal(r.cpuid_id, id, `AP ${id}: CPUID ID agrees with LAPIC ID`);
        assert.equal(r.errors, 0, `AP ${id}: guest checked its preserved registers and stack`);
        assert.equal(r.ready, 1, `AP ${id}: reached HLT`);
        assert.equal(core_field(id, STATE_OFFSETS.in_hlt, 1), 1, `AP ${id}: actually halted`);
        const reg = index => core_field(id, STATE_OFFSETS.reg32 + index * 4);
        assert.equal(reg(3), id, `AP ${id}: EBX`);
        assert.equal(reg(5), 0xC0010000 + id, `AP ${id}: EBP`);
        assert.equal(reg(6), 0x51A70000 + id, `AP ${id}: ESI`);
        assert.equal(reg(7), RECORDS + id * STRIDE, `AP ${id}: EDI`);
        assert.equal(reg(4), r.stack - 4, `AP ${id}: ESP`);
        assert.equal(read(r.stack - 4), 0xC0010000 + id, `AP ${id}: stack canary`);
    }

    function ipi(kind, targets, target = 0)
    {
        const before = records();
        const target_set = new Set(targets);
        const mask = targets.filter(id => id !== 0).reduce((bits, id) => bits | 1 << id, 0);
        write(CONTROL + 32, 0);
        command(kind, target);
        run_until(`IPI ${kind}: targets ${targets.join(",")}`, () => targets.every(id =>
            record(id).irqs === before[id].irqs + 1 &&
            (id === 0 || record(id).resumes === before[id].resumes + 1)) && read(CONTROL + 32) === mask);
        for(let id = 0; id < count; id++)
        {
            assert.equal(record(id).irqs, before[id].irqs + Number(target_set.has(id)), `IPI ${kind}: core ${id} delivery`);
            if(id !== 0) verify_ap(id, before[id].boots, before[id].vector);
        }
    }

    try
    {
        write(CONTROL, count);
        assert.equal(cpu.cores.length, count);
        assert.ok(cpu.cores.slice(1).every(core => !core.running), "APs initially wait for SIPI");
        run_until("BSP mailbox ready", () => read(CONTROL + 28) === 1);
        assert.ok(cpu.cores.slice(1).every(core => !core.running), "APs cannot execute before guest startup IPIs");
        command(1);
        run_until("all APs reached HLT", () => records().slice(1).every(r => r.boots === 1 && r.ready === 1));
        for(let id = 1; id < count; id++) verify_ap(id, 1, 8);

        // Each targeted AP must leave HLT, service the IPI, acknowledge the
        // BSP with its own vector, restore its registers and halt again.
        for(let id = 1; id < count; id++) ipi(2, [id], id);
        const all = Array.from({ length: count }, (_, id) => id);
        ipi(3, all);                 // ICR all including self
        ipi(4, all.slice(1));        // ICR all excluding self
        ipi(5, all);                 // physical destination 0xFF

        // A SIPI to an already running (even currently halted) AP is ignored.
        command(7, 1, 9);
        ipi(2, [1], 1);
        verify_ap(1, 1, 8);

        command(6, 1, 9);
        run_until("AP re-INIT and restart", () => record(1).boots === 2 && record(1).ready === 1);
        verify_ap(1, 2, 9);
        for(let id = 2; id < count; id++) verify_ap(id, 1, 8);
        ipi(2, [1], 1);
        console.log(`${count} cores: real-mode startup, independent state, directed/broadcast IPI, HLT and re-INIT passed`);

        command(8, 1, 8);
        run_until("two queued SIPIs", () => record(1).boots === 3 && record(1).ready === 1);
        verify_ap(1, 3, 8);
        ipi(2, [1], 1);
        command(8, 1, 9);
        run_until("two queued SIPIs in reverse order", () => record(1).boots === 4 && record(1).ready === 1);
        verify_ap(1, 4, 9);
        ipi(2, [1], 1);
        console.log(`${count} cores: first SIPI wins in both vector orders, ${slices} scheduler rounds`);
    }
    catch(error)
    {
        console.error(JSON.stringify({ count, phase, slices, mailbox: Array.from({ length: 9 }, (_, i) => read(CONTROL + i * 4)), records: records(), diagnostics: cpu.get_diagnostics() }, null, 2));
        throw error;
    }
    finally
    {
        await emulator.destroy();
    }
}

const failures = [];
for(const count of [2, 4, 8])
{
    try { await test(count); }
    catch(error) { failures.push(error); console.error(`${count} cores: ${error.stack}`); }
}
assert.equal(failures.length, 0, `${failures.length} AP startup configurations failed`);
