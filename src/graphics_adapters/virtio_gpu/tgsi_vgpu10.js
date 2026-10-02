// TGSI (tgsi.js parses virgl's text) into VGPU10 tokens, the shaders GX
// runs (src/browser/glbridge/shader_ir/dxbc_frontend.js decodes them), as
// Mesa's svga driver does on VMware (svga_tgsi_vgpu10.c), for the subset
// of TGSI Mesa's nir_to_tgsi makes for GL 3.3 / GLES 3.0.
//
// What GL wants and D3D does not have is put in here, so that GX stays a
// D3D renderer; each is part of the variant key a program is translated for:
// - linkage: D3D matches a stage's outputs to the next one's inputs by
//   register, GL by semantic (GENERIC[3]): the next stage's input registers
//   (key.outputs, semantic -> register) say where a stage writes each;
// - the viewport: gallium's may flip Y (GL's framebuffer objects) and map
//   depth from [-1, 1] (clip_halfz off); D3D's cannot, so the last vertex
//   stage flips Y (key.flip_y) and moves Z into [0, 1] (key.halfz off);
// - sampler views have swizzles (GL's texture swizzle, the luminance and
//   alpha formats): applied after each sample (key.swizzles);
// - gl_FragColor into every bound color buffer (FS_COLOR0_WRITES_ALL_CBUFS,
//   key.color_buffers), flat shaded COLOR inputs (key.flatshade), the
//   fragment position GL sees (1/w, integer pixel centers), FACE as +-1.
//
// Registers: TGSI TEMP n is r n, TEMP arrays indexable x(array id), ADDR n
// a temp after those, then the temps the translation needs. VS inputs are
// their vertex elements' registers; FS inputs keep their TGSI index (which
// the previous stage's outputs are moved to).

// VGPU10 opcodes (VGPU10_OPCODE_TYPE)
const OP = {
    ADD: 0, AND: 1, BREAK: 2, CASE: 6, CONTINUE: 7, CUT: 9, DEFAULT: 10, DERIV_RTX: 11, DERIV_RTY: 12,
    DISCARD: 13, DIV: 14, DP2: 15, DP3: 16, DP4: 17, ELSE: 18, EMIT: 19, ENDIF: 21, ENDLOOP: 22, ENDSWITCH: 23,
    EQ: 24, EXP: 25, FRC: 26, FTOI: 27, FTOU: 28, GE: 29, IADD: 30, IF: 31, IEQ: 32, IGE: 33, ILT: 34,
    IMAD: 35, IMAX: 36, IMIN: 37, IMUL: 38, INE: 39, INEG: 40, ISHL: 41, ISHR: 42, ITOF: 43, LD: 45, LD_MS: 46,
    LOG: 47, LOOP: 48, LT: 49, MAD: 50, MIN: 51, MAX: 52, CUSTOMDATA: 53, MOV: 54, MOVC: 55, MUL: 56, NE: 57,
    NOP: 58, NOT: 59, OR: 60, RESINFO: 61, RET: 62, ROUND_NE: 64, ROUND_NI: 65, ROUND_PI: 66, ROUND_Z: 67,
    RSQ: 68, SAMPLE: 69, SAMPLE_C: 70, SAMPLE_C_LZ: 71, SAMPLE_L: 72, SAMPLE_D: 73, SAMPLE_B: 74, SQRT: 75,
    SWITCH: 76, SINCOS: 77, UDIV: 78, ULT: 79, UGE: 80, UMUL: 81, UMAD: 82, UMAX: 83, UMIN: 84, USHR: 85,
    UTOF: 86, XOR: 87, DCL_RESOURCE: 88, DCL_CONSTANT_BUFFER: 89, DCL_SAMPLER: 90,
    DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY: 92, DCL_GS_INPUT_PRIMITIVE: 93, DCL_MAX_OUTPUT_VERTEX_COUNT: 94,
    DCL_INPUT: 95, DCL_INPUT_SGV: 96, DCL_INPUT_SIV: 97, DCL_INPUT_PS: 98, DCL_INPUT_PS_SGV: 99,
    DCL_INPUT_PS_SIV: 100, DCL_OUTPUT: 101, DCL_OUTPUT_SGV: 102, DCL_OUTPUT_SIV: 103, DCL_TEMPS: 104,
    DCL_INDEXABLE_TEMP: 105, VMWARE: 107, LOD: 108, GATHER4: 109, SAMPLE_INFO: 111, BUFINFO: 121,
    DERIV_RTX_COARSE: 122, DERIV_RTX_FINE: 123, DERIV_RTY_COARSE: 124, DERIV_RTY_FINE: 125, GATHER4_C: 126,
    GATHER4_PO: 127, GATHER4_PO_C: 128, RCP: 129, F32TOF16: 130, F16TOF32: 131, COUNTBITS: 134,
    FIRSTBIT_HI: 135, FIRSTBIT_LO: 136, FIRSTBIT_SHI: 137, UBFE: 138, IBFE: 139, BFI: 140, BFREV: 141,
    EVAL_SNAPPED: 203, EVAL_SAMPLE_INDEX: 204, EVAL_CENTROID: 205,
};
const VMWARE_IDIV = 0;

// operand types (VGPU10_OPERAND_TYPE)
const T = {
    TEMP: 0, INPUT: 1, OUTPUT: 2, INDEXABLE_TEMP: 3, IMMEDIATE32: 4, SAMPLER: 6, RESOURCE: 7, CONSTANT_BUFFER: 8,
    IMMEDIATE_CONSTANT_BUFFER: 9, INPUT_PRIMITIVEID: 11, OUTPUT_DEPTH: 12, NULL: 13, OUTPUT_COVERAGE_MASK: 15,
    INPUT_COVERAGE_MASK: 35,
};
// system value names (VGPU10_SYSTEM_NAME)
const NAME = { POSITION: 1, CLIP_DISTANCE: 2, RENDER_TARGET_ARRAY_INDEX: 4, VIEWPORT_ARRAY_INDEX: 5, VERTEX_ID: 6,
    PRIMITIVE_ID: 7, INSTANCE_ID: 8, IS_FRONT_FACE: 9, SAMPLE_INDEX: 10 };
// interpolation modes (VGPU10_INTERPOLATION_MODE)
const INTERP = { CONSTANT: 1, LINEAR: 2, LINEAR_CENTROID: 3, LINEAR_NOPERSPECTIVE: 4, LINEAR_NOPERSPECTIVE_CENTROID: 5,
    LINEAR_SAMPLE: 6, LINEAR_NOPERSPECTIVE_SAMPLE: 7 };
// resource dimensions (VGPU10_RESOURCE_DIMENSION)
const DIM = { BUFFER: 1, TEXTURE1D: 2, TEXTURE2D: 3, TEXTURE2DMS: 4, TEXTURE3D: 5, TEXTURECUBE: 6, TEXTURE1DARRAY: 7,
    TEXTURE2DARRAY: 8, TEXTURE2DMSARRAY: 9, TEXTURECUBEARRAY: 10 };
// resource return types (VGPU10_RESOURCE_RETURN_TYPE)
const RETURN = { UNORM: 1, SNORM: 2, SINT: 3, UINT: 4, FLOAT: 5 };
// VGPU10_PRIMITIVE and VGPU10_PRIMITIVE_TOPOLOGY
const GS_INPUT = { POINTS: 1, LINES: 2, TRIANGLES: 3, LINES_ADJACENCY: 6, TRIANGLES_ADJACENCY: 7 };
const GS_INPUT_VERTICES = { POINTS: 1, LINES: 2, TRIANGLES: 3, LINES_ADJACENCY: 4, TRIANGLES_ADJACENCY: 6 };
const GS_OUTPUT = { POINTS: 1, LINE_STRIP: 3, TRIANGLE_STRIP: 5 };

