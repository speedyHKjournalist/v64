(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const geometry = global.GLSelectGeometry || require("./gl_select_geometry.js");
    const arrays = global.GLListArrays || require("./gl_list_arrays.js");
    const clientArrays = global.GLClientArrays || require("./gl_client_arrays.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    if (typeof module !== "undefined" && module.exports) require("./gl_shadow_arrays.js");
    const CHUNK = 262144;
    const MAX_CAPTURE_VERTICES = 65536, MAX_PENDING_VERTICES = 262144;
    const maxNames = s => s.capabilities ? caps.integer(s.capabilities, GL.MAX_NAME_STACK_DEPTH) ?? caps.LIMITS.MAX_NAME_STACK_DEPTH : caps.LIMITS.MAX_NAME_STACK_DEPTH;
    const feedbackTypes = new Set([GL["2D"], GL["3D"], GL["3D_COLOR"], GL["3D_COLOR_TEXTURE"], GL["4D_COLOR_TEXTURE"]]);
    const initial = () => ({ mode: GL.RENDER, selectSize: 0, selectPointer: 0, feedbackSize: 0, feedbackPointer: 0, feedbackType: GL["2D"],
        names: [], hitNames: [], data: [], overflow: false, hits: 0, hit: null, primitive: null, pending: null, nextTicket: 0,
        events: [], retired: [], sequence: 0 });
    const modeOf = c => c.state.selection?.mode ?? GL.RENDER;
    function write(q, values, direct = false) {
        if (!direct && q.events?.length) { q.events.push({ kind: "words", values }); return; }
        const capacity = q.mode === GL.SELECT ? q.selectSize : q.feedbackSize;
        for (const value of values) if (q.data.length < capacity) q.data.push(value); else q.overflow = true;
    }
    function flushHit(q) {
        if (!q.hit) return;
        const names = q.hitNames || q.names;
        write(q, [names.length, Math.round(q.hit[0] * 0xFFFFFFFF), Math.round(q.hit[1] * 0xFFFFFFFF), ...names], true);
        ++q.hits; q.hit = null;
    }
    function hit(q, depths, direct = false) {
        if (!direct && q.events?.length) { q.events.push({ kind: "hit", depths }); return; }
        for (const z of depths) if (Number.isFinite(z)) {
            const value = Math.max(0, Math.min(1, z));
            if (!q.hit) q.hit = [value, value];
            else { q.hit[0] = Math.min(q.hit[0], value); q.hit[1] = Math.max(q.hit[1], value); }
        }
    }
    function feedbackVertex(q, position, color, tex) {
        const out = position.slice(0, q.feedbackType === GL["2D"] ? 2 : q.feedbackType === GL["4D_COLOR_TEXTURE"] ? 4 : 3);
        if ([GL["3D_COLOR"], GL["3D_COLOR_TEXTURE"], GL["4D_COLOR_TEXTURE"]].includes(q.feedbackType)) out.push(...color);
        if ([GL["3D_COLOR_TEXTURE"], GL["4D_COLOR_TEXTURE"]].includes(q.feedbackType)) out.push(...tex);
        return out.map(Math.fround);
    }
    function emit(c, primitive, q = c.state.selection, direct = false) {
        const vertices = primitive.vertices, points = vertices.map(v => geometry.window(c, v)), append = values => write(q, values, direct);
        if (q.mode === GL.SELECT) return hit(q, points.map(p => p[2]), direct);
        const vertex = i => feedbackVertex(q, points[i], primitive.front ? vertices[i].color : vertices[i].backColor, vertices[i].tex);
        if (primitive.kind === "point") return append([GL.POINT_TOKEN, ...vertex(0)]);
        if (primitive.kind === "line") return append([primitive.reset ? GL.LINE_RESET_TOKEN : GL.LINE_TOKEN, ...vertex(0), ...vertex(1)]);
        const polygonMode = c.state.values[GL.POLYGON_MODE][primitive.front ? 0 : 1];
        // Rotating a polygon preserves its winding. Start with its provoking
        // end vertex, matching the legacy native feedback packet ordering.
        const order = [vertices.length - 1, ...Array.from({ length: vertices.length - 1 }, (_, i) => i)];
        if (polygonMode === GL.POINT) for (const i of order) { if (vertices[i].edge) append([GL.POINT_TOKEN, ...vertex(i)]); }
        else if (polygonMode === GL.LINE) {
            let first = true;
            for (let i = 0; i < order.length; ++i) if (vertices[order[i]].edge) {
                append([first ? GL.LINE_RESET_TOKEN : GL.LINE_TOKEN, ...vertex(order[i]), ...vertex(order[(i + 1) % order.length])]); first = false;
            }
        }
        else append([GL.POLYGON_TOKEN, vertices.length, ...order.flatMap(vertex)]);
    }
    function finish(s, c, q, out) {
        if (out.mode === GL.SELECT) flushHit(out);
        const r = out.close.fields, ticket = out.data.length ? q.nextTicket = q.nextTicket % 0xFFFFFFFF + 1 : 0;
        if (out.close.sequence === q.sequence) q.pending = ticket ? { ticket, data: out.data, mode: out.mode } : null;
        Object.assign(r, { status: out.failure ? P.C.V86GL_SYNC_QUERY_STATUS_FAILED : P.C.V86GL_SYNC_QUERY_STATUS_OK, error: out.failure || 0,
            result: out.overflow ? -1 : out.mode === GL.SELECT ? out.hits : out.mode === GL.FEEDBACK ? out.data.length : 0,
            ticket, total: out.data.length * 4, size: c.id, pointer: out.mode === GL.SELECT ? out.selectPointer : out.mode === GL.FEEDBACK ? out.feedbackPointer : 0, type: out.mode });
        if (out.failure && !c.error) c.error = out.failure;
        s.completeResponse(out.close.target, P.encodeRecord("QUERY_RENDER_MODE", r), P.F.QUERY_RENDER_MODE.status); ++s.stats.answered;
    }
    function drain(s, c, q, out) {
        while (out.events.length) {
            const event = out.events[0]; if (event.kind === "capture" && !event.ready) break;
            out.events.shift();
            if (event.kind === "words") write(out, event.values, true);
            else if (event.kind === "hit") hit(out, event.depths, true);
            else if (event.kind === "names") { flushHit(out); out.hitNames = event.names; }
            else if (event.kind === "capture") {
                if (event.error) out.failure = event.error;
                else geometry.primitives(event.context, event.mode, event.vertices, primitive => emit(event.context, primitive, out, true));
            }
        }
        if (!out.events.length && out.close) {
            finish(s, c, q, out); q.retired = q.retired.filter(item => item !== out);
        }
    }
    function program(s) {
        const c = s.current, p = c.group.programs?.get(c.program);
        if (p) {
            const linked = s.installedProgram?.(p);
            if (p.executableInput?.shaders.some(shader => shader.type === GL.VERTEX_SHADER))
                return { attributes: linked?.attributes || [], sources: p.executableInput.shaders.map(shader => shader.compileSource).join("\n"), glsl: true };
            // An installed fragment-only GLSL program leaves the vertex stage fixed.
            return null;
        }
        if (c.state.raster.enabled[GL.VERTEX_PROGRAM_ARB]) {
            const p = s.arbProgram?.(GL.VERTEX_PROGRAM_ARB);
            if (p?.compiled?.ok) return { attributes: p.compiled.reflection.attributes, invariant: p.compiled.reflection.positionInvariant };
        }
        return null;
    }
    const conventional = { gl_Vertex: 0, gl_Normal: 2, gl_Color: 3, gl_SecondaryColor: 4, gl_FogCoord: 5,
        ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["gl_MultiTexCoord" + i, 8 + i])) };
    function input(c, p, position, attributes = {}) {
        const values = c.state.values, slots = c.state.arrays.generic.map((a, i) => (attributes["generic" + i] || a.current).slice());
        const compat = { gl_Vertex: position, gl_Normal: attributes.normal || values[GL.CURRENT_NORMAL], gl_Color: attributes.color || values[GL.CURRENT_COLOR],
            gl_SecondaryColor: attributes.secondaryColor || values[GL.CURRENT_SECONDARY_COLOR_EXT], gl_FogCoord: attributes.fogCoord || values[GL.CURRENT_FOG_COORDINATE_EXT] };
        for (let i = 0; i < 8; ++i) compat["gl_MultiTexCoord" + i] = attributes["texCoord" + i] || c.state.fixed.units[i].coord;
        const used = new Set(p.attributes.map(a => a.name || a.field));
        if (/\b(?:gl_Vertex|ftransform)\b/.test(p.sources || "") || p.invariant) used.add("gl_Vertex");
        for (const name of used) if (conventional[name] !== undefined) {
            const slot = conventional[name], value = compat[name] || [0, 0, 0, 1];
            slots[slot] = attributes["generic" + slot] || Array.from({ length: 4 }, (_, i) => value[i] ?? (i === 3 ? 1 : 0));
        }
        // Conventional vertex submission also supplies generic attribute zero.
        slots[0] = position.slice();
        return slots.flat().map(Math.fround);
    }
    function captureContext(c, p) {
        const context = { state: { values: GLShadow.clone(c.state.values), raster: { enabled: GLShadow.clone(c.state.raster.enabled) }, fixed: { clip: GLShadow.clone(c.state.fixed.clip) } } };
        if (!p.glsl && !p.invariant) for (let i = 0; i < 6; ++i) context.state.raster.enabled[GL.CLIP_PLANE0 + i] = false;
        return context;
    }
    function rasterCommand(c) {
        return arrays.record(P.GLFN.RESOLVED_RASTER_ALL, [P.encodeRecord("RESOLVED_RASTER_ALL", {
            valid: c.state.values[GL.CURRENT_RASTER_POSITION_VALID][0], position: c.state.values[GL.CURRENT_RASTER_POSITION],
            color: c.state.values[GL.CURRENT_RASTER_COLOR], secondary: c.state.values[GL.CURRENT_RASTER_SECONDARY_COLOR],
            distance: c.state.values[GL.CURRENT_RASTER_DISTANCE][0], fog: c.state.rasterFogCoord, coords: c.state.rasterCoords.flat(),
        })]);
    }
    function captureRaster(s, bytes, view, offset, size, p) {
        const error = s.dispatch(P.GLFN.RASTER_POS4F, bytes, view, offset, size, true); if (error) return { error };
        if (s.nextSelectionJob >= 0xFFFFFFFF) return { error: GL.OUT_OF_MEMORY };
        const c = s.current, job = ++s.nextSelectionJob, attributes = input(c, p, s.args("RASTER_POS4F", view, offset, size));
        const event = { kind: "raster", context: captureContext(c, p), total: 1 };
        s.selectionJobs.set(job, { c, event }); s.blockCPU(job);
        return { commands: [arrays.record(P.GLFN.CAPTURE_RASTER_VERTEX, [P.encodeRecord("CAPTURE_RASTER_VERTEX", { job }), new Uint8Array(new Float32Array(attributes).buffer)])] };
    }
    function capture(s, mode, vertices, p) {
        const c = s.current, q = c.state.selection;
        if (!vertices.length) return [];
        let pending = vertices.length;
        for (const { event } of s.selectionJobs.values()) pending += event.total;
        if (vertices.length > MAX_CAPTURE_VERTICES || pending > MAX_PENDING_VERTICES || s.nextSelectionJob >= 0xFFFFFFFF) return null;
        const job = ++s.nextSelectionJob;
        const context = captureContext(c, p);
        const event = { kind: "capture", job, mode, context, total: vertices.length, received: 0, chunks: [], vertices: [], edges: vertices.map(v => v.edge), ready: false,
            twoSide: !!c.state.raster.enabled[GL.VERTEX_PROGRAM_TWO_SIDE] };
        q.events.push(event); s.selectionJobs.set(job, { c, q, out: q, event });
        const commands = [];
        for (let first = 0; first < vertices.length; first += 256) {
            const count = Math.min(256, vertices.length - first), data = new Float32Array(count * 64);
            for (let i = 0; i < count; ++i) data.set(vertices[first + i].input, i * 64);
            commands.push(arrays.record(P.GLFN.CAPTURE_VERTICES, [P.encodeRecord("CAPTURE_VERTICES", { job, first, count, total: vertices.length }), new Uint8Array(data.buffer)]));
        }
        return commands;
    }
    GLShadow.prototype.completeVertexCapture = function(message) {
        const saved = this.selectionJobs.get(message.job); if (!saved) return;
        const { c, q, out, event } = saved, first = message.first, values = message.values, count = values?.length / 20;
        if (event.kind === "raster") {
            if (this.cpuBarrier?.token !== message.job) { this.selectionJobs.delete(message.job); return; }
            if (!message.error && (!(values instanceof Float32Array) || values.length !== 56 || first !== 0)) return;
            this.selectionJobs.delete(message.job);
            const part = at => Array.from(values.subarray(at, at + 4));
            const vertex = !message.error && { clip: part(0), color: part(4), backColor: part(8), tex: part(12), eye: part(16) },
                valid = vertex && geometry.clip(event.context, [vertex], "point").length > 0;
            state.set(c, GL.CURRENT_RASTER_POSITION_VALID, [+!!valid]);
            if (message.error && !c.error) c.error = GL.INVALID_OPERATION;
            if (valid) {
                const position = geometry.window(event.context, vertex);
                state.set(c, GL.CURRENT_RASTER_POSITION, position); state.set(c, GL.CURRENT_RASTER_COLOR, vertex.color);
                state.set(c, GL.CURRENT_RASTER_SECONDARY_COLOR, part(20)); state.set(c, GL.CURRENT_RASTER_DISTANCE, [values[24]]);
                c.state.rasterFogCoord = values[24]; c.state.rasterCoords = [vertex.tex, ...Array.from({ length: 7 }, (_, i) => part(28 + i * 4))];
                if (c.state.selection.mode === GL.SELECT) hit(c.state.selection, [position[2]]);
            }
            this.resumeCPU(message.job, [rasterCommand(c)]); return;
        }
        if (!message.error && (!(values instanceof Float32Array) || !Number.isInteger(first) || first < 0 || first >= event.total || first % 256 ||
            !Number.isInteger(count) || count <= 0 || count !== Math.min(256, event.total - first) || event.chunks.includes(first))) return;
        if (message.error) { event.error = GL.INVALID_OPERATION; event.ready = true; }
        else {
            for (let i = 0; i < count; ++i) {
                const at = i * 20, part = offset => Array.from(values.subarray(at + offset, at + offset + 4));
                event.vertices[first + i] = { clip: part(0), color: part(4), backColor: part(event.twoSide ? 8 : 4), tex: part(12), eye: part(16), edge: event.edges[first + i] };
            }
            event.chunks.push(first); event.received += count; event.ready = event.received === event.total;
        }
        if (event.ready) { this.selectionJobs.delete(message.job); drain(this, c, q, out); }
    };
    GLShadow.prototype.evaluatedVertex = function(position, attributes) {
        const c = this.current, q = c.state.selection;
        if (!c.state.begin) return [];
        if (q.mode !== GL.RENDER) {
            const primitive = q.primitive; if (!primitive) return [];
            if (primitive.vertices.length >= (primitive.program ? MAX_CAPTURE_VERTICES : 1048576)) { if (!c.error) c.error = GL.OUT_OF_MEMORY; return []; }
            primitive.vertices.push(primitive.program ? { input: input(c, primitive.program, position, attributes), edge: !!c.state.values[GL.EDGE_FLAG][0] } : geometry.vertex(c, position, attributes));
            return [];
        }
        return [arrays.record(P.GLFN.RESOLVED_EVAL_VERTEX, [P.encodeRecord("RESOLVED_EVAL_VERTEX", { position, color: attributes.color, normal: [...attributes.normal, 0], texcoord: attributes.texCoord0 })])];
    };
    const drawNames = new Set(["DRAW_ARRAYS", "DRAW_ELEMENTS", "DRAW_ARRAYS_GL2", "DRAW_ELEMENTS_GL2", "DRAW_ARRAYS_DIRECT", "DRAW_ELEMENTS_DIRECT",
        "DRAW_RANGE_ELEMENTS_DIRECT", "MULTI_DRAW_ARRAYS_DIRECT", "MULTI_DRAW_ELEMENTS_DIRECT"]);
    function draw(s, name, bytes, view, offset, size) {
        const c = s.current, packet = clientArrays.decode(name, bytes, view, offset, size), a = packet.arrays, p = program(s);
        if (packet.mode > GL.POLYGON) return GL.INVALID_ENUM;
        if (packet.count < 0) return GL.INVALID_VALUE;
        if (packet.count > (p ? MAX_CAPTURE_VERTICES : 1048576)) return GL.OUT_OF_MEMORY;
        const indexed = packet.indices, indexBytes = indexed && new Map([[GL.UNSIGNED_BYTE, 1], [GL.UNSIGNED_SHORT, 2], [GL.UNSIGNED_INT, 4]]).get(indexed.type);
        if (indexed && !indexBytes) return GL.INVALID_ENUM;
        if (indexed && indexed.data.length < packet.count * indexBytes) return GL.INVALID_OPERATION;
        const indexView = indexed && new DataView(indexed.data.buffer, indexed.data.byteOffset, indexed.data.length), vertices = [];
        for (let i = 0; i < packet.count; ++i) {
            const index = !indexed ? i : indexBytes === 1 ? indexView.getUint8(i) : indexBytes === 2 ? indexView.getUint16(i * 2, true) : indexView.getUint32(i * 4, true);
            const position = clientArrays.attribute(a.vertex || a.generic0, index, 4); if (!position && !p) return GL.INVALID_OPERATION;
            const attributes = { color: clientArrays.attribute(a.color || a.generic3, index, 4, true), normal: clientArrays.attribute(a.normal || a.generic2, index, 3, true) };
            attributes.secondaryColor = clientArrays.attribute(a.secondaryColor, index, 4, true);
            attributes.fogCoord = clientArrays.attribute(a.fogCoord, index, 1);
            for (let slot = 0; slot < 16; ++slot) attributes["generic" + slot] = clientArrays.attribute(a["generic" + slot], index, 4);
            for (let unit = 0; unit < 8; ++unit) attributes["texCoord" + unit] = clientArrays.attribute(a["texCoord" + unit] || a["generic" + (8 + unit)], index, 4);
            vertices.push(p ? { input: input(c, p, position || c.state.arrays.generic[0].current, attributes), edge: !!c.state.values[GL.EDGE_FLAG][0] } : geometry.vertex(c, position, attributes));
        }
        if (p) return capture(s, packet.mode, vertices, p) || GL.OUT_OF_MEMORY;
        geometry.primitives(c, packet.mode, vertices, primitive => emit(c, primitive)); return 0;
    }
    GLShadow.prototype.queryRenderMode = function(bytes, view, offset, size) {
        const name = "QUERY_RENDER_MODE", f = P.F[name], header = P.RECORDS[name].size;
        if (!this.pending(name, view, offset, size)) return;
        const r = P.decodeRecord(name, view, offset), c = this.current, q = c?.state.selection;
        const fail = value => {
            if (c && !c.error) c.error = value;
            view.setUint32(offset + f.error, value, true); this.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_FAILED);
        };
        if (!c || c.state.begin) return fail(GL.INVALID_OPERATION);
        if (r.operation > 3) return fail(GL.INVALID_ENUM);
        if (r.operation < 2) {
            if (r.size < 0) return fail(GL.INVALID_VALUE);
            if (q.mode === (r.operation === 0 ? GL.SELECT : GL.FEEDBACK)) return fail(GL.INVALID_OPERATION);
            if (r.operation === 1 && !feedbackTypes.has(r.type)) return fail(GL.INVALID_ENUM);
            if (r.operation === 0) { q.selectSize = r.size; q.selectPointer = r.pointer; }
            else { q.feedbackSize = r.size; q.feedbackPointer = r.pointer; q.feedbackType = r.type; }
        } else if (r.operation === 2) {
            if (![GL.RENDER, GL.SELECT, GL.FEEDBACK].includes(r.type)) return fail(GL.INVALID_ENUM);
            if (r.type === GL.SELECT && !q.selectSize || r.type === GL.FEEDBACK && !q.feedbackSize) return fail(GL.INVALID_OPERATION);
            const out = Object.fromEntries(["mode", "selectSize", "selectPointer", "feedbackSize", "feedbackPointer", "feedbackType", "data", "overflow", "hits", "hit", "hitNames", "events", "failure"].map(key => [key, q[key]]));
            out.close = { sequence: ++q.sequence, target: this.deferResponse(view, offset, header, !q.events.length), fields: r };
            for (const job of this.selectionJobs.values()) if (job.out === q) job.out = out;
            q.pending = null; q.mode = r.type; q.data = []; q.events = []; q.overflow = false; q.hits = 0; q.hit = null; q.failure = 0;
            if (r.type === GL.SELECT) q.names = [];
            q.hitNames = q.names.slice();
            q.retired.push(out); drain(this, c, q, out); return;
        } else {
            const saved = q.pending;
            if (!saved || r.ticket !== saved.ticket || (r.size >>> 0) !== c.id || r.offset % 4 || r.data_size % 4 || !r.data_size ||
                r.data_size > CHUNK || r.data_size > size - header || r.offset + r.data_size > saved.data.length * 4) return fail(GL.INVALID_OPERATION);
            for (let i = 0; i < r.data_size; i += 4) {
                const value = saved.data[(r.offset + i) / 4];
                if (saved.mode === GL.SELECT) view.setUint32(offset + header + i, value, true);
                else view.setFloat32(offset + header + i, value, true);
            }
            if (r.offset + r.data_size === saved.data.length * 4) q.pending = null;
        }
        view.setUint32(offset + f.error, 0, true); this.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_OK);
    };
    GLShadow.install({ [P.GLFN.QUERY_RENDER_MODE]: "queryRenderMode" });
    GLShadow.rules({ [P.GLFN.NAME_COMMAND]: (s, b, v, o) => {
        if (s.current.state.begin) return GL.INVALID_OPERATION;
        const r = P.decodeRecord("NAME_COMMAND", v, o), q = s.current.state.selection;
        if (r.operation > 4) return GL.INVALID_ENUM;
        if (q.mode !== GL.SELECT || r.operation === 4) return 0;
        if (r.operation === 1 && !q.names.length) return GL.INVALID_OPERATION;
        if (r.operation === 2 && q.names.length >= maxNames(s)) return GL.STACK_OVERFLOW;
        return r.operation === 3 && !q.names.length ? GL.STACK_UNDERFLOW : 0;
    }, [P.GLFN.RESOLVED_RASTER_STATE]: () => GL.INVALID_OPERATION, [P.GLFN.CAPTURE_VERTICES]: () => GL.INVALID_OPERATION,
    [P.GLFN.CAPTURE_RASTER_VERTEX]: () => GL.INVALID_OPERATION, [P.GLFN.RESOLVED_RASTER_ALL]: () => GL.INVALID_OPERATION });
    state.query([GL.RENDER_MODE], s => [[modeOf(s.current)], "e"]);
    state.query([GL.MAX_NAME_STACK_DEPTH], s => [[maxNames(s)], "i"]);
    state.query([0x0D70], s => [[s.current.state.selection.names.length], "i"]);
    for (const [pname, key, kind] of [[0x0DF4, "selectSize", "i"], [0x0DF1, "feedbackSize", "i"], [0x0DF2, "feedbackType", "e"]])
        state.query([pname], s => [[s.current.state.selection[key]], kind]);
    // ARRAY_POINTER's selection/feedback entries were deliberately left open
    // until their buffer metadata moved together with RenderMode.
    state.parameter(P.C.V86GL_PARAMETER_ARRAY_POINTER, (s, target, pname, index) => {
        if (pname === 0x0DF3 || pname === 0x0DF0) return [[s.current.state.selection[pname === 0x0DF3 ? "selectPointer" : "feedbackPointer"]], "u"];
        return s.arrayPointerParameter?.(target, pname, index) ?? GL.INVALID_ENUM;
    });
    GLShadow.part({
        reset(s) { s.nextSelectionJob = 0; s.selectionJobs = new Map(); },
        cancelCPU(s, barrier) { if (barrier) s.selectionJobs.delete(barrier.token); },
        destroy(s, c) {
            for (const [id, job] of s.selectionJobs) if (job.c === c) s.selectionJobs.delete(id);
            for (const out of c.state.selection.retired) if (out.close?.target.localId) s.responseTargets.delete(out.close.target.localId);
        },
        context(c) { c.state.selection = initial(); },
        routeRecord(s, fn, bytes, view, offset, size) {
            const c = s.current; if (!c) return;
            if (fn === P.GLFN.NAME_COMMAND) return { error: s.dispatch(fn, bytes, view, offset, size) || 0, commands: [] };
            if (fn === P.GLFN.RASTER_POS4F || fn === P.GLFN.WINDOW_POS3F) {
                const p = fn === P.GLFN.RASTER_POS4F && program(s);
                if (p) return captureRaster(s, bytes, view, offset, size, p);
                const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
                return { commands: [rasterCommand(c)] };
            }
            const q = c.state.selection; if (q.mode === GL.RENDER) return;
            const name = P.NAME_BY_OPCODE[fn], vertex = ["VERTEX2F", "VERTEX3F", "VERTEX4F"].includes(name),
                attribZero = name === "VERTEX_ATTRIB4F" && view.getUint32(offset, true) === 0 && c.state.begin;
            if (fn === P.GLFN.BEGIN || fn === P.GLFN.END || vertex || attribZero) {
                const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
                if (fn === P.GLFN.BEGIN) q.primitive = { mode: view.getUint32(offset, true), vertices: [], program: program(s) };
                else if (fn === P.GLFN.END) {
                    const primitive = q.primitive; q.primitive = null;
                    if (primitive?.program) {
                        const commands = capture(s, primitive.mode, primitive.vertices, primitive.program);
                        return commands ? { commands } : { error: GL.OUT_OF_MEMORY };
                    }
                    if (primitive) geometry.primitives(c, primitive.mode, primitive.vertices, p => emit(c, p));
                } else if (q.primitive) {
                    if (q.primitive.vertices.length >= (q.primitive.program ? MAX_CAPTURE_VERTICES : 1048576)) return { error: GL.OUT_OF_MEMORY };
                    const position = s.args(name, view, offset, size).slice(attribZero ? 1 : 0);
                    while (position.length < 4) position.push(position.length === 3 ? 1 : 0);
                    q.primitive.vertices.push(q.primitive.program ? { input: input(c, q.primitive.program, position), edge: !!c.state.values[GL.EDGE_FLAG][0] } : geometry.vertex(c, position));
                }
                return { commands: attribZero ? [arrays.record(fn, [bytes.subarray(offset, offset + size)])] : [] };
            }
            if (drawNames.has(name)) {
                const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
                try {
                    if (name.endsWith("DIRECT")) return { commands: (arrays.capture(s, fn, bytes, view, offset, size) || []).flatMap(record => s.expand(record)) };
                    const result = draw(s, name, bytes, view, offset, size);
                    return Array.isArray(result) ? { commands: result } : { error: result, commands: [] };
                } catch (error) { return { error: GL.INVALID_OPERATION }; }
            }
            if (["BITMAP", "DRAW_PIXELS", "COPY_PIXELS", "CLEAR", "ACCUM", "BLIT_FRAMEBUFFER"].includes(name)) {
                const position = c.state.values[GL.CURRENT_RASTER_POSITION]?.slice(), valid = c.state.values[GL.CURRENT_RASTER_POSITION_VALID]?.[0];
                const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
                if (q.mode === GL.FEEDBACK && valid && ["BITMAP", "DRAW_PIXELS", "COPY_PIXELS"].includes(name))
                    write(q, [GL[name === "BITMAP" ? "BITMAP_TOKEN" : name === "DRAW_PIXELS" ? "DRAW_PIXEL_TOKEN" : "COPY_PIXEL_TOKEN"],
                        ...feedbackVertex(q, position, c.state.values[GL.CURRENT_RASTER_COLOR], c.state.rasterCoords[0])]);
                if (name === "BITMAP") {
                    const r = P.decodeRecord(name, view, offset);
                    return { commands: [arrays.record(fn, [P.encodeRecord("BITMAP", { xmove: r.xmove, ymove: r.ymove })])] };
                }
                return { commands: [] };
            }
        },
        command(s, fn, bytes, view, offset) {
            const c = s.current; if (!c) return;
            const q = c.state.selection;
            if (fn === P.GLFN.NAME_COMMAND) {
                const r = P.decodeRecord("NAME_COMMAND", view, offset);
                if (r.operation === 4) { if (q.mode === GL.FEEDBACK) write(q, [GL.PASS_THROUGH_TOKEN, r.value]); return; }
                if (q.mode !== GL.SELECT) return;
                if (r.operation === 0) q.names = [];
                if (r.operation === 1) q.names[q.names.length - 1] = r.name;
                if (r.operation === 2) q.names.push(r.name);
                if (r.operation === 3) q.names.pop();
                if (q.events.length) q.events.push({ kind: "names", names: q.names.slice() });
                else { flushHit(q); q.hitNames = q.names.slice(); }
            } else if (q.mode === GL.SELECT && [P.GLFN.RASTER_POS4F, P.GLFN.WINDOW_POS3F].includes(fn) && c.state.values[GL.CURRENT_RASTER_POSITION_VALID][0])
                hit(q, [c.state.values[GL.CURRENT_RASTER_POSITION][2]]);
        },
        getState(s, saved) { saved.nextSelectionJob = s.nextSelectionJob; },
        setState(s, saved) {
            s.nextSelectionJob = saved.nextSelectionJob || 0;
            for (const c of s.contexts.values()) {
                if (!c.state.selection) c.state.selection = initial();
                const q = c.state.selection;
                q.events ||= []; q.retired ||= []; q.hitNames ||= q.names.slice(); q.sequence ||= 0;
                for (const out of [q, ...q.retired]) for (const event of out.events) if (event.kind === "capture" && !event.ready)
                    s.selectionJobs.set(event.job, { c, q, out, event });
            }
        },
    });
    const api = { emit, write, modeOf, feedbackVertex, vertexProgram: program };
    global.GLSelection = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
