#!/usr/bin/env node
// The VGPU10 shader front end (dxbc_frontend.js) and its WGSL (wgsl_emitter.js):
// programs written with the little assembler below decode as expected, and
// what they become is WGSL that naga (the WGSL front end of wgpu and Firefox)
// accepts. Without naga (cargo install naga-cli, or D9_NAGA=path) the WGSL is
// only checked for shape.
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const F = require("../../src/browser/glbridge/shader_ir/dxbc_frontend.js");
const W = require("../../src/browser/glbridge/shader_ir/wgsl_emitter.js");
const { OP, OPERAND, NAME, INTERPOLATION, DIM, RETURN, PROGRAM } = F;

const naga = process.env.D9_NAGA || (spawnSync("naga", ["--version"]).status === 0 ? "naga" : null);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dxbc-wgsl-"));

function validate(name, code) {
    if (!naga) return;
    const file = path.join(scratch, name + ".wgsl");
    fs.writeFileSync(file, code);
    const result = spawnSync(naga, [file], { encoding: "utf8" });
    if (result.status !== 0) {
        console.error(code.split("\n").map((l, i) => String(i + 1).padStart(4) + "  " + l).join("\n"));
        assert.fail(name + ": naga rejected the WGSL:\n" + result.stderr + result.stdout);
    }
}

// ---- assembler ------------------------------------------------------------

const X = 1, Y = 2, Z = 4, W_ = 8, XY = 3, XYZW = 15;
const SW = (x, y, z, w) => ({ swizzle: [x, y, z, w] });
const XYZW_S = SW(0, 1, 2, 3);

/** An operand: register type, indices, and { mask } | { swizzle } | { select } */
function operand(type, indices, selection, modifier) {
    const sel = selection || {};
    let token = 2;      // four components
    if (sel.zero) token = 0;
    else if (sel.one) token = 1;
    else if (sel.swizzle) token |= 1 << 2 | sel.swizzle[0] << 4 | sel.swizzle[1] << 6 | sel.swizzle[2] << 8 | sel.swizzle[3] << 10;
    else if (sel.select !== undefined) token |= 2 << 2 | sel.select << 4;
    else token |= (sel.mask === undefined ? XYZW : sel.mask) << 4;
    token |= type << 12 | indices.length << 20;
    const words = [];
    if (modifier) {
        token |= 1 << 31;
        words.push(1 | modifier << 6);
    }
    return [token >>> 0, ...words, ...indices];
}
const r = (i, sel, mod) => operand(OPERAND.TEMP, [i], sel, mod);
const v = (i, sel, mod) => operand(OPERAND.INPUT, [i], sel, mod);
const o = (i, sel) => operand(OPERAND.OUTPUT, [i], sel);
const cb = (slot, i, sel) => operand(OPERAND.CONSTANT_BUFFER, [slot, i], sel);
const t = (i, sel) => operand(OPERAND.RESOURCE, [i], sel || XYZW_S);
const s = i => operand(OPERAND.SAMPLER, [i], { zero: true });
const label = i => operand(OPERAND.LABEL, [i], { zero: true });
function imm(...values) {
    const token = (values.length === 4 ? 2 : 1) | OPERAND.IMMEDIATE32 << 12;
    return [token, ...values.map(x => typeof x === "number" && !Number.isInteger(x) ? f32(x) : x >>> 0)];
}
const f32 = x => new Uint32Array(new Float32Array([x]).buffer)[0];

/** An instruction: opcode, controls, operands */
function ins(op, ...operands) {
    let controls = 0;
    if (typeof operands[0] === "object" && !Array.isArray(operands[0])) controls = operands.shift().controls;
    const body = operands.flat();
    return [(op | controls << 11 | (1 + body.length) << 24) >>> 0, ...body];
}
function program(type, ...instructions) {
    const body = instructions.flat();
    return new Uint32Array([type << 16 | 4 << 4 | 0, 2 + body.length, ...body]);
}
const SAT = { controls: 1 << 2 };
const NZ = { controls: 1 << 7 };

