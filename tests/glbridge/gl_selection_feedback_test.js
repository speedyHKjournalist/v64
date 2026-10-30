"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_select.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), { GLStream, GL } = require("./gl_stream_builder.js");
const selection = require("./gl_conformance/selection_reference.json").cases;
const feedback = require("./gl_conformance/feedback_reference.json").cases;
function query(s, fields, capacity = 0) {
    const header = P.encodeRecord("QUERY_RENDER_MODE", fields), payload = new Uint8Array(header.length + capacity); payload.set(header);
    s.record(P.GLFN.QUERY_RENDER_MODE, payload); return s.payloadView();
}
const name = (s, operation, value = 0, token = 0) => s.record(P.GLFN.NAME_COMMAND, P.encodeRecord("NAME_COMMAND", { operation, name: value, value: token }));
const point = (s, x, y, z) => s.call("BEGIN", GL.POINTS).call("VERTEX3F", x, y, z).call("END");
const triangle = s => s.call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, -0.5).call("VERTEX3F", 1, -1, 0.5).call("VERTEX3F", 0, 1, 0).call("END");
function reset(s) {
    return s.call("MATRIX_MODE", GL.MODELVIEW).call("LOAD_IDENTITY").call("MATRIX_MODE", GL.PROJECTION).call("LOAD_IDENTITY").call("MATRIX_MODE", GL.MODELVIEW)
        .call("DISABLE", GL.CULL_FACE).call("DISABLE", GL.CLIP_PLANE0);
}
function harness(saved) {
    const shadow = new GLShadow(); shadow.process(new GLStream().makeCurrent(1, 0, 0, 32, 32, 1, 1).bytes());
    if (saved) shadow.setState(saved);
    const buffer = new Uint32Array(256);
    const submit = s => shadow.process(s.bytes());
    function mode(s, type) {
        const response = query(s, { operation: 2, type }); submit(s);
        const r = P.decodeRecord("QUERY_RENDER_MODE", response.view, 0);
        if (r.status !== 1) return r;
        for (let offset = 0; offset < r.total;) {
            const count = Math.min(262144, r.total - offset), next = new GLStream(), q = query(next, { operation: 3, ticket: r.ticket, size: r.size, offset, data_size: count }, count);
            submit(next); assert.equal(q.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 1);
            new Uint8Array(buffer.buffer).set(q.bytes.subarray(44), offset); offset += count;
        }
        return r;
    }
    return { shadow, buffer, submit, mode };
}
function selectionWords(actual, expected, capacity) {
    const depths = new Set();
    for (let at = 0; at < capacity && expected[at] !== 0xA5A5A5A5;) { depths.add(at + 1); depths.add(at + 2); at += 3 + expected[at]; }
    actual.forEach((value, i) => {
        if (depths.has(i) && i < capacity) assert.ok(Math.abs(value - expected[i]) <= 128, "native depth precision " + value + " vs " + expected[i]);
        else assert.equal(value, expected[i], "word " + i);
    });
}
{
    const h = harness();
    for (const entry of selection) {
        if (!entry.words) continue;
        h.buffer.fill(0xA5A5A5A5); let s = reset(new GLStream()).call("VIEWPORT", 0, 0, 16, 16).call("DEPTH_RANGE", 0, 1);
        query(s, { operation: 0, size: entry.size, pointer: 0x1000 }); h.mode(s, GL.SELECT);
        name(s = new GLStream(), 0); name(s, 2, 7);
        switch (entry.name) {
        case "point": point(s, 0, 0, 0); break;
        case "outside": point(s, 2, 0, 0); break;
        case "negative_w": s.call("BEGIN", GL.POINTS).call("VERTEX4F", 0, 0, 0, -1).call("END"); break;
        case "merged": point(s, 0, 0, -0.5); point(s, 0, 0, 0.5); break;
        case "same_name_flush": point(s, 0, 0, -0.5); name(s, 1, 7); point(s, 0, 0, 0.5); break;
        case "empty_names": name(s, 3); point(s, 0, 0, 0); break;
        case "clipped_line": s.call("BEGIN", GL.LINES).call("VERTEX3F", -2, 0, -2).call("VERTEX3F", 2, 0, 2).call("END"); break;
        case "reversed_depth": s.call("DEPTH_RANGE", 0.75, 0.25).call("BEGIN", GL.LINES).call("VERTEX3F", -0.5, 0, -0.5).call("VERTEX3F", 0.5, 0, 0.5).call("END"); break;
        case "clipped_triangle": s.call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -2, -0.5, -0.5).call("VERTEX3F", 2, -0.5, 0.5).call("VERTEX3F", 0, 2, 0).call("END"); break;
        case "culled_front": s.call("ENABLE", GL.CULL_FACE).call("CULL_FACE", GL.FRONT); triangle(s); break;
        case "user_clip": s.call("CLIP_PLANE", GL.CLIP_PLANE0, 1, 0, 0, -0.25).call("ENABLE", GL.CLIP_PLANE0); point(s, 0, 0, 0); break;
        case "transformed": s.call("TRANSLATEF", 0, 0, 0.5); point(s, 0, 0, 0); break;
        case "reenter": point(s, 0, 0, 0); assert.equal(h.mode(s, GL.SELECT).result, 1); point(s = new GLStream(), 0, 0, 0.5); break;
        default: assert.ok(entry.name.startsWith("overflow_")); point(s, 0, 0, 0);
        }
        const result = h.mode(s, GL.RENDER);
        assert.equal(result.result, entry.result, entry.name); assert.equal(h.shadow.current.error, entry.error, entry.name);
        assert.equal(h.shadow.current.state.selection.names.length, entry.depth, entry.name);
        selectionWords(Array.from(h.buffer.subarray(0, entry.words.length)), entry.words, entry.size); h.shadow.current.error = 0;
    }
    let s = new GLStream(); name(s, 1, 1); name(s, 3); name(s, 2, 2); name(s, 0); h.submit(s); assert.equal(h.shadow.current.error, 0);
    s = new GLStream().call("BEGIN", GL.POINTS); name(s, 2, 2); s.call("END"); h.submit(s); assert.equal(h.shadow.current.error, GL.INVALID_OPERATION);
    const f = harness(), types = [GL["2D"], GL["3D"], GL["3D_COLOR"], GL["3D_COLOR_TEXTURE"], GL["4D_COLOR_TEXTURE"]];
    const pointNames = ["point_2d", "point_3d", "point_color", "point_texture", "point_4d"];
    for (const entry of feedback) {
        new Float32Array(f.buffer.buffer).fill(-12345);
        s = reset(new GLStream()).call("VIEWPORT", 2, 3, 10, 20).call("DEPTH_RANGE", 0.2, 0.8).call("DISABLE", GL.LIGHTING)
            .call("DISABLE", GL.COLOR_MATERIAL).call("DISABLE", GL.LIGHT0).call("EDGE_FLAG", 1)
            .call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.FILL).call("COLOR4F", 0.25, 0.5, 0.75, 1).call("TEX_COORD4F", 2, 3, 4, 5);
        const type = entry.name === "clipped_line" || entry.name === "array_color_material" ? GL["3D_COLOR"] : entry.name === "bitmap_zero" ? GL["3D_COLOR_TEXTURE"] : types[pointNames.indexOf(entry.name)] || GL["2D"];
        const capacity = entry.name.startsWith("overflow_") ? +entry.name.slice(-1) : 128;
        query(s, { operation: 1, size: capacity, type, pointer: 0x2000 }); f.mode(s, GL.FEEDBACK); s = new GLStream();
        if (pointNames.includes(entry.name) || entry.name.startsWith("overflow_")) s.call("BEGIN", GL.POINTS).call("VERTEX4F", 0.5, 1, 0, 2).call("END");
        else switch (entry.name) {
        case "clipped_line": s.call("BEGIN", GL.LINES).call("COLOR4F", 1, 0, 0, 1).call("VERTEX3F", -2, 0, -2).call("COLOR4F", 0, 0, 1, 1).call("VERTEX3F", 2, 0, 2).call("END"); break;
        case "line_strip": s.call("BEGIN", GL.LINE_STRIP).call("VERTEX3F", -0.5, -0.5, 0).call("VERTEX3F", 0, 0, 0).call("VERTEX3F", 0.5, 0.5, 0).call("END"); break;
        case "triangle": triangle(s); break;
        case "polygon_line": s.call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.LINE); triangle(s); break;
        case "polygon_point": s.call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.POINT); triangle(s); break;
        case "clipped_polygon": s.call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -2, -0.5, 0).call("VERTEX3F", 2, -0.5, 0).call("VERTEX3F", 0, 2, 0).call("END"); break;
        case "culled": s.call("ENABLE", GL.CULL_FACE).call("CULL_FACE", GL.FRONT); triangle(s); break;
        case "pass_through": name(s, 4, 0, 3.25); break;
        case "bitmap_zero": s.call("WINDOW_POS3F", 4, 5, 0.75).bitmap(0, 0, 0, 0, 3, 2); break;
        case "draw_pixels": s.call("WINDOW_POS3F", 4, 5, 0).drawPixels(1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255])); break;
        case "copy_pixels": s.call("WINDOW_POS3F", 4, 5, 0).call("COPY_PIXELS", 0, 0, 1, 1, GL.COLOR); break;
        case "edge_points": case "edge_lines": s.call("POLYGON_MODE", GL.FRONT_AND_BACK, entry.name === "edge_points" ? GL.POINT : GL.LINE).call("BEGIN", GL.TRIANGLES)
            .call("EDGE_FLAG", 0).call("VERTEX3F", -1, -1, 0).call("EDGE_FLAG", 1).call("VERTEX3F", 1, -1, 0).call("VERTEX3F", 0, 1, 0).call("END"); break;
        case "array_color_material": s.call("ENABLE", GL.LIGHTING).call("ENABLE", GL.LIGHT0).call("ENABLE", GL.COLOR_MATERIAL)
            .drawArrays(GL.POINTS, 1, { vertex: { size: 4, type: GL.FLOAT, data: new Float32Array([0.5, 1, 0, 2]) },
                color: { size: 4, type: GL.FLOAT, data: new Float32Array([0.5, 0.25, 0.75, 1]) } }); break;
        default: throw new Error(entry.name);
        }
        const result = f.mode(s, GL.RENDER); assert.equal(result.result, entry.result, entry.name); assert.equal(f.shadow.current.error, entry.error, entry.name);
        const actual = Array.from(new Float32Array(f.buffer.buffer, 0, entry.values.length));
        if (entry.name === "clipped_polygon") {
            // The starting vertex of the same clipped cyclic polygon depends
            // on the driver's clipping plane order; winding and all vertices
            // must still agree.
            assert.equal(actual[0], entry.values[0]); assert.equal(actual[1], entry.values[1]);
            const count = actual[1], matches = shift => Array.from({ length: count * 2 }, (_, i) =>
                Math.abs(actual[2 + i] - entry.values[2 + (i + shift * 2) % (count * 2)]) < 1e-6).every(Boolean);
            assert.ok(Array.from({ length: count }, (_, shift) => matches(shift)).some(Boolean));
            assert.deepEqual(actual.slice(2 + count * 2), entry.values.slice(2 + count * 2));
        } else actual.forEach((value, i) => assert.ok(Math.abs(value - entry.values[i]) < 1e-6, entry.name + " value " + i + ": " + value + " vs " + entry.values[i]));
        f.shadow.current.error = 0;
    }
}
{
    const h = harness(); let s = new GLStream(); query(s, { operation: 0, size: 128, pointer: 0x12345678 }); h.mode(s, GL.SELECT);
    name(s = new GLStream(), 2, 3); s.call("BEGIN", GL.LINES).call("VERTEX3F", -2, 0, -2); h.submit(s);
    const restored = harness(JSON.parse(JSON.stringify(h.shadow.getState())));
    s = new GLStream().call("VERTEX3F", 2, 0, 2).call("END"); name(s, 1, 4);
    s.call("RASTER_POS4F", 2, 0, 0, 1).call("WINDOW_POS3F", 2, 3, 0.25);
    const result = restored.mode(s, GL.RENDER); assert.equal(result.result, 2);
    assert.deepEqual(Array.from(restored.buffer.subarray(0, 8)), [1, 0, 0xFFFFFFFF, 3, 1, 0x40000000, 0x40000000, 4]);
    s = new GLStream(); const header = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_ARRAY_POINTER, pname: 0x0DF3,
        value_kind: P.C.V86GL_STATE_UNSIGNED_INT, data_size: 8 }), bytes = new Uint8Array(header.length + 8); bytes.set(header);
    s.record(P.GLFN.QUERY_PARAMETER, bytes); const pointer = s.payloadView(); restored.submit(s);
    assert.equal(pointer.view.getUint32(P.F.QUERY_PARAMETER.status, true), 1); assert.equal(pointer.view.getFloat64(header.length, true), 0x12345678);
    s = new GLStream(); query(s, { operation: 0, size: 128 }); restored.mode(s, GL.SELECT); name(s = new GLStream(), 3); restored.submit(s);
    assert.equal(restored.shadow.current.error, GL.STACK_UNDERFLOW); restored.shadow.current.error = 0;
    s = new GLStream(); name(s, 1, 0); restored.submit(s); assert.equal(restored.shadow.current.error, GL.INVALID_OPERATION); restored.shadow.current.error = 0;
    s = new GLStream(); for (let i = 0; i < 64; ++i) name(s, 2, i); name(s, 2, 999); restored.submit(s);
    assert.equal(restored.shadow.current.error, GL.STACK_OVERFLOW); assert.equal(restored.shadow.current.state.selection.names.length, 64); restored.shadow.current.error = 0;
    s = new GLStream().record(P.GLFN.RESOLVED_RASTER_STATE, P.encodeRecord("RESOLVED_RASTER_STATE", { valid: 1 })); restored.submit(s);
    assert.equal(restored.shadow.current.error, GL.INVALID_OPERATION, "only CPU-generated segments can carry resolved raster state");
}
{
    const h = harness(); let s = new GLStream(); query(s, { operation: 0, size: 16 }); h.mode(s, GL.SELECT);
    point(s = new GLStream(), 0, 0, 0); const meta = query(s, { operation: 2, type: GL.RENDER }); h.submit(s);
    const r = P.decodeRecord("QUERY_RENDER_MODE", meta.view, 0), copy = harness(JSON.parse(JSON.stringify(h.shadow.getState())));
    for (const invalid of [{ ticket: r.ticket + 1 }, { size: r.size + 1 }, { offset: 1 }, { data_size: 262148 }, { offset: r.total }]) {
        s = new GLStream(); const answer = query(s, { operation: 3, ticket: r.ticket, size: r.size, data_size: 4, ...invalid }, 4); copy.submit(s);
        assert.equal(answer.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 2); assert.equal(answer.view.getUint32(P.F.QUERY_RENDER_MODE.error, true), GL.INVALID_OPERATION);
        assert.equal(copy.shadow.current.state.selection.pending.ticket, r.ticket); copy.shadow.current.error = 0;
    }
    s = new GLStream(); const answer = query(s, { operation: 3, ticket: r.ticket, size: r.size, data_size: r.total }, r.total); copy.submit(s);
    assert.equal(answer.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 1); assert.equal(copy.shadow.current.state.selection.pending, null);
}
{
    const h = harness(); h.submit(new GLStream().call("EDGE_FLAG", 0).call("PUSH_ATTRIB", 1).call("EDGE_FLAG", 1));
    const saved = JSON.parse(JSON.stringify(h.shadow.getState()));
    for (const [, typed] of saved.typed) for (const values of [typed.values, ...typed.attrib.map(a => a.values)]) {
        values[0x0B31] = values[0x0B43]; delete values[0x0B43];
    }
    const restored = harness(saved), s = new GLStream().call("POP_ATTRIB"), answers = [];
    for (const pname of [0x0B43, 0x0B31]) {
        const header = P.encodeRecord("QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 }), bytes = new Uint8Array(header.length + 8);
        bytes.set(header); s.record(P.GLFN.QUERY_STATE, bytes); answers.push(s.payloadView());
    }
    restored.submit(s); assert.deepEqual(answers.map(q => q.view.getFloat64(24, true)), [0, 64], "legacy EdgeFlag values migrate without colliding with MAX_LIST_NESTING");
}
console.log("Native selection/feedback transformations, clipping, names, primitive tokens, raster records and partial overflow passed");
