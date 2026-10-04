#!/usr/bin/env node

// The ICH9 SMBus controller of the Q35 machine (smbus: true), driven through
// its I/O registers as SeaBIOS sets it up (BAR4 at the PM base + 0x100,
// HOSTC.HST_EN) and as Linux's i2c-i801 drives it (docs/q35.md):
// decode, quick/byte/byte data/word data commands to the EEPROMs at
// 0x50-0x57, NACK for absent devices, block commands through the 32-byte
// buffer and byte by byte, I2C block reads, interrupts and snapshots.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    machine_type: "q35",
    smbus: true,
    memory_size: 32 * 1024 * 1024,
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const SMB = 0x1F << 3 | 3;

let failed = 0, passed = 0;
function test(name, f)
{
    try
    {
        f();
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

const BASE = 0x700;
const inb = offset => cpu.io.port_read8(BASE + offset);
const outb = (offset, value) => cpu.io.port_write8(BASE + offset, value);
const STS = 0, CNT = 2, CMD = 3, SLVA = 4, D0 = 5, D1 = 6, BLK = 7, AUX_CTL = 0xD;
const INTR = 2, DEV_ERR = 4, FAILED = 0x10, INUSE = 0x40, BYTE_DONE = 0x80, BUSY = 1;
const START = 0x40, LAST_BYTE = 0x20, INTREN = 1, KILL = 2;
const QUICK = 0 << 2, BYTE = 1 << 2, BYTE_DATA = 2 << 2, WORD_DATA = 3 << 2, BLOCK = 5 << 2, I2C_READ = 6 << 2;
const E32B = 2;

/** A command as i801 runs it: clear the status, set up, start; the status after */
function run(protocol, address, read, setup = {})
{
    outb(STS, 0xFF);
    outb(SLVA, address << 1 | (read ? 1 : 0));
    if(setup.command !== undefined) outb(CMD, setup.command);
    if(setup.d0 !== undefined) outb(D0, setup.d0);
    if(setup.d1 !== undefined) outb(D1, setup.d1);
    outb(CNT, protocol | START | (setup.intren ? INTREN : 0));
    return inb(STS) & ~INUSE;
}

test("PCI function 00:1f.3: ICH9 SMBus, BAR4 I/O, HOSTC; decoded only with HST_EN and I/O space", () => {
    assert.equal(pci.config_read(SMB, 0, 4) >>> 0, 0x29308086);
    assert.equal(pci.config_read(SMB, 0x08, 4) >>> 8, 0x0C0500, "SMBus");
    assert.equal(pci.config_read(0x1F << 3, 0x0E, 1) & 0x80, 0x80, "device 31 is multi-function");
    pci.config_write(SMB, 0x20, 4, 0xFFFFFFFF);
    assert.equal(pci.config_read(SMB, 0x20, 4) >>> 0, 0xFFFFFFE1, "32 bytes of I/O");
    // SeaBIOS (ich9_smbus_setup): PM base + 0x100, HST_EN
    pci.config_write(SMB, 0x20, 4, BASE | 1);
    assert.equal(inb(STS), 0xFF, "not decoded yet");
    pci.config_write(SMB, 0x40, 1, 1);
    assert.equal(inb(STS), 0xFF, "HST_EN, but I/O space disabled");
    pci.config_write(SMB, 0x04, 2, 1);
    assert.equal(inb(STS), 0, "decoded");
    assert.equal(inb(STS), INUSE, "INUSE_STS: set by the read that found it clear");
    outb(STS, INUSE);
    assert.equal(inb(STS) & INUSE, 0, "cleared by writing one");
    pci.config_write(SMB, 0x40, 1, 0xFF);
    assert.equal(pci.config_read(SMB, 0x40, 1), 0x1F, "HOSTC: five bits");
    assert.equal(inb(STS), 0xFF, "I2C_EN: the SMBus host interface is off");
    pci.config_write(SMB, 0x40, 1, 1);
});

test("byte data and word data to the EEPROM at 0x50; a quick command; no device at 0x30: DEV_ERR", () => {
    assert.equal(run(BYTE_DATA, 0x50, false, { command: 0x10, d0: 0xAB }), INTR, "write byte data");
    assert.equal(run(BYTE_DATA, 0x50, true, { command: 0x10 }), INTR);
    assert.equal(inb(D0), 0xAB, "read back");
    assert.equal(run(WORD_DATA, 0x50, false, { command: 0x20, d0: 0x34, d1: 0x12 }), INTR, "write word");
    assert.equal(run(WORD_DATA, 0x50, true, { command: 0x20 }), INTR);
    assert.deepEqual([inb(D0), inb(D1)], [0x34, 0x12]);
    assert.equal(run(BYTE, 0x50, false, { command: 0x20 }), INTR, "send byte: the offset");
    assert.equal(run(BYTE, 0x50, true), INTR);
    assert.equal(inb(D0), 0x34, "receive byte at it");
    assert.equal(run(BYTE, 0x50, true), INTR);
    assert.equal(inb(D0), 0x12, "and on");
    assert.equal(run(QUICK, 0x57, false), INTR, "the eighth EEPROM answers");
    assert.equal(run(QUICK, 0x30, false), DEV_ERR, "nothing at 0x30: no acknowledge");
    assert.equal(run(QUICK, 0x58, false), DEV_ERR);
    assert.equal(run(BYTE_DATA, 0x51, true, { command: 0x10 }), INTR, "another EEPROM, zeroed");
    assert.equal(inb(D0), 0);
});

test("block write and read through the 32-byte buffer (E32B)", () => {
    outb(AUX_CTL, E32B);
    inb(CNT); // (resets the buffer index)
    for(let i = 0; i < 5; i++) outb(BLK, 0x60 + i);
    assert.equal(run(BLOCK, 0x52, false, { command: 0x40, d0: 5 }), INTR, "block write");
    assert.equal(run(BLOCK, 0x52, true, { command: 0x40 }), INTR, "block read");
    assert.equal(inb(D0), 5, "the byte count");
    inb(CNT);
    assert.deepEqual(Array.from({ length: 5 }, () => inb(BLK)), [0x60, 0x61, 0x62, 0x63, 0x64]);
    outb(AUX_CTL, 0);
});

test("byte-by-byte block transfers (as i801 without E32B): BYTE_DONE, LAST_BYTE", () => {
    // write: count in D0, the first byte in HOST_BLOCK_DB before START
    const bytes = [0x11, 0x22, 0x33];
    outb(STS, 0xFF);
    outb(SLVA, 0x53 << 1);
    outb(CMD, 0x80);
    outb(D0, bytes.length);
    outb(BLK, bytes[0]);
    outb(CNT, BLOCK | START);
    for(let i = 1; i <= bytes.length; i++)
    {
        assert.equal(inb(STS) & BYTE_DONE, BYTE_DONE, "byte " + i + " taken");
        assert.equal(inb(STS) & BUSY, BUSY);
        if(i < bytes.length) outb(BLK, bytes[i]);
        outb(STS, BYTE_DONE);
    }
    assert.equal(inb(STS) & (INTR | BUSY), INTR, "done");

    // read: the count comes with the first byte; LAST_BYTE before the last
    outb(STS, 0xFF);
    outb(SLVA, 0x53 << 1 | 1);
    outb(CMD, 0x80);
    const got = [];
    let length = 1;
    for(let i = 1; i <= length; i++)
    {
        const cnt = BLOCK | (i === length && i > 1 ? LAST_BYTE : 0);
        outb(CNT, i === 1 ? cnt | START : cnt);
        assert.equal(inb(STS) & BYTE_DONE, BYTE_DONE, "byte " + i);
        if(i === 1) length = inb(D0);
        if(i === length) outb(CNT, BLOCK | LAST_BYTE);
        got.push(inb(BLK));
        outb(STS, BYTE_DONE);
    }
    assert.deepEqual(got, bytes, "read back");
    assert.equal(inb(STS) & (INTR | BUSY | BYTE_DONE), INTR, "INTR after the last byte");
});

test("I2C block read: the offset in HST_D1, bytes until LAST_BYTE", () => {
    outb(STS, 0xFF);
    outb(SLVA, 0x50 << 1 | 1);
    outb(D1, 0x20);
    const got = [];
    for(let i = 1; i <= 2; i++)
    {
        outb(CNT, I2C_READ | (i === 2 ? LAST_BYTE : 0) | (i === 1 ? START : 0));
        assert.equal(inb(STS) & BYTE_DONE, BYTE_DONE);
        got.push(inb(BLK));
        outb(STS, BYTE_DONE);
    }
    assert.deepEqual(got, [0x34, 0x12], "the word written above");
    assert.equal(inb(STS) & (INTR | BUSY), INTR);
});

test("KILL ends a byte-by-byte transfer: FAILED; an uncleared error stops the next command", () => {
    outb(STS, 0xFF);
    outb(SLVA, 0x50 << 1 | 1);
    outb(D1, 0);
    outb(CNT, I2C_READ | START);
    assert.equal(inb(STS) & BUSY, BUSY);
    outb(CNT, KILL);
    assert.equal(inb(STS) & (FAILED | BUSY | BYTE_DONE), FAILED);
    outb(CNT, 0);
    outb(SLVA, 0x50 << 1 | 1);
    outb(CNT, BYTE | START);
    assert.equal(inb(STS) & (DEV_ERR | INTR), DEV_ERR, "FAILED still set: not run");
    assert.equal(run(BYTE, 0x50, true), INTR, "cleared: runs");
});

test("INTREN: INTA (00:1f.3 behind D31IR: PIRQA, GSI 16) until the status is cleared", () => {
    run(QUICK, 0x50, false, { intren: true });
    assert.ok(cpu.shared_irq_sources[16].has(SMB), "asserted");
    outb(STS, INTR);
    assert.ok(!cpu.shared_irq_sources[16].has(SMB), "cleared");
    outb(CNT, 0);
});

run(WORD_DATA, 0x55, false, { command: 0x00, d0: 0x5A, d1: 0xA5 });
const state = await emulator.save_state();
run(WORD_DATA, 0x55, false, { command: 0x00, d0: 0, d1: 0 });
pci.config_write(SMB, 0x40, 1, 0);
await emulator.restore_state(state);
test("snapshot: decode and the EEPROMs' contents", () => {
    assert.equal(run(WORD_DATA, 0x55, true, { command: 0x00 }), INTR);
    assert.deepEqual([inb(D0), inb(D1)], [0x5A, 0xA5]);
});

emulator.destroy();
console.log((failed ? "FAIL" : "PASS") + ": " + passed + " SMBus tests passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
