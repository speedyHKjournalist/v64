"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { execFileSync } = require("node:child_process");
const t = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js"), cases = require("./gl_vertex_capture_cases.js");
const naga = require("./naga.js").requireNaga("gl_vertex_capture_test");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-vertex-capture-"));
try {
    const entries = cases.cases();
    require("./cube2_glsl_direct_corpus_r6889.js");
    for (const entry of globalThis.CUBE2_DIRECT_GLSL_CORPUS_R6889) {
        const vertex = t.compileShader(entry.vertex, "vertex"), result = t.linkVertexCapture(vertex);
        assert.ok(result.ok, entry.name + ": " + result.log); entries.push({ name: "cube2_" + entry.name, wgsl: result.wgslCompute });
    }
    for (const entry of entries) {
        const file = path.join(dir, entry.name + ".wgsl"); fs.writeFileSync(file, entry.wgsl);
        try { execFileSync(naga, [file], { stdio: "pipe" }); } catch (error) { throw new Error(entry.name + ": " + error.stderr); }
    }
    const native = require("./gl_conformance/selection_program_reference.json").cases;
    assert.ok(native.every(c => c.error === 0));
    assert.equal(native[0].result, 0, "shader-scaled position is outside the view volume");
    assert.deepEqual(native[1].values, [1793, 12, 8, 0.5, 1, ...entries[0].expected.slice(4, 8), ...entries[0].expected.slice(12, 16)]);
    assert.equal(t.linkVertexCapture(null).ok, false);
    console.log("gl_vertex_capture_test: " + entries.length + " GLSL/ARB/Cube2 compute shaders accepted by Naga; native feedback contract passed");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
