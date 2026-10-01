// virtio-gpu as virtio-vga (1AF4:1050, class 0300): the VGA core for the
// BIOS, boot loaders and VBE (its frame buffer is BAR0), and the virtio-gpu
// device on the same function, its four capabilities in the memory BAR2
// (as QEMU's virtio-vga: viogpudo maps no I/O BARs).
// Section 6 of docs/vmware-svga-virtio-gpu-plan.zh-CN.md; the protocol is
// third_party/virtio/virtio_gpu.h.
//
// This file is the 2D device (V1): resources in host memory, filled from
// their guest backing by TRANSFER_TO_HOST_2D and shown on a scanout by
// RESOURCE_FLUSH, the cursor queue, EDID, and display events when the page's
// size changes (V86.set_display_size). The screen shows the VGA core until
// the driver's first control command, and again after a device reset.

import { VGAScreen } from "../vga_core.js";
import { SoftwareCursor } from "../vmware_svga/svga_cursor.js";
import { make_edid } from "./edid.js";

// For Types Only
import { GraphicsMachine } from "../machine.js";
import { DisplaySource } from "../../display.js";

const DEFAULT_VRAM_SIZE = 32 << 20;
// viogpudo only uses BAR0 as its frame buffer from 16 MiB
const MIN_VRAM_SIZE = 16 << 20;

const VIRTIO_GPU_DEVICE_ID = 0x1050;
const VIRTIO_GPU_SUBSYSTEM_ID = 0x1100;
const VGA_CLASS = 0x030000;

// Feature bits
const VIRTIO_GPU_F_EDID = 1;
const VIRTIO_GPU_F_RESOURCE_UUID = 2;
const VIRTIO_F_RING_INDIRECT_DESC = 28;

const CONTROLQ = 0;
const CURSORQ = 1;

// What the device declares, chosen at power-on and kept by snapshots, as
// vmware_svga's levels: a new feature needs a new level
const LEVELS = {
    "2d": { features: [VIRTIO_GPU_F_EDID, VIRTIO_GPU_F_RESOURCE_UUID, VIRTIO_F_RING_INDIRECT_DESC] },
};
const LEVEL_ORDER = ["2d"];
const DEFAULT_LEVEL = "2d";

// Commands
const CMD_GET_DISPLAY_INFO = 0x0100;
const CMD_RESOURCE_CREATE_2D = 0x0101;
const CMD_RESOURCE_UNREF = 0x0102;
const CMD_SET_SCANOUT = 0x0103;
const CMD_RESOURCE_FLUSH = 0x0104;
const CMD_TRANSFER_TO_HOST_2D = 0x0105;
const CMD_RESOURCE_ATTACH_BACKING = 0x0106;
const CMD_RESOURCE_DETACH_BACKING = 0x0107;
const CMD_GET_CAPSET_INFO = 0x0108;
const CMD_GET_CAPSET = 0x0109;
const CMD_GET_EDID = 0x010A;
const CMD_RESOURCE_ASSIGN_UUID = 0x010B;
const CMD_UPDATE_CURSOR = 0x0300;
const CMD_MOVE_CURSOR = 0x0301;

// Responses
const RESP_OK_NODATA = 0x1100;
const RESP_OK_DISPLAY_INFO = 0x1101;
const RESP_OK_EDID = 0x1104;
const RESP_OK_RESOURCE_UUID = 0x1105;
const RESP_ERR_UNSPEC = 0x1200;
const RESP_ERR_OUT_OF_MEMORY = 0x1201;
const RESP_ERR_INVALID_SCANOUT_ID = 0x1202;
const RESP_ERR_INVALID_RESOURCE_ID = 0x1203;
const RESP_ERR_INVALID_PARAMETER = 0x1205;

const FLAG_FENCE = 1;
const FLAG_INFO_RING_IDX = 2;

const EVENT_DISPLAY = 1;

const HEADER_SIZE = 24;
const MAX_SCANOUTS = 16;
const MAX_BACKING_ENTRIES = 16384;
// What resources may take of host memory (as QEMU's max_hostmem)
const MAX_HOST_MEMORY = 256 << 20;

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 768;

/**
 * The formats (all 4 bytes per pixel, named in memory order): how a pixel,
 * read as a little-endian word, becomes RGBA (opaque)
 * @type {!Object<number, function(number):number>}
 */
