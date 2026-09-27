#!/usr/bin/env node
// Headless game-state profiler: restores a saved state (made in the browser
// with the v86gl graphics proxy) and runs it, reporting guest MIPS and the
// frames the guest submits per second.
//
//   node tests/ir/performance/game_state.mjs --state kartrider.bin \
//       --hda windowsxp.img [--hdb game.img] [--wasm core.wasm] [--tier0 0|1]
//       [--seconds 60] [--profile-from 30 --profile-out game.cpuprofile]
//       [--sync-publication 0|1]
//
// Memory and VRAM sizes come from the state. Graphics: an infinitely fast
// null renderer (batches acknowledged; D9WG queries, readbacks and the
// heartbeat answered as the WebGPU host does), so only guest CPU work is
// measured. Audio: a speaker that consumes SB16 DMA at the sampling rate, so
// the guest's audio path runs as in the browser. Disk writes stay in RAM.
import fs from "node:fs";
import inspector from "node:inspector";
import { V86 } from "../../../build/libv86.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf("--" + name); return i < 0 ? fallback : args[i + 1]; };
const state_path = option("state"), hda = option("hda"), hdb = option("hdb");
if(!state_path || !hda) {
    console.error("usage: game_state.mjs --state file.bin --hda disk.img [--hdb disk.img] [--wasm core.wasm] [--tier0 0|1] [--seconds 60]");
    process.exit(2);
}
const seconds = Number(option("seconds", 60));
const profile_from = option("profile-from");
const profile_out = option("profile-out", "game.cpuprofile");

class SyncDisk {
    constructor(path) { this.fd = fs.openSync(path, "r"); this.byteLength = fs.fstatSync(this.fd).size; this.overlay = new Map(); }
    load() { this.onload && this.onload({}); }
    get(start, len, fn) {
        const out = new Uint8Array(len);
        fs.readSync(this.fd, out, 0, len, start);
        for(let sector = Math.floor(start / 512); sector * 512 < start + len; sector++) {
            const data = this.overlay.get(sector);
            if(!data) continue;
            const from = Math.max(start, sector * 512), to = Math.min(start + len, sector * 512 + 512);
            out.set(data.subarray(from - sector * 512, to - sector * 512), from - start);
        }
        fn(out);
    }
    get_and_cache(start, len, fn) { this.get(start, len, fn); }
    get_from_cache() { return undefined; }
    set(start, slice, fn) {
        for(let at = 0; at < slice.length;) {
            const offset = start + at, sector = Math.floor(offset / 512), within = offset - sector * 512;
            let data = this.overlay.get(sector);
            if(!data) { data = new Uint8Array(512); this.get(sector * 512, 512, b => data.set(b)); this.overlay.set(sector, data); }
            const n = Math.min(512 - within, slice.length - at);
            data.set(slice.subarray(at, at + n), within);
            at += n;
        }
        fn && fn();
    }
    get_buffer(fn) { fn(); }
    get_state() { return []; }
    set_state() {}
}

// The state's info block (an uncompressed v6 state): memory and VRAM sizes.
const raw = fs.readFileSync(state_path);
const header = new DataView(raw.buffer, raw.byteOffset, 16);
if(header.getInt32(0, true) !== (0x86768676 | 0))
    throw new Error("expected an uncompressed v86 state (decompress .zst first)");
const info = JSON.parse(raw.subarray(16, 16 + header.getUint32(12, true)).toString("utf8"));
const memory_size = info.state[0];
const vga_memory_size = Array.isArray(info.state[52]) ? info.state[52][0] : 8 * 1024 * 1024;

// --- null renderer ---------------------------------------------------------
const RESPONSE_REGION = 16 * 1024 * 1024 - 4 * 1024 * 1024;
const HEARTBEAT = RESPONSE_REGION + 4 * 1024 * 1024 - 16;
const g = { batches: 0, bytes: 0, presents: 0, draws: 0 };
// Wall-clock intervals between presents (ms, rounded), in the second half.
const intervals = new Map();
let last_present = 0, measuring = false;
const queries = new Map();
let heartbeat = 0;
function onSubmit(event) {
    event.handled = true;
    const b = event.bytes;
    g.batches++; g.bytes += b.byteLength;
    const envelope = b.byteLength >= 8 ? b[0] | b[1] << 8 : 0;
    if(envelope !== 0xFFE0 && envelope !== 0xFFE1) return;
    const d = new DataView(b.buffer, b.byteOffset + 8, b.byteLength - 8);
    if(d.byteLength < 32 || d.getUint32(0, true) !== 0x47573944) return; // "D9WG"
    const end = 32 + d.getUint32(20, true);
    const write = (offset, bytes) => { try { event.writeGuestMemory(offset, bytes); } catch(e) {} };
    for(let at = 32; at + 16 <= end;) {
        const op = d.getUint16(at, true), size = d.getUint32(at + 4, true), p = at + 16;
        if(size < 16 || at + size > end) break;
        if(op === 4 || op === 0x226) {
            g.presents++;
            const now = performance.now();
            if(measuring && last_present) { const ms = Math.round(now - last_present); intervals.set(ms, (intervals.get(ms) || 0) + 1); }
            last_present = now;
        }
        if(op >= 0x300 && op <= 0x303) g.draws++;
        if(op === 0x123 && size >= 32) queries.set(d.getUint32(p + 4, true), { type: d.getUint32(p + 8, true), offset: d.getUint32(p + 12, true) });
        if(op === 0x401 && size >= 32) {
            const q = queries.get(d.getUint32(p + 4, true));
            if(q) {
                const out = new Uint8Array(16), v = new DataView(out.buffer);
                const value = q.type === 8 ? 1 : q.type === 9 ? 1000 : q.type === 12 ? 1e9 : q.type === 10 ? Math.floor(performance.now() * 1e6) : 0;
                v.setUint32(0, d.getUint32(p + 12, true), true);
                v.setUint32(4, value >>> 0, true);
                v.setUint32(8, Math.floor(value / 2 ** 32) >>> 0, true);
                v.setUint32(12, 1, true);
                write(RESPONSE_REGION + q.offset, out);
            }
        }
        if(op === 12 && size >= 16 + 48) {
            const bytes = d.getUint32(p + 36, true), offset = d.getUint32(p + 40, true);
            const out = new Uint8Array(16 + bytes), v = new DataView(out.buffer);
            v.setUint32(0, d.getUint32(p + 44, true), true);
            v.setUint32(4, bytes, true);
            v.setUint32(12, 1, true);
            write(RESPONSE_REGION + offset, out);
        }
        at += size;
    }
    heartbeat = heartbeat + 1 >>> 0;
    write(HEARTBEAT, new Uint8Array([heartbeat & 255, heartbeat >> 8 & 255, heartbeat >> 16 & 255, heartbeat >>> 24]));
}

