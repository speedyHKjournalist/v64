#!/usr/bin/env node
// W1/C3 soak (docs/acpi-x86-64-multicore-plan.zh-CN.md): linux4 on cores in
// vCPU workers for SOAK_MINUTES. Each iteration starts a workload on every
// core (arithmetic whose results are checked, a pipe and a tmpfs file with
// checksums), and while it runs pauses and resumes the machine and takes and
// restores a snapshot; every SOAK_SLEEP_EVERY iterations the guest suspends
// to RAM and an RTC alarm wakes it (a suspend the kernel aborts because the
// alarm came first is counted, not failed: the host was too slow for the
// alarm's lead). The kernel log must stay free of oopses,
// soft lockups, RCU stalls and hung tasks, every CPU keeps taking local timer
// interrupts, and the time keeps moving forward.
//
// SOAK_MINUTES (60), CPU_CORES (4), DISABLE_JIT=1, SOAK_SLEEP_EVERY (5),
// SOAK_ALARM_SECONDS (5).
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PARALLEL_WASM, Shell, linux4_options, value_of } from "./guest.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const minutes = +(process.env.SOAK_MINUTES || 60), cores = +(process.env.CPU_CORES || 4);
const jit = !+process.env.DISABLE_JIT, sleep_every = +(process.env.SOAK_SLEEP_EVERY || 5);
const alarm_seconds = +(process.env.SOAK_ALARM_SECONDS || 5);
const emulator = new V86({ ...linux4_options(), wasm_path: PARALLEL_WASM, memory_size: 128 << 20,
    cpu_cores: cores, parallel: true, experimental_smp_jit: jit, disable_jit: !jit });
const errors = [];
emulator.add_listener("emulator-error", error => errors.push(error));
const shell = new Shell(emulator, "soak");
const started = Date.now();
await shell.boot(600000);
console.log(`booted with ${cores} cores in ${((Date.now() - started) / 1000).toFixed(0)} s`);

const loc = async () => {
    const text = await shell.run("grep LOC /proc/interrupts");
    return text.match(/LOC:((?:\s+\d+)+)/)[1].trim().split(/\s+/).map(Number);
};
const workload = `rm -f /tmp/soak.out; for i in $(seq ${cores}); do (s=0; j=0; while [ $j -lt 3000 ]; do j=$((j+1)); s=$((s+j*i)); done; echo R$i=$s >> /tmp/soak.out) & done; ` +
    `seq 1 5000 | md5sum > /tmp/soak.md5; dd if=/dev/urandom of=/tmp/soak.bin bs=1k count=256 2>/dev/null; md5sum /tmp/soak.bin > /tmp/soak.bin.md5; wait; ` +
    "echo WORK_DONE=1";
