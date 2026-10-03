#!/usr/bin/env node

// The VMware SVGA II adapter's video overlay (level dx11-full,
// svga_video.js): SVGA_FIFO_CAP_VIDEO, SVGA_ESCAPE_VMWARE_VIDEO_SET_REGS and
// _FLUSH through the FIFO, YUY2 and YV12 frames from VRAM scaled into the
// destination rectangle, the color key, switching a unit off, snapshots; the
// overlay is drawn over the picture, guest memory stays as it was. Also the
// level's DX_PROVOKING_VERTEX devcap.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const C = await import("../../src/graphics_adapters/vmware_svga/svga_constants.js");

// hlt forever
const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

// (a 3D level needs a renderer; nothing here draws in 3D)
let to_device = null;
const renderer = {
    "post": message => { if(message["type"] === "submit") to_device({ "type": "done", "seq": message["seq"] }); },
    "listen": handler => { to_device = handler; },
};
const VRAM = 8 << 20;
const emulator = new V86({
    graphics_adapter: "vmware_svga",
    graphics_adapter_test: { level: "dx11-full", renderer },
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    boot_order: 0x321,
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    vram_size: VRAM,
    net_device: { type: "none" },
    disable_speaker: true,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
await emulator.wait_until_vga_screen_contains("Booting from Floppy", { timeout_msec: 30000 });
await emulator.stop();

const cpu = emulator.v86.cpu, io = cpu.io;
const svga = cpu.devices.graphics_adapter.device["svga"];
const BDF = 0x12 << 3;
const pci_read = reg => { io.port_write32(0xcf8, 0x80000000 | BDF << 8 | reg); return io.port_read32(0xcfc) >>> 0; };
const port = pci_read(0x10) & ~3, fb = (pci_read(0x14) & ~0xF) >>> 0, fifo = (pci_read(0x18) & ~0xF) >>> 0;
const write_reg = (index, value) => { io.port_write32(port + C.SVGA_INDEX_PORT, index); io.port_write32(port + C.SVGA_VALUE_PORT, value); };
const read_reg = index => { io.port_write32(port + C.SVGA_INDEX_PORT, index); return io.port_read32(port + C.SVGA_VALUE_PORT) >>> 0; };
const write32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
const read32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;
const fifo_write = (index, value) => write32(fifo + index * 4, value);
const fifo_read = index => read32(fifo + index * 4);

// The level: the video overlay's FIFO capability, GL's provoking vertex
write_reg(C.SVGA_REG_ID, C.SVGA_ID_2);
write_reg(C.SVGA_REG_DEV_CAP, C.SVGA3D_DEVCAP_DX_PROVOKING_VERTEX);
assert.equal(read_reg(C.SVGA_REG_DEV_CAP), 1, "DX_PROVOKING_VERTEX");

// A 64x48x32 mode: the left half has the color key (magenta), the right not
const W = 64, H = 48, KEY = 0x00FF00FF, OTHER = 0x00102030;
write_reg(C.SVGA_REG_WIDTH, W);
write_reg(C.SVGA_REG_HEIGHT, H);
write_reg(C.SVGA_REG_BITS_PER_PIXEL, 32);
write_reg(C.SVGA_REG_ENABLE, C.SVGA_REG_ENABLE_ENABLE);
const pitch = read_reg(C.SVGA_REG_BYTES_PER_LINE);
for(let y = 0; y < H; y++) for(let x = 0; x < W; x++) write32(fb + y * pitch + x * 4, x < W / 2 ? KEY : OTHER);

const MIN = 0x1000, MAX = 0x10000;
fifo_write(C.SVGA_FIFO_MIN, MIN);
fifo_write(C.SVGA_FIFO_MAX, MAX);
fifo_write(C.SVGA_FIFO_NEXT_CMD, MIN);
fifo_write(C.SVGA_FIFO_STOP, MIN);
write_reg(C.SVGA_REG_CONFIG_DONE, 1);
assert.ok(fifo_read(C.SVGA_FIFO_CAPABILITIES) & C.SVGA_FIFO_CAP_VIDEO, "SVGA_FIFO_CAP_VIDEO");
let next = MIN;
const submit = (...dwords) => {
    for(const dword of dwords)
    {
        write32(fifo + next, dword);
        next = next + 4 === MAX ? MIN : next + 4;
    }
    fifo_write(C.SVGA_FIFO_NEXT_CMD, next);
    write_reg(C.SVGA_REG_SYNC, 1);
    assert.equal(fifo_read(C.SVGA_FIFO_STOP), next, "consumed");
};
const SET_REGS = 0x00020001, FLUSH = 0x00020002;
const R = { ENABLED: 0, FLAGS: 1, DATA_OFFSET: 2, FORMAT: 3, COLORKEY: 4, SIZE: 5, WIDTH: 6, HEIGHT: 7, SRC_X: 8, SRC_Y: 9,
    SRC_WIDTH: 10, SRC_HEIGHT: 11, DST_X: 12, DST_Y: 13, DST_WIDTH: 14, DST_HEIGHT: 15, PITCH_1: 16, PITCH_2: 17, PITCH_3: 18,
    DATA_GMRID: 19, DST_SCREEN_ID: 20 };
const escape = (...payload) => submit(C.SVGA_CMD_ESCAPE, C.SVGA_ESCAPE_NSID_VMWARE, payload.length * 4, ...payload);
const set_regs = (unit, regs) => escape(SET_REGS, unit, ...Object.entries(regs).flatMap(([name, value]) => [R[name], value]));
const flush = unit => escape(FLUSH, unit);

// What the page shows: the layers composed
const screen = new Uint8ClampedArray(W * H * 4);
cpu.devices.display.update_buffer = layers => {
    for(const l of layers)
    {
        for(let y = 0; y < l.buffer_height; y++)
        {
            const from = ((l.buffer_y + y) * l.pixels.width + l.buffer_x) * 4;
            screen.set(l.pixels.data.subarray(from, from + l.buffer_width * 4), ((l.screen_y + y) * W + l.screen_x) * 4);
        }
    }
};
const shown = (x, y) => { cpu.devices.display.request_frame(true); return [...screen.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]; };
const near = (got, want, what) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 2), what + ": " + got + " vs " + want);
near(shown(5, 5), [0xFF, 0, 0xFF], "the picture");

