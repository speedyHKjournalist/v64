#!/usr/bin/env node
// Mutation testing for the D3D9 and GL executors: each mutation is a one-line
// semantic bug (the reviews' experiments, docs/d3d-webgpu-review.md section 6
// and docs/opengl-webgpu-review.md section 6). It is applied to a copy of the
// tree, the Node suites and the real-GPU conformance pages run against it,
// and a test that fails has killed it. A mutation that no longer matches the
// source is reported, so the list follows the code.
//
//   node tests/glbridge/mutations.mjs [--node-only] [--only=d3d9|gl] [filter]
//
// Exits 1 when a family's kill rate is below its floor.
import { cpSync as cp_sync, mkdtempSync as mkdtemp_sync, readFileSync as read_file_sync,
    writeFileSync as write_file_sync, rmSync as rm_sync } from "node:fs";
import { spawnSync as spawn_sync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const node_only = args.includes("--node-only");
const family = (args.find(a => a.startsWith("--only=")) || "").slice(7);
const filter = args.find(a => !a.startsWith("--"));

const D = "src/browser/glbridge/d3d9-webgpu/";
const G = "src/browser/glbridge/gl-webgpu/";
const MUTATIONS = {
    d3d9: { floor: 10 / 12, node: ["d3d9_webgpu_executor_test.js", "d3d9_shader_pipeline_test.js",
        "d3d9_shader_wgsl_validation_test.js", "ddraw_webgpu_executor_test.js", "ddraw_blit_wgsl_validation_test.js"],
    pages: ["d3d9_conformance_browser_test.html"], list: [
        ["cull CW/CCW swapped", D + "d3d9_executor.js",
            'if (cullValue === D3DCULL_CW) cullMode = "front";\n                else if (cullValue === D3DCULL_CCW) cullMode = "back";',
            'if (cullValue === D3DCULL_CW) cullMode = "back";\n                else if (cullValue === D3DCULL_CCW) cullMode = "front";'],
        ["ZFUNC LESS <-> GREATER", D + "d3d9_executor.js", '"never", "less", "equal", "less-equal",\n        "greater",',
            '"never", "greater", "equal", "less-equal",\n        "less",'],
        ["BLEND SRCALPHA <-> INVSRCALPHA", D + "d3d9_executor.js",
            '"src-alpha",            // D3DBLEND_SRCALPHA\n        "one-minus-src-alpha",  // D3DBLEND_INVSRCALPHA',
            '"one-minus-src-alpha",  // D3DBLEND_SRCALPHA\n        "src-alpha",            // D3DBLEND_INVSRCALPHA'],
        ["BLENDOP SUBTRACT <-> REVSUBTRACT", D + "d3d9_executor.js", 'undefined, "add", "subtract", "reverse-subtract",',
            'undefined, "add", "reverse-subtract", "subtract",'],
        ["MODULATE2X without the 2x", D + "d3d9_executor.js",
            'case D3DTOP_MODULATE2X: return "((" + a1 + " * " + a2 + ") * 2.0)";',
            'case D3DTOP_MODULATE2X: return "((" + a1 + " * " + a2 + ") * 1.0)";'],
        ["address WRAP <-> MIRROR", D + "d3d9_executor.js", 'undefined, "repeat", "mirror-repeat", "clamp-to-edge",',
            'undefined, "mirror-repeat", "repeat", "clamp-to-edge",'],
        ["D3DCOLOR not BGRA-swizzled", D + "d3d9_executor.js",
            '"in" + FF_LOCATION_COLOR0 + (signature.colorIsBGRA ? ".bgra" : "")',
            '"in" + FF_LOCATION_COLOR0 + (signature.colorIsBGRA ? "" : "")'],
        ["rcp(0) = 0 instead of FLT_MAX", D + "d3d9_shader_pipeline.js",
            'out.push("fn d9_rcp(v: f32) -> f32 { return select(1.0 / v, " +\n                FLOAT_MAX + ", v == 0.0); }");',
            'out.push("fn d9_rcp(v: f32) -> f32 { return select(1.0 / v, " +\n                "0.0" + ", v == 0.0); }");'],
        ["linear fog uses START for END", D + "d3d9_executor.js", '"clamp((uniforms.fog_params.y - " + distance + ") / " +',
            '"clamp((uniforms.fog_params.x - " + distance + ") / " +'],
        ["lit() ignores the N.L > 0 gate", D + "d3d9_shader_pipeline.js", '"s.x > 0.0 && s.y > 0.0);");', '"s.y > 0.0);");'],
        ["DDraw indexed colour key range exclusive", D + "ddraw_ops.js",
            "if (index >= blit.key_low.x && index <= blit.key_high.x) {",
            "if (index > blit.key_low.x && index < blit.key_high.x) {"],
        ["DDraw RGB colour key range exclusive", D + "ddraw_ops.js",
            "if (all(quantised >= blit.key_low.rgb) &&\n            all(quantised <= blit.key_high.rgb)) {",
            "if (all(quantised > blit.key_low.rgb) &&\n            all(quantised < blit.key_high.rgb)) {"],
    ] },
    gl: { floor: 0.9, node: ["gl_executor_test.js", "gl_shader_translator_test.js", "gl_shader_wgsl_validation_test.js",
        "gl_fixed_function_wgsl_test.js", "gl_arb_program_test.js", "graphics_checkpoint_test.js"],
    pages: ["gl_conformance_browser_test.html", "gl_multipass_browser_test.html"], list: [
        ["cull FRONT/BACK swapped", G + "gl_executor.js", 'return state.cullFace === GL.FRONT ? "front" : "back";',
            'return state.cullFace === GL.FRONT ? "back" : "front";'],
        ["depth GL_LESS -> less-equal", G + "gl_executor.js",
            'const COMPARE_FUNCTIONS = {\n        [GL.NEVER]: "never", [GL.LESS]: "less",',
            'const COMPARE_FUNCTIONS = {\n        [GL.NEVER]: "never", [GL.LESS]: "less-equal",'],
        ["blend SRC_ALPHA <-> ONE_MINUS_SRC_ALPHA", G + "gl_executor.js",
            '[GL.SRC_ALPHA]: "src-alpha", [GL.ONE_MINUS_SRC_ALPHA]: "one-minus-src-alpha",',
            '[GL.SRC_ALPHA]: "one-minus-src-alpha", [GL.ONE_MINUS_SRC_ALPHA]: "src-alpha",'],
        ["blend DST_COLOR <-> ONE_MINUS_DST_COLOR", G + "gl_executor.js",
            '[GL.DST_COLOR]: "dst", [GL.ONE_MINUS_DST_COLOR]: "one-minus-dst",',
            '[GL.DST_COLOR]: "one-minus-dst", [GL.ONE_MINUS_DST_COLOR]: "dst",'],
        ["texenv MODULATE drops texture alpha", G + "gl_fixed_function.js", 'emit("    frag = frag * " + cs + ";");',
            'emit("    frag = vec4<f32>(frag.rgb * " + cs + ".rgb, frag.a);");'],
        ["fog mix operands inverted", G + "gl_fixed_function.js", 'emit("    frag = vec4<f32>(mix(glState.fogColor.rgb, frag.rgb, " +',
            'emit("    frag = vec4<f32>(mix(frag.rgb, glState.fogColor.rgb, " +'],
        ["alpha test GREATER -> >=", G + "gl_fixed_function.js", 'greater: ">", notequal', 'greater: ">=", notequal'],
        ["polygon offset units sign", G + "gl_executor.js", "Math.round(s.polygonOffset.units) : 0,",
            "-Math.round(s.polygonOffset.units) : 0,"],
        ["packed indexed draw ignores min index", G + "gl_executor.js", "firstSourceVertex = min;", "firstSourceVertex = 0;"],
        ["direct EBO ignores index offset", G + "gl_executor.js", "offset: indexInfo.bufferOffset, count,", "offset: 0, count,"],
        ["viewport y top-left origin", G + "gl_executor.js", "const y = clamp(vp.y, 0, height);",
            "const y = clamp(height - vp.y - vp.height, 0, height);"],
        ["depth clear keyed on STENCIL bit", G + "gl_executor.js", "if (mask & GL.DEPTH_BUFFER_BIT) pending.depth = s.clearDepth;",
            "if (mask & GL.STENCIL_BUFFER_BIT) pending.depth = s.clearDepth;"],
        ["stencil INCR -> increment-wrap", G + "gl_executor.js", '[GL.INCR]: "increment-clamp"', '[GL.INCR]: "increment-wrap"'],
        ["light quadratic attenuation uses d", G + "gl_fixed_function.js",
            'l + ".quadraticAttenuation * dist * dist, 1e-8);");', 'l + ".quadraticAttenuation * dist, 1e-8);");'],
        ["infinite-viewer half vector sign", G + "gl_fixed_function.js", "normalize(VP + vec3<f32>(0.0, 0.0, 1.0))",
            "normalize(VP + vec3<f32>(0.0, 0.0, -1.0))"],
        ["GLSL mod() -> WGSL %", G + "gl_shader_translator.js",
            '"(" + args[0] + " - " + args[1] + " * floor(" + args[0] + " / " + args[1] + "))";',
            '"(" + args[0] + " % " + args[1] + ")";'],
        ["GLSL texture2DProj(vec4) divides by z", G + "gl_shader_translator.js",
            'const wComponent = coordType.size === 4 ? "w" : "z";', 'const wComponent = coordType.size === 4 ? "z" : "z";'],
        ["ARB LIT diffuse not clamped", G + "gl_arb_program.js", '"    let diffuse = max(v.x, 0.0);\\n" +',
            '"    let diffuse = v.x;\\n" +'],
        ["ARB LRP operands swapped", G + "gl_arb_program.js",
            'emit: a => "mix(" + a[2] + ", " + a[1] + ", " + a[0] + ")" },', 'emit: a => "mix(" + a[1] + ", " + a[2] + ", " + a[0] + ")" },'],
        ["texture wrap REPEAT -> mirror", G + "gl_executor.js", '[GL.REPEAT]: "repeat",', '[GL.REPEAT]: "mirror-repeat",'],
        ["QUADS first triangle loses provoking", G + "gl_executor.js",
            "// provoking vertex is the quad's last, so it leads both halves\n                out[w++] = b + 3; out[w++] = b; out[w++] = b + 1;",
            "// provoking vertex is the quad's last, so it leads both halves\n                out[w++] = b; out[w++] = b + 1; out[w++] = b + 3;"],
        ["normal matrix: one element the inverse's", G + "gl_executor.js",
            "n[1] = (m02 * m21 - m01 * m22) * det;", "n[1] = c01 * det;"],
        ["flat triangles lead with their first vertex", G + "gl_executor.js",
            "out[w] = first + w + 2; out[w + 1] = first + w; out[w + 2] = first + w + 1;",
            "out[w] = first + w; out[w + 1] = first + w + 1; out[w + 2] = first + w + 2;"],
        ["QUAD_STRIP second half reversed", G + "gl_executor.js",
            "out[w++] = b + 3; out[w++] = b + 2; out[w++] = b;", "out[w++] = b + 3; out[w++] = b + 1; out[w++] = b + 2;"],
        ["RESCALE_NORMAL by the modelview's column", G + "gl_fixed_function.js",
            '"glState.normalMatrix[2], glState.normalMatrix[2]), 1e-8));"',
            '"glState.modelview[2].xyz, glState.modelview[2].xyz), 1e-8));"'],
        ["COLOR_MATERIAL does not latch", G + "gl_executor.js",
            "            if (!s.colorMaterial.enabled) return;\n            const mode = s.colorMaterial.mode;",
            "            if (s.colorMaterial.enabled || !s.colorMaterial.enabled) return;\n            const mode = s.colorMaterial.mode;"],
        ["the projective q is dropped", G + "gl_fixed_function.js",
            'default: return "vec3<f32>(" + tc + ".xy, " + tc + ".w)";', 'default: return "vec3<f32>(" + tc + ".xy, 1.0)";'],
        ["a reversed depth range is not flipped", G + "gl_executor.js",
            'reversedDepthRange(s) ? "zflip" : "-",', '"-",'],
        ["a crossbar to a disabled unit still blends", G + "gl_fixed_function.js",
            "            return crossbar && !sig.texture[+crossbar[1]].enabled;", "            return false && crossbar;"],
        ["unlit vertex colours are not clamped", G + "gl_fixed_function.js",
            'writeVarying(emit, layout.color, "saturate(" + primary + ")", 4);', "writeVarying(emit, layout.color, primary, 4);"],
        ["COLOR_SUM unlit adds nothing", G + "gl_fixed_function.js",
            "        if (sig.colorSum || sig.lighting.enabled && sig.lighting.separateSpecular)\n            layout.secondary = place(",
            "        if (sig.lighting.enabled && sig.lighting.separateSpecular)\n            layout.secondary = place("],
        ["gl_FrontColor is not clamped", G + "gl_shader_translator.js",
            'COLOR_OUTPUTS.has(source) ? "saturate(" + safeName(source) + ")" : safeName(source)', "safeName(source)"],
        ["an invalid raster position still draws", G + "gl_executor.js",
            "            s.current.rasterValid = valid;\n", "            s.current.rasterValid = cw !== 0;\n"],
        ["a disabled clip plane below an enabled one clips", G + "gl_executor.js",
            "                else snapshot.clipPlanes[i].set(PASSING_PLANE);", "                else snapshot.clipPlanes[i].set(s.clipPlanes[i]);"],
        ["pipelines keyed by program name", G + "gl_executor.js",
            'kind: "program", key: "p" + entry.codeKey,', 'kind: "program", key: "p" + program.name + "|" + key,'],
        ["the viewport is clamped into the target", G + "gl_executor.js",
            "            const x = clamp(vp.x, -2 * limit, 2 * limit - 1 - vw);", "            const x = clamp(vp.x, 0, width);"],
        ["an incomplete texture is sampled", G + "gl_executor.js",
            "                if (!complete) { texture.push({ enabled: false }); continue; }\n", ""],
        ["the LOD bias is not applied", G + "gl_fixed_function.js",
            "        const sample = (coordinates) => unit.lodBias ?", "        const sample = (coordinates) => false ?"],
        ["BGRA packed types read as RGBA", G + "gl_executor.js",
            "        case GL.BGRA: out[0] = c[2]; out[1] = c[1]; out[2] = c[0]; out[3] = c[3]; return;\n        case GL.ABGR_EXT: out[0] = c[3]; out[1] = c[2]; out[2] = c[1]; out[3] = c[0]; return;\n        default: out[0] = c[0]; out[1] = components > 1",
            "        case GL.BGRA: out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = c[3]; return;\n        case GL.ABGR_EXT: out[0] = c[3]; out[1] = c[2]; out[2] = c[1]; out[3] = c[0]; return;\n        default: out[0] = c[0]; out[1] = components > 1"],
        ["sized formats keep 8 bits", G + "gl_executor.js",
            "            if (pixels && storage.bits) quantize(pixels, storage.bits);", "            void quantize;"],
        ["ReadPixels LUMINANCE is red", G + "gl_executor.js",
            "            case GL.LUMINANCE: return [l];", "            case GL.LUMINANCE: return [r];"],
        ["ReadPixels ignores the pack alignment", G + "gl_executor.js",
            "        const rowBytes = alignUp((pack.rowLength || requestWidth) * groupBytes, pack.alignment || 4);",
            "        const rowBytes = (pack.rowLength || requestWidth) * groupBytes;"],
        ["CONSTANT_ALPHA blends with the constant's RGB", G + "gl_executor.js",
            "return usesAlpha && !usesColor ? { r: a, g: a, b: a, a } : { r, g, b, a };", "return { r, g, b, a };"],
        ["polygon facing ignores glFrontFace", G + "gl_executor.js",
            "        return (area >= 0) === (frontFace !== GL.CW);", "        return area >= 0;"],
        ["edge flags are ignored", G + "gl_executor.js",
            "                boundary.push(flagged ? flags[at(i)] : 1);", "                boundary.push(1);"],
        ["polygon-mode lines are not culled", G + "gl_executor.js",
            "                if (clip && culling && (isFront ? s.cullFace === GL.FRONT : s.cullFace === GL.BACK))",
            "                if (false)"],
        ["POLYGON_OFFSET_LINE drops the units", G + "gl_executor.js",
            "            return (slope * s.polygonOffset.factor + r * s.polygonOffset.units) / range;",
            "            return slope * s.polygonOffset.factor / range;"],
        ["gl_FragColor goes to the first draw buffer only", G + "gl_shader_translator.js",
            "            let colorTargets = Math.max(1, variant.colorTargets || 1);", "            let colorTargets = 1;"],
        ["ARB result.color goes to the first draw buffer only", G + "gl_executor.js",
            "                wgslFragment: broadcastColor(fragment.compiled.wgsl, targets),",
            "                wgslFragment: fragment.compiled.wgsl,"],
        ["an unwritten draw buffer keeps its write mask", G + "gl_executor.js",
            "                    writeMask: i >= outputs ? 0 : (s.colorMask[0] ? 1 : 0) | (s.colorMask[1] ? 2 : 0) |",
            "                    writeMask: (s.colorMask[0] ? 1 : 0) | (s.colorMask[1] ? 2 : 0) |"],
        ["glVertexAttrib(0) inside glBegin issues no vertex", G + "gl_executor.js",
            "            if (index === 0 && this.current.immediate)", "            if (false)"],
        ["immediate mode lays generic attribute 0 out twice", G + "gl_executor.js",
            "                    if (index > 0 && index < MAX_VERTEX_ATTRIBS &&",
            "                    if (index >= 0 && index < MAX_VERTEX_ATTRIBS &&"],
        ["32-bit float targets blend without float32-blendable", G + "gl_executor.js",
            "            if (!/^(r|rg|rgba)32float$/.test(format) ||", "            if (true ||"],
        ["a sub-image re-uploads every level's CPU copy", G + "gl_executor.js",
            '                    if (shapeChanged || full.has(layer + ":" + level))', "                    if (true)"],
        ["drawing into a texture keeps its old CPU copy", G + "gl_executor.js",
            "                if (slot && !slot.compressed) slot.pixels = null;", "                void slot;"],
        ["glTexSubImage needs a CPU copy of the level", G + "gl_executor.js",
            '            if (!slot)\n                return this.refuse("glTexSubImage", "level has no storage",',
            '            if (!slot || !slot.pixels)\n                return this.refuse("glTexSubImage", "level has no storage",'],
        ["GENERATE_MIPMAP ignores sub-images", G + "gl_executor.js",
            "            if (texture.generateMipmapHint && level === 0) this.generateMipmapFor(texture);\n        },\n\n        compressedTexImage(",
            "            void 0;\n        },\n\n        compressedTexImage("],
        ["constant attributes step per instance", G + "gl_executor.js",
            "                    baseOffset: slice.offset, stride: 0, attributes });",
            '                    baseOffset: slice.offset, stride: components * 4, stepMode: "instance", attributes });'],
        ["a one-pixel point ignores the attenuation", G + "gl_executor.js",
            "                p.attenuation[0] !== 1 || p.attenuation[1] !== 0 || p.attenuation[2] !== 0 ||", ""],
        ["point quads are culled", G + "gl_executor.js",
            '            const cullMode = request.expandedPoints ? "none" : this.gpuCullMode(s);',
            "            const cullMode = this.gpuCullMode(s);"],
        ["glEnable(GL_POINT_SPRITE) sets COORD_REPLACE", G + "gl_executor.js",
            "            case GL.POINT_SPRITE:\n                // the enable is global; COORD_REPLACE is the unit's (glTexEnv)\n",
            "            case GL.POINT_SPRITE:\n                unit.env.pointSprite = value;\n"],
        ["gl_PointSize counts without VERTEX_PROGRAM_POINT_SIZE", G + "gl_shader_translator.js",
            "                const size = this.options.programPointSize &&\n", "                const size = true &&\n"],
        ["pixel rectangles keep GL's viewport", G + "gl_executor.js",
            "            pass.setViewport(0, 0, window.width, window.height, 0, 1);", "            void window;"],
        ["reads and copies go outside the read buffer", G + "gl_executor.js",
            "        const x1 = Math.min(source.width, x + width), y1 = Math.min(source.height, y + height);",
            "        const x1 = x + width, y1 = y + height;"],
        ["wide lines are one pixel", G + "gl_executor.js",
            "                    (s.lineWidth >= 1.5 || s.enabled.has(GL.LINE_STIPPLE)))",
            "                    s.enabled.has(GL.LINE_STIPPLE))"],
        ["a wide line widens across its major axis", G + "gl_executor.js",
            "                const ox = xMajor ? 0 : width / 2, oy = xMajor ? width / 2 : 0;",
            "                const ox = xMajor ? width / 2 : 0, oy = xMajor ? 0 : width / 2;"],
        ["the stipple counter restarts in a strip", G + "gl_executor.js",
            "            out.push({ a: at(i), b: at(i + 1), provoking: at(i + 1), restart: i === 0 });",
            "            out.push({ a: at(i), b: at(i + 1), provoking: at(i + 1), restart: true });"],
        ["the stipple pattern is read from the high bit", G + "gl_fixed_function.js",
            'emit("    let stippleBit = u32(floor(fin.lineDistance / glState.rasterParams.z)) % 16u;");',
            'emit("    let stippleBit = 15u - u32(floor(fin.lineDistance / glState.rasterParams.z)) % 16u;");'],
        ["a missing texture binds the 2D colour fallback", G + "gl_executor.js",
            "            if (!object || !this.textureIsComplete(object)) return this.fallbackViewFor(item);",
            "            if (!object || !this.textureIsComplete(object)) return this.fallbackView;"],
        ["a depth texture binds to a colour sampler", G + "gl_executor.js",
            "            if (depth !== !!item.shadow) {", "            if (false) {"],
        ["MIN and MAX keep the application's factors", G + "gl_executor.js",
            '            const minMax = operation === "min" || operation === "max";', "            const minMax = false;"],
        ["GL_CLAMP never blends the border", G + "gl_executor.js",
            '            (wrap === GL.CLAMP && linear ? "clamp" : null);', "            null;"],
        ["a LUMINANCE border keeps its green and blue", G + "gl_executor.js",
            '        case "LUMINANCE": case "DEPTH": return [r, r, r, 1];', '        case "DEPTH": return [r, r, r, 1];'],
        ["the border factor ignores the half texel", G + "gl_fixed_function.js",
            '"clamp(min(" + u + " + 0.5, " + n + " - " + u + " + 0.5), 0.0, 1.0)" :',
            '"clamp(min(" + u + ", " + n + " - " + u + "), 0.0, 1.0)" :'],
        ["lines get POLYGON_OFFSET_FILL's depth bias", G + "gl_executor.js",
            "                isPolygonPrimitive(request.mode) && !request.expandedPoints;", "                true;"],
    ] },
};

const copy = mkdtemp_sync(join(tmpdir(), "glbridge-mutations-"));
let below_floor = false;
try {
    for(const part of ["src/browser/glbridge", "tests/glbridge"])
        cp_sync(join(root, part), join(copy, part), { recursive: true });
    const run = (file, isPage) => {
        const result = isPage
            ? spawn_sync(process.execPath, [join(copy, "tests/glbridge/gl_multipass_browser_runner.js"), file],
                { encoding: "utf8", timeout: 600000, env: { ...process.env, GL_TIMEOUT_MS: "300000" } })
            : spawn_sync(process.execPath, [join(copy, "tests/glbridge", file)], { encoding: "utf8", timeout: 300000 });
        return result.status === 0;
    };
    for(const [name, set] of Object.entries(MUTATIONS)) {
        if(family && family !== name) continue;
        const suites = [...set.node.map(f => [f, false]), ...(node_only ? [] : set.pages.map(p => [p, true]))];
        let killed = 0, applied = 0;
        for(const [label, file, from, to] of set.list) {
            if(filter && !label.includes(filter)) continue;
            const path = join(copy, file);
            const original = read_file_sync(path, "utf8");
            const matches = original.split(from).length - 1;
            if(matches !== 1) {
                console.log("STALE    " + name + ": " + label + " (" + matches + " matches: update the mutation)");
                continue;
            }
            write_file_sync(path, original.replace(from, to));
            ++applied;
            const killers = [];
            try {
                for(const [suite, isPage] of suites) if(!run(suite, isPage)) killers.push(suite);
            } finally {
                write_file_sync(path, original);
            }
            if(killers.length) ++killed;
            console.log((killers.length ? "KILLED   " : "SURVIVED ") + name + ": " + label.padEnd(44) + killers.join(","));
        }
        const rate = applied ? killed / applied : 1;
        console.log(name + ": " + killed + "/" + applied + " killed" + (filter ? "" : ", floor " + Math.round(set.floor * 100) + "%"));
        if(!filter && rate < set.floor) below_floor = true;
    }
} finally {
    rm_sync(copy, { recursive: true, force: true });
}
process.exitCode = below_floor ? 1 : 0;
