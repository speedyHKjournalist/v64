"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arrays.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
const scene = () => new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
function query(stream, pname, family, target = 0, index = 0, kind = P.C.V86GL_STATE_INTEGER) {
    const name = family ? "QUERY_PARAMETER" : "QUERY_STATE", header = P.encodeRecord(name,
        { pname, query_kind: family, target, index, value_kind: kind, data_size: 32 });
    const payload = new Uint8Array(header.length + 32); payload.fill(0xA5); payload.set(header); stream.record(P.GLFN[name], payload);
    const at = stream.length - payload.length;
    return () => { const bytes = stream.bytes(), v = new DataView(bytes.buffer, bytes.byteOffset + at, payload.length);
        return { status: v.getUint32(P.F[name].status, true), error: v.getUint32(P.F[name].error, true),
            values: Array.from({ length: v.getUint32(P.F[name].count, true) }, (_, i) => v.getFloat64(header.length + i * 8, true)),
            data: bytes.subarray(at + header.length, at + payload.length) }; };
}
const pointer = (stream, pname, index) => query(stream, pname, P.C.V86GL_PARAMETER_ARRAY_POINTER,
    index === undefined ? 0 : GL.VERTEX_ATTRIB_ARRAY_POINTER, index || 0, P.C.V86GL_STATE_UNSIGNED_INT);
