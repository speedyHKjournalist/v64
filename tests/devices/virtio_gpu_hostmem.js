#!/usr/bin/env node

// virtio-gpu's host visible memory (level virgl43-hostmem): the shared
// memory capability and BAR4, HOST3D blobs from PIPE_RESOURCE_CREATE's
// templates, MAP_BLOB and UNMAP_BLOB, and coherency -- what the guest writes
// through a mapping reaches the blob before the GPU runs the next SUBMIT_3D,
// and what the GPU writes into a mapped blob is in the mapping before the
// submit's fence completes -- and snapshots of mappings. GX is a fake here:
// it keeps the buffers' bytes and answers readbacks from them. Mesa's virgl
// on it is tested by tests/x64/linux_gpu.mjs (gltest's buffer-storage cases).

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

// GX opcodes and the readback answer's layout (src/graphics_adapters/renderer_protocol.js)
const GX_SURFACE_DEFINE = 1, GX_SURFACE_UPLOAD = 3, GX_SURFACE_READBACK = 4;
const QUERY_REGION_BYTES = 16 * 1024, READBACK_HEADER_BYTES = 16, RESPONSE_OK = 1;

/** A GX that keeps each buffer's bytes, and answers at once */
function fake_gx()
{
    let to_device = null;
    const buffers = new Map();
    const log = [];
    const renderer = {
        "post": message => {
            if(message["type"] === "reset") { buffers.clear(); return; }
            if(message["type"] !== "submit") return;
            const words = new Uint32Array(message["bytes"].buffer, message["bytes"].byteOffset, message["bytes"].byteLength >> 2);
            const answers = [];
            for(let at = 4; at < words[2];)
            {
                const op = words[at], body = words[at + 1], p = words.subarray(at + 2, at + 2 + body);
                if(op === GX_SURFACE_DEFINE)
                {
                    buffers.set(p[0], new Uint8Array(p[4]));
                    log.push(["define", p[0], p[4]]);
                }
                else if(op === GX_SURFACE_UPLOAD)
                {
                    const [sid, , , x, , , w] = p;
                    const bytes = new Uint8Array(p.buffer, p.byteOffset + 11 * 4, w);
                    buffers.get(sid).set(bytes, x);
                    log.push(["upload", sid, x, w, Array.from(bytes)]);
                }
                else if(op === GX_SURFACE_READBACK)
                {
                    const [sid, , , x, , , w, , , id] = p;
                    const answer = new Uint8Array(READBACK_HEADER_BYTES + w);
                    const v = new DataView(answer.buffer);
                    v.setUint32(0, id, true);
                    v.setUint32(4, w, true);
                    v.setUint32(12, RESPONSE_OK, true);
                    answer.set(buffers.get(sid).subarray(x, x + w), READBACK_HEADER_BYTES);
                    answers.push({ "type": "write", "offset": QUERY_REGION_BYTES, "bytes": answer });
                    log.push(["readback", sid, x, w]);
                }
                at += 2 + body;
            }
            for(const answer of answers) to_device(answer);
            to_device({ "type": "done", "seq": message["seq"] });
        },
        "listen": handler => { to_device = handler; },
    };
    return { renderer, buffers, log };
}
const gx = fake_gx();

// hlt forever
const floppy = new Uint8Array(1474560);
floppy.set([0xfa, 0xf4, 0xeb, 0xfd]);
floppy[510] = 0x55;
floppy[511] = 0xAA;

const emulator = new V86({
    graphics_adapter: "virtio_gpu",
    graphics_adapter_test: { level: "virgl43-hostmem", renderer: gx.renderer },
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    fda: { buffer: floppy.buffer },
    boot_order: 0x321,
    autostart: true,
    memory_size: 64 << 20,
    vram_size: 16 << 20,
    net_device: { type: "none" },
    disable_speaker: true,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));
await emulator.wait_until_vga_screen_contains("Booting from Floppy", { timeout_msec: 30000 });
await emulator.stop();

const cpu = emulator.v86.cpu, io = cpu.io;
const BDF = 0x12 << 3;
const pci_read = reg => { io.port_write32(0xcf8, 0x80000000 | BDF << 8 | reg); return io.port_read32(0xcfc) >>> 0; };
const pci_read8 = reg => pci_read(reg & ~3) >>> 8 * (reg & 3) & 0xFF;

// BAR4: 64 MiB of prefetchable memory, which SeaBIOS placed
const HOSTMEM = 64 << 20;
const bar4 = pci_read(0x20);
assert.equal(bar4 & 0xF, 8, "BAR4: 32-bit prefetchable memory");
const hostmem = (bar4 & ~0xF) >>> 0;
assert.ok(hostmem >= 0xE0000000 && hostmem % HOSTMEM === 0, "placed in the PCI memory window: " + hostmem.toString(16));

