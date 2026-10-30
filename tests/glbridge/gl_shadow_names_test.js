"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arrays.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_names.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arb.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
const scene = () => new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
function generate(stream, kind, count, capacity = Math.max(0, count * 4), declared = capacity) {
    const header = P.encodeRecord("QUERY_NAMES", { object_kind: kind, count, data_size: declared }), payload = new Uint8Array(header.length + capacity);
    payload.fill(0xA5); payload.set(header); stream.record(P.GLFN.QUERY_NAMES, payload);
    const offset = stream.length - payload.length;
    return () => { const b = stream.bytes(), v = new DataView(b.buffer, b.byteOffset + offset, payload.length);
        return { status: v.getUint32(P.F.QUERY_NAMES.status, true), error: v.getUint32(P.F.QUERY_NAMES.error, true),
            values: Array.from({ length: Math.floor(capacity / 4) }, (_, i) => v.getUint32(header.length + i * 4, true)) }; };
}
const families = [[P.C.V86GL_OBJECT_KIND_TEXTURE, "BIND_TEXTURE", GL.TEXTURE_2D, "textures", "DELETE_TEXTURES"],
    [P.C.V86GL_OBJECT_KIND_BUFFER, "BIND_BUFFER", GL.ARRAY_BUFFER, "buffers", "DELETE_BUFFERS"],
    [P.C.V86GL_OBJECT_KIND_RENDERBUFFER, "BIND_RENDERBUFFER", GL.RENDERBUFFER_EXT, "renderbuffers", "DELETE_RENDERBUFFERS"],
    [P.C.V86GL_OBJECT_KIND_FRAMEBUFFER, "BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, "framebuffers", "DELETE_FRAMEBUFFERS"],
    [P.C.V86GL_OBJECT_KIND_ARB_PROGRAM, "BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, "arbPrograms", "DELETE_PROGRAMS_ARB"]];
test("CPU generators skip bound and reserved names in each public namespace", () => {
    for (const [kind, bind, target, field] of families) {
        const s = new GLShadow(), st = scene().call(bind, target, 1).call(bind, target, 3), q = generate(st, kind, 3);
        s.process(st.bytes()); assert.deepEqual(q(), { status: 1, error: 0, values: [2, 4, 5] });
        const owner = field === "framebuffers" ? s.current : s.current.group;
        for (const n of [2, 4, 5]) {
            const object = owner[field].get(n); assert.ok(object);
            assert.equal(field === "textures" || field === "arbPrograms" ? object.target : +object.created, 0, "generated names acquire object state on first binding");
        }
        const next = new GLStream().call(bind, target, 7), more = generate(next, kind, 3); s.process(next.bytes()); assert.deepEqual(more().values, [6, 8, 9]);
    }
});
test("ARB generated names become objects on first binding and remain allocated across snapshots and sharing", () => {
    const kind = P.C.V86GL_OBJECT_KIND_ARB_PROGRAM, s = new GLShadow(), st = scene(), q = generate(st, kind, 2);
    s.process(st.bytes()); assert.deepEqual(q().values, [1, 2]);
    const isObject = (stream, id) => {
        const header = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_IS_OBJECT, target: kind,
            pname: id, value_kind: P.C.V86GL_STATE_BOOLEAN, data_size: 8 });
        const payload = new Uint8Array(header.length + 8); payload.set(header); stream.record(P.GLFN.QUERY_PARAMETER, payload);
        return stream.payloadView();
    };
    const queries = new GLStream(), before = isObject(queries, 1);
    queries.call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 1); const after = isObject(queries, 1);
    queries.names(P.GLFN.DELETE_PROGRAMS_ARB, [1]); const deleted = isObject(queries, 1);
    s.process(queries.bytes());
    for (const [record, expected] of [[before, 0], [after, 1], [deleted, 0]]) {
        assert.equal(record.view.getUint32(P.F.QUERY_PARAMETER.status, true), 1);
        assert.equal(record.view.getFloat64(P.RECORDS.QUERY_PARAMETER.size, true), expected);
    }
    const copy = new GLShadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    const more = new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1), next = generate(more, kind, 1);
    copy.process(more.bytes()); assert.deepEqual(next().values, [3]); assert.equal(copy.current.group.arbPrograms.has(2), true);
});
test("GLSL reserves one shared shader/program namespace and consumes each reservation with its matching creation", () => {
    const s = new GLShadow(), st = scene().call("CREATE_SHADER", 1, GL.VERTEX_SHADER).call("CREATE_PROGRAM", 3);
    const programs = generate(st, P.C.V86GL_OBJECT_KIND_PROGRAM, 2), shaders = generate(st, P.C.V86GL_OBJECT_KIND_SHADER, 2);
    s.process(st.bytes()); assert.deepEqual(programs().values, [2, 4]); assert.deepEqual(shaders().values, [5, 6]);
    assert.equal(s.current.group.programs.has(2), false); assert.equal(s.current.group.shaders.has(5), false);
    s.process(new GLStream().call("CREATE_SHADER", 2, GL.VERTEX_SHADER).call("CREATE_PROGRAM", 2)
        .call("CREATE_SHADER", 5, GL.VERTEX_SHADER).call("CREATE_SHADER", 6, GL.FRAGMENT_SHADER).call("CREATE_PROGRAM", 2).bytes());
    assert.equal(s.stats.rejected, 2); assert.deepEqual([...s.current.group.glslNames], [[4, P.C.V86GL_OBJECT_KIND_PROGRAM]]);
    assert.equal(s.current.group.programs.has(2), true); assert.equal(s.current.group.shaders.has(2), false);
    const copy = new GLShadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    const shared = new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1), next = generate(shared, P.C.V86GL_OBJECT_KIND_SHADER, 1);
    copy.process(shared.bytes()); assert.deepEqual(next().values, [7]); assert.equal(copy.current.group.glslNames.get(4), P.C.V86GL_OBJECT_KIND_PROGRAM);
    copy.current.group.nameCursors.set(P.C.V86GL_OBJECT_KIND_SHADER, 0xFFFFFFFF);
    const wrap = new GLStream(), wrapped = generate(wrap, P.C.V86GL_OBJECT_KIND_PROGRAM, 2); copy.process(wrap.bytes());
    assert.deepEqual(wrapped().values, [0xFFFFFFFF, 8]);
    const privateContext = new GLStream().makeCurrent(3, 0, 0, 64, 64, 3, 3), own = generate(privateContext, P.C.V86GL_OBJECT_KIND_PROGRAM, 1);
    copy.process(privateContext.bytes()); assert.deepEqual(own().values, [1]);
});

