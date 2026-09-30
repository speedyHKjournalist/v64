"use strict";
const assert = require("node:assert/strict");
const { D3D9WebGPUExecutor } = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
const { GraphicsJournal } = require("../../src/browser/glbridge/graphics_journal.js");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
(async () => {
    const { GraphicsPerformance } = await import("../../src/browser/graphics_performance.js");
    let now = 0, cpu = 0, presents = 0, fences = 0;
    const raf = new Map(), listeners = new Map();
    let rafId = 0;
    const host = { requestAnimationFrame(fn) { raf.set(++rafId, fn); return rafId; },
        cancelAnimationFrame(id) { raf.delete(id); },
        document: { visibilityState: "visible", addEventListener(k, fn) { listeners.set(k, fn); }, removeEventListener(k) { listeners.delete(k); } } };
    const fence = deferred(), batch = deferred();
    const queue = { submit() { assert.equal(this, queue); now += 2; }, onSubmittedWorkDone() { fences++; return fence.promise; } };
    const executor = { device: { queue }, stats: { commands: 10, presents: 5 },
        options: { onPresent() { presents++; } },
        submit(bytes, metadata) { return batch.promise.then(() => this.executeBatch(bytes, metadata)); },
        executeBatch() { now += 3; this.stats.commands++; this.finishFrame(true); },
        finishFrame(present) { this.device.queue.submit([]); if (present) this.options.onPresent({ sessionKey: "a" }); } };
    const second = { device: { queue }, stats: {}, options: {} };
    const bridge = { d3d9Executor: executor, d3d8Executor: second, pushPCIBatch() {} };
    const emulator = { graphics_proxy: { bridge } };
    const originals = { submit: queue.submit, execute: executor.executeBatch, present: executor.options.onPresent };
    const recording = new GraphicsPerformance(emulator, { now: () => now, host, cpu_time: () => cpu });
    const promise = executor.submit(new Uint8Array(1), {});
    now = 30;
    batch.resolve();
    await promise;
    assert.equal(fences, 1);
    assert.equal(presents, 1, "existing presentation callback still runs");
    queue.submit([]);
    assert.equal(fences, 1, "never add another probe while one is pending");
    now = 100; cpu = 10;
    executor.options.onPresent({ sessionKey: "b" });
    now = 235; cpu = 140;
    executor.options.onPresent({ sessionKey: "a" });
    now = 300;
    executor.options.onPresent({ sessionKey: "b" });
    host.document.visibilityState = "hidden"; listeners.get("visibilitychange")();
    now = 350;
    const snapshot = recording.snapshot();
    assert.equal(snapshot.executors[0].queue_wait_ms, 30);
    assert.equal(snapshot.executors[0].execute.sync_ms, 5);
    assert.equal(snapshot.executors[0].execute_sync_ms, null, "old async executor must not report prefix timing as full sync time");
    assert.equal(snapshot.executors[0].counters.commands, 1);
    assert.equal(snapshot.gpu_queues.length, 1, "shared queue is instrumented once");
    assert.equal(snapshot.gpu_queues[0].fence.pending, 1);
    assert.equal(snapshot.streams.find(s => s.session === "a").mean_fps, 5);
    assert.equal(snapshot.streams.find(s => s.session === "b").mean_fps, 5);
    assert.equal(snapshot.hidden_ms, 50);
    assert.equal(snapshot.slow_present_intervals[0].cpu_main_loop_ms, 140);
    const report = recording.stop();
    assert.equal(queue.submit, originals.submit);
    assert.equal(executor.executeBatch, originals.execute);
    assert.equal(executor.options.onPresent, originals.present);
    assert.equal(raf.size, 0);
    assert.equal(listeners.size, 0);
    const frozen = JSON.stringify(report);
    const next = new GraphicsPerformance(emulator, { now: () => now, host: {} });
    fence.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(JSON.stringify(report), frozen, "late GPU completion cannot mutate an exported report");
    assert.equal(next.snapshot().gpu_queues[0].fence.completed, 0);
    next.stop();

    // Production async decoder: time both synchronous segments, excluding the
    // awaited operation, including work after resumption and early errors.
    now = 0;
    const wait = deferred();
    const native = Object.create(D3D9WebGPUExecutor.prototype);
    native.stats = { batches: 0, commands: 0, malformedBatches: 0 };
    native.switchSession = () => { now += 2; };
    native.dispatchCommand = () => { now += 3; return wait.promise; };
    native.finishFrame = () => { now += 4; };
    native.beat = () => { now += 1; };
    native.saveActiveSessionState = () => { now += 2; };
    native.commandSerial = 0;
    const diagnostic = new GraphicsPerformance({ graphics_proxy: { bridge: { d3d9Executor: native } } }, { now: () => now, host: {} });
    const bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
    view.setUint32(0, 0x47573944, true); view.setUint16(4, 1, true); view.setUint16(6, 3, true);
    view.setUint32(12, 1, true); view.setUint32(16, 1, true); view.setUint32(20, 16, true);
    view.setUint16(32, 0x7777, true); view.setUint32(36, 16, true);
    const operation = native.executeBatch(bytes, {});
    assert.equal(now, 5);
    now += 100; wait.resolve(); await operation;
    const measured = diagnostic.snapshot().executors[0];
    assert.equal(measured.execute.sync_ms, 5);
    assert.equal(measured.execute_sync_ms, 12, "post-await synchronous work is included; await delay is excluded");
    assert.equal(measured.execute.elapsed_ms, 112);
    await assert.rejects(native.executeBatch(new Uint8Array(0), {}));
    assert.equal(diagnostic.stop().executors[0].execute.errors, 1);
    assert.equal(Object.hasOwn(native, "performanceTiming"), false);

    // Real journal scheduling with controlled compressor completion: queue wait
    // must be distinct from service time and off-thread wall time.
    now = 0;
    const journal = new GraphicsJournal({ pageBytes: 64, worker: false, store: null });
    const compression = [];
    journal.compressor.compress = (buffer, length, measure) => {
        assert.equal(measure, true);
        const job = deferred(); compression.push(job); return job.promise;
    };
    const trace = new GraphicsPerformance({ graphics_proxy: { bridge: { graphicsJournal: journal } } }, { now: () => now, host: {} });
    const payload = new Uint8Array(32);
    journal.append({}, payload); journal.append({}, payload);
    now = 10; await Promise.resolve();
    assert.equal(compression.length, 1);
    now = 20;
    compression[0].resolve({ data: new Uint8Array(8), codec: 1, compression_backend: "worker", compression_ms: 7 });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(compression.length, 2);
    now = 30; compression[1].resolve({ data: new Uint8Array(9), codec: 1, compression_backend: "worker", compression_ms: 6 });
    await journal.work;
    const journalReport = trace.stop().journal;
    assert.equal(journalReport.queue_wait_ms, 30);
    assert.equal(journalReport.service_ms, 20);
    assert.equal(journalReport.worker_wall_ms, 13);
    assert.equal(journalReport.pending, 0);
    assert.equal(journalReport.compressed_bytes, 17);
    await journal.destroy();

    // Bounded data even with excessive distinct sessions or stalled work.
    const bounded = new GraphicsPerformance({}, { now: () => now, host: {} });
    for (let i = 0; i < 100; i++) { now += 100; bounded.frame("d3d9", String(i)); }
    assert.equal(bounded.streams.size, 16);
    for (let i = 0; i < 100; i++) { now += 100; bounded.frame("d3d9", "0"); }
    assert.equal(bounded.snapshot().slow_present_intervals.length, 32);
    const pendingMetric = { calls: 0, sync_ms: 0, elapsed_ms: 0, pending: 0, untracked: 0 };
    const stalled = deferred();
    for (let i = 0; i < 1000; i++) assert.equal(bounded.measure(pendingMetric, () => stalled.promise), stalled.promise);
    assert.equal(bounded.pending.size, 512);
    assert.equal(pendingMetric.untracked, 488);
    bounded.stop(); stalled.resolve(); await Promise.resolve();
    console.log("graphics_performance_test: timing boundaries, frames, queue probes, bounds, worker attribution and lifecycle passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
