// CPU geometry for GL_SELECT/GL_FEEDBACK. Clipping happens in homogeneous
// coordinates, before division and viewport/depth-range conversion.
(function(global) {
    "use strict";
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const fixed = global.GLFixedVertex || require("./gl_shadow_rasterpos.js");
    const enabled = (c, cap) => !!c.state.raster.enabled[cap];
    const value = (c, pname) => c.state.values[pname];
    const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
    const clamp = n => Math.max(0, Math.min(1, n));
    function vertex(c, position, attributes) {
        let context = c;
        if (attributes) {
            const values = { ...c.state.values };
            for (const [pname, field] of [[GL.CURRENT_COLOR, "color"], [GL.CURRENT_NORMAL, "normal"]])
                if (attributes[field]) values[pname] = attributes[field];
            const units = c.state.fixed.units.map((u, i) => attributes["texCoord" + i] ? { ...u, coord: attributes["texCoord" + i] } : u);
            let materials = c.state.fixed.materials;
            if (attributes.color && enabled(c, GL.COLOR_MATERIAL)) {
                const face = value(c, GL.COLOR_MATERIAL_FACE)[0], parameter = value(c, GL.COLOR_MATERIAL_PARAMETER)[0];
                materials = materials.map((material, side) => face === GL.FRONT && side === 1 || face === GL.BACK && side === 0 ? material :
                    { ...material, ...Object.fromEntries((parameter === GL.AMBIENT_AND_DIFFUSE ? [GL.AMBIENT, GL.DIFFUSE] : [parameter]).map(p => [p, attributes.color.slice()])) });
            }
            context = { ...c, state: { ...c.state, values, fixed: { ...c.state.fixed, units, materials } } };
        }
        const eye = fixed.transform(context.state.stacks[GL.MODELVIEW].at(-1), position), clip = fixed.transform(context.state.stacks[GL.PROJECTION].at(-1), eye);
        const n = fixed.normal(context), lit = enabled(context, GL.LIGHTING);
        const color = lit ? fixed.lighting(context, eye, n)[0] : value(context, GL.CURRENT_COLOR).map(clamp);
        const backColor = lit && value(context, GL.LIGHT_MODEL_TWO_SIDE)[0] ? fixed.lighting(context, eye, n.map(v => -v), 1)[0] : color.slice();
        return { eye, clip, color, backColor, tex: fixed.coordinates(context, position, eye, n)[0], edge: attributes?.edgeFlag ?? !!value(context, GL.EDGE_FLAG)[0] };
    }
    function distances(c, v) {
        const p = v.clip, out = [p[3] + p[0], p[3] - p[0], p[3] + p[1], p[3] - p[1], p[3] + p[2], p[3] - p[2]];
        for (let i = 0; i < c.state.fixed.clip.length; ++i)
            if (enabled(c, GL.CLIP_PLANE0 + i)) out.push(dot(c.state.fixed.clip[i], v.eye));
        return out;
    }
    function mix(a, b, t) {
        return { ...Object.fromEntries(["eye", "clip", "color", "backColor", "tex"].map(key => [key, a[key].map((n, i) => n + (b[key][i] - n) * t)])), edge: a.edge };
    }
    function clip(c, vertices, kind) {
        if (kind === "point") return distances(c, vertices[0]).every(n => n >= 0) && vertices[0].clip[3] > 0 ? vertices : [];
        if (kind === "line") {
            const da = distances(c, vertices[0]), db = distances(c, vertices[1]); let lo = 0, hi = 1;
            for (let i = 0; i < da.length; ++i) {
                if (da[i] < 0 && db[i] < 0) return [];
                if (da[i] < 0) lo = Math.max(lo, da[i] / (da[i] - db[i]));
                if (db[i] < 0) hi = Math.min(hi, da[i] / (da[i] - db[i]));
                if (lo > hi) return [];
            }
            return [mix(vertices[0], vertices[1], lo), mix(vertices[0], vertices[1], hi)].filter(v => v.clip[3] > 0);
        }
        let polygon = vertices;
        for (let plane = 0, count = distances(c, vertices[0]).length; plane < count && polygon.length; ++plane) {
            const next = []; let previous = polygon.at(-1), before = distances(c, previous)[plane];
            for (const current of polygon) {
                const after = distances(c, current)[plane];
                if ((before < 0) !== (after < 0)) {
                    const crossing = mix(previous, current, before / (before - after));
                    if (before >= 0) crossing.edge = true;
                    next.push(crossing);
                }
                if (after >= 0) next.push(current);
                previous = current; before = after;
            }
            polygon = next;
        }
        return polygon.filter(v => v.clip[3] > 0);
    }
    function window(c, v) {
        const p = v.clip, viewport = value(c, GL.VIEWPORT), depth = value(c, GL.DEPTH_RANGE);
        return [viewport[0] + (p[0] / p[3] + 1) * viewport[2] / 2, viewport[1] + (p[1] / p[3] + 1) * viewport[3] / 2,
            depth[0] + (p[2] / p[3] + 1) * (depth[1] - depth[0]) / 2, p[3]].map(Math.fround);
    }
    function front(c, vertices) {
        let area = 0;
        for (let i = 0; i < vertices.length; ++i) {
            const a = vertices[i].clip, b = vertices[(i + 1) % vertices.length].clip;
            area += a[0] / a[3] * b[1] / b[3] - b[0] / b[3] * a[1] / a[3];
        }
        return value(c, GL.FRONT_FACE)[0] === GL.CCW ? area >= 0 : area <= 0;
    }
    function primitives(c, mode, input, emit) {
        function primitive(kind, vertices, reset = false) {
            if (value(c, GL.SHADE_MODEL)[0] === GL.FLAT && vertices.length > 1) {
                const provoking = mode === GL.POLYGON ? vertices[0] : vertices.at(-1);
                vertices = vertices.map(v => ({ ...v, color: provoking.color, backColor: provoking.backColor }));
            }
            const clipped = clip(c, vertices, kind);
            if (clipped.length < (kind === "polygon" ? 3 : kind === "line" ? 2 : 1)) return;
            const facing = kind !== "polygon" || front(c, clipped);
            if (kind === "polygon" && enabled(c, GL.CULL_FACE)) {
                const face = value(c, GL.CULL_FACE_MODE)[0];
                if (face === GL.FRONT_AND_BACK || (face === GL.FRONT) === facing) return;
            }
            emit({ kind, vertices: clipped, front: facing, reset });
        }
        const v = input, n = v.length;
        if (mode === GL.POINTS) for (const p of v) primitive("point", [p]);
        else if (mode === GL.LINES) for (let i = 0; i + 1 < n; i += 2) primitive("line", v.slice(i, i + 2), true);
        else if (mode === GL.LINE_STRIP || mode === GL.LINE_LOOP) {
            for (let i = 1; i < n; ++i) primitive("line", [v[i - 1], v[i]], i === 1);
            if (mode === GL.LINE_LOOP && n >= 2) primitive("line", [v[n - 1], v[0]], false);
        } else if (mode === GL.TRIANGLES) for (let i = 0; i + 2 < n; i += 3) primitive("polygon", v.slice(i, i + 3));
        else if (mode === GL.TRIANGLE_STRIP) for (let i = 2; i < n; ++i) primitive("polygon", i & 1 ? [v[i - 1], v[i - 2], v[i]] : v.slice(i - 2, i + 1));
        else if (mode === GL.TRIANGLE_FAN) for (let i = 2; i < n; ++i) primitive("polygon", [v[0], v[i - 1], v[i]]);
        else if (mode === GL.QUADS) for (let i = 0; i + 3 < n; i += 4) primitive("polygon", v.slice(i, i + 4));
        else if (mode === GL.QUAD_STRIP) for (let i = 2; i + 1 < n; i += 2) primitive("polygon", [v[i - 2], v[i - 1], v[i + 1], v[i]]);
        else if (mode === GL.POLYGON && n >= 3) primitive("polygon", v);
    }
    const api = { vertex, clip, window, primitives };
    global.GLSelectGeometry = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
