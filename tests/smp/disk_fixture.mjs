// Test-only disks. Host image descriptors are opened read-only; guest writes
// exist only in sector overlays and never call a host-file write operation.
import fs from "node:fs";
import assert from "node:assert/strict";

export class ReadOnlyOverlayDisk
{
    constructor(filename)
    {
        this.fd = fs.openSync(filename, "r");
        this.byteLength = fs.fstatSync(this.fd).size;
        this.overlay = new Map();
    }
    load() { this.onload?.({}); }
    get(start, length, done)
    {
        assert.ok(start >= 0 && start + length <= this.byteLength);
        const data = new Uint8Array(length);
        assert.equal(fs.readSync(this.fd, data, 0, length, start), length);
        for(let sector = Math.floor(start / 512); sector * 512 < start + length; sector++)
        {
            const changed = this.overlay.get(sector);
            if(!changed) continue;
            const from = Math.max(start, sector * 512), to = Math.min(start + length, (sector + 1) * 512);
            data.set(changed.subarray(from - sector * 512, to - sector * 512), from - start);
        }
        done(data);
    }
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache() { return undefined; }
    set(start, data, done)
    {
        assert.ok(start >= 0 && start + data.length <= this.byteLength);
        for(let at = 0; at < data.length;)
        {
            const sector = Math.floor((start + at) / 512), within = (start + at) % 512;
            let changed = this.overlay.get(sector);
            if(!changed)
            {
                this.get(sector * 512, 512, bytes => { changed = bytes; });
                this.overlay.set(sector, changed);
            }
            const count = Math.min(512 - within, data.length - at);
            changed.set(data.subarray(at, at + count), within);
            at += count;
        }
        done?.();
    }
    get_buffer(done) { done(undefined); }
    get_state()
    {
        const sectors = [...this.overlay.keys()].sort((a, b) => a - b);
        const bytes = new Uint8Array(sectors.length * 512);
        sectors.forEach((sector, i) => bytes.set(this.overlay.get(sector), i * 512));
        return [1, this.byteLength, Uint32Array.from(sectors), bytes];
    }
    // Also takes the written-block cache of the browser's lazily loaded disks
    // (AsyncXHRBuffer and friends in src/buffer.js: [[[block, 256 bytes], ...]]),
    // so snapshots saved by a website restore here. Checked by hand: a failing
    // node:assert comparison renders the whole value into a line diff whose cost
    // is quadratic, and node is SIGKILLed with no output long before it throws.
    set_state(state)
    {
        const fail = what => { throw new Error(`Snapshot state of disk (${this.byteLength} bytes) ${what}`); };
        if(!Array.isArray(state)) fail("is not an array");
        if(state[0] === 1)
        {
            if(state[1] !== this.byteLength) fail(`is for a disk of ${state[1]} bytes`);
            if(!(state[2] instanceof Uint32Array) || !(state[3] instanceof Uint8Array) ||
                state[2].length * 512 !== state[3].length) fail("has an invalid sector overlay");
            this.overlay.clear();
            state[2].forEach((sector, i) => this.overlay.set(sector, state[3].slice(i * 512, (i + 1) * 512)));
        }
        else if(state.length === 1 && Array.isArray(state[0]))
        {
            for(const entry of state[0])
            {
                if(!Array.isArray(entry) || !Number.isSafeInteger(entry[0]) || entry[0] < 0 ||
                    (entry[0] + 1) * 256 > this.byteLength ||
                    !(entry[1] instanceof Uint8Array) || entry[1].length !== 256) fail("has an invalid block cache entry");
            }
            this.overlay.clear();
            for(const [block, bytes] of state[0]) this.set(block * 256, bytes);
        }
        else fail("has an unknown format (only an overlay or a browser block cache restore here)");
    }
    close() { fs.closeSync(this.fd); }
}

export class MemoryDisk
{
    constructor(bytes) { this.bytes = bytes; this.byteLength = bytes.length; }
    load() { this.onload?.({}); }
    get(start, length, done) { assert.ok(start + length <= this.byteLength); done(this.bytes.subarray(start, start + length)); }
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache(start, length) { return this.bytes.subarray(start, start + length); }
    set(start, bytes, done) { this.bytes.set(bytes, start); done?.(); }
    get_buffer(done) { done(this.bytes.slice().buffer); }
    get_state() { return [this.byteLength, this.bytes]; }
    set_state(state)
    {
        // (not assert.equal: see ReadOnlyOverlayDisk.set_state)
        if(state[0] !== this.byteLength || !(state[1] instanceof Uint8Array) || state[1].length !== this.byteLength)
            throw new Error(`Snapshot state does not fit this ${this.byteLength}-byte memory disk`);
        this.bytes = state[1].slice();
    }
}

