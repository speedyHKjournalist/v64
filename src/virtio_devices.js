// Virtio devices supplied by the embedder (the virtio_devices option). v86 owns
// the transport: the PCI function, its capabilities, the rings, the interrupt
// and the transport's part of a snapshot. The descriptor owns what the device
// does. Descriptors come from code that Closure does not compile, so every
// field and every method of the handle uses a quoted name.
// See docs/graphics-proxy-plugin-plan.md.

import { dbg_log } from "./log.js";
import { LOG_PCI } from "./const.js";
import {
    VirtIO, VIRTIO_F_VERSION_1, VIRTIO_STATUS_DRIVER_OK,
    VIRTIO_STATUS_DEVICE_NEEDS_RESET, VIRTIO_STATUS_FAILED,
} from "./virtio.js";

// For Types Only
import { CPU } from "./cpu.js";

// state[92] is ["virtio_devices", 1, <one entry per device>]
const STATE_TAG = "virtio_devices";
const STATE_VERSION = 1;

// Slots and I/O windows handed out when a descriptor asks for none
const FIRST_FREE_SLOT = 0x10;
const LAST_SLOT = 0x1F;
// One 256-byte window each for the common configuration, the notification
// register, the ISR status and the device configuration
const IO_WINDOW_BYTES = 0x400;
const IO_POOL_START = 0xE000;
const DEVICE_CONFIG_MAX_BYTES = 0x100;

// Legacy VGA memory and the BIOS ROMs, never RAM for a device
const LEGACY_HOLE_START = 0xA0000;
const LEGACY_HOLE_END = 0x100000;
const PHYSICAL_BUS_END = 0x1000000000;
const PAGE_SIZE = 4096;

// x64_phys_kind
const PHYS_KIND_RAM = 1;
const PHYS_KIND_EXTENDED = 3;

/**
 * @param {CPU} cpu
 * @param {*} descriptors
 * @return {!Array<VirtioDevice>}
 */
export function create_virtio_devices(cpu, descriptors)
{
    if(!Array.isArray(descriptors))
    {
        throw new TypeError("virtio_devices must be an array of device descriptors");
    }

    const names = new Set();
    const slots = new Set();
    const windows = new Set();

    // Fixed slots and windows first, so that allocation steps around them
    for(const descriptor of descriptors)
    {
        check_descriptor(descriptor, names);
        const name = descriptor["name"];
        const slot = descriptor["pci_slot"];
        const io_base = descriptor["io_base"];
        if(slot !== undefined)
        {
            if(slots.has(slot) || !is_slot_free(cpu, slot))
            {
                throw new Error("virtio_devices: \"" + name + "\" asks for PCI slot 0x" + slot.toString(16) + ", which is taken");
            }
            slots.add(slot);
        }
        if(io_base !== undefined)
        {
            if(windows.has(io_base) || !is_io_window_free(cpu, io_base))
            {
                throw new Error("virtio_devices: \"" + name + "\" asks for I/O ports 0x" + io_base.toString(16) + ", which are taken");
            }
            windows.add(io_base);
        }
    }

    return descriptors.map(descriptor => {
        let slot = descriptor["pci_slot"];
        if(slot === undefined)
        {
            slot = FIRST_FREE_SLOT;
            while(slot <= LAST_SLOT && (slots.has(slot) || !is_slot_free(cpu, slot))) slot++;
            if(slot > LAST_SLOT)
            {
                throw new Error("virtio_devices: no free PCI slot for \"" + descriptor["name"] + "\"");
            }
            slots.add(slot);
        }

        let io_base = descriptor["io_base"];
        if(io_base === undefined)
        {
            io_base = IO_POOL_START;
            while(io_base + IO_WINDOW_BYTES <= 0x10000 && (windows.has(io_base) || !is_io_window_free(cpu, io_base)))
            {
                io_base += IO_WINDOW_BYTES;
            }
            if(io_base + IO_WINDOW_BYTES > 0x10000)
            {
                throw new Error("virtio_devices: no free I/O ports for \"" + descriptor["name"] + "\"");
            }
            windows.add(io_base);
        }

        dbg_log("virtio device " + descriptor["name"] + " at slot 0x" + slot.toString(16) +
            ", ports 0x" + io_base.toString(16), LOG_PCI);
        return new VirtioDevice(cpu, descriptor, slot, io_base);
    });
}

