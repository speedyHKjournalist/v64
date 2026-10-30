#!/usr/bin/env node
// The GL shadow's ARB assembly programs (gl_shadow_arb.js): loading, the
// error position and string, environment and local parameters by the
// extensions' rules, the queries, and snapshots.
"use strict";

const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arb.js");
const glCaps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const reference = require("./gl_conformance/arb_reference.json").cases;

const OK = P.C.V86GL_SYNC_QUERY_STATUS_OK, FAILED = P.C.V86GL_SYNC_QUERY_STATUS_FAILED;
const ENV = P.C.V86GL_PROGRAM_PARAMETER_ENV, LOCAL = P.C.V86GL_PROGRAM_PARAMETER_LOCAL;
const VP = GL.VERTEX_PROGRAM_ARB, FP = GL.FRAGMENT_PROGRAM_ARB;
const GOOD_VP = "!!ARBvp1.0\nTEMP t;\nMOV t, vertex.position;\nMOV result.position, t;\nEND\n";
const GOOD_FP = "!!ARBfp1.0\nMOV result.color, fragment.color;\nEND\n";
const BAD_FP = "!!ARBfp1.0\nMOV result.color, fragment.bogus;\nEND\n";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function shadow() {
    const s = new GLShadow();
    s.setCapabilities(glCaps.capabilities({}, {}));
    return s;
}

const context = () => new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
function programiv(stream, target, pname) {
    stream.record(P.GLFN.QUERY_PROGRAM_IV_ARB, P.encodeRecord("QUERY_PROGRAM_IV_ARB", { target, pname }));
    return stream.payloadView();
}
function value(r) {
    assert.equal(r.view.getUint32(P.F.QUERY_PROGRAM_IV_ARB.status, true), OK);
    return r.view.getInt32(P.F.QUERY_PROGRAM_IV_ARB.value, true);
}
function parameter(r) {
    assert.equal(r.view.getUint32(P.F.QUERY_PROGRAM_PARAMETER_FV_ARB.status, true), OK);
    return [0, 1, 2, 3].map(i => r.view.getFloat32(24 + i * 4, true));
}
const string = r => String.fromCharCode(...r.bytes.subarray(24, 24 + r.view.getUint32(P.F.QUERY_PROGRAM_STRING_ARB.length,
    true)));

test("a program loads; its length, counts and text are answered", () => {
    const s = context().call("BIND_PROGRAM_ARB", VP, 4).programStringARB(VP, GOOD_VP);
    const length = programiv(s, VP, GL.PROGRAM_LENGTH_ARB);
    const instructions = programiv(s, VP, GL.PROGRAM_INSTRUCTIONS_ARB);
    const temporaries = programiv(s, VP, GL.PROGRAM_TEMPORARIES_ARB);
    const binding = programiv(s, VP, GL.PROGRAM_BINDING_ARB);
    const native = programiv(s, VP, GL.PROGRAM_UNDER_NATIVE_LIMITS_ARB);
    const position = s.queryInteger(GL.PROGRAM_ERROR_POSITION_ARB);
    const text = s.queryProgramStringARB(VP, 128);
    shadow().process(s.bytes());
    assert.equal(value(length), GOOD_VP.length);
    assert.equal(value(instructions), 2);
    assert.equal(value(temporaries), 1);
    assert.equal(value(binding), 4);
    assert.equal(value(native), 1);
    assert.equal(position.view.getInt32(8, true), -1);
    assert.equal(string(text), GOOD_VP);
});

test("a program that does not assemble keeps the old one and says where it stopped", () => {
    const s = context().call("BIND_PROGRAM_ARB", FP, 4).programStringARB(FP, GOOD_FP).programStringARB(FP, BAD_FP);
    const position = s.queryInteger(GL.PROGRAM_ERROR_POSITION_ARB);
    const message = s.queryString(GL.PROGRAM_ERROR_STRING_ARB, 256);
    const length = programiv(s, FP, GL.PROGRAM_LENGTH_ARB);
    // a fragment program for the vertex target is an error too
    s.call("BIND_PROGRAM_ARB", VP, 5).programStringARB(VP, GOOD_FP);
    const wrongTarget = s.queryInteger(GL.PROGRAM_ERROR_POSITION_ARB);
    // and the next good load clears the error
    s.programStringARB(VP, GOOD_VP);
    const cleared = s.queryInteger(GL.PROGRAM_ERROR_POSITION_ARB);
    const clearedString = s.queryString(GL.PROGRAM_ERROR_STRING_ARB, 64);
    shadow().process(s.bytes());
    const at = BAD_FP.indexOf("fragment.bogus");
    assert.ok(position.view.getInt32(8, true) >= at && position.view.getInt32(8, true) <= at + "fragment.bogus".length,
        "the error position is at the bad source: " + position.view.getInt32(8, true));
    assert.match(String.fromCharCode(...message.bytes.subarray(16, 16 + message.view.getUint32(8, true) - 1)),
        /fragment\.bogus/);
    assert.equal(value(length), GOOD_FP.length, "the program that loaded stays");
    assert.equal(wrongTarget.view.getInt32(8, true), 0);
    assert.equal(cleared.view.getInt32(8, true), -1);
    assert.equal(clearedString.view.getUint32(8, true), 1, "an empty error string");
});

