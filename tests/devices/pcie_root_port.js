#!/usr/bin/env node

// The PCI Express root ports of the Q35 machine (pcie_root_ports) and the
// devices behind them, driven through configuration space and the devices'
// registers; no guest code runs (docs/q35-ahci-sata-plan.md, P6): the type 1
// header and the capabilities, configuration routing by the bus numbers the
// guest programs, memory and I/O forwarding through the windows, bus
// mastering (DMA, MSI) through the bridge, INTx through the swizzle and
// snapshots.
// Behind root port 0: a second AHCI controller (ahci_test_drives) with a
// disk; behind root port 2: a virtio device (virtio_devices, pcie_root_port).

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { SyncBuffer } = await import("../../src/buffer.js");

const disk = new Uint8Array(1 << 20).map((_, i) => i * 13 + (i >> 9) & 0xFF);

const rng = {
    "name": "rng",
    "device_id": 0x1044,
    "subsystem_device_id": 4,
    "queues": [{ "size": 8 }],
    "pcie_root_port": 2,
    "notify": () => {},
};

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    machine_type: "q35",
    pcie_root_ports: 3,
    memory_size: 64 * 1024 * 1024,
    ahci_test_drives: [{ buffer: new SyncBuffer(disk.buffer) }],
    ahci_test_pci_id: 1 << 8,
    virtio_devices: [rng],
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const cpu = emulator.v86.cpu;
const pci = cpu.devices.pci;
const mem = cpu.mem8;

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

const RP = n => 0x1C << 3 | n;         // root port n on bus 0
const read = (bdf, offset, size = 4) => pci.config_read(bdf, offset, size) >>> 0;
const write = (bdf, offset, value, size = 4) => pci.config_write(bdf, offset, size, value);
const ECAM = 0xB0000000;
const ecam_read = (bdf, offset) => cpu.mmap_read32(ECAM + bdf * 4096 + offset) >>> 0;
// the MCH's PCIEXBAR, as SeaBIOS programs it: 256 MiB at ECAM, enabled
write(0, 0x64, 0);
write(0, 0x60, ECAM | 1);
/** secondary and subordinate bus numbers of a root port */
const buses = (n, secondary, subordinate = secondary) => write(RP(n), 0x18, secondary << 8 | subordinate << 16);
const capability = (bdf, id) => {
    for(let at = read(bdf, 0x34, 1); at; at = read(bdf, at + 1, 1))
    {
        if(read(bdf, at, 1) === id) return at;
    }
    return 0;
};

test("root ports: identity, type 1 header, capability chain", () => {
    for(let n = 0; n < 3; n++)
    {
        assert.equal(read(RP(n), 0x00), 0x8086 | 0x2940 + 2 * n << 16, "ICH9 PCI Express Port " + (n + 1));
        assert.equal(read(RP(n), 0x08) >>> 8, 0x060400, "PCI-to-PCI bridge");
        assert.equal(read(RP(n), 0x0E, 1), n === 0 ? 0x81 : 0x01, "type 1 header; function 0 multi-function");
        assert.equal(read(RP(n), 0x3D, 1), n + 1, "INTA, INTB, INTC");
    }
    assert.equal(read(RP(3), 0x00), 0xFFFFFFFF, "three ports only");
    const chain = [];
    for(let at = read(RP(0), 0x34, 1); at; at = read(RP(0), at + 1, 1)) chain.push([at, read(RP(0), at, 1)]);
    assert.deepEqual(chain, [[0x40, 0x10], [0x80, 0x05], [0x90, 0x0D], [0xA0, 0x01]], "PCI Express, MSI, SSVID, PM");
    assert.equal(read(RP(0), 0x42, 2), 0x0141, "PCI Express 1, root port, slot implemented");
    assert.equal(read(RP(1), 0x4C) >>> 24, 2, "link capabilities: port number");
    assert.equal(read(RP(0), 0x4C) & 0x3FF, 0x11, "2.5 GT/s, x1");
    assert.equal(read(RP(0), 0x5A, 2) & 0x40, 0x40, "port 0: presence detected (the AHCI controller)");
    assert.equal(read(RP(0), 0x52, 2) & 0x2000, 0x2000, "port 0: link active");
    assert.equal(read(RP(1), 0x5A, 2) & 0x40, 0, "port 1: empty");
    assert.equal(read(RP(1), 0x52, 2) & 0x2000, 0);
    assert.equal(read(RP(2), 0x5A, 2) & 0x40, 0x40, "port 2: the virtio device");
    assert.equal(ecam_read(RP(0), 0x100), 0, "extended space: no extended capabilities");
    assert.equal(ecam_read(RP(0), 0x00), read(RP(0), 0x00), "the same through ECAM");
});