test("name cursors wrap past zero, skip live names and survive deletion, sharing and snapshots", () => {
    const s = new GLShadow(); s.process(scene().call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bytes());
    s.current.group.nameCursors.set(P.C.V86GL_OBJECT_KIND_BUFFER, 0xFFFFFFFF);
    const st = new GLStream(), q = generate(st, P.C.V86GL_OBJECT_KIND_BUFFER, 3); s.process(st.bytes()); assert.deepEqual(q().values, [0xFFFFFFFF, 2, 3]);
    s.process(new GLStream().names(P.GLFN.DELETE_BUFFERS, [2]).bytes());
    const copy = new GLShadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    const next = new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1), shared = generate(next, P.C.V86GL_OBJECT_KIND_BUFFER, 2);
    copy.process(next.bytes()); assert.deepEqual(shared().values, [4, 5]);
    const separate = new GLStream().makeCurrent(3, 0, 0, 64, 64, 3, 3), own = generate(separate, P.C.V86GL_OBJECT_KIND_BUFFER, 2);
    copy.process(separate.bytes()); assert.deepEqual(own().values, [1, 2]);
});
test("framebuffer Gen aliases reserve shared names before their first core or EXT binding", () => {
    const s = new GLShadow(), a = scene(), first = generate(a, P.C.V86GL_OBJECT_KIND_FRAMEBUFFER, 2), texture = generate(a, P.C.V86GL_OBJECT_KIND_TEXTURE, 2);
    s.process(a.bytes()); assert.deepEqual(first().values, [1, 2]); assert.deepEqual(texture().values, [1, 2]);
    const b = new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1), second = generate(b, P.C.V86GL_OBJECT_KIND_FRAMEBUFFER, 2), shared = generate(b, P.C.V86GL_OBJECT_KIND_TEXTURE, 2);
    s.process(b.bytes()); assert.deepEqual(second().values, [3, 4]); assert.deepEqual(shared().values, [3, 4]);
});
test("invalid generation, zero count and Begin leave names, cursors and output unchanged", () => {
    for (const [kind, count, capacity, declared, expected] of [[P.C.V86GL_OBJECT_KIND_BUFFER, -1, 8, 8, GL.INVALID_VALUE],
        [P.C.V86GL_OBJECT_KIND_TEXTURE, 3, 8, 8, GL.INVALID_VALUE], [P.C.V86GL_OBJECT_KIND_TEXTURE, 1, 4, 8, GL.INVALID_VALUE],
        [999, 2, 8, 8, GL.INVALID_ENUM], [P.C.V86GL_OBJECT_KIND_BUFFER, 0, 8, 8, 0]]) {
        const s = new GLShadow(), st = scene(), q = generate(st, kind, count, capacity, declared); s.process(st.bytes());
        assert.equal(q().status, expected ? 2 : 1); assert.equal(q().error, expected); assert.ok(q().values.every(v => v === 0xA5A5A5A5));
        assert.equal(s.current.group.textures.size, 0); assert.equal(s.current.group.buffers.size, 0); assert.equal(s.current.group.nameCursors.size, 0);
    }
    const s = new GLShadow(), st = scene().call("BEGIN", GL.POINTS), q = generate(st, P.C.V86GL_OBJECT_KIND_BUFFER, 0);
    st.call("END"); s.process(st.bytes()); assert.equal(q().error, GL.INVALID_OPERATION);
    const noContext = new GLShadow(), no = new GLStream(), failed = generate(no, P.C.V86GL_OBJECT_KIND_BUFFER, 1); noContext.process(no.bytes()); assert.equal(failed().error, GL.INVALID_OPERATION);
});
test("failed object reservation rolls back names and identity counters", () => {
    const s = new GLShadow(); s.process(scene().bytes()); const next = s.current.group.nextImageId;
    const create = s.textureObject; let calls = 0;
    s.textureObject = function(name) { if (++calls === 2) throw new RangeError("allocation failed"); return create.call(this, name); };
    const st = new GLStream(), q = generate(st, P.C.V86GL_OBJECT_KIND_TEXTURE, 3); s.process(st.bytes());
    assert.equal(q().error, GL.OUT_OF_MEMORY); assert.deepEqual(q().values, [0xA5A5A5A5, 0xA5A5A5A5, 0xA5A5A5A5]);
    assert.equal(s.current.group.textures.size, 0); assert.equal(s.current.group.textureImages.size, 0);
    assert.equal(s.current.group.nextImageId, next); assert.equal(s.current.group.nameCursors.size, 0);
});
(async () => { for (const { name, fn } of tests) { try { await fn(); console.log("ok   " + name); }
    catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; return; } }
console.log(tests.length + " CPU name allocation tests passed"); })();
