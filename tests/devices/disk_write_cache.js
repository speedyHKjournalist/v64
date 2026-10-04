#!/usr/bin/env node

// The blocks written to the lazily loaded disks (AsyncFileBuffer and
// AsyncXHRBuffer in src/buffer.js; docs/sata.md): reads see them over the
// source, they are kept in chunks of 65536 blocks (16 MiB), and a snapshot
// holds their numbers and those chunks, so the manifest of a V7 snapshot stays
// small however much was written (with 1.5 GB written, it listed millions of
// 256-byte buffers: "Invalid V7 snapshot: manifest too large"). Snapshots of
// the format before still restore. DISK_WRITE_MB=1536 writes as much as
// Windows 8.1 did installing VMware Tools (the default writes 40 MB).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { AsyncFileBuffer } = await import("../../src/buffer.js");

const BLOCK = 256, CHUNK_BLOCKS = 0x10000;
const WRITE_MB = +(process.env.DISK_WRITE_MB || 40);

let failed = 0, passed = 0;
async function test(name, f)
{
    try
    {
        await f();
        passed++;
        console.log("ok - " + name);
    }
    catch(e)
    {
        failed++;
        console.log("FAIL - " + name);
        console.log(e);
    }
}

// AsyncFileBuffer over a "file" of 32 MiB whose every 32-bit word holds its own
// offset. It reads with FileReaderSync, as in the CPU worker; the slices are
// real Blobs (for get_as_file), read here from the bytes they were made of.
const SOURCE_SIZE = 32 << 20;
const source = new Uint8Array(SOURCE_SIZE);
new Uint32Array(source.buffer).forEach((_, i, words) => { words[i] = i * 4; });
const slice_bytes = new WeakMap();
const file = {
    size: SOURCE_SIZE,
    slice(start = 0, end = SOURCE_SIZE)
    {
        const bytes = source.subarray(start, end), blob = new Blob([bytes]);
        slice_bytes.set(blob, bytes);
        return blob;
    },
};
globalThis.FileReaderSync = class { readAsArrayBuffer(blob) { return slice_bytes.get(blob).slice().buffer; } };

// the data written to a block: its number, then a byte of its own
function written(index, round = 0)
{
    const data = new Uint8Array(BLOCK).fill(index * 7 + round & 255);
    new DataView(data.buffer).setFloat64(0, index * 2 + round, true);
    return data;
}
function expected(offset, length, writes)
{
    const result = source.slice(offset, offset + length);
    for(let at = 0; at < length; at += BLOCK)
    {
        const round = writes.get((offset + at) / BLOCK);
        if(round !== undefined) result.set(written((offset + at) / BLOCK, round), at);
    }
    return result;
}
function read(disk, offset, length)
{
    let result;
    disk.get(offset, length, data => { result = data.slice(); });
    assert.ok(result, "synchronous read");
    return result;
}
function write(disk, writes, index, count = 1, round = 0)
{
    const data = new Uint8Array(count * BLOCK);
    for(let i = 0; i < count; i++)
    {
        data.set(written(index + i, round), i * BLOCK);
        writes.set(index + i, round);
    }
    disk.set(index * BLOCK, data, () => {});
}

const disk = new AsyncFileBuffer(file);
const writes = new Map();

await test("reads see the blocks written over the file; a block written again keeps its slot", () => {
    assert.deepEqual(read(disk, 0x10000, 0x1000), source.subarray(0x10000, 0x11000), "nothing written: the file");
    write(disk, writes, 0x103, 3);
    write(disk, writes, 0x200);
    assert.equal(disk.written_blocks.size, 4);
    assert.equal(disk.write_chunks.length, 1);
    assert.deepEqual(read(disk, 0x10000, 0x1000), expected(0x10000, 0x1000, writes), "partly written");
    assert.deepEqual(read(disk, 0x20000, BLOCK), written(0x200), "one block, all written");
    write(disk, writes, 0x104, 1, 1);
    assert.equal(disk.written_blocks.size, 4, "the same slot");
    assert.deepEqual(read(disk, 0x10000, 0x1000), expected(0x10000, 0x1000, writes));
});

await test("get_from_cache and get_and_cache: blocks kept from reads give way to writes", () => {
    assert.equal(disk.get_from_cache(0x10300, 0x400), undefined, "not all there");
    assert.deepEqual(disk.get_from_cache(0x10300, 0x300), expected(0x10300, 0x300, writes), "all written");
    let cached;
    disk.get_and_cache(0x30000, 0x400, data => { cached = data.slice(); });
    assert.deepEqual(cached, source.subarray(0x30000, 0x30400));
    assert.equal(disk.block_cache.size, 4, "kept from the read");
    assert.deepEqual(disk.get_from_cache(0x30000, 0x400), source.subarray(0x30000, 0x30400));
    write(disk, writes, 0x301);
    assert.equal(disk.block_cache.size, 3, "the written block is not kept twice");
    assert.deepEqual(disk.get_from_cache(0x30000, 0x400), expected(0x30000, 0x400, writes));
    assert.deepEqual(read(disk, 0x2FF00, 0x600), expected(0x2FF00, 0x600, writes));
});

