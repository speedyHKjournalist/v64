"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arrays.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const cases = require("./gl_display_list_array_cases.js");
const native = require("./gl_conformance/display_list_arrays_reference.json").cases;
const scene = () => new GLStream().makeCurrent(1100, 0, 0, 8, 8, 1100, 1100);
(async () => {
    for (const copied of [false, true]) {
        let shadow = new GLShadow(); const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const draws = [];
        gpu.drawPacked = (mode, count, arrays, indices) => draws.push({ mode, count, arrays, indices });
        const submit = stream => {
            const bytes = stream.bytes(), segments = shadow.process(bytes);
            for (const segment of segments || [{ offset: 0, length: bytes.length }]) {
                const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length);
                gpu.submit(copied ? part.slice() : part, {});
            }
        };
        const { stream, reads } = cases.build(); submit(stream);
        assert.equal(draws.length, 3);
        for (let i = 0; i < 3; ++i) {
            const draw = draws[i]; assert.equal(draw.mode, GL.TRIANGLES); assert.equal(draw.count, 3);
            assert.equal(draw.arrays.vertex.stride, 12); assert.equal(draw.arrays.vertex.data.length, 36);
            const positions = new DataView(draw.arrays.vertex.data.buffer, draw.arrays.vertex.data.byteOffset, 36);
            assert.deepEqual(Array.from({ length: 9 }, (_, j) => positions.getFloat32(j * 4, true)), i ? [0, 1, 0, -1, -1, 0, 1, -1, 0] : [-1, -1, 0, 1, -1, 0, 0, 1, 0]);
            assert.deepEqual(Array.from(draw.arrays.color.data), Array(3).fill(native[i].pixel).flat());
            assert.deepEqual(reads[i].pixel, native[i].pixel); assert.equal(native[i].error, 0);
            if (i) { const v = new DataView(draw.indices.data.buffer, draw.indices.data.byteOffset, 12);
                assert.deepEqual([0, 1, 2].map(j => v.getUint32(j * 4, true)), [0, 1, 2]); }
            assert.ok(shadow.current.group.displayLists.get(100 + i)[0].length < 512, "only three referenced elements belong to the list");
        }
        assert.equal(shadow.current.error, 0);
        // Float64 positions, normalized generic colours, per-unit coordinates
        // and client draws retain their own formats after current state changes.
        const doubles = new Float64Array([-1, -1, 0, 1, 1, -1, 0, 1, 0, 1, 0, 1]), colors = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
        let s = scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 3).bufferData(GL.ARRAY_BUFFER, doubles.byteLength, GL.STATIC_DRAW, new Uint8Array(doubles.buffer))
            .pointerVBO("VERTEX_POINTER_VBO", 4, GL.DOUBLE, 32, 0).call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY).call("DISABLE_CLIENT_STATE", GL.COLOR_ARRAY)
            .call("BIND_BUFFER", GL.ARRAY_BUFFER, 4).bufferData(GL.ARRAY_BUFFER, colors.length, GL.STATIC_DRAW, colors)
            .attribPointerVBO(3, 4, GL.UNSIGNED_BYTE, true, 4, 0).call("ENABLE_VERTEX_ATTRIB_ARRAY", 3)
            .call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0 + 3).pointerVBO("TEX_COORD_POINTER_VBO", 2, GL.SHORT, 4, 0)
            .call("ENABLE_CLIENT_STATE", GL.TEXTURE_COORD_ARRAY).call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0);
        cases.list(s, 1, 200, GL.COMPILE); s.call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 3); cases.list(s, 2); submit(s);
        const saved = JSON.parse(JSON.stringify(shadow.getState())); shadow = new GLShadow(); shadow.setState(saved);
        shadow.current.group.buffers.get(3).mapped = true; shadow.current.group.buffers.get(4).mapped = true;
        s = scene(); cases.list(s, 3, 200); submit(s);
        const captured = draws.at(-1); assert.equal(shadow.current.error, 0);
        assert.equal(captured.arrays.vertex.type, GL.DOUBLE); assert.deepEqual(Array.from(captured.arrays.vertex.data), Array.from(new Uint8Array(doubles.buffer)));
        assert.equal(captured.arrays.generic3.normalized, true); assert.deepEqual(Array.from(captured.arrays.generic3.data), Array.from(colors));
        assert.equal(captured.arrays.texCoord3.type, GL.SHORT); assert.deepEqual(Array.from(captured.arrays.texCoord3.data), Array.from(colors));
        const before = draws.length;
        s = scene(); cases.list(s, 1, 201, GL.COMPILE); s.call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 3); cases.list(s, 2); submit(s);
        assert.equal(shadow.current.error, 0, "a captured draw's execution error is deferred in COMPILE mode");
        shadow.current.group.buffers.get(3).mapped = false; shadow.current.group.buffers.get(4).mapped = false;
        s = scene(); cases.list(s, 3, 201); submit(s); assert.equal(shadow.current.error, GL.INVALID_OPERATION); assert.equal(draws.length, before); shadow.current.error = 0;
        // Multi-draw records freeze each draw, preserving their order.
        s = scene(); cases.list(s, 1, 202, GL.COMPILE);
        const h = P.encodeRecord("MULTI_DRAW_ARRAYS_DIRECT", { mode: GL.TRIANGLES, primcount: 2 }), payload = new Uint8Array(h.length + 16);
        payload.set(h); const v = new DataView(payload.buffer); [0, 3, 0, 3].forEach((value, i) => v.setInt32(h.length + i * 4, value, true));
        s.record(P.GLFN.MULTI_DRAW_ARRAYS_DIRECT, payload); cases.list(s, 2); cases.list(s, 3, 202); submit(s); assert.equal(draws.length, before + 2);
        s = scene().call("BIND_BUFFER", GL.ELEMENT_ARRAY_BUFFER, 5).bufferData(GL.ELEMENT_ARRAY_BUFFER, 12, GL.STATIC_DRAW,
            new Uint8Array(new Uint16Array([2, 0, 1, 1, 2, 0]).buffer)); cases.list(s, 1, 203, GL.COMPILE);
        const mh = P.encodeRecord("MULTI_DRAW_ELEMENTS_DIRECT", { mode: GL.TRIANGLES, type: GL.UNSIGNED_SHORT, primcount: 2 }), mp = new Uint8Array(mh.length + 16);
        mp.set(mh); const mv = new DataView(mp.buffer); [3, 0, 3, 6].forEach((value, i) => mv.setUint32(mh.length + i * 4, value, true));
        s.record(P.GLFN.MULTI_DRAW_ELEMENTS_DIRECT, mp); cases.list(s, 2); cases.list(s, 3, 203); submit(s); assert.equal(draws.length, before + 4);
        for (const [name, fields, expected] of [["DRAW_ELEMENTS_DIRECT", { mode: GL.TRIANGLES, count: 3, type: 0 }, GL.INVALID_ENUM],
            ["DRAW_RANGE_ELEMENTS_DIRECT", { mode: GL.TRIANGLES, count: 3, type: GL.UNSIGNED_SHORT, start: 3, end: 1 }, GL.INVALID_VALUE],
            ["DRAW_ELEMENTS_DIRECT", { mode: GL.TRIANGLES, count: 100, type: GL.UNSIGNED_SHORT }, GL.INVALID_OPERATION]]) {
            s = scene(); cases.list(s, 1, 204, GL.COMPILE); s.record(P.GLFN[name], P.encodeRecord(name, fields)); cases.list(s, 2); submit(s);
            assert.equal(shadow.current.error, 0); cases.list(s = scene(), 3, 204); submit(s); assert.equal(shadow.current.error, expected); shadow.current.error = 0;
        }
        assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0); await gpu.idle();
    }
    console.log("Native list VBO/index captures, sparse gathering, double/generic formats, mapped-state isolation, snapshots and multi-draw passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
