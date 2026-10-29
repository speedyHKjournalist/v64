// The GL shadow's shaders and programs (docs/opengl-webgpu-plan.md C4, the
// first step): GLSL 1.10/1.20 checked, linked and reflected by glslang on the
// CPU side, so glGetShaderiv, glGetProgramiv, the info logs, the active
// uniforms and attributes, the locations and glGetUniform* are answered in
// the request that asks, in both of the proxy's modes.
//
// glslang runs when an answer needs it, not at glCompileShader: the module
// may arrive after the first shaders (the renderer sends it), and a guest
// that never asks pays nothing. Until it is there these queries stay PENDING
// for the executor.
//
// Locations are this side's. A uniform's are the program's name times
// UNIFORM_LOCATIONS_PER_PROGRAM plus its position among the program's
// uniform elements, so they are the same after a relink and after a
// snapshot; an attribute not bound by the application takes the highest
// free slot, around the slots the conventional attributes alias
// (gl_shader_translator.js's table, NVIDIA's). The page's executor adopts
// what the guest was told: an answered location record is the mapping.

(function(global) {
    "use strict";

    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const constants = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const { STAGE_OF_GL_TYPE } = global.V86GLGlslang || require("./gl_glslang.js");
    const { GLFN, C, F, RECORDS } = protocol;
    const GL = constants.GL;

    const OK = C.V86GL_SYNC_QUERY_STATUS_OK;
    const FAILED = C.V86GL_SYNC_QUERY_STATUS_FAILED;
    const PENDING = C.V86GL_SYNC_QUERY_STATUS_PENDING;
    const UNIFORM_LOCATIONS_PER_PROGRAM = 4096;
    const MAX_VERTEX_ATTRIBS = 16;
    const CONVENTIONAL_SLOTS = {
        gl_Vertex: 0, gl_Normal: 2, gl_Color: 3, gl_SecondaryColor: 4, gl_FogCoord: 5,
        gl_MultiTexCoord0: 8, gl_MultiTexCoord1: 9, gl_MultiTexCoord2: 10, gl_MultiTexCoord3: 11,
        gl_MultiTexCoord4: 12, gl_MultiTexCoord5: 13, gl_MultiTexCoord6: 14, gl_MultiTexCoord7: 15,
    };

    // GL type -> [base ("f", "i", "b"), columns, rows]: a vector is one
    // column, a sampler an int
    const TYPES = new Map([
        [0x1406, ["f", 1, 1]], [0x8B50, ["f", 1, 2]], [0x8B51, ["f", 1, 3]], [0x8B52, ["f", 1, 4]],
        [0x1404, ["i", 1, 1]], [0x8B53, ["i", 1, 2]], [0x8B54, ["i", 1, 3]], [0x8B55, ["i", 1, 4]],
        [0x8B56, ["b", 1, 1]], [0x8B57, ["b", 1, 2]], [0x8B58, ["b", 1, 3]], [0x8B59, ["b", 1, 4]],
        [0x8B5A, ["f", 2, 2]], [0x8B5B, ["f", 3, 3]], [0x8B5C, ["f", 4, 4]],
        [0x8B65, ["f", 2, 3]], [0x8B66, ["f", 2, 4]], [0x8B67, ["f", 3, 2]],
        [0x8B68, ["f", 3, 4]], [0x8B69, ["f", 4, 2]], [0x8B6A, ["f", 4, 3]],
    ]);
    const typeOf = type => TYPES.get(type) || ["i", 1, 1];

    // glslang's limits, from what the renderer backs (gl_caps.js)
    function glslangLimits(capabilities) {
        const limits = capabilities.limits;
        return {
            MaxLights: 8, MaxClipPlanes: 6, MaxTextureUnits: 8, MaxTextureCoords: 8,
            MaxVertexAttribs: MAX_VERTEX_ATTRIBS, MaxVertexUniformComponents: 1024, MaxVaryingFloats: 64,
            MaxVertexTextureImageUnits: 16, MaxCombinedTextureImageUnits: 24, MaxTextureImageUnits: 16,
            MaxFragmentUniformComponents: 1024, MaxDrawBuffers: Math.min(8, limits.maxColorAttachments),
        };
    }

    function readText(bytes, at, length) {
        let end = at;
        while (end < at + length && bytes[end]) ++end;
        let text = "";
        for (let i = at; i < end; ++i) text += String.fromCharCode(bytes[i]);
        return text;
    }

    // As much of `text` as fits in `capacity` bytes, terminated; the length written
    function writeText(bytes, at, capacity, text) {
        if (!capacity) return 0;
        const length = Math.min(text.length, capacity - 1);
        for (let i = 0; i < length; ++i) bytes[at + i] = text.charCodeAt(i) & 0xff;
        bytes[at + length] = 0;
        return length;
    }

    const proto = GLShadow.prototype;

    proto.createShader = function(bytes, view, offset, size) {
        const a = this.args("CREATE_SHADER", view, offset, size);
        if (!a || !STAGE_OF_GL_TYPE.has(a[1])) return;
        this.current.group.shaders.set(a[0], { name: a[0], type: a[1], source: "", compileSource: null,
            compiled: null, deleted: false });
    };

    proto.shaderSource = function(bytes, view, offset, size) {
        if (size < RECORDS.SHADER_SOURCE.size) return;
        const shader = this.current.group.shaders.get(view.getUint32(offset + F.SHADER_SOURCE.shader, true));
        const length = view.getUint32(offset + F.SHADER_SOURCE.length, true);
        if (!shader || RECORDS.SHADER_SOURCE.size + length > size) return;
        shader.source = readText(bytes, offset + RECORDS.SHADER_SOURCE.size, length);
    };

    // compiled when an answer needs it: the source as it was now
    proto.compileShader = function(bytes, view, offset, size) {
        const a = this.args("COMPILE_SHADER", view, offset, size);
        const shader = a && this.current.group.shaders.get(a[0]);
        if (!shader) return;
        shader.compileSource = shader.source;
        shader.compiled = null;
    };

    // {ok, log}, or null without glslang
    proto.compiledShader = function(shader) {
        if (shader.compileSource === null) return { ok: false, log: "" };
        if (!shader.compiled) {
            if (!this.prepareGlslang()) return null;
            shader.compiled = this.glslang.compile(STAGE_OF_GL_TYPE.get(shader.type), shader.compileSource);
        }
        return shader.compiled;
    };

    proto.prepareGlslang = function() {
        if (!this.glslang || !this.capabilities) return false;
        this.glslang.setLimits(glslangLimits(this.capabilities));
        return true;
    };

    // A shader flagged for deletion goes once no program has it attached
    proto.deleteShader = function(bytes, view, offset, size) {
        const a = this.args("DELETE_SHADER", view, offset, size);
        const group = this.current.group;
        const shader = a && group.shaders.get(a[0]);
        if (!shader) return;
        shader.deleted = true;
        this.collectShader(group, shader);
    };

    proto.collectShader = function(group, shader) {
        if (!shader.deleted) return;
        for (const program of group.programs.values()) if (program.attached.has(shader.name)) return;
        group.shaders.delete(shader.name);
    };

    proto.createProgram = function(bytes, view, offset, size) {
        const a = this.args("CREATE_PROGRAM", view, offset, size);
        if (!a) return;
        this.current.group.programs.set(a[0], { name: a[0], attached: new Set(), bindings: new Map(),
            linkInput: null, linked: null, validated: false, deleted: false, values: new Map() });
    };

    proto.attachShader = function(bytes, view, offset, size) {
        const a = this.args("ATTACH_SHADER", view, offset, size);
        const group = this.current.group;
        const program = a && group.programs.get(a[0]);
        if (program && group.shaders.has(a[1])) program.attached.add(a[1]);
    };

    proto.detachShader = function(bytes, view, offset, size) {
        const a = this.args("DETACH_SHADER", view, offset, size);
        const group = this.current.group;
        const program = a && group.programs.get(a[0]);
        if (!program || !program.attached.delete(a[1])) return;
        const shader = group.shaders.get(a[1]);
        if (shader) this.collectShader(group, shader);
    };

    proto.bindAttribLocation = function(bytes, view, offset, size) {
        const header = RECORDS.BIND_ATTRIB_LOCATION.size;
        if (size < header) return;
        const program = this.current.group.programs.get(view.getUint32(offset + F.BIND_ATTRIB_LOCATION.program, true));
        const length = view.getUint32(offset + F.BIND_ATTRIB_LOCATION.name_length, true);
        if (!program || header + length > size) return;
        // takes effect at the next link
        program.bindings.set(readText(bytes, offset + header, length),
            view.getInt32(offset + F.BIND_ATTRIB_LOCATION.location, true));
    };

    // Linked when an answer needs it, from the shaders and bindings as they
    // are now; the uniforms' values start over
    proto.linkProgram = function(bytes, view, offset, size) {
        const a = this.args("LINK_PROGRAM", view, offset, size);
        const group = this.current.group;
        const program = a && group.programs.get(a[0]);
        if (!program) return;
        const shaders = [...program.attached].map(name => group.shaders.get(name)).filter(Boolean);
        program.linkInput = { shaders: shaders.map(s => ({ type: s.type, compileSource: s.compileSource })),
            bindings: [...program.bindings] };
        program.linked = null;
        program.validated = false;
        program.values = new Map();
    };

    // The link's result: {ok, log, uniforms, attributes, byLocation}, or null without glslang
    proto.linkedProgram = function(program) {
        if (program.linked) return program.linked;
        if (!program.linkInput) return { ok: false, log: "", uniforms: [], attributes: [], byLocation: new Map() };
        if (!this.prepareGlslang()) return null;
        const failed = log => ({ ok: false, log, uniforms: [], attributes: [], byLocation: new Map() });
        const shaders = program.linkInput.shaders;
        if (!shaders.length) return program.linked = failed("ERROR: no shaders attached\n");
        for (const shader of shaders) {
            if (shader.compileSource === null) return program.linked = failed("ERROR: a shader is not compiled\n");
            if (!this.glslang.compile(STAGE_OF_GL_TYPE.get(shader.type), shader.compileSource).ok)
                return program.linked = failed("ERROR: a shader did not compile\n");
        }
        const result = this.glslang.link(shaders.map(s => ({ stage: STAGE_OF_GL_TYPE.get(s.type),
            source: s.compileSource })));
        if (!result.ok) return program.linked = failed(result.log);
        const linked = { ok: true, log: result.log, uniforms: [], attributes: [], byLocation: new Map() };
        // uniforms: GL's list, built-ins too ("gl_" names have no location)
        let next = (program.name % (0x80000000 / UNIFORM_LOCATIONS_PER_PROGRAM)) * UNIFORM_LOCATIONS_PER_PROGRAM;
        for (const u of result.uniforms) {
            const name = u.name.replace(/\[0\]$/, "");
            const size = Math.max(1, u.size);
            const uniform = { name, active: u.arrayDims ? name + "[0]" : name, array: !!u.arrayDims, type: u.type,
                size, location: -1 };
            if (!name.startsWith("gl_")) {
                uniform.location = next;
                for (let i = 0; i < size; ++i) linked.byLocation.set(next + i, { uniform, element: i });
                next += size;
            }
            linked.uniforms.push(uniform);
        }
        // attributes: the vertex stage's inputs
        const vertexSources = shaders.filter(s => s.type === GL.VERTEX_SHADER).map(s => s.compileSource).join("\n");
        const used = new Set();
        if (/\b(gl_Vertex|ftransform)\b/.test(vertexSources)) used.add(0);
        const inputs = result.inputs.filter(i => i.stages & 1 || !(i.stages >>> 0));
        for (const i of inputs) if (i.name in CONVENTIONAL_SLOTS) used.add(CONVENTIONAL_SLOTS[i.name]);
        const bindings = new Map(program.linkInput.bindings);
        const slots = type => typeOf(type)[1];
        for (const i of inputs) {
            const attribute = { name: i.name, type: i.type, size: Math.max(1, i.size), location: -1 };
            linked.attributes.push(attribute);
            if (i.name.startsWith("gl_")) continue;
            const bound = bindings.get(i.name);
            if (bound !== undefined) {
                attribute.location = bound;
                for (let k = 0; k < slots(i.type); ++k) used.add(bound + k);
            }
        }
        for (const attribute of linked.attributes) {
            if (attribute.name.startsWith("gl_") || attribute.location >= 0) continue;
            const n = slots(attribute.type);
            let base = MAX_VERTEX_ATTRIBS - n;
            const free = b => { for (let k = 0; k < n; ++k) if (used.has(b + k)) return false; return true; };
            while (base >= 0 && !free(base)) --base;
            if (base < 0) return program.linked = failed("ERROR: out of vertex attribute slots for '" +
                attribute.name + "'\n");
            for (let k = 0; k < n; ++k) used.add(base + k);
            attribute.location = base;
        }
        return program.linked = linked;
    };

    proto.useProgram = function(bytes, view, offset, size) {
        const a = this.args("USE_PROGRAM", view, offset, size);
        if (!a) return;
        const group = this.current.group;
        const previous = group.programs.get(this.current.program);
        this.current.program = a[0];
        if (previous) this.collectProgram(group, previous);
    };

    proto.validateProgram = function(bytes, view, offset, size) {
        const a = this.args("VALIDATE_PROGRAM", view, offset, size);
        const program = a && this.current.group.programs.get(a[0]);
        if (program) program.validated = true;
    };

    // A program flagged for deletion goes once no context uses it
    proto.deleteProgram = function(bytes, view, offset, size) {
        const a = this.args("DELETE_PROGRAM", view, offset, size);
        const group = this.current.group;
        const program = a && group.programs.get(a[0]);
        if (!program) return;
        program.deleted = true;
        this.collectProgram(group, program);
    };

    proto.collectProgram = function(group, program) {
        if (!program.deleted) return;
        for (const context of this.contexts.values())
            if (context.group === group && context.program === program.name) return;
        group.programs.delete(program.name);
        for (const name of program.attached) {
            const shader = group.shaders.get(name);
            program.attached.delete(name);
            if (shader) this.collectShader(group, shader);
        }
    };

    // glUniform*: the current program's values, by location
    proto.uniformValues = function(view, offset, size, header, location, columns, rows, count, transpose, integer) {
        const program = this.current.group.programs.get(this.current.program);
        const linked = program && program.linked;
        if (!linked || !linked.ok) return;
        for (let m = 0; m < count; ++m) {
            const entry = linked.byLocation.get(location + m);
            if (!entry || entry.uniform.location + entry.uniform.size <= location + m) return;
            const values = [];
            for (let c = 0; c < columns; ++c) for (let r = 0; r < rows; ++r) {
                const index = transpose ? r * columns + c : c * rows + r;
                const at = offset + header + (m * columns * rows + index) * 4;
                if (at + 4 > offset + size) return;
                values.push(integer ? view.getInt32(at, true) : view.getFloat32(at, true));
            }
            program.values.set(location + m, values);
        }
    };

    proto.uniformVector = function(integer) {
        return function(bytes, view, offset, size) {
            const name = integer ? "UNIFORM_IV" : "UNIFORM_FV";
            if (size < RECORDS[name].size) return;
            const components = view.getInt32(offset + F[name].components, true);
            if (components < 1 || components > 4) return;
            this.uniformValues(view, offset, size, RECORDS[name].size, view.getInt32(offset + F[name].location, true),
                1, components, view.getInt32(offset + F[name].count, true), false, integer);
        };
    };
    proto.uniformFv = proto.uniformVector(false);
    proto.uniformIv = proto.uniformVector(true);

    proto.uniformMatrix = function(bytes, view, offset, size) {
        const R = F.UNIFORM_MATRIX_FV;
        if (size < RECORDS.UNIFORM_MATRIX_FV.size) return;
        const n = view.getInt32(offset + R.dimension, true);
        this.uniformValues(view, offset, size, RECORDS.UNIFORM_MATRIX_FV.size, view.getInt32(offset + R.location, true),
            n, n, view.getInt32(offset + R.count, true), view.getUint32(offset + R.transpose, true) !== 0, false);
    };

    proto.uniformMatrixRect = function(bytes, view, offset, size) {
        const R = F.UNIFORM_MATRIX_RECT_FV;
        if (size < RECORDS.UNIFORM_MATRIX_RECT_FV.size) return;
        this.uniformValues(view, offset, size, RECORDS.UNIFORM_MATRIX_RECT_FV.size,
            view.getInt32(offset + R.location, true), view.getInt32(offset + R.columns, true),
            view.getInt32(offset + R.rows, true), view.getInt32(offset + R.count, true),
            view.getUint32(offset + R.transpose, true) !== 0, false);
    };

    /* ---- the answers ---- */

    const maxLength = list => list.reduce((n, e) => Math.max(n, e.length + 1), 0);

    proto.queryObjectIv = function(bytes, view, offset, size) {
        const R = F.QUERY_OBJECT_IV;
        if (!this.pending("QUERY_OBJECT_IV", view, offset, size)) return;
        const kind = view.getUint32(offset + R.object_kind, true);
        const name = view.getUint32(offset + R.name, true);
        const pname = view.getUint32(offset + R.pname, true);
        const group = this.current.group;
        let value = null;
        if (kind === C.V86GL_OBJECT_KIND_SHADER) {
            const shader = group.shaders.get(name);
            if (!shader) return this.answered("QUERY_OBJECT_IV", view, offset, FAILED);
            if (pname === GL.COMPILE_STATUS || pname === GL.INFO_LOG_LENGTH) {
                const compiled = this.compiledShader(shader);
                if (!compiled) return;
                value = pname === GL.COMPILE_STATUS ? +compiled.ok : compiled.log ? compiled.log.length + 1 : 0;
            } else if (pname === GL.SHADER_TYPE) value = shader.type;
            else if (pname === GL.DELETE_STATUS) value = +shader.deleted;
            else if (pname === GL.SHADER_SOURCE_LENGTH) value = shader.source ? shader.source.length + 1 : 0;
        } else if (kind === C.V86GL_OBJECT_KIND_PROGRAM) {
            const program = group.programs.get(name);
            if (!program) return this.answered("QUERY_OBJECT_IV", view, offset, FAILED);
            if (pname === GL.DELETE_STATUS) value = +program.deleted;
            else if (pname === GL.ATTACHED_SHADERS) value = program.attached.size;
            else if (pname === GL.VALIDATE_STATUS) {
                const linked = this.linkedProgram(program);
                if (!linked) return;
                value = +(program.validated && linked.ok);
            } else {
                const linked = this.linkedProgram(program);
                if (!linked) return;
                switch (pname) {
                case GL.LINK_STATUS: value = +linked.ok; break;
                case GL.INFO_LOG_LENGTH: value = linked.log ? linked.log.length + 1 : 0; break;
                case GL.ACTIVE_UNIFORMS: value = linked.uniforms.length; break;
                case GL.ACTIVE_ATTRIBUTES: value = linked.attributes.length; break;
                case GL.ACTIVE_UNIFORM_MAX_LENGTH: value = maxLength(linked.uniforms.map(u => u.active)); break;
                case GL.ACTIVE_ATTRIBUTE_MAX_LENGTH: value = maxLength(linked.attributes.map(a => a.name)); break;
                }
            }
        } else {
            // queries' results are the renderer's
            return;
        }
        if (value === null) return this.answered("QUERY_OBJECT_IV", view, offset, FAILED);
        view.setInt32(offset + R.value, value, true);
        this.answered("QUERY_OBJECT_IV", view, offset, OK);
    };

    // {object_kind, name, buf_size, status, length, data_size} then the text
    proto.queryObjectLog = function(bytes, view, offset, size) {
        const R = F.QUERY_OBJECT_LOG, header = RECORDS.QUERY_OBJECT_LOG.size;
        if (!this.pending("QUERY_OBJECT_LOG", view, offset, size)) return;
        const kind = view.getUint32(offset + R.object_kind, true);
        const name = view.getUint32(offset + R.name, true);
        const capacity = view.getUint32(offset + R.buf_size, true);
        const group = this.current.group;
        let result;
        if (kind === C.V86GL_OBJECT_KIND_SHADER) {
            const shader = group.shaders.get(name);
            result = shader ? this.compiledShader(shader) : undefined;
        } else if (kind === C.V86GL_OBJECT_KIND_PROGRAM) {
            const program = group.programs.get(name);
            result = program ? this.linkedProgram(program) : undefined;
        } else {
            return;
        }
        if (result === null) return;
        if (!result || header + capacity > size) return this.answered("QUERY_OBJECT_LOG", view, offset, FAILED);
        view.setUint32(offset + R.length, writeText(bytes, offset + header, capacity, result.log), true);
        this.answered("QUERY_OBJECT_LOG", view, offset, OK);
    };

    // {active_kind, program, index, buf_size, status, length, size, type, data_size, reserved} then the name
    proto.queryActive = function(bytes, view, offset, size) {
        const R = F.QUERY_ACTIVE, header = RECORDS.QUERY_ACTIVE.size;
        if (!this.pending("QUERY_ACTIVE", view, offset, size)) return;
        const program = this.current.group.programs.get(view.getUint32(offset + R.program, true));
        const linked = program ? this.linkedProgram(program) : undefined;
        if (linked === null) return;
        const kind = view.getUint32(offset + R.active_kind, true);
        const index = view.getUint32(offset + R.index, true);
        const capacity = view.getUint32(offset + R.buf_size, true);
        const list = !linked ? [] : kind === C.V86GL_ACTIVE_KIND_ATTRIB ? linked.attributes : linked.uniforms;
        const entry = list[index];
        if (!entry || header + capacity > size) return this.answered("QUERY_ACTIVE", view, offset, FAILED);
        view.setUint32(offset + R.length, writeText(bytes, offset + header, capacity, entry.active || entry.name), true);
        view.setInt32(offset + R.size, entry.size, true);
        view.setUint32(offset + R.type, entry.type, true);
        this.answered("QUERY_ACTIVE", view, offset, OK);
    };

    // {location_kind, program, guest_location, status, result, value_type, value_count, name_length} then the name
    proto.queryLocation = function(bytes, view, offset, size) {
        const R = F.QUERY_LOCATION, header = RECORDS.QUERY_LOCATION.size;
        if (!this.pending("QUERY_LOCATION", view, offset, size)) return;
        const program = this.current.group.programs.get(view.getUint32(offset + R.program, true));
        const linked = program ? this.linkedProgram(program) : undefined;
        if (linked === null) return;
        const length = view.getUint32(offset + R.name_length, true);
        if (!linked || !linked.ok || header + length > size) return this.answered("QUERY_LOCATION", view, offset, FAILED);
        const name = readText(bytes, offset + header, length);
        let location = -1, type = 0, count = 0;
        if (view.getUint32(offset + R.location_kind, true) === C.V86GL_LOCATION_KIND_ATTRIB) {
            const attribute = linked.attributes.find(a => a.name === name);
            if (attribute && attribute.location >= 0) {
                location = attribute.location;
                type = attribute.type;
                count = typeOf(type)[1] * typeOf(type)[2];
            }
        } else {
            // name, name[0] and name[i]: location + i
            const match = /^(.*)\[(\d+)\]$/.exec(name);
            const base = match ? match[1] : name, element = match ? +match[2] : 0;
            const uniform = linked.uniforms.find(u => u.name === base);
            if (uniform && uniform.location >= 0 && element < uniform.size && (!match || uniform.array)) {
                location = uniform.location + element;
                type = uniform.type;
                count = typeOf(type)[1] * typeOf(type)[2];
            }
        }
        view.setInt32(offset + R.result, location, true);
        view.setUint32(offset + R.value_type, type, true);
        view.setInt32(offset + R.value_count, count, true);
        this.answered("QUERY_LOCATION", view, offset, OK);
    };

    // {program, location, value_kind, status, value_count, data_size, reserved0, reserved1} then the values:
    // value_kind 1 floats, 2 ints
    proto.queryUniform = function(bytes, view, offset, size) {
        const R = F.QUERY_UNIFORM, header = RECORDS.QUERY_UNIFORM.size;
        if (!this.pending("QUERY_UNIFORM", view, offset, size)) return;
        const program = this.current.group.programs.get(view.getUint32(offset + R.program, true));
        const linked = program ? this.linkedProgram(program) : undefined;
        if (linked === null) return;
        const location = view.getInt32(offset + R.location, true);
        const entry = linked && linked.ok ? linked.byLocation.get(location) : null;
        if (!entry) return this.answered("QUERY_UNIFORM", view, offset, FAILED);
        const [base, columns, rows] = typeOf(entry.uniform.type);
        const count = columns * rows;
        if (header + count * 4 > size) return this.answered("QUERY_UNIFORM", view, offset, FAILED);
        const values = program.values.get(location) || new Array(count).fill(0);
        const integer = view.getUint32(offset + R.value_kind, true) === 2;
        for (let i = 0; i < count; ++i) {
            let v = values[i] || 0;
            if (base === "b") v = v ? 1 : 0;
            if (integer) view.setInt32(offset + header + i * 4, base === "f" ? Math.round(v) : v, true);
            else view.setFloat32(offset + header + i * 4, v, true);
        }
        view.setInt32(offset + R.value_count, count, true);
        this.answered("QUERY_UNIFORM", view, offset, OK);
    };

    GLShadow.install({
        [GLFN.CREATE_SHADER]: "createShader",
        [GLFN.SHADER_SOURCE]: "shaderSource",
        [GLFN.COMPILE_SHADER]: "compileShader",
        [GLFN.DELETE_SHADER]: "deleteShader",
        [GLFN.CREATE_PROGRAM]: "createProgram",
        [GLFN.ATTACH_SHADER]: "attachShader",
        [GLFN.DETACH_SHADER]: "detachShader",
        [GLFN.BIND_ATTRIB_LOCATION]: "bindAttribLocation",
        [GLFN.LINK_PROGRAM]: "linkProgram",
        [GLFN.USE_PROGRAM]: "useProgram",
        [GLFN.VALIDATE_PROGRAM]: "validateProgram",
        [GLFN.DELETE_PROGRAM]: "deleteProgram",
        [GLFN.UNIFORM_FV]: "uniformFv",
        [GLFN.UNIFORM_IV]: "uniformIv",
        [GLFN.UNIFORM_MATRIX_FV]: "uniformMatrix",
        [GLFN.UNIFORM_MATRIX_RECT_FV]: "uniformMatrixRect",
        [GLFN.QUERY_OBJECT_IV]: "queryObjectIv",
        [GLFN.QUERY_OBJECT_LOG]: "queryObjectLog",
        [GLFN.QUERY_ACTIVE]: "queryActive",
        [GLFN.QUERY_LOCATION]: "queryLocation",
        [GLFN.QUERY_UNIFORM]: "queryUniform",
    });

    // The objects, in snapshots: what was compiled and linked, and the
    // uniforms' values (glslang runs again when an answer needs it)
    GLShadow.part({
        group(group) {
            group.shaders = new Map();
            group.programs = new Map();
        },
        getState(shadow, state) {
            state.glsl = [...shadow.groups.values()].map(group => ({
                key: group.key,
                shaders: [...group.shaders.values()].map(s => [s.name, s.type, s.source, s.compileSource, s.deleted]),
                programs: [...group.programs.values()].map(p => [p.name, [...p.attached], [...p.bindings], p.linkInput,
                    p.validated, p.deleted, [...p.values]]),
            }));
        },
        setState(shadow, state) {
            for (const saved of state.glsl || []) {
                const group = shadow.groups.get(saved.key);
                if (!group) continue;
                for (const [name, type, source, compileSource, deleted] of saved.shaders)
                    group.shaders.set(name, { name, type, source, compileSource, compiled: null, deleted });
                for (const [name, attached, bindings, linkInput, validated, deleted, values] of saved.programs)
                    group.programs.set(name, { name, attached: new Set(attached), bindings: new Map(bindings), linkInput,
                        linked: null, validated, deleted, values: new Map(values) });
            }
        },
    });

    const api = { UNIFORM_LOCATIONS_PER_PROGRAM, CONVENTIONAL_SLOTS };
    global.V86GLShadowGLSL = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