const TO_RGBA = {
    // B8G8R8A8, B8G8R8X8
    1: w => w >>> 16 & 0xFF | w & 0xFF00 | (w & 0xFF) << 16 | 0xFF000000,
    2: w => w >>> 16 & 0xFF | w & 0xFF00 | (w & 0xFF) << 16 | 0xFF000000,
    // A8R8G8B8, X8R8G8B8
    3: w => w >>> 8 | 0xFF000000,
    4: w => w >>> 8 | 0xFF000000,
    // R8G8B8A8, R8G8B8X8
    67: w => w | 0xFF000000,
    134: w => w | 0xFF000000,
    // X8B8G8R8, A8B8G8R8
    68: w => w >>> 24 | (w >>> 16 & 0xFF) << 8 | (w >>> 8 & 0xFF) << 16 | 0xFF000000,
    121: w => w >>> 24 | (w >>> 16 & 0xFF) << 8 | (w >>> 8 & 0xFF) << 16 | 0xFF000000,
};

/**
 * The formats with alpha: the byte that holds it, in the little-endian word
 * @type {!Object<number, number>}
 */
const ALPHA_SHIFT = { 1: 24, 67: 24, 3: 0, 121: 0 };

/**
 * A resource: a 2D image in host memory, and the guest pages it is copied from
 * @constructor
 */
function Resource(id, format, width, height)
{
    this.id = id;
    this.format = format;
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    /** @type {Float64Array} the backing: address, length, ... */
    this.backing = null;
    /** @type {Float64Array} where each entry starts in the backing */
    this.backing_starts = null;
    this.backing_length = 0;
    /** @type {Uint8Array} RESOURCE_ASSIGN_UUID's */
    this.uuid = null;
}

Resource.prototype.set_backing = function(entries)
{
    this.backing = entries;
    this.backing_starts = new Float64Array(entries.length / 2);
    let length = 0;
    for(let i = 0; i < entries.length; i += 2)
    {
        this.backing_starts[i / 2] = length;
        length += entries[i + 1];
    }
    this.backing_length = length;
};

/**
 * A display of the guest's
 * @constructor
 */
function Scanout(index)
{
    this.index = index;
    // what the page would like (GET_DISPLAY_INFO, the EDID); scanout 0 is always on
    this.enabled = index === 0;
    this.host_width = DEFAULT_WIDTH;
    this.host_height = DEFAULT_HEIGHT;
    // SET_SCANOUT: the resource (0: none) and the rectangle of it shown
    this.resource_id = 0;
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    // where it is on the page's picture
    this.screen_x = 0;
    this.screen_y = 0;
    /** @type {Uint8ClampedArray} the flushed picture, RGBA */
    this.rgba = null;
    /** @type {Array<number>} the part of it not yet sent: x0, y0, x1, y1 */
    this.dirty = null;
}

Scanout.prototype.add_dirty = function(x0, y0, x1, y1)
{
    if(x0 >= x1 || y0 >= y1) return;
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
};

/**
 * @constructor
 * @implements {DisplaySource}
 * @param {GraphicsMachine} machine
 * @param {{vram_size: (number|undefined), level: (string|undefined), scanouts: (number|undefined)}} options
 */
