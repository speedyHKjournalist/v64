#!/usr/bin/env node

// The TCO watchdog of the Q35 machine's ICH9 (PMBASE + 0x60), with a
// machine clock the test moves (docs/q35-ahci-sata-plan.md, P6): stopped
// until software reloads it, 0.6 s ticks from TCO_TMR, TIMEOUT on the first
// timeout and SMI_STS.TCO_STS, SECOND_TO_STS and BOOT_STS on the second, a
// reset only with NO_REBOOT (RCBA GCS) cleared, reloads keeping it from
// firing, TCO_TMR_HLT, TCO_LOCK and snapshots.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

let host = 1000;
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    machine_type: "q35",
    memory_size: 32 * 1024 * 1024,
    cpu_clock: { mode: "normal", now: () => host },
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
cpu.clock.resume();

let failed = 0, passed = 0;
function test(name, f)
{
    try
    {
        f();
        passed++;
        console.log("ok - " + name);
    }
    catch(e)
    {
        failed++;
        console.log("FAIL - " + name);
        console.log(e);
    }
}

// the PM block at 0x600 and the root complex registers, as SeaBIOS sets them up
const LPC = 0x1F << 3;
pci.config_write(LPC, 0x40, 4, 0x601);
pci.config_write(LPC, 0x44, 1, 0x80);
pci.config_write(LPC, 0xF0, 4, 0xFED1C001);
const TCO = 0x660, RLD = 0, STS1 = 4, STS2 = 6, CNT1 = 8, TMR = 0x12;
const inw = offset => cpu.io.port_read16(TCO + offset);
const outw = (offset, value) => cpu.io.port_write16(TCO + offset, value);
const SMI_STS = 0x634;
const GCS = 0xFED1C000 + 0x3410;
const TIMEOUT = 1 << 3, SECOND_TO = 1 << 1, BOOT = 1 << 2, HLT = 1 << 11, LOCK = 1 << 12;

const resets = [];
cpu.reboot_internal = reason => { resets.push(reason); };
function advance(ms)
{
    for(; ms > 0; ms -= 100)
    {
        host += Math.min(ms, 100);
        cpu.devices.acpi.timer(cpu.clock.now());
    }
}

test("registers: defaults, stopped until reloaded", () => {
    assert.equal(inw(TMR), 4, "TCO_TMR: 4 ticks (2.4 s)");
    assert.equal(inw(CNT1), 0);
    advance(10000);
    assert.equal(inw(STS1), 0, "not running");
    assert.equal(cpu.read32s(GCS) & 0x20, 0x20, "NO_REBOOT set at reset");
});

test("first timeout: TIMEOUT, an SMI with SMI_EN.TCO_EN; second: SECOND_TO_STS, BOOT_STS; no reset with NO_REBOOT", () => {
    cpu.io.port_write32(0x630, 1 << 13);   // SMI_EN.TCO_EN
    outw(TMR, 4);
    outw(RLD, 1);
    advance(1300);
    assert.equal(inw(RLD), 1, "about 1 tick left after 1.3 s");
    advance(1200);
    assert.equal(inw(STS1) & TIMEOUT, TIMEOUT, "first timeout at 2.4 s");
    assert.equal(cpu.io.port_read16(SMI_STS) & 0x2000, 0x2000, "SMI_STS.TCO_STS");
    assert.ok(cpu.smm_active(), "the SMI: the CPU is in SMM");
    assert.equal(inw(STS2) & (SECOND_TO | BOOT), 0);
    advance(2400);
    assert.equal(inw(STS2) & (SECOND_TO | BOOT), SECOND_TO | BOOT, "second timeout");
    assert.deepEqual(resets, [], "NO_REBOOT: no reset");
    advance(5000);
    assert.equal(inw(RLD), 0, "BOOT_STS keeps it stopped");
    outw(STS1, TIMEOUT);
    outw(STS2, SECOND_TO | BOOT);
    assert.equal(inw(STS1) & TIMEOUT, 0, "write one to clear");
    assert.equal(inw(STS2), 0);
    cpu.io.port_write16(SMI_STS, 0x2000);
    cpu.io.port_write32(0x630, 0);
});

test("reloads (iTCO_wdt's pings) keep it from timing out", () => {
    outw(RLD, 1);
    for(let i = 0; i < 10; i++)
    {
        advance(2000);
        outw(RLD, 1);
    }
    assert.equal(inw(STS1) & TIMEOUT, 0);
});

test("with NO_REBOOT cleared, the second timeout resets the machine", () => {
    cpu.write32(GCS, cpu.read32s(GCS) & ~0x20);
    assert.equal(cpu.read32s(GCS) & 0x20, 0);
    outw(RLD, 1);
    advance(2500);
    assert.deepEqual(resets, [], "first timeout");
    outw(STS1, TIMEOUT);
    advance(2500);
    assert.deepEqual(resets, ["tco"], "second timeout: reset");
});

test("TCO_TMR_HLT stops it; TCO_LOCK stays set", () => {
    cpu.devices.acpi.tco.reset();
    outw(CNT1, HLT);
    outw(RLD, 1);
    advance(5000);
    assert.equal(inw(STS1) & TIMEOUT, 0, "halted");
    outw(CNT1, 0);
    advance(2500);
    assert.equal(inw(STS1) & TIMEOUT, TIMEOUT, "running once HLT is cleared");
    outw(CNT1, LOCK | HLT);
    outw(CNT1, HLT);
    assert.equal(inw(CNT1) & LOCK, LOCK, "TCO_LOCK cannot be cleared");
});

cpu.devices.acpi.tco.reset();
outw(TMR, 10);
outw(RLD, 1);
advance(3000);
const state = await emulator.save_state();
outw(CNT1, HLT);
await emulator.restore_state(state);
cpu.clock.resume();
test("snapshot: the running timer goes on from where it was", () => {
    assert.equal(inw(RLD), 5, "5 of 10 ticks left");
    advance(3100);
    assert.equal(inw(STS1) & TIMEOUT, TIMEOUT);
});

emulator.destroy();
console.log((failed ? "FAIL" : "PASS") + ": " + passed + " TCO tests passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
