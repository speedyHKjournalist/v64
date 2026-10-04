#!/usr/bin/env node

// The Q35 machine (machine_type: "q35") with real guests and the real
// firmware (docs/q35.md, docs/ahci.md, docs/sata.md). PARTS selects (comma separated):
//   linux: SeaBIOS boots linux4.iso (Linux 4.16, IOAPIC routing) from the
//     SATA CD drive through AHCI; the tables have MCFG and the ICH9 layout;
//     the guest uses ECAM, ahci/libata with MSI and 64-bit DMA, reads its root from sr0,
//     writes and verifies hda (an asynchronous disk whose requests complete
//     out of order: native command queuing with several commands in flight),
//     finds a disk hot plugged into port 3 and loses it when it is pulled
//     out, keeps the data across a reset through the FADT reset register and
//     across a snapshot, and powers off (S5)
//   dos: MS-DOS 6.22 from the SATA disk through SeaBIOS's int13h in real
//     mode (clean boot), and with EMM386 in virtual-8086 mode, where
//     SeaBIOS reaches its 32-bit AHCI driver through SMM (call32_smm)
//   intx: the same kernel booted directly with pci=nomsi: AHCI's INTA
//     reaches the IOAPIC through PIRQA as GSI 16; a second AHCI controller
//     behind PCI Express root port 1 too (the swizzle, then device 28's
//     route), and ahci reads the disk behind the bridge; with the HPET
//   pic: a direct kernel boot (Linux 6.8, PIC routing): ECAM, the PCI
//     Express root bridge and the PIRQ links; the root complex registers
//     and the SMBus controller from the guest (devmem, /dev/port)
//   pcie: the same kernel with three PCI Express root ports; behind port 0
//     a second AHCI controller (no driver in this kernel), behind port 2 a
//     virtio entropy device: the buses and windows the firmware set up,
//     /dev/hwrng reading the virtio device through the I/O window
//   hpet: the same kernel with hpet: true: Linux finds the HPET by the ACPI
//     table, takes IRQ 0 with the legacy replacement route, keeps time with
//     it as clock source
// Images: images/linux4.iso, images/msdos622.img, images/buildroot-bzimage68.bin

import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";
import crypto from "node:crypto";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const PARTS = (process.env.PARTS || "linux,intx,dos,pic,pcie,hpet").split(",");
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { SyncBuffer } = await import("../../src/buffer.js");

const IMAGES = __dirname + "/../../images/";
const BIOS = { url: __dirname + "/../../bios/seabios.bin" };
const VGA_BIOS = { url: __dirname + "/../../bios/vgabios.bin" };

const log = message => console.log(message);

/**
 * A booted emulator with serial and screen helpers
 * @param {Object} options
 */
async function start(options)
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: BIOS,
        vga_bios: VGA_BIOS,
        machine_type: "q35",
        memory_size: 256 * 1024 * 1024,
        autostart: true,
        screen_dummy: true,
        log_level: 0,
        ...options,
    });
    const machine = { emulator, serial: "" };
    emulator.add_listener("serial0-output-byte", byte => {
        const c = String.fromCharCode(byte);
        if(SHOW_LOGS) process.stdout.write(c);
        machine.serial += c;
    });
    return machine;
}

function screen(machine)
{
    // (the screen exists once the emulator has loaded)
    const adapter = machine.emulator.screen_adapter;
    return adapter ? adapter.get_text_screen().join("\n") : "";
}

function wait_for(what, predicate, timeout_ms)
{
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            if(predicate()) return resolve();
            if(Date.now() - start > timeout_ms) return reject(new Error("timed out waiting for " + what));
            setTimeout(check, 50);
        };
        check();
    });
}

const PROMPT = /~% $/;

async function command(machine, cmd, timeout_ms = 120000)
{
    machine.serial = "";
    machine.emulator.serial0_send(cmd + "\n");
    await wait_for(JSON.stringify(cmd), () => PROMPT.test(machine.serial), timeout_ms);
    return machine.serial.slice(cmd.length).replace(PROMPT, "");
}

/** Run a command until its output satisfies predicate */
async function wait_for_command(machine, cmd, predicate, what, timeout_ms = 60000)
{
    const start = Date.now();
    for(;;)
    {
        const out = await command(machine, cmd);
        if(predicate(out)) return out;
        if(Date.now() - start > timeout_ms) throw new Error("timed out waiting for " + what + ": " + out);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

function next_event(emulator, name, timeout_ms)
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + name)), timeout_ms);
        const listener = value => {
            clearTimeout(timer);
            emulator.remove_listener(name, listener);
            resolve(value);
        };
        emulator.add_listener(name, listener);
    });
}