export function VirtioGPU(machine, options)
{
    /** @const */
    this.machine = machine;
    /** @const */
    this.display = machine.display;

    const vram_size = options.vram_size || DEFAULT_VRAM_SIZE;
    if(vram_size < MIN_VRAM_SIZE || (vram_size & (vram_size - 1)))
    {
        throw new Error("virtio_gpu: vram_size must be a power of two of at least " + (MIN_VRAM_SIZE >> 20) + " MiB");
    }
    /** @const */
    this.vram_size = vram_size;

    this.level = options.level || DEFAULT_LEVEL;
    if(!LEVELS[this.level])
    {
        throw new Error("virtio_gpu: unknown level " + JSON.stringify(this.level) + "; levels: " + LEVEL_ORDER.join(", "));
    }
    this.num_scanouts = Math.max(1, Math.min(MAX_SCANOUTS, options.scanouts || 1));

    // The VGA core: legacy VGA, VBE and the frame buffer (BAR0); this device
    // is the PCI function and the display source
    /** @const */
    this.vga = new VGAScreen(machine, vram_size, { pci: false, display_source: false });

    /** @type {!Map<number, !Resource>} */
    this.resources = new Map();
    this.host_memory = 0;
    /** @type {!Array<!Scanout>} */
    this.scanouts = [];
    for(let i = 0; i < this.num_scanouts; i++) this.scanouts.push(new Scanout(i));
    /** @const */
    this.cursor = new SoftwareCursor();
    this.events_read = 0;
    // the driver has sent a control command since the last reset: its
    // scanouts, not the VGA core, are on screen
    this.active = false;
    this.layout_key = "";
    /** @type {Uint8ClampedArray} black, for displays that show nothing yet */
    this.blank = null;
    this.serial = 0x0086;
    /** What the driver has done, for harnesses and debugging */
    this.stats = { commands: {}, errors: 0, last_error: 0, transfers: 0, flushes: 0, cursor_updates: 0, cursor_moves: 0 };

    const features = LEVELS[this.level].features;
    this.virtio = machine.create_virtio({
        "name": "virtio-gpu",
        "device_id": VIRTIO_GPU_DEVICE_ID,
        "subsystem_device_id": VIRTIO_GPU_SUBSYSTEM_ID,
        "class_code": VGA_CLASS,
        "revision": 1,
        "bars": [{
            "bar": 0,
            "size": vram_size,
            "address": this.vga.lfb_address,
            "prefetchable": true,
            "on_move": base => this.vga.move_lfb(base),
        }],
        // (as QEMU's virtio-vga; viogpudo maps only memory BARs)
        "capability_bar": 2,
        "pci_rom_size": this.vga.pci_rom_size,
        "pci_rom_address": this.vga.pci_rom_address,
        // (viogpudo needs QEMU's vector registers and ISR bits)
        "qemu_compatible": true,
        "features": features,
        "queues": [{ "size": 256 }, { "size": 16 }],
        "config": [
            { "bytes": 4, "name": "events_read", "read": () => this.events_read },
            { "bytes": 4, "name": "events_clear", "read": () => 0, "write": value => { this.events_read &= ~value; } },
            { "bytes": 4, "name": "num_scanouts", "read": () => this.num_scanouts },
            { "bytes": 4, "name": "num_capsets", "read": () => 0 },
        ],
        "notify": queue => this.notify(queue),
        "reset": () => this.reset_device(),
    });

    machine.on_host_display_size((width, height, index) => this.set_host_size(index, width, height));
    this.display.add_source(this);
}

/** A machine reset */
VirtioGPU.prototype.reset = function()
{
    this.virtio["reset"]();
};

/**
 * The driver reset the device (or the machine was reset): no resources, and
 * the VGA core is on screen again
 */
VirtioGPU.prototype.reset_device = function()
{
    this.resources.clear();
    this.host_memory = 0;
    for(const scanout of this.scanouts)
    {
        scanout.resource_id = 0;
        scanout.rgba = null;
        scanout.dirty = null;
    }
    this.cursor.reset();
    this.events_read = 0;
    this.set_active(false);
};

/** @param {boolean} active */
VirtioGPU.prototype.set_active = function(active)
{
    if(active === this.active) return;
    this.active = active;
    this.layout_key = "";
    if(!active)
    {
        // the core sends its mode and picture again
        this.vga.redisplay();
    }
};

/**
 * The page's size for a display: the guest learns it from GET_DISPLAY_INFO
 * and the EDID after a display event
 */
VirtioGPU.prototype.set_host_size = function(index, width, height)
{
    const scanout = this.scanouts[index];
    if(!scanout) return;
    const enabled = index === 0 || width > 0 && height > 0;
    if(width > 0 && height > 0)
    {
        width = Math.max(320, Math.min(8192, width));
        height = Math.max(200, Math.min(8192, height));
    }
    else
    {
        width = scanout.host_width;
        height = scanout.host_height;
    }
    if(enabled === scanout.enabled && width === scanout.host_width && height === scanout.host_height) return;
    scanout.enabled = enabled;
    scanout.host_width = width;
    scanout.host_height = height;
    this.events_read |= EVENT_DISPLAY;
    this.virtio["config_changed"]();
};

// ---------------------------------------------------------------------------
// The queues

VirtioGPU.prototype.notify = function(queue)
{
    let request;
    while((request = this.virtio["pop_request"](queue)))
    {
        const bytes = request["read"]();
        if(queue === CONTROLQ)
        {
            this.set_active(true);
            const response = this.control(bytes);
            this.respond(request, bytes, response);
        }
        else if(queue === CURSORQ)
        {
            this.cursor_command(bytes);
        }
        request["complete"]();
    }
    this.virtio["flush"](queue);
};

