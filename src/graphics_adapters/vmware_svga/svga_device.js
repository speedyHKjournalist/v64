// The VMware SVGA II adapter (15AD:0405), the device side: the register
// interface, the command FIFO, the 2D commands and interrupts, on top of the
// VGA core for the BIOS, DOS and boot screens. What it declares is set by its
// level (LEVELS); see docs/vmware-svga-virtio-gpu-plan.zh-CN.md, section 5.
//
// PCI: BAR0 I/O (index +0, value +1, BIOS +2, IRQ status +8), BAR1 the frame
// buffer (the VGA core's LFB region), BAR2 the FIFO (its own device memory).

import { LOG_VGA } from "../../const.js";
import { h } from "../../lib.js";
import { dbg_log } from "../../log.js";
import { VGAScreen } from "../vga_core.js";
import * as C from "./svga_constants.js";

// For Types Only
import { DisplaySource } from "../../display.js";
import { GraphicsMachine } from "../machine.js";

const DEFAULT_VRAM_SIZE = 32 << 20;
const MIN_VRAM_SIZE = 4 << 20;
const FIFO_SIZE = 2 << 20;
const IO_SIZE = 16;

// Where the BARs start out; SeaBIOS assigns them
const FIFO_INITIAL_ADDRESS = 0xFD000000;

const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1600;
const SCRATCH_SIZE = 64;

/** The FIFO's register area, in dwords, that the driver must leave free */
const FIFO_REGS = C.SVGA_FIFO_NUM_REGS;

/**
 * What each level declares. A level is fixed once chosen: a snapshot keeps it.
 * @type {!Object<string, {caps: number, fifo_caps: number}>}
 */
export const LEVELS = {
    // S1: modes through the registers, the FIFO with UPDATE/RECT_COPY/FENCE,
    // interrupts. No hardware cursor yet (the guest draws its own).
    "2d": {
        caps: C.SVGA_CAP_RECT_COPY | C.SVGA_CAP_EXTENDED_FIFO | C.SVGA_CAP_PITCHLOCK |
            C.SVGA_CAP_IRQMASK | C.SVGA_CAP_TRACES,
        fifo_caps: C.SVGA_FIFO_CAP_FENCE | C.SVGA_FIFO_CAP_PITCHLOCK | C.SVGA_FIFO_CAP_RESERVE,
    },
};

/** Lowest to highest; without a pinned level the highest is used */
export const LEVEL_ORDER = ["2d"];

/**
 * @param {number} bpp
 * @return {number}
 */
function bytes_per_pixel(bpp)
{
    return bpp === 15 ? 2 : bpp >> 3;
}

/**
 * @constructor
 * @implements {DisplaySource}
 * @param {GraphicsMachine} machine
 * @param {{vram_size: (number|undefined), level: (string|undefined)}} options
 */
export function SVGADevice(machine, options)
{
    /** @const */
    this.machine = machine;

    /** @const */
    this.display = machine.display;

    const level = options.level || LEVEL_ORDER[LEVEL_ORDER.length - 1];
    if(!LEVELS[level])
    {
        throw new Error("vmware_svga: unknown level " + JSON.stringify(level) + "; levels: " + LEVEL_ORDER.join(", "));
    }
    /** @const @type {string} */
    this.level = level;
    this.caps = LEVELS[level].caps;
    this.fifo_caps = LEVELS[level].fifo_caps;

    const vram_size = options.vram_size || DEFAULT_VRAM_SIZE;
    if(vram_size < MIN_VRAM_SIZE)
    {
        throw new Error("vmware_svga: vram_size must be at least " + (MIN_VRAM_SIZE >> 20) + " MiB");
    }
    /** @const @type {number} */
    this.vram_size = vram_size;

    // The VGA core: legacy VGA, VBE and the frame buffer memory (BAR1). This
    // device is the PCI function and the display source.
    /** @const */
    this.vga = new VGAScreen(machine, vram_size, { pci: false, display_source: false });

    // The FIFO: device memory the guest writes at memory speed
    this.fifo_region = machine.mmio_ram_allocate(FIFO_SIZE);
    if(this.fifo_region < 0)
    {
        throw new Error("vmware_svga: no device memory for the FIFO");
    }
    this.fifo_backing = machine.mmio_ram_backing(this.fifo_region) >>> 0;
    this.fifo_address = 0;
    /** @type {Int32Array} */
    this.fifo_view = null;
    this.move_fifo(FIFO_INITIAL_ADDRESS);

    this.io_base = machine.allocate_io(IO_SIZE);

    this.palette = new Uint8Array(3 * 256);
    this.scratch = new Int32Array(SCRATCH_SIZE);

    // The picture of the SVGA mode, in wasm memory (mmio_ram_allocate_pixels)
    this.pixels = null;
    this.pixels_offset = 0;
    this.mode_key = "";
    this.showing = false;
    this.pci_registered = false;

    this.reset();

    this.register_ports();
    machine.register_pci({
        pci_space: this.create_pci_space(),
        pci_bars: [
            { size: IO_SIZE, on_move: undefined },
            { size: vram_size, on_move: base => this.vga.move_lfb(base) },
            { size: FIFO_SIZE, on_move: base => this.move_fifo(base) },
        ],
        pci_rom_size: this.vga.pci_rom_size,
        pci_rom_address: this.vga.pci_rom_address,
    });
    this.pci_registered = true;
    this.display.add_source(this);
}

