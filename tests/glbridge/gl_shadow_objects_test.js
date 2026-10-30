#!/usr/bin/env node
// The GL shadow's textures, renderbuffers and framebuffer objects
// (gl_shadow_objects.js): glCheckFramebufferStatus answered on the CPU side,
// by EXT_framebuffer_object's rules, and the state kept across snapshots.
"use strict";

const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
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

test("deleted names cannot redirect shared bindings or unbound framebuffer attachments", async () => {
    const one = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const send = s => { const b = s.bytes(); one.process(b); gpu.submit(b, {}); };
    const s = scene(); texture(s, 7, 32, 16); renderbuffer(s, 9, GL.DEPTH_COMPONENT24, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3); attachTexture(s, COLOR0, 7); attachRenderbuffer(s, DEPTH, 9);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 0).makeCurrent(2, 0, 0, 64, 64, 2, 1)
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 7).call("BIND_RENDERBUFFER", RENDERBUFFER, 9);
    send(s);
    const group = one.current.group, gpuGroup = gpu.current.shareGroup;
    const oldTexture = group.textures.get(7), oldRb = group.renderbuffers.get(9);
    const gpuTexture = gpu.boundTexture(GL.TEXTURE_2D), gpuRb = gpuGroup.renderbuffers.get(9);
    const gpuStorage = gpu.ensureTextureUploaded(gpuTexture), rbStorage = gpuRb.gpuTexture;
    const reuse = scene().names(P.GLFN.DELETE_TEXTURES, [7]).names(P.GLFN.DELETE_RENDERBUFFERS, [9]);
    texture(reuse, 7, 8, 8); renderbuffer(reuse, 9, GL.DEPTH_COMPONENT24, 8, 8);
    reuse.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).status(); send(reuse);
    assert.ok(!(gpu.retired || []).includes(gpuStorage) && !(gpu.retired || []).includes(rbStorage), "referenced images must not be retired");
    assert.deepEqual(reuse.answers(), [GL.FRAMEBUFFER_COMPLETE]);
    assert.notEqual(group.textures.get(7), oldTexture); assert.notEqual(group.renderbuffers.get(9), oldRb);
    assert.equal(one.attachedImage(one.current.framebuffers.get(3).color[0]).width, 32);
    assert.equal(gpu.attachmentSize(gpu.framebuffers.get(gpu.current.id).get(3).color[0]).width, 32);
    const other = new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1); send(other);
    assert.equal(one.boundImage(GL.TEXTURE_2D).texture, oldTexture); assert.equal(gpu.boundTexture(GL.TEXTURE_2D), gpuTexture);
    assert.equal(group.renderbufferImages.get(one.current.renderbufferImage), oldRb);
    assert.equal(gpuGroup.renderbufferImages.get(gpu.current.renderbufferImage), gpuRb);
    // Deleting the reused names while the old FBO is bound must not detach its old images.
    const again = scene().names(P.GLFN.DELETE_TEXTURES, [7]).names(P.GLFN.DELETE_RENDERBUFFERS, [9]).status(); send(again);
    assert.deepEqual(again.answers(), [GL.FRAMEBUFFER_COMPLETE]);
    const release = scene().names(P.GLFN.DELETE_FRAMEBUFFERS, [3])
        .record(P.CTRL.DESTROY_CONTEXT, P.encodeRecord("DESTROY_CONTEXT", { context_id: 2 })); send(release);
    assert.equal(group.textureImages.has(oldTexture.id), false); assert.equal(group.renderbufferImages.has(oldRb.id), false);
    assert.equal(gpuGroup.textureImages.has(gpuTexture.imageId), false); assert.equal(gpuGroup.renderbufferImages.has(gpuRb.imageId), false);
    gpu.releaseRetired(); assert.ok(gpuStorage.destroyed && rbStorage.destroyed, "last-reference removal must release GPU storage");
});
test("reserved names become objects only on bind and CPU queries distinguish deletion and name reuse", () => {
    const one = shadow(), s = scene(), asks = [];
    const ask = (kind, name) => {
        const at = s.length + 4, r = P.encodeRecord("QUERY_PARAMETER", {
            query_kind: P.C.V86GL_PARAMETER_IS_OBJECT, target: kind, pname: name, value_kind: P.C.V86GL_STATE_BOOLEAN, data_size: 8,
        });
        const data = new Uint8Array(r.length + 8); data.set(r); s.record(P.GLFN.QUERY_PARAMETER, data); asks.push(at);
    };
    const kinds = [P.C.V86GL_OBJECT_KIND_TEXTURE, P.C.V86GL_OBJECT_KIND_RENDERBUFFER, P.C.V86GL_OBJECT_KIND_FRAMEBUFFER];
    s.names(P.GLFN.GEN_TEXTURES, [7]).names(P.GLFN.GEN_RENDERBUFFERS, [7]).names(P.GLFN.GEN_FRAMEBUFFERS, [7]);
    for (const k of kinds) ask(k, 7);
    s.call("BIND_TEXTURE", GL.TEXTURE_2D, 7).call("BIND_RENDERBUFFER", RENDERBUFFER, 7).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 7);
    for (const k of kinds) ask(k, 7);
    s.names(P.GLFN.DELETE_TEXTURES, [7]).names(P.GLFN.DELETE_RENDERBUFFERS, [7]).names(P.GLFN.DELETE_FRAMEBUFFERS, [7]);
    for (const k of kinds) ask(k, 7);
    one.process(s.bytes()); const v = new DataView(s.bytes().buffer);
    assert.deepEqual(asks.map(at => { assert.equal(v.getUint32(at + P.F.QUERY_PARAMETER.status, true), OK); return v.getFloat64(at + P.RECORDS.QUERY_PARAMETER.size, true); }),
        [0, 0, 0, 1, 1, 1, 0, 0, 0]);
    const invalid = new GLStream().call("BIND_TEXTURE", GL.TEXTURE_2D, 7).call("BIND_TEXTURE", GL.TEXTURE_3D, 7);
    one.process(invalid.bytes()); assert.equal(one.current.error, GL.INVALID_OPERATION);
    assert.equal(one.current.units[0].has(GL.TEXTURE_3D), false);
});
test("default textures are per-context objects and snapshots preserve retained identities", () => {
    const one = shadow(), s = scene();
    s.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 2, GL.RGBA, GL.UNSIGNED_BYTE, null)
        .call("PUSH_ATTRIB", 0x40000);
    texture(s, 7, 32, 16); s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3); attachTexture(s, COLOR0, 7);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 0).names(P.GLFN.DELETE_TEXTURES, [7]);
    texture(s, 7, 8, 8); s.makeCurrent(2, 0, 0, 64, 64, 2, 1)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 9, 7, GL.RGBA, GL.UNSIGNED_BYTE, null);
    one.process(s.bytes());
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(one.getState())));
    assert.equal(copy.boundImage(GL.TEXTURE_2D).texture.levels.get(0).get(0).width, 9);
    const back = scene().call("POP_ATTRIB").call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).status(); copy.process(back.bytes());
    assert.equal(copy.boundImage(GL.TEXTURE_2D).texture.name, 0);
    assert.equal(copy.boundImage(GL.TEXTURE_2D).texture.levels.get(0).get(0).width, 4);
    assert.equal(copy.attachedImage(copy.current.framebuffers.get(3).color[0]).width, 32);
    assert.deepEqual(back.answers(), [GL.FRAMEBUFFER_COMPLETE]);
});
test("FBO draw/read selections match desktop GL and attribute restoration follows EXT issue 81", async () => {
    const one = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const reference = require("./gl_conformance/fbo_buffers_reference.json").cases;
    const expected = { ...reference, pop_on_b: [COLOR0 + 2, 0, COLOR0 + 1, 0], return_to_b: [COLOR0 + 2, 0, COLOR0 + 1, 0] };
    // Apple does not restore FBO selections at PopAttrib. EXT_framebuffer_object
    // issue 81 and the state tables specify restoration to the currently bound FBO.
    const step = (name, stream) => {
        const asks = [];
        for (const pname of [GL.DRAW_BUFFER0, GL.DRAW_BUFFER0 + 1, GL.DRAW_BUFFER0 + 2, 0x0C02]) {
            const at = stream.length + 4, h = P.encodeRecord("QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 });
            const payload = new Uint8Array(h.length + 8); payload.set(h); stream.record(P.GLFN.QUERY_STATE, payload); asks.push(at);
        }
        const bytes = stream.bytes(); one.process(bytes); gpu.submit(bytes, {});
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        assert.deepEqual(asks.map(at => { assert.equal(v.getUint32(at + P.F.QUERY_STATE.status, true), OK); return v.getFloat64(at + P.RECORDS.QUERY_STATE.size, true); }), expected[name], name);
        const c = gpu.current;
        assert.deepEqual([c.drawBuffers[0] || 0, c.drawBuffers[1] || 0, c.drawBuffers[2] || 0, c.readBuffer], expected[name], "renderer " + name);
    };
    step("initial_a", scene().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3));
    step("configured_a", new GLStream().names(P.GLFN.DRAW_BUFFERS, [COLOR0 + 2, 0, COLOR0 + 1]).call("READ_BUFFER", COLOR0 + 2));
    step("initial_b", new GLStream().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 4));
    step("configured_b", new GLStream().call("DRAW_BUFFER", GL.NONE).call("READ_BUFFER", GL.NONE));
    step("draw_a_read_b", new GLStream().call("BIND_FRAMEBUFFER", GL.DRAW_FRAMEBUFFER, 3));
    step("pop_on_b", new GLStream().call("PUSH_ATTRIB", 0x4020).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 4)
        .call("DRAW_BUFFER", COLOR0 + 3).call("READ_BUFFER", COLOR0 + 3).call("POP_ATTRIB"));
    step("return_to_a", new GLStream().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3));
    step("return_to_b", new GLStream().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 4));
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(one.getState())));
    copy.process(scene().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).bytes());
    assert.deepEqual(copy.current.drawBuffers, [COLOR0 + 2, 0, COLOR0 + 1]); assert.equal(copy.current.readBuffer, COLOR0 + 2);
    const remove = scene().names(P.GLFN.DELETE_FRAMEBUFFERS, [4]); one.process(remove.bytes()); gpu.submit(remove.bytes(), {});
    assert.deepEqual(one.current.drawBuffers, [GL.BACK]); assert.equal(one.current.readBuffer, GL.BACK);
    assert.deepEqual(gpu.current.drawBuffers, [GL.BACK]); assert.equal(gpu.current.readBuffer, GL.BACK);
});
test("draw/read selection rejects invalid enums, unavailable buffers and duplicates atomically", () => {
    for (const [stream, error] of [
        [new GLStream().call("DRAW_BUFFER", GL.BACK), GL.INVALID_OPERATION],
        [new GLStream().call("READ_BUFFER", 0xFFFFFFFF), GL.INVALID_ENUM],
        [new GLStream().names(P.GLFN.DRAW_BUFFERS, [COLOR0, COLOR0]), GL.INVALID_OPERATION],
        [new GLStream().names(P.GLFN.DRAW_BUFFERS, [COLOR0 + 2, 0xFFFFFFFF]), GL.INVALID_ENUM],
        [new GLStream().names(P.GLFN.DRAW_BUFFERS, new Array(9).fill(GL.NONE)), GL.INVALID_VALUE],
        [new GLStream().call("BEGIN", GL.POINTS).call("DRAW_BUFFER", GL.NONE), GL.INVALID_OPERATION],
    ]) {
        const one = shadow(); one.process(scene().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).bytes());
        one.process(stream.bytes()); assert.equal(one.current.error, error); assert.deepEqual(one.current.drawBuffers, [COLOR0]);
        assert.equal(one.current.readBuffer, COLOR0);
    }
    const single = shadow(), s = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1, P.C.V86GL_FORMAT_SINGLE_BUFFER);
    single.process(s.bytes()); assert.deepEqual(single.current.drawBuffers, [GL.FRONT]); assert.equal(single.current.readBuffer, GL.FRONT);
    single.process(new GLStream().call("DRAW_BUFFER", GL.BACK).bytes()); assert.equal(single.current.error, GL.INVALID_OPERATION);
});
test("texture attribute bindings keep a deleted image alive until the saved binding is released", async () => {
    const one = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const send = s => { one.process(s.bytes()); gpu.submit(s.bytes(), {}); };
    const s = scene(); texture(s, 7, 4, 4); s.call("PUSH_ATTRIB", 0x40000).names(P.GLFN.DELETE_TEXTURES, [7]); send(s);
    const group = one.current.group, gpuGroup = gpu.current.shareGroup;
    const old = [...group.textureImages.values()].find(t => t.name === 7);
    const gpuOld = [...gpuGroup.textureImages.values()].find(t => t.name === 7);
    assert.ok(old && gpuOld);
    send(new GLStream().call("POP_ATTRIB"));
    assert.equal(one.boundImage(GL.TEXTURE_2D).texture, old); assert.equal(gpu.boundTexture(GL.TEXTURE_2D), gpuOld);
    send(new GLStream().call("BIND_TEXTURE", GL.TEXTURE_2D, 0));
    assert.equal(group.textureImages.has(old.id), false); assert.equal(gpuGroup.textureImages.has(gpuOld.imageId), false);
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
