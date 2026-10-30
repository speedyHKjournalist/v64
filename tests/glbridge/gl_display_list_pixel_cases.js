"use strict";
(function(global) {
    const P = global.GLProtocol || require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
    const { GLStream, GL } = global.GLTestStream || require("./gl_stream_builder.js");
    const arrays = global.GLDisplayListArrayCases || require("./gl_display_list_array_cases.js");
    const unpackNames = ["ALIGNMENT", "ROW_LENGTH", "SKIP_ROWS", "SKIP_PIXELS", "LSB_FIRST", "IMAGE_HEIGHT", "SKIP_IMAGES", "SWAP_BYTES"].map(name => GL["UNPACK_" + name]);
    const unpack = (s, values) => unpackNames.forEach((p, i) => s.call("PIXEL_STOREI", p, values[i]));
    function payload(s, name, fields, data) {
        const header = P.encodeRecord(name, fields), out = new Uint8Array(header.length + data.length); out.set(header); out.set(data, header.length);
        s.record(P.GLFN[name], out); return s.payloadView();
    }
    function build(reference, context = 1200) {
        const native = Object.fromEntries(reference.map(c => [c.name, c])), s = new GLStream().makeCurrent(context, 0, 0, 16, 16, context, context), reads = [], queries = [], states = [];
        const checkpoint = name => {
            const checks = unpackNames.map(pname => payload(s, "QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 }, new Uint8Array(8)));
            states.push({ name, checks, expected: native[name].unpack });
        };
        const read = (name, width, height) => { reads.push({ name, read: s.readPixels(0, 0, width, height, GL.RGBA, GL.UNSIGNED_BYTE, width * height * 4), expected: native[name].bytes }); checkpoint(name); };
        const stipple = name => {
            queries.push({ name, read: payload(s, "QUERY_POLYGON_STIPPLE", { mode: 0, data_size: 320 }, new Uint8Array(320)), expected: native[name].bytes });
            s.record(P.GLFN.QUERY_ERROR, P.encodeRecord("QUERY_ERROR", {}));
            queries.at(-1).error = s.payloadView(); queries.at(-1).expectedError = native[name].error; checkpoint(name);
        };
        s.call("VIEWPORT", 0, 0, 16, 16).call("PIXEL_STOREI", GL.PACK_ALIGNMENT, 1).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);
        let source = new Uint8Array(512); source.set([0xA8, 0x0A], 4); source.set([0x50, 0x05], 8);
        unpack(s, [4, 16, 1, 3, 1]); arrays.list(s, 1, 10, GL.COMPILE); s.bitmap(9, 2, 0, 0, 3, 2, source.subarray(0, 10)); arrays.list(s, 2);
        source.fill(0); unpack(s, [1, 32, 0, 0, 0]); s.call("COLOR4F", 1, 0, 0, 1).call("WINDOW_POS3F", 0, 0, 0); arrays.list(s, 3, 10); read("bitmap", 9, 2);
        const rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]; source.set(rgb.slice(0, 6), 19); source.set(rgb.slice(6), 35);
        unpack(s, [8, 3, 1, 1, 0]); arrays.list(s, 1, 20, GL.COMPILE); s.drawPixels(2, 2, GL.RGB, GL.UNSIGNED_BYTE, source.subarray(0, 41)); arrays.list(s, 2);
        source.fill(0); unpack(s, [1, 0, 0, 0, 1]); s.call("WINDOW_POS3F", 0, 0, 0); arrays.list(s, 3, 20); read("draw_pixels", 2, 2);
        const rgba = [32, 64, 96, 128, 160, 192, 224, 255, 10, 20, 30, 40, 200, 150, 100, 50]; source.set(rgba.slice(0, 8), 20); source.set(rgba.slice(8), 36);
        s.call("BIND_TEXTURE", GL.TEXTURE_2D, 1); unpack(s, [8, 3, 1, 1, 0]); arrays.list(s, 1, 30, GL.COMPILE);
        payload(s, "TEX_IMAGE_2D", { target: GL.TEXTURE_2D, internalformat: GL.RGBA8, width: 2, height: 2, format: GL.RGBA, type: GL.UNSIGNED_BYTE, data_size: 44 }, source.subarray(0, 44)); arrays.list(s, 2);
        source.fill(0); unpack(s, [1, 0, 0, 0, 1]); s.call("BIND_TEXTURE", GL.TEXTURE_2D, 2); arrays.list(s, 3, 30);
        s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 1).call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 2, 0, 0); read("texture", 2, 2);
        s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 0);
        source = Uint8Array.from({ length: 512 }, (_, i) => (i * 73) ^ 0xA6); const compact = new Uint8Array(160);
        for (let row = 0; row < 32; ++row) compact.set(source.subarray(8 + row * 8, 13 + row * 8), row * 5);
        unpack(s, [8, 40, 1, 5, 1]); arrays.list(s, 1, 40, GL.COMPILE); payload(s, "POLYGON_STIPPLE_BITMAP", { data_size: 160 }, compact); arrays.list(s, 2);
        unpack(s, [1, 0, 0, 0, 0]); arrays.list(s, 3, 40); stipple("stipple");
        const pbo = Uint8Array.from({ length: 128 }, (_, i) => i * 17);
        s.call("BIND_BUFFER", GL.PIXEL_UNPACK_BUFFER, 1).bufferData(GL.PIXEL_UNPACK_BUFFER, 128, GL.STATIC_DRAW, pbo);
        arrays.list(s, 1, 50, GL.COMPILE); payload(s, "QUERY_POLYGON_STIPPLE", { mode: 2, data_size: 320 }, new Uint8Array(320));
        s.record(P.GLFN.POLYGON_STIPPLE, pbo); stipple("pbo_compiling"); arrays.list(s, 2); s.names(P.GLFN.DELETE_BUFFERS, [1]); arrays.list(s, 3, 50); stipple("pbo_called");
        source.fill(0); source.set(rgb.slice(0, 6), 19); unpack(s, [8, 3, 1, 1, 0]); arrays.list(s, 1, 31, GL.COMPILE);
        s.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 2, 1, GL.RGB, GL.UNSIGNED_BYTE, source.subarray(0, 25)); arrays.list(s, 2); unpack(s, [1, 0, 0, 0, 0]); arrays.list(s, 3, 31);
        s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 1).call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 2, 0, 0); read("sub_texture", 2, 2);
        s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 0).call("PIXEL_STOREI", GL.UNPACK_SWAP_BYTES, 1).call("BIND_TEXTURE", GL.TEXTURE_2D, 4); arrays.list(s, 1, 60, GL.COMPILE);
        payload(s, "TEX_IMAGE_2D", { target: GL.TEXTURE_2D, internalformat: GL.RGBA8, width: 1, height: 1, format: GL.RGBA, type: GL.UNSIGNED_SHORT, data_size: 8 },
            new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0])); arrays.list(s, 2); s.call("PIXEL_STOREI", GL.UNPACK_SWAP_BYTES, 0); arrays.list(s, 3, 60);
        s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 1).call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 4, 0, 0); read("swap_texture", 1, 1);
        s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 0); source.fill(0);
        for (let z = 0; z < 2; ++z) for (let y = 0; y < 2; ++y) for (let x = 0; x < 6; ++x) source[67 + z * 48 + y * 16 + x] = (z * 12 + y * 6 + x) * 7;
        unpack(s, [8, 3, 1, 1, 0, 3, 1, 0]); s.call("BIND_TEXTURE", GL.TEXTURE_3D, 3); arrays.list(s, 1, 70, GL.COMPILE);
        payload(s, "TEX_IMAGE_3D", { target: GL.TEXTURE_3D, internalformat: GL.RGB8, width: 2, height: 2, depth: 2, format: GL.RGB, type: GL.UNSIGNED_BYTE, data_size: 137 }, source.subarray(0, 137)); arrays.list(s, 2);
        unpack(s, [1, 0, 0, 0, 0]); arrays.list(s, 3, 70); s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 1);
        for (let z = 0; z < 2; ++z) {
            s.call("FRAMEBUFFER_TEXTURE_3D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_3D, 3, 0, z);
            reads.push({ name: "texture_3d plane " + z, read: s.readPixels(0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, 16), expected: native.texture_3d.bytes.slice(z * 16, z * 16 + 16) });
        }
        checkpoint("texture_3d");
        for (const mapped of [false, true]) {
            s.call("BIND_BUFFER", GL.PIXEL_UNPACK_BUFFER, 5).bufferData(GL.PIXEL_UNPACK_BUFFER, mapped ? 128 : 127, GL.STATIC_DRAW, new Uint8Array(mapped ? 128 : 127));
            if (mapped) payload(s, "QUERY_BUFFER_MAP", { target: GL.PIXEL_UNPACK_BUFFER, access: GL.READ_ONLY_ARB, pointer: 0x1000 }, new Uint8Array());
            arrays.list(s, 1, mapped ? 81 : 80, GL.COMPILE); payload(s, "QUERY_POLYGON_STIPPLE", { mode: 2, data_size: 320 }, new Uint8Array(320));
            stipple(mapped ? "mapped_compiling" : "short_compiling"); arrays.list(s, 2);
            if (mapped) payload(s, "QUERY_BUFFER_UNMAP", { target: GL.PIXEL_UNPACK_BUFFER }, new Uint8Array());
            s.call("BIND_BUFFER", GL.PIXEL_UNPACK_BUFFER, 0); arrays.list(s, 3, mapped ? 81 : 80); stipple(mapped ? "mapped_called" : "short_called");
        }
        return { stream: s, reads, queries, states };
    }
    const api = { build, unpackNames, payload, unpack };
    global.GLDisplayListPixelCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
