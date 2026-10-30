#!/usr/bin/env node
// The GL shadow's shaders and programs (gl_shadow_glsl.js): glslang's
// answers to the GLSL queries, written in the guest's batch; what waits for
// glslang; deletion; snapshots; and the page's executor adopting the
// locations the guest was told.
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
const { UNIFORM_LOCATIONS_PER_PROGRAM } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_state.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
const glCaps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");

const OK = P.C.V86GL_SYNC_QUERY_STATUS_OK, FAILED = P.C.V86GL_SYNC_QUERY_STATUS_FAILED;
const PENDING = P.C.V86GL_SYNC_QUERY_STATUS_PENDING;
const SHADER = P.C.V86GL_OBJECT_KIND_SHADER, PROGRAM = P.C.V86GL_OBJECT_KIND_PROGRAM;
const UNIFORM = P.C.V86GL_LOCATION_KIND_UNIFORM, ATTRIB = P.C.V86GL_LOCATION_KIND_ATTRIB;
const CAPS = glCaps.capabilities({}, {});
const WASM = readFileSync(join(__dirname, "../../bios/glslang.wasm"));
const glslang = new Glslang(WASM);

const VS = `uniform mat4 bones[4];
uniform vec3 light;
attribute vec4 weights;
attribute vec3 tangent;
varying vec4 col;
void main() {
    gl_Position = ftransform();
    col = gl_Color * weights + vec4(light, 1.0) * bones[1][0].x + vec4(tangent, 0.0);
}`;
const FS = `#version 120
uniform sampler2D tex;
uniform float scale;
uniform int mode;
varying vec4 col;
vec4 helper();
void main() { gl_FragColor = texture2D(tex, gl_TexCoord[0].xy) * col * scale + helper() * float(mode); }`;
const FS_HELPER = "vec4 helper() { return gl_LightSource[0].diffuse; }";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function newShadow(withGlslang = true) {
    const shadow = new GLShadow();
    shadow.setCapabilities(CAPS);
    if (withGlslang) shadow.setGlslang(glslang);
    return shadow;
}

// A program of VS, FS and FS_HELPER: shaders 1-3, program 5
function program(stream, { link = true, fs = FS } = {}) {
    stream.makeCurrent(1, 0, 0, 64, 64, 1, 1)
        .call("CREATE_SHADER", 1, GL.VERTEX_SHADER).shaderSource(1, VS).call("COMPILE_SHADER", 1)
        .call("CREATE_SHADER", 2, GL.FRAGMENT_SHADER).shaderSource(2, fs).call("COMPILE_SHADER", 2)
        .call("CREATE_SHADER", 3, GL.FRAGMENT_SHADER).shaderSource(3, FS_HELPER).call("COMPILE_SHADER", 3)
        .call("CREATE_PROGRAM", 5).call("ATTACH_SHADER", 5, 1).call("ATTACH_SHADER", 5, 2).call("ATTACH_SHADER", 5, 3);
    if (link) stream.call("LINK_PROGRAM", 5);
    return stream;
}

const status = (record, name) => record.view.getUint32(P.F[name].status, true);
const int = (record, name, field) => record.view.getInt32(P.F[name][field], true);
const text = (record, name, length) =>
    String.fromCharCode(...record.bytes.subarray(P.RECORDS[name].size, P.RECORDS[name].size + length));

test("compile and link status, logs and the active lists come from glslang", () => {
    const stream = program(new GLStream());
    const compiled = stream.queryObjectiv(SHADER, 2, GL.COMPILE_STATUS);
    const linked = stream.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
    const uniforms = stream.queryObjectiv(PROGRAM, 5, GL.ACTIVE_UNIFORMS);
    const longest = stream.queryObjectiv(PROGRAM, 5, GL.ACTIVE_UNIFORM_MAX_LENGTH);
    const attributes = stream.queryObjectiv(PROGRAM, 5, GL.ACTIVE_ATTRIBUTES);
    const validated = stream.queryObjectiv(PROGRAM, 5, GL.VALIDATE_STATUS);
    const actives = [0, 1, 2, 3, 4, 5].map(i => stream.queryActive(1, 5, i, 64));
    const outOfRange = stream.queryActive(1, 5, 6, 64);
    const firstAttribute = stream.queryActive(2, 5, 0, 64);
    newShadow().process(stream.bytes());
    assert.equal(status(compiled, "QUERY_OBJECT_IV"), OK);
    assert.equal(int(compiled, "QUERY_OBJECT_IV", "value"), 1);
    assert.equal(int(linked, "QUERY_OBJECT_IV", "value"), 1);
    // light, bones[0] (size 2: the highest element used), tex, scale, mode
    // and the built-in the helper reads (glslang reflects ftransform()'s matrix as none)
    assert.equal(int(uniforms, "QUERY_OBJECT_IV", "value"), 6);
    const names = actives.map(r => text(r, "QUERY_ACTIVE", int(r, "QUERY_ACTIVE", "length")));
    assert.deepEqual(names.slice().sort(), ["bones[0]", "gl_LightSource[0].diffuse", "light", "mode", "scale", "tex"]);
    // ACTIVE_UNIFORM_MAX_LENGTH counts the [0] and the terminator
    assert.equal(int(longest, "QUERY_OBJECT_IV", "value"), Math.max(...names.map(n => n.length)) + 1);
    const bones = actives[names.indexOf("bones[0]")];
    assert.equal(int(bones, "QUERY_ACTIVE", "size"), 2);
    assert.equal(bones.view.getUint32(P.F.QUERY_ACTIVE.type, true), 0x8B5C);
    assert.equal(status(outOfRange, "QUERY_ACTIVE"), FAILED);
    assert.ok(int(attributes, "QUERY_OBJECT_IV", "value") >= 3, "weights, tangent and gl_Color");
    assert.equal(status(firstAttribute, "QUERY_ACTIVE"), OK);
    // validated only once glValidateProgram ran
    assert.equal(int(validated, "QUERY_OBJECT_IV", "value"), 0);
});

