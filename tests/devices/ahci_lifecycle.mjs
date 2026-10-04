#!/usr/bin/env node
// AHCI commands with disk I/O in flight (docs/q35-ahci-sata-plan.md): the
// hard disk is an embedder's asynchronous buffer whose reads and writes
// complete 100 ms later.
// - a machine reset while a READ DMA is in flight: no data reaches RAM, no
//   status and no interrupt for the machine that starts after it;
// - clearing PxCMD.ST while a READ DMA is in flight: PxCI clears at once,
//   the late data reaches no memory, no status bits appear;
// - a write completes for the guest only once the backend has it (DMA and
//   PIO), and FLUSH CACHE after it;
// - a snapshot taken while a write is in flight holds the completed command;
// - a reset while a write is in flight: the write lands (the guest issued
//   it), its completion reaches nothing;
// - S5 while a write is in flight: "acpi-power-off" only after it landed;
// - native command queuing: several queued commands in flight at once, each
//   completing on its own; a non-queued command waits for them; clearing ST
//   drops them; a snapshot waits for them;
// - hot plug: pulling the drive out with I/O in flight drops the read, the
//   write lands; the drive works again once plugged in.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { SyncBuffer } = await import("../../src/buffer.js");

const SIZE = 16 << 20, LATENCY = 100;
const disk = new Uint8Array(SIZE).map((_, i) => i * 7 & 0xFF);
let writes_landed = 0;
const base = new SyncBuffer(disk.buffer);
const hda = Object.create(base);
hda.get = (start, length, callback) => setTimeout(() => base.get(start, length, callback), LATENCY);
hda.set = (start, data, callback) => setTimeout(() => base.set(start, data, () => { writes_landed++; callback(); }), LATENCY);

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
    machine_type: "q35", hda, memory_size: 32 << 20, autostart: false, log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const mem = cpu.mem8;
const AHCI = 0x1F << 3 | 2, ABAR = 0xC0000000;
const ST = 1, FRE = 1 << 4, DHRS = 1;
const IS = 0x110, CMD = 0x118, CI = 0x138;
const CLB = 0x200000, FB = 0x200400, TABLE = 0x201000, DATA = 0x300000;

const r32 = offset => cpu.mmap_read32(ABAR + offset) >>> 0;
const w32 = (offset, value) => cpu.mmap_write32(ABAR + offset, value | 0);
const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
const pending = () => cpu["snapshot_io_pending"] || 0;
const SACT = 0x134, SDBS = 1 << 3;
const irq_asserted = () => cpu.shared_irq_sources.some(sources => sources.has(AHCI));

function setup()
{
    pci.config_write(AHCI, 0x24, 4, ABAR);
    pci.config_write(AHCI, 0x04, 2, 0x0006);
    w32(CMD, 0);
    w32(0x100, CLB);
    w32(0x108, FB);
    w32(CMD, FRE);
    w32(CMD, FRE | ST);
    w32(IS, -1);
    w32(0x114, -1 & 0xFDC000FF); // PxIE: everything
    w32(0x04, 2);               // GHC.IE
}

function issue(command, lba, count, write)
{
    mem.fill(0, TABLE, TABLE + 0x100);
    mem.set([0x27, 0x80, command, 0, lba & 0xFF, lba >> 8 & 0xFF, lba >> 16 & 0xFF, 0x40, 0, 0, 0, 0, count, 0], TABLE);
    put32(TABLE + 0x80, DATA);
    put32(TABLE + 0x8C, count * 512 - 1);
    put32(CLB, 5 | (write ? 1 << 6 : 0) | 1 << 16);
    put32(CLB + 8, TABLE);
    w32(CI, 1);
}

// a READ DMA in flight, then a machine reset
setup();
mem.fill(0xAA, DATA, DATA + 1024);
issue(0x25, 4, 2, false);
assert.equal(r32(CI), 1, "in flight");
assert.equal(pending(), 1);
cpu.reboot_internal("test");
await delay(LATENCY * 3);
assert.ok(mem.subarray(DATA, DATA + 1024).every(b => b === 0xAA), "the late data did not reach RAM");
assert.equal(pending(), 0, "and is no longer counted as pending");
assert.equal(r32(CI), 0);
assert.equal(r32(IS), 0, "no status for the reset port");
assert.ok(!irq_asserted(), "no interrupt");
console.log("ok - READ DMA in flight across a reset is dropped");

// a READ DMA in flight, then software stops the command list
setup();
mem.fill(0xAA, DATA, DATA + 1024);
issue(0x25, 4, 2, false);
w32(CMD, FRE);
assert.equal(r32(CI), 0, "clearing ST clears PxCI at once");
w32(IS, -1);
await delay(LATENCY * 3);
assert.ok(mem.subarray(DATA, DATA + 1024).every(b => b === 0xAA), "no data after ST was cleared");
assert.equal(r32(IS), 0, "no status for the stopped command");
console.log("ok - a command in flight is dropped when ST is cleared");

