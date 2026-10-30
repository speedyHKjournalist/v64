"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "buffers", "arrays"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const native = require("./gl_conformance/buffer_lifetime_reference.json").cases;
const fields = ["arrayBuffer", "elementArrayBuffer", "pixelPackBuffer", "pixelUnpackBuffer"];
const targets = [GL.ARRAY_BUFFER, GL.ELEMENT_ARRAY_BUFFER, GL.PIXEL_PACK_BUFFER, GL.PIXEL_UNPACK_BUFFER];
const current = (s, id) => s.makeCurrent(id, 0, 0, 64, 64, id, 1);
const bind = (s, name) => { for (const target of targets) s.call("BIND_BUFFER", target, name); return s; };
const pointers = s => s.pointerVBO("VERTEX_POINTER_VBO", 3, GL.FLOAT, 0, 4).pointerVBO("COLOR_POINTER_VBO", 4, GL.UNSIGNED_BYTE, 0, 0)
    .call("CLIENT_ACTIVE_TEXTURE", GL.TEXTURE0 + 3).pointerVBO("TEX_COORD_POINTER_VBO", 2, GL.FLOAT, 0, 0).attribPointerVBO(2, 4, GL.FLOAT, false, 0, 0);
const data = (s, values) => s.bufferData(GL.ARRAY_BUFFER, 16, GL.STATIC_DRAW, new Uint8Array(new Int32Array(values).buffer));
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const submit = s => { const bytes = s.bytes(); shadow.process(bytes); gpu.submit(copied ? bytes.slice() : bytes, {}); };
        const cpuBindings = () => targets.map(t => shadow.boundBuffer(t)?.name || 0).concat([
            shadow.current.state.arrays.vertex.bufferId, shadow.current.state.arrays.color.bufferId,
            shadow.current.state.arrays.texCoord[3].bufferId, shadow.current.state.arrays.generic[2].bufferId]
            .map(id => shadow.current.group.bufferObjects.get(id)?.name || 0));
        const gpuBindings = () => fields.map(f => gpu.current[f]).concat(["vertex", "color", "texCoord3", "generic2"].map(key => gpu.current.arrays[key]?.buffer || 0));
        submit(pointers(data(bind(current(new GLStream(), 1), 7), [11, 22, 33, 44])));
        const old = shadow.boundBuffer(GL.ARRAY_BUFFER), oldGPU = gpu.bufferFor(GL.ARRAY_BUFFER);
        assert.deepEqual(cpuBindings(), native.find(c => c.name === "first_before").bindings); assert.deepEqual(gpuBindings(), cpuBindings());
        submit(new GLStream().call("PUSH_CLIENT_ATTRIB", 3));
        submit(pointers(bind(current(new GLStream(), 2), 7)));
        assert.deepEqual(cpuBindings(), native.find(c => c.name === "second_before").bindings); assert.deepEqual(gpuBindings(), cpuBindings());
        submit(current(new GLStream(), 1).names(P.GLFN.DELETE_BUFFERS, [7]));
        assert.deepEqual(cpuBindings(), native.find(c => c.name === "first_deleted").bindings); assert.deepEqual(gpuBindings(), cpuBindings());
        assert.equal(shadow.current.state.arrays.vertex.pointer, 4); assert.equal(gpu.current.arrays.vertex.offset, 4);
        assert.equal(old.deleted, true); assert.ok(shadow.current.group.bufferObjects.has(old.id));
        assert.ok(gpu.current.shareGroup.bufferObjects.has(oldGPU.id));
        gpu.flushFrame(); await gpu.idle(); assert.equal(oldGPU.gpuBuffer.destroyed, false, "a shared or stacked binding keeps GPU storage alive");
        submit(data(bind(new GLStream(), 7), [55, 66, 77, 88]));
        const replacement = shadow.boundBuffer(GL.ARRAY_BUFFER), replacementGPU = gpu.bufferFor(GL.ARRAY_BUFFER);
        assert.notEqual(old, replacement); assert.notEqual(oldGPU, replacementGPU);
        const oldStorage = oldGPU.gpuBuffer; await gpu.onDeviceLost();
        assert.notEqual(oldGPU.gpuBuffer, oldStorage); assert.ok(oldGPU.gpuBuffer, "rebuild deleted but retained storage after device loss");
        submit(current(new GLStream(), 2));
        assert.equal(shadow.boundBuffer(GL.ARRAY_BUFFER), old); assert.equal(gpu.bufferFor(GL.ARRAY_BUFFER), oldGPU);
        assert.equal(gpu.arrayBufferObject(gpu.current.arrays.vertex), oldGPU);
        assert.deepEqual(Array.from(new Int32Array(old.data.buffer)), [11, 22, 33, 44]);
        assert.deepEqual(Array.from(oldGPU.shadow), Array.from(old.data));
        submit(new GLStream().names(P.GLFN.DELETE_BUFFERS, [7]));
        assert.equal(shadow.boundBuffer(GL.ARRAY_BUFFER), old); assert.equal(gpu.bufferFor(GL.ARRAY_BUFFER), oldGPU);
        assert.equal(gpu.arrayBufferObject(gpu.current.arrays.generic2), oldGPU);
        submit(pointers(bind(new GLStream(), 0)));
        assert.ok(gpu.current.shareGroup.bufferObjects.has(oldGPU.id), "client attribute stack remains an owner");
        // ARB VBO's Push/PopClientAttrib issue preserves non-current stack
        // references. The recorded Apple implementation instead rebinds a
        // name (first_popped creates an empty public object). Keep that raw
        // observation; this profile retains the actual referenced object.
        submit(current(new GLStream(), 1).call("POP_CLIENT_ATTRIB"));
        assert.equal(shadow.boundBuffer(GL.ARRAY_BUFFER), old); assert.equal(gpu.bufferFor(GL.ARRAY_BUFFER), oldGPU);
        assert.equal(shadow.current.group.buffers.has(7), false, "a restored binding does not recreate the public name");
        assert.equal(gpu.current.shareGroup.buffers.has(7), false);
        assert.equal(shadow.current.group.bufferObjects.has(replacement.id), false);
        assert.equal(gpu.current.shareGroup.bufferObjects.has(replacementGPU.id), false);
        const restored = new GLShadow(); restored.setState(JSON.parse(JSON.stringify(shadow.getState())));
        assert.equal(restored.boundBuffer(GL.ARRAY_BUFFER).id, old.id); assert.deepEqual(Array.from(restored.boundBuffer(GL.ARRAY_BUFFER).data), Array.from(old.data));
        submit(pointers(bind(new GLStream(), 0)));
        assert.equal(shadow.current.group.bufferObjects.has(old.id), false); assert.equal(gpu.current.shareGroup.bufferObjects.has(oldGPU.id), false);
        submit(data(bind(current(new GLStream(), 2), 8), [11, 22, 33, 44]).record(P.GLFN.QUERY_BUFFER_MAP,
            P.encodeRecord("QUERY_BUFFER_MAP", { target: GL.ARRAY_BUFFER, access: GL.READ_WRITE_ARB, pointer: 0x1000 })));
        submit(bind(current(new GLStream(), 1), 8).names(P.GLFN.DELETE_BUFFERS, [8]));
        submit(current(new GLStream(), 2));
        assert.equal(+shadow.boundBuffer(GL.ARRAY_BUFFER).mapped, native.find(c => c.name === "second_mapped_deleted").mapped);
        assert.equal(shadow.boundBuffer(GL.ARRAY_BUFFER).pointer, 0x1000);
        assert.equal(shadow.stats.rejected, 0); assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0);
    }
    console.log("gl_buffer_lifetime_test: native current unbinding/mapped retention, stable shared and stacked identities, name reuse, snapshot and GPU loss in both modes (passed)");
})().catch(error => { console.error(error); process.exitCode = 1; });