/**
 * A machine reset: back to VGA, the FIFO not configured
 */
SVGADevice.prototype.reset = function()
{
    this.index = 0;
    this.id = C.SVGA_ID_2;
    this.enable = 0;
    this.width = 1024;
    this.height = 768;
    this.bpp = 32;
    this.pitchlock = 0;
    this.guest_id = 0;
    this.config_done = false;
    this.traces = 0;
    this.irq_mask = 0;
    this.irq_status = 0;
    this.num_guest_displays = 0;
    this.display_id = 0;
    this.palette.fill(0);
    this.scratch.fill(0);
    this.update_irq();
    this.init_fifo_registers();
    this.update_scanout();
};

/**
 * @return {!Array<number>}
 */
SVGADevice.prototype.create_pci_space = function()
{
    const io = this.io_base | 1;
    const lfb = this.vga.lfb_address | 0x08;  // prefetchable
    const fifo = this.fifo_address;
    const pci_space = [
        0xAD, 0x15, 0x05, 0x04,     // VMware, SVGA II
        0x03, 0x00, 0x00, 0x00,     // command: I/O and memory; status
        0x00, 0x00, 0x00, 0x03,     // revision 0 (vm3d.inf: REV_00), VGA controller
        0x00, 0x00, 0x00, 0x00,
        io & 0xFF, io >> 8 & 0xFF, 0x00, 0x00,                                  // BAR0
        lfb & 0xFF, lfb >> 8 & 0xFF, lfb >> 16 & 0xFF, lfb >>> 24,              // BAR1
        fifo & 0xFF, fifo >> 8 & 0xFF, fifo >> 16 & 0xFF, fifo >>> 24,          // BAR2
        0x00, 0x00, 0x00, 0x00,     // BAR3
        0x00, 0x00, 0x00, 0x00,     // BAR4
        0x00, 0x00, 0x00, 0x00,     // BAR5
        0x00, 0x00, 0x00, 0x00,
        0xAD, 0x15, 0x05, 0x04,     // subsystem 15AD:0405 (vm3d.inf: SUBSYS_040515AD)
        0x00, 0x00, 0x00, 0x00,     // expansion ROM (v86's ROM BAR)
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00,     // interrupt pin A
    ];
    return pci_space;
};

SVGADevice.prototype.register_ports = function()
{
    const machine = this.machine;
    const base = this.io_base;
    machine.register_read(base + C.SVGA_INDEX_PORT, this,
        function(port) { return this.index & 0xFF; }, undefined, function(port) { return this.index; });
    machine.register_write(base + C.SVGA_INDEX_PORT, this,
        function(value) { this.index = value; }, undefined, function(value) { this.index = value >>> 0; });
    machine.register_read(base + C.SVGA_VALUE_PORT, this,
        function(port) { return this.read_register(this.index) & 0xFF; }, undefined,
        function(port) { return this.read_register(this.index) | 0; });
    machine.register_write(base + C.SVGA_VALUE_PORT, this,
        undefined, undefined, function(value) { this.write_register(this.index, value >>> 0); });
    machine.register_read(base + C.SVGA_BIOS_PORT, this,
        function(port) { return 0; }, undefined, function(port) { return 0; });
    machine.register_write(base + C.SVGA_BIOS_PORT, this,
        function(value) {}, undefined, function(value) {});
    machine.register_read(base + C.SVGA_IRQSTATUS_PORT, this,
        function(port) { return this.irq_status & 0xFF; }, undefined, function(port) { return this.irq_status; });
    machine.register_write(base + C.SVGA_IRQSTATUS_PORT, this,
        function(value) { this.clear_irq(value); }, undefined, function(value) { this.clear_irq(value); });
};