test("type 1 header writes: bus numbers, windows (read-only bits), secondary status, bridge control", () => {
    write(RP(1), 0x18, 0xFFFFFFFF);
    assert.equal(read(RP(1), 0x18), 0xFFFFFFFF, "primary, secondary, subordinate, latency timer");
    write(RP(1), 0x18, 0);
    write(RP(1), 0x1C, 0xFFFF);
    assert.equal(read(RP(1), 0x1C, 2), 0xF0F0, "I/O base/limit: 16-bit decode");
    write(RP(1), 0x20, 0xFFFFFFFF);
    assert.equal(read(RP(1), 0x20), 0xFFF0FFF0);
    write(RP(1), 0x24, 0xFFFFFFFF);
    assert.equal(read(RP(1), 0x24), 0xFFF1FFF1, "prefetchable: 64-bit");
    write(RP(1), 0x28, 0x12345678);
    assert.equal(read(RP(1), 0x28), 0x12345678, "prefetchable base, upper 32 bits");
    write(RP(1), 0x30, 0xFFFFFFFF);
    assert.equal(read(RP(1), 0x30), 0, "I/O upper 16 bits: read-only (16-bit)");
    write(RP(1), 0x38, 0xFFFFFFFF);
    assert.equal(read(RP(1), 0x38), 0, "no expansion ROM");
    write(RP(1), 0x10, 0xFFFFFFFF);
    assert.equal(read(RP(1), 0x10), 0, "no BARs");
    write(RP(1), 0x3C, 0xFFFFFFFF);
    assert.equal(read(RP(1), 0x3C), 0x005F02FF, "interrupt line, pin (read-only), bridge control");
    write(RP(1), 0x3C, 0);
    for(const offset of [0x1C, 0x20, 0x24, 0x28, 0x2C]) write(RP(1), offset, 0);
    // capabilities: read-only parts stay
    write(RP(1), 0x40, 0xFFFFFFFF);
    assert.equal(read(RP(1), 0x40), 0x01418010);
    write(RP(1), 0x4C, 0);
    assert.equal(read(RP(1), 0x4C) >>> 24, 2);
    write(RP(1), 0xA4, 0xFFFF);
    assert.equal(read(RP(1), 0xA4, 2), 0x0103, "PMCSR: power state, PME enable");
    write(RP(1), 0xA4, 0);
    write(RP(1), 0x200, 0xFFFFFFFF);
    assert.equal(ecam_read(RP(1), 0x200), 0, "the extended space stays zero");
});

test("configuration routing by the bus numbers the guest programs", () => {
    assert.equal(read(1 << 8, 0), 0xFFFFFFFF, "nothing on bus 1 before the bridge has the number");
    buses(0, 1);
    assert.equal(read(1 << 8, 0), 0x29228086, "bus 1, device 0: the AHCI controller behind root port 0");
    assert.equal(read(1 << 8 | 1 << 3, 0), 0xFFFFFFFF, "device 1: nothing behind a PCI Express downstream port");
    assert.equal(ecam_read(1 << 8, 0), 0x29228086, "the same through ECAM");
    buses(0, 5);
    assert.equal(read(1 << 8, 0), 0xFFFFFFFF, "renumbered: bus 1 is gone");
    assert.equal(read(5 << 8, 0), 0x29228086, "bus 5");
    buses(0, 1, 4);
    assert.equal(read(2 << 8, 0), 0xFFFFFFFF, "buses 2-4: behind the port, but no bridge there");
    buses(2, 2);
    assert.equal(read(2 << 8, 0), 0xFFFFFFFF, "overlapping ranges: bus 2 goes to port 0 (the first), where nothing has it");
    buses(0, 1);
    assert.equal(read(2 << 8, 0), 0x10441AF4, "bus 2, device 0: the virtio device behind root port 2");
    write(1 << 8, 0x3C, 0x0B, 1);
    assert.equal(read(1 << 8, 0x3C, 1), 0x0B, "writes reach the function behind the bridge");
});

/** AHCI behind root port 0 at bus 1: ABAR, command */
const ABAR = 0xC0100000;
function program_ahci(command = 0x0006)
{
    write(1 << 8, 0x24, ABAR);
    write(1 << 8, 0x04, command, 2);
}
const abar_read = offset => cpu.mmap_read32(ABAR + offset) >>> 0;

