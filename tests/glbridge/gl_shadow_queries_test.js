"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arrays.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_names.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_queries.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const tests = [], test = (name, fn) => tests.push({ name, fn });
const scene = () => new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
function parameter(st, family, target, pname) {
    const header = P.encodeRecord("QUERY_PARAMETER", { query_kind: family, target, pname, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 });
    const payload = new Uint8Array(header.length + 8); payload.fill(0xA5); payload.set(header); st.record(P.GLFN.QUERY_PARAMETER, payload);
    const at = st.length - payload.length;
    return () => { const b = st.bytes(), v = new DataView(b.buffer, b.byteOffset + at); return [v.getUint32(8, true), v.getUint32(20, true), v.getFloat64(header.length, true)]; };
}
const isQuery = (st, id) => parameter(st, P.C.V86GL_PARAMETER_IS_OBJECT, P.C.V86GL_OBJECT_KIND_QUERY, id);
const currentQuery = st => parameter(st, P.C.V86GL_PARAMETER_QUERY_TARGET, GL.SAMPLES_PASSED, GL.CURRENT_QUERY);
test("query names, implicit creation and errors follow native GL with the GL 2.1 active-name restriction", () => {
    const native = require("./gl_conformance/queries_reference.json").cases, s = new GLShadow(), st = scene().names(P.GLFN.GEN_QUERIES, [1]);
    const reserved = isQuery(st, 1); st.call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7); const exists = isQuery(st, 7), current = currentQuery(st);
    s.process(st.bytes()); assert.equal(reserved()[2], native.reserved); assert.equal(exists()[2], native.created); assert.equal(current()[2], native.current);
    for (const [key, command, expected] of [
        ["zero_begin", st => st.call("BEGIN_QUERY", GL.SAMPLES_PASSED, 0)], ["nested_begin", st => st.call("BEGIN_QUERY", GL.SAMPLES_PASSED, 8)],
        // Apple permits active Gen/Delete; GL 2.1 4.1.7 explicitly forbids both.
        ["active_gen_zero", st => st.names(P.GLFN.GEN_QUERIES, []), GL.INVALID_OPERATION],
        ["active_delete_unused", st => st.names(P.GLFN.DELETE_QUERIES, [999]), GL.INVALID_OPERATION],
        ["bad_target", st => st.call("END_QUERY", GL.TEXTURE_2D)],
    ]) { s.current.error = 0; s.process(command(new GLStream()).bytes()); assert.equal(s.current.error, expected ?? native[key], key); assert.equal(s.current.activeQueryName, 7); }
    s.current.error = 0; s.process(new GLStream().call("END_QUERY", GL.SAMPLES_PASSED).bytes()); assert.equal(s.current.error, native.valid_end);
    s.process(new GLStream().call("END_QUERY", GL.SAMPLES_PASSED).bytes()); assert.equal(s.current.error, native.missing_end);
    s.current.error = 0; s.process(new GLStream().names(P.GLFN.DELETE_QUERIES, [7, 999]).bytes()); assert.equal(s.current.error, native.delete_unused);
    const check = new GLStream(), gone = isQuery(check, 7); s.process(check.bytes()); assert.equal(gone()[2], native.deleted);
});
test("query namespaces and active objects stay private across shared contexts and snapshots", () => {
    const s = new GLShadow(), st = scene().call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7)
        .makeCurrent(2, 0, 0, 64, 64, 2, 1);
    const absent = isQuery(st, 7); st.call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7); s.process(st.bytes()); assert.equal(s.current.error, 0); assert.equal(absent()[2], 0);
    const copy = new GLShadow(); copy.setState(JSON.parse(JSON.stringify(s.getState())));
    const end = new GLStream().call("END_QUERY", GL.SAMPLES_PASSED).makeCurrent(1, 0, 0, 64, 64, 1, 1), current = currentQuery(end);
    end.call("END_QUERY", GL.SAMPLES_PASSED); copy.process(end.bytes()); assert.equal(current()[2], 7); assert.equal(copy.current.error, 0);
    assert.notEqual(copy.contexts.get("context:1").queryObjects.get(7), copy.contexts.get("context:2").queryObjects.get(7));
    const allocate = new GLStream().record(P.GLFN.QUERY_NAMES, P.encodeRecord("QUERY_NAMES", { object_kind: P.C.V86GL_OBJECT_KIND_QUERY, count: 0 }));
    copy.process(allocate.bytes()); assert.equal(copy.current.error, 0);
    const generated = new GLStream(); const h = P.encodeRecord("QUERY_NAMES", { object_kind: P.C.V86GL_OBJECT_KIND_QUERY, count: 1, data_size: 4 });
    const payload = new Uint8Array(h.length + 4); payload.set(h); generated.record(P.GLFN.QUERY_NAMES, payload); const response = generated.payloadView();
    copy.process(generated.bytes()); assert.equal(response.view.getUint32(h.length, true), 1);
});
test("invalid result requests complete as failed on CPU and renderer preserves the failed response", async () => {
    const s = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
    const initial = scene().names(P.GLFN.GEN_QUERIES, [1]).call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7); s.process(initial.bytes()); gpu.submit(initial.bytes(), {});
    for (const [id, pname, error] of [[7, GL.QUERY_RESULT_AVAILABLE, GL.INVALID_OPERATION], [1, GL.QUERY_RESULT, GL.INVALID_OPERATION],
        [99, GL.QUERY_RESULT, GL.INVALID_OPERATION]]) {
        const st = new GLStream(), r = st.queryObjectiv(P.C.V86GL_OBJECT_KIND_QUERY, id, pname); s.process(st.bytes());
        assert.equal(r.view.getUint32(P.F.QUERY_OBJECT_IV.status, true), 2); assert.equal(r.view.getUint32(P.F.QUERY_OBJECT_IV.reserved, true), error);
        const before = st.bytes().slice(); gpu.submit(st.bytes(), {}); assert.deepEqual(st.bytes(), before);
    }
    const bad = new GLStream().record(P.GLFN.QUERY_OBJECT_BATCH, new Uint8Array([...P.encodeRecord("QUERY_OBJECT_BATCH",
        { count: 1, object_kind: P.C.V86GL_OBJECT_KIND_QUERY }), ...P.encodeRecord("QUERY_OBJECT_BATCH_ENTRY", { name: 7, available: 0xA5A5A5A5, result: 0xA5A5A5A5 })]));
    s.process(bad.bytes()); const failed = bad.bytes().slice(); gpu.submit(bad.bytes(), {}); assert.deepEqual(bad.bytes(), failed);
    assert.equal(new DataView(failed.buffer).getUint32(4 + P.F.QUERY_OBJECT_BATCH.status, true), 2);
    const end = new GLStream().call("END_QUERY", GL.SAMPLES_PASSED); s.process(end.bytes()); gpu.submit(end.bytes(), {});
    const invalid = new GLStream(), invalidReply = invalid.queryObjectiv(P.C.V86GL_OBJECT_KIND_QUERY, 7, 0); s.process(invalid.bytes()); assert.equal(s.current.error, GL.INVALID_OPERATION);
    assert.equal(invalidReply.view.getUint32(P.F.QUERY_OBJECT_IV.reserved, true), GL.INVALID_ENUM);
    gpu.flushFrame(); await gpu.idle(); assert.equal(gpu.hostErrors.length, 0); assert.equal(gpu.stats.refusals, 0);
});
test("renderer suspends parallel context queries independently and boolean targets return one", async () => {
    for (const copied of [false, true]) {
        const s = new GLShadow(), { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const triangle = { vertex: { size: 3, type: GL.FLOAT, data: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]) } };
        const st = scene().call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7).drawArrays(GL.TRIANGLES, 3, triangle).makeCurrent(2, 0, 0, 64, 64, 2, 1)
            .call("BEGIN_QUERY", GL.ANY_SAMPLES_PASSED, 7).drawArrays(GL.TRIANGLES, 3, triangle).makeCurrent(1, 0, 0, 64, 64, 1, 1).call("END_QUERY", GL.SAMPLES_PASSED)
            .makeCurrent(2, 0, 0, 64, 64, 2, 1).call("END_QUERY", GL.ANY_SAMPLES_PASSED);
        s.process(st.bytes()); assert.equal(s.current.error, 0); gpu.submit(copied ? st.bytes().slice() : st.bytes(), {}); gpu.flushFrame();
        const a = gpu.contexts.get("context:1").queryObjects.get(7), b = gpu.contexts.get("context:2").queryObjects.get(7);
        assert.notEqual(a, b); assert.equal(log.queryResolves[0].count, 2);
        const staging = log.buffers.find(buffer => buffer.descriptor.label === "GL occlusion readback");
        new DataView(staging.storage).setUint32(0, 1, true); new DataView(staging.storage).setUint32(8, 1, true);
        await gpu.idle(); assert.equal(a.result, P.C.V86GL_QUERY_VISIBLE_SAMPLES); assert.equal(b.result, 1); assert.ok(a.ready && b.ready);
        assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0);
        const cpu = new GLStream().call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7); s.current.error = 0; s.process(cpu.bytes());
        assert.equal(s.current.error, GL.INVALID_OPERATION, "a query object's target is fixed on first use");
    }
});
test("blocking query results submit pending work, wait for readback and reject stale generations", async () => {
    for (const copied of [false, true]) for (const reuse of [false, true]) {
        const s = new GLShadow(), { host, log, device } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const create = device.createBuffer.bind(device); let release;
        device.createBuffer = descriptor => { const buffer = create(descriptor);
            if (descriptor.label === "GL occlusion readback") buffer.mapAsync = () => new Promise(resolve => { release = resolve; }); return buffer; };
        const st = scene().call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7).drawArrays(GL.TRIANGLES, 3,
            { vertex: { size: 3, type: GL.FLOAT, data: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]) } }).call("END_QUERY", GL.SAMPLES_PASSED);
        const response = st.queryObjectiv(P.C.V86GL_OBJECT_KIND_QUERY, 7, GL.QUERY_RESULT); response.view.setUint32(P.F.QUERY_OBJECT_IV.value, 0xA5A5A5A5, true);
        const bytes = st.bytes(); s.process(bytes); gpu.options.writeGuestMemory = (offset, data) => bytes.set(data, offset); gpu.submit(copied ? bytes.slice() : bytes, {});
        assert.ok(log.submits.length && log.queryResolves.length, "a blocking result must submit its producing work"); assert.ok(release);
        for (let i = 0; i < 20; ++i) await Promise.resolve(); assert.equal(response.view.getUint32(P.F.QUERY_OBJECT_IV.status, true), 0);
        if (reuse) {
            const again = new GLStream().call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7).call("END_QUERY", GL.SAMPLES_PASSED); s.process(again.bytes()); gpu.submit(again.bytes(), {});
        }
        const staging = log.buffers.find(buffer => buffer.descriptor.label === "GL occlusion readback"); new DataView(staging.storage).setUint32(0, 1, true);
        release(); await gpu.idle(); assert.equal(response.view.getUint32(P.F.QUERY_OBJECT_IV.status, true), reuse ? 2 : 1);
        assert.equal(response.view.getUint32(P.F.QUERY_OBJECT_IV.value, true), reuse ? 0xA5A5A5A5 : P.C.V86GL_QUERY_VISIBLE_SAMPLES);
        assert.equal(gpu.hostErrors.length, 0); assert.equal(gpu.stats.refusals, 0);
    }
});
test("empty queries avoid framebuffer work and batch availability polls submit queued segments", async () => {
    const s = new GLShadow(), { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
    const empty = scene().call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 99).call("BEGIN_QUERY", GL.SAMPLES_PASSED, 7).call("END_QUERY", GL.SAMPLES_PASSED);
    const result = empty.queryObjectiv(P.C.V86GL_OBJECT_KIND_QUERY, 7, GL.QUERY_RESULT); s.process(empty.bytes()); gpu.submit(empty.bytes(), {});
    assert.equal(result.view.getUint32(P.F.QUERY_OBJECT_IV.status, true), 1); assert.equal(result.view.getUint32(P.F.QUERY_OBJECT_IV.value, true), 0);
    assert.equal(log.passes.length, 0); assert.equal(gpu.stats.refusals, 0);
    const draw = new GLStream().call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0).call("BEGIN_QUERY", GL.SAMPLES_PASSED, 8)
        .drawArrays(GL.TRIANGLES, 3, { vertex: { size: 3, type: GL.FLOAT, data: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]) } }).call("END_QUERY", GL.SAMPLES_PASSED);
    s.process(draw.bytes()); gpu.submit(draw.bytes(), {}); assert.equal(log.queryResolves.length, 0);
    const poll = new GLStream().record(P.GLFN.QUERY_OBJECT_BATCH, new Uint8Array([...P.encodeRecord("QUERY_OBJECT_BATCH", { count: 1, object_kind: P.C.V86GL_OBJECT_KIND_QUERY }),
        ...P.encodeRecord("QUERY_OBJECT_BATCH_ENTRY", { name: 8 })]));
    s.process(poll.bytes()); gpu.submit(poll.bytes(), {}); assert.equal(log.queryResolves.length, 1); await gpu.idle(); assert.equal(gpu.queries.get(8).ready, true);
});

(async () => { for (const { name, fn } of tests) { try { await fn(); console.log("ok   " + name); }
    catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; return; } }
console.log(tests.length + " CPU query object tests passed"); })();
