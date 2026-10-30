"use strict";
(function(global) {
    const P = global.GLProtocol || require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
    const { GL, GLStream } = global.GLTestStream || require("./gl_stream_builder.js");
    const rgba = [32, 64, 96, 128, 160, 192, 224, 255, 10, 20, 30, 40, 200, 150, 100, 50];
    function image(s, target, internalformat, format, type, data, width = 2, height = 2, depth = 1, level = 0) {
        const dimensions = target === GL.TEXTURE_3D ? 3 : 2;
        const name = "TEX_IMAGE_" + dimensions + "D", header = P.encodeRecord(name,
            { target, level, internalformat, width, height, depth, format, type, data_size: data.byteLength });
        const payload = new Uint8Array(header.length + data.byteLength); payload.set(header); payload.set(data, header.length);
        return s.record(P.GLFN[name], payload);
    }
    function setup(entry, context) {
        const s = new GLStream().makeCurrent(context, 0, 0, 64, 64, context, context);
        s.call("PIXEL_STOREI", GL.UNPACK_ALIGNMENT, 1).call("PIXEL_STOREI", GL.PACK_ALIGNMENT, 1);
        const name = entry.name;
        s.call("BIND_TEXTURE", GL.TEXTURE_2D, 1);
        image(s, GL.TEXTURE_2D, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, Uint8Array.from(rgba));
        if (name === "subimage") {
            const header = P.encodeRecord("TEX_SUB_IMAGE_2D", { target: GL.TEXTURE_2D, xoffset: 1, width: 1, height: 1,
                format: GL.RGBA, type: GL.UNSIGNED_BYTE, data_size: 4 });
            const payload = new Uint8Array(header.length + 4); payload.set(header); payload.set([255, 0, 0, 255], header.length);
            s.record(P.GLFN.TEX_SUB_IMAGE_2D, payload);
        }
        if (name.startsWith("depth_")) {
            s.call("BIND_TEXTURE", GL.TEXTURE_2D, 2);
            image(s, GL.TEXTURE_2D, GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.FLOAT,
                new Uint8Array(new Float32Array([0.25, 0.5, 0.75, 1]).buffer));
            if (name === "depth_rendered") s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 2)
                .call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, 2, 0, 0)
                .call("DRAW_BUFFER", GL.NONE).call("READ_BUFFER", GL.NONE).call("CLEAR_DEPTH", 0.625)
                .call("CLEAR", GL.DEPTH_BUFFER_BIT).call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 0);
        }
        if (name === "nonzero_level") {
            s.call("BIND_TEXTURE", GL.TEXTURE_2D, 6);
            image(s, GL.TEXTURE_2D, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, Uint8Array.from(rgba), 2, 2, 1, 2);
        }
        if (name.startsWith("cube_")) {
            s.call("BIND_TEXTURE", GL.TEXTURE_CUBE_MAP, 3);
            image(s, GL.TEXTURE_CUBE_MAP_POSITIVE_X, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, Uint8Array.from(rgba));
        }
        if (name === "pack_volume") {
            s.call("BIND_TEXTURE", GL.TEXTURE_3D, 4);
            image(s, GL.TEXTURE_3D, GL.RGB8, GL.RGB, GL.UNSIGNED_BYTE, Uint8Array.from({ length: 24 }, (_, i) => i * 7), 2, 2, 2);
            for (const [pname, value] of [[GL.PACK_ALIGNMENT, 4], [GL.PACK_ROW_LENGTH, 3], [GL.PACK_IMAGE_HEIGHT, 3],
                [GL.PACK_SKIP_IMAGES, 1], [GL.PACK_SKIP_ROWS, 1], [GL.PACK_SKIP_PIXELS, 1]]) s.call("PIXEL_STOREI", pname, value);
        }
        if (name === "pack_rows") for (const [pname, value] of [[GL.PACK_ALIGNMENT, 4], [GL.PACK_ROW_LENGTH, 4],
            [GL.PACK_SKIP_PIXELS, 1], [GL.PACK_SKIP_ROWS, 1]]) s.call("PIXEL_STOREI", pname, value);
        if (name.startsWith("swapped_")) s.call("PIXEL_STOREI", GL.PACK_SWAP_BYTES, 1);
        if (name === "pack_overlap") s.call("PIXEL_STOREI", GL.PACK_ROW_LENGTH, 1);
        if (name === "ignores_transfer") s.call("PIXEL_TRANSFERF", GL.RED_SCALE, 2);
        if (name.startsWith("compressed_")) {
            s.call("BIND_TEXTURE", GL.TEXTURE_2D, 5);
            const header = P.encodeRecord("COMPRESSED_TEX_IMAGE_2D", { target: GL.TEXTURE_2D,
                internalformat: GL.COMPRESSED_RGB_S3TC_DXT1_EXT, width: 4, height: 4, image_size: 8 });
            const payload = new Uint8Array(header.length + 8); payload.set(header); payload.set([255, 255, 0, 0, 0, 0, 0, 0], header.length);
            s.record(P.GLFN.COMPRESSED_TEX_IMAGE_2D, payload);
            if (name.startsWith("compressed_sub_")) {
                const header = P.encodeRecord("COMPRESSED_TEX_SUB_IMAGE_2D", { target: GL.TEXTURE_2D,
                    format: GL.COMPRESSED_RGB_S3TC_DXT1_EXT, width: 4, height: 4, image_size: 8 });
                const payload = new Uint8Array(header.length + 8); payload.set(header); payload.set([0, 248, 0, 0, 0, 0, 0, 0], header.length);
                s.record(P.GLFN.COMPRESSED_TEX_SUB_IMAGE_2D, payload);
            }
        }
        if (name === "rendered_unbound_fbo" || entry.pboSize) {
            s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 1)
                .call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 1, 0, 0)
                .call("CLEAR_COLOR", 0.25, 0.5, 0.75, 1).call("CLEAR", GL.COLOR_BUFFER_BIT)
                .call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 0);
        }
        if (entry.pboSize) {
            s.call("BIND_BUFFER", GL.PIXEL_PACK_BUFFER, 1);
            const header = P.encodeRecord("BUFFER_DATA", { target: GL.PIXEL_PACK_BUFFER, size: entry.pboSize,
                usage: 0x88E1, data_size: entry.pboSize });
            const payload = new Uint8Array(header.length + entry.pboSize); payload.fill(0xA5); payload.set(header);
            s.record(P.GLFN.BUFFER_DATA, payload);
            if (entry.mapped) s.record(P.GLFN.QUERY_BUFFER_MAP, P.encodeRecord("QUERY_BUFFER_MAP",
                { target: GL.PIXEL_PACK_BUFFER, access: GL.WRITE_ONLY_ARB, pointer: 0x1000 }));
        }
        return s;
    }
    function query(s, values, data) {
        const header = P.encodeRecord("QUERY_TEXTURE_IMAGE", values), payload = new Uint8Array(header.length + (data?.length || 0));
        payload.set(header); if (data) payload.set(data, header.length);
        s.record(P.GLFN.QUERY_TEXTURE_IMAGE, payload); return s.payloadView();
    }
    const api = { setup, query, image };
    global.GLTextureReadbackCases = api;
    if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
