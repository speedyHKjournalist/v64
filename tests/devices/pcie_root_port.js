#!/usr/bin/env node

// The PCI Express root ports of the Q35 machine (pcie_root_ports) and the
// devices behind them, driven through configuration space and the devices'
// registers; no guest code runs (docs/q35.md): the type 1
// header and the capabilities, configuration routing by the bus numbers the
// guest programs, memory and I/O forwarding through the windows, bus
// mastering (DMA, MSI) through the bridge, INTx through the swizzle and
// snapshots; PCI Express native hot plug: the slot registers, the hot plug
// interrupt (INTx, MSI), surprise removal, insertion (into a powered slot
// and into one the guest switched off), removal through the attention
// button, the guest switching the slot off and on, snapshots; built-in
// devices behind root ports. With a guest: tests/devices/pcie_hotplug.mjs.
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

// PCI Express native hot plug; root port 2's card is the virtio device
const LNKSTA = 0x52, SLTCAP = 0x54, SLTCTL = 0x58, SLTSTA = 0x5A;
const ABP = 1, PDC = 8, CC = 0x10, PDS = 0x40, DLLSC = 0x100;
const ABPE = 1, PDCE = 8, CCIE = 0x10, HPIE = 0x20, INDICATORS_OFF = 0x3C0, PCC = 0x400, DLLSCE = 0x1000;
const POWER_INDICATOR_ON = 0x1C0;               // (the attention indicator off)
const slot_status = n => read(RP(n), SLTSTA, 2);
const link_up = n => (read(RP(n), LNKSTA, 2) & 0x2000) !== 0;
const clear_events = n => write(RP(n), SLTSTA, 0x11F, 2);
// the root port's own pin: INTA-INTC, through D28IR to PIRQA-C, GSI 16-18
const intx = n => !!cpu.shared_irq_sources[16 + n] && cpu.shared_irq_sources[16 + n].has(RP(n));

test("hot plug slots: attention button, power controller, indicators, surprise, hot plug capable, slot numbers", () => {
    for(let n = 0; n < 3; n++)
    {
        assert.equal(read(RP(n), SLTCAP), (0x7B | n + 1 << 19) >>> 0, "port " + n);
    }
    assert.equal(read(RP(0), SLTCTL, 2), POWER_INDICATOR_ON, "a slot with a card: on, its power indicator on (as QEMU)");
    assert.equal(read(RP(2), SLTCTL, 2), POWER_INDICATOR_ON);
    assert.equal(read(RP(1), SLTCTL, 2), INDICATORS_OFF | PCC, "the empty slot: off, indicators off");
    write(RP(1), SLTCTL, 0xFFFF, 2);
    assert.equal(read(RP(1), SLTCTL, 2), 0x17FF, "no electromechanical interlock");
    assert.equal(slot_status(1), CC, "a write of slot control is a command, completed at once");
    write(RP(1), SLTSTA, 0x0100, 2);
    assert.equal(slot_status(1), CC, "write one to clear: only those");
    clear_events(1);
    assert.equal(slot_status(1), 0);
    write(RP(1), SLTCTL, INDICATORS_OFF, 2);
    clear_events(1);
});

