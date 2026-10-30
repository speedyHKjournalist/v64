"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
const compiler = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
const overloads = [
    ["sampler1D", "texture1DLod(t,0.5,0.0)"], ["sampler1D", "texture1DProjLod(t,vec2(0.5,1.0),0.0)"],
    ["sampler1D", "texture1DProjLod(t,vec4(0.5,0.0,0.0,1.0),0.0)"],
    ["sampler2D", "texture2DLod(t,vec2(0.5),0.0)"], ["sampler2D", "texture2DProjLod(t,vec3(0.5,0.5,1.0),0.0)"],
    ["sampler2D", "texture2DProjLod(t,vec4(0.5,0.5,0.0,1.0),0.0)"],
    ["sampler3D", "texture3DLod(t,vec3(0.5),0.0)"], ["sampler3D", "texture3DProjLod(t,vec4(0.5,0.5,0.5,1.0),0.0)"],
    ["samplerCube", "textureCubeLod(t,vec3(1.0),0.0)"],
    ["sampler1DShadow", "shadow1DLod(t,vec3(0.5),0.0)"], ["sampler1DShadow", "shadow1DProjLod(t,vec4(0.5,0.5,0.5,1.0),0.0)"],
    ["sampler2DShadow", "shadow2DLod(t,vec3(0.5),0.0)"], ["sampler2DShadow", "shadow2DProjLod(t,vec4(0.5,0.5,0.5,1.0),0.0)"],
];
for (const version of ["", "#version 110\n", "#version 120\n"]) for (const [sampler, call] of overloads) {
    const body = "uniform " + sampler + " t;void main(){OUTPUT=" + call + ";}";
    for (const extension of ["", "#extension GL_ARB_shader_texture_lod : disable\n"]) {
        const vertex = version + extension + body.replace("OUTPUT", "gl_Position");
        const result = compiler.compile(0, vertex); assert.equal(result.ok, true, vertex + "\n" + result.log);
    }
    const fragment = version + body.replace("OUTPUT", "gl_FragColor");
    assert.equal(compiler.compile(4, fragment).ok, false, "fragment LOD still requires extension: " + call);
    const extended = compiler.compile(4, version + "#extension GL_ARB_shader_texture_lod : require\n" + body.replace("OUTPUT", "gl_FragColor"));
    assert.equal(extended.ok, true, call + "\n" + extended.log);
    const link = compiler.link([{ stage: 0, source: version + body.replace("OUTPUT", "gl_Position") },
        { stage: 4, source: "void main(){gl_FragColor=vec4(1.0);}" }]);
    assert.equal(link.ok, true, link.log);
}
const gradient = "#version 120\nuniform sampler2D t;void main(){gl_Position=texture2DGradARB(t,vec2(0.5),vec2(0.0),vec2(0.0));}";
assert.equal(compiler.compile(0, gradient).ok, false, "gradient functions keep their extension requirement");
(async () => {
    const { create_glslang, compile_glslang } = await import("../../src/gles/glslang.js");
    const es = await create_glslang(await compile_glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm"))));
    const body = "precision mediump float;uniform sampler2D t;void main(){OUTPUT=texture2DLod(t,vec2(0.5),0.0);}";
    assert.equal(es.check_shader(0, body.replace("OUTPUT", "gl_Position")).ok, true, "ES 100 vertex LOD remains core");
    assert.equal(es.check_shader(4, body.replace("OUTPUT", "gl_FragColor")).ok, false, "ES 100 fragment LOD remains unavailable");
    const extended = "#extension GL_EXT_shader_texture_lod : require\n" + body.replace("OUTPUT", "gl_FragColor").replace("texture2DLod(", "texture2DLodEXT(");
    assert.equal(es.check_shader(4, extended).ok, true, "ES fragment LOD extension remains available");
    console.log("gl_desktop_lod_test: 13 explicit-LOD overloads retain core vertex and extension-only fragment rules across desktop 110/120/default and ES 100 (passed)");
})().catch(error => { console.error(error); process.exitCode = 1; });
