#!/usr/bin/env node
// Multicore throughput (docs/multicore.md): the same total
// guest work (tests/parallel/bench.asm) on 1/2/4/8 cores, cooperative and in
// vCPU workers. Every round's checksum is checked against a reference
// computed here, so a configuration cannot finish early by doing less work.
// Each machine runs a cold round (fresh compiler caches) and warm rounds.
//
// Modes: "cooperative" (release v86.wasm), "cooperative-pbuild" (cooperative
// cores on v86-parallel.wasm: the cost of its atomics alone) and "parallel".
//
// Items are claimed in chunks by whichever core is free (BENCH_SPLIT=static:
// equal shares instead, where the slowest host core sets the time).
//
// BENCH_WORKLOADS (compute,lock,memory,io), BENCH_CORES (1,2,4,8),
// BENCH_MODES (cooperative,cooperative-pbuild,parallel), BENCH_ROUNDS (warm rounds, 3),
// BENCH_SCALE (work multiplier, 1), DISABLE_JIT=1, BENCH_REPORT (JSON file).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PARALLEL_WASM, ROOT } from "./guest.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const kernel = ROOT + "build/parallel-bench.bin";
const assembled = spawnSync("nasm", ["-f", "bin", "-o", kernel, ROOT + "tests/parallel/bench.asm"], { encoding: "utf8" });
assert.equal(assembled.status, 0, assembled.stderr);

const CONTROL = 0x380000;
const JIT = !+process.env.DISABLE_JIT;
const SCALE = +process.env.BENCH_SCALE || 1;
const WARM_ROUNDS = +process.env.BENCH_ROUNDS || 3;
const WORKLOADS = {
    compute: { id: 1, total: 1600000, chunk: 1024 },
    lock: { id: 2, total: 1200000, chunk: 1024 },
    memory: { id: 3, total: 40000, chunk: 32 },
    io: { id: 4, total: 200000, chunk: 256 },
};
const STATIC_SPLIT = process.env.BENCH_SPLIT === "static";
const workloads = (process.env.BENCH_WORKLOADS || "compute,lock,memory,io").split(",");
const core_counts = (process.env.BENCH_CORES || "1,2,4,8").split(",").map(Number);
const modes = (process.env.BENCH_MODES || "cooperative,cooperative-pbuild,parallel").split(",");

const mix = (x, rounds) => {
    for(let c = rounds; c > 0; c--)
    {
        x = Math.imul(x, 0x9E3779B1);
        x = (x << 13 | x >>> 19) ^ c;
    }
    return x >>> 0;
};
const block_sums = Array.from({ length: 1024 }, (_, b) => {
    let sum = 0;
    for(let k = 0; k < 1024; k++) sum = sum + Math.imul(b * 1024 + k, 0x9E3779B1) >>> 0;
    return sum;
});
function expected(name, total)
{
    let sum = 0;
    if(name === "compute") for(let i = 0; i < total; i++) sum = sum + mix(i, 64) >>> 0;
    if(name === "lock") for(let i = 0; i < total; i++) sum = sum + mix(i, 32) >>> 0;
    if(name === "memory") for(let i = 0; i < total; i++) sum = sum + block_sums[i & 1023] >>> 0;
    if(name === "io") sum = total;
    return sum;
}

async function measure(name, cores, mode)
{
    const total = Math.round(WORKLOADS[name].total * SCALE);
    const parallel = mode === "parallel";
    const emulator = new V86({
        multiboot: { url: kernel }, memory_size: 64 << 20, acpi: true, cpu_cores: cores,
        disable_jit: !JIT, experimental_smp_jit: JIT && cores > 1,
        ...(parallel ? { parallel: true, wasm_path: PARALLEL_WASM } :
            mode === "cooperative-pbuild" ? { wasm_path: PARALLEL_WASM } : { wasm_path: ROOT + "build/v86.wasm" }),
        autostart: false, log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    const cpu = emulator.v86.cpu;
    const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    const u32 = offset => view().getUint32(CONTROL + offset, true);
    const set = (offset, value) => view().setUint32(CONTROL + offset, value, true);
    set(0, cores);
    set(4, WORKLOADS[name].id);
    set(8, total);
    set(32, STATIC_SPLIT ? 0 : WORKLOADS[name].chunk);
    const reference = expected(name, total);
    emulator.run();
    const rounds = [];
    for(let round = 1; round <= 1 + WARM_ROUNDS; round++)
    {
        set(20, 0);
        set(24, 0);
        set(36, 0);
        const cpu0 = process.cpuUsage();
        const t0 = performance.now();
        set(12, round);
        const deadline = t0 + 600000;
        while(u32(16) < round)
        {
            if(performance.now() > deadline) throw new Error(`${name} ${cores}c ${mode}: round ${round} timed out`);
            await delay(1);
        }
        const ms = performance.now() - t0;
        const used = process.cpuUsage(cpu0);
        assert.equal(u32(28), 0, "kernel errors");
        assert.equal(u32(20), reference, `${name} ${cores}c ${mode} round ${round}: checksum`);
        if(name === "lock") assert.equal(u32(24), total, `${name} ${cores}c ${mode}: lock counter`);
        rounds.push({ ms, cpu_ratio: (used.user + used.system) / 1000 / ms });
    }
    const diagnostics = cpu.get_diagnostics();
    const result = {
        workload: name, cores, mode, total,
        cold_ms: rounds[0].ms,
        warm_ms: Math.min(...rounds.slice(1).map(r => r.ms)),
        warm_cpu_ratio: rounds.slice(1).reduce((a, r) => a + r.cpu_ratio, 0) / WARM_ROUNDS,
        rss_mb: process.memoryUsage().rss / 2 ** 20,
        io_served: diagnostics.parallel?.served ?? null,
        worker_waits: diagnostics.parallel?.cores.map(c => c.waits) ?? null,
        worker_jit: diagnostics.parallel?.cores.map(c => c.jit) ?? null,
    };
    await emulator.destroy();
    return result;
}

const host = { cpu: os.cpus()[0]?.model, logical_cores: os.cpus().length, node: process.version, platform: process.platform,
    arch: process.arch, memory_gb: os.totalmem() / 2 ** 30, jit: JIT, scale: SCALE, warm_rounds: WARM_ROUNDS,
    split: STATIC_SPLIT ? "static" : "chunks" };
console.log(JSON.stringify(host));
const results = [];
for(const name of workloads)
{
    let base = null;
    for(const cores of core_counts)
    {
        for(const mode of modes)
        {
            if(mode === "parallel" && cores === 1) continue;
            const r = await measure(name, cores, mode);
            if(cores === 1 && mode === "cooperative") base = r.warm_ms;
            r.speedup = base ? base / r.warm_ms : null;
            results.push(r);
            console.log(`${name.padEnd(8)} ${String(cores).padStart(2)}c ${mode.padEnd(11)} cold ${(r.cold_ms / 1000).toFixed(2)}s` +
                ` warm ${(r.warm_ms / 1000).toFixed(2)}s` + (r.speedup ? ` speedup ${r.speedup.toFixed(2)}x` : "") +
                ` cpu/wall ${r.warm_cpu_ratio.toFixed(2)} rss ${r.rss_mb.toFixed(0)} MiB` +
                (r.io_served !== null ? ` io ${r.io_served}` : ""));
        }
    }
}
if(process.env.BENCH_REPORT) fs.writeFileSync(process.env.BENCH_REPORT, JSON.stringify({ host, results }, null, 2));
console.log("benchmark checksums passed");
