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
    if(fs.existsSync(directory + file)) continue;
    const unpack = spawnSync("bsdtar", ["-xf", directory + name, "-C", directory, file], {encoding: "utf8"});
    assert.equal(unpack.status, 0, unpack.stderr);
}
// 64-bit and compatibility-mode probes from one freestanding source. They are
// delivered as a ustar image on the IDE disk and unpacked by the guest shell.
// Concurrent configurations get separate probe builds and result files.
const cores = Number(process.env.X64_CORES || 1);
const tag = `${+process.env.X64_LINUX_QEMU ? "qemu" : +process.env.X64_JIT ? "native" : "interpreter"}-${cores}c${process.env.X64_HIGH_MEMORY ? "-high" : ""}`;
const probe_directory = directory + `probe-${tag}/`;
fs.mkdirSync(probe_directory, {recursive: true});
function run(program, args)
{
    const result = spawnSync(program, args, {encoding: "utf8"});
    assert.equal(result.status, 0, `${program}: ${result.stderr || result.error}`);
    return result.stdout.trim();
}
const host = run("rustc", ["-vV"]).match(/host: (.+)/)[1];
const lld = process.env.LD_LLD || `${run("rustc", ["--print", "sysroot"])}/lib/rustlib/${host}/bin/rust-lld`;
const probe_source = root + "tests/x64/linux_probe.c";
for(const [bits, target, flags, emulation] of [
    [64, "x86_64-unknown-linux-gnu", ["-mno-red-zone"], "elf_x86_64"],
    [32, "i386-unknown-linux-gnu", ["-m32", "-mno-sse", "-mno-mmx"], "elf_i386"],
])
{
    run(process.env.CLANG || "clang", [`--target=${target}`, ...flags, "-O2", "-ffreestanding", "-fno-stack-protector",
        "-fno-pic", "-fno-builtin", "-c", probe_source, "-o", probe_directory + `probe${bits}.o`]);
    run(lld, ["-flavor", "gnu", "-m", emulation, "-static", "-e", "_start", "-o", probe_directory + `linux_probe${bits}`, probe_directory + `probe${bits}.o`]);
}
run("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0",
    "-cf", probe_directory + "probe.tar", "-C", probe_directory, "linux_probe64", "linux_probe32"]);
const probe_disk = fs.readFileSync(probe_directory + "probe.tar");
const guest_command = "tar -xf /dev/sda -C /tmp && /tmp/linux_probe64 && /tmp/linux_probe32; uname -m; cat /sys/devices/system/cpu/online; grep 'System RAM' /proc/iomem; echo X64_LINUX_BOOT_OK\n";
// X5: relocate this many bytes of RAM to guest physical 4 GiB (v86) or give
// QEMU the same split, so the kernel and probes must use RAM above 4 GiB.
const high_memory = Number(process.env.X64_HIGH_MEMORY || 0);
const cmdline = process.env.X64_LINUX_CMDLINE || "console=ttyS0,115200 earlyprintk=serial,ttyS0,115200 loglevel=7 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage";
const manifest = {source, iso_sha256: digest, kernel_sha256: hash(fs.readFileSync(directory + "boot/vmlinuz-virt")),
    initrd_sha256: hash(fs.readFileSync(directory + "boot/initramfs-virt")), cmdline,
    probe_tar_sha256: hash(probe_disk), probe64_sha256: hash(fs.readFileSync(probe_directory + "linux_probe64")),
    probe32_sha256: hash(fs.readFileSync(probe_directory + "linux_probe32"))};
