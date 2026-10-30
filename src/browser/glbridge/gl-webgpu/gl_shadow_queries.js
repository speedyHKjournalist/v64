// Occlusion query names and logical state are private to each context. Only
// completed GPU counts/availability need the renderer (GL 2.1 4.1.7, C3/C7).
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const targets = new Set([GL.SAMPLES_PASSED, GL.ANY_SAMPLES_PASSED, GL.ANY_SAMPLES_PASSED_CONSERVATIVE]);
    GLShadow.prototype.queryObject = function(name) {
        const objects = this.current.queryObjects;
        let object = objects.get(name);
        if (!object) objects.set(name, object = { name, target: 0, created: false, active: false });
        return object;
    };
    for (const name of ["GEN_QUERIES", "DELETE_QUERIES"]) {
        GLShadow.rules({ [P.GLFN[name]]: (s, b, v, o, size) => {
            if (s.current.state.begin || s.current.activeQueryName) return GL.INVALID_OPERATION;
            const count = v.getInt32(o, true); return count < 0 || 4 + count * 4 > size ? GL.INVALID_VALUE : 0;
        } });
        const method = "shadow" + name;
        GLShadow.prototype[method] = function(bytes, view, offset, size) {
            for (const id of this.names(name, view, offset, size) || []) if (id) {
                if (name === "GEN_QUERIES") this.queryObject(id); else this.current.queryObjects.delete(id);
            }
        };
        GLShadow.install({ [P.GLFN[name]]: method });
    }
    state.rule("BEGIN_QUERY", (c, [target, id]) => {
        if (!targets.has(target)) return GL.INVALID_ENUM;
        const query = c.queryObjects.get(id);
        return !id || c.activeQueryName || query?.active || query?.target && query.target !== target ? GL.INVALID_OPERATION : 0;
    });
    state.on("BEGIN_QUERY", (c, [target, id], s) => {
        Object.assign(s.queryObject(id), { target, created: true, active: true }); c.activeQueryName = id;
    });
    state.rule("END_QUERY", (c, [target]) => !targets.has(target) ? GL.INVALID_ENUM :
        !c.activeQueryName || c.queryObjects.get(c.activeQueryName).target !== target ? GL.INVALID_OPERATION : 0);
    state.on("END_QUERY", c => { c.queryObjects.get(c.activeQueryName).active = false; c.activeQueryName = 0; });
    state.parameter(P.C.V86GL_PARAMETER_QUERY_TARGET, (s, target, pname) => {
        if (!targets.has(target)) return GL.INVALID_ENUM;
        if (pname === GL.QUERY_COUNTER_BITS) return [[target === GL.SAMPLES_PASSED ? 31 : 1], "i"];
        if (pname === GL.CURRENT_QUERY) return [[s.current.queryObjects.get(s.current.activeQueryName)?.target === target ? s.current.activeQueryName : 0], "u"];
        return GL.INVALID_ENUM;
    });
    GLShadow.part({
        context(c) { c.queryObjects = new Map(); c.activeQueryName = 0; },
        checkCommand(s, fn, bytes, view, offset, size) {
            const single = fn === P.GLFN.QUERY_OBJECT_IV, batch = fn === P.GLFN.QUERY_OBJECT_BATCH;
            if (!single && !batch) return 0;
            const name = single ? "QUERY_OBJECT_IV" : "QUERY_OBJECT_BATCH", r = P.decodeRecord(name, view, offset);
            if (r.object_kind !== P.C.V86GL_OBJECT_KIND_QUERY) return 0;
            if (!s.pending(name, view, offset, size)) return 0;
            const fail = error => { if (!s.current.error) s.current.error = error;
                if (single) view.setUint32(offset + P.F.QUERY_OBJECT_IV.reserved, error, true);
                s.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_FAILED); return 0; };
            if (s.current.state.begin) return fail(GL.INVALID_OPERATION);
            const valid = id => !!s.current.queryObjects.get(id)?.created && !s.current.queryObjects.get(id).active;
            if (single) {
                if (!valid(r.name)) return fail(GL.INVALID_OPERATION);
                if (![GL.QUERY_RESULT, GL.QUERY_RESULT_AVAILABLE].includes(r.pname)) return fail(GL.INVALID_ENUM);
            } else {
                if (P.RECORDS[name].size + r.count * P.RECORDS.QUERY_OBJECT_BATCH_ENTRY.size > size) return fail(GL.INVALID_VALUE);
                for (let i = 0; i < r.count; ++i) if (!valid(view.getUint32(offset + P.RECORDS[name].size + i * P.RECORDS.QUERY_OBJECT_BATCH_ENTRY.size, true)))
                    return fail(GL.INVALID_OPERATION);
            }
            return 0;
        },
        getState(s, saved) { saved.queryObjects = [...s.contexts.values()].map(c => [c.key, [...c.queryObjects], c.activeQueryName]); },
        setState(s, saved) { for (const [key, queries, active] of saved.queryObjects || []) {
            const c = s.contexts.get(key); if (c) { c.queryObjects = new Map(queries); c.activeQueryName = active; }
        } },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
