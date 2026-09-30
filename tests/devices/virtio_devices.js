#!/usr/bin/env node

// Custom virtio devices (the virtio_devices option, src/virtio_devices.js),
// driven through the transport's I/O ports without a guest: PCI identity,
// slot and port allocation, the configuration space, feature negotiation, a
// request round trip, notifications before DRIVER_OK, requests that outlive a
// reset, guest RAM access, machine resets and snapshots (including state[92]
// from before custom devices).

import assert from "assert/strict";

process.on("unhandledRejection", exn => { throw exn; });

const { V86 } = await import("../../src/main.js");
const {
    create_virtio_devices, get_virtio_devices_state, resolve_virtio_devices_state,
} = await import("../../src/virtio_devices.js");

const MEMORY_SIZE = 32 * 1024 * 1024;
const QUEUE_SIZE = 8;

// Replies with the request's bytes reversed, or keeps the request when told to
function echo_device(log)
{
    let dev = null;
    let config_word = 0x1234;
    let echoed = 0;
    const held = [];
    return {
        held,
        get echoed() { return echoed; },
        descriptor: {
            "name": "echo",
            "device_id": 0x10F0,
            "subsystem_device_id": 0x0E40,
            "features": [0],
            "queues": [{ "size": QUEUE_SIZE }],
            "config": [
                { "bytes": 4, "read": () => 0xC0FFEE01 },
                { "bytes": 2, "read": () => config_word, "write": value => { config_word = value; } },
            ],
            "init": handle => { dev = handle; log.push("init"); },
            "notify": queue => {
                log.push("notify " + queue);
                let request;
                while((request = dev["pop_request"](queue)))
                {
                    const bytes = request["read"]();
                    if(bytes[0] === 0xFF)
                    {
                        held.push(request);
                        continue;
                    }
                    request["write"](bytes.reverse());
                    request["complete"]();
                    echoed++;
                }
                dev["flush"](queue);
            },
            "reset": () => { log.push("reset"); },
            "get_state": () => [echoed, config_word],
            "set_state": state => { echoed = state[0]; config_word = state[1]; },
        },
        handle: () => dev,
    };
}

function create_emulator(virtio_devices)
{
    return new V86({
        memory_size: MEMORY_SIZE,
        // hlt forever: nothing moves the BARs from where the device put them
        bios: { buffer: new Uint8Array(65536).fill(0xF4).buffer },
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        net_device: { type: "none" },
        autostart: false,
        log_level: 0,
        virtio_devices,
    });
}

const loaded = emulator => new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const log = [];
const echo = echo_device(log);
const emulator = create_emulator([echo.descriptor]);
await loaded(emulator);

const cpu = emulator.v86.cpu;
const io = cpu.io;
const [device] = cpu.devices.virtio_devices;

assert.deepEqual(log, ["init"], "init runs once, and a reset while the transport is built is not forwarded");

// PCI identity, through configuration mechanism #1
const SLOT = 0x10;
const pci_read32 = offset => {
    io.port_write32(0xCF8, (0x80000000 | SLOT << 11 | offset) >>> 0);
    return io.port_read32(0xCFC) >>> 0;
};
assert.equal(pci_read32(0x00), 0x10F01AF4, "vendor 1AF4 and the descriptor's device ID, in the first free slot");
assert.equal(pci_read32(0x2C), 0x0E401AF4, "subsystem ID");

const bar = n => pci_read32(0x10 + 4 * n) & ~3;
const common = bar(0), notify = bar(1), isr = bar(2), config = bar(3);
assert.equal(common, 0xE000, "ports come from the pool");
assert.deepEqual([notify, isr, config], [0xE100, 0xE200, 0xE300]);

// Device configuration space
assert.equal(io.port_read32(config) >>> 0, 0xC0FFEE01);
assert.equal(io.port_read16(config + 4), 0x1234);
io.port_write16(config + 4, 0xBEEF);
assert.equal(io.port_read16(config + 4), 0xBEEF, "config write reaches the device");

