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
import { GMRTable, GMR_MAX_IDS, GMR_MAX_PAGES, GMR_MAX_DESCRIPTOR_LENGTH, remap_gmr2_payload } from "./svga_gmr.js";
import { ScreenObjects } from "./svga_screens.js";
import { SoftwareCursor, cursor_masks_length } from "./svga_cursor.js";
import { SVGA3D } from "./svga3d.js";

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
/** Displays the guest may define with MULTIMON / screen objects */
const MAX_DISPLAYS = 4;
/** The largest command buffer taken (SVGA_CB_MAX_SIZE) */
const CB_MAX_SIZE = C.SVGA_CB_MAX_SIZE;

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
    // S2: the whole 2D device: guest memory regions, screen objects,
    // multiple displays, the hardware cursor, command buffers
    "2d-full": {
        caps: C.SVGA_CAP_RECT_COPY | C.SVGA_CAP_EXTENDED_FIFO | C.SVGA_CAP_PITCHLOCK |
            C.SVGA_CAP_IRQMASK | C.SVGA_CAP_TRACES |
            C.SVGA_CAP_CURSOR | C.SVGA_CAP_CURSOR_BYPASS | C.SVGA_CAP_CURSOR_BYPASS_2 | C.SVGA_CAP_ALPHA_CURSOR |
            C.SVGA_CAP_8BIT_EMULATION | C.SVGA_CAP_MULTIMON | C.SVGA_CAP_DISPLAY_TOPOLOGY |
            C.SVGA_CAP_GMR | C.SVGA_CAP_GMR2 | C.SVGA_CAP_SCREEN_OBJECT_2 |
            C.SVGA_CAP_COMMAND_BUFFERS | C.SVGA_CAP_CMD_BUFFERS_2 | C.SVGA_CAP_HP_CMD_QUEUE,
        fifo_caps: C.SVGA_FIFO_CAP_FENCE | C.SVGA_FIFO_CAP_PITCHLOCK | C.SVGA_FIFO_CAP_RESERVE |
            C.SVGA_FIFO_CAP_CURSOR_BYPASS_3 | C.SVGA_FIFO_CAP_ESCAPE |
            C.SVGA_FIFO_CAP_SCREEN_OBJECT | C.SVGA_FIFO_CAP_SCREEN_OBJECT_2 | C.SVGA_FIFO_CAP_GMR2,
    },
    // S3: legacy 3D (svga3d.js), what Windows 8.1's vm3d uses without
    // guest-backed objects; needs a renderer
    "vgpu9": {
        caps: C.SVGA_CAP_RECT_COPY | C.SVGA_CAP_EXTENDED_FIFO | C.SVGA_CAP_PITCHLOCK |
            C.SVGA_CAP_IRQMASK | C.SVGA_CAP_TRACES |
            C.SVGA_CAP_CURSOR | C.SVGA_CAP_CURSOR_BYPASS | C.SVGA_CAP_CURSOR_BYPASS_2 | C.SVGA_CAP_ALPHA_CURSOR |
            C.SVGA_CAP_8BIT_EMULATION | C.SVGA_CAP_MULTIMON | C.SVGA_CAP_DISPLAY_TOPOLOGY |
            C.SVGA_CAP_GMR | C.SVGA_CAP_GMR2 | C.SVGA_CAP_SCREEN_OBJECT_2 |
            C.SVGA_CAP_COMMAND_BUFFERS | C.SVGA_CAP_CMD_BUFFERS_2 | C.SVGA_CAP_HP_CMD_QUEUE | C.SVGA_CAP_3D,
        fifo_caps: C.SVGA_FIFO_CAP_FENCE | C.SVGA_FIFO_CAP_PITCHLOCK | C.SVGA_FIFO_CAP_RESERVE |
            C.SVGA_FIFO_CAP_CURSOR_BYPASS_3 | C.SVGA_FIFO_CAP_ESCAPE |
            C.SVGA_FIFO_CAP_SCREEN_OBJECT | C.SVGA_FIFO_CAP_SCREEN_OBJECT_2 | C.SVGA_FIFO_CAP_GMR2,
    },
};

