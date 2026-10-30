// Buffer names, retained identities, storage and CPU queries (plan C3/C6).
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const targets = new Set([GL.ARRAY_BUFFER, GL.ELEMENT_ARRAY_BUFFER, GL.PIXEL_PACK_BUFFER, GL.PIXEL_UNPACK_BUFFER]);
    const usages = new Set([0x88E0, 0x88E1, 0x88E2, 0x88E4, 0x88E5, 0x88E6, 0x88E8, 0x88E9, 0x88EA]);
    const proto = GLShadow.prototype;
    proto.bufferObject = function(name) {
        const group = this.current.group;
        let buffer = group.buffers.get(name);
        if (!buffer) {
            buffer = { name, id: group.nextBufferId++, created: false, deleted: false, size: 0, usage: GL.STATIC_DRAW_ARB, data: null };
            group.buffers.set(name, buffer); group.bufferObjects.set(buffer.id, buffer);
        }
        return buffer;
    };
    proto.boundBuffer = function(target) {
        return this.current.group.bufferObjects.get(this.current.bufferBindings.get(target));
    };
    for (const name of ["GEN_BUFFERS", "DELETE_BUFFERS"]) {
        GLShadow.rules({ [P.GLFN[name]]: (s, b, v, o, size) => {
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            const count = v.getInt32(o, true);
            return count < 0 || count * 4 + 4 > size ? GL.INVALID_VALUE : 0;
        } });
        const method = "shadow" + name;
        proto[method] = function(bytes, v, o) {
            const s = this, c = s.current;
            const count = v.getUint32(o, true);
            for (let i = 0; i < count; ++i) {
                const name = v.getUint32(o + 4 + i * 4, true);
                if (!name) continue;
                if (method === "shadowGEN_BUFFERS") s.bufferObject(name);
                else {
                    const buffer = c.group.buffers.get(name); if (!buffer) continue;
                    c.group.buffers.delete(name); buffer.deleted = true;
                    for (const [target, id] of c.bufferBindings) if (id === buffer.id) c.bufferBindings.delete(target);
                }
            }
        };
        GLShadow.install({ [P.GLFN[name]]: method });
    }
    state.rule("BIND_BUFFER", (c, [target]) => targets.has(target) ? 0 : GL.INVALID_ENUM);
    state.on("BIND_BUFFER", (c, [target, name], s) => {
        if (!name) c.bufferBindings.delete(target);
        else { const buffer = s.bufferObject(name); buffer.created = true; c.bufferBindings.set(target, buffer.id); }
    });
    for (const name of ["BUFFER_DATA", "BUFFER_SUB_DATA"]) {
        GLShadow.rules({ [P.GLFN[name]]: (s, b, v, o, size) => {
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            const r = P.decodeRecord(name, v, o);
            if (!targets.has(r.target)) return GL.INVALID_ENUM;
            if (r.size < 0 || name === "BUFFER_SUB_DATA" && r.offset < 0) return GL.INVALID_VALUE;
            if (name === "BUFFER_DATA" && !usages.has(r.usage)) return GL.INVALID_ENUM;
            const buffer = s.boundBuffer(r.target); if (!buffer) return GL.INVALID_OPERATION;
            if (r.data_size > size - P.RECORDS[name].size || r.data_size && r.data_size < r.size ||
                name === "BUFFER_SUB_DATA" && (r.offset + r.size > buffer.size || r.data_size < r.size)) return GL.INVALID_VALUE;
            if (name === "BUFFER_DATA") {
                try { s.pendingBufferData = new Uint8Array(r.size); }
                catch (_) { return GL.OUT_OF_MEMORY; }
            }
            return 0;
        } });
        const method = "shadow" + name;
        proto[method] = function(bytes, v, o) {
            const s = this;
            const r = P.decodeRecord(name, v, o), buffer = s.boundBuffer(r.target);
            const data = new Uint8Array(v.buffer, v.byteOffset + o + P.RECORDS[name].size, Math.min(r.data_size, r.size));
            if (name === "BUFFER_DATA") {
                buffer.data = s.pendingBufferData; delete s.pendingBufferData;
                buffer.size = r.size; buffer.usage = r.usage;
            }
            if (data.length) buffer.data.set(data, name === "BUFFER_DATA" ? 0 : r.offset);
        };
        GLShadow.install({ [P.GLFN[name]]: method });
    }
    for (const [pname, target] of [[GL.ARRAY_BUFFER_BINDING, GL.ARRAY_BUFFER], [GL.ELEMENT_ARRAY_BUFFER_BINDING, GL.ELEMENT_ARRAY_BUFFER],
            [GL.PIXEL_PACK_BUFFER_BINDING, GL.PIXEL_PACK_BUFFER], [GL.PIXEL_UNPACK_BUFFER_BINDING, GL.PIXEL_UNPACK_BUFFER]])
        state.query([pname], s => [[s.boundBuffer(target)?.name || 0], "u"]);
    state.parameter(P.C.V86GL_PARAMETER_BUFFER, (s, target, pname) => {
        if (!targets.has(target)) return GL.INVALID_ENUM;
        const buffer = s.boundBuffer(target); if (!buffer) return GL.INVALID_OPERATION;
        if (pname === GL.BUFFER_SIZE_ARB) return [[buffer.size], "i"];
        if (pname === GL.BUFFER_USAGE_ARB) return [[buffer.usage], "e"];
        // Mapping and guest pointers have not been migrated yet.
        if ([GL.BUFFER_ACCESS_ARB, GL.BUFFER_MAPPED_ARB, GL.BUFFER_MAP_POINTER_ARB].includes(pname)) return null;
        return GL.INVALID_ENUM;
    });
    state.attributes("buffers", {
        capture(c, mask, client) {
            if (!client) return null;
            return [...targets].filter(target => target === GL.PIXEL_PACK_BUFFER || target === GL.PIXEL_UNPACK_BUFFER ? mask & 1 : mask & 2)
                .map(target => [target, c.bufferBindings.get(target) || 0]);
        },
        restore(c, saved) {
            for (const [target, id] of saved) { if (id) c.bufferBindings.set(target, id); else c.bufferBindings.delete(target); }
        },
    });
    GLShadow.part({
        group(g) { g.buffers = new Map(); g.bufferObjects = new Map(); g.nextBufferId = 1; },
        context(c) { c.bufferBindings = new Map(); },
        getState(s, saved) {
            saved.buffers = { groups: [...s.groups.values()].map(g => ({ key: g.key, nextBufferId: g.nextBufferId,
                objects: [...g.bufferObjects.values()].map(b => ({ ...b, data: b.data && Array.from(b.data) })) })),
            contexts: [...s.contexts.values()].map(c => [c.key, [...c.bufferBindings]]) };
        },
        setState(s, saved) {
            for (const item of saved.buffers?.groups || []) {
                const g = s.groups.get(item.key); if (!g) continue; g.nextBufferId = item.nextBufferId;
                for (const data of item.objects) {
                    const buffer = { ...data, data: data.data && Uint8Array.from(data.data) };
                    g.bufferObjects.set(buffer.id, buffer); if (!buffer.deleted) g.buffers.set(buffer.name, buffer);
                }
            }
            for (const [key, bindings] of saved.buffers?.contexts || []) { const c = s.contexts.get(key); if (c) c.bufferBindings = new Map(bindings); }
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
