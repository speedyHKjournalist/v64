#!/usr/bin/env node

// The HPET of the Q35 machine (hpet: true), driven through its registers
// with a machine clock the test moves (docs/q35.md): the
// capabilities, the main counter, one-shot and periodic timers in 32- and
// 64-bit mode, the legacy replacement route (and the PIT and RTC losing IRQ
// 0 and 8), I/O APIC routes edge and level triggered, FSB messages (also of
// timer 0 with the legacy replacement route, as Windows has it), the ACPI
// description and snapshots.

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
    hpet: true,
    memory_size: 32 * 1024 * 1024,
    cpu_clock: { mode: "normal", now: () => host },
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const cpu = emulator.v86.cpu;
const hpet = cpu.devices.hpet;
// (not running: the machine clock is paused; this test moves it itself)
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

const BASE = 0xFED00000;
const r32 = offset => cpu.mmap_read32(BASE + offset) >>> 0;
const w32 = (offset, value) => cpu.mmap_write32(BASE + offset, value | 0);
const T = (n, reg) => 0x100 + 0x20 * n + reg;
const CONF = 0x00, CMP = 0x08, FSB = 0x10;
const ENABLE = 1, LEG_RT = 2;
const LEVEL = 1 << 1, INT_ENB = 1 << 2, PERIODIC = 1 << 3, VAL_SET = 1 << 6, MODE32 = 1 << 8, FSB_EN = 1 << 14;
const route = gsi => gsi << 9;
const TICKS_PER_MS = 1e12 / 69841279;

/** Interrupt activity: [kind, line, level] */
let events = [];
const raise = cpu.device_raise_irq, lower = cpu.device_lower_irq, gsi_level = cpu.set_shared_gsi_level;
cpu.device_raise_irq = irq => { events.push(["irq", irq, true]); raise.call(cpu, irq); };
cpu.device_lower_irq = irq => { events.push(["irq", irq, false]); lower.call(cpu, irq); };
cpu.set_shared_gsi_level = function(gsi, source, level) { events.push(["gsi", gsi, level]); gsi_level.call(cpu, gsi, source, level); };
const msis = [];
cpu.apic_msi = (address, data) => { msis.push([address >>> 0, data]); return true; };

/** Move the machine clock on by ms and run the HPET's timers */
function advance(ms)
{
    while(ms > 0)
    {
        const step = Math.min(ms, 500);
        host += step;
        ms -= step;
    }
    return hpet.timer(cpu.clock.now());
}
const counter = () => r32(0xF0) + r32(0xF4) * 2 ** 32;
const hpet_events = () => events.filter(([kind, line]) => kind === "gsi" || line === 0 || line === 8);

test("capabilities: revision 1, three 64-bit timers, legacy route capable, Intel, 14.31818 MHz", () => {
    assert.equal(r32(0x000), 0x8086A201);
    assert.equal(r32(0x004), 69841279, "period: 69841279 fs");
    for(let n = 0; n < 3; n++)
    {
        assert.equal(r32(T(n, CONF)) & 0x8030, 0x8030, "timer " + n + ": periodic and 64-bit capable, FSB delivery");
        assert.equal(r32(T(n, CONF) + 4), 0x00F00000, "routes: I/O APIC 20-23");
        assert.equal(r32(T(n, CMP)), 0xFFFFFFFF, "comparator: all ones");
        assert.equal(r32(T(n, CMP) + 4), 0xFFFFFFFF);
    }
    assert.equal(r32(0x010), 0, "stopped, no legacy route");
});

test("main counter: stopped until enabled, 14.31818 MHz, writable only while stopped", () => {
    advance(50);
    assert.equal(counter(), 0, "stopped");
    w32(0x010, ENABLE);
    advance(10);
    assert.ok(Math.abs(counter() - 10 * TICKS_PER_MS) <= 1, "10 ms: " + counter());
    w32(0x010, 0);
    const frozen = counter();
    advance(10);
    assert.equal(counter(), frozen, "stopped again");
    w32(0xF0, 0xFFFFFFF0);
    w32(0xF4, 1);
    assert.equal(counter(), 2 ** 32 + 0xFFFFFFF0, "written while stopped");
    w32(0x010, ENABLE);
    advance(1);
    assert.ok(Math.abs(counter() - (2 ** 32 + 0xFFFFFFF0 + TICKS_PER_MS)) <= 1, "counts on from there, past 2^32");
    w32(0xF0, 0);
    assert.ok(counter() > 2 ** 32, "not writable while running");
    w32(0x010, 0);
    w32(0xF0, 0);
    w32(0xF4, 0);
    w32(0x010, ENABLE);
});

