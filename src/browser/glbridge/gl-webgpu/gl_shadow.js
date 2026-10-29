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
// capabilities the renderer sends once its adapter is up).

(function(global) {
    "use strict";

    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const glCaps = global.GLCaps || require("./gl_caps.js");
    const { GLFN, CTRL, C, F, RECORDS } = protocol;

    const OK = C.V86GL_SYNC_QUERY_STATUS_OK;
    const PENDING = C.V86GL_SYNC_QUERY_STATUS_PENDING;
    const EXTENDED_RECORD_SIZE = C.V86GL_EXTENDED_RECORD_SIZE;

    class GLShadow {
        constructor() {
            // gl_caps.js's capabilities object; none until the renderer sends it
            this.capabilities = null;
            this.stats = { batches: 0, records: 0, answered: 0, malformed: 0 };
            this.reset();
        }

        // A new owner of the arena, or a reset machine: no contexts
        reset() {
            this.contexts = new Map();
            this.current = null;
        }

        setCapabilities(capabilities) {
            this.capabilities = capabilities;
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
                this.dispatch(fn, bytes, view, offset, size);
                offset += size;
            }
            if (offset !== end) ++this.stats.malformed;
        }

        dispatch(fn, bytes, view, offset, size) {
            switch (fn) {
            case CTRL.MAKE_CURRENT: return this.makeCurrent(view, offset, size);
            case CTRL.RELEASE_CURRENT: this.current = null; return;
            case CTRL.DESTROY_CONTEXT: return this.destroyContext(view, offset, size);
            case GLFN.QUERY_INTEGER: return this.queryInteger(view, offset, size);
            case GLFN.QUERY_GL_STRING: return this.queryString(bytes, view, offset, size);
            }
        }

        // An older guest's MAKE_CURRENT stops short; the fields after read as 0
        field(name, field, view, offset, size) {
            const at = F[name][field];
            return at + 4 <= size ? view.getUint32(offset + at, true) : 0;
        }

        // Keyed as the executor keys them: by the guest's context id, or by
        // the window for a guest too old to send one
        makeCurrent(view, offset, size) {
            const id = this.field("MAKE_CURRENT", "context_id", view, offset, size);
            const hwnd = this.field("MAKE_CURRENT", "hwnd", view, offset, size);
            const key = id ? "context:" + id : "hwnd:" + hwnd;
            let context = this.contexts.get(key);
            if (!context) {
                context = { key, id, shareGroup: this.field("MAKE_CURRENT", "share_group", view, offset, size) };
                this.contexts.set(key, context);
            }
            this.current = context;
        }

        destroyContext(view, offset, size) {
            if (size < RECORDS.DESTROY_CONTEXT.size) {
                this.reset();
                return;
            }
            const key = "context:" + view.getUint32(offset + F.DESTROY_CONTEXT.context_id, true);
            if (this.current && this.current.key === key) this.current = null;
            this.contexts.delete(key);
        }

        // Whether a query record is still the guest's to have answered
        pending(name, view, offset, size) {
            return size >= RECORDS[name].size && view.getUint32(offset + F[name].status, true) === PENDING;
        }

        queryInteger(view, offset, size) {
            if (!this.capabilities || !this.pending("QUERY_INTEGER", view, offset, size)) return;
            const value = glCaps.integer(this.capabilities, view.getUint32(offset + F.QUERY_INTEGER.pname, true));
            if (value === undefined) return;
            view.setUint32(offset + F.QUERY_INTEGER.value, value >>> 0, true);
            view.setUint32(offset + F.QUERY_INTEGER.status, OK, true);
            ++this.stats.answered;
        }

        // {name, status, length, data_size} then data_size bytes for the
        // text; length counts its terminator, which is written when it fits
        queryString(bytes, view, offset, size) {
            if (!this.capabilities || !this.pending("QUERY_GL_STRING", view, offset, size)) return;
            const text = glCaps.string(this.capabilities, view.getUint32(offset + F.QUERY_GL_STRING.name, true));
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
            return {
                capabilities: this.capabilities,
                contexts: [...this.contexts.values()].map(c => ({ key: c.key, id: c.id, shareGroup: c.shareGroup })),
                current: this.current ? this.current.key : null,
            };
        }

        // A snapshot's capabilities stand: the guest was told those
        setState(state) {
            this.reset();
            if (!state) return;
            this.capabilities = state.capabilities || null;
            for (const c of state.contexts || []) this.contexts.set(c.key, { ...c });
            this.current = state.current ? this.contexts.get(state.current) || null : null;
        }
    }

    const api = { GLShadow };
    global.V86GLShadow = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