/**
 * v86's tables as the guest sees them
 * @param {!Uint8Array} mem
 */
function check_tables(mem)
{
    const u16 = a => mem[a] | mem[a + 1] << 8;
    const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
    const u64 = a => u32(a) + u32(a + 4) * 2 ** 32;
    const signature = (a, n = 4) => String.fromCharCode(...mem.subarray(a, a + n));
    const checksum = (a, n) => mem.subarray(a, a + n).reduce((x, y) => x + y, 0) & 0xFF;

    let rsdp = -1;
    for(let a = 0xE0000; a < 0x100000; a += 16)
    {
        if(signature(a, 8) === "RSD PTR " && checksum(a, 20) === 0) { rsdp = a; break; }
    }
    assert.ok(rsdp >= 0, "RSDP");
    assert.equal(signature(rsdp + 9, 6), "V86   ", "v86's tables");
    const xsdt = u64(rsdp + 24);
    const tables = {};
    for(let p = xsdt + 36; p < xsdt + u32(xsdt + 4); p += 8)
    {
        const address = u64(p);
        assert.equal(checksum(address, u32(address + 4)), 0, signature(address) + " checksum");
        tables[signature(address)] = address;
    }
    assert.deepEqual(Object.keys(tables).sort(), ["APIC", "FACP", "MCFG"]);

    const mcfg = tables["MCFG"];
    assert.equal(u64(mcfg + 44), 0xB0000000, "MCFG: ECAM base");
    assert.deepEqual([u16(mcfg + 52), mem[mcfg + 54], mem[mcfg + 55]], [0, 0, 255], "segment 0, buses 0-255");

    const facp = tables["FACP"];
    const pm_base = u32(facp + 56);
    assert.equal(pm_base, 0x600, "the PM base SeaBIOS programs in PMBASE");
    assert.deepEqual([mem[facp + 52], mem[facp + 53]], [0x02, 0x03], "ICH9 ACPI_ENABLE/ACPI_DISABLE");
    assert.equal(u32(facp + 80), pm_base + 0x20, "GPE0_BLK inside the ICH9 PM block");
    assert.equal(mem[facp + 92], 16, "GPE0_BLK_LEN");

    const dsdt = u32(facp + 40);
    const text = Buffer.from(mem.subarray(dsdt, dsdt + u32(dsdt + 4)));
    assert.ok(text.includes("_S5_"), "S5 advertised");
    assert.ok(!text.includes("_S3_") && !text.includes("_S4_"), "S3 and S4 not advertised on Q35 yet");
    assert.ok(text.includes("PRTA") && text.includes("PRTP") && text.includes("PICF"), "APIC and PIC routing tables, _PIC");
    assert.ok(text.includes("DRAC"), "ECAM reserved by a motherboard resource");
}

/**
 * A disk image whose requests complete after a random 0-4 ms, so that
 * requests in flight together complete out of order. Writes reach the image
 * at once (only their completion is late), reads take the data when issued.
 * (a class: state images take no plain objects)
 */
class LatencyDisk
{
    /** @param {!Uint8Array} data */
    constructor(data)
    {
        this.data = data;
        this.byteLength = data.length;
        this.in_flight = 0;
        this.max_in_flight = 0;
    }
    load() { this.onload?.({}); }
    later(f)
    {
        this.max_in_flight = Math.max(this.max_in_flight, ++this.in_flight);
        setTimeout(() => { this.in_flight--; f(); }, Math.random() * 4);
    }
    get(start, length, done)
    {
        const data = this.data.slice(start, start + length);
        this.later(() => done(data));
    }
    set(start, data, done)
    {
        this.data.set(data, start);
        this.later(done);
    }
    // (the starter reads the MBR for the CHS geometry)
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache(start, length) { return this.data.slice(start, start + length); }
    get_buffer(done) { done(undefined); }
    get_state() { return []; }
    set_state() {}
}