/**
 * @param {number} base
 */
SVGADevice.prototype.move_fifo = function(base)
{
    this.fifo_address = base >>> 0;
    this.machine.mmio_ram_map(this.fifo_region, this.fifo_address);
};

/**
 * The FIFO as dwords (a view of wasm memory, made again after it grows)
 * @return {!Int32Array}
 */
SVGADevice.prototype.fifo = function()
{
    const buffer = this.machine.wasm_memory.buffer;
    if(!this.fifo_view || this.fifo_view.buffer !== buffer)
    {
        this.fifo_view = new Int32Array(buffer, this.fifo_backing, FIFO_SIZE >> 2);
    }
    return this.fifo_view;
};

/**
 * What the device writes into the FIFO register area for the driver
 */
SVGADevice.prototype.init_fifo_registers = function()
{
    const fifo = this.fifo();
    fifo[C.SVGA_FIFO_CAPABILITIES] = this.fifo_caps;
    fifo[C.SVGA_FIFO_FLAGS] = 0;
    fifo[C.SVGA_FIFO_3D_HWVERSION] = 0;
    fifo[C.SVGA_FIFO_3D_HWVERSION_REVISED] = 0;
    Atomics.store(fifo, C.SVGA_FIFO_BUSY, 0);
};

// ---------------------------------------------------------------------------
// Registers

/**
 * @param {number} index
 * @return {number}
 */
SVGADevice.prototype.read_register = function(index)
{
    switch(index)
    {
        case C.SVGA_REG_ID: return this.id;
        case C.SVGA_REG_ENABLE: return this.enable;
        case C.SVGA_REG_WIDTH: return this.width;
        case C.SVGA_REG_HEIGHT: return this.height;
        case C.SVGA_REG_MAX_WIDTH: return MAX_WIDTH;
        case C.SVGA_REG_MAX_HEIGHT: return MAX_HEIGHT;
        case C.SVGA_REG_DEPTH: return this.bpp === 32 ? 24 : this.bpp;
        case C.SVGA_REG_BITS_PER_PIXEL: return this.bpp;
        case C.SVGA_REG_HOST_BITS_PER_PIXEL: return 32;
        case C.SVGA_REG_PSEUDOCOLOR: return this.bpp === 8 ? 1 : 0;
        case C.SVGA_REG_RED_MASK: return this.bpp === 16 ? 0xF800 : this.bpp === 15 ? 0x7C00 : 0xFF0000;
        case C.SVGA_REG_GREEN_MASK: return this.bpp === 16 ? 0x07E0 : this.bpp === 15 ? 0x03E0 : 0x00FF00;
        case C.SVGA_REG_BLUE_MASK: return this.bpp === 16 || this.bpp === 15 ? 0x001F : 0x0000FF;
        case C.SVGA_REG_BYTES_PER_LINE: return this.pitch();
        case C.SVGA_REG_FB_START: return this.vga.lfb_address;
        case C.SVGA_REG_FB_OFFSET: return 0;
        case C.SVGA_REG_VRAM_SIZE: return this.vram_size;
        case C.SVGA_REG_FB_SIZE: return this.pitch() * this.height;
        case C.SVGA_REG_CAPABILITIES: return this.caps;
        case C.SVGA_REG_MEM_START: return this.fifo_address;
        case C.SVGA_REG_MEM_SIZE: return FIFO_SIZE;
        case C.SVGA_REG_CONFIG_DONE: return +this.config_done;
        case C.SVGA_REG_SYNC: return 0;
        case C.SVGA_REG_BUSY:
            // The FIFO is processed synchronously: it is idle once processed
            this.process_fifo();
            return 0;
        case C.SVGA_REG_GUEST_ID: return this.guest_id;
        case C.SVGA_REG_SCRATCH_SIZE: return SCRATCH_SIZE;
        case C.SVGA_REG_MEM_REGS: return FIFO_REGS;
        case C.SVGA_REG_NUM_DISPLAYS: return 1;
        case C.SVGA_REG_PITCHLOCK: return this.pitchlock;
        case C.SVGA_REG_IRQMASK: return this.irq_mask;
        case C.SVGA_REG_NUM_GUEST_DISPLAYS: return this.num_guest_displays;
        case C.SVGA_REG_DISPLAY_ID: return this.display_id;
        case C.SVGA_REG_TRACES: return this.traces;
    }
    if(index >= C.SVGA_PALETTE_BASE && index < C.SVGA_PALETTE_BASE + C.SVGA_NUM_PALETTE_REGS)
    {
        return this.palette[index - C.SVGA_PALETTE_BASE];
    }
    if(index >= C.SVGA_SCRATCH_BASE && index < C.SVGA_SCRATCH_BASE + SCRATCH_SIZE)
    {
        return this.scratch[index - C.SVGA_SCRATCH_BASE] >>> 0;
    }
    dbg_log("svga: read of unimplemented register " + index, LOG_VGA);
    return 0;
};