test("a shader that does not compile, and a program missing a function, say why", () => {
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1)
        .call("CREATE_SHADER", 9, GL.VERTEX_SHADER).shaderSource(9, "void main() { gl_Position = foo; }")
        .call("COMPILE_SHADER", 9);
    const status1 = stream.queryObjectiv(SHADER, 9, GL.COMPILE_STATUS);
    const length = stream.queryObjectiv(SHADER, 9, GL.INFO_LOG_LENGTH);
    const log = stream.queryObjectLog(SHADER, 9, 256);
    program(stream);
    stream.call("DETACH_SHADER", 5, 3).call("LINK_PROGRAM", 5);
    const linked = stream.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
    const linkLog = stream.queryObjectLog(PROGRAM, 5, 256);
    newShadow().process(stream.bytes());
    assert.equal(int(status1, "QUERY_OBJECT_IV", "value"), 0);
    const written = int(log, "QUERY_OBJECT_LOG", "length");
    assert.equal(int(length, "QUERY_OBJECT_IV", "value"), written + 1);
    assert.match(text(log, "QUERY_OBJECT_LOG", written), /'foo' : undeclared identifier/);
    assert.equal(int(linked, "QUERY_OBJECT_IV", "value"), 0);
    assert.match(text(linkLog, "QUERY_OBJECT_LOG", int(linkLog, "QUERY_OBJECT_LOG", "length")), /helper/);
});

test("locations: per program, name[i] is location + i, built-ins and unknown names are -1", () => {
    const stream = program(new GLStream());
    const at = name => stream.queryLocation(UNIFORM, 5, name, 32);
    const scale = at("scale"), bones = at("bones"), bones0 = at("bones[0]"), bones1 = at("bones[1]");
    const bones2 = at("bones[2]"), lightArray = at("light[0]"), builtIn = at("gl_ModelViewProjectionMatrix");
    const missing = at("nothing");
    newShadow().process(stream.bytes());
    const location = r => int(r, "QUERY_LOCATION", "result");
    assert.equal(status(scale, "QUERY_LOCATION"), OK);
    const base = 5 * UNIFORM_LOCATIONS_PER_PROGRAM;
    for (const r of [scale, bones, bones1]) assert.ok(location(r) >= base && location(r) < base + 16, location(r));
    assert.equal(location(bones0), location(bones));
    assert.equal(location(bones1), location(bones) + 1);
    // beyond the active size, a non-array with [0], a built-in, a name not there
    for (const r of [bones2, lightArray, builtIn, missing]) assert.equal(location(r), -1);
    assert.equal(scale.view.getUint32(P.F.QUERY_LOCATION.value_type, true), 0x1406);
});

test("attribute locations honour the bindings and avoid the conventional attributes' slots", () => {
    const stream = program(new GLStream(), { link: false });
    // weights bound to 7 before the link; tangent takes the highest free slot
    const name = "weights\0";
    const bind = new Uint8Array(12 + name.length);
    new DataView(bind.buffer).setUint32(0, 5, true);
    new DataView(bind.buffer).setInt32(4, 7, true);
    new DataView(bind.buffer).setUint32(8, name.length, true);
    for (let i = 0; i < name.length; ++i) bind[12 + i] = name.charCodeAt(i);
    stream.record(P.GLFN.BIND_ATTRIB_LOCATION, bind).call("LINK_PROGRAM", 5);
    const weights = stream.queryLocation(ATTRIB, 5, "weights", 32);
    const tangent = stream.queryLocation(ATTRIB, 5, "tangent", 32);
    const builtIn = stream.queryLocation(ATTRIB, 5, "gl_Color", 32);
    newShadow().process(stream.bytes());
    assert.equal(int(weights, "QUERY_LOCATION", "result"), 7);
    // 15 is gl_MultiTexCoord7's; the program does not use it, so it is free
    assert.equal(int(tangent, "QUERY_LOCATION", "result"), 15);
    assert.equal(int(builtIn, "QUERY_LOCATION", "result"), -1);
});