// writes complete for the guest when the backend has them
setup();
mem.fill(0x5A, DATA, DATA + 512);
let landed = writes_landed;
issue(0xCA, 8, 1, true);
assert.equal(r32(CI), 1, "a DMA write is not complete before the backend has it");
await delay(LATENCY * 2);
assert.equal(writes_landed, landed + 1);
assert.equal(r32(CI), 0, "then it is");
assert.ok(r32(IS) & DHRS);
assert.ok(disk.subarray(8 * 512, 9 * 512).every(b => b === 0x5A));

w32(IS, -1);
mem.fill(0x6B, DATA, DATA + 512);
landed = writes_landed;
issue(0x30, 9, 1, true);
assert.equal(r32(CI), 1, "a PIO write neither (BSY until the backend has it)");
assert.equal(r32(0x120) & 0x80, 0x80, "PxTFD shows BSY");
await delay(LATENCY * 2);
assert.equal(writes_landed, landed + 1);
assert.equal(r32(CI), 0);
assert.ok(disk.subarray(9 * 512, 10 * 512).every(b => b === 0x6B));

issue(0xE7, 0, 0, false);
assert.equal(r32(CI), 0, "FLUSH CACHE with no write in flight completes at once");
console.log("ok - writes and FLUSH CACHE complete after the backend has the data");

// a snapshot while a write is in flight: it waits, the command is complete in it
setup();
mem.fill(0x3C, DATA, DATA + 512);
issue(0xCA, 12, 1, true);
assert.equal(r32(CI), 1);
const state = await emulator.save_state();
assert.equal(pending(), 0, "the snapshot waited for the write");
assert.equal(r32(CI), 0, "and the command completed before the state was taken");
w32(IS, -1);
await emulator.restore_state(state);
assert.equal(r32(CI), 0, "complete in the snapshot");
assert.ok(r32(IS) & DHRS, "with its status");
assert.ok(disk.subarray(12 * 512, 13 * 512).every(b => b === 0x3C));
console.log("ok - a snapshot taken during a write holds the completed command");

// a write in flight, then a reset: it lands, nothing completes
setup();
mem.fill(0x4D, DATA, DATA + 512);
issue(0xCA, 16, 1, true);
cpu.reboot_internal("test");
await delay(LATENCY * 3);
assert.ok(disk.subarray(16 * 512, 17 * 512).every(b => b === 0x4D), "the write itself landed (the guest issued it)");
assert.equal(r32(IS), 0, "no status for the reset port");
assert.ok(!irq_asserted());
console.log("ok - a write completing after a reset does not touch the port");

/**
 * READ/WRITE FPDMA QUEUED in slot (= tag) n: its own command table and data
 * buffer (DATA + n * 64 KiB)
 */
function queue(slot, lba, count, write)
{
    const table = TABLE + slot * 0x100, data = DATA + slot * 0x10000, header = CLB + slot * 32;
    mem.fill(0, table, table + 0x100);
    mem.set([0x27, 0x80, write ? 0x61 : 0x60, count, lba & 0xFF, lba >> 8 & 0xFF, lba >> 16 & 0xFF, 0x40, 0, 0, 0, 0, slot << 3, 0], table);
    put32(table + 0x80, data);
    put32(table + 0x8C, count * 512 - 1);
    put32(header, 5 | (write ? 1 << 6 : 0) | 1 << 16);
    put32(header + 8, table);
}
const sector = lba => disk.subarray(lba * 512, lba * 512 + 512);
const buffer = slot => mem.subarray(DATA + slot * 0x10000, DATA + slot * 0x10000 + 512);

// four queued reads at once
setup();
for(let slot = 0; slot < 4; slot++)
{
    mem.fill(0xAA, DATA + slot * 0x10000, DATA + slot * 0x10000 + 512);
    queue(slot, 100 + slot * 3, 1, false);
}
w32(SACT, 0xF);
w32(CI, 0xF);
assert.equal(r32(CI), 0, "the device took all four at once");
assert.equal(r32(SACT), 0xF);
assert.equal(pending(), 4, "four reads in flight");
assert.equal(r32(0x120) & 0x88, 0, "PxTFD: not busy");
w32(IS, -1);
await delay(LATENCY * 2);
assert.equal(r32(SACT), 0, "all completed");
assert.ok(r32(IS) & SDBS);
for(let slot = 0; slot < 4; slot++) assert.deepEqual(buffer(slot), sector(100 + slot * 3), "tag " + slot);
console.log("ok - four queued reads are in flight at once");

// a queued write completes when the backend has it; a non-queued command
// waits for the queued ones
setup();
mem.fill(0x19, DATA + 5 * 0x10000, DATA + 5 * 0x10000 + 512);
landed = writes_landed;
queue(5, 30, 1, true);
w32(SACT, 1 << 5);
w32(CI, 1 << 5);
issue(0x25, 31, 1, false); // READ DMA EXT in slot 0
assert.equal(r32(CI), 1, "the non-queued command waits");
await delay(LATENCY * 1.5);
assert.equal(writes_landed, landed + 1);
assert.equal(r32(SACT), 0, "the write completed after it landed");
assert.ok(sector(30).every(b => b === 0x19));
assert.equal(r32(CI), 1, "then the non-queued command runs");
await delay(LATENCY * 1.5);
assert.equal(r32(CI), 0);
assert.ok(r32(IS) & DHRS);

