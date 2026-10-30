"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arb.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_select.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),
    { GLStream, GL } = require("./gl_stream_builder.js"), cases = require("./gl_selection_program_cases.js"),
    reference = require("./gl_conformance/selection_program_reference.json").cases;
const compiler = new Glslang(fs.readFileSync(require("node:path").join(__dirname, "../../bios/glslang.wasm")));
function harness(fragment, kind) {
    const shadow = new GLShadow(); shadow.setGlslang(compiler); shadow.setCapabilities(require("../../src/browser/glbridge/gl-webgpu/gl_caps.js").capabilities({}, {}));
    const setup = cases.setup(fragment, kind); shadow.process(setup.stream.bytes());
    return { shadow, location: setup.location ? setup.location.view.getInt32(P.F.QUERY_LOCATION.result, true) : null };
}
function records(segments) {
    const result = [];
    for (const segment of segments) if (segment.bytes) {
        const bytes = segment.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint16(0, true) === P.GLFN.CAPTURE_VERTICES) {
            const start = view.getUint16(2, true) === 0xFFFF ? 8 : 4;
            result.push({ ...P.decodeRecord("CAPTURE_VERTICES", view, start), input: new Float32Array(bytes.buffer.slice(bytes.byteOffset + start + 16, bytes.byteOffset + bytes.byteLength)) });
        }
    }
    return result;
}
function resolve(shadow, record) {
    const values = new Float32Array(record.count * 20);
    for (let i = 0; i < record.count; ++i) {
        const a = record.input.subarray(i * 64, (i + 1) * 64);
        values.set([a[0] * 2, a[1], a[2], a[3], 1, 0, 0.5, 1, 0.25, 0.5, 0.75, 1,
            ...Array.from({ length: 4 }, (_, k) => a[32 + k] + a[36 + k]), ...a.subarray(0, 4)], i * 20);
    }
    shadow.completeVertexCapture({ job: record.job, first: record.first, values });
}
for (const entry of reference) {
    const { shadow, location } = harness(entry.name.includes("fragment"), entry.name.startsWith("arb_") ? "arb" : entry.name === "glsl_over_arb_select" ? "both" : "glsl"), draw = cases.draw(entry.name, location), segments = shadow.process(draw.stream.bytes()), jobs = records(segments);
    assert.equal(jobs.length, 1); assert.equal(draw.response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 0, "GPU result remains pending");
    const serialized = JSON.parse(JSON.stringify(shadow.getState())); assert.equal(serialized.nextSelectionJob, jobs[0].job);
    if (entry.name === "glsl_over_arb_select") { const values = new Float32Array([0.375, 0, 0, 1, 1, 0, 0.5, 1, 0.25, 0.5, 0.75, 1, 5, 5, 5, 5, 0.75, 0, 0, 1]); shadow.completeVertexCapture({ job: jobs[0].job, first: 0, values }); }
    else resolve(shadow, jobs[0]);
    assert.equal(draw.response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 1, entry.name);
    assert.equal(draw.response.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), entry.result, entry.name);
    const read = cases.read(draw.response); if (read.response) {
        shadow.process(read.stream.bytes());
        const actual = Array.from({ length: entry.values.length }, (_, i) => read.response.view[entry.name.endsWith("select") ? "getUint32" : "getFloat32"](44 + i * 4, true));
        actual.forEach((value, i) => assert.ok(Math.abs(value - entry.values[i]) <= (entry.name.endsWith("select") && (i === 1 || i === 2) ? 128 : 0), entry.name + " word " + i));
    }
    assert.equal(shadow.current.error, 0); assert.equal(shadow.selectionJobs.size, 0); assert.equal(shadow.current.state.selection.retired.length, 0);
}
{
    const { shadow, location } = harness(false), s = new GLStream().uniformfv(location, 1, 1, [2]);
    cases.query(s, { operation: 0, size: 64 }); cases.query(s, { operation: 2, type: GL.SELECT });
    s.record(P.GLFN.NAME_COMMAND, P.encodeRecord("NAME_COMMAND", { operation: 2, name: 7 }));
    const point = (stream, z) => stream.call("BEGIN", GL.POINTS).call("VERTEX3F", 0, 0, z).call("END");
    point(s, -0.5); s.record(P.GLFN.NAME_COMMAND, P.encodeRecord("NAME_COMMAND", { operation: 1, name: 8 }));
    point(s, 0.5); s.call("USE_PROGRAM", 0); point(s, 0);
    const response = cases.query(s, { operation: 2, type: GL.RENDER }), jobs = records(shadow.process(s.bytes()));
    resolve(shadow, jobs[1]); assert.equal(response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 0, "later completion cannot overtake the first hit");
    resolve(shadow, jobs[0]); assert.equal(response.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), 2);
    const read = cases.read(response); shadow.process(read.stream.bytes());
    const words = Array.from(new Uint32Array(read.response.bytes.buffer, read.response.bytes.byteOffset + 44, 8));
    assert.deepEqual([words[0], words[3], words[4], words[7]], [1, 7, 1, 8]);
    assert.ok(words[1] < words[5] && words[5] < words[6], "the final fixed draw joins the second name's depth interval");
}
{
    const { shadow, location } = harness(false), draw = cases.draw("glsl_vertex_feedback", location), jobs = records(shadow.process(draw.stream.bytes()));
    shadow.completeVertexCapture({ job: jobs[0].job, first: 0, values: new Float32Array(19) });
    assert.equal(draw.response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 0, "malformed GPU result is rejected");
    shadow.completeVertexCapture({ job: jobs[0].job, first: 0, error: "map failed" });
    assert.equal(draw.response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 2); assert.equal(shadow.current.error, GL.INVALID_OPERATION);
    resolve(shadow, jobs[0]); assert.equal(draw.response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 2, "late completion cannot change failure");
}
{
    const { shadow, location } = harness(false), s = new GLStream().uniformfv(location, 1, 1, [2]);
    cases.query(s, { operation: 1, size: 2048, type: GL["2D"] }); cases.query(s, { operation: 2, type: GL.FEEDBACK });
    s.call("BEGIN", GL.POINTS); for (let i = 0; i < 513; ++i) s.call("VERTEX3F", 0.25, 0, 0); s.call("END");
    const response = cases.query(s, { operation: 2, type: GL.RENDER }), jobs = records(shadow.process(s.bytes()));
    assert.deepEqual(jobs.map(job => job.count), [256, 256, 1]);
    resolve(shadow, jobs[2]); resolve(shadow, jobs[0]); resolve(shadow, jobs[0]);
    assert.equal(response.view.getUint32(P.F.QUERY_RENDER_MODE.status, true), 0, "duplicate chunk cannot complete a missing middle chunk");
    resolve(shadow, jobs[1]); assert.equal(response.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), 1539);
    const read = cases.read(response); shadow.process(read.stream.bytes());
    for (let i = 0; i < 513; ++i) assert.deepEqual(Array.from({ length: 3 }, (_, k) => read.response.view.getFloat32(44 + i * 12 + k * 4, true)), [1793, 12, 8]);
}
{
    const { shadow, location } = harness(false);
    const failed = new GLStream().shaderSource(101, "broken shader text").call("COMPILE_SHADER", 101).call("LINK_PROGRAM", 100).call("DELETE_PROGRAM", 100);
    shadow.process(failed.bytes());
    const draw = cases.draw("glsl_vertex_feedback", location), jobs = records(shadow.process(draw.stream.bytes()));
    assert.equal(jobs.length, 1, "failed relink and deletion keep the installed vertex executable");
    resolve(shadow, jobs[0]); assert.equal(draw.response.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), 13);
}
{
    const { shadow, location } = harness(false), first = cases.draw("glsl_vertex_feedback", location), firstJobs = records(shadow.process(first.stream.bytes())),
        second = cases.draw("glsl_vertex_feedback", location), secondJobs = records(shadow.process(second.stream.bytes()));
    resolve(shadow, secondJobs[0]); const ticket = shadow.current.state.selection.pending.ticket;
    resolve(shadow, firstJobs[0]); assert.equal(shadow.current.state.selection.pending.ticket, ticket, "older mode completion cannot replace the newest result ticket");
}
{
    const { shadow, location } = harness(false), s = new GLStream().uniformfv(location, 1, 1, [2]);
    cases.query(s, { operation: 1, size: 32, type: GL["2D"] }); cases.query(s, { operation: 2, type: GL.FEEDBACK });
    s.call("BEGIN", GL.POINTS).call("VERTEX3F", 0.25, 0, 0).call("END");
    const jobs = records(shadow.process(s.bytes())), restored = new GLShadow(); restored.setState(JSON.parse(JSON.stringify(shadow.getState())));
    resolve(restored, jobs[0]);
    const end = new GLStream(), response = cases.query(end, { operation: 2, type: GL.RENDER }); restored.process(end.bytes());
    assert.equal(response.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), 3, "CPU result queue retains its geometry and mode across serialization");
}
console.log("gl_selection_program_test: native programmable feedback, ordered/chunked asynchronous hits, retained programs, serialized queues and malformed/failing/late results passed");
