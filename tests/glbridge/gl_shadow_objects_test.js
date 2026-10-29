#!/usr/bin/env node
// The GL shadow's textures, renderbuffers and framebuffer objects
// (gl_shadow_objects.js): glCheckFramebufferStatus answered on the CPU side,
// by EXT_framebuffer_object's rules, and the state kept across snapshots.
"use strict";

const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
const glCaps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");

const OK = P.C.V86GL_SYNC_QUERY_STATUS_OK;
const FRAMEBUFFER = 0x8D40, RENDERBUFFER = 0x8D41;
const COLOR0 = GL.COLOR_ATTACHMENT0, DEPTH = GL.DEPTH_ATTACHMENT, STENCIL = GL.STENCIL_ATTACHMENT;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function shadow() {
    const s = new GLShadow();
    s.setCapabilities(glCaps.capabilities({}, {}));
    return s;
}

// A stream with a context, and a way to ask the status at that point
function scene() {
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    const asks = [];
    stream.status = (target = FRAMEBUFFER) => {
        stream.record(P.GLFN.CHECK_FRAMEBUFFER_STATUS, P.encodeRecord("CHECK_FRAMEBUFFER_STATUS", { target }));
        asks.push(stream.payloadView());
        return stream;
    };
    stream.answers = () => asks.map(r => {
        assert.equal(r.view.getUint32(P.F.CHECK_FRAMEBUFFER_STATUS.status, true), OK);
        return r.view.getUint32(P.F.CHECK_FRAMEBUFFER_STATUS.result, true);
    });
    return stream;
}

const texture = (stream, name, width, height, internalFormat = GL.RGBA, target = GL.TEXTURE_2D) =>
    stream.call("BIND_TEXTURE", target === GL.TEXTURE_2D ? target : GL.TEXTURE_CUBE_MAP, name)
        .texImage2D(target, 0, internalFormat, width, height, GL.RGBA, GL.UNSIGNED_BYTE, null);
const renderbuffer = (stream, name, internalFormat, width, height) =>
    stream.call("BIND_RENDERBUFFER", RENDERBUFFER, name).call("RENDERBUFFER_STORAGE", RENDERBUFFER, internalFormat,
        width, height);
const attachTexture = (stream, attachment, name, level = 0, target = GL.TEXTURE_2D) =>
    stream.call("FRAMEBUFFER_TEXTURE", FRAMEBUFFER, attachment, target, name, level, 0);
const attachRenderbuffer = (stream, attachment, name) =>
    stream.call("FRAMEBUFFER_RENDERBUFFER", FRAMEBUFFER, attachment, RENDERBUFFER, name);

test("the default framebuffer is complete; an empty object is missing an attachment", () => {
    const s = scene().status().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).status();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), [GL.FRAMEBUFFER_COMPLETE, GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]);
});

test("colour texture plus depth renderbuffer is complete, and the executor agrees", async () => {
    const s = scene();
    texture(s, 7, 32, 16);
    renderbuffer(s, 9, GL.DEPTH_COMPONENT24, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    attachTexture(s, COLOR0, 7);
    attachRenderbuffer(s, DEPTH, 9);
    s.status();
    // the executor answers the same stream on its own
    const copy = s.bytes().slice();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), [GL.FRAMEBUFFER_COMPLETE]);
    const { host } = createFakeHost();
    const executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    executor.submit(copy, {});
    const at = copy.length - P.RECORDS.CHECK_FRAMEBUFFER_STATUS.size;
    assert.equal(new DataView(copy.buffer).getUint32(at + P.F.CHECK_FRAMEBUFFER_STATUS.result, true),
        GL.FRAMEBUFFER_COMPLETE);
});

test("what makes an attachment incomplete", () => {
    const s = scene();
    texture(s, 7, 32, 16);
    s.call("BIND_TEXTURE", GL.TEXTURE_2D, 8);
    renderbuffer(s, 9, GL.DEPTH_COMPONENT24, 32, 16);
    renderbuffer(s, 10, GL.RGBA8, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    // a texture with no image at the level
    attachTexture(s, COLOR0, 8);
    s.status();
    // a level the texture does not have
    attachTexture(s, COLOR0, 7, 2);
    s.status();
    // a depth format as colour
    attachTexture(s, COLOR0, 7);
    attachRenderbuffer(s, GL.COLOR_ATTACHMENT0 + 1, 9);
    s.status();
    // a colour format as depth
    attachRenderbuffer(s, GL.COLOR_ATTACHMENT0 + 1, 0);
    attachRenderbuffer(s, DEPTH, 10);
    s.status();
    // a depth-only format as stencil
    attachRenderbuffer(s, DEPTH, 0);
    attachRenderbuffer(s, STENCIL, 9);
    s.status();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), new Array(5).fill(GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT));
});