/** Lowest to highest; without a pinned level the highest one there is a renderer for */
export const LEVEL_ORDER = ["2d", "2d-full", "vgpu9"];

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
 * @param {{vram_size: (number|undefined), level: (string|undefined), renderer: (Object|undefined)}} options
 *     renderer: the channel to the 3D renderer ({post, listen}), if there is one
 */
export function SVGADevice(machine, options)
{
    /** @const */
    this.machine = machine;

    /** @const */
    this.display = machine.display;

    const level = options.level || (options.renderer ? "vgpu9" : "2d-full");
    if(!LEVELS[level])
    {
        throw new Error("vmware_svga: unknown level " + JSON.stringify(level) + "; levels: " + LEVEL_ORDER.join(", "));
    }
    if((LEVELS[level].caps & C.SVGA_CAP_3D) && !options.renderer)
    {
        throw new Error("vmware_svga: level " + level + " needs a 3D renderer (WebGPU and libv86-webgpu.js)");
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

    /** @const */
    this.gmrs = new GMRTable(machine, () => this.vram());
    /** @const */
    this.screens = new ScreenObjects(this.gmrs);
    /** @const */
    this.cursor = new SoftwareCursor();
    /** SVGA_REG_DISPLAY_*: [id, primary, x, y, width, height] each */
    this.topology = [];
    /** @const @type {SVGA3D} 3D, at the levels that have it */
    this.svga3d = (LEVELS[level].caps & C.SVGA_CAP_3D) ? new SVGA3D(this, /** @type {!Object} */ (options.renderer)) : null;

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
 * The frame buffer (BAR1), as a view taken now: growing wasm memory detaches
 * older views
 * @return {!Uint8Array}
 */
SVGADevice.prototype.vram = function()
{
    return new Uint8Array(this.machine.wasm_memory.buffer, this.vga.svga_memory.byteOffset, this.vram_size);
};

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
    this.topology = [];
    this.gmr_id = 0;
    this.command_high = 0;
    this.prepend_low = 0;
    this.prepend_high = 0;
    // the guest's place in SVGA_FIFO_CURSOR_COUNT: a change moves the cursor
    this.cursor_count = 0;
    this.cursor_on = 0;
    this.cursor_x = 0;
    this.cursor_y = 0;
    this.palette.fill(0);
    this.scratch.fill(0);
    this.gmrs.reset();
    this.screens.reset();
    this.cursor.reset();
    if(this.svga3d) this.svga3d.reset();
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
    if(this.svga3d) SVGA3D.write_fifo_caps(fifo);
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
        case C.SVGA_REG_NUM_DISPLAYS: return this.caps & C.SVGA_CAP_MULTIMON ? MAX_DISPLAYS : 1;
        case C.SVGA_REG_PITCHLOCK: return this.pitchlock;
        case C.SVGA_REG_IRQMASK: return this.irq_mask;
        case C.SVGA_REG_NUM_GUEST_DISPLAYS: return this.num_guest_displays;
        case C.SVGA_REG_DISPLAY_ID: return this.display_id;
        case C.SVGA_REG_TRACES: return this.traces;
        case C.SVGA_REG_GMR_ID: return this.gmr_id;
        case C.SVGA_REG_GMR_MAX_IDS: return this.caps & C.SVGA_CAP_GMR ? GMR_MAX_IDS : 0;
        case C.SVGA_REG_GMR_MAX_DESCRIPTOR_LENGTH: return this.caps & C.SVGA_CAP_GMR ? GMR_MAX_DESCRIPTOR_LENGTH : 0;
        case C.SVGA_REG_GMRS_MAX_PAGES: return this.caps & C.SVGA_CAP_GMR2 ? GMR_MAX_PAGES : 0;
        case C.SVGA_REG_MEMORY_SIZE: return this.caps & C.SVGA_CAP_GMR2 ? GMR_MAX_PAGES * 4096 : 0;
        case C.SVGA_REG_COMMAND_HIGH: return this.command_high;
        case C.SVGA_REG_CMD_PREPEND_LOW: return this.prepend_low;
        case C.SVGA_REG_CMD_PREPEND_HIGH: return this.prepend_high;
        case C.SVGA_REG_CURSOR_X: return this.cursor_x;
        case C.SVGA_REG_CURSOR_Y: return this.cursor_y;
        case C.SVGA_REG_CURSOR_ON: return this.cursor_on;
        case C.SVGA_REG_DISPLAY_IS_PRIMARY:
        case C.SVGA_REG_DISPLAY_POSITION_X:
        case C.SVGA_REG_DISPLAY_POSITION_Y:
        case C.SVGA_REG_DISPLAY_WIDTH:
        case C.SVGA_REG_DISPLAY_HEIGHT:
        {
            const entry = this.topology[this.display_id];
            return entry ? entry[index - C.SVGA_REG_DISPLAY_IS_PRIMARY + 1] : 0;
        }
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
        case C.SVGA_REG_GMR_ID:
            this.gmr_id = value;
            break;
        case C.SVGA_REG_GMR_DESCRIPTOR:
            if(this.caps & C.SVGA_CAP_GMR && !this.gmrs.define_gmr1(this.gmr_id, value))
            {
                dbg_log("svga: invalid GMR descriptor for GMR " + this.gmr_id, LOG_VGA);
            }
            break;
        case C.SVGA_REG_COMMAND_HIGH:
            this.command_high = value;
            break;
        case C.SVGA_REG_COMMAND_LOW:
            if(this.caps & C.SVGA_CAP_COMMAND_BUFFERS)
            {
                this.submit_command_buffer(this.command_high * 0x100000000 + (value & ~0x3F), value & 0x3F);
            }
            break;
        case C.SVGA_REG_CMD_PREPEND_LOW:
            this.prepend_low = value;
            break;
        case C.SVGA_REG_CMD_PREPEND_HIGH:
            this.prepend_high = value;
            break;
        case C.SVGA_REG_CURSOR_X:
            this.cursor_x = value | 0;
            this.cursor.move(this.cursor_x, this.cursor_y, this.cursor_on === C.SVGA_CURSOR_ON_SHOW);
            break;
        case C.SVGA_REG_CURSOR_Y:
            this.cursor_y = value | 0;
            this.cursor.move(this.cursor_x, this.cursor_y, this.cursor_on === C.SVGA_CURSOR_ON_SHOW);
            break;
        case C.SVGA_REG_CURSOR_ON:
            this.cursor_on = value;
            this.cursor.move(this.cursor_x, this.cursor_y, this.cursor_on === C.SVGA_CURSOR_ON_SHOW);
            break;
        case C.SVGA_REG_DISPLAY_IS_PRIMARY:
        case C.SVGA_REG_DISPLAY_POSITION_X:
        case C.SVGA_REG_DISPLAY_POSITION_Y:
        case C.SVGA_REG_DISPLAY_WIDTH:
        case C.SVGA_REG_DISPLAY_HEIGHT:
            if(this.display_id < MAX_DISPLAYS)
            {
                const entry = this.topology[this.display_id] || (this.topology[this.display_id] = [this.display_id, 0, 0, 0, 0, 0]);
                entry[index - C.SVGA_REG_DISPLAY_IS_PRIMARY + 1] = value | 0;
            }
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
            // the frame buffer's dirty pages already show every write; screens
            // backed by it need converting
            this.screens.update(read(1) >>> 0, read(2) >>> 0, read(3) >>> 0, read(4) >>> 0);
            return 5;
        case C.SVGA_CMD_UPDATE_VERBOSE:
            if(!need(6)) return 0;
            this.screens.update(read(1) >>> 0, read(2) >>> 0, read(3) >>> 0, read(4) >>> 0);
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
            const width = read(4) >>> 0, height = read(5) >>> 0, and_depth = read(6) >>> 0, xor_depth = read(7) >>> 0;
            if(width > 256 || height > 256 || ![1, 32].includes(and_depth) || ![1, 8, 24, 32].includes(xor_depth)) return -1;
            const length = 8 + cursor_masks_length(width, height, and_depth, xor_depth);
            if(!need(length)) return 0;
            if(this.caps & C.SVGA_CAP_CURSOR)
            {
                this.cursor.define(read(2) >>> 0, read(3) >>> 0, width, height, and_depth, xor_depth,
                    i => read(8 + i), this.palette);
            }
            return length;
        }
        case C.SVGA_CMD_DEFINE_ALPHA_CURSOR:
        {
            if(!need(6)) return 0;
            const width = read(4) >>> 0, height = read(5) >>> 0;
            if(width > 256 || height > 256) return -1;
            const length = 6 + width * height;
            if(!need(length)) return 0;
            if(this.caps & C.SVGA_CAP_ALPHA_CURSOR)
            {
                this.cursor.define_alpha(read(2) >>> 0, read(3) >>> 0, width, height, i => read(6 + i));
            }
            return length;
        }
        case C.SVGA_CMD_DEFINE_SCREEN:
        {
            if(!need(2)) return 0;
            const size = read(1) >>> 0;
            if(size < 28 || size & 3 || size > 256) return -1;
            const length = 1 + size / 4;
            if(!need(length)) return 0;
            if(!this.screens.define(i => read(1 + i), size / 4)) this.set_irq(C.SVGA_IRQFLAG_ERROR);
            return length;
        }
        case C.SVGA_CMD_DESTROY_SCREEN:
            if(!need(2)) return 0;
            this.screens.destroy(read(1) >>> 0);
            return 2;
        case C.SVGA_CMD_DEFINE_GMRFB:
            if(!need(5)) return 0;
            this.screens.define_gmrfb(read(1) >>> 0, read(2) >>> 0, read(3) >>> 0, read(4) >>> 0);
            return 5;
        case C.SVGA_CMD_BLIT_GMRFB_TO_SCREEN:
            if(!need(8)) return 0;
            if(!this.screens.blit_to_screen(read(1) | 0, read(2) | 0, read(3) | 0, read(4) | 0, read(5) | 0, read(6) | 0, read(7) >>> 0))
            {
                dbg_log("svga: BLIT_GMRFB_TO_SCREEN failed", LOG_VGA);
            }
            return 8;
        case C.SVGA_CMD_BLIT_SCREEN_TO_GMRFB:
            if(!need(8)) return 0;
            if(!this.screens.blit_from_screen(read(1) | 0, read(2) | 0, read(3) | 0, read(4) | 0, read(5) | 0, read(6) | 0, read(7) >>> 0))
            {
                dbg_log("svga: BLIT_SCREEN_TO_GMRFB failed", LOG_VGA);
            }
            return 8;
        case C.SVGA_CMD_ANNOTATION_FILL:
            // (a hint about the next blit, whose pixels come anyway)
            return need(2) ? 2 : 0;
        case C.SVGA_CMD_ANNOTATION_COPY:
            return need(4) ? 4 : 0;
        case C.SVGA_CMD_DEFINE_GMR2:
            if(!need(3)) return 0;
            if(!(this.caps & C.SVGA_CAP_GMR2) || !this.gmrs.define_gmr2(read(1) >>> 0, read(2) >>> 0))
            {
                this.set_irq(C.SVGA_IRQFLAG_ERROR);
            }
            return 3;
        case C.SVGA_CMD_REMAP_GMR2:
        {
            if(!need(5)) return 0;
            const id = read(1) >>> 0, flags = read(2) >>> 0, offset = read(3) >>> 0, count = read(4) >>> 0;
            const length = 5 + remap_gmr2_payload(flags, count);
            if(!need(length)) return 0;
            let ppn;
            if(flags & C.SVGA_REMAP_GMR2_VIA_GMR)
            {
                // the page numbers are in another region
                const entry = flags & C.SVGA_REMAP_GMR2_PPN64 ? 8 : 4;
                const list = this.gmrs.read(read(5) >>> 0, read(6) >>> 0, entry * (flags & C.SVGA_REMAP_GMR2_SINGLE_PPN ? 1 : count));
                const view = list && new DataView(list.buffer);
                ppn = !view ? () => 0 : entry === 8 ?
                    i => view.getUint32(i * 8, true) + view.getUint32(i * 8 + 4, true) * 0x100000000 :
                    i => view.getUint32(i * 4, true);
            }
            else
            {
                ppn = flags & C.SVGA_REMAP_GMR2_PPN64 ?
                    i => (read(5 + 2 * i) >>> 0) + (read(6 + 2 * i) >>> 0) * 0x100000000 :
                    i => read(5 + i) >>> 0;
            }
            if(!this.gmrs.remap_gmr2(id, flags, offset, count, ppn)) this.set_irq(C.SVGA_IRQFLAG_ERROR);
            return length;
        }
    }

    if(id >= C.SVGA_3D_CMD_LEGACY_BASE && id < C.SVGA_3D_CMD_MAX)
    {
        // SVGA3dCmdHeader: id, size in bytes
        if(!need(2)) return 0;
        const size = read(1) >>> 0;
        const length = 2 + (size + 3 >> 2);
        if(!need(length)) return 0;
        if(this.svga3d)
        {
            const body = new Int32Array(size >> 2);
            for(let i = 0; i < body.length; i++) body[i] = read(2 + i);
            this.svga3d.command(id, body);
        }
        else
        {
            dbg_log("svga: 3D command " + id + " ignored (no 3D at level " + this.level + ")", LOG_VGA);
        }
        return length;
    }

    dbg_log("svga: unknown FIFO command " + id, LOG_VGA);
    return -1;
};

