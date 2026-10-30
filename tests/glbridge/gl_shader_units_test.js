#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const t = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const cases = require("./gl_shader_units_cases.js"), reference = require("./gl_conformance/shader_units_reference.json");
const naga = require("./naga.js").requireNaga("gl_shader_units_test");
if (!naga) process.exit(0);
const g = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
const pack = entry => entry.vertex.map(source => ({ stage: 0, source })).concat(entry.fragment.map(source => ({ stage: 4, source })));
const unit = (sources, stage) => t.linkShaderUnits(sources.map(source => t.compileShader(source, stage, { library: true })), stage);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-shader-units-"));
try {
    for (const entry of cases) {
        assert.equal(g.link(pack(entry)).ok, reference[entry.name].link, entry.name);
        const result = t.linkProgram(unit(entry.vertex, "vertex"), unit(entry.fragment, "fragment"));
        assert.ok(result.ok, entry.name + ": " + result.log);
        for (const [stage, source] of [["vertex", result.wgslVertex], ["fragment", result.wgslFragment]]) {
            const file = path.join(dir, entry.name + "." + stage + ".wgsl");
            fs.writeFileSync(file, source); execFileSync(naga, [file], { stdio: "pipe" });
        }
        const shadow = new GLShadow(); shadow.setCapabilities(caps.capabilities({}, {})); shadow.setGlslang(g);
        const stream = new GLStream().makeCurrent(1, 0, 0, 4, 4, 1, 1);
        cases.appendProgram(stream, entry, 100);
        const link = stream.queryObjectiv(P.C.V86GL_OBJECT_KIND_PROGRAM, 100, GL.LINK_STATUS);
        shadow.process(stream.bytes());
        assert.equal(link.view.getInt32(P.F.QUERY_OBJECT_IV.value, true), 1, "compiled source snapshot: " + entry.name);
        assert.equal(shadow.stats.rejected, 0);
    }
    const stages = (first, second) => pack({ vertex: [first + " float helper(); void main(){gl_Position=vec4(helper());}", second + " float helper(){return 0.0;}"], fragment: ["void main(){gl_FragColor=vec4(1.0);}"] });
    for (const [a, b] of [["float x=1.0;", "float x=2.0;"], ["vec4 x=vec4(1.0);", "vec4 x=vec4(1.0,2.0,1.0,1.0);"],
        ["const float x=1.0;", "const float x=2.0;"], ["float x;", "vec2 x;"], ["float x;", "uniform float x;"]])
        assert.equal(g.link(stages(a, b)).ok, false, "conflicting globals must fail: " + a + b);
    assert.equal(g.link(stages("vec4 x=vec4(0.5);", "vec4 x=vec4(1.0)/2.0;")).ok, true, "compare folded values");
    assert.equal(g.link(stages("float x;", "float x=0.5;")).ok, true, "a single initializer is allowed");
    const linked = t.linkProgram(unit(["float shared; float helper(); void main(){float x=helper();gl_Position=vec4(x+shared);}",
        "float shared=0.5;float helper(){shared+=0.25;return shared;}"], "vertex"), t.compileShader("void main(){gl_FragColor=vec4(1.0);}", "fragment"));
    assert.ok(linked.ok, linked.log);
    assert.equal(linked.wgslVertex.match(/var<private> shared_ /g).length, 1, "one storage cell for a shared global");
    assert.match(linked.wgslVertex, /shared_ = 0\.5/);
    const library = t.compileShader("vec4 helper(){return vec4(1.0);}", "vertex", { library: true });
    assert.ok(library.ok, library.log);
    assert.equal(t.linkProgram(library, t.compileShader("void main(){gl_FragColor=vec4(1.0);}", "fragment")).ok, false);
    console.log("PASS: shader compilation units, shared global initialization, compiled-source snapshots and WGSL validation");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