test("sizes, draw and read buffers, and separate depth and stencil images", () => {
    const s = scene();
    texture(s, 7, 32, 16);
    texture(s, 8, 16, 16);
    renderbuffer(s, 9, GL.DEPTH_COMPONENT24, 32, 16);
    renderbuffer(s, 11, GL.STENCIL_INDEX8_EXT, 32, 16);
    renderbuffer(s, 12, GL.DEPTH24_STENCIL8, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    attachTexture(s, COLOR0, 7);
    attachTexture(s, COLOR0 + 1, 8);
    s.status();
    attachTexture(s, COLOR0 + 1, 0);
    // the draw buffer names an attachment that is not there
    s.call("DRAW_BUFFER", COLOR0 + 2).status();
    s.call("DRAW_BUFFER", COLOR0).call("READ_BUFFER", COLOR0 + 3).status().status(GL.DRAW_FRAMEBUFFER);
    s.call("READ_BUFFER", COLOR0);
    // depth and stencil from two images: WebGPU cannot
    attachRenderbuffer(s, DEPTH, 9);
    attachRenderbuffer(s, STENCIL, 11);
    s.status();
    // one depth-stencil image at both is fine
    attachRenderbuffer(s, GL.DEPTH_STENCIL_ATTACHMENT, 12);
    s.status();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), [GL.FRAMEBUFFER_INCOMPLETE_DIMENSIONS_EXT, GL.FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER_EXT,
        GL.FRAMEBUFFER_INCOMPLETE_READ_BUFFER_EXT, GL.FRAMEBUFFER_COMPLETE, GL.FRAMEBUFFER_UNSUPPORTED_EXT,
        GL.FRAMEBUFFER_COMPLETE]);
});

test("cube faces, mipmaps and deletion", () => {
    const s = scene();
    texture(s, 7, 32, 32, GL.RGBA, GL.TEXTURE_CUBE_MAP_POSITIVE_X + 2);
    texture(s, 8, 64, 32);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    // the face that has an image, then one that has not
    attachTexture(s, COLOR0, 7, 0, GL.TEXTURE_CUBE_MAP_POSITIVE_X + 2);
    s.status();
    attachTexture(s, COLOR0, 7, 0, GL.TEXTURE_CUBE_MAP_POSITIVE_X + 3);
    s.status();
    // level 2 exists once the mipmaps are generated: 16x8
    attachTexture(s, COLOR0, 8, 2);
    s.status();
    s.call("BIND_TEXTURE", GL.TEXTURE_2D, 8).call("GENERATE_MIPMAP", GL.TEXTURE_2D).status();
    // deleting the texture detaches it from the bound framebuffer
    s.names(P.GLFN.DELETE_TEXTURES, [8]);
    s.status();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), [GL.FRAMEBUFFER_COMPLETE, GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT,
        GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT, GL.FRAMEBUFFER_COMPLETE, GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]);
});

test("framebuffer objects are the context's; textures the share group's; a snapshot keeps both", () => {
    const one = shadow();
    const s = scene();
    texture(s, 7, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    attachTexture(s, COLOR0, 7);
    one.process(s.bytes());
    // another context of the share group: texture 7 is there, framebuffer 3 is not (yet)
    const other = new GLStream().makeCurrent(1, 0, 0, 64, 64, 2, 1).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    other.record(P.GLFN.CHECK_FRAMEBUFFER_STATUS, P.encodeRecord("CHECK_FRAMEBUFFER_STATUS", { target: FRAMEBUFFER }));
    const fresh = other.payloadView();
    one.process(other.bytes());
    assert.equal(fresh.view.getUint32(P.F.CHECK_FRAMEBUFFER_STATUS.result, true),
        GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT);
    // back on the first context, after a snapshot
    const copy = shadow();
    copy.setState(JSON.parse(JSON.stringify(one.getState())));
    const again = scene().status();
    copy.process(again.bytes());
    assert.deepEqual(again.answers(), [GL.FRAMEBUFFER_COMPLETE]);
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
    console.log(tests.length + " GL shadow object tests passed");
})();
