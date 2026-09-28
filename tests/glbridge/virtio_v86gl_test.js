"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
(async () => {
    global.DEBUG = false;
    const { V86 } = await import("../../src/browser/starter.js");
    const emulator = new V86({
        wasm_path: path.join(__dirname, "../../build/v86.wasm"),
        memory_size: 32 * 1024 * 1024,
        bios: { buffer: new Uint8Array(65536).fill(0xf4).buffer },
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        net_device: { type: "none" }, autostart: false,
        v86gl_pci: { maxBatchBytes: 16 * 1024 * 1024 },
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    try {
        const cpu = emulator.v86.cpu, io = cpu.io, device = cpu.devices.v86gl_pci;
        const pci = device.virtio;
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
        assert.equal(request(2,0,32),2,"submit without registered arena fails");
        assert.equal(request(1,arena,16*1024*1024,0,1),1,"64-bit address without RAM rejected");
        assert.equal(request(1,0x2000000,16*1024*1024),1,"out-of-RAM arena rejected");
        assert.equal(request(1,arena,16*1024*1024),0);
        assert.equal(request(1,arena,16*1024*1024),1,"registration cannot replace live arena");
        [0x324c4756,1,0,42,1,4,0,0].forEach((v,i)=>mem.setUint32(arena+i*4,v,true));
        mem.setUint16(arena+32,0xfff1,true); mem.setUint16(arena+34,0,true);
        assert.equal(request(2,0,36),3,"missing host renderer is visible to guest");
        let lastEvent;
        let expectedCommandBytes = 4;
        emulator.add_listener("v86gl-pci-frame", event => {
            event.handled = true; lastEvent = event;
            assert.equal(event.frameId,42);
            assert.equal(event.bytes.byteLength,expectedCommandBytes);
        });
        assert.equal(request(2,0,36,1),0);
        assert.equal(lastEvent.flags,1);
        assert.equal(lastEvent.batchAddr,arena+32);
        lastEvent.writeGuestMemory(0x100,new Uint8Array([7]));
        assert.equal(mem.getUint8(arena+0x100),7);
        assert.throws(()=>lastEvent.writeGuestMemory(16*1024*1024,new Uint8Array([1])),/outside/);
        const writer = lastEvent.writeGuestMemory;
        assert.equal(request(3),0);
        assert.equal(lastEvent.isMemoryValid(),false);
        writer(0x100,new Uint8Array([9]));
        assert.equal(mem.getUint8(arena+0x100),7,"unregistration revokes async writers");
        assert.equal(request(1,arena,16*1024*1024),0);
        assert.equal(request(2,0,36),0);
        const beforeReset = lastEvent;
        const saved = device.get_state();
        saved[1] = pci.get_state().map(x => x && typeof x.get_state === "function" ? x.get_state() : x);
        w8(20,0);
        assert.equal(device.arenaBytes,0,"guest virtio reset revokes the arena");
        assert.equal(beforeReset.isMemoryValid(),false);
        device.set_state(saved);
        assert.equal(device.arenaBytes,16*1024*1024);
        assert.throws(()=>device.set_state([1,0,32,1,0,0,0,0]),/Legacy/);
        // Real split-ring 16-bit wrap, rather than just modulo queue size.
        idx = 65535;
        pci.queues[0].avail_last_idx = idx;
        mem.setUint16(used+2,idx,true); mem.setUint16(avail+2,idx,true);
        assert.equal(request(2,0,36),0);
        assert.equal(idx,0);
        setup();
        mem.setUint32(req,1,true); mem.setUint16(avail+2,1,true);
        mem.setUint16(table+14,0,true); // descriptor cycle
        io.port_write16(notify,0);
        assert.ok(io.port_read8(common+20)&64,"malformed queue requests a device reset");
        setup();
        w8(20,3);
        mem.setUint16(avail+2,1,true);
        io.port_write16(notify,0);
        assert.equal(mem.getUint16(used+2,true),0,"no consumption before DRIVER_OK");
        setup();
        // Relocate every BAR via real PCI config writes, as an OS enumerator can.
        for (let bar = 0; bar < 4; bar++) {
            io.port_write32(0xcf8, (0x80000000 | (0x13 << 11) | (0x10 + bar*4)) >>> 0);
            io.port_write32(0xcfc, 0xe001 + bar*0x100);
        }
        common = 0xe000; notify = 0xe100;
        assert.equal(io.port_read8(common+20),15);
        assert.equal(io.port_read32(0xe300) >>> 0,0x324c4756);
        assert.equal(request(1,arena,16*1024*1024),0);
        assert.equal(request(2,0,36),0,"submissions work after PCI BAR relocation");
        // The shipping D3D9, D3D8 and DirectDraw DLLs put D9WG_MAGIC in
        // VGL2 reserved0. Only OpenGL zeroes it; it is not a virtio field.
        const envelope = new Uint8Array(40);
        const d9 = new DataView(envelope.buffer);
        d9.setUint16(0,0xffe1,true); d9.setUint16(2,0xffff,true);
        d9.setUint32(4,32,true); d9.setUint32(8,0x47573944,true);
        d9.setUint16(12,1,true); d9.setUint16(14,3,true);
        d9.setUint32(16,42,true); d9.setUint32(32,1,true); d9.setUint32(36,1,true);
        expectedCommandBytes = envelope.length;
        mem.setUint32(arena+20,envelope.length,true);
        mem.setUint32(arena+24,0x47573944,true);
        ram.set(envelope,arena+32);
        assert.equal(request(2,0,32+envelope.length),0,"shipping D9WG descriptor accepted by virtqueue");
        assert.deepEqual([...lastEvent.bytes],[...envelope]);
        // Two outstanding requests are drained with one used-index/IRQ flush.
        setup();
        [1,arena,0,16*1024*1024,0,0].forEach((v,i)=>mem.setUint32(req+i*4,v,true));
        const req2=table+320, reply2=table+352;
        [3,0,0,0,0,0].forEach((v,i)=>mem.setUint32(req2+i*4,v,true));
        mem.setUint32(table+32,req2,true); mem.setUint32(table+40,24,true);
        mem.setUint16(table+44,1,true); mem.setUint16(table+46,3,true);
        mem.setUint32(table+48,reply2,true); mem.setUint32(table+56,16,true);
        mem.setUint16(table+60,2,true);
        mem.setUint16(avail,0,true);
        mem.setUint16(avail+4,0,true); mem.setUint16(avail+6,2,true); mem.setUint16(avail+2,2,true);
        let interrupts=0, invalidations=0;
        const raise=pci.raise_irq;
        pci.raise_irq=function(type) { interrupts++; return raise.call(this,type); };
        const dirty=cpu.jit_dirty_cache;
        cpu.jit_dirty_cache=(start,end)=>{
            if ((start===reply || start===reply2) && end===start+16) invalidations++;
            return dirty(start,end);
        };
        io.port_write16(notify,0);
        cpu.jit_dirty_cache=dirty; pci.raise_irq=raise;
        assert.equal(mem.getUint16(used+2,true),2);
        assert.equal(mem.getUint32(reply,true),0); assert.equal(mem.getUint32(reply2,true),0);
        assert.equal(interrupts,1,"one completion interrupt for multiple pending requests");
        assert.equal(invalidations,2,"direct replies invalidate guest JIT code as before");
        assert.equal(device.arenaBytes,0);
        setup();
        [1,arena,0,16*1024*1024,0,0].forEach((v,i)=>mem.setUint32(req+i*4,v,true));
        mem.setUint16(avail+4,0,true); mem.setUint16(avail+6,8,true); mem.setUint16(avail+2,2,true);
        io.port_write16(notify,0);
        assert.equal(mem.getUint16(used+2,true),1,"publish accepted reply before rejecting later malformed head");
        assert.ok(io.port_read8(common+20)&64);
        setup();
        mem.setUint32(table+16,0xa0000,true); mem.setUint16(avail+2,1,true);
        io.port_write16(notify,0);
        assert.ok(io.port_read8(common+20)&64,"direct replies must target RAM, not VGA MMIO");
        setup();
        assert.equal(request(1,arena,16*1024*1024),0,"register again after a reset");
        console.log("virtio_v86gl_test: PCI capabilities, negotiation, real virtqueue, validation, lifetime, reset, wrap and BAR relocation passed");
    } finally { await emulator.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
