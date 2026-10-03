// VGPU10 shader tokens (SM4.0, SM4.1, SM5.0: the DXBC SHEX instruction
// stream VMware's SVGA DX commands carry, plus its VMWARE opcodes) decoded
// into the shader IR wgsl_emitter.js turns into WGSL (docs/gpu-devices.md,
// "GX"). The IR is the instruction list with its operands spelled out, and
// the declarations gathered by kind. virgl's TGSI comes here too, as VGPU10
// tokens (src/graphics_adapters/virtio_gpu/tgsi_vgpu10.js).
//
// Token layout: VGPU10ShaderTokens.h (third_party/vmware-svga). A program is
// a version token, a length token (dwords, both included), then
// instructions: an opcode token (opcode, controls, length, extended), maybe
// extended opcode tokens, then operands: an operand token, maybe an extended
// operand token (modifiers), then per index dimension an immediate or a
// relative operand, or for immediates their 1 or 4 values.
//
// decode(Uint32Array) -> { type, major, minor, decls, code, icb, temps,
//     indexable, signature }; a malformed program throws ShaderDecodeError.
(function(global) {
    "use strict";

    class ShaderDecodeError extends Error {}

    const PROGRAM = { PS: 0, VS: 1, GS: 2, HS: 3, DS: 4, CS: 5 };
    const PROGRAM_NAMES = ["ps", "vs", "gs", "hs", "ds", "cs"];

    // Opcodes (VGPU10_OPCODE_TYPE)
    const OP = {
        ADD: 0, AND: 1, BREAK: 2, BREAKC: 3, CALL: 4, CALLC: 5, CASE: 6, CONTINUE: 7, CONTINUEC: 8,
        CUT: 9, DEFAULT: 10, DERIV_RTX: 11, DERIV_RTY: 12, DISCARD: 13, DIV: 14, DP2: 15, DP3: 16, DP4: 17,
        ELSE: 18, EMIT: 19, EMITTHENCUT: 20, ENDIF: 21, ENDLOOP: 22, ENDSWITCH: 23, EQ: 24, EXP: 25,
        FRC: 26, FTOI: 27, FTOU: 28, GE: 29, IADD: 30, IF: 31, IEQ: 32, IGE: 33, ILT: 34, IMAD: 35,
        IMAX: 36, IMIN: 37, IMUL: 38, INE: 39, INEG: 40, ISHL: 41, ISHR: 42, ITOF: 43, LABEL: 44,
        LD: 45, LD_MS: 46, LOG: 47, LOOP: 48, LT: 49, MAD: 50, MIN: 51, MAX: 52, CUSTOMDATA: 53,
        MOV: 54, MOVC: 55, MUL: 56, NE: 57, NOP: 58, NOT: 59, OR: 60, RESINFO: 61, RET: 62, RETC: 63,
        ROUND_NE: 64, ROUND_NI: 65, ROUND_PI: 66, ROUND_Z: 67, RSQ: 68, SAMPLE: 69, SAMPLE_C: 70,
        SAMPLE_C_LZ: 71, SAMPLE_L: 72, SAMPLE_D: 73, SAMPLE_B: 74, SQRT: 75, SWITCH: 76, SINCOS: 77,
        UDIV: 78, ULT: 79, UGE: 80, UMUL: 81, UMAD: 82, UMAX: 83, UMIN: 84, USHR: 85, UTOF: 86, XOR: 87,
        DCL_RESOURCE: 88, DCL_CONSTANT_BUFFER: 89, DCL_SAMPLER: 90, DCL_INDEX_RANGE: 91,
        DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY: 92, DCL_GS_INPUT_PRIMITIVE: 93, DCL_MAX_OUTPUT_VERTEX_COUNT: 94,
        DCL_INPUT: 95, DCL_INPUT_SGV: 96, DCL_INPUT_SIV: 97, DCL_INPUT_PS: 98, DCL_INPUT_PS_SGV: 99,
        DCL_INPUT_PS_SIV: 100, DCL_OUTPUT: 101, DCL_OUTPUT_SGV: 102, DCL_OUTPUT_SIV: 103, DCL_TEMPS: 104,
        DCL_INDEXABLE_TEMP: 105, DCL_GLOBAL_FLAGS: 106, VMWARE: 107, LOD: 108, GATHER4: 109,
        SAMPLE_POS: 110, SAMPLE_INFO: 111, HS_DECLS: 113, HS_CONTROL_POINT_PHASE: 114, HS_FORK_PHASE: 115,
        HS_JOIN_PHASE: 116, EMIT_STREAM: 117, CUT_STREAM: 118, EMITTHENCUT_STREAM: 119, INTERFACE_CALL: 120,
        BUFINFO: 121, DERIV_RTX_COARSE: 122, DERIV_RTX_FINE: 123, DERIV_RTY_COARSE: 124, DERIV_RTY_FINE: 125,
        GATHER4_C: 126, GATHER4_PO: 127, GATHER4_PO_C: 128, RCP: 129, F32TOF16: 130, F16TOF32: 131,
        UADDC: 132, USUBB: 133, COUNTBITS: 134, FIRSTBIT_HI: 135, FIRSTBIT_LO: 136, FIRSTBIT_SHI: 137,
        UBFE: 138, IBFE: 139, BFI: 140, BFREV: 141, SWAPC: 142, DCL_STREAM: 143, DCL_FUNCTION_BODY: 144,
        DCL_FUNCTION_TABLE: 145, DCL_INTERFACE: 146, DCL_INPUT_CONTROL_POINT_COUNT: 147,
        DCL_OUTPUT_CONTROL_POINT_COUNT: 148, DCL_TESS_DOMAIN: 149, DCL_TESS_PARTITIONING: 150,
        DCL_TESS_OUTPUT_PRIMITIVE: 151, DCL_HS_MAX_TESSFACTOR: 152, DCL_HS_FORK_PHASE_INSTANCE_COUNT: 153,
        DCL_HS_JOIN_PHASE_INSTANCE_COUNT: 154, DCL_THREAD_GROUP: 155, DCL_UAV_TYPED: 156, DCL_UAV_RAW: 157,
        DCL_UAV_STRUCTURED: 158, DCL_TGSM_RAW: 159, DCL_TGSM_STRUCTURED: 160, DCL_RESOURCE_RAW: 161,
        DCL_RESOURCE_STRUCTURED: 162, LD_UAV_TYPED: 163, STORE_UAV_TYPED: 164, LD_RAW: 165, STORE_RAW: 166,
        LD_STRUCTURED: 167, STORE_STRUCTURED: 168, ATOMIC_AND: 169, ATOMIC_OR: 170, ATOMIC_XOR: 171,
        ATOMIC_CMP_STORE: 172, ATOMIC_IADD: 173, ATOMIC_IMAX: 174, ATOMIC_IMIN: 175, ATOMIC_UMAX: 176,
        ATOMIC_UMIN: 177, IMM_ATOMIC_ALLOC: 178, IMM_ATOMIC_CONSUME: 179, IMM_ATOMIC_IADD: 180,
        IMM_ATOMIC_AND: 181, IMM_ATOMIC_OR: 182, IMM_ATOMIC_XOR: 183, IMM_ATOMIC_EXCH: 184,
        IMM_ATOMIC_CMP_EXCH: 185, IMM_ATOMIC_IMAX: 186, IMM_ATOMIC_IMIN: 187, IMM_ATOMIC_UMAX: 188,
        IMM_ATOMIC_UMIN: 189, SYNC: 190, DADD: 191, DMAX: 192, DMIN: 193, DMUL: 194, DEQ: 195, DGE: 196,
        DLT: 197, DNE: 198, DMOV: 199, DMOVC: 200, DTOF: 201, FTOD: 202, EVAL_SNAPPED: 203,
        EVAL_SAMPLE_INDEX: 204, EVAL_CENTROID: 205, DCL_GS_INSTANCE_COUNT: 206, ABORT: 207,
        DEBUG_BREAK: 208, DDIV: 210, DFMA: 211, DRCP: 212, MSAD: 213, DTOI: 214, DTOU: 215, ITOD: 216,
        UTOD: 217,
    };
    const OP_NAMES = [];
    for (const name of Object.keys(OP)) OP_NAMES[OP[name]] = name.toLowerCase();

    // VGPU10_VMWARE_OPCODE_TYPE: in the controls of OP.VMWARE
    const VMWARE_OP = { IDIV: 0, DFRC: 1, DRSQ: 2 };

    // Operand types (VGPU10_OPERAND_TYPE)
    const OPERAND = {
        TEMP: 0, INPUT: 1, OUTPUT: 2, INDEXABLE_TEMP: 3, IMMEDIATE32: 4, IMMEDIATE64: 5, SAMPLER: 6,
        RESOURCE: 7, CONSTANT_BUFFER: 8, IMMEDIATE_CONSTANT_BUFFER: 9, LABEL: 10, INPUT_PRIMITIVEID: 11,
        OUTPUT_DEPTH: 12, NULL: 13, RASTERIZER: 14, OUTPUT_COVERAGE_MASK: 15, STREAM: 16,
        FUNCTION_BODY: 17, FUNCTION_TABLE: 18, INTERFACE: 19, FUNCTION_INPUT: 20, FUNCTION_OUTPUT: 21,
        OUTPUT_CONTROL_POINT_ID: 22, INPUT_FORK_INSTANCE_ID: 23, INPUT_JOIN_INSTANCE_ID: 24,
        INPUT_CONTROL_POINT: 25, OUTPUT_CONTROL_POINT: 26, INPUT_PATCH_CONSTANT: 27,
        INPUT_DOMAIN_POINT: 28, THIS_POINTER: 29, UAV: 30, THREAD_GROUP_SHARED_MEMORY: 31,
        INPUT_THREAD_ID: 32, INPUT_THREAD_GROUP_ID: 33, INPUT_THREAD_ID_IN_GROUP: 34,
        INPUT_COVERAGE_MASK: 35, INPUT_THREAD_ID_IN_GROUP_FLATTENED: 36, INPUT_GS_INSTANCE_ID: 37,
        OUTPUT_DEPTH_GREATER_EQUAL: 38, OUTPUT_DEPTH_LESS_EQUAL: 39, CYCLE_COUNTER: 40,
    };

    // System value names (VGPU10_SYSTEM_NAME)
    const NAME = {
        UNDEFINED: 0, POSITION: 1, CLIP_DISTANCE: 2, CULL_DISTANCE: 3, RENDER_TARGET_ARRAY_INDEX: 4,
        VIEWPORT_ARRAY_INDEX: 5, VERTEX_ID: 6, PRIMITIVE_ID: 7, INSTANCE_ID: 8, IS_FRONT_FACE: 9,
        SAMPLE_INDEX: 10,
        // a hull shader's tess factors (patch constant outputs)
        FINAL_QUAD_U_EQ_0_EDGE_TESSFACTOR: 11, FINAL_QUAD_V_EQ_0_EDGE_TESSFACTOR: 12,
        FINAL_QUAD_U_EQ_1_EDGE_TESSFACTOR: 13, FINAL_QUAD_V_EQ_1_EDGE_TESSFACTOR: 14,
        FINAL_QUAD_U_INSIDE_TESSFACTOR: 15, FINAL_QUAD_V_INSIDE_TESSFACTOR: 16,
        FINAL_TRI_U_EQ_0_EDGE_TESSFACTOR: 17, FINAL_TRI_V_EQ_0_EDGE_TESSFACTOR: 18, FINAL_TRI_W_EQ_0_EDGE_TESSFACTOR: 19,
        FINAL_TRI_INSIDE_TESSFACTOR: 20, FINAL_LINE_DETAIL_TESSFACTOR: 21, FINAL_LINE_DENSITY_TESSFACTOR: 22,
    };

    const INTERPOLATION = {
        UNDEFINED: 0, CONSTANT: 1, LINEAR: 2, LINEAR_CENTROID: 3, LINEAR_NOPERSPECTIVE: 4,
        LINEAR_NOPERSPECTIVE_CENTROID: 5, LINEAR_SAMPLE: 6, LINEAR_NOPERSPECTIVE_SAMPLE: 7,
    };

    const DIM = {
        UNKNOWN: 0, BUFFER: 1, TEXTURE1D: 2, TEXTURE2D: 3, TEXTURE2DMS: 4, TEXTURE3D: 5, TEXTURECUBE: 6,
        TEXTURE1DARRAY: 7, TEXTURE2DARRAY: 8, TEXTURE2DMSARRAY: 9, TEXTURECUBEARRAY: 10, RAW_BUFFER: 11,
        STRUCTURED_BUFFER: 12,
    };

    const RETURN = { UNORM: 1, SNORM: 2, SINT: 3, UINT: 4, FLOAT: 5, MIXED: 6, DOUBLE: 7, CONTINUED: 8, UNUSED: 9 };

    const PRIMITIVE = { UNDEFINED: 0, POINT: 1, LINE: 2, TRIANGLE: 3, LINE_ADJ: 6, TRIANGLE_ADJ: 7 };

    const CUSTOMDATA = { COMMENT: 0, DEBUGINFO: 1, OPAQUE: 2, ICB: 3 };

    // How many destination operands an instruction has (the rest are sources)
    const DESTINATIONS = new Map([
        [OP.SINCOS, 2], [OP.UDIV, 2], [OP.IMUL, 2], [OP.UMUL, 2], [OP.SWAPC, 2], [OP.UADDC, 2], [OP.USUBB, 2],
    ]);
    // Instructions with no destination
    const NO_DESTINATION = new Set([
        OP.BREAK, OP.BREAKC, OP.CALL, OP.CALLC, OP.CASE, OP.CONTINUE, OP.CONTINUEC, OP.CUT, OP.DEFAULT,
        OP.DISCARD, OP.ELSE, OP.EMIT, OP.EMITTHENCUT, OP.ENDIF, OP.ENDLOOP, OP.ENDSWITCH, OP.IF, OP.LABEL,
        OP.LOOP, OP.NOP, OP.RET, OP.RETC, OP.SWITCH, OP.EMIT_STREAM, OP.CUT_STREAM, OP.EMITTHENCUT_STREAM,
        OP.INTERFACE_CALL, OP.SYNC, OP.ABORT, OP.DEBUG_BREAK, OP.HS_DECLS, OP.HS_CONTROL_POINT_PHASE,
        OP.HS_FORK_PHASE, OP.HS_JOIN_PHASE,
    ]);
    // ... and those whose first operand is written although it is a UAV or
    // shared memory (stores, atomics without a returned value)
    const STORES = new Set([
        OP.STORE_UAV_TYPED, OP.STORE_RAW, OP.STORE_STRUCTURED, OP.ATOMIC_AND, OP.ATOMIC_OR, OP.ATOMIC_XOR,
        OP.ATOMIC_CMP_STORE, OP.ATOMIC_IADD, OP.ATOMIC_IMAX, OP.ATOMIC_IMIN, OP.ATOMIC_UMAX, OP.ATOMIC_UMIN,
    ]);

    function isDeclaration(op) {
        return (op >= OP.DCL_RESOURCE && op <= OP.DCL_GLOBAL_FLAGS) || op === OP.DCL_STREAM ||
            (op >= OP.DCL_FUNCTION_BODY && op <= OP.DCL_RESOURCE_STRUCTURED) || op === OP.DCL_GS_INSTANCE_COUNT;
    }

    /**
     * One shader program
     * @param tokens Uint32Array of the program's dwords (more after its
     *               length are ignored: VMware appends a signature there)
     */
    function decode(tokens) {
        if (!(tokens instanceof Uint32Array)) tokens = new Uint32Array(tokens);
        if (tokens.length < 2) throw new ShaderDecodeError("a shader of " + tokens.length + " tokens");
        const version = tokens[0];
        const type = version >>> 16;
        const major = version >>> 4 & 0xF, minor = version & 0xF;
        const length = tokens[1];
        if (type > PROGRAM.CS || length < 2 || length > tokens.length) {
            throw new ShaderDecodeError("bad program header " + version.toString(16) + ", length " + length);
        }
        const program = {
            type, stage: PROGRAM_NAMES[type], major, minor,
            decls: [], code: [], icb: null, temps: 0, indexable: new Map(),
            inputs: [], outputs: [], resources: new Map(), samplers: new Map(), cbuffers: new Map(),
            uavs: new Map(), tgsm: new Map(), globalFlags: 0,
            gs: { input: 0, outputTopology: 0, maxVertices: 0, instances: 1, streams: [] },
            // hull and domain shaders: control points, the tessellator's
            // settings, and a hull shader's phases (code and declarations
            // carry their phase's index; -1 outside of a hull shader)
            tess: { inputCPs: 0, outputCPs: 0, domain: 0, partitioning: 0, outputPrimitive: 0, maxTessFactor: 64, phases: [] },
            threadGroup: [1, 1, 1], indexRanges: [],
            signature: decodeSignature(tokens, length),
        };

        let at = 2;
        let phase = -1;
        while (at < length) {
            const start = at;
            const token = tokens[at];
            const op = token & 0x7FF;
            let size = token >>> 24 & 0x7F;
            if (op === OP.CUSTOMDATA) {
                // its length is the next dword (the two header dwords included)
                size = tokens[at + 1];
                if (size < 2 || start + size > length) throw new ShaderDecodeError("bad customdata length " + size);
                const kind = token >>> 11;
                if (kind === CUSTOMDATA.ICB) program.icb = tokens.slice(start + 2, start + size);
                at = start + size;
                continue;
            }
            if (size === 0 || start + size > length) {
                throw new ShaderDecodeError("instruction " + (OP_NAMES[op] || op) + " at " + start + ": length " + size);
            }
            const end = start + size;
            // a hull shader's phases begin with these
            const PHASES = { [OP.HS_DECLS]: "decls", [OP.HS_CONTROL_POINT_PHASE]: "cp", [OP.HS_FORK_PHASE]: "fork", [OP.HS_JOIN_PHASE]: "join" };
            if (PHASES[op]) {
                program.tess.phases.push({ kind: PHASES[op], instances: 1 });
                phase = program.tess.phases.length - 1;
            }
            const instruction = {
                op, name: OP_NAMES[op] || ("op" + op), at: start, phase,
                controls: token >>> 11 & 0x1FFF,
                saturate: !!(token >>> 13 & 1),
                test: token >>> 18 & 1,
                precise: token >>> 19 & 0xF,
                offsets: null, dimension: 0, returnTypes: null,
                dst: [], src: [],
            };
            at++;
            // extended opcode tokens
            let extended = token >>> 31;
            while (extended) {
                if (at >= end) throw new ShaderDecodeError("extended opcode beyond its instruction");
                const t = tokens[at++];
                switch (t & 0x3F) {
                    case 1: { // sample controls: signed 4-bit texel offsets
                        const s4 = v => v & 8 ? v - 16 : v;
                        instruction.offsets = [s4(t >>> 9 & 0xF), s4(t >>> 13 & 0xF), s4(t >>> 17 & 0xF)];
                        break;
                    }
                    case 2: instruction.dimension = t >>> 6 & 0x1F; break;
                    case 3: instruction.returnTypes = [t >>> 6 & 0xF, t >>> 10 & 0xF, t >>> 14 & 0xF, t >>> 18 & 0xF]; break;
                }
                extended = t >>> 31;
            }

            if (isDeclaration(op)) {
                decodeDeclaration(program, instruction, tokens, at, end);
                program.decls.push(instruction);
                at = end;
                continue;
            }

            const operands = [];
            while (at < end) {
                const [operand, next] = decodeOperand(tokens, at, end);
                operands.push(operand);
                at = next;
            }
            let dsts = NO_DESTINATION.has(op) ? 0 : (DESTINATIONS.get(op) || 1);
            if (STORES.has(op)) dsts = 1;
            // VMware's integer division: quotient and remainder (Mesa's svga
            // writes the second as a null operand)
            if (op === OP.VMWARE && (instruction.controls & 0xF) === VMWARE_OP.IDIV) dsts = 2;
            instruction.dst = operands.slice(0, dsts);
            instruction.src = operands.slice(dsts);
            if (op === OP.VMWARE) instruction.vmware = instruction.controls & 0xF;
            program.code.push(instruction);
        }
        return program;
    }

    /**
     * One operand at tokens[at]
     * @return [operand, the index after it]
     */
    function decodeOperand(tokens, at, end) {
        const token = tokens[at++];
        const ncomp = [0, 1, 4, -1][token & 3];
        const operand = {
            type: token >>> 12 & 0xFF,
            ncomp,
            mode: "mask", mask: 0xF, swizzle: [0, 1, 2, 3],
            indices: [],
            modifier: 0,
            imm: null,
        };
        if (ncomp === 4) {
            const selection = token >>> 2 & 3;
            if (selection === 0) {
                operand.mode = "mask";
                operand.mask = token >>> 4 & 0xF;
                // (a mask of 0 means all of them)
                if (!operand.mask) operand.mask = 0xF;
            } else if (selection === 1) {
                operand.mode = "swizzle";
                operand.swizzle = [token >>> 4 & 3, token >>> 6 & 3, token >>> 8 & 3, token >>> 10 & 3];
            } else {
                operand.mode = "select1";
                const c = token >>> 4 & 3;
                operand.swizzle = [c, c, c, c];
            }
        } else if (ncomp === 1) {
            operand.mode = "select1";
            operand.swizzle = [0, 0, 0, 0];
        }
        const dimensions = token >>> 20 & 3;
        const representations = [token >>> 22 & 7, token >>> 25 & 7, token >>> 28 & 7];
        let extended = token >>> 31;
        while (extended) {
            if (at >= end) throw new ShaderDecodeError("extended operand beyond its instruction");
            const t = tokens[at++];
            if ((t & 0x3F) === 1) operand.modifier = t >>> 6 & 0xFF;
            extended = t >>> 31;
        }
        if (operand.type === OPERAND.IMMEDIATE32) {
            const count = ncomp === 4 ? 4 : 1;
            if (at + count > end) throw new ShaderDecodeError("immediate beyond its instruction");
            operand.imm = Array.from(tokens.subarray(at, at + count));
            return [operand, at + count];
        }
        if (operand.type === OPERAND.IMMEDIATE64) {
            const count = ncomp === 4 ? 4 : 2;
            operand.imm = Array.from(tokens.subarray(at, at + count));
            return [operand, at + count];
        }
        for (let d = 0; d < dimensions; d++) {
            const representation = representations[d];
            const index = { imm: 0, rel: null };
            switch (representation) {
                case 0: // immediate32
                    index.imm = tokens[at++];
                    break;
                case 1: // immediate64 (the low dword is enough here)
                    index.imm = tokens[at];
                    at += 2;
                    break;
                case 2: { // relative
                    const [rel, next] = decodeOperand(tokens, at, end);
                    index.rel = rel;
                    at = next;
                    break;
                }
                case 3: { // immediate32 + relative
                    index.imm = tokens[at++];
                    const [rel, next] = decodeOperand(tokens, at, end);
                    index.rel = rel;
                    at = next;
                    break;
                }
                case 4: { // immediate64 + relative
                    index.imm = tokens[at];
                    at += 2;
                    const [rel, next] = decodeOperand(tokens, at, end);
                    index.rel = rel;
                    at = next;
                    break;
                }
                default:
                    throw new ShaderDecodeError("index representation " + representation);
            }
            operand.indices.push(index);
        }
        if (at > end) throw new ShaderDecodeError("operand beyond its instruction");
        return [operand, at];
    }

    function decodeDeclaration(program, instruction, tokens, at, end) {
        const op = instruction.op;
        const controls = instruction.controls;
        const operand = () => {
            const [o, next] = decodeOperand(tokens, at, end);
            at = next;
            return o;
        };
        const word = () => {
            if (at >= end) throw new ShaderDecodeError(instruction.name + " is too short");
            return tokens[at++];
        };
        switch (op) {
            case OP.DCL_TEMPS:
                program.temps = Math.max(program.temps, word());
                break;
            case OP.DCL_INDEXABLE_TEMP: {
                const index = word(), size = word(), components = word();
                program.indexable.set(index, { size, components });
                break;
            }
            case OP.DCL_GLOBAL_FLAGS:
                program.globalFlags = controls;
                break;
            case OP.DCL_INPUT:
            case OP.DCL_INPUT_SGV:
            case OP.DCL_INPUT_SIV:
            case OP.DCL_INPUT_PS:
            case OP.DCL_INPUT_PS_SGV:
            case OP.DCL_INPUT_PS_SIV: {
                const o = operand();
                const name = op === OP.DCL_INPUT_SGV || op === OP.DCL_INPUT_SIV ||
                    op === OP.DCL_INPUT_PS_SGV || op === OP.DCL_INPUT_PS_SIV ? word() & 0xFFFF : 0;
                const interpolation = op >= OP.DCL_INPUT_PS && op <= OP.DCL_INPUT_PS_SIV ? controls & 0xF : 0;
                program.inputs.push({ operand: o, type: o.type, index: indexOf(o), index2: o.indices.length > 1 ? o.indices[1].imm : -1,
                    mask: o.mask, name, interpolation, phase: instruction.phase });
                break;
            }
            case OP.DCL_OUTPUT:
            case OP.DCL_OUTPUT_SGV:
            case OP.DCL_OUTPUT_SIV: {
                const o = operand();
                const name = op !== OP.DCL_OUTPUT ? word() & 0xFFFF : 0;
                program.outputs.push({ operand: o, type: o.type, index: indexOf(o), mask: o.mask, name, phase: instruction.phase });
                break;
            }
            case OP.DCL_RESOURCE: {
                const o = operand();
                const r = word();
                program.resources.set(indexOf(o), { kind: "texture", dimension: controls & 0x1F,
                    samples: controls >>> 5 & 0x7F, returnTypes: [r & 0xF, r >>> 4 & 0xF, r >>> 8 & 0xF, r >>> 12 & 0xF] });
                break;
            }
            case OP.DCL_RESOURCE_RAW: {
                const o = operand();
                program.resources.set(indexOf(o), { kind: "raw", dimension: DIM.RAW_BUFFER, samples: 0, returnTypes: null });
                break;
            }
            case OP.DCL_RESOURCE_STRUCTURED: {
                const o = operand();
                program.resources.set(indexOf(o), { kind: "structured", dimension: DIM.STRUCTURED_BUFFER,
                    samples: 0, returnTypes: null, stride: word() });
                break;
            }
            case OP.DCL_UAV_TYPED: {
                const o = operand();
                const r = word();
                program.uavs.set(indexOf(o), { kind: "typed", dimension: controls & 0x1F,
                    returnTypes: [r & 0xF, r >>> 4 & 0xF, r >>> 8 & 0xF, r >>> 12 & 0xF],
                    counter: !!(controls >>> 12 & 1), coherent: !!(controls >>> 5 & 1) });
                break;
            }
            case OP.DCL_UAV_RAW: {
                const o = operand();
                program.uavs.set(indexOf(o), { kind: "raw", dimension: DIM.RAW_BUFFER, counter: !!(controls >>> 12 & 1) });
                break;
            }
            case OP.DCL_UAV_STRUCTURED: {
                const o = operand();
                program.uavs.set(indexOf(o), { kind: "structured", dimension: DIM.STRUCTURED_BUFFER,
                    stride: word(), counter: !!(controls >>> 12 & 1) });
                break;
            }
            case OP.DCL_TGSM_RAW: {
                const o = operand();
                program.tgsm.set(indexOf(o), { kind: "raw", bytes: word() });
                break;
            }
            case OP.DCL_TGSM_STRUCTURED: {
                const o = operand();
                const stride = word(), count = word();
                program.tgsm.set(indexOf(o), { kind: "structured", stride, count, bytes: stride * count });
                break;
            }
            case OP.DCL_CONSTANT_BUFFER: {
                // cb#[size]: the second index is the size in vec4s
                const o = operand();
                program.cbuffers.set(o.indices[0].imm, { size: o.indices.length > 1 ? o.indices[1].imm : 4096,
                    dynamic: !!(controls & 1) });
                break;
            }
            case OP.DCL_SAMPLER: {
                const o = operand();
                program.samplers.set(indexOf(o), { mode: controls & 0xF });
                break;
            }
            case OP.DCL_INDEX_RANGE: {
                const o = operand();
                program.indexRanges.push({ type: o.type, index: indexOf(o), count: word() });
                break;
            }
            case OP.DCL_GS_INPUT_PRIMITIVE:
                program.gs.input = controls & 0x3F;
                break;
            case OP.DCL_GS_OUTPUT_PRIMITIVE_TOPOLOGY:
                program.gs.outputTopology = controls & 0x7F;
                break;
            case OP.DCL_MAX_OUTPUT_VERTEX_COUNT:
                program.gs.maxVertices = word();
                break;
            case OP.DCL_GS_INSTANCE_COUNT:
                program.gs.instances = word();
                break;
            case OP.DCL_STREAM:
                program.gs.streams.push(indexOf(operand()));
                break;
            case OP.DCL_THREAD_GROUP:
                program.threadGroup = [word(), word(), word()];
                break;
            case OP.DCL_INPUT_CONTROL_POINT_COUNT:
                program.tess.inputCPs = controls & 0x3F;
                break;
            case OP.DCL_OUTPUT_CONTROL_POINT_COUNT:
                program.tess.outputCPs = controls & 0x3F;
                break;
            case OP.DCL_TESS_DOMAIN:
                program.tess.domain = controls & 3;
                break;
            case OP.DCL_TESS_PARTITIONING:
                program.tess.partitioning = controls & 7;
                break;
            case OP.DCL_TESS_OUTPUT_PRIMITIVE:
                program.tess.outputPrimitive = controls & 7;
                break;
            case OP.DCL_HS_MAX_TESSFACTOR:
                program.tess.maxTessFactor = new Float32Array(new Uint32Array([word()]).buffer)[0];
                break;
            case OP.DCL_HS_FORK_PHASE_INSTANCE_COUNT:
            case OP.DCL_HS_JOIN_PHASE_INSTANCE_COUNT: {
                const p = program.tess.phases[instruction.phase];
                if (p) p.instances = word();
                break;
            }
            default:
                // the tessellation and interface declarations are taken as
                // they come; the stages that need them read instruction.raw
                instruction.raw = Array.from(tokens.subarray(at, end));
        }
    }

    function indexOf(operand) {
        return operand.indices.length ? operand.indices[operand.indices.length === 1 ? 0 : 0].imm : 0;
    }

    /**
     * VMware's signature block after the program (SVGA3dDXShaderSignatureHeader
     * and its entries), if there is one
     */
    function decodeSignature(tokens, length) {
        const at = length;
        if (tokens.length < at + 4 || tokens[at] !== 0x08a92d12) return null;
        const inputs = tokens[at + 1], outputs = tokens[at + 2], patch = tokens[at + 3];
        const total = inputs + outputs + patch;
        if (tokens.length < at + 4 + 5 * total) return null;
        const entry = i => {
            const e = at + 4 + 5 * i;
            return { register: tokens[e], name: tokens[e + 1], mask: tokens[e + 2], componentType: tokens[e + 3] };
        };
        const list = (first, count) => Array.from({ length: count }, (_, i) => entry(first + i));
        return { inputs: list(0, inputs), outputs: list(inputs, outputs), patch: list(inputs + outputs, patch) };
    }

    /**
     * Assemble tokens from a compact description, for tests: see
     * tests/glbridge/dxbc_wgsl_test.js
     */
    const api = {
        decode, ShaderDecodeError, PROGRAM, PROGRAM_NAMES, OP, OP_NAMES, VMWARE_OP, OPERAND, NAME, INTERPOLATION,
        DIM, RETURN, PRIMITIVE, CUSTOMDATA,
    };
    if (typeof module === "object" && module.exports) module.exports = api;
    else global.V86DXBCFrontend = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
