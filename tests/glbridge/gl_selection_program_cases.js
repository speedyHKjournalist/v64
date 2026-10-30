"use strict";
(function(global) {
    const { GLStream, GL } = global.GLTestStream || require("./gl_stream_builder.js"),
        P = global.GLProtocol || require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),
        vertex = global.GLVertexCaptureCases || require("./gl_vertex_capture_cases.js");
    const query = (stream, fields, capacity = 0) => {
        const payload = new Uint8Array(44 + capacity); payload.set(P.encodeRecord("QUERY_RENDER_MODE", fields));
        stream.record(P.GLFN.QUERY_RENDER_MODE, payload); return stream.payloadView();
    };
    function setup(fragment = false, kind = "glsl") {
        if (kind === "arb") {
            const stream = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 10)
                .programStringARB(GL.VERTEX_PROGRAM_ARB, "!!ARBvp1.0\nMUL result.position,vertex.position,program.env[0];MOV result.color.front.primary,program.local[0];MOV result.color.back.primary,vertex.color;ADD result.texcoord[0],vertex.texcoord[0],vertex.texcoord[1];END")
                .programParameterARB(P.C.V86GL_PROGRAM_PARAMETER_ENV, GL.VERTEX_PROGRAM_ARB, 0, [2, 1, 1, 1])
                .programParameterARB(P.C.V86GL_PROGRAM_PARAMETER_LOCAL, GL.VERTEX_PROGRAM_ARB, 0, [2, -1, 0.5, 1])
                .call("COLOR4F", 0.25, 0.5, 0.75, 1).call("ENABLE", GL.VERTEX_PROGRAM_ARB);
            return { stream, location: null };
        }
        const stream = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("CREATE_PROGRAM", 100)
            .call("CREATE_SHADER", 101, GL.VERTEX_SHADER).shaderSource(101, vertex.source).call("COMPILE_SHADER", 101).call("ATTACH_SHADER", 100, 101);
        if (fragment) stream.call("CREATE_SHADER", 102, GL.FRAGMENT_SHADER).shaderSource(102, "#version 120\nvoid main(){gl_FragColor=vec4(1);}").call("COMPILE_SHADER", 102).call("ATTACH_SHADER", 100, 102);
        stream.call("LINK_PROGRAM", 100).call("USE_PROGRAM", 100);
        if (kind === "both") stream.call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 10)
            .programStringARB(GL.VERTEX_PROGRAM_ARB, "!!ARBvp1.0\nMUL result.position,vertex.position,program.env[0];END")
            .programParameterARB(P.C.V86GL_PROGRAM_PARAMETER_ENV, GL.VERTEX_PROGRAM_ARB, 0, [2, 1, 1, 1]).call("ENABLE", GL.VERTEX_PROGRAM_ARB);
        const location = stream.queryLocation(P.C.V86GL_LOCATION_KIND_UNIFORM, 100, "scale", 64);
        return { stream, location };
    }
    function draw(name, location) {
        const feedback = !name.endsWith("select"), triangle = name.endsWith("_back"), stream = new GLStream();
        if (location !== null) stream.uniformfv(location, 1, 1, [name === "glsl_over_arb_select" ? 0.5 : 2]);
        query(stream, feedback ? { operation: 1, size: 64, type: GL["4D_COLOR_TEXTURE"], pointer: 0x2000 } : { operation: 0, size: 64, pointer: 0x1000 });
        query(stream, { operation: 2, type: feedback ? GL.FEEDBACK : GL.SELECT });
        stream.record(P.GLFN.NAME_COMMAND, P.encodeRecord("NAME_COMMAND", { operation: 0 }));
        stream.record(P.GLFN.NAME_COMMAND, P.encodeRecord("NAME_COMMAND", { operation: 2, name: 7 }));
        stream.call("MULTI_TEX_COORD4F", GL.TEXTURE0, 1, 2, 3, 4).call("MULTI_TEX_COORD4F", GL.TEXTURE0 + 1, 4, 3, 2, 1);
        if (triangle) stream.call("ENABLE", GL.VERTEX_PROGRAM_TWO_SIDE);
        stream.call("BEGIN", triangle ? GL.TRIANGLES : GL.POINTS);
        if (triangle) stream.call("VERTEX3F", -0.25, -0.5, 0).call("VERTEX3F", 0, 0.5, 0).call("VERTEX3F", 0.25, -0.5, 0);
        else stream.call("VERTEX3F", feedback ? 0.25 : 0.75, 0, 0);
        stream.call("END");
        const response = query(stream, { operation: 2, type: GL.RENDER });
        return { stream, response };
    }
    function read(response) {
        const r = P.decodeRecord("QUERY_RENDER_MODE", response.view, 0), stream = new GLStream();
        return { stream, response: r.total ? query(stream, { operation: 3, ticket: r.ticket, size: r.size, offset: 0, data_size: r.total }, r.total) : null };
    }
    const api = { query, setup, draw, read };
    global.GLSelectionProgramCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
