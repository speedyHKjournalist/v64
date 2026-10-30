"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_state.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_buffers.js");
require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");
const { V86GraphicsProxy } = require("../../src/browser/glbridge/graphics_proxy.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const wasm = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
function opcodes(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = [];
    for (let at = 0; at < bytes.length;) {
        result.push(view.getUint16(at, true)); let size = view.getUint16(at + 2, true); at += 4;
        if (size === 0xFFFF) { size = view.getUint32(at, true); at += 4; } at += size;
    }
    return result;
}
(async () => {
    for (const remote of [false, true]) {
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const bridge = global.installV86GLNetworkBridge(null, null, { managedState: true, glExecutor: gpu,
            d3d9Executor: { options: {}, work: Promise.resolve() }, compositor: new V86WebGPUCompositor({ width: 64, height: 64 }) });
        bridge.ready = Promise.resolve();
        bridge.destroy = async () => { bridge.destroyed = true; await bridge.graphicsJournal.destroy(); };
        const executed = [], execute = bridge.executePCIBatch.bind(bridge);
        bridge.executePCIBatch = (event, bytes) => { executed.push(bytes.slice()); return execute(event, bytes); };
        const memory = new Uint8Array(16 * 1024 * 1024), arena = 0x100000, queue = [], messages = [];
        let cpuListener, hostListener, reply;
        const device = createV86GLDevice({ remote, listen: fn => { cpuListener = fn; }, post: message => { messages.push(message); hostListener(message); } });
        device.init({ is_feature_negotiated: () => true, has_request: () => !!queue.length, pop_request: () => queue.shift(),
            flush() {}, needs_reset() { throw new Error("unexpected reset"); }, is_ram: () => true,
            read_memory: (at, count) => memory.subarray(at - arena, at - arena + count),
            write_memory: (bytes, at) => memory.set(bytes, at - arena) });
        const proxy = V86GraphicsProxy({ createBridge: () => bridge, glslang: wasm });
        await proxy.start({ emulator: {}, screen: { canvas: {}, set_backend() {}, fallback() {}, is_graphical: () => true },
            channel: { remote, listen: fn => { hostListener = fn; }, post: message => cpuListener(message) } });
        function request(words) {
            queue.push({ readable: 24, writable: 16, read: () => new Uint8Array(new Uint32Array(words).buffer),
                write: bytes => { reply = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true); }, complete() {} });
            device.notify(); assert.equal(reply, 0);
        }
        request([1, arena, 0, memory.length, 0, 0]);
        async function submit(stream) {
            const bytes = stream.bytes(), header = new DataView(memory.buffer);
            header.setUint32(0, 0x324C4756, true); header.setUint32(4, 1, true); header.setUint32(20, bytes.length, true);
            memory.set(bytes, 32); request([2, 0, 0, 32 + bytes.length, 0, 0]);
            await proxy.idle(); await gpu.idle(); stream.buffer.set(memory.subarray(32, 32 + bytes.length));
        }
        const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1).call("LINE_WIDTH", -1).call("LINE_WIDTH", 3);
        const badHeader = P.encodeRecord("BUFFER_DATA", { target: 0, size: 131072, data_size: 131072 }), bad = new Uint8Array(badHeader.length + 131072);
        bad.set(badHeader); stream.record(P.GLFN.BUFFER_DATA, bad).call("CLEAR_COLOR", 0.25, 0.5, 0.75, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);
        stream.queryError(); const firstError = stream.payloadView();
        const pixel = stream.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);
        await submit(stream);
        assert.equal(firstError.view.getUint32(P.F.QUERY_ERROR.status, true), 1);
        assert.equal(firstError.view.getUint32(P.F.QUERY_ERROR.value, true), GL.INVALID_VALUE);
        assert.equal(pixel.view.getUint32(P.F.READ_PIXELS.status, true), 1, "asynchronous response keeps the original offset after a large rejected record");
        assert.equal(gpu.current.lineWidth, 3); assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0);
        assert.ok(messages.find(m => m.type === "batch").segments.length > 1);
        assert.ok(executed.flatMap(opcodes).every(fn => !P.isRejected(fn)), "only accepted commands reach the renderer and journal");
        const count = executed.length, commands = gpu.stats.commands, journal = bridge.glJournalBytes;
        await submit(new GLStream().call("LINE_WIDTH", -2));
        assert.deepEqual(messages.at(-1).segments, []); assert.equal(executed.length, count);
        assert.equal(gpu.stats.commands, commands); assert.equal(bridge.glJournalBytes, journal);
        const error = async expected => {
            const s = new GLStream(); s.queryError(); const q = s.payloadView(); await submit(s);
            assert.equal(q.view.getUint32(P.F.QUERY_ERROR.status, true), 1);
            assert.equal(q.view.getUint32(P.F.QUERY_ERROR.value, true), expected);
        };
        await error(GL.INVALID_VALUE); await error(GL.NO_ERROR);
        gpu.current.error = GL.INVALID_ENUM; await error(GL.INVALID_ENUM); await error(GL.NO_ERROR);
        gpu.current.error = GL.INVALID_ENUM;
        await submit(new GLStream().call("LINE_WIDTH", -2));
        await error(GL.INVALID_VALUE); await error(GL.INVALID_ENUM); await error(GL.NO_ERROR);
        assert.equal(gpu.stats.refusals, 0);
        const last = messages.filter(m => m.type === "batch").at(-1), beforeInvalid = executed.length;
        const invalidRanges = [[{ offset: 0, length: 4 }, { offset: 2, length: 4 }],
            [{ offset: -1, length: 4 }], [{ offset: 0, length: last.bytes.length + 1 }]];
        const originalError = console.error, errors = []; console.error = (...args) => errors.push(args);
        try {
            for (const segments of invalidRanges) {
                const message = { ...last, id: last.id + 10000, segments };
                if (remote) { hostListener(message); await proxy.idle(); }
                else assert.throws(() => hostListener(message), /invalid CPU-validated graphics segment/);
            }
        } finally { console.error = originalError; }
        assert.equal(executed.length, beforeInvalid, "validate all segment ranges before executing any prefix");
        assert.equal(errors.length, remote ? invalidRanges.length : 0);
        await proxy.destroy();
    }
    console.log("gl_cpu_forwarding_test: actual device/proxy/bridge filter rejections, keep readback offsets and preserve CPU/renderer errors in both modes (passed)");
})().catch(error => { console.error(error); process.exitCode = 1; });
