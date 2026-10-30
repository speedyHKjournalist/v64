#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_pixelmaps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const reference = require("./gl_conformance/pixelmaps_reference.json").cases;
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
function scene() {
    const s = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    s.map = (name, map, values) => {
        const header = P.encodeRecord(name, { map, count: values.length }), stride = name === "PIXEL_MAPUSV" ? 2 : 4;
        const payload = new Uint8Array(header.length + values.length * stride), v = new DataView(payload.buffer); payload.set(header);
        values.forEach((value, i) => name === "PIXEL_MAPUSV" ? v.setUint16(8 + i * 2, value, true) :
            name === "PIXEL_MAPUIV" ? v.setUint32(8 + i * 4, value, true) : v.setFloat32(8 + i * 4, value, true));
        return s.record(P.GLFN[name], payload);
    };
    s.ask = (target, value_kind = P.C.V86GL_STATE_FLOAT, capacity = 256) => {
        const header = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_PIXEL_MAP, target, value_kind, data_size: capacity * 8 });
        const payload = new Uint8Array(header.length + capacity * 8); payload.set(header); payload.fill(0xA5, header.length);
        const at = s.length + 4; s.record(P.GLFN.QUERY_PARAMETER, payload);
        return () => { const view = new DataView(s.buffer.buffer, at, payload.length); return {
            status: view.getUint32(P.F.QUERY_PARAMETER.status, true), error: view.getUint32(P.F.QUERY_PARAMETER.error, true),
            values: Array.from({ length: view.getUint32(P.F.QUERY_PARAMETER.count, true) }, (_, i) => view.getFloat64(header.length + i * 8, true)),
            unchanged: new Uint8Array(s.buffer.buffer, at + header.length, capacity * 8).every(v => v === 0xA5) }; };
    };
    return s;
}
const shadow = () => { const s = new GLShadow(); s.setCapabilities(caps.capabilities({}, {})); return s; };
const check = (q, expected) => { assert.equal(q().status, 1); assert.deepEqual(q().values, expected); };
test("float, unsigned integer and short input/output agree with independent GL", () => {
    const s = scene(), checks = [];
    const record = (name, map) => {
        for (const [kind, type] of [["float", P.C.V86GL_STATE_FLOAT], ["uint", P.C.V86GL_STATE_UNSIGNED_INT], ["ushort", P.C.V86GL_STATE_UNSIGNED_SHORT]])
            checks.push([s.ask(map, type), reference[name][kind], name + "/" + kind]);
    };
    record("default", GL.PIXEL_MAP_R_TO_R);
    s.map("PIXEL_MAPFV", GL.PIXEL_MAP_R_TO_R, [-1, 0.5, 1, 2]); record("float", GL.PIXEL_MAP_R_TO_R);
    s.map("PIXEL_MAPUIV", GL.PIXEL_MAP_G_TO_G, [0, 0x80000000, 0xFFFFFFFF, 0x40000000]); record("uint", GL.PIXEL_MAP_G_TO_G);
    s.map("PIXEL_MAPUSV", GL.PIXEL_MAP_B_TO_B, [0, 32768, 65535, 16384]); record("ushort", GL.PIXEL_MAP_B_TO_B);
    shadow().process(s.bytes()); for (const [q, expected, name] of checks) {
        assert.equal(q().status, 1);
        // Map storage precision is implementation dependent. Apple's u16->u32
        // query differs from its float query by one float32 ULP; our stored
        // float32 values use the explicit linear conversion in queryTyped.
        if (name === "ushort/uint") q().values.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= 256, name));
        else assert.deepEqual(q().values, expected, name);
    }
});
test("tables are context state, restored by PIXEL_MODE and snapshots, with vector queries larger than 16", () => {
    const values = Array.from({ length: 32 }, (_, i) => Math.fround(i / 31)), s = scene().map("PIXEL_MAPFV", GL.PIXEL_MAP_R_TO_R, values)
        .call("PUSH_ATTRIB", 0x20).map("PIXEL_MAPFV", GL.PIXEL_MAP_R_TO_R, [1, 0]);
    const first = shadow(); first.process(s.bytes()); const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(first.getState())));
    const after = scene().call("POP_ATTRIB"), answer = after.ask(GL.PIXEL_MAP_R_TO_R);
    after.makeCurrent(2, 0, 0, 64, 64, 2, 1); const other = after.ask(GL.PIXEL_MAP_R_TO_R);
    copy.process(after.bytes()); check(answer, values); check(other, [0]);
});
test("bad maps, sizes, truncated payloads and Begin changes preserve the last table and failed outputs", () => {
    const s = scene().map("PIXEL_MAPFV", GL.PIXEL_MAP_R_TO_R, [0.25, 0.75]).map("PIXEL_MAPFV", 0xDEAD, [1])
        .map("PIXEL_MAPFV", GL.PIXEL_MAP_R_TO_R, []).map("PIXEL_MAPUIV", GL.PIXEL_MAP_I_TO_R, [0, 1, 2]);
    s.record(P.GLFN.PIXEL_MAPUSV, P.encodeRecord("PIXEL_MAPUSV", { map: GL.PIXEL_MAP_R_TO_R, count: 2 }));
    s.call("BEGIN", GL.POINTS).map("PIXEL_MAPFV", GL.PIXEL_MAP_R_TO_R, [1]).call("END");
    const q = s.ask(GL.PIXEL_MAP_R_TO_R), short = s.ask(GL.PIXEL_MAP_R_TO_R, P.C.V86GL_STATE_FLOAT, 1), bad = s.ask(0xDEAD);
    const state = shadow(); state.process(s.bytes()); assert.equal(state.stats.rejected, 5); check(q, [0.25, 0.75]);
    assert.equal(short().error, GL.INVALID_VALUE); assert.ok(short().unchanged); assert.equal(bad().error, GL.INVALID_ENUM); assert.ok(bad().unchanged);
});
test("the renderer decodes integer/short maps, restores them, and keeps contexts independent", async () => {
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize();
    const s = scene().map("PIXEL_MAPUIV", GL.PIXEL_MAP_R_TO_R, [0, 0xFFFFFFFF]).map("PIXEL_MAPUSV", GL.PIXEL_MAP_G_TO_G, [65535, 0])
        .call("PUSH_ATTRIB", 0x20).map("PIXEL_MAPFV", GL.PIXEL_MAP_R_TO_R, [0.5]).call("POP_ATTRIB");
    shadow().process(s.bytes()); executor.submit(s.bytes(), {});
    assert.deepEqual(Array.from(executor.current.pixelMaps[GL.PIXEL_MAP_R_TO_R]), [0, 1]);
    assert.deepEqual(Array.from(executor.current.pixelMaps[GL.PIXEL_MAP_G_TO_G]), [1, 0]);
    const next = scene().makeCurrent(2, 0, 0, 64, 64, 2, 1); executor.submit(next.bytes(), {});
    assert.deepEqual(Array.from(executor.current.pixelMaps[GL.PIXEL_MAP_R_TO_R]), [0]);
});
(async () => { for (const { name, fn } of tests) { await fn(); console.log("ok   " + name); } console.log(tests.length + " CPU pixel-map tests passed"); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
