#!/usr/bin/env node

// 48-bit ATA addressing on a disk larger than 2^32 sectors (3 TiB, never
// allocated: reads return their own byte offset). Ports are accessed
// directly; no guest code runs. [ATA-6] 6.2 (HOB), 8.16 (IDENTIFY words
// 60-61 and 100-103), 8.33 (READ NATIVE MAX ADDRESS EXT), 8.36 (READ SECTORS EXT).

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SECTORS = 6 * 2 ** 30; // 3 TiB: 0x1_8000_0000 sectors
const reads = [];
const disk = {
    byteLength: SECTORS * 512,
    load() { this.onload?.({}); },
    get(start, length, done)
    {
        assert.ok(Number.isSafeInteger(start) && start >= 0 && start + length <= this.byteLength, "read in range");
        reads.push(start);
        const data = new Uint8Array(length);
        new DataView(data.buffer).setBigUint64(0, BigInt(start), true);
        done(data);
    },
    get_and_cache(start, length, done) { this.get(start, length, done); },
    get_from_cache() { return undefined; },
    set(start, data, done) { done(); },
    get_buffer(done) { done(undefined); },
};

const emulator = new V86({
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    hda: disk,
    autostart: false,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const io = emulator.v86.cpu.io;

const DATA = 0x1F0, COUNT = 0x1F2, LBA_LOW = 0x1F3, LBA_MID = 0x1F4, LBA_HIGH = 0x1F5, DEVICE = 0x1F6, COMMAND = 0x1F7, CONTROL = 0x3F6;
const NIEN = 0x02, HOB = 0x80, DRQ = 0x08, ERR = 0x01;
io.port_write8(CONTROL, NIEN);

function read_words(count)
{
    assert.equal(io.port_read8(COMMAND) & (DRQ | ERR), DRQ, "data ready");
    return Array.from({ length: count }, () => io.port_read16(DATA));
}

// IDENTIFY: the 28-bit capacity saturates, the 48-bit one is complete
io.port_write8(DEVICE, 0xE0);
io.port_write8(COMMAND, 0xEC);
const identify = read_words(256);
assert.equal(identify[60] | identify[61] << 16, 0x0FFFFFFF, "words 60-61 capped for 28-bit commands");
assert.deepEqual(identify.slice(100, 104), [0x0000, 0x8000, 0x0001, 0x0000], "words 100-103: 0x1_8000_0000 sectors");
assert.ok(identify[83] & 1 << 10, "48-bit address feature set supported");

// READ NATIVE MAX ADDRESS EXT: bits 24-47 are read back with HOB set
io.port_write8(DEVICE, 0x40);
io.port_write8(COMMAND, 0x27);
assert.equal(io.port_read8(COMMAND) & ERR, 0);
const low = [LBA_LOW, LBA_MID, LBA_HIGH].map(port => io.port_read8(port));
io.port_write8(CONTROL, NIEN | HOB);
const high = [LBA_LOW, LBA_MID, LBA_HIGH].map(port => io.port_read8(port));
io.port_write8(CONTROL, NIEN);
const max = low[0] + low[1] * 2 ** 8 + low[2] * 2 ** 16 + high[0] * 2 ** 24 + high[1] * 2 ** 32 + high[2] * 2 ** 40;
assert.equal(max, SECTORS - 1, "native max address");

// READ SECTORS EXT above 2^32 sectors: the high order byte of each register
// is written first
function read_sector(lba)
{
    const bytes = [0, 1, 2, 3, 4, 5].map(i => Math.floor(lba / 2 ** (8 * i)) & 0xFF);
    io.port_write8(COUNT, 0); io.port_write8(COUNT, 1);
    io.port_write8(LBA_LOW, bytes[3]); io.port_write8(LBA_LOW, bytes[0]);
    io.port_write8(LBA_MID, bytes[4]); io.port_write8(LBA_MID, bytes[1]);
    io.port_write8(LBA_HIGH, bytes[5]); io.port_write8(LBA_HIGH, bytes[2]);
    io.port_write8(DEVICE, 0x40);
    io.port_write8(COMMAND, 0x24);
    const words = read_words(256);
    return words[0] + words[1] * 2 ** 16 + words[2] * 2 ** 32 + words[3] * 2 ** 48;
}
for(const lba of [0x1_2345_6789, 0xFFFF_FFFF, 0x1_0000_0000, SECTORS - 1])
{
    reads.length = 0;
    assert.equal(read_sector(lba), lba * 512, `LBA ${lba.toString(16)}: the data came from its byte offset`);
    assert.deepEqual(reads, [lba * 512]);
}

emulator.destroy();
console.log("PASS ide_large_disk: IDENTIFY capacity words, HOB reads of READ NATIVE MAX ADDRESS EXT, READ SECTORS EXT beyond 2^32 sectors");