/**
 * The response's header: its type, and the request's fence when it has one
 * @param {!Object} request
 * @param {!Uint8Array} bytes the request
 * @param {!Uint8Array} response with room for its header
 */
VirtioGPU.prototype.respond = function(request, bytes, response)
{
    if(bytes.length >= HEADER_SIZE)
    {
        const flags = bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24;
        if(flags & FLAG_FENCE)
        {
            // fence_id, ctx_id, ring_idx
            response[4] = FLAG_FENCE | flags & FLAG_INFO_RING_IDX;
            response.set(bytes.subarray(8, 21), 8);
        }
    }
    request["write"](response);
};

/**
 * @param {number} type
 * @param {number=} size of the whole response
 * @return {!Uint8Array}
 */
function response(type, size)
{
    const out = new Uint8Array(size || HEADER_SIZE);
    out[0] = type & 0xFF;
    out[1] = type >> 8;
    return out;
}

/**
 * A control command
 * @param {!Uint8Array} bytes
 * @return {!Uint8Array} the response
 */
VirtioGPU.prototype.control = function(bytes)
{
    if(bytes.length < HEADER_SIZE) return this.error(RESP_ERR_UNSPEC, 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint32(0, true);
    this.stats.commands[type] = (this.stats.commands[type] || 0) + 1;
    const u32 = at => HEADER_SIZE + at + 4 <= bytes.length ? view.getUint32(HEADER_SIZE + at, true) : 0;
    const need = size => HEADER_SIZE + size <= bytes.length;

    switch(type)
    {
        case CMD_GET_DISPLAY_INFO:
            return this.display_info();
        case CMD_GET_EDID:
            if(!need(8)) break;
            return this.edid(u32(0));
        case CMD_RESOURCE_CREATE_2D:
            if(!need(16)) break;
            return this.create_2d(u32(0), u32(4), u32(8), u32(12));
        case CMD_RESOURCE_UNREF:
            if(!need(8)) break;
            return this.unref(u32(0));
        case CMD_SET_SCANOUT:
            if(!need(24)) break;
            return this.set_scanout(u32(16), u32(20), u32(0), u32(4), u32(8), u32(12));
        case CMD_RESOURCE_FLUSH:
            if(!need(24)) break;
            return this.flush(u32(16), u32(0), u32(4), u32(8), u32(12));
        case CMD_TRANSFER_TO_HOST_2D:
            if(!need(32)) break;
            return this.transfer_to_host(u32(24), u32(0), u32(4), u32(8), u32(12), u32(16) + u32(20) * 0x100000000);
        case CMD_RESOURCE_ATTACH_BACKING:
        {
            if(!need(8)) break;
            const count = u32(4);
            if(count > MAX_BACKING_ENTRIES || !need(8 + count * 16)) return this.error(RESP_ERR_INVALID_PARAMETER, type);
            const entries = new Float64Array(count * 2);
            for(let i = 0; i < count; i++)
            {
                entries[i * 2] = u32(8 + i * 16) + u32(12 + i * 16) * 0x100000000;
                entries[i * 2 + 1] = u32(16 + i * 16);
            }
            return this.attach_backing(u32(0), entries);
        }
        case CMD_RESOURCE_DETACH_BACKING:
            if(!need(8)) break;
            return this.detach_backing(u32(0));
        case CMD_RESOURCE_ASSIGN_UUID:
            if(!need(8)) break;
            return this.assign_uuid(u32(0));
        case CMD_GET_CAPSET_INFO:
        case CMD_GET_CAPSET:
            // no capsets (num_capsets is 0)
            return this.error(RESP_ERR_INVALID_PARAMETER, type);
    }
    return this.error(RESP_ERR_UNSPEC, type);
};

VirtioGPU.prototype.error = function(code, command)
{
    this.stats.errors++;
    this.stats.last_error = command << 16 | code & 0xFFFF;
    return response(code);
};

VirtioGPU.prototype.ok = function()
{
    return response(RESP_OK_NODATA);
};

/**
 * Where each enabled display is on the page: side by side, left to right
 */
VirtioGPU.prototype.place_scanouts = function()
{
    let x = 0;
    for(const scanout of this.scanouts)
    {
        scanout.screen_x = x;
        scanout.screen_y = 0;
        if(scanout.enabled) x += scanout.host_width;
    }
};

VirtioGPU.prototype.display_info = function()
{
    const out = response(RESP_OK_DISPLAY_INFO, HEADER_SIZE + MAX_SCANOUTS * 24);
    const view = new DataView(out.buffer);
    this.place_scanouts();
    for(const scanout of this.scanouts)
    {
        if(!scanout.enabled) continue;
        const at = HEADER_SIZE + scanout.index * 24;
        view.setUint32(at, scanout.screen_x, true);
        view.setUint32(at + 4, scanout.screen_y, true);
        view.setUint32(at + 8, scanout.host_width, true);
        view.setUint32(at + 12, scanout.host_height, true);
        view.setUint32(at + 16, 1, true);
    }
    return out;
};

VirtioGPU.prototype.edid = function(index)
{
    const scanout = this.scanouts[index];
    if(!scanout) return this.error(RESP_ERR_INVALID_PARAMETER, CMD_GET_EDID);
    const edid = make_edid(scanout.host_width, scanout.host_height, this.serial + index);
    const out = response(RESP_OK_EDID, HEADER_SIZE + 8 + 1024);
    new DataView(out.buffer).setUint32(HEADER_SIZE, edid.length, true);
    out.set(edid, HEADER_SIZE + 8);
    return out;
};

VirtioGPU.prototype.create_2d = function(id, format, width, height)
{
    if(id === 0 || this.resources.has(id)) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_CREATE_2D);
    if(!TO_RGBA[format] || !width || !height || width > 16384 || height > 16384)
    {
        return this.error(RESP_ERR_INVALID_PARAMETER, CMD_RESOURCE_CREATE_2D);
    }
    const bytes = width * height * 4;
    if(this.host_memory + bytes > MAX_HOST_MEMORY) return this.error(RESP_ERR_OUT_OF_MEMORY, CMD_RESOURCE_CREATE_2D);
    this.host_memory += bytes;
    this.resources.set(id, new Resource(id, format, width, height));
    return this.ok();
};