await test("chunks: the 65537th block written starts a second chunk", () => {
    // 65536 more blocks from block 0x10000 (offset 16 MiB), in 64 KiB writes
    for(let i = 0; i < CHUNK_BLOCKS; i += 256) write(disk, writes, 0x10000 + i, 256);
    assert.equal(disk.written_blocks.size, 5 + CHUNK_BLOCKS);
    assert.equal(disk.write_chunks.length, 2);
    assert.equal(disk.write_chunks[0].length, CHUNK_BLOCKS * BLOCK);
    assert.deepEqual(read(disk, 0x1000000, 0x1000000), expected(0x1000000, 0x1000000, writes), "16 MiB across both chunks");
});

let state;
await test("get_state: the block numbers in the order of the chunks, the last only as far as written", () => {
    state = disk.get_state();
    assert.equal(state[0], null);
    assert.ok(state[1] instanceof Float64Array);
    assert.equal(state[1].length, disk.written_blocks.size);
    assert.equal(state[2].length, 2);
    assert.equal(state[2][0].buffer, disk.write_chunks[0].buffer, "referenced, not copied");
    assert.equal(state[2][1].length, 5 * BLOCK);
    state[1].forEach((index, slot) => {
        const chunk = state[2][Math.floor(slot / CHUNK_BLOCKS)], at = slot % CHUNK_BLOCKS * BLOCK;
        if(Buffer.compare(chunk.subarray(at, at + BLOCK), written(index, writes.get(index))))
            assert.fail("slot " + slot + ": not the data of block " + index);
    });
});

await test("set_state: a full chunk is taken as it is, the last is copied; writes after the restore", () => {
    // as a restore makes them: new buffers
    const restored = [null, state[1].slice(), state[2].map(chunk => chunk.slice())];
    const other = new AsyncFileBuffer(file);
    other.get_and_cache(0, 0x400, () => {});
    other.set_state(restored);
    assert.equal(other.block_cache.size, 0, "blocks kept from reads are dropped");
    assert.equal(other.write_chunks[0], restored[2][0], "the full chunk");
    assert.equal(other.write_chunks[1].length, CHUNK_BLOCKS * BLOCK, "the last one, copied to a chunk of full size");
    assert.deepEqual(read(other, 0, 0x2000000), expected(0, 0x2000000, writes), "all 32 MiB");
    const after = new Map(writes);
    write(other, after, 0x10010, 1, 2);
    write(other, after, 0x400, 2, 2);
    assert.equal(other.written_blocks.size, disk.written_blocks.size + 2);
    assert.deepEqual(read(other, 0, 0x2000000), expected(0, 0x2000000, after));
    assert.deepEqual(read(disk, 0, 0x2000000), expected(0, 0x2000000, writes), "the original disk is unchanged");
});

await test("set_state: snapshots from before ([[block number, 256 bytes], ...])", () => {
    const other = new AsyncFileBuffer(file);
    const before = new Map([[5, 0], [0x1FFFF, 0], [6, 0]]);
    other.set_state([Array.from(before.keys(), index => [index, written(index)])]);
    assert.equal(other.written_blocks.size, 3);
    assert.deepEqual(read(other, 0, 0x1000), expected(0, 0x1000, before));
    assert.deepEqual(read(other, 0x1FFFF00, BLOCK), written(0x1FFFF));
    other.set_state([[]]);
    assert.equal(other.written_blocks.size, 0, "nothing written");
    assert.deepEqual(read(other, 0, 0x1000), source.subarray(0, 0x1000));
});

await test("set_state: invalid states", () => {
    const other = new AsyncFileBuffer(file);
    const chunk = new Uint8Array(2 * BLOCK);
    assert.throws(() => other.set_state([null, Float64Array.of(1), [chunk]]), /block numbers/, "one number for two blocks");
    assert.throws(() => other.set_state([null, Float64Array.of(1, SOURCE_SIZE / BLOCK), [chunk]]), /block numbers/, "beyond the disk");
    assert.throws(() => other.set_state([null, Float64Array.of(1, 2.5), [chunk]]), /block numbers/);
    assert.throws(() => other.set_state([null, Float64Array.of(1), [new Uint8Array(100)]]), /chunk/);
    const full = new Uint8Array(CHUNK_BLOCKS * BLOCK), twice = new Float64Array(CHUNK_BLOCKS).map((_, i) => i);
    twice[7] = 3;
    assert.throws(() => other.set_state([null, twice, [full]]), /twice/);
});

