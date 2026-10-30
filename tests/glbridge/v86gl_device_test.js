#!/usr/bin/env node
// v86gl_device.js against a fake virtio handle: what the guest's driver sees
// when the renderer is behind, and when it goes away.
"use strict";

const assert = require("node:assert/strict");
const { createV86GLDevice } = require("../../src/browser/glbridge/v86gl_device.js");

const ARENA = 0x100000, ARENA_BYTES = 16 * 1024 * 1024;
const OK = 0, NO_RENDERER = 3;

function fakeHandle(memory) {
    const queue = [];
    const replies = [];
    return {
        replies,
        push(words) {
            const bytes = new Uint8Array(new Uint32Array(words).buffer);
            queue.push({
                readable: 24, writable: 16,
                read: () => bytes,
                write: reply => replies.push(new Uint32Array(reply.buffer, reply.byteOffset, 4)[0]),
                complete() {},
            });
        },
        is_feature_negotiated: () => true,
        has_request: () => queue.length > 0,
        pop_request: () => queue.shift(),
        flush() {},
        needs_reset() { throw new Error("needs_reset"); },
        is_ram: () => true,
        read_memory: (address, length) => memory.subarray(address - ARENA, address - ARENA + length),
        write_memory(bytes, address) { memory.set(bytes, address - ARENA); },
    };
}

// One VGL2 batch of `bytes` command bytes at the start of the arena
function writeBatch(memory, bytes) {
    const view = new DataView(memory.buffer);
    view.setUint32(0, 0x324C4756, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, 0, true);
    view.setUint32(12, 7, true);
    view.setUint32(16, 1, true);
    view.setUint32(20, bytes, true);
}

const memory = new Uint8Array(ARENA_BYTES);
const posted = [];
let toDevice = null;
const device = createV86GLDevice({ remote: true, post: message => posted.push(message),
    listen: handler => { toDevice = handler; } });
const handle = fakeHandle(memory);
device.init(handle);
toDevice({ type: "available", value: true });

handle.push([1, ARENA, 0, ARENA_BYTES, 0, 0]);
device.notify();
assert.deepEqual(handle.replies, [OK], "the arena registers");

// The renderer acknowledges nothing: eight batches go, the ninth waits
writeBatch(memory, 16);
for (let i = 0; i < 9; ++i) handle.push([2, 0, 0, 48, 0, 0]);
device.notify();
assert.equal(posted.filter(m => m.type === "batch").length, 8);
assert.equal(handle.replies.length, 9, "the ninth descriptor stays with the guest");

// The renderer goes away: the waiting descriptor is answered, not left until
// the guest's driver gives up on the queue
toDevice({ type: "available", value: false });
assert.equal(handle.replies.length, 10);
assert.equal(handle.replies[9], NO_RENDERER);

// Inline GL responses have the lifetime of one command arena submission;
// D3D response slots and heartbeat writes keep their arena lifetime.
const latest = posted.filter(m => m.type === "batch").at(-1);
toDevice({ type: "write", generation: latest.generation, inlineId: latest.id - 1, offset: 4096, bytes: new Uint8Array([7]) });
assert.equal(memory[4096], 0, "a late inline answer cannot overwrite a newer batch");
toDevice({ type: "write", generation: latest.generation, inlineId: latest.id, offset: 4096, bytes: new Uint8Array([8]) });
assert.equal(memory[4096], 8, "the current inline response is accepted even after done");
toDevice({ type: "write", generation: latest.generation, offset: 4096, bytes: new Uint8Array([9]) });
assert.equal(memory[4096], 9, "arena-scoped responses do not depend on the inline lease");

// The owner unmaps: the renderer hears once that its sessions are over
handle.push([3, 0, 0, 0, 0, 0]);
handle.push([3, 0, 0, 0, 0, 0]);
device.notify();
assert.equal(posted.filter(m => m.type === "released").length, 1);

// A queue reset (the driver after a timeout) releases the arena without
// ending any session: the owner is still there and registers again
handle.push([1, ARENA, 0, ARENA_BYTES, 0, 0]);
device.notify();
device.reset();
assert.equal(posted.filter(m => m.type === "released").length, 1);

// Startup must not let either transport route GLSL queries to the page before
// CPU glslang is ready. The virtqueue descriptor stays owned by the guest.
require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js").capabilities({}, {});
const moduleBytes = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../bios/glslang.wasm"));
for (const remote of [false, true]) for (const failed of [false, true]) {
    const guest = new Uint8Array(ARENA_BYTES), outgoing = []; let deliver;
    const d = createV86GLDevice({ remote, post: m => outgoing.push(m), listen: f => { deliver = f; } });
    const h = fakeHandle(guest); d.init(h);
    h.push([1, ARENA, 0, ARENA_BYTES, 0, 0]); d.notify();
    deliver({ type: "initializing", value: true }); deliver({ type: "available", value: true });
    const stream = new GLStream().makeCurrent(1, 0, 0, 4, 4, 1, 1)
        .call("CREATE_SHADER", 1, GL.VERTEX_SHADER).shaderSource(1, "void main(){gl_Position=gl_Vertex;}").call("COMPILE_SHADER", 1);
    const query = stream.queryObjectiv(P.C.V86GL_OBJECT_KIND_SHADER, 1, GL.COMPILE_STATUS);
    writeBatch(guest, stream.bytes().length); guest.set(stream.bytes(), 32);
    h.push([2, 0, 0, 32 + stream.bytes().length, 0, 0]); d.notify();
    assert.equal(h.replies.length, 1, "submission must wait for startup, including in local mode");
    assert.equal(outgoing.filter(m => m.type === "batch").length, 0);
    deliver({ type: "capabilities", value: caps });
    deliver(failed ? { type: "glslang", error: "compiler download failed" } : { type: "glslang", module: new WebAssembly.Module(moduleBytes) });
    assert.equal(h.replies.length, 1, "compiler arrival alone must not release the barrier");
    deliver({ type: "initializing", value: false });
    assert.deepEqual(h.replies, [OK, OK]);
    const batch = outgoing.find(m => m.type === "batch");
    // payloadView's offset is within the stream, shared by the copied batch.
    const original = stream.bytes(), payloadOffset = query.bytes.byteOffset - original.byteOffset;
    if (!Number.isInteger(payloadOffset) || payloadOffset < 0) throw new Error("invalid fixture query offset");
    const view = new DataView(batch.bytes.buffer, batch.bytes.byteOffset + payloadOffset, query.bytes.length);
    assert.equal(view.getUint32(P.F.QUERY_OBJECT_IV.status, true), P.C.V86GL_SYNC_QUERY_STATUS_OK);
    assert.equal(view.getInt32(P.F.QUERY_OBJECT_IV.value, true), failed ? 0 : 1);
}
console.log("v86gl_device_test: backpressure, renderer loss, owner release, queue reset and compiler startup passed");
