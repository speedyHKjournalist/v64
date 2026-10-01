#!/usr/bin/env node
// Optional Windows XP qualification using a user-supplied disk. The source
// image is opened O_RDONLY; all installation/boot/probe writes remain in RAM.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { deflateSync as deflate_sync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryDisk, ReadOnlyOverlayDisk, make_fat16, read_fat16 } from "./disk_fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const filename = process.argv[2];
assert.ok(filename, "usage: windows_qualification.mjs original-xp-disk.img");
const image_path = path.resolve(filename), source_stat = fs.statSync(image_path);
const output_dir = path.resolve(process.env.XP_LOG_DIR || path.join(root, "build/c3-windows-xp"));
fs.mkdirSync(output_dir, { recursive: true });
const module_url = new URL(process.env.V86_MODULE || "../../build/libv86.mjs", import.meta.url);
const { V86 } = await import(module_url.href);
const hash = bytes => create_hash("sha256").update(bytes).digest("hex");
function command(name, args)
{
    const result = spawnSync(name, args, { maxBuffer: 128 << 20 });
    assert.equal(result.status, 0, `${name}: ${result.stderr?.toString() || result.error}`);
    return result.stdout;
}
const seven_zip = process.env.SEVEN_ZIP || "7zz";
const cab = command(seven_zip, ["x", "-so", image_path, "WINDOWS/Driver Cache/i386/sp3.cab"]);
const cab_path = path.join(output_dir, "sp3.cab");
fs.writeFileSync(cab_path, cab);
const hal = command(seven_zip, ["x", "-so", cab_path, "halmacpi.dll"]);
const kernel = command(seven_zip, ["x", "-so", cab_path, "ntkrnlmp.exe"]);
const original_hal = command(seven_zip, ["x", "-so", image_path, "WINDOWS/system32/hal.dll"]);
const original_kernel = command(seven_zip, ["x", "-so", image_path, "WINDOWS/system32/ntoskrnl.exe"]);
function version_strings(bytes)
{
    const latin = bytes.toString("latin1");
    return [...latin.matchAll(/(?:[ -~]\x00){6,}/g)].map(match => Buffer.from(match[0], "latin1").toString("utf16le"))
        .filter(value => /5\.1\.2600| HAL|ntkrnlmp|ntoskrnl|halmacpi|^hal\.dll$/i.test(value));
}
for(const bytes of [hal, kernel, original_hal, original_kernel]) assert.ok(version_strings(bytes).some(value => value.includes("5.1.2600.5512")), "matching XP SP3 binaries");
const probe_path = path.join(output_dir, "C3PROBE.EXE");
command(process.env.MINGW_CC || "i686-w64-mingw32-gcc", ["-Os", "-nostdlib", "-fno-builtin", "-fno-stack-protector", "-Wl,--entry,_entry@0", "-Wl,--subsystem,console", "-o", probe_path, path.join(root, "tests/smp/windows_probe.c"), "-lkernel32"]);
const boot = "[boot loader]\r\ntimeout=0\r\ndefault=multi(0)disk(0)rdisk(0)partition(1)\\WINDOWS\r\n[operating systems]\r\nmulti(0)disk(0)rdisk(0)partition(1)\\WINDOWS=\"XP ACPI SMP RAM overlay\" /HAL=HALSMP.DLL /KERNEL=NTSMP.EXE /noexecute=AlwaysOff /fastdetect /sos /bootlog\r\n";
const setup = `@echo off\r
copy /y "%~dp0HALMP.DLL" "%SystemRoot%\\System32\\HALSMP.DLL"\r
if errorlevel 1 goto fail\r
copy /y "%~dp0NTMP.EXE" "%SystemRoot%\\System32\\NTSMP.EXE"\r
if errorlevel 1 goto fail\r
attrib -s -h -r "%SystemDrive%\\boot.ini"\r
copy /y "%~dp0BOOT.INI" "%SystemDrive%\\boot.ini"\r
if errorlevel 1 goto fail\r
echo C3_SETUP_DONE>"%~dp0SETUP.TXT"\r
del /q "%~dp0RESULT.TXT"\r
shutdown -r -t 0\r
goto end\r
:fail\r
echo C3_SETUP_FAIL>"%~dp0SETUP.TXT"\r
:end\r
`;
const auxiliary = new MemoryDisk(make_fat16({ "C3PROBE.EXE": fs.readFileSync(probe_path), "HALMP.DLL": hal,
    "NTMP.EXE": kernel, "BOOT.INI": Buffer.from(boot), "SETUPMP.BAT": Buffer.from(setup) }));