test("memory forwarding: ABAR behind the root port only through its windows while it decodes memory", () => {
    buses(0, 1);
    program_ahci();
    assert.equal(abar_read(0x0C), 0xFFFFFFFF, "the root port forwards nothing yet");
    write(RP(0), 0x20, 0xC010 | 0xC010 << 16);      // memory window C0100000-C01FFFFF
    assert.equal(abar_read(0x0C), 0xFFFFFFFF, "the window, but memory decode is off in the root port");
    write(RP(0), 0x04, 0x0002, 2);
    assert.equal(abar_read(0x0C), 0x3F, "decoded: ports implemented");
    write(RP(0), 0x20, 0xC020 | 0xC020 << 16);
    assert.equal(abar_read(0x0C), 0xFFFFFFFF, "outside the memory window");
    write(RP(0), 0x24, 0xC001 | 0xC011 << 16);      // prefetchable C0000000-C01FFFFF
    assert.equal(abar_read(0x0C), 0x3F, "inside the prefetchable window");
    write(RP(0), 0x24, 0xFFF1 | 0x0001 << 16);      // prefetchable window closed
    assert.equal(abar_read(0x0C), 0xFFFFFFFF);
    write(RP(0), 0x20, 0xC010 | 0xC010 << 16);
    assert.equal(abar_read(0x0C), 0x3F);
    write(1 << 8, 0x04, 0x0004, 2);
    assert.equal(abar_read(0x0C), 0xFFFFFFFF, "the function's own memory decode still counts");
    program_ahci();
});

test("bus mastering through the root port: commands wait for the bridge's too; MSI as well", () => {
    const P = 0x100, CLB = 0x200000, FB = 0x200400, TABLE = 0x201000, DATA = 0x300000;
    const w = (offset, value) => cpu.mmap_write32(ABAR + offset, value | 0);
    const put32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
    w(P + 0x18, 0);
    w(P + 0x00, CLB);
    w(P + 0x08, FB);
    w(P + 0x18, 0x10);
    w(P + 0x18, 0x11);
    mem.fill(0, TABLE, TABLE + 0x100);
    mem.set([0x27, 0x80, 0x25, 0, 3, 0, 0, 0x40, 0, 0, 0, 0, 1, 0], TABLE);   // READ DMA EXT, LBA 3
    put32(TABLE + 0x80, DATA);
    put32(TABLE + 0x8C, 511);
    put32(CLB, 5 | 1 << 16);
    put32(CLB + 8, TABLE);
    w(P + 0x38, 1);
    assert.equal(abar_read(P + 0x38), 1, "the root port's bus mastering is off: the command waits");
    write(RP(0), 0x04, 0x0006, 2);
    assert.equal(abar_read(P + 0x38), 0, "on: it runs");
    assert.deepEqual(mem.subarray(DATA, DATA + 512), disk.subarray(3 * 512, 4 * 512));
    assert.ok(pci.is_bus_master(1 << 8));
    write(RP(0), 0x04, 0x0002, 2);
    assert.ok(!pci.is_bus_master(1 << 8), "no MSI (a memory write) without the bridge's bus mastering");
    write(RP(0), 0x04, 0x0006, 2);
});

test("MSI behind a root port: the message reaches the local APIC only with the bridge's bus mastering", () => {
    const LAPIC = 0xFEE00000;
    const irr = vector => !!((cpu.read32s(LAPIC + 0x200 + (vector >> 5) * 16) >>> 0) & 1 << (vector & 31));
    const eoi = () => cpu.write32(LAPIC + 0xB0, 0);
    cpu.write32(LAPIC + 0xF0, 0x1FF);
    const AHCI = 1 << 8;
    write(AHCI, 0x84, 0xFEE00000);
    write(AHCI, 0x88, 0);
    write(AHCI, 0x8C, 0x0046, 2);
    write(AHCI, 0x82, 0x0001, 2);           // MSI enable
    write(RP(0), 0x04, 0x0002, 2);          // the root port: memory decode, no bus mastering
    cpu.mmap_write32(ABAR + 0x100 + 0x10, -1);
    cpu.mmap_write32(ABAR + 0x04, 2);
    cpu.mmap_write32(ABAR + 0x100 + 0x14, 1);
    const comreset = () => {
        cpu.mmap_write32(ABAR + 0x100 + 0x10, -1);
        cpu.mmap_write32(ABAR + 0x100 + 0x2C, 1);
        cpu.mmap_write32(ABAR + 0x100 + 0x2C, 0);
    };
    comreset();
    assert.ok(!irr(0x46), "no message while the root port does not master the bus");
    write(RP(0), 0x04, 0x0006, 2);
    comreset();
    assert.ok(irr(0x46), "delivered through the root port");
    eoi();
    cpu.mmap_write32(ABAR + 0x100 + 0x10, -1);
    write(AHCI, 0x82, 0, 2);
    cpu.mmap_write32(ABAR + 0x04, 0);
    cpu.mmap_write32(ABAR + 0x100 + 0x14, 0);
});

