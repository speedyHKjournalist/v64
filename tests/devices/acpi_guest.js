#!/usr/bin/env node

// ACPI with a real guest (acpi: true). GUEST selects the image:
//   buildroot (default): buildroot-bzimage68.bin, Linux 6.8, PIC interrupt routing
//   linux4: linux4.iso, Linux 4.16, IOAPIC interrupt routing (uses the MADT)
// - the tables SeaBIOS installed from v86's table loader match the emulated
//   hardware and advertise S3, S4 and S5; the guest reports no ACPI errors
// - S3, if the kernel supports it (linux4): suspend to RAM, woken
//   alternately by an RTC alarm and by the power button (S3_CYCLES); RAM
//   contents and the shell survive, the kernel reports the wake from S3
// - S4, if supported: hibernate to a swap disk, ACPI S4 soft off, power
//   on with RAM cleared, the booted kernel restores the image from the disk
//   (as an initramfs does, through /sys/power/resume) (S4_CYCLES)
// - the fixed power button reaches the guest as one event, without an SCI storm
// - the PM timer keeps time as the guest's clocksource
// - "reboot" (reboot=acpi) goes through the FADT reset register and the guest
//   comes back with ACPI enabled (the direct-boot kernel is placed again)
// - "poweroff" enters S5: the emulator emits acpi-power-off and stops
// - power_button() powers the machine on again (repeated POWER_CYCLES times)

import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const POWER_CYCLES = +process.env.POWER_CYCLES || 2;
const S3_CYCLES = process.env.S3_CYCLES === undefined ? 4 : +process.env.S3_CYCLES;
const S4_CYCLES = process.env.S4_CYCLES === undefined ? 2 : +process.env.S4_CYCLES;
const CPU_CORES = +process.env.CPU_CORES || 1;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

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

const GUEST = process.env.GUEST || "buildroot";
const GUESTS = {
    // reboot=acpi: use the FADT reset register (also the default of newer kernels)
    "buildroot": {
        bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
        cmdline: "console=ttyS0 audit=0 reboot=acpi",
    },
    // The CD's own kernel, booted directly: its isolinux line is
    // "root=/dev/sr0". nokaslr: 32-bit hibernation restores into a kernel at
    // the same address (with KASLR the resuming kernel may lie elsewhere).
    // resume=: the kernel restores a hibernation image from the swap disk.
    // (Kernel messages stay on the VGA console: the image starts a shell on
    // the console and one on ttyS0.)
    "linux4": {
        cdrom: { url: __dirname + "/../../images/linux4.iso" },
        bzimage: { buffer: iso_file(__dirname + "/../../images/linux4.iso", ["BOOT", "BZIMAGE"]) },
        cmdline: "root=/dev/sr0 nokaslr resume=/dev/sda",
        // blank disk: swap space for hibernation
        hda: { buffer: new ArrayBuffer(96 * 1024 * 1024) },
    },
};
assert.ok(GUESTS[GUEST], "unknown GUEST " + GUEST);

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    autostart: true,
    memory_size: 256 * 1024 * 1024,
    acpi: true,
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1 && !+process.env.DISABLE_JIT,
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
    ...GUESTS[GUEST],
    // PARALLEL=1: application processors in vCPU workers
    ...(+process.env.PARALLEL ? { parallel: true, wasm_path: __dirname + "/../../build/v86-parallel.wasm" } : {}),
});

const overall_timeout = setTimeout(() => {
    console.log("\nTimeout. Serial output since the last command:\n" + serial);
    process.exit(1);
}, (120 + POWER_CYCLES * 60 + S3_CYCLES * 60 + S4_CYCLES * 180) * 1000);

let serial = "";
let waiter = null;

emulator.add_listener("serial0-output-byte", function(byte)
{
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    serial += chr;
    if(waiter && waiter.pattern.test(serial))
    {
        const { resolve } = waiter;
        waiter = null;
        resolve(serial);
    }
});

const PROMPT = /~% $/;

function wait_serial(pattern, what, timeout_ms)
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + what)), timeout_ms);
        waiter = { pattern, resolve: text => { clearTimeout(timer); resolve(text); } };
        if(pattern.test(serial))
        {
            waiter = null;
            clearTimeout(timer);
            resolve(serial);
        }
    });
}