fs.writeFileSync(path.join(output_dir, "tools.img"), auxiliary.bytes);
const source = new ReadOnlyOverlayDisk(image_path);
const cores = +(process.env.CPU_CORES || 4);
assert.ok(Number.isInteger(cores) && cores >= 2 && cores <= 8);
const wasm_bytes = fs.readFileSync(process.env.WASM_PATH || path.join(root, "build/v86.wasm"));
const wasm = await WebAssembly.compile(wasm_bytes);
const image_hash = create_hash("sha256");
for await (const chunk of fs.createReadStream(image_path)) image_hash.update(chunk);
const report = { image: { path: image_path, size: source_stat.size, original_mtime_ms: source_stat.mtimeMs, sha256: image_hash.digest("hex") },
    javascript: hash(fs.readFileSync(module_url)), wasm: hash(wasm_bytes), cores,
    binaries: Object.fromEntries(Object.entries({ original_hal, original_kernel, hal, kernel }).map(([name, bytes]) => [name, { sha256: hash(bytes), strings: version_strings(bytes) }])),
    initial: null, smp: null, qualification: "not yet run", modes: [], interventions: [] };
const vm = new V86({ graphics_adapter: "bochs_vga", wasm_fn: async imports => (await WebAssembly.instantiate(wasm, imports)).exports,
    bios: { url: path.join(root, "bios/seabios.bin") }, vga_bios: { url: path.join(root, "bios/vgabios.bin") },
    hda: source, hdb: auxiliary, memory_size: 512 << 20, vram_size: 16 << 20,
    acpi: true, cpu_cores: cores, experimental_smp_jit: true, ir_tier0: true,
    ir_sync_publication: true, net_device: { type: "ne2k" }, autostart: false, log_level: 0 });
let phase = "load", serial = "", last_mode_ms = 0, graphics_seen = false, cpu, heartbeat;
const started = performance.now();
vm.add_listener("screen-set-size", size => {
    report.modes.push({ ms: Math.round(performance.now() - started), size });
    if(size[0] >= 640 && size[1] >= 480 && size[2] >= 16) { graphics_seen = true; last_mode_ms = performance.now(); }
});
vm.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
const ascii_scans = Object.fromEntries(Object.entries({ "1234567890": [2,3,4,5,6,7,8,9,10,11],
    "qwertyuiop": [16,17,18,19,20,21,22,23,24,25], "asdfghjkl": [30,31,32,33,34,35,36,37,38],
    "zxcvbnm": [44,45,46,47,48,49,50] }).flatMap(([letters, values]) => [...letters].map((letter, i) => [letter, values[i]])));
