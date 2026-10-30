#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_rasterpos.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const reference = require("./gl_conformance/raster_reference.json").cases;
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
function scene() {
    const s = new GLStream().makeCurrent(1, 0, 0, 128, 128, 1, 1).call("VIEWPORT", 10, 20, 100, 60);
    s.ask = (pname, kind = P.C.V86GL_STATE_FLOAT) => {
        const header = P.encodeRecord("QUERY_STATE", { pname, value_kind: kind, data_size: 128 }), payload = new Uint8Array(header.length + 128);
        payload.set(header); const at = s.length + 4; s.record(P.GLFN.QUERY_STATE, payload);
        return () => { const view = new DataView(s.buffer.buffer, at, payload.length); assert.equal(view.getUint32(P.F.QUERY_STATE.status, true), 1);
            return Array.from({ length: view.getUint32(P.F.QUERY_STATE.count, true) }, (_, i) => view.getFloat64(header.length + i * 8, true)); };
    };
    s.bitmapMove = (xmove, ymove) => s.record(P.GLFN.BITMAP, P.encodeRecord("BITMAP", { xmove, ymove }));
    return s;
}
const near = (actual, expected, message) => { assert.equal(actual.length, expected.length, message);
    actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= 0.00001, message + "[" + i + "]: " + v + " vs " + expected[i])); };