VirtioGPU.prototype.unref = function(id)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_UNREF);
    // (as QEMU: the displays that show it are switched off)
    for(const scanout of this.scanouts)
    {
        if(scanout.resource_id === id) this.disable_scanout(scanout);
    }
    this.host_memory -= resource.data.length;
    this.resources.delete(id);
    return this.ok();
};

VirtioGPU.prototype.disable_scanout = function(scanout)
{
    scanout.resource_id = 0;
    scanout.width = scanout.height = 0;
    scanout.rgba = null;
    scanout.dirty = null;
    this.layout_key = "";
};

VirtioGPU.prototype.set_scanout = function(index, id, x, y, width, height)
{
    const scanout = this.scanouts[index];
    if(!scanout) return this.error(RESP_ERR_INVALID_SCANOUT_ID, CMD_SET_SCANOUT);
    if(id === 0)
    {
        this.disable_scanout(scanout);
        return this.ok();
    }
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_SET_SCANOUT);
    if(width < 16 || height < 16 || x + width > resource.width || y + height > resource.height)
    {
        return this.error(RESP_ERR_INVALID_PARAMETER, CMD_SET_SCANOUT);
    }
    if(scanout.width !== width || scanout.height !== height || !scanout.rgba)
    {
        scanout.rgba = new Uint8ClampedArray(width * height * 4);
        this.layout_key = "";
    }
    scanout.resource_id = id;
    scanout.x = x;
    scanout.y = y;
    scanout.width = width;
    scanout.height = height;
    this.present(scanout, resource, 0, 0, width, height);
    return this.ok();
};

VirtioGPU.prototype.flush = function(id, x, y, width, height)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_FLUSH);
    this.stats.flushes++;
    for(const scanout of this.scanouts)
    {
        if(scanout.resource_id !== id) continue;
        // the rectangle, in the scanout's coordinates
        const x0 = Math.max(x - scanout.x, 0), y0 = Math.max(y - scanout.y, 0);
        const x1 = Math.min(x + width - scanout.x, scanout.width), y1 = Math.min(y + height - scanout.y, scanout.height);
        if(x0 < x1 && y0 < y1) this.present(scanout, resource, x0, y0, x1 - x0, y1 - y0);
    }
    return this.ok();
};

