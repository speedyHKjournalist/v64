#!/usr/bin/env node

// Compare independently built releases. Every sample starts a fresh Node/VM.
// Only run() -> Linux serial shell is timed; builds and image loading are not.
// Example:
// node tests/smp/clock_boot_bench.mjs --baseline /tmp/v86-before \
//   --current /tmp/v86-current --samples 5 --output /tmp/c0-boot.json
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL as path_to_file_url } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../..");
assert.equal((process.argv.length - 2) % 2, 0, "every --option requires a value");
const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) =>
    [process.argv[2 + i * 2].replace(/^--/, ""), process.argv[3 + i * 2]]));
const assets = path.resolve(options.assets || repository);
const hash = file => create_hash("sha256").update(fs.readFileSync(file)).digest("hex");
const workload_bytes = 16 * 1024 * 1024;
const workload_hash = create_hash("md5").update(Buffer.alloc(workload_bytes)).digest("hex");
const timeout_ms = +(options.timeout || 120000);
const marker = "C0_BENCH_RESULT ";

function command(executable, args, cwd)
{
    try { return execFileSync(executable, args, { cwd, encoding: "utf8" }).trim(); }
    catch{ return null; }
}

async function sample(root)
{
    const { V86 } = await import(path_to_file_url(path.join(root, "build/libv86.mjs")));
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        wasm_path: path.join(root, "build/v86.wasm"),
        bios: { url: path.join(assets, "bios/seabios.bin") },
        vga_bios: { url: path.join(assets, "bios/vgabios.bin") },
        cdrom: { url: path.join(assets, "images/linux4.iso") },
        memory_size: 128 << 20,
        cpu_cores: 1,
        acpi: true,
        autostart: false,
        log_level: 0,
    });
    let serial = "";
    let boot_started;
    let boot_finished;
    let workload_started;
    let workload_finished;
    let boot_resolve;
    let workload_resolve;
    let phase = "load";
    let timeout;
    const booted = new Promise(resolve => { boot_resolve = resolve; });
    const worked = new Promise(resolve => { workload_resolve = resolve; });
    emulator.add_listener("serial0-output-byte", byte => {
        serial += String.fromCharCode(byte);
        if(phase === "boot" && serial.endsWith("~% "))
        {
            boot_finished = performance.now();
            phase = "shell";
            boot_resolve();
        }
        if(phase === "workload" && serial.endsWith("~% "))
        {
            workload_finished = performance.now();
            phase = "done";
            workload_resolve();
        }
    });
    const failed = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${phase} timed out after ${timeout_ms} ms`)), timeout_ms);
        emulator.add_listener("emulator-error", reject);
    });
    try
    {
        await Promise.race([new Promise(resolve => emulator.add_listener("emulator-loaded", resolve)), failed]);
        phase = "boot";
        boot_started = performance.now();
        emulator.run();
        await Promise.race([booted, failed]);
        assert.ok(!serial.includes("Kernel panic"), "Linux boot must reach shell without panic");
        const boot_serial_length = serial.length;
        phase = "workload";
        workload_started = performance.now();
        emulator.serial0_send("dd if=/dev/zero bs=1024 count=16384 2>/dev/null | md5sum\n");
        await Promise.race([worked, failed]);
        assert.match(serial.slice(boot_serial_length), new RegExp(`(?:\\r?\\n)${workload_hash}  -\\r?\\n`),
            "fixed 16 MiB stream must complete with the expected digest");
        await emulator.stop();
        return {
            boot_wall_ms: boot_finished - boot_started,
            workload_wall_ms: workload_finished - workload_started,
            instruction_counter: emulator.v86.cpu.instruction_counter[0] >>> 0,
            serial_sha256: create_hash("sha256").update(serial).digest("hex"),
            serial,
        };
    }
    catch(error)
    {
        if(options.transcript) fs.writeFileSync(options.transcript, serial);
        throw error;
    }
    finally
    {
        clearTimeout(timeout);
        await emulator.destroy();
    }
}

if(options.sample)
{
    const result = await sample(path.resolve(options.sample));
    if(options.transcript) fs.writeFileSync(options.transcript, result.serial);
    delete result.serial;
    console.log(marker + JSON.stringify(result));
}
else
{
    assert.ok(options.baseline && options.current, "--baseline and --current release build roots are required");
    const sample_count = +(options.samples || 5);
    const max_ratio = +(options.ratio || 1.10);
    assert.ok(Number.isInteger(sample_count) && sample_count >= 3, "at least three measured samples per revision");
    assert.ok(Number.isFinite(max_ratio) && max_ratio >= 1, "--ratio is the maximum current/baseline median boot ratio");
    const output = path.resolve(options.output || "build/c0-boot-bench.json");
    const logs = output.replace(/\.json$/, "") + "-serial";
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.mkdirSync(logs, { recursive: true });
    const roots = { baseline: path.resolve(options.baseline), current: path.resolve(options.current) };
    const report = {
        schema: 1,
        started_utc: new Date().toISOString(),
        host: {
            platform: os.platform(), release: os.release(), architecture: os.arch(),
            model: os.cpus()[0].model, logical_cpus: os.cpus().length, memory_bytes: os.totalmem(),
            node: process.version, v8: process.versions.v8,
            load_average_start: os.loadavg(),
            os_version: command("sw_vers", []),
            rustc: command("rustc", ["--version"]),
            clang: command("clang", ["--version"]),
            java: command("java", ["--version"]),
        },
        method: {
            build_command: "make build/v86.wasm build/libv86.mjs (independent worktrees/target directories, WASM_OPT=false)",
            clock: "normal (default)", cpu_cores: 1, acpi: true, memory_bytes: 128 << 20,
            jit: "default", sample_count, warmups_per_revision: 1,
            order: "alternating AB/BA pairs, fresh Node process and VM each sample",
            start: "performance.now immediately before emulator.run after emulator-loaded",
            end: "serial0-output-byte callback completing Linux shell prompt '~% '",
            boot_source: "linux4.iso default bootloader/kernel command line, through SeaBIOS POST",
            excludes: "build, module import, WebAssembly instantiation and initial BIOS/image loading before emulator-loaded; guest disk I/O during boot remains included",
            workload: { bytes: workload_bytes, md5: workload_hash, command: "dd if=/dev/zero bs=1024 count=16384 2>/dev/null | md5sum" },
            boot_median_max_ratio: max_ratio,
        },
        artifacts: Object.fromEntries(Object.entries(roots).map(([label, root]) => [label, {
            root, commit: command("git", ["rev-parse", "HEAD"], root),
            working_tree: command("git", ["status", "--short", "--untracked-files=no"], root),
            wasm_sha256: hash(path.join(root, "build/v86.wasm")),
            js_sha256: hash(path.join(root, "build/libv86.mjs")),
            softfloat_sha256: hash(path.join(root, "build/softfloat.o")),
            zstd_sha256: hash(path.join(root, "build/zstddeclib.o")),
            closure_compiler_sha256: hash(path.join(root, "closure-compiler/compiler.jar")),
        }])),
        inputs: Object.fromEntries(["bios/seabios.bin", "bios/vgabios.bin", "images/linux4.iso"].map(file =>
            [file, { bytes: fs.statSync(path.join(assets, file)).size, sha256: hash(path.join(assets, file)) }])),
        runner_sha256: hash(script), warmups: [], samples: [],
    };
    const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    const run = async (label, index, warmup) => {
        const transcript = path.join(logs, `${warmup ? "warmup" : "sample"}-${index}-${label}.log`);
        let stdout;
        try
        {
            ({ stdout } = await promisify(execFile)(process.execPath, [script,
                "--sample", roots[label], "--assets", assets,
                "--timeout", String(timeout_ms), "--transcript", transcript,
            ], { timeout: timeout_ms + 15000, maxBuffer: 1024 * 1024 }));
        }
        catch(error)
        {
            report.failure = { label, index, warmup, message: String(error), transcript: path.relative(path.dirname(output), transcript) };
            save();
            throw error;
        }
        const line = stdout.split("\n").find(text => text.startsWith(marker));
        assert.ok(line, "child returned a measured result");
        const result = { label, index, transcript: path.relative(path.dirname(output), transcript), ...JSON.parse(line.slice(marker.length)) };
        report[warmup ? "warmups" : "samples"].push(result);
        save();
        console.log(`${warmup ? "warmup" : "sample"} ${index} ${label}: boot ${result.boot_wall_ms.toFixed(1)} ms, workload ${result.workload_wall_ms.toFixed(1)} ms`);
    };
    save();
    await run("baseline", 0, true);
    await run("current", 0, true);
    for(let index = 1; index <= sample_count; index++)
    {
        for(const label of index % 2 ? ["baseline", "current"] : ["current", "baseline"])
        {
            await run(label, index, false);
        }
    }
    const median = values => {
        values.sort((a, b) => a - b);
        return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
    };
    report.summary = Object.fromEntries(["boot_wall_ms", "workload_wall_ms"].map(metric => {
        const baseline = median(report.samples.filter(sample => sample.label === "baseline").map(sample => sample[metric]));
        const current = median(report.samples.filter(sample => sample.label === "current").map(sample => sample[metric]));
        return [metric, { baseline_median: baseline, current_median: current, ratio: current / baseline }];
    }));
    report.passed = report.summary.boot_wall_ms.ratio <= max_ratio;
    report.finished_utc = new Date().toISOString();
    report.host.load_average_end = os.loadavg();
    save();
    console.log(JSON.stringify({ passed: report.passed, ...report.summary, output }, null, 2));
    if(!report.passed) process.exitCode = 1;
}
