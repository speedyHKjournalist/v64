#!/usr/bin/env node
// Windows x64 qualification on a user-supplied disk (X3/XC, C2 topology).
// The image is opened read-only; every guest write stays in a RAM overlay.
// A FAT16 tools disk carries PROBE64.EXE (native) and PROBE32.EXE (WOW64,
// compatibility mode); after sign-in they run through Win+R and write their
// results next to themselves.
//
// Env: WIN_IMAGE, WIN_CORES (1), WIN_MEMORY_MB (2048), X64_JIT (1),
// X64_IR_TIER0, WIN_PARALLEL, WIN_USER_PASSWORD (the image's test account password),
// WIN_TIMEOUT_MS, WIN_OUT (output directory). While it runs, a line written to
// <out>/command.txt is executed: "key <scancodes hex>", "type <text>",
// "run <command line>", "enter", "space", "password", "shot", "rips",
// "trace on|off" (WIN_USER_TRACE=1 enables it from the start).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash as create_hash} from "node:crypto";
import {deflateSync as deflate_sync} from "node:zlib";
import {spawnSync} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {MemoryDisk, ReadOnlyOverlayDisk, make_fat16, read_fat16} from "../smp/disk_fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const image_path = path.resolve(process.env.WIN_IMAGE || path.join(root, "../retro-gaming-site/windows8/windows8.img"));
const out = path.resolve(process.env.WIN_OUT || path.join(root, "build/x64-windows"));
fs.mkdirSync(out, {recursive: true});
const cores = +(process.env.WIN_CORES || 1), jit = process.env.X64_JIT !== "0";
const password = process.env.WIN_USER_PASSWORD || "admin1";
// (not `<< 20`: 2048 << 20 overflows int32; v86 caps RAM just below 2 GiB)
const memory_mb = +(process.env.WIN_MEMORY_MB || 2048);
const source_stat = fs.statSync(image_path);