/**
 * A rectangle of a scanout from its resource into its picture
 */
VirtioGPU.prototype.present = function(scanout, resource, x, y, width, height)
{
    const convert = TO_RGBA[resource.format];
    const src = new Int32Array(resource.data.buffer);
    const dst = new Int32Array(scanout.rgba.buffer);
    for(let row = y; row < y + height; row++)
    {
        let from = (scanout.y + row) * resource.width + scanout.x + x;
        let to = row * scanout.width + x;
        for(const end = to + width; to < end; to++, from++) dst[to] = convert(src[from]);
    }
    scanout.add_dirty(x, y, x + width, y + height);
};

VirtioGPU.prototype.transfer_to_host = function(id, x, y, width, height, offset)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_TRANSFER_TO_HOST_2D);
    if(!resource.backing) return this.error(RESP_ERR_UNSPEC, CMD_TRANSFER_TO_HOST_2D);
    if(x + width > resource.width || y + height > resource.height || x + width < x || y + height < y)
    {
        return this.error(RESP_ERR_INVALID_PARAMETER, CMD_TRANSFER_TO_HOST_2D);
    }
    this.stats.transfers++;
    const stride = resource.width * 4, row = width * 4;
    if(offset === 0 && x === 0 && y === 0 && width === resource.width)
    {
        // (the whole of the first rows, in one go)
        if(!this.read_backing(resource, 0, resource.data, 0, stride * height))
        {
            return this.error(RESP_ERR_INVALID_PARAMETER, CMD_TRANSFER_TO_HOST_2D);
        }
        return this.ok();
    }
    for(let h = 0; h < height; h++)
    {
        if(!this.read_backing(resource, offset + stride * h, resource.data, (y + h) * stride + x * 4, row))
        {
            return this.error(RESP_ERR_INVALID_PARAMETER, CMD_TRANSFER_TO_HOST_2D);
        }
    }
    return this.ok();
};

/**
 * Bytes of a resource's backing (guest RAM, or the frame buffer in BAR0)
 * @param {!Resource} resource
 * @param {number} from the offset in the backing
 * @param {!Uint8Array} out
 * @param {number} at
 * @param {number} length
 * @return {boolean} whether the backing has them
 */
VirtioGPU.prototype.read_backing = function(resource, from, out, at, length)
{
    if(from + length > resource.backing_length) return false;
    const starts = resource.backing_starts, entries = resource.backing;
    // the entry that holds `from`
    let low = 0, high = starts.length - 1;
    while(low < high)
    {
        const mid = low + high + 1 >> 1;
        if(starts[mid] <= from) low = mid;
        else high = mid - 1;
    }
    for(let i = low; length > 0; i++)
    {
        const skip = from - starts[i];
        const count = Math.min(entries[i * 2 + 1] - skip, length);
        if(count > 0)
        {
            const bytes = this.read_guest(entries[i * 2] + skip, count);
            if(!bytes) return false;
            out.set(bytes, at);
            at += count;
            from += count;
            length -= count;
        }
    }
    return true;
};

/**
 * @param {number} address
 * @param {number} length
 * @return {Uint8Array} a view or a copy, null if it is neither RAM nor the frame buffer
 */
VirtioGPU.prototype.read_guest = function(address, length)
{
    const lfb = this.vga.lfb_address;
    if(address >= lfb && address + length <= lfb + this.vram_size)
    {
        return this.vga.svga_memory.subarray(address - lfb, address - lfb + length);
    }
    if(!this.virtio["is_ram"](address, length)) return null;
    return this.virtio["read_memory"](address, length);
};

VirtioGPU.prototype.attach_backing = function(id, entries)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_ATTACH_BACKING);
    if(resource.backing) return this.error(RESP_ERR_UNSPEC, CMD_RESOURCE_ATTACH_BACKING);
    resource.set_backing(entries);
    return this.ok();
};

VirtioGPU.prototype.detach_backing = function(id)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_DETACH_BACKING);
    if(!resource.backing) return this.error(RESP_ERR_UNSPEC, CMD_RESOURCE_DETACH_BACKING);
    resource.backing = null;
    resource.backing_starts = null;
    resource.backing_length = 0;
    return this.ok();
};

