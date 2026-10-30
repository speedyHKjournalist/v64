// Draw/read selection belongs to the selected framebuffer, including zero.
(function(global) {
    "use strict";
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const initial = first => ({ drawBuffers: [first], readBuffer: first });
    function owner(c, map, read) {
        const name = read ? c.readFramebuffer : c.drawFramebuffer;
        const object = read ? c.readFramebufferObject : c.drawFramebufferObject;
        return name ? object?.name === name ? object : map.get(name) : c.defaultFramebufferState;
    }
    function sync(c, map) {
        c.drawBuffers = owner(c, map, false).drawBuffers.slice();
        c.readBuffer = owner(c, map, true).readBuffer;
    }
    function draw(c, map, values) {
        owner(c, map, false).drawBuffers = values.length ? values.slice() : [GL.NONE]; sync(c, map);
    }
    function read(c, map, value) {
        owner(c, map, true).readBuffer = value; sync(c, map);
    }
    function bind(c, map, target, name, object = name ? map.get(name) : null) {
        if (target !== GL.READ_FRAMEBUFFER) { c.drawFramebuffer = name; c.drawFramebufferObject = object; }
        if (target !== GL.DRAW_FRAMEBUFFER) { c.readFramebuffer = name; c.readFramebufferObject = object; }
        sync(c, map);
    }
    const api = { initial, owner, sync, draw, read, bind };
    global.GLFramebufferState = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