test("glUniform values come back from glGetUniform, converted as GL says", () => {
    const stream = program(new GLStream());
    const scale = stream.queryLocation(UNIFORM, 5, "scale", 32);
    const mode = stream.queryLocation(UNIFORM, 5, "mode", 32);
    const bones1 = stream.queryLocation(UNIFORM, 5, "bones[1]", 32);
    const shadow = newShadow();
    shadow.process(stream.bytes());
    const location = r => int(r, "QUERY_LOCATION", "result");
    const values = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1).call("USE_PROGRAM", 5)
        .uniformfv(location(scale), 1, 1, [2.75]).uniformiv(location(mode), 1, 1, [3]);
    const matrix = new Uint8Array(16 + 64);
    const mv = new DataView(matrix.buffer);
    mv.setInt32(0, location(bones1), true);
    mv.setInt32(4, 4, true);
    mv.setInt32(8, 1, true);
    for (let i = 0; i < 16; ++i) mv.setFloat32(16 + i * 4, i + 1, true);
    values.record(P.GLFN.UNIFORM_MATRIX_FV, matrix);
    const asFloat = values.queryUniform(5, location(scale), 1, 64);
    const asInt = values.queryUniform(5, location(scale), 2, 64);
    const modeFloat = values.queryUniform(5, location(mode), 1, 64);
    const bone = values.queryUniform(5, location(bones1), 1, 64);
    const bone0 = values.queryUniform(5, location(bones1) - 1, 1, 64);
    const nowhere = values.queryUniform(5, 12345, 1, 64);
    shadow.process(values.bytes());
    const float = (r, i) => r.view.getFloat32(32 + i * 4, true);
    assert.equal(float(asFloat, 0), 2.75);
    assert.equal(int(asFloat, "QUERY_UNIFORM", "value_count"), 1);
    assert.equal(asInt.view.getInt32(32, true), 3, "a float read as an int is rounded");
    assert.equal(float(modeFloat, 0), 3);
    assert.equal(int(bone, "QUERY_UNIFORM", "value_count"), 16);
    assert.deepEqual([0, 5, 15].map(i => float(bone, i)), [1, 6, 16]);
    assert.equal(float(bone0, 0), 0, "an element never set is zero");
    assert.equal(status(nowhere, "QUERY_UNIFORM"), FAILED);
});

test("without glslang the GLSL queries wait for the executor; when it comes, the earlier shaders are compiled", () => {
    const shadow = newShadow(false);
    const stream = program(new GLStream());
    const before = stream.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
    shadow.process(stream.bytes());
    assert.equal(status(before, "QUERY_OBJECT_IV"), PENDING);
    shadow.setGlslang(glslang);
    const after = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    const linked = after.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
    shadow.process(after.bytes());
    assert.equal(int(linked, "QUERY_OBJECT_IV", "value"), 1);
});

test("a deleted shader stays while attached; a deleted program while current", () => {
    const shadow = newShadow();
    const stream = program(new GLStream()).call("USE_PROGRAM", 5).call("DELETE_SHADER", 3).call("DELETE_PROGRAM", 5);
    const shaderDeleted = stream.queryObjectiv(SHADER, 3, GL.DELETE_STATUS);
    const programDeleted = stream.queryObjectiv(PROGRAM, 5, GL.DELETE_STATUS);
    stream.call("USE_PROGRAM", 0);
    const gone = stream.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
    const shaderGone = stream.queryObjectiv(SHADER, 3, GL.SHADER_TYPE);
    const vertexStays = stream.queryObjectiv(SHADER, 1, GL.SHADER_TYPE);
    shadow.process(stream.bytes());
    assert.equal(int(shaderDeleted, "QUERY_OBJECT_IV", "value"), 1);
    assert.equal(int(programDeleted, "QUERY_OBJECT_IV", "value"), 1);
    assert.equal(status(gone, "QUERY_OBJECT_IV"), FAILED);
    assert.equal(status(shaderGone, "QUERY_OBJECT_IV"), FAILED);
    assert.equal(int(vertexStays, "QUERY_OBJECT_IV", "value"), GL.VERTEX_SHADER);
});

test("a snapshot keeps the objects, the locations and the values", () => {
    const shadow = newShadow();
    const stream = program(new GLStream());
    const scale = stream.queryLocation(UNIFORM, 5, "scale", 32);
    shadow.process(stream.bytes());
    const location = int(scale, "QUERY_LOCATION", "result");
    shadow.process(new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1).call("USE_PROGRAM", 5)
        .uniformfv(location, 1, 1, [0.5]).bytes());
    const copy = newShadow();
    copy.setState(JSON.parse(JSON.stringify(shadow.getState())));
    const after = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    const again = after.queryLocation(UNIFORM, 5, "scale", 32);
    const value = after.queryUniform(5, location, 1, 64);
    copy.process(after.bytes());
    assert.equal(int(again, "QUERY_LOCATION", "result"), location);
    assert.equal(value.view.getFloat32(32, true), 0.5);
});