VirtioGPU.prototype.assign_uuid = function(id)
{
    const resource = this.resources.get(id);
    if(!resource) return this.error(RESP_ERR_INVALID_RESOURCE_ID, CMD_RESOURCE_ASSIGN_UUID);
    if(!resource.uuid)
    {
        // a version 4 UUID
        resource.uuid = new Uint8Array(16);
        for(let i = 0; i < 16; i++) resource.uuid[i] = Math.random() * 256;
        resource.uuid[6] = resource.uuid[6] & 0x0F | 0x40;
        resource.uuid[8] = resource.uuid[8] & 0x3F | 0x80;
    }
    const out = response(RESP_OK_RESOURCE_UUID, HEADER_SIZE + 16);
    out.set(resource.uuid, HEADER_SIZE);
    return out;
};

/**
 * UPDATE_CURSOR, MOVE_CURSOR: pos (scanout, x, y), resource, hot_x, hot_y
 * @param {!Uint8Array} bytes
 */
VirtioGPU.prototype.cursor_command = function(bytes)
{
    if(bytes.length < HEADER_SIZE + 16) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint32(0, true);
    const scanout = this.scanouts[view.getUint32(HEADER_SIZE, true)] || this.scanouts[0];
    this.place_scanouts();
    const x = scanout.screen_x + view.getInt32(HEADER_SIZE + 4, true), y = scanout.screen_y + view.getInt32(HEADER_SIZE + 8, true);
    if(type === CMD_UPDATE_CURSOR && bytes.length >= HEADER_SIZE + 28)
    {
        this.stats.cursor_updates++;
        const id = view.getUint32(HEADER_SIZE + 16, true);
        const resource = this.resources.get(id);
        if(!resource)
        {
            this.cursor.move(x, y, false);
            return;
        }
        const pixels = new Int32Array(resource.data.buffer);
        const convert = TO_RGBA[resource.format], shift = ALPHA_SHIFT[resource.format];
        // premultiplied 0xAARRGGBB (as DRM's cursor planes are by default)
        this.cursor.define_alpha(view.getUint32(HEADER_SIZE + 20, true), view.getUint32(HEADER_SIZE + 24, true),
            resource.width, resource.height, i => {
                const rgba = convert(pixels[i]), alpha = shift === undefined ? 0xFF : pixels[i] >>> shift & 0xFF;
                return alpha << 24 | (rgba & 0xFF) << 16 | rgba & 0xFF00 | rgba >>> 16 & 0xFF;
            });
        this.cursor.move(x, y, true);
    }
    else if(type === CMD_MOVE_CURSOR)
    {
        this.stats.cursor_moves++;
        this.cursor.move(x, y, this.cursor.visible);
    }
};

// ---------------------------------------------------------------------------
// The scanout

/** @override */
VirtioGPU.prototype.vblank_period = function()
{
    return this.active ? 1000 / 60 : this.vga.vblank_period();
};

/** @override */
VirtioGPU.prototype.on_vblank = function()
{
    this.vga.on_vblank();
};

/** @override */
VirtioGPU.prototype.invalidate = function()
{
    if(this.active)
    {
        this.layout_key = "";
        this.cursor.drawn = null;
    }
    else
    {
        this.vga.invalidate();
    }
};