test("environment parameters are the target's, set with no program bound; local ones the program's", () => {
    const s = context().programParameterARB(ENV, VP, 3, [1, 2, 3, 4]);
    s.call("BIND_PROGRAM_ARB", VP, 4).programStringARB(VP, GOOD_VP).programParameterARB(LOCAL, VP, 1, [5, 6, 7, 8]);
    const env4 = s.queryProgramParameterARB(ENV, VP, 3);
    const local4 = s.queryProgramParameterARB(LOCAL, VP, 1);
    s.call("BIND_PROGRAM_ARB", VP, 5);
    const env5 = s.queryProgramParameterARB(ENV, VP, 3);
    const local5 = s.queryProgramParameterARB(LOCAL, VP, 1);
    const fragmentEnv = s.queryProgramParameterARB(ENV, FP, 3);
    const beyond = s.queryProgramParameterARB(ENV, VP, 96);
    shadow().process(s.bytes());
    assert.deepEqual(parameter(env4), [1, 2, 3, 4]);
    assert.deepEqual(parameter(local4), [5, 6, 7, 8]);
    assert.deepEqual(parameter(env5), [1, 2, 3, 4], "every vertex program sees the environment");
    assert.deepEqual(parameter(local5), [0, 0, 0, 0], "a program's locals are its own");
    assert.deepEqual(parameter(fragmentEnv), [0, 0, 0, 0], "the fragment target's environment is another");
    assert.equal(beyond.view.getUint32(P.F.QUERY_PROGRAM_PARAMETER_FV_ARB.status, true), FAILED);
});

test("deleting a bound program binds object 0, which is a program of its own", () => {
    const s = context().call("BIND_PROGRAM_ARB", VP, 4).programStringARB(VP, GOOD_VP);
    s.names(P.GLFN.DELETE_PROGRAMS_ARB, [4]);
    const binding = programiv(s, VP, GL.PROGRAM_BINDING_ARB);
    const length = programiv(s, VP, GL.PROGRAM_LENGTH_ARB);
    s.programStringARB(VP, GOOD_VP);
    const loaded = programiv(s, VP, GL.PROGRAM_LENGTH_ARB);
    shadow().process(s.bytes());
    assert.equal(value(binding), 0);
    assert.equal(value(length), 0);
    assert.equal(value(loaded), GOOD_VP.length);
});

test("a snapshot keeps the programs, parameters and error state", () => {
    const one = shadow();
    one.process(context().programParameterARB(ENV, FP, 2, [9, 8, 7, 6]).call("BIND_PROGRAM_ARB", FP, 4)
        .programStringARB(FP, GOOD_FP).programParameterARB(LOCAL, FP, 0, [1, 1, 2, 3]).programStringARB(FP, BAD_FP)
        .bytes());
    const copy = shadow();
    copy.setState(JSON.parse(JSON.stringify(one.getState())));
    const s = context();
    const env = s.queryProgramParameterARB(ENV, FP, 2);
    const local = s.queryProgramParameterARB(LOCAL, FP, 0);
    const text = s.queryProgramStringARB(FP, 128);
    const position = s.queryInteger(GL.PROGRAM_ERROR_POSITION_ARB);
    const instructions = programiv(s, FP, GL.PROGRAM_INSTRUCTIONS_ARB);
    copy.process(s.bytes());
    assert.deepEqual(parameter(env), [9, 8, 7, 6]);
    assert.deepEqual(parameter(local), [1, 1, 2, 3]);
    assert.equal(string(text), GOOD_FP);
    assert.ok(position.view.getInt32(8, true) > 0);
    assert.equal(value(instructions), 1, "the program assembled again");
});

