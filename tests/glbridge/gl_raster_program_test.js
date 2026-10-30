"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arb.js"); require("../../src/browser/glbridge/gl-webgpu/gl_shadow_select.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),
    t = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js"), arb = require("../../src/browser/glbridge/gl-webgpu/gl_arb_program.js"),
    caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js"), cases = require("./gl_raster_program_cases.js"), reference = require("./gl_conformance/raster_program_reference.json").cases;
const naga = require("./naga.js").requireNaga("gl_raster_program_test"), compiler = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm"))), dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-raster-program-"));
function resolve(shadow, bytes, kind) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), r = P.decodeRecord("CAPTURE_RASTER_VERTEX", view, 4),
        a = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 12, bytes.byteOffset + bytes.byteLength)), values = new Float32Array(56), p = Array.from(a.subarray(0, 4));
    values.set([kind === "glsl" ? p[0] + 0.25 : p[0] * 2, ...p.slice(1), 1, 0, 0.5, 1, 1, 1, 1, 1, ...a.subarray(32, 36), ...(kind === "glsl" ? p : [0, 0, 0, 0])]);
    values.set(Array.from(a.subarray(16, 20), n => Math.max(0, Math.min(1, n * 2))), 20); values[24] = a[20] + 1.5;
    for (let unit = 1; unit < 8; ++unit) values.set(unit === 7 ? a.subarray(60, 64) : Array.from(a.subarray(32, 36), n => n + unit), 28 + (unit - 1) * 4);
    shadow.completeVertexCapture({ job: r.job, first: 0, values });
}
try {
    for (const kind of ["glsl", "arb"]) {
        const shadow = new GLShadow(); shadow.setCapabilities(caps.capabilities({}, {})); shadow.setGlslang(compiler);
        const setup = cases.setup(kind); shadow.process(setup.stream.bytes());
        const result = kind === "glsl" ? t.linkVertexCapture(t.compileShader(cases.vertex, "vertex"), { vertexCaptureRaster: true }) : arb.compileARBProgram(cases.assembly, { vertexCapture: true, vertexCaptureRaster: true });
        assert.equal(result.ok, true, result.log); const file = path.join(dir, kind + ".wgsl"); fs.writeFileSync(file, result.wgslCompute || result.wgsl); execFileSync(naga, [file], { stdio: "pipe" });
        const location = setup.location ? setup.location.view.getInt32(P.F.QUERY_LOCATION.result, true) : null;
        for (const entry of reference.filter(c => c.name.startsWith(kind))) {
            const phase = cases.phase(entry.name, location), memory = phase.stream.bytes(); let pending = [];
            shadow.writeResponse = (target, bytes) => memory.set(bytes, target.offset);
            shadow.onCPUResume = (bytes, segments) => { pending.push(...(segments || []).filter(segment => segment.bytes).map(segment => segment.bytes)); };
            const segments = shadow.process(memory, { generation: 1, batchId: 1, root: true });
            for (const segment of segments || []) if (segment.bytes) {
                const bytes = segment.bytes, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                if (view.getUint16(0, true) !== P.GLFN.CAPTURE_RASTER_VERTEX) continue;
                assert.equal(phase.queries.valid.view.getUint32(P.F.QUERY_STATE.status, true), 0, "RasterPos getters must wait");
                resolve(shadow, bytes, kind);
                assert.ok(pending.some(bytes => new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, true) === P.GLFN.RESOLVED_RASTER_ALL));
            }
            cases.check(entry, reference, phase.queries, (ok, message) => assert.ok(ok, message));
            assert.equal(shadow.current.error, 0, entry.name); assert.equal(shadow.cpuBarrier, null); assert.equal(shadow.selectionJobs.size, 0);
        }
        const { GLStream, GL } = require("./gl_stream_builder.js"), selection = require("./gl_selection_program_cases.js");
        for (const mode of [GL.SELECT, GL.FEEDBACK]) {
            const s = new GLStream(); selection.query(s, mode === GL.SELECT ? { operation: 0, size: 32 } : { operation: 1, size: 128, type: GL["3D_COLOR_TEXTURE"] });
            selection.query(s, { operation: 2, type: mode }); s.record(P.GLFN.NAME_COMMAND, P.encodeRecord("NAME_COMMAND", { operation: 2, name: 9 }));
            s.call("RASTER_POS4F", 0.25, 0.5, 0, 1); if (mode === GL.FEEDBACK) s.bitmap(0, 0, 0, 0, 2, 3);
            const result = selection.query(s, { operation: 2, type: GL.RENDER }), memory = s.bytes(); shadow.writeResponse = (target, bytes) => memory.set(bytes, target.offset);
            const segments = shadow.process(memory, { generation: 1, batchId: 1, root: true });
            resolve(shadow, segments.find(segment => segment.bytes && new DataView(segment.bytes.buffer).getUint16(0, true) === P.GLFN.CAPTURE_RASTER_VERTEX).bytes, kind);
            assert.equal(result.view.getInt32(P.F.QUERY_RENDER_MODE.result, true), mode === GL.SELECT ? 1 : 12);
            const read = selection.read(result); shadow.process(read.stream.bytes());
            const expected = mode === GL.SELECT ? [1, 2147483648, 2147483648, 9] : [GL.BITMAP_TOKEN, 12, 12, 0.5, 1, 0, 0.5, 1, 1, 2, 3, 4];
            assert.deepEqual(Array.from({ length: expected.length }, (_, i) => read.response.view[mode === GL.SELECT ? "getUint32" : "getFloat32"](44 + i * 4, true)), expected);
            if (mode === GL.FEEDBACK) assert.deepEqual(shadow.current.state.values[GL.CURRENT_RASTER_POSITION], [14, 15, 0.5, 1]);
        }
        const forged = new GLStream().record(P.GLFN.RESOLVED_RASTER_ALL, P.encodeRecord("RESOLVED_RASTER_ALL", { valid: 1 }));
        shadow.process(forged.bytes()); assert.equal(shadow.current.error, GL.INVALID_OPERATION, "guest cannot forge authoritative raster state"); shadow.current.error = 0;
        const failing = new GLStream().call("RASTER_POS4F", 0, 0, 0, 1), response = cases.query(failing, GL.CURRENT_RASTER_POSITION_VALID, 1), memory = failing.bytes();
        shadow.writeResponse = (target, bytes) => memory.set(bytes, target.offset);
        const pending = shadow.process(memory, { generation: 1, batchId: 2, root: true }), capture = pending.find(segment => segment.bytes && new DataView(segment.bytes.buffer).getUint16(0, true) === P.GLFN.CAPTURE_RASTER_VERTEX);
        const job = new DataView(capture.bytes.buffer).getUint32(4, true);
        shadow.completeVertexCapture({ job, first: 0, values: new Float32Array(55) }); assert.ok(shadow.cpuBarrier, "short raster output cannot resume the CPU");
        shadow.completeVertexCapture({ job, first: 0, error: "map failed" }); assert.equal(shadow.cpuBarrier, null); assert.equal(shadow.current.error, GL.INVALID_OPERATION);
        assert.equal(response.view.getUint32(P.F.QUERY_STATE.status, true), 1); assert.equal(response.view.getFloat64(24, true), 0);
    }
    console.log("gl_raster_program_test: GLSL/ARB raster getters, all texture units, fog/secondary color, clipping, window bypass and Naga capture passed");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