const dcl_temps = n => ins(OP.DCL_TEMPS, n);
const dcl_input = (reg, mask) => ins(OP.DCL_INPUT, v(reg, { mask }));
const dcl_input_ps = (reg, mask, mode) => ins(OP.DCL_INPUT_PS, { controls: mode }, v(reg, { mask }));
const dcl_input_ps_siv = (reg, mask, mode, name) => ins(OP.DCL_INPUT_PS_SIV, { controls: mode }, v(reg, { mask }), name);
const dcl_input_sgv = (reg, mask, name) => ins(OP.DCL_INPUT_SGV, v(reg, { mask }), name);
const dcl_output = (reg, mask) => ins(OP.DCL_OUTPUT, o(reg, { mask }));
const dcl_output_siv = (reg, mask, name) => ins(OP.DCL_OUTPUT_SIV, o(reg, { mask }), name);
const dcl_cb = (slot, size) => ins(OP.DCL_CONSTANT_BUFFER, operand(OPERAND.CONSTANT_BUFFER, [slot, size], XYZW_S));
const dcl_sampler = (slot, mode = 0) => ins(OP.DCL_SAMPLER, { controls: mode }, operand(OPERAND.SAMPLER, [slot], { zero: true }));
const dcl_resource = (slot, dim, ret = RETURN.FLOAT) => ins(OP.DCL_RESOURCE, { controls: dim }, operand(OPERAND.RESOURCE, [slot], { zero: true }),
    ret | ret << 4 | ret << 8 | ret << 12);
const RET = ins(OP.RET);

let checked = 0;
function translate(name, tokens, options) {
    const p = F.decode(tokens);
    const result = W.emit(p, options);
    validate(name, result.code);
    checked++;
    return { p, result };
}

// ---- a vertex shader: transform by a matrix in cb0, pass a texcoord ---------

const VS = program(PROGRAM.VS,
    dcl_cb(0, 4),
    dcl_input(0, XYZW), dcl_input(1, X | Y), dcl_input_sgv(2, X, NAME.VERTEX_ID),
    dcl_output_siv(0, XYZW, NAME.POSITION), dcl_output(1, X | Y | Z | W_),
    dcl_temps(1),
    ins(OP.DP4, o(0, { mask: X }), v(0, XYZW_S), cb(0, 0, XYZW_S)),
    ins(OP.DP4, o(0, { mask: Y }), v(0, XYZW_S), cb(0, 1, XYZW_S)),
    ins(OP.DP4, o(0, { mask: Z }), v(0, XYZW_S), cb(0, 2, XYZW_S)),
    ins(OP.DP4, o(0, { mask: W_ }), v(0, XYZW_S), cb(0, 3, XYZW_S)),
    ins(OP.MOV, o(1, { mask: X | Y }), v(1, SW(0, 1, 0, 0))),
    ins(OP.UTOF, o(1, { mask: Z }), v(2, { select: 0 })),
    ins(OP.MOV, o(1, { mask: W_ }), imm(1.0)),
    RET);
{
    const { p, result } = translate("vs", VS, { vertexInputs: { 0: "f32", 1: "f32" } });
    assert.equal(p.stage, "vs");
    assert.equal(p.code.length, 8);
    assert.deepEqual([...p.cbuffers.keys()], [0]);
    assert.equal(p.outputs[0].name, NAME.POSITION);
    assert.ok(result.usesDraw, "the vertex id needs the draw's base vertex");
    assert.match(result.code, /@vertex fn main/);
    assert.deepEqual(result.bindings.map(b => b.binding).sort((a, b) => a - b), [0, 15]);
    console.log("PASS: a vertex shader: constant buffer, matrix, vertex id");
}

// ---- a pixel shader: texture, interpolation modes, discard, depth --------------