/**
 * The value of state[92]: nothing when no device is configured, so that
 * snapshots of machines without custom devices do not change
 * @param {Array<VirtioDevice>|undefined} devices
 */
export function get_virtio_devices_state(devices)
{
    if(!devices || !devices.length) return undefined;
    return [STATE_TAG, STATE_VERSION].concat(devices);
}

/**
 * Match the entries of state[92] to the configured devices. Changes nothing,
 * so that CPU.set_state can call it before it restores anything.
 * @param {Array<VirtioDevice>|undefined} devices
 * @param {*} slot
 * @return {!Map<string, !Array>}
 */
export function resolve_virtio_devices_state(devices, slot)
{
    devices = devices || [];
    const entries = new Map();

    if(Array.isArray(slot) && slot[0] === STATE_TAG)
    {
        if(slot[1] !== STATE_VERSION)
        {
            throw new Error("Unsupported virtio devices state version " + slot[1]);
        }
        for(const entry of slot.slice(2))
        {
            entries.set(entry[0], entry);
        }
    }
    else if(slot !== undefined && slot !== null)
    {
        // A slot written before custom devices existed belongs to the
        // device that recognizes it
        for(const device of devices)
        {
            const upgrade_state = device.descriptor["upgrade_state"];
            const upgraded = upgrade_state && upgrade_state(slot);
            if(upgraded)
            {
                entries.set(device.name, [device.name, upgraded[0], upgraded[1], upgraded[2]]);
                break;
            }
        }
        if(!entries.size)
        {
            throw new Error("The snapshot contains device state that no configured virtio device recognizes");
        }
    }

    for(const name of entries.keys())
    {
        if(!devices.some(device => device.name === name))
        {
            throw new Error("The snapshot contains virtio device \"" + name + "\", which is not configured");
        }
    }

    return entries;
}

/**
 * @param {Array<VirtioDevice>|undefined} devices
 * @param {!Map<string, !Array>} entries from resolve_virtio_devices_state
 */
export function set_virtio_devices_state(devices, entries)
{
    for(const device of devices || [])
    {
        const entry = entries.get(device.name);
        if(entry)
        {
            device.set_state(entry);
        }
        else
        {
            // The snapshot is from a machine without this device
            device.reset();
            device.restored_host_state = undefined;
        }
    }
}

/**
 * @param {*} descriptor
 * @param {!Set<string>} names
 */
