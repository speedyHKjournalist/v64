// The GL shadow's ARB assembly programs (docs/opengl-webgpu-plan.md C5):
// ARB_vertex_program's and ARB_fragment_program's objects, parameters and
// queries, on the CPU side and by the extensions' rules:
// - a program string that does not assemble leaves the program as it was
//   (Mesa's reading), and sets the error position and string;
// - environment parameters belong to the context and the target, shared
//   by every program of it and settable with none bound; local ones to the
//   program object;
// - program object 0 is a real (default) program of each target.
// The assembler is gl_arb_program.js's (its parse and its checks). The
// executor still keeps environment parameters per program when it renders
// (plan E2).

(function(global) {
    "use strict";

    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const constants = global.GLWGConstants || require("./gl_constants.js");
    const arb = global.GLARBProgram || require("./gl_arb_program.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const { GLFN, C, F, RECORDS } = protocol;
    const GL = constants.GL;

    const OK = C.V86GL_SYNC_QUERY_STATUS_OK;
    const FAILED = C.V86GL_SYNC_QUERY_STATUS_FAILED;
    const ENV = C.V86GL_PROGRAM_PARAMETER_ENV, LOCAL = C.V86GL_PROGRAM_PARAMETER_LOCAL;
    // what the renderer has room for: the same for both targets
    const MAX_PARAMETERS = arb.MAX_PROGRAM_PARAMETERS;
    const TARGETS = { [GL.VERTEX_PROGRAM_ARB]: "vertex", [GL.FRAGMENT_PROGRAM_ARB]: "fragment" };

    const newProgram = (name, target) => ({ name, target, source: "", compiled: null,
        local: new Float64Array(MAX_PARAMETERS * 4) });

    const proto = GLShadow.prototype;

    // The program bound to a target here (object 0 is the context's own)
    proto.arbProgram = function(target) {
        const c = this.current;
        if (!TARGETS[target]) return null;
        const name = c.arb.bound[target];
        if (!name) return c.arb.defaults[target];
        return c.group.arbPrograms.get(name) || null;
    };

    proto.genProgramsARB = function(bytes, view, offset, size) {
        const programs = this.current.group.arbPrograms;
        for (const name of this.names("GEN_PROGRAMS_ARB", view, offset, size) || [])
            if (name && !programs.has(name)) programs.set(name, newProgram(name, 0));
    };

    // A deleted program bound here reverts to object 0
    proto.deleteProgramsARB = function(bytes, view, offset, size) {
        const c = this.current;
        for (const name of this.names("DELETE_PROGRAMS_ARB", view, offset, size) || []) {
            if (!name || !c.group.arbPrograms.delete(name)) continue;
            for (const target of Object.keys(c.arb.bound)) if (c.arb.bound[target] === name) c.arb.bound[target] = 0;
        }
    };

    proto.bindProgramARB = function(bytes, view, offset, size) {
        const a = this.args("BIND_PROGRAM_ARB", view, offset, size);
        if (!a || !TARGETS[a[0]]) return;
        const programs = this.current.group.arbPrograms;
        let program = a[1] && programs.get(a[1]);
        if (a[1] && !program) programs.set(a[1], program = newProgram(a[1], a[0]));
        // (a program of the other target cannot be bound to this one)
        if (program && program.target && program.target !== a[0]) return;
        if (program) program.target = a[0];
        this.current.arb.bound[a[0]] = a[1];
    };

    // {target, format, length, reserved} then the text
    proto.programStringARB = function(bytes, view, offset, size) {
        const header = RECORDS.PROGRAM_STRING_ARB.size;
        if (size < header) return;
        const target = view.getUint32(offset + F.PROGRAM_STRING_ARB.target, true);
        const length = view.getInt32(offset + F.PROGRAM_STRING_ARB.length, true);
        const program = this.arbProgram(target);
        if (!program || length < 0 || header + length > size) return;
        let source = "";
        for (let i = 0; i < length && bytes[offset + header + i]; ++i) source += String.fromCharCode(bytes[offset + header + i]);
        const compiled = arb.compileARBProgram(source, {});
        const state = this.current.arb;
        if (compiled.ok && compiled.target !== TARGETS[target]) {
            compiled.ok = false;
            compiled.log = "ERROR: a " + compiled.target + " program cannot be loaded for the " + TARGETS[target] +
                " target";
            compiled.errorPosition = 0;
        }
        if (!compiled.ok) {
            state.errorPosition = compiled.errorPosition >= 0 ? compiled.errorPosition : 0;
            state.errorString = compiled.log;
            return;
        }
        program.source = source;
        program.compiled = compiled;
        state.errorPosition = -1;
        state.errorString = "";
    };

    // {kind, target, index, count} then count * 4 floats, or {kind, target,
    // index, reserved} then four doubles
    proto.programParameterARB = function(doublePrecision) {
        return function(bytes, view, offset, size) {
            const name = doublePrecision ? "PROGRAM_PARAMETER_DV_ARB" : "PROGRAM_PARAMETER_FV_ARB";
            const R = F[name];
            if (size < RECORDS.PROGRAM_PARAMETER_FV_ARB.size) return;
            const target = view.getUint32(offset + R.target, true);
            const index = view.getUint32(offset + R.index, true);
            const count = doublePrecision ? 1 : Math.max(1, view.getUint32(offset + F.PROGRAM_PARAMETER_FV_ARB.count, true));
            const storage = this.arbParameters(view.getUint32(offset + R.parameter_kind, true), target);
            const at = doublePrecision ? F.PROGRAM_PARAMETER_DV_ARB.values : RECORDS.PROGRAM_PARAMETER_FV_ARB.size;
            const stride = doublePrecision ? 8 : 4;
            if (!storage || index + count > MAX_PARAMETERS || at + count * 4 * stride > size) return;
            for (let i = 0; i < count * 4; ++i)
                storage[index * 4 + i] = doublePrecision ? view.getFloat64(offset + at + i * 8, true) :
                    view.getFloat32(offset + at + i * 4, true);
        };
    };
    proto.programParameterFvARB = proto.programParameterARB(false);
    proto.programParameterDvARB = proto.programParameterARB(true);

    proto.arbParameters = function(kind, target) {
        if (!TARGETS[target]) return null;
        if (kind === ENV) return this.current.arb.env[target];
        const program = kind === LOCAL ? this.arbProgram(target) : null;
        return program ? program.local : null;
    };

    proto.programivARB = function(target, pname) {
        const program = this.arbProgram(target);
        const compiled = program && program.compiled;
        const reflection = compiled && compiled.reflection;
        switch (pname) {
        case GL.PROGRAM_LENGTH_ARB: return program ? program.source.length : 0;
        case GL.PROGRAM_FORMAT_ARB: return GL.PROGRAM_FORMAT_ASCII_ARB;
        case GL.PROGRAM_BINDING_ARB: return this.current.arb.bound[target] || 0;
        case GL.PROGRAM_INSTRUCTIONS_ARB:
        case GL.PROGRAM_NATIVE_INSTRUCTIONS_ARB:
            return reflection ? reflection.instructionCount : 0;
        case GL.PROGRAM_TEMPORARIES_ARB:
        case GL.PROGRAM_NATIVE_TEMPORARIES_ARB:
            return reflection ? reflection.temporaryCount : 0;
        case GL.PROGRAM_PARAMETERS_ARB:
        case GL.PROGRAM_NATIVE_PARAMETERS_ARB:
        case GL.MAX_PROGRAM_PARAMETERS_ARB:
        case GL.MAX_PROGRAM_NATIVE_PARAMETERS_ARB:
        case GL.MAX_PROGRAM_ENV_PARAMETERS_ARB:
        case GL.MAX_PROGRAM_LOCAL_PARAMETERS_ARB:
            return MAX_PARAMETERS;
        case GL.MAX_PROGRAM_INSTRUCTIONS_ARB:
        case GL.MAX_PROGRAM_NATIVE_INSTRUCTIONS_ARB:
            return 4096;
        case GL.MAX_PROGRAM_TEMPORARIES_ARB:
        case GL.MAX_PROGRAM_NATIVE_TEMPORARIES_ARB:
            return arb.MAX_TEMPORARIES;
        case GL.PROGRAM_UNDER_NATIVE_LIMITS_ARB: return compiled ? 1 : 0;
        case GL.PROGRAM_ERROR_POSITION_ARB: return this.current.arb.errorPosition;
        default: return 0;
        }
    };

    // {target, pname, status, value}
    proto.queryProgramIvARB = function(bytes, view, offset, size) {
        const R = F.QUERY_PROGRAM_IV_ARB;
        if (!this.pending("QUERY_PROGRAM_IV_ARB", view, offset, size)) return;
        const target = view.getUint32(offset + R.target, true);
        if (!TARGETS[target]) return this.answered("QUERY_PROGRAM_IV_ARB", view, offset, FAILED);
        view.setInt32(offset + R.value, this.programivARB(target, view.getUint32(offset + R.pname, true)), true);
        this.answered("QUERY_PROGRAM_IV_ARB", view, offset, OK);
    };

    // {kind, target, index, status, data_size, reserved} then four floats or doubles
    proto.queryProgramParameterARB = function(doublePrecision) {
        return function(bytes, view, offset, size) {
            const name = doublePrecision ? "QUERY_PROGRAM_PARAMETER_DV_ARB" : "QUERY_PROGRAM_PARAMETER_FV_ARB";
            const R = F[name], header = RECORDS[name].size, stride = doublePrecision ? 8 : 4;
            if (!this.pending(name, view, offset, size)) return;
            const index = view.getUint32(offset + R.index, true);
            const storage = this.arbParameters(view.getUint32(offset + R.parameter_kind, true),
                view.getUint32(offset + R.target, true));
            if (!storage || index >= MAX_PARAMETERS || header + 4 * stride > size)
                return this.answered(name, view, offset, FAILED);
            for (let c = 0; c < 4; ++c) {
                if (doublePrecision) view.setFloat64(offset + header + c * 8, storage[index * 4 + c], true);
                else view.setFloat32(offset + header + c * 4, storage[index * 4 + c], true);
            }
            this.answered(name, view, offset, OK);
        };
    };
    proto.queryProgramParameterFvARB = proto.queryProgramParameterARB(false);
    proto.queryProgramParameterDvARB = proto.queryProgramParameterARB(true);

    // {target, pname, status, length, data_size, reserved} then the text,
    // unterminated (the caller sized it from PROGRAM_LENGTH_ARB)
    proto.queryProgramStringARB = function(bytes, view, offset, size) {
        const R = F.QUERY_PROGRAM_STRING_ARB, header = RECORDS.QUERY_PROGRAM_STRING_ARB.size;
        if (!this.pending("QUERY_PROGRAM_STRING_ARB", view, offset, size)) return;
        const program = this.arbProgram(view.getUint32(offset + R.target, true));
        const capacity = view.getUint32(offset + R.data_size, true);
        if (!program || header + capacity > size) return this.answered("QUERY_PROGRAM_STRING_ARB", view, offset, FAILED);
        const written = Math.min(program.source.length, capacity);
        for (let i = 0; i < written; ++i) bytes[offset + header + i] = program.source.charCodeAt(i) & 0xff;
        view.setUint32(offset + R.length, written, true);
        this.answered("QUERY_PROGRAM_STRING_ARB", view, offset, OK);
    };

    proto.programErrorPosition = function() {
        return this.current.arb.errorPosition;
    };

    proto.programErrorString = function() {
        return this.current.arb.errorString;
    };

    GLShadow.install({
        [GLFN.GEN_PROGRAMS_ARB]: "genProgramsARB",
        [GLFN.DELETE_PROGRAMS_ARB]: "deleteProgramsARB",
        [GLFN.BIND_PROGRAM_ARB]: "bindProgramARB",
        [GLFN.PROGRAM_STRING_ARB]: "programStringARB",
        [GLFN.PROGRAM_PARAMETER_FV_ARB]: "programParameterFvARB",
        [GLFN.PROGRAM_PARAMETER_DV_ARB]: "programParameterDvARB",
        [GLFN.QUERY_PROGRAM_IV_ARB]: "queryProgramIvARB",
        [GLFN.QUERY_PROGRAM_PARAMETER_FV_ARB]: "queryProgramParameterFvARB",
        [GLFN.QUERY_PROGRAM_PARAMETER_DV_ARB]: "queryProgramParameterDvARB",
        [GLFN.QUERY_PROGRAM_STRING_ARB]: "queryProgramStringARB",
    });
    GLShadow.queries({
        integers: { [GL.PROGRAM_ERROR_POSITION_ARB]: "programErrorPosition" },
        strings: { [GL.PROGRAM_ERROR_STRING_ARB]: "programErrorString" },
    });

    // (a snapshot keeps the sources; they assemble again on restore)
    const programOut = p => [p.name, p.target, p.source, [...p.local]];
    const programIn = ([name, target, source, local]) => {
        const program = newProgram(name, target);
        program.source = source;
        program.local.set(local);
        if (source) program.compiled = arb.compileARBProgram(source, {});
        return program;
    };

    GLShadow.part({
        group(group) {
            group.arbPrograms = new Map();
        },
        context(context) {
            context.arb = {
                bound: { [GL.VERTEX_PROGRAM_ARB]: 0, [GL.FRAGMENT_PROGRAM_ARB]: 0 },
                defaults: { [GL.VERTEX_PROGRAM_ARB]: newProgram(0, GL.VERTEX_PROGRAM_ARB),
                    [GL.FRAGMENT_PROGRAM_ARB]: newProgram(0, GL.FRAGMENT_PROGRAM_ARB) },
                env: { [GL.VERTEX_PROGRAM_ARB]: new Float64Array(MAX_PARAMETERS * 4),
                    [GL.FRAGMENT_PROGRAM_ARB]: new Float64Array(MAX_PARAMETERS * 4) },
                errorPosition: -1,
                errorString: "",
            };
        },
        getState(shadow, state) {
            state.arb = {
                groups: [...shadow.groups.values()].map(g => [g.key, [...g.arbPrograms.values()].map(programOut)]),
                contexts: [...shadow.contexts.values()].map(c => [c.key, c.arb.bound,
                    Object.values(c.arb.defaults).map(programOut),
                    [GL.VERTEX_PROGRAM_ARB, GL.FRAGMENT_PROGRAM_ARB].map(t => [...c.arb.env[t]]),
                    c.arb.errorPosition, c.arb.errorString]),
            };
        },
        setState(shadow, state) {
            if (!state.arb) return;
            for (const [key, programs] of state.arb.groups) {
                const group = shadow.groups.get(key);
                if (group) for (const saved of programs) group.arbPrograms.set(saved[0], programIn(saved));
            }
            for (const [key, bound, defaults, env, errorPosition, errorString] of state.arb.contexts) {
                const context = shadow.contexts.get(key);
                if (!context) continue;
                context.arb.bound = bound;
                for (const saved of defaults) context.arb.defaults[saved[1]] = programIn(saved);
                context.arb.env[GL.VERTEX_PROGRAM_ARB].set(env[0]);
                context.arb.env[GL.FRAGMENT_PROGRAM_ARB].set(env[1]);
                context.arb.errorPosition = errorPosition;
                context.arb.errorString = errorString;
            }
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