test("the executor leaves the answered ARB queries alone", async () => {
    const { host } = createFakeHost();
    const executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    // with no program bound the executor would fail this one; the shadow answers it
    const s = context().programParameterARB(ENV, VP, 3, [1, 2, 3, 4]);
    const env = s.queryProgramParameterARB(ENV, VP, 3);
    shadow().process(s.bytes());
    executor.submit(s.bytes(), {});
    assert.deepEqual(parameter(env), [1, 2, 3, 4]);
});

test("vertex parameter 95 is stored, compiled and queried while fragment parameters retain their own limit", async () => {
    const s = context().programParameterARB(ENV, VP, 95, [1, 2, 3, 4])
        .programParameterARB(LOCAL, VP, 95, [5, 6, 7, 8])
        .programStringARB(VP, "!!ARBvp1.0\nADD result.position, program.env[95], program.local[95];\nEND");
    const maxVertex = programiv(s, VP, GL.MAX_PROGRAM_ENV_PARAMETERS_ARB), maxFragment = programiv(s, FP, GL.MAX_PROGRAM_ENV_PARAMETERS_ARB);
    const env = s.queryProgramParameterARB(ENV, VP, 95), local = s.queryProgramParameterARB(LOCAL, VP, 95);
    s.programParameterARB(ENV, VP, 96, [1, 1, 1, 1]).programParameterARB(ENV, FP, 28, [1, 1, 1, 1]);
    const state = shadow(); state.process(s.bytes()); assert.equal(state.stats.rejected, 2);
    assert.equal(value(maxVertex), 96); assert.equal(value(maxFragment), 28);
    assert.deepEqual(parameter(env), [1, 2, 3, 4]); assert.deepEqual(parameter(local), [5, 6, 7, 8]);
    const { host } = createFakeHost(), executor = new GLWebGPUExecutor(null, { host }); await executor.initialize(); executor.submit(s.bytes(), {});
    assert.deepEqual(Array.from(executor.arbEnvironment(VP).subarray(95 * 4, 96 * 4)), [1, 2, 3, 4]);
    assert.equal(executor.stats.refusals, 0, "program 0 has real source and local storage on the renderer too");
    const saved = JSON.parse(JSON.stringify(state.getState())), copy = shadow(); copy.setState(saved);
    assert.deepEqual(copy.getState(), saved);
});

test("program parameter use counts agree with native GL and distinguish usage from capacity", () => {
    const cases = {
        none: "MOV result.position, vertex.position;",
        high: "ADD result.position, program.env[95], program.local[94];",
        unused: "PARAM unused = {1};\nMOV result.position, vertex.position;",
        matrix: "PARAM mvp[4] = {state.matrix.mvp};\n" + ["x", "y", "z", "w"].map((c, i) => "DP4 result.position." + c + ",mvp[" + i + "],vertex.position;").join("\n"),
        duplicate: "PARAM c = {1,2,3,4};\nPARAM d = {1,2,3,4};\nADD result.position,c,d;",
        relative_constants: "PARAM arr[2] = {{1,1,1,1},{1,1,1,1}};\nADDRESS a;\nARL a.x,vertex.position.x;\nMOV result.position,arr[a.x];",
    };
    for (const [name, source] of Object.entries(cases)) {
        const s = context().programStringARB(VP, "!!ARBvp1.0\n" + source + "\nEND");
        const used = programiv(s, VP, GL.PROGRAM_PARAMETERS_ARB), native = programiv(s, VP, GL.PROGRAM_NATIVE_PARAMETERS_ARB);
        const max = programiv(s, VP, GL.MAX_PROGRAM_PARAMETERS_ARB); shadow().process(s.bytes());
        // ARB_vertex_program 2.14.3.7 coalesces equal non-relative constants.
        // Apple's logical counter reports two for the identical declarations;
        // our generated code has one distinct binding, as the spec requires.
        const expected = name === "duplicate" ? 1 : reference[name];
        assert.equal(value(used), expected, name); assert.equal(value(native), expected); assert.equal(value(max), 4096);
    }
});

