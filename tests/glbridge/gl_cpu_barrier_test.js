"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), { GLStream, GL } = require("./gl_stream_builder.js");
let next = 0, blocked;
GLShadow.part({ routeRecord(shadow, fn, bytes, view, offset, size) {
    if (fn !== P.GLFN.POINT_SIZE || view.getFloat32(offset, true) !== 13) return;
    assert.equal(shadow.dispatch(fn, bytes, view, offset, size, true), 0);
    shadow.blockCPU(++next); blocked = shadow;
    return { commands: [] };
} });
const list = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
function query(s, pname) {
    const bytes = new Uint8Array(32); bytes.set(P.encodeRecord("QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_FLOAT, data_size: 8 }));
    s.record(P.GLFN.QUERY_STATE, bytes); return s.payloadView();
}
function harness() {
    const shadow = new GLShadow(); shadow.process(new GLStream().makeCurrent(1, 0, 0, 32, 32, 1, 1).bytes());
    return shadow;
}
{
    const s = new GLStream().call("LINE_WIDTH", 3).call("POINT_SIZE", 13).call("LINE_WIDTH", 5),
        line = query(s, GL.LINE_WIDTH), point = query(s, GL.POINT_SIZE), memory = s.bytes(), shadow = harness(), events = [];
    shadow.writeResponse = (target, bytes) => memory.set(bytes, target.offset);
    shadow.onCPUResume = (bytes, segments) => events.push(["commands", bytes.length, segments]);
    shadow.onCPUComplete = () => events.push(["complete"]);
    const segments = shadow.process(memory, { generation: 1, batchId: 1, root: true });
    assert.equal(blocked, shadow); assert.ok(segments.length); assert.equal(line.view.getUint32(P.F.QUERY_STATE.status, true), 0);
    assert.equal(shadow.current.state.values[GL.LINE_WIDTH][0], 3); assert.ok(shadow.deferredCPUBytes > 0); assert.equal(events.length, 0);
    shadow.current.state.values[GL.POINT_SIZE] = [7];
    assert.equal(shadow.resumeCPU(next, [new GLStream().call("POINT_SIZE", 7).bytes()]), true);
    assert.equal(shadow.deferredCPUBytes, 0); assert.equal(shadow.cpuBarrier, null);
    assert.equal(line.view.getUint32(P.F.QUERY_STATE.status, true), 1); assert.equal(line.view.getFloat64(24, true), 5); assert.equal(point.view.getFloat64(24, true), 7);
    assert.deepEqual(events.map(e => e[0]), ["commands", "commands", "complete"], "publish renderer continuations before completing submission");
    assert.equal(shadow.resumeCPU(next), false, "duplicate completion cannot replay commands");
}
{
    const shadow = harness(), s = new GLStream().call("POINT_SIZE", 13), completed = [];
    const first = query(s, GL.POINT_SIZE); s.call("POINT_SIZE", 13);
    const last = query(s, GL.POINT_SIZE), memory = s.bytes();
    shadow.writeResponse = (target, bytes) => memory.set(bytes, target.offset); shadow.onCPUComplete = () => completed.push(true);
    shadow.process(memory, { generation: 1, batchId: 2, root: true });
    const token = next; shadow.current.state.values[GL.POINT_SIZE] = [7]; shadow.resumeCPU(token);
    assert.equal(first.view.getFloat64(24, true), 7); assert.equal(last.view.getUint32(P.F.QUERY_STATE.status, true), 0); assert.equal(completed.length, 0);
    shadow.current.state.values[GL.POINT_SIZE] = [9]; shadow.resumeCPU(next);
    assert.equal(last.view.getFloat64(24, true), 9); assert.equal(completed.length, 1);
}
{
    const shadow = harness(), compile = new GLStream(); list(compile, 1, 1, GL.COMPILE); compile.call("POINT_SIZE", 13); list(compile, 3, 1); list(compile, 2);
    shadow.process(compile.bytes()); assert.equal(shadow.cpuBarrier, null, "compiling a list does not wait for its commands");
    const s = new GLStream(); list(s, 3, 1); const answer = query(s, GL.POINT_SIZE), memory = s.bytes();
    shadow.writeResponse = (target, bytes) => memory.set(bytes, target.offset);
    shadow.process(memory, { generation: 1, batchId: 3, root: true });
    let count = 0;
    while (shadow.cpuBarrier) { assert.ok(++count <= 64, "a CPU suspension must preserve the display list recursion limit"); shadow.current.state.values[GL.POINT_SIZE] = [count]; shadow.resumeCPU(next); }
    assert.equal(count, 64); assert.equal(answer.view.getUint32(P.F.QUERY_STATE.status, true), 1); assert.equal(answer.view.getFloat64(24, true), 64);
}
console.log("gl_cpu_barrier_test: deferred CPU state/queries, ordered continuations, repeated waits and bounded recursive display lists passed");
