"use strict";
(function(global) {
    const P = global.GLProtocol || require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
    const { GLStream, GL } = global.GLTestStream || require("./gl_stream_builder.js");
    function query(s, fields, capacity = 0) {
        const header = P.encodeRecord("QUERY_RENDER_MODE", fields), payload = new Uint8Array(header.length + capacity); payload.set(header);
        s.record(P.GLFN.QUERY_RENDER_MODE, payload); return s.payloadView();
    }
    const names = (s, operation, name = 0, value = 0) => s.record(P.GLFN.NAME_COMMAND, P.encodeRecord("NAME_COMMAND", { operation, name, value }));
    const list = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
    function selection() {
        const s = new GLStream().makeCurrent(1300, 0, 0, 32, 32, 1300, 1300).call("VIEWPORT", 0, 0, 32, 32)
            .call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);
        list(s, 1, 99, GL.COMPILE); s.call("COLOR4F", 1, 0, 0, 1).call("BEGIN", GL.QUADS).call("VERTEX3F", -1, -1, 0)
            .call("VERTEX3F", 1, -1, 0).call("VERTEX3F", 1, 1, 0).call("VERTEX3F", -1, 1, 0).call("END"); list(s, 2);
        query(s, { operation: 0, size: 128, pointer: 0x1000 }); query(s, { operation: 2, type: GL.SELECT }); names(s, 2, 7); list(s, 3, 99); names(s, 1, 8);
        s.call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 1).call("RASTER_POS4F", 0, 0, 0, 1).call("BIND_FRAMEBUFFER_EXT", GL.FRAMEBUFFER_EXT, 0);
        const result = query(s, { operation: 2, type: GL.RENDER }), pixel = s.readPixels(16, 16, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);
        return { stream: s, result, pixel, expectedResult: 2, expected: [1, 0x80000000, 0x80000000, 7, 1, 0x80000000, 0x80000000, 8] };
    }
    function feedback() {
        const s = new GLStream(); query(s, { operation: 1, size: 32, type: GL["2D"], pointer: 0x2000 }); query(s, { operation: 2, type: GL.FEEDBACK });
        s.call("WINDOW_POS3F", 1, 2, 0.5).bitmap(0, 0, 0, 0, 3, 4); names(s, 4, 0, 3.25);
        const result = query(s, { operation: 2, type: GL.RENDER });
        s.call("PIXEL_STOREI", GL.UNPACK_ALIGNMENT, 1).bitmap(1, 1, 0, 0, 0, 0, new Uint8Array([0x80]));
        const pixel = s.readPixels(4, 6, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4);
        return { stream: s, result, pixel, expectedResult: 5, expected: [GL.BITMAP_TOKEN, 1, 2, GL.PASS_THROUGH_TOKEN, 3.25] };
    }
    function read(result) {
        const r = P.decodeRecord("QUERY_RENDER_MODE", result.view, 0), s = new GLStream(), response = query(s,
            { operation: 3, ticket: r.ticket, size: r.size, offset: 0, data_size: r.total }, r.total);
        return { stream: s, response };
    }
    const api = { selection, feedback, read, query };
    global.GLSelectionCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