test("the executor adopts the shadow's uniform and attribute locations", async () => {
    const { host } = createFakeHost();
    const executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    // a program both sides can link (the executor's translator needs a vertex shader)
    const vs = "attribute vec4 position; attribute vec4 extra; uniform vec4 tint; uniform float gain;\n" +
        "void main() { gl_Position = position + extra * gain; gl_FrontColor = tint; }";
    const fs = "void main() { gl_FragColor = gl_Color; }";
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1)
        .call("CREATE_SHADER", 1, GL.VERTEX_SHADER).shaderSource(1, vs).call("COMPILE_SHADER", 1)
        .call("CREATE_SHADER", 2, GL.FRAGMENT_SHADER).shaderSource(2, fs).call("COMPILE_SHADER", 2)
        .call("CREATE_PROGRAM", 5).call("ATTACH_SHADER", 5, 1).call("ATTACH_SHADER", 5, 2)
        .call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5);
    const gain = stream.queryLocation(UNIFORM, 5, "gain", 32);
    const extra = stream.queryLocation(ATTRIB, 5, "extra", 32);
    newShadow().process(stream.bytes());
    const gainAt = int(gain, "QUERY_LOCATION", "result");
    assert.ok(gainAt >= 5 * UNIFORM_LOCATIONS_PER_PROGRAM);
    // (as though the shadow had chosen a slot the executor's own link would not)
    const extraAt = 6;
    extra.view.setInt32(P.F.QUERY_LOCATION.result, extraAt, true);
    executor.submit(stream.bytes(), {});
    const program = executor.current.shareGroup.programs.get(5);
    assert.ok(program.linked, program.log);
    assert.equal(program.adoptedAttribLocations.get("extra"), extraAt);
    assert.equal(program.link.reflection.attributes.find(a => a.name === "extra").location, extraAt,
        "the executor relinked with extra where the guest was told it is");
    executor.submit(new GLStream().uniformfv(gainAt, 1, 1, [4.5]).bytes(), {});
    const uniform = program.uniformByName.get("gain");
    assert.equal(program.uniformFloats[uniform.offsetBytes / 4], 4.5, "glUniform at the shadow's location reaches gain");
});

test("uniform type/shape errors leave storage unchanged and array updates stop at their own boundary", () => {
    const s = program(new GLStream()), locations = {};
    for (const name of ["scale", "mode", "light", "bones", "tex"]) locations[name] = s.queryLocation(UNIFORM, 5, name, 32);
    const shadow = newShadow(); shadow.process(s.bytes());
    const at = name => int(locations[name], "QUERY_LOCATION", "result");
    const update = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1).call("USE_PROGRAM", 5)
        .uniformfv(at("scale"), 1, 1, [7]).uniformiv(at("mode"), 1, 1, [9])
        .uniformiv(at("scale"), 1, 1, [3]).uniformfv(at("mode"), 1, 1, [4])
        .uniformfv(at("light"), 2, 1, [1, 2]).uniformfv(at("scale"), 1, 2, [1, 2])
        .uniformfv(at("tex"), 1, 1, [2]).uniformfv(at("scale"), 1, -1, [])
        .uniformfv(12345, 1, 1, [1]).uniformfv(-1, 4, 1, [1, 2, 3, 4]);
    const matrix = new Uint8Array(16 + 3 * 64), v = new DataView(matrix.buffer);
    v.setInt32(0, at("bones") + 1, true); v.setInt32(4, 4, true); v.setInt32(8, 3, true);
    for (let i = 0; i < 48; ++i) v.setFloat32(16 + i * 4, i + 1, true);
    update.record(P.GLFN.UNIFORM_MATRIX_FV, matrix);
    const scale = update.queryUniform(5, at("scale"), 1, 64), mode = update.queryUniform(5, at("mode"), 2, 64);
    const bones = update.queryUniform(5, at("bones") + 1, 1, 64);
    shadow.process(update.bytes());
    assert.equal(shadow.stats.rejected, 7);
    assert.equal(scale.view.getFloat32(32, true), 7); assert.equal(mode.view.getInt32(32, true), 9);
    assert.equal(bones.view.getFloat32(32 + 15 * 4, true), 16);
    const p = shadow.current.group.programs.get(5);
    assert.equal(p.values.size, 3, "an overlong matrix array must not create writes at adjacent uniforms");
});

test("a uniform write after restoring a snapshot relinks lazily before updating values", () => {
    const s = program(new GLStream()).call("USE_PROGRAM", 5), location = s.queryLocation(UNIFORM, 5, "scale", 32), first = newShadow(); first.process(s.bytes());
    const copy = newShadow(); copy.setState(JSON.parse(JSON.stringify(first.getState())));
    const at = int(location, "QUERY_LOCATION", "result"), update = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1)
        .uniformfv(at, 1, 1, [12.5]);
    const value = update.queryUniform(5, at, 1, 4); copy.process(update.bytes());
    assert.equal(value.view.getFloat32(32, true), 12.5);
});