test("raster transforms, lighting, normals, texgen and active-unit queries agree with desktop GL", () => {
    const s = scene(), answers = [];
    const record = name => {
        const expected = JSON.parse(JSON.stringify(reference[name]));
        if (name.startsWith("window") || name === "bitmap") {
            // ARB_window_pos requires w=1 and a fresh fog distance. Apple
            // preserves these two fields from the preceding RasterPos.
            expected.position[3] = 1; expected.distance = [name === "window_unlit" || name === "lit_window" ? 0 : 3.5];
        }
        for (const [key, pname] of [["position", GL.CURRENT_RASTER_POSITION], ["color", GL.CURRENT_RASTER_COLOR],
                ["secondary", GL.CURRENT_RASTER_SECONDARY_COLOR], ["texture", GL.CURRENT_RASTER_TEXTURE_COORDS],
                ["distance", GL.CURRENT_RASTER_DISTANCE], ["valid", GL.CURRENT_RASTER_POSITION_VALID]])
            if (name !== "clipped" || key === "valid") answers.push([s.ask(pname), expected[key], name + "/" + key]);
    };
    record("default");
    s.call("COLOR4F", 0.25, 0.5, 0.75, 1).call("MULTI_TEX_COORD4F", GL.TEXTURE0, 0.1, 0.2, 0.3, 1)
        .call("MATRIX_MODE", GL.TEXTURE).call("TRANSLATEF", 2, 3, 4).call("MATRIX_MODE", GL.MODELVIEW).call("TRANSLATEF", 0.2, 0.3, 0.4)
        .call("RASTER_POS4F", 0.2, 0.2, 0.2, 2); record("raster_w2");
    s.call("FOG_COORDF", 3.5).call("DEPTH_RANGE", 0.25, 0.75).call("WINDOW_POS3F", -5, 900, 0.3); record("window_unlit");
    s.call("LOAD_IDENTITY").call("ENABLE", GL.LIGHTING).call("ENABLE", GL.LIGHT0).call("RASTER_POS4F", 0, 0, 0, 1); record("lit_raster");
    s.call("WINDOW_POS3F", 0, 0, 0); record("lit_window");
    s.call("MATERIALFV", GL.FRONT, GL.SPECULAR, 4, 0.5, 0.5, 0.5, 1).call("MATERIALF", GL.FRONT, GL.SHININESS, 16)
        .call("LIGHT_MODELI", GL.LIGHT_MODEL_COLOR_CONTROL, GL.SEPARATE_SPECULAR_COLOR).call("RASTER_POS4F", 0, 0, 0, 1); record("lit_specular");
    s.call("SCALEF", 2, 4, 8).call("NORMAL3F", 0.577350269, 0.577350269, 0.577350269).call("RASTER_POS4F", 0, 0, 0, 1); record("normal_raw");
    s.call("ENABLE", GL.NORMALIZE).call("RASTER_POS4F", 0, 0, 0, 1); record("normal_unit");
    s.call("DISABLE", GL.NORMALIZE).call("ENABLE", GL.RESCALE_NORMAL).call("RASTER_POS4F", 0, 0, 0, 1); record("normal_rescale");
    s.call("DISABLE", GL.LIGHTING).call("DISABLE", GL.RESCALE_NORMAL).call("LOAD_IDENTITY")
        .call("TEX_GENI", GL.S, GL.TEXTURE_GEN_MODE, GL.OBJECT_LINEAR).call("TEX_GENFV", GL.S, GL.OBJECT_PLANE, 4, 0.5, 0, 0, 1)
        .call("ENABLE", GL.TEXTURE_GEN_S).call("RASTER_POS4F", 0.2, 0, 0, 1); record("texgen");
    s.call("RASTER_POS4F", 3, 0, 0, 1); record("clipped");
    s.call("FOGI", GL.FOG_COORD_SRC, GL.FOG_COORD).call("WINDOW_POS3F", 5, 6, 0.5); record("window_fog");
    s.bitmapMove(5, -7); record("bitmap");
    s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("MULTI_TEX_COORD4F", GL.TEXTURE0 + 3, 2, 3, 4, 5)
        .call("MATRIX_MODE", GL.TEXTURE).call("TRANSLATEF", 7, 8, 9).call("MATRIX_MODE", GL.MODELVIEW).call("RASTER_POS4F", 0, 0, 0, 1); record("unit3");
    const shadow = new GLShadow(); shadow.process(s.bytes()); assert.equal(shadow.stats.rejected, 0);
    for (const [answer, expected, name] of answers) near(answer(), expected, name);
});
test("raster values latch, invalid positions suppress Bitmap movement, and CURRENT_BIT survives snapshots", () => {
    const s = scene().call("COLOR4F", 0.25, 0.5, 0.75, 1).call("RASTER_POS4F", 0, 0, 0, 2).call("PUSH_ATTRIB", 1)
        .call("COLOR4F", 1, 0, 0, 1).call("RASTER_POS4F", 3, 0, 0, 1).bitmapMove(5, 7);
    const first = new GLShadow(); first.process(s.bytes()); const saved = JSON.parse(JSON.stringify(first.getState())), copy = new GLShadow(); copy.setState(saved);
    const after = scene().call("POP_ATTRIB"), color = after.ask(GL.CURRENT_RASTER_COLOR), position = after.ask(GL.CURRENT_RASTER_POSITION), valid = after.ask(GL.CURRENT_RASTER_POSITION_VALID);
    copy.process(after.bytes()); near(color(), [0.25, 0.5, 0.75, 1], "color"); near(position(), [60, 50, 0.5, 2], "position"); near(valid(), [1], "valid");
    assert.deepEqual(saved, first.getState());
});
test("user planes clip raster positions and Begin forbids raster/window/bitmap changes", () => {
    const s = scene().call("CLIP_PLANE", GL.CLIP_PLANE0, 1, 0, 0, 0).call("ENABLE", GL.CLIP_PLANE0)
        .call("RASTER_POS4F", -0.5, 0, 0, 1), clipped = s.ask(GL.CURRENT_RASTER_POSITION_VALID);
    s.call("WINDOW_POS3F", -100, -100, 0.5).call("BEGIN", GL.POINTS).call("RASTER_POS4F", 0, 0, 0, 1).call("WINDOW_POS3F", 7, 8, 0).bitmapMove(4, 5).call("END");
    const position = s.ask(GL.CURRENT_RASTER_POSITION), shadow = new GLShadow(); shadow.process(s.bytes());
    near(clipped(), [0], "user plane"); near(position(), [-100, -100, 0.5, 1], "no Begin mutation"); assert.equal(shadow.stats.rejected, 3);
});
test("the renderer uses clip w and maps WindowPos z through the depth range", async () => {
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize();
    const s = scene().call("RASTER_POS4F", 0, 0, 0, 2); executor.submit(s.bytes(), {});
    assert.equal(executor.current.current.rasterPos[3], 2);
    executor.submit(new GLStream().call("DEPTH_RANGE", 0.25, 0.75).call("WINDOW_POS3F", 1, 2, 0.25).bytes(), {});
    assert.deepEqual(Array.from(executor.current.current.rasterPos), [1, 2, 0.375, 1]);
});
test("an incomplete framebuffer rejects RasterPos/Bitmap while WindowPos remains available", () => {
    const s = scene().call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER, 4).call("RASTER_POS4F", 0, 0, 0, 1)
        .call("WINDOW_POS3F", 5, 7, 0.25).bitmapMove(3, 4), position = s.ask(GL.CURRENT_RASTER_POSITION);
    const shadow = new GLShadow(); shadow.process(s.bytes()); assert.equal(shadow.stats.rejected, 2);
    assert.equal(shadow.current.error, GL.INVALID_FRAMEBUFFER_OPERATION); near(position(), [5, 7, 0.25, 1], "window bypass");
});
(async () => { for (const { name, fn } of tests) { await fn(); console.log("ok   " + name); } console.log(tests.length + " CPU raster-position tests passed"); })()
    .catch(error => { console.error(error); process.exitCode = 1; });
