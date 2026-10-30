// Queryable fixed-function scalar/vector families: fog, point parameters,
// pixel transfer/zoom, logic operation and the current edge flag (plan C3).
(function(global) {
    "use strict";
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const clamp = v => Math.max(0, Math.min(1, v));
    state.define("FOG_MODE", [GL.EXP], "i", 0x80);
    state.define("FOG_DENSITY FOG_END", [1], "f", 0x80);
    state.define("FOG_START FOG_INDEX", [0], "f", 0x80);
    state.define("FOG_COORD_SRC", [GL.FRAGMENT_DEPTH], "i", 0x80);
    state.define("FOG_COLOR", [0, 0, 0, 0], "n", 0x80);
    const FOG = new Set([GL.FOG_MODE, GL.FOG_DENSITY, GL.FOG_START, GL.FOG_END, GL.FOG_INDEX, GL.FOG_COORD_SRC, GL.FOG_COLOR]);
    for (const name of ["FOGF", "FOGI", "FOGFV"]) {
        state.rule(name, (c, a) => {
            const p = a[0], vector = name === "FOGFV", v = a[vector ? 2 : 1];
            if (!FOG.has(p) || !vector && p === GL.FOG_COLOR) return GL.INVALID_ENUM;
            if (vector && a[1] < (p === GL.FOG_COLOR ? 4 : 1)) return GL.INVALID_VALUE;
            if (p === GL.FOG_MODE && ![GL.LINEAR, GL.EXP, GL.EXP2].includes(v) ||
                    p === GL.FOG_COORD_SRC && ![GL.FOG_COORD, GL.FRAGMENT_DEPTH].includes(v)) return GL.INVALID_ENUM;
            return p === GL.FOG_DENSITY && v < 0 ? GL.INVALID_VALUE : 0;
        });
        state.on(name, (c, a) => state.set(c, a[0], a[0] === GL.FOG_COLOR ? a.slice(2, 6).map(clamp) : [Math.fround(a[name === "FOGFV" ? 2 : 1]) ]));
    }
    state.define("POINT_SIZE_MIN", [0], "f", 2);
    state.define("POINT_SIZE_MAX", [64], "f", 2);
    state.define("POINT_FADE_THRESHOLD_SIZE", [1], "f", 2);
    state.define("POINT_DISTANCE_ATTENUATION", [1, 0, 0], "f", 2);
    state.define("POINT_SPRITE_COORD_ORIGIN", [GL.UPPER_LEFT], "i", 2);
    const POINT = new Set([GL.POINT_SIZE_MIN, GL.POINT_SIZE_MAX, GL.POINT_FADE_THRESHOLD_SIZE,
        GL.POINT_DISTANCE_ATTENUATION, GL.POINT_SPRITE_COORD_ORIGIN]);
    for (const name of ["POINT_PARAMETERF", "POINT_PARAMETERI", "POINT_PARAMETERFV", "POINT_PARAMETERIV"]) {
        state.rule(name, (c, a) => {
            const p = a[0];
            if (!POINT.has(p) || p === GL.POINT_DISTANCE_ATTENUATION && !name.endsWith("V")) return GL.INVALID_ENUM;
            if (p === GL.POINT_SPRITE_COORD_ORIGIN) return [GL.LOWER_LEFT, GL.UPPER_LEFT].includes(a[1]) ? 0 : GL.INVALID_ENUM;
            return p !== GL.POINT_DISTANCE_ATTENUATION && a[1] < 0 ? GL.INVALID_VALUE : 0;
        });
        state.on(name, (c, a) => state.set(c, a[0], a.slice(1, a[0] === GL.POINT_DISTANCE_ATTENUATION ? 4 : 2).map(Math.fround)));
    }
    const TRANSFER = new Map();
    function transfer(names, initial, kind) {
        state.define(names, [initial], kind, 0x20);
        for (const name of names.split(" ")) TRANSFER.set(GL[name], kind);
    }
    transfer("RED_SCALE GREEN_SCALE BLUE_SCALE ALPHA_SCALE DEPTH_SCALE POST_COLOR_MATRIX_RED_SCALE_SGI " +
        "POST_COLOR_MATRIX_GREEN_SCALE_SGI POST_COLOR_MATRIX_BLUE_SCALE_SGI POST_COLOR_MATRIX_ALPHA_SCALE_SGI", 1, "f");
    transfer("RED_BIAS GREEN_BIAS BLUE_BIAS ALPHA_BIAS DEPTH_BIAS POST_COLOR_MATRIX_RED_BIAS_SGI " +
        "POST_COLOR_MATRIX_GREEN_BIAS_SGI POST_COLOR_MATRIX_BLUE_BIAS_SGI POST_COLOR_MATRIX_ALPHA_BIAS_SGI", 0, "f");
    transfer("MAP_COLOR MAP_STENCIL", 0, "b");
    transfer("INDEX_SHIFT INDEX_OFFSET", 0, "i");
    for (const name of ["PIXEL_TRANSFERF", "PIXEL_TRANSFERI"]) {
        state.rule(name, (c, a) => TRANSFER.has(a[0]) ? 0 : GL.INVALID_ENUM);
        state.on(name, (c, [p, v]) => state.set(c, p, [TRANSFER.get(p) === "b" ? +!!v : TRANSFER.get(p) === "i" ? Math.round(v) : Math.fround(v)]));
    }
    state.define("ZOOM_X ZOOM_Y", [1], "f", 0x20);
    state.rule("PIXEL_ZOOM");
    state.on("PIXEL_ZOOM", (c, a) => { state.set(c, GL.ZOOM_X, [a[0]]); state.set(c, GL.ZOOM_Y, [a[1]]); });
    state.define("LOGIC_OP_MODE", [GL.COPY], "i", 0x4000);
    state.rule("LOGIC_OP", (c, a) => a[0] >= GL.CLEAR_LOGIC_OP && a[0] <= GL.SET ? 0 : GL.INVALID_ENUM);
    state.on("LOGIC_OP", (c, a) => state.set(c, GL.LOGIC_OP_MODE, a));
    state.define("CURRENT_EDGE_FLAG", [1], "b", 1);
    state.rule("EDGE_FLAG", null, true);
    state.on("EDGE_FLAG", (c, a) => state.set(c, GL.CURRENT_EDGE_FLAG, [+!!a[0]]), true);
})(typeof globalThis !== "undefined" ? globalThis : this);
