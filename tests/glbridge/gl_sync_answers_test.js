#!/usr/bin/env node
// What the guest reads back for an OpenGL query, end to end -- v86gl_device.js
// takes the batch from guest memory, graphics_proxy.js hands it to the
// renderer, the GL executor answers -- in both of the proxy's modes: the
// page's, where the renderer runs beside the CPU and the batch the executor
// writes its answers into IS guest memory, and the CPU worker's (the site's
// default), where the batch crosses to the renderer as a copy.
//
// The worker mode loses every answer today (docs/opengl-webgpu-review.md
// S1-1; plan stage C moves the answers to the CPU side): it is a known
// failure here, and this test fails once it passes, to be updated.
"use strict";

const assert = require("node:assert/strict");
require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");
const { V86GraphicsProxy } = require("../../src/browser/glbridge/graphics_proxy.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream } = require("./gl_stream_builder.js");

const KNOWN_FAILURES = { worker: "S1-1: the executor answers into a copy of the batch" };

const ARENA = 0x100000, ARENA_BYTES = 16 * 1024 * 1024, HEADER = 32;
const SYNC_STATUS_OK = 1;

async function guestAnswers(remote) {
    const memory = new Uint8Array(ARENA + ARENA_BYTES);
    // the two ends of the channel; across threads a message is a copy
    let toRenderer = null, toDevice = null;
    const pass = message => remote ? globalThis.structuredClone(message) : message;
    const deviceEnd = { remote, post: message => toRenderer(pass(message)), listen: handler => { toDevice = handler; } };
    const rendererEnd = { remote, post: message => toDevice(pass(message)), listen: handler => { toRenderer = handler; } };

    const queue = [];
    const handle = {
        is_feature_negotiated: () => true,
        has_request: () => queue.length > 0,
        pop_request: () => queue.shift(),
        flush() {},
        needs_reset() { throw new Error("needs_reset"); },
        is_ram: () => true,
        read_memory: (address, length) => memory.subarray(address, address + length),
        write_memory: (bytes, address) => memory.set(bytes, address),
    };
    const request = words => new Promise(resolve => {
        queue.push({ readable: 24, writable: 16, read: () => new Uint8Array(new Uint32Array(words).buffer),
            write: reply => resolve(new Uint32Array(reply.buffer, reply.byteOffset, 4)[0]), complete() {} });
        device.notify();
    });
    const device = createV86GLDevice(deviceEnd);
    device.init(handle);

    const { host } = createFakeHost();
    const executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    const plugin = V86GraphicsProxy({ createBridge: () => {
        const bridge = global.installV86GLNetworkBridge(null, null, {
            compositor: new V86WebGPUCompositor({ width: 64, height: 64 }), glExecutor: executor, d3d9Executor: null });
        bridge.ready = Promise.resolve();
        return bridge;
    } });
    await plugin.start({ emulator: {}, channel: rendererEnd,
        screen: { canvas: {}, set_backend() {}, fallback() {}, is_graphical: () => true } });

    assert.equal(await request([1, ARENA, 0, ARENA_BYTES, 0, 0]), 0, "the arena registers");
    // one batch: a context, then glGetError and glGetString(GL_VENDOR)
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64);
    // (each record: a 4-byte header, then the payload; the status word is
    // the payload's first for glGetError, its second for glGetString)
    const errorAt = stream.length + 4;
    stream.queryError();
    const stringAt = stream.length + 4 + 4;
    stream.queryString(0x1F00, 64);
    const bytes = stream.bytes();
    const header = new DataView(memory.buffer, ARENA, HEADER);
    header.setUint32(0, 0x324C4756, true);
    header.setUint32(4, 1, true);
    header.setUint32(12, 7, true);
    header.setUint32(16, 1, true);
    header.setUint32(20, bytes.byteLength, true);
    memory.set(bytes, ARENA + HEADER);
    assert.equal(await request([2, 0, 0, HEADER + bytes.byteLength, 0, 0]), 0, "the batch is taken");
    await plugin.idle();
    const view = new DataView(memory.buffer, ARENA + HEADER);
    return { error: view.getUint32(errorAt, true), string: view.getUint32(stringAt, true) };
}

(async () => {
    const failures = [];
    for (const [mode, remote] of [["page", false], ["worker", true]]) {
        const answers = await guestAnswers(remote);
        const answered = answers.error === SYNC_STATUS_OK && answers.string === SYNC_STATUS_OK;
        if (KNOWN_FAILURES[mode]) {
            if (answered) failures.push(mode + " answers now: delete its known failure (" + KNOWN_FAILURES[mode] + ")");
            else console.log("known " + mode + ": " + KNOWN_FAILURES[mode]);
        } else if (!answered) {
            failures.push(mode + ": the guest read status " + JSON.stringify(answers));
        }
    }
    if (failures.length) {
        console.error(failures.join("\n"));
        process.exitCode = 1;
        return;
    }
    console.log("gl_sync_answers_test: the page mode answers the guest; the worker mode's loss is known (passed)");
})();
