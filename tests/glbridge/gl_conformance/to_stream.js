// Interprets scenes.js ops into VGL2 records the way opengl32_proxy.c would
// encode the same calls, and runs them through a GLWebGPUExecutor.
"use strict";
(function (global) {
    const { GLStream, GL, GLFN } = global.GLTestStream;
    const EXTRA = {
        SOURCE0_RGB: 0x8580, SOURCE1_RGB: 0x8581, SOURCE2_RGB: 0x8582,
        SOURCE0_ALPHA: 0x8588, SOURCE1_ALPHA: 0x8589, SOURCE2_ALPHA: 0x858A,
        TEXTURE1: 0x84C1, FOG_COORDINATE_SOURCE: 0x8450, FOG_COORDINATE: 0x8451,
        POLYGON_OFFSET_LINE: 0x2A02, BLEND_COLOR: 0x8005, LOAD: 0x0101, ACCUM: 0x0100,
        RETURN: 0x0102, MULT: 0x0103, CLAMP_VERTEX_COLOR: 0x891A,
        // logic ops are absent from gl_constants.js
        CLEAR: 0x1500, AND: 0x1501, AND_REVERSE: 0x1502, COPY: 0x1503, AND_INVERTED: 0x1504, NOOP: 0x1505,
        XOR: 0x1506, OR: 0x1507, NOR: 0x1508, EQUIV: 0x1509, INVERT: 0x150A, OR_REVERSE: 0x150B,
        COPY_INVERTED: 0x150C, OR_INVERTED: 0x150D, NAND: 0x150E, SET: 0x150F,
    };
    const used = {};
    function E(x) {
        if (typeof x !== "string") return x;
        const v = GL[x] !== undefined ? GL[x] : EXTRA[x];
        if (v === undefined) throw new Error("no JS value for GL_" + x);
        used[x] = v;
        return v;
    }
    function bytesOf(d) {
        if (!d) return new Uint8Array(0);
        const [kind, values] = Object.entries(d)[0];
        const T = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, f32: Float32Array }[kind];
        const arr = T.from(values);
        return new Uint8Array(arr.buffer);
    }
    // guest *_value_count tables
    const SCALAR = new Set(["SPOT_EXPONENT", "SPOT_CUTOFF", "CONSTANT_ATTENUATION", "LINEAR_ATTENUATION",
        "QUADRATIC_ATTENUATION", "SHININESS", "FOG_MODE", "FOG_DENSITY", "FOG_START", "FOG_END", "FOG_INDEX",
        "FOG_COORDINATE_SOURCE", "LIGHT_MODEL_LOCAL_VIEWER", "LIGHT_MODEL_TWO_SIDE", "LIGHT_MODEL_COLOR_CONTROL",
        "TEXTURE_ENV_MODE", "RGB_SCALE", "ALPHA_SCALE", "TEXTURE_LOD_BIAS", "TEXTURE_GEN_MODE"]);
    const count = (pname) => pname === "SPOT_DIRECTION" ? 3 : SCALAR.has(pname) ? 1 : 4;
    function pixelBytes(format, type) {
        if ([GL.UNSIGNED_SHORT_5_6_5, GL.UNSIGNED_SHORT_4_4_4_4, GL.UNSIGNED_SHORT_5_5_5_1].includes(type)) return 2;
        if ([GL.UNSIGNED_INT_8_8_8_8, GL.UNSIGNED_INT_8_8_8_8_REV].includes(type)) return 4;
        const comps = [GL.RGBA, GL.BGRA].includes(format) ? 4 : [GL.RGB, GL.BGR].includes(format) ? 3 :
            format === GL.LUMINANCE_ALPHA ? 2 : 1;
        if ([GL.UNSIGNED_SHORT, GL.SHORT].includes(type)) return comps * 2;
        if ([GL.UNSIGNED_INT, GL.INT, GL.FLOAT].includes(type)) return comps * 4;
        return comps;
    }
    function span(w, h, format, type, pack) {
        const bpp = pixelBytes(format, type);
        const rowPixels = pack.rowLength > 0 ? pack.rowLength : w;
        const stride = Math.ceil(rowPixels * bpp / pack.align) * pack.align;
        return pack.skipRows * stride + pack.skipPixels * bpp + (h - 1) * stride + w * bpp;
    }
    function arraysOf(arrays) {
        const out = {};
        for (const [k, a] of Object.entries(arrays))
            out[k] = { size: a.size, type: E(a.type), stride: 0, data: bytesOf(a.data) };
        return out;
    }

    async function runScene(executor, scene, index, size) {
        let st = new GLStream();
        const extras = [];
        const submit = () => { if (st.length) executor.submit(st.bytes(), {}); st = new GLStream(); };
        const pack = { align: 4, rowLength: 0, skipRows: 0, skipPixels: 0 };
        let currentProgram = 0;
        const glslIds = {};
        st.makeCurrent(1, 0, 0, size, size, 1000 + index, 0);
        st.call("VIEWPORT", 0, 0, size, size).call("SCISSOR", 0, 0, size, size)
            .call("CLEAR_COLOR", 0, 0, 0, 0).call("CLEAR_DEPTH", 1).call("CLEAR_STENCIL", 0)
            .call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
        const uniform = (name, values, ints) => {
            const q = st.queryLocation(1, currentProgram, name, 0);
            submit();
            const v = q.view;
            const status = v.getUint32(12, true);
            const location = status === 1 ? v.getInt32(16, true) : -1;
            if (ints) st.uniformiv(location, values.length, 1, values);
            else st.uniformfv(location, values.length, 1, values);
        };
        for (const op of scene.ops) {
            const [n, ...a] = op;
            switch (n) {
            case "Enable": case "Disable": case "MatrixMode": case "DepthFunc": case "BlendEquation": case "LogicOp":
            case "CullFace": case "FrontFace": case "ShadeModel": case "Begin": case "ActiveTexture": {
                const wire = { Enable: "ENABLE", Disable: "DISABLE", MatrixMode: "MATRIX_MODE", DepthFunc: "DEPTH_FUNC",
                    BlendEquation: "BLEND_EQUATION", LogicOp: "LOGIC_OP", CullFace: "CULL_FACE", FrontFace: "FRONT_FACE",
                    ShadeModel: "SHADE_MODEL", Begin: "BEGIN", ActiveTexture: "ACTIVE_TEXTURE" }[n];
                st.call(wire, E(a[0])); break;
            }
            case "End": st.call("END"); break;
            case "LoadIdentity": st.call("LOAD_IDENTITY"); break;
            case "PushMatrix": st.call("PUSH_MATRIX"); break;
            case "PopMatrix": st.call("POP_MATRIX"); break;
            case "ClearColor": st.call("CLEAR_COLOR", ...a); break;
            case "ClearAccum": st.call("CLEAR_ACCUM", ...a); break;
            case "BlendColor": st.call("BLEND_COLOR", ...a); break;
            case "ClearDepth": st.call("CLEAR_DEPTH", a[0]); break;
            case "DepthRange": st.call("DEPTH_RANGE", a[0], a[1]); break;
            case "ClearStencil": st.call("CLEAR_STENCIL", a[0]); break;
            case "Clear": st.call("CLEAR", a[0].reduce((m, x) => m | E(x), 0)); break;
            case "Viewport": st.call("VIEWPORT", ...a); break;
            case "Scissor": st.call("SCISSOR", ...a); break;
            case "ColorMask": st.call("COLOR_MASK", ...a); break;
            case "DepthMask": st.call("DEPTH_MASK", a[0]); break;
            case "StencilMask": st.call("STENCIL_MASK", a[0]); break;
            case "AlphaFunc": st.call("ALPHA_FUNC", E(a[0]), a[1]); break;
            case "BlendFunc": st.call("BLEND_FUNC", E(a[0]), E(a[1])); break;
            case "BlendFuncSeparate": st.call("BLEND_FUNC_SEPARATE", ...a.map(E)); break;
            case "PolygonMode": st.call("POLYGON_MODE", E(a[0]), E(a[1])); break;
            case "ColorMaterial": st.call("COLOR_MATERIAL", E(a[0]), E(a[1])); break;
            case "StencilFunc": st.call("STENCIL_FUNC", E(a[0]), a[1], a[2]); break;
            case "StencilOp": st.call("STENCIL_OP", ...a.map(E)); break;
            case "PolygonOffset": st.call("POLYGON_OFFSET", a[0], a[1]); break;
            case "PixelZoom": st.call("PIXEL_ZOOM", a[0], a[1]); break;
            case "LineWidth": st.call("LINE_WIDTH", a[0]); break;
            case "PointSize": st.call("POINT_SIZE", a[0]); break;
            case "FogCoordf": st.call("FOG_COORDF", a[0]); break;
            case "Translatef": st.call("TRANSLATEF", ...a); break;
            case "Scalef": st.call("SCALEF", ...a); break;
            case "Rotatef": st.call("ROTATEF", ...a); break;
            case "Ortho": st.call("ORTHO", ...a); break;
            case "Frustum": st.call("FRUSTUM", ...a); break;
            case "LoadMatrixf": case "MultMatrixf": {
                const b = new Uint8Array(new Float32Array(a[0]).buffer);
                st.raw(n === "LoadMatrixf" ? GLFN.LOAD_MATRIXF : GLFN.MULT_MATRIXF, b); break;
            }
            case "Vertex2f": st.call("VERTEX3F", a[0], a[1], 0); break;
            case "Vertex3f": st.call("VERTEX3F", ...a); break;
            case "Vertex4f": st.call("VERTEX4F", ...a); break;
            case "Color3f": st.call("COLOR4F", a[0], a[1], a[2], 1); break;
            case "Color4f": st.call("COLOR4F", ...a); break;
            case "Color4ub": st.call("COLOR4F", ...a.map(v => Math.fround(v) / 255)); break;
            case "Normal3f": st.call("NORMAL3F", ...a); break;
            case "TexCoord2f": st.call("TEX_COORD2F", ...a); break;
            case "TexCoord4f": st.call("TEX_COORD4F", ...a); break;
            case "MultiTexCoord2f": st.call("MULTI_TEX_COORD4F", E(a[0]), a[1], a[2], 0, 1); break;
            case "SecondaryColor3f": st.call("SECONDARY_COLOR3F", ...a); break;
            case "RasterPos2f": st.call("RASTER_POS4F", a[0], a[1], 0, 1); break;
            case "RasterPos3f": st.call("RASTER_POS4F", a[0], a[1], a[2], 1); break;
            case "WindowPos2f": st.call("WINDOW_POS3F", a[0], a[1], 0); break;
            case "Lightf": st.call("LIGHTF", E(a[0]), E(a[1]), a[2]); break;
            case "Materialf": st.call("MATERIALF", E(a[0]), E(a[1]), a[2]); break;
            case "TexEnvf": st.call("TEX_ENVF", E(a[0]), E(a[1]), a[2]); break;
            case "TexParameterf": st.call("TEX_PARAMETERF", E(a[0]), E(a[1]), a[2]); break;
            case "Lightfv": st.call("LIGHTFV", E(a[0]), E(a[1]), count(a[1]), ...a[2]); break;
            case "Lightiv": st.call("LIGHTIV", E(a[0]), E(a[1]), count(a[1]), ...a[2].concat([0, 0, 0]).slice(0, 4)); break;
            case "Materialfv": st.call("MATERIALFV", E(a[0]), E(a[1]), count(a[1]), ...a[2]); break;
            case "TexEnvfv": st.call("TEX_ENVFV", E(a[0]), E(a[1]), count(a[1]), ...a[2]); break;
            case "TexGenfv": st.call("TEX_GENFV", E(a[0]), E(a[1]), 4, ...a[2]); break;
            case "TexParameterfv": st.call("TEX_PARAMETERFV", E(a[0]), E(a[1]), 4, ...a[2]); break;
            case "TexEnvi": st.call("TEX_ENVI", E(a[0]), E(a[1]), E(a[2])); break;
            case "TexGeni": st.call("TEX_GENI", E(a[0]), E(a[1]), E(a[2])); break;
            case "TexParameteri": st.call("TEX_PARAMETERI", E(a[0]), E(a[1]), E(a[2])); break;
            case "LightModeli": st.call("LIGHT_MODELI", E(a[0]), E(a[1])); break;
            case "Fogi": st.call("FOGI", E(a[0]), E(a[1])); break;
            case "PixelStorei": {
                const p = a[0], v = E(a[1]);
                if (p === "PACK_ALIGNMENT") pack.align = v;
                if (p === "PACK_ROW_LENGTH") pack.rowLength = v;
                if (p === "PACK_SKIP_ROWS") pack.skipRows = v;
                if (p === "PACK_SKIP_PIXELS") pack.skipPixels = v;
                st.call("PIXEL_STOREI", E(p), v); break;
            }
            case "Fogf": st.call("FOGF", E(a[0]), a[1]); break;
            case "PixelTransferf": st.call("PIXEL_TRANSFERF", E(a[0]), a[1]); break;
            case "LightModelfv": st.call("LIGHT_MODELFV", E(a[0]), count(a[0]), ...a[1]); break;
            case "Fogfv": st.call("FOGFV", E(a[0]), count(a[0]), ...a[1]); break;
            case "ClipPlane": st.call("CLIP_PLANE", E(a[0]), ...a[1]); break;
            case "GenTextures": st.names(GLFN.GEN_TEXTURES, a[0]); break;
            case "GenFramebuffers": st.names(GLFN.GEN_FRAMEBUFFERS, a[0]); break;
            case "BindTexture": st.call("BIND_TEXTURE", E(a[0]), a[1]); break;
            case "TexImage2D": st.texImage2D(E(a[0]), a[1], E(a[2]), a[3], a[4], E(a[6]), E(a[7]), a[8] ? bytesOf(a[8]) : null); break;
            case "DrawPixels": st.drawPixels(a[0], a[1], E(a[2]), E(a[3]), bytesOf(a[4])); break;
            case "Bitmap": st.bitmap(a[0], a[1], a[2], a[3], a[4], a[5], bytesOf(a[6])); break;
            case "Accum": st.call("ACCUM", E(a[0]), a[1]); break;
            case "CopyTexImage2D": st.call("COPY_TEX_IMAGE_2D", E(a[0]), a[1], E(a[2]), ...a.slice(3)); break;
            case "CopyTexSubImage2D": st.call("COPY_TEX_SUB_IMAGE_2D", E(a[0]), ...a.slice(1)); break;
            case "CopyPixels": st.call("COPY_PIXELS", ...a.slice(0, 4), E(a[4])); break;
            case "ReadPixels": {
                const fmt = E(a[4]), type = E(a[5]);
                const bytes = span(a[2], a[3], fmt, type, pack);
                extras.push({ x: a[0], y: a[1], w: a[2], h: a[3], format: fmt, type, view: st.readPixels(a[0], a[1], a[2], a[3], fmt, type, bytes) });
                break;
            }
            case "PolygonStipple": st.raw(GLFN.POLYGON_STIPPLE, bytesOf(a[0])); break;
            case "DrawArrays": st.drawArrays(E(a[0]), a[1], arraysOf(a[2])); break;
            case "DrawElements": {
                const T = { UNSIGNED_BYTE: Uint8Array, UNSIGNED_SHORT: Uint16Array, UNSIGNED_INT: Uint32Array }[a[1]];
                st.drawElements(E(a[0]), T.from(a[2]), E(a[1]), arraysOf(a[3])); break;
            }
            case "Program": {
                const id = a[0], vs = 100 + id * 2, fs = vs + 1;
                glslIds[id] = true;
                st.call("CREATE_PROGRAM", id).call("CREATE_SHADER", vs, GL.VERTEX_SHADER).call("CREATE_SHADER", fs, GL.FRAGMENT_SHADER)
                    .shaderSource(vs, a[1]).shaderSource(fs, a[2]).call("COMPILE_SHADER", vs).call("COMPILE_SHADER", fs)
                    .call("ATTACH_SHADER", id, vs).call("ATTACH_SHADER", id, fs).call("LINK_PROGRAM", id);
                break;
            }
            case "UseProgram": currentProgram = a[0]; st.call("USE_PROGRAM", a[0]); break;
            case "Uniform1f": uniform(a[0], [a[1]], false); break;
            case "Uniform1i": uniform(a[0], [a[1]], true); break;
            case "ProgramARB":
                st.names(GLFN.GEN_PROGRAMS_ARB, [a[1]]).call("BIND_PROGRAM_ARB", E(a[0]), a[1]).programStringARB(E(a[0]), a[2]);
                break;
            case "ProgramLocalParameter4f": st.programParameterARB(2, E(a[0]), a[1], a.slice(2)); break;
            case "ProgramEnvParameter4f": st.programParameterARB(1, E(a[0]), a[1], a.slice(2)); break;
            case "BindFramebuffer": st.call("BIND_FRAMEBUFFER", E(a[0]), a[1]); break;
            case "FramebufferTexture2D": st.call("FRAMEBUFFER_TEXTURE", E(a[0]), E(a[1]), E(a[2]), a[3], a[4], 0); break;
            default: throw new Error("to_stream: no mapping for " + n);
            }
        }
        st.call("USE_PROGRAM", 0).call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0)
            .call("PIXEL_STOREI", GL.PACK_ALIGNMENT, 4).call("PIXEL_STOREI", GL.PACK_ROW_LENGTH, 0)
            .call("PIXEL_STOREI", GL.PACK_SKIP_ROWS, 0).call("PIXEL_STOREI", GL.PACK_SKIP_PIXELS, 0);
        const final = st.readPixels(0, 0, size, size, GL.RGBA, GL.UNSIGNED_BYTE, size * size * 4);
        const err = st.queryError();
        submit();
        await executor.idle();
        return {
            extra: extras.map(e => ({ x: e.x, y: e.y, w: e.w, h: e.h, format: e.format, type: e.type,
                status: e.view.view.getUint32(28, true), bytes: e.view.bytes.slice(32) })),
            status: final.view.getUint32(28, true),
            rgba: final.bytes.slice(32),
            error: err.view.getUint32(4, true),
        };
    }
    global.GLConformanceStream = { runScene, used };
})(globalThis);