test("objects share a namespace, shader/program kinds are checked and an invalid use keeps the current program", () => {
    const shadow = newShadow(), s = program(new GLStream()).call("USE_PROGRAM", 5)
        .call("CREATE_SHADER", 5, GL.VERTEX_SHADER).call("CREATE_PROGRAM", 1)
        .call("COMPILE_SHADER", 5).call("USE_PROGRAM", 1).call("USE_PROGRAM", 999)
        .call("ATTACH_SHADER", 5, 1).call("DETACH_SHADER", 5, 999).call("CREATE_PROGRAM", 7).call("USE_PROGRAM", 7);
    shadow.process(s.bytes()); assert.equal(shadow.stats.rejected, 8);
    assert.equal(shadow.current.program, 5); assert.ok(shadow.current.group.programs.has(5));
    assert.ok(shadow.current.group.shaders.has(1)); assert.ok(!shadow.current.group.shaders.has(5));
    s.call("USE_PROGRAM", 0);
});

test("deleting a shared current program retains it until the last context releases or is destroyed", async () => {
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize();
    const shadow = newShadow(), s = program(new GLStream()).call("USE_PROGRAM", 5)
        .makeCurrent(2, 0, 0, 64, 64, 2, 1).call("USE_PROGRAM", 5).call("DELETE_SHADER", 3).call("DELETE_PROGRAM", 5)
        .makeCurrent(1, 0, 0, 64, 64, 1, 1).call("USE_PROGRAM", 0);
    const bytes = s.bytes(); shadow.process(bytes); executor.submit(bytes, {});
    const group = shadow.current.group, gpuGroup = executor.current.shareGroup;
    assert.ok(group.programs.has(5)); assert.ok(gpuGroup.programs.has(5));
    assert.ok(group.shaders.has(3)); assert.ok(gpuGroup.shaders.has(3));
    const end = new GLStream().record(P.CTRL.DESTROY_CONTEXT, P.encodeRecord("DESTROY_CONTEXT", { context_id: 2 }));
    shadow.process(end.bytes()); executor.submit(end.bytes(), {});
    assert.ok(!group.programs.has(5)); assert.ok(!gpuGroup.programs.has(5));
    assert.ok(!group.shaders.has(3)); assert.ok(!gpuGroup.shaders.has(3));
    assert.ok(group.shaders.has(1)); assert.ok(gpuGroup.shaders.has(1));
});

test("boolean and sampler array updates reach every renderer element without extra location queries", async () => {
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize();
    const s = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1)
        .call("CREATE_SHADER", 1, GL.VERTEX_SHADER).shaderSource(1, "void main() { gl_Position = gl_Vertex; }").call("COMPILE_SHADER", 1)
        .call("CREATE_SHADER", 2, GL.FRAGMENT_SHADER).shaderSource(2, "#version 120\nuniform bvec3 flags; uniform sampler2D tex[2]; void main() { gl_FragColor = vec4(vec3(flags), 1.0) + texture2D(tex[0], vec2(0.5)) + texture2D(tex[1], vec2(0.5)); }")
        .call("COMPILE_SHADER", 2).call("CREATE_PROGRAM", 5).call("ATTACH_SHADER", 5, 1).call("ATTACH_SHADER", 5, 2).call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5);
    const flags = s.queryLocation(UNIFORM, 5, "flags", 32), tex = s.queryLocation(UNIFORM, 5, "tex[1]", 32);
    const shadow = newShadow(); shadow.process(s.bytes()); executor.submit(s.bytes(), {});
    const update = new GLStream().uniformfv(int(flags, "QUERY_LOCATION", "result"), 3, 1, [-0, 2, -3])
        .uniformiv(int(tex, "QUERY_LOCATION", "result") - 1, 1, 2, [2, 7])
        .uniformiv(int(tex, "QUERY_LOCATION", "result"), 1, 1, [5]);
    const cpuFlags = update.queryUniform(5, int(flags, "QUERY_LOCATION", "result"), 2, 16);
    shadow.process(update.bytes()); executor.submit(update.bytes(), {});
    assert.equal(shadow.stats.rejected, 0);
    assert.deepEqual([0, 1, 2].map(i => cpuFlags.view.getInt32(32 + i * 4, true)), [0, 1, 1]);
    const p = executor.currentProgramObject(), uniform = p.uniformByName.get("flags");
    assert.deepEqual(Array.from(p.uniformInts.subarray(uniform.offsetBytes / 4, uniform.offsetBytes / 4 + 3)), [0, 1, 1]);
    assert.equal(p.samplerUnits.get("tex[0]"), 2); assert.equal(p.samplerUnits.get("tex[1]"), 5);
});

