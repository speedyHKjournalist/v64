"use strict";

const assert = require("node:assert/strict");

require("../../src/browser/glbridge/v86_network_bridge.js");
const { V86WebGPUCompositor } = require("../../src/browser/glbridge/webgpu_compositor.js");

const listeners = Object.create(null);
const routed = [];
let d3d8Options;
const compositor = new V86WebGPUCompositor({ width: 1024, height: 768 });
const bridge = globalThis.installV86GLNetworkBridge({
    add_listener(name, callback) { listeners[name] = callback; },
}, null, {
    compositor,
    glExecutor: { submit() {}, onSwapBuffers() {} },
    installD3D8WebGPUExecutor(installedCanvas, options) {
        assert.equal(installedCanvas, bridge_d3d8Canvas());
        assert.equal(options.host, installedCanvas.layer.host, "the executor draws through its layer's host");
        d3d8Options = options;
        return {
            submit(bytes, metadata) { routed.push({ bytes: Buffer.from(bytes), metadata }); },
        };
    },
});
function bridge_d3d8Canvas() { return compositor.layers.find(layer => layer.name === "d3d8").canvas; }
const d3d8Layer = bridge.d3d8Canvas.layer, glLayer = bridge.glCanvas.layer;
const placed = layer => [layer.x, layer.y, layer.width, layer.height, layer.visible];

bridge.lastPresentedFrameId = 999;
const d8wg = Buffer.alloc(32);
d8wg.writeUInt32LE(0x47573844, 0);
d8wg.writeUInt16LE(1, 4);
d8wg.writeUInt16LE(7, 6);
d8wg.writeUInt32LE(0xA0010001, 24);
d8wg.writeUInt32LE(0x20260802, 28);
const envelope = Buffer.alloc(8 + d8wg.length);
envelope.writeUInt16LE(0xFFE0, 0);
envelope.writeUInt16LE(0xFFFF, 2);
envelope.writeUInt32LE(d8wg.length, 4);
d8wg.copy(envelope, 8);

bridge.pushPCIBatch({
    bytes: envelope,
    frameId: 1,
    submitCount: 7,
    commandCount: 1,
    flags: 0,
});

assert.equal(routed.length, 1,
    "D8WG routing must not be rejected by the OpenGL stale-frame counter");
assert.deepEqual(routed[0].bytes, d8wg);
assert.deepEqual(routed[0].metadata, {
    pciFrameId: 1,
    submitCount: 7,
    descriptorCommandCount: 1,
});

d3d8Options.onSurface({ hwnd: 0x1234, x: 10, y: 20, width: 640,
    height: 480, displayWidth: 640, displayHeight: 480, visible: true }, "create");
d3d8Options.onPresent({ hwnd: 0x1234, x: 10, y: 20, width: 640,
    height: 480, displayWidth: 640, displayHeight: 480, visible: true }, {});
assert.deepEqual(placed(d3d8Layer), [10, 20, 640, 480, true], "a presented window is a visible layer where the guest has it");
assert.equal(glLayer.visible, false);

d3d8Options.onSurface({ hwnd: 0x1234, x: 30, y: 40, width: 640,
    height: 480, displayWidth: 800, displayHeight: 600, visible: true }, "move");
assert.deepEqual(placed(d3d8Layer).slice(0, 4), [30, 40, 800, 600], "the layer follows the window");
d3d8Options.onPresent({ hwnd: 0x1234, x: 524, y: 40, width: 640,
    height: 480, displayWidth: 800, displayHeight: 600, visible: true }, {});
assert.deepEqual(placed(d3d8Layer), [524, 40, 800, 600, true]);
assert.deepEqual(d3d8Layer.clip, { left: 0, top: 0, right: 500 / 800, bottom: 1 },
    "the part of the window past the desktop's edge is clipped");

d3d8Options.onSurface({ hwnd: 0x1234, x: 0, y: 0, width: 640,
    height: 480, displayWidth: 800, displayHeight: 600, visible: false }, "hide");
assert.equal(d3d8Layer.visible, false, "a hidden window hides its layer");
d3d8Options.onPresent({ sessionKey: "new-session", hwnd: 0x1234,
    x: 30, y: 40, width: 640, height: 480, displayWidth: 800,
    displayHeight: 600, visible: true }, {});
assert.equal(d3d8Layer.visible, true);

d3d8Options.onDestroy({ sessionKey: "old-session", hwnd: 0x1234,
    x: 30, y: 40, width: 640, height: 480, displayWidth: 800,
    displayHeight: 600, visible: true }, "device");
assert.equal(d3d8Layer.visible, true,
    "late teardown from an old process session must not hide the new owner");
d3d8Options.onDestroy({ sessionKey: "new-session", hwnd: 0x1234,
    x: 30, y: 40, width: 640, height: 480, displayWidth: 800,
    displayHeight: 600, visible: true }, "device");
assert.equal(d3d8Layer.visible, false);

bridge.showOwner("gl");
assert.equal(d3d8Layer.visible, false);
assert.equal(glLayer.visible, true, "one API's window at a time");

console.log("v86_network_bridge_d3d8_route_test: ok");