function check_descriptor(descriptor, names)
{
    if(!descriptor || typeof descriptor !== "object")
    {
        throw new TypeError("virtio_devices: a device descriptor must be an object");
    }

    const name = descriptor["name"];
    if(typeof name !== "string" || !name)
    {
        throw new TypeError("virtio_devices: a device descriptor needs a name");
    }
    if(names.has(name))
    {
        throw new Error("virtio_devices: more than one device is named \"" + name + "\"");
    }
    names.add(name);

    const fail = message => { throw new TypeError("virtio_devices: \"" + name + "\": " + message); };
    const is_u16 = value => Number.isInteger(value) && value >= 0 && value <= 0xFFFF;

    if(!is_u16(descriptor["device_id"])) fail("device_id must be a 16-bit integer");
    if(descriptor["subsystem_device_id"] !== undefined && !is_u16(descriptor["subsystem_device_id"]))
    {
        fail("subsystem_device_id must be a 16-bit integer");
    }

    const slot = descriptor["pci_slot"];
    if(slot !== undefined && !(Number.isInteger(slot) && slot >= 1 && slot <= LAST_SLOT))
    {
        fail("pci_slot must be between 1 and 31");
    }
    const io_base = descriptor["io_base"];
    if(io_base !== undefined && !(Number.isInteger(io_base) && io_base > 0 && !(io_base & 0xFF) &&
        io_base + IO_WINDOW_BYTES <= 0x10000))
    {
        fail("io_base must be 256-byte aligned and leave room for four 256-byte windows");
    }

    const queues = descriptor["queues"];
    if(!Array.isArray(queues) || !queues.length)
    {
        fail("queues must be a non-empty array");
    }
    for(const queue of queues)
    {
        const size = queue && queue["size"];
        if(!Number.isInteger(size) || size < 1 || size > 32768 || (size & (size - 1)))
        {
            fail("a queue size must be a power of two up to 32768");
        }
    }

    const features = descriptor["features"];
    if(features !== undefined && !(Array.isArray(features) &&
        features.every(bit => Number.isInteger(bit) && bit >= 0 && bit < 128)))
    {
        fail("features must be an array of bit numbers below 128");
    }

    const config = descriptor["config"];
    if(config !== undefined)
    {
        if(!Array.isArray(config)) fail("config must be an array");
        let bytes = 0;
        for(const field of config)
        {
            if(!field || ![1, 2, 4].includes(field["bytes"])) fail("a config field has 1, 2 or 4 bytes");
            if(typeof field["read"] !== "function") fail("a config field needs a read function");
            if(field["write"] !== undefined && typeof field["write"] !== "function") fail("config write must be a function");
            bytes += field["bytes"];
        }
        if(bytes > DEVICE_CONFIG_MAX_BYTES) fail("the device configuration is limited to 256 bytes");
    }

    if(typeof descriptor["notify"] !== "function") fail("notify must be a function");
    for(const hook of ["init", "reset", "get_state", "set_state", "upgrade_state"])
    {
        if(descriptor[hook] !== undefined && typeof descriptor[hook] !== "function")
        {
            fail(hook + " must be a function");
        }
    }
}

/**
 * @param {CPU} cpu
 * @param {number} slot
 */
function is_slot_free(cpu, slot)
{
    return !cpu.devices.pci.devices[slot << 3];
}

/**
 * @param {CPU} cpu
 * @param {number} io_base
 */
function is_io_window_free(cpu, io_base)
{
    for(let port = io_base; port < io_base + IO_WINDOW_BYTES; port++)
    {
        if(cpu.io.ports[port].device) return false;
    }
    return true;
}

/**
 * @constructor
 * @param {CPU} cpu
 * @param {!Object} descriptor
 * @param {number} slot
 * @param {number} io_base
 */
function VirtioDevice(cpu, descriptor, slot, io_base)
{
    /** @const @type {CPU} */
    this.cpu = cpu;

    this.descriptor = descriptor;
    this.name = descriptor["name"];

    // Bumped by resets and restores: requests popped before one must not
    // complete into the new rings
    this.generation = 0;
    this.initialized = false;

    // Set by the embedder before a save, read by it after a restore
    this.host_state = undefined;
    this.restored_host_state = undefined;

    const features = descriptor["features"] || [];
    const config = descriptor["config"] || [];

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-" + this.name,
        pci_id: slot << 3,
        device_id: descriptor["device_id"],
        subsystem_device_id: descriptor["subsystem_device_id"] || 0,
        on_reset: () =>
        {
            this.generation++;
            const reset = this.descriptor["reset"];
            if(this.initialized && reset) reset();
        },
        common:
        {
            initial_port: io_base,
            queues: descriptor["queues"].map(queue => ({ size_supported: queue["size"], notify_offset: 0 })),
            features: features.includes(VIRTIO_F_VERSION_1) ? features : features.concat([VIRTIO_F_VERSION_1]),
            on_driver_ok: () => {},
        },
        notification:
        {
            initial_port: io_base + 0x100,
            single_handler: true,
            handlers: [
                (queue_id) => this.notify(queue_id),
            ],
        },
        isr_status:
        {
            initial_port: io_base + 0x200,
        },
        device_specific: config.length ? {
            initial_port: io_base + 0x300,
            struct: config.map((field, i) => ({
                bytes: field["bytes"],
                name: field["name"] || "config" + i,
                // (port reads are int32, or the field's width)
                read: field["bytes"] === 4 ? () => field["read"]() | 0 :
                    () => field["read"]() & (field["bytes"] === 2 ? 0xFFFF : 0xFF),
                write: data => { field["write"] && field["write"](data); },
            })),
        } : undefined,
    });

    this.handle = this.create_handle();
    this.initialized = true;

    const init = descriptor["init"];
    init && init(this.handle);
}

