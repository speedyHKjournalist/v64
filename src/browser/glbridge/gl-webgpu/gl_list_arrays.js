// Freeze VBO inputs when a draw is compiled, using the packed draw ABI. The
// list then owns only the referenced elements, independent of buffer names,
// later uploads, deletion and the caller's current client-array formats.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const scalarBytes = new Map([[GL.BYTE, 1], [GL.UNSIGNED_BYTE, 1], [GL.SHORT, 2], [GL.UNSIGNED_SHORT, 2],
        [GL.INT, 4], [GL.UNSIGNED_INT, 4], [GL.FLOAT, 4], [GL.DOUBLE, 8]]);
    const direct = new Set(["DRAW_ARRAYS_DIRECT", "DRAW_ELEMENTS_DIRECT", "DRAW_RANGE_ELEMENTS_DIRECT", "MULTI_DRAW_ARRAYS_DIRECT", "MULTI_DRAW_ELEMENTS_DIRECT"]);
    const packedNames = new Set(["DRAW_ARRAYS", "DRAW_ELEMENTS", "DRAW_ARRAYS_GL2", "DRAW_ELEMENTS_GL2"]);
    const indexSizes = new Map([[GL.UNSIGNED_BYTE, 1], [GL.UNSIGNED_SHORT, 2], [GL.UNSIGNED_INT, 4]]);
    const LIMIT = 64 * 1024 * 1024;
    function record(opcode, chunks) {
        const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0), extended = size >= 0xFFFF;
        const out = new Uint8Array(size + (extended ? 8 : 4)), view = new DataView(out.buffer);
        view.setUint16(0, opcode, true); view.setUint16(2, extended ? 0xFFFF : size, true); if (extended) view.setUint32(4, size, true);
        let at = out.length - size; for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; } return out;
    }
    function reject(fn, error) { return [record(P.rejectedOpcode(fn, error), [])]; }
    function packed(shadow, fn, mode, count, first, indexType, indexOffset) {
        const c = shadow.current, a = c.state.arrays;
        if (mode > GL.POLYGON) return reject(fn, GL.INVALID_ENUM);
        if (count < 0 || first < 0) return reject(fn, GL.INVALID_VALUE);
        const indexed = indexType !== null, indexBytes = indexed ? indexSizes.get(indexType) : 0;
        if (indexed && !indexBytes) return reject(fn, GL.INVALID_ENUM);
        if (!count) return [];
        if (count > LIMIT / 4) return reject(fn, GL.OUT_OF_MEMORY);
        const indices = indexed ? new Uint32Array(count) : null, elements = [], seen = new Map();
        if (indexed) {
            const buffer = shadow.boundBuffer(GL.ELEMENT_ARRAY_BUFFER);
            if (!buffer || buffer.mapped || indexOffset + count * indexBytes > buffer.size) return reject(fn, GL.INVALID_OPERATION);
            const view = new DataView(buffer.data.buffer, buffer.data.byteOffset, buffer.data.length);
            for (let i = 0; i < count; ++i) {
                const at = indexOffset + i * indexBytes, index = indexBytes === 1 ? view.getUint8(at) : indexBytes === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
                if (!seen.has(index)) { seen.set(index, elements.length); elements.push(index); }
                indices[i] = seen.get(index);
            }
        } else for (let i = 0; i < count; ++i) elements.push(first + i);
        const arrays = [[a.vertex, c.state.raster.client[GL.VERTEX_ARRAY]], [a.color, c.state.raster.client[GL.COLOR_ARRAY]],
            [a.normal, c.state.raster.client[GL.NORMAL_ARRAY]], ...a.texCoord.map((array, i) => [array, c.state.raster.texcoord[i]]),
            [a.secondaryColor, c.state.raster.client[GL.SECONDARY_COLOR_ARRAY_EXT]], [a.fogCoord, c.state.raster.client[GL.FOG_COORDINATE_ARRAY_EXT]]];
        const generic = a.generic.map((array, index) => [array, array.enabled, index]).filter(([, enabled]) => enabled);
        const blocks = []; let total = indexed ? indices.byteLength : 0;
        for (const [array, enabled, index] of [...arrays, ...generic]) {
            const elementSize = array.size * (scalarBytes.get(array.type) || 0), dataSize = enabled ? elements.length * elementSize : 0;
            total += dataSize + (index === undefined ? 20 : 28);
            if (total > LIMIT) return reject(fn, GL.OUT_OF_MEMORY);
            const data = new Uint8Array(dataSize);
            if (enabled) {
                const buffer = c.group.bufferObjects.get(array.bufferId), stride = array.stride || elementSize;
                if (!buffer || buffer.mapped || !elementSize) return reject(fn, GL.INVALID_OPERATION);
                for (let i = 0; i < elements.length; ++i) {
                    const at = array.pointer + elements[i] * stride;
                    if (!Number.isSafeInteger(at) || at + elementSize > buffer.size) return reject(fn, GL.INVALID_OPERATION);
                    data.set(buffer.data.subarray(at, at + elementSize), i * elementSize);
                }
            }
            blocks.push(P.encodeRecord(index === undefined ? "CLIENT_ARRAY_BLOCK" : "GENERIC_ATTRIB_BLOCK",
                { index, normalized: +!!array.normalized, enabled: +!!enabled, size: array.size, type: array.type, stride: elementSize, data_size: dataSize }), data);
        }
        const gl2 = !!generic.length, name = indexed ? "DRAW_ELEMENTS" : "DRAW_ARRAYS", opcode = P.GLFN[name + (gl2 ? "_GL2" : "")];
        const header = P.encodeRecord("PACKED_" + name + (gl2 ? "_GL2_MT" : "_MT"), { mode, count, type: GL.UNSIGNED_INT,
            index_data_size: indexed ? indices.byteLength : 0, magic: P.C.CLIENT_ARRAY_MT_MAGIC,
            tex_unit_count: (a.texCoord.length | P.C.CLIENT_ARRAY_MT_SECONDARY_COLOR_BIT | P.C.CLIENT_ARRAY_MT_FOG_COORD_BIT) >>> 0,
            client_active_texture: c.state.clientTexture, generic_attrib_count: generic.length });
        return [record(opcode, [header, ...(indexed ? [new Uint8Array(indices.buffer)] : []), ...blocks])];
    }
    function capture(shadow, fn, bytes, view, offset, size) {
        const name = P.NAME_BY_OPCODE[fn];
        if (!direct.has(name) && !packedNames.has(name)) return null;
        const error = shadow.arrayInputError?.(fn); if (error) return reject(fn, error);
        if (!direct.has(name)) return null;
        const r = name === "DRAW_ARRAYS_DIRECT" ? { mode: view.getUint32(offset, true), first: view.getInt32(offset + 4, true), count: view.getInt32(offset + 8, true) } :
            P.decodeRecord(name, view, offset);
        if (name === "DRAW_RANGE_ELEMENTS_DIRECT" && r.end < r.start) return reject(fn, GL.INVALID_VALUE);
        if (!name.startsWith("MULTI_")) return packed(shadow, fn, r.mode, r.count, r.first || 0,
            name.includes("ELEMENTS") ? r.type : null, r.offset || 0);
        const header = P.RECORDS[name].size;
        if (r.primcount < 0 || r.primcount * 8 > size - header) return reject(fn, GL.INVALID_VALUE);
        if (r.mode > GL.POLYGON || name.includes("ELEMENTS") && !indexSizes.has(r.type)) return reject(fn, GL.INVALID_ENUM);
        const out = [];
        for (let i = 0; i < r.primcount; ++i) {
            const at = offset + header + i * 8, indexed = name === "MULTI_DRAW_ELEMENTS_DIRECT";
            out.push(...packed(shadow, fn, r.mode, view.getInt32(at + (indexed ? 0 : 4), true),
                indexed ? 0 : view.getInt32(at, true), indexed ? r.type : null, indexed ? view.getUint32(at + 4, true) : 0));
        }
        return out;
    }
    const api = { capture, record };
    global.GLListArrays = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
