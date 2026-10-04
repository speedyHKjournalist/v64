#!/usr/bin/env node
// V7 writes to a real file; no test-side whole snapshot buffer hides allocation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as set_immediate } from "node:timers";
import { createHash as create_hash } from "node:crypto";
import { crc32 } from "node:zlib";
import { MessageChannel } from "node:worker_threads";
import { begin_state_io } from "../../src/state_io.js";
import { state_stream_client, state_stream_server } from "../../src/browser/state_stream_transport.js";
const { V86 } = await import(process.env.V86_LIB_PATH || (+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js"));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "v86-state-stream-"));
const file = await fs.open(path.join(directory, "state.v7"), "w+");
const emulator = new V86({ graphics_adapter: "bochs_vga", wasm_path: process.env.WASM_PATH, memory_size: 16 << 20,
    cpu_cores: 2, acpi: true, disable_jit: true, autostart: false, log_level: 0,
    net_device: { type: "none" } });
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
try
{
    const cpu = emulator.v86.cpu, e = cpu.wm.exports, HIGH = 2 ** 32;
    cpu.mem8.fill(0);
    for(let page = 0; page < cpu.mem8.length / 4096; page += 2)
        cpu.mem8.fill(page & 255 || 0xA5, page * 4096, (page + 1) * 4096);
    assert.equal(e.x64_phys_set_window(0, 0, 1, 0x200000, 0x10000, 1), 1);
    cpu.write32_physical(HIGH + 0x5000, 0x1234ABCD);
    const windows = cpu.get_physical_windows();
    cpu.reg32[0] = 0xABCD;
    cpu.switch_core(1); cpu.reg32[0] = 0x9876; cpu.switch_core(0);
    const original_pack = cpu.pack_memory;
    cpu.pack_memory = () => { throw new Error("V7 must never pack whole RAM"); };
    let position = 0, maximum = 0, active = 0, peak = 0, writes = 0, input_received = 0;
    cpu.bus.register("stream-test-input", () => { input_received++; }, null);
    const complete_io = begin_state_io(cpu);
    setTimeout(() => { cpu.mem8[0x1010] = 0x77; complete_io(); }, 5);
    await emulator.save_state_stream(async bytes => {
        active++; peak = Math.max(peak, active);
        assert.ok(bytes instanceof Uint8Array && bytes.length <= 1024 * 1024);
        maximum = Math.max(maximum, bytes.length);
        if(!writes++)
        {
            assert.equal(cpu.mem8[0x1010], 0x77, "all DMA completed before bitmap capture");
            emulator.bus.send("stream-test-input", 1);
            assert.equal(input_received, 0, "external input held until the transaction completes");
        }
        await new Promise(resolve => set_immediate(resolve));
        const result = await file.write(bytes, 0, bytes.length, position);
        assert.equal(result.bytesWritten, bytes.length);
        position += bytes.length;
        active--;
    });
    cpu.pack_memory = original_pack;
    assert.equal(peak, 1, "writer backpressure permits one outstanding chunk");
    assert.equal(input_received, 1);
    assert.ok(position > 8 << 20);
    const header = new Uint8Array(32); await file.read(header, 0, 32, 0);
    assert.equal(new DataView(header.buffer).getUint32(4, true), 7);
    // the checksums are CRC-32 as zlib's (files saved before must still load)
    const manifest = new Uint8Array(new DataView(header.buffer).getUint32(12, true));
    await file.read(manifest, 0, manifest.length, 32);
    assert.equal(new DataView(header.buffer).getUint32(28, true), crc32(manifest), "manifest checksum");
    const record_header = new Uint8Array(16); await file.read(record_header, 0, 16, 32 + manifest.length);
    const record = new Uint8Array(16 + new DataView(record_header.buffer).getUint32(12, true) + 4);
    await file.read(record, 0, record.length, 32 + manifest.length);
    assert.equal(new DataView(record.buffer).getUint32(record.length - 4, true), crc32(record.subarray(0, record.length - 4)), "record checksum");
    let reads = 0;
    const source = { size: position, async read(offset, length) {
        assert.ok(length <= 1024 * 1024); reads++;
        const bytes = new Uint8Array(length);
        assert.equal((await file.read(bytes, 0, length, offset)).bytesRead, length);
        return bytes;
    } };
    assert.equal(e.x64_phys_set_window(0, 0, 0, 0, 0, 0), 1);
    cpu.mem8.fill(0xEE); cpu.reg32[0] = 0;
    await emulator.restore_state_stream(source);
    assert.deepEqual(cpu.get_physical_windows(), windows);
    assert.equal(cpu.read32_physical(HIGH + 0x5000), 0x1234ABCD);
    assert.equal(cpu.mem8[0x1010], 0x77);
    assert.equal(cpu.mem8[0x1000], 0);
    assert.equal(cpu.mem8[0x2000], 2);
    assert.equal(cpu.reg32[0], 0xABCD);
    cpu.switch_core(1); assert.equal(cpu.reg32[0], 0x9876); cpu.switch_core(0);
    console.log(`PASS V7 file roundtrip: ${position} bytes, ${writes} writes/${reads} reads, max chunk ${maximum}, two cores/high RAM/DMA drain/backpressure`);

    const hash_ram = () => create_hash("sha256").update(cpu.mem8.subarray(0)).digest("hex");
    const epoch = cpu.execution_epoch, untouched = hash_ram();
    const last = new Uint8Array(1); await file.read(last, 0, 1, position - 5);
    await file.write(Uint8Array.of(last[0] ^ 1), 0, 1, position - 5);
    await assert.rejects(emulator.restore_state_stream(source), /record\/checksum/);
    assert.equal(cpu.execution_epoch, epoch);
    assert.equal(hash_ram(), untouched, "late corrupt data is rejected before the first RAM write");
    await file.write(last, 0, 1, position - 5);
    await assert.rejects(emulator.restore_state_stream({ ...source, size: position - 1 }), /total length/);
    assert.equal(hash_ram(), untouched);
    console.log("PASS V7 damaged final record and truncated source rejected before architectural/RAM mutation");

    let ram_start = null, ram_reads = 0;
    const failing = { size: position, async read(offset, length) {
        const bytes = await source.read(offset, length);
        if(length > 20 && new DataView(bytes.buffer).getUint32(0, true) === 2)
        {
            if(ram_start === null) ram_start = offset;
            if(offset === ram_start && ++ram_reads === 2) throw new Error("second-pass I/O failure");
        }
        return bytes;
    } };
    await assert.rejects(emulator.restore_state_stream(failing), /second-pass I\/O failure/);
    assert.equal(emulator.is_running(), false);
    assert.equal(cpu.clock.paused, true);
    await emulator.restore_state_stream(source);
    console.log("PASS V7 second-pass I/O failure keeps CPU/clock stopped; a fresh restore recovers");

    const save_channel = new MessageChannel();
    let transport_position = 0, transport_max = 0;
    const save_server = state_stream_server(save_channel.port1, "save", async bytes => {
        transport_max = Math.max(transport_max, bytes.length);
        transport_position += bytes.length;
        await new Promise(resolve => set_immediate(resolve));
    });
    const save_client = state_stream_client(save_channel.port2);
    try { await emulator.save_state_stream(save_client.write); }
    finally { save_client.close(); save_server.close(); }
    assert.equal(transport_position, position);
    assert.ok(transport_max <= 1024 * 1024);
    const restore_channel = new MessageChannel();
    const restore_server = state_stream_server(restore_channel.port1, "restore", source);
    const restore_client = state_stream_client(restore_channel.port2);
    try { await emulator.restore_state_stream({ size: restore_server.size, read: restore_client.read }); }
    finally { restore_client.close(); restore_server.close(); }
    assert.equal(cpu.read32_physical(HIGH + 0x5000), 0x1234ABCD);
    console.log("PASS real MessagePort stream transport preserves bounded chunks and request/reply backpressure");

    const v6 = await emulator.save_state();
    assert.equal(new DataView(v6).getUint32(4, true), 6);
    cpu.write32_physical(HIGH + 0x5000, 0);
    await emulator.restore_state(v6);
    assert.equal(cpu.read32_physical(HIGH + 0x5000), 0x1234ABCD);
    await assert.rejects(emulator.save_state_stream(async () => { throw new Error("sink cancelled"); }), /sink cancelled/);
    assert.equal(emulator.v86.state_busy, null);
    console.log("PASS legacy V6 save/import retained and cancelled writer releases snapshot transaction");
}
finally
{
    await emulator.destroy();
    await file.close();
    await fs.rm(directory, { recursive: true, force: true });
}
