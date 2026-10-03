#!/usr/bin/env node
// Real Wasm memory/MMIO and VirtIO transport through the 36-bit bus.
import assert from "node:assert/strict";
import { VirtIO } from "../../src/virtio.js";
const { V86 } = await import(process.env.V86_LIB_PATH || (+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js"));
const emulator = new V86({ graphics_adapter: "bochs_vga", wasm_path: process.env.WASM_PATH, memory_size: 16 << 20,
    disable_jit: true, autostart: false, log_level: 0, net_device: { type: "none" },
    hda: { buffer: new ArrayBuffer(8192) }, virtio_balloon: true });
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
try
{
    const cpu = emulator.v86.cpu, e = cpu.wm.exports;
    const HIGH = 2 ** 32, LIMIT = 2 ** 36;
    const generation = () => (e.x64_phys_generation(false) >>> 0) + (e.x64_phys_generation(true) >>> 0) * HIGH;
    const map = (slot, address, backing, length, kind = 1) =>
        e.x64_phys_set_window(slot, address >>> 0, Math.floor(address / HIGH), backing, length, kind);
    const before = generation();
    assert.equal(map(0, HIGH, 0x200000, 0x10000), 1);
    assert.ok(generation() > before);
    const first = generation();
    assert.equal(map(0, HIGH, 0x200000, 0x10000), 1);
    assert.equal(generation(), first, "no-op mapping does not invalidate again");
    assert.deepEqual(Array.from({ length: 5 }, (_, field) => e.x64_phys_get_window(0, field)), [0, 1, 0x200000, 0x10000, 1]);
    assert.equal(map(1, HIGH + 0x1000, 0x220000, 0x1000), 0, "overlap rejected");
    assert.equal(generation(), first, "failed mapping changes nothing");
    assert.throws(() => cpu.read8_physical(0x200000), RangeError, "relocated low physical RAM is a hole");
    cpu.write32_physical(0x1000, 0xAABBCCDD);
    cpu.write32_physical(HIGH + 0x1000, 0x12345678);
    assert.equal(cpu.read32_physical(HIGH + 0x1000), 0x12345678);
    assert.equal(cpu.read32_physical(0x1000), 0xAABBCCDD, "high physical access never aliases its low DWORD");
    assert.equal(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x201000, true), 0x12345678);
    assert.equal(!!cpu.in_mapped_range(0x201000), true);
    assert.equal(!!cpu.in_mapped_range(0x210000), false, "RAM above the first hole still has an ordinary fast mapping");
    assert.equal(cpu.read32s(0x201000) >>> 0, 0xFFFFFFFF, "legacy physical read sees a hole");
    cpu.write32(0x201000, 0xBAD);
    assert.equal(cpu.read32_physical(HIGH + 0x1000), 0x12345678, "legacy physical write cannot reach relocated backing");
    const first_high_bytes = cpu.read_blob_physical(HIGH, 2);
    cpu.write32(0x1FFFFE, 0x11223344);
    assert.deepEqual(cpu.mem8.slice(0x1FFFFE, 0x200000), new Uint8Array([0x44, 0x33]));
    assert.deepEqual(cpu.read_blob_physical(HIGH, 2), first_high_bytes, "straddling legacy physical write ignores hole bytes");
    assert.equal(cpu.read32s(0x1FFFFE) >>> 0, 0xFFFF3344);

    assert.equal(map(1, HIGH + 0x10000, 0x220000, 0x1000), 1);
    const split = new Uint8Array([1, 2, 3, 4]);
    cpu.write_blob_physical(split, HIGH + 0xFFFE);
    assert.deepEqual(cpu.read_blob_physical(HIGH + 0xFFFE, 4), split);
    assert.equal(cpu.read32_physical(HIGH + 0xFFFE), 0x04030201);
    assert.deepEqual(cpu.mem8.slice(0x20FFFE, 0x210000), split.slice(0, 2));
    assert.deepEqual(cpu.mem8.slice(0x220000, 0x220002), split.slice(2));
    const unchanged = cpu.mem8.slice(0x220FFC, 0x221000);
    assert.throws(() => cpu.write_blob_physical(new Uint8Array(8).fill(0xFF), HIGH + 0x10FFC), RangeError);
    assert.deepEqual(cpu.mem8.slice(0x220FFC, 0x221000), unchanged, "whole blob validated before first write");
    assert.throws(() => cpu.read8_physical(LIMIT), RangeError);
    assert.throws(() => cpu.write32_physical(LIMIT - 2, 1), RangeError);
    console.log("PASS physical Wasm RAM relocation, split windows, all-or-nothing invalid range");

    const device = new Uint8Array(0x20000), view = new DataView(device.buffer), trace = [];
    const MMIO = 0x10000000, HIGH_MMIO = 2 * HIGH;
    cpu.io.mmap_register(MMIO, device.length,
        address => { trace.push(["r8", address]); return device[(address >>> 0) - MMIO]; },
        (address, value) => { trace.push(["w8", address]); device[(address >>> 0) - MMIO] = value; },
        address => { trace.push(["r32", address]); return view.getInt32((address >>> 0) - MMIO, true); },
        (address, value) => { trace.push(["w32", address]); view.setInt32((address >>> 0) - MMIO, value, true); });
    assert.equal(map(2, HIGH_MMIO, MMIO, 0x1000, 2), 1);
    cpu.write32_physical(HIGH_MMIO + 4, 0x87654321);
    assert.equal(cpu.read32_physical(HIGH_MMIO + 4), 0x87654321);
    assert.deepEqual(trace.map(([kind]) => kind), ["w32", "r32"]);
    assert.equal(cpu.read32_physical(MMIO + 4), 0x87654321, "MMIO window explicitly aliases existing device decode");
    trace.length = 0;
    assert.throws(() => cpu.write32_physical(HIGH_MMIO + 0xFFE, 0xAAAAAAAA), RangeError);
    assert.equal(trace.length, 0, "invalid second half cannot trigger first-half MMIO");
    const last_device = new Uint8Array(0x20000);
    cpu.io.mmap_register(0xFFFE0000, last_device.length,
        address => last_device[(address >>> 0) - 0xFFFE0000],
        (address, value) => { last_device[(address >>> 0) - 0xFFFE0000] = value; });
    cpu.write32_physical(HIGH - 2, 0x44332211);
    assert.deepEqual(last_device.slice(-2), new Uint8Array([0x11, 0x22]));
    assert.deepEqual(cpu.mem8.slice(0x200000, 0x200002), new Uint8Array([0x33, 0x44]));
    assert.equal(cpu.read32_physical(HIGH - 2), 0x44332211);
    console.log("PASS physical Wasm high MMIO, no premature MMIO effects, cross-4GiB scalar");

    const options = {
        name: "high-dma-wasm", pci_id: 0x78, device_id: 0x1041, subsystem_device_id: 1,
        common: { initial_port: 0xAF00, features: [28, 29, 32], queues: [{ size_supported: 8, notify_offset: 0 }], on_driver_ok() {} },
        notification: { initial_port: 0xAF40, single_handler: true, handlers: [() => {}] },
        isr_status: { initial_port: 0xAF60 },
    };
    const virtio = new VirtIO(cpu, options), queue = virtio.queues[0];
    const table = HIGH + 0x1000, avail = HIGH + 0x2000, used = HIGH + 0x3000;
    for(const [offset, address] of [[32, table], [40, avail], [48, used]])
    {
        cpu.io.port_write32(0xAF00 + offset + 4, 1);
        cpu.io.port_write32(0xAF00 + offset, address >>> 0);
        assert.equal(cpu.io.port_read32(0xAF00 + offset + 4), 1);
    }
    cpu.write_blob_physical(new Uint8Array(0x3000), table);
    const descriptor = (address, data, length, flags, next = 0) => {
        cpu.write32_physical(address, data >>> 0);
        cpu.write32_physical(address + 4, Math.floor(data / HIGH));
        cpu.write32_physical(address + 8, length);
        cpu.write16_physical(address + 12, flags);
        cpu.write16_physical(address + 14, next);
    };
    const indirect = HIGH + 0x6000, payload = HIGH + 0x7000, reply = HIGH + 0x8000;
    const message = new Uint8Array([9, 8, 7, 6, 5]);
    descriptor(table, indirect, 32, 4);
    descriptor(indirect, payload, message.length, 1, 1);
    descriptor(indirect + 16, reply, message.length, 2);
    cpu.write_blob_physical(message, payload);
    cpu.write_blob_physical(new Uint8Array(message.length).fill(0xAA), 0x8000);
    cpu.write16_physical(avail + 2, 1);
    cpu.write16_physical(avail + 4, 0);
    cpu.io.port_write16(0xAF00 + 28, 1);
    assert.equal(queue.enabled, true);
    const chain = queue.pop_request();
    assert.equal(chain.valid, true);
    const actual = new Uint8Array(message.length);
    assert.equal(chain.get_next_blob(actual), actual.length);
    assert.deepEqual(actual, message);
    assert.equal(chain.set_next_blob(actual), actual.length);
    queue.push_reply(chain);
    queue.flush_replies();
    assert.deepEqual(cpu.read_blob_physical(reply, actual.length), message);
    assert.deepEqual(cpu.read_blob_physical(0x8000, actual.length), new Uint8Array(actual.length).fill(0xAA));
    assert.equal(cpu.read16_physical(used + 2), 1);
    assert.equal(cpu.read32_physical(used + 8), message.length);
    console.log("PASS real PCI-register VirtIO high rings, indirect table, DMA blob and completion");

    const dma = cpu.devices.dma;
    const dma_address = address => {
        dma.channel_addr[0] = address & 0xFFFF;
        dma.channel_page[0] = address >>> 16 & 255;
        dma.channel_pagehi[0] = address >>> 24;
        dma.channel_count[0] = 3;
    };
    let called = false, dma_error;
    dma_address(0x200000);
    dma.do_read({ byteLength: 4, get() { called = true; } }, 0, 4, 0, error => { dma_error = error; });
    assert.equal(dma_error, true);
    assert.equal(called, false, "8237 rejects low hole before requesting disk data");
    dma_error = undefined;
    dma.do_write({ byteLength: 4, set() { called = true; } }, 0, 4, 0, error => { dma_error = error; });
    assert.equal(dma_error, true);
    assert.equal(called, false, "8237 rejects low hole before writing disk data");
    dma_address(0x9000);
    dma.do_read({ byteLength: 4, get(start, length, done) { done(split); } }, 0, 4, 0, error => { dma_error = error; });
    assert.equal(dma_error, false);
    assert.deepEqual(cpu.read_blob_physical(0x9000, 4), split);
    dma_address(0x9000);
    dma.do_write({ byteLength: 4, set(start, data, done) { assert.deepEqual(data, split); done(); } }, 0, 4, 0, error => { dma_error = error; });
    assert.equal(dma_error, false);
    dma_address(0xFFFFFFFF);
    assert.equal(dma.address_get_8bit(0), 0xFFFFFFFF);
    dma.do_read({ byteLength: 4, get() { assert.fail("32-bit DMA must not extend into high RAM"); } }, 0, 4, 0, error => { dma_error = error; });
    assert.equal(dma_error, true);
    let delayed;
    dma_address(0x230000);
    dma.do_read({ byteLength: 4, get(start, length, done) { delayed = done; } }, 0, 4, 0, error => { dma_error = error; });
    assert.equal(map(3, HIGH + 0x20000, 0x230000, 4096), 1);
    const before_delayed = cpu.mem8.slice(0x230000, 0x230004);
    delayed(split);
    assert.equal(dma_error, true);
    assert.deepEqual(cpu.mem8.slice(0x230000, 0x230004), before_delayed, "async DMA rechecks relocation after data arrives");
    assert.equal(map(3, 0, 0, 0, 0), 1);
    console.log("PASS real 8237 DMA low holes, normal transfer, 32-bit limit, async remap rejection");

    const ide = cpu.devices.ide.primary.master, channel = cpu.devices.ide.primary;
    const prdt = 0xB000;
    const prd = (slot, address, count, end) => {
        cpu.write32_physical(prdt + slot * 8, address);
        cpu.write16_physical(prdt + slot * 8 + 4, count);
        cpu.write16_physical(prdt + slot * 8 + 6, end ? 0x8000 : 0);
    };
    const atapi_transfer = () => {
        channel.prdt_addr = prdt;
        channel.dma_status = 1;
        ide.current_command = 0xA0;
        ide.status_reg = 8;
        ide.data = new Uint8Array([5, 6, 7, 8]);
        ide.data_length = 4;
        ide.do_atapi_dma();
    };
    prd(0, 0x9000, 2, false);
    prd(1, 0x200000, 2, true);
    const before_ide = cpu.read_blob_physical(0x9000, 4);
    atapi_transfer();
    assert.equal(channel.dma_status & 3, 2);
    assert.equal(ide.error_reg, 4);
    assert.deepEqual(cpu.read_blob_physical(0x9000, 4), before_ide, "IDE prevalidates later PRD before writing the first");
    prd(1, 0x9002, 2, true);
    atapi_transfer();
    assert.equal(channel.dma_status & 3, 0);
    assert.deepEqual(cpu.read_blob_physical(0x9000, 4), new Uint8Array([5, 6, 7, 8]));
    channel.prdt_addr = 0x200000;
    assert.throws(() => ide.dma_segments(4), RangeError);
    channel.prdt_addr = prdt;
    prd(0, 0xFFFFFFFE, 4, true);
    assert.throws(() => ide.dma_segments(4), RangeError, "IDE buffer remains 32-bit even when high RAM exists");
    channel.prdt_addr = 0xFFFFFFFC;
    assert.throws(() => ide.dma_segments(4), RangeError, "IDE PRDT cannot cross 4GiB");
    const ata_setup = command => {
        channel.prdt_addr = prdt;
        channel.dma_status = 1;
        ide.current_command = command;
        ide.sector_count_reg = 1;
        ide.is_lba = 1;
        ide.head = ide.lba_low_reg = ide.lba_mid_reg = ide.lba_high_reg = 0;
    };
    const sector = Uint8Array.from({ length: 512 }, (_, i) => i * 17 & 255);
    cpu.write_blob_physical(sector, 0x9000);
    prd(0, 0x9000, 512, true);
    ata_setup(0xCA);
    ide.do_ata_write_sectors_dma();
    assert.equal(channel.dma_status & 3, 0);
    assert.equal(ide.current_command, -1);
    cpu.write_blob_physical(new Uint8Array(512), 0x9000);
    ata_setup(0xC8);
    ide.do_ata_read_sectors_dma();
    assert.equal(channel.dma_status & 3, 0);
    assert.deepEqual(cpu.read_blob_physical(0x9000, 512), sector);
    prd(0, 0x200000, 512, true);
    for(const command of [0xCA, 0xC8])
    {
        ata_setup(command);
        if(command === 0xCA) ide.do_ata_write_sectors_dma();
        else ide.do_ata_read_sectors_dma();
        assert.equal(channel.dma_status & 3, 2);
        assert.equal(ide.current_command, -1);
    }
    console.log("PASS real IDE PRDT low holes, full-transfer preflight, device abort, 32-bit limits");

    const balloon = cpu.devices.virtio_balloon;
    const balloon_table = HIGH + 0x9000, balloon_avail = HIGH + 0xA000, balloon_used = HIGH + 0xB000;
    cpu.write_blob_physical(new Uint8Array(0x3000), balloon_table);
    cpu.io.port_write16(0xD800 + 22, 3);
    for(const [offset, address] of [[32, balloon_table], [40, balloon_avail], [48, balloon_used]])
    {
        cpu.io.port_write32(0xD800 + offset, address >>> 0);
        cpu.io.port_write32(0xD800 + offset + 4, 1);
    }
    descriptor(balloon_table, HIGH + 0xC000, 16, 2);
    cpu.write_blob_physical(new Uint8Array(16).fill(0xCC), HIGH + 0xC000);
    cpu.write_blob_physical(new Uint8Array(16).fill(0xDD), 0xC000);
    cpu.write16_physical(balloon_avail + 2, 1);
    cpu.io.port_write16(0xD800 + 28, 1);
    cpu.io.port_write16(0xD900 + 4, 3);
    assert.deepEqual(cpu.read_blob_physical(HIGH + 0xC000, 16), new Uint8Array(16));
    assert.deepEqual(cpu.read_blob_physical(0xC000, 16), new Uint8Array(16).fill(0xDD));
    assert.equal(balloon.zeroed, 16);
    assert.equal(cpu.read16_physical(balloon_used + 2), 1);
    console.log("PASS real VirtIO balloon high free-page hint zeros correct backing only");

    if(e.x64_phys_restore_windows)
    {
        const saved = new Uint32Array(80);
        for(let slot = 0; slot < 16; slot++)
            for(let field = 0; field < 5; field++) saved[slot * 5 + field] = e.x64_phys_get_window(slot, field);
        const pointer = e.v86_malloc(saved.byteLength);
        try
        {
            const transfer = new Uint32Array(cpu.wasm_memory.buffer, pointer, saved.length);
            transfer.set(saved);
            transfer[16] = 16; // slot 3 physical high DWORD: outside 36 bits
            transfer[18] = 4096;
            transfer[19] = 1;
            const unchanged_generation = generation();
            assert.equal(e.x64_phys_restore_windows(pointer, saved.length), 0);
            assert.equal(generation(), unchanged_generation);
            assert.equal(cpu.read32_physical(HIGH + 0x7000), 0x06070809);
            transfer.set(saved);
            assert.equal(e.x64_phys_restore_windows(pointer, saved.length), 1);
            assert.ok(generation() > unchanged_generation);
            assert.equal(cpu.read32_physical(HIGH + 0x7000), 0x06070809);
            console.log("PASS physical window restore transaction rejects bad set and refreshes generation");
        }
        finally { e.v86_free(pointer); }
    }
    else assert.fail("physical transactional restore export missing: rebuild required");
}
finally { await emulator.destroy(); }