// The shared memory capability: struct virtio_pci_cap64, region 1 (host visible), all of BAR4
let shm = null, common = 0, notify = 0;
const bar2 = (pci_read(0x18) & ~0xF) >>> 0;
for(let at = pci_read8(0x34); at; at = pci_read8(at + 1))
{
    if(pci_read8(at) !== 0x09) continue;
    const type = pci_read8(at + 3);
    if(type === 8) shm = { len: pci_read8(at + 2), bar: pci_read8(at + 4), id: pci_read8(at + 5), offset: pci_read(at + 8),
        length: pci_read(at + 12), offset_hi: pci_read(at + 16), length_hi: pci_read(at + 20) };
    if(type === 1) common = bar2 + pci_read(at + 8);
    if(type === 2) notify = bar2 + pci_read(at + 8);
}
assert.deepEqual(shm, { len: 24, bar: 4, id: 1, offset: 0, length: HOSTMEM, offset_hi: 0, length_hi: 0 });
console.log("PASS: BAR4 at " + hostmem.toString(16) + " and the shared memory capability");

// The transport
const write32 = (address, value) => { for(let i = 0; i < 4; i++) cpu.write8(address + i, value >>> 8 * i & 0xFF); };
const read32 = address => (cpu.read8(address) | cpu.read8(address + 1) << 8 | cpu.read8(address + 2) << 16 | cpu.read8(address + 3) << 24) >>> 0;
const write_bytes = (address, bytes) => bytes.forEach((b, i) => cpu.write8(address + i, b));
const read_bytes = (address, length) => Array.from({ length }, (_, i) => cpu.read8(address + i));
const w8 = (offset, value) => cpu.write8(common + offset, value);
const w16 = (offset, value) => { cpu.write8(common + offset, value & 0xFF); cpu.write8(common + offset + 1, value >> 8); };
const QUEUES = [{ size: 0, desc: 0x100000, avail: 0x101000, used: 0x102000, avail_idx: 0 },
    { size: 0, desc: 0x110000, avail: 0x111000, used: 0x112000, avail_idx: 0 }];

w8(20, 0);
w8(20, 3);
write32(common, 0);
const features0 = read32(common + 4);
assert.equal(features0 & 0x19, 0x19, "VIRGL, RESOURCE_BLOB, CONTEXT_INIT");
write32(common + 8, 0); write32(common + 12, features0);
write32(common + 8, 1); write32(common + 12, 1);
w8(20, 11);
QUEUES.forEach((q, i) => {
    w16(22, i);
    q.size = cpu.read8(common + 24) | cpu.read8(common + 25) << 8;
    write32(common + 32, q.desc); write32(common + 36, 0);
    write32(common + 40, q.avail); write32(common + 44, 0);
    write32(common + 48, q.used); write32(common + 52, 0);
    for(let j = 0; j < 0x3000; j += 4) write32(q.desc + j, 0);
    w16(28, 1);
});
w8(20, 15);

const REQUEST = 0x200000, REPLY = 0x280000;
function submit(bytes)
{
    const q = QUEUES[0];
    write_bytes(REQUEST, bytes);
    write32(q.desc, REQUEST); write32(q.desc + 4, 0); write32(q.desc + 8, bytes.length);
    cpu.write8(q.desc + 12, 1); cpu.write8(q.desc + 14, 1);
    for(let i = 0; i < 64; i += 4) write32(REPLY + i, 0xDEADBEEF);
    write32(q.desc + 16, REPLY); write32(q.desc + 20, 0); write32(q.desc + 24, 64);
    cpu.write8(q.desc + 28, 2);
    write32(q.avail + 4 + (q.avail_idx % q.size) * 2, 0);
    q.avail_idx = q.avail_idx + 1 & 0xFFFF;
    cpu.write8(q.avail + 2, q.avail_idx & 0xFF);
    cpu.write8(q.avail + 3, q.avail_idx >> 8);
    const before = read32(q.used) >>> 16;
    cpu.write8(notify, 0);
    cpu.write8(notify + 1, 0);
    assert.equal(read32(q.used) >>> 16, before + 1 & 0xFFFF, "completed at once (the fake GX answers at once)");
    return read32(REPLY);
}
const CTX = 1;
const command = (type, ...values) => {
    const out = new Uint32Array(6 + values.length);
    out[0] = type;
    out[4] = CTX;
    out.set(values, 6);
    return submit(new Uint8Array(out.buffer));
};
const OK = 0x1100, OK_MAP_INFO = 0x1106, ERR_INVALID_PARAMETER = 0x1205, ERR_INVALID_RESOURCE_ID = 0x1203;
/** SUBMIT_3D of virgl commands */
const submit_3d = (...words) => command(0x0207, words.length * 4, 0, ...words);

assert.equal(command(0x0200, 0, 0), OK, "CTX_CREATE");
assert.equal(submit_3d(), OK, "an empty SUBMIT_3D");