function build(compiler, entry, output)
{
    const result = spawnSync(compiler, ["-Os", "-nostdlib", "-fno-builtin", "-fno-stack-protector", "-mno-stack-arg-probe",
        `-Wl,--entry,${entry}`, "-Wl,--subsystem,console", "-o", output, path.join(root, "tests/x64/windows_probe.c"), "-lkernel32"], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(output);
}
const probe64 = build("x86_64-w64-mingw32-gcc", "entry", path.join(out, "PROBE64.EXE"));
const probe32 = build("i686-w64-mingw32-gcc", "_entry@0", path.join(out, "PROBE32.EXE"));
const tools = new MemoryDisk(make_fat16({"PROBE64.EXE": probe64, "PROBE32.EXE": probe32}));
const source = new ReadOnlyOverlayDisk(image_path);

const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const vm = new V86({
    wasm_path: process.env.WASM_PATH,
    bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
    hda: source, hdb: tools, memory_size: memory_mb * 1048576, vga_memory_size: 16 << 20,
    acpi: true, cpu_cores: cores, net_device: {type: "ne2k"}, autostart: false, log_level: 0,
    disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: true,
    ...(process.env.X64_IR_TIER0 === "0" ? {ir_tier0: false} : {}),
    // WIN_PARALLEL=1: the application processors run in vCPU workers (W1)
    ...(+process.env.WIN_PARALLEL ? {parallel: true, wasm_path: root + "build/v86-parallel.wasm"} : {}),
});

const started = performance.now();
const elapsed = () => Math.round((performance.now() - started) / 1000);
const report = {image: {path: image_path, size: source_stat.size, mtime_ms: source_stat.mtimeMs}, cores, jit,
    parallel: !!+process.env.WIN_PARALLEL, memory_mb, modes: [], events: [], results: {}};
const event = (kind, detail = {}) => { const e = {s: elapsed(), kind, ...detail}; report.events.push(e); console.log("X64_WIN_EVENT " + JSON.stringify(e)); };
let cpu, graphics_since = 0, last_mode = null, execution_error;
vm.add_listener("screen-set-size", size => {
    report.modes.push({s: elapsed(), size});
    last_mode = size; graphics_since = performance.now();
    event("mode", {size});
});

// Set 1 scan codes
const scans = {};
for(const [letters, codes] of [["1234567890", [2,3,4,5,6,7,8,9,10,11]], ["qwertyuiop", [16,17,18,19,20,21,22,23,24,25]],
    ["asdfghjkl", [30,31,32,33,34,35,36,37,38]], ["zxcvbnm", [44,45,46,47,48,49,50]]])
    [...letters].forEach((letter, i) => { scans[letter] = codes[i]; });
Object.assign(scans, {" ": 57, ".": 52, "/": 53, "\\": 43, "-": 12, ";": 39, "=": 13, ",": 51, "'": 40});
const shifted = {":": 39, "%": 6, "(": 10, ")": 11, "@": 3, "&": 8, "\"": 40, ">": 52, "<": 51, "_": 12, "|": 43};
async function type(text)
{
    for(const ch of text)
    {
        const upper = ch >= "A" && ch <= "Z";
        const code = shifted[ch] || scans[ch.toLowerCase()];
        assert.ok(code, `scan code for ${JSON.stringify(ch)}`);
        const shift = upper || shifted[ch];
        await vm.keyboard_send_scancodes(shift ? [42, code, code | 128, 170] : [code, code | 128], 30);
        await delay(40);
    }
}
const press = async codes => { await vm.keyboard_send_scancodes(codes, 30); await delay(100); };
const enter = () => press([28, 156]);
// The sign-in screen of this image at 1024x768: the password box is a white
// field right of the user tile. Keys pressed before it appears are lost
// (the lock screen fades out slowly on an emulated core).
function pixel(x, y)
{
    const vga = cpu.devices.vga, bytes_per = vga.svga_bpp / 8;
    const at = (vga.svga_offset + y * vga.svga_width + x) * bytes_per, m = vga.svga_memory;
    return bytes_per === 2 ? [(m[at + 1] >> 3) << 3, (m[at] >> 5 | (m[at + 1] & 7) << 3) << 2, (m[at] & 31) << 3] : [m[at + 2], m[at + 1], m[at]];
}
function password_box_visible()
{
    const vga = cpu.devices.vga;
    if(!vga.svga_enabled || vga.svga_width !== 1024 || vga.svga_height !== 768 || ![32, 24, 16].includes(vga.svga_bpp)) return false;
    const background = pixel(100, 100), tile = pixel(260, 190);
    return [[620, 248], [680, 248], [720, 256], [735, 240]].every(([x, y]) => pixel(x, y).every(c => c > 230)) &&
        // a plain background, not white, around the gray user tile
        !background.every(c => c > 230) && [[900, 100], [100, 600], [900, 600]].every(([x, y]) => pixel(x, y).every((c, i) => c === background[i])) &&
        tile.every(c => c >= 40 && c <= 110 && Math.abs(c - tile[0]) < 8);
}
// The desktop: the white Start logo at the left end of the taskbar (four
// panes split by a vertical gap)
function desktop_visible()
{
    const vga = cpu.devices.vga;
    if(!vga.svga_enabled || vga.svga_width !== 1024 || vga.svga_height !== 768 || ![32, 24, 16].includes(vga.svga_bpp)) return false;
    const white = (x, y) => pixel(x, y).every(c => c > 220);
    return [[16, 744], [30, 744], [16, 752], [30, 752]].every(([x, y]) => white(x, y)) && !white(23, 746) && !white(10, 745) && !white(40, 745);
}
let last_sign_in = -Infinity;
// A key wakes the display or dismisses the lock screen; repeat until the
// password box shows, clear anything typed into it, then sign in.
async function sign_in()
{
    event("sign-in");
    last_sign_in = performance.now();
    for(let i = 0; i < 12 && !password_box_visible() && !desktop_visible(); i++)
    {
        await press([57, 185]);
        await delay(10000);
    }
    // never type the password blind (it could reach the desktop); the caller
    // retries while the session is not up
    if(!password_box_visible()) { event("sign-in-no-password-box"); return; }
    for(let i = 0; i < 4; i++) await press([14, 142]);
    await type(password);
    await enter();
}
// The Run dialog of this image at 1024x768 (bottom left), open with the
// input focused: white body, the grey button strip and the edit box's blue
// focus border
function run_dialog_ready()
{
    const vga = cpu.devices.vga;
    if(!vga.svga_enabled || vga.svga_width !== 1024 || vga.svga_height !== 768 || ![32, 24, 16].includes(vga.svga_bpp)) return false;
    const white = (x, y) => pixel(x, y).every(c => c > 245);
    const [r, , b] = pixel(398, 622);
    return white(300, 555) && white(300, 600) && white(100, 650) && pixel(60, 700).every(c => Math.abs(c - 240) <= 6) && b > 200 && r < 120;
}
// Keys typed before the dialog has focus are lost (it takes seconds to tens
// of seconds to appear on a loaded host); returns whether the line was typed
async function run_command(line)
{
    event("run", {line});
    await press([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB]); // Win+R
    for(const limit = performance.now() + 60000; performance.now() < limit && !run_dialog_ready();) await delay(1000);
    if(!run_dialog_ready()) { event("run-dialog-missing"); return false; }
    await delay(1000);
    // the previous command is preselected; typing replaces it
    await type(line);
    await enter();
    return true;
}

function text_screen()
{
    const vga = cpu.devices.vga;
    if(vga.graphical_mode) return "";
    return Array.from({length: 25}, (_, row) => Array.from({length: 80}, (_, col) => {
        const c = vga.vga_memory[(row * 80 + col) * 2];
        return c >= 32 && c < 127 ? String.fromCharCode(c) : " ";
    }).join("").trimEnd()).join("\n").trim();
}
let last_hash = "", shots = 0, last_saved = 0, last_change = 0, dark_fraction = 1, colors = 0;
function screenshot(force)
{
    const vga = cpu.devices.vga, width = vga.svga_width, height = vga.svga_height;
    if(!vga.svga_enabled || !width || !height || ![32, 24, 16].includes(vga.svga_bpp)) return null;
    const bytes_per = vga.svga_bpp / 8, stride = width * 3 + 1, raw = Buffer.alloc(stride * height), memory = vga.svga_memory;
    for(let y = 0; y < height; y++) for(let x = 0; x < width; x++)
    {
        const from = (vga.svga_offset + y * width + x) * bytes_per, to = y * stride + 1 + x * 3;
        if(bytes_per === 2)
        {
            const v = memory[from] | memory[from + 1] << 8;
            raw[to] = (v >> 11 & 31) << 3; raw[to + 1] = (v >> 5 & 63) << 2; raw[to + 2] = (v & 31) << 3;
        }
        else { raw[to] = memory[from + 2]; raw[to + 1] = memory[from + 1]; raw[to + 2] = memory[from]; }
    }
    const hash = create_hash("sha1").update(raw).digest("hex").slice(0, 12);
    if(hash === last_hash && !force) return hash;
    last_hash = hash;
    last_change = performance.now();
    let dark = 0, samples = 0;
    const palette = new Set();
    for(let at = 1; at < raw.length; at += 3 * 97)
    {
        samples++;
        if(raw[at] + raw[at + 1] + raw[at + 2] < 48) dark++;
        palette.add(raw[at] >> 5 | raw[at + 1] >> 5 << 3 | raw[at + 2] >> 5 << 6);
    }
    dark_fraction = dark / samples;
    colors = palette.size;
    const crc = data => { let c = 0xFFFFFFFF; for(const byte of data) { c ^= byte; for(let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (name, data) => { const tag = Buffer.from(name), body = Buffer.concat([tag, data]), b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); body.copy(b, 4); b.writeUInt32BE(crc(body), b.length - 4); return b; };
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflate_sync(raw)), chunk("IEND", Buffer.alloc(0))]);
    fs.writeFileSync(path.join(out, "screen.png"), png);
    // numbered history: at most one per 20 s (a console cursor blinks)
    if(force || performance.now() - last_saved > 20000)
    {
        last_saved = performance.now();
        fs.writeFileSync(path.join(out, `screen-${String(++shots).padStart(3, "0")}-${elapsed()}s.png`), png);
    }
    return hash;
}
function stats()
{
    const ex = cpu.wm.exports;
    const tier = ex.x64_page_stat ? Object.fromEntries(["compiled", "native", "retries", "unknown", "steps", "invalidated"].map((name, i) => [name, ex.x64_page_stat(i)])) : null;
    const d = cpu.get_diagnostics();
    return {page_tier: tier, cores: d.cores.map(core => ({state: core.state, ip: core.linear_ip, cs: core.cs, retired: core.retired_instructions, halted: core.halted})),
        mode: d.cpu.mode, overlay_sectors: source.overlay.size, execution: d.execution,
        workers: d.parallel ? d.parallel.cores.map(core => ({steps: core.steps})) : undefined};
}
// Read-only 4-level walk (no A/D updates), for diagnostics only.
function physical(cr3, address)
{
    const ram = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
    let table = cr3;
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
}
// RIP sampling between slices: which kernel code is hot (offline
// symbolization against ntoskrnl.exe; the base is found from LSTAR, which
// points into ntoskrnl)
const rip_samples = new Map();
let kernel_base = null;
function sample_rip()
{
    const view = new DataView(cpu.wasm_memory.buffer);
    const rip = BigInt(view.getUint32(1584, true)) << 32n | BigInt(cpu.instruction_pointer[0] >>> 0);
    if(kernel_base === null && view.getBigUint64(1720, true) !== 0n)
    {
        const lstar = view.getBigUint64(1720, true);
        const cr3 = BigInt(cpu.cr[3] >>> 0) | BigInt(view.getUint32(1612, true)) << 32n;
        for(let page = lstar & ~0xFFFn, n = 0; n < 8192; n++, page -= 0x1000n)
        {
            const at = physical(cr3, page);
            if(at !== null && cpu.mem8[at] === 0x4D && cpu.mem8[at + 1] === 0x5A) { kernel_base = page; event("kernel-base", {base: "0x" + page.toString(16)}); break; }
        }
    }
    const compat = view.getUint8(1744) === 0 && (view.getBigUint64(1696, true) & 0x400n) !== 0n;
    const key = compat ? "compat:0x" + rip.toString(16) :
        kernel_base !== null && rip >= kernel_base && rip < kernel_base + 0x1000000n ? "nt+0x" + (rip - kernel_base).toString(16) : "0x" + rip.toString(16);
    rip_samples.set(key, (rip_samples.get(key) || 0) + 1);
}
// WIN_USER_TRACE=1: exceptions taken from user mode (compatibility mode: all;
// 64-bit: all but #PF), with the code at the faulting RIP, read while the
// process is (most likely) still current
let trace_seen = 0;
function poll_user_trace()
{
    const ex = cpu.wm.exports, count = ex.x64_user_trace_count();
    if(count === trace_seen) return;
    const first = Math.max(0, count - 1024);
    const u64 = (i, f) => BigInt(ex.x64_user_trace(i - first, f, 1) >>> 0) << 32n | BigInt(ex.x64_user_trace(i - first, f, 0) >>> 0);
    for(let i = Math.max(trace_seen, first); i < count; i++)
    {
        const [vector, error, rip, address, rsp, cs, cr3] = [0, 1, 2, 3, 4, 5, 6].map(f => u64(i, f));
        const at = physical(cr3, rip);
        const none = 0xFFFFFFFFFFFFFFFFn, hex = v => "0x" + v.toString(16);
        console.log("X64_WIN_TRACE " + JSON.stringify({n: i, vector: Number(vector), error: error === none ? null : hex(error), rip: hex(rip),
            cr2: address === none ? null : hex(address), rsp: hex(rsp), cs: hex(cs), cr3: hex(cr3),
            code: at === null ? null : Buffer.from(cpu.mem8.subarray(at, at + 16)).toString("hex")}));
    }
    trace_seen = count;
}
const result_text = name => { const bytes = read_fat16(tools.bytes, name); return bytes ? Buffer.from(bytes).toString("ascii") : ""; };

