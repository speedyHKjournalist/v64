#!/usr/bin/env node
// v86 CPU benchmark runner: identical guest work on each arm (the core under
// test and an optional baseline core), checked results, SPEC-style ratio scores.
//
//   node tests/bench/run.mjs [--filter re] [--runs 5] [--cold 3] [--scale 1]
//        [--wasm build/v86-ir-runtime.wasm] [--baseline other.wasm]
//        [--xp image.img] [--xp-runs 3] [--out file.json] [--quick]
//        [--ir-setup "export=value,..."]   (calls on every arm after boot)
//        [--switches-a "name=value,..."] [--switches-b "name=value,..."]
//            (the JIT switches of the arm and of the baseline, over
//            JIT_SWITCHES; --switches-b without --baseline compares two
//            configurations of one core, see tests/bench/compare.mjs)
//        [--fallbacks]   (print the instructions the JITs most often leave to
//            the interpreter: the step profile of an extra round that is not
//            timed, tools/step_profile.mjs)
//        [--isa i686|x86_64|compat32]   (x86_64: the PE32+ builds of the C
//            benchmarks, started in 64-bit mode by build/bench/long_mode.bin,
//            where the x64 page tier runs them; --small-pages boots with 4 KiB
//            pages. compat32: the i686 images in compatibility mode under the
//            same paging, build/bench/long_mode_compat.bin)
//        [--same-source]   (the arm is the x86_64 build, the baseline the
//            i686 build of the same source, on one core unless --baseline;
//            each row gets instruction_ratio and data_ratio, x86-64 over
//            i686: tests/bench/gate.mjs --level S, make bench-same-source)
//        [--interpreter]   (one more arm without JIT, with the arm's ISA:
//            the reference its checksums must match)
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
import { parse_jit_switches, set_jit_switches } from "../../src/jit_switches.js";
import { jit_switches_from_env } from "../lib/jit_switches.mjs";
import { jit_stats, jit_stats_enabled } from "../../tools/bench/jit_stats.mjs";
import { step_profile } from "../../tools/step_profile.mjs";
import { STATE_OFFSETS } from "../../src/state_layout.js";

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
const same_source = flag("same-source");
const isa = same_source ? "x86_64" : option("isa", "i686");
assert(["i686", "x86_64", "compat32"].includes(isa), `--isa ${isa}: i686, x86_64 or compat32`);
const ir_setup = (option("ir-setup") || "").split(",").filter(Boolean).map(s => s.split("="));
const out = option("out", `build/bench/results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
assert(Number.isInteger(runs) && runs >= 1 && Number.isInteger(cold_runs) && cold_runs >= 0 && scale > 0);

const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const wide = isa !== "i686" || same_source;
assert(!wide || manifest.boot64, "no x86-64 builds: install x86_64-w64-mingw32-gcc and make bench-build");
const boot64 = wide ? fs.readFileSync(flag("small-pages") ? manifest.boot64_small_pages : manifest.boot64) : null;
const boot_compat = isa === "compat32" ? fs.readFileSync(manifest.boot_compat) : null;
const switches = name => ({ ...jit_switches_from_env(), ...parse_jit_switches(option(name)) });
const arms = [
    { label: "ir", isa, wasm, switches: switches("switches-a") },
    ...same_source ? [{ label: "baseline", isa: "i686", wasm: baseline || wasm, switches: switches("switches-b") }] :
        baseline || option("switches-b") ? [{ label: "baseline", isa, wasm: baseline || wasm, switches: switches("switches-b") }] : [],
    ...flag("interpreter") ? [{ label: "interpreter", isa, wasm, switches: {}, interpreted: true }] : [],
];
// The arm whose results another arm's must equal: the first one before it with its ISA
const reference_of = arm => arms.find(a => a !== arm && a.isa === arm.isa && arms.indexOf(a) < arms.indexOf(arm)) ??
    arms.find(a => a !== arm && a.isa === arm.isa);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const geomean = values => values.length ? Math.exp(values.reduce((s, v) => s + Math.log(v), 0) / values.length) : null;

// Minimal PE loader: sections at ImageBase + VirtualAddress, zero-filled to
// VirtualSize. Writable sections are restored before every run. PE32 and
// PE32+ (linked below 4 GiB).
function load_pe(file) {
    const b = fs.readFileSync(file), pe = b.readUInt32LE(0x3C);
    assert.equal(b.readUInt32LE(pe), 0x4550, `${file}: not a PE image`);
    const sections = b.readUInt16LE(pe + 6), optional = pe + 24, table = optional + b.readUInt16LE(pe + 20);
    const pe32plus = b.readUInt16LE(optional) === 0x20B;
    const base = pe32plus ? Number(b.readBigUInt64LE(optional + 24)) : b.readUInt32LE(optional + 28);
    assert(base < 2 ** 32 - 0x1000000, `${file}: image base above 4 GiB`);
    const entry = base + b.readUInt32LE(optional + 16);
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

// (a benchmark's cpu_features: the optional CPU features its guest uses;
// cpu_type: the x86-64 profile for its own ones, such as LZCNT. An x86_64
// arm boots build/bench/long_mode.bin with the x86-64 profile. `extra`: JIT
// switches over the arm's.)
async function create(arm, bench, extra = {}) {
    const jit_switches = { ...arm.switches, ...extra };
    const vm = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: arm.wasm, memory_size: 128 << 20,
        ...bench.cpu_features ? { cpu_features: bench.cpu_features, cpu_features_unreleased: !!bench.cpu_features_unreleased } : {},
        ...arm.isa === "x86_64" ? { cpu_type: "x86_64", multiboot: { buffer: Uint8Array.from(boot64).buffer } } :
            arm.isa === "compat32" ? { cpu_type: "x86_64", multiboot: { buffer: Uint8Array.from(boot_compat).buffer } } :
            { ...bench.cpu_type ? { cpu_type: bench.cpu_type } : {}, bios: { buffer: Uint8Array.from(boot).buffer } },
        ...arm.interpreted ? { disable_jit: true } : {},
        disable_keyboard: true, disable_mouse: true,
        disable_speaker: true, net_device: { type: "none" }, autostart: false,
        ...Object.keys(jit_switches).length ? { jit_switches } : {},
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
    if(machine.arm.isa !== "i686") {
        // (the upper halves, R8-R15 and RIP's upper half: the 64-bit register file)
        const words = (offset, n) => new Uint32Array(cpu.wasm_memory.buffer, cpu.state_base + offset, n);
        words(STATE_OFFSETS.x64_gpr_hi, 16).fill(0);
        words(STATE_OFFSETS.x64_gpr_ext_lo, 8).fill(0);
        words(STATE_OFFSETS.x64_rip_hi, 1)[0] = 0;
    }
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
const writable = image => image.parts.filter(p => p.writable).reduce((sum, p) => sum + p.bytes.length, 0);
for(const bench of manifest.benchmarks) {
    if(filter && !filter.test(bench.name)) continue;
    if(arms.some(a => a.isa === "x86_64") && !bench.image64) continue;
    const images = { i686: load_pe(bench.image), ...bench.image64 ? { x86_64: load_pe(bench.image64) } : {} };
    images.compat32 = images.i686;
    const iterations = Math.max(1, Math.round(bench.iterations * scale));
    const row = { name: bench.name, category: bench.category, about: bench.about, iterations, arms: {} };
    for(const arm of arms) row.arms[arm.label] = { cold_ms: [], warm_ms: [], warmup_ms: [], checksum: null, instructions: null };
    // (the x64 page tier counts instructions per block, an upper bound that
    // depends on where blocks were left: only its checksums must repeat)
    const note = (arm, sample) => {
        const r = row.arms[arm.label], exact = arm.isa !== "x86_64" || arm.interpreted;
        r.checksum ??= sample.checksum; r.instructions ??= sample.instructions;
        if(r.checksum !== sample.checksum || exact && r.instructions !== sample.instructions)
            errors.push(`${bench.name}/${arm.label}: nondeterministic result ${sample.checksum}/${sample.instructions}`);
    };
    try {
        for(let c = 0; c < cold_runs; c++) for(const arm of c % 2 ? [...arms].reverse() : arms) {
            const machine = await create(arm, bench);
            try { const s = await execute(machine, images[arm.isa], iterations); note(arm, s); row.arms[arm.label].cold_ms.push(s.ms); }
            finally { await machine.vm.destroy(); }
        }
        const machines = [];
        try {
            for(const arm of arms) machines.push(await create(arm, bench));
            // Warm up until two consecutive runs of every arm agree within 5%.
            for(let w = 0; w < 30; w++) {
                for(const m of machines) { const s = await execute(m, images[m.arm.isa], iterations); note(m.arm, s); row.arms[m.arm.label].warmup_ms.push(s.ms); }
                if(w >= 3 && machines.every(m => { const t = row.arms[m.arm.label].warmup_ms.slice(-2); return Math.abs(t[0] - t[1]) <= 0.05 * Math.min(...t); })) break;
            }
            for(let r = 0; r < runs; r++) for(const m of r % 2 ? [...machines].reverse() : machines) {
                const s = await execute(m, images[m.arm.isa], iterations);
                note(m.arm, s);
                row.arms[m.arm.label].warm_ms.push(s.ms);
            }
            // (tools/bench/jit_stats.mjs, docs/jit-unification-plan.md P0.7)
            if(jit_stats_enabled())
            {
                for(const m of machines) row.arms[m.arm.label].jit_stats = jit_stats(m.vm, { script: "bench", benchmark: bench.name, arm: m.arm.label, wasm: m.arm.wasm });
            }
            // (docs/jit-unification-plan.md P0.8: the step profile slows
            // every step, so it runs in one more round, not timed)
            if(fallbacks) {
                const m = machines[0], memory = m.cpu.wasm_memory;
                set_jit_switches(m.e, memory, { step_profile: 1 }, "--fallbacks");
                m.e.step_profile_reset();
                const s = await execute(m, images[m.arm.isa], iterations);
                note(m.arm, s);
                const steps = step_profile(m.e);
                set_jit_switches(m.e, memory, { step_profile: 0 }, "--fallbacks");
                row.arms[m.arm.label].steps = steps.slice(0, 40);
                const share = steps.reduce((sum, r) => sum + r.count, 0) / s.instructions;
                console.log(`  stepped ${(100 * share).toFixed(1)}%: ` + steps.slice(0, 8).map(r =>
                    `${r.name} ${(100 * r.count / s.instructions).toFixed(1)}%`).join(", "));
            }
            // Same source: the exact instruction counts (cross-phase rule 3) of
            // one more round, x86-64 in a fresh machine without the page
            // tier's block counts (compiled in; an upper bound when a block is
            // left early), and the writable data of each build
            if(same_source) {
                for(const m of machines.filter(m => !m.arm.interpreted)) {
                    const counted = m.arm.isa === "x86_64" ? await create(m.arm, bench, { x64_block_count: 0 }) : m;
                    try {
                        const before = counted.e.core_statistics_get(0, 0), steps = counted.e.x64_page_stat(4);
                        await execute(counted, images[m.arm.isa], iterations);
                        const r = row.arms[m.arm.label];
                        r.retired = counted.e.core_statistics_get(0, 0) - before;
                        if(m.arm.isa === "x86_64") r.step_share = (counted.e.x64_page_stat(4) - steps) / r.retired;
                    }
                    finally { if(counted !== m) await counted.vm.destroy(); }
                }
                row.instruction_ratio = row.arms.ir.retired / row.arms.baseline.retired;
                // (neither build writes static data: as much in both)
                const data = [writable(images.x86_64), writable(images.i686)];
                row.data_ratio = data[1] ? data[0] / data[1] : data[0] ? Infinity : 1;
            }
        }
        finally {
            for(const m of machines) await m.vm.destroy();
        }
        const reference = row.arms.baseline;
        for(const arm of arms) {
            const r = row.arms[arm.label];
            // (results only compare within an ISA; instruction counts only
            // between JIT arms of 32-bit code: the x64 page tier counts blocks)
            const same = reference_of(arm), expected = same && row.arms[same.label];
            const counts = arm.isa !== "x86_64" && !arm.interpreted && !same?.interpreted;
            if(expected && (r.checksum !== expected.checksum || counts && r.instructions !== expected.instructions))
                errors.push(`${bench.name}: ${arm.label} result ${r.checksum}/${r.instructions} differs from ${same.label} ${expected.checksum}/${expected.instructions}`);
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
    const ratios = row.instruction_ratio ? ` | instructions x${row.instruction_ratio.toFixed(2)} data x${row.data_ratio.toFixed(2)}` +
        ` steps ${(100 * row.arms.ir.step_share).toFixed(1)}%` : "";
    console.log(`${bench.name.padEnd(16)} ${row.error ? "ERROR " + row.error : line + ratios}`);
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
try { revision = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain", { encoding: "utf8" }).trim() ? "+dirty" : ""); } catch{}
const report = {
    suite: "v86-cpu", version: 1, date: new Date().toISOString(), revision, arms,
    settings: { runs, cold_runs, scale, ir_setup, isa, same_source },
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