// PIPE_RESOURCE_CREATE (48): a buffer of 3 pages, blob id 7; then the blob
const RES = 5, SIZE = 3 * 4096, BLOB_ID = 7, MAPPABLE = 1;
assert.equal(submit_3d(48 | 11 << 16, 0, 64, 1 << 4, SIZE, 1, 1, 1, 0, 0, 0, BLOB_ID), OK);
assert.equal(command(0x010C, RES, 2, MAPPABLE, 0, BLOB_ID, 0, SIZE, 0), OK, "RESOURCE_CREATE_BLOB, HOST3D");
assert.equal(submit_3d(), OK);
assert.ok(gx.log.some(e => e[0] === "define" && e[1] === RES && e[2] === SIZE), "a GX buffer of the template's size");
assert.equal(command(0x010C, RES + 1, 2, MAPPABLE, 0, BLOB_ID, 0, SIZE, 0), ERR_INVALID_PARAMETER,
    "a template makes one blob");

// MAP_BLOB: OK_MAP_INFO, cached
const OFFSET = 16 * 4096, base = hostmem + OFFSET;
assert.equal(command(0x0208, RES, 0, OFFSET, 0), OK_MAP_INFO, "MAP_BLOB");
assert.equal(read32(REPLY + 24), 1, "VIRTIO_GPU_MAP_CACHE_CACHED");
assert.equal(command(0x0208, RES, 0, OFFSET, 0), ERR_INVALID_PARAMETER, "mapped once");
assert.equal(command(0x0208, 99, 0, 0, 0), ERR_INVALID_RESOURCE_ID);
assert.deepEqual(read_bytes(base, 8), [0, 0, 0, 0, 0, 0, 0, 0], "a new mapping reads as zeros");
console.log("PASS: PIPE_RESOURCE_CREATE, HOST3D blob, MAP_BLOB");

// The guest writes pages 0 and 2 through the mapping: SUBMIT_3D uploads them first
gx.log.length = 0;
write_bytes(base + 100, [1, 2, 3, 4]);
write_bytes(base + 2 * 4096 + 5, [9, 8]);
assert.equal(submit_3d(), OK);
const uploads = gx.log.filter(e => e[0] === "upload");
assert.deepEqual(uploads.map(e => e.slice(1, 4)), [[RES, 0, 4096], [RES, 8192, 4096]], "the two written pages, nothing else");
assert.deepEqual(gx.buffers.get(RES).subarray(100, 104), Uint8Array.from([1, 2, 3, 4]));
assert.deepEqual(gx.buffers.get(RES).subarray(8197, 8199), Uint8Array.from([9, 8]));
gx.log.length = 0;
assert.equal(submit_3d(), OK);
assert.equal(gx.log.filter(e => e[0] === "upload").length, 0, "no page written since: no upload");
console.log("PASS: the guest's writes reach the blob before the GPU work");

// The GPU writes it (RESOURCE_INLINE_WRITE, 9: res, level, usage, stride,
// layer stride, x, y, z, w, h, d, data): it is read back into the mapping
// before the submit completes
gx.log.length = 0;
assert.equal(submit_3d(9 | 13 << 16, RES, 0, 0, 0, 0, 4096 + 16, 0, 0, 8, 1, 1, 0x44332211, 0x88776655), OK);
assert.ok(gx.log.some(e => e[0] === "readback" && e[1] === RES), "read back");
assert.deepEqual(read_bytes(base + 4096 + 16, 8), [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88], "the GPU's bytes, in the mapping");
assert.deepEqual(read_bytes(base + 100, 4), [1, 2, 3, 4], "and the guest's are still there");
console.log("PASS: the GPU's writes reach the mapping before the fence");

// A snapshot: the mapping and the blob come back
const state = await emulator.save_state();
write_bytes(base + 100, [0, 0, 0, 0]);
await emulator.restore_state(state);
assert.deepEqual(read_bytes(base + 100, 4), [1, 2, 3, 4], "the mapping's bytes");
assert.deepEqual(read_bytes(base + 4096 + 16, 4), [0x11, 0x22, 0x33, 0x44]);
assert.deepEqual(gx.buffers.get(RES).subarray(4096 + 16, 4096 + 20), Uint8Array.from([0x11, 0x22, 0x33, 0x44]), "the blob, in GX again");
gx.log.length = 0;
write_bytes(base + 2 * 4096, [7]);
assert.equal(submit_3d(), OK);
assert.deepEqual(gx.log.filter(e => e[0] === "upload").map(e => e.slice(1, 4)), [[RES, 8192, 4096]], "still mapped after the restore");
console.log("PASS: snapshots keep mappings");

// UNMAP_BLOB, then the pages are of no blob; UNREF
assert.equal(command(0x0209, RES, 0), OK, "UNMAP_BLOB");
assert.equal(command(0x0209, RES, 0), ERR_INVALID_RESOURCE_ID, "unmapped once");
gx.log.length = 0;
write_bytes(base, [5]);
assert.equal(submit_3d(), OK);
assert.equal(gx.log.filter(e => e[0] === "upload").length, 0, "nothing uploaded for an unmapped blob");
assert.equal(command(0x0102, RES, 0), OK, "RESOURCE_UNREF");
console.log("PASS: UNMAP_BLOB");

emulator.destroy();