// FLUSH CACHE after queued writes: it completes after they landed
mem.fill(0x2A, DATA + 6 * 0x10000, DATA + 6 * 0x10000 + 512);
landed = writes_landed;
queue(6, 32, 1, true);
w32(SACT, 1 << 6);
w32(CI, 1 << 6);
issue(0xE7, 0, 0, false);
assert.equal(r32(CI), 1, "FLUSH CACHE waits");
await delay(LATENCY * 1.5);
assert.equal(writes_landed, landed + 1);
assert.equal(r32(CI), 0, "and completes once the queued write landed");
assert.ok(sector(32).every(b => b === 0x2A));
console.log("ok - a non-queued command (and FLUSH CACHE) waits for the queued commands in flight");

// clearing ST drops the queued commands in flight
setup();
mem.fill(0xAA, DATA, DATA + 512);
queue(0, 40, 1, false);
w32(SACT, 1);
w32(CI, 1);
w32(CMD, FRE);
assert.equal(r32(SACT), 0, "PxSACT clears with ST");
w32(IS, -1);
await delay(LATENCY * 2);
assert.ok(buffer(0).every(b => b === 0xAA), "no data after ST was cleared");
assert.equal(r32(IS), 0, "no set device bits FIS");
console.log("ok - queued commands in flight are dropped when ST is cleared");

// a snapshot waits for the queued commands in flight
setup();
queue(2, 50, 1, false);
queue(3, 51, 1, false);
w32(SACT, 0xC);
w32(CI, 0xC);
assert.equal(pending(), 2);
const queued_state = await emulator.save_state();
assert.equal(pending(), 0);
assert.equal(r32(SACT), 0, "completed before the state was taken");
w32(IS, -1);
await emulator.restore_state(queued_state);
assert.equal(r32(SACT), 0);
assert.ok(r32(IS) & SDBS);
assert.deepEqual(buffer(2), sector(50));
console.log("ok - a snapshot waits for the queued commands in flight");

// the drive pulled out with a queued read and a queued write in flight
setup();
mem.fill(0xAA, DATA, DATA + 1024);
mem.fill(0x5C, DATA + 7 * 0x10000, DATA + 7 * 0x10000 + 512);
landed = writes_landed;
queue(7, 60, 1, true);
queue(0, 4, 2, false);
w32(SACT, 1 << 7 | 1);
w32(CI, 1 << 7 | 1);
assert.equal(pending(), 2);
emulator.detach_sata_drive(0);
assert.equal(pending(), 1, "the read is dropped (the write is in the backend's hands)");
assert.equal(r32(0x128), 0, "no link");
w32(IS, -1);
await delay(LATENCY * 2);
assert.equal(pending(), 0);
assert.equal(writes_landed, landed + 1, "the write landed");
assert.ok(sector(60).every(b => b === 0x5C));
assert.ok(mem.subarray(DATA, DATA + 1024).every(b => b === 0xAA), "no data from the read");
assert.equal(r32(IS), 1 << 22, "no completion, only PRCS (the link went down)");
assert.equal(r32(SACT), 1 << 7 | 1, "both stay active (until software stops the port)");
// plugged in again: after the guest restarts the port, it works
await emulator.attach_sata_drive(0, hda);
w32(0x130, -1); // PxSERR
setup();
issue(0x25, 4, 2, false);
await delay(LATENCY * 2);
assert.equal(r32(CI), 0);
assert.deepEqual(mem.subarray(DATA, DATA + 1024), disk.subarray(4 * 512, 6 * 512));
console.log("ok - a drive pulled out with I/O in flight: the read is dropped, the write lands; plugged in again");

// S5 with a write in flight: the power-off is announced after it landed
setup();
pci.config_write(0x1F << 3, 0x40, 4, 0x601); // PMBASE
pci.config_write(0x1F << 3, 0x44, 1, 0x80);  // ACPI_EN
assert.equal(cpu.devices.acpi.pm_base, 0x600);
mem.fill(0x2E, DATA, DATA + 512);
landed = writes_landed;
issue(0xCA, 20, 1, true);
let announced_after = -1;
const off = new Promise(resolve => emulator.add_listener("acpi-power-off", () => { announced_after = writes_landed - landed; resolve(); }));
cpu.io.port_write16(0x604, 0 << 10 | 1 << 13); // SLP_TYP 0 (S5), SLP_EN
await off;
assert.equal(announced_after, 1, "acpi-power-off after the write landed");
console.log("ok - S5 is announced after the AHCI write in flight landed");

emulator.destroy();
console.log("AHCI lifecycle tests passed");