async function part_linux()
{
    log("linux: booting linux4.iso from the SATA CD drive");
    const disk = new Uint8Array(64 * 1024 * 1024);
    const hda = new LatencyDisk(disk);
    const machine = await start({
        cdrom: { url: IMAGES + "linux4.iso" },
        hda,
    });
    const { emulator } = machine;
    try
    {
        await wait_for("the shell", () => PROMPT.test(machine.serial), 240000);
        const cpu = emulator.v86.cpu;
        check_tables(cpu.mem8);
        log("linux: tables: MCFG, FADT with the ICH9 PM layout, S5 only");

        const dmesg = await command(machine, "dmesg");
        for(const [pattern, what] of [
            [/PCI: Using MMCONFIG|PCI: MMCONFIG for domain 0000 \[bus 00-ff\] at \[mem 0xb0000000-0xbfffffff\]|ECAM \[mem 0xb0000000-0xbfffffff\]/, "ECAM"],
            [/ACPI: Using IOAPIC for interrupt routing/, "IOAPIC routing"],
            [/PNP0A08/, "PCI Express root bridge"],
            [/ahci 0000:00:1f\.2: AHCI 0001\.0000 32 slots 6 ports 1\.5 Gbps 0x3f impl SATA mode/, "AHCI controller"],
            [/ata1: SATA link up 1\.5 Gbps/, "hda's link"],
            [/ata1\.00: .*LBA48 NCQ \(depth (31\/)?32\)/, "hda with NCQ"],
            [/ata3\.00: ATAPI: /, "the CD drive"],
            [/Attached scsi CD-ROM sr0/, "sr0"],
            [/ata2: SATA link down/, "empty port"],
        ])
        {
            assert.ok(pattern.test(dmesg), what + " in dmesg");
        }
        assert.ok(!/exception Emask|hard resetting link|timeout|failed command/i.test(dmesg), "no libata errors");
        assert.ok(/ahci 0000:00:1f\.2: flags: 64bit/.test(dmesg), "64-bit addressing");
        const interrupts = await command(machine, "cat /proc/interrupts");
        assert.ok(/\d+:\s+\d+\s+PCI-MSI \d+-edge\s+ahci/.test(interrupts), "ahci uses MSI");
        log("linux: ECAM, IOAPIC routing, ahci with MSI and 64-bit DMA, hda and sr0 attached");

        // Write a pattern with the guest, compare it on both sides
        const md5 = await command(machine,
            "dd if=/dev/urandom of=/tmp/x bs=1k count=4096 2>/dev/null && dd if=/tmp/x of=/dev/sda bs=64k conv=fsync 2>/dev/null; " +
            "echo 3 > /proc/sys/vm/drop_caches; dd if=/dev/sda bs=64k count=64 2>/dev/null | md5sum; md5sum /tmp/x");
        const sums = md5.match(/[0-9a-f]{32}/g);
        assert.ok(sums && sums.length === 2 && sums[0] === sums[1], "read back what was written: " + md5);
        const host_sum = crypto.createHash("md5").update(disk.subarray(0, 4 << 20)).digest("hex");
        assert.equal(host_sum, sums[0], "the disk image holds the guest's data");
        // reads of four regions at once
        const parallel = await command(machine,
            "echo 3 > /proc/sys/vm/drop_caches; for i in 0 1 2 3; do dd if=/dev/sda bs=4k skip=$((i * 256)) count=256 2>/dev/null | md5sum & done; wait");
        const parallel_sums = parallel.match(/[0-9a-f]{32}/g);
        assert.deepEqual(parallel_sums && parallel_sums.sort(),
            [0, 1, 2, 3].map(i => crypto.createHash("md5").update(disk.subarray(i << 20, i + 1 << 20)).digest("hex")).sort(),
            "parallel reads: " + parallel);
        const ahci_port = emulator.v86.cpu.devices.ahci.ports[0];
        assert.ok(hda.max_in_flight > 1, "queued commands overlapped (" + hda.max_in_flight + " in flight at most)");
        assert.equal(ahci_port.ncq_error, null);
        log("linux: NCQ: up to " + hda.max_in_flight + " commands in flight, completing out of order");

        // An NCQ error: the disk image claims to end at 32 MiB for a moment,
        // a read at 48 MiB fails with IDNF. Linux's error handler restarts
        // the port, finds the failed tag in the NCQ error log (READ LOG EXT
        // 10h), fails that command and goes on with NCQ.
        await command(machine, "dmesg -c >/dev/null");
        hda.byteLength = 32 << 20;
        const failed = await command(machine, "echo 3 > /proc/sys/vm/drop_caches; dd if=/dev/sda of=/dev/null bs=4k skip=12288 count=16; echo status=$?");
        hda.byteLength = disk.length;
        assert.ok(/status=1/.test(failed), "the read failed: " + failed);
        const eh = await command(machine, "dmesg");
        for(const [pattern, what] of [
            [/ata1\.00: failed command: READ FPDMA QUEUED/, "the failed queued command"],
            [/ata1\.00: error: \{ IDNF \}/, "its error, from the NCQ error log"],
            [/ata1: EH complete/, "recovery"],
        ])
        {
            assert.ok(pattern.test(eh), what + " in dmesg: " + eh);
        }
        assert.ok(!/log page 10h|hard resetting link|limiting SATA|NCQ disabled|timeout/i.test(eh), "no reset, NCQ kept: " + eh);
        const recovered = await command(machine, "dd if=/dev/sda bs=4k skip=12288 count=16 2>/dev/null | md5sum");
        assert.ok(recovered.includes(crypto.createHash("md5").update(disk.subarray(48 << 20, (48 << 20) + 65536)).digest("hex")), "reads work again: " + recovered);
        log("linux: NCQ error: IDNF reported through the NCQ error log, no link reset, reads work again");

        // link power management: with the min_power policy Linux sets ALPE
        // and ASP, the idle link sleeps (slumber), commands wake it
        const port0 = emulator.v86.cpu.devices.ahci.ports[0];
        const policy = "/sys/class/scsi_host/host0/link_power_management_policy";
        await command(machine, "dmesg -c >/dev/null");
        assert.ok((await command(machine, "echo min_power > " + policy + "; cat " + policy)).includes("min_power"));
        const lpm_read = await command(machine, "echo 3 > /proc/sys/vm/drop_caches; dd if=/dev/sda bs=64k count=64 2>/dev/null | md5sum");
        assert.ok(lpm_read.includes(crypto.createHash("md5").update(disk.subarray(0, 4 << 20)).digest("hex")), "reads with LPM: " + lpm_read);
        assert.equal(port0.cmd >> 26 & 3, 3, "ALPE and ASP");
        assert.equal(port0.ssts >> 8 & 0xF, 6, "idle: slumber");
        await command(machine, "echo max_performance > " + policy);
        assert.equal(port0.ssts >> 8 & 0xF, 1, "max_performance: active");
        const lpm_dmesg = await command(machine, "dmesg");
        assert.ok(!/exception Emask|hard resetting link|failed command/.test(lpm_dmesg), "no libata errors: " + lpm_dmesg);
        log("linux: link power management (min_power): the idle link slumbers, reads wake it");

        const cd_sum = await command(machine, "dd if=/dev/sr0 bs=64k count=32 2>/dev/null | md5sum");
        const iso = fs.readFileSync(IMAGES + "linux4.iso");
        assert.ok(cd_sum.includes(crypto.createHash("md5").update(iso.subarray(0, 2 << 20)).digest("hex")), "sr0 reads the ISO");
        log("linux: 4 MiB written to hda and read back, sr0 matches the ISO");

        // hot plug: a disk into port 3 (ata4)
        const extra = new Uint8Array(8 << 20).map((_, i) => i * 31 + (i >> 9) & 0xFF);
        const extra_sum = crypto.createHash("md5").update(extra).digest("hex");
        await emulator.attach_sata_drive(3, { buffer: extra.buffer });
        await wait_for_command(machine, "ls /sys/block | cat", out => /^sdb\s*$/m.test(out), "sdb");
        const extra_read = await command(machine, "dd if=/dev/sdb bs=64k 2>/dev/null | md5sum");
        assert.ok(extra_read.includes(extra_sum), "sdb reads the image: " + extra_read);
        const plugged = await command(machine, "dmesg | grep ata4");
        assert.ok(/ata4: SATA link up 1\.5 Gbps/.test(plugged) && /ata4\.00: .*NCQ/.test(plugged), plugged);
        log("linux: a disk hot plugged into port 3 appears as sdb (ata4) and reads the image");

        // a snapshot, restored into the same machine (with the hot plugged disk)
        const state = await emulator.save_state();
        await emulator.restore_state(state);
        const after = await command(machine, "echo 3 > /proc/sys/vm/drop_caches; dd if=/dev/sda bs=64k count=64 2>/dev/null | md5sum; dd if=/dev/sdb bs=64k 2>/dev/null | md5sum");
        assert.ok(after.includes(sums[0]) && after.includes(extra_sum), "after a snapshot restore: " + after);
        log("linux: snapshot restored, the disks read the same");

        // and pulled out again
        emulator.detach_sata_drive(3);
        await wait_for_command(machine, "ls /sys/block | cat", out => !/^sdb\s*$/m.test(out), "sdb to go away");
        const unplugged = await command(machine, "dmesg | grep ata4");
        assert.ok(/ata4: SATA link down/.test(unplugged), unplugged);
        log("linux: pulled out, sdb is gone (ata4: link down)");

        // reset through the FADT reset register, boot again from the CD
        machine.serial = "";
        emulator.serial0_send("reboot -f\n");
        await wait_for("the shell after the reset", () => PROMPT.test(machine.serial), 240000);
        const again = await command(machine, "dd if=/dev/sda bs=64k count=64 2>/dev/null | md5sum");
        assert.ok(again.includes(sums[0]), "the data is still on hda after the reset");
        log("linux: reset (reboot), booted again from the CD, hda kept the data");

        const off = next_event(emulator, "acpi-power-off", 60000);
        emulator.serial0_send("poweroff -f\n");
        assert.equal(await off, "S5");
        log("linux: poweroff -> S5");
    }
    finally
    {
        emulator.destroy();
    }
}

