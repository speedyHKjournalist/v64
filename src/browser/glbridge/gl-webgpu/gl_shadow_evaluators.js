// GL 2.1 section 5.1. Coefficients and grid state belong to the CPU context;
// the page receives evaluated vertices without changes to current attributes.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js"), { GL } = global.GLWGConstants || require("./gl_constants.js"),
        { GLShadow } = global.V86GLShadow || require("./gl_shadow.js"), state = global.V86GLShadowState || require("./gl_shadow_state.js"),
        caps = global.GLCaps || require("./gl_caps.js"), arrays = global.GLListArrays || require("./gl_list_arrays.js"), selection = global.GLSelection || require("./gl_shadow_select.js");
    const dimensions = target => target >= GL.MAP1_COLOR_4 && target <= GL.MAP1_VERTEX_4 ? 1 : target >= GL.MAP2_COLOR_4 && target <= GL.MAP2_VERTEX_4 ? 2 : 0;
    const index = target => target - (dimensions(target) === 2 ? GL.MAP2_COLOR_4 : GL.MAP1_COLOR_4);
    const components = target => [4, 1, 3, 1, 2, 3, 4, 3, 4][index(target)] || 0;
    const enabled = (c, target) => !!c.state.raster.enabled[target];
    const limit = s => (s.capabilities && caps.integer(s.capabilities, GL.MAX_EVAL_ORDER)) ?? caps.LIMITS.MAX_EVAL_ORDER;
    function initial() {
        const maps = {};
        for (const base of [GL.MAP1_COLOR_4, GL.MAP2_COLOR_4]) for (let i = 0; i < 9; ++i) {
            const target = base + i, k = components(target), defaults = i === 0 ? [1, 1, 1, 1] : i === 1 ? [1] : i === 2 ? [0, 0, 1] : [0, 0, 0, 1];
            maps[target] = { uorder: 1, vorder: 1, domain: [0, 1, 0, 1], points: defaults.slice(0, k) };
        }
        return maps;
    }
    // De Casteljau evaluates interpolation and extrapolation without the
    // large alternating binomial terms of a direct Bernstein sum.
    function curve(points, order, k, t) {
        const values = points.slice();
        for (let remaining = order - 1; remaining > 0; --remaining)
            for (let i = 0; i < remaining; ++i) for (let c = 0; c < k; ++c)
                values[i * k + c] = (1 - t) * values[i * k + c] + t * values[(i + 1) * k + c];
        return values.slice(0, k);
    }
    function evaluate(map, k, u, v) {
        const tu = (u - map.domain[0]) / (map.domain[1] - map.domain[0]), tv = (v - map.domain[2]) / (map.domain[3] - map.domain[2]), rows = [];
        for (let i = 0; i < map.uorder; ++i) rows.push(...curve(map.points.slice(i * map.vorder * k, (i + 1) * map.vorder * k), map.vorder, k, tv));
        return curve(rows, map.uorder, k, tu);
    }
    function derivative(map, k, u, v, axis) {
        const order = axis === 0 ? map.uorder : map.vorder;
        if (order < 2) return Array(k).fill(0);
        const result = [], nu = map.uorder - +(axis === 0), nv = map.vorder - +(axis === 1);
        for (let i = 0; i < nu; ++i) for (let j = 0; j < nv; ++j) for (let c = 0; c < k; ++c) {
            const at = (i * map.vorder + j) * k + c, next = at + (axis === 0 ? map.vorder * k : k);
            result.push((order - 1) * (map.points[next] - map.points[at]));
        }
        return evaluate({ ...map, uorder: nu, vorder: nv, points: result }, k, u, v);
    }
    function grid(index, count, first, last) { return index === 0 ? first : index === count ? last : first + index * (last - first) / count; }
    const pad = values => Array.from({ length: 4 }, (_, i) => values[i] ?? (i === 3 ? 1 : 0));
    function coordinate(s, dim, u, v) {
        const c = s.current, base = dim === 1 ? GL.MAP1_COLOR_4 : GL.MAP2_COLOR_4, maps = c.state.evaluators;
        const highest = indices => indices.find(i => enabled(c, base + i)), vertex = highest([8, 7]);
        if (vertex === undefined || !c.state.begin) return [];
        const position = pad(evaluate(maps[base + vertex], components(base + vertex), u, v)), attributes = {
            color: c.state.values[GL.CURRENT_COLOR].slice(), normal: c.state.values[GL.CURRENT_NORMAL].slice(), texCoord0: c.state.fixed.units[0].coord.slice(),
        };
        if (enabled(c, base)) attributes.color = evaluate(maps[base], 4, u, v);
        const tex = highest([6, 5, 4, 3]);
        if (tex !== undefined) attributes.texCoord0 = pad(evaluate(maps[base + tex], components(base + tex), u, v));
        if (dim === 2 && enabled(c, GL.AUTO_NORMAL)) {
            const map = maps[base + vertex], k = components(base + vertex), du = derivative(map, k, u, v, 0), dv = derivative(map, k, u, v, 1);
            const tangent = d => d.slice(0, 3).map((n, i) => k === 4 ? (n * position[3] - d[3] * position[i]) / (position[3] * position[3]) : n), a = tangent(du), b = tangent(dv);
            let n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
            if (!selection.vertexProgram(s)) { const length = Math.hypot(...n); if (length) n = n.map(v => v / length); }
            attributes.normal = n;
        } else if (enabled(c, base + 2)) attributes.normal = evaluate(maps[base + 2], 3, u, v);
        return s.evaluatedVertex(position, attributes);
    }
    state.define("MAP1_GRID_DOMAIN", [0, 1], "f", 0x10000);
    state.define("MAP2_GRID_DOMAIN", [0, 1, 0, 1], "f", 0x10000);
    state.define("MAP1_GRID_SEGMENTS", [1], "i", 0x10000);
    state.define("MAP2_GRID_SEGMENTS", [1, 1], "i", 0x10000);
    state.query([GL.MAX_EVAL_ORDER], s => [[limit(s)], "i"]);
    GLShadow.rules({
        [P.GLFN.MAP_EVALUATOR]: (s, bytes, view, offset, size) => {
            const r = P.decodeRecord("MAP_EVALUATOR", view, offset), dim = dimensions(r.target), k = components(r.target);
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            if (!dim || dim !== r.dimensions) return GL.INVALID_ENUM;
            if (s.current.activeTexture) return GL.INVALID_OPERATION;
            if (r.uorder < 1 || r.uorder > limit(s) || dim === 2 && (r.vorder < 1 || r.vorder > limit(s)) || r.ustride < k || dim === 2 && r.vstride < k ||
                r.domain[0] === r.domain[1] || dim === 2 && r.domain[2] === r.domain[3]) return GL.INVALID_VALUE;
            const count = r.uorder * (dim === 2 ? r.vorder : 1) * k;
            return r.data_size !== count * 8 || r.data_size > size - P.RECORDS.MAP_EVALUATOR.size ? GL.INVALID_VALUE : 0;
        },
        [P.GLFN.EVALUATOR_GRID]: (s, bytes, view, offset) => {
            const r = P.decodeRecord("EVALUATOR_GRID", view, offset);
            return s.current.state.begin ? GL.INVALID_OPERATION : ![1, 2].includes(r.dimensions) ? GL.INVALID_ENUM : r.un < 1 || r.dimensions === 2 && r.vn < 1 ? GL.INVALID_VALUE : 0;
        },
        [P.GLFN.EVAL_COORD]: (s, bytes, view, offset) => {
            const r = P.decodeRecord("EVAL_COORD", view, offset);
            return ![1, 2].includes(r.dimensions) || r.operation > 1 ? GL.INVALID_ENUM : r.operation && r.values.some((n, i) => i < r.dimensions && (!Number.isInteger(n) || n < -2147483648 || n > 2147483647)) ? GL.INVALID_VALUE : 0;
        },
        [P.GLFN.EVAL_MESH]: (s, bytes, view, offset) => {
            const r = P.decodeRecord("EVAL_MESH", view, offset);
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            if (![1, 2].includes(r.dimensions) || ![GL.POINT, GL.LINE, ...(r.dimensions === 2 ? [GL.FILL] : [])].includes(r.mode)) return GL.INVALID_ENUM;
            const base = r.dimensions === 1 ? GL.MAP1_COLOR_4 : GL.MAP2_COLOR_4;
            if (!enabled(s.current, base + 7) && !enabled(s.current, base + 8)) return 0;
            const nu = Math.max(0, r.indices[1] - r.indices[0] + 1), nv = r.dimensions === 2 ? Math.max(0, r.indices[3] - r.indices[2] + 1) : 1;
            return nu * nv * (r.dimensions === 2 && r.mode !== GL.POINT ? 2 : 1) > 65536 ? GL.OUT_OF_MEMORY : 0;
        },
        [P.GLFN.RESOLVED_EVAL_VERTEX]: () => GL.INVALID_OPERATION,
    });
    GLShadow.prototype.queryEvaluator = function(bytes, view, offset, size) {
        const name = "QUERY_EVALUATOR", f = P.F[name]; if (!this.pending(name, view, offset, size)) return;
        const r = P.decodeRecord(name, view, offset), c = this.current, dim = dimensions(r.target);
        const fail = error => { if (c && !c.error) c.error = error; view.setUint32(offset + f.error, error, true); this.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_FAILED); };
        if (!c || c.state.begin) return fail(GL.INVALID_OPERATION);
        if (!dim || ![GL.COEFF, GL.ORDER, GL.DOMAIN].includes(r.pname)) return fail(GL.INVALID_ENUM);
        if (![P.C.V86GL_STATE_INTEGER, P.C.V86GL_STATE_FLOAT, P.C.V86GL_STATE_DOUBLE].includes(r.value_kind)) return fail(GL.INVALID_ENUM);
        const map = c.state.evaluators[r.target], data = r.pname === GL.COEFF ? map.points : r.pname === GL.ORDER ? [map.uorder, ...(dim === 2 ? [map.vorder] : [])] : map.domain.slice(0, dim * 2), header = P.RECORDS[name].size;
        if (r.data_size < data.length * 8 || r.data_size > 2048 || r.data_size % 8 || header + r.data_size > size) return fail(GL.INVALID_VALUE);
        for (let i = 0; i < data.length; ++i) {
            let value = data[i];
            if (r.value_kind === P.C.V86GL_STATE_FLOAT) value = Math.fround(value);
            else if (r.value_kind === P.C.V86GL_STATE_INTEGER) value = Math.max(-2147483648, Math.min(2147483647, value < 0 ? -Math.round(-value) : Math.round(value)));
            view.setFloat64(offset + header + i * 8, value, true);
        }
        view.setUint32(offset + f.count, data.length, true); view.setUint32(offset + f.error, 0, true); this.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_OK);
    };
    GLShadow.install({ [P.GLFN.QUERY_EVALUATOR]: "queryEvaluator" });
    function evalPoint(s, dim, u, v) {
        const values = s.current.state.values, domain = values[dim === 1 ? GL.MAP1_GRID_DOMAIN : GL.MAP2_GRID_DOMAIN], counts = values[dim === 1 ? GL.MAP1_GRID_SEGMENTS : GL.MAP2_GRID_SEGMENTS];
        return coordinate(s, dim, grid(u, counts[0], domain[0], domain[1]), dim === 1 ? 0 : grid(v, counts[1], domain[2], domain[3]));
    }
    function mesh(s, r) {
        const commands = [], [u1, u2, v1, v2] = r.indices;
        if (u2 < u1 || r.dimensions === 2 && v2 < v1) return commands;
        const base = r.dimensions === 1 ? GL.MAP1_COLOR_4 : GL.MAP2_COLOR_4;
        if (!enabled(s.current, base + 7) && !enabled(s.current, base + 8)) return commands;
        const primitive = (mode, emit) => {
            commands.push(...s.expand(arrays.record(P.GLFN.BEGIN, [P.encodeArgs("BEGIN", [mode])])));
            if (!s.current.state.begin) return;
            emit(); commands.push(...s.expand(arrays.record(P.GLFN.END, [])));
        };
        const point = (u, v) => commands.push(...evalPoint(s, r.dimensions, u, v));
        if (r.dimensions === 1) primitive(r.mode === GL.POINT ? GL.POINTS : GL.LINE_STRIP, () => { for (let u = u1; u <= u2; ++u) point(u, 0); });
        else if (r.mode === GL.POINT) primitive(GL.POINTS, () => { for (let v = v1; v <= v2; ++v) for (let u = u1; u <= u2; ++u) point(u, v); });
        else if (r.mode === GL.LINE) {
            for (let v = v1; v <= v2; ++v) primitive(GL.LINE_STRIP, () => { for (let u = u1; u <= u2; ++u) point(u, v); });
            for (let u = u1; u <= u2; ++u) primitive(GL.LINE_STRIP, () => { for (let v = v1; v <= v2; ++v) point(u, v); });
        } else for (let v = v1; v < v2; ++v) primitive(GL.QUAD_STRIP, () => { for (let u = u1; u <= u2; ++u) { point(u, v); point(u, v + 1); } });
        return commands;
    }
    GLShadow.part({
        context(c) { c.state.evaluators = initial(); },
        setState(s) { for (const c of s.contexts.values()) if (!c.state.evaluators) c.state.evaluators = initial(); },
        routeRecord(s, fn, bytes, view, offset, size) {
            if (!s.current || ![P.GLFN.MAP_EVALUATOR, P.GLFN.EVALUATOR_GRID, P.GLFN.EVAL_COORD, P.GLFN.EVAL_MESH].includes(fn)) return;
            const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
            const r = P.decodeRecord(P.NAME_BY_OPCODE[fn], view, offset), c = s.current;
            if (fn === P.GLFN.MAP_EVALUATOR) {
                const at = offset + P.RECORDS.MAP_EVALUATOR.size;
                c.state.evaluators[r.target] = { uorder: r.uorder, vorder: r.dimensions === 2 ? r.vorder : 1, domain: r.dimensions === 2 ? r.domain : [...r.domain.slice(0, 2), 0, 1],
                    points: Array.from({ length: r.data_size / 8 }, (_, i) => view.getFloat64(at + i * 8, true)) };
            } else if (fn === P.GLFN.EVALUATOR_GRID) {
                state.set(c, r.dimensions === 1 ? GL.MAP1_GRID_DOMAIN : GL.MAP2_GRID_DOMAIN, r.domain.slice(0, r.dimensions * 2));
                state.set(c, r.dimensions === 1 ? GL.MAP1_GRID_SEGMENTS : GL.MAP2_GRID_SEGMENTS, r.dimensions === 1 ? [r.un] : [r.un, r.vn]);
            } else if (fn === P.GLFN.EVAL_COORD) return { commands: r.operation ? evalPoint(s, r.dimensions, ...r.values) : coordinate(s, r.dimensions, ...r.values) };
            else return { commands: mesh(s, r) };
            return { commands: [] };
        },
    });
    const api = { dimensions, components, curve, evaluate, derivative, grid };
    global.GLEvaluators = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