test("one-shot, 32-bit mode (as Linux programs it), I/O APIC input 20, edge", () => {
    events = [];
    w32(T(0, CONF), INT_ENB | MODE32 | route(20));
    assert.equal(r32(T(0, CMP) + 4), 0, "32-bit mode: the comparator's upper half is 0");
    const at = (counter() + 14318) >>> 0;   // about 1 ms
    w32(T(0, CMP), at);
    const wait = advance(0.5);
    assert.deepEqual(hpet_events(), [], "not yet");
    assert.ok(wait > 0.4 && wait < 0.6, "the next match in about 0.5 ms: " + wait);
    advance(0.6);
    assert.deepEqual(hpet_events(), [["gsi", 20, true], ["gsi", 20, false]], "an edge on input 20");
    events = [];
    advance(10);
    assert.deepEqual(hpet_events(), [], "once");
    w32(T(0, CONF), 0);
});

test("periodic, 32-bit: Tn_VAL_SET sets the comparator, then the period; missed periods coalesce", () => {
    events = [];
    const now = counter();
    w32(T(0, CONF), INT_ENB | PERIODIC | VAL_SET | MODE32 | route(21));
    w32(T(0, CMP), now + 1000);             // the comparator
    w32(T(0, CMP), 2000);                   // then the period
    assert.equal(r32(T(0, CONF)) & VAL_SET, 0, "VAL_SET clears itself");
    assert.equal(r32(T(0, CMP)), now + 1000);
    advance(1000 / TICKS_PER_MS + 0.01);
    assert.equal(hpet_events().length, 2, "the first match");
    assert.equal(r32(T(0, CMP)), now + 3000, "the comparator moves on by the period");
    events = [];
    advance(2000 / TICKS_PER_MS);
    assert.equal(hpet_events().length, 2, "the second, a period later");
    events = [];
    advance(20000 / TICKS_PER_MS);
    assert.equal(hpet_events().length, 2, "ten periods late: one interrupt");
    assert.ok(r32(T(0, CMP)) > counter() % 2 ** 32, "the comparator ahead of the counter again");
    w32(T(0, CONF), 0);
});

test("periodic, 64-bit (timer 1): comparator and period in two halves", () => {
    events = [];
    const now = counter();
    w32(T(1, CONF), INT_ENB | PERIODIC | VAL_SET | route(22));
    w32(T(1, CMP), now + 500);
    assert.equal(r32(T(1, CONF)) & VAL_SET, VAL_SET, "64-bit: VAL_SET stays for the upper half");
    w32(T(1, CMP) + 4, 0);
    assert.equal(r32(T(1, CONF)) & VAL_SET, 0);
    w32(T(1, CMP), 1500);
    w32(T(1, CMP) + 4, 0);
    assert.equal(r32(T(1, CMP)), now + 500, "then only the period changes");
    assert.equal(r32(T(1, CMP) + 4), 0);
    advance(600 / TICKS_PER_MS);
    advance(1500 / TICKS_PER_MS);
    assert.equal(hpet_events().length, 4, "two matches");
    w32(T(1, CONF), 0);
});

test("legacy replacement route: timers 0 and 1 on IRQ 0 and 8; the PIT and the RTC lose them", () => {
    const pit = cpu.devices.pit, rtc = cpu.devices.rtc;
    assert.ok(pit.drives_irq0() && rtc.drives_irq8());
    w32(0x010, ENABLE | LEG_RT);
    assert.ok(!pit.drives_irq0() && !rtc.drives_irq8(), "taken");
    events = [];
    w32(T(0, CONF), INT_ENB | MODE32 | route(20));
    w32(T(0, CMP), counter() + 100 >>> 0);
    w32(T(1, CONF), INT_ENB | MODE32);
    w32(T(1, CMP), counter() + 200 >>> 0);
    advance(300 / TICKS_PER_MS);
    assert.deepEqual(hpet_events(), [["irq", 0, true], ["irq", 0, false], ["irq", 8, true], ["irq", 8, false]],
        "timer 0 on IRQ 0 (not input 20), timer 1 on IRQ 8");
    w32(0x010, ENABLE);
    assert.ok(pit.drives_irq0() && rtc.drives_irq8(), "given back");
    w32(T(0, CONF), 0);
    w32(T(1, CONF), 0);
});