// One MBR FAT16 partition, 16 MiB disk, 2 KiB clusters, 8.3 root files.
export function make_fat16(files)
{
    const bytes = new Uint8Array(16 << 20), view = new DataView(bytes.buffer);
    const partition = 63, total = bytes.length / 512 - partition, boot = partition * 512;
    const fat_sectors = 32, root_sectors = 32, cluster_sectors = 4;
    const fat = boot + 512, root = fat + 2 * fat_sectors * 512, data = root + root_sectors * 512;
    const ascii = (at, text) => bytes.set(Buffer.from(text, "ascii"), at);
    const word = (at, value) => view.setUint16(at, value, true);
    const dword = (at, value) => view.setUint32(at, value, true);
    bytes.set([0xFA,0xEB,0xFD]);
    dword(440, 0xC3002026);
    bytes[446] = 0x80; bytes.set([1,1,0], 447);
    bytes[450] = 0x0E; bytes.set([0xFE,0xFF,0xFF], 451);
    dword(454, partition); dword(458, total); word(510, 0xAA55);
    bytes.set([0xEB,0x3C,0x90], boot); ascii(boot + 3, "C3TOOLS ");
    word(boot + 11, 512); bytes[boot + 13] = cluster_sectors; word(boot + 14, 1); bytes[boot + 16] = 2;
    word(boot + 17, 512); word(boot + 19, total); bytes[boot + 21] = 0xF8;
    word(boot + 22, fat_sectors); word(boot + 24, 63); word(boot + 26, 16); dword(boot + 28, partition);
    bytes[boot + 36] = 0x80; bytes[boot + 38] = 0x29; dword(boot + 39, 0xC3202026);
    ascii(boot + 43, "C3TOOLS    "); ascii(boot + 54, "FAT16   "); word(boot + 510, 0xAA55);
    word(fat, 0xFFF8); word(fat + 2, 0xFFFF);
    let next = 2, entry = root;
    for(const [filename, contents] of Object.entries(files))
    {
        const [name, extension = ""] = filename.toUpperCase().split(".");
        assert.ok(name.length <= 8 && extension.length <= 3);
        ascii(entry, name.padEnd(8) + extension.padEnd(3)); bytes[entry + 11] = 0x20;
        const clusters = Math.ceil(contents.length / (cluster_sectors * 512));
        word(entry + 26, clusters ? next : 0); dword(entry + 28, contents.length);
        word(entry + 24, (46 << 9) | (9 << 5) | 27);
        for(let i = 0; i < clusters; i++) word(fat + (next + i) * 2, i + 1 === clusters ? 0xFFFF : next + i + 1);
        bytes.set(contents, data + (next - 2) * cluster_sectors * 512);
        next += clusters; entry += 32;
    }
    assert.ok(next * 2 <= fat_sectors * 512 && entry < root + root_sectors * 512);
    bytes.set(bytes.subarray(fat, fat + fat_sectors * 512), fat + fat_sectors * 512);
    return bytes;
}

export function read_fat16(bytes, filename)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset), word = at => view.getUint16(at, true), dword = at => view.getUint32(at, true);
    const boot = dword(454) * 512, cluster_bytes = bytes[boot + 13] * 512;
    const fat = boot + word(boot + 14) * 512, root = fat + bytes[boot + 16] * word(boot + 22) * 512;
    const data = root + Math.ceil(word(boot + 17) * 32 / 512) * 512;
    const [name, extension = ""] = filename.toUpperCase().split(".");
    const wanted = name.padEnd(8) + extension.padEnd(3);
    for(let at = root; at < data && bytes[at]; at += 32)
    {
        if(Buffer.from(bytes.subarray(at, at + 11)).toString("ascii") !== wanted) continue;
        const size = dword(at + 28), result = new Uint8Array(size), visited = new Set();
        let cluster = word(at + 26), offset = 0;
        while(offset < size && cluster >= 2 && cluster < 0xFFF8 && !visited.has(cluster))
        {
            visited.add(cluster);
            const length = Math.min(cluster_bytes, size - offset), start = data + (cluster - 2) * cluster_bytes;
            result.set(bytes.subarray(start, start + length), offset); offset += length; cluster = word(fat + cluster * 2);
        }
        return offset === size ? result : undefined;
    }
    return undefined;
}