// Guest RAM
const ram = cpu.read_blob(0, MEMORY_SIZE);
const mem = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
const handle = echo.handle();
assert.ok(handle["is_ram"](0x1000, 4096));
assert.ok(!handle["is_ram"](0xA0000, 16), "legacy VGA memory is not RAM");
assert.ok(!handle["is_ram"](0x9FFF0, 32), "nor is a range that reaches into it");
assert.ok(!handle["is_ram"](MEMORY_SIZE - 16, 32), "nor is a range past the end of RAM");
assert.ok(!handle["is_ram"](0x1000, 0));
const view = handle["read_memory"](0x200000, 16);
view[0] = 0x5A;
assert.equal(mem.getUint8(0x200000), 0x5A, "contiguous RAM is read as a view");
handle["write_memory"](new Uint8Array([1, 2, 3]), 0x200010);
assert.equal(mem.getUint8(0x200012), 3);
assert.throws(() => handle["read_memory"](0xA0000, 16), RangeError);
assert.throws(() => handle["write_memory"](new Uint8Array([1]), 0xB8000), RangeError);

// A split virtqueue in guest RAM
const table = 0x10000, avail = table + 128, used = table + 256;
const data = 0x11000, reply = 0x12000;
const w8 = (offset, value) => io.port_write8(common + offset, value);
const w16 = (offset, value) => io.port_write16(common + offset, value);
const w32 = (offset, value) => io.port_write32(common + offset, value);
let avail_idx = 0;

function setup_queue(status)
{
    w8(20, 0);
    w8(20, 3);
    w32(0, 0);
    assert.equal(io.port_read32(common + 4) & 1, 1, "device offers feature bit 0");
    w32(0, 1);
    assert.equal(io.port_read32(common + 4) & 1, 1, "VIRTIO_F_VERSION_1 is added");
    w32(8, 0); w32(12, 1); w32(8, 1); w32(12, 1);
    w8(20, 11);
    assert.equal(io.port_read8(common + 20), 11, "FEATURES_OK accepted");
    w16(22, 0);
    assert.equal(io.port_read16(common + 24), QUEUE_SIZE);
    w32(32, table); w32(36, 0);
    w32(40, avail); w32(44, 0);
    w32(48, used); w32(52, 0);
    for(let i = 0; i < 512; i++) mem.setUint8(table + i, 0);
    w16(28, 1);
    w8(20, status);
    avail_idx = 0;
}

function submit(bytes)
{
    // descriptor 0: the request (readable), descriptor 1: the reply (writable)
    ram.set(bytes, data);
    mem.setUint32(table, data, true); mem.setUint32(table + 8, bytes.length, true);
    mem.setUint16(table + 12, 1, true); mem.setUint16(table + 14, 1, true);
    mem.setUint32(table + 16, reply, true); mem.setUint32(table + 24, 64, true);
    mem.setUint16(table + 28, 2, true);
    mem.setUint16(avail + 4 + (avail_idx % QUEUE_SIZE) * 2, 0, true);
    avail_idx = avail_idx + 1 & 0xFFFF;
    mem.setUint16(avail + 2, avail_idx, true);
    io.port_write16(notify, 0);
}

const used_idx = () => mem.getUint16(used + 2, true);

setup_queue(3);
submit(new Uint8Array([1, 2, 3]));
assert.equal(used_idx(), 0, "no request is taken before DRIVER_OK");
assert.ok(!log.includes("notify 0"), "the device is not notified before DRIVER_OK");

setup_queue(15);
submit(new TextEncoder().encode("hello"));
assert.equal(used_idx(), 1, "used ring acknowledges the request");
assert.equal(mem.getUint32(used + 8, true), 5, "used length is what the device wrote");
assert.equal(new TextDecoder().decode(ram.subarray(reply, reply + 5)), "olleh");
assert.ok(io.port_read8(isr) & 1, "queue interrupt raised");
assert.equal(echo.echoed, 1);

// A request kept past a guest reset must not complete into the new rings
submit(new Uint8Array([0xFF, 1]));
assert.equal(echo.held.length, 1);
log.length = 0;
w8(20, 0);
assert.deepEqual(log, ["reset"], "a guest reset reaches the device");
setup_queue(15);
echo.held[0]["write"](new Uint8Array([9]));
echo.held[0]["complete"]();
handle["flush"](0);
assert.equal(used_idx(), 0, "a stale request neither writes nor completes");
assert.notEqual(mem.getUint8(reply), 9);