test("the hot plug interrupt: INTx while an enabled event is pending, an MSI when one starts", () => {
    write(RP(1), SLTCTL, INDICATORS_OFF | CCIE, 2);
    assert.ok(!intx(1), "not without HPIE");
    clear_events(1);
    write(RP(1), SLTCTL, INDICATORS_OFF | HPIE | CCIE, 2);
    assert.ok(intx(1), "command completed, enabled: INTB, PIRQB");
    clear_events(1);
    assert.ok(!intx(1), "cleared");
    const msis = [];
    const apic_msi = cpu.apic_msi;
    cpu.apic_msi = (address, data) => { msis.push([address >>> 0, data]); return true; };
    write(RP(1), 0x84, 0xFEE00000);
    write(RP(1), 0x88, 0);
    write(RP(1), 0x8C, 0x0055, 2);
    write(RP(1), 0x82, 0x0001, 2);
    write(RP(1), 0x04, 0x0004, 2);              // (a message is a memory write: bus mastering)
    write(RP(1), SLTCTL, INDICATORS_OFF | HPIE | CCIE, 2);
    assert.deepEqual(msis, [[0xFEE00000, 0x55]], "a message");
    assert.ok(!intx(1), "no INTx with MSI");
    write(RP(1), SLTCTL, INDICATORS_OFF | HPIE | CCIE, 2);
    assert.equal(msis.length, 1, "the event still pending: no new message");
    clear_events(1);
    write(RP(1), SLTCTL, INDICATORS_OFF | HPIE | CCIE, 2);
    assert.equal(msis.length, 2, "cleared, then a new event: a new message");
    cpu.apic_msi = apic_msi;
    write(RP(1), 0x82, 0, 2);
    write(RP(1), 0x04, 0, 2);
    write(RP(1), SLTCTL, INDICATORS_OFF, 2);
    clear_events(1);
});