// A YUY2 frame in VRAM, 8x4: white on the left half, black on the right
// (Y 235 and 16, no color), scaled 4x into (16, 8) 32x16
const DATA = 0x100000;
for(let y = 0; y < 4; y++) for(let x = 0; x < 8; x += 2)
{
    const luma = x < 4 ? 235 : 16;
    write32(fb + DATA + y * 16 + x * 2, luma | 128 << 8 | luma << 16 | 128 << 24);
}
set_regs(0, { ENABLED: 1, FLAGS: 1, COLORKEY: KEY, FORMAT: 0x32595559, SIZE: 64, WIDTH: 8, HEIGHT: 4, SRC_X: 0, SRC_Y: 0,
    SRC_WIDTH: 8, SRC_HEIGHT: 4, DST_X: 16, DST_Y: 8, DST_WIDTH: 32, DST_HEIGHT: 16, PITCH_1: 16, DATA_GMRID: C.SVGA_GMR_FRAMEBUFFER,
    DATA_OFFSET: DATA, DST_SCREEN_ID: C.SVGA_ID_INVALID });
flush(0);
near(shown(20, 10), [255, 255, 255], "the video where the picture has the key");
near(shown(40, 10), [0x10, 0x20, 0x30], "the picture where it has not");
near(shown(5, 5), [0xFF, 0, 0xFF], "the picture outside of the rectangle");
assert.equal(read32(fb + 10 * pitch + 20 * 4), KEY, "guest memory is as it was");
console.log("PASS: a YUY2 frame, scaled, with a color key");

// Without the key: the whole rectangle; its right half is the frame's black
set_regs(0, { FLAGS: 0 });
flush(0);
near(shown(20, 10), [255, 255, 255], "the left of the frame");
near(shown(40, 10), [0, 0, 0], "the right of the frame, over the picture");
near(shown(48, 10), [0x10, 0x20, 0x30], "past the rectangle");

// The picture changes under it: still over it
for(let x = 32; x < 48; x++) write32(fb + 10 * pitch + x * 4, 0x00405060);
near(shown(40, 10), [0, 0, 0], "over the picture's new pixels");
console.log("PASS: without a color key, over a changing picture");

// A YV12 frame, 2x2: Y 16, 235, 81, 145, with U 90, V 240 (red's chroma)
const yv12 = [16, 235, 81, 145, 240, 90];
// (elsewhere in VRAM: unit 0 still shows its frame, read again on a restore)
const DATA2 = DATA + 0x1000;
yv12.forEach((v, i) => cpu.write8(fb + DATA2 + i, v));
set_regs(1, { ENABLED: 1, FLAGS: 0, FORMAT: 0x32315659, SIZE: 6, WIDTH: 2, HEIGHT: 2, SRC_WIDTH: 2, SRC_HEIGHT: 2,
    DST_X: 0, DST_Y: 40, DST_WIDTH: 2, DST_HEIGHT: 2, PITCH_1: 2, PITCH_2: 1, PITCH_3: 1, DATA_GMRID: C.SVGA_GMR_FRAMEBUFFER,
    DATA_OFFSET: DATA2, DST_SCREEN_ID: C.SVGA_ID_INVALID });
flush(1);
// (Y 81 with that chroma is BT.601's red)
near(shown(0, 41), [255, 0, 0], "YV12: red");
console.log("PASS: a YV12 frame");

// A snapshot: the units, and their frames read again
const state = await emulator.save_state();
await emulator.restore_state(state);
screen.fill(0);
svga.mode_key = "";
near(shown(20, 10), [255, 255, 255], "unit 0 after a restore");
near(shown(0, 41), [255, 0, 0], "unit 1 after a restore");
console.log("PASS: snapshots");

// Switched off: the picture again
set_regs(0, { ENABLED: 0 });
set_regs(1, { ENABLED: 0 });
near(shown(20, 10), [0xFF, 0, 0xFF], "the picture again");
near(shown(40, 10), [0x40, 0x50, 0x60], "the picture's own pixels");
assert.equal(svga.video.stats.escapes > 0, true);
console.log("PASS: units switched off");

emulator.destroy();
