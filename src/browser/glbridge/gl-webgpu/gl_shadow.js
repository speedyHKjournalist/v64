// The CPU side's OpenGL state (docs/opengl-webgpu-plan.md C3). It lives in
// the v86gl device (v86gl_device.js), on the thread the CPU runs on, and
// reads every GL batch in guest memory before the renderer gets it: the
// guest's synchronous queries are answered there, before the device
// completes the request. So the answers are the same whether the renderer
// is on this thread or across the CPU worker's boundary, where the renderer
// only ever sees a copy (review S1-1).
//
// It takes over the answers one kind at a time. A query it does not answer
// yet keeps its PENDING status, and the page's executor answers it (which
// reaches the guest in local mode only); one it answers is no longer
// PENDING when the executor sees it, and the executor leaves it alone.
//
// Answered here so far: the capability queries (gl_caps.js, from the
// capabilities the renderer sends once its adapter is up), and with glslang
// (gl_glslang.js) the shaders' and programs' (gl_shadow_glsl.js).
//
// The parts: this file walks the records and keeps the contexts and their
// share groups; the others add handlers (GLShadow.install) and the state
// they keep (GLShadow.parts), to snapshots too.

(function(global) {
    "use strict";

    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const glCaps = global.GLCaps || require("./gl_caps.js");
    const { GLFN, CTRL, C, F, RECORDS } = protocol;

    const OK = C.V86GL_SYNC_QUERY_STATUS_OK;
    const PENDING = C.V86GL_SYNC_QUERY_STATUS_PENDING;
    const EXTENDED_RECORD_SIZE = C.V86GL_EXTENDED_RECORD_SIZE;

    // record code -> method; the parts add theirs
    const HANDLERS = new Map();
    // CPU rules run before any state mutation or query handler. Returning a
    // GL error suppresses the original command in both halves of the stream.
    const RULES = new Map();
    // glGetIntegerv and glGetString pnames the parts answer: pname -> method
    // of the shadow, giving the value (undefined: not this side's yet)
    const INTEGERS = new Map(), STRINGS = new Map();
    // { reset(shadow), group(group), context(context), getState(shadow, state), setState(shadow, state) }
    // of each part
    const PARTS = [];

    class GLShadow {
        constructor() {
            // gl_caps.js's capabilities object; none until the renderer sends it
            this.capabilities = null;
            // gl_glslang.js's Glslang; none until the renderer sends the module
            this.glslang = null;
            this.stats = { batches: 0, records: 0, answered: 0, malformed: 0, rejected: 0 };
            this.reset();
        }

        // fn -> the method's name, for a part
        static install(handlers) {
            for (const [fn, method] of Object.entries(handlers)) HANDLERS.set(+fn, method);
        }

        static rules(rules) {
            for (const [fn, rule] of Object.entries(rules)) RULES.set(+fn, rule);
        }

        // pname -> the method's name, for a part's glGetIntegerv and glGetString
        static queries({ integers, strings }) {
            for (const [pname, method] of Object.entries(integers || {})) INTEGERS.set(+pname, method);
            for (const [pname, method] of Object.entries(strings || {})) STRINGS.set(+pname, method);
        }

        static part(part) {
            PARTS.push(part);
        }

        // A new owner of the arena, or a reset machine: no contexts
        reset() {
            this.contexts = new Map();
            this.groups = new Map();
            this.nextGroup = 1;
            this.current = null;
            for (const part of PARTS) if (part.reset) part.reset(this);
        }

        setCapabilities(capabilities) {
            this.capabilities = capabilities;
        }

        setGlslang(glslang) {
            this.glslang = glslang;
        }

        /*
         * One GL batch's records, in guest memory (a view the answers are
         * written into). A malformed stream stops the walk: the executor
         * reports it.
         */
        process(bytes) {
            ++this.stats.batches;
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const end = bytes.byteLength;
            let offset = 0;
            while (offset + 4 <= end) {
                const recordOffset = offset;
                const fn = view.getUint16(offset, true);
                let size = view.getUint16(offset + 2, true);
                offset += 4;
                if (size === EXTENDED_RECORD_SIZE) {
                    if (offset + 4 > end) break;
                    size = view.getUint32(offset, true);
                    offset += 4;
                }
                if (offset + size > end) {
                    ++this.stats.malformed;
                    return;
                }
                ++this.stats.records;
                const error = this.dispatch(fn, bytes, view, offset, size);
                if (error) {
                    if (this.current && !this.current.error) this.current.error = error;
                    view.setUint16(recordOffset, protocol.rejectedOpcode(fn, error), true);
                    ++this.stats.rejected;
                }
                offset += size;
            }
            if (offset !== end) ++this.stats.malformed;
        }

        dispatch(fn, bytes, view, offset, size) {
            if (protocol.isRejected(fn)) {
                if (this.current && !this.current.error) this.current.error = protocol.rejectionError(fn);
                return;
            }
            const name = protocol.NAME_BY_OPCODE[fn];
            const signature = protocol.SIGNATURES[name];
            const header = RECORDS[name];
            const minimum = signature ? protocol.payloadBytes(signature[1]) : header ? header.size : 0;
            if (size < minimum) { ++this.stats.malformed; return; }
            const rule = RULES.get(fn);
            if (rule && this.current) {
                const error = rule(this, bytes, view, offset, size);
                if (error) return error;
            }
            // Keep our partial error state consumed by legacy glGetError;
            // it is not authoritative until every command family has rules.
            if (fn === GLFN.QUERY_ERROR && this.current) this.current.error = 0;
            for (const part of PARTS) if (part.command) part.command(this, fn, bytes, view, offset, size);
            const method = HANDLERS.get(fn);
            if (!method) return;
            // (a GL command needs a context; one without is the executor's to report)
            if (fn < 0xFF00 && fn !== GLFN.QUERY_INTEGER && fn !== GLFN.QUERY_GL_STRING &&
                    fn !== GLFN.QUERY_STATE && fn !== GLFN.QUERY_PARAMETER && !this.current) return;
            this[method](bytes, view, offset, size);
        }

        // A flat record's arguments, or null when it is short
        args(name, view, offset, size) {
            const out = [];
            return protocol.decodeArgs(protocol.SIGNATURES[name][1], view, offset, size, out) < 0 ? null : out;
        }

        // An older guest's MAKE_CURRENT stops short; the fields after read as 0
        field(name, field, view, offset, size) {
            const at = F[name][field];
            return at + 4 <= size ? view.getUint32(offset + at, true) : 0;
        }

        // Keyed as the executor keys them: by the guest's context id, or by
        // the window for a guest too old to send one. Objects belong to the
        // share group: the guest's, or the context's own.
        makeCurrent(bytes, view, offset, size) {
            const id = this.field("MAKE_CURRENT", "context_id", view, offset, size);
            const hwnd = this.field("MAKE_CURRENT", "hwnd", view, offset, size);
            const key = id ? "context:" + id : "hwnd:" + hwnd;
            let context = this.contexts.get(key);
            if (!context) {
                const shareGroup = this.field("MAKE_CURRENT", "share_group", view, offset, size);
                context = this.createContext(key, id, shareGroup ? "guest:" + shareGroup : "private:" + this.nextGroup++);
            }
            this.current = context;
            for (const part of PARTS) if (part.current) part.current(this, context, view, offset, size);
        }

        createContext(key, id, groupKey) {
            let group = this.groups.get(groupKey);
            if (!group) {
                group = { key: groupKey };
                for (const part of PARTS) if (part.group) part.group(group);
                this.groups.set(groupKey, group);
            }
            const context = { key, id, group, program: 0, error: 0 };
            for (const part of PARTS) if (part.context) part.context(context);
            this.contexts.set(key, context);
            return context;
        }

        releaseCurrent() {
            this.current = null;
        }

        destroyContext(bytes, view, offset, size) {
            if (size < RECORDS.DESTROY_CONTEXT.size) {
                this.reset();
                return;
            }
            const key = "context:" + view.getUint32(offset + F.DESTROY_CONTEXT.context_id, true);
            if (this.current && this.current.key === key) this.current = null;
            this.contexts.delete(key);
            // a share group goes with its last context
            for (const [groupKey, group] of this.groups)
                if (![...this.contexts.values()].some(c => c.group === group)) this.groups.delete(groupKey);
        }

        // Whether a query record is still the guest's to have answered
        pending(name, view, offset, size) {
            return size >= RECORDS[name].size && view.getUint32(offset + F[name].status, true) === PENDING;
        }

        answered(name, view, offset, status) {
            view.setUint32(offset + F[name].status, status, true);
            ++this.stats.answered;
        }

        // A name list record (GEN_*, DELETE_*, DRAW_BUFFERS): the names, or null
        names(name, view, offset, size) {
            if (size < RECORDS[name].size) return null;
            const count = view.getUint32(offset + F[name].count, true);
            if (RECORDS[name].size + count * 4 > size) return null;
            const names = [];
            for (let i = 0; i < count; ++i) names.push(view.getUint32(offset + RECORDS[name].size + i * 4, true));
            return names;
        }

        // A capability, or a part's state (with a context)
        integer(pname) {
            const value = glCaps.integer(this.capabilities, pname);
            const method = INTEGERS.get(pname);
            return value !== undefined || !method || !this.current ? value : this[method](pname);
        }

        string(pname) {
            const value = glCaps.string(this.capabilities, pname);
            const method = STRINGS.get(pname);
            return value !== undefined || !method || !this.current ? value : this[method](pname);
        }

        queryInteger(bytes, view, offset, size) {
            if (!this.capabilities || !this.pending("QUERY_INTEGER", view, offset, size)) return;
            const value = this.integer(view.getUint32(offset + F.QUERY_INTEGER.pname, true));
            if (value === undefined) return;
            view.setUint32(offset + F.QUERY_INTEGER.value, value >>> 0, true);
            view.setUint32(offset + F.QUERY_INTEGER.status, OK, true);
            ++this.stats.answered;
        }

        // {name, status, length, data_size} then data_size bytes for the
        // text; length counts its terminator, which is written when it fits
        queryString(bytes, view, offset, size) {
            if (!this.capabilities || !this.pending("QUERY_GL_STRING", view, offset, size)) return;
            const text = this.string(view.getUint32(offset + F.QUERY_GL_STRING.name, true));
            const capacity = view.getUint32(offset + F.QUERY_GL_STRING.data_size, true);
            const header = RECORDS.QUERY_GL_STRING.size;
            if (text === undefined || header + capacity > size) return;
            const limit = Math.min(text.length + 1, capacity);
            for (let i = 0; i < limit; ++i)
                bytes[offset + header + i] = i < text.length ? text.charCodeAt(i) & 0xff : 0;
            view.setUint32(offset + F.QUERY_GL_STRING.length, text.length + 1, true);
            view.setUint32(offset + F.QUERY_GL_STRING.status, OK, true);
            ++this.stats.answered;
        }

        getState() {
            const state = {
                capabilities: this.capabilities,
                nextGroup: this.nextGroup,
                contexts: [...this.contexts.values()].map(c => ({ key: c.key, id: c.id, group: c.group.key,
                    program: c.program, error: c.error })),
                current: this.current ? this.current.key : null,
            };
            for (const part of PARTS) if (part.getState) part.getState(this, state);
            return state;
        }

        // A snapshot's capabilities stand: the guest was told those
        setState(state) {
            this.reset();
            if (!state) return;
            this.capabilities = state.capabilities || null;
            this.nextGroup = state.nextGroup || 1;
            for (const c of state.contexts || []) {
                const context = this.createContext(c.key, c.id, c.group || "private:" + c.key);
                context.program = c.program || 0;
                context.error = c.error || 0;
            }
            this.current = state.current ? this.contexts.get(state.current) || null : null;
            for (const part of PARTS) if (part.setState) part.setState(this, state);
        }
    }

    GLShadow.install({
        [CTRL.MAKE_CURRENT]: "makeCurrent",
        [CTRL.RELEASE_CURRENT]: "releaseCurrent",
        [CTRL.DESTROY_CONTEXT]: "destroyContext",
        [GLFN.QUERY_INTEGER]: "queryInteger",
        [GLFN.QUERY_GL_STRING]: "queryString",
    });

    const api = { GLShadow };
    global.V86GLShadow = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