const virtio_port = () => cpu.io.ports[0xC000].device === cpu.devices.virtio_devices[0].virtio;
write(RP(2), SLTCTL, INDICATORS_OFF | HPIE | PDCE | ABPE | DLLSCE, 2);
clear_events(2);
const power_on_command = read(2 << 8, 0x04, 2);
test("a card in the slot: present, link up", () => {
    assert.equal(slot_status(2), PDS);
    assert.ok(link_up(2));
    assert.ok(virtio_port(), "its I/O BAR where the guest put it");
    write(2 << 8, 0x04, 0x0001, 2);
    assert.equal(read(2 << 8, 0x04, 2), 0x0001);
});
await emulator.detach_pcie_device(2, { surprise: true });
test("surprise removal: the card leaves the bus at once", () => {
    assert.equal(slot_status(2), PDC | DLLSC, "presence detect and link changed, nothing present");
    assert.ok(!link_up(2));
    assert.ok(intx(2), "enabled events: the hot plug interrupt (INTC, PIRQC)");
    assert.equal(read(2 << 8, 0), 0xFFFFFFFF, "nothing answers configuration cycles");
    assert.ok(!virtio_port(), "its I/O BARs are gone");
});
clear_events(2);
await emulator.attach_pcie_device(2);
test("plugged in: presence and link up, the device starts afresh", () => {
    assert.equal(slot_status(2), PDS | PDC | DLLSC);
    assert.ok(link_up(2));
    assert.equal(read(2 << 8, 0), 0x10441AF4, "the virtio device again");
    assert.equal(read(2 << 8, 0x04, 2), power_on_command, "command as at power-on");
    assert.ok(!virtio_port(), "its BARs as at power-on (outside the root port's window)");
});
clear_events(2);
let removed = false;
const removal = emulator.detach_pcie_device(2).then(() => { removed = true; });
await new Promise(resolve => setTimeout(resolve, 0));
const POWER_INDICATOR_BLINK = 0x2C0;            // (the attention indicator off)
test("removal through the attention button: the guest is asked, the card stays meanwhile", () => {
    assert.equal(slot_status(2), PDS | ABP, "attention button pressed");
    assert.ok(!removed);
    assert.equal(read(2 << 8, 0), 0x10441AF4, "still on the bus");
    clear_events(2);
    write(RP(2), SLTCTL, POWER_INDICATOR_BLINK | HPIE | PDCE | ABPE | DLLSCE | PCC, 2);
    assert.equal(read(2 << 8, 0), 0xFFFFFFFF, "the guest switched the slot off: off the bus");
    assert.equal(slot_status(2) & (PDS | PDC | DLLSC), PDS | DLLSC, "the link down; the power indicator blinks: the card stays");
    assert.ok(!link_up(2));
    write(RP(2), SLTCTL, INDICATORS_OFF | HPIE | PDCE | ABPE | DLLSCE | PCC, 2);
    assert.equal(slot_status(2) & (PDS | PDC), PDC, "the power indicator off too: out of the slot");
});
await removal;
test("removal through the attention button: done once the guest switched the slot and its power indicator off", () => {
    assert.ok(removed);
});
clear_events(2);
await emulator.attach_pcie_device(2);
test("plugged into a slot the guest switched off: presence and the attention button, off the bus until switched on", () => {
    assert.equal(slot_status(2), PDS | PDC | ABP, "presence detect changed, attention button pressed (Linux enables only ABPE then)");
    assert.ok(!link_up(2));
    assert.equal(read(2 << 8, 0), 0xFFFFFFFF, "nothing answers yet");
    clear_events(2);
    write(RP(2), SLTCTL, INDICATORS_OFF | HPIE | PDCE | ABPE | DLLSCE, 2);
    assert.equal(slot_status(2), PDS | CC | DLLSC, "switched on: the link comes up");
    assert.ok(link_up(2));
    assert.equal(read(2 << 8, 0), 0x10441AF4, "the virtio device");
    assert.equal(read(2 << 8, 0x04, 2), power_on_command, "afresh");
});
write(RP(2), SLTCTL, INDICATORS_OFF | HPIE | PDCE | ABPE | DLLSCE, 2);
clear_events(2);
await emulator.attach_pcie_device(2);
clear_events(2);
test("the guest switches the slot off and on: the card stays in, off the bus meanwhile", () => {
    write(RP(2), SLTCTL, INDICATORS_OFF | PCC, 2);
    assert.equal(read(2 << 8, 0), 0xFFFFFFFF, "off");
    assert.equal(slot_status(2) & (PDS | PDC | DLLSC), PDS | DLLSC, "present, the link down");
    assert.ok(!link_up(2));
    write(RP(2), SLTCTL, INDICATORS_OFF, 2);
    assert.equal(read(2 << 8, 0), 0x10441AF4, "on again");
    assert.ok(link_up(2));
    clear_events(2);
});
await emulator.detach_pcie_device(2, { surprise: true });
const hot_plug_state = await emulator.save_state();
await emulator.attach_pcie_device(2);
await emulator.restore_state(hot_plug_state);
test("snapshot: the slot empty as saved, the card off the bus", () => {
    assert.equal(slot_status(2) & PDS, 0);
    assert.ok(!link_up(2));
    assert.equal(read(2 << 8, 0), 0xFFFFFFFF);
});
await emulator.attach_pcie_device(2);
test("snapshot: and plugged in again", () => {
    assert.equal(read(2 << 8, 0), 0x10441AF4);
});
const attach_error = await emulator.attach_pcie_device(1).then(() => null, e => e);
await emulator.detach_pcie_device(1);
test("attach_pcie_device needs a device for the port; detaching from an empty slot does nothing", () => {
    assert.match(String(attach_error), /no device for root port 1/);
    assert.equal(slot_status(1) & (PDS | PDC), 0);
});
write(RP(2), SLTCTL, INDICATORS_OFF | PCC, 2);
write(RP(1), SLTCTL, INDICATORS_OFF, 2);
await emulator.restart();
test("reset: a slot with a card on (the card afresh), an empty one off", () => {
    assert.equal(read(RP(2), SLTCTL, 2), POWER_INDICATOR_ON);
    assert.equal(slot_status(2), PDS, "no events");
    buses(2, 2);
    assert.equal(read(2 << 8, 0), 0x10441AF4, "the card the guest had switched off is back on the bus");
    assert.equal(read(RP(1), SLTCTL, 2), INDICATORS_OFF | PCC, "the empty slot the guest had switched on is off");
});
emulator.destroy();

