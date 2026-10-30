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
    const maxNames = s => s.capabilities ? caps.integer(s.capabilities, GL.MAX_NAME_STACK_DEPTH) ?? caps.LIMITS.MAX_NAME_STACK_DEPTH : caps.LIMITS.MAX_NAME_STACK_DEPTH;
    const feedbackTypes = new Set([GL["2D"], GL["3D"], GL["3D_COLOR"], GL["3D_COLOR_TEXTURE"], GL["4D_COLOR_TEXTURE"]]);
    const initial = () => ({ mode: GL.RENDER, selectSize: 0, selectPointer: 0, feedbackSize: 0, feedbackPointer: 0, feedbackType: GL["2D"],
        names: [], data: [], overflow: false, hits: 0, hit: null, primitive: null, pending: null, nextTicket: 0 });
    const modeOf = c => c.state.selection?.mode ?? GL.RENDER;
    function write(q, values) {
        const capacity = q.mode === GL.SELECT ? q.selectSize : q.feedbackSize;
        for (const value of values) if (q.data.length < capacity) q.data.push(value); else q.overflow = true;
    }
    function flushHit(q) {
        if (!q.hit) return;
        write(q, [q.names.length, Math.round(q.hit[0] * 0xFFFFFFFF), Math.round(q.hit[1] * 0xFFFFFFFF), ...q.names]);
        ++q.hits; q.hit = null;
    }
    function hit(q, depths) {
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
    function emit(c, primitive) {
        const q = c.state.selection, vertices = primitive.vertices, points = vertices.map(v => geometry.window(c, v));
        if (q.mode === GL.SELECT) return hit(q, points.map(p => p[2]));
        const vertex = i => feedbackVertex(q, points[i], primitive.front ? vertices[i].color : vertices[i].backColor, vertices[i].tex);
        if (primitive.kind === "point") return write(q, [GL.POINT_TOKEN, ...vertex(0)]);
        if (primitive.kind === "line") return write(q, [primitive.reset ? GL.LINE_RESET_TOKEN : GL.LINE_TOKEN, ...vertex(0), ...vertex(1)]);
        const polygonMode = c.state.values[GL.POLYGON_MODE][primitive.front ? 0 : 1];
        // Rotating a polygon preserves its winding. Start with its provoking
        // end vertex, matching the legacy native feedback packet ordering.
        const order = [vertices.length - 1, ...Array.from({ length: vertices.length - 1 }, (_, i) => i)];
        if (polygonMode === GL.POINT) for (const i of order) { if (vertices[i].edge) write(q, [GL.POINT_TOKEN, ...vertex(i)]); }
        else if (polygonMode === GL.LINE) {
            let first = true;
            for (let i = 0; i < order.length; ++i) if (vertices[order[i]].edge) {
                write(q, [first ? GL.LINE_RESET_TOKEN : GL.LINE_TOKEN, ...vertex(order[i]), ...vertex(order[(i + 1) % order.length])]); first = false;
            }
        }
        else write(q, [GL.POLYGON_TOKEN, vertices.length, ...order.flatMap(vertex)]);
    }
    const drawNames = new Set(["DRAW_ARRAYS", "DRAW_ELEMENTS", "DRAW_ARRAYS_GL2", "DRAW_ELEMENTS_GL2", "DRAW_ARRAYS_DIRECT", "DRAW_ELEMENTS_DIRECT",
        "DRAW_RANGE_ELEMENTS_DIRECT", "MULTI_DRAW_ARRAYS_DIRECT", "MULTI_DRAW_ELEMENTS_DIRECT"]);
    function draw(s, name, bytes, view, offset, size) {
        const c = s.current, packet = clientArrays.decode(name, bytes, view, offset, size), a = packet.arrays;
        if (packet.mode > GL.POLYGON) return GL.INVALID_ENUM;
        if (packet.count < 0) return GL.INVALID_VALUE;
        if (packet.count > 1048576) return GL.OUT_OF_MEMORY;
        const indexed = packet.indices, indexBytes = indexed && new Map([[GL.UNSIGNED_BYTE, 1], [GL.UNSIGNED_SHORT, 2], [GL.UNSIGNED_INT, 4]]).get(indexed.type);
        if (indexed && !indexBytes) return GL.INVALID_ENUM;
        if (indexed && indexed.data.length < packet.count * indexBytes) return GL.INVALID_OPERATION;
        const indexView = indexed && new DataView(indexed.data.buffer, indexed.data.byteOffset, indexed.data.length), vertices = [];
        for (let i = 0; i < packet.count; ++i) {
            const index = !indexed ? i : indexBytes === 1 ? indexView.getUint8(i) : indexBytes === 2 ? indexView.getUint16(i * 2, true) : indexView.getUint32(i * 4, true);
            const position = clientArrays.attribute(a.vertex || a.generic0, index, 4); if (!position) return GL.INVALID_OPERATION;
            const attributes = { color: clientArrays.attribute(a.color || a.generic3, index, 4, true), normal: clientArrays.attribute(a.normal || a.generic2, index, 3, true) };
            for (let unit = 0; unit < 8; ++unit) attributes["texCoord" + unit] = clientArrays.attribute(a["texCoord" + unit] || a["generic" + (8 + unit)], index, 4);
            vertices.push(geometry.vertex(c, position, attributes));
        }
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
            const old = q.mode;
            if (old === GL.SELECT) flushHit(q);
            const result = q.overflow ? -1 : old === GL.SELECT ? q.hits : old === GL.FEEDBACK ? q.data.length : 0;
            const ticket = q.data.length ? q.nextTicket = q.nextTicket % 0xFFFFFFFF + 1 : 0;
            q.pending = ticket ? { ticket, data: q.data, mode: old } : null;
            for (const [key, value] of Object.entries({ result, ticket, total: q.data.length * 4, size: c.id,
                pointer: old === GL.SELECT ? q.selectPointer : old === GL.FEEDBACK ? q.feedbackPointer : 0, type: old }))
                view.setUint32(offset + f[key], value, true);
            q.mode = r.type; q.data = []; q.overflow = false; q.hits = 0; q.hit = null;
            if (r.type === GL.SELECT) q.names = [];
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
    }, [P.GLFN.RESOLVED_RASTER_STATE]: () => GL.INVALID_OPERATION });
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
        context(c) { c.state.selection = initial(); },
        routeRecord(s, fn, bytes, view, offset, size) {
            const c = s.current; if (!c) return;
            if (fn === P.GLFN.NAME_COMMAND) return { error: s.dispatch(fn, bytes, view, offset, size) || 0, commands: [] };
            const q = c.state.selection; if (q.mode === GL.RENDER) return;
            const name = P.NAME_BY_OPCODE[fn], vertex = ["VERTEX2F", "VERTEX3F", "VERTEX4F"].includes(name),
                attribZero = name === "VERTEX_ATTRIB4F" && view.getUint32(offset, true) === 0 && c.state.begin;
            if (fn === P.GLFN.RASTER_POS4F || fn === P.GLFN.WINDOW_POS3F) {
                const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
                return { commands: [arrays.record(P.GLFN.RESOLVED_RASTER_STATE, [P.encodeRecord("RESOLVED_RASTER_STATE", {
                    valid: c.state.values[GL.CURRENT_RASTER_POSITION_VALID][0], position: c.state.values[GL.CURRENT_RASTER_POSITION], color: c.state.values[GL.CURRENT_RASTER_COLOR],
                })])] };
            }
            if (fn === P.GLFN.BEGIN || fn === P.GLFN.END || vertex || attribZero) {
                const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
                if (fn === P.GLFN.BEGIN) q.primitive = { mode: view.getUint32(offset, true), vertices: [] };
                else if (fn === P.GLFN.END) {
                    const primitive = q.primitive; q.primitive = null;
                    if (primitive) geometry.primitives(c, primitive.mode, primitive.vertices, p => emit(c, p));
                } else if (q.primitive) {
                    if (q.primitive.vertices.length >= 1048576) return { error: GL.OUT_OF_MEMORY };
                    const position = s.args(name, view, offset, size).slice(attribZero ? 1 : 0);
                    while (position.length < 4) position.push(position.length === 3 ? 1 : 0);
                    q.primitive.vertices.push(geometry.vertex(c, position));
                }
                return { commands: attribZero ? [arrays.record(fn, [bytes.subarray(offset, offset + size)])] : [] };
            }
            if (drawNames.has(name)) {
                const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
                try {
                    if (name.endsWith("DIRECT")) return { commands: (arrays.capture(s, fn, bytes, view, offset, size) || []).flatMap(record => s.expand(record)) };
                    return { error: draw(s, name, bytes, view, offset, size), commands: [] };
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
                flushHit(q);
                if (r.operation === 0) q.names = [];
                if (r.operation === 1) q.names[q.names.length - 1] = r.name;
                if (r.operation === 2) q.names.push(r.name);
                if (r.operation === 3) q.names.pop();
            } else if (q.mode === GL.SELECT && [P.GLFN.RASTER_POS4F, P.GLFN.WINDOW_POS3F].includes(fn) && c.state.values[GL.CURRENT_RASTER_POSITION_VALID][0])
                hit(q, [c.state.values[GL.CURRENT_RASTER_POSITION][2]]);
        },
        setState(s) { for (const c of s.contexts.values()) if (!c.state.selection) c.state.selection = initial(); },
    });
    const api = { emit, write, modeOf, feedbackVertex };
    global.GLSelection = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