/**
 * A file from an ISO9660 image (plain names, without version or Rock Ridge)
 * @param {string} path
 * @param {!Array<string>} names
 * @return {!ArrayBuffer}
 */
function iso_file(path, names)
{
    const iso = fs.readFileSync(path);
    let extent = iso.readUInt32LE(16 * 2048 + 156 + 2), size = iso.readUInt32LE(16 * 2048 + 156 + 10);
    for(const name of names)
    {
        let found = false;
        for(let at = extent * 2048; at < extent * 2048 + size;)
        {
            const length = iso[at];
            if(!length) { at = (Math.floor(at / 2048) + 1) * 2048; continue; }
            const entry = iso.toString("latin1", at + 33, at + 33 + iso[at + 32]).replace(/;\d+$/, "").replace(/\.$/, "");
            if(entry === name)
            {
                extent = iso.readUInt32LE(at + 2);
                size = iso.readUInt32LE(at + 10);
                found = true;
                break;
            }
            at += length;
        }
        assert.ok(found, name + " in " + path);
    }
    return iso.buffer.slice(iso.byteOffset + extent * 2048, iso.byteOffset + extent * 2048 + size);
}

async function part_intx()
{
    log("intx: linux4's kernel booted directly with pci=nomsi: AHCI's INTA through PIRQA, GSI 16");
    const disk = new Uint8Array(4 << 20).map((_, i) => i * 29 + (i >> 9) & 0xFF);
    const machine = await start({
        cdrom: { url: IMAGES + "linux4.iso" },
        bzimage: { buffer: iso_file(IMAGES + "linux4.iso", ["BOOT", "BZIMAGE"]) },
        cmdline: "root=/dev/sr0 pci=nomsi",
        // a second AHCI controller behind root port 1
        pcie_root_ports: 2,
        ahci_test_drives: [{ buffer: new SyncBuffer(disk.buffer) }],
        ahci_test_pci_id: 2 << 8,
        // (and the HPET, for this kernel too)
        hpet: true,
    });
    try
    {
        await wait_for("the shell", () => PROMPT.test(machine.serial), 240000);
        await command(machine, "dd if=/dev/sr0 bs=64k count=16 2>/dev/null | md5sum");
        const interrupts = await command(machine, "cat /proc/interrupts");
        const match = interrupts.match(/16:\s+(\d+)\s+IO-APIC\s+16-fasteoi\s+ahci/);
        assert.ok(match && +match[1] > 0, "ahci on GSI 16 (PIRQA): " + interrupts);
        log("intx: " + match[1] + " interrupts on GSI 16");

        const dmesg = await command(machine, "dmesg");
        const bus = dmesg.match(/pci 0000:00:1c\.1: PCI bridge to \[bus (\w\w)\]/);
        assert.ok(bus, "root port 1's bus: " + dmesg);
        assert.ok(new RegExp("ahci 0000:" + bus[1] + ":00\\.0: AHCI 0001\\.0000 32 slots 6 ports").test(dmesg), "ahci behind the bridge");
        const block = await command(machine, "for b in /sys/block/sd*; do echo $(readlink -f $b); done");
        const sd = block.match(new RegExp("0000:00:1c\\.1/0000:" + bus[1] + ":00\\.0/\\S*/block/(sd\\w)"));
        assert.ok(sd, "a disk behind the bridge: " + block);
        const sum = await command(machine, "dd if=/dev/" + sd[1] + " bs=64k 2>/dev/null | md5sum");
        assert.ok(sum.includes(crypto.createHash("md5").update(disk).digest("hex")), "reads the disk: " + sum);
        const shared = await command(machine, "cat /proc/interrupts");
        assert.ok(new RegExp("16:\\s+\\d+\\s+IO-APIC\\s+16-fasteoi\\s+ahci\\[0000:00:1f\\.2\\], ahci\\[0000:" + bus[1] + ":00\\.0\\]").test(shared),
            "both controllers on GSI 16: INTA behind root port 1 -> device 28's INTA -> PIRQA: " + shared);
        log("intx: the AHCI controller behind root port 1 (" + bus[1] + ":00.0): /dev/" + sd[1] + " reads the image, INTA on GSI 16");
        assert.ok(/ACPI: HPET id: 0x8086a201 base: 0xfed00000/.test(dmesg) && /clocksource: hpet: mask/.test(dmesg), "the HPET");
        assert.ok(machine.emulator.v86.cpu.devices.hpet.legacy_replacement(), "IRQ 0 from the HPET");
        log("intx: Linux 4.16 uses the HPET too (legacy replacement route)");
    }
    finally
    {
        machine.emulator.destroy();
    }
}