/**
 * @param {number} index
 * @param {number} value
 */
SVGADevice.prototype.write_register = function(index, value)
{
    switch(index)
    {
        case C.SVGA_REG_ID:
            // The driver offers the highest version it knows and reads back
            // what the device takes
            if(value >= C.SVGA_ID_0 && value <= C.SVGA_ID_2) this.id = value;
            break;
        case C.SVGA_REG_ENABLE:
            this.enable = value & (C.SVGA_REG_ENABLE_ENABLE | C.SVGA_REG_ENABLE_HIDE);
            this.update_scanout();
            break;
        case C.SVGA_REG_WIDTH:
            if(value > 0 && value <= MAX_WIDTH) this.width = value;
            this.update_scanout();
            break;
        case C.SVGA_REG_HEIGHT:
            if(value > 0 && value <= MAX_HEIGHT) this.height = value;
            this.update_scanout();
            break;
        case C.SVGA_REG_BITS_PER_PIXEL:
            if(value === 8 || value === 15 || value === 16 || value === 24 || value === 32) this.bpp = value;
            this.update_scanout();
            break;
        case C.SVGA_REG_CONFIG_DONE:
            this.config_done = !!value;
            if(this.config_done)
            {
                // the driver has set MIN/MAX/NEXT/STOP; the capabilities it
                // reads next are the device's
                this.init_fifo_registers();
            }
            break;
        case C.SVGA_REG_SYNC:
            this.process_fifo();
            break;
        case C.SVGA_REG_GUEST_ID:
            this.guest_id = value;
            break;
        case C.SVGA_REG_PITCHLOCK:
            this.pitchlock = value;
            this.update_scanout();
            break;
        case C.SVGA_REG_IRQMASK:
            this.irq_mask = value;
            this.update_irq();
            break;
        case C.SVGA_REG_NUM_GUEST_DISPLAYS:
            this.num_guest_displays = value;
            break;
        case C.SVGA_REG_DISPLAY_ID:
            this.display_id = value;
            break;
        case C.SVGA_REG_TRACES:
            this.traces = value;
            break;
        default:
            if(index >= C.SVGA_PALETTE_BASE && index < C.SVGA_PALETTE_BASE + C.SVGA_NUM_PALETTE_REGS)
            {
                this.palette[index - C.SVGA_PALETTE_BASE] = value;
                this.mode_key = "";
            }
            else if(index >= C.SVGA_SCRATCH_BASE && index < C.SVGA_SCRATCH_BASE + SCRATCH_SIZE)
            {
                this.scratch[index - C.SVGA_SCRATCH_BASE] = value;
            }
            else
            {
                dbg_log("svga: write of unimplemented register " + index + " = " + h(value), LOG_VGA);
            }
    }
};

/**
 * Bytes per line of the SVGA mode
 * @return {number}
 */
SVGADevice.prototype.pitch = function()
{
    if(this.pitchlock) return this.pitchlock;
    const fifo_pitchlock = this.config_done ? this.fifo()[C.SVGA_FIFO_PITCHLOCK] : 0;
    if(fifo_pitchlock > 0) return fifo_pitchlock;
    return this.width * bytes_per_pixel(this.bpp) + 3 & ~3;
};

