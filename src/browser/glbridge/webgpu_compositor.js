// One canvas for the whole screen (docs/display-design.md).
// The scanout -- whatever the guest's display device shows: text or
// graphics, drawn by src/browser/screen.js -- lives in a texture, and every
// guest D3D/GL surface is a window layer composited on top of it in guest
// desktop coordinates, clipped to the part of it the guest reports visible.
//
// The executors are unaware of this: each layer hands them a canvas-like
// object whose WebGPU context returns the layer's texture from
// getCurrentTexture(), and a host view that shares the compositor's device.
// What they "present" is what the next composition samples.

(function(global) {
    "use strict";

    const USAGE_COPY_SRC = 0x01;
    const USAGE_COPY_DST = 0x02;
    const USAGE_TEXTURE_BINDING = 0x04;
    const USAGE_UNIFORM = 0x40;
    const USAGE_RENDER_ATTACHMENT = 0x10;
    const BUFFER_USAGE_COPY_DST = 0x08;

    const COMPOSE_WGSL = `
struct Quad { dst: vec4<f32>, uv: vec4<f32> };
@group(0) @binding(0) var<uniform> quad: Quad;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

struct VSOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VSOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let c = corners[index];
    var out: VSOut;
    out.position = vec4<f32>(mix(quad.dst.x, quad.dst.z, c.x), mix(quad.dst.y, quad.dst.w, c.y), 0.0, 1.0);
    out.uv = vec2<f32>(mix(quad.uv.x, quad.uv.z, c.x), mix(quad.uv.y, quad.uv.w, c.y));
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    return vec4<f32>(textureSample(source, source_sampler, in.uv).rgb, 1.0);
}
`;

    function srgbSiblingOf(format) {
        const host = global.V86GPUHost;
        if (host && host.srgbSiblingOf) return host.srgbSiblingOf(format);
        if (format === "bgra8unorm") return "bgra8unorm-srgb";
        if (format === "rgba8unorm") return "rgba8unorm-srgb";
        return null;
    }

    /* What an executor sees as its canvas: a size and a WebGPU context. */
    class LayerCanvas {
        constructor(layer) {
            this.layer = layer;
            this.widthValue = 1;
            this.heightValue = 1;
            this.style = {};
        }
        get width() { return this.widthValue; }
        set width(value) { this.widthValue = Math.max(1, value | 0); }
        get height() { return this.heightValue; }
        set height(value) { this.heightValue = Math.max(1, value | 0); }
        getContext(type) { return type === "webgpu" ? this.layer.context : null; }
    }

    /* What an executor sees as its canvas context. Unlike a real one, the
     * texture persists between frames, which only matters to an executor
     * that relied on a fresh texture being cleared: every one of them either
     * copies a whole back buffer in or clears the pass. */
    class LayerContext {
        constructor(layer) {
            this.layer = layer;
            this.canvas = layer.canvas;
            this.configuration = null;
        }
        configure(configuration) { this.configuration = configuration || null; }
        unconfigure() { this.configuration = null; }
        getConfiguration() { return this.configuration; }
        getCurrentTexture() { return this.layer.currentTexture(); }
    }

    class WindowLayer {
        constructor(compositor, name, z) {
            this.compositor = compositor;
            this.name = name;
            this.z = z;
            this.canvas = new LayerCanvas(this);
            this.context = new LayerContext(this);
            this.x = 0;
            this.y = 0;
            this.width = 0;
            this.height = 0;
            this.visible = false;
            // Visible part of the layer as fractions of it, or null for all of it
            this.clip = null;
            // Where other guest windows leave it showing: rectangles as
            // fractions of the layer, or null for everywhere (within the clip)
            this.visibleRegion = null;
            this.texture = null;
            this.textureDevice = null;
            this.bindGroup = null;
            this.uniform = null;
            this.destroyed = false;
            this.host = compositor.hostViewFor(this);
        }

        currentTexture() {
            const compositor = this.compositor;
            const device = compositor.device;
            if (!device) throw new Error("the compositor has no WebGPU device");
            const width = this.canvas.width, height = this.canvas.height;
            if (!this.texture || this.textureDevice !== device ||
                    this.texture.width !== width || this.texture.height !== height) {
                const configuration = this.context.configuration || {};
                const format = configuration.format || compositor.format;
                const sibling = srgbSiblingOf(format);
                this.texture = device.createTexture({
                    label: "v86 window layer " + this.name,
                    size: { width, height, depthOrArrayLayers: 1 },
                    format,
                    ...(configuration.viewFormats || sibling ?
                        { viewFormats: configuration.viewFormats || [sibling] } : {}),
                    usage: USAGE_RENDER_ATTACHMENT | USAGE_COPY_SRC | USAGE_COPY_DST |
                        USAGE_TEXTURE_BINDING,
                });
                this.textureDevice = device;
                this.bindGroup = null;
            }
            compositor.scheduleCompose();
            return this.texture;
        }

        /**
         * Where the layer goes, in guest desktop pixels (the canvas's pixels)
         */
        place(x, y, width, height, visible) {
            const changed = x !== this.x || y !== this.y || width !== this.width ||
                height !== this.height || !!visible !== this.visible;
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
            this.visible = !!visible;
            if (changed) this.compositor.scheduleCompose();
        }

        /**
         * @param {{left:number, top:number, right:number, bottom:number}|null} clip
         *        the visible part as fractions of the layer
         */
        setClip(clip) {
            this.clip = clip;
            this.compositor.scheduleCompose();
        }

        /**
         * @param {Array<{left:number, top:number, right:number, bottom:number}>|null} rects
         *        the parts other guest windows leave showing, as fractions of
         *        the layer; null for all of it
         */
        setVisibleRegion(rects) {
            this.visibleRegion = rects;
            this.compositor.scheduleCompose();
        }

        destroy() {
            this.destroyed = true;
            this.visible = false;
            this.compositor.removeLayer(this);
        }
    }

    class V86WebGPUCompositor {
        constructor(canvas, options) {
            this.canvas = canvas;
            this.options = options || {};
            this.host = null;
            this.device = null;
            this.context = null;
            this.format = null;
            this.layers = [];
            this.nextZ = 0;
            this.scanout = null;
            this.scanoutWidth = 0;
            this.scanoutHeight = 0;
            this.scanoutBindGroup = null;
            this.scanoutUniform = null;
            this.scanoutDirty = true;
            this.composeScheduled = false;
            this.presenter = null;
            this.destroyed = false;
            this.stats = { compositions: 0, uploads: 0, uploadBytes: 0 };
        }

        get attached() { return !!this.device; }

        /* ---- the device ---- */

        /* Adopt the host now, so that executors created before it is ready
         * already share its device; attach() waits for it. */
        useHost(host) {
            if (this.host === host) return;
            this.detach();
            this.host = host;
        }

        async attach(host) {
            this.useHost(host);
            await host.initialize();
            if (this.destroyed || this.host !== host) return;
            this.setupDevice();
            host.onDeviceLost(() => {
                if (this.host === host) this.setupDevice();
            });
        }

        /** Stop using the device (it is about to be destroyed) */
        detach() {
            this.device = null;
            this.context = null;
            this.scanout = null;
            this.scanoutBindGroup = null;
            this.scanoutUniform = null;
            for (const layer of this.layers) {
                layer.texture = null;
                layer.bindGroup = null;
                layer.uniform = null;
            }
        }

        setupDevice() {
            const host = this.host;
            this.device = host.device;
            this.context = host.context;
            this.format = host.format;
            const module = this.device.createShaderModule({ label: "v86 compositor", code: COMPOSE_WGSL });
            this.pipeline = this.device.createRenderPipeline({
                label: "v86 compositor",
                layout: "auto",
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main", targets: [{ format: this.format }] },
                primitive: { topology: "triangle-list" },
            });
            // The scanout is shown pixel for pixel; window layers may be scaled
            this.nearest = this.device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
            this.linear = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
            this.scanout = null;
            this.scanoutBindGroup = null;
            this.scanoutUniform = null;
            for (const layer of this.layers) {
                layer.bindGroup = null;
                layer.uniform = null;
            }
            if (this.scanoutWidth && this.scanoutHeight) this.createScanout();
            // Everything that was in the old scanout texture has to be sent again
            if (this.presenter && typeof this.presenter["invalidate"] === "function")
                this.presenter["invalidate"]();
            this.scheduleCompose();
        }

        createScanout() {
            this.scanout = this.device.createTexture({
                label: "v86 scanout",
                size: { width: this.scanoutWidth, height: this.scanoutHeight, depthOrArrayLayers: 1 },
                format: "rgba8unorm",
                usage: USAGE_COPY_DST | USAGE_TEXTURE_BINDING | USAGE_COPY_SRC,
            });
            this.scanoutBindGroup = null;
            this.scanoutDirty = true;
        }

        /* ---- window layers ---- */

        createLayer(name) {
            const layer = new WindowLayer(this, name, this.nextZ++);
            this.layers.push(layer);
            return layer;
        }

        removeLayer(layer) {
            const index = this.layers.indexOf(layer);
            if (index >= 0) this.layers.splice(index, 1);
            this.scheduleCompose();
        }

        /* A host for one layer: the compositor's current host and device, but
         * the layer's own canvas and context, and no competition for the
         * presenter -- each layer is its own. */
        hostViewFor(layer) {
            const compositor = this;
            const overrides = {
                canvas: layer.canvas,
                context: layer.context,
                configureCanvas() {},
                resizeCanvas(width, height) {
                    const w = Math.max(1, width | 0), h = Math.max(1, height | 0);
                    if (layer.canvas.width === w && layer.canvas.height === h) return false;
                    layer.canvas.width = w;
                    layer.canvas.height = h;
                    return true;
                },
                claimPresenter() { return 1; },
                canPresent(token) { return !!token; },
                releasePresenter() {},
            };
            return new Proxy({}, {
                get(target, name) {
                    if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
                    const host = compositor.host;
                    if (!host) {
                        if (name === "initialize") return () => Promise.reject(new Error("the compositor has no WebGPU host"));
                        return undefined;
                    }
                    const value = host[name];
                    return typeof value === "function" ? value.bind(host) : value;
                },
                set(target, name, value) {
                    // Per layer, so that one executor cannot mark the shared host destroyed
                    overrides[name] = value;
                    return true;
                },
                has(target, name) {
                    return Object.prototype.hasOwnProperty.call(overrides, name) ||
                        !!(compositor.host && name in compositor.host);
                },
            });
        }

        /* ---- the presenter backend (src/browser/screen.js) ---- */

        attach_presenter(presenter) {
            this.presenter = presenter;
        }

        resize(width, height) {
            width = Math.max(1, width | 0);
            height = Math.max(1, height | 0);
            if (width === this.scanoutWidth && height === this.scanoutHeight) return;
            this.scanoutWidth = width;
            this.scanoutHeight = height;
            if (this.device) this.createScanout();
        }

        /**
         * Copy a rectangle of RGBA pixels into the scanout, like putImageData:
         * (sx, sy, sw, sh) of a buffer `stride` pixels wide and `rows` high
         * goes to (dx, dy), clipped to both.
         */
        put_pixels(data, stride, rows, sx, sy, sw, sh, dx, dy) {
            if (!this.scanout) return;
            if (dx < 0) { sx -= dx; sw += dx; dx = 0; }
            if (dy < 0) { sy -= dy; sh += dy; dy = 0; }
            if (sx < 0) { dx -= sx; sw += sx; sx = 0; }
            if (sy < 0) { dy -= sy; sh += sy; sy = 0; }
            sw = Math.min(sw, stride - sx, this.scanoutWidth - dx);
            sh = Math.min(sh, rows - sy, this.scanoutHeight - dy);
            if (sw <= 0 || sh <= 0) return;
            this.device.queue.writeTexture(
                { texture: this.scanout, origin: { x: dx, y: dy, z: 0 } },
                data,
                { offset: (sy * stride + sx) * 4, bytesPerRow: stride * 4, rowsPerImage: sh },
                { width: sw, height: sh, depthOrArrayLayers: 1 });
            this.stats.uploads++;
            this.stats.uploadBytes += sw * sh * 4;
            this.scanoutDirty = true;
        }

        clear() {
            if (!this.scanout) return;
            const encoder = this.device.createCommandEncoder();
            encoder.beginRenderPass({
                colorAttachments: [{ view: this.scanout.createView(), loadOp: "clear",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
            }).end();
            this.device.queue.submit([encoder.finish()]);
            this.scanoutDirty = true;
        }

        /** The presenter finished a frame */
        present() {
            if (this.scanoutDirty || this.layers.some(layer => layer.visible))
                this.compose();
        }

        /** A data URL of the screen as it is composed right now */
        screenshot() {
            if (!this.compose()) return this.canvas.toDataURL("image/png");
            // Read in the same task as the composition, while the canvas still
            // holds its current texture: reading it later races the presentation
            return this.canvas.toDataURL("image/png");
        }

        screenshotImage() {
            const doc = this.canvas.ownerDocument || global.document;
            const image = new (doc.defaultView || global).Image();
            image.src = this.screenshot();
            return image;
        }

        /* ---- composition ---- */

        scheduleCompose() {
            if (this.composeScheduled || this.destroyed) return;
            this.composeScheduled = true;
            // After the synchronous stretch in which an executor acquired its
            // texture and submitted the frame into it
            queueMicrotask(() => {
                this.composeScheduled = false;
                this.compose();
            });
        }

        quadUniform(existing) {
            return existing || this.device.createBuffer({
                label: "v86 compositor quad", size: 32,
                usage: USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
            });
        }

        /**
         * @return {boolean} whether a frame was composed
         */
        compose() {
            if (this.destroyed || !this.device || !this.context || !this.scanout) return false;
            const width = this.canvas.width, height = this.canvas.height;
            if (!width || !height) return false;
            const device = this.device;
            let target;
            try {
                target = this.context.getCurrentTexture();
            } catch (error) {
                return false;
            }
            const toX = x => x / width * 2 - 1;
            const toY = y => 1 - y / height * 2;
            const encoder = device.createCommandEncoder({ label: "v86 compositor" });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: target.createView(), loadOp: "clear",
                    clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
            });
            pass.setPipeline(this.pipeline);

            this.scanoutUniform = this.quadUniform(this.scanoutUniform);
            device.queue.writeBuffer(this.scanoutUniform, 0, new Float32Array([
                -1, 1, toX(this.scanoutWidth), toY(this.scanoutHeight), 0, 0, 1, 1]));
            if (!this.scanoutBindGroup) {
                this.scanoutBindGroup = device.createBindGroup({
                    layout: this.pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: this.scanoutUniform } },
                        { binding: 1, resource: this.scanout.createView() },
                        { binding: 2, resource: this.nearest },
                    ],
                });
            }
            pass.setBindGroup(0, this.scanoutBindGroup);
            pass.draw(6);

            const layers = this.layers.filter(layer => layer.visible && layer.texture &&
                layer.textureDevice === device && layer.width > 0 && layer.height > 0)
                .sort((a, b) => a.z - b.z);
            for (const layer of layers) {
                const clip = layer.clip || { left: 0, top: 0, right: 1, bottom: 1 };
                const x0 = Math.max(0, Math.round(layer.x + clip.left * layer.width));
                const y0 = Math.max(0, Math.round(layer.y + clip.top * layer.height));
                const x1 = Math.min(width, Math.round(layer.x + clip.right * layer.width));
                const y1 = Math.min(height, Math.round(layer.y + clip.bottom * layer.height));
                if (x1 <= x0 || y1 <= y0) continue;
                layer.uniform = this.quadUniform(layer.uniform);
                device.queue.writeBuffer(layer.uniform, 0, new Float32Array([
                    toX(layer.x), toY(layer.y), toX(layer.x + layer.width), toY(layer.y + layer.height),
                    0, 0, 1, 1]));
                // A layer shown at its own size is copied pixel for pixel
                const sampler = layer.texture.width === layer.width &&
                    layer.texture.height === layer.height ? this.nearest : this.linear;
                if (!layer.bindGroup || layer.bindGroupSampler !== sampler) {
                    layer.bindGroup = device.createBindGroup({
                        layout: this.pipeline.getBindGroupLayout(0),
                        entries: [
                            { binding: 0, resource: { buffer: layer.uniform } },
                            { binding: 1, resource: layer.texture.createView() },
                            { binding: 2, resource: sampler },
                        ],
                    });
                    layer.bindGroupSampler = sampler;
                }
                pass.setBindGroup(0, layer.bindGroup);
                // Once per part the guest's other windows leave showing
                for (const part of layer.visibleRegion || [null]) {
                    let sx0 = x0, sy0 = y0, sx1 = x1, sy1 = y1;
                    if (part) {
                        sx0 = Math.max(sx0, Math.round(layer.x + part.left * layer.width));
                        sy0 = Math.max(sy0, Math.round(layer.y + part.top * layer.height));
                        sx1 = Math.min(sx1, Math.round(layer.x + part.right * layer.width));
                        sy1 = Math.min(sy1, Math.round(layer.y + part.bottom * layer.height));
                    }
                    if (sx1 <= sx0 || sy1 <= sy0) continue;
                    pass.setScissorRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
                    pass.draw(6);
                }
            }
            pass.end();
            device.queue.submit([encoder.finish()]);
            this.scanoutDirty = false;
            this.stats.compositions++;
            return true;
        }

        destroy() {
            this.destroyed = true;
            this.detach();
            this.layers = [];
        }
    }

    const api = { V86WebGPUCompositor, WindowLayer, LayerCanvas };
    global.V86WebGPUCompositor = V86WebGPUCompositor;
    global.V86WebGPUCompositorAPI = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