/** The program types of VGPU10 (VGPU10_PROGRAM_TYPE), by TGSI processor */
const PROGRAM = [1, 0, 2, 3, 4, 5];
/** ... and SVGA3D shader types (SVGA3D_SHADERTYPE_*), as GX's SET_SHADER takes them */
export const SVGA_SHADER_TYPE = [1, 2, 3, 4, 5, 6];

const PIPE_SWIZZLE_0 = 4, PIPE_SWIZZLE_1 = 5;

/** The resource dimension of a TGSI texture target, and how many coordinates it reads */
const TARGETS = {
    BUFFER: [DIM.BUFFER, 1], "1D": [DIM.TEXTURE1D, 1], "2D": [DIM.TEXTURE2D, 2], "3D": [DIM.TEXTURE3D, 3],
    CUBE: [DIM.TEXTURECUBE, 3], RECT: [DIM.TEXTURE2D, 2], SHADOW1D: [DIM.TEXTURE1D, 1], SHADOW2D: [DIM.TEXTURE2D, 2],
    SHADOWRECT: [DIM.TEXTURE2D, 2], "1D_ARRAY": [DIM.TEXTURE1DARRAY, 2], "2D_ARRAY": [DIM.TEXTURE2DARRAY, 3],
    SHADOW1D_ARRAY: [DIM.TEXTURE1DARRAY, 2], SHADOW2D_ARRAY: [DIM.TEXTURE2DARRAY, 3], SHADOWCUBE: [DIM.TEXTURECUBE, 3],
    "2D_MSAA": [DIM.TEXTURE2DMS, 2], "2D_ARRAY_MSAA": [DIM.TEXTURE2DMSARRAY, 3], CUBE_ARRAY: [DIM.TEXTURECUBEARRAY, 4],
    SHADOWCUBE_ARRAY: [DIM.TEXTURECUBEARRAY, 4],
};
/** Where a shadow target's reference value is in the coordinates (-1: the second source's x) */
const SHADOW_REF = { SHADOW1D: 2, SHADOW2D: 2, SHADOWRECT: 2, SHADOW1D_ARRAY: 2, SHADOW2D_ARRAY: 3, SHADOWCUBE: 3,
    SHADOWCUBE_ARRAY: -1 };

export class TGSITranslateError extends Error {}

const f32_bits = (() => {
    const f = new Float32Array(1), u = new Uint32Array(f.buffer);
    return x => { f[0] = x; return u[0]; };
})();
const ONE_F = 0x3F800000;

// ---------------------------------------------------------------------------
// Operands: { type, idx: [{imm, rel}], ncomp: 0 | 1 | 4, mode: "mask" |
// "swizzle" | "select", mask, swz, mod (1 neg, 2 abs, 3 both), imm }

/**
 * @param {number} type
 * @param {!Array} indices numbers, or {imm, rel}
 * @param {number=} ncomp 0, 1 or 4 (the default)
 * @return {!Object}
 */
function operand(type, indices, ncomp)
{
    return { type, idx: indices.map(i => typeof i === "number" ? { imm: i, rel: null } : i), ncomp: ncomp === undefined ? 4 : ncomp,
        mode: "swizzle", mask: 0xF, swz: [0, 1, 2, 3], mod: 0, imm: null };
}

/**
 * A 4-component immediate
 * @return {!Object}
 */