async function part_dos()
{
    for(const clean of [true, false])
    {
        log("dos: MS-DOS 6.22 from the SATA disk, " + (clean ? "clean boot (real mode)" : "CONFIG.SYS with EMM386 (virtual-8086 mode)"));
        const machine = await start({
            hda: { buffer: fs.readFileSync(IMAGES + "msdos622.img").buffer },
            memory_size: 64 * 1024 * 1024,
        });
        try
        {
            let pressed = false;
            const press = setInterval(() => {
                if(clean && !pressed && /Starting MS-DOS/.test(screen(machine)))
                {
                    machine.emulator.keyboard_send_scancodes([0x3F, 0xBF]); // F5: bypass CONFIG.SYS and AUTOEXEC.BAT
                    pressed = /bypassing/.test(screen(machine));
                }
            }, 50);
            try
            {
                if(clean)
                {
                    await wait_for("C:\\>", () => /C:\\>/.test(screen(machine)), 120000);
                    assert.ok(/MS-DOS is bypassing/.test(screen(machine)));
                    log("dos: C:\\> through SeaBIOS's AHCI disk services");
                }
                else
                {
                    // EMM386 runs DOS in virtual-8086 mode: SeaBIOS reaches its
                    // 32-bit AHCI driver from there through SMM (call32_smm)
                    await wait_for("the emulator", () => machine.emulator.v86, 60000);
                    const cpu = machine.emulator.v86.cpu;
                    // (counted where the APM control port raises them, in
                    // the mode of the guest's OUT)
                    let smis = 0, from_vm86 = 0;
                    const smi = cpu.smi.bind(cpu);
                    cpu.smi = core => {
                        smis++;
                        if(cpu.get_eflags() & 1 << 17) from_vm86++;
                        smi(core);
                    };
                    await wait_for("C:\\>", () => /C:\\>|Bad or missing/.test(screen(machine)), 120000);
                    assert.ok(!/Bad or missing/.test(screen(machine)), "disk services in virtual-8086 mode: " + screen(machine));
                    const before = from_vm86;
                    machine.emulator.keyboard_send_text("dir\n");
                    await wait_for("DIR", () => /bytes free/.test(screen(machine)), 60000);
                    assert.ok(cpu.cr[0] & 1, "EMM386: protected mode");
                    assert.ok(from_vm86 > before, "DIR's disk reads: SMIs from virtual-8086 mode (" + (from_vm86 - before) + ")");
                    log("dos: with EMM386 the disk services work from virtual-8086 mode through SMM: " +
                        from_vm86 + " of " + smis + " SMIs from virtual-8086 mode");
                }
            }
            finally
            {
                clearInterval(press);
            }
        }
        finally
        {
            machine.emulator.destroy();
        }
    }
}