/** @override */
VirtioGPU.prototype.render = function()
{
    if(!this.active)
    {
        this.vga.render();
        return;
    }
    this.place_scanouts();
    const shown = this.scanouts.filter(s => s.enabled || s.rgba);
    // the page's picture: the displays side by side (each the size it shows,
    // or the size the page asked for while it shows nothing)
    let width = 0, height = 0;
    const boxes = shown.map(s => {
        const w = s.rgba ? s.width : s.host_width, h = s.rgba ? s.height : s.host_height;
        const box = [width, 0, w, h];
        width += w;
        height = Math.max(height, h);
        return box;
    });
    const key = boxes.join(";");
    let all = false;
    if(key !== this.layout_key)
    {
        this.layout_key = key;
        this.display.set_mode(true);
        this.display.set_size_graphical(width, height, width, height, 32);
        this.cursor.drawn = null;
        all = true;
        if(!this.blank || this.blank.length < width * height * 4) this.blank = new Uint8ClampedArray(width * height * 4);
    }
    const layers = [];
    shown.forEach((s, i) => {
        const [bx, by, bw, bh] = boxes[i];
        if(!s.rgba)
        {
            if(all) layers.push({ pixels: { data: this.blank, width: bw, height: bh }, screen_x: bx, screen_y: by,
                buffer_x: 0, buffer_y: 0, buffer_width: bw, buffer_height: bh });
            return;
        }
        const d = all ? [0, 0, s.width, s.height] : s.dirty;
        s.dirty = null;
        if(!d) return;
        layers.push({ pixels: { data: s.rgba, width: s.width, height: s.height }, screen_x: bx + d[0], screen_y: by + d[1],
            buffer_x: d[0], buffer_y: d[1], buffer_width: d[2] - d[0], buffer_height: d[3] - d[1] });
    });
    // the cursor, over whatever display it is on
    const at = (px, py) => {
        for(let i = 0; i < shown.length; i++)
        {
            const s = shown[i], [bx, , bw, bh] = boxes[i];
            if(s.rgba && px >= bx && py >= 0 && px < bx + bw && py < bh) return { s, sx: px - bx, sy: py, bx };
        }
        return null;
    };
    layers.push(...this.cursor.layers(
        (px, py) => {
            const hit = at(px, py);
            return hit ? { data: hit.s.rgba, at: (hit.sy * hit.s.width + hit.sx) * 4 } : null;
        },
        (rx, ry, w, h) => {
            const out = [];
            shown.forEach((s, i) => {
                if(!s.rgba) return;
                const [bx, , bw, bh] = boxes[i];
                const x0 = Math.max(rx, bx), y0 = Math.max(ry, 0), x1 = Math.min(rx + w, bx + bw), y1 = Math.min(ry + h, bh);
                if(x0 < x1 && y0 < y1)
                {
                    out.push({ pixels: { data: s.rgba, width: s.width, height: s.height }, screen_x: x0, screen_y: y0,
                        buffer_x: x0 - bx, buffer_y: y0, buffer_width: x1 - x0, buffer_height: y1 - y0 });
                }
            });
            return out;
        }));
    if(layers.length) this.display.update_buffer(layers);
};

// ---------------------------------------------------------------------------
// Snapshots

const STATE_VERSION = 1;

VirtioGPU.prototype.get_state = function()
{
    const resources = [];
    for(const r of this.resources.values())
    {
        resources.push([r.id, r.format, r.width, r.height, r.data, r.backing, r.uuid]);
    }
    return [
        STATE_VERSION,
        this.level,
        this.num_scanouts,
        this.vga.get_state(),
        // (v86's own object: v86 saves and restores it)
        this.virtio["transport"](),
        resources,
        this.scanouts.map(s => [s.enabled, s.host_width, s.host_height, s.resource_id, s.x, s.y, s.width, s.height]),
        this.cursor.get_state(),
        this.events_read,
        this.active,
    ];
};

VirtioGPU.prototype.set_state = function(state)
{
    if(state[0] !== STATE_VERSION)
    {
        throw new Error("virtio_gpu: unsupported state version " + state[0]);
    }
    if(state[1] !== this.level || state[2] !== this.num_scanouts)
    {
        throw new Error("virtio_gpu: the snapshot is from level " + state[1] + " with " + state[2] +
            " displays; this device has level " + this.level + " with " + this.num_scanouts);
    }
    this.vga.set_state(state[3]);
    this.virtio["set_transport"](state[4]);
    this.resources.clear();
    this.host_memory = 0;
    for(const [id, format, width, height, data, backing, uuid] of state[5])
    {
        const r = new Resource(id, format, width, height);
        r.data.set(data);
        if(backing) r.set_backing(Float64Array.from(backing));
        r.uuid = uuid ? Uint8Array.from(uuid) : null;
        this.resources.set(id, r);
        this.host_memory += r.data.length;
    }
    state[6].forEach(([enabled, host_width, host_height, resource_id, x, y, width, height], i) => {
        const s = this.scanouts[i];
        Object.assign(s, { enabled, host_width, host_height, resource_id: 0, x, y, width: 0, height: 0, rgba: null, dirty: null });
        const resource = resource_id && this.resources.get(resource_id);
        if(resource)
        {
            s.rgba = new Uint8ClampedArray(width * height * 4);
            Object.assign(s, { resource_id, width, height });
            this.present(s, resource, 0, 0, width, height);
        }
    });
    this.cursor.set_state(state[7]);
    this.events_read = state[8];
    this.active = state[9];
    this.layout_key = "";
    if(!this.active) this.vga.redisplay();
};