test("level triggered (timer 2, input 23): GINTR_STA, the line held until the status is cleared", () => {
    events = [];
    w32(T(2, CONF), INT_ENB | LEVEL | MODE32 | route(23));
    w32(T(2, CMP), counter() + 100 >>> 0);
    advance(200 / TICKS_PER_MS);
    assert.deepEqual(hpet_events(), [["gsi", 23, true]]);
    assert.equal(r32(0x020), 4, "status of timer 2");
    assert.ok(cpu.shared_irq_sources[23].size > 0);
    cpu.mmap_write8(BASE + 0x020, 0);
    assert.equal(r32(0x020), 4, "a byte write of 0 clears nothing");
    w32(0x020, 4);
    assert.equal(r32(0x020), 0);
    assert.deepEqual(hpet_events(), [["gsi", 23, true], ["gsi", 23, false]], "cleared: the line drops");
    w32(T(2, CONF), 0);
});

test("FSB delivery: the timer's message to the local APIC", () => {
    msis.length = 0;
    events = [];
    w32(T(1, FSB) + 4, 0xFEE00000);
    w32(T(1, FSB), 0x0041);
    w32(T(1, CONF), INT_ENB | MODE32 | FSB_EN | route(20));
    w32(T(1, CMP), counter() + 100 >>> 0);
    advance(200 / TICKS_PER_MS);
    assert.deepEqual(msis, [[0xFEE00000, 0x41]]);
    assert.deepEqual(hpet_events(), [], "no line");
    w32(T(1, CONF), 0);
});

test("FSB delivery before the legacy replacement route (as Windows uses timer 0, and QEMU has it)", () => {
    w32(0x010, ENABLE | LEG_RT);
    msis.length = 0;
    events = [];
    w32(T(0, FSB) + 4, 0xFEE0100C);
    w32(T(0, FSB), 0x49D1);
    w32(T(0, CONF), INT_ENB | MODE32 | FSB_EN);
    w32(T(0, CMP), counter() + 100 >>> 0);
    advance(200 / TICKS_PER_MS);
    assert.deepEqual(msis, [[0xFEE0100C, 0x49D1]], "timer 0's message");
    assert.deepEqual(hpet_events(), [], "not IRQ 0");
    assert.ok(!cpu.devices.pit.drives_irq0(), "the PIT still loses IRQ 0");
    w32(T(0, CONF), 0);
    w32(0x010, ENABLE);
});

test("ACPI: the HPET table (in the tables SeaBIOS loads), a PNP0103 device in the DSDT", () => {
    const file = cpu.option_roms.find(rom => rom.name === "etc/acpi/tables");
    const data = file.get_data ? file.get_data() : file.data;
    const text = Buffer.from(data);
    const at = text.indexOf(Buffer.from([0x48, 0x50, 0x45, 0x54, 56, 0, 0, 0]));     // "HPET", length 56
    assert.ok(at >= 0, "the HPET table");
    const u32 = a => text.readUInt32LE(a);
    assert.equal(u32(at + 4), 56, "its length");
    assert.equal(u32(at + 36), 0x8086A201, "event timer block ID: GCAP_ID");
    assert.equal(text[at + 40], 0, "system memory");
    assert.equal(u32(at + 44), BASE, "base address");
    assert.equal(text.subarray(at, at + 56).reduce((a, b) => a + b, 0) & 0xFF, 0, "checksum");
    // the DSDT: Device (HPET) with _HID EISAID("PNP0103") (41 D0 01 03)
    assert.ok(text.indexOf(Buffer.from([0x5B, 0x82])) >= 0 && text.indexOf(Buffer.from([0x0C, 0x41, 0xD0, 0x01, 0x03])) >= 0, "PNP0103");
});

// a periodic timer across a snapshot
events = [];
const start = counter();
w32(T(0, CONF), INT_ENB | PERIODIC | VAL_SET | MODE32 | route(20));
w32(T(0, CMP), start + 1000);
w32(T(0, CMP), 4000);
const state = await emulator.save_state();
w32(T(0, CONF), 0);
w32(0x010, 0);
await emulator.restore_state(state);
cpu.clock.resume();
test("snapshot: the counter runs on, the periodic timer keeps comparator and period", () => {
    events = [];
    assert.equal(r32(0x010), ENABLE);
    assert.equal(r32(T(0, CMP)), start + 1000);
    advance(1100 / TICKS_PER_MS);
    assert.equal(hpet_events().length, 2, "the first match");
    advance(4000 / TICKS_PER_MS);
    assert.equal(hpet_events().length, 4, "a period later");
    w32(T(0, CONF), 0);
});

emulator.destroy();
console.log((failed ? "FAIL" : "PASS") + ": " + passed + " HPET tests passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
