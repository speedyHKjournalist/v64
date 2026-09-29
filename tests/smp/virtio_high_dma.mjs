#!/usr/bin/env node
// Exercise the actual VirtIO transport against a sparse 36-bit physical bus.
// This isolates address decoding from RAM allocation: high and low aliases
// deliberately contain different bytes, and legacy 32-bit helpers are absent.
import assert from "node:assert/strict";
import { VirtIO } from "../../src/virtio.js";

globalThis.DEBUG = false;
const LIMIT = 2 ** 36;
const HIGH = 2 ** 32;
const ranges = [[0, 0x10000], [HIGH, HIGH + 0x10000], [LIMIT - 0x1000, LIMIT]];
const bytes = new Map();
const accesses = [];
const cpu = {
    io: { register_read() {}, register_write() {} },
    devices: { pci: { register_device() {}, raise_irq() {}, lower_irq() {} } },
    validate_physical_range(address, length)
    {
        if(!Number.isSafeInteger(address) || !Number.isSafeInteger(length) ||
            address < 0 || length < 0 || address >= LIMIT || length > LIMIT - address ||
            !ranges.some(([start, end]) => address >= start && address + length <= end))
        {
            throw new RangeError("Invalid physical range");
        }
    },
    read_blob_physical(address, length)
    {
        this.validate_physical_range(address, length);
        accesses.push(["read", address, length]);
        return Uint8Array.from({ length }, (_, i) => bytes.get(address + i) || 0);
    },
    write_blob_physical(blob, address)
    {
        this.validate_physical_range(address, blob.length);
        accesses.push(["write", address, blob.length]);
        blob.forEach((byte, i) => bytes.set(address + i, byte));
    },
    read16_physical(address)
    {
        return new DataView(this.read_blob_physical(address, 2).buffer).getUint16(0, true);
    },
    read32_physical(address)
    {
        return new DataView(this.read_blob_physical(address, 4).buffer).getUint32(0, true);
    },
    write16_physical(address, value)
    {
        const blob = new Uint8Array(2);
        new DataView(blob.buffer).setUint16(0, value, true);
        this.write_blob_physical(blob, address);
    },
    write32_physical(address, value)
    {
        const blob = new Uint8Array(4);
        new DataView(blob.buffer).setUint32(0, value, true);
        this.write_blob_physical(blob, address);
    },
};

const options = {
    name: "high-dma-test", pci_id: 0x38, device_id: 0x1041, subsystem_device_id: 1,
    common: { initial_port: 0xD000, features: [28, 29, 32], queues: [{ size_supported: 8, notify_offset: 0 }], on_driver_ok() {} },
    notification: { initial_port: 0xD100, single_handler: true, handlers: [() => {}] },
    isr_status: { initial_port: 0xD200 },
};
const virtio = new VirtIO(cpu, options);
const queue = virtio.queues[0];
const fields = new Map(virtio.create_common_capability(options.common).struct.map(field => [field.name, field]));
function write_address(name, address, high_first = false)
{
    const low = fields.get("queue_" + name + " (low dword)");
    const high = fields.get("queue_" + name + " (high dword)");
    if(high_first) high.write(Math.floor(address / HIGH));
    low.write(address >>> 0);
    if(!high_first) high.write(Math.floor(address / HIGH));
    assert.equal(low.read() >>> 0, address >>> 0);
    assert.equal(high.read() >>> 0, Math.floor(address / HIGH));
}
const table = HIGH + 0x1000, avail = HIGH + 0x2000, used = HIGH + 0x3000;
function configure()
{
    virtio.reset();
    bytes.clear();
    write_address("desc", table, true);
    write_address("avail", avail);
    write_address("used", used, true);
    fields.get("queue_enable").write(1);
    assert.equal(queue.enabled, true);
}
function descriptor(at, address, length, flags, next = 0)
{
    cpu.write32_physical(at, address >>> 0);
    cpu.write32_physical(at + 4, Math.floor(address / HIGH));
    cpu.write32_physical(at + 8, length);
    cpu.write16_physical(at + 12, flags);
    cpu.write16_physical(at + 14, next);
}
function post()
{
    cpu.write16_physical(avail + 2, 1);
    cpu.write16_physical(avail + 4, 0);
    assert.equal(queue.has_request(), true);
    return queue.pop_request();
}
function complete(chain, expected)
{
    assert.equal(chain.valid, true);
    const actual = new Uint8Array(expected.length);
    const first = Math.min(2, actual.length);
    assert.equal(chain.get_next_blob(actual.subarray(0, first)), first);
    assert.equal(chain.get_next_blob(actual.subarray(first)), actual.length - first);
    assert.deepEqual(actual, expected);
    assert.equal(chain.set_next_blob(actual.subarray(0, first)), first);
    assert.equal(chain.set_next_blob(actual.subarray(first)), actual.length - first);
    queue.push_reply(chain);
    queue.flush_replies();
    assert.equal(cpu.read16_physical(used + 2), 1);
    assert.equal(cpu.read32_physical(used + 8), expected.length);
    assert.equal(queue.has_request(), false);
}

