#!/usr/bin/env node
// Unmodified Alpine x86_64 kernel: real Linux boot protocol, firmware and initrd.
// The private CPUID switch is used only for qualification; no public CPU option.
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawn, spawnSync} from "node:child_process";
import {createHash as create_hash} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = root + "build/x64-linux/";
const name = "alpine-virt-3.24.0-x86_64.iso";
const source = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/" + name;
const digest = "6cd1a38ae05cf96a5d0cbb2ddd6c630834babfeca1ecc5d1f05ec0b06b886102";
const hash = bytes => create_hash("sha256").update(bytes).digest("hex");
fs.mkdirSync(directory, {recursive: true});
if(!fs.existsSync(directory + name))
{
    const response = await fetch(source);
    assert.ok(response.ok, `Official image HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), digest, "official pinned Alpine ISO SHA-256");
    fs.writeFileSync(directory + name, bytes);
}
assert.equal(hash(fs.readFileSync(directory + name)), digest, "official pinned Alpine ISO SHA-256");
for(const file of ["boot/vmlinuz-virt", "boot/initramfs-virt"])
{
    const unpack = spawnSync("bsdtar", ["-xf", directory + name, "-C", directory, file], {encoding: "utf8"});
    assert.equal(unpack.status, 0, unpack.stderr);
}
const cmdline = process.env.X64_LINUX_CMDLINE || "console=ttyS0,115200 earlyprintk=serial,ttyS0,115200 loglevel=7 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage";
const manifest = {source, iso_sha256: digest, kernel_sha256: hash(fs.readFileSync(directory + "boot/vmlinuz-virt")),
    initrd_sha256: hash(fs.readFileSync(directory + "boot/initramfs-virt")), cmdline};
fs.writeFileSync(directory + "image.json", JSON.stringify(manifest, null, 2) + "\n");
if(+process.env.X64_LINUX_PREPARE_ONLY) process.exit(0);
if(+process.env.X64_LINUX_QEMU)
{
    const child = spawn("qemu-system-x86_64", ["-machine", "pc,accel=tcg", "-cpu", "qemu64,phys-bits=36,-pdpe1gb", "-m", "512M",
        "-display", "none", "-monitor", "none", "-serial", "stdio", "-no-reboot", "-no-shutdown",
        "-kernel", directory + "boot/vmlinuz-virt", "-initrd", directory + "boot/initramfs-virt", "-cdrom", directory + name, "-append", cmdline,
        ...(process.env.X64_QEMU_TRACE ? ["-d", "in_asm", "-D", directory + "qemu-instructions.log"] : [])],
    {stdio: ["pipe", "pipe", "pipe"]});
    let transcript = "", logged_in = false, command = false;
    let timer;
    try
    {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("QEMU Linux boot deadline")), Number(process.env.X64_LINUX_TIMEOUT || 60000));
            child.on("error", reject);
            child.on("exit", code => reject(new Error(`QEMU exited ${code}`)));
            const output = bytes => {
                transcript += bytes;
                if(+process.env.SHOW_LOGS) process.stdout.write(bytes);
                if(transcript.includes("localhost login:") && !logged_in) { child.stdin.write("root\n"); logged_in = true; }
                if(transcript.includes("localhost:~#") && !command) { child.stdin.write("uname -m; echo X64_LINUX_BOOT_OK\n"); command = true; }
                if(/\r?\nX64_LINUX_BOOT_OK\r?\n/.test(transcript)) resolve();
                if(transcript.includes("Kernel panic")) reject(new Error("QEMU kernel panic"));
            };
            child.stdout.on("data", output);
            child.stderr.on("data", output);
        });
        assert.match(transcript, /\r?\nx86_64\r?\n/);
        console.log("X64_LINUX_QEMU_PASS");
    }
    finally
    {
        clearTimeout(timer);
        child.kill();
        fs.writeFileSync(directory + "qemu.serial", transcript);
    }
    process.exit(0);
}
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const jit = !!+process.env.X64_JIT;
const emulator = new V86({
    wasm_path: process.env.WASM_PATH,
    bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
    bzimage: {url: directory + "boot/vmlinuz-virt"}, initrd: {url: directory + "boot/initramfs-virt"},
    cdrom: {url: directory + name}, cmdline, memory_size: 512 << 20,
    cpu_cores: Number(process.env.X64_CORES || 1), acpi: true, autostart: false,
    disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: true, log_level: 0,
});
let serial = "";
let cpu;
let snapshot;
let rounds = 0;
let booted = false;
let execution_error;
let command_sent = false;
const transcript = directory + `v86-${jit ? "native" : "interpreter"}.serial`;
emulator.add_listener("serial0-output-byte", byte => {
    const c = String.fromCharCode(byte);
    serial += c;
    if(+process.env.SHOW_LOGS) process.stdout.write(c);
});
function inspect()
{
    const view = new DataView(cpu.wasm_memory.buffer);
    const u64 = offset => view.getBigUint64(offset, true).toString(16);
    const wide_ip = BigInt(view.getUint32(1584, true)) << 32n | BigInt(cpu.instruction_pointer[0] >>> 0);
    // Read-only diagnostic walk for this 512 MiB fixture: never alters A/D,
    // devices, TLB contents or architectural state.
    const physical = address => {
        if(!(cpu.cr[0] & 0x80000000)) return Number(address);
        if(!(view.getBigUint64(1696, true) & 0x400n)) return null;
        const ram = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
        let table = BigInt(cpu.cr[3] >>> 0) | BigInt(view.getUint32(1612, true)) << 32n;
        for(const shift of [39n, 30n, 21n, 12n])
        {
            const at = Number(table & 0xFFFFFF000n) + Number(address >> shift & 511n) * 8;
            if(at + 8 > ram.byteLength) return null;
            const entry = ram.getBigUint64(at, true);
            if(!(entry & 1n)) return null;
            if(shift === 12n || shift < 39n && entry & 128n)
            {
                const mask = (1n << shift) - 1n;
                return Number(entry & 0xFFFFFF000n & ~mask | address & mask);
            }
            table = entry;
        }
        return null;
    };
    const at = physical(wide_ip);
    return {rounds, rip: (BigInt(view.getUint32(1584, true)) << 32n | BigInt(cpu.instruction_pointer[0] >>> 0)).toString(16),
        previous_rip: (BigInt(view.getUint32(1588, true)) << 32n | BigInt(cpu.previous_ip[0] >>> 0)).toString(16),
        physical_ip: at, instruction_bytes: at === null ? null : Buffer.from(cpu.mem8.subarray(at, at + 16)).toString("hex"),
        gpr: Array.from({length: 16}, (_, i) => ((BigInt(view.getUint32(1360 + i * 4, true)) << 32n) | BigInt(view.getUint32(i < 8 ? 64 + i * 4 : 1424 + (i - 8) * 4, true))).toString(16)),
        efer: u64(1696), cs_long: view.getUint8(1744), serial_bytes: serial.length,
        diagnostics: cpu.get_diagnostics()};
}
try
{
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    cpu = emulator.v86.cpu;
    assert.equal(typeof cpu.wm.exports.set_x64_test_capabilities, "function", "rebuild Wasm with private qualification switch");
    cpu.wm.exports.set_x64_test_capabilities(1);
    const run_cores = cpu.run_cores.bind(cpu);
    cpu.run_cores = () => {
        rounds++;
        try { return run_cores(); }
        catch(error) { execution_error = error; emulator.stop(); return 100; }
    };
    emulator.run();
    const deadline = performance.now() + Number(process.env.X64_LINUX_TIMEOUT || 300000);
    let next_report = performance.now() + 10000;
    while(performance.now() < deadline)
    {
        await delay(10);
        if(execution_error) throw execution_error;
        if(serial.includes("Kernel panic") || serial.includes("not implemented")) throw new Error("Guest kernel reported a failure");
        if(/localhost login:/.test(serial) && !command_sent)
        {
            emulator.serial0_send("root\n");
            command_sent = true;
        }
        if(/localhost:~#/.test(serial) && !booted)
        {
            emulator.serial0_send("uname -m; cat /sys/devices/system/cpu/online; echo X64_LINUX_BOOT_OK\n");
            booted = true;
        }
        if(booted && /\r?\nX64_LINUX_BOOT_OK\r?\n/.test(serial)) break;
        if(performance.now() >= next_report)
        {
            snapshot = inspect();
            console.log("X64_LINUX_PROGRESS " + JSON.stringify(snapshot));
            fs.writeFileSync(transcript, serial);
            next_report = performance.now() + 10000;
        }
    }
    snapshot = inspect();
    assert.ok(booted && /\r?\nX64_LINUX_BOOT_OK\r?\n/.test(serial), "real x64 Linux login shell and command deadline");
    assert.match(serial, /\r?\nx86_64\r?\n/, "uname confirms actual x86_64 userspace");
    fs.writeFileSync(directory + "result.json", JSON.stringify({...manifest, passed: true, snapshot}, null, 2) + "\n");
    console.log("X64_LINUX_PASS " + JSON.stringify(snapshot));
}
catch(error)
{
    if(cpu) snapshot = inspect();
    fs.writeFileSync(directory + "result.json", JSON.stringify({...manifest, passed: false, error: String(error), snapshot}, null, 2) + "\n");
    console.error("X64_LINUX_FAILURE " + JSON.stringify(snapshot));
    throw error;
}
finally
{
    fs.writeFileSync(transcript, serial);
    await emulator.destroy();
}