// ---------------------------------------------------------------------------
// Command buffers (SVGA_CAP_COMMAND_BUFFERS, CMD_BUFFERS_2)

/**
 * COMMAND_LOW written: run the command buffer whose SVGACBHeader is at
 * `address` (64-byte aligned) on a context, now, and complete it
 * @param {number} address guest physical
 * @param {number} context SVGA_CB_CONTEXT_0, _1 or _DEVICE
 */
SVGADevice.prototype.submit_command_buffer = function(address, context)
{
    const header = new DataView(this.machine.read_physical(address, 64).slice().buffer);
    const flags = header.getUint32(16, true), length = header.getUint32(20, true);
    const pa = header.getUint32(24, true) + header.getUint32(28, true) * 0x100000000;
    const offset = header.getUint32(32, true);
    let status = C.SVGA_CB_STATUS_COMPLETED, error_offset = 0;

    if(flags & C.SVGA_CB_FLAG_MOB || length > CB_MAX_SIZE || offset > length || length & 3 || offset & 3 ||
        context !== C.SVGA_CB_CONTEXT_DEVICE && context >= C.SVGA_CB_CONTEXT_MAX)
    {
        // (MOB-backed buffers come with guest-backed objects)
        status = C.SVGA_CB_STATUS_CB_HEADER_ERROR;
    }
    else
    {
        const bytes = this.machine.read_physical(pa + offset, length - offset).slice();
        const dwords = new Int32Array(bytes.buffer, 0, bytes.length >> 2);
        for(let at = 0; at < dwords.length;)
        {
            const read = i => dwords[at + i];
            const run = context === C.SVGA_CB_CONTEXT_DEVICE ?
                this.run_device_command(read, dwords.length - at) : this.run_command(read, dwords.length - at);
            if(run <= 0)
            {
                // unknown, or longer than the buffer
                status = C.SVGA_CB_STATUS_COMMAND_ERROR;
                error_offset = offset + at * 4;
                break;
            }
            at += run;
        }
    }

    const complete = () => {
        const done = new DataView(new ArrayBuffer(8));
        done.setUint32(0, status, true);
        done.setUint32(4, error_offset, true);
        this.machine.write_physical(new Uint8Array(done.buffer), address);
        if(status !== C.SVGA_CB_STATUS_COMPLETED)
        {
            dbg_log("svga: command buffer at " + h(address) + " failed: status " + status + " at " + error_offset, LOG_VGA);
            this.set_irq(C.SVGA_IRQFLAG_ERROR);
        }
        if(!(flags & C.SVGA_CB_FLAG_NO_IRQ) || status !== C.SVGA_CB_STATUS_COMPLETED)
        {
            this.set_irq(C.SVGA_IRQFLAG_COMMAND_BUFFER);
        }
    };
    // a buffer is complete when the GPU work before it is (readbacks have landed)
    if(this.svga3d) this.svga3d.after_work(complete);
    else complete();
};

