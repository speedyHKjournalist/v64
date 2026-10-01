#!/usr/bin/env node
// ACPI reset and S5 (docs/acpi.md): disk I/O in flight across a
// machine reset or S5. The hard disk is an embedder's asynchronous buffer whose
// reads and writes complete 100 ms later.
// - a reset while an IDE read is in flight: the read is dropped, the reset
//   IDE controller raises no interrupt for it;
// - a reset while an IDE DMA write is in flight: its completion does not
//   touch the reset channel (no interrupt, bus master status left alone);
// - a reset while an ISA DMA transfer (the floppy's path) is in flight: the
//   late data does not reach the RAM of the machine that starts after it;
// - S5 while a write is in flight: "acpi-power-off" comes only after it landed.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SIZE = 16 << 20, LATENCY = 100;
const disk = new Uint8Array(SIZE).map((_, i) => i * 7 & 0xFF);
let writes_landed = 0;
// v86's own in-memory disk, with every read and write completing later
const { SyncBuffer } = await import("../../src/buffer.js");
const base = new SyncBuffer(disk.buffer);
const hda = Object.create(base);
hda.get = (start, length, callback) => setTimeout(() => base.get(start, length, callback), LATENCY);
hda.set = (start, data, callback) => setTimeout(() => base.set(start, data, () => { writes_landed++; callback(); }), LATENCY);

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
    hda, memory_size: 32 << 20, acpi: true, autostart: false, log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const cpu = emulator.v86.cpu;
const channel = cpu.devices.ide.primary, drive = channel.master;
let irqs = 0;
const raise = cpu.device_raise_irq.bind(cpu);
cpu.device_raise_irq = irq => { if(irq === channel.irq) irqs++; raise(irq); };

// an IDE read in flight, then a machine reset
let read_completed = false;
drive.read_buffer(0, 512, () => { read_completed = true; });
assert.equal(cpu["snapshot_io_pending"], 1, "the read is in flight");
cpu.reboot_internal("test");
await delay(LATENCY * 3);
assert.equal(read_completed, false, "a read in flight is dropped by the reset");
assert.equal(cpu["snapshot_io_pending"], 0, "and no longer counted as pending");
console.log("ok - IDE read in flight across a reset is dropped");

// an IDE DMA write in flight (as ata_write_sectors_dma leaves it), then a reset
drive.current_command = 0xCA;
channel.dma_status = 1;
irqs = 0;
const { track_state_io } = await import("../../src/state_io.js");
const epoch = drive.reset_epoch;
track_state_io(cpu, done => drive.buffer.set(0, new Uint8Array(512).fill(0x55), done), () => {
    if(epoch !== drive.reset_epoch) return;
    drive.push_irq();
});
cpu.reboot_internal("test");
await delay(LATENCY * 3);
assert.equal(disk[0], 0x55, "the write itself landed (the guest issued it)");
assert.equal(irqs, 0, "its completion raised no interrupt on the reset channel");
assert.equal(channel.dma_status, 0, "bus master status as after reset");
console.log("ok - IDE write completing after a reset does not touch the channel");

// an ISA DMA transfer in flight, then a reset: the late data stays out of RAM
const dma = cpu.devices.dma;
const target = 0x10000;
cpu.mem8.fill(0, target, target + 512);
dma.channel_page[2] = target >> 16;
dma.channel_addr[2] = target & 0xFFFF;
dma.channel_count[2] = 511;
let dma_done = false;
dma.do_read(hda, 1024, 512, 2, () => { dma_done = true; });
cpu.reboot_internal("test");
await delay(LATENCY * 3);
assert.equal(dma_done, false, "the transfer does not complete for the new machine");
assert.ok(cpu.mem8.subarray(target, target + 512).every(b => b === 0), "its data did not reach RAM");
console.log("ok - ISA DMA transfer across a reset leaves RAM alone");

// S5 while a write is in flight: the host hears of it after the write landed
const landed_before = writes_landed;
track_state_io(cpu, done => hda.set(4096, new Uint8Array(512).fill(0xAA), done), () => {});
const announced = new Promise(resolve => emulator.add_listener("acpi-power-off", resolve));
cpu.devices.acpi.power_off(5);
assert.equal(await announced, "S5");
assert.equal(writes_landed, landed_before + 1, "acpi-power-off comes after the write landed");
assert.equal(disk[4096], 0xAA);
console.log("ok - S5 is announced after disk writes in flight landed");

await emulator.destroy();
console.log("device I/O reset tests passed");
