#!/usr/bin/env node

// The VMware backdoor's RPCI channel (src/vmware.js, CMD_MESSAGE): the way
// vmwgfx and VMware's Windows drivers send their logs and ask for guestinfo
// settings, four bytes per access of port 0x5658, as open-vm-tools'
// lib/message does it.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

const vm = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    boot_order: 0x321, autostart: true, memory_size: 16 << 20,
    net_device: { type: "none" }, disable_speaker: true, log_level: 0,
});
await new Promise(resolve => vm.add_listener("emulator-ready", resolve));
await vm.wait_until_vga_screen_contains("Booting from Floppy", { timeout_msec: 30000 });
await vm.stop();

const cpu = vm.v86.cpu, io = cpu.io, reg = cpu.reg32;
const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESI = 6, EDI = 7;
const PORT = 0x5658, MAGIC = 0x564D5868, MESSAGE = 30;
/** One backdoor call: [eax, ebx, ecx, edx, esi, edi] after it */
const call = (step, ebx, channel) => {
    reg[EAX] = MAGIC;
    reg[EBX] = ebx;
    reg[ECX] = step << 16 | MESSAGE;
    reg[EDX] = channel << 16 | PORT;
    const eax = io.port_read32(PORT);
    return [eax, reg[EBX] >>> 0, reg[ECX] >>> 0, reg[EDX] >>> 0, reg[ESI] >>> 0, reg[EDI] >>> 0];
};
const SUCCESS = 1, DORECV = 2;

/** A whole RPCI exchange: the reply as text */
function rpci(text)
{
    const [, , status, edx] = call(0, 0x49435052 | 0x80000000, 0);
    assert.ok(status >>> 16 & SUCCESS, "OPEN");
    const channel = edx >>> 16;
    const bytes = new TextEncoder().encode(text);
    assert.ok(call(1, bytes.length, channel)[2] >>> 16 & SUCCESS, "SENDSIZE");
    for(let i = 0; i < bytes.length; i += 4)
    {
        const v = bytes[i] | (bytes[i + 1] | 0) << 8 | (bytes[i + 2] | 0) << 16 | (bytes[i + 3] | 0) << 24;
        assert.ok(call(2, v, channel)[2] >>> 16 & SUCCESS, "SENDPAYLOAD");
    }
    const [, size, received, type] = call(3, 0, channel);
    assert.ok(received >>> 16 & DORECV, "a reply");
    assert.equal(type >>> 16, 1, "its size comes as MESSAGE_TYPE_SENDSIZE");
    const reply = [];
    for(let i = 0; i < size; i += 4)
    {
        const [, v, , kind] = call(4, SUCCESS, channel);
        assert.equal(kind >>> 16, 2, "payload as MESSAGE_TYPE_SENDPAYLOAD");
        for(let j = 0; j < 4 && i + j < size; j++) reply.push(v >>> 8 * j & 0xFF);
    }
    call(5, SUCCESS, channel);
    assert.ok(call(6, 0, channel)[2] >>> 16 & SUCCESS, "CLOSE");
    return String.fromCharCode(...reply);
}

const logs = [];
vm.add_listener("vmware-log", text => logs.push(text));
assert.equal(rpci("log vm3d: WDDM 3D is enabled."), "1 ");
assert.deepEqual(logs, ["vm3d: WDDM 3D is enabled."], "the log reaches the emulator's bus");
assert.equal(rpci("info-get guestinfo.svga.wddm.enableGBObjects"), "0 No value found");
cpu.devices.vmware.guestinfo.set("svga.wddm.enableGBObjects", "FALSE");
assert.equal(rpci("info-get guestinfo.svga.wddm.enableGBObjects"), "1 FALSE", "guestinfo values the host set");
assert.equal(rpci("frobnicate"), "0 Unknown command");
console.log("PASS: RPCI over the backdoor: logs, guestinfo, unknown commands");
await vm.destroy();
