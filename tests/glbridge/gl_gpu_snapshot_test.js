"use strict";
const assert = require("node:assert/strict"), gpu = require("../../src/browser/glbridge/gl-webgpu/gl_gpu_snapshot.js");
function image(format = "rgba8unorm", samples = 1) {
    return { kind: "texture", descriptor: { size: { width: 2, height: 3, depthOrArrayLayers: 1 }, format, dimension: "2d", mipLevelCount: 1, sampleCount: samples, usage: 23 },
        levels: [{ level: 0, layer: 0, width: 2, height: 3, rows: 3, rowBytes: 8, aspect: "all", data: new Uint8Array(24) }] };
}
gpu.validate(image()); gpu.validate({ kind: "buffer", descriptor: { size: 4, usage: 12 }, data: new Uint8Array(4) });
for (const mutate of [s => { s.levels[0].rows = 0; }, s => { s.levels[0].rowBytes = 0; }, s => { s.levels[0].layer = 1; }, s => { s.levels[0].data = new Uint8Array(23); },
    s => { s.levels.push(s.levels[0]); }, s => { s.descriptor.mipLevelCount = 4; }, s => { s.descriptor.size.width = Infinity; }, s => { s.descriptor.size.depthOrArrayLayers = -1; },
    s => { s.levels[0].aspect = "depth"; }, s => { s.descriptor.sampleCount = 4; }, s => { s.descriptor.usage = 0; }]) {
    const saved = image(); mutate(saved); assert.throws(() => gpu.validate(saved), /Invalid GL resource/);
}
const depth = image("depth24plus-stencil8"); depth.levels = [{ level: 0, layer: 0, width: 2, height: 3, aspect: "depth", data: new Uint8Array(24) },
    { level: 0, layer: 0, width: 2, height: 3, rows: 3, rowBytes: 2, aspect: "stencil-only", data: new Uint8Array(6) }]; gpu.validate(depth);
depth.levels[1] = depth.levels[0]; assert.throws(() => gpu.validate(depth), /Invalid GL resource/);
const msaa = image("rgba8unorm", 4); msaa.levels = [{ level: 0, layer: 0, width: 2, height: 3, aspect: "samples", data: new Uint8Array(384) }]; gpu.validate(msaa);
msaa.levels[0].data = new Uint8Array(96); assert.throws(() => gpu.validate(msaa), /Invalid GL resource/);
console.log("gl_gpu_snapshot_test: resource dimensions, complete mip/layer/aspect sets, exact payload spans, MSAA sample counts and malformed archives passed");
