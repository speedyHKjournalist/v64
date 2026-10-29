#!/usr/bin/env node
// Generates scenes_gen.c (the reference side) from scenes.js.
"use strict";
const fs = require("fs");
const path = require("path");
const { scenes } = require("../scenes.js");

const C_ALIAS = { FRAMEBUFFER_EXT: "GL_FRAMEBUFFER_EXT", COLOR_ATTACHMENT0: "GL_COLOR_ATTACHMENT0_EXT" };
const usedEnums = new Set();
const E = (x) => {
    if (typeof x !== "string") return String(x);
    usedEnums.add(x);
    return C_ALIAS[x] || "GL_" + x;
};
const F = (x) => { const s = String(Number(x)); return /[.e]/.test(s) ? s + "f" : s + ".0f"; };
const D = (x) => { const s = String(Number(x)); return /[.e]/.test(s) ? s : s + ".0"; };
const I = (x) => String(x | 0);
const U = (x) => String(x >>> 0) + "u";
const X = (x) => typeof x === "string" ? "(GLint)" + E(x) : I(x);

let decls = [];
let dataId = 0;
function dataArray(d) {
    if (!d) return "NULL";
    const [kind, values] = Object.entries(d)[0];
    const ctype = { u8: "GLubyte", i8: "GLbyte", u16: "GLushort", i16: "GLshort", u32: "GLuint", f32: "GLfloat" }[kind];
    const name = "d" + (dataId++);
    const vals = values.length ? values.map(v => kind === "f32" ? F(v) : kind === "u32" ? U(v) : String(v)).join(",") : "0";
    decls.push(`static const ${ctype} ${name}[] = {${vals}};`);
    return name;
}
function cstr(text) {
    return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, '\\n"\n    "') + '"';
}
const v4 = (a, conv, type) => `(const ${type}[]){${[0, 1, 2, 3].map(i => conv(a[i] === undefined ? 0 : a[i])).join(",")}}`;

function arraysC(arrays) {
    const out = [];
    const kinds = { vertex: ["VERTEX_ARRAY", "glVertexPointer"], color: ["COLOR_ARRAY", "glColorPointer"],
        normal: ["NORMAL_ARRAY", null], texCoord0: ["TEXTURE_COORD_ARRAY", "glTexCoordPointer"] };
    for (const [k, a] of Object.entries(arrays)) {
        const [cap, fn] = kinds[k];
        out.push(`glEnableClientState(${E(cap)});`);
        if (fn) out.push(`${fn}(${a.size}, ${E(a.type)}, 0, ${dataArray(a.data)});`);
        else out.push(`glNormalPointer(${E(a.type)}, 0, ${dataArray(a.data)});`);
    }
    const disable = Object.keys(arrays).map(k => `glDisableClientState(${E(kinds[k][0])});`);
    return [out, disable];
}