const RELINK_VS = "void main() { gl_Position = gl_Vertex; }";
const RELINK_FS = "uniform vec4 tint; void main() { gl_FragColor = tint; }";
const RELINK_BAD = "void main() { gl_FragColor = unknownValue; }";
function relinkSetup() {
    return new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1)
        .call("CREATE_SHADER", 1, GL.VERTEX_SHADER).shaderSource(1, RELINK_VS).call("COMPILE_SHADER", 1)
        .call("CREATE_SHADER", 2, GL.FRAGMENT_SHADER).shaderSource(2, RELINK_FS).call("COMPILE_SHADER", 2)
        .call("CREATE_PROGRAM", 5).call("ATTACH_SHADER", 5, 1).call("ATTACH_SHADER", 5, 2)
        .call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5);
}
test("changing shader source preserves compiled code until CompileShader", async () => {
    const shadow = newShadow(), { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    const s = relinkSetup().shaderSource(2, RELINK_BAD);
    const compiled = s.queryObjectiv(SHADER, 2, GL.COMPILE_STATUS);
    s.call("LINK_PROGRAM", 5);
    const linked = s.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
    shadow.process(s.bytes()); executor.submit(s.bytes(), {});
    const reference = require("./gl_conformance/glsl_relink_reference.json").cases;
    assert.equal(int(compiled, "QUERY_OBJECT_IV", "value"), reference.source_only_compile_status);
    assert.equal(int(linked, "QUERY_OBJECT_IV", "value"), reference.source_only_link_status);
    assert.ok(executor.currentProgramObject().linked, "renderer must use the previously compiled source");
});
test("failed relinks preserve installed code and uniforms, successful relinks reset them", async () => {
    const shadow = newShadow(), { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    const s = relinkSetup(), location = s.queryLocation(UNIFORM, 5, "tint", 32);
    shadow.process(s.bytes()); executor.submit(s.bytes(), {});
    const at = int(location, "QUERY_LOCATION", "result");
    const values = new GLStream().uniformfv(at, 4, 1, [0.25, 0.5, 0.75, 1]);
    shadow.process(values.bytes()); executor.submit(values.bytes(), {});
    const gpu = executor.currentProgramObject(), oldLink = gpu.link, oldCompiled = gpu.compiled, oldSerial = gpu.serial;
    const p = shadow.current.group.programs.get(5), oldInput = p.executableInput;
    const fail = new GLStream().shaderSource(2, RELINK_BAD).call("COMPILE_SHADER", 2).call("LINK_PROGRAM", 5);
    const linked = fail.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
    const guarded = fail.queryUniform(5, at, 1, 16); guarded.bytes.fill(0xA5, 32);
    fail.uniformfv(at, 4, 1, [1, 0, 0, 1]).call("USE_PROGRAM", 5);
    shadow.process(fail.bytes()); executor.submit(fail.bytes(), {});
    assert.equal(int(linked, "QUERY_OBJECT_IV", "value"), 0);
    assert.equal(status(guarded, "QUERY_UNIFORM"), FAILED);
    assert.ok(guarded.bytes.subarray(32).every(v => v === 0xA5));
    assert.equal(shadow.current.error, GL.INVALID_OPERATION); assert.equal(shadow.stats.rejected, 3);
    assert.equal(shadow.current.program, 5); assert.equal(executor.currentProgramObject(), gpu);
    assert.equal(gpu.linked, false); assert.equal(gpu.link, oldLink); assert.equal(gpu.compiled, oldCompiled);
    assert.equal(gpu.serial, oldSerial); assert.equal(p.executableInput, oldInput);
    assert.deepEqual(p.values.get(at), [0.25, 0.5, 0.75, 1]);
    const uniform = gpu.uniformByName.get("tint");
    assert.deepEqual(Array.from(gpu.uniformFloats.subarray(uniform.offsetBytes / 4, uniform.offsetBytes / 4 + 4)), p.values.get(at));
    const fixed = new GLStream().shaderSource(2, RELINK_FS).call("COMPILE_SHADER", 2).call("LINK_PROGRAM", 5);
    shadow.process(fixed.bytes()); executor.submit(fixed.bytes(), {});
    assert.equal(p.values.size, 0); assert.notEqual(p.executableInput, oldInput);
    assert.equal(executor.currentProgramObject(), gpu); assert.ok(gpu.linked); assert.ok(gpu.serial > oldSerial);
    assert.ok(gpu.uniformData.every(v => v === 0));
});
test("snapshots retain the failed link and the previous executable's uniform values", () => {
    const shadow = newShadow(), s = relinkSetup(), location = s.queryLocation(UNIFORM, 5, "tint", 32);
    shadow.process(s.bytes()); const at = int(location, "QUERY_LOCATION", "result");
    shadow.process(new GLStream().uniformfv(at, 4, 1, [0.25, 0.5, 0.75, 1])
        .shaderSource(2, RELINK_BAD).call("COMPILE_SHADER", 2).call("LINK_PROGRAM", 5).bytes());
    const copy = newShadow(); copy.setState(JSON.parse(JSON.stringify(shadow.getState())));
    const p = copy.current.group.programs.get(5);
    assert.equal(copy.linkedProgram(p).ok, false);
    assert.deepEqual(p.values.get(at), [0.25, 0.5, 0.75, 1]);
    assert.equal(p.executableInput.shaders.find(s => s.type === GL.FRAGMENT_SHADER).compileSource, RELINK_FS);
    copy.process(new GLStream().call("USE_PROGRAM", 0).call("USE_PROGRAM", 5).bytes());
    assert.equal(copy.current.program, 0); assert.equal(copy.current.error, GL.INVALID_OPERATION);
});
test("GLSL query errors are latched on the CPU and preserve output", () => {
    for (const [make, expected] of [
        [s => s.queryObjectiv(SHADER, 5, GL.COMPILE_STATUS), GL.INVALID_OPERATION],
        [s => s.queryObjectiv(PROGRAM, 99, GL.LINK_STATUS), GL.INVALID_VALUE],
        [s => s.queryObjectiv(PROGRAM, 5, 0), GL.INVALID_ENUM],
        [s => s.queryObjectLog(PROGRAM, 1, 32), GL.INVALID_OPERATION],
        [s => s.queryActive(1, 5, 99, 32), GL.INVALID_VALUE],
        [s => s.queryLocation(UNIFORM, 1, "tint", 32), GL.INVALID_OPERATION],
        [s => s.queryUniform(5, -1, 1, 16), GL.INVALID_OPERATION],
    ]) {
        const shadow = newShadow(), setup = relinkSetup(); shadow.process(setup.bytes());
        const s = new GLStream(), r = make(s); r.bytes.fill(0xA5, 32);
        shadow.process(s.bytes()); assert.equal(shadow.current.error, expected);
        assert.equal(shadow.stats.rejected, 1); assert.ok(r.bytes.subarray(32).every(v => v === 0xA5));
    }
});

function samplerProgram(fs = "uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, vec2(0.5)); }") {
    return new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1)
        .call("CREATE_SHADER", 1, GL.VERTEX_SHADER).shaderSource(1, "void main() { gl_Position = gl_Vertex; }").call("COMPILE_SHADER", 1)
        .call("CREATE_SHADER", 2, GL.FRAGMENT_SHADER).shaderSource(2, fs).call("COMPILE_SHADER", 2)
        .call("CREATE_PROGRAM", 5).call("ATTACH_SHADER", 5, 1).call("ATTACH_SHADER", 5, 2).call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5);
}