/**
 * One command of the device context: queues are run as they are submitted,
 * so starting, stopping, preempting and emptying them have nothing to do
 * @param {function(number):number} read
 * @param {number} available
 * @return {number} its length in dwords, or -1
 */
SVGADevice.prototype.run_device_command = function(read, available)
{
    switch(read(0) >>> 0)
    {
        case C.SVGA_DC_CMD_NOP: return 1;
        case C.SVGA_DC_CMD_START_STOP_CONTEXT: return available >= 3 ? 3 : -1;
        case C.SVGA_DC_CMD_PREEMPT: return available >= 3 ? 3 : -1;
        case C.SVGA_DC_CMD_START_QUEUE: return available >= 2 ? 2 : -1;
        case C.SVGA_DC_CMD_ASYNC_STOP_QUEUE: return available >= 2 ? 2 : -1;
        case C.SVGA_DC_CMD_EMPTY_CONTEXT_QUEUE: return available >= 2 ? 2 : -1;
    }
    return -1;
};

/**
 * @param {number} fence
 */
SVGADevice.prototype.fence = function(fence)
{
    // 2D commands complete as they are read; 3D ones when the renderer has run them
    const pass = () => {
        Atomics.store(this.fifo(), C.SVGA_FIFO_FENCE, fence | 0);
        this.set_irq(C.SVGA_IRQFLAG_ANY_FENCE);
    };
    if(this.svga3d) this.svga3d.after_work(pass);
    else pass();
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
    const vram = this.vram();
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
        this.cursor.drawn = null;
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
    this.poll_cursor();
    if(this.screens.screens.size)
    {
        this.render_screens();
    }
    else
    {
        this.render_legacy();
    }
};