test("invalid ARB commands preserve bindings, parameters and the last loaded program", () => {
    const s = context().call("BIND_PROGRAM_ARB", VP, 4).programStringARB(VP, GOOD_VP)
        .call("BIND_PROGRAM_ARB", FP, 4).call("BIND_PROGRAM_ARB", 0xDEAD, 4)
        .programParameterARB(ENV, VP, 96, [1, 2, 3, 4]).programStringARB(VP, BAD_FP);
    const binding = programiv(s, FP, GL.PROGRAM_BINDING_ARB), length = programiv(s, VP, GL.PROGRAM_LENGTH_ARB), invalid = programiv(s, VP, 0xDEAD);
    const state = shadow(); state.process(s.bytes()); assert.equal(state.stats.rejected, 4);
    assert.equal(value(binding), 0); assert.equal(value(length), GOOD_VP.length);
    assert.equal(invalid.view.getUint32(P.F.QUERY_PROGRAM_IV_ARB.status, true), FAILED);
    assert.equal(state.current.error, GL.INVALID_OPERATION);
});

test("cyclic aliases and duplicate state in relative parameter arrays fail safely", () => {
    const s = context().programStringARB(VP, "!!ARBvp1.0\nALIAS a = b;\nALIAS b = a;\nMOV result.position,a;\nEND")
        .programStringARB(VP, "!!ARBvp1.0\nPARAM arr[2] = {program.env[0],program.env[0]};\nADDRESS a;\nARL a.x,vertex.position.x;\nMOV result.position,arr[a.x];\nEND");
    const state = shadow(); state.process(s.bytes()); assert.equal(state.stats.rejected, 2);
    assert.match(state.current.arb.errorString, /state bound twice/);
});

test("fragment instruction and indirection queries follow the sequential-node rules", () => {
    for (const [source, expected] of [
        ["MOV result.color,fragment.color;", [1, 0, 1]],
        ["TEMP t; TEX t,fragment.texcoord[0],texture[0],2D; TEX result.color,t,texture[1],2D;", [0, 2, 2]],
        ["TEMP t; MOV t,fragment.texcoord[0]; TEX result.color,t,texture[0],2D;", [1, 1, 2]],
        ["TEMP t; MOV result.color,t; TEX t,fragment.texcoord[0],texture[0],2D;", [1, 1, 2]],
        ["TEMP t; TEX t,fragment.texcoord[0],texture[0],2D; TEX result.color,fragment.texcoord[0],texture[1],2D;", [0, 2, 1]],
    ]) {
        const s = context().programStringARB(FP, "!!ARBfp1.0\n" + source + "\nEND"), answers =
            [GL.PROGRAM_ALU_INSTRUCTIONS_ARB, GL.PROGRAM_TEX_INSTRUCTIONS_ARB, GL.PROGRAM_TEX_INDIRECTIONS_ARB].map(p => programiv(s, FP, p));
        const max = programiv(s, FP, GL.MAX_PROGRAM_NATIVE_TEX_INDIRECTIONS_ARB);
        shadow().process(s.bytes()); assert.deepEqual(answers.map(value), expected); assert.equal(value(max), 4096);
    }
});

test("malformed ARB declarations, initializer sizes and huge ranges are rejected before WGSL generation", () => {
    for (const [header, source] of [
        ["vp", "TEMP t; PARAM t = 1; MOV result.position,vertex.position;"],
        ["vp", "ALIAS a = missing; MOV result.position,vertex.position;"],
        ["fp", "ADDRESS a; MOV result.color,fragment.color;"],
        ["vp", "PARAM arr[3] = {state.matrix.mvp}; MOV result.position,vertex.position;"],
        ["vp", "PARAM arr[0] = {1}; MOV result.position,vertex.position;"],
        ["vp", "PARAM v = {1,2,3,4,5}; MOV result.position,vertex.position;"],
        ["vp", "PARAM arr[] = {program.env[0..4294967295]}; MOV result.position,vertex.position;"],
        ["vp", "ATTRIB v = program.env[0]; MOV result.position,v;"],
        ["vp", "PARAM v = vertex.position; MOV result.position,v;"],
        ["fp", "MOV result.color,fragment.texcoord[8];"],
        ["vp", "MOV result.texcoord[8],vertex.position;"],
        ["vp", "MOV result.position,state.matrix.mvp.row[4];"],
        ["vp", "MOV result.position,state.light[8].position;"],
    ]) {
        const s = context().programStringARB(header === "vp" ? VP : FP, "!!ARB" + header + "1.0\n" + source + "\nEND"), state = shadow();
        state.process(s.bytes()); assert.equal(state.stats.rejected, 1, source); assert.equal(state.current.error, GL.INVALID_OPERATION);
    }
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
    console.log(tests.length + " GL shadow ARB tests passed");
})();
