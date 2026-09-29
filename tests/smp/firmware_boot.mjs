#!/usr/bin/env node

// Real SeaBIOS POST, including its INIT/SIPI rendezvous, then floppy boot.
// No multiboot, AP state injection or firmware CPU-count overrides.
// Build: nasm -f bin tests/smp/firmware_boot.asm -o build/smp/firmware_boot.bin
import assert from "node:assert/strict";
import { setImmediate as set_immediate } from "node:timers";
import fs from "node:fs";
import url from "node:url";
import { locate_acpi_tables } from "../../src/acpi_tables.js";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const local = path => url.fileURLToPath(new URL(path, import.meta.url));
const sector = fs.readFileSync(local("../../build/smp/firmware_boot.bin"));
assert.equal(sector.length, 512, "fixture is one boot sector");
assert.equal(sector.readUInt16LE(510), 0xAA55, "boot signature");
const TIME_LIMIT_MS = 30000;
const ROUND_LIMIT = 1000000;
const MARKER = 0x534D5042;

function check_madt(cpu, count)
{
    const tables = locate_acpi_tables(cpu.mem8);
    assert.ok(tables, "SeaBIOS installed an RSDP");
    assert.ok(tables.tables.every(table => table.checksum_ok), "ACPI table checksums");
    const madt = tables.tables.find(table => table.signature === "APIC");
    assert.ok(madt, "SeaBIOS installed a MADT");
    const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    const ids = [];
    const processors = [];
    const end = madt.address + madt.length;
    for(let p = madt.address + 44; p < end;)
    {
        assert.ok(p + 2 <= end, "complete MADT entry header");
        const type = cpu.mem8[p];
        const length = cpu.mem8[p + 1];
        assert.ok(length >= 2 && p + length <= end, "bounded MADT entry");
        if(type === 0)
        {
            assert.equal(length, 8, "processor local APIC entry length");
            if(view.getUint32(p + 4, true) & 1)
            {
                processors.push(cpu.mem8[p + 2]);
                ids.push(cpu.mem8[p + 3]);
            }
        }
        p += length;
    }
    const expected = Array.from({ length: count }, (_, id) => id);
    assert.deepEqual(ids.sort((a, b) => a - b), expected, "enabled MADT APIC IDs");
    assert.deepEqual(processors.sort((a, b) => a - b), expected, "enabled MADT processor IDs");
    return tables.oem_id.trim();
}

async function test(count)
{
    const disk = new Uint8Array(1440 * 1024);
    disk.set(sector);
    const emulator = new V86({
        bios: { url: local("../../bios/seabios.bin") },
        vga_bios: { url: local("../../bios/vgabios.bin") },
        fda: { buffer: disk.buffer },
        memory_size: 32 * 1024 * 1024,
        cpu_cores: count,
        acpi: true,
        disable_jit: true,
        autostart: false,
        log_level: 0,
    });
    let load_timeout;
    let cpu;
    let firmware_log = "";
    let marker = null;
    let marker_core = -1;
    let rounds = 0;
    const started = new Set();
    const startup_events = Array.from({ length: count }, () => []);
    try
    {
        await new Promise((resolve, reject) => {
            load_timeout = setTimeout(() => reject(new Error("emulator load timed out")), TIME_LIMIT_MS);
            emulator.add_listener("emulator-loaded", resolve);
        });
        clearTimeout(load_timeout);
        cpu = emulator.v86.cpu;
        cpu.clock.resume(); // this fixture explicitly drives scheduling rounds
        assert.equal(cpu.cores.length, count);
        assert.ok(cpu.cores.slice(1).every(core => !core.running), "APs initially wait for guest startup");
        // Observe event consumption without changing the returned bits or
        // invoking a core-state operation. All senders remain BIOS code.
        const take_events = cpu.apic_take_core_events;
        cpu.apic_take_core_events = core => {
            const events = take_events(core);
            if(events) startup_events[core].push(events);
            return events;
        };
        cpu.io.register_write(0x402, {}, value => {
            firmware_log = (firmware_log + String.fromCharCode(value)).slice(-16000);
        });
        const finish = value => { marker = value >>> 0; marker_core = cpu.active_core; };
        cpu.io.register_write(0xF4, {}, finish, finish, finish);
        const deadline = performance.now() + TIME_LIMIT_MS;
        while(marker === null)
        {
            assert.ok(++rounds <= ROUND_LIMIT, "SeaBIOS round limit exceeded");
            assert.ok(performance.now() < deadline, "SeaBIOS POST/floppy boot timed out");
            cpu.run_cores();
            for(let id = 1; id < count; id++)
            {
                if(cpu.cores[id].running && cpu.cores[id].steps > 0) started.add(id);
            }
            // Floppy reads can complete on the host event loop.
            if(rounds % 256 === 0) await new Promise(resolve => set_immediate(resolve));
        }
        assert.equal(marker, MARKER, "boot sector pass marker");
        assert.equal(marker_core, 0, "BSP executed the boot sector");
        assert.equal(started.size, count - 1, "every AP ran during real SeaBIOS POST");
        for(let id = 1; id < count; id++)
        {
            assert.ok(startup_events[id].some(events => events & 1), `AP ${id}: BIOS sent INIT`);
            assert.ok(startup_events[id].some(events => events & 2), `AP ${id}: BIOS sent SIPI`);
        }
        const memory = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
        assert.equal(memory.getUint16(0x500, true), count, "firmware expected CPU count was not reduced");
        assert.equal(memory.getUint32(0x504, true), 0, "boot sector sees BSP CPUID ID");
        const oem = check_madt(cpu, count);
        console.log(`${count} cores: SeaBIOS POST, ${started.size} real APs, ${oem} MADT IDs and floppy boot passed (${rounds} rounds)`);
    }
    catch(error)
    {
        console.error(JSON.stringify({ count, rounds, marker, started: [...started], startup_events, firmware_log,
            diagnostics: cpu?.get_diagnostics() }, null, 2));
        throw error;
    }
    finally
    {
        clearTimeout(load_timeout);
        await emulator.destroy();
    }
}

const failures = [];
for(const count of [2, 3, 4, 8])
{
    try { await test(count); }
    catch(error) { failures.push(error); console.error(`${count} cores: ${error.stack}`); }
}
assert.equal(failures.length, 0, `${failures.length} SeaBIOS configurations failed`);