// ---------------------------------------------------------------------------
// Interrupts

SVGADevice.prototype.update_irq = function()
{
    // (the PCI function, and so its interrupt line, comes after the first reset)
    if(!this.pci_registered) return;
    if(this.irq_status & this.irq_mask) this.machine.raise_irq();
    else this.machine.lower_irq();
};

/** @param {number} flags */
SVGADevice.prototype.set_irq = function(flags)
{
    this.irq_status |= flags;
    this.update_irq();
};

/** @param {number} flags written to the IRQ status port */
SVGADevice.prototype.clear_irq = function(flags)
{
    this.irq_status &= ~flags;
    this.update_irq();
};

// ---------------------------------------------------------------------------
// The FIFO

/**
 * Run the commands between STOP and NEXT_CMD. The ring is [MIN, MAX) in
 * bytes; a command may wrap around its end.
 */
SVGADevice.prototype.process_fifo = function()
{
    if(!this.config_done || !(this.enable & C.SVGA_REG_ENABLE_ENABLE)) return;

    const fifo = this.fifo();
    const min = fifo[C.SVGA_FIFO_MIN], max = fifo[C.SVGA_FIFO_MAX];
    let stop = fifo[C.SVGA_FIFO_STOP];
    if(min < FIFO_REGS * 4 || max > FIFO_SIZE || min >= max || (min | max | stop) & 3 || stop < min || stop >= max)
    {
        dbg_log("svga: FIFO misconfigured: min=" + h(min) + " max=" + h(max) + " stop=" + h(stop), LOG_VGA);
        return;
    }

    let progress = false;
    for(;;)
    {
        // NEXT_CMD is published after the command: read it first
        const next = Atomics.load(fifo, C.SVGA_FIFO_NEXT_CMD);
        if(next === stop) break;
        if(next < min || next >= max || next & 3)
        {
            dbg_log("svga: FIFO NEXT_CMD out of range: " + h(next), LOG_VGA);
            break;
        }
        const available = (next - stop + (max - min)) % (max - min) >> 2;
        const read = n => fifo[(stop - min + 4 * n) % (max - min) + min >> 2];
        const length = this.run_command(read, available);
        if(length === 0) break;       // incomplete: the rest is not written yet
        if(length < 0)
        {
            // unknown command: its length is unknown, nothing after it can be parsed
            this.set_irq(C.SVGA_IRQFLAG_ERROR);
            stop = next;
            Atomics.store(fifo, C.SVGA_FIFO_STOP, stop);
            break;
        }
        stop = (stop - min + 4 * length) % (max - min) + min;
        Atomics.store(fifo, C.SVGA_FIFO_STOP, stop);
        progress = true;
    }

    Atomics.store(fifo, C.SVGA_FIFO_BUSY, 0);
    if(progress) this.set_irq(C.SVGA_IRQFLAG_FIFO_PROGRESS);
};

/**
 * Run one command
 * @param {function(number):number} read the command's dwords, from 0 (the id)
 * @param {number} available dwords written
 * @return {number} its length in dwords, 0 if not all of it is there, -1 if unknown
 */
