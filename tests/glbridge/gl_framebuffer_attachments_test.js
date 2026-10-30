"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_textures.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const reference = require("./gl_conformance/framebuffer_attachments_reference.json");
const capabilities = caps.capabilities({}, {}), max3D = caps.integer(capabilities, GL.MAX_3D_TEXTURE_SIZE), maxColors = caps.integer(capabilities, GL.MAX_COLOR_ATTACHMENTS);
const F = GL.FRAMEBUFFER_EXT, A = GL.COLOR_ATTACHMENT0, T = GL.TEXTURE_2D, R = GL.RENDERBUFFER_EXT;
const texture = (s, dimension, target = F, attachment = A, textarget = T, object = 1, level = 0, slice = 0) =>
    s.call("FRAMEBUFFER_TEXTURE_" + dimension + "D", target, attachment, textarget, object, level, slice);
const rb = (s, target = R, object = 1) => s.call("FRAMEBUFFER_RENDERBUFFER", F, A, target, object);
const calls = {
    valid_2d: s => texture(s, 2), bad_target: s => texture(s, 2, 0), bad_attachment: s => texture(s, 2, F, 0),
    attachment_limit: s => texture(s, 2, F, A + maxColors), default_framebuffer: s => texture(s.call("BIND_FRAMEBUFFER", F, 0), 2),
    bad_textarget: s => texture(s, 2, F, A, 0), wrong_object_target: s => texture(s, 2, F, A, T, 2),
    missing_texture: s => texture(s, 2, F, A, T, 100), reserved_texture: s => texture(s, 2, F, A, T, 4),
    negative_level: s => texture(s, 2, F, A, T, 1, -1), large_level: s => texture(s, 2, F, A, T, 1, 99),
    undefined_level: s => texture(s, 2, F, A, T, 1, 1), wrong_2d_function: s => texture(s, 2, F, A, GL.TEXTURE_1D, 2),
    valid_1d: s => texture(s, 1, F, A, GL.TEXTURE_1D, 2), wrong_1d_function: s => texture(s, 1),
    valid_3d: s => texture(s, 3, F, A, GL.TEXTURE_3D, 3, 0, 1), undefined_slice: s => texture(s, 3, F, A, GL.TEXTURE_3D, 3, 0, max3D - 1),
    negative_slice: s => texture(s, 3, F, A, GL.TEXTURE_3D, 3, 0, -1), large_slice: s => texture(s, 3, F, A, GL.TEXTURE_3D, 3, 0, max3D),
    zero_texture_ignored_arguments: s => texture(s, 3, F, A, 0, 0, -1, -1), valid_renderbuffer: s => rb(s),
    bad_rb_target: s => rb(s, 0), missing_renderbuffer: s => rb(s, R, 100), reserved_renderbuffer: s => rb(s, R, 2),
    zero_rb_bad_target: s => rb(s, 0, 0), zero_renderbuffer: s => rb(s, R, 0),
};
function setup() {
    const stream = new GLStream().makeCurrent(1, 0, 0, 4, 4, 1, 1).names(P.GLFN.GEN_TEXTURES, [1, 2, 3, 4])
        .call("BIND_TEXTURE", T, 1).texImage2D(T, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(64))
        .call("BIND_TEXTURE", GL.TEXTURE_1D, 2);
    stream.record(P.GLFN.TEX_IMAGE_1D, P.encodeRecord("TEX_IMAGE_1D", { target: GL.TEXTURE_1D, internalformat: GL.RGBA8,
        width: 4, format: GL.RGBA, type: GL.UNSIGNED_BYTE }));
    stream.call("BIND_TEXTURE", GL.TEXTURE_3D, 3).record(P.GLFN.TEX_IMAGE_3D, P.encodeRecord("TEX_IMAGE_3D", { target: GL.TEXTURE_3D,
        internalformat: GL.RGBA8, width: 4, height: 4, depth: 2, format: GL.RGBA, type: GL.UNSIGNED_BYTE }))
        .names(P.GLFN.GEN_RENDERBUFFERS, [1, 2]).call("BIND_RENDERBUFFER", R, 1).call("RENDERBUFFER_STORAGE", R, GL.RGBA8, 4, 4)
        .call("BIND_FRAMEBUFFER", F, 1);
    return texture(stream, 2);
}
for (const expected of reference.cases) {
    const shadow = new GLShadow(); shadow.setCapabilities(capabilities); shadow.process(setup().bytes());
    assert.equal(shadow.stats.rejected, 0, "fixture setup");
    const stream = new GLStream(); calls[expected.name](stream); shadow.process(stream.bytes());
    assert.equal(shadow.current.error, expected.error, expected.name + " error");
    shadow.process(new GLStream().call("BIND_FRAMEBUFFER", F, 1).bytes());
    const attachment = shadow.current.framebuffers.get(1).color[0];
    assert.equal(attachment?.name || 0, expected.objectName, expected.name + " object");
    assert.equal(attachment ? attachment.kind === "texture" ? GL.TEXTURE : R : 0, expected.objectType, expected.name + " type");
    assert.equal(attachment?.level || 0, expected.level, expected.name + " level");
    assert.equal(shadow.framebufferStatus(F), expected.status, expected.name + " completeness");
}
const formatReference = require("./gl_conformance/framebuffer_formats_reference.json");
// Apple also exposes ARB_framebuffer_object, which lifts EXT's matching
// colour format restriction. This profile exposes EXT only. Both incomplete
// attachment and unsupported are valid diagnoses for a non-renderable image.
assert.equal(formatReference.arbFramebuffer, true);
for (const entry of formatReference.cases) {
    const shadow = new GLShadow(); shadow.setCapabilities(capabilities);
    const stream = new GLStream().makeCurrent(1, 0, 0, 4, 4, 1, 1).call("BIND_TEXTURE", T, 1);
    stream.record(P.GLFN.TEX_IMAGE_2D, P.encodeRecord("TEX_IMAGE_2D", { target: T, internalformat: entry.format, width: entry.width,
        height: entry.height, border: entry.border, format: GL.RGBA, type: GL.UNSIGNED_BYTE }));
    texture(stream.call("BIND_FRAMEBUFFER", F, 1), 2);
    if (entry.secondFormat) {
        stream.call("BIND_TEXTURE", T, 2).record(P.GLFN.TEX_IMAGE_2D, P.encodeRecord("TEX_IMAGE_2D", { target: T,
            internalformat: entry.secondFormat, width: 4, height: 4, format: GL.RGBA, type: GL.UNSIGNED_BYTE }));
        texture(stream, 2, F, A + 1, T, 2);
    }
    shadow.process(stream.bytes()); assert.equal(shadow.stats.rejected, 0, entry.name);
    const expected = ["luminance8", "alpha8", "intensity8", "luminance_alpha8"].includes(entry.name) ? GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT :
        entry.name.startsWith("different_") ? GL.FRAMEBUFFER_INCOMPLETE_FORMATS_EXT : entry.status;
    assert.equal(shadow.framebufferStatus(F), expected, entry.name);
    const rejected = expected !== GL.FRAMEBUFFER_COMPLETE, draw = new GLStream().call("CLEAR", GL.COLOR_BUFFER_BIT);
    const read = draw.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4); read.bytes.fill(0xA5, 32);
    shadow.process(draw.bytes());
    assert.equal(shadow.current.error, rejected ? GL.INVALID_FRAMEBUFFER_OPERATION : 0, entry.name + " drawing");
    assert.equal(read.view.getUint32(P.F.READ_PIXELS.status, true), rejected ? P.C.V86GL_SYNC_QUERY_STATUS_FAILED : P.C.V86GL_SYNC_QUERY_STATUS_PENDING);
    if (entry.status !== GL.FRAMEBUFFER_COMPLETE) {
        assert.equal(entry.clearError, GL.INVALID_FRAMEBUFFER_OPERATION); assert.equal(entry.readError, GL.INVALID_FRAMEBUFFER_OPERATION);
        assert.equal(entry.readPreserved, true);
    }
}
for (const [name, build] of [
    ["clear", stream => stream.call("CLEAR", GL.COLOR_BUFFER_BIT)],
    ["begin", stream => stream.call("BEGIN", GL.POINTS)],
    ["draw", stream => stream.call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 0)],
    ["blit", stream => stream.call("BLIT_FRAMEBUFFER", 0, 0, 1, 1, 0, 0, 1, 1, GL.COLOR_BUFFER_BIT, GL.NEAREST)],
]) {
    const shadow = new GLShadow(); shadow.setCapabilities(capabilities);
    const stream = new GLStream().makeCurrent(1, 0, 0, 4, 4, 1, 1).call("BIND_FRAMEBUFFER", F, 1); build(stream);
    shadow.process(stream.bytes()); assert.equal(shadow.current.error, GL.INVALID_FRAMEBUFFER_OPERATION, name);
    assert.equal(shadow.stats.rejected, 1, name); assert.equal(!!shadow.current.state.begin, false);
}
{
    const shadow = new GLShadow(); shadow.setCapabilities(capabilities);
    const stream = setup().call("BIND_TEXTURE", T, 5), header = P.encodeRecord("COMPRESSED_TEX_IMAGE_2D", { target: T,
        internalformat: GL.COMPRESSED_RGB_S3TC_DXT1_EXT, width: 4, height: 4, image_size: 8 });
    const payload = new Uint8Array(header.length + 8); payload.set(header); stream.record(P.GLFN.COMPRESSED_TEX_IMAGE_2D, payload);
    texture(stream, 2, F, A, T, 5); shadow.process(stream.bytes()); assert.equal(shadow.stats.rejected, 0);
    assert.equal(shadow.framebufferStatus(F), GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT, "decoded BC storage does not make compressed images colour-renderable");
}
{
    const shadow = new GLShadow(); shadow.setCapabilities(capabilities);
    const stream = setup().call("BIND_TEXTURE", T, 6).record(P.GLFN.TEX_IMAGE_2D, P.encodeRecord("TEX_IMAGE_2D", { target: T,
        internalformat: GL.RGBA, width: 4, height: 4, format: GL.RGBA, type: GL.UNSIGNED_BYTE }));
    texture(stream, 2, F, A + 1, T, 6); shadow.process(stream.bytes());
    assert.equal(shadow.framebufferStatus(F), GL.FRAMEBUFFER_COMPLETE, "unsized RGBA and RGBA8 have the same effective format");
}
for (const read of [true, false]) {
    const shadow = new GLShadow(); shadow.setCapabilities(capabilities);
    const stream = new GLStream().makeCurrent(1, 0, 0, 4, 4, 1, 1).call("BIND_FRAMEBUFFER", read ? GL.READ_FRAMEBUFFER : GL.DRAW_FRAMEBUFFER, 1)
        .call("CLEAR", GL.COLOR_BUFFER_BIT);
    const result = stream.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4); result.bytes.fill(0xA5, 32);
    shadow.process(stream.bytes()); assert.equal(shadow.stats.rejected, 1, "read and draw completeness are independent");
    assert.equal(result.view.getUint32(P.F.READ_PIXELS.status, true), read ? P.C.V86GL_SYNC_QUERY_STATUS_FAILED : P.C.V86GL_SYNC_QUERY_STATUS_PENDING);
    assert.ok(result.bytes.subarray(32).every(v => v === 0xA5), "failed readback preserves output");
}
console.log("PASS: " + (reference.cases.length + formatReference.cases.length) + " native FBO cases, EXT format rules and CPU draw/read rejection");
