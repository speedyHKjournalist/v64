"use strict";
const assert = require("node:assert/strict"), { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_state.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arb.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    reference = require("./gl_conformance/state_queries_reference.json").cases;
function query(s, pname, kind, count) {
    const data = new Uint8Array(24 + count * 8); data.set(P.encodeRecord("QUERY_STATE", { pname, value_kind: kind, data_size: count * 8 }));
    s.record(P.GLFN.QUERY_STATE, data); return s.payloadView();
}
(async () => {
    for (const copied of [false, true]) for (const bc of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        shadow.setCapabilities(caps.capabilities({}, { bc }));
        const submit = s => { const bytes = s.bytes(); shadow.process(bytes); const answered = bytes.slice(); gpu.submit(copied ? bytes.slice() : bytes, {}); assert.deepEqual(bytes, answered); };
        submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
        for (const entry of reference) {
            if (entry.name === "attrib_pushed") submit(new GLStream().call("PUSH_ATTRIB", 1).call("PUSH_ATTRIB", 0x4000).call("PUSH_CLIENT_ATTRIB", 2));
            if (entry.name === "attrib_popped") submit(new GLStream().call("POP_ATTRIB").call("POP_ATTRIB").call("POP_CLIENT_ATTRIB"));
            const load = (mode, values, unit) => {
                const s = new GLStream(); if (unit !== undefined) s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + unit);
                s.call("MATRIX_MODE", mode).record(P.GLFN.LOAD_MATRIXF, P.encodeRecord("LOAD_MATRIXF", { values })); submit(s);
            };
            if (entry.name === "transpose_mv") load(GL.MODELVIEW, Array.from({ length: 16 }, (_, i) => i + 1));
            if (entry.name === "transpose_projection") load(GL.PROJECTION, Array.from({ length: 16 }, (_, i) => (i + 1) * 2));
            if (entry.name === "transpose_tex0") load(GL.TEXTURE, Array.from({ length: 16 }, (_, i) => i + 2), 0);
            if (entry.name === "transpose_tex3") load(GL.TEXTURE, Array.from({ length: 16 }, (_, i) => -i - 0.5), 3);
            if (entry.name === "transpose_tex0_unchanged") submit(new GLStream().call("ACTIVE_TEXTURE", GL.TEXTURE0));
            if (entry.name === "transpose_color") load(GL.COLOR, Array.from({ length: 16 }, (_, i) => i % 5 === 0 ? i + 1 : 0));
            let expected = entry.values;
            if (["line_range", "aliased_line_range"].includes(entry.name)) expected = [1, 64];
            if (entry.name === "point_granularity" || entry.name === "line_granularity") expected = [1];
            if (entry.name === "max_color_matrix") expected = [4];
            if (entry.name === "compressed_formats") expected = bc ? [33776, 33777, 33778, 33779] : [];
            assert.equal(entry.error, 0, entry.name);
            for (const kind of [P.C.V86GL_STATE_INTEGER, P.C.V86GL_STATE_FLOAT, P.C.V86GL_STATE_DOUBLE, P.C.V86GL_STATE_BOOLEAN]) {
                const s = new GLStream(), q = query(s, entry.pname, kind, expected.length); submit(s);
                assert.equal(q.view.getUint32(P.F.QUERY_STATE.status, true), 1, entry.name); assert.equal(q.view.getUint32(P.F.QUERY_STATE.count, true), expected.length);
                const values = expected.map((n, i) => q.view.getFloat64(24 + i * 8, true));
                assert.deepEqual(values, expected.map(n => kind === P.C.V86GL_STATE_BOOLEAN ? +!!n : kind === P.C.V86GL_STATE_FLOAT ? Math.fround(n) :
                    kind === P.C.V86GL_STATE_INTEGER ? n < 0 ? -Math.round(-n) : Math.round(n) : n), entry.name);
            }
        }
        const bad = new GLStream().call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 1).programStringARB(GL.VERTEX_PROGRAM_ARB, "!!ARBvp1.0\nBROKEN; END"); submit(bad);
        assert.ok(shadow.current.arb.errorPosition >= 0); shadow.current.error = 0;
        const s = new GLStream(), q = query(s, GL.PROGRAM_ERROR_POSITION_ARB, P.C.V86GL_STATE_INTEGER, 1); submit(s);
        assert.equal(q.view.getFloat64(24, true), shadow.current.arb.errorPosition);
        const frozen = JSON.parse(JSON.stringify(shadow.getState())), restored = new GLShadow(); restored.setState(frozen);
        assert.deepEqual(caps.vector(restored.capabilities, GL.COMPRESSED_TEXTURE_FORMATS), bc ? [33776, 33777, 33778, 33779] : []);
        frozen.capabilities.profile.vectors[GL.LINE_WIDTH_RANGE][1] = 4096;
        assert.deepEqual(caps.vector(restored.capabilities, GL.LINE_WIDTH_RANGE), [1, 64]);
        const previous = JSON.parse(JSON.stringify(shadow.capabilities)); previous.profile.vectors[GL.LINE_WIDTH_RANGE] = [1, 32];
        const stable = caps.freeze(previous); previous.profile.vectors[GL.LINE_WIDTH_RANGE][1] = 8192;
        assert.deepEqual(caps.vector(stable, GL.LINE_WIDTH_RANGE), [1, 32]); assert.ok(Object.isFrozen(stable.profile.vectors[GL.LINE_WIDTH_RANGE]));
        const legacy = JSON.parse(JSON.stringify(shadow.capabilities)); delete legacy.profile.vectors; delete legacy.profile.integers[GL.MAX_COLOR_MATRIX_STACK_DEPTH_SGI];
        const old = new GLShadow(); old.setCapabilities(legacy); old.process(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("MATRIX_MODE", GL.COLOR).call("PUSH_MATRIX").call("PUSH_MATRIX").bytes());
        assert.equal(caps.integer(old.capabilities, GL.MAX_COLOR_MATRIX_STACK_DEPTH_SGI), 2); assert.equal(old.current.state.stacks[GL.COLOR].length, 2); assert.equal(old.current.error, GL.STACK_OVERFLOW);
        assert.equal(gpu.hostErrors.length, 0); await gpu.idle();
    }
    console.log("gl_state_queries_test: native stack/format queries, virtual ranges, four typed conversions, ARB error position, frozen vectors and legacy stack limits passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