const PS = program(PROGRAM.PS,
    dcl_sampler(0), dcl_resource(0, DIM.TEXTURE2D),
    dcl_input_ps_siv(0, XYZW, INTERPOLATION.LINEAR_NOPERSPECTIVE, NAME.POSITION),
    dcl_input_ps(1, X | Y | Z | W_, INTERPOLATION.LINEAR),
    dcl_input_ps(2, X, INTERPOLATION.CONSTANT),
    dcl_output(0, XYZW),
    ins(OP.DCL_OUTPUT, operand(OPERAND.OUTPUT_DEPTH, [], { one: true })),
    dcl_temps(2),
    ins(OP.SAMPLE, r(0, { mask: XYZW }), v(1, SW(0, 1, 0, 0)), t(0), s(0)),
    ins(OP.LT, r(1, { mask: X }), r(0, { select: 3 }), imm(0.5)),
    ins(OP.DISCARD, NZ, r(1, { select: 0 })),
    ins(OP.MUL, SAT, o(0, { mask: XYZW }), r(0, XYZW_S), v(1, { select: 3 }, 1)),
    ins(OP.MOV, operand(OPERAND.OUTPUT_DEPTH, [], { one: true }), v(0, { select: 2 })),
    RET);
{
    const { p, result } = translate("ps", PS, { targets: { 0: "f32" } });
    assert.equal(p.inputs.length, 3);
    assert.equal(p.inputs[2].interpolation, INTERPOLATION.CONSTANT);
    assert.match(result.code, /@interpolate\(flat\) @location\(2\) i2: vec4<u32>/);
    assert.match(result.code, /textureSample\(t0, s0/);
    assert.match(result.code, /frag_depth/);
    const varyings = W.pixelVaryings(p);
    assert.deepEqual(Object.keys(varyings), ["1", "2"]);
    // the vertex shader linked to it writes what it reads, as it reads it
    const linked = translate("vs_linked", VS, { vertexInputs: { 0: "f32", 1: "f32" }, varyings }).result;
    assert.match(linked.code, /@interpolate\(flat\) @location\(2\) o2: vec4<u32>/);
    console.log("PASS: a pixel shader: sampling, flat and noperspective inputs, discard, depth, and its link");
}

// ---- control flow: loops, conditions, switch, subroutines ------------------------

const FLOW = program(PROGRAM.PS,
    dcl_input_ps(1, X, INTERPOLATION.CONSTANT),
    dcl_output(0, XYZW),
    dcl_temps(3),
    ins(OP.MOV, r(0, { mask: XYZW }), imm(0, 0, 0, 0)),
    ins(OP.LOOP),
    ins(OP.IGE, r(1, { mask: X }), r(0, { select: 0 }), imm(10)),
    ins(OP.BREAKC, NZ, r(1, { select: 0 })),
    ins(OP.IADD, r(0, { mask: X }), r(0, { select: 0 }), imm(1)),
    ins(OP.IF, NZ, v(1, { select: 0 })),
    ins(OP.CONTINUE),
    ins(OP.ELSE),
    ins(OP.IADD, r(0, { mask: Y }), r(0, { select: 1 }), imm(2)),
    ins(OP.ENDIF),
    ins(OP.ENDLOOP),
    ins(OP.SWITCH, r(0, { select: 1 })),
    ins(OP.CASE, imm(0)),
    ins(OP.CASE, imm(2)),
    ins(OP.MOV, r(2, { mask: XYZW }), imm(1.0, 0.0, 0.0, 1.0)),
    ins(OP.BREAK),
    ins(OP.DEFAULT),
    ins(OP.CALL, label(0)),
    ins(OP.BREAK),
    ins(OP.ENDSWITCH),
    ins(OP.UDIV, r(1, { mask: X }), r(1, { mask: Y }), r(0, { select: 0 }), imm(3)),
    ins(OP.IMUL, operand(OPERAND.NULL, [], { zero: true }), r(1, { mask: Z }), r(0, { select: 0 }), r(0, { select: 1 })),
    ins(OP.UBFE, r(1, { mask: W_ }), imm(4), imm(8), r(0, { select: 0 })),
    ins(OP.FIRSTBIT_HI, r(2, { mask: Z }), r(1, { select: 3 })),
    ins(OP.UTOF, r(2, { mask: W_ }), r(1, { select: 0 })),
    ins(OP.MOV, o(0, { mask: XYZW }), r(2, XYZW_S)),
    RET,
    ins(OP.LABEL, label(0)),
    ins(OP.MOV, r(2, { mask: XYZW }), imm(0.0, 1.0, 0.0, 1.0)),
    RET);
{
    const { result } = translate("flow", FLOW, { targets: { 0: "f32" } });
    assert.match(result.code, /loop \{/);
    assert.match(result.code, /switch \(/);
    assert.match(result.code, /case 0i, 2i: \{/);
    assert.match(result.code, /fn label0\(\)/);
    console.log("PASS: control flow: loop, breakc, if/else, continue, switch with shared cases, call/label; integer ops");
}

// ---- texture forms: arrays, cubes, comparisons, loads, sizes, gathers ----------

const TEX = program(PROGRAM.PS,
    dcl_sampler(0), dcl_sampler(1, 1),
    dcl_resource(0, DIM.TEXTURE2DARRAY), dcl_resource(1, DIM.TEXTURECUBE), dcl_resource(2, DIM.TEXTURE2D),
    dcl_resource(3, DIM.TEXTURE2D, RETURN.UINT), dcl_resource(4, DIM.TEXTURE3D), dcl_resource(5, DIM.TEXTURE1D),
    dcl_input_ps(1, XYZW, INTERPOLATION.LINEAR),
    dcl_output(0, XYZW), dcl_output(1, XYZW),
    dcl_temps(4),
    ins(OP.SAMPLE_L, r(0, { mask: XYZW }), v(1, XYZW_S), t(0), s(0), imm(0.0)),
    ins(OP.SAMPLE_B, r(1, { mask: XYZW }), v(1, XYZW_S), t(1), s(0), imm(-1.0)),
    ins(OP.SAMPLE_C, r(2, { mask: X }), v(1, XYZW_S), t(2, SW(0, 0, 0, 0)), s(1), v(1, { select: 3 })),
    ins(OP.SAMPLE_C_LZ, r(2, { mask: Y }), v(1, XYZW_S), t(2, SW(0, 0, 0, 0)), s(1), v(1, { select: 3 })),
    ins(OP.FTOI, r(3, { mask: XYZW }), v(1, XYZW_S)),
    ins(OP.LD, r(3, { mask: XYZW }), r(3, XYZW_S), t(3)),
    ins(OP.RESINFO, { controls: 2 }, r(3, { mask: XY }), imm(0), t(4)),
    ins(OP.SAMPLE_D, r(0, { mask: XYZW }), v(1, XYZW_S), t(4), s(0), v(1, XYZW_S), v(1, XYZW_S)),
    ins(OP.GATHER4, r(1, { mask: XYZW }), v(1, XYZW_S), t(0), s(0)),
    ins(OP.SAMPLE, r(1, { mask: XYZW }), v(1, XYZW_S), t(5), s(0)),
    ins(OP.DERIV_RTX_FINE, r(2, { mask: Z | W_ }), v(1, XYZW_S)),
    ins(OP.ADD, o(0, { mask: XYZW }), r(0, XYZW_S), r(1, XYZW_S)),
    ins(OP.MOV, o(1, { mask: XYZW }), r(3, XYZW_S)),
    RET);
{
    const { result } = translate("textures", TEX, { targets: { 0: "f32", 1: "u32" } });
    assert.match(result.code, /texture_depth_2d/);
    assert.match(result.code, /sampler_comparison/);
    assert.match(result.code, /texture_2d<u32>/);
    const texture = result.bindings.find(b => b.binding === 34);
    assert.equal(texture.sampleType, "depth");
    console.log("PASS: arrays, cubes, comparisons, ld, resinfo, gradients, gather, 1D as 2D, derivatives");
}

// ---- two destinations, one of them a source: sincos r1.x, r0.x, r1.x ----------

{
    const SINCOS = program(PROGRAM.PS,
        dcl_input_ps(1, XYZW, INTERPOLATION.LINEAR),
        dcl_output(0, XYZW),
        dcl_temps(2),
        ins(OP.MOV, r(1, { mask: XYZW }), v(1, XYZW_S)),
        ins(OP.SINCOS, r(1, { mask: X }), r(0, { mask: X }), r(1, { select: 0 })),
        ins(OP.IMUL, r(1, { mask: Y }), r(0, { mask: Y }), r(1, { select: 1 }), r(1, { select: 1 })),
        ins(OP.MOV, r(0, { mask: Z | W_ }), r(1, XYZW_S)),
        ins(OP.MOV, o(0, { mask: XYZW }), r(0, XYZW_S)),
        RET);
    const { result } = translate("sincos", SINCOS, { targets: { 0: "f32" } });
    // the cosine is of the source, not of the sine just written over it
    assert.match(result.code, /let a = [^;]*r\[1u\][^;]*;\s*r\[1u\]\.x = [^;]*sin\(a\)[^;]*;\s*r\[0u\]\.x = [^;]*cos\(a\)/);
    assert.match(result.code, /let a = [^;]*;\s*let b = [^;]*;\s*r\[1u\]\.y = [^;]*gx_imul_hi\(a, b\)[^;]*;\s*r\[0u\]\.y = [^;]*a \* b/);
    console.log("PASS: sincos and imul whose destination is their source read it first");
}

// ---- compute (SM5): typed texture UAVs, an append counter, raw atomics, shared memory ----

{
    const uav = (i, sel) => operand(OPERAND.UAV, [i], sel || { mask: XYZW });
    const g = (i, sel) => operand(OPERAND.THREAD_GROUP_SHARED_MEMORY, [i], sel || { mask: X });
    const tid = sel => operand(OPERAND.INPUT_THREAD_ID, [], sel || XYZW_S);
    const RET4 = (t) => t | t << 4 | t << 8 | t << 12;
    const CS = (() => {
        const p = program(PROGRAM.CS,
            ins(OP.DCL_THREAD_GROUP, 8, 8, 1),
            ins(OP.DCL_UAV_TYPED, { controls: DIM.TEXTURE2D }, uav(0, { zero: true }), RET4(RETURN.FLOAT)),
            ins(OP.DCL_UAV_TYPED, { controls: DIM.TEXTURE2D }, uav(1, { zero: true }), RET4(RETURN.UINT)),
            ins(OP.DCL_UAV_STRUCTURED, uav(2, { zero: true }), 16),
            ins(OP.DCL_UAV_RAW, uav(3, { zero: true })),
            ins(OP.DCL_TGSM_RAW, g(0, { zero: true }), 64),
            ins(OP.DCL_INPUT, tid({ mask: XY })),
            dcl_temps(4),
            ins(OP.STORE_UAV_TYPED, uav(0), tid(SW(0, 1, 1, 1)), imm(1.0, 0.0, 0.0, 1.0)),
            ins(OP.LD_UAV_TYPED, r(0, { mask: X }), tid(SW(0, 1, 1, 1)), uav(1, SW(0, 0, 0, 0))),
            ins(OP.IADD, r(0, { mask: X }), r(0, { select: 0 }), imm(1)),
            ins(OP.STORE_UAV_TYPED, uav(1), tid(SW(0, 1, 1, 1)), r(0, SW(0, 0, 0, 0))),
            ins(OP.IMM_ATOMIC_ALLOC, r(1, { mask: X }), uav(2, { zero: true })),
            ins(OP.STORE_STRUCTURED, uav(2), r(1, { select: 0 }), imm(0), tid(SW(0, 1, 0, 1))),
            ins(OP.ATOMIC_IADD, uav(3, { mask: X }), imm(0), imm(1)),
            ins(OP.STORE_RAW, g(0), imm(0), r(0, { select: 0 })),
            ins(OP.SYNC, { controls: 1 | 2 }),
            ins(OP.LD_RAW, r(2, { mask: X }), imm(0), g(0, SW(0, 0, 0, 0))),
            ins(OP.BUFINFO, r(3, { mask: X }), uav(2, SW(0, 0, 0, 0))),
            RET);
        p[0] = PROGRAM.CS << 16 | 5 << 4 | 0;     // version 5.0
        return p;
    })();
    const { result } = translate("compute", CS, { uavFormats: { 0: { format: "rgba8unorm" } } });
    assert.match(result.code, /var u0: texture_storage_2d<rgba8unorm, write>;/);
    assert.match(result.code, /var u1: texture_storage_2d<r32uint, read_write>;/, "a read R32 UAV is read-write");
    assert.match(result.code, /var<storage, read_write> uc2: atomic<u32>;/, "the append counter");
    assert.match(result.code, /atomicAdd\(&uc2, 1u\)/);
    assert.match(result.code, /textureStore\(u0, /);
    assert.match(result.code, /textureLoad\(u1, /);
    assert.match(result.code, /gx_view_base\(2u\)/, "a view's first element");
    assert.match(result.code, /@compute @workgroup_size\(8, 8, 1\)/);
    const kinds = result.bindings.map(b => b.type).sort();
    assert.deepEqual(kinds, ["uav", "uav", "uav-counter", "uav-texture", "uav-texture", "views"]);
    console.log("PASS: compute: typed texture UAVs (write, R32 read-write), an append counter, raw atomics, shared memory, bufinfo");
}

// ---- tessellation: a hull shader's phases, a domain shader, as compute ------

{
    const icp = (cp, reg, sel) => operand(OPERAND.INPUT_CONTROL_POINT, [cp, reg], sel || XYZW_S);
    // vicp[vOutputControlPointID][0]: the first index relative to a register
    const icpByID = sel => {
        const token = (2 | 1 << 2 | 0xE4 << 4 | OPERAND.INPUT_CONTROL_POINT << 12 | 2 << 20 | 2 /* relative */ << 22) >>> 0;
        return [token, ...operand(OPERAND.OUTPUT_CONTROL_POINT_ID, [], { select: 0 }), 0];
    };
    const HS = (() => {
        const p = program(PROGRAM.HS,
            ins(OP.HS_DECLS),
            ins(OP.DCL_INPUT_CONTROL_POINT_COUNT, { controls: 4 }),
            ins(OP.DCL_OUTPUT_CONTROL_POINT_COUNT, { controls: 4 }),
            ins(OP.DCL_TESS_DOMAIN, { controls: 3 }),
            ins(OP.DCL_TESS_PARTITIONING, { controls: 1 }),
            ins(OP.DCL_TESS_OUTPUT_PRIMITIVE, { controls: 3 }),
            ins(OP.DCL_HS_MAX_TESSFACTOR, f32(64)),
            ins(OP.HS_CONTROL_POINT_PHASE),
            ins(OP.DCL_INPUT, icp(4, 0, { mask: XYZW })),
            ins(OP.DCL_INPUT, operand(OPERAND.OUTPUT_CONTROL_POINT_ID, [], { zero: true })),
            dcl_output(0, XYZW),
            ins(OP.MOV, o(0, { mask: XYZW }), icpByID()),
            RET,
            ins(OP.HS_FORK_PHASE),
            ins(OP.DCL_HS_FORK_PHASE_INSTANCE_COUNT, 1),
            dcl_output_siv(0, X, NAME.FINAL_QUAD_U_EQ_0_EDGE_TESSFACTOR),
            dcl_output_siv(1, X, NAME.FINAL_QUAD_V_EQ_0_EDGE_TESSFACTOR),
            dcl_output_siv(2, X, NAME.FINAL_QUAD_U_EQ_1_EDGE_TESSFACTOR),
            dcl_output_siv(3, X, NAME.FINAL_QUAD_V_EQ_1_EDGE_TESSFACTOR),
            ins(OP.MOV, o(0, { mask: X }), imm(4.0)),
            ins(OP.MOV, o(1, { mask: X }), imm(4.0)),
            ins(OP.MOV, o(2, { mask: X }), imm(4.0)),
            ins(OP.MOV, o(3, { mask: X }), imm(4.0)),
            RET,
            ins(OP.HS_JOIN_PHASE),
            dcl_output_siv(4, X, NAME.FINAL_QUAD_U_INSIDE_TESSFACTOR),
            dcl_output_siv(5, X, NAME.FINAL_QUAD_V_INSIDE_TESSFACTOR),
            ins(OP.MOV, o(4, { mask: X }), operand(OPERAND.INPUT_PATCH_CONSTANT, [0], { select: 0 })),
            ins(OP.MOV, o(5, { mask: X }), imm(3.0)),
            RET);
        p[0] = PROGRAM.HS << 16 | 5 << 4;
        return p;
    })();
    const hs = translate("hull", HS, { group: 0, mode: "hull" });
    const h = hs.result.hull;
    assert.deepEqual([h.inCPs, h.outCPs, h.cpRegs, h.pcRegs, h.domain, h.partitioning, h.outputPrimitive], [4, 4, 1, 6, 3, 1, 3]);
    assert.equal(hs.result.record, 4 * 1 + 6 + 2, "control points, patch constants, tess factors");
    assert.match(hs.result.code, /fn hs_phase1\(\)/);
    assert.match(hs.result.code, /vicp\[[^\]]*hs_cpid[^\]]*\]\[0u\]/, "the control point the invocation makes");
    assert.match(hs.result.code, /opc\[0u\]\.x = /, "fork phases write patch constants");
    assert.match(hs.result.code, /vec4<f32>\(bitcast<f32>\(opc\[0\]\.x\), bitcast<f32>\(opc\[1\]\.x\)/, "the edge tess factors");

    const DS = (() => {
        const neg = 1;
        const p = program(PROGRAM.DS,
            ins(OP.DCL_INPUT_CONTROL_POINT_COUNT, { controls: 4 }),
            ins(OP.DCL_TESS_DOMAIN, { controls: 3 }),
            ins(OP.DCL_INPUT, operand(OPERAND.INPUT_DOMAIN_POINT, [], { mask: XY })),
            ins(OP.DCL_INPUT, icp(4, 0, { mask: XY })),
            dcl_output_siv(0, XYZW, NAME.POSITION),
            dcl_temps(2),
            ins(OP.ADD, r(0, { mask: XY }), icp(0, 0, XYZW_S).map((w, i) => i === 0 ? w : w), icp(1, 0)),
            ins(OP.MAD, r(0, { mask: XY }), operand(OPERAND.INPUT_DOMAIN_POINT, [], SW(0, 0, 0, 0)), r(0, XYZW_S), icp(0, 0)),
            ins(OP.ADD, r(1, { mask: XY }), operand(OPERAND.INPUT_CONTROL_POINT, [3, 0], XYZW_S, neg), icp(2, 0)),
            ins(OP.MAD, r(1, { mask: XY }), operand(OPERAND.INPUT_DOMAIN_POINT, [], SW(0, 0, 0, 0)), r(1, XYZW_S), icp(3, 0)),
            ins(OP.ADD, r(1, { mask: XY }), r(0, XYZW_S, neg), r(1, XYZW_S)),
            ins(OP.MAD, o(0, { mask: XY }), operand(OPERAND.INPUT_DOMAIN_POINT, [], SW(1, 1, 1, 1)), r(1, XYZW_S), r(0, XYZW_S)),
            ins(OP.MOV, o(0, { mask: Z | W_ }), imm(0.0, 0.0, 0.0, 1.0)),
            RET);
        p[0] = PROGRAM.DS << 16 | 5 << 4;
        return p;
    })();
    const ds = translate("domain", DS, { group: 0, mode: "domain" });
    assert.match(ds.result.code, /gx_domain = vec3<f32>\(u, v, 0\.0\);/, "a quad's domain point");
    assert.match(ds.result.code, /vicp\[0u\]\[0u\]/);
    assert.deepEqual(ds.result.bindings.map(b => b.type).sort(), ["domain", "stage-in", "stage-out", "tess-args", "tess-points"]);
    console.log("PASS: tessellation: a hull shader's control point, fork and join phases, a domain shader, as compute");
}

// ---- shader model 4.1: cube arrays, lod, the rasterizer's samples, per-sample inputs ----

const rasterizer = sel => operand(OPERAND.RASTERIZER, [], sel || XYZW_S);
const SM41 = (() => {
    const p = program(PROGRAM.PS,
        dcl_sampler(0),
        dcl_resource(0, DIM.TEXTURECUBEARRAY), dcl_resource(1, DIM.TEXTURE2D), dcl_resource(2, DIM.TEXTURE2DMS),
        dcl_input_ps(1, XYZW, INTERPOLATION.LINEAR_SAMPLE),
        dcl_input_ps_siv(0, XYZW, INTERPOLATION.LINEAR_NOPERSPECTIVE, NAME.POSITION),
        dcl_output(0, XYZW),
        dcl_temps(5),
        ins(OP.SAMPLE, r(0, { mask: XYZW }), v(1, XYZW_S), t(0), s(0)),
        ins(OP.GATHER4, r(1, { mask: XYZW }), v(1, XYZW_S), t(0), operand(OPERAND.SAMPLER, [0], { select: 0 })),
        ins(OP.LOD, r(2, { mask: XY }), v(1, XYZW_S), t(0), s(0)),
        ins(OP.LOD, r(2, { mask: Z | W_ }), v(1, XYZW_S), t(1, SW(0, 0, 1, 1)), s(0)),
        ins(OP.SAMPLE_INFO, { controls: 1 }, r(3, { mask: X }), rasterizer(SW(0, 0, 0, 0))),
        ins(OP.SAMPLE_INFO, r(3, { mask: Y }), t(2, SW(0, 0, 0, 0))),
        ins(OP.SAMPLE_POS, r(3, { mask: Z | W_ }), rasterizer(SW(0, 0, 0, 1)), imm(1)),
        // sample 2 of the multisampled texture, at the pixel
        ins(OP.FTOI, r(4, { mask: XY }), v(0, XYZW_S)),
        ins(OP.LD_MS, r(4, { mask: XYZW }), r(4, XYZW_S), t(2), imm(2)),
        ins(OP.ADD, r(3, { mask: XYZW }), r(3, XYZW_S), r(4, XYZW_S)),
        ins(OP.ADD, r(0, { mask: XYZW }), r(0, XYZW_S), r(1, XYZW_S)),
        ins(OP.ADD, r(0, { mask: XYZW }), r(0, XYZW_S), r(2, XYZW_S)),
        ins(OP.ADD, o(0, { mask: XYZW }), r(0, XYZW_S), r(3, XYZW_S)),
        RET);
    p[0] = PROGRAM.PS << 16 | 4 << 4 | 1;     // version 4.1
    return p;
})();
{
    const { p, result } = translate("sm41", SM41, { targets: { 0: "f32" } });
    assert.equal(p.minor, 1);
    assert.match(result.code, /texture_cube_array<f32>/);
    // multisampled surfaces are supersampled: plain textures, a sample a texel
    assert.match(result.code, /var t2: texture_2d<f32>/);
    assert.match(result.code, /textureLoad\(t2, .*\.xy\) \* 2 \+ gx_ms_texel\(/);
    assert.match(result.code, /override gx_ss: u32 = 0u;/);
    assert.match(result.code, /gx_sample = select\(0u, \(u32\(input\.position\.x\) & 1u\)/);
    assert.match(result.code, /input\.position\.xy \* 0\.5/, "per-sample shading sees the sample's position");
    assert.match(result.code, /\{ discard; \}/);
    assert.match(result.code, /override gx_samples: u32 = 1u;/);
    assert.ok(result.usesSamples, "the rasterizer's samples are the pipeline's");
    assert.match(result.code, /fn gx_lod\(/);
    assert.match(result.code, /gx_cube_face\(/);
    assert.match(result.code, /vec4<f32>\(f32\(4u\)/, "sample_info of the texture: 4");
    assert.match(result.code, /@interpolate\(perspective, sample\)/);
    assert.ok(!result.warnings.some(w => /lod/.test(w)), "lod is computed, not approximated");
    const cube = result.bindings.find(b => b.type === "texture" && b.dimension === "cube-array");
    assert.ok(cube, "a cube array binding");
    console.log("PASS: shader model 4.1: cube arrays, gather4, lod, sample_info/sample_pos of the rasterizer, per-sample inputs");
}

// ---- compute variants for geometry shaders: a vertex shader that pulls its
// vertices, and geometry shaders ------------------------------------------------

{
    const fetch = [
        { reg: 0, slot: 0, offset: 0, format: "float32x4", instanced: false },
        { reg: 1, slot: 1, offset: 4, format: "unorm8x4-bgra", instanced: true },
    ];
    const { result } = translate("vs-compute", VS, { mode: "vertex-compute", fetch });
    assert.match(result.code, /@compute @workgroup_size\(64\) fn main/);
    assert.equal(result.record, 2, "a record of its two outputs");
    const types = Object.fromEntries(result.bindings.map(b => [b.binding, b.type]));
    assert.equal(types[200], "vertex-buffer");
    assert.equal(types[201], "vertex-buffer");
    assert.equal(types[230], "fetch");
    assert.equal(types[231], "index");
    assert.equal(types[233], "stage-out");
    // every format the GX table has, pulled
    const formats = ["float32", "float32x2", "float32x3", "float16", "float16x2", "float16x4", "unorm8", "unorm8x2", "unorm8x4",
        "snorm8x4", "uint8x4", "sint8x2", "unorm16x4", "snorm16x2", "uint16", "sint16x4", "uint32x3", "sint32x4",
        "unorm10-10-10-2", "pull:uint10-10-10-2", "pull:ufloat11-11-10"];
    const many = formats.map((format, i) => ({ reg: 0, slot: i % 4, offset: 4 * i, format, instanced: false }));
    for (const f of many) translate("fetch-" + f.format.replace(/[^a-z0-9]/g, "_"), VS, { mode: "vertex-compute", fetch: [f] });
    console.log("PASS: a vertex shader as compute, pulling " + formats.length + " vertex formats");
}

const vin = (vertex, reg, sel) => operand(OPERAND.INPUT, [vertex, reg], sel);
const GS = program(PROGRAM.GS,
    ins(OP.DCL_GS_INPUT_PRIMITIVE, { controls: 3 /* triangle */ }),
    ins(OP.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY, { controls: 5 /* triangle strip */ }),
    ins(OP.DCL_MAX_OUTPUT_VERTEX_COUNT, 6),
    ins(OP.DCL_INPUT, operand(OPERAND.INPUT, [3, 0], { mask: XYZW })),
    ins(OP.DCL_INPUT, operand(OPERAND.INPUT, [3, 1], { mask: XYZW })),
    dcl_output_siv(0, XYZW, NAME.POSITION), dcl_output(1, XYZW),
    dcl_temps(1),
    // each vertex as it came, then a cut, then the first again, alone
    ...[0, 1, 2].map(i => [ins(OP.MOV, o(0, { mask: XYZW }), vin(i, 0, XYZW_S)), ins(OP.MOV, o(1, { mask: XYZW }), vin(i, 1, XYZW_S)),
        ins(OP.EMIT)]).flat(),
    ins(OP.CUT),
    ins(OP.MOV, o(0, { mask: XYZW }), vin(0, 0, XYZW_S)),
    ins(OP.EMITTHENCUT),
    RET);
{
    const { p, result } = translate("gs", GS, { mode: "geometry" });
    assert.equal(p.stage, "gs");
    assert.deepEqual(result.gs, { vertices: 3, topology: "triangle-list", perPrim: 3, maxPrims: 4 });
    assert.equal(result.record, 3, "two outputs and the flag");
    assert.match(result.code, /var<private> v: array<array<vec4<u32>, 2>, 3>/);
    assert.match(result.code, /gs_emit\(\);/);
    assert.match(result.code, /gs_cut\(\);/);
    assert.throws(() => W.emit(p, {}), /emulated elsewhere/, "only as compute");
    console.log("PASS: a geometry shader as compute: 2D inputs, emit and cut, triangles from strips");
}

const GS_POINTS = program(PROGRAM.GS,
    ins(OP.DCL_GS_INPUT_PRIMITIVE, { controls: 1 /* point */ }),
    ins(OP.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY, { controls: 5 }),
    ins(OP.DCL_MAX_OUTPUT_VERTEX_COUNT, 4),
    ins(OP.DCL_INPUT, operand(OPERAND.INPUT, [1, 0], { mask: XYZW })),
    ins(OP.DCL_INPUT, operand(OPERAND.INPUT_PRIMITIVEID, [], { zero: true })),
    dcl_output_siv(0, XYZW, NAME.POSITION), dcl_output(1, X),
    dcl_temps(1),
    ...[[-0.1, -0.1], [-0.1, 0.1], [0.1, -0.1], [0.1, 0.1]].map(([dx, dy]) => [
        ins(OP.ADD, o(0, { mask: XYZW }), vin(0, 0, XYZW_S), imm(dx, dy, 0.0, 0.0)),
        ins(OP.MOV, o(1, { mask: X }), operand(OPERAND.INPUT_PRIMITIVEID, [], { select: 0 })),
        ins(OP.EMIT)]).flat(),
    RET);
{
    const { result } = translate("gs-points", GS_POINTS, { mode: "geometry" });
    assert.deepEqual(result.gs, { vertices: 1, topology: "triangle-list", perPrim: 3, maxPrims: 2 });
    assert.match(result.code, /vec4<u32>\(prim_id\)/);
    console.log("PASS: a geometry shader making quads of points, with the primitive id");
}

console.log("PASS: " + checked + " shaders" + (naga ? " validated by naga" : " (naga not found: not validated)"));
fs.rmSync(scratch, { recursive: true, force: true });
