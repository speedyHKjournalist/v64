// The shader IR (dxbc_frontend.js) as WGSL (plan 4.6).
//
// The register files are arrays of raw 32-bit lanes (vec4<u32>): DXBC
// registers have no type, each instruction says how it reads them, so every
// read is a bitcast to the instruction's type and every write a bitcast
// back. Temps, inputs and outputs are private arrays, so relative indexing
// and subroutines (label/call) need nothing special; the entry point copies
// the stage's inputs in, calls shader_main() and copies the outputs out.
//
// The interfaces depend on the pipeline, not only on the shader, and the
// caller says how (options):
//   vertexInputs: register -> "f32" | "i32" | "u32", from the input
//       layout's formats (WebGPU types vertex attributes)
//   varyings: register -> { type: "f32" | "u32", interpolation, sampling },
//       from the pixel shader's declarations, for the vertex shader's
//       outputs (WebGPU wants both stages to agree)
//   targets: render target -> "f32" | "i32" | "u32" (absent: no target)
//   dualSource: the blend state reads the second color (SRC1_*)
//   group: the bind group of this stage
//
// Bindings in the group: constant buffer n at n (0-14), the draw
// parameters at 15, sampler n at 16 + n, resource n at 32 + n, UAV n at
// 160 + n, its append/consume counter at 300 + n, and at 299 where the
// buffer views start (GXViews). emit() returns them, for the bind group
// layout. options.uavFormats: { slot: { format, lanes } }, a typed UAV's
// view: the storage texture format, or a typed buffer's 32-bit lanes.
//
// Geometry shaders have no WebGPU stage, so a draw with one runs its
// vertex and geometry shaders as compute shaders (options.mode):
//   "vertex-compute": a vertex shader that pulls its inputs from the vertex
//       buffers (vertex buffer n at 200 + n, read as words; options.fetch:
//       [{ reg, slot, offset, format, instanced }]), the indices at 231 and
//       the draw at 230 (GXFetch), and stores each vertex's outputs (a
//       record of `record` vec4s) at 233
//   "geometry": a geometry shader, one invocation per input primitive (and
//       instance): its vertices come from the vertex shader's records at
//       232 (GXGeo at 234 says how many, the topology and the record
//       size), and what it emits goes to 233 as primitives of the output
//       topology, maxPrims slots of each per input primitive, a record of
//       outputs + 1 vec4s each (the last: 1 if the slot is used)
(function(global) {
    "use strict";

    const F = (typeof require === "function" && typeof module === "object") ?
        require("./dxbc_frontend.js") : global.V86DXBCFrontend;
    const { OP, OPERAND, NAME, INTERPOLATION, DIM, RETURN, PROGRAM, VMWARE_OP } = F;

    class ShaderTranslateError extends Error {}

    const BINDING = { CB: 0, DRAW: 15, SAMPLER: 16, RESOURCE: 32, UAV: 160, VB: 200, FETCH: 230, INDEX: 231,
        STAGE_IN: 232, STAGE_OUT: 233, GEO: 234, TESS_POINTS: 235, TESS_ARGS: 236, VIEWS: 299, UAV_COUNTER: 300 };
    // the markers that begin a hull shader's phases
    const HS_PHASE_MARKERS = new Set([OP.HS_DECLS, OP.HS_CONTROL_POINT_PHASE, OP.HS_FORK_PHASE, OP.HS_JOIN_PHASE]);
    // where each tess factor goes among the tessellator's six (tessellator_wgsl.js)
    const TESS_FACTOR_SLOT = { [NAME.FINAL_QUAD_U_EQ_0_EDGE_TESSFACTOR]: 0, [NAME.FINAL_QUAD_V_EQ_0_EDGE_TESSFACTOR]: 1,
        [NAME.FINAL_QUAD_U_EQ_1_EDGE_TESSFACTOR]: 2, [NAME.FINAL_QUAD_V_EQ_1_EDGE_TESSFACTOR]: 3,
        [NAME.FINAL_QUAD_U_INSIDE_TESSFACTOR]: 4, [NAME.FINAL_QUAD_V_INSIDE_TESSFACTOR]: 5,
        [NAME.FINAL_TRI_U_EQ_0_EDGE_TESSFACTOR]: 0, [NAME.FINAL_TRI_V_EQ_0_EDGE_TESSFACTOR]: 1,
        [NAME.FINAL_TRI_W_EQ_0_EDGE_TESSFACTOR]: 2, [NAME.FINAL_TRI_INSIDE_TESSFACTOR]: 3,
        [NAME.FINAL_LINE_DENSITY_TESSFACTOR]: 0, [NAME.FINAL_LINE_DETAIL_TESSFACTOR]: 1 };
    // where a buffer view starts, in words, in GXViews: UAV n at n, resource n at 64 + n
    const VIEW_BASE_UAV = 0, VIEW_BASE_RESOURCE = 64, VIEW_BASES = 192;
    // vertices of a GS input primitive (D3D10_SB_PRIMITIVE): point, line, triangle, line_adj, triangle_adj
    const GS_INPUT_VERTICES = { 1: 1, 2: 2, 3: 3, 6: 4, 7: 6 };
    const LANES = "xyzw";
    const ALL = 0xF;

    function u32(value) {
        return (value >>> 0) + "u";
    }

    /**
     * @param program decoded by dxbc_frontend.decode
     * @param options see above
     * @return { code, bindings: [{ binding, type, ... }], usesDraw, inputs, outputs, warnings }
     */
    function emit(program, options) {
        options = options || {};
        const e = new Emitter(program, options);
        return e.run();
    }

    class Emitter {
        constructor(program, options) {
            this.p = program;
            this.o = options;
            this.stage = program.type;
            this.group = options.group || 0;
            this.lines = [];
            this.indent = 1;
            this.helpers = new Set();
            this.warnings = [];
            this.usesDraw = false;
            this.usesSamples = false;
            // resources used for comparison: they are depth textures
            this.compared = new Set();
            this.gathered = new Set();
            this.counters = new Set();
            this.uavLoads = new Set();
            // whether a buffer view's start is read from GXViews
            this.usesViews = false;
            this.temps = Math.max(1, program.temps);
            this.inputCount = 1;
            this.outputCount = 1;
            this.switches = [];
            this.needDepth = false;
            this.needMask = false;
            this.mode = options.mode || "";
        }

        warn(text) {
            if (!this.warnings.includes(text)) this.warnings.push(text);
        }

        line(text) {
            this.lines.push("    ".repeat(this.indent) + text);
        }

        run() {
            const p = this.p;
            const geometry = this.mode === "geometry" && this.stage === PROGRAM.GS;
            const hull = this.mode === "hull" && this.stage === PROGRAM.HS;
            const domain = this.mode === "domain" && this.stage === PROGRAM.DS;
            if (this.stage !== PROGRAM.VS && this.stage !== PROGRAM.PS && this.stage !== PROGRAM.CS && !geometry && !hull && !domain) {
                throw new ShaderTranslateError(p.stage + " shaders are emulated elsewhere");
            }
            if (hull) this.hull = this.hullLayout();
            if (domain) this.domain = this.domainLayout();
            if (geometry) {
                const g = p.gs;
                this.gsVertices = GS_INPUT_VERTICES[g.input] || 0;
                if (!this.gsVertices) throw new ShaderTranslateError("geometry shader input primitive " + g.input);
                // the output topology (D3D10_SB_PRIMITIVE_TOPOLOGY): point list 1, line strip 3, triangle strip 5
                this.gsOutput = g.outputTopology === 1 ? "point-list" : g.outputTopology === 3 ? "line-list" : "triangle-list";
                this.gsPerPrim = this.gsOutput === "point-list" ? 1 : this.gsOutput === "line-list" ? 2 : 3;
                const max = Math.max(1, g.maxVertices);
                this.gsMaxPrims = this.gsOutput === "point-list" ? max : Math.max(1, max - this.gsPerPrim + 1);
            }
            for (const input of p.inputs) if (input.type === OPERAND.INPUT) this.inputCount = Math.max(this.inputCount, inputRegister(input) + 1);
            for (const output of p.outputs) if (output.type === OPERAND.OUTPUT) this.outputCount = Math.max(this.outputCount, output.index + 1);
            this.scanUsage();

            // the body first: it says which helpers are needed
            const [main, labels] = hull ? [[], []] : this.split();
            const functions = [];
            for (const [label, code] of labels) {
                this.lines = [];
                this.indent = 1;
                this.body(code);
                functions.push("fn label" + label + "() {\n" + this.lines.join("\n") + "\n}\n");
            }
            // a hull shader: a function per phase
            if (hull) {
                p.tess.phases.forEach((phase, k) => {
                    if (phase.kind === "decls") return;
                    this.hsPhase = phase.kind;
                    this.lines = [];
                    this.indent = 1;
                    this.body(p.code.filter(ins => ins.phase === k && !HS_PHASE_MARKERS.has(ins.op)));
                    functions.push(`fn hs_phase${k}() {\n` + this.lines.join("\n") + "\n}\n");
                });
                this.hsPhase = null;
            }
            this.lines = [];
            this.indent = 1;
            this.body(main);
            const mainBody = this.lines.join("\n");

            // the entry point before the declarations: it says whether the draw parameters are read
            const entry = this.entryPoint();
            const out = [];
            out.push("diagnostic(off, derivative_uniformity);");
            if (this.stage === PROGRAM.PS && this.o.dualSource) out.push("enable dual_source_blending;");
            out.push("");
            out.push(...this.declarations());
            if (this.usesSamples) out.push("override gx_samples: u32 = 1u;");
            out.push(...this.helperCode());
            out.push(...functions);
            out.push("fn shader_main() {\n" + mainBody + "\n}\n");
            out.push(entry);
            return {
                code: out.join("\n"),
                bindings: this.bindings,
                usesDraw: this.usesDraw,
                // the override constant gx_samples: the pipeline's sample count
                usesSamples: this.usesSamples,
                warnings: this.warnings,
                stage: p.stage,
                // a compute variant's records: vec4s per vertex, and a geometry shader's output
                record: this.mode === "geometry" ? this.outputCount + 1 : this.mode === "hull" ? this.hull.record : this.outputCount,
                // a hull shader's records: its control points, patch constants and tess factors
                hull: this.hull || null,
                gs: this.mode === "geometry" ? { vertices: this.gsVertices, topology: this.gsOutput,
                    perPrim: this.gsPerPrim, maxPrims: this.gsMaxPrims } : null,
            };
        }

        /** Which resources are compared or gathered: their WGSL types depend on it */
        scanUsage() {
            for (const ins of this.p.code) {
                switch (ins.op) {
                    case OP.SAMPLE_C: case OP.SAMPLE_C_LZ: case OP.GATHER4_C: case OP.GATHER4_PO_C: {
                        const r = ins.op === OP.GATHER4_PO_C ? ins.src[2] : ins.src[1];
                        if (r) this.compared.add(r.indices[0].imm);
                        break;
                    }
                    // UAVs with an append/consume counter, typed UAVs read
                    case OP.IMM_ATOMIC_ALLOC: case OP.IMM_ATOMIC_CONSUME:
                        if (ins.src[0]) this.counters.add(ins.src[0].indices[0].imm);
                        break;
                    case OP.LD_UAV_TYPED:
                        if (ins.src[1]) this.uavLoads.add(ins.src[1].indices[0].imm);
                        break;
                }
            }
        }

        /** The main program and the subroutines (label n ... ret) after it */
        split() {
            const code = this.p.code;
            const first = code.findIndex(i => i.op === OP.LABEL);
            if (first < 0) return [code, []];
            const labels = [];
            let at = first;
            while (at < code.length) {
                const label = code[at].src[0].indices[0].imm;
                let end = at + 1;
                while (end < code.length && code[end].op !== OP.LABEL) end++;
                labels.push([label, code.slice(at + 1, end)]);
                at = end;
            }
            return [code.slice(0, first), labels];
        }

        // ---------------------------------------------------------------
        // Declarations

        declarations() {
            const p = this.p, g = this.group, out = [];
            this.bindings = [];
            for (const [slot, cb] of p.cbuffers) {
                const size = Math.max(1, Math.min(cb.size, 4096));
                out.push(`@group(${g}) @binding(${BINDING.CB + slot}) var<uniform> cb${slot}: array<vec4<u32>, ${size}>;`);
                this.bindings.push({ binding: BINDING.CB + slot, type: "uniform", slot, size: size * 16 });
            }
            if (this.usesDraw) {
                // viewport: (scale x, scale y, offset x, offset y) applied to
                // the position, for viewports WebGPU would not take as they are
                out.push("struct GXDraw { base_vertex: u32, base_instance: u32, pad0: u32, pad1: u32, viewport: vec4<f32> }");
                out.push(`@group(${g}) @binding(${BINDING.DRAW}) var<uniform> gx_draw: GXDraw;`);
                this.bindings.push({ binding: BINDING.DRAW, type: "draw" });
            }
            for (const [slot, s] of p.samplers) {
                const comparison = s.mode === 1;
                out.push(`@group(${g}) @binding(${BINDING.SAMPLER + slot}) var s${slot}: ${comparison ? "sampler_comparison" : "sampler"};`);
                this.bindings.push({ binding: BINDING.SAMPLER + slot, type: comparison ? "comparison" : "sampler", slot });
            }
            for (const [slot, r] of p.resources) {
                const type = this.resourceType(slot, r);
                out.push(`@group(${g}) @binding(${BINDING.RESOURCE + slot}) var t${slot}: ${type.wgsl};`);
                this.bindings.push({ binding: BINDING.RESOURCE + slot, slot, ...type.binding });
            }
            if (p.uavs.size && this.stage === PROGRAM.VS && !this.mode) this.warn("vertex shader UAVs are not supported");
            for (const [slot, u] of p.uavs) {
                if (u.kind === "typed" && u.dimension !== DIM.BUFFER) {
                    out.push(this.storageTexture(g, slot, u));
                    continue;
                }
                // raw, structured and typed buffers: 32-bit words
                const lanes = u.kind === "typed" ? ((this.o.uavFormats || {})[slot] || {}).lanes || 1 : 0;
                out.push(`@group(${g}) @binding(${BINDING.UAV + slot}) var<storage, read_write> u${slot}: array<atomic<u32>>;`);
                this.bindings.push({ binding: BINDING.UAV + slot, slot, type: "uav", kind: u.kind, stride: u.stride || 0, lanes });
                if (this.counters.has(slot)) {
                    out.push(`@group(${g}) @binding(${BINDING.UAV_COUNTER + slot}) var<storage, read_write> uc${slot}: atomic<u32>;`);
                    this.bindings.push({ binding: BINDING.UAV_COUNTER + slot, slot, type: "uav-counter" });
                }
            }
            for (const [slot, t] of p.tgsm) {
                out.push(`var<workgroup> g${slot}: array<atomic<u32>, ${Math.max(1, Math.ceil(t.bytes / 4))}>;`);
            }
            if (p.icb) {
                const n = p.icb.length >> 2;
                const items = [];
                for (let i = 0; i < n; i++) items.push(`vec4<u32>(${[0, 1, 2, 3].map(c => u32(p.icb[4 * i + c])).join(", ")})`);
                out.push(`var<private> icb: array<vec4<u32>, ${Math.max(1, n)}> = array<vec4<u32>, ${Math.max(1, n)}>(${items.join(", ") || "vec4<u32>()"});`);
            }
            out.push(`var<private> r: array<vec4<u32>, ${this.temps}>;`);
            for (const [index, x] of p.indexable) out.push(`var<private> x${index}: array<vec4<u32>, ${Math.max(1, x.size)}>;`);
            if (this.mode === "geometry") {
                out.push(`var<private> v: array<array<vec4<u32>, ${this.inputCount}>, ${this.gsVertices}>;`);
            } else {
                out.push(`var<private> v: array<vec4<u32>, ${this.inputCount}>;`);
            }
            out.push(`var<private> o: array<vec4<u32>, ${this.outputCount}>;`);
            if (this.mode === "vertex-compute") out.push(...this.fetchDeclarations());
            if (this.mode === "hull") out.push(...this.hullDeclarations());
            if (this.mode === "domain") out.push(...this.domainDeclarations());
            if (this.mode === "geometry") out.push(...this.geometryDeclarations());
            if (this.stage === PROGRAM.PS) {
                out.push("var<private> odepth: u32;");
                out.push("var<private> omask: u32 = 0xFFFFFFFFu;");
                out.push("var<private> prim_id: u32;");
                // which sample of a supersampled target a fragment is
                out.push("var<private> gx_sample: u32;");
                // set by GX per pipeline: whether the target is multisampled
                // (supersampled), the sample mask, alpha to coverage
                out.push("override gx_ss: u32 = 0u;");
                out.push("override gx_sample_mask: u32 = 0xFFFFFFFFu;");
                out.push("override gx_a2c: u32 = 0u;");
            }
            if (this.usesViews) {
                out.push(`struct GXViews { base: array<vec4<u32>, ${VIEW_BASES / 4}> }`);
                out.push(`@group(${g}) @binding(${BINDING.VIEWS}) var<uniform> gx_views: GXViews;`);
                out.push("fn gx_view_base(i: u32) -> u32 { return gx_views.base[i >> 2u][i & 3u]; }");
                this.bindings.push({ binding: BINDING.VIEWS, type: "views" });
            }
            if (this.stage === PROGRAM.CS) {
                out.push("var<private> cs_thread: vec3<u32>;");
                out.push("var<private> cs_group: vec3<u32>;");
                out.push("var<private> cs_local: vec3<u32>;");
                out.push("var<private> cs_flat: u32;");
            }
            out.push("");
            return out;
        }

        /** The WGSL type of a resource, and its binding */
        resourceType(slot, r) {
            if (r.kind === "raw" || r.kind === "structured") {
                return { wgsl: "array<u32>", binding: { type: "read-storage", kind: r.kind, stride: r.stride || 0 } };
            }
            const ret = r.returnTypes ? r.returnTypes[0] : RETURN.FLOAT;
            const scalar = ret === RETURN.SINT ? "i32" : ret === RETURN.UINT ? "u32" : "f32";
            const sampleType = ret === RETURN.SINT ? "sint" : ret === RETURN.UINT ? "uint" : "float";
            const depth = this.compared.has(slot);
            if (depth && scalar !== "f32") this.warn("comparison on an integer texture");
            let wgsl, dimension, multisampled = false;
            switch (r.dimension) {
                case DIM.BUFFER:
                    // typed buffers: elements of 32-bit lanes; the format is applied when read
                    return { wgsl: "array<u32>", binding: { type: "read-storage", kind: "typed", returnType: ret } };
                case DIM.TEXTURE1D:
                case DIM.TEXTURE2D:
                    // (1D textures are 2D ones of one row: WebGPU's 1D ones have no mips)
                    wgsl = depth ? "texture_depth_2d" : `texture_2d<${scalar}>`; dimension = "2d"; break;
                case DIM.TEXTURE1DARRAY:
                case DIM.TEXTURE2DARRAY:
                    wgsl = depth ? "texture_depth_2d_array" : `texture_2d_array<${scalar}>`; dimension = "2d-array"; break;
                // GX keeps multisampled surfaces supersampled: each sample a
                // texel of a texture twice as wide and high (gx_ms_texel)
                case DIM.TEXTURE2DMS:
                    wgsl = depth ? "texture_depth_2d" : `texture_2d<${scalar}>`; dimension = "2d"; break;
                case DIM.TEXTURE2DMSARRAY:
                    wgsl = depth ? "texture_depth_2d_array" : `texture_2d_array<${scalar}>`; dimension = "2d-array"; break;
                case DIM.TEXTURE3D:
                    wgsl = `texture_3d<${scalar}>`; dimension = "3d"; break;
                case DIM.TEXTURECUBE:
                    wgsl = depth ? "texture_depth_cube" : `texture_cube<${scalar}>`; dimension = "cube"; break;
                case DIM.TEXTURECUBEARRAY:
                    wgsl = depth ? "texture_depth_cube_array" : `texture_cube_array<${scalar}>`; dimension = "cube-array"; break;
                default:
                    throw new ShaderTranslateError("resource dimension " + r.dimension);
            }
            return { wgsl, binding: { type: "texture", dimension, sampleType: depth ? "depth" : sampleType, multisampled,
                one: r.dimension === DIM.TEXTURE1D || r.dimension === DIM.TEXTURE1DARRAY } };
        }

        // ---------------------------------------------------------------
        // Entry points

        entryPoint() {
            if (this.mode === "vertex-compute") return this.vertexComputeEntry();
            if (this.mode === "geometry") return this.geometryEntry();
            if (this.mode === "hull") return this.hullEntry();
            if (this.mode === "domain") return this.domainEntry();
            switch (this.stage) {
                case PROGRAM.VS: return this.vertexEntry();
                case PROGRAM.PS: return this.fragmentEntry();
                case PROGRAM.CS: return this.computeEntry();
            }
            return "";
        }

        vertexEntry() {
            const p = this.p, o = this.o;
            const inputs = [], loads = [];
            let needVertex = false, needInstance = false;
            for (const input of p.inputs) {
                if (input.type !== OPERAND.INPUT) continue;
                const reg = inputRegister(input);
                if (input.name === NAME.VERTEX_ID) {
                    needVertex = true;
                    this.usesDraw = true;
                    loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, "vec4<u32>(vid - gx_draw.base_vertex)", input.mask)};`);
                } else if (input.name === NAME.INSTANCE_ID) {
                    needInstance = true;
                    this.usesDraw = true;
                    loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, "vec4<u32>(iid - gx_draw.base_instance)", input.mask)};`);
                } else {
                    const type = (o.vertexInputs && o.vertexInputs[reg]) || null;
                    if (!type) {
                        // not in the input layout: D3D reads zeros
                        continue;
                    }
                    if (inputs.some(i => i.reg === reg)) continue;
                    inputs.push({ reg, type });
                    loads.push(`v[${reg}] = bitcast<vec4<u32>>(input.a${reg});`);
                }
            }
            const fields = inputs.map(i => `    @location(${i.reg}) a${i.reg}: vec4<${i.type}>,`);
            if (needVertex) fields.push("    @builtin(vertex_index) vid: u32,");
            if (needInstance) fields.push("    @builtin(instance_index) iid: u32,");
            const outFields = [], stores = [];
            let position = null;
            for (const output of p.outputs) {
                if (output.type !== OPERAND.OUTPUT) continue;
                if (output.name === NAME.POSITION) position = output.index;
            }
            outFields.push("    @builtin(position) position: vec4<f32>,");
            this.usesDraw = true;
            stores.push(position === null ? "out.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);" :
                `let p = bitcast<vec4<f32>>(o[${position}]);\n    out.position = vec4<f32>(p.xy * gx_draw.viewport.xy + gx_draw.viewport.zw * p.w, p.zw);`);
            // the varyings the pixel shader reads, as it declares them
            const varyings = o.varyings || defaultVaryings(p);
            for (const reg of Object.keys(varyings).map(Number).sort((a, b) => a - b)) {
                const vary = varyings[reg];
                const type = vary.type === "u32" ? "u32" : "f32";
                outFields.push(`    ${interpolationAttribute(vary, type)}@location(${reg}) o${reg}: vec4<${type}>,`);
                const value = reg < this.outputCount && reg !== position ? `o[${reg}]` : "vec4<u32>()";
                stores.push(type === "u32" ? `out.o${reg} = ${value};` : `out.o${reg} = bitcast<vec4<f32>>(${value});`);
            }
            const struct_in = fields.length ? `struct VSIn {\n${fields.join("\n")}\n}\n` : "";
            return struct_in +
                `struct VSOut {\n${outFields.join("\n")}\n}\n` +
                `@vertex fn main(${fields.length ? "input: VSIn" : ""}) -> VSOut {\n` +
                (needVertex ? "    let vid = input.vid;\n" : "") + (needInstance ? "    let iid = input.iid;\n" : "") +
                loads.map(l => "    " + l).join("\n") + "\n" +
                "    shader_main();\n    var out: VSOut;\n" +
                stores.map(s => "    " + s).join("\n") + "\n    return out;\n}\n";
        }

        /**
         * The pixel shader's entry point. Into a multisampled target (GX
         * supersamples them, gx_ss 1) each fragment is a sample: its index
         * comes from the position, the position is the pixel's again, and
         * the sample mask, alpha to coverage and oMask discard the samples
         * they leave out.
         */
        fragmentEntry() {
            const p = this.p, o = this.o;
            // (the position always: it says which sample a fragment is)
            const fields = ["    @builtin(position) position: vec4<f32>,"], loads = [];
            const seen = new Set();
            // per-sample shading sees the sample's position, else the pixel's center
            const perSample = p.inputs.some(i => i.type === OPERAND.INPUT && (i.name === NAME.SAMPLE_INDEX ||
                i.interpolation === INTERPOLATION.LINEAR_SAMPLE || i.interpolation === INTERPOLATION.LINEAR_NOPERSPECTIVE_SAMPLE));
            for (const input of p.inputs) {
                const reg = inputRegister(input);
                if (input.type === OPERAND.INPUT_PRIMITIVEID) continue;
                if (input.type === OPERAND.INPUT_COVERAGE_MASK) continue;
                if (input.type !== OPERAND.INPUT) continue;
                switch (input.name) {
                    case NAME.POSITION: {
                        const pixel = perSample ? "input.position.xy * 0.5" : "floor(input.position.xy * 0.5) + 0.5";
                        const position = `vec4<f32>(select(input.position.xy, ${pixel}, gx_ss != 0u), input.position.zw)`;
                        loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, `bitcast<vec4<u32>>(${position})`, input.mask)};`);
                        continue;
                    }
                    case NAME.IS_FRONT_FACE:
                        fields.push("    @builtin(front_facing) front: bool,");
                        loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, "vec4<u32>(select(0u, 0xFFFFFFFFu, input.front))", input.mask)};`);
                        continue;
                    case NAME.SAMPLE_INDEX:
                        loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, "vec4<u32>(gx_sample)", input.mask)};`);
                        continue;
                    case NAME.PRIMITIVE_ID:
                        loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, "vec4<u32>(0u)", input.mask)};`);
                        continue;
                    case NAME.CLIP_DISTANCE:
                    case NAME.CULL_DISTANCE:
                    case NAME.RENDER_TARGET_ARRAY_INDEX:
                    case NAME.VIEWPORT_ARRAY_INDEX:
                        loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, "vec4<u32>(0u)", input.mask)};`);
                        continue;
                }
                if (seen.has(reg)) continue;
                seen.add(reg);
                const vary = varyingOf(input);
                const type = vary.type;
                fields.push(`    ${interpolationAttribute(vary, type)}@location(${reg}) i${reg}: vec4<${type}>,`);
                loads.push(type === "u32" ? `v[${reg}] = input.i${reg};` : `v[${reg}] = bitcast<vec4<u32>>(input.i${reg});`);
            }
            const outFields = [], stores = [];
            const targets = o.targets || { 0: "f32" };
            for (const index of Object.keys(targets).map(Number).sort((a, b) => a - b)) {
                const type = targets[index];
                if (!type) continue;
                const value = index < this.outputCount ? `o[${index}]` : "vec4<u32>()";
                if (o.dualSource && index === 0) {
                    outFields.push(`    @location(0) @blend_src(0) c0: vec4<${type}>,`);
                    outFields.push(`    @location(0) @blend_src(1) c1: vec4<${type}>,`);
                    stores.push(`out.c0 = ${fromBits(value, type)};`);
                    stores.push(`out.c1 = ${fromBits(this.outputCount > 1 ? "o[1]" : "vec4<u32>()", type)};`);
                    break;
                }
                outFields.push(`    @location(${index}) c${index}: vec4<${type}>,`);
                stores.push(`out.c${index} = ${fromBits(value, type)};`);
            }
            for (const output of p.outputs) {
                if (output.type === OPERAND.OUTPUT_DEPTH || output.type === OPERAND.OUTPUT_DEPTH_GREATER_EQUAL ||
                    output.type === OPERAND.OUTPUT_DEPTH_LESS_EQUAL) {
                    outFields.push("    @builtin(frag_depth) depth: f32,");
                    stores.push("out.depth = bitcast<f32>(odepth);");
                }
            }
            // the samples left out
            const discards = [];
            if (p.outputs.some(output => output.type === OPERAND.OUTPUT_COVERAGE_MASK)) discards.push("((omask >> gx_sample) & 1u) == 0u");
            discards.push("((gx_sample_mask >> gx_sample) & 1u) == 0u");
            if (targets[0] === "f32" && this.outputCount > 0) {
                discards.push("gx_ss != 0u && gx_a2c != 0u && bitcast<f32>(o[0].w) < (f32(gx_sample) + 0.5) * 0.25");
            }
            const struct_in = `struct PSIn {\n${fields.join("\n")}\n}\n`;
            const struct_out = outFields.length ? `struct PSOut {\n${outFields.join("\n")}\n}\n` : "";
            return struct_in + struct_out +
                `@fragment fn main(input: PSIn)${outFields.length ? " -> PSOut" : ""} {\n` +
                "    gx_sample = select(0u, (u32(input.position.x) & 1u) | ((u32(input.position.y) & 1u) << 1u), gx_ss != 0u);\n" +
                loads.map(l => "    " + l).join("\n") + "\n" +
                "    shader_main();\n" +
                `    if (${discards.map(d => "(" + d + ")").join(" || ")}) { discard; }\n` +
                (outFields.length ? "    var out: PSOut;\n" + stores.map(s => "    " + s).join("\n") + "\n    return out;\n" : "") +
                "}\n";
        }

        computeEntry() {
            const [x, y, z] = this.p.threadGroup;
            return `@compute @workgroup_size(${x}, ${y}, ${z}) fn main(@builtin(global_invocation_id) gid: vec3<u32>, ` +
                `@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, ` +
                `@builtin(local_invocation_index) lindex: u32) {\n` +
                "    cs_thread = gid;\n    cs_group = wid;\n    cs_local = lid;\n    cs_flat = lindex;\n" +
                "    shader_main();\n}\n";
        }

        // ---------------------------------------------------------------
        // Compute variants: a vertex shader that pulls its vertices, and a
        // geometry shader (see the top of this file)

        fetchDeclarations() {
            const g = this.group, out = [];
            out.push("struct GXFetch { count: u32, first: u32, base: i32, indexed: u32, instances: u32, first_instance: u32, " +
                "index16: u32, index_offset: u32, vb: array<vec4<u32>, 16> }");
            out.push(`@group(${g}) @binding(${BINDING.FETCH}) var<uniform> gx_fetch: GXFetch;`);
            out.push(`@group(${g}) @binding(${BINDING.INDEX}) var<storage, read> gx_index: array<u32>;`);
            out.push(`@group(${g}) @binding(${BINDING.STAGE_OUT}) var<storage, read_write> gx_out: array<vec4<u32>>;`);
            this.bindings.push({ binding: BINDING.FETCH, type: "fetch" });
            this.bindings.push({ binding: BINDING.INDEX, type: "index" });
            this.bindings.push({ binding: BINDING.STAGE_OUT, type: "stage-out" });
            const slots = [...new Set((this.o.fetch || []).map(f => f.slot))].sort((a, b) => a - b);
            for (const slot of slots) {
                out.push(`@group(${g}) @binding(${BINDING.VB + slot}) var<storage, read> vb${slot}: array<u32>;`);
                this.bindings.push({ binding: BINDING.VB + slot, type: "vertex-buffer", slot });
                // a word at any byte
                out.push(`fn vbword${slot}(byte: u32) -> u32 { let w = byte >> 2u; let s = (byte & 3u) * 8u;\n` +
                    `    if (s == 0u) { return vb${slot}[w]; }\n    return (vb${slot}[w] >> s) | (vb${slot}[w + 1u] << (32u - s)); }`);
            }
            out.push("fn gx_sext(value: u32, bits: u32) -> u32 { return u32(i32(value << (32u - bits)) >> (32u - bits)); }");
            out.push("fn gx_unorm(value: u32, bits: u32) -> u32 { return bitcast<u32>(f32(value) / f32((1u << bits) - 1u)); }");
            out.push("fn gx_snorm(value: u32, bits: u32) -> u32 { let v = i32(value << (32u - bits)) >> (32u - bits);\n" +
                "    return bitcast<u32>(max(f32(v) / f32((1u << (bits - 1u)) - 1u), -1.0)); }");
            out.push("fn gx_uf(value: u32, mantissa: u32) -> u32 { let e = value >> mantissa; let m = value & ((1u << mantissa) - 1u);\n" +
                "    if (e == 0u) { return bitcast<u32>(f32(m) * exp2(-14.0 - f32(mantissa))); }\n" +
                "    if (e == 31u) { return select(0x7F800000u, 0x7FC00000u, m != 0u); }\n" +
                "    return bitcast<u32>((1.0 + f32(m) / f32(1u << mantissa)) * exp2(f32(e) - 15.0)); }");
            out.push("");
            return out;
        }

        /** An input element's value, from its bytes at `byte` in its slot, as vec4<u32> lanes */
        fetchValue(format, slot) {
            const word = at => `vbword${slot}(byte + ${at}u)`;
            const ONE = "0x3F800000u";
            const pad = (lanes, n, one) => { while (lanes.length < 4) lanes.push(lanes.length === 3 ? one : "0u"); return `vec4<u32>(${lanes.join(", ")})`; };
            if (format === "unorm10-10-10-2") {
                return `vec4<u32>(gx_unorm(${word(0)} & 0x3FFu, 10u), gx_unorm((${word(0)} >> 10u) & 0x3FFu, 10u), ` +
                    `gx_unorm((${word(0)} >> 20u) & 0x3FFu, 10u), gx_unorm(${word(0)} >> 30u, 2u))`;
            }
            if (format === "pull:uint10-10-10-2") {
                return `vec4<u32>(${word(0)} & 0x3FFu, (${word(0)} >> 10u) & 0x3FFu, (${word(0)} >> 20u) & 0x3FFu, ${word(0)} >> 30u)`;
            }
            if (format === "pull:unorm8x4-bgrx") {
                return `vec4<u32>(gx_unorm((${word(0)} >> 16u) & 0xFFu, 8u), gx_unorm((${word(0)} >> 8u) & 0xFFu, 8u), ` +
                    `gx_unorm(${word(0)} & 0xFFu, 8u), ${ONE})`;
            }
            if (format === "pull:ufloat11-11-10") {
                return `vec4<u32>(gx_uf(${word(0)} & 0x7FFu, 6u), gx_uf((${word(0)} >> 11u) & 0x7FFu, 6u), gx_uf(${word(0)} >> 22u, 5u), ${ONE})`;
            }
            const m = /^(float|unorm|snorm|uint|sint)(8|16|32)(?:x(\d))?(-bgra)?$/.exec(format);
            if (!m) {
                this.warn("vertex format " + format + " is read as zeros");
                return "vec4<u32>(0u, 0u, 0u, 0u)";
            }
            const kind = m[1], bits = +m[2], count = m[3] ? +m[3] : 1;
            const integer = kind === "uint" || kind === "sint";
            const one = integer ? "1u" : ONE;
            const lanes = [];
            for (let c = 0; c < count; c++) {
                const bit = c * bits;
                const raw = bits === 32 ? word(4 * c) : `((${word(bit >> 5 << 2)} >> ${bit & 31}u) & ${(2 ** bits - 1) >>> 0}u)`;
                if (kind === "float") lanes.push(bits === 32 ? raw : `bitcast<u32>(unpack2x16float(${raw}).x)`);
                else if (kind === "uint") lanes.push(raw);
                else if (kind === "sint") lanes.push(bits === 32 ? raw : `gx_sext(${raw}, ${bits}u)`);
                else if (kind === "unorm") lanes.push(`gx_unorm(${raw}, ${bits}u)`);
                else lanes.push(`gx_snorm(${raw}, ${bits}u)`);
            }
            if (m[4]) [lanes[0], lanes[2]] = [lanes[2], lanes[0]];
            return pad(lanes, count, one);
        }

        vertexComputeEntry() {
            const p = this.p, loads = [];
            const fetch = new Map((this.o.fetch || []).map(f => [f.reg, f]));
            for (const input of p.inputs) {
                if (input.type !== OPERAND.INPUT) continue;
                const reg = inputRegister(input);
                if (input.name === NAME.VERTEX_ID) {
                    loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, "vec4<u32>(vid)", input.mask)};`);
                } else if (input.name === NAME.INSTANCE_ID) {
                    loads.push(`v[${reg}] = ${maskInto(`v[${reg}]`, "vec4<u32>(instance)", input.mask)};`);
                } else if (fetch.has(reg)) {
                    const f = fetch.get(reg);
                    const record = f.instanced ? "gx_fetch.first_instance + instance / max(1u, gx_fetch.vb[" + f.slot + "].z)" : "vertex";
                    loads.push(`{ let byte = gx_fetch.vb[${f.slot}].x + (${record}) * gx_fetch.vb[${f.slot}].y + ${f.offset}u;\n` +
                        `        v[${reg}] = ${this.fetchValue(f.format, f.slot)}; }`);
                    fetch.delete(reg);
                }
            }
            const stores = [];
            for (let i = 0; i < this.outputCount; i++) stores.push(`gx_out[at + ${i}u] = o[${i}];`);
            return "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {\n" +
                "    let total = gx_fetch.count * gx_fetch.instances;\n" +
                "    let k = gid.x + gid.y * 65535u * 64u;\n" +
                "    if (k >= total) { return; }\n" +
                "    let instance = k / gx_fetch.count;\n" +
                "    let n = k % gx_fetch.count;\n" +
                "    var vertex = gx_fetch.first + n;\n" +
                "    var vid = vertex;\n" +
                "    if (gx_fetch.indexed != 0u) {\n" +
                "        let byte = gx_fetch.index_offset + (gx_fetch.first + n) * select(4u, 2u, gx_fetch.index16 != 0u);\n" +
                "        var index = gx_index[byte >> 2u];\n" +
                "        if (gx_fetch.index16 != 0u) { index = (index >> ((byte & 2u) * 8u)) & 0xFFFFu; }\n" +
                "        vid = index;\n" +
                "        vertex = u32(i32(index) + gx_fetch.base);\n" +
                "    }\n" +
                loads.map(l => "    " + l).join("\n") + "\n" +
                "    shader_main();\n" +
                `    let at = k * ${this.outputCount}u;\n` +
                stores.map(l => "    " + l).join("\n") + "\n}\n";
        }

        geometryDeclarations() {
            const g = this.group, out = [];
            out.push("struct GXGeo { prims: u32, instances: u32, count: u32, topology: u32, in_record: u32, pad0: u32, pad1: u32, pad2: u32 }");
            out.push(`@group(${g}) @binding(${BINDING.GEO}) var<uniform> gx_geo: GXGeo;`);
            out.push(`@group(${g}) @binding(${BINDING.STAGE_IN}) var<storage, read> gx_in: array<vec4<u32>>;`);
            out.push(`@group(${g}) @binding(${BINDING.STAGE_OUT}) var<storage, read_write> gx_out: array<vec4<u32>>;`);
            this.bindings.push({ binding: BINDING.GEO, type: "geo" });
            this.bindings.push({ binding: BINDING.STAGE_IN, type: "stage-in" });
            this.bindings.push({ binding: BINDING.STAGE_OUT, type: "stage-out" });
            const OUT = this.outputCount, REC = OUT + 1, MAXP = this.gsMaxPrims;
            out.push("var<private> prim_id: u32;");
            out.push(`var<private> gs_s0: array<vec4<u32>, ${OUT}>;`);
            out.push(`var<private> gs_s1: array<vec4<u32>, ${OUT}>;`);
            out.push("var<private> gs_len: u32;");
            out.push("var<private> gs_prims: u32;");
            out.push("var<private> gs_base: u32;");
            out.push(`fn gs_put(slot: u32, value: array<vec4<u32>, ${OUT}>) {\n` +
                `    let at = slot * ${REC}u;\n` +
                `    for (var i = 0u; i < ${OUT}u; i++) { gx_out[at + i] = value[i]; }\n` +
                `    gx_out[at + ${OUT}u] = vec4<u32>(1u, 0u, 0u, 0u);\n}`);
            // what the strip so far makes with this vertex: a triangle of the
            // last three (winding kept), a line of the last two, a point
            let make;
            if (this.gsOutput === "triangle-list") {
                make = "if (gs_len >= 2u) {\n" +
                    "        let at = gs_base + gs_prims * 3u;\n" +
                    "        if ((gs_len & 1u) == 0u) { gs_put(at, gs_s0); gs_put(at + 1u, gs_s1); }\n" +
                    "        else { gs_put(at, gs_s1); gs_put(at + 1u, gs_s0); }\n" +
                    "        gs_put(at + 2u, cur);\n        gs_prims += 1u;\n    }";
            } else if (this.gsOutput === "line-list") {
                make = "if (gs_len >= 1u) { let at = gs_base + gs_prims * 2u; gs_put(at, gs_s1); gs_put(at + 1u, cur); gs_prims += 1u; }";
            } else {
                make = "gs_put(gs_base + gs_prims, cur);\n    gs_prims += 1u;";
            }
            out.push("fn gs_emit() {\n    let cur = o;\n" +
                `    if (gs_prims < ${MAXP}u) {\n    ${make}\n    }\n` +
                "    gs_s0 = gs_s1;\n    gs_s1 = cur;\n    gs_len += 1u;\n}");
            out.push("fn gs_cut() { gs_len = 0u; }");
            // the vertex of an input primitive, by the draw's topology (GXGeo.topology:
            // 1 point list, 2 line list, 3 line strip, 4 triangle list, 5 triangle strip,
            // 10-13 their adjacency kinds)
            out.push("fn gx_vertex(prim: u32, n: u32) -> u32 {\n" +
                "    switch (gx_geo.topology) {\n" +
                "        case 1u: { return prim; }\n" +
                "        case 2u: { return prim * 2u + n; }\n" +
                "        case 3u, 11u: { return prim + n; }\n" +
                "        case 4u: { return prim * 3u + n; }\n" +
                "        case 5u: { if ((prim & 1u) == 1u && n < 2u) { return prim + 1u - n; } return prim + n; }\n" +
                "        case 10u: { return prim * 4u + n; }\n" +
                "        case 12u: { return prim * 6u + n; }\n" +
                "        case 13u: { return prim * 2u + n; }\n" +
                `        default: { return prim * ${this.gsVertices}u + n; }\n` +
                "    }\n}");
            out.push("");
            return out;
        }

        geometryEntry() {
            const p = this.p, NV = this.gsVertices, OUT = this.outputCount, REC = OUT + 1;
            const slots = this.gsMaxPrims * this.gsPerPrim;
            const loads = [];
            for (const input of p.inputs) {
                if (input.type === OPERAND.INPUT_PRIMITIVEID) continue;
                if (input.type !== OPERAND.INPUT) continue;
                if (input.name === NAME.PRIMITIVE_ID) {
                    const reg = inputRegister(input);
                    for (let n = 0; n < NV; n++) loads.push(`v[${n}][${reg}] = vec4<u32>(prim);`);
                }
            }
            return "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {\n" +
                "    let total = gx_geo.prims * gx_geo.instances;\n" +
                "    let k = gid.x + gid.y * 65535u * 64u;\n" +
                "    if (k >= total) { return; }\n" +
                "    let instance = k / gx_geo.prims;\n" +
                "    let prim = k % gx_geo.prims;\n" +
                `    for (var n = 0u; n < ${NV}u; n++) {\n` +
                "        let at = (instance * gx_geo.count + gx_vertex(prim, n)) * gx_geo.in_record;\n" +
                `        for (var reg = 0u; reg < min(${this.inputCount}u, gx_geo.in_record); reg++) { v[n][reg] = gx_in[at + reg]; }\n` +
                "    }\n" +
                loads.map(l => "    " + l).join("\n") + "\n" +
                "    prim_id = prim;\n" +
                `    gs_base = k * ${slots}u;\n` +
                `    for (var i = 0u; i < ${slots}u; i++) { gx_out[(gs_base + i) * ${REC}u + ${OUT}u] = vec4<u32>(); }\n` +
                "    gs_len = 0u;\n    gs_prims = 0u;\n" +
                "    shader_main();\n}\n";
        }

        // ---------------------------------------------------------------
        // Tessellation: hull and domain shaders as compute (see GX's
        // drawTessellated). A hull shader runs once per patch, its phases
        // in order; its record per patch: the output control points
        // (cpRegs vec4s each), the patch constants (pcRegs), then the six
        // tess factors (two vec4s of floats, tessellator_wgsl.js's order). A
        // domain shader runs once per point the tessellator made.

        hullLayout() {
            const p = this.p, t = p.tess;
            const kind = phase => (t.phases[phase] || {}).kind;
            let inRegs = 1, cpRegs = 0, pcRegs = 1;
            for (const input of p.inputs) {
                if (input.type === OPERAND.INPUT_CONTROL_POINT) inRegs = Math.max(inRegs, input.index2 + 1);
            }
            const hasCP = t.phases.some(ph => ph.kind === "cp");
            for (const output of p.outputs) {
                if (output.type !== OPERAND.OUTPUT) continue;
                if (kind(output.phase) === "cp") cpRegs = Math.max(cpRegs, output.index + 1);
                else pcRegs = Math.max(pcRegs, output.index + 1);
            }
            // without a control point phase the input control points pass through
            if (!hasCP) cpRegs = inRegs;
            cpRegs = Math.max(1, cpRegs);
            const inCPs = Math.max(1, t.inputCPs), outCPs = Math.max(1, hasCP ? t.outputCPs : t.outputCPs || t.inputCPs);
            const pcAt = outCPs * cpRegs;
            return { inCPs, outCPs, inRegs, cpRegs, pcRegs, hasCP, pcAt, factorAt: pcAt + pcRegs, record: pcAt + pcRegs + 2,
                domain: t.domain, partitioning: t.partitioning, outputPrimitive: t.outputPrimitive, maxTessFactor: t.maxTessFactor };
        }

        hullDeclarations() {
            const g = this.group, h = this.hull, out = [];
            out.push("struct GXHull { patches: u32, instances: u32, count: u32, in_record: u32 }");
            out.push(`@group(${g}) @binding(${BINDING.GEO}) var<uniform> gx_hull: GXHull;`);
            out.push(`@group(${g}) @binding(${BINDING.STAGE_IN}) var<storage, read> gx_in: array<vec4<u32>>;`);
            out.push(`@group(${g}) @binding(${BINDING.STAGE_OUT}) var<storage, read_write> gx_out: array<vec4<u32>>;`);
            this.bindings.push({ binding: BINDING.GEO, type: "hull" });
            this.bindings.push({ binding: BINDING.STAGE_IN, type: "stage-in" });
            this.bindings.push({ binding: BINDING.STAGE_OUT, type: "stage-out" });
            out.push(`var<private> vicp: array<array<vec4<u32>, ${h.inRegs}>, ${h.inCPs}>;`);
            out.push(`var<private> vocp: array<array<vec4<u32>, ${h.cpRegs}>, ${h.outCPs}>;`);
            out.push(`var<private> opc: array<vec4<u32>, ${h.pcRegs}>;`);
            out.push("var<private> hs_cpid: u32;");
            out.push("var<private> hs_inst: u32;");
            out.push("var<private> prim_id: u32;");
            return out;
        }

        hullEntry() {
            const p = this.p, h = this.hull, phases = p.tess.phases;
            const lines = [];
            lines.push("    let k = gid.x + gid.y * 65535u * 64u;");
            lines.push("    if (k >= gx_hull.patches * gx_hull.instances) { return; }");
            lines.push("    let instance = k / gx_hull.patches;");
            lines.push("    let prim = k % gx_hull.patches;");
            lines.push(`    for (var n = 0u; n < ${h.inCPs}u; n++) {`);
            lines.push(`        let at = (instance * gx_hull.count + prim * ${h.inCPs}u + n) * gx_hull.in_record;`);
            lines.push(`        for (var reg = 0u; reg < min(${h.inRegs}u, gx_hull.in_record); reg++) { vicp[n][reg] = gx_in[at + reg]; }`);
            lines.push("    }");
            lines.push("    prim_id = prim;");
            const cp = phases.findIndex(ph => ph.kind === "cp");
            lines.push(`    for (var cp = 0u; cp < ${h.outCPs}u; cp++) {`);
            lines.push("        hs_cpid = cp;");
            if (cp >= 0) {
                lines.push(`        for (var reg = 0u; reg < ${this.outputCount}u; reg++) { o[reg] = vec4<u32>(); }`);
                lines.push(`        hs_phase${cp}();`);
                lines.push(`        for (var reg = 0u; reg < ${h.cpRegs}u; reg++) { vocp[cp][reg] = o[reg]; }`);
            } else {
                lines.push(`        for (var reg = 0u; reg < ${h.cpRegs}u; reg++) { vocp[cp][reg] = vicp[min(cp, ${h.inCPs - 1}u)][reg]; }`);
            }
            lines.push("    }");
            phases.forEach((phase, k) => {
                if (phase.kind !== "fork" && phase.kind !== "join") return;
                lines.push(`    for (var i = 0u; i < ${Math.max(1, phase.instances)}u; i++) { hs_inst = i; hs_phase${k}(); }`);
            });
            lines.push(`    let out = k * ${h.record}u;`);
            lines.push(`    for (var cp = 0u; cp < ${h.outCPs}u; cp++) {`);
            lines.push(`        for (var reg = 0u; reg < ${h.cpRegs}u; reg++) { gx_out[out + cp * ${h.cpRegs}u + reg] = vocp[cp][reg]; }`);
            lines.push("    }");
            lines.push(`    for (var reg = 0u; reg < ${h.pcRegs}u; reg++) { gx_out[out + ${h.pcAt}u + reg] = opc[reg]; }`);
            // the tess factors, from the patch constants their declarations name
            const factors = ["0.0", "0.0", "0.0", "0.0", "0.0", "0.0"];
            for (const output of p.outputs) {
                const slot = TESS_FACTOR_SLOT[output.name];
                if (slot === undefined || output.type !== OPERAND.OUTPUT) continue;
                let lane = 0;
                while (lane < 3 && !(output.mask >> lane & 1)) lane++;
                factors[slot] = `bitcast<f32>(opc[${output.index}].${LANES[lane]})`;
            }
            lines.push(`    gx_out[out + ${h.factorAt}u] = bitcast<vec4<u32>>(vec4<f32>(${factors.slice(0, 4).join(", ")}));`);
            lines.push(`    gx_out[out + ${h.factorAt + 1}u] = bitcast<vec4<u32>>(vec4<f32>(${factors[4]}, ${factors[5]}, 0.0, 0.0));`);
            return "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {\n" + lines.join("\n") + "\n}\n";
        }

        domainLayout() {
            const p = this.p;
            let cpRegs = 1, pcRegs = 1;
            for (const input of p.inputs) {
                if (input.type === OPERAND.INPUT_CONTROL_POINT) cpRegs = Math.max(cpRegs, input.index2 + 1);
                if (input.type === OPERAND.INPUT_PATCH_CONSTANT) pcRegs = Math.max(pcRegs, input.index + 1);
            }
            return { cps: Math.max(1, p.tess.inputCPs), cpRegs, pcRegs, domain: p.tess.domain };
        }

        domainDeclarations() {
            const g = this.group, d = this.domain, out = [];
            // the hull shader's records: cp_regs vec4s per control point, the patch constants at pc_at
            out.push("struct GXDomain { patches: u32, hull_record: u32, cp_regs: u32, pc_at: u32 }");
            out.push(`@group(${g}) @binding(${BINDING.GEO}) var<uniform> gx_dom: GXDomain;`);
            out.push(`@group(${g}) @binding(${BINDING.STAGE_IN}) var<storage, read> gx_in: array<vec4<u32>>;`);
            out.push(`@group(${g}) @binding(${BINDING.TESS_POINTS}) var<storage, read> gx_points: array<vec4<u32>>;`);
            out.push(`@group(${g}) @binding(${BINDING.TESS_ARGS}) var<storage, read> gx_targs: array<u32>;`);
            out.push(`@group(${g}) @binding(${BINDING.STAGE_OUT}) var<storage, read_write> gx_out: array<vec4<u32>>;`);
            this.bindings.push({ binding: BINDING.GEO, type: "domain" });
            this.bindings.push({ binding: BINDING.STAGE_IN, type: "stage-in" });
            this.bindings.push({ binding: BINDING.TESS_POINTS, type: "tess-points" });
            this.bindings.push({ binding: BINDING.TESS_ARGS, type: "tess-args" });
            this.bindings.push({ binding: BINDING.STAGE_OUT, type: "stage-out" });
            out.push(`var<private> vicp: array<array<vec4<u32>, ${d.cpRegs}>, ${d.cps}>;`);
            out.push(`var<private> vpc: array<vec4<u32>, ${d.pcRegs}>;`);
            out.push("var<private> gx_domain: vec3<f32>;");
            out.push("var<private> prim_id: u32;");
            return out;
        }

        domainEntry() {
            const d = this.domain, OUT = this.outputCount;
            return "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {\n" +
                "    let k = gid.x + gid.y * 65535u * 64u;\n" +
                // (the tessellator's point count, after the draw's arguments)
                "    if (k >= gx_targs[7]) { return; }\n" +
                "    let point = gx_points[k];\n" +
                "    let u = bitcast<f32>(point.x);\n" +
                "    let v = bitcast<f32>(point.y);\n" +
                (d.domain === 2 ? "    gx_domain = vec3<f32>(u, v, 1.0 - u - v);\n" : "    gx_domain = vec3<f32>(u, v, 0.0);\n") +
                "    let at = point.z * gx_dom.hull_record;\n" +
                `    for (var cp = 0u; cp < ${d.cps}u; cp++) {\n` +
                `        for (var reg = 0u; reg < min(${d.cpRegs}u, gx_dom.cp_regs); reg++) { vicp[cp][reg] = gx_in[at + cp * gx_dom.cp_regs + reg]; }\n` +
                "    }\n" +
                `    for (var reg = 0u; reg < ${d.pcRegs}u; reg++) { vpc[reg] = gx_in[at + gx_dom.pc_at + reg]; }\n` +
                "    prim_id = point.z % max(gx_dom.patches, 1u);\n" +
                "    shader_main();\n" +
                `    for (var reg = 0u; reg < ${OUT}u; reg++) { gx_out[k * ${OUT}u + reg] = o[reg]; }\n` +
                "}\n";
        }

        // ---------------------------------------------------------------
        // Operands

        /** An index (immediate, plus maybe a register's component) as a u32 expression */
        index(index) {
            if (!index.rel) return u32(index.imm);
            const rel = this.read(index.rel, "u") + ".x";
            return index.imm ? `(${u32(index.imm)} + ${rel})` : rel;
        }

        /** The register an operand names, as an lvalue/rvalue of vec4<u32> */
        reg(op) {
            const i = op.indices;
            switch (op.type) {
                case OPERAND.TEMP: return `r[${this.index(i[0])}]`;
                case OPERAND.INPUT:
                    // a geometry shader's are [vertex][register]
                    if (this.mode === "geometry" && i.length > 1) return `v[${this.index(i[0])}][${this.index(i[1])}]`;
                    return `v[${this.index(i[i.length - 1])}]`;
                // (a hull shader's fork and join phases write patch constants)
                case OPERAND.OUTPUT: return this.hsPhase === "fork" || this.hsPhase === "join" ? `opc[${this.index(i[0])}]` : `o[${this.index(i[0])}]`;
                case OPERAND.INPUT_CONTROL_POINT: return `vicp[${this.index(i[0])}][${this.index(i[1])}]`;
                case OPERAND.OUTPUT_CONTROL_POINT: return `vocp[${this.index(i[0])}][${this.index(i[1])}]`;
                case OPERAND.INPUT_PATCH_CONSTANT: return this.mode === "hull" ? `opc[${this.index(i[0])}]` : `vpc[${this.index(i[0])}]`;
                case OPERAND.OUTPUT_CONTROL_POINT_ID: return "vec4<u32>(hs_cpid)";
                case OPERAND.INPUT_FORK_INSTANCE_ID:
                case OPERAND.INPUT_JOIN_INSTANCE_ID: return "vec4<u32>(hs_inst)";
                case OPERAND.INPUT_DOMAIN_POINT: return "bitcast<vec4<u32>>(vec4<f32>(gx_domain, 0.0))";
                case OPERAND.INDEXABLE_TEMP: return `x${i[0].imm}[${this.index(i[1])}]`;
                case OPERAND.CONSTANT_BUFFER: {
                    const slot = i[0].imm;
                    if (!this.p.cbuffers.has(slot)) {
                        this.p.cbuffers.set(slot, { size: 4096, dynamic: true });
                    }
                    return `cb${slot}[${this.index(i[1])}]`;
                }
                case OPERAND.IMMEDIATE_CONSTANT_BUFFER:
                    if (!this.p.icb) this.p.icb = new Uint32Array(4);
                    return `icb[${this.index(i[0])}]`;
                case OPERAND.INPUT_PRIMITIVEID: return "vec4<u32>(prim_id)";
                case OPERAND.OUTPUT_DEPTH:
                case OPERAND.OUTPUT_DEPTH_GREATER_EQUAL:
                case OPERAND.OUTPUT_DEPTH_LESS_EQUAL:
                    this.needDepth = true;
                    return "odepth";
                case OPERAND.OUTPUT_COVERAGE_MASK: return "omask";
                // (one sample per fragment)
                case OPERAND.INPUT_COVERAGE_MASK: return "vec4<u32>(select(1u, 1u << gx_sample, gx_ss != 0u))";
                case OPERAND.INPUT_THREAD_ID: return "vec4<u32>(cs_thread, 0u)";
                case OPERAND.INPUT_THREAD_GROUP_ID: return "vec4<u32>(cs_group, 0u)";
                case OPERAND.INPUT_THREAD_ID_IN_GROUP: return "vec4<u32>(cs_local, 0u)";
                case OPERAND.INPUT_THREAD_ID_IN_GROUP_FLATTENED: return "vec4<u32>(cs_flat)";
                case OPERAND.CYCLE_COUNTER: return "vec4<u32>(0u)";
            }
            throw new ShaderTranslateError("operand type " + op.type + " is not supported");
        }

        /**
         * A source operand as vec4 of a type: "u" (raw), "f", "i"; with its
         * swizzle and modifier
         */
        read(op, kind) {
            let value;
            if (op.type === OPERAND.IMMEDIATE32) {
                const v = op.imm.length === 4 ? op.imm : [op.imm[0], op.imm[0], op.imm[0], op.imm[0]];
                value = `vec4<u32>(${v.map(u32).join(", ")})`;
            } else if (op.type === OPERAND.IMMEDIATE64) {
                this.warn("double precision is not supported");
                value = "vec4<u32>()";
            } else {
                value = this.reg(op);
                // scalars (odepth, omask) are vectors when read
                if (value === "odepth" || value === "omask") value = `vec4<u32>(${value})`;
                const s = op.swizzle;
                if (op.ncomp === 4 || op.ncomp === 1) {
                    if (!(s[0] === 0 && s[1] === 1 && s[2] === 2 && s[3] === 3)) {
                        value += "." + s.map(c => LANES[c]).join("");
                    }
                }
            }
            if (kind === "u") return value;
            const typed = kind === "f" ? `bitcast<vec4<f32>>(${value})` : `bitcast<vec4<i32>>(${value})`;
            switch (op.modifier) {
                case 1: return `(-${typed})`;
                case 2: return `abs(${typed})`;
                case 3: return `(-abs(${typed}))`;
            }
            return typed;
        }

        f(ins, i) { return this.read(ins.src[i], "f"); }
        i(ins, i) { return this.read(ins.src[i], "i"); }
        u(ins, i) { return this.read(ins.src[i], "u"); }

        /** The component of a select-1 or scalar source, of a type */
        scalar(ins, i, kind) {
            return this.read(ins.src[i], kind) + ".x";
        }

        /**
         * Write a vec4 value of a type ("f", "i", "u") to a destination,
         * through its write mask; float results may be saturated
         */
        write(ins, value, kind, d = 0) {
            const dst = ins.dst[d];
            if (!dst || dst.type === OPERAND.NULL) return;
            if (kind === "f" && ins.saturate) value = `clamp(${value}, vec4<f32>(0.0), vec4<f32>(1.0))`;
            const bits = kind === "u" ? value : `bitcast<vec4<u32>>(${value})`;
            const target = this.reg(dst);
            if (target === "odepth" || target === "omask") {
                const lane = LANES[Math.max(0, [1, 2, 4, 8].indexOf(dst.mask & -dst.mask))] || "x";
                this.line(`${target} = (${bits}).${lane};`);
                return;
            }
            const mask = dst.mode === "mask" ? dst.mask : ALL;
            if (mask === ALL) {
                this.line(`${target} = ${bits};`);
                return;
            }
            const lanes = [0, 1, 2, 3].filter(c => mask >> c & 1);
            if (lanes.length === 1) {
                this.line(`${target}.${LANES[lanes[0]]} = (${bits}).${LANES[lanes[0]]};`);
                return;
            }
            this.line("{");
            this.indent++;
            this.line(`let t = ${bits};`);
            for (const c of lanes) this.line(`${target}.${LANES[c]} = t.${LANES[c]};`);
            this.indent--;
            this.line("}");
        }

        /** A condition on the first component of a source (if, breakc, ...) */
        test(ins, i = 0) {
            return `${this.u(ins, i)}.x ${ins.test ? "!=" : "=="} 0u`;
        }

        // ---------------------------------------------------------------
        // Instructions

        body(code) {
            for (const ins of code) this.instruction(ins);
            // a switch still open (malformed) is closed
            while (this.switches.length) this.endSwitch();
        }

        instruction(ins) {
            const f = (i) => this.f(ins, i), I = (i) => this.i(ins, i), U = (i) => this.u(ins, i);
            const wf = v => this.write(ins, v, "f"), wi = v => this.write(ins, v, "i"), wu = v => this.write(ins, v, "u");
            const mask = v => `select(vec4<u32>(0u), vec4<u32>(0xFFFFFFFFu), ${v})`;
            const shift = i => `(${U(i)} & vec4<u32>(31u))`;
            switch (ins.op) {
                // float arithmetic
                case OP.ADD: return wf(`${f(0)} + ${f(1)}`);
                case OP.MUL: return wf(`${f(0)} * ${f(1)}`);
                case OP.MAD: return wf(`fma(${f(0)}, ${f(1)}, ${f(2)})`);
                case OP.DIV: return wf(`${f(0)} / ${f(1)}`);
                case OP.MIN: return wf(`min(${f(0)}, ${f(1)})`);
                case OP.MAX: return wf(`max(${f(0)}, ${f(1)})`);
                case OP.SQRT: return wf(`sqrt(${f(0)})`);
                case OP.RSQ: return wf(`inverseSqrt(${f(0)})`);
                case OP.RCP: return wf(`vec4<f32>(1.0) / ${f(0)}`);
                case OP.EXP: return wf(`exp2(${f(0)})`);
                case OP.LOG: return wf(`log2(${f(0)})`);
                case OP.FRC: return wf(`fract(${f(0)})`);
                case OP.ROUND_NE: return wf(`round(${f(0)})`);
                case OP.ROUND_NI: return wf(`floor(${f(0)})`);
                case OP.ROUND_PI: return wf(`ceil(${f(0)})`);
                case OP.ROUND_Z: return wf(`trunc(${f(0)})`);
                case OP.DP2: return wf(`vec4<f32>(dot(${f(0)}.xy, ${f(1)}.xy))`);
                case OP.DP3: return wf(`vec4<f32>(dot(${f(0)}.xyz, ${f(1)}.xyz))`);
                case OP.DP4: return wf(`vec4<f32>(dot(${f(0)}, ${f(1)}))`);
                case OP.SINCOS:
                    // (the source read once: a destination may be it, "sincos r1.x, r0.x, r1.x")
                    this.line("{");
                    this.indent++;
                    this.line(`let a = ${f(0)};`);
                    if (ins.dst[0] && ins.dst[0].type !== OPERAND.NULL) this.write(ins, "sin(a)", "f", 0);
                    if (ins.dst[1] && ins.dst[1].type !== OPERAND.NULL) this.write(ins, "cos(a)", "f", 1);
                    this.indent--;
                    this.line("}");
                    return;
                case OP.EQ: return wu(mask(`${f(0)} == ${f(1)}`));
                case OP.NE: return wu(mask(`${f(0)} != ${f(1)}`));
                case OP.LT: return wu(mask(`${f(0)} < ${f(1)}`));
                case OP.GE: return wu(mask(`${f(0)} >= ${f(1)}`));
                case OP.MOV:
                    if (ins.saturate || ins.src[0].modifier) return wf(f(0));
                    return wu(U(0));
                case OP.MOVC: {
                    if (ins.saturate) return wf(`select(${f(2)}, ${f(1)}, ${U(0)} != vec4<u32>(0u))`);
                    return wu(`select(${U(2)}, ${U(1)}, ${U(0)} != vec4<u32>(0u))`);
                }
                case OP.SWAPC: {
                    const c = `${U(0)} != vec4<u32>(0u)`;
                    this.line("{");
                    this.indent++;
                    this.line(`let a = ${U(1)};`);
                    this.line(`let b = ${U(2)};`);
                    this.line(`let c = ${c};`);
                    this.write(ins, "select(a, b, c)", "u", 0);
                    this.write(ins, "select(b, a, c)", "u", 1);
                    this.indent--;
                    this.line("}");
                    return;
                }

                // conversions
                case OP.ITOF: return wf(`vec4<f32>(${I(0)})`);
                case OP.UTOF: return wf(`vec4<f32>(${U(0)})`);
                case OP.FTOI: return wi(`vec4<i32>(${f(0)})`);
                case OP.FTOU: return wu(`vec4<u32>(${f(0)})`);
                case OP.F32TOF16:
                    this.helpers.add("f32tof16");
                    return wu(`gx_f32tof16(${f(0)})`);
                case OP.F16TOF32:
                    this.helpers.add("f16tof32");
                    return wf(`gx_f16tof32(${U(0)})`);

                // bits and integers
                case OP.AND: return wu(`${U(0)} & ${U(1)}`);
                case OP.OR: return wu(`${U(0)} | ${U(1)}`);
                case OP.XOR: return wu(`${U(0)} ^ ${U(1)}`);
                case OP.NOT: return wu(`~${U(0)}`);
                case OP.ISHL: return wu(`${U(0)} << ${shift(1)}`);
                case OP.ISHR: return wi(`${I(0)} >> ${shift(1)}`);
                case OP.USHR: return wu(`${U(0)} >> ${shift(1)}`);
                case OP.IADD: return wi(`${I(0)} + ${I(1)}`);
                case OP.INEG: return wi(`-${I(0)}`);
                case OP.IMAD: return wi(`${I(0)} * ${I(1)} + ${I(2)}`);
                case OP.UMAD: return wu(`${U(0)} * ${U(1)} + ${U(2)}`);
                case OP.IMUL:
                case OP.UMUL: {
                    const signed = ins.op === OP.IMUL;
                    this.helpers.add(signed ? "imul_hi" : "umul_hi");
                    // (the sources read once: the high half may overwrite one)
                    this.line("{");
                    this.indent++;
                    this.line(`let a = ${signed ? I(0) : U(0)};`);
                    this.line(`let b = ${signed ? I(1) : U(1)};`);
                    if (ins.dst[0] && ins.dst[0].type !== OPERAND.NULL) {
                        this.write(ins, signed ? "gx_imul_hi(a, b)" : "gx_umul_hi(a, b)", signed ? "i" : "u", 0);
                    }
                    if (ins.dst[1] && ins.dst[1].type !== OPERAND.NULL) this.write(ins, "a * b", signed ? "i" : "u", 1);
                    this.indent--;
                    this.line("}");
                    return;
                }
                case OP.UDIV: {
                    this.line("{");
                    this.indent++;
                    this.line(`let a = ${U(0)};`);
                    this.line(`let b = ${U(1)};`);
                    this.line("let zero = b == vec4<u32>(0u);");
                    this.line("let safe = select(b, vec4<u32>(1u), zero);");
                    if (ins.dst[0] && ins.dst[0].type !== OPERAND.NULL) this.write(ins, "select(a / safe, vec4<u32>(0xFFFFFFFFu), zero)", "u", 0);
                    if (ins.dst[1] && ins.dst[1].type !== OPERAND.NULL) this.write(ins, "select(a % safe, vec4<u32>(0xFFFFFFFFu), zero)", "u", 1);
                    this.indent--;
                    this.line("}");
                    return;
                }
                case OP.IMIN: return wi(`min(${I(0)}, ${I(1)})`);
                case OP.IMAX: return wi(`max(${I(0)}, ${I(1)})`);
                case OP.UMIN: return wu(`min(${U(0)}, ${U(1)})`);
                case OP.UMAX: return wu(`max(${U(0)}, ${U(1)})`);
                case OP.IEQ: return wu(mask(`${I(0)} == ${I(1)}`));
                case OP.INE: return wu(mask(`${I(0)} != ${I(1)}`));
                case OP.ILT: return wu(mask(`${I(0)} < ${I(1)}`));
                case OP.IGE: return wu(mask(`${I(0)} >= ${I(1)}`));
                case OP.ULT: return wu(mask(`${U(0)} < ${U(1)}`));
                case OP.UGE: return wu(mask(`${U(0)} >= ${U(1)}`));
                case OP.COUNTBITS: return wu(`countOneBits(${U(0)})`);
                case OP.FIRSTBIT_LO: return wu(`firstTrailingBit(${U(0)})`);
                case OP.FIRSTBIT_HI: {
                    // counted from the top, ~0 if there is none
                    this.line("{");
                    this.indent++;
                    this.line(`let b = firstLeadingBit(${U(0)});`);
                    this.write(ins, "select(vec4<u32>(31u) - b, vec4<u32>(0xFFFFFFFFu), b == vec4<u32>(0xFFFFFFFFu))", "u");
                    this.indent--;
                    this.line("}");
                    return;
                }
                case OP.FIRSTBIT_SHI: {
                    this.line("{");
                    this.indent++;
                    this.line(`let b = bitcast<vec4<u32>>(firstLeadingBit(${I(0)}));`);
                    this.write(ins, "select(vec4<u32>(31u) - b, vec4<u32>(0xFFFFFFFFu), b == vec4<u32>(0xFFFFFFFFu))", "u");
                    this.indent--;
                    this.line("}");
                    return;
                }
                case OP.UBFE:
                case OP.IBFE: {
                    // width, offset, value: per component
                    const signed = ins.op === OP.IBFE;
                    this.helpers.add(signed ? "ibfe" : "ubfe");
                    return signed ? wi(`gx_ibfe(${U(0)}, ${U(1)}, ${I(2)})`) : wu(`gx_ubfe(${U(0)}, ${U(1)}, ${U(2)})`);
                }
                case OP.BFI:
                    this.helpers.add("bfi");
                    return wu(`gx_bfi(${U(0)}, ${U(1)}, ${U(2)}, ${U(3)})`);
                case OP.BFREV: return wu(`reverseBits(${U(0)})`);
                case OP.UADDC:
                case OP.USUBB: {
                    const add = ins.op === OP.UADDC;
                    this.line("{");
                    this.indent++;
                    this.line(`let a = ${U(0)};`);
                    this.line(`let b = ${U(1)};`);
                    this.line(`let s = ${add ? "a + b" : "a - b"};`);
                    if (ins.dst[0] && ins.dst[0].type !== OPERAND.NULL) this.write(ins, "s", "u", 0);
                    if (ins.dst[1] && ins.dst[1].type !== OPERAND.NULL) {
                        this.write(ins, add ? "select(vec4<u32>(0u), vec4<u32>(1u), s < a)" : "select(vec4<u32>(0u), vec4<u32>(1u), a < b)", "u", 1);
                    }
                    this.indent--;
                    this.line("}");
                    return;
                }
                case OP.VMWARE:
                    if (ins.vmware === VMWARE_OP.IDIV) {
                        // signed quotient and remainder, by zero ~0
                        this.line("{");
                        this.indent++;
                        this.line(`let a = ${I(0)};`);
                        this.line(`let b = ${I(1)};`);
                        this.line("let zero = b == vec4<i32>(0);");
                        this.line("let safe = select(b, vec4<i32>(1), zero);");
                        if (ins.dst[0] && ins.dst[0].type !== OPERAND.NULL) this.write(ins, "select(a / safe, vec4<i32>(-1), zero)", "i", 0);
                        if (ins.dst[1] && ins.dst[1].type !== OPERAND.NULL) this.write(ins, "select(a % safe, vec4<i32>(-1), zero)", "i", 1);
                        this.indent--;
                        this.line("}");
                        return;
                    }
                    this.warn("VMware opcode " + ins.vmware + " (double precision)");
                    return;

                // derivatives
                case OP.DERIV_RTX:
                case OP.DERIV_RTX_COARSE:
                case OP.DERIV_RTX_FINE:
                case OP.DERIV_RTY:
                case OP.DERIV_RTY_COARSE:
                case OP.DERIV_RTY_FINE: {
                    if (this.stage !== PROGRAM.PS) return wf("vec4<f32>(0.0)");
                    const name = {
                        [OP.DERIV_RTX]: "dpdx", [OP.DERIV_RTX_COARSE]: "dpdxCoarse", [OP.DERIV_RTX_FINE]: "dpdxFine",
                        [OP.DERIV_RTY]: "dpdy", [OP.DERIV_RTY_COARSE]: "dpdyCoarse", [OP.DERIV_RTY_FINE]: "dpdyFine",
                    }[ins.op];
                    return wf(`${name}(${f(0)})`);
                }

                // control flow
                case OP.IF:
                    this.line(`if (${this.test(ins)}) {`);
                    this.indent++;
                    return;
                case OP.ELSE:
                    this.indent--;
                    this.line("} else {");
                    this.indent++;
                    return;
                case OP.ENDIF:
                case OP.ENDLOOP:
                    this.indent--;
                    this.line("}");
                    return;
                case OP.LOOP:
                    this.line("loop {");
                    this.indent++;
                    return;
                case OP.BREAK:
                    this.line("break;");
                    return;
                case OP.BREAKC:
                    this.line(`if (${this.test(ins)}) { break; }`);
                    return;
                case OP.CONTINUE:
                    this.line("continue;");
                    return;
                case OP.CONTINUEC:
                    this.line(`if (${this.test(ins)}) { continue; }`);
                    return;
                case OP.RET:
                    this.line("return;");
                    return;
                case OP.RETC:
                    this.line(`if (${this.test(ins)}) { return; }`);
                    return;
                case OP.DISCARD:
                    if (this.stage === PROGRAM.PS) this.line(`if (${this.test(ins)}) { discard; }`);
                    return;
                case OP.CALL:
                    this.line(`label${ins.src[0].indices[0].imm}();`);
                    return;
                case OP.CALLC:
                    this.line(`if (${this.test(ins)}) { label${ins.src[1].indices[0].imm}(); }`);
                    return;
                case OP.SWITCH:
                    this.line(`switch (${this.read(ins.src[0], "i")}.x) {`);
                    this.indent++;
                    this.switches.push({ labels: [], open: false, hasDefault: false });
                    return;
                case OP.CASE:
                case OP.DEFAULT: {
                    const s = this.switches[this.switches.length - 1];
                    if (!s) throw new ShaderTranslateError(ins.name + " outside of a switch");
                    if (s.open) {
                        // the case before falls into this one: D3D compilers end cases with break
                        this.indent--;
                        this.line("}");
                        s.open = false;
                    }
                    if (ins.op === OP.CASE) {
                        s.labels.push(String(ins.src[0].imm[0] | 0) + "i");
                    } else {
                        s.labels.push("default");
                        s.hasDefault = true;
                    }
                    return;
                }
                case OP.ENDSWITCH:
                    this.endSwitch();
                    return;
                case OP.NOP:
                case OP.LABEL:
                case OP.HS_DECLS:
                    return;

                // textures
                case OP.SAMPLE:
                case OP.SAMPLE_B:
                case OP.SAMPLE_L:
                case OP.SAMPLE_D:
                case OP.SAMPLE_C:
                case OP.SAMPLE_C_LZ:
                    return this.sample(ins);
                case OP.GATHER4:
                case OP.GATHER4_C:
                case OP.GATHER4_PO:
                case OP.GATHER4_PO_C:
                    return this.gather(ins);
                case OP.LD:
                case OP.LD_MS:
                    return this.load(ins);
                case OP.RESINFO:
                    return this.resinfo(ins);
                case OP.SAMPLE_INFO: {
                    const count = this.sampleCount(ins.src[0]);
                    const value = (ins.controls & 1) ? `vec4<u32>(${count}, 0u, 0u, 0u)` : `vec4<f32>(f32(${count}), 0.0, 0.0, 0.0)`;
                    return this.write(ins, this.swizzled(value, ins.src[0]), (ins.controls & 1) ? "u" : "f");
                }
                case OP.SAMPLE_POS:
                    this.helpers.add("sample_pos");
                    return this.write(ins, this.swizzled(`gx_sample_pos(${this.u(ins, 1)}.x, ${this.sampleCount(ins.src[0])})`, ins.src[0]), "f");
                case OP.LOD:
                    return this.lod(ins);
                case OP.BUFINFO: {
                    // the buffer's words past the view's start, in elements (raw: bytes)
                    const r = ins.src[0];
                    const slot = r.indices[0].imm;
                    const b = this.bufferName(r);
                    const decl = (r.type === OPERAND.RESOURCE ? this.p.resources : this.p.uavs).get(slot) || {};
                    const words = `(arrayLength(&${b.name}) - ${b.base})`;
                    const lanes = decl.kind === "typed" ? ((this.o.uavFormats || {})[slot] || {}).lanes || 1 : 0;
                    const elements = decl.kind === "structured" ? `${words} * 4u / ${Math.max(4, decl.stride || 4)}u` :
                        decl.kind === "raw" ? `${words} * 4u` : lanes ? `${words} / ${lanes}u` : words;
                    return wu(`vec4<u32>(${elements})`);
                }
                case OP.LD_UAV_TYPED:
                    return this.loadTyped(ins);
                case OP.STORE_UAV_TYPED:
                    return this.storeTyped(ins);
                case OP.LD_RAW:
                    return this.loadRaw(ins, false);
                case OP.LD_STRUCTURED:
                    return this.loadRaw(ins, true);
                case OP.STORE_RAW:
                    return this.storeRaw(ins, false);
                case OP.STORE_STRUCTURED:
                    return this.storeRaw(ins, true);
                case OP.SYNC:
                    if (ins.controls & 1) this.line("workgroupBarrier();");
                    else if (ins.controls & 0xC) this.line("storageBarrier();");
                    return;
                case OP.EMIT:
                case OP.CUT:
                case OP.EMITTHENCUT:
                case OP.EMIT_STREAM:
                case OP.CUT_STREAM:
                case OP.EMITTHENCUT_STREAM: {
                    if (this.mode !== "geometry") throw new ShaderTranslateError("geometry shader instruction " + ins.name);
                    const streamed = ins.op === OP.EMIT_STREAM || ins.op === OP.CUT_STREAM || ins.op === OP.EMITTHENCUT_STREAM;
                    const operand = (ins.dst && ins.dst[0]) || (ins.src && ins.src[0]);
                    const stream = streamed && operand ? operand.indices[0].imm : 0;
                    if (stream !== 0) {
                        // only stream 0 is rasterized; the others only feed stream output
                        this.warn("geometry shader stream " + stream + " is not emulated");
                        return;
                    }
                    const emit = ins.op === OP.EMIT || ins.op === OP.EMITTHENCUT || ins.op === OP.EMIT_STREAM || ins.op === OP.EMITTHENCUT_STREAM;
                    const cut = ins.op === OP.CUT || ins.op === OP.EMITTHENCUT || ins.op === OP.CUT_STREAM || ins.op === OP.EMITTHENCUT_STREAM;
                    if (emit) this.line("gs_emit();");
                    if (cut) this.line("gs_cut();");
                    return;
                }
            }
            if (ins.op >= OP.ATOMIC_AND && ins.op <= OP.IMM_ATOMIC_UMIN) return this.atomic(ins);
            throw new ShaderTranslateError("instruction " + ins.name + " is not supported");
        }

        endSwitch() {
            const s = this.switches.pop();
            if (s.open) {
                this.indent--;
                this.line("}");
            }
            if (s.labels.length) {
                // labels with no code (at the end)
                this.line(s.labels.length === 1 && s.labels[0] === "default" ? "default: {}" : `case ${s.labels.join(", ")}: {}`);
                if (s.labels.includes("default")) s.hasDefault = true;
            }
            if (!s.hasDefault) this.line("default: {}");
            this.indent--;
            this.line("}");
        }

        /** Code inside a switch opens the case its labels name */
        openCase() {
            const s = this.switches[this.switches.length - 1];
            if (!s || s.open) return;
            if (!s.labels.length) return;
            this.line(`case ${s.labels.join(", ")}: {`);
            if (s.labels.includes("default")) s.hasDefault = true;
            s.labels = [];
            s.open = true;
            this.indent++;
        }

        // ---------------------------------------------------------------
        // Texture instructions

        /** The coordinates a dimension takes, from a float address: [coords, array index or null] */
        coordinates(dimension, address) {
            switch (dimension) {
                case DIM.TEXTURE1D: return [`vec2<f32>(${address}.x, 0.5)`, null];
                case DIM.TEXTURE1DARRAY: return [`vec2<f32>(${address}.x, 0.5)`, `i32(round(${address}.y))`];
                case DIM.TEXTURE2D:
                case DIM.TEXTURE2DMS: return [`${address}.xy`, null];
                case DIM.TEXTURE2DARRAY:
                case DIM.TEXTURE2DMSARRAY: return [`${address}.xy`, `i32(round(${address}.z))`];
                case DIM.TEXTURE3D:
                case DIM.TEXTURECUBE: return [`${address}.xyz`, null];
                case DIM.TEXTURECUBEARRAY: return [`${address}.xyz`, `i32(round(${address}.w))`];
            }
            throw new ShaderTranslateError("sampling a resource of dimension " + dimension);
        }

        offset(ins, dimension) {
            const o = ins.offsets;
            if (!o || (!o[0] && !o[1] && !o[2])) return null;
            if (dimension === DIM.TEXTURECUBE || dimension === DIM.TEXTURECUBEARRAY) return null;
            if (dimension === DIM.TEXTURE3D) return `vec3<i32>(${o[0]}, ${o[1]}, ${o[2]})`;
            if (dimension === DIM.TEXTURE1D || dimension === DIM.TEXTURE1DARRAY) return `vec2<i32>(${o[0]}, 0)`;
            return `vec2<i32>(${o[0]}, ${o[1]})`;
        }

        resource(operand) {
            const slot = operand.indices[0].imm;
            const r = this.p.resources.get(slot);
            if (!r) throw new ShaderTranslateError("resource t" + slot + " is not declared");
            return { slot, r, name: "t" + slot };
        }

        /** The result of a texture instruction (a vec4 of the resource's type) through the resource's swizzle */
        swizzled(value, operand) {
            const s = operand.swizzle;
            if (s[0] === 0 && s[1] === 1 && s[2] === 2 && s[3] === 3) return value;
            return `(${value}).${s.map(c => LANES[c]).join("")}`;
        }

        resultKind(r) {
            const ret = r.returnTypes ? r.returnTypes[0] : RETURN.FLOAT;
            return ret === RETURN.SINT ? "i" : ret === RETURN.UINT ? "u" : "f";
        }

        sample(ins) {
            const t = this.resource(ins.src[1]);
            const sampler = `s${ins.src[2].indices[0].imm}`;
            const dimension = t.r.dimension;
            const [coords, layer] = this.coordinates(dimension, this.f(ins, 0));
            const offset = this.offset(ins, dimension);
            const args = [t.name, sampler, coords];
            if (layer) args.push(layer);
            const fragment = this.stage === PROGRAM.PS;
            const depth = this.compared.has(t.slot);
            let call;
            switch (ins.op) {
                case OP.SAMPLE:
                    call = fragment ? `textureSample(${args.join(", ")}${offset ? ", " + offset : ""})` :
                        `textureSampleLevel(${args.join(", ")}, ${depth ? "0" : "0.0"}${offset ? ", " + offset : ""})`;
                    break;
                case OP.SAMPLE_B:
                    call = fragment ? `textureSampleBias(${args.join(", ")}, ${this.scalar(ins, 3, "f")}${offset ? ", " + offset : ""})` :
                        `textureSampleLevel(${args.join(", ")}, 0.0${offset ? ", " + offset : ""})`;
                    break;
                case OP.SAMPLE_L:
                    call = depth ? `textureSampleLevel(${args.join(", ")}, i32(${this.scalar(ins, 3, "f")})${offset ? ", " + offset : ""})` :
                        `textureSampleLevel(${args.join(", ")}, ${this.scalar(ins, 3, "f")}${offset ? ", " + offset : ""})`;
                    break;
                case OP.SAMPLE_D: {
                    const width = dimension === DIM.TEXTURE3D || dimension === DIM.TEXTURECUBE || dimension === DIM.TEXTURECUBEARRAY ? "xyz" :
                        dimension === DIM.TEXTURE1D || dimension === DIM.TEXTURE1DARRAY ? null : "xy";
                    const grad = i => width ? `${this.f(ins, i)}.${width}` : `vec2<f32>(${this.f(ins, i)}.x, 0.0)`;
                    call = `textureSampleGrad(${args.join(", ")}, ${grad(3)}, ${grad(4)}${offset ? ", " + offset : ""})`;
                    break;
                }
                case OP.SAMPLE_C:
                case OP.SAMPLE_C_LZ: {
                    const reference = this.scalar(ins, 3, "f");
                    const level = ins.op === OP.SAMPLE_C_LZ || !fragment;
                    call = `vec4<f32>(${level ? "textureSampleCompareLevel" : "textureSampleCompare"}(${args.join(", ")}, ${reference}${offset ? ", " + offset : ""}))`;
                    return this.write(ins, this.swizzled(call, ins.src[1]), "f");
                }
            }
            if (depth) call = `vec4<f32>(${call})`;
            this.write(ins, this.swizzled(call, ins.src[1]), "f");
        }

        gather(ins) {
            const po = ins.op === OP.GATHER4_PO || ins.op === OP.GATHER4_PO_C;
            const compare = ins.op === OP.GATHER4_C || ins.op === OP.GATHER4_PO_C;
            const tOperand = ins.src[po ? 2 : 1], sOperand = ins.src[po ? 3 : 2];
            const t = this.resource(tOperand);
            const sampler = `s${sOperand.indices[0].imm}`;
            const dimension = t.r.dimension;
            let address = this.f(ins, 0);
            const [coords0, layer] = this.coordinates(dimension, address);
            let coords = coords0;
            let offset = this.offset(ins, dimension);
            if (po) {
                // programmable offsets: WGSL wants constants, so the
                // coordinates move by the offset in texels instead
                coords = `(${coords0} + vec2<f32>(${this.i(ins, 1)}.xy) / vec2<f32>(textureDimensions(${t.name})))`;
                offset = null;
            }
            const component = sOperand.swizzle[0];
            const args = [t.name, sampler, coords];
            if (layer) args.push(layer);
            let call;
            if (compare) {
                call = `textureGatherCompare(${args.join(", ")}, ${this.scalar(ins, po ? 4 : 3, "f")}${offset ? ", " + offset : ""})`;
            } else if (this.compared.has(t.slot)) {
                call = `textureGather(${args.join(", ")}${offset ? ", " + offset : ""})`;
            } else {
                call = `textureGather(${component}, ${args.join(", ")}${offset ? ", " + offset : ""})`;
            }
            this.write(ins, this.swizzled(call, tOperand), compare ? "f" : this.resultKind(t.r));
        }

        load(ins) {
            const ms = ins.op === OP.LD_MS;
            const tOperand = ins.src[1];
            if (tOperand.type === OPERAND.UAV) return this.loadTyped(ins);
            const t = this.resource(tOperand);
            const dimension = t.r.dimension;
            const a = this.i(ins, 0);
            const o = ins.offsets || [0, 0, 0];
            const off2 = o[0] || o[1] ? ` + vec2<i32>(${o[0]}, ${o[1]})` : "";
            const kind = this.compared.has(t.slot) ? "f" : this.resultKind(t.r);
            let call;
            switch (dimension) {
                case DIM.BUFFER:
                    return this.loadTypedBuffer(ins, t);
                case DIM.TEXTURE1D:
                    call = `textureLoad(${t.name}, vec2<i32>(${a}.x + ${o[0]}, 0), ${a}.w)`; break;
                case DIM.TEXTURE1DARRAY:
                    call = `textureLoad(${t.name}, vec2<i32>(${a}.x + ${o[0]}, 0), ${a}.y, ${a}.w)`; break;
                case DIM.TEXTURE2D:
                    call = `textureLoad(${t.name}, ${a}.xy${off2}, ${a}.w)`; break;
                case DIM.TEXTURE2DARRAY:
                    call = `textureLoad(${t.name}, ${a}.xy${off2}, ${a}.z, ${a}.w)`; break;
                case DIM.TEXTURE3D:
                    call = `textureLoad(${t.name}, ${a}.xyz${o[0] || o[1] || o[2] ? ` + vec3<i32>(${o[0]}, ${o[1]}, ${o[2]})` : ""}, ${a}.w)`; break;
                case DIM.TEXTURE2DMS:
                case DIM.TEXTURE2DMSARRAY: {
                    this.helpers.add("ms_texel");
                    const texel = `(${a}.xy${off2}) * 2 + gx_ms_texel(u32(${ms ? this.scalar(ins, 2, "i") : "0"}))`;
                    call = dimension === DIM.TEXTURE2DMS ? `textureLoad(${t.name}, ${texel}, 0)` : `textureLoad(${t.name}, ${texel}, ${a}.z, 0)`;
                    break;
                }
                default:
                    throw new ShaderTranslateError("ld from a resource of dimension " + dimension);
            }
            if (this.compared.has(t.slot)) call = `vec4<f32>(${call})`;
            this.write(ins, this.swizzled(call, tOperand), kind);
        }

        loadTypedBuffer(ins, t) {
            // the buffer's elements are 32-bit lanes; four per element is the
            // common case (R32G32B32A32); narrower formats are taken as one lane
            this.warn("typed buffer loads assume 32-bit lanes");
            const index = `u32(${this.i(ins, 0)}.x)`;
            const value = `vec4<u32>(${t.name}[${index} * 4u], ${t.name}[${index} * 4u + 1u], ${t.name}[${index} * 4u + 2u], ${t.name}[${index} * 4u + 3u])`;
            this.write(ins, this.swizzled(value, ins.src[1]), "u");
        }

        resinfo(ins) {
            const t = this.resource(ins.src[1]);
            const dimension = t.r.dimension;
            const mip = `u32(${this.i(ins, 0)}.x)`;
            const type = ins.controls & 3;
            let dims;
            const ms = dimension === DIM.TEXTURE2DMS || dimension === DIM.TEXTURE2DMSARRAY;
            const levels = ms ? "1u" : `textureNumLevels(${t.name})`;
            const level = ms ? "" : `, ${mip}`;
            switch (dimension) {
                case DIM.TEXTURE1D: dims = `vec4<u32>(textureDimensions(${t.name}${level}).x, 0u, 0u, ${levels})`; break;
                case DIM.TEXTURE1DARRAY: dims = `vec4<u32>(textureDimensions(${t.name}${level}).x, textureNumLayers(${t.name}), 0u, ${levels})`; break;
                case DIM.TEXTURE2D:
                case DIM.TEXTURECUBE: dims = `vec4<u32>(textureDimensions(${t.name}${level}), 0u, ${levels})`; break;
                // (supersampled: the texture is twice the surface)
                case DIM.TEXTURE2DMS: dims = `vec4<u32>(textureDimensions(${t.name}) / 2u, 0u, 1u)`; break;
                case DIM.TEXTURE2DARRAY:
                case DIM.TEXTURECUBEARRAY: dims = `vec4<u32>(textureDimensions(${t.name}${level}), textureNumLayers(${t.name}), ${levels})`; break;
                case DIM.TEXTURE2DMSARRAY: dims = `vec4<u32>(textureDimensions(${t.name}) / 2u, textureNumLayers(${t.name}), 1u)`; break;
                case DIM.TEXTURE3D: dims = `vec4<u32>(textureDimensions(${t.name}${level}), ${levels})`; break;
                default: throw new ShaderTranslateError("resinfo of dimension " + dimension);
            }
            // (a mip level beyond the texture reads zeros in D3D; WGSL clamps it)
            if (type === 2) return this.write(ins, this.swizzled(dims, ins.src[1]), "u");
            let value = `vec4<f32>(${dims})`;
            if (type === 1) value = `vec4<f32>(vec3<f32>(1.0) / vec4<f32>(${dims}).xyz, f32(${levels}))`;
            this.write(ins, this.swizzled(value, ins.src[1]), "f");
        }

        /**
         * The samples of the rasterizer (the pipeline's, an override
         * constant) or of a multisampled resource, as a u32 expression
         */
        sampleCount(operand) {
            if (operand.type === OPERAND.RASTERIZER) {
                this.usesSamples = true;
                return "gx_samples";
            }
            const t = this.resource(operand);
            const ms = t.r.dimension === DIM.TEXTURE2DMS || t.r.dimension === DIM.TEXTURE2DMSARRAY;
            return ms ? "4u" : "1u";
        }

        /**
         * lod: the mip level a sample would take, from the coordinates'
         * derivatives (WGSL has no query): x clamped to the view's levels,
         * y not. Only pixel shaders have derivatives; elsewhere it is 0.
         */
        lod(ins) {
            const t = this.resource(ins.src[1]);
            if (this.stage !== PROGRAM.PS) return this.write(ins, "vec4<f32>(0.0)", "f");
            const a = this.f(ins, 0), name = t.name;
            let coords, size;
            switch (t.r.dimension) {
                case DIM.TEXTURE1D:
                case DIM.TEXTURE1DARRAY:
                    coords = `vec3<f32>(${a}.x, 0.0, 0.0)`;
                    size = `vec3<f32>(f32(textureDimensions(${name}).x), 0.0, 0.0)`;
                    break;
                case DIM.TEXTURE2D:
                case DIM.TEXTURE2DARRAY:
                    coords = `vec3<f32>(${a}.xy, 0.0)`;
                    size = `vec3<f32>(vec2<f32>(textureDimensions(${name})), 0.0)`;
                    break;
                case DIM.TEXTURE3D:
                    coords = `${a}.xyz`;
                    size = `vec3<f32>(textureDimensions(${name}))`;
                    break;
                case DIM.TEXTURECUBE:
                case DIM.TEXTURECUBEARRAY:
                    // on the face: the direction over its major axis, [-1, 1] across
                    this.helpers.add("cube_face");
                    coords = `gx_cube_face(${a}.xyz)`;
                    size = `vec3<f32>(f32(textureDimensions(${name}).x) * 0.5)`;
                    break;
                default:
                    throw new ShaderTranslateError("lod of a resource of dimension " + t.r.dimension);
            }
            this.helpers.add("lod");
            this.write(ins, this.swizzled(`gx_lod(${coords} * ${size}, f32(textureNumLevels(${name})))`, ins.src[1]), "f");
        }

        // ---------------------------------------------------------------
        // Raw and structured buffers, atomics (SM5)

        /**
         * A typed texture UAV: a storage texture of the bound view's format
         * (options.uavFormats; R32 of the declared type when none is bound),
         * read-write if the shader reads it (WebGPU can for R32 formats only,
         * as D3D11.0 can)
         */
        storageTexture(g, slot, u) {
            const t = this.storageInfo(slot, u);
            if (this.uavLoads.has(slot) && t.access !== "read_write") this.warn("typed UAV loads of " + t.format + " read zeros");
            this.bindings.push({ binding: BINDING.UAV + slot, slot, type: "uav-texture", format: t.format, access: t.access, dimension: t.dimension });
            return `@group(${g}) @binding(${BINDING.UAV + slot}) var u${slot}: texture_storage_${t.wgsl}<${t.format}, ${t.access}>;`;
        }

        /** A typed texture UAV's storage format, access, dimension and texel kind */
        storageInfo(slot, u) {
            const info = (this.o.uavFormats || {})[slot] || {};
            const ret = u.returnTypes ? u.returnTypes[0] : RETURN.FLOAT;
            const format = info.format || (ret === RETURN.UINT ? "r32uint" : ret === RETURN.SINT ? "r32sint" : "r32float");
            const access = this.uavLoads.has(slot) && /^r32/.test(format) ? "read_write" : "write";
            const [wgsl, dimension] = {
                [DIM.TEXTURE1D]: ["2d", "2d"], [DIM.TEXTURE2D]: ["2d", "2d"],
                [DIM.TEXTURE1DARRAY]: ["2d_array", "2d-array"], [DIM.TEXTURE2DARRAY]: ["2d_array", "2d-array"],
                [DIM.TEXTURE3D]: ["3d", "3d"],
            }[u.dimension] || [];
            if (!wgsl) throw new ShaderTranslateError("a typed UAV of dimension " + u.dimension);
            const kind = /uint$/.test(format) ? "u" : /sint$/.test(format) ? "i" : "f";
            return { format, access, wgsl, dimension, kind };
        }

        /** A typed UAV's coordinates and layer, from an integer address */
        storageAddress(slot, a) {
            const u = this.p.uavs.get(slot);
            switch (u.dimension) {
                case DIM.TEXTURE1D: return `vec2<i32>(${a}.x, 0)`;
                case DIM.TEXTURE1DARRAY: return `vec2<i32>(${a}.x, 0), ${a}.y`;
                case DIM.TEXTURE2D: return `${a}.xy`;
                case DIM.TEXTURE2DARRAY: return `${a}.xy, ${a}.z`;
                case DIM.TEXTURE3D: return `${a}.xyz`;
            }
            throw new ShaderTranslateError("a typed UAV of dimension " + u.dimension);
        }

        loadTyped(ins) {
            const operand = ins.src[1];
            const slot = operand.indices[0].imm;
            const u = this.p.uavs.get(slot);
            if (!u) throw new ShaderTranslateError("UAV u" + slot + " is not declared");
            if (u.dimension === DIM.BUFFER) {
                const b = this.bufferName(operand);
                const lanes = ((this.o.uavFormats || {})[slot] || {}).lanes || 1;
                const word = k => k < lanes ? `atomicLoad(&u${slot}[${b.base} + base + ${k}u])` : k === 3 ? "1u" : "0u";
                this.line("{");
                this.indent++;
                this.line(`let base = u32(${this.i(ins, 0)}.x) * ${lanes}u;`);
                this.write(ins, this.swizzled(`vec4<u32>(${word(0)}, ${word(1)}, ${word(2)}, ${word(3)})`, operand), "u");
                this.indent--;
                this.line("}");
                return;
            }
            const t = this.storageInfo(slot, u);
            if (t.access !== "read_write") return this.write(ins, "vec4<u32>(0u)", "u");
            this.write(ins, this.swizzled(`textureLoad(u${slot}, ${this.storageAddress(slot, this.i(ins, 0))})`, operand), t.kind);
        }

        storeTyped(ins) {
            const dst = ins.dst[0];
            const slot = dst.indices[0].imm;
            const u = this.p.uavs.get(slot);
            if (!u) throw new ShaderTranslateError("UAV u" + slot + " is not declared");
            if (u.dimension === DIM.BUFFER) {
                const b = this.bufferName(dst);
                const lanes = ((this.o.uavFormats || {})[slot] || {}).lanes || 1;
                this.line("{");
                this.indent++;
                this.line(`let base = u32(${this.i(ins, 0)}.x) * ${lanes}u;`);
                this.line(`let value = ${this.u(ins, 1)};`);
                for (let c = 0; c < lanes; c++) this.line(`atomicStore(&u${slot}[${b.base} + base + ${c}u], value.${LANES[c]});`);
                this.indent--;
                this.line("}");
                return;
            }
            const kind = this.storageInfo(slot, u).kind;
            const value = kind === "u" ? this.u(ins, 1) : kind === "i" ? this.i(ins, 1) : this.f(ins, 1);
            this.line(`textureStore(u${slot}, ${this.storageAddress(slot, this.i(ins, 0))}, ${value});`);
        }

        bufferName(operand) {
            const slot = operand.indices[0].imm;
            // (a view's first element: from GXViews)
            const base = index => { this.usesViews = true; return `gx_view_base(${index}u)`; };
            switch (operand.type) {
                case OPERAND.RESOURCE: return { name: "t" + slot, atomic: false, stride: (this.p.resources.get(slot) || {}).stride || 0,
                    base: base(VIEW_BASE_RESOURCE + slot) };
                case OPERAND.UAV: return { name: "u" + slot, atomic: true, stride: (this.p.uavs.get(slot) || {}).stride || 0,
                    base: base(VIEW_BASE_UAV + slot) };
                case OPERAND.THREAD_GROUP_SHARED_MEMORY: return { name: "g" + slot, atomic: true, stride: (this.p.tgsm.get(slot) || {}).stride || 0,
                    base: "0u" };
            }
            throw new ShaderTranslateError("a buffer operand of type " + operand.type);
        }

        loadRaw(ins, structured) {
            const b = this.bufferName(ins.src[structured ? 2 : 1]);
            const address = structured ? `(u32(${this.u(ins, 0)}.x) * ${b.stride}u + u32(${this.u(ins, 1)}.x)) / 4u` :
                `u32(${this.u(ins, 0)}.x) / 4u`;
            const word = k => b.atomic ? `atomicLoad(&${b.name}[base + ${k}u])` : `${b.name}[base + ${k}u]`;
            this.line("{");
            this.indent++;
            this.line(`let base = ${b.base} + ${address};`);
            this.write(ins, this.swizzled(`vec4<u32>(${word(0)}, ${word(1)}, ${word(2)}, ${word(3)})`, ins.src[structured ? 2 : 1]), "u");
            this.indent--;
            this.line("}");
        }

        storeRaw(ins, structured) {
            const dst = ins.dst[0];
            const b = this.bufferName(dst);
            const address = structured ? `(u32(${this.u(ins, 0)}.x) * ${b.stride}u + u32(${this.u(ins, 1)}.x)) / 4u` :
                `u32(${this.u(ins, 0)}.x) / 4u`;
            const value = this.u(ins, structured ? 2 : 1);
            this.line("{");
            this.indent++;
            this.line(`let base = ${b.base} + ${address};`);
            this.line(`let value = ${value};`);
            let k = 0;
            for (let c = 0; c < 4; c++) {
                if (!(dst.mask >> c & 1)) continue;
                this.line(b.atomic ? `atomicStore(&${b.name}[base + ${k}u], value.${LANES[c]});` : `${b.name}[base + ${k}u] = value.${LANES[c]};`);
                k++;
            }
            this.indent--;
            this.line("}");
        }

        atomic(ins) {
            const immediate = ins.op >= OP.IMM_ATOMIC_ALLOC;
            const target = immediate ? ins.src[0] : ins.dst[0];
            const srcs = immediate ? ins.src.slice(1) : ins.src;
            if (ins.op === OP.IMM_ATOMIC_ALLOC || ins.op === OP.IMM_ATOMIC_CONSUME) {
                // the UAV's hidden counter: the index before the increment, or after the decrement
                const slot = target.indices[0].imm;
                return this.write(ins, ins.op === OP.IMM_ATOMIC_ALLOC ? `vec4<u32>(atomicAdd(&uc${slot}, 1u))` :
                    `vec4<u32>(atomicSub(&uc${slot}, 1u) - 1u)`, "u");
            }
            if (target.type === OPERAND.UAV && (this.p.uavs.get(target.indices[0].imm) || {}).kind === "typed" &&
                this.p.uavs.get(target.indices[0].imm).dimension !== DIM.BUFFER) {
                this.warn("atomics on typed texture UAVs are not supported");
                if (immediate) this.write(ins, "vec4<u32>(0u)", "u");
                return;
            }
            const b = this.bufferName(target);
            const read = i => this.read(srcs[i], "u");
            // raw: a byte address; structured: (element, byte offset); typed buffer: an element
            const typedLanes = target.type === OPERAND.UAV && (this.p.uavs.get(target.indices[0].imm) || {}).kind === "typed" ?
                ((this.o.uavFormats || {})[target.indices[0].imm] || {}).lanes || 1 : 0;
            const address = `${b.base} + ` + (typedLanes ? `${read(0)}.x * ${typedLanes}u` :
                b.stride ? `(${read(0)}.x * ${b.stride}u + ${read(0)}.y) / 4u` : `${read(0)}.x / 4u`);
            const name = {
                [OP.ATOMIC_AND]: "atomicAnd", [OP.ATOMIC_OR]: "atomicOr", [OP.ATOMIC_XOR]: "atomicXor",
                [OP.ATOMIC_IADD]: "atomicAdd", [OP.ATOMIC_UMAX]: "atomicMax", [OP.ATOMIC_UMIN]: "atomicMin",
                [OP.ATOMIC_IMAX]: "atomicMax", [OP.ATOMIC_IMIN]: "atomicMin",
                [OP.IMM_ATOMIC_IADD]: "atomicAdd", [OP.IMM_ATOMIC_AND]: "atomicAnd", [OP.IMM_ATOMIC_OR]: "atomicOr",
                [OP.IMM_ATOMIC_XOR]: "atomicXor", [OP.IMM_ATOMIC_EXCH]: "atomicExchange",
                [OP.IMM_ATOMIC_UMAX]: "atomicMax", [OP.IMM_ATOMIC_UMIN]: "atomicMin",
                [OP.IMM_ATOMIC_IMAX]: "atomicMax", [OP.IMM_ATOMIC_IMIN]: "atomicMin",
            }[ins.op];
            if (ins.op === OP.ATOMIC_IMAX || ins.op === OP.ATOMIC_IMIN || ins.op === OP.IMM_ATOMIC_IMAX || ins.op === OP.IMM_ATOMIC_IMIN) {
                this.warn("signed atomic min/max are done unsigned");
            }
            if (ins.op === OP.ATOMIC_CMP_STORE || ins.op === OP.IMM_ATOMIC_CMP_EXCH) {
                const call = `atomicCompareExchangeWeak(&${b.name}[${address}], ${read(1)}.x, ${read(2)}.x).old_value`;
                if (immediate) this.write(ins, `vec4<u32>(${call})`, "u");
                else this.line(`_ = ${call};`);
                return;
            }
            const call = `${name}(&${b.name}[${address}], ${read(1)}.x)`;
            if (immediate) this.write(ins, `vec4<u32>(${call})`, "u");
            else this.line(`_ = ${call};`);
        }

        // ---------------------------------------------------------------

        helperCode() {
            const h = this.helpers, out = [];
            if (h.has("umul_hi") || h.has("imul_hi")) {
                out.push(`fn gx_umul_hi1(a: u32, b: u32) -> u32 {
    let al = a & 0xFFFFu; let ah = a >> 16u; let bl = b & 0xFFFFu; let bh = b >> 16u;
    let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh;
    let mid = (ll >> 16u) + (lh & 0xFFFFu) + (hl & 0xFFFFu);
    return hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u);
}
fn gx_umul_hi(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> {
    return vec4<u32>(gx_umul_hi1(a.x, b.x), gx_umul_hi1(a.y, b.y), gx_umul_hi1(a.z, b.z), gx_umul_hi1(a.w, b.w));
}`);
            }
            if (h.has("imul_hi")) {
                out.push(`fn gx_imul_hi(a: vec4<i32>, b: vec4<i32>) -> vec4<i32> {
    let ua = bitcast<vec4<u32>>(a); let ub = bitcast<vec4<u32>>(b);
    var hi = gx_umul_hi(ua, ub);
    hi = hi - select(vec4<u32>(0u), ub, a < vec4<i32>(0)) - select(vec4<u32>(0u), ua, b < vec4<i32>(0));
    return bitcast<vec4<i32>>(hi);
}`);
            }
            if (h.has("ubfe")) {
                out.push(`fn gx_ubfe1(w: u32, o: u32, v: u32) -> u32 {
    let width = w & 31u; let offset = o & 31u;
    if (width == 0u) { return 0u; }
    if (width + offset < 32u) { return (v << (32u - width - offset)) >> (32u - width); }
    return v >> offset;
}
fn gx_ubfe(w: vec4<u32>, o: vec4<u32>, v: vec4<u32>) -> vec4<u32> {
    return vec4<u32>(gx_ubfe1(w.x, o.x, v.x), gx_ubfe1(w.y, o.y, v.y), gx_ubfe1(w.z, o.z, v.z), gx_ubfe1(w.w, o.w, v.w));
}`);
            }
            if (h.has("ibfe")) {
                out.push(`fn gx_ibfe1(w: u32, o: u32, v: i32) -> i32 {
    let width = w & 31u; let offset = o & 31u;
    if (width == 0u) { return 0; }
    if (width + offset < 32u) { return (v << (32u - width - offset)) >> (32u - width); }
    return v >> offset;
}
fn gx_ibfe(w: vec4<u32>, o: vec4<u32>, v: vec4<i32>) -> vec4<i32> {
    return vec4<i32>(gx_ibfe1(w.x, o.x, v.x), gx_ibfe1(w.y, o.y, v.y), gx_ibfe1(w.z, o.z, v.z), gx_ibfe1(w.w, o.w, v.w));
}`);
            }
            if (h.has("bfi")) {
                out.push(`fn gx_bfi1(w: u32, o: u32, insert: u32, base: u32) -> u32 {
    let width = w & 31u; let offset = o & 31u;
    let mask = (((1u << width) - 1u) << offset);
    return ((insert << offset) & mask) | (base & ~mask);
}
fn gx_bfi(w: vec4<u32>, o: vec4<u32>, insert: vec4<u32>, base: vec4<u32>) -> vec4<u32> {
    return vec4<u32>(gx_bfi1(w.x, o.x, insert.x, base.x), gx_bfi1(w.y, o.y, insert.y, base.y),
        gx_bfi1(w.z, o.z, insert.z, base.z), gx_bfi1(w.w, o.w, insert.w, base.w));
}`);
            }
            if (h.has("f32tof16")) {
                out.push(`fn gx_f32tof16(v: vec4<f32>) -> vec4<u32> {
    return vec4<u32>(pack2x16float(vec2<f32>(v.x, 0.0)), pack2x16float(vec2<f32>(v.y, 0.0)),
        pack2x16float(vec2<f32>(v.z, 0.0)), pack2x16float(vec2<f32>(v.w, 0.0))) & vec4<u32>(0xFFFFu);
}`);
            }
            if (h.has("f16tof32")) {
                out.push(`fn gx_f16tof32(v: vec4<u32>) -> vec4<f32> {
    return vec4<f32>(unpack2x16float(v.x).x, unpack2x16float(v.y).x, unpack2x16float(v.z).x, unpack2x16float(v.w).x);
}`);
            }
            if (h.has("sample_pos")) {
                // where GX's samples are, in pixels from the center: one at
                // the center, four on the supersampled 2x2 grid (gx_ms_texel);
                // an index past the samples is at 0
                out.push(`fn gx_sample_pos(i: u32, count: u32) -> vec4<f32> {
    if (count != 4u || i >= 4u) { return vec4<f32>(0.0); }
    return vec4<f32>(f32(i & 1u) * 0.5 - 0.25, f32(i >> 1u) * 0.5 - 0.25, 0.0, 0.0);
}`);
            }
            if (h.has("ms_texel")) {
                out.push(`fn gx_ms_texel(sample: u32) -> vec2<i32> {
    return vec2<i32>(i32(sample & 1u), i32((sample >> 1u) & 1u));
}`);
            }
            if (h.has("cube_face")) {
                out.push(`fn gx_cube_face(d: vec3<f32>) -> vec3<f32> {
    let m = max(max(abs(d.x), abs(d.y)), abs(d.z));
    return d / max(m, 1e-30);
}`);
            }
            if (h.has("lod")) {
                // texels: the coordinates scaled by the texture's size
                out.push(`fn gx_lod(texels: vec3<f32>, levels: f32) -> vec4<f32> {
    let dx = dpdx(texels);
    let dy = dpdy(texels);
    let lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-30));
    return vec4<f32>(clamp(lod, 0.0, levels - 1.0), lod, 0.0, 0.0);
}`);
            }
            return out;
        }
    }

    // code inside a switch: every instruction but case/default/endswitch opens its case
    const originalInstruction = Emitter.prototype.instruction;
    Emitter.prototype.instruction = function(ins) {
        if (this.switches.length && ins.op !== OP.CASE && ins.op !== OP.DEFAULT && ins.op !== OP.ENDSWITCH) this.openCase();
        return originalInstruction.call(this, ins);
    };

    function inputRegister(input) {
        const o = input.operand;
        return o && o.indices.length ? o.indices[o.indices.length - 1].imm : input.index;
    }

    /** value with only the masked lanes of `bits` written over `old` */
    function maskInto(old, bits, mask) {
        if (!mask || mask === ALL) return bits;
        const lanes = [0, 1, 2, 3].map(c => mask >> c & 1 ? `(${bits}).${LANES[c]}` : `${old}.${LANES[c]}`);
        return `vec4<u32>(${lanes.join(", ")})`;
    }

    function fromBits(value, type) {
        return type === "u32" ? value : `bitcast<vec4<${type}>>(${value})`;
    }

    /** How a pixel shader input is interpolated, and its type */
    function varyingOf(input) {
        const m = input.interpolation;
        if (m === INTERPOLATION.CONSTANT) return { type: "u32", interpolation: "flat", sampling: "" };
        const linear = m === INTERPOLATION.LINEAR_NOPERSPECTIVE || m === INTERPOLATION.LINEAR_NOPERSPECTIVE_CENTROID ||
            m === INTERPOLATION.LINEAR_NOPERSPECTIVE_SAMPLE;
        const sampling = m === INTERPOLATION.LINEAR_CENTROID || m === INTERPOLATION.LINEAR_NOPERSPECTIVE_CENTROID ? "centroid" :
            m === INTERPOLATION.LINEAR_SAMPLE || m === INTERPOLATION.LINEAR_NOPERSPECTIVE_SAMPLE ? "sample" : "";
        return { type: "f32", interpolation: linear ? "linear" : "perspective", sampling };
    }

    function interpolationAttribute(vary, type) {
        if (type === "u32" || vary.interpolation === "flat") return "@interpolate(flat) ";
        if (vary.interpolation === "linear") return `@interpolate(linear${vary.sampling ? ", " + vary.sampling : ""}) `;
        if (vary.sampling) return `@interpolate(perspective, ${vary.sampling}) `;
        return "";
    }

    /** Without a pixel shader to link with: every output but the position, perspective */
    function defaultVaryings(program) {
        const varyings = {};
        for (const output of program.outputs) {
            if (output.type !== OPERAND.OUTPUT || output.name !== NAME.UNDEFINED) continue;
            varyings[output.index] = { type: "f32", interpolation: "perspective", sampling: "" };
        }
        return varyings;
    }

    /**
     * The varyings a pixel shader reads (for linking a vertex shader to it)
     * @return register -> { type, interpolation, sampling }
     */
    function pixelVaryings(program) {
        const varyings = {};
        for (const input of program.inputs) {
            if (input.type !== OPERAND.INPUT) continue;
            if (input.name !== NAME.UNDEFINED && input.name !== NAME.CLIP_DISTANCE && input.name !== NAME.CULL_DISTANCE) {
                if (input.name !== NAME.PRIMITIVE_ID && input.name !== NAME.RENDER_TARGET_ARRAY_INDEX &&
                    input.name !== NAME.VIEWPORT_ARRAY_INDEX) continue;
            }
            if (input.name !== NAME.UNDEFINED) continue;
            varyings[inputRegister(input)] = varyingOf(input);
        }
        return varyings;
    }

    const api = { emit, pixelVaryings, ShaderTranslateError, BINDING };
    if (typeof module === "object" && module.exports) module.exports = api;
    else global.V86WGSLEmitter = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