async function command(cmd, timeout_ms = 60000)
{
    serial = "";
    emulator.serial0_send(cmd + "\n");
    const output = await wait_serial(PROMPT, JSON.stringify(cmd), timeout_ms);
    return output.slice(cmd.length);
}

function value_of(output, key)
{
    const match = output.match(new RegExp(key + "=(\\d+)"));
    assert.ok(match, "no " + key + "= in " + JSON.stringify(output));
    return +match[1];
}

function next_event(name, timeout_ms)
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
 * The tables SeaBIOS installed from v86's etc/table-loader, read from guest memory
 */
function check_tables()
{
    const mem = emulator.v86.cpu.mem8;
    const u16 = a => mem[a] | mem[a + 1] << 8;
    const u32 = a => (mem[a] | mem[a + 1] << 8 | mem[a + 2] << 16 | mem[a + 3] << 24) >>> 0;
    const u64 = a => u32(a) + u32(a + 4) * 2 ** 32;
    const signature = (a, n = 4) => String.fromCharCode(...mem.subarray(a, a + n));
    const checksum = (a, n) => mem.subarray(a, a + n).reduce((x, y) => x + y, 0) & 0xFF;
    const contains = (table, text) => Buffer.from(mem.subarray(table.addr, table.addr + table.len)).includes(text);

    let rsdp = -1;
    for(let a = 0xE0000; a < 0x100000; a += 16)
    {
        if(signature(a, 8) === "RSD PTR " && checksum(a, 20) === 0)
        {
            rsdp = a;
            break;
        }
    }
    assert.ok(rsdp >= 0, "RSDP in the BIOS area");
    assert.equal(mem[rsdp + 15], 2, "RSDP revision 2");
    assert.equal(checksum(rsdp, 36), 0, "RSDP extended checksum");
    assert.equal(signature(rsdp + 9, 6), "V86   ", "v86's tables, not SeaBIOS's fallback");

    const table_at = addr => {
        const len = u32(addr + 4);
        assert.equal(checksum(addr, len), 0, signature(addr) + " checksum");
        return { addr, len };
    };

    const xsdt = table_at(u64(rsdp + 24));
    assert.equal(signature(xsdt.addr), "XSDT");
    const rsdt = table_at(u32(rsdp + 16));
    assert.equal(signature(rsdt.addr), "RSDT");

    const tables = {};
    for(let p = xsdt.addr + 36; p < xsdt.addr + xsdt.len; p += 8)
    {
        const addr = u64(p);
        tables[signature(addr)] = table_at(addr);
        assert.equal(u32(rsdt.addr + 36 + (p - xsdt.addr - 36) / 2), addr, "RSDT lists the same table");
    }

    const facp = tables["FACP"].addr;
    assert.equal(mem[facp + 8], 3, "FADT revision 3");
    tables["DSDT"] = table_at(u32(facp + 40));
    assert.equal(signature(tables["DSDT"].addr), "DSDT");
    assert.equal(u64(facp + 140), tables["DSDT"].addr, "X_DSDT");

    // FACS has no checksum; it must be 64-byte aligned and at least 64 bytes
    const facs = u32(facp + 36);
    assert.equal(signature(facs), "FACS");
    assert.equal(facs % 64, 0);
    assert.ok(u32(facs + 4) >= 64);
    assert.equal(u64(facp + 132), facs, "X_FIRMWARE_CTRL");

    // FADT fields against the emulated PIIX4 PM function, at the base SeaBIOS programmed
    const pm_base = emulator.v86.cpu.devices.acpi.pm_base;
    assert.equal(pm_base, 0x600, "SeaBIOS moves the PM base when it loads v86's tables");
    assert.equal(u16(facp + 46), 9, "SCI_INT");
    assert.equal(u32(facp + 48), 0xB2, "SMI_CMD");
    assert.equal(mem[facp + 52], 0xF1, "ACPI_ENABLE");
    assert.equal(mem[facp + 53], 0xF0, "ACPI_DISABLE");
    assert.equal(u32(facp + 56), pm_base, "PM1a_EVT_BLK");
    assert.equal(u32(facp + 64), pm_base + 4, "PM1a_CNT_BLK");
    assert.equal(u32(facp + 76), pm_base + 8, "PM_TMR_BLK");
    assert.equal(u32(facp + 80), 0xAFE0, "GPE0_BLK");
    assert.deepEqual([mem[facp + 88], mem[facp + 89], mem[facp + 91], mem[facp + 92]], [4, 2, 4, 4], "block lengths");
    const flags = u32(facp + 112);
    assert.equal(flags & 1 << 4, 0, "PWR_BUTTON clear: fixed power button");
    assert.equal(flags & 1 << 8, 0, "TMR_VAL_EXT clear: 24-bit timer");
    assert.ok(flags & 1 << 10, "RESET_REG_SUP");
    assert.deepEqual([mem[facp + 116], u64(facp + 120), mem[facp + 128]], [1, 0xCF9, 0x06], "RESET_REG");

    // Sleep states: S3 (SLP_TYP 1), S4 (2), S5 (0)
    for(const state of ["_S3_", "_S4_", "_S5_"]) assert.ok(contains(tables["DSDT"], state), state + " advertised");
    // no S4BIOS: the OS hibernates itself
    assert.equal(u32(facs + 16) & 1, 0, "FACS S4BIOS_F clear");

    assert.ok(tables["APIC"], "MADT");

    return Object.keys(tables).sort();
}

