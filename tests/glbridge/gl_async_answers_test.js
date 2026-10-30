#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
async function fixture() {
    const { host, log } = createFakeHost(), writes = [];
    const executor = new GLWebGPUExecutor(null, { host, readbackTimeoutMs: 5,
        writeGuestMemory: (offset, data) => writes.push([offset, data.slice()]) });
    await executor.initialize();
    return { executor, log, writes };
}
const status = response => response.view.getUint32(P.F.READ_PIXELS.status, true);
const stream = () => new GLStream().makeCurrent(1, 0, 0, 64, 64).call("CLEAR", GL.COLOR_BUFFER_BIT);
test("an immediate readback failure is written across the worker boundary", async () => {
    const { executor, writes } = await fixture();
    const s = stream(), response = s.readPixels(0, 0, 1, 1, GL.RGBA, 0xDEADBEEF, 4);
    executor.submit(s.bytes(), {});
    assert.equal(status(response), 2); assert.equal(new DataView(writes.at(-1)[1].buffer).getUint32(0, true), 2);
    assert.ok(response.bytes.subarray(32).every(b => b === 0xCD));
});
test("a short readback record fails without writing past its declared extent", async () => {
    const { executor, writes } = await fixture();
    const s = stream(), response = s.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);
    response.view.setUint32(P.F.READ_PIXELS.data_size, 1000, true);
    executor.submit(s.bytes(), {});
    assert.equal(status(response), 2); assert.equal(writes.at(-1)[1].length, 4);
});
test("a GPU mapping timeout answers FAILED, releases staging and ignores late success", async () => {
    const { executor, log, writes } = await fixture();
    let resolve;
    const create = executor.device.createBuffer.bind(executor.device);
    executor.device.createBuffer = desc => { const b = create(desc); if (desc.label === "GL readback") b.mapAsync = () => new Promise(done => { resolve = done; }); return b; };
    const s = stream(), response = s.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);
    executor.submit(s.bytes(), {});
    assert.equal(status(response), 0, "the answer must still be pending at submission");
    await executor.idle();
    assert.equal(status(response), 2); assert.ok(response.bytes.subarray(32).every(b => b === 0xCD));
    assert.ok(log.buffers.find(b => b.descriptor.label === "GL readback").destroyed);
    const count = writes.length; resolve();
    for (let i = 0; i < 10; ++i) await Promise.resolve();
    assert.equal(writes.length, count); assert.equal(status(response), 2);
});
test("glFinish has a bounded fence and never overwrites a timeout with late success", async () => {
    const { executor, writes } = await fixture(); let resolve;
    executor.device.queue.onSubmittedWorkDone = () => new Promise(done => { resolve = done; });
    const s = stream().record(P.GLFN.FINISH, new Uint8Array(4)), response = s.payloadView();
    executor.submit(s.bytes(), {}); assert.equal(response.view.getUint32(0, true), 0);
    await executor.idle(); assert.equal(response.view.getUint32(0, true), 2);
    const count = writes.length; resolve();
    for (let i = 0; i < 10; ++i) await Promise.resolve();
    assert.equal(writes.length, count); assert.equal(response.view.getUint32(0, true), 2);
});
test("a synchronous fence exception also completes glFinish with failure", async () => {
    const { executor } = await fixture(); executor.device.queue.onSubmittedWorkDone = () => { throw new Error("lost queue"); };
    const s = stream().record(P.GLFN.FINISH, new Uint8Array(4)), response = s.payloadView();
    executor.submit(s.bytes(), {}); await executor.idle(); assert.equal(response.view.getUint32(0, true), 2);
});
test("a stalled occlusion mapping becomes available and conservatively visible", async () => {
    const { executor, log } = await fixture();
    const create = executor.device.createBuffer.bind(executor.device);
    executor.device.createBuffer = desc => { const b = create(desc); if (desc.label === "GL occlusion readback") b.mapAsync = () => new Promise(() => {}); return b; };
    executor.submit(stream().names(P.GLFN.GEN_QUERIES, [1]).call("BEGIN_QUERY", GL.SAMPLES_PASSED, 1)
        .call("END_QUERY", GL.SAMPLES_PASSED).bytes(), {});
    executor.flushFrame(); await executor.idle();
    assert.equal(executor.queries.get(1).ready, true); assert.ok(executor.queries.get(1).result > 0);
    assert.ok(log.buffers.find(b => b.descriptor.label === "GL occlusion readback").destroyed);
});
test("stale local aliases are not written, while heartbeat writes remain arena scoped", async () => {
    const { executor, writes } = await fixture();
    const bytes = new Uint8Array(16).fill(0xCD), metadata = { isInlineMemoryValid: () => false, responseBase: 0 };
    executor.answerGuest(bytes, metadata, [[0, new Uint8Array([1])]]);
    assert.ok(bytes.every(b => b === 0xCD)); assert.equal(writes.length, 0);
    let inline;
    executor.options.writeGuestMemory = (offset, data, meta, scope) => { inline = scope; };
    executor.beat(metadata); assert.equal(inline, false);
});
(async () => {
    for (const { name, fn } of tests) { await fn(); console.log("ok   " + name); }
    console.log(tests.length + " asynchronous GL response tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
