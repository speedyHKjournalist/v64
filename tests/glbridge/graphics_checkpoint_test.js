"use strict";
const assert = require("node:assert/strict");
const { GLStream, GL, GLFN } = require("./gl_stream_builder.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const d8 = require("./d3d8_webgpu_executor_test.js");
const d9 = require("./d3d9_webgpu_executor_test.js");
const dd = require("./ddraw_webgpu_executor_test.js");
require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js");

function envelope(opcode, payload) {
    const bytes = new Uint8Array(8 + payload.byteLength);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, opcode, true);
    view.setUint16(2, 0xffff, true);
    view.setUint32(4, payload.byteLength, true);
    bytes.set(payload, 8);
    return bytes;
}
async function fixture() {
    const { host, log } = createFakeHost();
    const gl = new GLWebGPUExecutor(null, { host });
    await gl.initialize();
    const fake8 = d8.makeFakeWebGPU();
    const direct8 = new d8.D3D8WebGPUExecutor({ width: 64, height: 64,
        getContext: () => fake8.context }, { gpu: fake8.gpu });
    const direct9 = d9.makeExecutor();
    direct9.fake.device.queue.onSubmittedWorkDone = () => Promise.resolve();
    const bridge = global.installV86GLNetworkBridge(null, null, {
        compositor: new V86WebGPUCompositor({ width: 64, height: 64 }),
        managedState: true, glExecutor: gl,
        d3d8Executor: direct8, d3d9Executor: direct9.executor,
    });
    let writes = 0;
    const send = (bytes, flags = 0) => bridge.pushPCIBatch({ bytes, flags,
        descAddr: 0x100000, batchAddr: 0x100020, responseBase: 0xc00000 - 32,
        writeGuestMemory() { writes++; }, isMemoryValid: () => true });
    const save = async () => {
        await bridge.prepareSaveState();
        return bridge.serializeCheckpoint();
    };
    const restore = async bytes => {
        bridge.beginStateRestore();
        bridge.onPCIStateRestored(bytes);
        await bridge.finishStateRestore();
    };
    return { bridge, gl, log, direct8, direct9, send, save, restore, writes: () => writes };
}