/**
 * What the descriptor gets to work with
 */
VirtioDevice.prototype.create_handle = function()
{
    return {
        "name": this.name,
        "is_ready": () => this.is_ready(),
        "has_request": queue_id => this.has_request(queue_id),
        "pop_request": queue_id => this.pop_request(queue_id),
        "flush": queue_id => this.flush(queue_id),
        "is_ram": (address, length) => this.is_ram(address, length),
        "read_memory": (address, length) => this.read_memory(address, length),
        "write_memory": (bytes, address) => this.write_memory(bytes, address),
        "is_feature_negotiated": bit => this.virtio.is_feature_negotiated(bit),
        "needs_reset": () => this.virtio.needs_reset(),
        "config_changed": () => { if(this.is_ready()) this.virtio.notify_config_changes(); },
    };
};

/**
 * The driver has set DRIVER_OK, and neither side has given up
 */
VirtioDevice.prototype.is_ready = function()
{
    const status = this.virtio.device_status;
    return (status & (VIRTIO_STATUS_DRIVER_OK | VIRTIO_STATUS_DEVICE_NEEDS_RESET | VIRTIO_STATUS_FAILED)) ===
        VIRTIO_STATUS_DRIVER_OK;
};

VirtioDevice.prototype.notify = function(queue_id)
{
    if(!this.is_ready() || queue_id >= this.virtio.queues.length) return;
    try
    {
        this.descriptor["notify"](queue_id);
    }
    catch(error)
    {
        // A RangeError is a malformed ring or buffer; anything else is a bug in the device
        if(!(error instanceof RangeError)) console.error("virtio device " + this.name + ":", error);
        this.virtio.needs_reset();
    }
};

VirtioDevice.prototype.get_queue = function(queue_id)
{
    const queue = this.virtio.queues[queue_id];
    if(!queue) throw new Error("virtio device " + this.name + " has no queue " + queue_id);
    return queue;
};

VirtioDevice.prototype.has_request = function(queue_id)
{
    const queue = this.get_queue(queue_id);
    if(!this.is_ready() || !queue.is_configured()) return false;
    // The rings, like every buffer, are DMA: guest RAM, never a device's window
    if(!this.is_ram(queue.desc_addr, queue.size * 16) ||
        !this.is_ram(queue.avail_addr, 6 + queue.size * 2) ||
        !this.is_ram(queue.used_addr, 6 + queue.size * 8))
    {
        this.virtio.needs_reset();
        return false;
    }
    return queue.has_request();
};

/**
 * @return {Object} a request, or null when there is none or the chain is malformed
 * (the driver has been told to reset then)
 */
VirtioDevice.prototype.pop_request = function(queue_id)
{
    const queue = this.get_queue(queue_id);
    if(!this.has_request(queue_id)) return null;

    let chain;
    try
    {
        chain = queue.pop_request();
    }
    catch(error)
    {
        if(!(error instanceof RangeError)) throw error;
        this.virtio.needs_reset();
        return null;
    }
    if(!chain.valid) return null;
    for(const buffer of chain.read_buffers.concat(chain.write_buffers))
    {
        if(buffer.len && !this.is_ram(buffer.address, buffer.len))
        {
            this.virtio.needs_reset();
            return null;
        }
    }

    const generation = this.generation;
    let completed = false;
    return {
        "readable": chain.length_readable,
        "writable": chain.length_writable,
        "read": () =>
        {
            const bytes = new Uint8Array(chain.length_readable);
            chain.get_next_blob(bytes);
            return bytes;
        },
        "write": bytes =>
        {
            return generation === this.generation ? chain.set_next_blob(bytes) : 0;
        },
        // Staged until flush
        "complete": () =>
        {
            if(completed || generation !== this.generation) return;
            completed = true;
            queue.push_reply(chain);
        },
    };
};

