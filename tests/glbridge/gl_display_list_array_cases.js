"use strict";
(function(global) {
    const P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const { GLStream, GL } = global.GLTestStream || require("./gl_stream_builder.js");
    const list = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
    function vertices(entries) {
        const out = new Uint8Array(1001 * 16), view = new DataView(out.buffer);
        for (const [index, xyz, color] of entries) {
            xyz.forEach((n, i) => view.setFloat32(index * 16 + i * 4, n, true)); out.set(color, index * 16 + 12);
        }
        return out;
    }
    function build(context = 1100) {
        const green = [0, 255, 0, 255], blue = [0, 0, 255, 255];
        const s = new GLStream().makeCurrent(context, 0, 0, 8, 8, context, context), reads = [];
        s.call("VIEWPORT", 0, 0, 8, 8).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT)
            .call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bufferData(GL.ARRAY_BUFFER, 1001 * 16, GL.STATIC_DRAW,
                vertices([[1, [-1, -1, 0], green], [2, [1, -1, 0], green], [3, [0, 1, 0], green]]))
            .pointerVBO("VERTEX_POINTER_VBO", 3, GL.FLOAT, 16, 0).pointerVBO("COLOR_POINTER_VBO", 4, GL.UNSIGNED_BYTE, 16, 12)
            .call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY).call("ENABLE_CLIENT_STATE", GL.COLOR_ARRAY);
        list(s, 1, 100, GL.COMPILE); s.call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 1, 3); list(s, 2);
        s.bufferData(GL.ARRAY_BUFFER, 1001 * 16, GL.STATIC_DRAW, new Uint8Array(1001 * 16))
            .call("DISABLE_CLIENT_STATE", GL.VERTEX_ARRAY).call("DISABLE_CLIENT_STATE", GL.COLOR_ARRAY); list(s, 3, 100);
        reads.push({ name: "arrays_frozen", read: s.readPixels(4, 3, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4), pixel: green });
        s.bufferData(GL.ARRAY_BUFFER, 1001 * 16, GL.STATIC_DRAW,
            vertices([[0, [-1, -1, 0], blue], [5, [1, -1, 0], blue], [1000, [0, 1, 0], blue]]))
            .call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY).call("ENABLE_CLIENT_STATE", GL.COLOR_ARRAY)
            .call("BIND_BUFFER", GL.ELEMENT_ARRAY_BUFFER, 2).bufferData(GL.ELEMENT_ARRAY_BUFFER, 12, GL.STATIC_DRAW,
                new Uint8Array(new Uint32Array([1000, 0, 5]).buffer));
        list(s, 1, 101, GL.COMPILE); s.drawElementsDirect(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0, 0, 1000); list(s, 2);
        list(s, 1, 102, GL.COMPILE); s.record(P.GLFN.DRAW_RANGE_ELEMENTS_DIRECT, P.encodeRecord("DRAW_RANGE_ELEMENTS_DIRECT",
            { mode: GL.TRIANGLES, count: 3, type: GL.UNSIGNED_INT, offset: 0, start: 0, end: 1000 })); list(s, 2);
        s.bufferData(GL.ELEMENT_ARRAY_BUFFER, 12, GL.STATIC_DRAW, new Uint8Array(12)).names(P.GLFN.DELETE_BUFFERS, [1, 2]);
        for (const [name, id] of [["elements_frozen", 101], ["range_frozen", 102]]) {
            s.call("CLEAR", GL.COLOR_BUFFER_BIT); list(s, 3, id);
            reads.push({ name, read: s.readPixels(4, 3, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, 4), pixel: blue });
        }
        return { stream: s, reads };
    }
    const api = { build, list, vertices };
    global.GLDisplayListArrayCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