Object.assign(ascii_scans, { " ": 57, ".": 52, "/": 53, "\\": 43, "-": 12, ";": 39 });
const shifted = { ":": 39, "%": 6, "(": 10, ")": 11, "@": 3 };
async function run_command(command_line)
{
    console.log("guest command: " + command_line);
    // Win+R, then scan codes. No browser keyboard adapter is needed.
    await vm.keyboard_send_scancodes([0xE0,0x5B,0x13,0x93,0xE0,0xDB], 30);
    await new Promise(resolve => setTimeout(resolve, 500));
    for(const ch of command_line.toLowerCase())
    {
        const shift = shifted[ch], code = shift || ascii_scans[ch]; assert.ok(code, `scan code ${ch}`);
        await vm.keyboard_send_scancodes(shift ? [42,code,code | 128,170] : [code,code | 128], +(process.env.XP_KEY_DELAY || 25));
    }
    await vm.keyboard_send_scancodes([28,156], 30);
}
const file_text = name => { const bytes = read_fat16(auxiliary.bytes, name); return bytes ? Buffer.from(bytes).toString("ascii") : ""; };
async function run_probe(label)
{
    phase = label;
    const deadline = performance.now() + +(process.env.XP_PHASE_MS || 240000);
    let next_command = 0, boot_menu_accepted = false;
    while(performance.now() < deadline)
    {
        const command_file = path.join(output_dir, "command.txt");
        if(fs.existsSync(command_file))
        {
            const input = fs.readFileSync(command_file, "utf8").trim(); fs.unlinkSync(command_file);
            await run_command(input); next_command = performance.now() + 60000;
        }
        if(!graphics_seen && !boot_menu_accepted)
        {
            const vga = cpu.devices.vga;
            const text = Array.from({length:80 * 25}, (_,i) => String.fromCharCode(vga.vga_memory[i * 2])).join("");
            if(text.includes("Seconds until Windows starts:") && text.includes("Start Windows Normally"))
            {
                report.interventions ||= [];
                report.interventions.push({phase,ms:Math.round(performance.now() - started),kind:"accept Start Windows Normally boot menu"});
                await vm.keyboard_send_scancodes([28,156],30);
                boot_menu_accepted = true;
            }
        }
        const text = file_text("RESULT.TXT");
        const match = text.match(/C3_XP_DONE processors=(\d+) progress=(\d+) failures=(\d+) checks=([\d,]+)\r?\n/);
        if(match)
        {
            const result = { processors: +match[1], progress: +match[2], failures: +match[3], checks: match[4].split(",").map(Number), text };
            assert.equal(result.failures, 0); assert.equal(result.progress, result.processors * 128);
            assert.deepEqual(result.checks, Array(result.processors).fill(128));
            console.log(label + " " + JSON.stringify(result));
            return result;
        }
        if(graphics_seen && performance.now() - last_mode_ms > 10000 && performance.now() > next_command)
        {
            await run_command("cmd /c for %d in (d e f g h) do @if exist %d:\\c3probe.exe %d:\\c3probe.exe");
            next_command = performance.now() + 30000;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${label}: Windows probe did not complete`);
}
function screenshot()
{
    const vga = cpu.devices.vga, width = vga.svga_width, height = vga.svga_height;
    if(!vga.svga_enabled || vga.svga_bpp !== 32 || !width || !height) return;
    const raw = Buffer.alloc((width * 3 + 1) * height), memory = vga.svga_memory;
    for(let y = 0; y < height; y++) for(let x = 0; x < width; x++)
    {
        const from = (vga.svga_offset + y * width + x) * 4, to = y * (width * 3 + 1) + 1 + x * 3;
        raw[to] = memory[from + 2]; raw[to + 1] = memory[from + 1]; raw[to + 2] = memory[from];
    }
    const crc = bytes => { let c = 0xFFFFFFFF; for(const byte of bytes) { c ^= byte; for(let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (name, bytes) => { const n = Buffer.from(name), data = Buffer.concat([n, bytes]), out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); data.copy(out, 4); out.writeUInt32BE(crc(data), out.length - 4); return out; };
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8] = 8; header[9] = 2;
    fs.writeFileSync(path.join(output_dir, "screen.png"), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflate_sync(raw)),chunk("IEND",Buffer.alloc(0))]));
}
try
{
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    cpu = vm.v86.cpu;
    heartbeat = setInterval(() => {
        screenshot();
        console.log(JSON.stringify({ phase, ms: Math.round(performance.now() - started), graphics_seen,
            display: [cpu.devices.vga.svga_width, cpu.devices.vga.svga_height, cpu.devices.vga.svga_bpp],
            core_steps: cpu.cores.map(core => core.steps), overlay_sectors: source.overlay.size,
            result: file_text("RESULT.TXT").slice(0, 160) }));
    }, 30000);
    if(process.env.XP_RESTORE) await vm.restore_state(fs.readFileSync(process.env.XP_RESTORE));
    vm.run();
    if(!process.env.XP_RESUME_MP)
    {
        report.initial = await run_probe("original installed HAL");
        assert.equal(report.initial.processors, 1, "the supplied Standard PC installation is UP");
        phase = "install matching ACPI MP boot in RAM overlay";
        await run_command("cmd /c for %d in (d e f g h) do @if exist %d:\\setupmp.bat %d:\\setupmp.bat");
        const setup_deadline = performance.now() + 30000;
        while(!file_text("SETUP.TXT").includes("C3_SETUP_DONE"))
        {
            assert.ok(performance.now() < setup_deadline && !file_text("SETUP.TXT").includes("C3_SETUP_FAIL"), "guest installs matching MP files into RAM overlay");
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        while(file_text("RESULT.TXT"))
        {
            assert.ok(performance.now() < setup_deadline, "setup removes the previous probe result before reboot");
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        graphics_seen = false;
    }
    report.smp = await run_probe("ACPI MP HAL from matching SP3 cabinet");
    assert.equal(report.smp.processors, cores, "Windows actually schedules every configured core");
    report.qualification = "passed: real Win32 threads migrate and complete work on every configured APIC ID";
}
catch(error)
{
    report.qualification = "blocked or failed: " + error.message;
    console.error(report.qualification);
    process.exitCode = 1;
}
finally
{
    clearInterval(heartbeat);
    await vm.stop();
    if(process.exitCode) fs.writeFileSync(path.join(output_dir, "failure-state.bin"), new Uint8Array(await vm.save_state()));
    if(cpu) { report.diagnostics = cpu.get_diagnostics(); screenshot(); }
    if(process.env.XP_CONVERTED_DISK)
    {
        const converted = path.resolve(process.env.XP_CONVERTED_DISK);
        assert.notEqual(converted, image_path);
        fs.copyFileSync(image_path, converted, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        const output = fs.openSync(converted, "r+");
        try { for(const [sector, bytes] of source.overlay) fs.writeSync(output, bytes, 0, bytes.length, sector * 512); }
        finally { fs.closeSync(output); }
        report.converted_disk = converted;
    }
    report.phase = phase; report.wall_ms = Math.round(performance.now() - started); report.overlay_sectors = source.overlay.size;
    const final_stat = fs.statSync(image_path);
    assert.equal(final_stat.size, source_stat.size); assert.equal(final_stat.mtimeMs, source_stat.mtimeMs, "original image never written");
    report.image.original_unchanged = true;
    fs.writeFileSync(path.join(output_dir, "qualification.json"), JSON.stringify(report, null, 2) + "\n");
    fs.writeFileSync(path.join(output_dir, "serial.log"), serial);
    fs.writeFileSync(path.join(output_dir, "tools-final.img"), auxiliary.bytes);
    await vm.destroy(); source.close();
}
