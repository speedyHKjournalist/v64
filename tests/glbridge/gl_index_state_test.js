"use strict";
const assert = require("node:assert/strict"), { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { createFakeHost } = require("./gl_fake_gpu.js"), reference = require("./gl_conformance/index_state_reference.json").cases;
const index = (s, operation, value = 0, mask = 0) => s.record(P.GLFN.INDEX_STATE, P.encodeRecord("INDEX_STATE", { operation, value, mask }));
const list = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
function query(s, pname, kind) { const bytes = new Uint8Array(32); bytes.set(P.encodeRecord("QUERY_STATE", { pname, value_kind: kind, data_size: 8 })); s.record(P.GLFN.QUERY_STATE, bytes); return s.payloadView(); }
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize(); shadow.setCapabilities(gpu.capabilities());
        const submit = s => {
            const bytes = s.bytes(), segments = shadow.process(bytes);
            for (const segment of segments || [{ offset: 0, length: bytes.length }]) { const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length); gpu.submit(copied ? part.slice() : part, {}); }
        };
        submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
        for (const entry of reference) {
            const s = new GLStream();
            if (entry.name === "double_precision") index(s, 0, 16777217.25);
            if (entry.name === "negative_half") index(s, 0, -3.5);
            if (entry.name === "negative_small_half") index(s, 0, -0.5);
            if (entry.name === "byte_value") index(s, 0, 255);
            if (entry.name === "clear_value") index(s, 1, -3.5);
            if (entry.name === "mask_value") index(s, 2, 0, 0x80000001);
            if (entry.name === "current_restored") { s.call("PUSH_ATTRIB", 0x4001); index(s, 0, 7.25); index(s, 1, 8.5); index(s, 2, 0, 7); s.call("POP_ATTRIB"); }
            if (entry.name === "list_compile") { list(s, 1, 1, GL.COMPILE); index(s, 0, 9.5); list(s, 2); }
            if (entry.name === "list_call") list(s, 3, 1);
            if (entry.name === "index_inside_begin") { s.call("BEGIN", GL.POINTS); index(s, 0, 2.75); s.call("END"); }
            if (entry.name === "clear_inside_begin") { s.call("BEGIN", GL.POINTS); index(s, 1, 10); s.call("END"); }
            if (entry.name === "mask_inside_begin") { s.call("BEGIN", GL.POINTS); index(s, 2, 0, 0); s.call("END"); }
            const queries = entry.values && [P.C.V86GL_STATE_DOUBLE, P.C.V86GL_STATE_FLOAT, P.C.V86GL_STATE_INTEGER, P.C.V86GL_STATE_BOOLEAN].map(kind => query(s, entry.pname, kind));
            submit(s); assert.equal(shadow.current.error, entry.error, entry.name); shadow.current.error = 0;
            if (queries) assert.deepEqual(queries.map(q => { assert.equal(q.view.getUint32(P.F.QUERY_STATE.status, true), 1); return q.view.getFloat64(24, true); }), entry.values, entry.name);
        }
        const restored = new GLShadow(); restored.setState(JSON.parse(JSON.stringify(shadow.getState())));
        assert.deepEqual(restored.stateValue(GL.CURRENT_INDEX), [[2.75], "f"]); assert.deepEqual(restored.stateValue(GL.INDEX_CLEAR_VALUE), [[-3.5], "f"]);
        assert.deepEqual(restored.stateValue(GL.INDEX_WRITEMASK), [[0x80000001], "u"]);
        const currentOnly = new GLStream().call("PUSH_ATTRIB", 1); index(currentOnly, 0, 6.25); index(currentOnly, 1, 11.5); index(currentOnly, 2, 0, 3); currentOnly.call("POP_ATTRIB"); submit(currentOnly);
        assert.deepEqual(shadow.stateValue(GL.CURRENT_INDEX), [[2.75], "f"]); assert.deepEqual(shadow.stateValue(GL.INDEX_CLEAR_VALUE), [[11.5], "f"]);
        assert.deepEqual(shadow.stateValue(GL.INDEX_WRITEMASK), [[3], "u"]);
        const colorOnly = new GLStream().call("PUSH_ATTRIB", 0x4000); index(colorOnly, 0, 12.5); index(colorOnly, 1, 13.5); index(colorOnly, 2, 0, 4); colorOnly.call("POP_ATTRIB"); submit(colorOnly);
        assert.deepEqual(shadow.stateValue(GL.CURRENT_INDEX), [[12.5], "f"]); assert.deepEqual(shadow.stateValue(GL.INDEX_CLEAR_VALUE), [[11.5], "f"]);
        assert.deepEqual(shadow.stateValue(GL.INDEX_WRITEMASK), [[3], "u"]);
        submit(index(new GLStream(), 3)); assert.equal(shadow.current.error, GL.INVALID_ENUM);
        assert.equal(gpu.hostErrors.length, 0); assert.equal(gpu.stats.refusals, 0); await gpu.idle();
    }
    console.log("gl_index_state_test: native defaults, float precision, signed ties/masks, lists, attribute groups, Begin/End errors and snapshots passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
