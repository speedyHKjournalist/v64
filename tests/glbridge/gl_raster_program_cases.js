"use strict";
(function(global) {
    const { GLStream, GL } = global.GLTestStream || require("./gl_stream_builder.js"), P = global.GLProtocol || require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
    const vertex = "#version 120\nuniform float shift;void main(){gl_Position=gl_Vertex;gl_Position.x+=shift;gl_ClipVertex=gl_Vertex;gl_FrontColor=vec4(2,-1,0.5,1);gl_FrontSecondaryColor=gl_SecondaryColor*2.0;gl_FogFragCoord=gl_FogCoord+1.5;" +
        Array.from({ length: 7 }, (_, i) => "gl_TexCoord[" + i + "]=gl_MultiTexCoord0+vec4(" + i + ".0);").join("") + "gl_TexCoord[7]=gl_MultiTexCoord7;}",
        assembly = "!!ARBvp1.0\nMUL result.position,vertex.position,program.env[0];MOV result.color.front.primary,program.local[0];MUL result.color.front.secondary,vertex.color.secondary,2.0;ADD result.fogcoord,vertex.fogcoord,program.env[1];MOV result.texcoord[0],vertex.texcoord[0];" +
        Array.from({ length: 6 }, (_, i) => "ADD result.texcoord[" + (i + 1) + "],vertex.texcoord[0]," + (i + 1) + ".0;").join("") + "MOV result.texcoord[7],vertex.texcoord[7];END";
    function setup(kind) {
        const stream = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("VIEWPORT", 0, 0, 16, 16)
            .call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR4F", 0.25, 0.5, 0.75, 1)
            .call("SECONDARY_COLOR3F", 0.125, 0.25, 0.375).call("FOG_COORDF", 2)
            .call("MULTI_TEX_COORD4F", GL.TEXTURE0, 1, 2, 3, 4).call("MULTI_TEX_COORD4F", GL.TEXTURE0 + 7, 4, 3, 2, 1);
        let location = null;
        if (kind === "glsl") {
            stream.call("CREATE_PROGRAM", 100).call("CREATE_SHADER", 101, GL.VERTEX_SHADER).shaderSource(101, vertex).call("COMPILE_SHADER", 101)
                .call("ATTACH_SHADER", 100, 101).call("LINK_PROGRAM", 100).call("USE_PROGRAM", 100);
            location = stream.queryLocation(P.C.V86GL_LOCATION_KIND_UNIFORM, 100, "shift", 64);
        } else stream.call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 10).programStringARB(GL.VERTEX_PROGRAM_ARB, assembly)
            .programParameterARB(P.C.V86GL_PROGRAM_PARAMETER_ENV, GL.VERTEX_PROGRAM_ARB, 0, [2, 1, 1, 1])
            .programParameterARB(P.C.V86GL_PROGRAM_PARAMETER_ENV, GL.VERTEX_PROGRAM_ARB, 1, [1.5, 0, 0, 0])
            .programParameterARB(P.C.V86GL_PROGRAM_PARAMETER_LOCAL, GL.VERTEX_PROGRAM_ARB, 0, [2, -1, 0.5, 1]).call("ENABLE", GL.VERTEX_PROGRAM_ARB);
        return { stream, location };
    }
    function query(s, pname, n) {
        const bytes = new Uint8Array(24 + n * 8); bytes.set(P.encodeRecord("QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_FLOAT, data_size: n * 8 }));
        s.record(P.GLFN.QUERY_STATE, bytes); return s.payloadView();
    }
    function phase(name, location) {
        const stream = new GLStream().call("DISABLE", GL.CLIP_PLANE0).call("DEPTH_RANGE", 0, 1);
        if (location !== null) stream.uniformfv(location, 1, 1, [0.25]);
        if (name.includes("clip")) stream.call("CLIP_PLANE", GL.CLIP_PLANE0, 1, 0, 0, -0.5).call("ENABLE", GL.CLIP_PLANE0);
        if (name.endsWith("window_bypass")) stream.call("WINDOW_POS3F", 3, 4, 0.25);
        else if (name.endsWith("outside")) stream.call("RASTER_POS4F", name.startsWith("glsl") ? 0.9 : 0.75, 0, 0, 1);
        else if (name.endsWith("negative_w")) stream.call("RASTER_POS4F", 0, 0, 0, -1);
        else if (name.endsWith("reversed_depth")) stream.call("DEPTH_RANGE", 0.75, 0.25).call("RASTER_POS4F", 0.25, 0.5, 0.5, 1);
        else stream.call("RASTER_POS4F", 0.25, 0.5, 0, 1);
        const queries = Object.fromEntries([["valid", GL.CURRENT_RASTER_POSITION_VALID, 1], ["position", GL.CURRENT_RASTER_POSITION, 4], ["color", GL.CURRENT_RASTER_COLOR, 4],
            ["secondary", GL.CURRENT_RASTER_SECONDARY_COLOR, 4], ["distance", GL.CURRENT_RASTER_DISTANCE, 1]].map(([key, pname, n]) => [key, query(stream, pname, n)]));
        queries.coords = Array.from({ length: 8 }, (_, i) => { stream.call("ACTIVE_TEXTURE", GL.TEXTURE0 + i); return query(stream, GL.CURRENT_RASTER_TEXTURE_COORDS, 4); });
        stream.call("ACTIVE_TEXTURE", GL.TEXTURE0);
        return { stream, queries };
    }
    function expected(entry, reference) {
        const result = JSON.parse(JSON.stringify(entry));
        // GL 2.1 2.13 and ARB_vertex_program 2.12 take the shader's fog
        // output. Apple instead reports fixed eye-z, or stale distance.
        if (result.valid) result.distance = entry.name.endsWith("window_bypass") ? 0 : 3.5;
        // ARB_vertex_program 2.11 disables user clipping for non-invariant
        // programs. Apple incorrectly applies it to RasterPos in this case.
        if (entry.name === "arb_user_clip_disabled") return { ...expected(reference.find(c => c.name === "arb_valid"), reference), name: entry.name };
        return result;
    }
    function check(entry, reference, queries, assert) {
        const e = expected(entry, reference), values = q => Array.from({ length: q.view.getUint32(P.F.QUERY_STATE.count, true) }, (_, i) => q.view.getFloat64(24 + i * 8, true));
        for (const [key, q] of Object.entries(queries)) if (key !== "coords") {
            assert(q.view.getUint32(P.F.QUERY_STATE.status, true) === 1, entry.name + " " + key + " query completion");
            if (key === "valid" || e.valid) {
                const expectedValues = Array.isArray(e[key]) ? e[key] : [e[key]], actual = values(q);
                assert(actual.length === expectedValues.length && actual.every((n, i) => Math.abs(n - expectedValues[i]) < 0.000001), entry.name + " " + key + ": " + actual + " vs " + expectedValues);
            }
        }
        if (e.valid) queries.coords.forEach((q, unit) => assert(q.view.getUint32(P.F.QUERY_STATE.status, true) === 1 && values(q).every((n, i) => Math.abs(n - e.coords[unit][i]) < 0.000001), entry.name + " texture coordinate unit " + unit));
    }
    const api = { vertex, assembly, setup, query, phase, expected, check };
    global.GLRasterProgramCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