/**
 * SVGA_FIFO_CURSOR_*: the guest moved the cursor when CURSOR_COUNT changed
 */
SVGADevice.prototype.poll_cursor = function()
{
    if(!this.config_done || !(this.fifo_caps & C.SVGA_FIFO_CAP_CURSOR_BYPASS_3)) return;
    const fifo = this.fifo();
    const count = Atomics.load(fifo, C.SVGA_FIFO_CURSOR_COUNT);
    if(count === this.cursor_count) return;
    this.cursor_count = count;
    let x = fifo[C.SVGA_FIFO_CURSOR_X], y = fifo[C.SVGA_FIFO_CURSOR_Y];
    // with screen objects, the position may be in a screen's coordinates
    const screen = this.screens.screens.get(fifo[C.SVGA_FIFO_CURSOR_SCREEN_ID] >>> 0);
    if(screen && fifo[C.SVGA_FIFO_CURSOR_SCREEN_ID] >>> 0 !== C.SVGA_ID_INVALID)
    {
        x += screen.x;
        y += screen.y;
    }
    this.cursor.move(x, y, fifo[C.SVGA_FIFO_CURSOR_ON] === C.SVGA_CURSOR_ON_SHOW);
};

/**
 * The register mode: WIDTH x HEIGHT x BITS_PER_PIXEL in the frame buffer
 */