const attrib = (stream, pname, index = 3, kind) => query(stream, pname, P.C.V86GL_PARAMETER_VERTEX_ATTRIB, index, 0, kind);
const conventional = (st, pnames, pointerPname) => [...pnames.map(p => query(st, p)), pointer(st, pointerPname)];
const values = queries => queries.flatMap(q => { assert.equal(q().status, 1); return q().values; });
function genericQueries(st) {
    return [GL.VERTEX_ATTRIB_ARRAY_SIZE, GL.VERTEX_ATTRIB_ARRAY_TYPE, GL.VERTEX_ATTRIB_ARRAY_STRIDE, GL.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
        GL.VERTEX_ATTRIB_ARRAY_NORMALIZED, GL.VERTEX_ATTRIB_ARRAY_ENABLED].map(p => attrib(st, p)).concat(pointer(st, GL.VERTEX_ATTRIB_ARRAY_POINTER, 3));
}
test("array metadata, pointers and attribute-stack boundaries match independent native GL", () => {
    const native = require("./gl_conformance/client_arrays_reference.json").cases, s = new GLShadow();
    const vertex = st => conventional(st, [0x807A, 0x807B, 0x807C, 0x8896], 0x808E);
    const texcoord = st => conventional(st, [0x8088, 0x8089, 0x808A, 0x889A], 0x8092);
    const initial = scene(), v = vertex(initial), t = texcoord(initial), g = genericQueries(initial); s.process(initial.bytes());
    assert.deepEqual(values(v), native.default_vertex); assert.deepEqual(values(t), native.default_texcoord); assert.deepEqual(values(g), native.default_generic);
    const setup = new GLStream().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7).pointerVBO("VERTEX_POINTER_VBO", 3, GL.SHORT, 16, 12).call("BIND_BUFFER", GL.ARRAY_BUFFER, 0);
    const bound = vertex(setup); s.process(setup.bytes()); assert.deepEqual(values(bound), native.vertex_buffer);
    const firstUnit = new GLStream().call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0 + 1).pointerVBO("TEX_COORD_POINTER_VBO", 2, GL.DOUBLE, 24, 100);
    const first = texcoord(firstUnit); firstUnit.call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0).call("ACTIVE_TEXTURE", GL.TEXTURE0 + 1);
    const zero = texcoord(firstUnit); s.process(firstUnit.bytes()); assert.deepEqual(values(first), native.unit1_texcoord); assert.deepEqual(values(zero), native.unit0_texcoord);
    const generic = new GLStream().call("BIND_BUFFER", GL.ARRAY_BUFFER, 9).attribPointerVBO(3, 2, GL.UNSIGNED_SHORT, true, 10, 256)
        .call("ENABLE_VERTEX_ATTRIB_ARRAY", 3).call("VERTEX_ATTRIB4F", 3, 0.25, -2.75, 3.5, 1);
    const before = genericQueries(generic), integer = attrib(generic, GL.CURRENT_VERTEX_ATTRIB); s.process(generic.bytes());
    assert.deepEqual(values(before), native.generic_buffer); assert.deepEqual(integer().values, native.current_integer);
    const stack = new GLStream().call("PUSH_CLIENT_ATTRIB", 2).attribPointerVBO(3, 4, GL.FLOAT, false, 0, 512)
        .call("DISABLE_VERTEX_ATTRIB_ARRAY", 3).call("VERTEX_ATTRIB4F", 3, 7, 8, 9, 10).call("POP_CLIENT_ATTRIB");
    const restored = genericQueries(stack), current = attrib(stack, GL.CURRENT_VERTEX_ATTRIB);
    stack.call("PUSH_ATTRIB", 1).call("VERTEX_ATTRIB4F", 3, 1, 2, 3, 4).call("POP_ATTRIB"); const restoredCurrent = attrib(stack, GL.CURRENT_VERTEX_ATTRIB);
    s.process(stack.bytes()); assert.deepEqual(values(restored), native.restored_generic);
    assert.deepEqual(current().values, native.client_keeps_current); assert.deepEqual(restoredCurrent().values, native.restored_current);
    const deletion = new GLStream().names(P.GLFN.DELETE_BUFFERS, [7]), deleted = vertex(deletion); s.process(deletion.bytes()); assert.deepEqual(values(deleted), native.deleted_buffer);
});
test("invalid pointer records and attribute queries preserve formats and destination buffers", () => {
    const native = require("./gl_conformance/client_arrays_reference.json").cases;
    for (const [key, command, size, type, stride] of [["vertex_size", "VERTEX_POINTER_VBO", 1, GL.FLOAT, 0],
        ["vertex_type", "VERTEX_POINTER_VBO", 3, GL.UNSIGNED_BYTE, 0], ["normal_type", "NORMAL_POINTER_VBO", 3, GL.UNSIGNED_BYTE, 0],
        ["index_type", "INDEX_POINTER_VBO", 1, GL.UNSIGNED_SHORT, 0], ["color_size", "COLOR_POINTER_VBO", 2, GL.FLOAT, 0],
        ["secondary_size", "SECONDARY_COLOR_POINTER_VBO", 4, GL.FLOAT, 0], ["fog_type", "FOG_COORD_POINTER_VBO", 1, GL.SHORT, 0],
        ["generic_stride", "VERTEX_ATTRIB_POINTER_VBO", 2, GL.FLOAT, -1]]) {
        const s = new GLShadow(); s.process(scene().bytes()); const before = JSON.stringify(s.current.state.arrays);
        const st = new GLStream(); if (command === "VERTEX_ATTRIB_POINTER_VBO") st.attribPointerVBO(3, size, type, false, stride, 0); else st.pointerVBO(command, size, type, stride, 0);
        s.process(st.bytes()); assert.equal(s.current.error, native[key][0], key); assert.equal(JSON.stringify(s.current.state.arrays), before);
    }
    for (const [pname, index, error] of [[GL.CURRENT_VERTEX_ATTRIB, 0, GL.INVALID_OPERATION], [GL.VERTEX_ATTRIB_ARRAY_SIZE, 16, GL.INVALID_VALUE], [0, 3, GL.INVALID_ENUM]]) {
        const s = new GLShadow(), st = scene(), q = attrib(st, pname, index); s.process(st.bytes());
        assert.equal(q().status, 2); assert.equal(q().error, error); assert.ok(q().data.every(v => v === 0xA5));
    }
    const s = new GLShadow(), st = scene(), q = pointer(st, GL.VERTEX_ATTRIB_ARRAY_POINTER, 16); s.process(st.bytes()); assert.equal(q().error, GL.INVALID_VALUE);
});
test("all conventional formats, per-unit pointers, generic arrays and current values survive snapshots", () => {
    const s = new GLShadow(), st = scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7);
    const pairs = [["VERTEX_POINTER_VBO", 3, GL.DOUBLE, 0x808E], ["NORMAL_POINTER_VBO", 3, GL.BYTE, 0x808F],
        ["COLOR_POINTER_VBO", 4, GL.UNSIGNED_INT, 0x8090], ["INDEX_POINTER_VBO", 1, GL.UNSIGNED_BYTE, 0x8091],
        ["EDGE_FLAG_POINTER_VBO", 1, GL.UNSIGNED_BYTE, 0x8093], ["SECONDARY_COLOR_POINTER_VBO", 3, GL.SHORT, 0x845D], ["FOG_COORD_POINTER_VBO", 1, GL.DOUBLE, 0x8456]];
    pairs.forEach(([command, size, type], i) => st.pointerVBO(command, size, type, i + 1, 0xF0000000 + i));
    for (let unit = 0; unit < 8; ++unit) st.call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0 + unit).pointerVBO("TEX_COORD_POINTER_VBO", 2, GL.FLOAT, 12, unit * 16);
    st.attribPointerVBO(15, 1, GL.UNSIGNED_BYTE, true, 8, 0xFFFF0000).call("ENABLE_VERTEX_ATTRIB_ARRAY", 15).call("VERTEX_ATTRIB4F", 15, 0.125, 0.25, 0.5, 1);
    s.process(st.bytes()); assert.equal(s.current.error, 0);
    const restored = new GLShadow(); restored.setState(JSON.parse(JSON.stringify(s.getState())));
    assert.deepEqual(restored.current.state.arrays, s.current.state.arrays);
    const check = new GLStream(), answers = pairs.map(p => pointer(check, p[3]));
    for (let unit = 0; unit < 8; ++unit) { check.call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0 + unit); answers.push(pointer(check, 0x8092)); }
    answers.push(pointer(check, GL.VERTEX_ATTRIB_ARRAY_POINTER, 15)); restored.process(check.bytes());
    assert.deepEqual(values(answers), [...pairs.map((p, i) => 0xF0000000 + i), ...Array.from({ length: 8 }, (_, i) => i * 16), 0xFFFF0000]);
});
test("mapped vertex and element sources reject all draw families while disabled sources remain legal", () => {
    for (const generic of [false, true]) {
        const s = new GLShadow(), st = scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7).bufferData(GL.ARRAY_BUFFER, 64, GL.STATIC_DRAW, null);
        if (generic) st.attribPointerVBO(3, 3, GL.FLOAT, false, 0, 0).call("ENABLE_VERTEX_ATTRIB_ARRAY", 3);
        else st.pointerVBO("VERTEX_POINTER_VBO", 3, GL.FLOAT, 0, 0).call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY);
        st.record(P.GLFN.QUERY_BUFFER_MAP, P.encodeRecord("QUERY_BUFFER_MAP", { target: GL.ARRAY_BUFFER, access: GL.READ_WRITE_ARB, pointer: 1024 })); s.process(st.bytes());
        const triangle = { vertex: { size: 3, type: GL.FLOAT, data: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]) } };
        for (const draw of [new GLStream().call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 3),
            new GLStream().drawArrays(GL.TRIANGLES, 3, triangle), new GLStream().drawArraysGL2(GL.TRIANGLES, 3, triangle),
            new GLStream().drawElements(GL.TRIANGLES, new Uint8Array([0, 1, 2]), GL.UNSIGNED_BYTE, triangle),
            new GLStream().drawElementsGL2(GL.TRIANGLES, new Uint8Array([0, 1, 2]), GL.UNSIGNED_BYTE, triangle),
            new GLStream().drawElementsDirect(GL.TRIANGLES, 3, GL.UNSIGNED_BYTE, 0, 0, 2)]) {
            s.current.error = 0; s.process(draw.bytes()); assert.equal(s.current.error, GL.INVALID_OPERATION);
        }
        s.current.error = 0; const legal = new GLStream().call(generic ? "DISABLE_VERTEX_ATTRIB_ARRAY" : "DISABLE_CLIENT_STATE", generic ? 3 : GL.VERTEX_ARRAY)
            .call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 0); s.process(legal.bytes()); assert.equal(s.current.error, 0);
    }
    const s = new GLShadow(), st = scene().call("BIND_BUFFER", GL.ELEMENT_ARRAY_BUFFER, 9).bufferData(GL.ELEMENT_ARRAY_BUFFER, 4, GL.STATIC_DRAW, null)
        .record(P.GLFN.QUERY_BUFFER_MAP, P.encodeRecord("QUERY_BUFFER_MAP", { target: GL.ELEMENT_ARRAY_BUFFER, access: GL.READ_ONLY_ARB, pointer: 100 }));
    st.record(P.GLFN.DRAW_ELEMENTS_DIRECT, P.encodeRecord("DRAW_ELEMENTS_DIRECT", { mode: GL.POINTS, count: 1, type: GL.UNSIGNED_BYTE, offset: 0 })); s.process(st.bytes()); assert.equal(s.current.error, GL.INVALID_OPERATION);
});
test("deleted buffer identities remain while client stacks refer to them and retire after the last array reference", () => {
    const s = new GLShadow(), setup = scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)
        .pointerVBO("VERTEX_POINTER_VBO", 3, GL.FLOAT, 0, 12).call("PUSH_CLIENT_ATTRIB", 2);
    s.process(setup.bytes()); const old = s.boundBuffer(GL.ARRAY_BUFFER);
    s.process(new GLStream().names(P.GLFN.DELETE_BUFFERS, [7]).call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)
        .pointerVBO("VERTEX_POINTER_VBO", 2, GL.SHORT, 8, 16).bytes()); const replacement = s.boundBuffer(GL.ARRAY_BUFFER);
    assert.notEqual(old.id, replacement.id); assert.ok(s.current.group.bufferObjects.has(old.id));
    s.process(new GLStream().call("POP_CLIENT_ATTRIB").bytes()); assert.equal(s.boundBuffer(GL.ARRAY_BUFFER), old);
    assert.equal(s.current.state.arrays.vertex.bufferId, old.id); assert.equal(s.current.state.arrays.vertex.pointer, 12);
    s.process(new GLStream().call("BIND_BUFFER", GL.ARRAY_BUFFER, 7).bytes()); assert.ok(s.current.group.bufferObjects.has(old.id), "the vertex array still holds the object");
    s.process(new GLStream().pointerVBO("VERTEX_POINTER_VBO", 3, GL.FLOAT, 0, 0).bytes()); assert.equal(s.current.group.bufferObjects.has(old.id), false);
});
(async () => { for (const { name, fn } of tests) { try { await fn(); console.log("ok   " + name); }
    catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; return; } }
console.log(tests.length + " CPU client array tests passed"); })();
