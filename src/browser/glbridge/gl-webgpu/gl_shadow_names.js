// Synchronous CPU name allocation shares the same namespaces as binds and
// deletion, so glGen* cannot collide with application-chosen names (C3).
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const { C } = P;
    GLShadow.prototype.queryNames = function(bytes, view, offset, size) {
        const name = "QUERY_NAMES", header = P.RECORDS[name].size;
        if (!this.pending(name, view, offset, size)) return;
        const r = P.decodeRecord(name, view, offset);
        const fail = error => {
            if (this.current && !this.current.error) this.current.error = error;
            view.setUint32(offset + P.F[name].error, error, true);
            this.answered(name, view, offset, C.V86GL_SYNC_QUERY_STATUS_FAILED);
        };
        if (!this.current || this.current.state.begin) return fail(GL.INVALID_OPERATION);
        if (r.count < 0 || r.count * 4 > r.data_size || r.data_size > size - header) return fail(GL.INVALID_VALUE);
        const c = this.current, group = c.group;
        let names, allocate, pool, owner = group;
        switch (r.object_kind) {
        case C.V86GL_OBJECT_KIND_QUERY:
            if (c.activeQueryName) return fail(GL.INVALID_OPERATION);
            names = c.queryObjects; allocate = n => this.queryObject(n); owner = c; break;
        case C.V86GL_OBJECT_KIND_TEXTURE: names = group.textures; allocate = n => this.textureObject(n); pool = group.textureImages; break;
        case C.V86GL_OBJECT_KIND_RENDERBUFFER: names = group.renderbuffers; allocate = n => this.renderbufferObject(n); pool = group.renderbufferImages; break;
        case C.V86GL_OBJECT_KIND_BUFFER: names = group.buffers; allocate = n => this.bufferObject(n); pool = group.bufferObjects; break;
        case C.V86GL_OBJECT_KIND_FRAMEBUFFER: names = c.framebuffers; allocate = n => this.framebufferObject(n); owner = c; break;
        default: return fail(GL.INVALID_ENUM);
        }
        if (r.count > 0xFFFFFFFF - names.size) return fail(GL.OUT_OF_MEMORY);
        let next = owner.nameCursors.get(r.object_kind) || 1;
        const chosen = [], used = new Set();
        for (let i = 0; i < r.count; ++i) {
            while (names.has(next) || used.has(next)) next = (next + 1) >>> 0 || 1;
            chosen.push(next); used.add(next); next = (next + 1) >>> 0 || 1;
        }
        const created = [], nextImageId = group.nextImageId, nextBufferId = group.nextBufferId;
        try { for (const n of chosen) created.push(allocate(n)); }
        catch (_) {
            for (const object of created) { names.delete(object.name); if (pool) pool.delete(object.id); }
            group.nextImageId = nextImageId; group.nextBufferId = nextBufferId;
            return fail(GL.OUT_OF_MEMORY);
        }
        for (let i = 0; i < chosen.length; ++i) view.setUint32(offset + header + i * 4, chosen[i], true);
        if (r.count) owner.nameCursors.set(r.object_kind, next);
        this.answered(name, view, offset, C.V86GL_SYNC_QUERY_STATUS_OK);
    };
    GLShadow.install({ [P.GLFN.QUERY_NAMES]: "queryNames" });
    GLShadow.part({
        group(g) { g.nameCursors = new Map(); },
        context(c) { c.nameCursors = new Map(); },
        getState(s, saved) {
            saved.names = { groups: [...s.groups.values()].map(g => [g.key, [...g.nameCursors]]),
                contexts: [...s.contexts.values()].map(c => [c.key, [...c.nameCursors]]) };
        },
        setState(s, saved) {
            for (const [key, values] of saved.names?.groups || []) { const g = s.groups.get(key); if (g) g.nameCursors = new Map(values); }
            for (const [key, values] of saved.names?.contexts || []) { const c = s.contexts.get(key); if (c) c.nameCursors = new Map(values); }
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
