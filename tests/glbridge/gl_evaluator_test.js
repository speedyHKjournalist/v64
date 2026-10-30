"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_evaluators.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"), { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),
    cases = require("./gl_evaluator_cases.js"), modes = require("./gl_selection_cases.js"), math = require("../../src/browser/glbridge/gl-webgpu/gl_shadow_evaluators.js"),
    reference = require("./gl_conformance/evaluator_reference.json").cases;
const compiler = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }), memories = new Map();
        await gpu.initialize(); shadow.setCapabilities(gpu.capabilities()); shadow.setGlslang(compiler);
        shadow.writeResponse = (target, bytes) => memories.get(target.batchId).set(bytes, target.offset);
        gpu.options.writeGuestMemory = (at, bytes, metadata) => memories.get(metadata.batchId).set(bytes, at + metadata.originalOffset);
        // Only arithmetic of the normal-observing shader is substituted here;
        // the same capture program runs on the real GPU in the browser page.
        gpu.captureVertices = function(bytes, view, offset, size, metadata) {
            const r = P.decodeRecord("CAPTURE_VERTICES", view, offset), values = new Float32Array(r.count * 20);
            for (let i = 0; i < r.count; ++i) {
                const at = offset + 16 + i * 256, part = slot => Array.from({ length: 4 }, (_, k) => view.getFloat32(at + slot * 16 + k * 4, true)), color = part(3), normal = part(2);
                values.set([...part(0), ...color, ...color, ...normal.slice(0, 3), 1, 0, 0, 0, 0], i * 20);
            }
            this.trackReadback(Promise.resolve().then(() => metadata.onVertexCapture({ job: r.job, first: r.first, values })));
        };
        let nextBatch = 0;
        const submit = async stream => {
            const memory = stream.bytes(), batchId = ++nextBatch; memories.set(batchId, memory);
            const segments = shadow.process(memory, { generation: 1, batchId, root: true });
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);
                gpu.submit(copied ? bytes.slice() : bytes, { batchId, originalOffset: segment.bytes ? 0 : segment.offset, onVertexCapture: result => shadow.completeVertexCapture(result) });
            }
            await gpu.idle();
        };
        const readState = (q, name = "QUERY_STATE") => {
            assert.equal(q.view.getUint32(P.F[name].status, true), 1);
            return Array.from({ length: q.view.getUint32(P.F[name].count, true) }, (_, i) => q.view.getFloat64(P.RECORDS[name].size + i * 8, true));
        };
        for (const phase of cases.build()) {
            await submit(phase.stream); if (phase.name === "setup") continue;
            const e = cases.expected(reference.find(entry => entry.name === phase.name)); assert.equal(shadow.current.error, e.error, phase.name); shadow.current.error = 0;
            if (phase.feedback) {
                const count = phase.response.view.getInt32(P.F.QUERY_RENDER_MODE.result, true); assert.ok(count >= 0, phase.name);
                const read = modes.read(phase.response); await submit(read.stream);
                const values = Array.from({ length: count }, (_, i) => read.response.view.getFloat32(44 + i * 4, true)); cases.compareFeedback(phase.name, values, e, (ok, message) => assert.ok(ok, message));
                assert.deepEqual(phase.current.flatMap(q => readState(q)), e.current, phase.name + " preserves current attributes");
                readState(phase.material, "QUERY_PARAMETER").forEach((n, i) => assert.ok(Math.abs(n - e.material[i]) < 0.000002, phase.name + " preserves material"));
            } else if (phase.response) assert.deepEqual(readState(phase.response, "QUERY_EVALUATOR"), e.values, phase.name);
            else if (phase.grid) assert.deepEqual(phase.grid.flatMap(q => readState(q)), e.values, phase.name);
        }
        const saved = JSON.parse(JSON.stringify(shadow.getState())), restored = new GLShadow(); restored.setState(saved);
        const query = new GLStream(), answer = cases.query(query, GL.MAP1_VERTEX_3, GL.COEFF); restored.process(query.bytes());
        assert.deepEqual(readState(answer, "QUERY_EVALUATOR"), [-0.25, 0, 0, 0.25, 0, 0]);
        const abnormal = new GLStream(); cases.map(abnormal, GL.MAP1_COLOR_4, [0, 1], 1, [NaN, Infinity, -Infinity, -0]); shadow.process(abnormal.bytes());
        restored.setState(JSON.parse(JSON.stringify(shadow.getState()))); const nums = new GLStream(), numbers = cases.query(nums, GL.MAP1_COLOR_4, GL.COEFF); restored.process(nums.bytes());
        const values = readState(numbers, "QUERY_EVALUATOR"); assert.ok(Number.isNaN(values[0])); assert.equal(values[1], Infinity); assert.equal(values[2], -Infinity); assert.ok(Object.is(values[3], -0));
        const invalid = new GLStream(), short = cases.query(invalid, GL.MAP1_VERTEX_3, GL.COEFF, false, 8); restored.process(invalid.bytes());
        assert.equal(short.view.getUint32(P.F.QUERY_EVALUATOR.status, true), 2); assert.ok(short.bytes.subarray(32).every(n => n === 0xA5));
        const forged = new GLStream().record(P.GLFN.RESOLVED_EVAL_VERTEX, P.encodeRecord("RESOLVED_EVAL_VERTEX", { position: [0, 0, 0, 1] })); restored.current.error = 0; restored.process(forged.bytes()); assert.equal(restored.current.error, GL.INVALID_OPERATION);
        const empty = cases.reset(new GLStream()); cases.mesh(empty, 2, GL.POINT, [-2147483648, 2147483647, -2147483648, 2147483647]); shadow.process(empty.bytes()); assert.equal(shadow.current.error, 0, "disabled vertex maps do no work even for enormous meshes");
        const reversed = new GLStream().call("ENABLE", GL.MAP2_VERTEX_3); cases.mesh(reversed, 2, GL.LINE, [1, 0, -2147483648, 2147483647]); shadow.process(reversed.bytes());
        assert.equal(shadow.current.error, 0, "reversed mesh ranges generate no vertices or empty primitives");
        assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0); assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    assert.equal(math.grid(3, 3, 0.1, 0.3), 0.3); assert.equal(math.grid(0, 3, 0.1, 0.3), 0.1);
    console.log("gl_evaluator_test: native maps/queries, curves/surfaces/grids, raw analytic normals, attribute/material preservation, lists and snapshots passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