async function boot()
{
    // printed by the image's init scripts on every boot, then the shell
    await wait_serial(/Files send via emulator appear in \/mnt\/[\s\S]*~% $/, "boot to the shell prompt", 120000);
}

async function power_off()
{
    const event = next_event("acpi-power-off", 60000);
    const stopped = next_event("emulator-stopped", 60000);
    serial = "";
    emulator.serial0_send("poweroff\n");
    assert.equal(await event, "S5");
    await stopped;
    assert.equal(emulator.is_running(), false);
}

const t0 = Date.now();
const log = text => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`);

await boot();
log("booted");

log("tables: " + check_tables().join(" "));

// The diagnostics snapshot sees the same machine
{
    const d = await emulator.get_diagnostics();
    assert.equal(d.cpu.mode, "protected32");
    assert.ok(d.cpu.paging);
    assert.equal(d.acpi.pm_base, "0x600");
    assert.ok(d.acpi.sci_enabled, "the OS switched to ACPI mode");
    assert.equal(d.acpi_tables.oem_id, "V86   ");
    assert.deepEqual(d.acpi_tables.tables.map(t => t.signature).sort(), ["APIC", "DSDT", "FACP", "FACS", "XSDT"]);
    assert.ok(d.acpi_tables.tables.every(t => t.checksum_ok));
    // (the local APIC of the core that ran last)
    assert.equal(d.apic.id, d.active_core ?? 0);
}

// Older kernels report that the PCI root bridge has no _OSC; it is optional
// for conventional PCI (the tables don't claim PCIe features)
const PROBLEMS = "dmesg | grep -i -E 'ACPI (BIOS )?(Error|Warning)|AE_[A-Z_]+|Firmware Bug' | grep -v '_OSC failed (AE_NOT_FOUND)'";
const acpi_problems = await command(PROBLEMS + "; echo PROBLEMS=$(" + PROBLEMS + " | wc -l)");
assert.equal(value_of(acpi_problems, "PROBLEMS"), 0, "ACPI errors in dmesg: " + acpi_problems);

const dmesg = await command("dmesg | grep -E 'ACPI: (Interpreter enabled|(PM: )?\\(supports)|Power Button|Using (PIC|IOAPIC) for interrupt routing'");
assert.match(dmesg, /ACPI: Interpreter enabled/);
const sleep_states = await command("cat /sys/power/state 2>/dev/null; echo STATES_END");
const can_suspend = /\bmem\b/.test(sleep_states), can_hibernate = /\bdisk\b/.test(sleep_states);
// a kernel without CONFIG_SUSPEND/HIBERNATION lists only what it can use
assert.match(dmesg, can_suspend ? /ACPI: (PM: )?\(supports S0 S3 S4 S5\)/ : /ACPI: (PM: )?\(supports S0 (S3 )?(S4 )?S5\)/);
assert.match(dmesg, /Power Button \[PWRF\]/);
log("guest ACPI: " + dmesg.trim().split("\n").filter(line => line.includes("ACPI")).join(" | "));

const COUNTERS = "set -- $(cat /sys/firmware/acpi/interrupts/ff_pwr_btn); echo BTN=$1; " +
    "set -- $(cat /sys/firmware/acpi/interrupts/sci); echo SCI=$1";
const before = await command(COUNTERS);
assert.equal(await emulator.power_button(), true);
await new Promise(resolve => setTimeout(resolve, 1000));
const after = await command(COUNTERS);
const buttons = value_of(after, "BTN") - value_of(before, "BTN");
const scis = value_of(after, "SCI") - value_of(before, "SCI");
log(`power button: ${buttons} event(s), ${scis} SCI(s)`);
assert.equal(buttons, 1);
assert.ok(scis >= 1 && scis <= 3, "no SCI storm");

const clocksource = await command(
    "echo acpi_pm > /sys/devices/system/clocksource/clocksource0/current_clocksource; " +
    "cat /sys/devices/system/clocksource/clocksource0/current_clocksource");
if(!/\nacpi_pm/.test(clocksource))
{
    // Keep the failure strict, but distinguish an unavailable/rejected clock
    // from a serial command failure when tests run under heavy host load.
    console.error("Clocksource selection returned: " + JSON.stringify(clocksource));
    console.error(await command(
        "cat /sys/devices/system/clocksource/clocksource0/available_clocksource; " +
        "dmesg | grep -i -E 'clocksource|pm.timer|pmtmr|unstable'"));
}
assert.match(clocksource, /\nacpi_pm/);
const host_start = Date.now();
const uptime = await command("set -- $(cat /proc/uptime); echo U0=${1%.*}${1#*.}; sleep 3; set -- $(cat /proc/uptime); echo U1=${1%.*}${1#*.}");
const guest_seconds = (value_of(uptime, "U1") - value_of(uptime, "U0")) / 100;
const host_seconds = (Date.now() - host_start) / 1000;
log(`acpi_pm clocksource: guest ${guest_seconds.toFixed(2)}s over host ${host_seconds.toFixed(2)}s`);
assert.ok(guest_seconds >= 2.9 && guest_seconds <= host_seconds + 0.1, "guest time follows the PM timer");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// S3: suspend to RAM. A tmpfs file (RAM only) must survive; the wake cause
// alternates between the RTC alarm (RTC_EN wake) and the power button.
if(can_suspend && S3_CYCLES)
{
    await command("dd if=/dev/urandom of=/tmp/s3.bin bs=1024 count=2048 2>/dev/null; md5sum /tmp/s3.bin > /tmp/s3.md5");
    for(let cycle = 1; cycle <= S3_CYCLES; cycle++)
    {
        const by_rtc = cycle % 2 === 1;
        const before = await command("set -- $(cat /proc/uptime); echo UP=${1%.*}; echo RTC=$(date +%s)");
        const slept = next_event("acpi-sleep", 60000);
        const woke = next_event("acpi-wake", 120000);
        // (the kernel log is cleared each cycle: over many cycles its ring buffer wraps)
        const alarm = "dmesg -c >/dev/null; " + (by_rtc ? "echo 0 > /sys/class/rtc/rtc0/wakealarm; echo +3 > /sys/class/rtc/rtc0/wakealarm; " : "");
        serial = "";
        // (the marker is computed, so the echoed command line cannot match it)
        emulator.serial0_send(alarm + "echo mem > /sys/power/state; echo RESUMED_$((" + cycle + "*7))\n");
        assert.equal(await slept, "S3");
        assert.equal(emulator.v86.cpu.devices.acpi.sleeping, 3, "cores stopped in S3");
        if(!by_rtc)
        {
            await delay(1000);
            if(cycle === 2)
            {
                // a snapshot of the sleeping machine wakes after restore
                const state = await emulator.save_state();
                await emulator.restore_state(state);
                assert.equal(emulator.v86.cpu.devices.acpi.sleeping, 3, "restored asleep");
            }
            assert.equal(await emulator.power_button(), true);
        }
        assert.equal(await woke, by_rtc ? "rtc" : "power-button");
        await wait_serial(new RegExp("RESUMED_" + cycle * 7 + "\r?\n[\\s\\S]*~% $"), "resume " + cycle, 60000).catch(error => {
            const d = emulator.v86.cpu.get_diagnostics();
            console.log(JSON.stringify({ cpu: d.cpu, cores: d.cores, parallel: d.parallel, acpi: d.acpi }, null, 1));
            console.log("serial: " + JSON.stringify(serial.slice(-1500)));
            throw error;
        });
        const check = await command("md5sum -c /tmp/s3.md5 >/dev/null && echo RAM_INTACT=1; " +
            "echo WAKES=$(dmesg | grep -c -E '(ACPI: )?(PM: )?Waking up from system sleep state S3')");
        assert.equal(value_of(check, "RAM_INTACT"), 1, "tmpfs contents survive S3");
        assert.equal(value_of(check, "WAKES"), 1, "the kernel woke from S3");
        const after = await command("set -- $(cat /proc/uptime); echo UP=${1%.*}; echo RTC=$(date +%s)");
        assert.ok(value_of(after, "UP") >= value_of(before, "UP"), "uptime does not go backwards across S3");
        assert.ok(value_of(after, "RTC") >= value_of(before, "RTC"), "wall clock does not go backwards across S3");
        log(`S3 cycle ${cycle}: woken by ${by_rtc ? "the RTC alarm" : "the power button"}, RAM intact`);
    }
}

// S4: the guest hibernates to the swap disk and enters ACPI S4 (soft off).
// Power-on clears RAM and boots from the CD again; handing the image to the
// new kernel (/sys/power/resume, as an initramfs does) restores the old one.
if(can_hibernate && S4_CYCLES)
{
    const swap = await command("mkswap /dev/sda >/dev/null && swapon /dev/sda && echo SWAP=1");
    assert.equal(value_of(swap, "SWAP"), 1, "swap on the blank disk");
    for(let cycle = 1; cycle <= S4_CYCLES; cycle++)
    {
        const marker = 1000 + cycle;
        await command(`echo ${marker} > /tmp/s4-marker; echo platform > /sys/power/disk; echo 1 > /sys/power/pm_debug_messages; dmesg -c >/dev/null`);
        const off = next_event("acpi-power-off", 180000);
        const stopped = next_event("emulator-stopped", 180000);
        serial = "";
        emulator.serial0_send(`echo disk > /sys/power/state; echo THAWED_${cycle}=$(cat /tmp/s4-marker)\n`);
        assert.equal(await off, "S4");
        await stopped;
        log(`S4 cycle ${cycle}: hibernated, soft off (S4)`);
        // power-on clears RAM (a sentinel far above what firmware touches)
        const SENTINEL = 200 * 1024 * 1024;
        emulator.v86.cpu.mem8.set([0x5A, 0xA5, 0x5A, 0xA5], SENTINEL);
        serial = "";
        assert.equal(await emulator.power_button(), true);
        assert.deepEqual([...emulator.v86.cpu.mem8.subarray(SENTINEL, SENTINEL + 4)], [0, 0, 0, 0], "RAM cleared at power-on");
        // the new kernel finds the image through resume= and restores it
        const thawed = await wait_serial(new RegExp(`THAWED_${cycle}=\\d+\\r?\\n[\\s\\S]*~% $`), "restore " + cycle, 180000);
        assert.equal(value_of(thawed, `THAWED_${cycle}`), marker, "the shell continues in the restored kernel");
        const restored = await command("echo RESTORED=$(dmesg | grep -c 'Image restored successfully')");
        assert.equal(value_of(restored, "RESTORED"), 1, "the kernel restored the image from swap");
        log(`S4 cycle ${cycle}: powered on, image restored from disk, marker ${marker} back`);
    }
}

// Watch the PIIX reset control register: reboot=acpi writes the FADT reset value there
const reset_writes = [];
{
    const port = emulator.v86.cpu.io.ports[0xCF9];
    const write8 = port.write8;
    port.write8 = function(value) { reset_writes.push(value); return write8.call(this, value); };
}
serial = "";
emulator.serial0_send("reboot\n");
await boot();
assert.deepEqual(reset_writes, [0x06], "reset through the FADT reset register");
const after_reboot = await command("dmesg | grep -E 'ACPI: Interpreter enabled'; set -- $(cat /sys/firmware/acpi/interrupts/sci); echo SCI=$1");
assert.match(after_reboot, /ACPI: Interpreter enabled/);
assert.equal(value_of(after_reboot, "SCI"), 0, "counters start again after the reboot");
log("rebooted through the ACPI reset register, ACPI enabled again");

for(let cycle = 1; cycle <= POWER_CYCLES; cycle++)
{
    await power_off();
    log(`power cycle ${cycle}: S5, emulator stopped`);

    if(cycle === POWER_CYCLES) break;

    serial = "";
    assert.equal(await emulator.power_button(), true);
    assert.equal(emulator.is_running(), true);
    await boot();
    log(`power cycle ${cycle}: powered on and booted again`);
}

clearTimeout(overall_timeout);
console.log("ACPI guest test passed");
await emulator.destroy();
process.exit(0);
