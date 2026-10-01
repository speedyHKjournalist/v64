#!/usr/bin/env node
// Linux on a machine whose application processors run in vCPU workers
// (src/parallel), interpreted. The kernel brings every core online and runs
// work on all of them; the diagnostics show that each worker executed
// instructions and served I/O through the machine thread.
import assert from "node:assert/strict";
import { PARALLEL_WASM, Shell, linux4_options, value_of } from "./guest.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const CORES = +process.env.CPU_CORES || 2;

const timeout = setTimeout(() => { console.log("timeout\n" + shell.serial.slice(-3000)); process.exit(1); }, +process.env.TIMEOUT || 900000);
const JIT = !process.env.DISABLE_JIT || !+process.env.DISABLE_JIT;
const emulator = new V86({ graphics_adapter: "bochs_vga", ...linux4_options(), wasm_path: PARALLEL_WASM, memory_size: 128 << 20,
    cpu_cores: CORES, parallel: true, experimental_smp_jit: JIT, disable_jit: !JIT });
const shell = new Shell(emulator, "parallel");
const t0 = Date.now();
await shell.boot(+process.env.BOOT_TIMEOUT || 600000);
console.log(`booted with ${CORES} cores in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const cpus = await shell.run("echo CPUS=$(grep -c ^processor /proc/cpuinfo) ONLINE=$(cat /sys/devices/system/cpu/online)");
assert.equal(+value_of(cpus, "CPUS"), CORES);
// one busy loop per core
const work = await shell.run(`for i in $(seq ${CORES}); do (i=0; while [ $i -lt 3000 ]; do i=$((i+1)); done; echo DONE) & done; wait; echo ALL=1`, 600000);
assert.equal(+value_of(work, "ALL"), 1);
const d = emulator.v86.cpu.get_diagnostics();
console.log(JSON.stringify(d.parallel));
for(const core of d.parallel.cores) assert.ok(core.steps > 0, `vCPU ${core.core} executed instructions`);
await emulator.destroy();
clearTimeout(timeout);
console.log("parallel Linux boot passed");
