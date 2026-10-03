#!/usr/bin/env node

// virtio-gpu as virtio-vga (src/graphics_adapters/virtio_gpu), after SeaBIOS
// and the VGA BIOS have set it up, driven through its transport the way a
// driver does: PCI identity and layout (VRAM in BAR0, the capabilities in
// the memory BAR2, as QEMU's virtio-vga), the VGA core until the first control command, display
// information and EDID, 2D resources with scattered backing (guest RAM and
// the frame buffer), scanouts and flushes, fences, errors, the cursor queue,
// display events from V86.set_display_size, two displays, snapshots and
// resets. The guests' drivers are tested by tests/x64/linux_gpu.mjs.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

// hlt forever
const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

const VRAM = 16 << 20;
const MEMORY = 64 << 20;
const emulator = new V86({
    graphics_adapter: "virtio_gpu",
    graphics_adapter_test: { scanouts: 2, level: "2d-blob" },
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    boot_order: 0x321,
    autostart: true,
    memory_size: MEMORY,
    vram_size: VRAM,
    net_device: { type: "none" },
    disable_speaker: true,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
await emulator.wait_until_vga_screen_contains("Booting from Floppy", { timeout_msec: 30000 });
await emulator.stop();

const cpu = emulator.v86.cpu, io = cpu.io;
const gpu = cpu.devices.graphics_adapter.device["virtio_gpu"];
const BDF = 0x12 << 3;
const pci_read = reg => { io.port_write32(0xcf8, 0x80000000 | BDF << 8 | reg); return io.port_read32(0xcfc) >>> 0; };
const pci_read8 = reg => pci_read(reg & ~3) >>> 8 * (reg & 3) & 0xFF;

// PCI identity: what Linux's virtio_pci and viogpudo's INF match
assert.equal(pci_read(0x00), 0x10501AF4, "virtio-gpu, modern");
assert.equal(pci_read(0x2C), 0x11001AF4, "subsystem 1AF4:1100");
assert.equal(pci_read(0x08), 0x03000001, "revision 1, a VGA controller");
const bar0 = pci_read(0x10), bar2 = pci_read(0x18);
assert.equal(bar0 & 0xF, 0x8, "BAR0 is prefetchable memory");
assert.equal(bar2 & 0xF, 0x0, "BAR2 is memory");
assert.deepEqual([0x14, 0x1C, 0x20, 0x24].map(pci_read), [0, 0, 0, 0], "no other BARs");
const fb = (bar0 & ~0xF) >>> 0, mmio = (bar2 & ~0xF) >>> 0;
assert.equal(fb % VRAM, 0, "BAR0 aligned to its size");
assert.equal(mmio % 0x20000, 0, "BAR2 aligned to its size (at least a block of v86's memory map)");
assert.equal(gpu.vga.lfb_address, fb, "the VGA core's frame buffer follows BAR0");
console.log(`SeaBIOS put the frame buffer at ${fb.toString(16)}, the capabilities at ${mmio.toString(16)}`);

// The capabilities: all four in BAR1, at their windows
const caps = {};
for(let at = pci_read8(0x34); at; at = pci_read8(at + 1))
{
    if(pci_read8(at) !== 0x09) continue;
    caps[pci_read8(at + 3)] = { bar: pci_read8(at + 4), offset: pci_read(at + 8), length: pci_read(at + 12) };
}
assert.deepEqual([1, 2, 3, 4].map(type => caps[type].bar), [2, 2, 2, 2], "common, notify, ISR and device config share BAR2");
assert.deepEqual([1, 2, 3, 4].map(type => caps[type].offset), [0, 0x100, 0x200, 0x300]);
assert.ok(caps[5], "and the PCI configuration access capability");
const common = mmio, notify = mmio + 0x100, isr = mmio + 0x200, config = mmio + 0x300;
// The capabilities through the memory map, as the CPU reaches them (16-bit
// writes arrive a byte at a time)
const mmio_read8 = address => cpu.mmap_read8(address);
const mmio_read16 = address => cpu.mmap_read8(address) | cpu.mmap_read8(address + 1) << 8;
const mmio_read32 = address => cpu.mmap_read32(address) >>> 0;
const mmio_write8 = (address, value) => cpu.mmap_write8(address, value);
const mmio_write16 = (address, value) => cpu.mmap_write16(address, value);
const mmio_write32 = (address, value) => cpu.mmap_write32(address, value);
assert.equal(mmio_read32(config + 8), 2, "num_scanouts");
assert.equal(mmio_read32(config + 12), 0, "num_capsets: no 3D at the 2d level");
assert.ok(cpu.devices.vga === gpu.vga, "the VGA core is the machine's VGA");
// Status is read-only or write-1-to-clear: Windows clears it with a 16-bit
// write, which must leave the capability list (virtio drivers look for it)
io.port_write32(0xcf8, 0x80000000 | BDF << 8 | 0x04);
io.port_write16(0xcfe, 0xFFFF);
assert.equal(pci_read(0x04) >>> 16 & 0x10, 0x10, "the capability list survives a write to the status register");
io.port_write8(0xcfe, 0);
assert.equal(pci_read(0x04) >>> 16 & 0x10, 0x10, "and a byte write");

// An OS that moves BAR2: the capabilities follow, the old place is unmapped
const pci_write = (reg, value) => { io.port_write32(0xcf8, 0x80000000 | BDF << 8 | reg); io.port_write32(0xcfc, value); };
const MOVED = 0xFEA00000;
pci_write(0x18, MOVED);
assert.equal(cpu.mmap_read32(MOVED + 0x300 + 8) >>> 0, 2, "num_scanouts at the new place");
assert.equal(cpu.mmap_read8(mmio + 0x300 + 8), 0xFF, "nothing at the old one");
pci_write(0x18, mmio);
assert.equal(mmio_read32(config + 8), 2, "and back");
console.log("PASS: PCI identity, BARs and capabilities");

// Guest memory
const write32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
const read32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;
const write_bytes = (address, bytes) => bytes.forEach((b, i) => cpu.write8(address + i, b));
const read_bytes = (address, length) => Array.from({ length }, (_, i) => cpu.read8(address + i));

// The transport: features, two queues
const w8 = (offset, value) => mmio_write8(common + offset, value);
const w16 = (offset, value) => mmio_write16(common + offset, value);
const w32 = (offset, value) => mmio_write32(common + offset, value);
const QUEUES = [{ size: 0, desc: 0x100000, avail: 0x101000, used: 0x102000, avail_idx: 0 },
    { size: 0, desc: 0x110000, avail: 0x111000, used: 0x112000, avail_idx: 0 }];

function start_driver()
{
    w8(20, 0);
    w8(20, 3);
    w32(0, 0);
    const features0 = mmio_read32(common + 4) >>> 0;
    assert.equal(features0 & 6, 6, "EDID and RESOURCE_UUID");
    assert.equal(features0 & 1, 0, "no VIRGL at the 2d level");
    w32(0, 1);
    assert.equal(mmio_read32(common + 4) & 1, 1, "VIRTIO_F_VERSION_1");
    w32(8, 0); w32(12, 6); w32(8, 1); w32(12, 1);
    w8(20, 11);
    assert.equal(mmio_read8(common + 20), 11, "FEATURES_OK accepted");
    // (viogpudo always asks for configuration vector 0 and gives up when it
    // does not read back; interrupts stay INTx)
    w16(16, 0);
    assert.equal(mmio_read16(common + 16), 0, "msix_config keeps what the driver writes");
    QUEUES.forEach((q, i) => {
        w16(22, i);
        q.size = mmio_read16(common + 24);
        w16(26, 0xFFFF);
        assert.equal(mmio_read16(common + 26), 0xFFFF, "queue_msix_vector");
        w32(32, q.desc); w32(36, 0);
        w32(40, q.avail); w32(44, 0);
        w32(48, q.used); w32(52, 0);
        for(let j = 0; j < 0x3000; j += 4) write32(q.desc + j, 0);
        q.avail_idx = 0;
        w16(28, 1);
    });
    w8(20, 15);
}

const REQUEST = 0x200000, REPLY = 0x280000;
/**
 * A request on a queue: its bytes, readable, then a writable reply buffer
 * (in two descriptors, as Linux sends ATTACH_BACKING's entries)
 */
function submit(queue_index, parts, reply_size = 2048)
{
    const q = QUEUES[queue_index];
    let address = REQUEST, d = 0;
    for(const part of parts)
    {
        write_bytes(address, part);
        write32(q.desc + d * 16, address); write32(q.desc + d * 16 + 4, 0);
        write32(q.desc + d * 16 + 8, part.length);
        cpu.write8(q.desc + d * 16 + 12, 1);
        cpu.write8(q.desc + d * 16 + 14, d + 1);
        address += part.length + 64 & ~63;
        d++;
    }
    if(reply_size)
    {
        for(let i = 0; i < reply_size; i += 4) write32(REPLY + i, 0xDEADBEEF);
        write32(q.desc + d * 16, REPLY); write32(q.desc + d * 16 + 4, 0);
        write32(q.desc + d * 16 + 8, reply_size);
        cpu.write8(q.desc + d * 16 + 12, 2);
    }
    else
    {
        cpu.write8(q.desc + (d - 1) * 16 + 12, 0);
    }
    cpu.write8(q.desc + d * 16 + 13, 0);
    write32(q.avail + 4 + (q.avail_idx % q.size) * 2, 0);
    q.avail_idx = q.avail_idx + 1 & 0xFFFF;
    cpu.write8(q.avail + 2, q.avail_idx & 0xFF);
    cpu.write8(q.avail + 3, q.avail_idx >> 8);
    const used_before = read32(q.used) >>> 16;
    mmio_write16(notify, queue_index);
    const used_after = read32(q.used) >>> 16;
    assert.equal(used_after, used_before + 1 & 0xFFFF, "the request is completed at once");
    return read32(q.used + 4 + ((used_after - 1) % q.size) * 8 + 4);
}

const header = (type, flags = 0, fence = 0) => {
    const h = new Uint8Array(24), v = new DataView(h.buffer);
    v.setUint32(0, type, true); v.setUint32(4, flags, true); v.setUint32(8, fence, true);
    return h;
};
const words = (...values) => new Uint8Array(new Uint32Array(values).buffer);
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for(const p of parts) { out.set(p, at); at += p.length; } return out; };
const command = (type, ...values) => submit(0, [concat(header(type), words(...values))]);
const reply_type = () => read32(REPLY);
const OK = 0x1100;

// The VGA core is on screen until the driver sends a control command
let layers = [];
cpu.devices.display.update_buffer = l => { layers = layers.concat(l); };
assert.ok(!gpu.active);
start_driver();
assert.ok(!gpu.active, "DRIVER_OK alone does not take the screen");

// GET_DISPLAY_INFO: the first display on, 1024x768, the second off
assert.equal(command(0x0100), 24 + 16 * 24, "the whole response is written");
assert.equal(reply_type(), 0x1101);
assert.deepEqual([0, 1, 2, 3, 4].map(i => read32(REPLY + 24 + i * 4)), [0, 0, 1024, 768, 1]);
assert.equal(read32(REPLY + 24 + 24 + 16), 0, "the second display is off");
assert.ok(gpu.active, "the driver has the screen");

// GET_EDID: a valid EDID 1.4 whose preferred mode is the display's size
command(0x010A, 0, 0);
assert.equal(reply_type(), 0x1104);
assert.equal(read32(REPLY + 24), 128);
const edid = read_bytes(REPLY + 32, 128);
assert.deepEqual(edid.slice(0, 8), [0, 255, 255, 255, 255, 255, 255, 0], "the EDID header");
assert.equal(edid.reduce((a, b) => a + b) & 0xFF, 0, "the checksum");
assert.deepEqual([edid[18], edid[19]], [1, 4], "EDID 1.4");
assert.equal(edid[56] | (edid[58] >> 4) << 8, 1024, "preferred width");
assert.equal(edid[59] | (edid[61] >> 4) << 8, 768, "preferred height");
console.log("PASS: display information and EDID");

// A 64x48 B8G8R8X8 resource, its backing in three pieces: a page of RAM, the
// frame buffer (as viogpudo backs its resources), RAM again
const W = 64, H = 48, STRIDE = W * 4;
const pieces = [[0x300000, 4096], [fb + 0x10000, 4096], [0x310000, STRIDE * H - 8192]];
const pixel_address = offset => {
    for(const [address, length] of pieces)
    {
        if(offset < length) return address + offset;
        offset -= length;
    }
    throw new Error("outside the backing");
};
const put = (x, y, bgrx) => write32(pixel_address(y * STRIDE + x * 4), bgrx);
for(let y = 0; y < H; y++) for(let x = 0; x < W; x++) put(x, y, x | y << 8 | 0x40 << 16);
assert.equal(command(0x0101, 1, 2, W, H), 24);
assert.equal(reply_type(), OK);
const entries = concat(...pieces.map(([address, length]) => words(address >>> 0, Math.floor(address / 2 ** 32), length, 0)));
submit(0, [concat(header(0x0106), words(1, pieces.length)), entries]);
assert.equal(reply_type(), OK, "ATTACH_BACKING with its entries in a second descriptor");
command(0x0105, 0, 0, W, H, 0, 0, 1, 0);
assert.equal(reply_type(), OK, "TRANSFER_TO_HOST_2D");
command(0x0103, 0, 0, W, H, 0, 1);
assert.equal(reply_type(), OK, "SET_SCANOUT");
const scanout = gpu.scanouts[0];
const shown = (x, y) => [...scanout.rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
assert.deepEqual(shown(5, 7), [0x40, 7, 5, 255], "B8G8R8X8, converted");
assert.deepEqual(shown(10, 16), [0x40, 16, 10, 255], "from the frame buffer page");
assert.deepEqual(shown(63, 47), [0x40, 47, 63, 255], "the last pixel");

// Changes show after a transfer of their rectangle and a flush
put(20, 30, 0x00FF00FF);
put(21, 30, 0x0000FF00);
command(0x0105, 20, 30, 2, 1, 30 * STRIDE + 20 * 4, 0, 1, 0);
assert.deepEqual(shown(20, 30), [0x40, 30, 20, 255], "a transfer alone does not reach the display");
command(0x0104, 16, 28, 8, 4, 1, 0);
assert.deepEqual(shown(20, 30), [0xFF, 0, 0xFF, 255], "RESOURCE_FLUSH");
assert.deepEqual(shown(21, 30), [0, 0xFF, 0, 255]);

// What the display gets: the mode, then the picture
cpu.devices.display.request_frame(true);
assert.ok(layers.some(l => l.pixels.data === scanout.rgba && l.buffer_width === W), "the scanout is on screen");
console.log("PASS: resources, backing in RAM and VRAM, transfers, scanouts and flushes");

// Fences: the response carries the request's
submit(0, [concat(header(0x0104, 1, 0x1234), words(0, 0, 1, 1, 1, 0))]);
assert.equal(reply_type(), OK);
assert.equal(read32(REPLY + 4), 1, "VIRTIO_GPU_FLAG_FENCE");
assert.equal(read32(REPLY + 8), 0x1234, "the fence id");

// Errors
command(0x0101, 1, 2, 8, 8);
assert.equal(reply_type(), 0x1203, "a resource ID in use");
command(0x0101, 2, 99, 8, 8);
assert.equal(reply_type(), 0x1205, "an unknown format");
command(0x0103, 0, 0, W + 1, H, 0, 1);
assert.equal(reply_type(), 0x1205, "a scanout rectangle outside the resource");
command(0x0103, 0, 0, W, H, 7, 1);
assert.equal(reply_type(), 0x1202, "an unknown scanout");
command(0x0105, 0, 0, W, H, 0, 0, 9, 0);
assert.equal(reply_type(), 0x1203, "a transfer to no resource");
command(0x0108, 0, 0);
assert.equal(reply_type(), 0x1205, "no capsets");
command(0x7777);
assert.equal(reply_type(), 0x1200, "an unknown command");

// RESOURCE_ASSIGN_UUID: the same one each time
command(0x010B, 1, 0);
assert.equal(reply_type(), 0x1105);
const uuid = read_bytes(REPLY + 24, 16);
command(0x010B, 1, 0);
assert.deepEqual(read_bytes(REPLY + 24, 16), uuid);
assert.equal(uuid[6] >> 4, 4, "a version 4 UUID");
console.log("PASS: fences, errors and UUIDs");

// The cursor queue: a 2x2 B8G8R8A8 cursor, then moved; no reply
command(0x0101, 5, 1, 2, 2);
for(let i = 0; i < 4; i++) write32(0x320000 + i * 4, 0xFF0000FF);
command(0x0106, 5, 1, 0x320000, 0, 16, 0);
command(0x0105, 0, 0, 2, 2, 0, 0, 5, 0);
assert.equal(submit(1, [concat(header(0x0300), words(0, 10, 12, 0, 5, 1, 1, 0))], 0), 0, "nothing written");
assert.ok(gpu.cursor.visible);
layers = [];
cpu.devices.display.request_frame(false);
let patch = layers[layers.length - 1];
assert.deepEqual([patch.screen_x, patch.screen_y], [9, 11], "the hotspot at (1, 1)");
assert.deepEqual([...patch.pixels.data.subarray(0, 4)], [0, 0, 255, 255], "an opaque blue cursor");
submit(1, [concat(header(0x0301), words(0, 30, 20, 0, 0, 0, 0, 0))], 0);
layers = [];
cpu.devices.display.request_frame(false);
assert.equal(layers[0].screen_x, 9, "the picture under its old place first");
patch = layers[layers.length - 1];
assert.deepEqual([patch.screen_x, patch.screen_y], [29, 19], "MOVE_CURSOR");
submit(1, [concat(header(0x0300), words(0, 30, 20, 0, 0, 0, 0, 0))], 0);
assert.ok(!gpu.cursor.visible, "resource 0 hides it");
console.log("PASS: the cursor queue");

// The page's size: a display event, then the new size and EDID
mmio_read8(isr);
emulator.set_display_size(1280, 720);
assert.equal(mmio_read32(config), 1, "events_read: VIRTIO_GPU_EVENT_DISPLAY");
assert.equal(mmio_read8(isr), 3, "a configuration change interrupt (both bits, as QEMU: viogpudo's INTx handler takes only 1 and 3)");
mmio_write32(config + 4, 1);
assert.equal(mmio_read32(config), 0, "events_clear");
command(0x0100);
assert.deepEqual([2, 3].map(i => read32(REPLY + 24 + i * 4)), [1280, 720]);
command(0x010A, 0, 0);
assert.equal(cpu.read8(REPLY + 32 + 56) | (cpu.read8(REPLY + 32 + 58) >> 4) << 8, 1280);
emulator.set_display_size(1280, 720);
assert.equal(mmio_read32(config), 0, "the same size again is no event");

// A second display, beside the first
emulator.set_display_size(800, 600, 1);
command(0x0100);
assert.deepEqual([0, 1, 2, 3, 4].map(i => read32(REPLY + 48 + i * 4)), [1280, 0, 800, 600, 1], "the second display, on");
command(0x0101, 2, 2, 32, 32);
command(0x0106, 2, 1, 0x330000, 0, 32 * 32 * 4, 0);
for(let i = 0; i < 32 * 32; i++) write32(0x330000 + i * 4, 0x00808080);
command(0x0105, 0, 0, 32, 32, 0, 0, 2, 0);
command(0x0103, 0, 0, 32, 32, 1, 2);
assert.equal(reply_type(), OK);
layers = [];
cpu.devices.display.request_frame(true);
const second = layers.find(l => l.pixels.data === gpu.scanouts[1].rgba);
assert.equal(second.screen_x, W, "the second display is drawn beside the first");
console.log("PASS: display events from the page's size, two displays");

// Snapshots
const state = await emulator.save_state();
command(0x0102, 1, 0);
assert.equal(scanout.resource_id, 0, "RESOURCE_UNREF switches its displays off");
await emulator.restore_state(state);
// (the rings are guest RAM: back to where they were)
for(const q of QUEUES) q.avail_idx = read32(q.avail) >>> 16;
assert.equal(gpu.resources.size, 3);
assert.deepEqual([...gpu.scanouts[0].rgba.subarray((30 * W + 20) * 4, (30 * W + 20) * 4 + 4)], [0xFF, 0, 0xFF, 255],
    "the scanout's picture is back");
assert.equal(mmio_read8(common + 20), 15, "the transport is back");
put(0, 0, 0x00123456);
command(0x0105, 0, 0, 1, 1, 0, 0, 1, 0);
command(0x0104, 0, 0, 1, 1, 1, 0);
assert.deepEqual([...gpu.scanouts[0].rgba.subarray(0, 4)], [0x12, 0x34, 0x56, 255], "and the restored queues and backing work");
console.log("PASS: snapshots");

// Blobs in guest memory (level 2d-blob): a scanout shows one straight from
// there, as SET_SCANOUT_BLOB describes it; a flush is enough
{
    const BW = 32, BH = 20, BSTRIDE = 160, BOFFSET = 64;
    const blob = [[0x380000, 2048], [0x390000, BOFFSET + BSTRIDE * BH - 2048]];
    const blob_address = offset => {
        for(const [address, length] of blob)
        {
            if(offset < length) return address + offset;
            offset -= length;
        }
        throw new Error("outside the blob");
    };
    const bput = (x, y, bgrx) => write32(blob_address(BOFFSET + y * BSTRIDE + x * 4), bgrx);
    for(let y = 0; y < BH; y++) for(let x = 0; x < BW; x++) bput(x, y, x | y << 8 | 0x22 << 16);
    const size = BOFFSET + BSTRIDE * BH;
    const blob_entries = concat(...blob.map(([address, length]) => words(address, 0, length, 0)));
    // resource 9, BLOB_MEM_GUEST, shareable, 2 entries, blob id 0, size
    submit(0, [concat(header(0x010C), words(9, 1, 2, blob.length, 0, 0, size, 0)), blob_entries]);
    assert.equal(reply_type(), OK, "RESOURCE_CREATE_BLOB");
    // rectangle (2, 3, 24 x 16), scanout 1, resource 9, 32 x 20, B8G8R8X8, padding, strides, offsets
    command(0x010D, 2, 3, 24, 16, 1, 9, BW, BH, 2, 0, BSTRIDE, 0, 0, 0, BOFFSET, 0, 0, 0);
    assert.equal(reply_type(), OK, "SET_SCANOUT_BLOB");
    const second = gpu.scanouts[1];
    const bshown = (x, y) => [...second.rgba.subarray((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)];
    assert.deepEqual(bshown(0, 0), [0x22, 3, 2, 255], "the rectangle's first pixel, from guest memory");
    assert.deepEqual(bshown(23, 15), [0x22, 18, 25, 255], "its last (across the blob's two pieces)");
    bput(10, 10, 0x00ABCDEF);
    command(0x0104, 0, 0, BW, BH, 9, 0);
    assert.deepEqual(bshown(8, 7), [0xAB, 0xCD, 0xEF, 255], "RESOURCE_FLUSH reads it again");
    command(0x0105, 0, 0, 1, 1, 0, 0, 9, 0);
    assert.equal(reply_type(), OK, "a transfer to a blob has nothing to do");
    command(0x010D, 0, 0, 64, 64, 1, 9, BW, BH, 2, 0, BSTRIDE, 0, 0, 0, BOFFSET, 0, 0, 0);
    assert.notEqual(reply_type(), OK, "a rectangle outside the blob's picture");
    const blob_state = await emulator.save_state();
    await emulator.restore_state(blob_state);
    for(const q of QUEUES) q.avail_idx = read32(q.avail) >>> 16;
    bput(11, 10, 0x00102030);
    command(0x0104, 0, 0, BW, BH, 9, 0);
    assert.deepEqual(bshown(9, 7), [0x10, 0x20, 0x30, 255], "a restored blob scanout");
    command(0x0102, 9, 0);
    assert.equal(second.resource_id, 0);
}
console.log("PASS: blobs in guest memory and their scanouts");

// A device reset gives the screen back to the VGA core
w8(20, 0);
assert.ok(!gpu.active);
assert.equal(gpu.resources.size, 0);
start_driver();
command(0x0100);
assert.ok(gpu.active);
// and so does a machine reset
await emulator.restart();
assert.ok(!gpu.active);
assert.equal(mmio_read8(common + 20), 0);
assert.equal(mmio_read32(config + 8), 2, "the capabilities still answer at BAR2 (the BIOS's VGA ROM window does not cover them)");
console.log("PASS: resets");

await emulator.destroy();
