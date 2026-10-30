#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_raster.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const reference = require("./gl_conformance/state_reference.json").cases;
const { GLStream, GL } = require("./gl_stream_builder.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
const shadow = () => { const s = new GLShadow(); s.setCapabilities(caps.capabilities({}, {})); return s; };
function scene() {
    const s = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    s.ask = (pname, kind = P.C.V86GL_STATE_DOUBLE) => {
        const header = P.encodeRecord("QUERY_STATE", { pname, value_kind: kind, data_size: 128 });
        const payload = new Uint8Array(header.length + 128); payload.set(header); s.record(P.GLFN.QUERY_STATE, payload);
        const response = s.payloadView();
        return () => ({ status: response.view.getUint32(P.F.QUERY_STATE.status, true),
            error: response.view.getUint32(P.F.QUERY_STATE.error, true), values: Array.from({ length: response.view.getUint32(P.F.QUERY_STATE.count, true) },
                (_, i) => response.view.getFloat64(header.length + i * 8, true)) });
    };
    s.enabled = cap => s.ask(cap, P.C.V86GL_STATE_IS_ENABLED);
    return s;
}
const check = (answer, values) => { assert.equal(answer().status, 1); assert.deepEqual(answer().values, values); };
test("defaults and unsigned stencil masks agree with Apple GL's four conversions", () => {
    const s = scene(), dither = s.enabled(GL.DITHER), multisample = s.enabled(GL.MULTISAMPLE), blend = s.enabled(GL.BLEND);
    const masks = [P.C.V86GL_STATE_INTEGER, P.C.V86GL_STATE_FLOAT, P.C.V86GL_STATE_DOUBLE, P.C.V86GL_STATE_BOOLEAN].map(k => s.ask(GL.STENCIL_VALUE_MASK, k));
    shadow().process(s.bytes()); check(dither, [1]); check(multisample, [1]); check(blend, [0]);
    masks.forEach((answer, i) => check(answer, reference.mask_all[["integer", "float", "double", "boolean"][i]]));
});
test("server texture enables and client texture-coordinate arrays have independent active units", () => {
    const s = scene().call("ACTIVE_TEXTURE", GL.TEXTURE0 + 2).call("ENABLE", GL.TEXTURE_2D).call("ENABLE", GL.TEXTURE_GEN_S);
    const server2 = s.enabled(GL.TEXTURE_2D), gen2 = s.enabled(GL.TEXTURE_GEN_S);
    s.call("ACTIVE_TEXTURE", GL.TEXTURE0); const server0 = s.enabled(GL.TEXTURE_2D);
    s.call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("ENABLE_CLIENT_STATE", GL.TEXTURE_COORD_ARRAY).call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY);
    const client3 = s.enabled(GL.TEXTURE_COORD_ARRAY), vertex = s.enabled(GL.VERTEX_ARRAY);
    s.call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0 + 2); const client2 = s.enabled(GL.TEXTURE_COORD_ARRAY);
    shadow().process(s.bytes());
    for (const q of [server2, gen2, client3, vertex]) check(q, [1]);
    for (const q of [server0, client2]) check(q, [0]);
});
test("enable, texture and client attribute masks restore their own state families", () => {
    const s = scene().call("ENABLE", GL.LINE_SMOOTH).call("PUSH_ATTRIB", 4).call("DISABLE", GL.LINE_SMOOTH)
        .call("ENABLE", GL.DEPTH_TEST).call("POP_ATTRIB");
    const line = s.enabled(GL.LINE_SMOOTH), depth = s.enabled(GL.DEPTH_TEST);
    s.call("PUSH_ATTRIB", 0x2000).call("DISABLE", GL.DEPTH_TEST).call("ACTIVE_TEXTURE", GL.TEXTURE0 + 1).call("ENABLE", GL.TEXTURE_2D).call("POP_ATTRIB");
    const restoredDepth = s.enabled(GL.DEPTH_TEST), texture = s.enabled(GL.TEXTURE_2D);
    s.call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("ENABLE_CLIENT_STATE", GL.TEXTURE_COORD_ARRAY).call("PUSH_CLIENT_ATTRIB", 2)
        .call("DISABLE_CLIENT_STATE", GL.TEXTURE_COORD_ARRAY).call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY).call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0).call("POP_CLIENT_ATTRIB");
    const unit = s.ask(GL.CLIENT_ACTIVE_TEXTURE), coord = s.enabled(GL.TEXTURE_COORD_ARRAY), vertex = s.enabled(GL.VERTEX_ARRAY);
    shadow().process(s.bytes()); check(line, [1]); check(depth, [1]); check(restoredDepth, [1]); check(texture, [0]);
    check(unit, [GL.TEXTURE0 + 3]); check(coord, [1]); check(vertex, [0]);
});
test("stencil front/back state is independent, and queried references clamp to the current framebuffer", () => {
    const s = scene().call("STENCIL_FUNC_SEPARATE", GL.FRONT, GL.LESS, -7, 0x80000001)
        .call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.GEQUAL, 1000, 0xFFFFFFFF).call("STENCIL_MASK_SEPARATE", GL.BACK, 0xAABBCCDD)
        .call("STENCIL_OP_SEPARATE", GL.BACK, GL.INCR_WRAP, GL.DECR_WRAP, GL.REPLACE);
    const front = s.ask(GL.STENCIL_REF), back = s.ask(GL.STENCIL_BACK_REF), mask = s.ask(GL.STENCIL_VALUE_MASK, P.C.V86GL_STATE_INTEGER);
    const backMask = s.ask(GL.STENCIL_BACK_WRITEMASK), op = s.ask(GL.STENCIL_BACK_PASS_DEPTH_FAIL), frontFunc = s.ask(GL.STENCIL_FUNC);
    s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER, 4); const empty = s.ask(GL.STENCIL_BACK_REF);
    s.call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.GEQUAL, 42, 0xFFFFFFFF).call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER, 0); const returned = s.ask(GL.STENCIL_BACK_REF);
    shadow().process(s.bytes()); check(front, reference.ref_front.double); check(back, reference.ref_back.double);
    check(mask, reference.mask_high.integer); check(backMask, [0xAABBCCDD]);
    check(op, [GL.DECR_WRAP]); check(frontFunc, [GL.LESS]); check(empty, reference.ref_empty.double); check(returned, reference.ref_returned.double);
});
test("stencil and hint attribute groups restore values and enable bits", () => {
    const s = scene().call("ENABLE", GL.STENCIL_TEST).call("STENCIL_FUNC", GL.LESS, 37, 0x12345678).call("PUSH_ATTRIB", 0x400)
        .call("DISABLE", GL.STENCIL_TEST).call("STENCIL_FUNC", GL.ALWAYS, 7, 0).call("POP_ATTRIB");
    const enabled = s.enabled(GL.STENCIL_TEST), ref = s.ask(GL.STENCIL_REF), mask = s.ask(GL.STENCIL_VALUE_MASK);
    s.call("HINT", GL.FOG_HINT, GL.NICEST).call("PUSH_ATTRIB", 0x8000).call("HINT", GL.FOG_HINT, GL.FASTEST).call("POP_ATTRIB");
    const hint = s.ask(GL.FOG_HINT); shadow().process(s.bytes()); check(enabled, [1]); check(ref, [37]); check(mask, [0x12345678]); check(hint, [GL.NICEST]);
});
test("glIsEnabled validates capabilities separately from glGetBooleanv", () => {
    const s = scene(), value = s.ask(GL.LINE_WIDTH, P.C.V86GL_STATE_BOOLEAN), invalid = s.enabled(GL.LINE_WIDTH);
    shadow().process(s.bytes()); check(value, [1]); assert.equal(invalid().status, 2); assert.equal(invalid().error, GL.INVALID_ENUM);
});
test("invalid enables, client enables, hints and stencil commands are rejected without mutation", () => {
    const s = scene().call("ENABLE", 0xDEAD).call("ENABLE_CLIENT_STATE", GL.BLEND).call("ENABLE", GL.DEPTH_CLAMP)
        .call("HINT", GL.FOG_HINT, 0).call("STENCIL_FUNC_SEPARATE", GL.BACK, 0, 7, 1).call("STENCIL_OP", GL.KEEP, 0xDEAD, GL.KEEP);
    const hint = s.ask(GL.FOG_HINT), func = s.ask(GL.STENCIL_BACK_FUNC), blend = s.enabled(GL.BLEND);
    const state = shadow(); state.process(s.bytes()); assert.equal(state.stats.rejected, 6);
    check(hint, [GL.DONT_CARE]); check(func, [GL.ALWAYS]); check(blend, [0]);
});
test("raster state and attribute snapshots survive restore, including an older snapshot", () => {
    const first = shadow(), s = scene().call("ENABLE", GL.BLEND).call("STENCIL_FUNC", GL.GEQUAL, 37, 0x80000001).call("PUSH_ATTRIB", 0x4000).call("DISABLE", GL.BLEND);
    first.process(s.bytes()); const saved = JSON.parse(JSON.stringify(first.getState())), copy = shadow(); copy.setState(saved);
    assert.deepEqual(copy.getState(), saved);
    const next = scene().call("POP_ATTRIB"), blend = next.enabled(GL.BLEND), mask = next.ask(GL.STENCIL_VALUE_MASK, P.C.V86GL_STATE_INTEGER);
    copy.process(next.bytes()); check(blend, [1]); check(mask, [-2147483647]);
    for (const [, typed] of saved.typed) { delete typed.raster; delete typed.values[GL.STENCIL_VALUE_MASK]; }
    copy.setState(saved); const old = scene(), dither = old.enabled(GL.DITHER), defaultMask = old.ask(GL.STENCIL_VALUE_MASK, P.C.V86GL_STATE_INTEGER);
    copy.process(old.bytes()); check(dither, [1]); check(defaultMask, [-1]);
});
test("rendered stencil reference clamps instead of wrapping negative or overflowing values", async () => {
    for (const [ref, expected] of [[-7, 0], [1000, 255]]) {
        const { host, log } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize();
        const s = scene().call("CLEAR", GL.COLOR_BUFFER_BIT | GL.STENCIL_BUFFER_BIT).call("ENABLE", GL.STENCIL_TEST)
            .call("STENCIL_FUNC", GL.ALWAYS, ref, 0xFFFFFFFF).call("BEGIN", GL.TRIANGLES)
            .call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 1, -1, 0).call("VERTEX3F", 0, 1, 0).call("END");
        const bytes = s.bytes(); shadow().process(bytes); executor.submit(bytes, {});
        assert.equal(log.draws.at(-1).pass.stencilReference, expected);
    }
});
(async () => { for (const { name, fn } of tests) { await fn(); console.log("ok   " + name); } console.log(tests.length + " CPU raster state tests passed"); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
