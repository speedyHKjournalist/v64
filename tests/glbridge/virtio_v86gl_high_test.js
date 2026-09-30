"use strict";
// virtio-v86gl on the physical bus: an arena in RAM relocated above 4 GiB
// (high_memory_size) is accepted, submitted and written back through the
// bus; the low alias it leaves (an open-bus hole) is rejected.
const assert = require("node:assert/strict");
const path = require("node:path");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");
(async () => {
    global.DEBUG = false;
    const { V86 } = await import("../../src/browser/starter.js");
    const MiB = 1024 * 1024;
    let host = null, last;
    const descriptor = createV86GLDevice({ remote: false, post: message => { last = message; },
        listen: handler => { host = handler; } });
    const emulator = new V86({
        wasm_path: path.join(__dirname, "../../build/v86.wasm"),
        memory_size: 64 * MiB, high_memory_size: 16 * MiB,
        bios: { buffer: new Uint8Array(65536).fill(0xf4).buffer },
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        net_device: { type: "none" }, autostart: false,
        virtio_devices: [descriptor],
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    try {
        const cpu = emulator.v86.cpu, io = cpu.io;
        const ram = cpu.read_blob(0, 48 * MiB);
        const mem = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
        const common = 0xf100, notify = 0xf200;
        const table = 0x10000, avail = table + 128, used = table + 160;
        const req = table + 256, reply = table + 288;
        const w8 = (o, v) => io.port_write8(common + o, v);
        const w16 = (o, v) => io.port_write16(common + o, v);
        const w32 = (o, v) => io.port_write32(common + o, v);
        let idx = 0;
        w8(20, 0); w8(20, 3);
        w32(0, 1); w32(8, 0); w32(12, 1); w32(8, 1); w32(12, 1);
        w8(20, 11);
        w16(22, 0); w16(24, 8);
        w32(32, table); w32(36, 0); w32(40, avail); w32(44, 0); w32(48, used); w32(52, 0);
        for (let i = 0; i < 320; i++) mem.setUint8(table + i, 0);
        mem.setUint32(table, req, true); mem.setUint32(table + 8, 24, true);
        mem.setUint16(table + 12, 1, true); mem.setUint16(table + 14, 1, true);
        mem.setUint32(table + 16, reply, true); mem.setUint32(table + 24, 16, true);
        mem.setUint16(table + 28, 2, true);
        mem.setUint16(avail, 1, true);
        w16(28, 1); w8(20, 15);
        function request(op, address = 0, length = 0, flags = 0, high = 0) {
            [op, address, high, length, flags, 0].forEach((v, i) => mem.setUint32(req + i * 4, v, true));
            mem.setUint32(reply, 0xffffffff, true);
            mem.setUint16(avail + 4 + (idx & 7) * 2, 0, true);
            idx = (idx + 1) & 0xffff;
            mem.setUint16(avail + 2, idx, true);
            io.port_write16(notify, 0);
            assert.equal(mem.getUint16(used + 2, true), idx);
            return mem.getUint32(reply, true);
        }
        assert.equal(cpu.low_memory_size, 48 * MiB);
        assert.equal(request(1, 48 * MiB, 16 * MiB), 1, "the low alias of relocated RAM is a hole");
        assert.equal(request(1, 0, 16 * MiB, 0, 1), 0, "arena in RAM above 4 GiB");
        assert.equal(descriptor.get_state()[1], 4 * 1024 * MiB);
        const header = new Uint8Array(36), view = new DataView(header.buffer);
        [0x324c4756, 1, 0, 77, 1, 4, 0, 0].forEach((v, i) => view.setUint32(i * 4, v, true));
        view.setUint16(32, 0xfff1, true);
        cpu.write_blob_physical(header, 4 * 1024 * MiB);
        host({ type: "available", value: true });
        assert.equal(request(2, 0, 36), 0, "submission from high RAM");
        assert.equal(last.frameId, 77);
        assert.deepEqual([...last.bytes], [0xf1, 0xff, 0, 0]);
        // The relocated range is the top of the backing store, not low RAM.
        assert.equal(new Uint8Array(cpu.mem8.buffer, cpu.mem8.byteOffset + 48 * MiB, 4)[0], 0x56);
        host({ type: "write", generation: last.generation, offset: 0x200, bytes: new Uint8Array([0xA5, 0x5A]) });
        assert.deepEqual([...cpu.read_blob_physical(4 * 1024 * MiB + 0x200, 2)], [0xA5, 0x5A], "write-back reaches high RAM");
        console.log("virtio_v86gl_high_test: arena above 4 GiB accepted, low hole rejected, submit and write-back through the physical bus passed");
    } finally { await emulator.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
