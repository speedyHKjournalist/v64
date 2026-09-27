#!/usr/bin/env node
// v86 CPU benchmark runner: identical guest work on each arm (the core under
// test and an optional baseline core), checked results, SPEC-style ratio scores.
//
//   node tests/bench/run.mjs [--filter re] [--runs 5] [--cold 3] [--scale 1]
//        [--wasm build/v86-ir-runtime.wasm] [--baseline other.wasm]
//        [--xp image.img] [--xp-runs 3] [--out file.json] [--quick]
//        [--ir-setup "export=value,..."]   (calls on every arm after boot)
//        [--fallbacks]   (IR: print the instructions most often interpreted)
//
// Build the suite first: node tools/bench/build.mjs (make bench-build).
//
// Measurements per benchmark and arm:
//   cold  first run in a fresh VM: JIT discovery, compilation and execution
//   warm  median of timed runs after the timings have stabilized
// Ratios are baseline time / arm time (above 1 means faster than the baseline);
// without --baseline only MIPS are reported. Scores are geometric means of the
// ratios per category and over the whole suite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { V86 } from "../../build/libv86.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
process.chdir(root);
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf("--" + name);
    return i < 0 ? fallback : args[i + 1];
};
const flag = name => args.includes("--" + name);
const quick = flag("quick");
const runs = Number(option("runs", quick ? 3 : 5));
const cold_runs = Number(option("cold", quick ? 1 : 3));
const scale = Number(option("scale", quick ? 0.5 : 1));
const filter = option("filter") ? new RegExp(option("filter")) : null;
const wasm = option("wasm", "build/v86-ir-runtime.wasm");
const baseline = option("baseline");
const xp_image = option("xp");
const xp_runs = Number(option("xp-runs", 3));
const fallbacks = flag("fallbacks");
const ir_setup = (option("ir-setup") || "").split(",").filter(Boolean).map(s => s.split("="));
const out = option("out", `build/bench/results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
assert(Number.isInteger(runs) && runs >= 1 && Number.isInteger(cold_runs) && cold_runs >= 0 && scale > 0);

const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const arms = [
    { label: "ir", wasm },
    ...baseline ? [{ label: "baseline", wasm: baseline }] : [],
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const geomean = values => values.length ? Math.exp(values.reduce((s, v) => s + Math.log(v), 0) / values.length) : null;

// Minimal PE loader: sections at ImageBase + VirtualAddress, zero-filled to
// VirtualSize. Writable sections are restored before every run.
function load_pe(file) {
    const b = fs.readFileSync(file), pe = b.readUInt32LE(0x3C);
    assert.equal(b.readUInt32LE(pe), 0x4550, `${file}: not a PE image`);
    const sections = b.readUInt16LE(pe + 6), optional = pe + 24, table = optional + b.readUInt16LE(pe + 20);
    const base = b.readUInt32LE(optional + 28), entry = base + b.readUInt32LE(optional + 16);
    const parts = [];
    for(let i = 0; i < sections; i++) {
        const s = table + 40 * i;
        const virtual_size = b.readUInt32LE(s + 8), address = base + b.readUInt32LE(s + 12);
        const raw_size = b.readUInt32LE(s + 16), raw = b.readUInt32LE(s + 20), flags = b.readUInt32LE(s + 36);
        const bytes = new Uint8Array(Math.max(virtual_size, raw_size));
        bytes.set(b.subarray(raw, raw + Math.min(raw_size, bytes.length)));
        parts.push({ name: b.toString("latin1", s, s + 8).replace(/\0+$/, ""), address, bytes, writable: !!(flags & 0x80000000) });
    }
    return { entry, parts };
}

async function create(arm) {
    const vm = new V86({
        wasm_path: arm.wasm, memory_size: 128 << 20,
        bios: { buffer: Uint8Array.from(boot).buffer }, disable_keyboard: true, disable_mouse: true,
        disable_speaker: true, net_device: { type: "none" }, autostart: false,
    });
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    const cpu = vm.v86.cpu;
    const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    vm.run();
    const end = performance.now() + 15000;
    while(view().getUint32(0x500, true) !== 0xCAFE) { assert(performance.now() < end, "benchmark BIOS did not start"); await sleep(1); }
    await vm.stop();
    for(const [name, value] of ir_setup) {
        assert.equal(typeof cpu.wm.exports[name], "function", `--ir-setup: no export ${name}`);
        assert(cpu.wm.exports[name](Number(value)), `--ir-setup: ${name}(${value}) refused`);
    }
    return { vm, cpu, e: cpu.wm.exports, view, arm };
}

async function execute(machine, image, iterations) {
    const { vm, cpu, e, view } = machine;
    for(const part of image.parts) if(part.writable || !machine.loaded) cpu.mem8.set(part.bytes, part.address);
    machine.loaded = true;
    const v = view();
    v.setUint32(0x600, iterations, true); v.setUint32(0x604, 0, true); v.setUint32(0x608, 0, true);
    cpu.reg32.fill(0);
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0; cpu.instruction_pointer[0] = image.entry;
    e.fpu_discard_cache(); cpu.fpu_st.fill(0); cpu.fpu_stack_empty[0] = 255; cpu.fpu_stack_ptr[0] = 0;
    e.set_control_word(0x37F); cpu.fpu_status_word[0] = 0; cpu.mxcsr[0] = 0x1F80;
    e.update_state_flags();
    const counter = new Uint32Array(e.memory.buffer);
    counter[664 >> 2] = 0;
    const started = performance.now();
    vm.run();
    const limit = started + 120000;
    while(!cpu.in_hlt[0]) { assert(performance.now() < limit, "benchmark timeout"); await sleep(0); }
    const ms = performance.now() - started;
    await vm.stop();
    const status = view().getUint32(0x608, true);
    if(status !== 1) throw new Error(status >>> 31 ? `guest exception ${status & 31} at ${view().getUint32(0x60C, true).toString(16)}` : `guest did not finish (${status})`);
    return { ms, instructions: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0, checksum: view().getUint32(0x604, true) };
}

const results = [];
const errors = [];
for(const bench of manifest.benchmarks) {
    if(filter && !filter.test(bench.name)) continue;
    const image = load_pe(bench.image);
    const iterations = Math.max(1, Math.round(bench.iterations * scale));
    const row = { name: bench.name, category: bench.category, about: bench.about, iterations, arms: {} };
    for(const arm of arms) row.arms[arm.label] = { cold_ms: [], warm_ms: [], warmup_ms: [], checksum: null, instructions: null };
    const note = (arm, sample) => {
        const r = row.arms[arm.label];
        r.checksum ??= sample.checksum; r.instructions ??= sample.instructions;
        if(r.checksum !== sample.checksum || r.instructions !== sample.instructions)
            errors.push(`${bench.name}/${arm.label}: nondeterministic result ${sample.checksum}/${sample.instructions}`);
    };
    try {
        for(let c = 0; c < cold_runs; c++) for(const arm of c % 2 ? [...arms].reverse() : arms) {
            const machine = await create(arm);
            try { const s = await execute(machine, image, iterations); note(arm, s); row.arms[arm.label].cold_ms.push(s.ms); }
            finally { await machine.vm.destroy(); }
        }
        const machines = [];
        try {
            for(const arm of arms) machines.push(await create(arm));
            // Warm up until two consecutive runs of every arm agree within 5%.
            for(let w = 0; w < 30; w++) {
                for(const m of machines) { const s = await execute(m, image, iterations); note(m.arm, s); row.arms[m.arm.label].warmup_ms.push(s.ms); }
                if(w >= 3 && machines.every(m => { const t = row.arms[m.arm.label].warmup_ms.slice(-2); return Math.abs(t[0] - t[1]) <= 0.05 * Math.min(...t); })) break;
            }
            if(fallbacks) machines[0].e.ir_t0_steps_reset();
            for(let r = 0; r < runs; r++) for(const m of r % 2 ? [...machines].reverse() : machines) {
                const s = await execute(m, image, iterations);
                note(m.arm, s);
                row.arms[m.arm.label].warm_ms.push(s.ms);
            }
        }
        finally {
            if(fallbacks && machines[0]?.e.ir_t0_steps) {
                const e = machines[0].e, total = row.arms.ir.instructions * runs, top = [];
                for(let key = 0; key < 0x10000; key++) { const n = e.ir_t0_steps(key); if(n) top.push([n, key]); }
                top.sort((a, b) => b[0] - a[0]);
                const share = top.reduce((s, [n]) => s + n, 0) / total;
                console.log(`  interpreted ${(100 * share).toFixed(1)}%: ` + top.slice(0, 8).map(([n, key]) =>
                    `${(key & 255).toString(16).padStart(2, "0")} ${(key >> 8).toString(16).padStart(2, "0")} ${(100 * n / total).toFixed(1)}%`).join(", "));
            }
            for(const m of machines) await m.vm.destroy();
        }
        const reference = row.arms.baseline;
        for(const arm of arms) {
            const r = row.arms[arm.label];
            if(reference && (r.checksum !== reference.checksum || r.instructions !== reference.instructions))
                errors.push(`${bench.name}: ${arm.label} result ${r.checksum}/${r.instructions} differs from baseline ${reference.checksum}/${reference.instructions}`);
            r.warm = median(r.warm_ms); r.cold = cold_runs ? median(r.cold_ms) : null;
            r.warm_mips = r.instructions / r.warm / 1000;
            r.cold_mips = r.cold ? r.instructions / r.cold / 1000 : null;
            r.warm_ratio = reference ? median(reference.warm_ms) / r.warm : null;
            r.cold_ratio = reference && cold_runs ? median(reference.cold_ms) / r.cold : null;
        }
    }
    catch(error) {
        errors.push(`${bench.name}: ${error.message}`);
        row.error = error.message;
    }
    results.push(row);
    const line = arms.map(arm => {
        const r = row.arms[arm.label];
        return row.error ? `${arm.label} -` : `${arm.label} ${r.warm_mips.toFixed(0)} MIPS${arm.label === "baseline" || r.warm_ratio === null ? "" : ` x${r.warm_ratio.toFixed(2)} cold x${(r.cold_ratio ?? NaN).toFixed(2)}`}`;
    }).join(" | ");
    console.log(`${bench.name.padEnd(16)} ${row.error ? "ERROR " + row.error : line}`);
}

if(xp_image) {
    const row = { name: "900.xpboot", category: "system", about: "Windows XP boot to the first 800x600x32 desktop mode, synchronous disk", arms: {} };
    for(const arm of arms) row.arms[arm.label] = { boot_ms: [], avg_mips: [] };
    for(let r = 0; r < xp_runs; r++) for(const arm of r % 2 ? [...arms].reverse() : arms) {
        const child = spawnSync(process.execPath, ["tests/ir/performance/xp_boot.mjs", xp_image, arm.wasm], {
            env: { ...process.env, IR_SYNC_DISK: "1", IR_BOOT_TARGET: "desktop", IR_BOOT_MS: "180000", IR_DIAGNOSTICS: "0" },
            encoding: "utf8", timeout: 400000, maxBuffer: 1 << 28,
        });
        const result = child.stdout.split("\n").filter(l => l.includes('"event":"result"')).map(l => JSON.parse(l))[0];
        if(!result?.milestone) { errors.push(`900.xpboot/${arm.label}: no desktop milestone`); continue; }
        row.arms[arm.label].boot_ms.push(result.milestone.ms);
        row.arms[arm.label].avg_mips.push(result.milestone.instructions / result.milestone.ms / 1000);
    }
    for(const arm of arms) {
        const r = row.arms[arm.label];
        r.warm = median(r.boot_ms); r.warm_mips = median(r.avg_mips);
        r.warm_ratio = row.arms.baseline ? median(row.arms.baseline.boot_ms) / r.warm : null;
    }
    results.push(row);
    console.log(`900.xpboot       ${arms.map(a => `${a.label} ${(row.arms[a.label].warm / 1000).toFixed(2)} s ${row.arms[a.label].warm_mips.toFixed(0)} MIPS`).join(" | ")}`);
}

const scores = {};
for(const arm of arms) {
    if(arm.label === "baseline" || !baseline) continue;
    const ok = results.filter(r => !r.error && r.arms[arm.label]?.warm_ratio);
    const categories = [...new Set(ok.map(r => r.category))];
    scores[arm.label] = {
        warm: geomean(ok.map(r => r.arms[arm.label].warm_ratio)),
        cold: geomean(ok.filter(r => r.arms[arm.label].cold_ratio).map(r => r.arms[arm.label].cold_ratio)),
        categories: Object.fromEntries(categories.map(c => [c, {
            warm: geomean(ok.filter(r => r.category === c).map(r => r.arms[arm.label].warm_ratio)),
            cold: geomean(ok.filter(r => r.category === c && r.arms[arm.label].cold_ratio).map(r => r.arms[arm.label].cold_ratio)),
        }])),
        slower_than_baseline: ok.filter(r => r.arms[arm.label].warm_ratio < 1).map(r => r.name),
    };
}
let revision = null;
try { revision = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain", { encoding: "utf8" }).trim() ? "+dirty" : ""); } catch {}
const report = {
    suite: "v86-cpu", version: 1, date: new Date().toISOString(), revision, arms,
    settings: { runs, cold_runs, scale, ir_setup },
    host: { platform: process.platform, cpus: os.cpus().length, model: os.cpus()[0]?.model, load: os.loadavg(), node: process.version },
    scores, errors, results,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 1));
for(const [label, s] of Object.entries(scores)) {
    console.log(`\n${label} vs baseline: warm score ${s.warm?.toFixed(3)}  cold score ${s.cold?.toFixed(3) ?? "-"}`);
    for(const [c, v] of Object.entries(s.categories)) console.log(`  ${c.padEnd(9)} warm ${v.warm.toFixed(3)}  cold ${v.cold?.toFixed(3) ?? "-"}`);
    if(s.slower_than_baseline.length) console.log(`  slower than baseline: ${s.slower_than_baseline.join(" ")}`);
}
if(errors.length) { console.log("\nERRORS:\n  " + errors.join("\n  ")); process.exitCode = 1; }
console.log(`\nresults: ${out}`);