SVGADevice.prototype.render_legacy = function()
{
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
        this.cursor.drawn = null;
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

    const layers = [];
    min_y = Math.max(min_y, 0);
    max_y = Math.min(max_y, this.height);
    const width = this.width, height = this.height, pixels = this.pixels;
    const layer = (x, y, w, h) => ({
        pixels, screen_x: x, screen_y: y, buffer_x: x, buffer_y: y, buffer_width: w, buffer_height: h,
    });
    if(min_y < max_y) layers.push(layer(0, min_y, width, max_y - min_y));
    layers.push(...this.cursor.layers(
        (x, y) => x >= 0 && y >= 0 && x < width && y < height ? { data: pixels.data, at: (y * buffer_width + x) * 4 } : null,
        (x, y, w, h) => {
            const x0 = Math.max(x, 0), y0 = Math.max(y, 0), x1 = Math.min(x + w, width), y1 = Math.min(y + h, height);
            return x0 < x1 && y0 < y1 ? [layer(x0, y0, x1 - x0, y1 - y0)] : [];
        }));
    if(layers.length) this.display.update_buffer(layers);
};

/**
 * Screen objects: each screen a layer where it is on the virtual desktop
 */
SVGADevice.prototype.render_screens = function()
{
    let all = false;
    if(this.screens.layout_changed || this.mode_key !== "screens")
    {
        const box = this.screens.bounds();
        this.mode_key = "screens";
        this.screens.layout_changed = false;
        this.display.set_mode(true);
        this.display.set_size_graphical(box.width, box.height, box.width, box.height, 32);
        this.cursor.drawn = null;
        all = true;
    }
    const box = this.screens.bounds();
    const layers = this.screens.take_layers(all);
    const screen_at = (x, y) => {
        for(const s of this.screens.screens.values())
        {
            const sx = x + box.x - s.x, sy = y + box.y - s.y;
            if(sx >= 0 && sy >= 0 && sx < s.width && sy < s.height) return { s, sx, sy };
        }
        return null;
    };
    // the cursor's position is on the virtual desktop; layers are relative to the box
    const cursor = this.cursor, x = cursor.x, y = cursor.y;
    cursor.x -= box.x;
    cursor.y -= box.y;
    layers.push(...cursor.layers(
        (px, py) => {
            const hit = screen_at(px, py);
            return hit ? { data: hit.s.rgba, at: (hit.sy * hit.s.width + hit.sx) * 4 } : null;
        },
        (rx, ry, w, h) => {
            const out = [];
            for(const s of this.screens.screens.values())
            {
                const x0 = Math.max(rx, s.x - box.x), y0 = Math.max(ry, s.y - box.y);
                const x1 = Math.min(rx + w, s.x - box.x + s.width), y1 = Math.min(ry + h, s.y - box.y + s.height);
                if(x0 < x1 && y0 < y1)
                {
                    out.push({
                        pixels: { data: s.rgba, width: s.width, height: s.height },
                        screen_x: x0, screen_y: y0,
                        buffer_x: x0 - (s.x - box.x), buffer_y: y0 - (s.y - box.y),
                        buffer_width: x1 - x0, buffer_height: y1 - y0,
                    });
                }
            }
            return out;
        }));
    cursor.x = x;
    cursor.y = y;
    if(layers.length) this.display.update_buffer(layers);
};