VirtioDevice.prototype.flush = function(queue_id)
{
    const queue = this.get_queue(queue_id);
    if(queue.is_configured() && queue.num_staged_replies) queue.flush_replies();
};

/**
 * Plain or extended RAM on the physical bus: not a device window, not the
 * legacy VGA/ROM range and not a hole
 * @param {number} address
 * @param {number} length
 */
VirtioDevice.prototype.is_ram = function(address, length)
{
    return this.classify(address, length) !== -2;
};

/**
 * @param {number} address
 * @param {number} length
 * @return {number} the offset of one contiguous plain-RAM backing,
 *     -1 for other RAM, -2 for anything that is not RAM
 */
VirtioDevice.prototype.classify = function(address, length)
{
    if(!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || address < 0 || length <= 0 ||
        address + length > PHYSICAL_BUS_END ||
        address < LEGACY_HOLE_END && address + length > LEGACY_HOLE_START)
    {
        return -2;
    }

    const kind = this.cpu.wm.exports["x64_phys_kind"];
    const resolve = this.cpu.wm.exports["x64_phys_resolve"];
    const first = resolve(address >>> 0, Math.floor(address / 0x100000000));
    let contiguous = first >= 0;

    for(let page = address - address % PAGE_SIZE; page < address + length; page += PAGE_SIZE)
    {
        const low = page >>> 0;
        const high = Math.floor(page / 0x100000000);
        const page_kind = kind(low, high);
        if(page_kind !== PHYS_KIND_RAM && page_kind !== PHYS_KIND_EXTENDED) return -2;
        // (extended RAM frames are cached, never a view)
        if(contiguous && (page_kind !== PHYS_KIND_RAM ||
            page > address && resolve(low, high) !== first + (page - address)))
        {
            contiguous = false;
        }
    }

    return contiguous ? first : -1;
};

/**
 * @param {number} address
 * @param {number} length
 * @return {!Uint8Array} a view of guest RAM where one contiguous backing
 *     holds the range, a copy otherwise
 */
VirtioDevice.prototype.read_memory = function(address, length)
{
    const backing = this.classify(address, length);
    if(backing === -2)
    {
        throw new RangeError("virtio device " + this.name + ": 0x" + address.toString(16) +
            " (" + length + " bytes) is not guest RAM");
    }
    return backing >= 0 ? this.cpu.mem8.subarray(backing, backing + length) :
        this.cpu.read_blob_physical(address, length);
};

/**
 * Through the bus, which invalidates compiled code
 * @param {!Uint8Array} bytes
 * @param {number} address
 */
VirtioDevice.prototype.write_memory = function(bytes, address)
{
    if(!bytes.length) return;
    if(!this.is_ram(address, bytes.length))
    {
        throw new RangeError("virtio device " + this.name + ": 0x" + address.toString(16) +
            " (" + bytes.length + " bytes) is not guest RAM");
    }
    this.cpu.write_blob_physical(bytes, address);
};

/**
 * A machine reset; also used when a snapshot restores without this device
 */
VirtioDevice.prototype.reset = function()
{
    this.virtio.reset();
};

VirtioDevice.prototype.get_state = function()
{
    const get_state = this.descriptor["get_state"];
    return [this.name, this.virtio, get_state ? get_state() : undefined, this.host_state];
};

/**
 * @param {!Array} entry [name, transport state, device state, host state]
 */
VirtioDevice.prototype.set_state = function(entry)
{
    this.generation++;
    this.virtio.set_state(entry[1]);
    const set_state = this.descriptor["set_state"];
    set_state && set_state(entry[2]);
    this.restored_host_state = entry[3];
};
