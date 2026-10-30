// Wire decoding shared by the CPU state and the renderer. The three
// PixelMap records carry their original element types, including u16.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    function decode(name, view, offset) {
        const r = P.decodeRecord(name, view, offset), color = r.map >= GL.PIXEL_MAP_I_TO_R;
        const stride = name === "PIXEL_MAPUSV" ? 2 : 4, max = name === "PIXEL_MAPUSV" ? 65535 : 0xFFFFFFFF;
        const values = Array.from({ length: r.count }, (_, i) => {
            const at = offset + P.RECORDS[name].size + i * stride;
            const value = name === "PIXEL_MAPFV" ? view.getFloat32(at, true) : stride === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
            return color ? Math.fround(Math.max(0, Math.min(1, name === "PIXEL_MAPFV" ? value : value / max))) : value;
        });
        return { map: r.map, values };
    }
    const api = { decode };
    global.GLPixelMaps = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