function emit(op) {
    const [n, ...a] = op;
    switch (n) {
    case "Enable": case "Disable": case "MatrixMode": case "DepthFunc": case "BlendEquation": case "LogicOp":
    case "CullFace": case "FrontFace": case "ShadeModel": case "Begin": case "ActiveTexture":
        return `gl${n}(${E(a[0])});`;
    case "End": case "LoadIdentity": case "PushMatrix": case "PopMatrix": return `gl${n}();`;
    case "ClearColor": case "ClearAccum": case "BlendColor": case "Color4f": case "Rotatef": case "Vertex4f": case "TexCoord4f":
        return `gl${n}(${a.map(F).join(",")});`;
    case "ClearDepth": return `glClearDepth(${D(a[0])});`;
    case "DepthRange": return `glDepthRange(${D(a[0])},${D(a[1])});`;
    case "ClearStencil": return `glClearStencil(${I(a[0])});`;
    case "Clear": return `glClear(${a[0].map(E).join("|")});`;
    case "Viewport": case "Scissor": return `gl${n}(${a.map(I).join(",")});`;
    case "ColorMask": return `glColorMask(${a.join(",")});`;
    case "DepthMask": return `glDepthMask(${a[0]});`;
    case "StencilMask": return `glStencilMask(${U(a[0])});`;
    case "AlphaFunc": return `glAlphaFunc(${E(a[0])},${F(a[1])});`;
    case "BlendFunc": case "PolygonMode": case "ColorMaterial": return `gl${n}(${E(a[0])},${E(a[1])});`;
    case "BlendFuncSeparate": return `glBlendFuncSeparate(${a.map(E).join(",")});`;
    case "StencilFunc": return `glStencilFunc(${E(a[0])},${I(a[1])},${U(a[2])});`;
    case "StencilOp": return `glStencilOp(${a.map(E).join(",")});`;
    case "PolygonOffset": case "PixelZoom": case "TexCoord2f": case "RasterPos2f": case "WindowPos2f": case "Vertex2f":
        return `gl${n}(${a.map(F).join(",")});`;
    case "LineWidth": case "PointSize": case "FogCoordf": return `gl${n}(${F(a[0])});`;
    case "Translatef": case "Scalef": case "Vertex3f": case "Color3f": case "Normal3f": case "SecondaryColor3f": case "RasterPos3f":
        return `gl${n}(${a.map(F).join(",")});`;
    case "Color4ub": return `glColor4ub(${a.join(",")});`;
    case "Ortho": case "Frustum": return `gl${n}(${a.map(D).join(",")});`;
    case "MultiTexCoord2f": return `glMultiTexCoord2f(${E(a[0])},${F(a[1])},${F(a[2])});`;
    case "Lightf": case "Materialf": case "TexEnvf": case "TexParameterf": case "TexGenf": return `gl${n}(${E(a[0])},${E(a[1])},${F(a[2])});`;
    case "Lightfv": case "Materialfv": case "TexEnvfv": case "TexGenfv": case "TexParameterfv":
        return `gl${n}(${E(a[0])},${E(a[1])},${v4(a[2], F, "GLfloat")});`;
    case "Lightiv": return `glLightiv(${E(a[0])},${E(a[1])},${v4(a[2], I, "GLint")});`;
    case "MultMatrixf": case "LoadMatrixf": return `gl${n}((const GLfloat[]){${a[0].map(F).join(",")}});`;
    case "TexEnvi": case "TexGeni": case "TexParameteri": return `gl${n}(${E(a[0])},${E(a[1])},${X(a[2])});`;
    case "LightModeli": case "Fogi": case "PixelStorei": return `gl${n}(${E(a[0])},${X(a[1])});`;
    case "Fogf": case "PixelTransferf": return `gl${n}(${E(a[0])},${F(a[1])});`;
    case "LightModelfv": case "Fogfv": return `gl${n}(${E(a[0])},${v4(a[1], F, "GLfloat")});`;
    case "ClipPlane": return `glClipPlane(${E(a[0])},${v4(a[1], D, "GLdouble")});`;
    case "GenTextures": case "GenFramebuffers": return `/* ${n} ${a[0]} */`;
    case "BindTexture": return `glBindTexture(${E(a[0])},${a[1]});`;
    case "TexImage2D":
        return `glTexImage2D(${E(a[0])},${a[1]},${X(a[2])},${a[3]},${a[4]},${a[5]},${E(a[6])},${E(a[7])},${dataArray(a[8])});`;
    case "DrawPixels": return `glDrawPixels(${a[0]},${a[1]},${E(a[2])},${E(a[3])},${dataArray(a[4])});`;
    case "Bitmap": return `glBitmap(${a[0]},${a[1]},${F(a[2])},${F(a[3])},${F(a[4])},${F(a[5])},${dataArray(a[6])});`;
    case "Accum": return `glAccum(${E(a[0])},${F(a[1])});`;
    case "CopyTexImage2D": return `glCopyTexImage2D(${E(a[0])},${a[1]},${X(a[2])},${a.slice(3).join(",")});`;
    case "CopyTexSubImage2D": return `glCopyTexSubImage2D(${E(a[0])},${a.slice(1).join(",")});`;
    case "CopyPixels": return `glCopyPixels(${a.slice(0, 4).join(",")},${E(a[4])});`;
    case "ReadPixels": return `read_extra(${a[0]},${a[1]},${a[2]},${a[3]},${E(a[4])},${E(a[5])});`;
    case "PolygonStipple": return `glPolygonStipple(${dataArray(a[0])});`;
    case "DrawArrays": {
        const [en, dis] = arraysC(a[2]);
        return [...en, `glDrawArrays(${E(a[0])},0,${a[1]});`, ...dis].join(" ");
    }
    case "DrawElements": {
        const [en, dis] = arraysC(a[3]);
        const kind = { UNSIGNED_BYTE: "u8", UNSIGNED_SHORT: "u16", UNSIGNED_INT: "u32" }[a[1]];
        return [...en, `glDrawElements(${E(a[0])},${a[2].length},${E(a[1])},${dataArray({ [kind]: a[2] })});`, ...dis].join(" ");
    }
    case "Program": return `make_program(${a[0]}, ${cstr(a[1])}, ${cstr(a[2])});`;
    case "UseProgram": return `use_program(${a[0]});`;
    case "Uniform1f": return `glUniform1f(glGetUniformLocation(g_cur_program, ${cstr(a[0])}), ${F(a[1])});`;
    case "Uniform1i": return `glUniform1i(glGetUniformLocation(g_cur_program, ${cstr(a[0])}), ${I(a[1])});`;
    case "ProgramARB": return `arb_program(${E(a[0])}, ${a[1]}, ${cstr(a[2])});`;
    case "ProgramLocalParameter4f": return `glProgramLocalParameter4fARB(${E(a[0])},${a[1]},${a.slice(2).map(F).join(",")});`;
    case "ProgramEnvParameter4f": return `glProgramEnvParameter4fARB(${E(a[0])},${a[1]},${a.slice(2).map(F).join(",")});`;
    case "BindFramebuffer": return `bind_fb(${a[1]});`;
    case "FramebufferTexture2D": return `glFramebufferTexture2DEXT(${E(a[0])},${E(a[1])},${E(a[2])},${a[3]},${a[4]});`;
    }
    throw new Error("gen_c: no C emission for " + n);
}