test("INTx behind a root port: the swizzle, then the root port's pin at device 28 (D28IR: PIRQA-D)", () => {
    const AHCI = 1 << 8;
    assert.deepEqual(pci.root_pin(AHCI), { pci_id: RP(0), pin: 0 }, "INTA of device 0 -> INTA of the bridge");
    const sources = gsi => cpu.shared_irq_sources[gsi];
    cpu.mmap_write32(ABAR + 0x04, 2);           // GHC.IE
    cpu.mmap_write32(ABAR + 0x100 + 0x14, 1);   // PxIE: DHRS
    cpu.mmap_write32(ABAR + 0x100 + 0x38, 0);
    // a D2H FIS interrupt: COMRESET
    cpu.mmap_write32(ABAR + 0x100 + 0x2C, 1);
    cpu.mmap_write32(ABAR + 0x100 + 0x2C, 0);
    assert.ok(sources(16).has(AHCI), "PIRQA: GSI 16");
    cpu.mmap_write32(ABAR + 0x100 + 0x10, -1);
    assert.ok(!sources(16).has(AHCI));
    // as if it had INTB: the bridge's INTB, PIRQB, GSI 17
    pci.space_bytes(AHCI)[0x3D] = 2;
    cpu.mmap_write32(ABAR + 0x100 + 0x2C, 1);
    cpu.mmap_write32(ABAR + 0x100 + 0x2C, 0);
    assert.ok(sources(17).has(AHCI), "INTB: GSI 17");
    cpu.mmap_write32(ABAR + 0x100 + 0x10, -1);
    pci.space_bytes(AHCI)[0x3D] = 1;
    cpu.mmap_write32(ABAR + 0x04, 0);
    cpu.mmap_write32(ABAR + 0x100 + 0x14, 0);
});

/** The virtio device behind root port 2 at bus 2: its I/O BARs */
function io_bars()
{
    const bars = [];
    for(let bar = 0; bar < 6; bar++)
    {
        const offset = 0x10 + 4 * bar;
        const old = read(2 << 8, offset);
        write(2 << 8, offset, 0xFFFFFFFF);
        const probe = read(2 << 8, offset);
        write(2 << 8, offset, old);
        if(probe && probe & 1) bars.push({ offset, size: (~(probe & ~3) >>> 0 & 0xFFFF) + 1 });
    }
    return bars;
}

test("I/O forwarding: the I/O BARs of a function behind a root port appear only through the I/O window", () => {
    buses(0, 1);
    buses(2, 2);
    const bars = io_bars();
    assert.ok(bars.length > 0, "virtio has I/O BARs");
    const virtio = cpu.devices.virtio_devices[0].virtio;
    let port = 0xC000;
    for(const bar of bars)
    {
        write(2 << 8, bar.offset, port | 1);
        bar.port = port;
        port += Math.max(bar.size, 0x100);
    }
    const mapped = () => bars.map(bar => cpu.io.ports[bar.port].device === virtio);
    assert.deepEqual(mapped(), bars.map(() => false), "the root port forwards no I/O yet");
    write(RP(2), 0x1C, 0xC0 | 0xC0 << 8, 2);       // I/O window C000-CFFF
    assert.deepEqual(mapped(), bars.map(() => false), "the window, but I/O decode is off in the root port");
    write(RP(2), 0x04, 0x0001, 2);
    assert.deepEqual(mapped(), bars.map(() => true), "forwarded");
    write(RP(2), 0x1C, 0xD0 | 0xD0 << 8, 2);
    assert.deepEqual(mapped(), bars.map(() => false), "outside the I/O window");
    write(RP(2), 0x1C, 0xC0 | 0xC0 << 8, 2);
    assert.deepEqual(mapped(), bars.map(() => true));
    write(2 << 8, bars[0].offset, 0xD000 | 1);
    assert.equal(cpu.io.ports[bars[0].port].device, undefined, "moved away: the old ports are free");
    assert.equal(cpu.io.ports[0xD000].device, undefined, "and the new ones outside the window are not decoded");
    write(2 << 8, bars[0].offset, bars[0].port | 1);
    assert.deepEqual(mapped(), bars.map(() => true));
});

const state = await emulator.save_state();
write(RP(0), 0x18, 0);
write(RP(2), 0x04, 0, 2);
await emulator.restore_state(state);
test("snapshot: bus numbers, windows, decode and the I/O BARs behind the root ports survive", () => {
    assert.equal(read(1 << 8, 0), 0x29228086);
    assert.equal(abar_read(0x0C), 0x3F);
    const virtio = cpu.devices.virtio_devices[0].virtio;
    assert.equal(cpu.io.ports[0xC000].device, virtio);
});

emulator.destroy();
console.log((failed ? "FAIL" : "PASS") + ": " + passed + " PCI Express root port tests passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