test("sampler limits match actual texture units and reject oversized linked programs", () => {
    for (const pname of [GL.MAX_TEXTURE_IMAGE_UNITS, GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS, GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS])
        assert.equal(glCaps.integer(CAPS, pname), 8);
    const shadow = newShadow(), s = samplerProgram("uniform sampler2D tex[9]; void main() { gl_FragColor = " +
        Array.from({ length: 9 }, (_, i) => "texture2D(tex[" + i + "], vec2(0.5))").join(" + ") + "; }");
    const linked = s.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
    shadow.process(s.bytes());
    assert.equal(int(linked, "QUERY_OBJECT_IV", "value"), 0, "nine active samplers exceed the eight-unit implementation");
    for (const count of [4, 5]) {
        const s = samplerProgram("#version 120\nuniform sampler2D tex[" + count + "]; void main() { gl_FragColor = " +
            Array.from({ length: count }, (_, i) => "texture2D(tex[" + i + "], vec2(0.5))").join(" + ") + "; }");
        s.shaderSource(1, "#version 120\nuniform sampler2D tex[" + count + "]; void main() { gl_Position = gl_Vertex + " +
            Array.from({ length: count }, (_, i) => "texture2D(tex[" + i + "], vec2(0.5))").join(" + ") + "; }")
            .call("COMPILE_SHADER", 1).call("LINK_PROGRAM", 5);
        const status1 = s.queryObjectiv(PROGRAM, 5, GL.LINK_STATUS);
        const shadow = newShadow(); shadow.process(s.bytes());
        assert.equal(int(status1, "QUERY_OBJECT_IV", "value"), +(count === 4),
            "combined resources count each stage's uses: " + shadow.current.group.programs.get(5).linked.log);
    }
});

test("sampler assignments retain signed values; validation and rendering check the assigned units", () => {
    const reference = JSON.parse(readFileSync(join(__dirname, "gl_conformance/glsl_samplers_reference.json")));
    for (const [name, value, valid] of [["last", 7, true], ["negative", -1, false], ["past_end", 8, false]]) {
        const shadow = newShadow(), setup = samplerProgram(), at = setup.queryLocation(UNIFORM, 5, "tex", 32);
        shadow.process(setup.bytes()); const location = int(at, "QUERY_LOCATION", "result");
        const s = new GLStream().uniformiv(location, 1, 1, [value]);
        const stored = s.queryUniform(5, location, 2, 4);
        shadow.process(s.bytes());
        assert.equal(shadow.current.error, reference.cases[name][0]);
        assert.equal(stored.view.getInt32(32, true), value);
        const validate = new GLStream().call("VALIDATE_PROGRAM", 5);
        const status1 = validate.queryObjectiv(PROGRAM, 5, GL.VALIDATE_STATUS);
        const log = validate.queryObjectLog(PROGRAM, 5, 256);
        const logSize = validate.queryObjectiv(PROGRAM, 5, GL.INFO_LOG_LENGTH);
        validate.call("BEGIN", GL.TRIANGLES);
        shadow.process(validate.bytes());
        assert.equal(int(status1, "QUERY_OBJECT_IV", "value"), +valid);
        assert.equal(shadow.current.error, valid ? 0 : GL.INVALID_OPERATION);
        assert.equal(shadow.current.state.begin, valid);
        if (!valid) {
            assert.match(text(log, "QUERY_OBJECT_LOG", int(log, "QUERY_OBJECT_LOG", "length")), /unavailable texture unit/);
            assert.equal(int(logSize, "QUERY_OBJECT_IV", "value"), int(log, "QUERY_OBJECT_LOG", "length") + 1);
            const raster = new GLStream().call("RASTER_POS4F", 0, 0, 0, 1), bytes = raster.bytes();
            shadow.process(bytes);
            assert.ok(P.isRejected(new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, true)), "RasterPos also validates shader execution");
            shadow.process(new GLStream().uniformiv(location, 1, 1, [7]).bytes());
            const frozen = new GLStream(), savedStatus = frozen.queryObjectiv(PROGRAM, 5, GL.VALIDATE_STATUS);
            shadow.process(frozen.bytes()); assert.equal(int(savedStatus, "QUERY_OBJECT_IV", "value"), 0);
            const copy = newShadow(); copy.setState(JSON.parse(JSON.stringify(shadow.getState())));
            const restored = new GLStream(), oldStatus = restored.queryObjectiv(PROGRAM, 5, GL.VALIDATE_STATUS);
            restored.call("VALIDATE_PROGRAM", 5); const newStatus = restored.queryObjectiv(PROGRAM, 5, GL.VALIDATE_STATUS);
            copy.process(restored.bytes());
            assert.equal(int(oldStatus, "QUERY_OBJECT_IV", "value"), 0); assert.equal(int(newStatus, "QUERY_OBJECT_IV", "value"), 1);
        }
    }
});