const bodies = scenes.map((s, si) => {
    let depth = 0;
    const lines = s.ops.map((op, oi) => {
        const code = emit(op);
        if (op[0] === "Begin") depth++;
        if (op[0] === "End") depth--;
        return "    " + code + (depth ? "" : ` CHK(${oi});`);
    });
    return `static void scene_${si}(void) {\n${lines.join("\n")}\n}`;
});
const out = [
    "/* generated by gen_c.js from scenes.js -- do not edit */",
    ...decls,
    ...bodies,
    `static void (*const SCENES[])(void) = {${scenes.map((s, i) => "scene_" + i).join(",")}};`,
    `static const char* const SCENE_NAMES[] = {${scenes.map(s => JSON.stringify(s.name)).join(",")}};`,
    `#define SCENE_COUNT ${scenes.length}`,
    `static const struct { const char* name; GLenum value; } ENUMS[] = {${[...usedEnums].sort().map(n => `{${JSON.stringify(n)},${C_ALIAS[n] || "GL_" + n}}`).join(",")}};`,
    "",
].join("\n");
// (into the directory given, beside a copy of ref.c: generated, not committed)
fs.writeFileSync(path.join(process.argv[2] || __dirname, "scenes_gen.c"), out);
console.log("wrote scenes_gen.c:", scenes.length, "scenes,", dataId, "arrays,", usedEnums.size, "enums");