async function part_pic()
{
    log("pic: direct kernel boot, PIC routing");
    const machine = await start({
        bzimage: { url: IMAGES + "buildroot-bzimage68.bin" },
        cmdline: "console=ttyS0 audit=0",
        smbus: true,
    });
    try
    {
        await wait_for("the shell", () => PROMPT.test(machine.serial), 180000);
        const dmesg = await command(machine, "dmesg");
        assert.ok(/ECAM \[mem 0xb0000000-0xbfffffff\].*for domain 0000 \[bus 00-ff\]/.test(dmesg), "ECAM");
        assert.ok(/Using ECAM for extended config space/.test(dmesg));
        assert.ok(/ACPI: Using PIC for interrupt routing/.test(dmesg));
        assert.ok(/ACPI: PCI Root Bridge \[PCI0\]/.test(dmesg));
        for(const link of "ABCDEFGH") assert.ok(new RegExp("Interrupt link LNK" + link + " configured for IRQ 1[01]").test(dmesg), "LNK" + link);
        const devices = await command(machine, "for d in /sys/bus/pci/devices/*; do echo $d $(cat $d/vendor $d/device $d/class); done");
        for(const [bdf, id] of [["00:00.0", "0x8086 0x29c0 0x060000"], ["00:1f.0", "0x8086 0x2918 0x060100"], ["00:1f.2", "0x8086 0x2922 0x010601"]])
        {
            assert.ok(devices.includes(bdf + " " + id), bdf + " " + id);
        }
        const iomem = await command(machine, "cat /proc/iomem");
        assert.ok(/b0000000-bfffffff : PCI ECAM/.test(iomem) || /b0000000-bfffffff : PCI MMCONFIG/.test(iomem));
        assert.ok(/fed1c000-fed1ffff/.test(iomem), "RCBA reserved");
        // the root complex registers reach the guest (GCS: no reboot; D28IR:
        // INTA-D -> PIRQA-D)
        const rcba = await command(machine, "devmem 0xfed1f410 32; devmem 0xfed1f146 16");
        assert.ok(/0x00000020\s+0x3210/.test(rcba), "RCBA through the guest's own reads: " + rcba);
        log("pic: ECAM in use, PNP0A08 root bridge, eight PIRQ links, chipset functions, RCBA readable");

        // the SMBus controller where SeaBIOS put it (the PM base + 0x100),
        // a byte written to the EEPROM at 0x50 and read back through /dev/port
        const smbus = await command(machine, "cat /sys/bus/pci/devices/0000:00:1f.3/class /sys/bus/pci/devices/0000:00:1f.3/resource | head -6");
        assert.ok(/0x0c0500/.test(smbus) && /0x0000000000000700 0x000000000000071f 0x0000000000040101/.test(smbus), "00:1f.3 at 0x700: " + smbus);
        // (shell functions, so that the commands stay short)
        await command(machine, "outb() { printf \"\\\\$(printf %o $2)\" | dd of=/dev/port bs=1 seek=$1 conv=notrunc 2>/dev/null; }");
        await command(machine, "inb() { dd if=/dev/port bs=1 skip=$1 count=1 2>/dev/null | od -An -tx1 | tr -d ' '; }");
        // write byte data 0x77 at offset 5 of the EEPROM at 0x50, then read it
        await command(machine, "outb 1792 255; outb 1796 160; outb 1795 5; outb 1797 119; outb 1794 72");
        const read_back = await command(machine, "outb 1792 255; outb 1796 161; outb 1795 5; outb 1794 72; echo SMB $(inb 1792) $(inb 1797)");
        const result = read_back.match(/SMB ([0-9a-f]{2}) ([0-9a-f]{2})/);
        assert.ok(result && (parseInt(result[1], 16) & 0xBF) === 0x02 && result[2] === "77", "INTR, and the byte: " + read_back);
        log("pic: SMBus at 0x700 (SeaBIOS), the EEPROM at 0x50 written and read by the guest");
    }
    finally
    {
        machine.emulator.destroy();
    }
}

