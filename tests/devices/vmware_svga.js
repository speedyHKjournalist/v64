#!/usr/bin/env node

// The VMware SVGA II adapter (src/graphics_adapters/vmware_svga), driven the
// way a driver does: PCI identity and BARs (what vm3d.inf matches), the
// register interface, modes and pitch, the FIFO (fences, interrupts,
// commands that wrap around the ring, unknown commands, 3D commands skipped
// at the 2D level), RECT_COPY, snapshots and reset. The guests' drivers are
// tested by tests/x64/linux_gpu.mjs.

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

const VRAM = 8 << 20;
const emulator = new V86({
    graphics_adapter: "vmware_svga",
    graphics_adapter_test: { level: "2d" },
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

// PCI identity: exactly what the Windows 8.1 driver's INF matches
assert.equal(pci_read(0x00), 0x040515AD, "VMware SVGA II");
assert.equal(pci_read(0x2C), 0x040515AD, "subsystem 15AD:0405");
assert.equal(pci_read(0x08), 0x03000000, "revision 0, VGA controller");
const bar0 = pci_read(0x10), bar1 = pci_read(0x14), bar2 = pci_read(0x18);
assert.equal(bar0 & 1, 1, "BAR0 is I/O");
assert.equal(bar1 & 0xF, 0x8, "BAR1 is prefetchable memory");
assert.equal(bar2 & 0xF, 0x0, "BAR2 is memory");
const port = bar0 & ~3, fb = (bar1 & ~0xF) >>> 0, fifo = (bar2 & ~0xF) >>> 0;
assert.equal(fb % VRAM, 0, "BAR1 aligned to its size");
assert.equal(fifo % (2 << 20), 0, "BAR2 aligned to its size");
console.log(`SeaBIOS put the ports at ${port.toString(16)}, the frame buffer at ${fb.toString(16)}, the FIFO at ${fifo.toString(16)}`);

const write_reg = (index, value) => { io.port_write32(port + C.SVGA_INDEX_PORT, index); io.port_write32(port + C.SVGA_VALUE_PORT, value); };
const read_reg = index => { io.port_write32(port + C.SVGA_INDEX_PORT, index); return io.port_read32(port + C.SVGA_VALUE_PORT) >>> 0; };
const write32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
const read32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;
const fifo_write = (index, value) => write32(fifo + index * 4, value);
const fifo_read = index => read32(fifo + index * 4);

// Version negotiation: the device keeps the highest it supports
write_reg(C.SVGA_REG_ID, C.SVGA_ID_2);
assert.equal(read_reg(C.SVGA_REG_ID), C.SVGA_ID_2);
write_reg(C.SVGA_REG_ID, C.SVGA_ID_2 + 1);
assert.equal(read_reg(C.SVGA_REG_ID), C.SVGA_ID_2, "SVGA_ID_3 is not taken");

const caps = read_reg(C.SVGA_REG_CAPABILITIES);
for(const cap of ["SVGA_CAP_EXTENDED_FIFO", "SVGA_CAP_PITCHLOCK", "SVGA_CAP_IRQMASK", "SVGA_CAP_RECT_COPY"])
{
    assert.ok(caps & C[cap], cap);
}
assert.equal(caps & C.SVGA_CAP_3D, 0, "no 3D at the 2D level");
assert.equal(read_reg(C.SVGA_REG_FB_START), fb);
assert.equal(read_reg(C.SVGA_REG_MEM_START), fifo);
assert.equal(read_reg(C.SVGA_REG_MEM_SIZE), 2 << 20);
assert.equal(read_reg(C.SVGA_REG_VRAM_SIZE), VRAM);
assert.equal(read_reg(C.SVGA_REG_MEM_REGS), C.SVGA_FIFO_NUM_REGS);
console.log("PASS: PCI identity, BARs and the register interface");

// A mode: 64x48x32, then a locked pitch
const pixel = (x, y) => {
    cpu.devices.display.request_frame(true);
    const p = (y * svga.pixels.width + x) * 4;
    return [...svga.pixels.data.subarray(p, p + 3)];
};
write_reg(C.SVGA_REG_WIDTH, 64);
write_reg(C.SVGA_REG_HEIGHT, 48);
write_reg(C.SVGA_REG_BITS_PER_PIXEL, 32);
assert.equal(read_reg(C.SVGA_REG_DEPTH), 24, "32 bpp has depth 24 (vmwgfx checks it)");
assert.equal(read_reg(C.SVGA_REG_BYTES_PER_LINE), 256);
write_reg(C.SVGA_REG_ENABLE, C.SVGA_REG_ENABLE_ENABLE);
write32(fb + 5 * 256 + 10 * 4, 0x00112233);
assert.deepEqual(pixel(10, 5), [0x11, 0x22, 0x33], "the SVGA mode is on screen");
write_reg(C.SVGA_REG_PITCHLOCK, 512);
assert.equal(read_reg(C.SVGA_REG_BYTES_PER_LINE), 512);
write32(fb + 7 * 512 + 3 * 4, 0x00445566);
assert.deepEqual(pixel(3, 7), [0x44, 0x55, 0x66], "rows are PITCHLOCK bytes apart");
console.log("PASS: modes and pitch");

// The FIFO: a 60 KiB ring after a page of registers
const MIN = 0x1000, MAX = 0x10000;
fifo_write(C.SVGA_FIFO_MIN, MIN);
fifo_write(C.SVGA_FIFO_MAX, MAX);
fifo_write(C.SVGA_FIFO_NEXT_CMD, MIN);
fifo_write(C.SVGA_FIFO_STOP, MIN);
write_reg(C.SVGA_REG_CONFIG_DONE, 1);
assert.equal(fifo_read(C.SVGA_FIFO_CAPABILITIES),
    C.SVGA_FIFO_CAP_FENCE | C.SVGA_FIFO_CAP_PITCHLOCK | C.SVGA_FIFO_CAP_RESERVE, "the device's FIFO capabilities");

let next = MIN;
const submit = (...dwords) => {
    for(const dword of dwords)
    {
        write32(fifo + next, dword);
        next = next + 4 === MAX ? MIN : next + 4;
    }
    fifo_write(C.SVGA_FIFO_NEXT_CMD, next);
    write_reg(C.SVGA_REG_SYNC, 1);
};
const irq_status = () => io.port_read32(port + C.SVGA_IRQSTATUS_PORT) >>> 0;

write_reg(C.SVGA_REG_IRQMASK, C.SVGA_IRQFLAG_ANY_FENCE);
submit(C.SVGA_CMD_FENCE, 0x1234);
assert.equal(fifo_read(C.SVGA_FIFO_FENCE), 0x1234, "the fence passed");
assert.equal(fifo_read(C.SVGA_FIFO_STOP), next, "the device consumed the command");
assert.equal(fifo_read(C.SVGA_FIFO_BUSY), 0);
assert.ok(irq_status() & C.SVGA_IRQFLAG_ANY_FENCE, "fence interrupt");
io.port_write32(port + C.SVGA_IRQSTATUS_PORT, C.SVGA_IRQFLAG_ANY_FENCE);
assert.equal(irq_status() & C.SVGA_IRQFLAG_ANY_FENCE, 0, "written 1 clears it");

// A command that wraps around the end of the ring
next = MAX - 4;
fifo_write(C.SVGA_FIFO_STOP, next);
fifo_write(C.SVGA_FIFO_NEXT_CMD, next);
submit(C.SVGA_CMD_FENCE, 0x5678);
assert.equal(fifo_read(C.SVGA_FIFO_FENCE), 0x5678, "a command split by the end of the ring");
assert.equal(fifo_read(C.SVGA_FIFO_STOP), MIN + 4);

// RECT_COPY within the frame buffer (pitch 512)
write32(fb + 1 * 512 + 1 * 4, 0x00FF0000);
submit(C.SVGA_CMD_RECT_COPY, 1, 1, 20, 9, 1, 1);
assert.deepEqual(pixel(20, 9), [0xFF, 0, 0], "RECT_COPY");

// 3D commands are skipped by their header at this level; unknown commands
// cannot be skipped: an error interrupt, and the FIFO is drained
submit(C.SVGA_3D_CMD_SURFACE_DEFINE, 8, 0, 0, C.SVGA_CMD_FENCE, 0x9ABC);
assert.equal(fifo_read(C.SVGA_FIFO_FENCE), 0x9ABC, "a 3D command skipped by its size");
write_reg(C.SVGA_REG_IRQMASK, C.SVGA_IRQFLAG_ERROR);
submit(0x7777, C.SVGA_CMD_FENCE, 0xDEF0);
assert.ok(irq_status() & C.SVGA_IRQFLAG_ERROR, "unknown command: error interrupt");
assert.equal(fifo_read(C.SVGA_FIFO_STOP), next, "and nothing left to parse");
assert.equal(fifo_read(C.SVGA_FIFO_FENCE), 0x9ABC, "the fence behind it is not run");
io.port_write32(port + C.SVGA_IRQSTATUS_PORT, 0xFFFFFFFF);
console.log("PASS: the FIFO: fences, interrupts, wrapping, RECT_COPY, 3D and unknown commands");

// Snapshots: registers, the FIFO and the frame buffer
const state = await emulator.save_state();
write_reg(C.SVGA_REG_PITCHLOCK, 0);
write_reg(C.SVGA_REG_WIDTH, 32);
submit(C.SVGA_CMD_FENCE, 0x1111);
await emulator.restore_state(state);
assert.equal(read_reg(C.SVGA_REG_PITCHLOCK), 512);
assert.equal(read_reg(C.SVGA_REG_WIDTH), 64);
assert.equal(fifo_read(C.SVGA_FIFO_FENCE), 0x9ABC, "FIFO memory comes back");
assert.deepEqual(pixel(20, 9), [0xFF, 0, 0], "the frame buffer comes back");
console.log("PASS: snapshots");

// A machine reset hands the screen back to VGA
cpu.reboot_internal("test");
assert.equal(read_reg(C.SVGA_REG_ENABLE), 0);
assert.equal(read_reg(C.SVGA_REG_CONFIG_DONE), 0);
console.log("PASS: reset");

await emulator.destroy();

// ---------------------------------------------------------------------------
// The whole 2D device (level 2d-full): guest memory regions, screen objects,
// command buffers, the hardware cursor

{
    const vm = new V86({
        graphics_adapter: "vmware_svga",
        graphics_adapter_test: { level: "2d-full" },
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        fda: { buffer: floppy.buffer },
        boot_order: 0x321, autostart: true, memory_size: 32 << 20, vram_size: VRAM,
        net_device: { type: "none" }, disable_speaker: true, log_level: 0,
    });
    await new Promise(resolve => vm.add_listener("emulator-ready", resolve));
    await vm.wait_until_vga_screen_contains("Booting from Floppy", { timeout_msec: 30000 });
    await vm.stop();
    const cpu = vm.v86.cpu, io = cpu.io, svga = cpu.devices.graphics_adapter.device["svga"];
    const port = pci_read_on(io, 0x10) & ~3, fifo = (pci_read_on(io, 0x18) & ~0xF) >>> 0;
    const reg = (index, value) => { io.port_write32(port, index); if(value === undefined) return io.port_read32(port + 1) >>> 0; io.port_write32(port + 1, value); };
    const w32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
    const r32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;

    const caps = reg(C.SVGA_REG_CAPABILITIES);
    for(const cap of ["SVGA_CAP_GMR", "SVGA_CAP_GMR2", "SVGA_CAP_SCREEN_OBJECT_2", "SVGA_CAP_COMMAND_BUFFERS",
        "SVGA_CAP_CMD_BUFFERS_2", "SVGA_CAP_CURSOR", "SVGA_CAP_ALPHA_CURSOR", "SVGA_CAP_MULTIMON", "SVGA_CAP_DISPLAY_TOPOLOGY"])
    {
        assert.ok(caps & C[cap], cap);
    }
    assert.ok(reg(C.SVGA_REG_GMR_MAX_IDS) > 0 && reg(C.SVGA_REG_GMRS_MAX_PAGES) > 0 && reg(C.SVGA_REG_MEMORY_SIZE) >= 64 << 20);

    reg(C.SVGA_REG_ENABLE, C.SVGA_REG_ENABLE_ENABLE);
    const MIN = 0x1000, MAX = 0x10000;
    w32(fifo, MIN); w32(fifo + 4, MAX); w32(fifo + 8, MIN); w32(fifo + 12, MIN);
    reg(C.SVGA_REG_CONFIG_DONE, 1);
    let next = MIN;
    const submit = (...dwords) => {
        for(const d of dwords) { w32(fifo + next, d); next = next + 4 === MAX ? MIN : next + 4; }
        w32(fifo + 8, next);
        reg(C.SVGA_REG_SYNC, 1);
    };

    // GMR1: a descriptor page at 1 MiB naming two pages at 2 MiB
    w32(0x100000, 0x200); w32(0x100004, 2); w32(0x100008, 0); w32(0x10000C, 0);
    reg(C.SVGA_REG_GMR_ID, 1);
    reg(C.SVGA_REG_GMR_DESCRIPTOR, 0x100);
    assert.deepEqual([...svga.gmrs.regions.get(1)], [0x200, 0x201], "GMR1 from its descriptor chain");

    // a 16x16 screen object (no backing store), filled from a GMRFB in GMR 1
    for(let i = 0; i < 16 * 16; i++) w32(0x200000 + i * 4, 0x00102030 + i);   // BGRX
    submit(C.SVGA_CMD_DEFINE_SCREEN, 44, 0, C.SVGA_SCREEN_MUST_BE_SET | C.SVGA_SCREEN_IS_PRIMARY, 16, 16, 0, 0,
        C.SVGA_GMR_NULL, 0, 0, 0);
    submit(C.SVGA_CMD_DEFINE_GMRFB, 1, 0, 64, 32 | 24 << 8);
    submit(C.SVGA_CMD_BLIT_GMRFB_TO_SCREEN, 0, 0, 0, 0, 16, 16, 0);
    const screen = svga.screens.screens.get(0);
    assert.deepEqual([...screen.rgba.subarray(0, 4)], [0x10, 0x20, 0x30, 255], "BLIT_GMRFB_TO_SCREEN converts BGRX");
    assert.deepEqual([...screen.rgba.subarray(17 * 4, 17 * 4 + 3)], [0x10, 0x20, 0x30 + 17], "row and column");

    // GMR2 defined and remapped by commands, read back into by BLIT_SCREEN_TO_GMRFB
    submit(C.SVGA_CMD_DEFINE_GMR2, 2, 2);
    submit(C.SVGA_CMD_REMAP_GMR2, 2, C.SVGA_REMAP_GMR2_PPN32, 0, 2, 0x300, 0x301);
    assert.deepEqual([...svga.gmrs.regions.get(2)], [0x300, 0x301], "REMAP_GMR2");
    submit(C.SVGA_CMD_DEFINE_GMRFB, 2, 0, 64, 32 | 24 << 8);
    submit(C.SVGA_CMD_BLIT_SCREEN_TO_GMRFB, 0, 0, 0, 0, 16, 16, 0);
    assert.equal(r32(0x300000 + 17 * 4) & 0xFFFFFF, 0x102030 + 17, "BLIT_SCREEN_TO_GMRFB");

    // a screen backed by the frame buffer (vmwgfx's screen object unit), next
    // to the first: shows VRAM, refreshed where UPDATE says
    const fb = (pci_read_on(io, 0x14) & ~0xF) >>> 0;
    w32(fb + 0x1000 + 3 * 32 + 2 * 4, 0x00AABBCC);
    submit(C.SVGA_CMD_DEFINE_SCREEN, 44, 1, 0, 8, 8, 16, 0, C.SVGA_GMR_FRAMEBUFFER, 0x1000, 32, 0);
    const backed = svga.screens.screens.get(1);
    assert.deepEqual([...backed.rgba.subarray((3 * 8 + 2) * 4, (3 * 8 + 2) * 4 + 3)], [0xAA, 0xBB, 0xCC], "a screen in VRAM");
    w32(fb + 0x1000 + 4 * 32 + 5 * 4, 0x00010203);
    submit(C.SVGA_CMD_UPDATE, 16 + 5, 4, 1, 1);
    assert.deepEqual([...backed.rgba.subarray((4 * 8 + 5) * 4, (4 * 8 + 5) * 4 + 3)], [1, 2, 3], "UPDATE in desktop coordinates");
    submit(C.SVGA_CMD_DESTROY_SCREEN, 1);
    console.log("PASS: GMR1, GMR2, screen objects and their blits");

    // what the screen sends to the display: the screen, then the cursor over it
    let layers = [];
    cpu.devices.display.update_buffer = l => { layers = layers.concat(l); };
    cpu.devices.display.request_frame(true);
    assert.equal(layers.length, 1, "one screen, one layer");
    assert.equal(layers[0].pixels.data, screen.rgba);
    submit(C.SVGA_CMD_DEFINE_ALPHA_CURSOR, 0, 1, 1, 2, 2, 0xFFFF0000, 0xFFFF0000, 0xFFFF0000, 0xFFFF0000);
    w32(fifo + C.SVGA_FIFO_CURSOR_ON * 4, 1);
    w32(fifo + C.SVGA_FIFO_CURSOR_X * 4, 5);
    w32(fifo + C.SVGA_FIFO_CURSOR_Y * 4, 6);
    w32(fifo + C.SVGA_FIFO_CURSOR_SCREEN_ID * 4, C.SVGA_ID_INVALID);
    w32(fifo + C.SVGA_FIFO_CURSOR_COUNT * 4, 1);
    layers = [];
    cpu.devices.display.request_frame(false);
    const patch = layers[layers.length - 1];
    assert.equal(patch.screen_x, 4, "the hotspot at (1, 1)");
    assert.equal(patch.screen_y, 5);
    assert.deepEqual([...patch.pixels.data.subarray(0, 4)], [255, 0, 0, 255], "an opaque red alpha cursor");
    w32(fifo + C.SVGA_FIFO_CURSOR_X * 4, 9);
    w32(fifo + C.SVGA_FIFO_CURSOR_COUNT * 4, 2);
    layers = [];
    cpu.devices.display.request_frame(false);
    assert.equal(layers[0].screen_x, 4, "moving it first restores the picture under its old place");
    assert.equal(layers[0].pixels.data, screen.rgba);
    assert.equal(layers[layers.length - 1].screen_x, 8);
    console.log("PASS: the cursor is drawn over the screen and erased where it was");

    // command buffers: a header at 4 MiB, its commands at 4 MiB + 4 KiB
    const header = 0x400000, commands = 0x401000;
    const command_buffer = (context, flags, ...dwords) => {
        dwords.forEach((d, i) => w32(commands + i * 4, d));
        for(let i = 0; i < 64; i += 4) w32(header + i, 0);
        w32(header + 16, flags); w32(header + 20, dwords.length * 4); w32(header + 24, commands);
        reg(C.SVGA_REG_COMMAND_HIGH, 0);
        reg(C.SVGA_REG_COMMAND_LOW, header | context);
        return [r32(header), r32(header + 4)];
    };
    reg(C.SVGA_REG_IRQMASK, C.SVGA_IRQFLAG_COMMAND_BUFFER | C.SVGA_IRQFLAG_ANY_FENCE);
    io.port_write32(port + 8, 0xFFFFFFFF);
    assert.deepEqual(command_buffer(C.SVGA_CB_CONTEXT_DEVICE, 0, C.SVGA_DC_CMD_START_STOP_CONTEXT, 1, 0), [C.SVGA_CB_STATUS_COMPLETED, 0]);
    assert.deepEqual(command_buffer(0, 0, C.SVGA_CMD_FENCE, 0x4242), [C.SVGA_CB_STATUS_COMPLETED, 0], "a command buffer completes");
    assert.equal(r32(fifo + C.SVGA_FIFO_FENCE * 4), 0x4242, "its fence passed");
    assert.ok(io.port_read32(port + 8) & C.SVGA_IRQFLAG_COMMAND_BUFFER, "and interrupted");
    io.port_write32(port + 8, 0xFFFFFFFF);
    command_buffer(0, C.SVGA_CB_FLAG_NO_IRQ, C.SVGA_CMD_NOP);
    assert.equal(io.port_read32(port + 8) & C.SVGA_IRQFLAG_COMMAND_BUFFER, 0, "SVGA_CB_FLAG_NO_IRQ");
    assert.deepEqual(command_buffer(0, 0, C.SVGA_CMD_NOP, 0x7777, C.SVGA_CMD_NOP), [C.SVGA_CB_STATUS_COMMAND_ERROR, 4],
        "an unknown command: COMMAND_ERROR at its offset");
    console.log("PASS: command buffers");

    // snapshots keep the regions, the screens and the cursor
    const state = await vm.save_state();
    submit(C.SVGA_CMD_DESTROY_SCREEN, 0);
    submit(C.SVGA_CMD_DEFINE_GMR2, 2, 0);
    await vm.restore_state(state);
    assert.deepEqual([...svga.gmrs.regions.get(2)], [0x300, 0x301]);
    assert.deepEqual([...svga.screens.screens.get(0).rgba.subarray(17 * 4, 17 * 4 + 3)], [0x10, 0x20, 0x30 + 17]);
    assert.equal(svga.cursor.width, 2);
    console.log("PASS: snapshots of the 2d-full level");
    await vm.destroy();
}

function pci_read_on(io, reg)
{
    io.port_write32(0xcf8, 0x80000000 | 0x12 << 3 << 8 | reg);
    return io.port_read32(0xcfc) >>> 0;
}