test("samplers may share units only with the same sampler type", () => {
    for (const same of [true, false]) {
        const fs = "uniform sampler2D a; uniform " + (same ? "sampler2D" : "samplerCube") + " b; void main() { gl_FragColor = " +
            "texture2D(a, vec2(0.5)) + " + (same ? "texture2D(b, vec2(0.5))" : "textureCube(b, vec3(1.0))") + "; }";
        const shadow = newShadow(), s = samplerProgram(fs).call("VALIDATE_PROGRAM", 5);
        const valid = s.queryObjectiv(PROGRAM, 5, GL.VALIDATE_STATUS); s.call("BEGIN", GL.TRIANGLES);
        shadow.process(s.bytes());
        assert.equal(int(valid, "QUERY_OBJECT_IV", "value"), +same);
        assert.equal(shadow.current.error, same ? 0 : GL.INVALID_OPERATION);
        assert.equal(shadow.current.state.begin, same);
    }
});

test("render validation uses installed samplers after failed relinks and snapshot restore", () => {
    for (const value of [7, 8]) {
        const shadow = newShadow(), s = samplerProgram(), at = s.queryLocation(UNIFORM, 5, "tex", 32);
        shadow.process(s.bytes()); const location = int(at, "QUERY_LOCATION", "result");
        shadow.process(new GLStream().uniformiv(location, 1, 1, [value]).shaderSource(2, "void main() { broken; }")
            .call("COMPILE_SHADER", 2).call("LINK_PROGRAM", 5).bytes());
        const copy = newShadow(); copy.setState(JSON.parse(JSON.stringify(shadow.getState())));
        for (const current of [shadow, copy]) {
            current.process(new GLStream().call("BEGIN", GL.TRIANGLES).bytes());
            assert.equal(current.current.state.begin, value === 7);
            assert.equal(current.current.error, value === 7 ? 0 : GL.INVALID_OPERATION);
        }
    }
});

test("a CPU resource link failure is forwarded without replacing renderer code or uniforms", async () => {
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize();
    const shadow = newShadow(), setup = samplerProgram(), at = setup.queryLocation(UNIFORM, 5, "tex", 32);
    shadow.process(setup.bytes()); executor.submit(setup.bytes(), {});
    const location = int(at, "QUERY_LOCATION", "result"), values = new GLStream().uniformiv(location, 1, 1, [7]);
    shadow.process(values.bytes()); executor.submit(values.bytes(), {});
    const program = executor.currentProgramObject(), oldLink = program.link, oldValues = program.uniformData.slice();
    const fail = new GLStream().shaderSource(2, "uniform sampler2D tex[9]; void main() { gl_FragColor = " +
        Array.from({ length: 9 }, (_, i) => "texture2D(tex[" + i + "], vec2(0.5))").join(" + ") + "; }").call("COMPILE_SHADER", 2);
    const offset = fail.length; fail.call("LINK_PROGRAM", 5);
    const bytes = fail.bytes(); shadow.process(bytes);
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true), P.GLFN.PROGRAM_LINK_FAILED);
    executor.submit(bytes.slice(), {});
    assert.equal(program.linked, false); assert.equal(executor.currentProgramObject(), program);
    assert.equal(program.link, oldLink); assert.deepEqual(program.uniformData, oldValues);
});

(async () => {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log("ok   " + name);
        } catch (error) {
            console.error("FAIL " + name + "\n" + (error && error.stack || error));
            process.exitCode = 1;
            return;
        }
    }
    console.log(tests.length + " GL shadow GLSL tests passed");
})();