// ---------------------------------------------------------------------------
// Snapshots

const STATE_VERSION = 3;

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
        // version 2
        this.gmrs.get_state(), this.screens.get_state(), this.cursor.get_state(),
        [this.gmr_id, this.command_high, this.prepend_low, this.prepend_high, this.cursor_count,
            this.cursor_on, this.cursor_x, this.cursor_y],
        this.topology.map(entry => entry || null),
        // version 3: the 3D objects (svga3d.js; prepare_save read their contents back)
        this.svga3d ? this.svga3d.get_state() : null,
    ];
};

/**
 * Before a snapshot: what only the GPU has comes back
 * @return {!Promise<undefined>}
 */
SVGADevice.prototype.prepare_save = function()
{
    return this.svga3d ? this.svga3d.prepare_save() : Promise.resolve(undefined);
};

SVGADevice.prototype.set_state = function(state)
{
    if(state[0] < 1 || state[0] > STATE_VERSION) throw new Error("vmware_svga: unsupported state version " + state[0]);
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
    if(state[0] >= 2)
    {
        this.gmrs.set_state(state[8]);
        this.screens.set_state(state[9]);
        this.cursor.set_state(state[10]);
        [this.gmr_id, this.command_high, this.prepend_low, this.prepend_high, this.cursor_count,
            this.cursor_on, this.cursor_x, this.cursor_y] = state[11];
        this.topology = state[12].map(entry => entry && Array.from(entry));
    }
    else
    {
        this.gmrs.reset();
        this.screens.reset();
        this.cursor.reset();
    }
    if(this.svga3d) this.svga3d.set_state(state[0] >= 3 ? state[13] : null);
    this.mode_key = "";
    this.showing = false;
    this.update_scanout();
    this.update_irq();
};
