"use strict";
(function(global) {
    const { GL } = global.GLTestStream || require("./gl_stream_builder.js");
    const vertex = "#version 120\nvoid main(){gl_Position=gl_Vertex;gl_FrontColor=vec4(0.25,0.5,0.75,1.0);gl_BackColor=vec4(0.75,0.25,0.5,1.0);gl_FrontSecondaryColor=vec4(0.0,0.5,0.0,1.0);gl_BackSecondaryColor=vec4(0.5,0.0,0.0,1.0);gl_FogFragCoord=0.25;gl_TexCoord[0]=vec4(1.5,1.5,0.0,2.0);}";
    const cases = [
        { name: "vs_color", stage: "vertex", source: vertex },
        { name: "vs_texture", stage: "vertex", source: vertex },
        { name: "vs_fog", stage: "vertex", source: vertex },
        { name: "vs_secondary", stage: "vertex", source: vertex },
        { name: "vs_back", stage: "vertex", source: vertex, reverse: true },
        { name: "fs_color", stage: "fragment", source: "#version 120\nvoid main(){gl_FragColor=gl_Color;}" },
        { name: "fs_texgen", stage: "fragment", source: "#version 120\nvoid main(){gl_FragColor=vec4(gl_TexCoord[3].xyz,1.0);}" },
        { name: "fs_lighting", stage: "fragment", source: "#version 120\nvoid main(){gl_FragColor=gl_Color;}" },
        { name: "fs_fog", stage: "fragment", source: "#version 120\nvoid main(){gl_FragColor=vec4(vec3(gl_FogFragCoord),1.0);}" },
        { name: "fs_secondary", stage: "fragment", source: "#version 120\nvoid main(){gl_FragColor=gl_SecondaryColor;}" },
        { name: "vs_sampler", stage: "vertex", source: "#version 120\nuniform sampler2D probe;void main(){gl_Position=gl_Vertex;gl_FrontColor=texture2D(probe,vec2(0.75));gl_TexCoord[0]=vec4(1.5,1.5,0.0,2.0);}", sampler: true },
        { name: "vs_back_twoside", stage: "vertex", source: vertex, reverse: true },
        { name: "fs_back", stage: "fragment", source: "#version 120\nvoid main(){gl_FragColor=gl_Color;}", reverse: true },
        { name: "vs_sampler_lod", stage: "vertex", source: "#version 120\nuniform sampler2D probe;void main(){gl_Position=gl_Vertex;gl_FrontColor=texture2DLod(probe,vec2(0.75),0.0);gl_TexCoord[0]=vec4(1.5,1.5,0.0,2.0);}", sampler: true },
    ];
    const vector = (s, call, args, values) => s.call(call, ...args, values.length, ...values, ...Array(4 - values.length).fill(0));
    cases.program = (s, entry, name) => s.call("CREATE_PROGRAM", name)
        .call("CREATE_SHADER", name + 1, entry.stage === "vertex" ? GL.VERTEX_SHADER : GL.FRAGMENT_SHADER)
        .shaderSource(name + 1, entry.source).call("COMPILE_SHADER", name + 1).call("ATTACH_SHADER", name, name + 1)
        .call("LINK_PROGRAM", name).call("USE_PROGRAM", name);
    cases.setup = (s, entry) => {
        s.call("COLOR4F", 0.25, 0.5, 0.75, 1).call("NORMAL3F", 0, 0, 1).call("FOG_COORDF", 0.375)
            .call("SECONDARY_COLOR3F", 0.2, 0.4, 0.6).call("MULTI_TEX_COORD4F", GL.TEXTURE0 + 3, 0.1, 0.2, 0.3, 1);
        if (entry.name === "vs_color") s.call("ENABLE", GL.LIGHTING);
        if (entry.name === "vs_texture" || entry.sampler) {
            s.call("ENABLE", GL.TEXTURE_2D).call("BIND_TEXTURE", GL.TEXTURE_2D, 1)
                .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST)
                .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
                .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE,
                    Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 255, 64, 255]));
            if (entry.sampler) s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + 1).call("BIND_TEXTURE", GL.TEXTURE_2D, 2)
                .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST)
                .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
                .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, Uint8Array.from([255, 128, 255, 255]))
                .call("ACTIVE_TEXTURE", GL.TEXTURE0);
        }
        if (entry.name === "vs_fog") {
            s.call("ENABLE", GL.FOG).call("FOGI", GL.FOG_MODE, GL.LINEAR).call("FOGF", GL.FOG_START, 0).call("FOGF", GL.FOG_END, 1);
            vector(s, "FOGFV", [GL.FOG_COLOR], [0, 0, 1, 1]);
        }
        if (entry.name === "vs_secondary") s.call("ENABLE", GL.COLOR_SUM);
        if (entry.name === "vs_back_twoside") s.call("ENABLE", GL.VERTEX_PROGRAM_TWO_SIDE);
        if (entry.name === "fs_texgen") {
            s.call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("ENABLE", GL.TEXTURE_GEN_S).call("TEX_GENI", GL.S, GL.TEXTURE_GEN_MODE, GL.OBJECT_LINEAR);
            vector(s, "TEX_GENFV", [GL.S, GL.OBJECT_PLANE], [0, 0, 0, 0.25]);
            s.call("MATRIX_MODE", GL.TEXTURE).call("TRANSLATEF", 0.25, 0, 0).call("MATRIX_MODE", GL.MODELVIEW).call("ACTIVE_TEXTURE", GL.TEXTURE0);
        }
        if (entry.name === "fs_lighting") {
            s.call("ENABLE", GL.LIGHTING).call("ENABLE", GL.LIGHT0);
            vector(s, "LIGHTFV", [GL.LIGHT0, GL.DIFFUSE], [0.2, 0.4, 0.6, 1]);
            vector(s, "MATERIALFV", [GL.FRONT_AND_BACK, GL.DIFFUSE], [1, 1, 1, 1]);
            vector(s, "MATERIALFV", [GL.FRONT_AND_BACK, GL.AMBIENT], [0, 0, 0, 1]);
        }
        if (entry.name === "fs_fog") s.call("FOGI", GL.FOG_COORD_SRC, GL.FOG_COORD);
        return s;
    };
    cases.draw = (s, entry) => {
        s.call("BEGIN", GL.QUADS);
        const vertices = entry.reverse ? [[-1, 1], [1, 1], [1, -1], [-1, -1]] : [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (const [x, y] of vertices) s.call("VERTEX3F", x, y, 0);
        return s.call("END");
    };
    global.GLShaderMixedCases = cases;
    if (typeof module !== "undefined") module.exports = cases;
})(typeof globalThis !== "undefined" ? globalThis : this);
