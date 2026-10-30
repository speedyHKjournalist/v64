// Fixed-function parameter state on the CPU. Queries use the same typed
// reply path as glGet*v; matrix-dependent values are captured at set time.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const math = global.GLMath || require("./gl_math.js");
    const { C } = P;
    const clone = GLShadow.clone;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const COLORS = new Set([GL.AMBIENT, GL.DIFFUSE, GL.SPECULAR, GL.EMISSION, GL.AMBIENT_AND_DIFFUSE]);
    const LIGHT_COUNTS = { [GL.AMBIENT]: 4, [GL.DIFFUSE]: 4, [GL.SPECULAR]: 4, [GL.POSITION]: 4,
        [GL.SPOT_DIRECTION]: 3, [GL.SPOT_EXPONENT]: 1, [GL.SPOT_CUTOFF]: 1,
        [GL.CONSTANT_ATTENUATION]: 1, [GL.LINEAR_ATTENUATION]: 1, [GL.QUADRATIC_ATTENUATION]: 1 };
    const MATERIAL_COUNTS = { [GL.AMBIENT]: 4, [GL.DIFFUSE]: 4, [GL.SPECULAR]: 4, [GL.EMISSION]: 4,
        [GL.AMBIENT_AND_DIFFUSE]: 4, [GL.SHININESS]: 1, [GL.COLOR_INDEXES]: 3 };
    const MODEL = { [GL.LIGHT_MODEL_AMBIENT]: [4, "n"], [GL.LIGHT_MODEL_TWO_SIDE]: [1, "b"],
        [GL.LIGHT_MODEL_LOCAL_VIEWER]: [1, "b"], [GL.LIGHT_MODEL_COLOR_CONTROL]: [1, "i"] };
    const unit = c => c.state.fixed.units[c.activeTexture || 0];
    const top = c => c.state.stacks[GL.MODELVIEW].at(-1);
    const transform = (m, v) => Array.from(math.transformPoint4(m, v, new Float64Array(4)));
    const plane = (c, v) => transform(math.transpose4(math.invert4(top(c), new Float64Array(16)), new Float64Array(16)), v);
    // Integer color setters use the signed normalized mapping, while
    // positions, planes, shininess and enumerants are ordinary numbers.
    const normalized = v => Math.max(-1, v / 0x7FFFFFFF);
    function parameters(a, vector, start, color, integer) {
        const values = vector ? a.slice(start + 1, start + 1 + a[start]) : [a[start]];
        return integer && color ? values.map(v => Math.fround(normalized(v))) : values;
    }
    function material() {
        return { [GL.AMBIENT]: [0.2, 0.2, 0.2, 1], [GL.DIFFUSE]: [0.8, 0.8, 0.8, 1],
            [GL.SPECULAR]: [0, 0, 0, 1], [GL.EMISSION]: [0, 0, 0, 1], [GL.SHININESS]: [0], [GL.COLOR_INDEXES]: [0, 1, 1] };
    }
    function environment() {
        const e = { [GL.TEXTURE_ENV_MODE]: [GL.MODULATE], [GL.TEXTURE_ENV_COLOR]: [0, 0, 0, 0],
            [GL.COMBINE_RGB]: [GL.MODULATE], [GL.COMBINE_ALPHA]: [GL.MODULATE],
            [GL.RGB_SCALE]: [1], [GL.ALPHA_SCALE]: [1], [GL.TEXTURE_LOD_BIAS]: [0], [GL.COORD_REPLACE]: [0] };
        for (let i = 0; i < 3; ++i) {
            e[GL.SRC0_RGB + i] = e[GL.SRC0_ALPHA + i] = [[GL.TEXTURE, GL.PREVIOUS, GL.CONSTANT][i]];
            e[GL.OPERAND0_RGB + i] = [i === 2 ? GL.SRC_ALPHA : GL.SRC_COLOR];
            e[GL.OPERAND0_ALPHA + i] = [GL.SRC_ALPHA];
        }
        return e;
    }
    function initial() {
        return { lights: Array.from({ length: caps.LIMITS.MAX_LIGHTS }, (_, i) => ({
            [GL.AMBIENT]: [0, 0, 0, 1], [GL.DIFFUSE]: i ? [0, 0, 0, 1] : [1, 1, 1, 1],
            [GL.SPECULAR]: i ? [0, 0, 0, 1] : [1, 1, 1, 1], [GL.POSITION]: [0, 0, 1, 0],
            [GL.SPOT_DIRECTION]: [0, 0, -1], [GL.SPOT_EXPONENT]: [0], [GL.SPOT_CUTOFF]: [180],
            [GL.CONSTANT_ATTENUATION]: [1], [GL.LINEAR_ATTENUATION]: [0], [GL.QUADRATIC_ATTENUATION]: [0] })),
        materials: [material(), material()], clip: Array.from({ length: caps.LIMITS.MAX_CLIP_PLANES }, () => [0, 0, 0, 0]),
        units: Array.from({ length: caps.LIMITS.MAX_TEXTURE_UNITS }, () => ({ env: environment(),
            gen: Array.from({ length: 4 }, (_, i) => {
                const p = [+(i === 0), +(i === 1), 0, 0];
                return { [GL.TEXTURE_GEN_MODE]: [GL.EYE_LINEAR], [GL.OBJECT_PLANE]: p.slice(), [GL.EYE_PLANE]: p.slice() };
            }), coord: [0, 0, 0, 1] })) };
    }
    state.define("CURRENT_COLOR", [1, 1, 1, 1], "n", 1);
    state.define("CURRENT_NORMAL", [0, 0, 1], "f", 1);
    state.define("CURRENT_SECONDARY_COLOR_EXT", [0, 0, 0, 1], "n", 1);
    state.define("CURRENT_FOG_COORDINATE_EXT", [0], "f", 1);
    state.define("LIGHT_MODEL_AMBIENT", [0.2, 0.2, 0.2, 1], "n", 0x40);
    state.define("LIGHT_MODEL_TWO_SIDE LIGHT_MODEL_LOCAL_VIEWER", [0], "b", 0x40);
    state.define("LIGHT_MODEL_COLOR_CONTROL", [GL.SINGLE_COLOR], "i", 0x40);
    state.define("COLOR_MATERIAL_FACE", [GL.FRONT_AND_BACK], "i", 0x40);
    state.define("COLOR_MATERIAL_PARAMETER", [GL.AMBIENT_AND_DIFFUSE], "i", 0x40);
    state.query([GL.CURRENT_TEXTURE_COORDS], shadow => [unit(shadow.current).coord, "f"]);
    function latch(c) {
        if (!c.state.raster || !c.state.raster.enabled[GL.COLOR_MATERIAL]) return;
        const face = c.state.values[GL.COLOR_MATERIAL_FACE][0], mode = c.state.values[GL.COLOR_MATERIAL_PARAMETER][0];
        c.state.fixed.materials.forEach((m, i) => {
            if (face === (i ? GL.FRONT : GL.BACK)) return;
            for (const p of mode === GL.AMBIENT_AND_DIFFUSE ? [GL.AMBIENT, GL.DIFFUSE] : [mode])
                m[p] = c.state.values[GL.CURRENT_COLOR].slice();
        });
    }
    for (const [name, pname] of [["COLOR4F", GL.CURRENT_COLOR], ["NORMAL3F", GL.CURRENT_NORMAL],
            ["SECONDARY_COLOR3F", GL.CURRENT_SECONDARY_COLOR_EXT], ["FOG_COORDF", GL.CURRENT_FOG_COORDINATE_EXT]]) {
        state.rule(name, null, true);
        state.on(name, (c, a) => { state.set(c, pname, name === "SECONDARY_COLOR3F" ? [...a, 1] : a); if (name === "COLOR4F") latch(c); }, true);
    }
    state.rule("TEX_COORD2F", null, true);
    state.on("TEX_COORD2F", (c, a) => { c.state.fixed.units[0].coord = [...a, 0, 1]; }, true);
    state.rule("MULTI_TEX_COORD4F", (c, a) => a[0] >= GL.TEXTURE0 && a[0] < GL.TEXTURE0 + caps.LIMITS.MAX_TEXTURE_UNITS ? 0 : GL.INVALID_ENUM, true);
    state.on("MULTI_TEX_COORD4F", (c, a) => { c.state.fixed.units[a[0] - GL.TEXTURE0].coord = a.slice(1); }, true);
    state.rule("COLOR_MATERIAL", (c, a) => [GL.FRONT, GL.BACK, GL.FRONT_AND_BACK].includes(a[0]) && COLORS.has(a[1]) ? 0 : GL.INVALID_ENUM);
    state.on("COLOR_MATERIAL", (c, a) => { state.set(c, GL.COLOR_MATERIAL_FACE, [a[0]]); state.set(c, GL.COLOR_MATERIAL_PARAMETER, [a[1]]); latch(c); });

    for (const family of ["LIGHT", "MATERIAL", "LIGHT_MODEL"]) for (const suffix of ["F", "I", "FV", "IV"]) {
        const name = family + suffix, vector = suffix.endsWith("V"), integer = suffix.startsWith("I"), model = family === "LIGHT_MODEL";
        const read = a => { const p = a[model ? 0 : 1]; return parameters(a, vector, model ? 1 : 2, COLORS.has(p) || p === GL.LIGHT_MODEL_AMBIENT, integer); };
        state.rule(name, (c, a) => {
            const p = a[model ? 0 : 1], count = model ? MODEL[p] && MODEL[p][0] : (family === "LIGHT" ? LIGHT_COUNTS : MATERIAL_COUNTS)[p];
            if (!count || (!vector && count !== 1)) return GL.INVALID_ENUM;
            if (!model && (family === "LIGHT" ? a[0] < GL.LIGHT0 || a[0] >= GL.LIGHT0 + caps.LIMITS.MAX_LIGHTS :
                    ![GL.FRONT, GL.BACK, GL.FRONT_AND_BACK].includes(a[0]))) return GL.INVALID_ENUM;
            const v = read(a); if (v.length < count) return GL.INVALID_VALUE;
            if ((p === GL.SPOT_EXPONENT || p === GL.SHININESS) && !(v[0] >= 0 && v[0] <= 128) ||
                    p === GL.SPOT_CUTOFF && !(v[0] >= 0 && v[0] <= 90 || v[0] === 180) ||
                    [GL.CONSTANT_ATTENUATION, GL.LINEAR_ATTENUATION, GL.QUADRATIC_ATTENUATION].includes(p) && !(v[0] >= 0)) return GL.INVALID_VALUE;
            return p === GL.LIGHT_MODEL_COLOR_CONTROL && ![GL.SINGLE_COLOR, GL.SEPARATE_SPECULAR_COLOR].includes(v[0]) ? GL.INVALID_ENUM : 0;
        }, family === "MATERIAL");
        state.on(name, (c, a) => {
            const p = a[model ? 0 : 1]; let v = read(a);
            if (model) { state.set(c, p, MODEL[p][1] === "b" ? [+!!v[0]] : v); return; }
            if (family === "LIGHT") {
                if (p === GL.POSITION || p === GL.SPOT_DIRECTION) v = transform(top(c), p === GL.POSITION ? v : [...v.slice(0, 3), 0]).map(Math.fround);
                c.state.fixed.lights[a[0] - GL.LIGHT0][p] = v.slice(0, LIGHT_COUNTS[p]);
            } else c.state.fixed.materials.forEach((m, i) => {
                if (a[0] === (i ? GL.FRONT : GL.BACK)) return;
                for (const q of p === GL.AMBIENT_AND_DIFFUSE ? [GL.AMBIENT, GL.DIFFUSE] : [p]) m[q] = v.slice(0, MATERIAL_COUNTS[p]);
            });
        }, family === "MATERIAL");
    }
    const validLight = target => target >= GL.LIGHT0 && target < GL.LIGHT0 + caps.LIMITS.MAX_LIGHTS;
    state.parameter(C.V86GL_PARAMETER_LIGHT, (shadow, target, pname) => validLight(target) && LIGHT_COUNTS[pname] ?
        [shadow.current.state.fixed.lights[target - GL.LIGHT0][pname], COLORS.has(pname) ? "n" : "f"] : GL.INVALID_ENUM);
    state.parameter(C.V86GL_PARAMETER_MATERIAL, (shadow, target, pname) => [GL.FRONT, GL.BACK].includes(target) &&
        MATERIAL_COUNTS[pname] && pname !== GL.AMBIENT_AND_DIFFUSE ?
        [shadow.current.state.fixed.materials[+(target === GL.BACK)][pname], COLORS.has(pname) ? "n" : "f"] : GL.INVALID_ENUM);
    state.rule("CLIP_PLANE", (c, a) => a[0] >= GL.CLIP_PLANE0 && a[0] < GL.CLIP_PLANE0 + caps.LIMITS.MAX_CLIP_PLANES ? 0 : GL.INVALID_ENUM);
    state.on("CLIP_PLANE", (c, a) => { c.state.fixed.clip[a[0] - GL.CLIP_PLANE0] = plane(c, a.slice(1)); });
    state.parameter(C.V86GL_PARAMETER_CLIP_PLANE, (shadow, target) => target >= GL.CLIP_PLANE0 && target < GL.CLIP_PLANE0 + caps.LIMITS.MAX_CLIP_PLANES ?
        [shadow.current.state.fixed.clip[target - GL.CLIP_PLANE0], "f"] : GL.INVALID_ENUM);

    function envKind(target, p) {
        if (target === GL.POINT_SPRITE) return p === GL.COORD_REPLACE ? "b" : null;
        if (target === GL.TEXTURE_FILTER_CONTROL) return p === GL.TEXTURE_LOD_BIAS ? "t" : null;
        if (target !== GL.TEXTURE_ENV || p === GL.TEXTURE_LOD_BIAS || p === GL.COORD_REPLACE) return null;
        return p === GL.TEXTURE_ENV_COLOR ? "n" : Object.hasOwn(environment(), p) ? "i" : null;
    }
    function envError(target, p, v) {
        if (!envKind(target, p)) return GL.INVALID_ENUM;
        const x = v[0];
        if (p === GL.COORD_REPLACE) return [0, 1].includes(x) ? 0 : GL.INVALID_ENUM;
        if (p === GL.TEXTURE_ENV_COLOR) return v.length >= 4 ? 0 : GL.INVALID_VALUE;
        if (p === GL.RGB_SCALE || p === GL.ALPHA_SCALE) return [1, 2, 4].includes(x) ? 0 : GL.INVALID_VALUE;
        if (p === GL.TEXTURE_ENV_MODE) return [GL.MODULATE, GL.DECAL, GL.BLEND, GL.REPLACE, GL.ADD, GL.COMBINE].includes(x) ? 0 : GL.INVALID_ENUM;
        if (p === GL.COMBINE_RGB || p === GL.COMBINE_ALPHA) return [GL.REPLACE, GL.MODULATE, GL.ADD, GL.ADD_SIGNED, GL.INTERPOLATE, GL.SUBTRACT,
            ...(p === GL.COMBINE_RGB ? [GL.DOT3_RGB, GL.DOT3_RGBA] : [])].includes(x) ? 0 : GL.INVALID_ENUM;
        if (p >= GL.SRC0_RGB && p <= GL.SRC2_RGB || p >= GL.SRC0_ALPHA && p <= GL.SRC2_ALPHA)
            return [GL.TEXTURE, GL.CONSTANT, GL.PRIMARY_COLOR, GL.PREVIOUS].includes(x) || x >= GL.TEXTURE0 && x < GL.TEXTURE0 + caps.LIMITS.MAX_TEXTURE_UNITS ? 0 : GL.INVALID_ENUM;
        if (p >= GL.OPERAND0_RGB && p <= GL.OPERAND2_RGB) return [GL.SRC_COLOR, GL.ONE_MINUS_SRC_COLOR, GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA].includes(x) ? 0 : GL.INVALID_ENUM;
        if (p >= GL.OPERAND0_ALPHA && p <= GL.OPERAND2_ALPHA) return [GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA].includes(x) ? 0 : GL.INVALID_ENUM;
        return 0;
    }
    for (const family of ["TEX_ENV", "TEX_GEN"]) for (const suffix of ["I", "F", "IV", "FV"]) {
        const name = family + suffix, vector = suffix.endsWith("V"), env = family === "TEX_ENV";
        const read = a => parameters(a, vector, 2, env && a[1] === GL.TEXTURE_ENV_COLOR, suffix.startsWith("I"));
        state.rule(name, (c, a) => {
            const v = read(a), p = a[1];
            if (env) return !vector && p === GL.TEXTURE_ENV_COLOR ? GL.INVALID_ENUM : envError(a[0], p, v);
            if (a[0] < GL.S || a[0] > GL.Q || ![GL.TEXTURE_GEN_MODE, GL.OBJECT_PLANE, GL.EYE_PLANE].includes(p) ||
                    !vector && p !== GL.TEXTURE_GEN_MODE) return GL.INVALID_ENUM;
            if (p !== GL.TEXTURE_GEN_MODE) return v.length >= 4 ? 0 : GL.INVALID_VALUE;
            if (![GL.EYE_LINEAR, GL.OBJECT_LINEAR, GL.SPHERE_MAP, GL.NORMAL_MAP, GL.REFLECTION_MAP].includes(v[0]) ||
                    v[0] === GL.SPHERE_MAP && a[0] > GL.T || [GL.NORMAL_MAP, GL.REFLECTION_MAP].includes(v[0]) && a[0] === GL.Q) return GL.INVALID_ENUM;
            return 0;
        });
        state.on(name, (c, a) => {
            const v = read(a), p = a[1];
            if (env) unit(c).env[p] = p === GL.TEXTURE_ENV_COLOR ? v.map(x => clamp(x, 0, 1)) : p === GL.COORD_REPLACE ? [+!!v[0]] : [v[0]];
            else unit(c).gen[a[0] - GL.S][p] = p === GL.EYE_PLANE ? plane(c, v).map(Math.fround) : p === GL.TEXTURE_GEN_MODE ? [v[0]] : v;
        });
    }
    state.parameter(C.V86GL_PARAMETER_TEX_ENV, (shadow, target, pname) => {
        const kind = envKind(target, pname); return kind ? [unit(shadow.current).env[pname], kind] : GL.INVALID_ENUM;
    });
    state.parameter(C.V86GL_PARAMETER_TEX_GEN, (shadow, target, pname) => target >= GL.S && target <= GL.Q &&
        [GL.TEXTURE_GEN_MODE, GL.OBJECT_PLANE, GL.EYE_PLANE].includes(pname) ?
        [unit(shadow.current).gen[target - GL.S][pname], pname === GL.TEXTURE_GEN_MODE ? "i" : "t"] : GL.INVALID_ENUM);
    state.attributes("fixed", {
        capture(c, mask, client) {
            if (client) return null;
            const f = c.state.fixed, saved = {};
            if (mask & 0x40) { saved.lights = f.lights; saved.materials = f.materials; }
            if (mask & 0x1000) saved.clip = f.clip;
            if (mask & 0x40000) saved.units = f.units.map(u => ({ env: u.env, gen: u.gen }));
            if (mask & 1) saved.coords = f.units.map(u => u.coord);
            return clone(saved);
        },
        restore(c, saved) {
            const f = c.state.fixed;
            for (const key of ["lights", "materials", "clip"]) if (saved[key]) f[key] = clone(saved[key]);
            if (saved.units) saved.units.forEach((u, i) => { f.units[i].env = clone(u.env); f.units[i].gen = clone(u.gen); });
            if (saved.coords) saved.coords.forEach((v, i) => { f.units[i].coord = v.slice(); });
        },
    });
    GLShadow.part({
        context(c) { c.state.fixed = initial(); },
        command(shadow, fn, bytes, view, offset) {
            if (fn === P.GLFN.ENABLE && shadow.current && view.getUint32(offset, true) === GL.COLOR_MATERIAL) latch(shadow.current);
        },
        setState(shadow) { for (const c of shadow.contexts.values()) if (!c.state.fixed) c.state.fixed = initial(); },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