async function part_pcie()
{
    log("pcie: direct kernel boot, three PCI Express root ports");
    const disk = new Uint8Array(4 << 20).map((_, i) => i * 29 + (i >> 9) & 0xFF);
    const pattern = i => i * 37 + 11 & 0xFF;
    let rng;
    const machine = await start({
        bzimage: { url: IMAGES + "buildroot-bzimage68.bin" },
        cmdline: "console=ttyS0 audit=0",
        pcie_root_ports: 3,
        ahci_test_drives: [{ buffer: new SyncBuffer(disk.buffer) }],
        ahci_test_pci_id: 1 << 8,
        virtio_devices: [{
            "name": "rng",
            "device_id": 0x1044,
            "subsystem_device_id": 4,
            "queues": [{ "size": 8 }],
            "pcie_root_port": 2,
            "init": handle => { rng = handle; },
            "notify": queue => {
                let request;
                while((request = rng["pop_request"](queue)))
                {
                    const bytes = new Uint8Array(request["writable"]);
                    for(let i = 0; i < bytes.length; i++) bytes[i] = pattern(i);
                    request["write"](bytes);
                    request["complete"]();
                }
                rng["flush"](queue);
            },
        }],
    });
    try
    {
        await wait_for("the shell", () => PROMPT.test(machine.serial), 180000);
        const devices = await command(machine, "for d in /sys/bus/pci/devices/*; do echo $(readlink -f $d) $(cat $d/vendor $d/device $d/class); done");
        for(let n = 0; n < 3; n++)
        {
            const id = "0x8086 0x" + (0x2940 + 2 * n).toString(16) + " 0x060400";
            assert.ok(devices.includes("/sys/devices/pci0000:00/0000:00:1c." + n + " " + id), "root port " + n + ": " + devices);
        }
        const ahci = devices.match(/\/0000:00:1c\.0\/0000:(\w\w):00\.0 0x8086 0x2922 0x010601/);
        const virtio = devices.match(/\/0000:00:1c\.2\/0000:(\w\w):00\.0 0x1af4 0x1044 0x/);
        assert.ok(ahci && virtio, "the AHCI controller behind port 0, the virtio device behind port 2: " + devices);
        log("pcie: root ports 00:1c.0-2, AHCI at " + ahci[1] + ":00.0 behind port 0, virtio at " + virtio[1] + ":00.0 behind port 2");

        const dmesg = await command(machine, "dmesg");
        assert.ok(/pci 0000:00:1c\.0: \[8086:2940\] type 01 class 0x060400 PCIe Root Port/.test(dmesg), "a PCI Express root port");
        assert.ok(new RegExp("pci 0000:00:1c\\.0: PCI bridge to \\[bus " + ahci[1] + "\\]").test(dmesg), "the bridge's bus");
        assert.ok(new RegExp("pci 0000:00:1c\\.2:\\s+bridge window \\[io\\s+0x[0-9a-f]+-0x[0-9a-f]+\\]").test(dmesg), "port 2: an I/O window for the virtio device");
        assert.ok(!/BAR \d+: (no space|failed)|can't claim/.test(dmesg), "every BAR assigned within the windows");

        const expected = Array.from({ length: 8 }, (_, i) => pattern(i).toString(16).padStart(2, "0")).join(" ");
        const random = await command(machine, "cat /sys/class/misc/hw_random/rng_current; head -c 8 /dev/hwrng | od -An -tx1");
        assert.ok(random.includes("virtio_rng") && random.includes(expected), "/dev/hwrng: " + random);
        const interrupts = await command(machine, "cat /proc/interrupts");
        assert.ok(/virtio\d/.test(interrupts), "the virtio device's interrupt: " + interrupts);
        log("pcie: /dev/hwrng reads the virtio device behind root port 2 (INTx through the swizzle)");
    }
    finally
    {
        machine.emulator.destroy();
    }
}

async function part_hpet()
{
    log("hpet: direct kernel boot with the HPET");
    const machine = await start({
        bzimage: { url: IMAGES + "buildroot-bzimage68.bin" },
        cmdline: "console=ttyS0 audit=0",
        hpet: true,
    });
    try
    {
        await wait_for("the shell", () => PROMPT.test(machine.serial), 180000);
        const hpet = machine.emulator.v86.cpu.devices.hpet;
        const dmesg = await command(machine, "dmesg");
        assert.ok(/ACPI: HPET 0x[0-9A-F]+ 000038 \(v01 /.test(dmesg), "the ACPI table: " + dmesg);
        assert.ok(/ACPI: HPET id: 0x8086a201 base: 0xfed00000/.test(dmesg), "the event timer block");
        assert.ok(/clocksource: hpet: mask: 0xffffffff/.test(dmesg), "an HPET clock source");
        assert.ok(!/hpet: Config register invalid|HPET.*(not|dis)abl/i.test(dmesg), "not refused");
        assert.ok(hpet.legacy_replacement(), "Linux took IRQ 0 and 8 (legacy replacement route)");
        const interrupts = await command(machine, "cat /proc/interrupts");
        const timer = interrupts.match(/^\s*0:\s+(\d+)\s+.*timer/m);
        assert.ok(timer && +timer[1] > 0, "interrupts on IRQ 0, from the HPET: " + interrupts);
        log("hpet: Linux found it (ACPI HPET table), IRQ 0 by legacy replacement: " + timer[1] + " interrupts");

        const sources = await command(machine, "cat /sys/devices/system/clocksource/clocksource0/available_clocksource");
        assert.ok(/\bhpet\b/.test(sources), sources);
        await command(machine, "echo hpet > /sys/devices/system/clocksource/clocksource0/current_clocksource");
        assert.ok((await command(machine, "cat /sys/devices/system/clocksource/clocksource0/current_clocksource")).includes("hpet"));
        const start = Date.now();
        const elapsed = await command(machine, "a=$(cut -d' ' -f1 /proc/uptime); sleep 2; b=$(cut -d' ' -f1 /proc/uptime); echo \"$a $b\"");
        const host_seconds = (Date.now() - start) / 1000;
        const [a, b] = elapsed.trim().split(/\s+/).slice(-2).map(Number);
        assert.ok(b - a >= 1.9 && b - a <= host_seconds + 0.2, "the guest's 2 s by the HPET: " + (b - a) + " (host " + host_seconds + ")");
        const timer_list = await command(machine, "grep -i -m 3 hpet /proc/timer_list");
        assert.ok(/hpet/i.test(timer_list), "an HPET clock event device: " + timer_list);
        log("hpet: clocksource hpet, sleep 2 took " + (b - a).toFixed(2) + " s of guest uptime");
    }
    finally
    {
        machine.emulator.destroy();
    }
}

const timeout = setTimeout(() => {
    console.log("Timeout");
    process.exit(1);
}, 20 * 60 * 1000);

for(const part of PARTS)
{
    await { "linux": part_linux, "intx": part_intx, "dos": part_dos, "pic": part_pic, "pcie": part_pcie, "hpet": part_hpet }[part]();
}
clearTimeout(timeout);
console.log("Q35 guest test passed (" + PARTS.join(", ") + ")");