fs.writeFileSync(directory + `image-${tag}.json`, JSON.stringify(manifest, null, 2) + "\n");
if(+process.env.X64_LINUX_PREPARE_ONLY) process.exit(0);
function check_probes(text)
{
    for(const bits of [64, 32])
    {
        const line = text.match(new RegExp(`X64_PROBE_OK arch=${bits} cpus=(\\d+) threads=\\d+ counter=(\\d+) cpu_checks=([\\d,]+)`));
        assert.ok(line, `${bits}-bit probe result: ${text.match(new RegExp(`X64_PROBE_FAIL arch=${bits}[^\\r\\n]*`))?.[0] || "missing"}`);
        assert.equal(+line[1], cores, `${bits}-bit probe sees every online CPU`);
        assert.equal(+line[2], cores * 20000, `${bits}-bit LOCKed counter`);
        assert.deepEqual(line[3].split(",").map(Number), Array.from({length: cores}, (_, i) => i), `${bits}-bit threads ran on each CPU`);
        assert.match(text, new RegExp(`X64_PROBE_OK arch=${bits} [^\\r\\n]* tlb_stale=0 entry=${bits === 32 ? "vdso" : "syscall"}`), `${bits}-bit remote TLB shootdown and system call entry`);
        const matrix = text.match(new RegExp(`X64_PROBE_XC arch=${bits} packages=1 cores=(\\d+) threads_per_core=1 migrations=(\\d+) signals=(\\d+) smc_rounds=64 direct_io=1`));
        assert.ok(matrix, `${bits}-bit multicore matrix: ${text.match(new RegExp(`X64_PROBE_FAIL arch=${bits}[^\\r\\n]*`))?.[0] || "missing"}`);
        assert.deepEqual(matrix.slice(1).map(Number), [cores, cores * 24, cores * 16], `${bits}-bit topology, migrations and signals`);
        const placed = +text.match(new RegExp(`X64_PROBE_OK arch=${bits} [^\\r\\n]* high_pages=(\\d+)`))[1];
        if(high_memory) assert.ok(placed > 0, `${bits}-bit process received frames above 4 GiB`);
        else assert.equal(placed, 0, `${bits}-bit process: no RAM above 4 GiB exists`);
    }
}
if(+process.env.X64_LINUX_QEMU)
{
    const child = spawn("qemu-system-x86_64", ["-machine", `pc,accel=tcg${high_memory ? `,max-ram-below-4g=${(512 << 20) - high_memory}` : ""}`, "-cpu", "qemu64,phys-bits=36,-pdpe1gb", "-m", "512M",
        "-display", "none", "-monitor", "none", "-serial", "stdio", "-no-reboot", "-no-shutdown",
        "-kernel", directory + "boot/vmlinuz-virt", "-initrd", directory + "boot/initramfs-virt", "-cdrom", directory + name, "-append", cmdline,
        "-drive", `file=${probe_directory}probe.tar,format=raw,if=ide,index=0,snapshot=on`,
        "-smp", `${Number(process.env.X64_CORES || 1)},sockets=1,cores=${Number(process.env.X64_CORES || 1)},threads=1`,
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
                if(transcript.includes("localhost:~#") && !command) { child.stdin.write(guest_command); command = true; }
                if(/\r?\nX64_LINUX_BOOT_OK\r?\n/.test(transcript)) resolve();
                if(transcript.includes("Kernel panic")) reject(new Error("QEMU kernel panic"));
            };
            child.stdout.on("data", output);
            child.stderr.on("data", output);
        });
        assert.match(transcript, /\r?\nx86_64\r?\n/);
        check_probes(transcript);
        if(high_memory) assert.match(transcript, /\n\s*100000000-[0-9a-f]+ : System RAM/, "kernel owns RAM above 4 GiB");
        console.log("X64_LINUX_QEMU_PASS");
    }
    finally
    {
        clearTimeout(timer);
        child.kill();
        fs.writeFileSync(directory + `${tag}.serial`, transcript);
    }
    process.exit(0);
}
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const jit = !!+process.env.X64_JIT;
const emulator = new V86({
    wasm_path: process.env.WASM_PATH,
    bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
    bzimage: {url: directory + "boot/vmlinuz-virt"}, initrd: {url: directory + "boot/initramfs-virt"},
    cdrom: {url: directory + name}, hda: {buffer: probe_disk.buffer.slice(probe_disk.byteOffset, probe_disk.byteOffset + probe_disk.length)},
    cmdline, memory_size: 512 << 20, high_memory_size: high_memory, cpu_cores: cores, acpi: true, autostart: false,
    disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: true, log_level: 0,
    ...(process.env.X64_IR_TIER0 === "0" ? {ir_tier0: false} : {}),
});
let serial = "";
let cpu;
let snapshot;
let rounds = 0;
let booted = false;
let execution_error;
let command_sent = false;
const snapshot_markers = ["X64_PROBE_START arch=64", "X64_PROBE_OK arch=64", "X64_PROBE_START arch=32"];
const snapshots_taken = [], snapshot_bytes = [];
const transcript = directory + `v86-${tag}.serial`;
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
        page_tier: cpu.wm.exports.x64_page_stat ? Object.fromEntries(["compiled", "native", "retries", "unknown", "steps", "invalidated", "entries", "failed", "recompiled", "instructions", "templated", "evicted", "live"].map((name, i) => [name, cpu.wm.exports.x64_page_stat(i)])) : null,
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
    // X64_ARCH_CAPABILITIES=0: no IA32_ARCH_CAPABILITIES, so the guest also
    // runs its speculation mitigations (PTI, VERW, ITS thunks).
    if(process.env.X64_ARCH_CAPABILITIES === "0") cpu.wm.exports.set_x64_arch_capabilities(0);
    if(process.env.X64_STEP_PROFILE) cpu.wm.exports.x64_page_profile(1);
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
            emulator.serial0_send(guest_command);
            booted = true;
        }
        // X64_LINUX_SNAPSHOT=1: save and restore the whole machine while the
        // probes run (threads on every CPU, pending IPIs, page functions).
        for(const marker of snapshot_markers)
        {
            if(+process.env.X64_LINUX_SNAPSHOT && booted && !snapshots_taken.includes(marker) && serial.includes(marker))
            {
                snapshots_taken.push(marker);
                emulator.stop();
                const state = await emulator.save_state();
                await emulator.restore_state(state);
                snapshot_bytes.push(state.byteLength);
                emulator.run();
            }
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
    check_probes(serial);
    if(high_memory) assert.match(serial, new RegExp(`\\n\\s*100000000-${(0x100000000 + high_memory - 1).toString(16)} : System RAM`), "kernel owns the relocated RAM above 4 GiB");
    if(+process.env.X64_LINUX_SNAPSHOT)
    {
        assert.deepEqual(snapshots_taken, snapshot_markers, "snapshots taken during every probe phase");
        console.log("X64_LINUX_SNAPSHOT_PASS " + JSON.stringify(snapshot_bytes));
    }
    if(+process.env.X64_LINUX_LIFECYCLE)
    {
        // Guest reboot (reset through the FADT/keyboard controller path the
        // kernel picks), a second boot to a shell, then poweroff into S5.
        const wait_for = async (pattern, from, what) => {
            const limit = performance.now() + Number(process.env.X64_LINUX_TIMEOUT || 300000);
            while(!pattern.test(serial.slice(from)))
            {
                if(execution_error) throw execution_error;
                if(performance.now() > limit) throw new Error("lifecycle: " + what);
                await delay(10);
            }
        };
        let mark = serial.length;
        emulator.serial0_send("reboot\n");
        await wait_for(/Linux version[\s\S]*localhost login:/, mark, "second boot to login");
        mark = serial.length;
        emulator.serial0_send("root\n");
        await wait_for(/localhost:~#/, mark, "second shell");
        mark = serial.length;
        emulator.serial0_send("uname -m; cat /sys/devices/system/cpu/online; echo X64_REBOOT_OK\n");
        await wait_for(/\r?\nX64_REBOOT_OK\r?\n/, mark, "command after reboot");
        assert.match(serial.slice(mark), /\r?\nx86_64\r?\n/, "x86_64 after reboot");
        assert.match(serial.slice(mark), new RegExp(`\\r?\\n${cores === 1 ? "0" : "0-" + (cores - 1)}\\r?\\n`), "every CPU online after reboot");
        const off = new Promise(resolve => emulator.add_listener("acpi-power-off", resolve));
        emulator.serial0_send("poweroff\n");
        const state = await Promise.race([off, delay(120000).then(() => null)]);
        if(state !== "S5")
        {
            const diagnostics = cpu.get_diagnostics();
            fs.writeFileSync(directory + `poweroff-${tag}.json`, JSON.stringify(diagnostics, null, 1));
            throw new Error("no ACPI S5 after poweroff: " + JSON.stringify(diagnostics.cores.map(core => [core.state, core.linear_ip, core.halted, core.interrupts_enabled])));
        }
        await delay(100);
        assert.ok(!emulator.is_running(), "the machine stopped in S5");
        console.log("X64_LINUX_LIFECYCLE_PASS");
    }
    fs.writeFileSync(directory + `result-${tag}.json`, JSON.stringify({...manifest, passed: true, snapshot}, null, 2) + "\n");
    console.log("X64_LINUX_PASS " + JSON.stringify(snapshot));
    if(process.env.X64_STEP_PROFILE)
    {
        const get = cpu.wm.exports.x64_page_profile_get;
        const name = key => (key & 0x10000 ? "rep " : "") + ["", "0F ", "0F38 ", "0F3A "][(key >> 8) & 3] + (key & 0xFF).toString(16).padStart(2, "0");
        for(const [label, base] of [["X64_STEP_PROFILE", 0], ["X64_RETRY_PROFILE", 0x20000]])
        {
            const rows = [];
            for(let key = 0; key < 0x20000; key++) { const n = get(base + key); if(n) rows.push([n, key]); }
            rows.sort((a, b) => b[0] - a[0]);
            console.log(label + " " + rows.slice(0, 60).map(([n, key]) => `${name(key)}:${n}`).join(" "));
        }
        console.log("X64_REFUSED crossing=" + get(0x40000) + " fault=" + get(0x40001) + " device=" + get(0x40002) + " code=" + get(0x40003));
    }
}
catch(error)
{
    if(cpu) snapshot = inspect();
    fs.writeFileSync(directory + `result-${tag}.json`, JSON.stringify({...manifest, passed: false, error: String(error), snapshot}, null, 2) + "\n");
    console.error("X64_LINUX_FAILURE " + JSON.stringify(snapshot));
    throw error;
}
finally
{
    fs.writeFileSync(transcript, serial);
    await emulator.destroy();
}