// Built-in devices behind root ports: virtio-net, 9p, the console (starting
// unplugged) and the balloon; then the NE2000
const builtin = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    machine_type: "q35",
    pcie_root_ports: 4,
    memory_size: 64 * 1024 * 1024,
    net_device: { type: "virtio", pcie_root_port: 0 },
    filesystem: { pcie_root_port: 1 },
    virtio_console: { pcie_root_port: 2, pcie_plugged: false },
    virtio_balloon: { pcie_root_port: 3 },
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => builtin.add_listener("emulator-loaded", resolve));
const bpci = builtin.v86.cpu.devices.pci;
const bread = (bdf, offset, size = 4) => bpci.config_read(bdf, offset, size) >>> 0;
for(let n = 0; n < 4; n++) bpci.config_write(RP(n), 0x18, 4, n + 1 << 8 | n + 1 << 16);
test("built-in devices behind root ports: virtio-net, 9p, the console not plugged in, the balloon", () => {
    assert.equal(bread(1 << 8, 0), 0x10411AF4, "virtio-net behind port 0");
    assert.equal(bread(2 << 8, 0), 0x10491AF4, "9p behind port 1");
    assert.equal(bread(3 << 8, 0), 0xFFFFFFFF, "port 2: the console is not plugged in");
    assert.equal(bread(RP(2), SLTSTA, 2) & PDS, 0);
    assert.equal(bread(4 << 8, 0), 0x10451AF4, "the balloon behind port 3");
    for(const slot of [0x0A, 0x06, 0x0C, 0x0B]) assert.equal(bread(slot << 3, 0), 0xFFFFFFFF, "not in its usual slot on bus 0");
});
await builtin.attach_pcie_device(2);
test("built-in devices behind root ports: the console plugged in, on the bus once its slot is switched on", () => {
    assert.equal(bread(RP(2), SLTSTA, 2) & (PDS | PDC | ABP), PDS | PDC | ABP, "its empty slot was off");
    assert.equal(bread(3 << 8, 0), 0xFFFFFFFF);
    bpci.config_write(RP(2), SLTCTL, 2, INDICATORS_OFF);
    assert.equal(bread(3 << 8, 0), 0x10431AF4);
});
builtin.destroy();

const ne2k = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    machine_type: "q35",
    pcie_root_ports: 2,
    memory_size: 64 * 1024 * 1024,
    net_device: { type: "ne2k", pcie_root_port: 1 },
    autostart: false,
    log_level: 0,
});
await new Promise(resolve => ne2k.add_listener("emulator-loaded", resolve));
const npci = ne2k.v86.cpu.devices.pci;
npci.config_write(RP(1), 0x18, 4, 2 << 8 | 2 << 16);
test("the NE2000 behind a root port: its I/O BAR starts above the legacy ports", () => {
    assert.equal(npci.config_read(2 << 8, 0, 4) >>> 0, 0x802910EC);
    assert.equal(npci.config_read(2 << 8, 0x10, 4) >>> 0, 0x1301);
    assert.equal(npci.config_read(0x02 << 3, 0, 4) >>> 0, 0xFFFFFFFF, "not at 00:02.0");
});
ne2k.destroy();

const { create_platform } = await import("../../src/platform.js");
test("placements behind root ports: on Q35, an existing port, one device per port", () => {
    const q35 = { machine_type: "q35", pcie_root_ports: 2 };
    assert.throws(() => create_platform({ root_port_devices: { net: { port: 0, plugged: true } } }, 32 << 20), /root ports need machine_type "q35"/);
    assert.throws(() => create_platform({ ...q35, root_port_devices: { net: { port: 2, plugged: true } } }, 32 << 20), /pcie_root_port must be/);
    assert.throws(() => create_platform({ ...q35, root_port_devices: { net: { port: 0, plugged: true }, virtio_9p: { port: 0, plugged: true } } }, 32 << 20), /taken/);
    assert.deepEqual(create_platform({ ...q35, root_port_devices: { net: { port: 1, plugged: false } } }, 32 << 20).root_port_devices, { net: 1 });
});

console.log((failed ? "FAIL" : "PASS") + ": " + passed + " PCI Express root port tests passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
