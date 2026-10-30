"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_textures.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_buffers.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor, unpackReadback } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const cases = require("./gl_texture_readback_cases.js");
const reference = require("./gl_conformance/texture_readback_reference.json");
const F = P.F.QUERY_TEXTURE_IMAGE, H = P.RECORDS.QUERY_TEXTURE_IMAGE.size;
(async () => {
    for (const copied of [false, true]) for (const [i, entry] of reference.cases.entries()) {
        const shadow = new GLShadow(); shadow.setCapabilities(caps.capabilities({}, {}));
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        async function submit(stream) {
            const bytes = stream.bytes(); shadow.process(bytes);
            gpu.options.writeGuestMemory = (offset, data) => bytes.set(data, offset);
            gpu.submit(copied ? bytes.slice() : bytes, {}); await gpu.idle();
            return bytes;
        }
        const setup = cases.setup(entry, i + 1);
        const meta = cases.query(setup, { target: entry.target, level: entry.level, format: entry.format, type: entry.type,
            compressed: +entry.compressed, pointer: entry.pointer });
        await submit(setup);
        assert.equal(meta.view.getUint32(F.error, true), entry.error, entry.name);
        assert.equal(meta.view.getUint32(F.status, true), entry.error ? 2 : 1, entry.name);
        if (entry.error) continue;
        const r = P.decodeRecord("QUERY_TEXTURE_IMAGE", meta.view, 0), result = new Uint8Array(entry.size).fill(0xA5);
        // Real GPU pixels are covered by the browser test against the native
        // fixture. Here map rectangles from a deterministic image to isolate
        // tickets, clipping, partial-pixel chunks and PACK conversion.
        const saved = gpu.current.textureRead;
        if (saved && !saved.slot.compressedPixels) {
            const slot = saved.slot;
            const rendered = entry.name === "rendered_unbound_fbo" || entry.pboSize;
            const pixels = entry.name === "depth_rendered" ? new Uint8Array(new Float32Array([0.625, 0.625, 0.625, 0.625]).buffer) :
                rendered ? Uint8Array.from([64, 128, 191, 255, 64, 128, 191, 255, 64, 128, 191, 255, 64, 128, 191, 255]) : slot.pixels;
            gpu.readRectangle = (source, kind, rect) => {
                const bytes = slot.bytesPerTexel, begin = ((source.layer * slot.height + rect.y) * slot.width) * bytes;
                const format = kind === "depth" ? "r32float" : slot.gpuFormat;
                return () => Promise.resolve(unpackReadback(pixels.subarray(begin), slot.width * bytes, rect.width, rect.height, format));
            };
        }
        for (let at = 0; at < r.span;) {
            const size = Math.min(r.span - at, 7), stream = new GLStream();
            const q = cases.query(stream, { mode: at + size === r.span ? 2 : 1, ticket: r.ticket, context_id: r.context_id,
                offset: at, data_size: size }, result.subarray(at, at + size));
            await submit(stream); assert.equal(q.view.getUint32(F.status, true), 1, entry.name);
            result.set(q.bytes.subarray(H), at); at += size;
        }
        // Native float conversions may differ by one float ULP.
        if (entry.type === GL.FLOAT) {
            const little = !entry.name.startsWith("swapped"), actual = new DataView(result.buffer), expected = new DataView(Uint8Array.from(entry.bytes).buffer);
            for (let j = 0; j < result.length; j += 4)
                assert.ok(Math.abs(actual.getFloat32(j, little) - expected.getFloat32(j, little)) < 1e-6, entry.name);
        } else assert.deepEqual(Array.from(result), entry.bytes, entry.name);
        assert.equal(shadow.stats.rejected, 0); assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0);
    }
    const shadow = new GLShadow(), initial = cases.setup(reference.cases[0], 99);
    const meta = cases.query(initial, { target: GL.TEXTURE_2D, format: GL.RGBA, type: GL.UNSIGNED_BYTE }); shadow.process(initial.bytes());
    const r = P.decodeRecord("QUERY_TEXTURE_IMAGE", meta.view, 0);
    const heldId = shadow.current.textureRead.imageId;
    const removed = new GLStream().names(P.GLFN.DELETE_TEXTURES, [1]).call("BIND_TEXTURE", GL.TEXTURE_2D, 1);
    shadow.process(removed.bytes());
    assert.ok(shadow.current.group.textureImages.has(heldId), "pending read retains its deleted CPU image");
    assert.notEqual(shadow.current.group.textures.get(1).id, heldId);
    const restored = new GLShadow(); restored.setState(JSON.parse(JSON.stringify(shadow.getState())));
    const pending = new GLStream(), q = cases.query(pending, { mode: 1, ticket: r.ticket, context_id: r.context_id, data_size: 1 }, new Uint8Array(1));
    restored.process(pending.bytes()); assert.equal(q.view.getUint32(F.status, true), 0, "restore retains pending resource read");
    for (const invalid of [{ ticket: r.ticket + 1 }, { context_id: 100 }, { offset: r.span }, { data_size: 262145 }, { mode: 4 }]) {
        const stream = new GLStream(), dataSize = invalid.data_size || 1;
        const invalidQuery = cases.query(stream, { mode: 1, ticket: r.ticket, context_id: r.context_id, data_size: dataSize, ...invalid }, new Uint8Array(dataSize));
        restored.process(stream.bytes()); assert.equal(invalidQuery.view.getUint32(F.status, true), 2, JSON.stringify(invalid));
        assert.equal(invalidQuery.bytes[H], 0, "invalid query preserves caller bytes");
    }
    const cancel = new GLStream(); cases.query(cancel, { mode: 3, ticket: r.ticket }); restored.process(cancel.bytes());
    assert.equal(restored.current.textureRead, null);
    assert.equal(restored.current.group.textureImages.has(heldId), false, "cancel releases deleted CPU image");
    const absent = new GLShadow(), stream = new GLStream(), noContext = cases.query(stream, { target: GL.TEXTURE_2D });
    absent.process(stream.bytes()); assert.equal(noContext.view.getUint32(F.error, true), GL.INVALID_OPERATION);
    for (const bitmap of [false, true]) for (const lsb of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const setup = new GLStream().makeCurrent(101, 0, 0, 64, 64).call("BIND_TEXTURE", GL.TEXTURE_2D, 1)
            .call("PIXEL_STOREI", GL.UNPACK_ALIGNMENT, 1).call("PIXEL_STOREI", GL.PACK_ALIGNMENT, 1)
            .call("PIXEL_STOREI", GL.PACK_LSB_FIRST, +lsb);
        cases.image(setup, GL.TEXTURE_2D, GL.COLOR_INDEX8_EXT, GL.COLOR_INDEX, GL.UNSIGNED_BYTE, Uint8Array.from([0, 1, 128, 255, 5, 6, 7, 8]), 4, 2);
        if (bitmap) setup.call("PIXEL_STOREI", GL.PACK_SKIP_PIXELS, 3);
        const q = cases.query(setup, { target: GL.TEXTURE_2D, format: GL.COLOR_INDEX, type: bitmap ? 0x1A00 : GL.UNSIGNED_BYTE });
        shadow.process(setup.bytes()); gpu.submit(setup.bytes(), {}); await gpu.idle();
        const r = P.decodeRecord("QUERY_TEXTURE_IMAGE", q.view, 0), request = new GLStream(), output = new Uint8Array(r.span).fill(0xA5);
        const data = cases.query(request, { mode: 2, ticket: r.ticket, context_id: r.context_id, data_size: r.span }, output);
        shadow.process(request.bytes()); gpu.submit(request.bytes(), {}); await gpu.idle();
        assert.equal(data.view.getUint32(F.status, true), 1);
        assert.deepEqual(Array.from(data.bytes.subarray(H)), bitmap ? lsb ? [0xD5, 0xAD] : [0xAB, 0xB5] : [0, 1, 128, 255, 5, 6, 7, 8]);
    }
    console.log("gl_texture_readback_test: native texture metadata/errors, bounded PACK conversion, ticket validation and restore in local/copied modes (passed)");
})().catch(error => { console.error(error); process.exitCode = 1; });
