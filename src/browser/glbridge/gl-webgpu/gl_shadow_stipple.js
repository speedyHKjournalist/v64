(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const initial = () => Array(128).fill(255);
    function layout(c, pack) {
        const value = name => c.state.values[GL[(pack ? "PACK_" : "UNPACK_") + name]]?.[0] || 0;
        const alignment = value("ALIGNMENT") || 4, pixels = value("SKIP_PIXELS");
        const row_stride = Math.ceil(Math.ceil((value("ROW_LENGTH") || 32) / 8) / alignment) * alignment;
        const start = value("SKIP_ROWS") * row_stride + Math.floor(pixels / 8), bit_offset = pixels % 8;
        const row_bytes = Math.ceil((bit_offset + 32) / 8);
        return { row_stride, start, row_bytes, bit_offset, lsb_first: value("LSB_FIRST"), span: start + 31 * row_stride + row_bytes };
    }
    const bitMask = (bit, lsb) => lsb ? 1 << (bit % 8) : 0x80 >> (bit % 8);
    function canonical(source, l, pointer = 0, compact = false) {
        const out = Array(128).fill(0);
        for (let row = 0; row < 32; ++row) for (let x = 0; x < 32; ++x) {
            const bit = l.bit_offset + x, at = pointer + (compact ? row * l.row_bytes : l.start + row * l.row_stride) + Math.floor(bit / 8);
            if (source[at] & bitMask(bit, l.lsb_first)) out[row * 4 + Math.floor(x / 8)] |= 0x80 >> (x % 8);
        }
        return out;
    }
    function answer(s, name, bytes, view, offset, size) {
        if (!s.pending(name, view, offset, size)) return;
        const fields = P.F[name], header = P.RECORDS[name].size, r = P.decodeRecord(name, view, offset), c = s.current;
        const fail = error => {
            if (c && !c.error) c.error = error;
            view.setUint32(offset + fields.error, error, true);
            s.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_FAILED);
        };
        if (!c || c.state.begin) return fail(GL.INVALID_OPERATION);
        const query = name === "QUERY_POLYGON_STIPPLE", l = layout(c, query && r.mode === 0);
        if (!Number.isSafeInteger(l.span) || l.span > 0xFFFFFFFF) return fail(GL.OUT_OF_MEMORY);
        const buffer = s.boundBuffer?.(query && r.mode === 0 ? GL.PIXEL_PACK_BUFFER : GL.PIXEL_UNPACK_BUFFER);
        if (query) {
            if (r.mode > 1 || r.data_size !== 320 || size < header + 320) return fail(GL.INVALID_VALUE);
            if (buffer && (buffer.mapped || r.pointer + l.span > buffer.size)) return fail(GL.INVALID_OPERATION);
            for (const [key, value] of Object.entries(l)) view.setUint32(offset + fields[key], value, true);
            view.setUint32(offset + fields.pbo, buffer ? 1 : 0, true);
            const output = bytes.subarray(offset + header, offset + header + 320); output.fill(0);
            if (r.mode === 0) {
                const count = 32 * l.row_bytes;
                for (let row = 0; row < 32; ++row) for (let x = 0; x < 32; ++x) {
                    const bit = l.bit_offset + x, at = row * l.row_bytes + Math.floor(bit / 8), mask = bitMask(bit, l.lsb_first);
                    output[count + at] |= mask;
                    if (c.state.polygonStipple[row * 4 + Math.floor(x / 8)] & 0x80 >> (x % 8)) output[at] |= mask;
                }
            } else if (buffer) {
                c.state.polygonStipple = canonical(buffer.data, l, r.pointer);
                output.set(c.state.polygonStipple);
            }
        } else {
            if (buffer) return fail(GL.INVALID_OPERATION);
            if (r.data_size !== l.row_bytes * 32 || size < header + Math.max(128, r.data_size)) return fail(GL.INVALID_VALUE);
            c.state.polygonStipple = canonical(bytes.subarray(offset + header, offset + header + r.data_size), l, 0, true);
            bytes.set(c.state.polygonStipple, offset + header);
        }
        view.setUint32(offset + fields.error, 0, true);
        s.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_OK);
    }
    GLShadow.prototype.queryPolygonStipple = function(...args) { answer(this, "QUERY_POLYGON_STIPPLE", ...args); };
    GLShadow.prototype.polygonStippleBitmap = function(...args) { answer(this, "POLYGON_STIPPLE_BITMAP", ...args); };
    GLShadow.install({ [P.GLFN.QUERY_POLYGON_STIPPLE]: "queryPolygonStipple", [P.GLFN.POLYGON_STIPPLE_BITMAP]: "polygonStippleBitmap" });
    GLShadow.rules({ [P.GLFN.POLYGON_STIPPLE]: s => s.current.state.begin ? GL.INVALID_OPERATION : 0 });
    state.attributes("polygonStipple", {
        capture(c, mask, client) { return !client && mask & 0x10 ? c.state.polygonStipple.slice() : null; },
        restore(c, saved) { c.state.polygonStipple = saved.slice(); },
    });
    GLShadow.part({
        context(c) { c.state.polygonStipple = initial(); },
        command(s, fn, bytes, view, offset) {
            if (fn === P.GLFN.POLYGON_STIPPLE) s.current.state.polygonStipple = Array.from(bytes.subarray(offset, offset + 128));
        },
        setState(s) { for (const c of s.contexts.values()) if (!c.state.polygonStipple) c.state.polygonStipple = initial(); },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