await test("get_as_file: the file with the blocks written, a part for each run of them", async () => {
    const RealFile = globalThis.File;
    let parts;
    globalThis.File = class extends RealFile { constructor(list, name) { super(list, name); parts = list.length; } };
    const file = disk.get_as_file("disk.img");
    globalThis.File = RealFile;
    assert.equal(file.name, "disk.img");
    const result = new Uint8Array(await file.arrayBuffer());
    assert.equal(result.length, SOURCE_SIZE);
    assert.ok(Buffer.from(result).equals(Buffer.from(expected(0, SOURCE_SIZE, writes))));
    // the file before 0x103, blocks 0x103-0x105, file, 0x200, file, 0x301, file,
    // 0x10000 up to the end of the first chunk, the 5 blocks in the second
    assert.equal(parts, 9);
});

// A machine whose disk (an AsyncXHRBuffer reading a file here) had WRITE_MB
// written, in 64 KiB runs, every other one
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v86-disk-write-cache-"));
const image = path.join(directory, "disk.img");
const IMAGE_SIZE = Math.max(64, WRITE_MB * 2) * 1024 * 1024;
fs.writeFileSync(image, "");
fs.truncateSync(image, IMAGE_SIZE);
const RUN_BLOCKS = 256, RUNS = WRITE_MB * 16;
function run_data(run)
{
    const data = new Uint8Array(RUN_BLOCKS * BLOCK).fill(run * 13 & 255);
    const view = new DataView(data.buffer);
    for(let i = 0; i < RUN_BLOCKS; i++) view.setUint32(i * BLOCK, run * 2 * RUN_BLOCKS + i, true);
    return data;
}

async function machine()
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        hda: { url: image, async: true },
        memory_size: 32 * 1024 * 1024,
        autostart: false,
        log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    return { emulator, disk: emulator.v86.cpu.devices.ide.primary.master.buffer };
}
function read_async(disk, offset, length)
{
    return new Promise(resolve => disk.get(offset, length, data => resolve(data.slice())));
}
async function check_disk(disk, label)
{
    for(let run = 0; run < RUNS; run++)
    {
        const offset = run * 2 * RUN_BLOCKS * BLOCK;
        const data = await read_async(disk, offset, 2 * RUN_BLOCKS * BLOCK);
        if(!Buffer.from(data.subarray(0, RUN_BLOCKS * BLOCK)).equals(Buffer.from(run_data(run))) ||
            data.subarray(RUN_BLOCKS * BLOCK).some(byte => byte !== 0))
        {
            assert.fail(label + ": run " + run + " differs");
        }
    }
}

const first = await machine();
let t = performance.now();
for(let run = 0; run < RUNS; run++) first.disk.set(run * 2 * RUN_BLOCKS * BLOCK, run_data(run), () => {});
console.log(`  ${WRITE_MB} MB written in ${Math.round(performance.now() - t)} ms: ` +
    `${first.disk.written_blocks.size} blocks, ${first.disk.write_chunks.length} chunks`);

await test("V7: the manifest stays small, and the disk is as written after a restore", async () => {
    const snapshot = path.join(directory, "state.v7");
    const out = fs.openSync(snapshot, "w");
    let size = 0;
    t = performance.now();
    await first.emulator.save_state_stream(bytes => { fs.writeSync(out, bytes); size += bytes.length; });
    fs.closeSync(out);
    const save_ms = Math.round(performance.now() - t);
    const header = new DataView(new ArrayBuffer(32));
    const fd = fs.openSync(snapshot, "r");
    fs.readSync(fd, new Uint8Array(header.buffer), 0, 32, 0);
    const manifest = header.getUint32(12, true), buffers = header.getUint32(16, true);
    console.log(`  saved ${Math.round(size / 1048576)} MB in ${save_ms} ms: manifest ${manifest} bytes, ${buffers} buffers`);
    assert.ok(size > WRITE_MB * 1024 * 1024);
    assert.ok(manifest < 256 * 1024, "manifest: " + manifest + " bytes");
    assert.ok(buffers < 1000, buffers + " buffers");

    const second = await machine();
    t = performance.now();
    await second.emulator.restore_state_stream({ size, read: async (offset, length) => {
        const bytes = new Uint8Array(length);
        assert.equal(fs.readSync(fd, bytes, 0, length, offset), length);
        return bytes;
    } });
    fs.closeSync(fd);
    console.log(`  restored in ${Math.round(performance.now() - t)} ms`);
    assert.equal(second.disk.written_blocks.size, RUNS * RUN_BLOCKS);
    await check_disk(second.disk, "restored");
    second.emulator.destroy();
    fs.rmSync(snapshot);
});

await test("V6 (save_state): the same disk after a restore", async () => {
    if(WRITE_MB > 1024) return;
    const snapshot = await first.emulator.save_state();
    const second = await machine();
    await second.emulator.restore_state(snapshot);
    await check_disk(second.disk, "restored");
    second.emulator.destroy();
});

first.emulator.destroy();
fs.rmSync(directory, { recursive: true });
console.log((failed ? "FAIL" : "PASS") + ": " + passed + " disk write cache tests passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