const vm = new V86({
    wasm_path: option("wasm", "build/v86-ir-runtime.wasm"),
    ir_tier0: option("tier0", "1") === "1",
    memory_size, vga_memory_size,
    bios: { url: "bios/seabios.bin" }, vga_bios: { url: "bios/vgabios.bin" },
    hda: new SyncDisk(hda), ...(hdb ? { hdb: new SyncDisk(hdb) } : {}),
    x87_fast_math: true, x87_jit_cache: true,
    ir_sync_publication: option("sync-publication", "0") === "1",
    v86gl_pci: { maxBatchBytes: 16 * 1024 * 1024, onSubmit },
    filesystem: {},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "ne2k" }, autostart: false,
});
await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
const e = vm.v86.cpu.wm.exports;
await vm.restore_state(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

// --- speaker ------------------------------------------------------------------
let rate = 22050, queued = 0, last = performance.now();
vm.bus.register("dac-tell-sampling-rate", r => { rate = r; });
vm.bus.register("dac-send-data", data => { queued += data[0].length; });
const speaker = setInterval(() => {
    const now = performance.now();
    queued = Math.max(0, queued - rate * (now - last) / 1000);
    last = now;
    if(queued < rate * 0.2) vm.bus.send("dac-request-data");
}, 5);

const session = profile_from !== undefined ? new inspector.Session() : null;
const post = (method, params) => new Promise((resolve, reject) => session.post(method, params || {}, (err, r) => err ? reject(err) : resolve(r)));
if(session) { session.connect(); await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 200 }); }
let profiling = false, instructions = 0, counter = vm.get_instruction_counter() >>> 0;
let prev = { instructions: 0, presents: 0, draws: 0, t: performance.now() };
const steady = [];
const started = performance.now();
vm.run();
await new Promise(resolve => {
    const tick = setInterval(() => {
        const c = vm.get_instruction_counter() >>> 0;
        instructions += (c - counter) >>> 0; counter = c;
        const now = performance.now(), dt = (now - prev.t) / 1000, s = (now - started) / 1000;
        const line = {
            s: +s.toFixed(1),
            mips: +((instructions - prev.instructions) / dt / 1e6).toFixed(1),
            fps: +((g.presents - prev.presents) / dt).toFixed(1),
            draws: Math.round((g.draws - prev.draws) / dt),
            t0_compiles: e.ir_t0_stat?.(0), t0_chains: e.ir_t0_chains?.() >>> 0,
        };
        console.log(JSON.stringify(line));
        if(s >= seconds / 2) { steady.push(line); measuring = true; }
        prev = { instructions, presents: g.presents, draws: g.draws, t: now };
        if(session && !profiling && s >= Number(profile_from)) { profiling = true; post("Profiler.start"); }
        if(s >= seconds) { clearInterval(tick); resolve(); }
    }, 1000);
});
await vm.stop();
clearInterval(speaker);
if(profiling) fs.writeFileSync(profile_out, JSON.stringify((await post("Profiler.stop")).profile));
const mean = key => steady.reduce((t, l) => t + l[key], 0) / Math.max(1, steady.length);
const t0 = ["functions", "instructions", "templated", "bytes", "pages"].map((name, i) => [name, e.ir_t0_stat?.(i) >>> 0]);
console.log(JSON.stringify({ event: "summary", seconds, second_half: { mips: +mean("mips").toFixed(1), fps: +mean("fps").toFixed(1), draws: Math.round(mean("draws")) },
    frame_ms: Object.fromEntries([...intervals].sort((a, b) => b[1] - a[1]).slice(0, 8)), tier0: Object.fromEntries(t0) }));
await vm.destroy();
process.exit(0);