const timeout = setTimeout(() => { throw new Error("checkpoint test timed out"); }, 15000);
(async () => {
    const a = await fixture();
    a.send(new GLStream().makeCurrent(1, 0, 0, 64, 64)
        .names(GLFN.GEN_QUERIES, [7, 8])
        .names(GLFN.DELETE_QUERIES, [8])
        .call("CLEAR_COLOR", 0.25, 0.5, 0.75, 1).call("CLEAR", GL.COLOR_BUFFER_BIT)
        .call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7).bytes());
    const device8 = 0x100002, buffer8 = 0x100003;
    const create8 = d8.u32Payload(device8, buffer8, 1, 16, 0, 0, 0, 0);
    const data8 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const batch8 = d8.batch([
        d8.command(1, d8.u32Payload(32, 0, 0xA0010001, 0x20260802)),
        d8.command(2, d8.createDevicePayload(device8, 64, 64)),
        d8.command(0x100, create8),
        d8.command(0x101, d8.u32Payload(buffer8, 0, 16, 0, 0, 0), data8),
        d8.command(5, d8.u32Payload(device8, 1, 0xff112233, 0x3f800000, 0, 0)),
    ], 1);
    batch8.writeUInt32LE(0, 12); // save while the frame is unfinished
    await a.send(envelope(0xffe0, batch8));
    const buffer9 = 0x201;
    const shader = d9.shaderCreatePayload(0x400, [0xffff0101, 1, 0x800f0000, 0x90e40000, 0xffff]);
    await a.send(envelope(0xffe1, d9.buildBatch([
        d9.command(d9.OP.CREATE_DEVICE, d9.createDevicePayload(64, 64)),
        d9.command(d9.OP.CREATE_BUFFER, d9.createBufferPayload(buffer9, 1, 96)),
        d9.command(d9.OP.UPDATE_BUFFER, d9.u32(buffer9, 0, 16, 0, 0, 0), data8, 12),
        d9.command(d9.OP.CREATE_PIXEL_SHADER, shader.payload, shader.blob, shader.blobOffsetField),
        d9.command(d9.OP.SET_RENDER_STATE, d9.u32(d9.DEVICE, 7, 0)),
        d9.command(d9.OP.CLEAR, d9.u32(d9.DEVICE, 1, 0xffaabbcc, 0x3f800000, 0)),
    ], { sessionLow: 1 })));
    const indices = Buffer.from([7, 9, 11, 13]);
    const texture = dd.updateTexturePayload(0x300, 2, 2, 2, indices);
    const palette = dd.palettePayload(3, i => (0xff000000 | i) >>> 0);
    await a.send(envelope(0xffe1, dd.buildBatch([
        dd.command(dd.OP.CREATE_DEVICE, dd.createDevicePayload(64, 64)),
        dd.command(dd.OP.CREATE_TEXTURE_2D,
            dd.createSurfacePayload(0x300, 2, 2, dd.FMT_P8, dd.USAGE_DDRAW_INDEXED)),
        dd.command(dd.OP.UPDATE_TEXTURE, texture.payload, texture.blob, texture.blobOffsetField),
        dd.command(dd.OP.SET_PALETTE, palette.payload, palette.blob, palette.blobOffsetField),
        dd.command(dd.OP.DD_SET_SURFACE_PALETTE, dd.u32(0x300, 3, 1, 0)),
        dd.command(dd.OP.DD_SET_COLOR_KEY, dd.u32(0x300, 0, 7, 9, 1, 0)),
        dd.command(dd.OP.DD_BLT, dd.bltPayload({ sourceHandle: 0x300,
            sourceRect: [0, 0, 2, 2], destinationRect: [0, 0, 2, 2] })),
    ], { sessionLow: 2 })));
    const snapshot = await a.save();
    assert.equal(a.direct8.frame, null, "save flushes unfinished D3D8 drawing");
    const queryState = a.gl.queries.get(7);
    assert.equal(queryState.ended, false);
    const expected9 = a.direct9.executor.sessionStates.get("0000000000000001");
    assert.ok(expected9.resources.has(0x400), "shader was created before save");
    const expectedDD = a.direct9.executor.resources.get(0x300);
    const ddPalette = JSON.stringify(expectedDD.ddPaletteIndex);
    async function checkRestored(b) {
        assert.equal(b.gl.queries.has(7), true);
        assert.equal(b.gl.queries.has(8), false);
        assert.equal(b.gl.activeQuery.name, 7, "unfinished GL query survives");
        assert.deepEqual(b.direct8.resources.get(buffer8).shadow.slice(0, 16), new Uint8Array(data8));
        const session = b.direct9.executor.sessionStates.get("0000000000000001");
        assert.deepEqual(session.resources.get(buffer9).shadow.slice(0, 16), new Uint8Array(data8));
        assert.ok(session.resources.has(0x400), "shader reconstructed");
        assert.equal(session.devices.get(d9.DEVICE).renderStates.get(7), 0);
        const surface = b.direct9.executor.resources.get(0x300);
        assert.equal(surface.ddIndexed, true);
        assert.deepEqual([...surface.textureShadows.values()][0].data.slice(0, 4), new Uint8Array(indices));
        assert.equal(JSON.stringify(surface.ddPaletteIndex), ddPalette);
        assert.ok(b.direct9.executor.palettes.size > 0);
        b.send(new GLStream().call("END_QUERY", GL.SAMPLES_PASSED).bytes());
        await b.save();
        assert.equal(b.gl.activeQuery, null);
        assert.equal(b.gl.queries.get(7).ready, true);
    }
    // Roll back all four frontends after additional commands destroyed state.
    a.send(new GLStream().names(GLFN.DELETE_QUERIES, [7]).bytes());
    await a.send(envelope(0xffe1, d9.buildBatch([
        d9.command(d9.OP.DESTROY_RESOURCE, d9.u32(buffer9)),
    ], { sessionLow: 1 })));
    const beforeWrites = a.writes();
    a.direct9.executor.failed = new Error("discarded timeline failed");
    await a.restore(snapshot);
    assert.equal(a.writes(), beforeWrites, "replay never writes historical DMA responses");
    await checkRestored(a);
    const b = await fixture();
    await b.restore(snapshot);
    assert.equal(b.writes(), 0, "cold restore never writes historical DMA responses");
    await checkRestored(b);
    // Saving a restored guest must retain its complete ancestry.
    const second = await b.save();
    const c = await fixture();
    await c.restore(second);
    assert.equal(c.gl.queries.get(7).ready, true);
    assert.ok(c.direct9.executor.resources.has(0x300));
    // Large legal GL batches used to overflow Array.push's argument stack.
    const large = new GLStream();
    for (let i = 0; i < 150000; i++) large.call("LOAD_IDENTITY");
    const commands = c.gl.stats.commands;
    c.send(large.bytes());
    assert.equal(c.gl.stats.commands - commands, 150000);
    const malformed = snapshot.slice();
    new DataView(malformed.buffer).setUint32(32, 0xffffffff, true);
    assert.throws(() => c.bridge.parseCheckpoint(malformed), /invalid/i);
    // A fence response must reach guest memory before save resolves. Executor
    // idle() intentionally waits only for decoding; checkpointIdle() includes
    // asynchronous query completion as well.
    const q = await fixture();
    let completeFence;
    const fence = new Promise(resolve => { completeFence = resolve; });
    q.direct9.fake.device.queue.onSubmittedWorkDone = () => fence;
    await q.send(envelope(0xffe1, d9.buildBatch([
        d9.command(d9.OP.CREATE_DEVICE, d9.createDevicePayload(64, 64)),
        d9.command(d9.OP.CREATE_QUERY, d9.u32(d9.DEVICE, 0x902, 8, 0)),
        d9.command(d9.OP.END_QUERY, d9.u32(d9.DEVICE, 0x902, 0, 41)),
    ], { versionMinor: 3 })));
    const writesBeforeFence = q.writes();
    let savedQuery = false;
    const querySave = q.save().then(value => { savedQuery = true; return value; });
    for (let i = 0; i < 10; ++i) await Promise.resolve();
    assert.equal(savedQuery, false);
    completeFence();
    const querySnapshot = await querySave;
    assert.ok(q.writes() > writesBeforeFence, "save includes completed query DMA responses");
    const queryWrites = q.writes();
    await q.restore(querySnapshot);
    assert.equal(q.writes(), queryWrites, "query replay cannot overwrite restored DMA responses");

    console.log("graphics_checkpoint_test: four APIs, hot/cold restore, query continuation, DMA isolation and large batches passed");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