configure();
fields.get("queue_desc (low dword)").write(0x8000);
fields.get("queue_desc (high dword)").write(0);
assert.equal(queue.desc_addr, table, "active queue address stays stable until reset");
assert.equal(fields.get("queue_desc (low dword)").read(), 0x1000);
assert.equal(fields.get("queue_desc (high dword)").read(), 1);
const payload = HIGH + 0x4000, reply = HIGH + 0x5000;
const message = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
cpu.write_blob_physical(message, payload);
cpu.write_blob_physical(new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]), 0x5000);
descriptor(table, payload, message.length, 1, 1);
descriptor(table + 16, reply, message.length, 2);
complete(post(), message);
assert.deepEqual(cpu.read_blob_physical(reply, message.length), message);
assert.deepEqual(cpu.read_blob_physical(0x5000, 5), new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]));
assert.ok(accesses.some(([kind, address]) => kind === "read" && address === table));
console.log("PASS VirtIO high direct rings, partial blobs, used ring, no low32 alias");

configure();
const indirect = HIGH + 0x6000, top_reply = LIMIT - message.length;
cpu.write_blob_physical(message, 0x4000);
descriptor(table, indirect, 32, 4);
descriptor(indirect, 0x4000, message.length, 1, 1);
descriptor(indirect + 16, top_reply, message.length, 2);
complete(post(), message);
assert.deepEqual(cpu.read_blob_physical(top_reply, message.length), message);
console.log("PASS VirtIO high indirect table, mixed low/high payload, final 36-bit byte");

const saved = globalThis.structuredClone(queue.get_state());
queue.reset();
assert.deepEqual([...queue.address_words], [0, 0, 0, 0, 0, 0]);
queue.set_state(saved);
assert.equal(queue.desc_addr, table);
assert.equal(queue.avail_addr, avail);
assert.equal(queue.used_addr, used);
assert.equal(fields.get("queue_desc (high dword)").read(), 1);
const legacy = saved.slice(0, 10);
legacy[4] = -2147479552;
legacy[5] = -2147475456;
legacy[7] = -2147471360;
queue.set_state(legacy);
assert.equal(queue.desc_addr, 0x80001000);
assert.equal(queue.avail_addr, 0x80002000);
assert.equal(queue.used_addr, 0x80003000);
assert.deepEqual([...queue.address_words], [0x80001000, 0, 0x80002000, 0, 0x80003000, 0]);
console.log("PASS VirtIO high snapshot/reset and legacy signed32 snapshot");

for(const high of [16, 0x200000, 0xFFFFFFFF])
{
    configure();
    queue.enabled = false;
    fields.get("queue_desc (high dword)").write(high);
    fields.get("queue_desc (low dword)").write(0x12345000);
    assert.equal(fields.get("queue_desc (high dword)").read(), high);
    assert.equal(fields.get("queue_desc (low dword)").read(), 0x12345000);
    const raw_saved = globalThis.structuredClone(queue.get_state());
    queue.reset();
    queue.set_state(raw_saved);
    assert.equal(fields.get("queue_desc (high dword)").read(), high);
    fields.get("queue_enable").write(1);
    assert.equal(queue.enabled, false);
    assert.ok(virtio.device_status & 64);
}
console.log("PASS VirtIO unsupported 64-bit register values preserved and rejected");

for(const [address, length, flags] of [[LIMIT, 4, 0], [HIGH + 0xFFFE, 4, 2], [LIMIT - 2, 4, 2]])
{
    configure();
    descriptor(table, address, length, flags);
    const chain = post();
    assert.equal(chain.valid, false);
    assert.equal(chain.length_readable, 0);
    assert.equal(chain.length_writable, 0);
    assert.ok(virtio.device_status & 64);
    assert.equal(queue.has_request(), false);
    queue.push_reply(chain);
    queue.flush_replies();
    assert.equal(cpu.read16_physical(used + 2), 0);
}
configure();
descriptor(table, indirect, 16, 4);
descriptor(indirect, indirect, 16, 4);
assert.equal(post().valid, false);
assert.ok(virtio.device_status & 64);
console.log("PASS VirtIO out-of-range DMA and nested indirect descriptor fail without completion");
