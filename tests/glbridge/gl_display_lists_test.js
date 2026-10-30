"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_fixed.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_buffers.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const native = Object.fromEntries(require("./gl_conformance/display_lists_reference.json").cases.map(c => [c.name, c]));
const scene = (context = 1, group = 1) => new GLStream().makeCurrent(context, 0, 0, 64, 64, context, group);
const command = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
const begin = (s, name, mode = GL.COMPILE) => command(s, 1, name, mode), end = s => command(s, 2), call = (s, name) => command(s, 3, name);
function query(s, operation, name = 0, range = 0) {
    s.record(P.GLFN.QUERY_LIST, P.encodeRecord("QUERY_LIST", { operation, name, range })); return s.payloadView();
}
function calls(s, names) {
    const header = P.encodeRecord("LIST_CALLS", { count: names.length, data_size: names.length * 4 }), payload = new Uint8Array(header.length + names.length * 4);
    payload.set(header); const v = new DataView(payload.buffer); names.forEach((n, i) => v.setUint32(header.length + i * 4, n, true));
    return s.record(P.GLFN.LIST_CALLS, payload);
}
function stateQuery(s, pname) {
    const header = P.encodeRecord("QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_DOUBLE, data_size: 128 }), payload = new Uint8Array(header.length + 128);
    payload.set(header); s.record(P.GLFN.QUERY_STATE, payload); return s.payloadView();
}
(async () => {
    for (const copied of [false, true]) {
        let shadow = new GLShadow(); const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const submit = s => { const bytes = s.bytes(), segments = shadow.process(bytes);
            if (!segments) gpu.submit(copied ? bytes.slice() : bytes, {});
            else for (const segment of segments) { const b = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length); gpu.submit(copied ? b.slice() : b, {}); }
            return segments;
        };
        const report = (s, name, list) => {
            const exists = query(s, 1, list), queries = [0x0B33, 0x0B30, GL.LIST_BASE, GL.CURRENT_COLOR, GL.MODELVIEW_MATRIX].map(p => stateQuery(s, p));
            submit(s); const read = (i, at = 0) => queries[i].view.getFloat64(P.RECORDS.QUERY_STATE.size + at * 8, true);
            const result = { name, isList: exists.view.getUint32(P.F.QUERY_LIST.result, true), index: read(0), mode: read(1), base: read(2),
                color: [0, 1, 2, 3].map(i => read(3, i)), x: read(4, 12), error: shadow.current.error };
            assert.deepEqual(result, native[name], name); shadow.current.error = 0;
        };
        let s = scene(), allocated = query(s, 0, 0, 2); submit(s); const first = allocated.view.getUint32(P.F.QUERY_LIST.result, true);
        report(scene(), "generated", first); s = scene(); query(s, 2, first, 2); submit(s);
        s = begin(scene(), 10).call("COLOR4F", 1, 0, 0, 1).call("TRANSLATEF", 3, 0, 0); report(s, "compiling", 10);
        report(end(scene()), "compiled", 10); report(call(scene(), 10), "called", 10);
        s = end(call(begin(scene(), 11), 10)); submit(s);
        s = end(begin(scene(), 10).call("COLOR4F", 0, 1, 0, 1).call("TRANSLATEF", 5, 0, 0)); call(s, 11); report(s, "nested_redefined", 11);
        s = begin(scene(), 12, GL.COMPILE_AND_EXECUTE).call("COLOR4F", 0, 0, 1, 1).call("TRANSLATEF", 7, 0, 0); report(s, "compile_execute", 12);
        s = call(end(scene()), 12); report(s, "executed_again", 12);
        report(end(begin(scene(), 13).call("LINE_WIDTH", -1)), "deferred_error", 13); report(call(scene(), 13), "called_error", 13);
        report(call(scene(), 0), "call_zero", 0); report(begin(scene(), 14, 0), "invalid_mode", 14); report(end(scene()), "unmatched_end", 14);
        report(calls(command(scene(), 4, 10), [0, 1]), "call_lists", 10);
        s = command(scene().call("PUSH_ATTRIB", 0x20000), 4, 99).call("POP_ATTRIB"); report(s, "base_restored", 10);
        s = end(begin(scene(), 15).call("PIXEL_STOREI", GL.UNPACK_ALIGNMENT, 1).call("BIND_BUFFER", GL.ARRAY_BUFFER, 7)); submit(s);
        assert.equal(shadow.current.state.values[GL.UNPACK_ALIGNMENT][0], native.immediate.alignment); assert.equal(shadow.boundBuffer(GL.ARRAY_BUFFER).name, native.immediate.binding);
        assert.equal(shadow.current.group.displayLists.get(15).length, 0);
        // Snapshot open compilation and shared definitions; queries and client
        // state are never replayed by calling the saved list.
        s = begin(scene(), 30).call("COLOR4F", 0.25, 0.5, 0.75, 1); submit(s);
        const saved = JSON.parse(JSON.stringify(shadow.getState())); shadow = new GLShadow(); shadow.setState(saved);
        s = end(scene()); submit(s); s = call(scene(2, 1), 30); submit(s);
        assert.deepEqual(shadow.current.state.values[GL.CURRENT_COLOR], [0.25, 0.5, 0.75, 1]);
        s = scene(3, 3); const unshared = query(s, 1, 30); submit(s); assert.equal(unshared.view.getUint32(P.F.QUERY_LIST.result, true), 0);
        s = scene(); begin(s, 40); calls(s, [0]); end(s); command(s, 4, 12); call(s, 40); submit(s);
        assert.deepEqual(shadow.current.state.values[GL.CURRENT_COLOR], [0, 0, 1, 1], "CallLists resolves ListBase when the saved command executes");
        // Reserve a huge range without allocating one object per empty list.
        s = scene(4, 4); const huge = query(s, 0, 0, 0x7FFFFFFF); submit(s); assert.equal(huge.view.getUint32(P.F.QUERY_LIST.result, true), 1);
        s = scene(4, 4); query(s, 2, 100, 10); const hole = query(s, 0, 0, 10); submit(s); assert.equal(hole.view.getUint32(P.F.QUERY_LIST.result, true), 100);
        s = scene(5, 5);
        for (let n = 1; n <= 70; ++n) { begin(s, n); if (n < 70) call(s, n + 1); else s.call("COLOR4F", 1, 0, 0, 1); end(s); }
        call(s, 1); submit(s); assert.deepEqual(shadow.current.state.values[GL.CURRENT_COLOR], [1, 1, 1, 1]);
        call(s = scene(5, 5), 7); submit(s); assert.deepEqual(shadow.current.state.values[GL.CURRENT_COLOR], [1, 0, 0, 1]);
        assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0); await gpu.idle();
    }
    console.log("15 native display-list cases, dynamic nesting/base, shared CPU definitions, interval allocation, snapshots and 64-level limit passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
