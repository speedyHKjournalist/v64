"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_fixed.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_textures.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const cases = require("./gl_shader_mixed_cases.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const naga = require("./naga.js").requireNaga("gl_shader_mixed_test");
if (!naga) process.exit(0);
const compiler = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-shader-mixed-"));
    try {
        for (const copied of [false, true]) for (const [i, entry] of cases.entries()) {
            const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });
            await gpu.initialize(); shadow.setCapabilities(gpu.capabilities()); shadow.setGlslang(compiler);
            const setup = new GLStream().makeCurrent(i + 1, 0, 0, 64, 64);
            cases.program(setup, entry, 100);
            const linked = setup.queryObjectiv(P.C.V86GL_OBJECT_KIND_PROGRAM, 100, GL.LINK_STATUS);
            const location = entry.sampler && setup.queryLocation(P.C.V86GL_LOCATION_KIND_UNIFORM, 100, "probe", 64);
            shadow.process(setup.bytes()); gpu.submit(copied ? setup.bytes().slice() : setup.bytes(), {}); await gpu.idle();
            assert.equal(linked.view.getInt32(P.F.QUERY_OBJECT_IV.value, true), 1, entry.name + " CPU link");
            assert.equal(gpu.currentProgramObject()?.linked, true, entry.name + " GPU link");
            const before = gpu.resolveShaders();
            const draw = cases.setup(new GLStream(), entry);
            if (location) draw.uniformiv(location.view.getInt32(P.F.QUERY_LOCATION.result, true), 1, 1, [1]);
            cases.draw(draw, entry); shadow.process(draw.bytes()); gpu.submit(copied ? draw.bytes().slice() : draw.bytes(), {}); await gpu.idle();
            const shaders = gpu.resolveShaders();
            const stateStruct = source => source.match(/struct GLState \{[^]*?\n\}/)?.[0];
            assert.equal(stateStruct(shaders.wgslVertex), stateStruct(shaders.wgslFragment), entry.name + " shared state offsets");
            const vertexInterface = shaders.wgslVertex.match(/struct VSOut \{[^]*?\n\}/)[0];
            const fragmentInterface = shaders.wgslFragment.match(/struct FSIn \{[^]*?\n\}/)[0];
            const locations = source => [...source.matchAll(/@location\((\d+)\)/g)].map(m => +m[1]);
            assert.deepEqual(locations(vertexInterface), locations(fragmentInterface), entry.name + " shared varying slots");
            const bindings = gpu.textureBindEntries(shaders).map(e => e.binding);
            assert.equal(new Set(bindings).size, bindings.length, entry.name + " stage texture bindings must not overlap");
            assert.equal(gpu.currentVariant().twoSided, entry.name === "vs_back_twoside", entry.name + " two-sided enable");
            for (const [stage, source] of [["vertex", shaders.wgslVertex], ["fragment", shaders.wgslFragment]]) {
                const file = path.join(dir, entry.name + "-" + stage + ".wgsl"); fs.writeFileSync(file, source);
                try { execFileSync(naga, [file], { stdio: "pipe" }); }
                catch (error) { throw new Error(entry.name + " " + stage + ": " + error.stderr); }
            }
            if (["vs_texture", "vs_fog", "fs_texgen", "fs_lighting", "fs_fog"].includes(entry.name))
                assert.notEqual(before.key, shaders.key, "fixed state changes the mixed pipeline: " + entry.name);
            assert.equal(shadow.stats.rejected, 0, entry.name); assert.equal(gpu.stats.refusals, 0, entry.name); assert.equal(gpu.hostErrors.length, 0, entry.name);
        }
        console.log("gl_shader_mixed_test: one-stage CPU links, fixed stage variants, uniforms, texture bindings and Naga WGSL in both modes (passed)");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