const PIPE_MD5 = (await shell.run("seq 1 5000 | md5sum")).match(/[0-9a-f]{32}/)[0];
const stats = { iterations: 0, stops: 0, snapshots: 0, sleeps: 0, aborted_suspends: 0 };
let suspends = 0;
emulator.add_listener("acpi-sleep", () => suspends++);
let last_loc = await loc(), last_uptime = 0;
// on a failure: every core, the workers and the serial console's interrupt
process.on("uncaughtException", error => {
    try
    {
        const cpu = emulator.v86.cpu, uart = cpu.devices.uart0;
        const ioapic = new Uint32Array(cpu.wasm_memory.buffer, cpu.get_ioapic_addr(), 52);
        const d = cpu.get_diagnostics();
        console.error("SOAK_FAILURE_STATE " + JSON.stringify({ stats, cores: d.cores.map(c => ({ state: c.state, ip: c.linear_ip,
            halted: c.halted, if: c.interrupts_enabled, irr: c.apic_irr, isr: c.apic_isr, retired: c.retired_instructions })),
            parallel: d.parallel, uart: { ier: uart.ier, iir: uart.iir, ints: uart.ints, lsr: uart.lsr, input: uart.input.length },
            ioapic4: { config: ioapic[4] >>> 0, destination: ioapic[28] >>> 0, irr: ioapic[50] & 16, line: ioapic[51] & 16 },
            code: { refused: cpu.wm.exports.parallel_code_stat(0), published: cpu.wm.exports.parallel_code_stat(1) } }));
    }
    catch(e) { console.error("(no failure state: " + e + ")"); }
    console.error(error);
    process.exit(1);
});
while(Date.now() - started < minutes * 60000)
{
    stats.iterations++;
    shell.serial = "";
    emulator.serial0_send(workload + "\n");
    // while the workload runs on every core: pauses, and a snapshot restored in place
    for(let i = 0; i < 3; i++)
    {
        await delay(200 + Math.random() * 800);
        await emulator.stop();
        stats.stops++;
        emulator.run();
    }
    await delay(300);
    const state = await emulator.save_state();
    await emulator.restore_state(state);
    stats.snapshots++;
    emulator.run();
    await shell.wait(/WORK_DONE=1[\s\S]*~% $/, "the workload", 600000);
    const results = await shell.run("cat /tmp/soak.out; cat /tmp/soak.md5; md5sum -c /tmp/soak.bin.md5 && echo FILE_OK=1");
    for(let i = 1; i <= cores; i++) assert.equal(+value_of(results, "R" + i), i * 3000 * 3001 / 2, `core workload ${i}`);
    assert.ok(results.includes(PIPE_MD5), "pipe checksum");
    assert.equal(value_of(results, "FILE_OK"), "1", "tmpfs file checksum");
    if(stats.iterations % sleep_every === 0)
    {
        const suspends_before = suspends;
        const woke = new Promise(resolve => emulator.add_listener("acpi-wake", resolve));
        shell.serial = "";
        const returned = shell.wait(/SLEPT=\d+[\s\S]*~% $/, "echo mem", 300000);
        const slept = () => (shell.serial.match(/SLEPT=(\d+)/) || [])[1];
        emulator.serial0_send(`echo 0 > /sys/class/rtc/rtc0/wakealarm; echo +${alarm_seconds} > /sys/class/rtc/rtc0/wakealarm; ` +
            "echo mem > /sys/power/state; echo SLEPT=$?\n");
        const first = await Promise.race([woke, returned.then(() => "returned"), delay(120000).then(() => "timeout")]);
        if(first === "returned" && suspends === suspends_before && slept() !== "0")
        {
            // the kernel gave up before S3 (e.g. the alarm fired while suspending)
            stats.aborted_suspends++;
            console.log("suspend aborted by the guest:", (await shell.run("dmesg | grep -i -E 'abort|wakeup|PM:' | tail -5")).trim().split("\n").slice(-5).join(" | "));
            assert.ok(stats.aborted_suspends <= Math.max(2, stats.sleeps / 4), "too many aborted suspends");
        }
        else
        {
            const cpu = emulator.v86.cpu;
            assert.equal(first === "returned" ? await Promise.race([woke, delay(1000).then(() => "none")]) : first, "rtc",
                `RTC wake from S3 (suspends ${suspends - suspends_before}); acpi ${JSON.stringify(cpu.get_diagnostics().acpi)}; serial ${JSON.stringify(shell.serial.slice(-2000))}`);
            await returned;
            assert.equal(slept(), "0", "echo mem succeeded");
            stats.sleeps++;
        }
    }
    const health = await shell.run("echo PROBLEMS=$(dmesg | grep -c -i -E 'BUG:|Oops|soft lockup|rcu_sched self-detected|rcu.*stall|hung_task|blocked for more than') " +
        "UP=$(cut -d. -f1 /proc/uptime) ONLINE=$(cat /sys/devices/system/cpu/online)");
    assert.equal(+value_of(health, "PROBLEMS"), 0, "kernel log problems:\n" + await shell.run("dmesg | tail -40"));
    assert.equal(value_of(health, "ONLINE"), `0-${cores - 1}`, "every CPU online");
    const uptime = +value_of(health, "UP");
    assert.ok(uptime >= last_uptime, "uptime moves forward");
    last_uptime = uptime;
    const now_loc = await loc();
    now_loc.forEach((count, cpu) => assert.ok(count > last_loc[cpu], `CPU ${cpu} takes timer interrupts`));
    last_loc = now_loc;
    assert.equal(errors.length, 0, "emulator errors: " + errors);
    if(stats.iterations % 5 === 0 || Date.now() - started >= minutes * 60000)
    {
        const steps = emulator.v86.cpu.get_diagnostics().parallel.cores.map(c => c.steps);
        console.log(`${((Date.now() - started) / 60000).toFixed(1)} min: ${JSON.stringify(stats)} uptime ${uptime}s worker steps ${steps.join("/")}`);
    }
}
await emulator.destroy();
console.log(`SOAK_PASS ${minutes} min ${JSON.stringify(stats)}`);
