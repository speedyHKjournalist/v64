// Desktop GL's typed state queries (plan C3). Unlike QUERY_INTEGER, which
// predates the CPU shadow and has only one int, QUERY_STATE carries vectors
// and doubles. Migrate a whole state family here before the guest stops
// answering it locally. Other families explicitly return UNSUPPORTED.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const { GLFN, F, RECORDS, C } = P;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const clone = value => JSON.parse(JSON.stringify(value));
    const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    function multiply(a, b) {
        return Array.from({ length: 16 }, (_, i) => {
            const row = i % 4, col = i - row;
            return a[row] * b[col] + a[row + 4] * b[col + 1] +
                a[row + 8] * b[col + 2] + a[row + 12] * b[col + 3];
        });
    }

    // pname -> [initial values, GL state type, glPushAttrib group]. Colors
    // and depth's normalized conversion are distinct from ordinary floats.
    const DEFAULTS = new Map();
    const define = (names, values, kind, group) => {
        for (const name of names.split(" ")) {
            if (GL[name] === undefined) throw new Error("unknown GL state " + name);
            DEFAULTS.set(GL[name], [values, kind || "i", group || 0]);
        }
    };
    define("VIEWPORT", [0, 0, 0, 0], "i", 0x800);
    define("SCISSOR_BOX", [0, 0, 0, 0], "i", 0x80000);
    define("DEPTH_RANGE", [0, 1], "n", 0x800);
    define("COLOR_CLEAR_VALUE ACCUM_CLEAR_VALUE", [0, 0, 0, 0], "n", 0x4000);
    DEFAULTS.get(GL.ACCUM_CLEAR_VALUE)[2] = 0x200;
    define("DEPTH_CLEAR_VALUE", [1], "n", 0x100);
    define("STENCIL_CLEAR_VALUE", [0], "i", 0x400);
    define("DEPTH_FUNC", [GL.LESS], "i", 0x100);
    define("DEPTH_WRITEMASK", [1], "b", 0x100);
    define("COLOR_WRITEMASK", [1, 1, 1, 1], "b", 0x4000);
    define("CULL_FACE_MODE", [GL.BACK], "i", 0x8);
    define("FRONT_FACE", [GL.CCW], "i", 0x8);
    define("SHADE_MODEL", [GL.SMOOTH], "i", 0x40);
    define("LINE_WIDTH POINT_SIZE", [1], "f", 0x4);
    DEFAULTS.get(GL.POINT_SIZE)[2] = 0x2;
    define("POLYGON_MODE", [GL.FILL, GL.FILL], "i", 0x8);
    define("POLYGON_OFFSET_FACTOR POLYGON_OFFSET_UNITS", [0], "f", 0x8);
    define("LINE_STIPPLE_REPEAT", [1], "i", 0x4);
    define("LINE_STIPPLE_PATTERN", [65535], "i", 0x4);
    define("BLEND_SRC_RGB BLEND_SRC_ALPHA", [GL.ONE], "i", 0x4000);
    define("BLEND_DST_RGB BLEND_DST_ALPHA", [GL.ZERO], "i", 0x4000);
    define("BLEND_EQUATION_RGB BLEND_EQUATION_ALPHA", [GL.FUNC_ADD], "i", 0x4000);
    // GL_BLEND_COLOR (not present in older generated constant tables).
    DEFAULTS.set(0x8005, [[0, 0, 0, 0], "n", 0x4000]);
    define("ALPHA_TEST_FUNC", [GL.ALWAYS], "i", 0x4000);
    define("ALPHA_TEST_REF", [0], "n", 0x4000);
    define("SAMPLE_COVERAGE_VALUE", [1], "f", 0x20000000);
    define("SAMPLE_COVERAGE_INVERT", [0], "b", 0x20000000);
    define("PACK_ALIGNMENT UNPACK_ALIGNMENT", [4]);
    const STORE_BOOLEAN = new Set([GL.PACK_SWAP_BYTES, GL.PACK_LSB_FIRST, GL.UNPACK_SWAP_BYTES, GL.UNPACK_LSB_FIRST]);
    const STORE = new Set([GL.PACK_ALIGNMENT, GL.UNPACK_ALIGNMENT, ...STORE_BOOLEAN,
        GL.PACK_ROW_LENGTH, GL.PACK_SKIP_ROWS, GL.PACK_SKIP_PIXELS, GL.PACK_SKIP_IMAGES, GL.PACK_IMAGE_HEIGHT,
        GL.UNPACK_ROW_LENGTH, GL.UNPACK_SKIP_ROWS, GL.UNPACK_SKIP_PIXELS, GL.UNPACK_SKIP_IMAGES, GL.UNPACK_IMAGE_HEIGHT]);
    for (const pname of STORE) if (!DEFAULTS.has(pname)) DEFAULTS.set(pname, [[0], STORE_BOOLEAN.has(pname) ? "b" : "i", 0]);
    const COMPARE = value => value >= GL.NEVER && value <= GL.ALWAYS;
    const FACTORS = new Set([0, 1, GL.SRC_COLOR, GL.ONE_MINUS_SRC_COLOR, GL.DST_COLOR, GL.ONE_MINUS_DST_COLOR,
        GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.DST_ALPHA, GL.ONE_MINUS_DST_ALPHA,
        GL.CONSTANT_COLOR, GL.ONE_MINUS_CONSTANT_COLOR, GL.CONSTANT_ALPHA, GL.ONE_MINUS_CONSTANT_ALPHA]);
    const EQUATIONS = new Set([GL.FUNC_ADD, GL.FUNC_SUBTRACT, GL.FUNC_REVERSE_SUBTRACT, GL.MIN, GL.MAX]);
    const SETTERS = new Map();
    const on = (name, fn) => SETTERS.set(GLFN[name], fn);
    const set = (c, pname, values) => { c.state.values[pname] = values; };
    const scalar = (name, pname, valid, convert) => on(name, (c, a) => {
        if (!valid || valid(a[0])) set(c, pname, [convert ? convert(a[0]) : a[0]]);
    });
    on("VIEWPORT", (c, a) => { if (a[2] >= 0 && a[3] >= 0) set(c, GL.VIEWPORT, a); });
    on("SCISSOR", (c, a) => { if (a[2] >= 0 && a[3] >= 0) set(c, GL.SCISSOR_BOX, a); });
    on("DEPTH_RANGE", (c, a) => set(c, GL.DEPTH_RANGE, a.map(v => clamp(v, 0, 1))));
    on("CLEAR_COLOR", (c, a) => set(c, GL.COLOR_CLEAR_VALUE, a.map(v => clamp(v, 0, 1))));
    on("CLEAR_ACCUM", (c, a) => set(c, GL.ACCUM_CLEAR_VALUE, a.map(v => clamp(v, -1, 1))));
    scalar("CLEAR_DEPTH", GL.DEPTH_CLEAR_VALUE, null, v => clamp(v, 0, 1));
    scalar("CLEAR_STENCIL", GL.STENCIL_CLEAR_VALUE);
    scalar("DEPTH_FUNC", GL.DEPTH_FUNC, COMPARE);
    scalar("DEPTH_MASK", GL.DEPTH_WRITEMASK, null, v => +!!v);
    on("COLOR_MASK", (c, a) => set(c, GL.COLOR_WRITEMASK, a.map(v => +!!v)));
    scalar("CULL_FACE", GL.CULL_FACE_MODE, v => [GL.FRONT, GL.BACK, GL.FRONT_AND_BACK].includes(v));
    scalar("FRONT_FACE", GL.FRONT_FACE, v => v === GL.CW || v === GL.CCW);
    scalar("SHADE_MODEL", GL.SHADE_MODEL, v => v === GL.FLAT || v === GL.SMOOTH);
    scalar("LINE_WIDTH", GL.LINE_WIDTH, v => v > 0);
    scalar("POINT_SIZE", GL.POINT_SIZE, v => v > 0);
    on("POLYGON_MODE", (c, a) => {
        if (![GL.FRONT, GL.BACK, GL.FRONT_AND_BACK].includes(a[0]) || ![GL.POINT, GL.LINE, GL.FILL].includes(a[1])) return;
        const modes = c.state.values[GL.POLYGON_MODE].slice();
        if (a[0] !== GL.BACK) modes[0] = a[1];
        if (a[0] !== GL.FRONT) modes[1] = a[1];
        set(c, GL.POLYGON_MODE, modes);
    });
    on("POLYGON_OFFSET", (c, a) => { set(c, GL.POLYGON_OFFSET_FACTOR, [a[0]]); set(c, GL.POLYGON_OFFSET_UNITS, [a[1]]); });
    on("LINE_STIPPLE", (c, a) => { set(c, GL.LINE_STIPPLE_REPEAT, [clamp(a[0], 1, 256)]); set(c, GL.LINE_STIPPLE_PATTERN, [a[1] & 65535]); });
    function blend(c, a) {
        if (!a.every((v, i) => FACTORS.has(v) || i === 0 && v === GL.SRC_ALPHA_SATURATE)) return;
        [GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA, GL.BLEND_DST_ALPHA].forEach((p, i) => set(c, p, [a[i]]));
    }
    on("BLEND_FUNC", (c, a) => {
        if ((!FACTORS.has(a[0]) && a[0] !== GL.SRC_ALPHA_SATURATE) || !FACTORS.has(a[1])) return;
        [GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA, GL.BLEND_DST_ALPHA].forEach((p, i) => set(c, p, [a[i % 2]]));
    });
    on("BLEND_FUNC_SEPARATE", blend);
    on("BLEND_EQUATION", (c, a) => { if (EQUATIONS.has(a[0])) for (const p of [GL.BLEND_EQUATION_RGB, GL.BLEND_EQUATION_ALPHA]) set(c, p, a); });
    on("BLEND_EQUATION_SEPARATE", (c, a) => {
        if (a.every(v => EQUATIONS.has(v))) { set(c, GL.BLEND_EQUATION_RGB, [a[0]]); set(c, GL.BLEND_EQUATION_ALPHA, [a[1]]); }
    });
    on("BLEND_COLOR", (c, a) => set(c, 0x8005, a.map(v => clamp(v, 0, 1))));
    on("ALPHA_FUNC", (c, a) => { if (COMPARE(a[0])) { set(c, GL.ALPHA_TEST_FUNC, [a[0]]); set(c, GL.ALPHA_TEST_REF, [clamp(a[1], 0, 1)]); } });
    on("SAMPLE_COVERAGE", (c, a) => { set(c, GL.SAMPLE_COVERAGE_VALUE, [clamp(a[0], 0, 1)]); set(c, GL.SAMPLE_COVERAGE_INVERT, [+!!a[1]]); });
    on("PIXEL_STOREI", (c, [p, value]) => {
        if (!STORE.has(p)) return;
        if (p === GL.PACK_ALIGNMENT || p === GL.UNPACK_ALIGNMENT) { if (![1, 2, 4, 8].includes(value)) return; }
        else if (STORE_BOOLEAN.has(p)) value = +!!value;
        else if (value < 0) return;
        set(c, p, [value]);
    });
    function stack(c) { return c.state.mode === GL.TEXTURE ? c.state.texture[c.activeTexture || 0] : c.state.stacks[c.state.mode]; }
    on("MATRIX_MODE", (c, [mode]) => { if ([GL.MODELVIEW, GL.PROJECTION, GL.TEXTURE, GL.COLOR_MATRIX_SGI].includes(mode)) c.state.mode = mode; });
    on("LOAD_IDENTITY", c => { const s = stack(c); s[s.length - 1] = identity(); });
    on("PUSH_MATRIX", c => { const s = stack(c), max = c.state.mode === GL.MODELVIEW ? caps.LIMITS.MODELVIEW_STACK_DEPTH : caps.LIMITS.OTHER_STACK_DEPTH; if (s.length < max) s.push(s[s.length - 1].slice()); });
    on("POP_MATRIX", c => { const s = stack(c); if (s.length > 1) s.pop(); });
    const mult = (c, m) => { const s = stack(c); s[s.length - 1] = multiply(s[s.length - 1], m).map(Math.fround); };
    on("TRANSLATEF", (c, [x, y, z]) => { const m = identity(); m[12] = x; m[13] = y; m[14] = z; mult(c, m); });
    on("SCALEF", (c, [x, y, z]) => { const m = identity(); m[0] = x; m[5] = y; m[10] = z; mult(c, m); });
    on("ROTATEF", (c, [angle, x, y, z]) => {
        const len = Math.hypot(x, y, z); if (!len) return;
        x /= len; y /= len; z /= len;
        const cs = Math.cos(angle * Math.PI / 180), sn = Math.sin(angle * Math.PI / 180), t = 1 - cs;
        mult(c, [t*x*x+cs, t*x*y+sn*z, t*x*z-sn*y, 0, t*x*y-sn*z, t*y*y+cs, t*y*z+sn*x, 0,
            t*x*z+sn*y, t*y*z-sn*x, t*z*z+cs, 0, 0, 0, 0, 1]);
    });
    on("ORTHO", (c, [l, r, b, t, n, f]) => {
        if (l === r || b === t || n === f) return;
        mult(c, [2/(r-l), 0, 0, 0, 0, 2/(t-b), 0, 0, 0, 0, -2/(f-n), 0, -(r+l)/(r-l), -(t+b)/(t-b), -(f+n)/(f-n), 1]);
    });
    on("FRUSTUM", (c, [l, r, b, t, n, f]) => {
        if (l === r || b === t || n <= 0 || f <= 0 || n === f) return;
        mult(c, [2*n/(r-l), 0, 0, 0, 0, 2*n/(t-b), 0, 0, (r+l)/(r-l), (t+b)/(t-b), -(f+n)/(f-n), -1, 0, 0, -2*f*n/(f-n), 0]);
    });

    const proto = GLShadow.prototype;
    proto.stateValue = function(pname) {
        const c = this.current;
        if (!c) return null;
        const state = c.state;
        if (DEFAULTS.has(pname)) return [state.values[pname], DEFAULTS.get(pname)[1]];
        if (pname === GL.BLEND_SRC) return [state.values[GL.BLEND_SRC_RGB], "i"];
        if (pname === GL.BLEND_DST) return [state.values[GL.BLEND_DST_RGB], "i"];
        const matrix = { [GL.MODELVIEW_MATRIX]: GL.MODELVIEW, [GL.PROJECTION_MATRIX]: GL.PROJECTION,
            [GL.TEXTURE_MATRIX]: GL.TEXTURE, [GL.COLOR_MATRIX_SGI]: GL.COLOR_MATRIX_SGI }[pname];
        if (matrix) { const s = matrix === GL.TEXTURE ? state.texture[c.activeTexture || 0] : state.stacks[matrix]; return [s[s.length - 1], "f"]; }
        const depth = { [GL.MODELVIEW_STACK_DEPTH]: GL.MODELVIEW, [GL.PROJECTION_STACK_DEPTH]: GL.PROJECTION,
            [GL.TEXTURE_STACK_DEPTH]: GL.TEXTURE, [GL.COLOR_MATRIX_STACK_DEPTH_SGI]: GL.COLOR_MATRIX_SGI }[pname];
        if (depth) return [[(depth === GL.TEXTURE ? state.texture[c.activeTexture || 0] : state.stacks[depth]).length], "i"];
        if (pname === GL.MATRIX_MODE) return [[state.mode], "i"];
        if (pname === GL.ACTIVE_TEXTURE) return [[GL.TEXTURE0 + (c.activeTexture || 0)], "i"];
        if (pname === GL.CLIENT_ACTIVE_TEXTURE) return [[GL.TEXTURE0 + state.clientTexture], "i"];
        // Format queries belong to the selected drawable, not the adapter.
        if (pname === GL.DOUBLEBUFFER) return [[+(!c.drawFramebuffer && !(state.format & C.V86GL_FORMAT_SINGLE_BUFFER))], "b"];
        if (pname === GL.SAMPLES || pname === GL.SAMPLE_BUFFERS) {
            // FBO multisample storage has not been migrated yet.
            if (c.drawFramebuffer) return null;
            const samples = (state.format & C.V86GL_FORMAT_SAMPLES_MASK) >>> C.V86GL_FORMAT_SAMPLES_SHIFT;
            return [[pname === GL.SAMPLES ? (samples > 1 ? samples : 0) : +(samples > 1)], "i"];
        }
        if (pname === GL.MAX_VIEWPORT_DIMS && this.capabilities) {
            const max = caps.integer(this.capabilities, pname); return [[max, max], "i"];
        }
        // Do not use the adapter's unconditional bit-depth answers for FBOs.
        if (c.drawFramebuffer && pname >= GL.RED_BITS && pname <= GL.STENCIL_BITS) return null;
        const value = this.capabilities && caps.integer(this.capabilities, pname);
        return value !== undefined && value !== null ? [[value], "i"] : null;
    };

    proto.queryState = function(bytes, view, offset, size) {
        if (!this.pending("QUERY_STATE", view, offset, size)) return;
        const r = P.decodeRecord("QUERY_STATE", view, offset);
        const header = RECORDS.QUERY_STATE.size;
        const fail = error => { view.setUint32(offset + F.QUERY_STATE.error, error, true); this.answered("QUERY_STATE", view, offset, C.V86GL_SYNC_QUERY_STATUS_FAILED); };
        if (header + r.data_size > size || r.value_kind < C.V86GL_STATE_INTEGER || r.value_kind > C.V86GL_STATE_BOOLEAN) return fail(GL.INVALID_VALUE);
        if (!this.current || this.current.state.begin) return fail(GL.INVALID_OPERATION);
        const result = this.stateValue(r.pname);
        if (!result) { this.answered("QUERY_STATE", view, offset, C.V86GL_STATE_QUERY_UNSUPPORTED); return; }
        const [values, kind] = result;
        if (values.length * 8 > r.data_size) return fail(GL.INVALID_VALUE);
        for (let i = 0; i < values.length; ++i) {
            let v = values[i];
            if (r.value_kind === C.V86GL_STATE_BOOLEAN) v = +!!v;
            else if (r.value_kind === C.V86GL_STATE_INTEGER) {
                // Color/depth conversion scales then truncates (the Apple
                // GL 2.1 oracle), unlike an ordinary float's nearest integer.
                // Preserve the specified negative endpoint even though the
                // Apple driver returns -INT_MAX there (glGet's refpage).
                v = kind === "n" ? (v <= -1 ? -0x80000000 : Math.trunc(clamp(v, -1, 1) * 0x7FFFFFFF)) : Math.round(v);
                v = clamp(v, -0x80000000, 0x7FFFFFFF);
            } else if (r.value_kind === C.V86GL_STATE_FLOAT) v = Math.fround(v);
            view.setFloat64(offset + header + i * 8, v, true);
        }
        view.setUint32(offset + F.QUERY_STATE.count, values.length, true);
        this.answered("QUERY_STATE", view, offset, C.V86GL_SYNC_QUERY_STATUS_OK);
    };
    GLShadow.install({ [GLFN.QUERY_STATE]: "queryState" });
    GLShadow.part({
        context(c) {
            c.state = { values: Object.fromEntries([...DEFAULTS].map(([p, [v]]) => [p, v.slice()])),
                mode: GL.MODELVIEW, stacks: { [GL.MODELVIEW]: [identity()], [GL.PROJECTION]: [identity()], [GL.COLOR_MATRIX_SGI]: [identity()] },
                texture: Array.from({ length: caps.LIMITS.MAX_TEXTURE_UNITS }, () => [identity()]),
                attrib: [], clientAttrib: [], clientTexture: 0, format: 0, initialized: false, begin: false };
        },
        current(shadow, c, view, offset, size) {
            if (!c.state.initialized) {
                const width = shadow.field("MAKE_CURRENT", "width", view, offset, size), height = shadow.field("MAKE_CURRENT", "height", view, offset, size);
                set(c, GL.VIEWPORT, [0, 0, width, height]); set(c, GL.SCISSOR_BOX, [0, 0, width, height]);
                c.state.format = shadow.field("MAKE_CURRENT", "format", view, offset, size);
                c.state.initialized = true;
            }
        },
        command(shadow, fn, bytes, view, offset, size) {
            const c = shadow.current; if (!c) return;
            const state = c.state;
            if (fn === GLFN.BEGIN) { if (size >= 4 && view.getUint32(offset, true) <= GL.POLYGON) state.begin = true; return; }
            if (fn === GLFN.END) { state.begin = false; return; }
            // None of these state changes is legal within Begin/End.
            if (state.begin) return;
            if (fn === GLFN.LOAD_MATRIXF || fn === GLFN.MULT_MATRIXF) {
                if (size < 64) return;
                const m = Array.from({ length: 16 }, (_, i) => view.getFloat32(offset + i * 4, true)), s = stack(c);
                s[s.length - 1] = fn === GLFN.LOAD_MATRIXF ? m : multiply(s[s.length - 1], m).map(Math.fround);
                return;
            }
            if (fn === GLFN.PUSH_ATTRIB || fn === GLFN.PUSH_CLIENT_ATTRIB) {
                if (size < 4) return;
                const mask = view.getUint32(offset, true), client = fn === GLFN.PUSH_CLIENT_ATTRIB;
                const list = client ? state.clientAttrib : state.attrib;
                if (list.length >= 16) return;
                const values = {};
                for (const [p, [, , group]] of DEFAULTS)
                    if (client ? STORE.has(p) && (mask & 1) : group && (mask & group)) values[p] = state.values[p].slice();
                list.push({ values, mode: !client && (mask & 0x1000) ? state.mode : null,
                    clientTexture: client && (mask & 2) ? state.clientTexture : null,
                    activeTexture: !client && (mask & 0x40000) ? c.activeTexture : null });
                return;
            }
            if (fn === GLFN.POP_ATTRIB || fn === GLFN.POP_CLIENT_ATTRIB) {
                const saved = (fn === GLFN.POP_ATTRIB ? state.attrib : state.clientAttrib).pop();
                if (!saved) return;
                Object.assign(state.values, saved.values);
                if (saved.mode !== null) state.mode = saved.mode;
                if (saved.clientTexture !== null) state.clientTexture = saved.clientTexture;
                if (saved.activeTexture !== null && saved.activeTexture !== undefined) c.activeTexture = saved.activeTexture;
                return;
            }
            if (fn === GLFN.CLIENT_ACTIVE_TEXTURE) {
                if (size >= 4) { const unit = view.getUint32(offset, true) - GL.TEXTURE0; if (unit >= 0 && unit < caps.LIMITS.MAX_TEXTURE_COORDS) state.clientTexture = unit; }
                return;
            }
            const setter = SETTERS.get(fn);
            if (setter) { const a = shadow.args(P.NAME_BY_OPCODE[fn], view, offset, size); if (a) setter(c, a); }
        },
        getState(shadow, state) { state.typed = [...shadow.contexts.values()].map(c => [c.key, clone(c.state)]); },
        setState(shadow, state) { for (const [key, saved] of state.typed || []) { const c = shadow.contexts.get(key); if (c) c.state = clone(saved); } },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