// Snapshot: transport, device state
submit(new TextEncoder().encode("ab"));
assert.equal(used_idx(), 1);
const saved = await emulator.save_state();
assert.equal(echo.echoed, 2);
submit(new TextEncoder().encode("cd"));
io.port_write16(config + 4, 0x1111);
assert.equal(echo.echoed, 3);
await emulator.restore_state(saved);
assert.equal(echo.echoed, 2, "device state restored");
assert.equal(io.port_read16(config + 4), 0xBEEF);
assert.equal(io.port_read8(common + 20), 15, "transport state restored");
assert.equal(used_idx(), 1, "guest RAM and the ring restored together");
avail_idx = mem.getUint16(avail + 2, true);
submit(new TextEncoder().encode("xy"));
assert.equal(used_idx(), 2, "the restored queue keeps working");

// Machine reset
log.length = 0;
await emulator.restart();
assert.ok(log.includes("reset"), "a machine reset reaches the device");
assert.equal(io.port_read8(common + 20), 0);

// Descriptor checks and slot collisions, on the live machine
const valid = { "name": "x", "device_id": 0x10F1, "queues": [{ "size": 4 }], "notify": () => {} };
assert.throws(() => create_virtio_devices(cpu, {}), /array/);
assert.throws(() => create_virtio_devices(cpu, [{ ...valid, "name": "" }]), /name/);
assert.throws(() => create_virtio_devices(cpu, [valid, valid]), /more than one device/);
assert.throws(() => create_virtio_devices(cpu, [{ ...valid, "queues": [{ "size": 3 }] }]), /power of two/);
assert.throws(() => create_virtio_devices(cpu, [{ ...valid, "notify": undefined }]), /notify/);
assert.throws(() => create_virtio_devices(cpu, [{ ...valid, "pci_slot": 0x12 }]), /slot 0x12, which is taken/);
assert.throws(() => create_virtio_devices(cpu, [{ ...valid, "io_base": 0xE000 }]), /ports 0xe000, which are taken/);
assert.throws(() => create_virtio_devices(cpu, [{ ...valid, "io_base": 0xE080 }]), /aligned/);
assert.throws(() => create_virtio_devices(cpu,
    [{ ...valid, "config": Array(65).fill({ "bytes": 4, "read": () => 0 }) }]), /256 bytes/);

// state[92] layouts
const fake = (name, upgrade_state) => ({ name, descriptor: { "upgrade_state": upgrade_state } });
assert.equal(get_virtio_devices_state(undefined), undefined, "no devices: state[92] stays empty");
assert.equal(resolve_virtio_devices_state([fake("a")], undefined).size, 0);
assert.throws(() => resolve_virtio_devices_state([], ["virtio_devices", 1, ["gone", [], 0, undefined]]),
    /"gone", which is not configured/);
assert.throws(() => resolve_virtio_devices_state([], ["virtio_devices", 2]), /version 2/);
const legacy = [0x56514731, "transport", 1, 2];
const upgraded = resolve_virtio_devices_state(
    [fake("a", () => null), fake("b", slot => slot[0] === 0x56514731 ? [slot[1], slot.slice(2), "host"] : null)],
    legacy);
assert.deepEqual(upgraded.get("b"), ["b", "transport", [1, 2], "host"], "a legacy slot goes to the device that recognizes it");
assert.throws(() => resolve_virtio_devices_state([fake("a", () => null)], legacy), /no configured virtio device recognizes/);

// A snapshot with the device, restored without it
const plain = create_emulator(undefined);
await loaded(plain);
await assert.rejects(plain.restore_state(saved), /"echo", which is not configured/);
await plain.destroy();

// Descriptors run on the CPU's thread
const { encode_worker_options } = await import("../../src/browser/cpu_worker.js");
globalThis.location = { href: "http://localhost/" };
assert.throws(() => encode_worker_options({ "virtio_devices": [echo.descriptor] }), /CPU Worker cannot transfer virtio_devices/);

await emulator.destroy();
console.log("PASS: custom virtio devices");
