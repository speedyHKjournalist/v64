(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const maps = global.GLPixelMaps || require("./gl_pixel_maps.js");
    const initial = () => Array.from({ length: 10 }, () => [0]);
    const indexOf = map => map - GL.PIXEL_MAP_I_TO_I;
    for (let i = 0; i < 10; ++i)
        state.query([GL.PIXEL_MAP_I_TO_I_SIZE + i], s => [[s.current.state.pixelMaps[i].length], "i"]);
    for (const name of ["PIXEL_MAPFV", "PIXEL_MAPUIV", "PIXEL_MAPUSV"]) {
        const stride = name === "PIXEL_MAPUSV" ? 2 : 4;
        GLShadow.rules({ [P.GLFN[name]]: (s, bytes, view, offset, size) => {
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            const r = P.decodeRecord(name, view, offset), index = indexOf(r.map);
            if (index < 0 || index >= 10) return GL.INVALID_ENUM;
            return r.count < 1 || r.count > caps.LIMITS.MAX_PIXEL_MAP_TABLE || index < 6 && (r.count & r.count - 1) ||
                P.RECORDS[name].size + r.count * stride > size ? GL.INVALID_VALUE : 0;
        } });
    }
    state.parameter(P.C.V86GL_PARAMETER_PIXEL_MAP, (s, target) => {
        const index = indexOf(target);
        return index >= 0 && index < 10 ? [s.current.state.pixelMaps[index], index < 2 ? "u" : "n"] : GL.INVALID_ENUM;
    });
    state.attributes("pixelMaps", {
        capture(c, mask, client) { return !client && mask & 0x20 ? c.state.pixelMaps.map(v => v.slice()) : null; },
        restore(c, saved) { c.state.pixelMaps = saved.map(v => v.slice()); },
    });
    GLShadow.part({
        context(c) { c.state.pixelMaps = initial(); },
        command(s, fn, bytes, view, offset) {
            if (![P.GLFN.PIXEL_MAPFV, P.GLFN.PIXEL_MAPUIV, P.GLFN.PIXEL_MAPUSV].includes(fn)) return;
            const r = maps.decode(P.NAME_BY_OPCODE[fn], view, offset);
            s.current.state.pixelMaps[indexOf(r.map)] = r.values;
        },
        setState(s) { for (const c of s.contexts.values()) if (!c.state.pixelMaps) c.state.pixelMaps = initial(); },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
