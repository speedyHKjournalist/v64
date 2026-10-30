#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_misc.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const reference = require("./gl_conformance/state_reference.json").cases;
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
function scene() {
    const s = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    s.ask = (pname, value_kind = P.C.V86GL_STATE_DOUBLE) => {
        const header = P.encodeRecord("QUERY_STATE", { pname, value_kind, data_size: 128 }), payload = new Uint8Array(header.length + 128);
        const at = s.length + 4; payload.set(header); s.record(P.GLFN.QUERY_STATE, payload);
        return () => { const view = new DataView(s.buffer.buffer, at, payload.length);
            assert.equal(view.getUint32(P.F.QUERY_STATE.status, true), 1, "pname " + pname + " kind " + value_kind);
            return Array.from({ length: view.getUint32(P.F.QUERY_STATE.count, true) }, (_, i) => view.getFloat64(header.length + i * 8, true)); };
    };
    return s;
}
test("four query conversions agree with independent desktop GL for fog, points, transfer, zoom and logic state", () => {
    const s = scene(), answers = [];
    const compare = (name, pname) => {
        for (const key of ["integer", "float", "double", "boolean"])
            answers.push([s.ask(pname, P.C["V86GL_STATE_" + key.toUpperCase()]), reference[name][key], name + "/" + key]);
    };
    s.call("FOGFV", GL.FOG_COLOR, 4, 0.5, -0.25, 2, 0.25); compare("fog_color", GL.FOG_COLOR);
    s.call("FOGF", GL.FOG_DENSITY, 2.75); compare("fog_density", GL.FOG_DENSITY);
    s.call("POINT_PARAMETERFV", GL.POINT_DISTANCE_ATTENUATION, 1, 2, 3); compare("point_attenuation", GL.POINT_DISTANCE_ATTENUATION);
    s.call("POINT_PARAMETERF", GL.POINT_SIZE_MIN, 2.75); compare("point_min", GL.POINT_SIZE_MIN);
    s.call("POINT_PARAMETERI", GL.POINT_SPRITE_COORD_ORIGIN, GL.LOWER_LEFT); compare("point_origin", GL.POINT_SPRITE_COORD_ORIGIN);
    s.call("PIXEL_TRANSFERF", GL.RED_SCALE, 2.75); compare("red_scale", GL.RED_SCALE);
    s.call("PIXEL_TRANSFERF", GL.INDEX_SHIFT, 2.75); compare("index_shift", GL.INDEX_SHIFT);
    s.call("PIXEL_ZOOM", -2, 0.5); compare("zoom_x", GL.ZOOM_X); compare("zoom_y", GL.ZOOM_Y);
    s.call("LOGIC_OP", GL.XOR); compare("logic_op", GL.LOGIC_OP_MODE);
    s.call("EDGE_FLAG", 0); compare("edge_flag", GL.CURRENT_EDGE_FLAG);
    new GLShadow().process(s.bytes()); for (const [answer, expected, name] of answers) assert.deepEqual(answer(), expected, name);
});
test("attribute groups restore fog, points and pixel transfer separately, including after snapshot", () => {
    const s = scene().call("FOGF", GL.FOG_DENSITY, 3).call("POINT_PARAMETERI", GL.POINT_SIZE_MIN, 4)
        .call("PIXEL_TRANSFERF", GL.DEPTH_SCALE, 2).call("PUSH_ATTRIB", 0x80 | 2 | 0x20)
        .call("FOGF", GL.FOG_DENSITY, 8).call("POINT_PARAMETERI", GL.POINT_SIZE_MIN, 9).call("PIXEL_TRANSFERF", GL.DEPTH_SCALE, 7);
    const first = new GLShadow(); first.process(s.bytes()); const copy = new GLShadow(); copy.setState(JSON.parse(JSON.stringify(first.getState())));
    const after = scene().call("POP_ATTRIB"), fog = after.ask(GL.FOG_DENSITY), point = after.ask(GL.POINT_SIZE_MIN), depth = after.ask(GL.DEPTH_SCALE);
    copy.process(after.bytes()); assert.deepEqual(fog(), [3]); assert.deepEqual(point(), [4]); assert.deepEqual(depth(), [2]);
});
test("bad enums, negative sizes/density, and state changes within Begin are rejected without mutation", async () => {
    const s = scene().call("FOGF", GL.FOG_DENSITY, -1).call("FOGI", GL.FOG_MODE, 0).call("FOGF", GL.FOG_COLOR, 1)
        .call("FOGFV", GL.FOG_COLOR, 2, 1, 2, 3, 4).call("POINT_PARAMETERF", GL.POINT_DISTANCE_ATTENUATION, 2)
        .call("POINT_PARAMETERF", GL.POINT_SIZE_MIN, -1).call("POINT_PARAMETERI", GL.POINT_SPRITE_COORD_ORIGIN, 0)
        .call("PIXEL_TRANSFERI", 0xDEAD, 1).call("LOGIC_OP", 0xDEAD).call("BEGIN", GL.POINTS)
        .call("FOGF", GL.FOG_DENSITY, 5).call("EDGE_FLAG", 0).call("END");
    const density = s.ask(GL.FOG_DENSITY), point = s.ask(GL.POINT_SIZE_MIN), edge = s.ask(GL.CURRENT_EDGE_FLAG);
    const shadow = new GLShadow(), bytes = s.bytes(); shadow.process(bytes); assert.equal(shadow.stats.rejected, 10);
    assert.deepEqual(density(), [1]); assert.deepEqual(point(), [0]); assert.deepEqual(edge(), [0]);
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize(); executor.submit(bytes, {});
    assert.equal(executor.current.fog.density, 1); assert.equal(executor.current.point.sizeMin, 0); assert.equal(executor.stats.refusals, 0);
});
test("integer point and transfer values become float storage; booleans use zero/nonzero", () => {
    const s = scene().call("POINT_PARAMETERIV", GL.POINT_DISTANCE_ATTENUATION, 2147483647, 2, 3)
        .call("PIXEL_TRANSFERI", GL.RED_SCALE, 2147483647).call("PIXEL_TRANSFERF", GL.MAP_STENCIL, -3);
    const point = s.ask(GL.POINT_DISTANCE_ATTENUATION), scale = s.ask(GL.RED_SCALE), map = s.ask(GL.MAP_STENCIL);
    new GLShadow().process(s.bytes()); assert.deepEqual(point(), [2147483648, 2, 3]); assert.deepEqual(scale(), [2147483648]); assert.deepEqual(map(), [1]);
});
(async () => { for (const { name, fn } of tests) { await fn(); console.log("ok   " + name); } console.log(tests.length + " CPU miscellaneous state tests passed"); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
