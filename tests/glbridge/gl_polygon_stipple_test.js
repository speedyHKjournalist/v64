"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_buffers.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_stipple.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const native = Object.fromEntries(require("./gl_conformance/polygon_stipple_reference.json").cases.map(c => [c.name, c]));
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const scene = () => new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
function query(stream, mode = 0, pointer = 0) {
    const header = P.encodeRecord("QUERY_POLYGON_STIPPLE", { mode, pointer, data_size: 320 });
    const payload = new Uint8Array(header.length + 320); payload.fill(0xA5); payload.set(header);
    stream.record(P.GLFN.QUERY_POLYGON_STIPPLE, payload); return stream.payloadView();
}
function upload(stream, data) {
    const header = P.encodeRecord("POLYGON_STIPPLE_BITMAP", { data_size: data.length });
    const payload = new Uint8Array(header.length + Math.max(128, data.length)); payload.set(header); payload.set(data, header.length);
    stream.record(P.GLFN.POLYGON_STIPPLE_BITMAP, payload); return stream.payloadView();
}
function scatter(response, size) {
    const r = P.decodeRecord("QUERY_POLYGON_STIPPLE", response.view, 0), out = new Uint8Array(size).fill(0xA5);
    if (r.status !== 1) return out;
    const rows = response.bytes.subarray(48), count = 32 * r.row_bytes;
    for (let y = 0; y < 32; ++y) for (let b = 0; b < r.row_bytes; ++b) {
        const i = y * r.row_bytes + b, at = r.start + y * r.row_stride + b, mask = rows[count + i];
        out[at] = out[at] & ~mask | rows[i] & mask;
    }
    return out;
}
const layout = (s, pack, values) => ["ALIGNMENT", "ROW_LENGTH", "SKIP_ROWS", "SKIP_PIXELS", "LSB_FIRST"]
    .forEach((p, i) => s.call("PIXEL_STOREI", GL[(pack ? "PACK_" : "UNPACK_") + p], values[i]));
const check = (q, name) => {
    const expected = native[name]; assert.equal(q.view.getUint32(P.F.QUERY_POLYGON_STIPPLE.error, true), expected.error, name);
    const values = expected.bytes.slice();
    if (name === "pack_rows") {
        // Apple's legacy bitmap packer skips a zero final partial byte.
        // GL 2.1 section 4.3.2 requires writing these three data bits too.
        for (let y = 3; y < 32; y += 4) {
            assert.equal(values[12 + y * 8], 0xA5); values[12 + y * 8] = 0xA0;
        }
    }
    if (name === "pack_overlap") { assert.equal(values[35], 0xA5); values[35] = 0x05; }
    assert.deepEqual(Array.from(scatter(q, expected.bytes.length)), values, name);
};
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const submit = s => { const bytes = s.bytes(); shadow.process(bytes); gpu.submit(copied ? bytes.slice() : bytes, {}); return bytes; };
        let s = scene(), q = query(s); submit(s); check(q, "default");
        const source = Uint8Array.from({ length: 512 }, (_, i) => (i * 73) ^ 0xA6), compact = new Uint8Array(160);
        for (let y = 0; y < 32; ++y) compact.set(source.subarray(8 + y * 8, 13 + y * 8), y * 5);
        s = scene(); layout(s, false, [8, 40, 1, 5, 1]); upload(s, compact);
        layout(s, false, [4, 0, 0, 0, 0]); q = query(s); submit(s); check(q, "unpack_rows");
        assert.deepEqual(Array.from(gpu.current.polygonStipple), native.unpack_rows.bytes);
        for (const [name, values] of [["pack_rows", [8, 40, 1, 3, 1]], ["pack_lsb", [1, 0, 0, 0, 1]], ["pack_overlap", [1, 1, 0, 3, 0]]]) {
            s = scene(); layout(s, true, values); q = query(s); submit(s); check(q, name);
        }
        s = scene(); layout(s, true, [4, 0, 0, 0, 0]); s.call("PUSH_ATTRIB", 0x10); upload(s, new Uint8Array(128).fill(255));
        // Snapshot the saved stack as well as the currently installed pattern.
        submit(s); const restored = new GLShadow(); restored.setState(JSON.parse(JSON.stringify(shadow.getState())));
        s = scene().call("POP_ATTRIB"); q = query(s); restored.process(s.bytes()); check(q, "attrib_restore");
        submit(s); assert.deepEqual(Array.from(gpu.current.polygonStipple), native.attrib_restore.bytes);
        const pbo = Uint8Array.from({ length: 128 }, (_, i) => i * 17);
        for (const [name, size, mapped] of [["upload_pbo", 128, false], ["upload_short_pbo", 127, false], ["upload_mapped_pbo", 128, true]]) {
            s = scene().call("BIND_BUFFER", GL.PIXEL_UNPACK_BUFFER, 7).bufferData(GL.PIXEL_UNPACK_BUFFER, size, GL.STATIC_DRAW, pbo.subarray(0, size));
            submit(s); shadow.boundBuffer(GL.PIXEL_UNPACK_BUFFER).mapped = mapped;
            s = scene(); const set = query(s, 1); s.call("BIND_BUFFER", GL.PIXEL_UNPACK_BUFFER, 0); q = query(s); submit(s);
            assert.equal(set.view.getUint32(P.F.QUERY_POLYGON_STIPPLE.error, true), native[name].setterError); check(q, name);
            assert.deepEqual(Array.from(gpu.current.polygonStipple), native[name].bytes);
        }
        for (const [name, size, mapped] of [["read_pbo", 128, false], ["read_short_pbo", 127, false], ["read_mapped_pbo", 128, true]]) {
            s = scene().call("BIND_BUFFER", GL.PIXEL_PACK_BUFFER, 8).bufferData(GL.PIXEL_PACK_BUFFER, size, GL.STATIC_DRAW, new Uint8Array(size).fill(0xA5));
            submit(s); shadow.boundBuffer(GL.PIXEL_PACK_BUFFER).mapped = mapped;
            s = scene(); q = query(s); s.call("BIND_BUFFER", GL.PIXEL_PACK_BUFFER, 0); submit(s); check(q, name);
        }
        s = scene().call("BEGIN", GL.TRIANGLES); const failed = query(s, 1); s.call("END"); q = query(s); submit(s);
        assert.equal(failed.view.getUint32(P.F.QUERY_POLYGON_STIPPLE.error, true), native.upload_begin.setterError); check(q, "upload_begin");
        s = scene().call("BEGIN", GL.TRIANGLES); q = query(s); s.call("END"); submit(s); check(q, "read_begin");
        s = scene().call("BEGIN", GL.TRIANGLES); const invalid = upload(s, new Uint8Array(128)); s.call("END"); submit(s);
        assert.equal(invalid.view.getUint32(P.F.POLYGON_STIPPLE_BITMAP.status, true), 2);
        assert.deepEqual(Array.from(gpu.current.polygonStipple), native.upload_pbo.bytes);
        s = scene(); upload(s, new Uint8Array(127)); q = query(s); submit(s); check(q, "upload_pbo");
        s = scene(); layout(s, true, [8, 0x7FFFFFFF, 0x7FFFFFFF, 0, 0]); q = query(s); submit(s);
        assert.equal(q.view.getUint32(P.F.QUERY_POLYGON_STIPPLE.error, true), GL.OUT_OF_MEMORY);
        await gpu.idle(); assert.equal(gpu.hostErrors.length, 0);
    }
    console.log("14 native polygon stipple cases, bounded compact rows, invalid records and snapshot/renderer state passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