SVGADevice.prototype.run_command = function(read, available)
{
    const id = read(0) >>> 0;
    const need = n => available >= n;

    switch(id)
    {
        case C.SVGA_CMD_UPDATE:
            if(!need(5)) return 0;
            // the frame buffer's dirty pages already show every write
            return 5;
        case C.SVGA_CMD_UPDATE_VERBOSE:
            if(!need(6)) return 0;
            return 6;
        case C.SVGA_CMD_RECT_COPY:
            if(!need(7)) return 0;
            this.rect_copy(read(1), read(2), read(3), read(4), read(5), read(6));
            return 7;
        case C.SVGA_CMD_FENCE:
            if(!need(2)) return 0;
            this.fence(read(1) >>> 0);
            return 2;
        case C.SVGA_CMD_NOP:
            return 1;
        case C.SVGA_CMD_NOP_ERROR:
            this.set_irq(C.SVGA_IRQFLAG_ERROR);
            return 1;
        case C.SVGA_CMD_ESCAPE:
        {
            if(!need(3)) return 0;
            const size = read(2) >>> 0;
            const length = 3 + (size + 3 >> 2);
            if(!need(length)) return 0;
            dbg_log("svga: escape nsid=" + h(read(1) >>> 0) + " size=" + size + " ignored", LOG_VGA);
            return length;
        }
        case C.SVGA_CMD_DEFINE_CURSOR:
        {
            if(!need(8)) return 0;
            const width = read(4) >>> 0, height = read(5) >>> 0;
            const pixmap = depth => ((width * depth + 31) >>> 5) * height;
            const length = 8 + pixmap(read(6) >>> 0) + pixmap(read(7) >>> 0);
            if(!need(length)) return 0;
            return length;
        }
        case C.SVGA_CMD_DEFINE_ALPHA_CURSOR:
        {
            if(!need(6)) return 0;
            const length = 6 + (read(4) >>> 0) * (read(5) >>> 0);
            if(!need(length)) return 0;
            return length;
        }
    }

    if(id >= C.SVGA_3D_CMD_LEGACY_BASE && id < C.SVGA_3D_CMD_MAX)
    {
        // SVGA3dCmdHeader: id, size in bytes. No 3D at this level.
        if(!need(2)) return 0;
        const length = 2 + ((read(1) >>> 0) + 3 >> 2);
        if(!need(length)) return 0;
        dbg_log("svga: 3D command " + id + " ignored (no 3D at level " + this.level + ")", LOG_VGA);
        return length;
    }

    dbg_log("svga: unknown FIFO command " + id, LOG_VGA);
    return -1;
};

/**
 * @param {number} fence
 */
SVGADevice.prototype.fence = function(fence)
{
    // Commands complete as they are read
    Atomics.store(this.fifo(), C.SVGA_FIFO_FENCE, fence | 0);
    this.set_irq(C.SVGA_IRQFLAG_ANY_FENCE);
};

/**
 * Copy a rectangle of the SVGA frame buffer onto itself
 */
SVGADevice.prototype.rect_copy = function(src_x, src_y, dst_x, dst_y, width, height)
{
    const bpp = bytes_per_pixel(this.bpp), pitch = this.pitch();
    if(width <= 0 || height <= 0 ||
        Math.max(src_x, dst_x) + width > this.width || Math.max(src_y, dst_y) + height > this.height)
    {
        dbg_log("svga: RECT_COPY out of bounds", LOG_VGA);
        return;
    }
    const memory = this.vga.svga_memory;
    const vram = new Uint8Array(memory.buffer, memory.byteOffset, this.vram_size);
    const row = width * bpp;
    // overlapping rectangles: copy rows in the direction that keeps the source
    const downward = dst_y > src_y;
    for(let i = 0; i < height; i++)
    {
        const y = downward ? height - 1 - i : i;
        const from = (src_y + y) * pitch + src_x * bpp;
        vram.copyWithin((dst_y + y) * pitch + dst_x * bpp, from, from + row);
    }
    // (writes from here do not go through the dirty bitmap)
    this.machine.mmio_ram_mark_dirty(this.vga.lfb_region);
};

// ---------------------------------------------------------------------------
// The scanout

/**
 * Whether the SVGA mode, not the VGA core, is on screen
 * @return {boolean}
 */
SVGADevice.prototype.svga_active = function()
{
    return (this.enable & (C.SVGA_REG_ENABLE_ENABLE | C.SVGA_REG_ENABLE_HIDE)) === C.SVGA_REG_ENABLE_ENABLE;
};

/**
 * After a change of ENABLE or of the mode: hand the screen to the right side
 */
SVGADevice.prototype.update_scanout = function()
{
    const active = this.svga_active();
    if(active)
    {
        this.mode_key = "";
    }
    else if(this.showing)
    {
        // back to VGA: the core sends its mode and picture again
        this.vga.redisplay();
    }
    this.showing = active;
};

/** @override */
SVGADevice.prototype.vblank_period = function()
{
    return this.svga_active() ? 1000 / 60 : this.vga.vblank_period();
};

/** @override */
SVGADevice.prototype.on_vblank = function()
{
    this.vga.on_vblank();
    // A driver may write commands without SYNC while the device is busy
    this.process_fifo();
};

/** @override */
SVGADevice.prototype.invalidate = function()
{
    if(this.svga_active())
    {
        this.mode_key = "";
    }
    else
    {
        this.vga.invalidate();
    }
};