try
{
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    cpu = vm.v86.cpu;
    if(process.env.WIN_X64_PROFILE !== "0") cpu.wm.exports.set_x64_test_capabilities(1);
    if(process.env.WIN_PAGE_TIER === "0") cpu.wm.exports.x64_page_set_enabled(0);
    if(process.env.WIN_STEP_PROFILE) cpu.wm.exports.x64_page_profile(1);
    if(process.env.X64_COMPAT_JIT) cpu.wm.exports.x64_set_compat_jit(process.env.X64_COMPAT_JIT !== "0");
    if(process.env.WIN_USER_TRACE) cpu.wm.exports.x64_user_trace_enable(1);
    // The reset is noted before any state is replaced: record the code at
    // each faulting RIP and the descriptor tables while they are intact.
    const note_reset = cpu.note_reset.bind(cpu);
    cpu.note_reset = reason => {
        note_reset(reason);
        const info = cpu.last_reset, cr3 = BigInt(cpu.cr[3] >>> 0) | BigInt(new Uint32Array(cpu.wasm_memory.buffer, 1612, 1)[0]) << 32n;
        const bytes = (address, length) => {
            const at = physical(cr3, BigInt(address));
            return at === null ? null : Buffer.from(cpu.mem8.subarray(at, at + length)).toString("hex");
        };
        for(const fault of info.x64_faults || []) fault.bytes = bytes(fault.rip, 24);
        // The image containing the first faulting RIP (scan down for its MZ
        // header), plus the stack, for offline symbolization
        const first = info.x64_faults?.[info.x64_faults.length - 1];
        if(first)
        {
            for(let page = BigInt(first.rip) & ~0xFFFn, n = 0; n < 4096; n++, page -= 0x1000n)
            {
                const header = bytes(page, 2);
                if(header === "4d5a") { info.image_base = "0x" + page.toString(16); break; }
            }
            info.stack = "";
            for(let at = BigInt(first.rsp), end = at + 0x40000n; at < end;)
            {
                const length = 0x1000 - Number(at & 0xFFFn), part = bytes(at, length);
                if(part === null) break;
                info.stack += part;
                at += BigInt(length);
            }
            for(const rva of (process.env.WIN_DUMP_RVAS || "").split(",").filter(Boolean))
                (info.dumps ||= {})[rva] = info.image_base && bytes(BigInt(info.image_base) + BigInt(rva), 64);
        }
        info.gdt = bytes(info.gdtr[0], Math.min(info.gdtr[1] + 1, 0x80));
        info.idt_3_8_13 = [3, 8, 13].map(v => bytes(BigInt(info.idtr[0]) + BigInt(v * 16), 16));
    };
    const run_cores = cpu.run_cores.bind(cpu);
    cpu.run_cores = () => { try { return run_cores(); } catch(error) { execution_error = error; vm.stop(); return 100; } };
    vm.run();
    const deadline = performance.now() + +(process.env.WIN_TIMEOUT_MS || 3600000);
    let next_report = 0, next_samples = performance.now() + 60000, next_shot = 0, resets = 0, signed_in = false, probe_sent = 0, text_seen = "";
    while(performance.now() < deadline)
    {
        await delay(200);
        if(execution_error) throw execution_error;
        const command_file = path.join(out, "command.txt");
        if(fs.existsSync(command_file))
        {
            const lines = fs.readFileSync(command_file, "utf8").split("\n").map(line => line.trim()).filter(Boolean);
            fs.unlinkSync(command_file);
            for(const line of lines)
            {
                const [verb, ...rest] = line.split(" "), argument = rest.join(" ");
                event("command", {line});
                if(verb === "key") await press(argument.split(/\s+/).map(v => parseInt(v, 16)));
                else if(verb === "type") await type(argument);
                else if(verb === "run") await run_command(argument);
                else if(verb === "enter") await enter();
                else if(verb === "space") await press([57, 185]);
                else if(verb === "password") { await type(password); await enter(); }
                else if(verb === "shot") screenshot(true);
                else if(verb === "rips") next_samples = 0;
                else if(verb === "trace") { cpu.wm.exports.x64_user_trace_enable(argument !== "off"); trace_seen = 0; }
            }
        }
        poll_user_trace();
        const text = text_screen();
        if(text && text !== text_seen) { text_seen = text; event("text", {text}); }
        if(performance.now() >= next_shot)
        {
            next_shot = performance.now() + 2000;
            screenshot(false);
        }
        if(cpu.last_reset && cpu.last_reset.count !== resets)
        {
            resets = cpu.last_reset.count;
            event("reset", cpu.last_reset);
        }
        sample_rip();
        if(performance.now() >= next_samples)
        {
            next_samples = performance.now() + 60000;
            const top = [...rip_samples].sort((a, b) => b[1] - a[1]).slice(0, 12);
            console.log("X64_WIN_RIPS " + JSON.stringify(top));
            rip_samples.clear();
            if(process.env.WIN_STEP_PROFILE)
            {
                // interpreter steps inside page functions, by opcode (see pages.rs)
                const get = cpu.wm.exports.x64_page_profile_get;
                const name = key => (key & 0x10000 ? "rep " : "") + ["", "0F ", "0F38 ", "0F3A "][key >> 8 & 3] + (key & 0xFF).toString(16).padStart(2, "0");
                const rows = [];
                for(let key = 0; key < 0x20000; key++) { const n = get(key); if(n) rows.push([n, key]); }
                rows.sort((a, b) => b[0] - a[0]);
                console.log("X64_WIN_STEPS " + rows.slice(0, 40).map(([n, key]) => `${name(key)}:${n}`).join(" "));
            }
        }
        if(performance.now() >= next_report)
        {
            next_report = performance.now() + 15000;
            console.log("X64_WIN_PROGRESS " + JSON.stringify({s: elapsed(), screen: last_hash, dark: +dark_fraction.toFixed(2), colors, mode: last_mode, ...stats()}));
        }
        // Sign in once the graphical session has settled. Boot screens are
        // almost entirely black; the lock screen is a full-screen picture,
        // shown first as a plain colour while it loads (keys pressed then
        // are lost). Sign in once a many-coloured screen has been stable.
        if(!signed_in && last_mode && last_mode[0] >= 800 && dark_fraction < 0.6 && colors >= 12 && performance.now() - last_change > 10000 && !process.env.WIN_MANUAL)
        {
            await sign_in();
            signed_in = true;
            probe_sent = performance.now() + 60000;
        }
        if(signed_in && performance.now() > probe_sent && !process.env.WIN_MANUAL)
        {
            if(!desktop_visible())
            {
                // lock screen (sign-in lost, or locked after idling with the
                // display off), password box, or still signing in
                if(password_box_visible() || performance.now() - last_sign_in > 180000) await sign_in();
                probe_sent = performance.now() + 20000;
            }
            else
            {
                const arch = report.results[64] ? 32 : 64;
                const started = await run_command(`cmd /c for %d in (d e f g h) do @if exist %d:\\probe${arch}.exe %d:\\probe${arch}.exe`);
                // WOW64 start-up is slow; one attempt at a time
                probe_sent = performance.now() + (started ? 600000 : 20000);
            }
        }
        for(const arch of [64, 32])
        {
            const text = result_text(`RESULT${arch}.TXT`);
            const match = text.match(/X64_WIN_DONE arch=(\d+) processors=(\d+) packages=(\d+) cores=(\d+) smt_cores=(\d+) progress=(\d+) failures=(\d+) apic_ids=(\w+) high_block=(\w+) checks=([\d,]+)\r?\n/);
            if(match && !report.results[arch])
            {
                report.results[arch] = {processors: +match[2], packages: +match[3], cores: +match[4], smt_cores: +match[5],
                    progress: +match[6], failures: +match[7], apic_ids: match[8], high_block: match[9], text};
                event("probe", {arch, result: report.results[arch]});
                probe_sent = performance.now() + 2000;
            }
        }
        if(report.results[64] && report.results[32]) break;
    }
    for(const arch of [64, 32])
    {
        const r = report.results[arch];
        assert.ok(r, `probe ${arch} completed`);
        assert.equal(r.failures, 0, `probe ${arch} failures`);
        assert.equal(r.processors, cores);
        assert.equal(r.packages, 1); assert.equal(r.cores, cores); assert.equal(r.smt_cores, 0);
        assert.equal(r.progress, cores * 64);
        if(arch === 64) assert.ok(BigInt("0x" + r.high_block) >> 32n > 0n, "x64 top-down allocation above 4 GiB");
    }
    report.passed = true;
    console.log("X64_WIN_PASS " + JSON.stringify(report.results));
}
catch(error)
{
    report.passed = false;
    report.error = String(error?.stack || error);
    console.error("X64_WIN_FAILURE " + report.error);
    process.exitCode = 1;
}
finally
{
    if(cpu) { report.final = stats(); screenshot(true); report.text_screen = text_screen(); }
    await vm.stop();
    const final_stat = fs.statSync(image_path);
    assert.equal(final_stat.mtimeMs, source_stat.mtimeMs, "the source image was never written");
    report.wall_s = elapsed();
    fs.writeFileSync(path.join(out, `result-${jit ? "page" : "interpreter"}-${cores}c${report.parallel ? "-parallel" : ""}.json`),
        JSON.stringify(report, null, 1));
    fs.writeFileSync(path.join(out, "tools-final.img"), tools.bytes);
    await vm.destroy();
    source.close();
}
