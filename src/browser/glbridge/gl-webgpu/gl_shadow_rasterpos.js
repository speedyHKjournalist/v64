// Current raster state, including fixed-function lighting/texgen at set
// time. WindowPos follows ARB_window_pos, whose bypass rules differ from
// RasterPos (the gl2.1 WindowPos refpage incorrectly describes lighting).
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const math = global.GLMath || require("./gl_math.js");
    if (typeof module !== "undefined" && module.exports) {
        require("./gl_shadow_objects.js"); require("./gl_shadow_raster.js"); require("./gl_shadow_fixed.js"); require("./gl_shadow_misc.js");
    }
    const clone = v => JSON.parse(JSON.stringify(v));
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const unit = a => { const n = Math.hypot(...a); return n ? a.map(v => v / n) : a.map(() => 0); };
    const clamp = v => Math.max(0, Math.min(1, v));
    const float = values => values.map(Math.fround);
    const transform = (m, p) => Array.from(math.transformPoint4(m, p, new Float64Array(4)));
    const top = (c, mode) => c.state.stacks[mode].at(-1);
    const enabled = (c, cap) => !!c.state.raster.enabled[cap];
    const value = (c, p) => c.state.values[p];
    state.define("CURRENT_RASTER_POSITION", [0, 0, 0, 1], "f", 1);
    state.define("CURRENT_RASTER_POSITION_VALID", [1], "b", 1);
    state.define("CURRENT_RASTER_DISTANCE", [0], "f", 1);
    state.define("CURRENT_RASTER_COLOR", [1, 1, 1, 1], "n", 1);
    state.define("CURRENT_RASTER_SECONDARY_COLOR", [0, 0, 0, 1], "n", 1);
    state.define("CURRENT_RASTER_INDEX", [1], "f", 1); // the drawable is RGBA
    state.query([GL.CURRENT_RASTER_TEXTURE_COORDS], s => [s.current.state.rasterCoords[s.current.activeTexture || 0], "f"]);
    function normal(c) {
        const m = math.normalMatrixOf(top(c, GL.MODELVIEW), new Float64Array(9)), n = value(c, GL.CURRENT_NORMAL);
        let out = [0, 1, 2].map(i => m[i] * n[0] + m[3 + i] * n[1] + m[6 + i] * n[2]);
        if (enabled(c, GL.NORMALIZE)) out = unit(out);
        else if (enabled(c, GL.RESCALE_NORMAL)) {
            const len = Math.hypot(m[6], m[7], m[8]); if (len) out = out.map(v => v / len);
        }
        return out;
    }
    function lighting(c, eye, n) {
        const m = c.state.fixed.materials[0], model = value(c, GL.LIGHT_MODEL_AMBIENT);
        const color = [0, 1, 2].map(i => m[GL.EMISSION][i] + m[GL.AMBIENT][i] * model[i]);
        const specular = [0, 0, 0];
        const position = eye.slice(0, 3).map(v => eye[3] ? v / eye[3] : v);
        const viewer = value(c, GL.LIGHT_MODEL_LOCAL_VIEWER)[0] ? unit(position.map(v => -v)) : [0, 0, 1];
        c.state.fixed.lights.forEach((light, index) => {
            if (!enabled(c, GL.LIGHT0 + index)) return;
            const p = light[GL.POSITION], delta = p.slice(0, 3).map((v, i) => p[3] ? v / p[3] - position[i] : v);
            const distance = Math.hypot(...delta), l = unit(delta);
            let attenuation = p[3] ? 1 / (light[GL.CONSTANT_ATTENUATION][0] + light[GL.LINEAR_ATTENUATION][0] * distance +
                light[GL.QUADRATIC_ATTENUATION][0] * distance * distance) : 1;
            if (light[GL.SPOT_CUTOFF][0] !== 180) {
                const cosine = dot(l.map(v => -v), unit(light[GL.SPOT_DIRECTION]));
                attenuation *= cosine < Math.cos(light[GL.SPOT_CUTOFF][0] * Math.PI / 180) ? 0 : Math.pow(Math.max(0, cosine), light[GL.SPOT_EXPONENT][0]);
            }
            const diffuse = Math.max(0, dot(n, l)), half = unit(l.map((v, i) => v + viewer[i]));
            const spec = diffuse > 0 ? Math.pow(Math.max(0, dot(n, half)), m[GL.SHININESS][0]) : 0;
            for (let i = 0; i < 3; ++i) {
                color[i] += attenuation * (m[GL.AMBIENT][i] * light[GL.AMBIENT][i] + diffuse * m[GL.DIFFUSE][i] * light[GL.DIFFUSE][i]);
                specular[i] += attenuation * spec * m[GL.SPECULAR][i] * light[GL.SPECULAR][i];
            }
        });
        const separate = value(c, GL.LIGHT_MODEL_COLOR_CONTROL)[0] === GL.SEPARATE_SPECULAR_COLOR;
        return [float([...color.map((v, i) => clamp(v + (separate ? 0 : specular[i]))), clamp(m[GL.DIFFUSE][3])]),
            float([...(separate ? specular.map(clamp) : [0, 0, 0]), 1])];
    }
    function coordinates(c, object, eye, n) {
        const eyeUnit = unit(eye.slice(0, 3)), normalUnit = unit(n);
        const reflect = eyeUnit.map((v, i) => v - 2 * normalUnit[i] * dot(normalUnit, eyeUnit));
        const divisor = 2 * Math.hypot(reflect[0], reflect[1], reflect[2] + 1);
        return c.state.fixed.units.map((u, index) => {
            const coord = u.coord.slice();
            for (let i = 0; i < 4; ++i) {
                if (!c.state.raster.units[index][GL.TEXTURE_GEN_S + i]) continue;
                const gen = u.gen[i], mode = gen[GL.TEXTURE_GEN_MODE][0];
                if (mode === GL.OBJECT_LINEAR) coord[i] = dot(object, gen[GL.OBJECT_PLANE]);
                else if (mode === GL.EYE_LINEAR) coord[i] = dot(eye, gen[GL.EYE_PLANE]);
                else if (mode === GL.NORMAL_MAP) coord[i] = normalUnit[i];
                else if (mode === GL.REFLECTION_MAP) coord[i] = reflect[i];
                else if (mode === GL.SPHERE_MAP) coord[i] = (divisor ? reflect[i] / divisor : 0) + 0.5;
            }
            return float(transform(c.state.texture[index].at(-1), coord));
        });
    }
    function set(c, p, values) { state.set(c, p, values); }
    state.rule("RASTER_POS4F", (c, a, shadow) => shadow.framebufferStatus(GL.DRAW_FRAMEBUFFER) === GL.FRAMEBUFFER_COMPLETE ? 0 : GL.INVALID_FRAMEBUFFER_OPERATION);
    state.on("RASTER_POS4F", (c, object) => {
        const eye = transform(top(c, GL.MODELVIEW), object), clip = transform(top(c, GL.PROJECTION), eye), w = clip[3];
        let valid = w > 0 && Math.abs(clip[0]) <= w && Math.abs(clip[1]) <= w &&
            (enabled(c, GL.DEPTH_CLAMP) || Math.abs(clip[2]) <= w);
        for (let i = 0; valid && i < c.state.fixed.clip.length; ++i)
            if (enabled(c, GL.CLIP_PLANE0 + i) && dot(c.state.fixed.clip[i], eye) < 0) valid = false;
        set(c, GL.CURRENT_RASTER_POSITION_VALID, [+valid]);
        if (!valid) return; // associated values are undefined; keep stable bits
        const viewport = value(c, GL.VIEWPORT), depth = value(c, GL.DEPTH_RANGE);
        set(c, GL.CURRENT_RASTER_POSITION, float([viewport[0] + (clip[0] / w + 1) * viewport[2] / 2,
            viewport[1] + (clip[1] / w + 1) * viewport[3] / 2, depth[0] + (clip[2] / w + 1) * (depth[1] - depth[0]) / 2, w]));
        const n = normal(c), colors = enabled(c, GL.LIGHTING) ? lighting(c, eye, n) :
            [value(c, GL.CURRENT_COLOR).map(clamp), value(c, GL.CURRENT_SECONDARY_COLOR_EXT).map(clamp)];
        set(c, GL.CURRENT_RASTER_COLOR, colors[0]); set(c, GL.CURRENT_RASTER_SECONDARY_COLOR, colors[1]);
        // RasterPos keeps eye distance and the explicit raster fog coordinate
        // separately. WindowPos has the ARB extension's combined-distance rule.
        set(c, GL.CURRENT_RASTER_DISTANCE, [Math.fround(Math.abs(eye[2]))]);
        c.state.rasterFogCoord = value(c, GL.CURRENT_FOG_COORDINATE_EXT)[0];
        c.state.rasterCoords = coordinates(c, object, eye, n);
    });
    state.rule("WINDOW_POS3F");
    state.on("WINDOW_POS3F", (c, a) => {
        const depth = value(c, GL.DEPTH_RANGE);
        set(c, GL.CURRENT_RASTER_POSITION, float([a[0], a[1], depth[0] + clamp(a[2]) * (depth[1] - depth[0]), 1]));
        set(c, GL.CURRENT_RASTER_POSITION_VALID, [1]);
        set(c, GL.CURRENT_RASTER_COLOR, value(c, GL.CURRENT_COLOR).map(clamp));
        set(c, GL.CURRENT_RASTER_SECONDARY_COLOR, value(c, GL.CURRENT_SECONDARY_COLOR_EXT).map(clamp));
        set(c, GL.CURRENT_RASTER_DISTANCE, value(c, GL.FOG_COORD_SRC)[0] === GL.FOG_COORD ? value(c, GL.CURRENT_FOG_COORDINATE_EXT).slice() : [0]);
        c.state.rasterFogCoord = value(c, GL.CURRENT_RASTER_DISTANCE)[0];
        c.state.rasterCoords = c.state.fixed.units.map(u => u.coord.slice());
    });
    GLShadow.rules({ [P.GLFN.BITMAP]: (s, bytes, view, offset, size) => {
        if (s.current.state.begin) return GL.INVALID_OPERATION;
        if (s.framebufferStatus(GL.DRAW_FRAMEBUFFER) !== GL.FRAMEBUFFER_COMPLETE) return GL.INVALID_FRAMEBUFFER_OPERATION;
        const r = P.decodeRecord("BITMAP", view, offset);
        return r.width < 0 || r.height < 0 || P.RECORDS.BITMAP.size + r.data_size > size ? GL.INVALID_VALUE : 0;
    } });
    const coords = () => Array.from({ length: 8 }, () => [0, 0, 0, 1]);
    state.attributes("rasterPosition", {
        capture(c, mask, client) { return !client && mask & 1 ? { coords: clone(c.state.rasterCoords), fog: c.state.rasterFogCoord } : null; },
        restore(c, saved) { c.state.rasterCoords = clone(saved.coords); c.state.rasterFogCoord = saved.fog; },
    });
    GLShadow.part({
        context(c) { c.state.rasterCoords = coords(); c.state.rasterFogCoord = 0; },
        command(s, fn, bytes, view, offset) {
            if (fn !== P.GLFN.BITMAP || !s.current || !value(s.current, GL.CURRENT_RASTER_POSITION_VALID)[0]) return;
            const r = P.decodeRecord("BITMAP", view, offset), p = value(s.current, GL.CURRENT_RASTER_POSITION).slice();
            p[0] = Math.fround(p[0] + r.xmove); p[1] = Math.fround(p[1] + r.ymove);
            set(s.current, GL.CURRENT_RASTER_POSITION, p);
        },
        setState(s) { for (const c of s.contexts.values()) {
            if (!c.state.rasterCoords) c.state.rasterCoords = coords();
            if (c.state.rasterFogCoord === undefined) c.state.rasterFogCoord = 0;
        } },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
