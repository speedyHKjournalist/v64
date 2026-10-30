"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_textures.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const reference = require("./gl_conformance/framebuffer_queries_reference.json");
const F = GL.FRAMEBUFFER_EXT, A = GL.COLOR_ATTACHMENT0, T = GL.TEXTURE_2D, R = GL.RENDERBUFFER_EXT;
const image = (s, name, format, pixelFormat = GL.RGBA, type = GL.UNSIGNED_BYTE) => s.call("BIND_TEXTURE", T, name)
    .record(P.GLFN.TEX_IMAGE_2D, P.encodeRecord("TEX_IMAGE_2D", { target: T, internalformat: format, width: 4, height: 4, format: pixelFormat, type }));
const attach = (s, point, name) => s.call("FRAMEBUFFER_TEXTURE_2D", F, point, T, name, 0, 0);
function queries(s, expected) {
    const records = [];
    for (const entry of expected) {
        const old = s.queryInteger(entry.pname); records.push({ record: old, legacy: true, value: entry.value });
        for (const kind of [1, 2, 3, 4]) {
            const header = P.encodeRecord("QUERY_STATE", { pname: entry.pname, value_kind: kind, data_size: 8 });
            const payload = new Uint8Array(header.length + 8); payload.fill(0xA5); payload.set(header); s.record(P.GLFN.QUERY_STATE, payload);
            records.push({ record: s.payloadView(), legacy: false, value: kind === 4 ? +!!entry.value : entry.value });
        }
    }
    return records;
}
function check(records) {
    for (const { record, legacy, value } of records) {
        const name = legacy ? "QUERY_INTEGER" : "QUERY_STATE";
        assert.equal(record.view.getUint32(P.F[name].status, true), P.C.V86GL_SYNC_QUERY_STATUS_OK, "must finish on CPU");
        assert.equal(legacy ? record.view.getUint32(P.F[name].value, true) : record.view.getFloat64(P.RECORDS[name].size, true), value);
    }
}
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(); shadow.setCapabilities(caps.capabilities({}, {}));
        const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        for (const entry of reference.cases) {
            // Packed depth/stencil textures are not exposed by this profile.
            // Keep the packed renderbuffer attached for the later no-colour
            // cases, whose queried depth/stencil values are identical.
            if (entry.name === "packed_texture") continue;
            const stream = new GLStream();
            switch (entry.name) {
            case "window": stream.makeCurrent(1, 0, 0, 4, 4, 1, 1); break;
            case "rgba8": stream.call("BIND_FRAMEBUFFER", F, 1); attach(image(stream, 1, GL.RGBA8), A, 1); break;
            case "draw_none": stream.call("DRAW_BUFFER", GL.NONE); break;
            case "first_none": stream.names(P.GLFN.DRAW_BUFFERS, [GL.NONE, A]); break;
            case "rgb8": stream.call("DRAW_BUFFER", A); image(stream, 1, GL.RGB8); break;
            case "rgba4": image(stream, 1, GL.RGBA4); break;
            case "depth_renderbuffer16": image(stream, 1, GL.RGBA8); stream.call("BIND_RENDERBUFFER", R, 1)
                .call("RENDERBUFFER_STORAGE", R, GL.DEPTH_COMPONENT16, 4, 4).call("FRAMEBUFFER_RENDERBUFFER", F, GL.DEPTH_ATTACHMENT, R, 1); break;
            case "depth_texture24": attach(image(stream, 2, GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.FLOAT), GL.DEPTH_ATTACHMENT, 2); break;
            case "packed_renderbuffer": stream.call("RENDERBUFFER_STORAGE", R, GL.DEPTH24_STENCIL8, 4, 4)
                .call("FRAMEBUFFER_RENDERBUFFER", F, GL.DEPTH_ATTACHMENT, R, 1).call("FRAMEBUFFER_RENDERBUFFER", F, GL.STENCIL_ATTACHMENT, R, 1); break;
            case "no_color": attach(stream, A, 0).call("DRAW_BUFFER", GL.NONE).call("READ_BUFFER", GL.NONE); break;
            case "empty": attach(attach(stream, GL.DEPTH_ATTACHMENT, 0), GL.STENCIL_ATTACHMENT, 0); break;
            default: throw new Error(entry.name);
            }
            const expected = entry.queries.map(q => ({ ...q, value: entry.name === "window" && q.pname === GL.DEPTH_BITS ? 24 : q.value }));
            assert.ok(expected.every(q => q.error === 0)); const records = queries(stream, expected), bytes = stream.bytes();
            shadow.process(bytes); check(records); assert.equal(shadow.stats.rejected, 0, entry.name);
            const answered = bytes.slice(); gpu.submit(copied ? bytes.slice() : bytes, {}); await gpu.idle();
            assert.deepEqual(bytes, answered, "renderer must preserve every answered scalar");
        }
        const window = new GLStream().makeCurrent(2, 0, 0, 4, 4, 2, 2, 4 << P.C.V86GL_FORMAT_SAMPLES_SHIFT);
        const samples = queries(window, [{ pname: GL.SAMPLE_BUFFERS, value: 1 }, { pname: GL.SAMPLES, value: 4 }]);
        shadow.process(window.bytes()); check(samples);
        const separate = new GLStream().call("BIND_FRAMEBUFFER", F, 3);
        attach(image(separate, 4, GL.RGBA8), A, 4);
        image(separate, 5, GL.RGB8).call("BIND_FRAMEBUFFER", GL.READ_FRAMEBUFFER, 4)
            .call("FRAMEBUFFER_TEXTURE_2D", GL.READ_FRAMEBUFFER, A, T, 5, 0, 0);
        const drawBits = queries(separate, [{ pname: GL.ALPHA_BITS, value: 8 }]); shadow.process(separate.bytes()); check(drawBits);
        assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0);
    }
    console.log("PASS: 11 native FBO configurations, four scalar types, legacy integers and window samples on CPU in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