function imm4(a, b, c, d)
{
    const o = operand(T.IMMEDIATE32, [], 4);
    o.imm = [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
    return o;
}
/** @param {number} a @param {number=} b @param {number=} c @param {number=} d */
const immf = (a, b, c, d) => imm4(f32_bits(a), f32_bits(b === undefined ? a : b), f32_bits(c === undefined ? a : c), f32_bits(d === undefined ? a : d));
/** @param {number} a @param {number=} b @param {number=} c @param {number=} d */
const immu = (a, b, c, d) => imm4(a, b === undefined ? a : b, c === undefined ? a : c, d === undefined ? a : d);

/**
 * A copy as a destination with a write mask
 * @param {!Object} o
 * @param {number=} mask
 * @return {!Object}
 */
function as_dst(o, mask)
{
    return Object.assign({}, o, { mode: "mask", mask: mask === undefined ? 0xF : mask, mod: 0 });
}

/**
 * A copy as a source with a swizzle
 * @param {!Object} o
 * @param {Array<number>=} swz
 * @param {number=} mod
 * @return {!Object}
 */
function as_src(o, swz, mod)
{
    if(o.type === T.IMMEDIATE32)
    {
        const s = swz || [0, 1, 2, 3];
        return Object.assign({}, o, { imm: s.map(c => o.imm[c]), mod: mod || 0 });
    }
    return Object.assign({}, o, { mode: "swizzle", swz: swz || [0, 1, 2, 3], mod: mod || 0 });
}

/** One component of a source (after its swizzle), replicated */
const scalar = (o, c) => o.type === T.IMMEDIATE32 ? as_src(o, [c, c, c, c], o.mod) :
    as_src(o, [o.swz[c], o.swz[c], o.swz[c], o.swz[c]], o.mod);

/** A swizzle composed after another: s2 picks from what s1 gave */
const compose = (s1, s2) => s2.map(c => s1[c]);

function encode_operand(o, out)
{
    if(o.type === T.IMMEDIATE32)
    {
        const one = o.ncomp === 1;
        let token = (one ? 1 : 2) | T.IMMEDIATE32 << 12;
        const words = one ? [o.imm[0]] : o.imm;
        if(o.mod)
        {
            out.push((token | 1 << 31) >>> 0, 1 | o.mod << 6);
        }
        else out.push(token >>> 0);
        for(const w of words) out.push(w >>> 0);
        return;
    }
    let token = o.ncomp === 0 ? 0 : o.ncomp === 1 ? 1 : 2;
    if(o.ncomp === 4)
    {
        if(o.mode === "mask") token |= 0 << 2 | (o.mask & 0xF) << 4;
        else if(o.mode === "select") token |= 2 << 2 | (o.swz[0] & 3) << 4;
        else token |= 1 << 2 | o.swz[0] << 4 | o.swz[1] << 6 | o.swz[2] << 8 | o.swz[3] << 10;
    }
    token |= o.type << 12 | o.idx.length << 20;
    o.idx.forEach((index, d) => {
        const representation = index.rel ? (index.imm ? 3 : 2) : 0;
        token |= representation << (22 + 3 * d);
    });
    if(o.mod) token |= 1 << 31;
    out.push(token >>> 0);
    if(o.mod) out.push(1 | o.mod << 6);
    for(const index of o.idx)
    {
        if(!index.rel || index.imm) out.push(index.imm >>> 0);
        if(index.rel) encode_operand(index.rel, out);
    }
}

// ---------------------------------------------------------------------------

/**
 * @constructor
 * @param {!Object} program from parse_tgsi
 * @param {!Object} key the variant
 */
function Translator(program, key)
{
    this.p = program;
    this.key = key;
    this.processor = program.processor;
    this.vs = program.processor === 0;
    this.fs = program.processor === 1;
    this.gs = program.processor === 2;
    /** @type {!Array<number>} the instructions */
    this.code = [];
    /** @type {!Array<number>} the declarations */
    this.decls = [];
    /** @type {!Array<string>} what could not be translated */
    this.problems = [];
}

Translator.prototype.problem = function(text)
{
    if(!this.problems.includes(text)) this.problems.push(text);
};

/**
 * An instruction: opcode, operands, controls (saturate: 1 << 2, test nonzero: 1 << 7)
 * @param {number} op
 * @param {!Array<!Object>} operands
 * @param {number=} controls
 * @param {Array<number>=} extended
 */
Translator.prototype.emit = function(op, operands, controls, extended)
{
    const body = [];
    for(const o of operands) encode_operand(o, body);
    const ext = extended || [];
    const length = 1 + ext.length + body.length;
    this.code.push((op | (controls || 0) << 11 | length << 24 | (ext.length ? 1 << 31 : 0)) >>> 0, ...ext, ...body);
};

/**
 * @param {number} op
 * @param {!Array<!Object>} operands
 * @param {number=} controls
 * @param {Array<number>=} words
 */
Translator.prototype.decl = function(op, operands, controls, words)
{
    const body = [];
    for(const o of operands) encode_operand(o, body);
    if(words) body.push(...words);
    this.decls.push((op | (controls || 0) << 11 | (1 + body.length) << 24) >>> 0, ...body);
};

/** A temp for this instruction */
Translator.prototype.scratch = function()
{
    const r = this.scratch_base + this.scratch_used++;
    this.temps = Math.max(this.temps, r + 1);
    return operand(T.TEMP, [r]);
};

/** A temp for the whole program */
Translator.prototype.reserve = function()
{
    const r = this.next_temp++;
    this.temps = Math.max(this.temps, r + 1);
    return operand(T.TEMP, [r]);
};

// ---------------------------------------------------------------------------
// Declarations

Translator.prototype.scan = function()
{
    const p = this.p;
    let temps = 0, addrs = 0;
    this.arrays = new Map();    // TGSI array id -> { first, last }
    this.inputs = [];           // IN declarations, by index
    this.outputs = [];
    this.svs = [];
    this.cbuffers = new Map();  // slot -> size (vec4s)
    this.sviews = new Map();    // slot -> { target, return_types }
    this.samplers = new Map();  // slot -> { shadow }
    this.indirect_imm = false;
    for(const d of p.decls)
    {
        switch(d.file)
        {
            case "TEMP":
                if(d.array) this.arrays.set(d.array, { first: d.first, last: d.last });
                else temps = Math.max(temps, d.last + 1);
                break;
            case "ADDR": addrs = Math.max(addrs, d.last + 1); break;
            case "IN": for(let i = d.first; i <= d.last; i++) this.inputs[i] = Object.assign({}, d, { semantic_index: d.semantic_index + i - d.first }); break;
            case "OUT": for(let i = d.first; i <= d.last; i++) this.outputs[i] = Object.assign({}, d, { semantic_index: d.semantic_index + i - d.first }); break;
            case "SV": for(let i = d.first; i <= d.last; i++) this.svs[i] = d; break;
            case "CONST": this.cbuffers.set(d.two_d ? d.dim : 0, Math.max(this.cbuffers.get(d.two_d ? d.dim : 0) || 0, d.last + 1)); break;
            case "SVIEW": for(let i = d.first; i <= d.last; i++) this.sviews.set(i, { target: d.target, return_types: d.return_types }); break;
            case "SAMP": for(let i = d.first; i <= d.last; i++) this.samplers.set(i, { shadow: false, used: false }); break;
            case "IMM": break;
            default: this.problem("declarations of " + d.file);
        }
    }
    // what the code uses: the arrays' indirect accesses, immediates read
    // indirectly (an immediate constant buffer then), the sampler targets
    for(const ins of p.code)
    {
        for(const o of [...ins.src, ...ins.dst])
        {
            if(o.file === "IMM" && o.rel) this.indirect_imm = true;
            if(o.file === "CONST" && o.rel) this.cbuffers.set(o.has_dim ? o.dim : 0, Math.max(this.cbuffers.get(o.has_dim ? o.dim : 0) || 0, 4096));
            if(o.file === "TEMP" && !o.array) temps = Math.max(temps, o.index + 1);
        }
        if(ins.target)
        {
            const samp = ins.src.find(o => o.file === "SAMP");
            if(samp)
            {
                const s = this.samplers.get(samp.index) || { shadow: false };
                s.used = true;
                if(ins.target.startsWith("SHADOW") && ins.op !== "TXQ" && ins.op !== "TXF") s.shadow = true;
                this.samplers.set(samp.index, s);
                if(!this.sviews.has(samp.index)) this.sviews.set(samp.index, { target: ins.target, return_types: null });
                const view = this.sviews.get(samp.index);
                if(!view.target) view.target = ins.target;
                view.used_target = ins.target;
            }
        }
    }
    this.temp_count = temps;
    this.addr_base = temps;
    this.next_temp = temps + addrs;
    this.temps = this.next_temp;
};

/** The VGPU10 interpolation of a TGSI fragment input */
Translator.prototype.interpolation = function(d)
{
    let mode = d.interpolate || "PERSPECTIVE";
    if(mode === "COLOR") mode = this.key.flatshade ? "CONSTANT" : "PERSPECTIVE";
    if(mode === "CONSTANT") return INTERP.CONSTANT;
    const linear = mode === "LINEAR";
    if(d.location === "CENTROID") return linear ? INTERP.LINEAR_NOPERSPECTIVE_CENTROID : INTERP.LINEAR_CENTROID;
    if(d.location === "SAMPLE") return linear ? INTERP.LINEAR_NOPERSPECTIVE_SAMPLE : INTERP.LINEAR_SAMPLE;
    return linear ? INTERP.LINEAR_NOPERSPECTIVE : INTERP.LINEAR;
};

/** "GENERIC3": how stages name a varying to each other */
export function semantic_key(name, index)
{
    return name + index;
}

/**
 * Inputs, outputs, buffers, views, samplers; and what reading or writing
 * each TGSI register means (this.in_map, this.out_map, this.sv_map)
 */
Translator.prototype.declare = function()
{
    const key = this.key;
    const reg_in = i => operand(T.INPUT, [i]);
    /** the varyings a stage reads: semantic key -> register (where the previous stage writes them) */
    this.link_inputs = {};
    this.in_map = [];
    this.out_map = [];
    this.sv_map = [];
    /** what the epilogue copies: [temp, function(temp) emitting the copy] */
    this.epilogue = [];
    const input_count = this.inputs.length;

    // inputs
    if(this.vs)
    {
        this.inputs.forEach((d, i) => {
            if(!d) return;
            this.decl(OP.DCL_INPUT, [as_dst(reg_in(i))]);
            this.in_map[i] = reg_in(i);
        });
    }
    else if(this.fs)
    {
        this.inputs.forEach((d, i) => {
            if(!d) return;
            this.fs_input(d, i, i);
        });
    }
    else if(this.gs)
    {
        const prim = (this.p.properties.GS_INPUT_PRIMITIVE || ["TRIANGLES"])[0];
        this.gs_vertices = GS_INPUT_VERTICES[prim] || 3;
        this.decl(OP.DCL_GS_INPUT_PRIMITIVE, [], GS_INPUT[prim] || GS_INPUT.TRIANGLES);
        const topology = (this.p.properties.GS_OUTPUT_PRIMITIVE || ["TRIANGLE_STRIP"])[0];
        this.decl(OP.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY, [], GS_OUTPUT[topology] || GS_OUTPUT.TRIANGLE_STRIP);
        this.decl(OP.DCL_MAX_OUTPUT_VERTEX_COUNT, [], 0, [+(this.p.properties.GS_MAX_OUTPUT_VERTICES || [1])[0]]);
        this.inputs.forEach((d, i) => {
            if(!d) return;
            const o = operand(T.INPUT, [this.gs_vertices, i]);
            if(d.semantic === "POSITION") this.decl(OP.DCL_INPUT_SIV, [as_dst(o)], 0, [NAME.POSITION]);
            else if(d.semantic === "PRIMID") { this.in_map[i] = operand(T.INPUT_PRIMITIVEID, [], 1); return; }
            else this.decl(OP.DCL_INPUT, [as_dst(o)]);
            this.in_map[i] = "gs";
            this.link_inputs[semantic_key(d.semantic, d.semantic_index)] = i;
        });
    }
    // system values: after the inputs
    this.svs.forEach((d, i) => {
        if(!d) return;
        const reg = input_count + i;
        const name = d.semantic;
        if(this.vs && (name === "VERTEXID" || name === "INSTANCEID"))
        {
            this.decl(OP.DCL_INPUT_SGV, [as_dst(reg_in(reg), 1)], 0, [name === "VERTEXID" ? NAME.VERTEX_ID : NAME.INSTANCE_ID]);
            this.sv_map[i] = scalar(reg_in(reg), 0);
        }
        else if(this.fs && (name === "FACE" || name === "POSITION" || name === "SAMPLEID"))
        {
            this.fs_input(d, reg, -1);
            this.sv_map[i] = this.in_map[reg];
        }
        else if(this.fs && name === "SAMPLEMASK")
        {
            this.sv_map[i] = operand(T.INPUT_COVERAGE_MASK, [], 1);
            this.decl(OP.DCL_INPUT, [as_dst(operand(T.INPUT_COVERAGE_MASK, [], 1), 1)]);
        }
        else if(name === "PRIMID")
        {
            this.sv_map[i] = operand(T.INPUT_PRIMITIVEID, [], 1);
            this.decl(OP.DCL_INPUT, [operand(T.INPUT_PRIMITIVEID, [], 0)]);
        }
        else if(name === "HELPER_INVOCATION")
        {
            this.sv_map[i] = immu(0);
        }
        else
        {
            this.problem("system value " + name);
            this.sv_map[i] = immu(0);
        }
    });

    // outputs
    if(this.fs)
    {
        const broadcast = (this.p.properties.FS_COLOR0_WRITES_ALL_CBUFS || [])[0] === "1";
        const buffers = broadcast ? Math.max(1, key.color_buffers || 1) : 1;
        // GL's alpha test (compatibility profiles) reads color 0 at the end
        const alpha_test = key.alpha_func !== undefined && key.alpha_func !== 7;
        this.outputs.forEach((d, i) => {
            if(!d) return;
            if(d.semantic === "COLOR")
            {
                const o = operand(T.OUTPUT, [d.semantic_index]);
                if((broadcast || alpha_test) && d.semantic_index === 0)
                {
                    const temp = this.reserve();
                    this.out_map[i] = temp;
                    for(let b = 0; b < buffers; b++)
                    {
                        this.decl(OP.DCL_OUTPUT, [as_dst(operand(T.OUTPUT, [b]))]);
                        this.epilogue.push(() => this.emit(OP.MOV, [as_dst(operand(T.OUTPUT, [b])), as_src(temp)]));
                    }
                    this.color0 = temp;
                    return;
                }
                this.decl(OP.DCL_OUTPUT, [as_dst(o)]);
                this.out_map[i] = o;
                if(d.semantic_index === 0) this.color0 = o;
            }
            else if(d.semantic === "POSITION")
            {
                // depth: what TGSI writes into z
                const temp = this.reserve();
                this.out_map[i] = temp;
                this.decl(OP.DCL_OUTPUT, [operand(T.OUTPUT_DEPTH, [], 1)]);
                this.epilogue.push(() => this.emit(OP.MOV, [operand(T.OUTPUT_DEPTH, [], 1), scalar(temp, 2)]));
            }
            else if(d.semantic === "SAMPLEMASK")
            {
                const temp = this.reserve();
                this.out_map[i] = temp;
                this.decl(OP.DCL_OUTPUT, [operand(T.OUTPUT_COVERAGE_MASK, [], 1)]);
                this.epilogue.push(() => this.emit(OP.MOV, [operand(T.OUTPUT_COVERAGE_MASK, [], 1), scalar(temp, 0)]));
            }
            else
            {
                this.problem("fragment output " + d.semantic);
                this.out_map[i] = this.junk();
            }
        });
        // GL's alpha test (compatibility profiles), after the color is known
        if(alpha_test && this.color0)
        {
            const color0 = this.color0;
            this.epilogue.unshift(() => this.alpha_test(color0));
        }
    }
    else if(this.vs || this.gs)
    {
        const outputs = key.outputs || {};
        const used = new Set(Object.values(outputs));
        let next = 0;
        const free = () => { while(used.has(next)) next++; used.add(next); return next; };
        this.outputs.forEach((d, i) => {
            if(!d) return;
            const name = d.semantic;
            if(name === "POSITION")
            {
                const reg = free();
                const o = operand(T.OUTPUT, [reg]);
                this.decl(OP.DCL_OUTPUT_SIV, [as_dst(o)], 0, [NAME.POSITION]);
                // into a temp: the viewport's fixes are made at the end (at each vertex of a GS)
                const temp = this.reserve();
                this.out_map[i] = temp;
                this.epilogue.push(() => this.position_out(o, temp));
                return;
            }
            const k = semantic_key(name, d.semantic_index);
            if(k in outputs)
            {
                const o = operand(T.OUTPUT, [outputs[k]]);
                if(name === "LAYER") this.decl(OP.DCL_OUTPUT_SIV, [as_dst(o, 1)], 0, [NAME.RENDER_TARGET_ARRAY_INDEX]);
                else if(name === "VIEWPORT_INDEX") this.decl(OP.DCL_OUTPUT_SIV, [as_dst(o, 1)], 0, [NAME.VIEWPORT_ARRAY_INDEX]);
                else if(name === "PRIMID" && this.gs) this.decl(OP.DCL_OUTPUT_SGV, [as_dst(o, 1)], 0, [NAME.PRIMITIVE_ID]);
                else this.decl(OP.DCL_OUTPUT, [as_dst(o)]);
                this.out_map[i] = o;
                return;
            }
            // what nothing after reads (or D3D has no place for: point
            // sizes, clip vertices, edge flags) goes nowhere
            if(name === "CLIPDIST") this.problem("clip distances");
            this.out_map[i] = this.junk();
        });
    }

    // constant buffers, samplers, views
    for(const [slot, size] of [...this.cbuffers.entries()].sort((a, b) => a[0] - b[0]))
    {
        const dynamic = size >= 4096 ? 1 : 0;
        this.decl(OP.DCL_CONSTANT_BUFFER, [operand(T.CONSTANT_BUFFER, [slot, Math.min(size, 4096)])], dynamic);
    }
    for(const [slot, s] of this.samplers)
    {
        if(!s.used) continue;
        this.decl(OP.DCL_SAMPLER, [operand(T.SAMPLER, [slot], 0)], s.shadow ? 1 : 0);
    }
    for(const [slot, v] of this.sviews)
    {
        const target = v.target || v.used_target || "2D";
        const dimension = (TARGETS[target] || TARGETS["2D"])[0];
        const types = (v.return_types || ["FLOAT", "FLOAT", "FLOAT", "FLOAT"]).map(t => RETURN[t] || RETURN.FLOAT);
        this.decl(OP.DCL_RESOURCE, [operand(T.RESOURCE, [slot], 0)], dimension, [types[0] | types[1] << 4 | types[2] << 8 | types[3] << 12]);
        v.integer = types[0] === RETURN.SINT || types[0] === RETURN.UINT;
    }
    // indexable temps
    for(const [id, a] of this.arrays)
    {
        this.decls.push((OP.DCL_INDEXABLE_TEMP | 4 << 24) >>> 0, id, a.last - a.first + 1, 4);
    }
};

/** A temp nothing reads: the place of outputs that go nowhere */
Translator.prototype.junk = function()
{
    if(!this.junk_temp) this.junk_temp = this.reserve();
    return this.junk_temp;
};

/**
 * A fragment input at register `reg`, TGSI's IN `index` (-1: a system value)
 */
Translator.prototype.fs_input = function(d, reg, index)
{
    const v = operand(T.INPUT, [reg]);
    switch(d.semantic)
    {
        case "POSITION":
        {
            // GL's fragment position: 1/w, maybe integer pixel centers
            this.decl(OP.DCL_INPUT_PS_SIV, [as_dst(v)], INTERP.LINEAR_NOPERSPECTIVE, [NAME.POSITION]);
            const temp = this.reserve();
            this.prologue_ops.push(() => {
                this.emit(OP.MOV, [as_dst(temp, 0b0111), as_src(v)]);
                this.emit(OP.RCP, [as_dst(temp, 0b1000), scalar(v, 3)]);
                if((this.p.properties.FS_COORD_PIXEL_CENTER || [])[0] === "INTEGER")
                {
                    this.emit(OP.ADD, [as_dst(temp, 0b0011), as_src(temp), immf(-0.5)]);
                }
            });
            this.in_map[reg] = temp;
            return;
        }
        case "FACE":
        {
            this.decl(OP.DCL_INPUT_PS_SGV, [as_dst(v, 1)], INTERP.CONSTANT, [NAME.IS_FRONT_FACE]);
            const temp = this.reserve();
            this.prologue_ops.push(() => this.emit(OP.MOVC, [as_dst(temp), scalar(v, 0), immf(1), immf(-1)]));
            this.in_map[reg] = temp;
            return;
        }
        case "SAMPLEID":
            this.decl(OP.DCL_INPUT_PS_SGV, [as_dst(v, 1)], INTERP.CONSTANT, [NAME.SAMPLE_INDEX]);
            this.in_map[reg] = scalar(v, 0);
            return;
        case "PRIMID":
            this.decl(OP.DCL_INPUT_PS_SGV, [as_dst(v, 1)], INTERP.CONSTANT, [NAME.PRIMITIVE_ID]);
            this.in_map[reg] = scalar(v, 0);
            return;
    }
    this.decl(OP.DCL_INPUT_PS, [as_dst(v)], this.interpolation(d));
    this.in_map[reg] = v;
    if(index >= 0) this.link_inputs[semantic_key(d.semantic, d.semantic_index)] = reg;
};

/** The position as D3D wants it: Y flipped, Z from [-w, w] into [0, w] */
Translator.prototype.position_out = function(o, temp)
{
    const key = this.key;
    this.emit(OP.MOV, [as_dst(o, key.flip_y ? 0b1101 : 0b1111), as_src(temp)]);
    if(key.flip_y) this.emit(OP.MOV, [as_dst(o, 0b0010), as_src(temp, [1, 1, 1, 1], 1)]);
    if(!key.halfz)
    {
        const t = this.scratch();
        this.emit(OP.ADD, [as_dst(t, 0b0100), as_src(temp, [2, 2, 2, 2]), as_src(temp, [3, 3, 3, 3])]);
        this.emit(OP.MUL, [as_dst(o, 0b0100), as_src(t, [2, 2, 2, 2]), immf(0.5)]);
    }
};

/** GL's alpha test: discard what fails (key.alpha_func: PIPE_FUNC_*, key.alpha_ref) */
Translator.prototype.alpha_test = function(color)
{
    const f = this.key.alpha_func;
    const t = this.scratch();
    const a = as_src(color, [3, 3, 3, 3]), ref = immf(this.key.alpha_ref || 0);
    if(f === 0)
    {
        this.emit(OP.DISCARD, [immu(0xFFFFFFFF)], 1 << 7);
        return;
    }
    // the passing condition, then discard where it is zero
    const tests = { 1: [OP.LT, a, ref], 2: [OP.EQ, a, ref], 3: [OP.GE, ref, a], 4: [OP.LT, ref, a], 5: [OP.NE, a, ref], 6: [OP.GE, a, ref] };
    const [op, x, y] = tests[f];
    this.emit(op, [as_dst(t, 1), x, y]);
    this.emit(OP.DISCARD, [scalar(t, 0)], 0);
};

// ---------------------------------------------------------------------------
// Registers of instructions

/** A TGSI register's VGPU10 operand (its indices), before the swizzle or mask */
Translator.prototype.register = function(r, write)
{
    const rel = r.rel ? this.addr(r.rel) : null;
    switch(r.file)
    {
        case "TEMP":
        {
            if(r.array && this.arrays.has(r.array))
            {
                const a = this.arrays.get(r.array);
                return operand(T.INDEXABLE_TEMP, [r.array, { imm: r.index - (rel ? 0 : a.first), rel }]);
            }
            if(rel)
            {
                this.problem("indirect temps outside of arrays");
                return operand(T.TEMP, [r.index]);
            }
            return operand(T.TEMP, [r.index]);
        }
        case "ADDR":
            return operand(T.TEMP, [this.addr_base + r.index]);
        case "IN":
        {
            if(this.gs)
            {
                const vertex = r.dim_rel ? { imm: r.dim, rel: this.addr(r.dim_rel) } : r.dim;
                const m = this.in_map[r.index];
                if(m && m !== "gs") return m;
                return operand(T.INPUT, [vertex, rel ? { imm: r.index, rel } : r.index]);
            }
            if(rel) return operand(T.INPUT, [{ imm: r.index, rel }]);
            const m = this.in_map[r.index];
            if(!m)
            {
                this.problem("an undeclared input");
                return immu(0);
            }
            return m;
        }
        case "OUT":
        {
            const m = this.out_map[r.index];
            if(rel)
            {
                // an output array: the registers after the first's
                if(m && m.type === T.OUTPUT) return operand(T.OUTPUT, [{ imm: m.idx[0].imm, rel }]);
                this.problem("indirect outputs");
            }
            if(!m)
            {
                this.problem("an undeclared output");
                return this.junk();
            }
            if(!write && m.type === T.OUTPUT) this.problem("reading an output");
            return m;
        }
        case "CONST":
        {
            const slot = r.has_dim ? r.dim : 0;
            return operand(T.CONSTANT_BUFFER, [slot, rel ? { imm: r.index, rel } : r.index]);
        }
        case "IMM":
        {
            if(rel) return operand(T.IMMEDIATE_CONSTANT_BUFFER, [{ imm: r.index, rel }]);
            const imm = this.p.imms[r.index];
            if(!imm)
            {
                this.problem("an undeclared immediate");
                return immu(0);
            }
            return imm4(imm.values[0], imm.values[1], imm.values[2], imm.values[3]);
        }
        case "SV":
        {
            const m = this.sv_map[r.index];
            return m || immu(0);
        }
    }
    this.problem("registers of " + r.file);
    return immu(0);
};

/** An address register's component, as a relative index */
Translator.prototype.addr = function(rel)
{
    if(rel.file === "ADDR") return Object.assign(operand(T.TEMP, [this.addr_base + rel.index]), { mode: "select", swz: [rel.comp, rel.comp, rel.comp, rel.comp] });
    if(rel.file === "TEMP") return Object.assign(operand(T.TEMP, [rel.index]), { mode: "select", swz: [rel.comp, rel.comp, rel.comp, rel.comp] });
    this.problem("relative addressing by " + rel.file);
    return Object.assign(operand(T.TEMP, [this.addr_base]), { mode: "select", swz: [0, 0, 0, 0] });
};

/** A TGSI source */
Translator.prototype.src = function(s)
{
    const o = this.register(s, false);
    const mod = (s.neg ? 1 : 0) | (s.abs ? 2 : 0);
    if(o.type === T.IMMEDIATE32) return as_src(o, s.swizzle, mod);
    // registers that are scalars already (1 component)
    if(o.ncomp === 1) return Object.assign({}, o, { mod: (o.mod || 0) | mod });
    return as_src(o, compose(o.swz || [0, 1, 2, 3], s.swizzle), mod);
};

/** A TGSI destination */
Translator.prototype.dst = function(d)
{
    const o = this.register(d, true);
    if(o.ncomp === 1) return Object.assign({}, o, { mod: 0 });
    return as_dst(o, d.mask);
};

// ---------------------------------------------------------------------------
// Instructions

/** The simple ones: TGSI opcode -> VGPU10 opcode, with the same operands */
const SIMPLE = {
    MOV: OP.MOV, ADD: OP.ADD, MUL: OP.MUL, MAD: OP.MAD, FMA: OP.MAD, DP2: OP.DP2, DP3: OP.DP3, DP4: OP.DP4,
    MIN: OP.MIN, MAX: OP.MAX, FRC: OP.FRC, FLR: OP.ROUND_NI, CEIL: OP.ROUND_PI, TRUNC: OP.ROUND_Z,
    ROUND: OP.ROUND_NE, DIV: OP.DIV, FSEQ: OP.EQ, FSNE: OP.NE, FSLT: OP.LT, FSGE: OP.GE,
    DDX: OP.DERIV_RTX, DDY: OP.DERIV_RTY, DDX_FINE: OP.DERIV_RTX_FINE, DDY_FINE: OP.DERIV_RTY_FINE,
    F2I: OP.FTOI, F2U: OP.FTOU, I2F: OP.ITOF, U2F: OP.UTOF, UADD: OP.IADD, UMAD: OP.UMAD,
    INEG: OP.INEG, AND: OP.AND, OR: OP.OR, XOR: OP.XOR, NOT: OP.NOT, SHL: OP.ISHL, ISHR: OP.ISHR,
    USHR: OP.USHR, IMAX: OP.IMAX, IMIN: OP.IMIN, UMAX: OP.UMAX, UMIN: OP.UMIN, USEQ: OP.IEQ, USNE: OP.INE,
    ISLT: OP.ILT, ISGE: OP.IGE, USLT: OP.ULT, USGE: OP.UGE, UCMP: OP.MOVC, BREV: OP.BFREV,
    POPC: OP.COUNTBITS, LSB: OP.FIRSTBIT_LO,
};
/** Those of one source whose result is that of the source's first component, replicated */
const SCALAR = { RCP: OP.RCP, RSQ: OP.RSQ, SQRT: OP.SQRT, EX2: OP.EXP, LG2: OP.LOG };

Translator.prototype.instruction = function(ins)
{
    this.scratch_used = 0;
    const sat = ins.saturate ? 1 << 2 : 0;
    const op = ins.op;
    if(op in SIMPLE)
    {
        this.emit(SIMPLE[op], [this.dst(ins.dst[0]), ...ins.src.map(s => this.src(s))], sat);
        return;
    }
    if(op in SCALAR)
    {
        const s = this.src(ins.src[0]);
        this.emit(SCALAR[op], [this.dst(ins.dst[0]), as_src(s, [s.swz[0], s.swz[0], s.swz[0], s.swz[0]], s.mod)], sat);
        return;
    }
    const d = () => this.dst(ins.dst[0]);
    const s = i => this.src(ins.src[i]);
    const first = o => as_src(o, [o.swz[0], o.swz[0], o.swz[0], o.swz[0]], o.mod);
    switch(op)
    {
        case "NOP":
            return;
        case "END":
        case "RET":
            this.finish();
            if(op === "END") this.ended = true;
            return;
        case "SIN":
        case "COS":
        {
            const null_dst = operand(T.NULL, [], 0);
            const out = d();
            this.emit(OP.SINCOS, op === "SIN" ? [out, null_dst, first(s(0))] : [null_dst, out, first(s(0))], sat);
            return;
        }
        case "POW":
        {
            const t = this.scratch();
            this.emit(OP.LOG, [as_dst(t, 1), first(s(0))]);
            this.emit(OP.MUL, [as_dst(t, 1), scalar(t, 0), first(s(1))]);
            this.emit(OP.EXP, [d(), scalar(t, 0)], sat);
            return;
        }
        case "LRP":
        {
            // src0 * src1 + (1 - src0) * src2 = src0 * (src1 - src2) + src2
            const t = this.scratch();
            const c = s(2);
            this.emit(OP.ADD, [as_dst(t), s(1), Object.assign({}, c, { mod: c.mod ^ 1 })]);
            this.emit(OP.MAD, [d(), s(0), as_src(t), c], sat);
            return;
        }
        case "SLT": case "SGE": case "SEQ": case "SNE": case "SGT": case "SLE":
        {
            const t = this.scratch();
            const [cmp, x, y] = { SLT: [OP.LT, 0, 1], SGE: [OP.GE, 0, 1], SEQ: [OP.EQ, 0, 1], SNE: [OP.NE, 0, 1],
                SGT: [OP.LT, 1, 0], SLE: [OP.GE, 1, 0] }[op];
            this.emit(cmp, [as_dst(t), s(x), s(y)]);
            this.emit(OP.AND, [d(), as_src(t), immu(ONE_F)], sat);
            return;
        }
        case "CMP":
        {
            // src0 < 0 ? src1 : src2
            const t = this.scratch();
            this.emit(OP.LT, [as_dst(t), s(0), immf(0)]);
            this.emit(OP.MOVC, [d(), as_src(t), s(1), s(2)], sat);
            return;
        }
        case "SSG":
        case "ISSG":
        {
            // (x > 0) - (x < 0)
            const a = this.scratch(), b = this.scratch();
            const lt = op === "SSG" ? OP.LT : OP.ILT, zero = op === "SSG" ? immf(0) : immu(0);
            this.emit(lt, [as_dst(a), zero, s(0)]);
            this.emit(lt, [as_dst(b), s(0), zero]);
            this.emit(OP.IADD, [as_dst(a), as_src(b), as_src(a, null, 1)]);
            if(op === "SSG") this.emit(OP.ITOF, [d(), as_src(a)], sat);
            else this.emit(OP.MOV, [d(), as_src(a)]);
            return;
        }
        case "IABS":
        {
            const x = s(0);
            this.emit(OP.IMAX, [d(), x, Object.assign({}, x, { mod: x.mod ^ 1 })]);
            return;
        }
        case "UMUL":
            this.emit(OP.UMUL, [operand(T.NULL, [], 0), d(), s(0), s(1)]);
            return;
        case "IMUL_HI":
            this.emit(OP.IMUL, [d(), operand(T.NULL, [], 0), s(0), s(1)]);
            return;
        case "UMUL_HI":
            this.emit(OP.UMUL, [d(), operand(T.NULL, [], 0), s(0), s(1)]);
            return;
        case "UDIV":
            this.emit(OP.UDIV, [d(), operand(T.NULL, [], 0), s(0), s(1)]);
            return;
        case "UMOD":
            this.emit(OP.UDIV, [operand(T.NULL, [], 0), d(), s(0), s(1)]);
            return;
        case "IDIV":
            this.emit(OP.VMWARE, [d(), operand(T.NULL, [], 0), s(0), s(1)], VMWARE_IDIV);
            return;
        case "MOD":
            this.emit(OP.VMWARE, [operand(T.NULL, [], 0), d(), s(0), s(1)], VMWARE_IDIV);
            return;
        case "IBFE":
        case "UBFE":
            // TGSI: value, offset, bits; VGPU10: bits, offset, value
            this.emit(op === "IBFE" ? OP.IBFE : OP.UBFE, [d(), s(2), s(1), s(0)]);
            return;
        case "BFI":
            // TGSI: base, insert, offset, bits; VGPU10: bits, offset, insert, base
            this.emit(OP.BFI, [d(), s(3), s(2), s(1), s(0)]);
            return;
        case "IMSB":
        case "UMSB":
        {
            // the bit's index from the bottom, -1 for none (D3D counts from the top)
            const t = this.scratch(), none = this.scratch();
            this.emit(op === "IMSB" ? OP.FIRSTBIT_SHI : OP.FIRSTBIT_HI, [as_dst(t), s(0)]);
            this.emit(OP.IEQ, [as_dst(none), as_src(t), immu(0xFFFFFFFF)]);
            this.emit(OP.IADD, [as_dst(t), immu(31), as_src(t, null, 1)]);
            this.emit(OP.MOVC, [d(), as_src(none), immu(0xFFFFFFFF), as_src(t)]);
            return;
        }
        case "ARL":
        {
            const t = this.scratch();
            this.emit(OP.ROUND_NI, [as_dst(t), s(0)]);
            this.emit(OP.FTOI, [d(), as_src(t)]);
            return;
        }
        case "UARL":
            this.emit(OP.MOV, [d(), s(0)]);
            return;
        case "KILL":
            this.emit(OP.DISCARD, [immu(0xFFFFFFFF)], 1 << 7);
            return;
        case "KILL_IF":
        {
            // discard if any component is below zero
            const x = s(0);
            const t = this.scratch();
            const same = x.type === T.IMMEDIATE32 ? false : x.swz.every(c => c === x.swz[0]);
            this.emit(OP.LT, [as_dst(t, same ? 1 : 0xF), x, immf(0)]);
            if(!same)
            {
                this.emit(OP.OR, [as_dst(t, 0b0011), as_src(t, [0, 1, 0, 0]), as_src(t, [2, 3, 0, 0])]);
                this.emit(OP.OR, [as_dst(t, 1), scalar(t, 0), scalar(t, 1)]);
            }
            this.emit(OP.DISCARD, [scalar(t, 0)], 1 << 7);
            return;
        }
        case "IF":
        {
            const t = this.scratch();
            this.emit(OP.NE, [as_dst(t, 1), first(s(0)), immf(0)]);
            this.emit(OP.IF, [scalar(t, 0)], 1 << 7);
            return;
        }
        case "UIF":
            this.emit(OP.IF, [first(s(0))], 1 << 7);
            return;
        case "ELSE": this.emit(OP.ELSE, []); return;
        case "ENDIF": this.emit(OP.ENDIF, []); return;
        case "BGNLOOP": this.emit(OP.LOOP, []); return;
        case "ENDLOOP": this.emit(OP.ENDLOOP, []); return;
        case "BRK": this.emit(OP.BREAK, []); return;
        case "CONT": this.emit(OP.CONTINUE, []); return;
        case "SWITCH": this.emit(OP.SWITCH, [first(s(0))]); return;
        case "CASE":
        {
            const x = s(0);
            this.emit(OP.CASE, [x.type === T.IMMEDIATE32 ? Object.assign({}, x, { ncomp: 1 }) : first(x)]);
            return;
        }
        case "DEFAULT": this.emit(OP.DEFAULT, []); return;
        case "ENDSWITCH": this.emit(OP.ENDSWITCH, []); return;
        case "EMIT":
            // a vertex: the viewport's fixes first
            for(const run of this.epilogue) run();
            this.emit(OP.EMIT, []);
            return;
        case "ENDPRIM":
            this.emit(OP.CUT, []);
            return;
        case "PK2H":
        {
            const t = this.scratch();
            this.emit(OP.F32TOF16, [as_dst(t, 0b0011), s(0)]);
            this.emit(OP.ISHL, [as_dst(t, 0b0010), scalar(t, 1), immu(16)]);
            this.emit(OP.OR, [d(), scalar(t, 0), scalar(t, 1)]);
            return;
        }
        case "UP2H":
        {
            const t = this.scratch();
            const x = first(s(0));
            this.emit(OP.AND, [as_dst(t, 1), x, immu(0xFFFF)]);
            this.emit(OP.USHR, [as_dst(t, 2), x, immu(16)]);
            this.emit(OP.F16TOF32, [d(), as_src(t, [0, 1, 0, 1])]);
            return;
        }
        case "TEX": case "TXP": case "TXB": case "TXL": case "TXD": case "TXF": case "TXQ": case "TG4":
        case "LODQ": case "TEX2": case "TXB2": case "TXL2": case "TEX_LZ": case "TXF_LZ": case "TXQS":
            this.texture(ins);
            return;
    }
    this.problem("TGSI " + op);
};

/** Before a return: what the outputs need (the epilogue), then RET */
Translator.prototype.finish = function()
{
    if(!this.gs) for(const run of this.epilogue) run();
    this.emit(OP.RET, []);
};

// ---------------------------------------------------------------------------
// Textures

Translator.prototype.texture = function(ins)
{
    const op = ins.op;
    const samp = ins.src.find(o => o.file === "SAMP");
    if(!samp)
    {
        this.problem(op + " without a sampler");
        return;
    }
    const slot = samp.index;
    const target = ins.target || "2D";
    const [dimension, coords] = TARGETS[target] || TARGETS["2D"];
    const view = this.sviews.get(slot) || {};
    const resource = operand(T.RESOURCE, [slot]);
    const sampler = operand(T.SAMPLER, [slot], 0);
    const out = this.dst(ins.dst[0]);
    const sat = ins.saturate ? 1 << 2 : 0;
    const swizzle = (this.key.swizzles || [])[slot];
    const needs_swizzle = swizzle && !(swizzle[0] === 0 && swizzle[1] === 1 && swizzle[2] === 2 && swizzle[3] === 3);
    // into a temp when the view's swizzle comes after
    const result = needs_swizzle ? this.scratch() : null;
    const into = result ? as_dst(result) : out;
    const controls = result ? 0 : sat;

    if(op === "TXQ")
    {
        if(dimension === DIM.BUFFER) this.emit(OP.BUFINFO, [into, resource]);
        // (return type uint: controls 2)
        else this.emit(OP.RESINFO, [into, first_of(this.src(ins.src[0])), as_src(resource)], 2);
        if(result) this.view_swizzle(result, out, swizzle, true, sat);
        return;
    }
    if(op === "TXQS")
    {
        this.emit(OP.SAMPLE_INFO, [into, as_src(resource)], 1);
        return;
    }

    let coord = this.src(ins.src[0]);
    // offsets (immediates only: VGPU10 takes them as such)
    let extended = null;
    if(ins.offsets.length)
    {
        const o = ins.offsets[0];
        const imm = o.file === "IMM" ? this.p.imms[o.index] : null;
        if(imm)
        {
            const v = o.swizzle.slice(0, 3).map(c => imm.values[c] & 0xF);
            extended = [(1 | v[0] << 9 | v[1] << 13 | v[2] << 17) >>> 0];
        }
        else this.problem("texture offsets that are not immediates");
    }

    if(op === "TXF" || op === "TXF_LZ")
    {
        let address = coord;
        if(op === "TXF_LZ" || dimension === DIM.BUFFER)
        {
            const t = this.scratch();
            this.emit(OP.MOV, [as_dst(t), coord]);
            this.emit(OP.MOV, [as_dst(t, 0b1000), immu(0)]);
            address = as_src(t);
        }
        if(dimension === DIM.TEXTURE2DMS || dimension === DIM.TEXTURE2DMSARRAY)
        {
            this.emit(OP.LD_MS, [into, address, as_src(resource), scalar(coord, 3)], controls, extended);
        }
        else this.emit(OP.LD, [into, address, as_src(resource)], controls, extended);
        if(result) this.view_swizzle(result, out, swizzle, view.integer, sat);
        return;
    }

    // projective: divided by w first
    if(op === "TXP")
    {
        const t = this.scratch();
        this.emit(OP.DIV, [as_dst(t, 0b0111), coord, scalar(coord, 3)]);
        coord = as_src(t);
    }
    // rectangles: coordinates in texels
    if(target === "RECT" || target === "SHADOWRECT")
    {
        const size = this.scratch(), t = this.scratch();
        this.emit(OP.RESINFO, [as_dst(size), immu(0), as_src(resource)], 0);
        this.emit(OP.MOV, [as_dst(t), coord]);
        this.emit(OP.DIV, [as_dst(t, 0b0011), as_src(t), as_src(size)]);
        coord = as_src(t);
    }
    const shadow = SHADOW_REF[target];
    let ref = null;
    if(shadow !== undefined) ref = shadow < 0 ? first_of(this.src(ins.src[1])) : scalar(coord, shadow);

    switch(op)
    {
        case "TEX":
        case "TXP":
        case "TEX2":
            if(ref) this.emit(OP.SAMPLE_C, [into, coord, as_src(resource), sampler, ref], controls, extended);
            else this.emit(OP.SAMPLE, [into, coord, as_src(resource), sampler], controls, extended);
            break;
        case "TEX_LZ":
            if(ref) this.emit(OP.SAMPLE_C_LZ, [into, coord, as_src(resource), sampler, ref], controls, extended);
            else this.emit(OP.SAMPLE_L, [into, coord, as_src(resource), sampler, immf(0)], controls, extended);
            break;
        case "TXB":
        case "TXB2":
        {
            const bias = op === "TXB2" ? first_of(this.src(ins.src[1])) : scalar(coord, 3);
            if(ref) this.emit(OP.SAMPLE_C, [into, coord, as_src(resource), sampler, ref], controls, extended);
            else this.emit(OP.SAMPLE_B, [into, coord, as_src(resource), sampler, bias], controls, extended);
            break;
        }
        case "TXL":
        case "TXL2":
        {
            const lod = op === "TXL2" ? first_of(this.src(ins.src[1])) : scalar(coord, 3);
            // (D3D compares at level 0 only)
            if(ref) this.emit(OP.SAMPLE_C_LZ, [into, coord, as_src(resource), sampler, ref], controls, extended);
            else this.emit(OP.SAMPLE_L, [into, coord, as_src(resource), sampler, lod], controls, extended);
            break;
        }
        case "TXD":
        {
            const ddx = this.src(ins.src[1]), ddy = this.src(ins.src[2]);
            if(ref) this.emit(OP.SAMPLE_C, [into, coord, as_src(resource), sampler, ref], controls, extended);
            else this.emit(OP.SAMPLE_D, [into, coord, as_src(resource), sampler, ddx, ddy], controls, extended);
            break;
        }
        case "TG4":
        {
            // the component: the second source's x (an immediate)
            const c = ins.src[1] && ins.src[1].file === "IMM" ? this.p.imms[ins.src[1].index].values[ins.src[1].swizzle[0]] & 3 : 0;
            const s = Object.assign({}, sampler, { ncomp: 4, mode: "select", swz: [c, c, c, c] });
            if(ref) this.emit(OP.GATHER4_C, [into, coord, as_src(resource), s, ref], controls, extended);
            else this.emit(OP.GATHER4, [into, coord, as_src(resource), s], controls, extended);
            break;
        }
        case "LODQ":
            this.emit(OP.LOD, [into, coord, as_src(resource), sampler], controls);
            break;
    }
    if(result) this.view_swizzle(result, out, swizzle, view.integer, sat);
};

function first_of(o)
{
    return as_src(o, [o.swz[0], o.swz[0], o.swz[0], o.swz[0]], o.mod);
}

/** A sampler view's swizzle (PIPE_SWIZZLE_*) on what was sampled into `result` */
Translator.prototype.view_swizzle = function(result, out, swizzle, integer, sat)
{
    const mask = out.mask;
    const picks = [], constants = [];
    for(let c = 0; c < 4; c++)
    {
        if(!(mask >> c & 1)) continue;
        if(swizzle[c] <= 3) picks.push(c);
        else constants.push(c);
    }
    if(picks.length)
    {
        let m = 0;
        for(const c of picks) m |= 1 << c;
        this.emit(OP.MOV, [Object.assign({}, out, { mask: m }), as_src(result, [0, 1, 2, 3].map(c => swizzle[c] <= 3 ? swizzle[c] : 0))], sat);
    }
    if(constants.length)
    {
        let m = 0;
        for(const c of constants) m |= 1 << c;
        const v = [0, 1, 2, 3].map(c => swizzle[c] === PIPE_SWIZZLE_1 ? (integer ? 1 : ONE_F) : 0);
        this.emit(OP.MOV, [Object.assign({}, out, { mask: m }), immu(v[0], v[1], v[2], v[3])]);
    }
};

// ---------------------------------------------------------------------------

/**
 * One TGSI program, for a variant
 * @param {!Object} program from parse_tgsi
 * @param {!Object} key outputs (semantic key -> register), flip_y, halfz,
 *     swizzles (per view: 4 PIPE_SWIZZLE_*), color_buffers, flatshade,
 *     alpha_func, alpha_ref
 * @return {{tokens: !Uint32Array, inputs: !Object<string, number>, problems: !Array<string>, type: number}}
 */
export function tgsi_to_vgpu10(program, key)
{
    const t = new Translator(program, key);
    t.prologue_ops = [];
    t.scan();
    t.declare();
    for(const run of t.prologue_ops) run();
    t.scratch_base = t.next_temp;
    for(const ins of program.code)
    {
        if(t.ended) break;
        t.instruction(ins);
    }
    if(!t.ended) t.finish();
    if(t.indirect_imm)
    {
        // the immediates as an immediate constant buffer
        const data = [];
        for(const imm of program.imms) data.push(...(imm ? imm.values : [0, 0, 0, 0]));
        t.decls.unshift((OP.CUSTOMDATA | 3 << 11) >>> 0, 2 + data.length, ...data);
    }
    const decls = [(OP.DCL_TEMPS | 2 << 24) >>> 0, t.temps, ...t.decls];
    const type = PROGRAM[program.processor];
    const length = 2 + decls.length + t.code.length;
    const tokens = new Uint32Array(length);
    tokens[0] = (type << 16 | 5 << 4 | 0) >>> 0;
    tokens[1] = length;
    tokens.set(decls, 2);
    tokens.set(t.code, 2 + decls.length);
    return { tokens, inputs: t.link_inputs, problems: t.problems, type };
}
