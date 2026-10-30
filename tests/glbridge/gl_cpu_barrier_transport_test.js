"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_state.js");
require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js"), { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js"),
    { V86GraphicsProxy } = require("../../src/browser/glbridge/graphics_proxy.js"), { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
let waiting, next = 0;
GLShadow.part({ routeRecord(s, fn, bytes, view, offset) {
    if (fn !== P.GLFN.POINT_SIZE || view.getFloat32(offset, true) !== 13) return;
    s.blockCPU(++next); waiting = s; return { commands: [] };
} });
const wasm = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
function query(stream) {
    const bytes = new Uint8Array(32); bytes.set(P.encodeRecord("QUERY_STATE", { pname: GL.POINT_SIZE, value_kind: P.C.V86GL_STATE_FLOAT, data_size: 8 }));
    stream.record(P.GLFN.QUERY_STATE, bytes); return stream.payloadView();
}
(async () => {
    for (const remote of [false, true]) {
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        let swaps = 0; gpu.onSwapBuffers = () => { ++swaps; };
        const bridge = global.installV86GLNetworkBridge(null, null, { managedState: true, glExecutor: gpu,
            d3d9Executor: { options: {}, work: Promise.resolve(), endOwnerSessions() {} }, compositor: new V86WebGPUCompositor({ width: 32, height: 32 }) });
        bridge.ready = Promise.resolve(); bridge.destroy = async () => { bridge.destroyed = true; await bridge.graphicsJournal.destroy(); };
        const memory = new Uint8Array(16 * 1024 * 1024), arena = 0x100000, requests = [], replies = [], messages = [];
        let cpu, page;
        const device = createV86GLDevice({ remote, listen: handler => { cpu = handler; }, post: message => { messages.push(message); page(message); } });
        device.init({ is_feature_negotiated: () => true, has_request: () => requests.length > 0, pop_request: () => requests.shift(), flush() {}, needs_reset() { throw new Error("unexpected reset"); }, is_ram: () => true,
            read_memory: (at, size) => memory.subarray(at - arena, at - arena + size), write_memory: (bytes, at) => memory.set(bytes, at - arena) });
        const proxy = V86GraphicsProxy({ createBridge: () => bridge, glslang: wasm });
        await proxy.start({ emulator: {}, screen: { canvas: {}, set_backend() {}, fallback() {}, is_graphical: () => true },
            channel: { remote, listen: handler => { page = handler; }, post: message => cpu(message) } });
        const request = words => { requests.push({ readable: 24, writable: 16, read: () => new Uint8Array(new Uint32Array(words).buffer),
            write: bytes => replies.push(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)), complete() {} }); device.notify(); };
        request([1, arena, 0, memory.length, 0, 0]); assert.deepEqual(replies, [0]);
        function submit(stream, present = false) {
            const bytes = stream.bytes(), header = new DataView(memory.buffer);
            header.setUint32(0, 0x324C4756, true); header.setUint32(4, 1, true); header.setUint32(8, +present, true); header.setUint32(20, bytes.length, true);
            memory.set(bytes, 32); request([2, 0, 0, bytes.length + 32, 0, 0]);
        }
        const first = new GLStream().makeCurrent(1, 0, 0, 32, 32, 1, 1).call("LINE_WIDTH", 3).call("POINT_SIZE", 13).call("LINE_WIDTH", 5), answer = query(first);
        submit(first, true); await proxy.idle();
        assert.deepEqual(replies, [0], "submitting IOCTL remains pending while CPU state depends on the GPU");
        assert.equal(gpu.current.lineWidth, 3); assert.equal(swaps, 0); assert.equal(waiting.current.state.values[GL.LINE_WIDTH][0], 3);
        waiting.current.state.values[GL.POINT_SIZE] = [7]; waiting.resumeCPU(next, [new GLStream().call("POINT_SIZE", 7).bytes()]); await proxy.idle(); await gpu.idle();
        assert.deepEqual(replies, [0, 0]); assert.equal(gpu.current.lineWidth, 5); assert.equal(gpu.current.pointSize, 7); assert.equal(swaps, 1, "present follows the final continuation only");
        first.buffer.set(memory.subarray(32, 32 + first.length)); assert.equal(answer.view.getUint32(P.F.QUERY_STATE.status, true), 1); assert.equal(answer.view.getFloat64(24, true), 7);
        assert.ok(messages.filter(m => m.type === "batch" && m.continuation).length >= 2);
        const second = new GLStream().call("POINT_SIZE", 13); query(second); submit(second); await proxy.idle();
        request([3, 0, 0, 0, 0, 0]); assert.equal(replies.length, 2, "later descriptors stay queued behind the state dependency");
        waiting.current.state.values[GL.POINT_SIZE] = [9]; waiting.resumeCPU(next); await proxy.idle();
        assert.deepEqual(replies, [0, 0, 0, 0]); assert.equal(waiting.cpuBarrier, null);
        request([1, arena, 0, memory.length, 0, 0]);
        submit(new GLStream().makeCurrent(2, 0, 0, 32, 32, 2, 2).call("POINT_SIZE", 13)); await proxy.idle(); const beforeLoss = replies.length;
        cpu({ type: "available", value: false }); assert.equal(replies.length, beforeLoss + 1); assert.equal(replies.at(-1), 3, "renderer loss completes the held IOCTL");
        assert.equal(waiting.cpuBarrier, null); assert.equal(waiting.deferredCPUBytes, 0); assert.equal(gpu.hostErrors.length, 0);
        await proxy.destroy();
    }
    console.log("gl_cpu_barrier_transport_test: retained IOCTLs, deferred replies, continuations/present, queue order and renderer loss passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
