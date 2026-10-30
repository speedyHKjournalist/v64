// GL 2.1 section 5.4: compilation stores commands, nested calls keep their
// names, and client operations/queries execute while a list is being built.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const INDEX = 0x0B33, MODE = 0x0B30, NESTING = 0x0B31;
    const MAX_DEPTH = 64, MAX_EXPANSION = 64 * 1024 * 1024;
    const immediateNames = new Set(("PIXEL_STOREI PIXEL_STOREF READ_PIXELS FINISH FLUSH CLIENT_ACTIVE_TEXTURE " +
        "ENABLE_CLIENT_STATE DISABLE_CLIENT_STATE ENABLE_VERTEX_ATTRIB_ARRAY DISABLE_VERTEX_ATTRIB_ARRAY PUSH_CLIENT_ATTRIB POP_CLIENT_ATTRIB " +
        "GEN_TEXTURES DELETE_TEXTURES GEN_BUFFERS DELETE_BUFFERS BIND_BUFFER BUFFER_DATA BUFFER_SUB_DATA " +
        "GEN_QUERIES DELETE_QUERIES GEN_PROGRAMS_ARB DELETE_PROGRAMS_ARB " +
        "CREATE_SHADER CREATE_PROGRAM DELETE_SHADER DELETE_PROGRAM ATTACH_SHADER DETACH_SHADER BIND_ATTRIB_LOCATION COMPILE_SHADER SHADER_SOURCE LINK_PROGRAM VALIDATE_PROGRAM " +
        "MAP_UNIFORM_LOCATION MAP_ATTRIB_LOCATION INVALIDATE_PROGRAM_LOCATIONS CHECK_FRAMEBUFFER_STATUS GENERATE_MIPMAP").split(" "));
    function immediate(fn, bytes, view, offset) {
        const name = P.NAME_BY_OPCODE[fn] || "";
        if (fn >= 0xFF00 || name.startsWith("QUERY_") || immediateNames.has(name) || name.endsWith("POINTER_VBO") ||
            name.includes("FRAMEBUFFER") || name.includes("RENDERBUFFER")) return true;
        if (["TEX_IMAGE_1D", "TEX_IMAGE_2D", "TEX_IMAGE_3D", "COMPRESSED_TEX_IMAGE_1D", "COMPRESSED_TEX_IMAGE_2D", "COMPRESSED_TEX_IMAGE_3D"].includes(name))
            return [GL.PROXY_TEXTURE_1D, GL.PROXY_TEXTURE_2D, GL.PROXY_TEXTURE_3D, GL.PROXY_TEXTURE_CUBE_MAP].includes(view.getUint32(offset, true));
        return false;
    }
    const exists = (g, name) => !!name && (g.displayLists.has(name) || g.listRanges.some(([start, end]) => name >= start && name < end));
    const error = (c, value) => { if (c && !c.error) c.error = value; };
    function allocate(g, range) {
        if (!range) return 0;
        const intervals = [...g.listRanges, ...[...g.displayLists.keys()].map(name => [name, name + 1])].sort((a, b) => a[0] - b[0]);
        let first = 1;
        for (const [start, end] of intervals) {
            if (first + range <= start) break;
            if (first < end) first = end;
        }
        if (first + range > 0x100000000) return 0;
        g.listRanges.push([first, first + range]); return first;
    }
    function remove(g, name, range) {
        const end = Math.min(0x100000000, name + range), intervals = [];
        for (const [start, last] of g.listRanges) {
            if (last <= name || start >= end) intervals.push([start, last]);
            else { if (start < name) intervals.push([start, name]); if (last > end) intervals.push([end, last]); }
        }
        g.listRanges = intervals;
        for (const id of g.displayLists.keys()) if (id >= name && id < end) g.displayLists.delete(id);
    }
    GLShadow.prototype.queryList = function(bytes, view, offset, size) {
        const name = "QUERY_LIST", fields = P.F[name]; if (!this.pending(name, view, offset, size)) return;
        const r = P.decodeRecord(name, view, offset), c = this.current;
        const failure = !c || c.state.begin ? GL.INVALID_OPERATION : r.operation > 2 ? GL.INVALID_ENUM :
            r.operation !== 1 && r.range < 0 ? GL.INVALID_VALUE : 0;
        if (failure) {
            error(c, failure); view.setUint32(offset + fields.error, failure, true);
            return this.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_FAILED);
        }
        const result = r.operation === 0 ? allocate(c.group, r.range) : r.operation === 1 ? +exists(c.group, r.name) : 0;
        if (r.operation === 2 && r.range) remove(c.group, r.name, r.range);
        view.setUint32(offset + fields.result, result, true); view.setUint32(offset + fields.error, 0, true);
        this.answered(name, view, offset, P.C.V86GL_SYNC_QUERY_STATUS_OK);
    };
    GLShadow.install({ [P.GLFN.QUERY_LIST]: "queryList" });
    function execute(s, name) {
        const c = s.current;
        if (!name) { error(c, GL.INVALID_VALUE); return []; }
        const entries = c.group.displayLists.get(name); if (!entries) return [];
        const outer = !c.listExecution;
        if (outer) c.listExecution = { depth: 0, bytes: 0 };
        const execution = c.listExecution;
        if (execution.depth >= MAX_DEPTH) return [];
        ++execution.depth; const commands = [];
        try {
            for (const entry of entries) {
                execution.bytes += entry.length;
                if (execution.bytes > MAX_EXPANSION) { error(c, GL.OUT_OF_MEMORY); break; }
                commands.push(...s.expand(Uint8Array.from(entry)));
            }
        } finally { --execution.depth; if (outer) c.listExecution = null; }
        return commands;
    }
    state.query([INDEX], s => [[s.current.listCompile?.name || 0], "i"]);
    state.query([MODE], s => [[s.current.listCompile?.mode || 0], "e"]);
    state.query([NESTING], () => [[MAX_DEPTH], "i"]);
    state.define("LIST_BASE", [0], "u", 0x20000);
    GLShadow.part({
        group(g) { g.displayLists = new Map(); g.listRanges = []; },
        routeRecord(s, fn, bytes, view, offset, size) {
            const c = s.current; if (!c) return;
            const control = fn === P.GLFN.LIST_COMMAND, calls = fn === P.GLFN.LIST_CALLS;
            const r = control ? P.decodeRecord("LIST_COMMAND", view, offset) : null;
            if (control && (r.operation === 1 || r.operation === 2)) {
                if (c.state.begin || c.listCompile?.begin) return { error: GL.INVALID_OPERATION };
                if (r.operation === 1) {
                    if (c.listCompile) return { error: GL.INVALID_OPERATION };
                    if (!r.name) return { error: GL.INVALID_VALUE };
                    if (![GL.COMPILE, GL.COMPILE_AND_EXECUTE].includes(r.value)) return { error: GL.INVALID_ENUM };
                    c.listCompile = { name: r.name, mode: r.value, entries: [], begin: false };
                } else {
                    if (!c.listCompile) return { error: GL.INVALID_OPERATION };
                    c.group.displayLists.set(c.listCompile.name, c.listCompile.entries); c.listCompile = null;
                }
                return { commands: [] };
            }
            if (c.listCompile && !c.listExecution && !immediate(fn, bytes, view, offset)) {
                // Build a fresh header: bytes before a payload may belong to a
                // preceding record and must never determine this record's size.
                const extended = size >= 0xFFFF, copy = new Uint8Array(size + (extended ? 8 : 4)), v = new DataView(copy.buffer);
                v.setUint16(0, fn, true); v.setUint16(2, extended ? 0xFFFF : size, true); if (extended) v.setUint32(4, size, true);
                copy.set(bytes.subarray(offset, offset + size), copy.length - size);
                c.listCompile.entries.push(Array.from(copy));
                if (fn === P.GLFN.BEGIN) c.listCompile.begin = true;
                if (fn === P.GLFN.END) c.listCompile.begin = false;
                if (c.listCompile.mode === GL.COMPILE) return { commands: [] };
                const execution = c.listExecution; c.listExecution = { depth: 0, bytes: 0 };
                try { return { commands: s.expand(copy) }; } finally { c.listExecution = execution; }
            }
            if (control) {
                if (r.operation === 3) return { commands: execute(s, r.name) };
                if (r.operation === 4) {
                    if (c.state.begin) return { error: GL.INVALID_OPERATION };
                    state.set(c, GL.LIST_BASE, [r.name]); return { commands: [] };
                }
                return { error: GL.INVALID_ENUM };
            }
            if (calls) {
                const r = P.decodeRecord("LIST_CALLS", view, offset), header = P.RECORDS.LIST_CALLS.size;
                if (r.data_size !== r.count * 4 || r.data_size > size - header) return { error: GL.INVALID_VALUE };
                const commands = [];
                for (let i = 0; i < r.count; ++i) commands.push(...execute(s,
                    (view.getUint32(offset + header + i * 4, true) + c.state.values[GL.LIST_BASE][0]) >>> 0));
                return { commands };
            }
        },
        getState(s, saved) {
            saved.lists = [...s.groups.values()].map(g => [g.key, [...g.displayLists], g.listRanges]);
            saved.listCompilers = [...s.contexts.values()].map(c => [c.key, c.listCompile || null]);
        },
        setState(s, saved) {
            for (const [key, entries, ranges] of saved.lists || []) { const g = s.groups.get(key); if (g) { g.displayLists = new Map(entries); g.listRanges = ranges; } }
            for (const [key, compiler] of saved.listCompilers || []) { const c = s.contexts.get(key); if (c) c.listCompile = compiler; }
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