/** @override */
SVGADevice.prototype.render = function()
{
    if(!this.svga_active())
    {
        this.vga.render();
        return;
    }

    const bpp = this.bpp, bytes = bytes_per_pixel(bpp), pitch = this.pitch();
    const buffer_width = pitch / bytes | 0;
    const key = this.width + "x" + this.height + "x" + bpp + "/" + pitch;
    if(key !== this.mode_key)
    {
        this.mode_key = key;
        this.display.set_mode(true);
        this.display.set_size_graphical(this.width, this.height, buffer_width, this.height, bpp);
        this.pixels_offset = this.machine.mmio_ram_allocate_pixels(this.vga.lfb_region, buffer_width * this.height) >>> 0;
        this.pixels = null;
        this.machine.mmio_ram_mark_dirty(this.vga.lfb_region);
    }
    // (after the allocation above, which may grow wasm memory)
    const memory = this.machine.wasm_memory.buffer;
    if(!this.pixels || this.pixels.data.buffer !== memory)
    {
        this.pixels = {
            data: new Uint8ClampedArray(memory, this.pixels_offset, 4 * buffer_width * this.height),
            width: buffer_width,
            height: this.height,
        };
    }

    let min_y = 0, max_y = this.height;
    if(bpp === 8)
    {
        // (rare: converted whole, through the palette)
        const out = new Int32Array(memory, this.pixels_offset, buffer_width * this.height);
        const vram = this.vga.svga_memory;
        const source = new Uint8Array(memory, vram.byteOffset, Math.min(this.vram_size, out.length));
        const palette = this.palette;
        for(let i = 0; i < source.length; i++)
        {
            const c = source[i] * 3;
            out[i] = palette[c] | palette[c + 1] << 8 | palette[c + 2] << 16 | 0xFF000000;
        }
    }
    else
    {
        this.machine.mmio_ram_fill_pixels(this.vga.lfb_region, bpp, 0);
        min_y = (this.machine.dirty_min_offset() / bytes | 0) / buffer_width | 0;
        max_y = ((this.machine.dirty_max_offset() / bytes | 0) / buffer_width | 0) + 1;
    }

    min_y = Math.max(min_y, 0);
    max_y = Math.min(max_y, this.height);
    if(min_y < max_y)
    {
        this.display.update_buffer([{
            pixels: this.pixels,
            screen_x: 0, screen_y: min_y,
            buffer_x: 0, buffer_y: min_y,
            buffer_width: this.width,
            buffer_height: max_y - min_y,
        }]);
    }
};

// ---------------------------------------------------------------------------
// Snapshots

const STATE_VERSION = 1;

SVGADevice.prototype.get_state = function()
{
    const fifo = this.fifo();
    return [
        STATE_VERSION, this.level, this.vram_size,
        this.vga.get_state(),
        [this.index, this.id, this.enable, this.width, this.height, this.bpp, this.pitchlock, this.guest_id,
            +this.config_done, this.traces, this.irq_mask, this.irq_status, this.num_guest_displays, this.display_id],
        this.palette, this.scratch,
        new Uint8Array(fifo.buffer, fifo.byteOffset, FIFO_SIZE),
    ];
};

SVGADevice.prototype.set_state = function(state)
{
    if(state[0] !== STATE_VERSION) throw new Error("vmware_svga: unsupported state version " + state[0]);
    if(state[1] !== this.level)
    {
        throw new Error("vmware_svga: the snapshot's device declares level " + state[1] + ", this one " + this.level);
    }
    if(state[2] !== this.vram_size)
    {
        throw new Error("vmware_svga: the snapshot has vram_size " + state[2] + ", this machine " + this.vram_size);
    }
    this.vga.set_state(state[3]);
    [this.index, this.id, this.enable, this.width, this.height, this.bpp, this.pitchlock, this.guest_id,
        this.config_done, this.traces, this.irq_mask, this.irq_status, this.num_guest_displays, this.display_id] = state[4];
    this.config_done = !!this.config_done;
    this.palette.set(state[5]);
    this.scratch.set(state[6]);
    const fifo = this.fifo();
    new Uint8Array(fifo.buffer, fifo.byteOffset, FIFO_SIZE).set(state[7]);
    this.showing = false;
    this.update_scanout();
    this.update_irq();
};
