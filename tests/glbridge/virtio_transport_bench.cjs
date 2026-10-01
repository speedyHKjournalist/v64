// Run manually; this microbenchmark is not an FPS or CI timing assertion.
// For an A/B run, run it at another commit (a git worktree) with the same node.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");
(async () => {
    global.DEBUG = false;
    const { V86 } = await import("../../src/browser/starter.js");
    // A renderer that takes every batch at once
    let toDevice = null;
    const descriptor = createV86GLDevice({ remote: false, listen: handler => { toDevice = handler; },
        post: message => toDevice({ type: "done", id: message.id }) });
    toDevice({ type: "available", value: true });
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: path.join(__dirname,"../../build/v86.wasm"),
        memory_size: 32 * 1024 * 1024,
        bios: { buffer: new Uint8Array(65536).fill(0xf4).buffer },
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        net_device: { type: "none" }, autostart: false,
        virtio_devices: [descriptor],
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    try {
        const cpu = emulator.v86.cpu, io = cpu.io;
        const pci = cpu.devices.virtio_devices[0].virtio;
        assert.equal(pci.pci_space[0] | pci.pci_space[1] << 8, 0x1af4);
        assert.equal(pci.pci_space[2] | pci.pci_space[3] << 8, 0x107f);
        assert.ok(!pci.pci_bars.some(bar => bar && bar.fixed), "BARs can relocate");
        const ram = cpu.read_blob(0, 32 * 1024 * 1024);
        const mem = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
        let common = 0xf100, notify = 0xf200;
        const arena = 0x100000;
        const table = 0x10000, avail = table + 128, used = table + 160;
        const req = table + 256, reply = table + 288;
        const w8 = (o, v) => io.port_write8(common + o, v);
        const w16 = (o, v) => io.port_write16(common + o, v);
        const w32 = (o, v) => io.port_write32(common + o, v);
        let idx = 0;
        function setup() {
            w8(20, 0); w8(20, 3);
            w32(0, 1); assert.equal(io.port_read32(common + 4), 1);
            w32(8, 0); w32(12, 1); w32(8, 1); w32(12, 1);
            w8(20, 11); assert.equal(io.port_read8(common + 20), 11);
            w16(22, 0); w16(24, 8);
            w32(32, table); w32(36, 0); w32(40, avail); w32(44, 0);
            w32(48, used); w32(52, 0);
            for (let i = 0; i < 320; i++) mem.setUint8(table + i, 0);
            mem.setUint32(table, req, true); mem.setUint32(table + 8, 24, true);
            mem.setUint16(table + 12, 1, true); mem.setUint16(table + 14, 1, true);
            mem.setUint32(table + 16, reply, true); mem.setUint32(table + 24, 16, true);
            mem.setUint16(table + 28, 2, true);
            mem.setUint16(avail, 1, true);
            w16(28, 1); w8(20, 15); idx = 0;
        }
        function request(op, address = 0, length = 0, flags = 0, high = 0) {
            [op,address,high,length,flags,0].forEach((v,i) => mem.setUint32(req+i*4,v,true));
            mem.setUint32(reply, 0xffffffff, true);
            mem.setUint16(avail + 4 + (idx & 7) * 2, 0, true);
            idx = (idx + 1) & 0xffff;
            mem.setUint16(avail + 2, idx, true);
            io.port_write16(notify, 0);
            assert.equal(mem.getUint16(used + 2, true), idx, "used ring acknowledges request");
            assert.equal(mem.getUint32(used + 4 + ((idx - 1) & 7)*8+4,true),16);
            return mem.getUint32(reply, true);
        }
        setup();
        assert.equal(request(1,arena,16*1024*1024),0);
        [0x324c4756,1,0,42,1,4,0,0].forEach((v,i)=>mem.setUint32(arena+i*4,v,true));
        mem.setUint16(arena+32,0xfff1,true); mem.setUint16(arena+34,0,true);
        mem.setUint32(req,2,true); mem.setUint32(req+4,0,true); mem.setUint32(req+12,36,true);
        function run(count) {
            const start=process.hrtime.bigint();
            for (let i=0;i<count;i++) {
                mem.setUint16(avail+4+(idx&7)*2,0,true);
                idx=(idx+1)&65535; mem.setUint16(avail+2,idx,true);
                io.port_write16(notify,0);
            }
            assert.equal(mem.getUint16(used+2,true),idx);
            assert.equal(mem.getUint32(reply,true),0);
            return Number(process.hrtime.bigint()-start)/count;
        }
        run(20000);
        const iterations = Number(process.env.BENCH_ITERATIONS || 100000);
        assert.ok(Number.isInteger(iterations) && iterations > 0);
        const samples=Array.from({length:9},()=>run(iterations)).sort((a,b)=>a-b);
        console.log(JSON.stringify({scope:"Host virtio submission only; no guest execution or GPU rendering",node:process.version,iterations,ns_per_submit_median:samples[4],samples},null,2));
    } finally { await emulator.destroy(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
