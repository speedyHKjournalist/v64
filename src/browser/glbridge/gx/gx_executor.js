// GX: the renderer of VMware SVGA's DX contexts (VGPU10, level dx10; plan
// sections 4.6 and 5.10), D3D10-style state on WebGPU. The device side
// (src/graphics_adapters/vmware_svga/svga3d_dx.js) sends GX batches: the
// surfaces (with their contents, read from MOBs), the DX commands as the
// guest wrote them, shader tokens; this keeps the objects, translates the
// shaders (shader_ir/), builds pipelines for the state each draw uses, and
// answers readbacks and queries through the response region, like the D3D9
// executor does for D9WG.
//
// - Surfaces: buffers are GPUBuffers with a CPU copy (D3D lets the guest
//   update any byte range; WebGPU only whole dwords); textures are
//   GPUTextures (1D as 2D, cubes as 2D arrays). Formats: svga_dx_formats.js.
// - Order: uploads and copies are recorded in the command encoder, between
//   the render passes, so each draw sees the contents the guest gave before it.
// - Pipelines are cached by everything that goes into them; shader variants
//   (their interfaces depend on the input layout, the pixel shader, the
//   render targets) by the shader and those.
// - Viewports WebGPU would refuse (outside of the target) are clamped, and
//   the vertex shader moves the position to make up for it (gx_draw.viewport).
(function(global) {
    "use strict";

    const isNode = typeof module === "object" && module.exports && typeof require === "function";
    const IR = isNode ? require("../shader_ir/dxbc_frontend.js") : global.V86DXBCFrontend;
    const WGSL = isNode ? require("../shader_ir/wgsl_emitter.js") : global.V86WGSLEmitter;

    const GX_MAGIC = 0x30315847;
    const GX = {
        SURFACE_DEFINE: 1, SURFACE_DESTROY: 2, SURFACE_UPLOAD: 3, SURFACE_READBACK: 4,
        CONTEXT_DEFINE: 5, CONTEXT_DESTROY: 6, SHADER_CODE: 7, DX: 8, SURFACE_COPY: 9, QUERY_END: 10,
        COTABLE_RESET: 11, SURFACE_STRETCH: 12,
    };

    // SVGA_3D_CMD_DX_* (svga3d_cmd.h)
    const DX = {
        SET_SINGLE_CONSTANT_BUFFER: 1148, SET_SHADER_RESOURCES: 1149, SET_SHADER: 1150, SET_SAMPLERS: 1151,
        DRAW: 1152, DRAW_INDEXED: 1153, DRAW_INSTANCED: 1154, DRAW_INDEXED_INSTANCED: 1155, DRAW_AUTO: 1156,
        SET_INPUT_LAYOUT: 1157, SET_VERTEX_BUFFERS: 1158, SET_INDEX_BUFFER: 1159, SET_TOPOLOGY: 1160,
        SET_RENDERTARGETS: 1161, SET_BLEND_STATE: 1162, SET_DEPTHSTENCIL_STATE: 1163, SET_RASTERIZER_STATE: 1164,
        DEFINE_QUERY: 1165, DESTROY_QUERY: 1166, BEGIN_QUERY: 1169, END_QUERY: 1170, SET_PREDICATION: 1172,
        SET_SOTARGETS: 1173, SET_VIEWPORTS: 1174, SET_SCISSORRECTS: 1175, CLEAR_RENDERTARGET_VIEW: 1176,
        CLEAR_DEPTHSTENCIL_VIEW: 1177, PRED_COPY_REGION: 1178, PRED_COPY: 1179, PRESENTBLT: 1180, GENMIPS: 1181,
        DEFINE_SHADERRESOURCE_VIEW: 1185, DESTROY_SHADERRESOURCE_VIEW: 1186, DEFINE_RENDERTARGET_VIEW: 1187,
        DESTROY_RENDERTARGET_VIEW: 1188, DEFINE_DEPTHSTENCIL_VIEW: 1189, DESTROY_DEPTHSTENCIL_VIEW: 1190,
        DEFINE_ELEMENTLAYOUT: 1191, DESTROY_ELEMENTLAYOUT: 1192, DEFINE_BLEND_STATE: 1193, DESTROY_BLEND_STATE: 1194,
        DEFINE_DEPTHSTENCIL_STATE: 1195, DESTROY_DEPTHSTENCIL_STATE: 1196, DEFINE_RASTERIZER_STATE: 1197,
        DESTROY_RASTERIZER_STATE: 1198, DEFINE_SAMPLER_STATE: 1199, DESTROY_SAMPLER_STATE: 1200,
        DEFINE_SHADER: 1201, DESTROY_SHADER: 1202, DEFINE_STREAMOUTPUT: 1204, DESTROY_STREAMOUTPUT: 1205,
        SET_STREAMOUTPUT: 1206, BUFFER_COPY: 1209, TRANSFER_FROM_BUFFER: 1210, SURFACE_COPY_AND_READBACK: 1211,
        PRED_TRANSFER_FROM_BUFFER: 1215, SET_VS_CONSTANT_BUFFER_OFFSET: 1220, SET_CS_CONSTANT_BUFFER_OFFSET: 1225,
        RESOLVE_COPY: 1240, PRED_RESOLVE_COPY: 1241, PRED_CONVERT_REGION: 1242, PRED_CONVERT: 1243,
        DEFINE_UA_VIEW: 1245, DESTROY_UA_VIEW: 1246, CLEAR_UA_VIEW_UINT: 1247, CLEAR_UA_VIEW_FLOAT: 1248,
        SET_UA_VIEWS: 1250, DRAW_INDEXED_INSTANCED_INDIRECT: 1251, DRAW_INSTANCED_INDIRECT: 1252, DISPATCH: 1253,
        DISPATCH_INDIRECT: 1254, TRANSFER_TO_BUFFER: 1257, SET_CS_UA_VIEWS: 1268, SET_MIN_LOD: 1269,
        DEFINE_DEPTHSTENCIL_VIEW_V2: 1272, DEFINE_STREAMOUTPUT_WITH_MOB: 1273, BIND_STREAMOUTPUT: 1275,
        PRED_STAGING_COPY: 1281, STAGING_COPY: 1282, PRED_STAGING_COPY_REGION: 1283, SET_VERTEX_BUFFERS_V2: 1284,
        SET_INDEX_BUFFER_V2: 1285, SET_VERTEX_BUFFERS_OFFSET_AND_SIZE: 1286, SET_INDEX_BUFFER_OFFSET_AND_SIZE: 1287,
        DEFINE_RASTERIZER_STATE_V2: 1288, PRED_STAGING_CONVERT_REGION: 1289, PRED_STAGING_CONVERT: 1290,
        STAGING_BUFFER_COPY: 1291,
    };

    const SVGA3D_BUFFER = 37;
    const SVGA3D_R16_UINT = 89, SVGA3D_R32_UINT = 77;
    const SURFACE_CUBEMAP = 1, SURFACE_VOLUME = 0x8000;
    const INVALID = 0xFFFFFFFF;
    const SHADER_VS = 1, SHADER_PS = 2, SHADER_GS = 3, SHADER_HS = 4, SHADER_DS = 5, SHADER_CS = 6;
    const COTABLE = { RTVIEW: 0, DSVIEW: 1, SRVIEW: 2, ELEMENTLAYOUT: 3, BLENDSTATE: 4, DEPTHSTENCIL: 5,
        RASTERIZERSTATE: 6, SAMPLER: 7, STREAMOUTPUT: 8, DXQUERY: 9, DXSHADER: 10, UAVIEW: 11 };

    // response region (d9wg): query slots below 16 KiB, readbacks after
    const QUERY_REGION_BYTES = 16 * 1024;
    const RESPONSE_OK = 1, RESPONSE_FAILED = 2;

    const BUFFER_USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
    const TEXTURE_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };

    const DRAW_SLOT = 256;
    const DRAW_SLOTS = 4096;

    const BLEND_FACTORS = [null, "zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst-alpha",
        "one-minus-dst-alpha", "dst", "one-minus-dst", "src-alpha-saturated", "constant", "one-minus-constant",
        "src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha", "constant", "one-minus-constant"];
    const BLEND_OPS = [null, "add", "subtract", "reverse-subtract", "min", "max"];
    const COMPARE = [null, "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];
    const STENCIL_OPS = [null, "keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert", "increment-wrap", "decrement-wrap"];
    const ADDRESS = [null, "repeat", "mirror-repeat", "clamp-to-edge", "clamp-to-edge", "mirror-repeat", "clamp-to-edge"];
    // SVGA3dPrimitiveType -> WebGPU topology (adjacency drawn without it)
    const TOPOLOGY = [null, "triangle-list", "point-list", "line-list", "line-strip", "triangle-strip", null,
        "line-list", "line-strip", "triangle-list", "triangle-strip"];

    const SRGB = {
        "rgba8unorm": "rgba8unorm-srgb", "rgba8unorm-srgb": "rgba8unorm", "bgra8unorm": "bgra8unorm-srgb",
        "bgra8unorm-srgb": "bgra8unorm", "bc1-rgba-unorm": "bc1-rgba-unorm-srgb", "bc1-rgba-unorm-srgb": "bc1-rgba-unorm",
        "bc2-rgba-unorm": "bc2-rgba-unorm-srgb", "bc2-rgba-unorm-srgb": "bc2-rgba-unorm",
        "bc3-rgba-unorm": "bc3-rgba-unorm-srgb", "bc3-rgba-unorm-srgb": "bc3-rgba-unorm",
        "bc7-rgba-unorm": "bc7-rgba-unorm-srgb", "bc7-rgba-unorm-srgb": "bc7-rgba-unorm",
    };

    function align(value, to) {
        return Math.ceil(value / to) * to;
    }

    function f32(bits) {
        return new Float32Array(new Uint32Array([bits]).buffer)[0];
    }

    function isDepthFormat(format) {
        return format.startsWith("depth") || format === "stencil8";
    }

    function hasStencil(format) {
        return format.includes("stencil");
    }

    function sampleKind(format) {
        if (isDepthFormat(format)) return "depth";
        if (/sint$/.test(format)) return "sint";
        if (/uint$/.test(format)) return "uint";
        return "float";
    }

    class GXExecutor {
        /**
         * @param options { device, formats: [[gpu, can, vertex, bw, bh, bytes], ...] by SVGA format,
         *                  features: { float32Filterable, ... } }
         */
        constructor(options) {
            this.device = options.device;
            this.formats = options.formats;
            this.features = options.features || {};
            this.write = null;
            this.surfaces = new Map();
            this.contexts = new Map();
            this.encoderInstance = null;
            this.pass = null;
            this.passKey = "";
            this.pending = [];
            this.transient = [];
            this.pipelines = new Map();
            this.modules = new Map();
            this.samplerCache = new Map();
            this.warned = new Set();
            this.errors = 0;
            this.stats = { batches: 0, draws: 0, pipelines: 0, shaders: 0, passes: 0, uploads: 0, readbacks: 0 };
            this.drawBuffer = this.device.createBuffer({ size: DRAW_SLOT * DRAW_SLOTS,
                usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST });
            this.drawSlot = 0;
            this.occlusion = null;
            this.activeOcclusion = new Map();
            this.blitPipelines = new Map();
            this.emptyLayout = this.device.createBindGroupLayout({ entries: [] });
            this.emptyGroup = this.device.createBindGroup({ layout: this.emptyLayout, entries: [] });
            this.dummyBuffer = this.device.createBuffer({ size: 65536, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.STORAGE | BUFFER_USAGE.VERTEX });
            this.dummyTextures = new Map();
            this.linearSampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });
            this.nearestSampler = this.device.createSampler({});
            if (typeof this.device.addEventListener === "function") {
                this.device.addEventListener("uncapturederror", event => this.warn("webgpu:" + (event.error && event.error.message),
                    "WebGPU error: " + (event.error && event.error.message)));
            }
        }

        warn(key, text) {
            if (this.warned.has(key)) return;
            this.warned.add(key);
            if (this.warned.size < 200) console.warn("[gx] " + text);
        }

        reset() {
            this.endPass();
            this.flushEncoder();
            for (const s of this.surfaces.values()) this.releaseSurface(s);
            this.surfaces.clear();
            this.contexts.clear();
            this.activeOcclusion.clear();
        }

        /**
         * Run a GX batch
         * @param bytes Uint8Array
         * @param options { writeResponse(offset, bytes) }
         */
        async submit(bytes, options) {
            this.write = options.writeResponse;
            const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
            if (words[0] !== GX_MAGIC) throw new Error("not a GX batch");
            const end = Math.min(words[2], words.length);
            this.stats.batches++;
            for (let at = 4; at + 2 <= end;) {
                const op = words[at], n = words[at + 1];
                const body = words.subarray(at + 2, at + 2 + n);
                at += 2 + n;
                try {
                    this.command(op, body);
                } catch (error) {
                    this.errors++;
                    this.warn("exception:" + op + ":" + (body[1] || 0) + ":" + error.message,
                        "command " + op + (op === GX.DX ? " (DX " + body[1] + ")" : "") + " failed: " + (error.stack || error));
                }
            }
            this.endPass();
            this.flushEncoder();
            const pending = this.pending.splice(0);
            if (pending.length) await Promise.all(pending);
        }

        command(op, b) {
            switch (op) {
                case GX.SURFACE_DEFINE: return this.defineSurface(b);
                case GX.SURFACE_DESTROY: {
                    const s = this.surfaces.get(b[0]);
                    if (s) this.releaseSurface(s);
                    this.surfaces.delete(b[0]);
                    return;
                }
                case GX.SURFACE_UPLOAD: return this.upload(b);
                case GX.SURFACE_READBACK: return this.readback(b);
                case GX.CONTEXT_DEFINE: this.contexts.set(b[0], new GXContext(b[0])); return;
                case GX.CONTEXT_DESTROY: this.contexts.delete(b[0]); return;
                case GX.SHADER_CODE: return this.shaderCode(b);
                case GX.DX: return this.dx(b[0], b[1], b.subarray(2));
                case GX.SURFACE_COPY: return this.copySurface(b);
                case GX.SURFACE_STRETCH: return this.stretch(b);
                case GX.QUERY_END: return this.endQuery(b);
                case GX.COTABLE_RESET: {
                    const c = this.contexts.get(b[0]);
                    if (c) c.reset(b[1]);
                    return;
                }
            }
            this.warn("op" + op, "unknown GX op " + op);
        }

        // ------------------------------------------------------------------
        // Encoder and passes

        encoder() {
            if (!this.encoderInstance) this.encoderInstance = this.device.createCommandEncoder();
            return this.encoderInstance;
        }

        endPass() {
            if (!this.pass) return;
            if (this.passOcclusion !== null) this.pass.endOcclusionQuery();
            this.pass.end();
            this.pass = null;
            this.passKey = "";
            this.passOcclusion = null;
        }

        flushEncoder() {
            this.endPass();
            if (this.encoderInstance) {
                this.device.queue.submit([this.encoderInstance.finish()]);
                this.encoderInstance = null;
            }
            for (const buffer of this.transient.splice(0)) buffer.destroy();
        }

        /** A buffer with these bytes, to copy from in the encoder */
        staging(bytes) {
            const size = align(Math.max(4, bytes.length), 4);
            const buffer = this.device.createBuffer({ size, usage: BUFFER_USAGE.COPY_SRC, mappedAtCreation: true });
            new Uint8Array(buffer.getMappedRange()).set(bytes);
            buffer.unmap();
            this.transient.push(buffer);
            return buffer;
        }

        // ------------------------------------------------------------------
        // Surfaces

        formatOf(format) {
            const f = this.formats[format];
            if (!f) return null;
            return { gpu: f[0], can: f[1], vertex: f[2], bw: f[3], bh: f[4], bytes: f[5] };
        }

        defineSurface(b) {
            const [sid, format, flags, flags2, width, height, depth, mips, layers, samples, cube] = b;
            const old = this.surfaces.get(sid);
            if (old) this.releaseSurface(old);
            const f = this.formatOf(format);
            const s = { sid, format, f, flags, width: Math.max(1, width), height: Math.max(1, height),
                depth: Math.max(1, depth), mips: Math.max(1, mips), layers: Math.max(1, layers), samples,
                cube: !!cube, buffer: null, texture: null, shadow: null, generation: 0, views: new Map() };
            this.surfaces.set(sid, s);
            if (format === SVGA3D_BUFFER) {
                const size = align(Math.max(4, s.width * s.height * s.depth), 4);
                s.shadow = new Uint8Array(size);
                s.buffer = this.device.createBuffer({ size, usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.INDEX |
                    BUFFER_USAGE.UNIFORM | BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.COPY_DST |
                    BUFFER_USAGE.INDIRECT });
                return;
            }
            if (!f || !f.gpu) {
                this.warn("format" + format, "surface format " + format + " has no WebGPU texture");
                return;
            }
            const volume = s.depth > 1 || !!(flags & SURFACE_VOLUME);
            const compressed = f.gpu.startsWith("bc");
            const target = (f.can.includes("r") || f.can.includes("d")) && !compressed && !volume;
            const multisampled = samples > 1;
            const descriptor = {
                size: [s.width, s.height, volume ? s.depth : s.layers],
                dimension: volume ? "3d" : "2d",
                format: f.gpu,
                mipLevelCount: multisampled ? 1 : Math.min(s.mips, mipCount(s.width, s.height, volume ? s.depth : 1)),
                sampleCount: multisampled ? 4 : 1,
                usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_SRC | TEXTURE_USAGE.COPY_DST |
                    (target ? TEXTURE_USAGE.RENDER_ATTACHMENT : 0),
            };
            // (multisampled textures are drawn into, sampled and resolved; not copied)
            if (multisampled) descriptor.usage = TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.RENDER_ATTACHMENT;
            if (SRGB[f.gpu]) descriptor.viewFormats = [SRGB[f.gpu]];
            s.volume = volume;
            s.texture = this.device.createTexture(descriptor);
            s.gpuMips = descriptor.mipLevelCount;
            // "X" formats read as opaque: their alpha starts at 1
            if (f.can.includes("x") && target) this.clearTexture(s, [0, 0, 0, 1]);
        }

        releaseSurface(s) {
            if (s.buffer) s.buffer.destroy();
            if (s.texture) s.texture.destroy();
            s.buffer = s.texture = null;
            s.generation++;
        }

        /** The size in blocks of a mip level */
        level(s, mip) {
            const width = Math.max(1, s.width >> mip), height = Math.max(1, s.height >> mip), depth = Math.max(1, s.depth >> mip);
            const f = s.f;
            return { width, height, depth, columns: Math.ceil(width / f.bw), rows: Math.ceil(height / f.bh),
                pitch: Math.ceil(width / f.bw) * f.bytes };
        }

        upload(b) {
            const [sid, layer, mip, x, y, z, w, h, d, pitch, slicePitch] = b;
            const s = this.surfaces.get(sid);
            if (!s) return;
            const data = new Uint8Array(b.buffer, b.byteOffset + 11 * 4, b.byteLength - 11 * 4);
            this.stats.uploads++;
            if (s.buffer) {
                const count = Math.min(w, s.shadow.length - x);
                if (count <= 0) return;
                s.shadow.set(data.subarray(0, count), x);
                // whole dwords: the bytes around the range come from the CPU copy
                const start = x & ~3, stop = Math.min(s.shadow.length, align(x + count, 4));
                this.endPass();
                this.encoder().copyBufferToBuffer(this.staging(s.shadow.subarray(start, stop)), 0, s.buffer, start, stop - start);
                return;
            }
            if (!s.texture || mip >= s.gpuMips) return;
            const f = s.f;
            const columns = Math.ceil(w / f.bw), rows = Math.ceil(h / f.bh);
            const rowBytes = Math.min(pitch, columns * f.bytes);
            const emulated = f.can.includes("e");
            const gpuRow = emulated ? columns * 4 : rowBytes;
            const alignedPitch = align(Math.max(gpuRow, 1), 256);
            const slices = Math.max(1, d);
            const staged = new Uint8Array(alignedPitch * rows * slices);
            for (let slice = 0; slice < slices; slice++) {
                for (let row = 0; row < rows; row++) {
                    const from = slice * slicePitch + row * pitch;
                    const to = (slice * rows + row) * alignedPitch;
                    if (emulated) expandRow(s.format, f.bytes, data.subarray(from, from + rowBytes), staged.subarray(to, to + gpuRow));
                    else staged.set(data.subarray(from, from + rowBytes), to);
                }
            }
            if (!emulated) this.convertIn(s, staged, alignedPitch, columns, rows * slices);
            this.endPass();
            const level = this.level(s, mip);
            const copyWidth = Math.min(align(w, f.bw), align(level.width, f.bw) - x);
            const copyHeight = Math.min(align(h, f.bh), align(level.height, f.bh) - y);
            if (copyWidth <= 0 || copyHeight <= 0) return;
            this.encoder().copyBufferToTexture(
                { buffer: this.staging(staged), bytesPerRow: alignedPitch, rowsPerImage: rows },
                { texture: s.texture, mipLevel: mip, origin: [x, y, s.volume ? z : layer], aspect: "all" },
                [copyWidth, copyHeight, slices]);
        }

        /** Guest pixels into what the texture holds: opaque alpha for "X" formats */
        convertIn(s, bytes, pitch, columns, rows) {
            const f = s.f;
            if (f.can.includes("x") && f.bytes === 4) {
                for (let row = 0; row < rows; row++) {
                    for (let c = 0; c < columns; c++) bytes[row * pitch + c * 4 + 3] = 255;
                }
            }
        }

        readback(b) {
            const [sid, layer, mip, x, y, z, w, h, d, id] = b;
            const s = this.surfaces.get(sid);
            const fail = () => this.respond(id, null);
            if (!s) return fail();
            this.stats.readbacks++;
            this.endPass();
            if (s.buffer) {
                const start = x & ~3, stop = Math.min(s.shadow.length, align(x + w, 4));
                const target = this.device.createBuffer({ size: Math.max(4, stop - start), usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
                this.encoder().copyBufferToBuffer(s.buffer, start, target, 0, stop - start);
                this.flushEncoder();
                this.pending.push(target.mapAsync(1).then(() => {
                    const bytes = new Uint8Array(target.getMappedRange()).slice(x - start, x - start + w);
                    target.destroy();
                    s.shadow.set(bytes, x);
                    this.respond(id, bytes);
                }, () => fail()));
                return;
            }
            if (!s.texture || s.samples > 1 || isDepthFormat(s.f.gpu) && s.f.gpu !== "depth32float" && s.f.gpu !== "depth16unorm") {
                this.warn("readback" + s.format, "reading back format " + s.format + " is not supported");
                return fail();
            }
            const f = s.f;
            const columns = Math.ceil(w / f.bw), rows = Math.ceil(h / f.bh);
            const emulated = f.can.includes("e");
            const rowBytes = columns * f.bytes, gpuRow = emulated ? columns * 4 : rowBytes, alignedPitch = align(gpuRow, 256);
            const slices = Math.max(1, d);
            const target = this.device.createBuffer({ size: alignedPitch * rows * slices, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
            this.encoder().copyTextureToBuffer(
                { texture: s.texture, mipLevel: mip, origin: [x, y, s.volume ? z : layer], aspect: isDepthFormat(f.gpu) ? "depth-only" : "all" },
                { buffer: target, bytesPerRow: alignedPitch, rowsPerImage: rows },
                [align(w, f.bw), align(h, f.bh), slices]);
            this.flushEncoder();
            this.pending.push(target.mapAsync(1).then(() => {
                const mapped = new Uint8Array(target.getMappedRange());
                const out = new Uint8Array(rowBytes * rows * slices);
                for (let r = 0; r < rows * slices; r++) {
                    const row = mapped.subarray(r * alignedPitch, r * alignedPitch + gpuRow);
                    if (emulated) packRow(s.format, f.bytes, row, out.subarray(r * rowBytes, (r + 1) * rowBytes));
                    else out.set(row, r * rowBytes);
                }
                target.destroy();
                this.respond(id, out);
            }, () => fail()));
        }

        /** A readback answer: D9WGReadbackResponse (id, bytes, 0, status, then the bytes) */
        respond(id, bytes) {
            const out = new Uint8Array(16 + (bytes ? bytes.length : 0));
            const view = new DataView(out.buffer);
            view.setUint32(0, id, true);
            view.setUint32(4, bytes ? bytes.length : 0, true);
            view.setUint32(12, bytes ? RESPONSE_OK : RESPONSE_FAILED, true);
            if (bytes) out.set(bytes, 16);
            if (this.write) this.write(QUERY_REGION_BYTES, out);
        }

        clearTexture(s, color) {
            for (let layer = 0; layer < (s.volume ? 1 : s.layers); layer++) {
                this.endPass();
                const pass = this.encoder().beginRenderPass({ colorAttachments: [{
                    view: s.texture.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }),
                    loadOp: "clear", storeOp: "store", clearValue: color }] });
                pass.end();
            }
        }

        copySurface(b) {
            const [src, sLayer, sMip, sx, sy, sz, dst, dLayer, dMip, dx, dy, dz, w, h, d] = b;
            const S = this.surfaces.get(src), D = this.surfaces.get(dst);
            if (!S || !D) return;
            this.endPass();
            if (S.buffer && D.buffer) return this.copyBuffer(D, dx, S, sx, w);
            if (!S.texture || !D.texture) return;
            this.copyTexture(S, sLayer, sMip, sx, sy, sz, D, dLayer, dMip, dx, dy, dz, w, h, d);
        }

        copyBuffer(D, dx, S, sx, w) {
            const count = Math.min(w, S.shadow.length - sx, D.shadow.length - dx);
            if (count <= 0) return;
            D.shadow.set(S.shadow.subarray(sx, sx + count), dx);
            this.endPass();
            if (!(sx & 3) && !(dx & 3) && !(count & 3)) {
                this.encoder().copyBufferToBuffer(S.buffer, sx, D.buffer, dx, count);
                return;
            }
            const start = dx & ~3, stop = Math.min(D.shadow.length, align(dx + count, 4));
            this.encoder().copyBufferToBuffer(this.staging(D.shadow.subarray(start, stop)), 0, D.buffer, start, stop - start);
        }

        copyTexture(S, sLayer, sMip, sx, sy, sz, D, dLayer, dMip, dx, dy, dz, w, h, d) {
            if (sMip >= S.gpuMips || dMip >= D.gpuMips) return;
            const sameFamily = S.f.gpu === D.f.gpu || SRGB[S.f.gpu] === D.f.gpu;
            const sl = this.level(S, sMip), dl = this.level(D, dMip);
            w = Math.min(w, sl.width - sx, dl.width - dx);
            h = Math.min(h, sl.height - sy, dl.height - dy);
            d = Math.max(1, Math.min(d, S.volume ? sl.depth - sz : 1, D.volume ? dl.depth - dz : 1));
            if (w <= 0 || h <= 0) return;
            if (!sameFamily || S.samples !== D.samples) {
                // a different format: drawn, not copied
                return this.blit(S, sLayer, sMip, [sx, sy, sx + w, sy + h], D, dLayer, dMip, [dx, dy, dx + w, dy + h], false);
            }
            this.endPass();
            this.encoder().copyTextureToTexture(
                { texture: S.texture, mipLevel: sMip, origin: [sx, sy, S.volume ? sz : sLayer] },
                { texture: D.texture, mipLevel: dMip, origin: [dx, dy, D.volume ? dz : dLayer] },
                [align(w, S.f.bw), align(h, S.f.bh), d]);
        }

        stretch(b) {
            const [src, sLayer, sMip, sl, st, sr, sb, dst, dLayer, dMip, dl, dt, dr, db, linear] = b;
            const S = this.surfaces.get(src), D = this.surfaces.get(dst);
            if (!S || !D || !S.texture || !D.texture) return;
            this.blit(S, sLayer, sMip, [sl, st, sr, sb], D, dLayer, dMip, [dl, dt, dr, db], !!linear);
        }

        /**
         * Draw a rectangle of a texture into one of another, scaled
         */
        blit(S, sLayer, sMip, [sl, st, sr, sb], D, dLayer, dMip, [dl, dt, dr, db], linear) {
            const format = D.f.gpu;
            if (isDepthFormat(format) || isDepthFormat(S.f.gpu)) return this.warn("blit-depth", "blits of depth surfaces are not supported");
            const kind = sampleKind(S.f.gpu);
            const key = format + ":" + kind;
            let pipeline = this.blitPipelines.get(key);
            if (!pipeline) {
                const type = kind === "sint" ? "i32" : kind === "uint" ? "u32" : "f32";
                const outType = sampleKind(format) === "sint" ? "i32" : sampleKind(format) === "uint" ? "u32" : "f32";
                const code = `
struct Box { src: vec4<f32>, size: vec4<f32> }
@group(0) @binding(0) var t: texture_2d<${type}>;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var<uniform> box: Box;
struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
    let corner = vec2<f32>(f32(i & 1u), f32(i >> 1u));
    var out: Out;
    out.position = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
    out.uv = box.src.xy + corner * (box.src.zw - box.src.xy);
    return out;
}
@fragment fn fs(input: Out) -> @location(0) vec4<${outType}> {
    ${type === "f32" ? `return vec4<${outType}>(textureSampleLevel(t, s, input.uv / box.size.xy, 0.0));` :
        `return vec4<${outType}>(textureLoad(t, vec2<i32>(input.uv), 0));`}
}`;
                const module = this.device.createShaderModule({ code });
                pipeline = this.device.createRenderPipeline({ layout: "auto",
                    vertex: { module, entryPoint: "vs" },
                    fragment: { module, entryPoint: "fs", targets: [{ format }] },
                    primitive: { topology: "triangle-strip" } });
                this.blitPipelines.set(key, pipeline);
            }
            const sLevel = this.level(S, sMip), dLevel = this.level(D, dMip);
            dl = Math.max(0, dl); dt = Math.max(0, dt); dr = Math.min(dr, dLevel.width); db = Math.min(db, dLevel.height);
            if (dr <= dl || db <= dt) return;
            const uniform = this.device.createBuffer({ size: 32, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST });
            this.device.queue.writeBuffer(uniform, 0, new Float32Array([sl, st, sr, sb, sLevel.width, sLevel.height, 0, 0]));
            this.transient.push(uniform);
            const view = S.texture.createView({ dimension: "2d", baseMipLevel: sMip, mipLevelCount: 1,
                baseArrayLayer: S.volume ? 0 : sLayer, arrayLayerCount: 1 });
            const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: linear && kind === "float" ? this.linearSampler : this.nearestSampler },
                { binding: 2, resource: { buffer: uniform } }] });
            this.endPass();
            const pass = this.encoder().beginRenderPass({ colorAttachments: [{
                view: D.texture.createView({ dimension: "2d", baseMipLevel: dMip, mipLevelCount: 1, baseArrayLayer: D.volume ? 0 : dLayer, arrayLayerCount: 1 }),
                loadOp: "load", storeOp: "store" }] });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.setViewport(dl, dt, dr - dl, db - dt, 0, 1);
            pass.setScissorRect(dl, dt, dr - dl, db - dt);
            pass.draw(4);
            pass.end();
        }

        // ------------------------------------------------------------------
        // Shaders

        shaderCode(b) {
            const [cid, shid, type] = b;
            const c = this.contexts.get(cid);
            if (!c) return;
            const tokens = new Uint32Array(b.buffer.slice(b.byteOffset + 12, b.byteOffset + b.byteLength));
            let program = null;
            try {
                program = IR.decode(tokens);
            } catch (error) {
                this.warn("decode:" + error.message, "shader " + shid + " does not decode: " + error.message);
            }
            const old = c.shaders.get(shid);
            c.shaders.set(shid, { type, program, generation: (old ? old.generation : 0) + 1, id: ++this.stats.shaders });
        }

        /** A shader module for a shader in an interface, translated the first time */
        module(shader, options) {
            const key = shader.id + ":" + JSON.stringify(options);
            let entry = this.modules.get(key);
            if (entry) return entry;
            const result = WGSL.emit(shader.program, options);
            for (const warning of result.warnings) this.warn("wgsl:" + warning, "shader: " + warning);
            const module = this.device.createShaderModule({ code: result.code });
            if (typeof module.getCompilationInfo === "function") {
                module.getCompilationInfo().then(info => {
                    for (const m of info.messages) {
                        if (m.type === "error") {
                            this.warn("compile:" + key, "WGSL error: " + m.message + " at line " + m.lineNum + "\n" + result.code);
                        }
                    }
                });
            }
            entry = { module, result };
            this.modules.set(key, entry);
            return entry;
        }

        // ------------------------------------------------------------------
        // DX commands

        dx(cid, id, p) {
            const c = this.contexts.get(cid);
            if (!c) return this.warn("cid" + cid, "a DX command for an unknown context");
            const st = c.state;
            const words = n => p.subarray(n);
            switch (id) {
                // definitions
                case DX.DEFINE_RENDERTARGET_VIEW:
                    c.rtvs.set(p[0], { sid: p[1], format: p[2], dimension: p[3], mip: p[4], first: p[5], count: p[6] });
                    return;
                case DX.DEFINE_DEPTHSTENCIL_VIEW:
                case DX.DEFINE_DEPTHSTENCIL_VIEW_V2:
                    c.dsvs.set(p[0], { sid: p[1], format: p[2], dimension: p[3], mip: p[4], first: p[5], count: p[6], flags: p[7] & 0xFF });
                    return;
                case DX.DEFINE_SHADERRESOURCE_VIEW:
                    c.srvs.set(p[0], { sid: p[1], format: p[2], dimension: p[3], desc: Array.from(p.subarray(4, 8)) });
                    return;
                case DX.DEFINE_UA_VIEW:
                    c.uavs.set(p[0], { sid: p[1], format: p[2], dimension: p[3], desc: Array.from(p.subarray(4, 9)) });
                    return;
                case DX.DEFINE_ELEMENTLAYOUT: {
                    const elements = [];
                    for (let at = 1; at + 6 <= p.length; at += 6) {
                        elements.push({ slot: p[at], offset: p[at + 1], format: p[at + 2], instanced: p[at + 3] === 1,
                            rate: p[at + 4], register: p[at + 5] });
                    }
                    c.layouts.set(p[0], { elements, generation: ++c.generation });
                    return;
                }
                case DX.DEFINE_BLEND_STATE: c.blends.set(p[0], { words: Array.from(p.subarray(1, 26)), generation: ++c.generation }); return;
                case DX.DEFINE_DEPTHSTENCIL_STATE: c.depths.set(p[0], { words: Array.from(p.subarray(1, 5)), generation: ++c.generation }); return;
                case DX.DEFINE_RASTERIZER_STATE:
                case DX.DEFINE_RASTERIZER_STATE_V2:
                    c.rasters.set(p[0], { words: Array.from(p.subarray(1, 8)), generation: ++c.generation });
                    return;
                case DX.DEFINE_SAMPLER_STATE: c.samplers.set(p[0], { words: Array.from(p.subarray(1, 11)), sampler: null }); return;
                case DX.DEFINE_SHADER: c.shaders.set(p[0], { type: p[1], program: null, generation: 0, id: ++this.stats.shaders }); return;
                case DX.DEFINE_QUERY: c.queries.set(p[0], { type: p[1], indices: [] }); return;
                case DX.DEFINE_STREAMOUTPUT:
                case DX.DEFINE_STREAMOUTPUT_WITH_MOB:
                case DX.BIND_STREAMOUTPUT:
                case DX.DESTROY_STREAMOUTPUT:
                case DX.SET_STREAMOUTPUT:
                    return;
                case DX.DESTROY_RENDERTARGET_VIEW: c.rtvs.delete(p[0]); return;
                case DX.DESTROY_DEPTHSTENCIL_VIEW: c.dsvs.delete(p[0]); return;
                case DX.DESTROY_SHADERRESOURCE_VIEW: c.srvs.delete(p[0]); return;
                case DX.DESTROY_UA_VIEW: c.uavs.delete(p[0]); return;
                case DX.DESTROY_ELEMENTLAYOUT: c.layouts.delete(p[0]); return;
                case DX.DESTROY_BLEND_STATE: c.blends.delete(p[0]); return;
                case DX.DESTROY_DEPTHSTENCIL_STATE: c.depths.delete(p[0]); return;
                case DX.DESTROY_RASTERIZER_STATE: c.rasters.delete(p[0]); return;
                case DX.DESTROY_SAMPLER_STATE: c.samplers.delete(p[0]); return;
                case DX.DESTROY_SHADER: c.shaders.delete(p[0]); return;
                case DX.DESTROY_QUERY: c.queries.delete(p[0]); return;

                // state
                case DX.SET_SINGLE_CONSTANT_BUFFER: {
                    const stage = c.stage(p[1]);
                    if (stage && p[0] < 16) stage.cbs[p[0]] = { sid: p[2], offset: p[3], size: p[4] };
                    return;
                }
                case DX.SET_SHADER_RESOURCES: {
                    const stage = c.stage(p[1]);
                    if (!stage) return;
                    for (let i = 2; i < p.length && p[0] + i - 2 < 128; i++) stage.srvs[p[0] + i - 2] = p[i];
                    return;
                }
                case DX.SET_SAMPLERS: {
                    const stage = c.stage(p[1]);
                    if (!stage) return;
                    for (let i = 2; i < p.length && p[0] + i - 2 < 16; i++) stage.samplers[p[0] + i - 2] = p[i];
                    return;
                }
                case DX.SET_SHADER: {
                    const stage = c.stage(p[1]);
                    if (stage) stage.shader = p[0];
                    return;
                }
                case DX.SET_INPUT_LAYOUT: st.layout = p[0]; return;
                case DX.SET_VERTEX_BUFFERS:
                case DX.SET_VERTEX_BUFFERS_V2: {
                    const each = id === DX.SET_VERTEX_BUFFERS ? 3 : 4;
                    for (let i = 0; 1 + each * (i + 1) <= p.length && p[0] + i < 32; i++) {
                        const at = 1 + each * i;
                        st.vbs[p[0] + i] = { sid: p[at], stride: p[at + 1], offset: p[at + 2] };
                    }
                    return;
                }
                case DX.SET_VERTEX_BUFFERS_OFFSET_AND_SIZE:
                    for (let i = 0; 1 + 3 * (i + 1) <= p.length && p[0] + i < 32; i++) {
                        const at = 1 + 3 * i, vb = st.vbs[p[0] + i];
                        st.vbs[p[0] + i] = { sid: vb ? vb.sid : INVALID, stride: p[at], offset: p[at + 1] };
                    }
                    return;
                case DX.SET_INDEX_BUFFER:
                case DX.SET_INDEX_BUFFER_V2:
                    st.ib = { sid: p[0], format: p[1], offset: p[2] };
                    return;
                case DX.SET_INDEX_BUFFER_OFFSET_AND_SIZE:
                    st.ib = { sid: st.ib.sid, format: p[0], offset: p[1] };
                    return;
                case DX.SET_TOPOLOGY: st.topology = p[0]; return;
                case DX.SET_RENDERTARGETS:
                    st.dsv = p[0];
                    st.rtvs = Array.from(p.subarray(1, Math.min(p.length, 9)));
                    return;
                case DX.SET_BLEND_STATE:
                    st.blend = p[0];
                    st.blendFactor = [f32(p[1]), f32(p[2]), f32(p[3]), f32(p[4])];
                    st.sampleMask = p[5];
                    return;
                case DX.SET_DEPTHSTENCIL_STATE: st.depth = p[0]; st.stencilRef = p[1]; return;
                case DX.SET_RASTERIZER_STATE: st.raster = p[0]; return;
                case DX.SET_VIEWPORTS:
                    st.viewports = [];
                    for (let at = 1; at + 6 <= p.length; at += 6) st.viewports.push(Array.from(p.subarray(at, at + 6), f32));
                    return;
                case DX.SET_SCISSORRECTS:
                    st.scissors = [];
                    for (let at = 1; at + 4 <= p.length; at += 4) st.scissors.push(Array.from(p.subarray(at, at + 4), v => v | 0));
                    return;
                case DX.SET_PREDICATION: st.predication = [p[0], p[1]]; return;
                case DX.SET_SOTARGETS:
                    if (Array.from(p.subarray(1)).some((v, i) => i % 3 === 0 && v !== INVALID && v !== 0)) {
                        this.warn("so", "stream output is not supported yet");
                    }
                    return;
                case DX.SET_UA_VIEWS:
                case DX.SET_CS_UA_VIEWS:
                    return;
                case DX.SET_MIN_LOD:
                    return;
            }
            if (id >= DX.SET_VS_CONSTANT_BUFFER_OFFSET && id <= DX.SET_CS_CONSTANT_BUFFER_OFFSET) {
                const stage = c.stage(SHADER_VS + id - DX.SET_VS_CONSTANT_BUFFER_OFFSET);
                if (stage && p[0] < 16 && stage.cbs[p[0]]) stage.cbs[p[0]] = { ...stage.cbs[p[0]], offset: p[1] };
                return;
            }
            switch (id) {
                case DX.DRAW: return this.draw(c, { count: p[0], first: p[1], instances: 1, firstInstance: 0 });
                case DX.DRAW_INDEXED: return this.draw(c, { indexed: true, count: p[0], first: p[1], base: p[2] | 0, instances: 1, firstInstance: 0 });
                case DX.DRAW_INSTANCED: return this.draw(c, { count: p[0], instances: p[1], first: p[2], firstInstance: p[3] });
                case DX.DRAW_INDEXED_INSTANCED:
                    return this.draw(c, { indexed: true, count: p[0], instances: p[1], first: p[2], base: p[3] | 0, firstInstance: p[4] });
                case DX.DRAW_INSTANCED_INDIRECT:
                case DX.DRAW_INDEXED_INSTANCED_INDIRECT:
                    return this.draw(c, { indexed: id === DX.DRAW_INDEXED_INSTANCED_INDIRECT, indirect: { sid: p[0], offset: p[1] } });
                case DX.DRAW_AUTO:
                    return this.warn("drawauto", "DrawAuto (stream output) is not supported yet");
                case DX.DISPATCH:
                case DX.DISPATCH_INDIRECT:
                    return this.warn("dispatch", "compute is not supported yet");
                case DX.CLEAR_RENDERTARGET_VIEW: return this.clearRTV(c, p[0], [f32(p[1]), f32(p[2]), f32(p[3]), f32(p[4])]);
                case DX.CLEAR_DEPTHSTENCIL_VIEW: return this.clearDSV(c, p[1], p[0] & 0xFFFF, p[0] >>> 16, f32(p[2]));
                case DX.CLEAR_UA_VIEW_UINT:
                case DX.CLEAR_UA_VIEW_FLOAT:
                    return this.warn("uav-clear", "UAV clears are not supported yet");
                case DX.PRED_COPY_REGION:
                case DX.PRED_STAGING_COPY_REGION:
                    return this.copyRegion(p[0], p[1], p[2], p[3], Array.from(p.subarray(4, 13)));
                case DX.PRED_COPY:
                case DX.PRED_STAGING_COPY:
                case DX.STAGING_COPY:
                    return this.copyWhole(p[0], p[1]);
                case DX.SURFACE_COPY_AND_READBACK:
                    return this.copyRegion(p[1], 0, p[0], 0, Array.from(p.subarray(2, 11)));
                case DX.BUFFER_COPY:
                case DX.STAGING_BUFFER_COPY: {
                    const D = this.surfaces.get(p[0]), S = this.surfaces.get(p[1]);
                    if (D && S && D.buffer && S.buffer) this.copyBuffer(D, p[2], S, p[3], p[4]);
                    return;
                }
                case DX.TRANSFER_FROM_BUFFER:
                case DX.PRED_TRANSFER_FROM_BUFFER:
                    return this.transferFromBuffer(p);
                case DX.PRESENTBLT: {
                    // src, srcSub, dst, dstSub, boxSrc (x, y, z, w, h, d), boxDest, mode
                    const S = this.surfaces.get(p[0]), D = this.surfaces.get(p[2]);
                    if (!S || !D || !S.texture || !D.texture) return;
                    const [sMip, sLayer] = subresource(S, p[1]), [dMip, dLayer] = subresource(D, p[3]);
                    this.blit(S, sLayer, sMip, [p[4], p[5], p[4] + p[7], p[5] + p[8]], D, dLayer, dMip,
                        [p[10], p[11], p[10] + p[13], p[11] + p[14]], !!(p[16] & 1));
                    return;
                }
                case DX.RESOLVE_COPY:
                case DX.PRED_RESOLVE_COPY:
                    return this.resolve(p[0], p[1], p[2], p[3]);
                case DX.PRED_CONVERT_REGION:
                case DX.PRED_STAGING_CONVERT_REGION: {
                    const D = this.surfaces.get(p[0]), S = this.surfaces.get(p[8]);
                    if (!S || !D || !S.texture || !D.texture) return;
                    const [sMip, sLayer] = subresource(S, p[9]), [dMip, dLayer] = subresource(D, p[1]);
                    this.blit(S, sLayer, sMip, [p[10], p[11], p[10] + p[13], p[11] + p[14]], D, dLayer, dMip,
                        [p[2], p[3], p[2] + p[5], p[3] + p[6]], false);
                    return;
                }
                case DX.PRED_CONVERT:
                case DX.PRED_STAGING_CONVERT:
                    return this.copyWhole(p[0], p[1]);
                case DX.GENMIPS: return this.genmips(c, p[0]);
                case DX.BEGIN_QUERY: return this.beginQuery(c, p[0]);
                case DX.TRANSFER_TO_BUFFER:
                    return this.warn("transfer-to-buffer", "TRANSFER_TO_BUFFER is not supported yet");
            }
            this.warn("dx" + id, "DX command " + id + " is not supported");
        }

        copyRegion(dst, dstSub, src, srcSub, box) {
            const D = this.surfaces.get(dst), S = this.surfaces.get(src);
            if (!D || !S) return;
            const [x, y, z, w, h, d, sx, sy, sz] = box;
            if (S.buffer && D.buffer) return this.copyBuffer(D, x, S, sx, w);
            if (!S.texture || !D.texture) return;
            const [sMip, sLayer] = subresource(S, srcSub), [dMip, dLayer] = subresource(D, dstSub);
            this.copyTexture(S, sLayer, sMip, sx, sy, sz, D, dLayer, dMip, x, y, z, w, h, d);
        }

        copyWhole(dst, src) {
            const D = this.surfaces.get(dst), S = this.surfaces.get(src);
            if (!D || !S) return;
            if (S.buffer && D.buffer) return this.copyBuffer(D, 0, S, 0, Math.min(S.shadow.length, D.shadow.length));
            if (!S.texture || !D.texture) return;
            for (let layer = 0; layer < Math.min(S.layers, D.layers); layer++) {
                for (let mip = 0; mip < Math.min(S.gpuMips, D.gpuMips); mip++) {
                    const l = this.level(S, mip);
                    this.copyTexture(S, layer, mip, 0, 0, 0, D, layer, mip, 0, 0, 0, l.width, l.height, l.depth);
                }
            }
        }

        transferFromBuffer(p) {
            // srcSid, srcOffset, srcPitch, srcSlicePitch, destSid, destSubResource, destBox (x, y, z, w, h, d)
            const S = this.surfaces.get(p[0]), D = this.surfaces.get(p[4]);
            if (!S || !D || !S.buffer || !D.texture) return;
            const [mip, layer] = subresource(D, p[5]);
            const [x, y, z, w, h, d] = Array.from(p.subarray(6, 12));
            const f = D.f, rows = Math.ceil(h / f.bh), slices = Math.max(1, d);
            const bytes = new Uint8Array(p[2] * rows * slices);
            for (let slice = 0; slice < slices; slice++) {
                for (let row = 0; row < rows; row++) {
                    const from = p[1] + slice * p[3] + row * p[2];
                    bytes.set(S.shadow.subarray(from, from + p[2]), (slice * rows + row) * p[2]);
                }
            }
            const words = new Uint32Array(11 + align(bytes.length, 4) / 4);
            words.set([p[4], layer, mip, x, y, z, w, h, d, p[2], p[2] * rows]);
            new Uint8Array(words.buffer, 44).set(bytes);
            this.upload(words);
        }

        resolve(dst, dstSub, src, srcSub) {
            const D = this.surfaces.get(dst), S = this.surfaces.get(src);
            if (!D || !S || !D.texture || !S.texture || S.samples <= 1) return;
            const [dMip, dLayer] = subresource(D, dstSub);
            this.endPass();
            const pass = this.encoder().beginRenderPass({ colorAttachments: [{
                view: S.texture.createView({ dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 }),
                resolveTarget: D.texture.createView({ dimension: "2d", baseMipLevel: dMip, mipLevelCount: 1, baseArrayLayer: dLayer, arrayLayerCount: 1 }),
                loadOp: "load", storeOp: "store" }] });
            pass.end();
        }

        genmips(c, srvId) {
            const srv = c.srvs.get(srvId);
            const S = srv && this.surfaces.get(srv.sid);
            if (!S || !S.texture || S.volume) return;
            for (let layer = 0; layer < S.layers; layer++) {
                for (let mip = 1; mip < S.gpuMips; mip++) {
                    const from = this.level(S, mip - 1), to = this.level(S, mip);
                    this.blit(S, layer, mip - 1, [0, 0, from.width, from.height], S, layer, mip, [0, 0, to.width, to.height], true);
                }
            }
        }

        clearRTV(c, id, color) {
            const view = c.rtvs.get(id);
            const S = view && this.surfaces.get(view.sid);
            if (!S || !S.texture) return;
            const f = this.formatOf(view.format) || S.f;
            if (f.can.includes("x")) color = [color[0], color[1], color[2], 1];
            const kind = sampleKind(f.gpu || S.f.gpu);
            this.endPass();
            const pass = this.encoder().beginRenderPass({ colorAttachments: [{
                view: this.attachmentView(S, view, f.gpu || S.f.gpu),
                loadOp: "clear", storeOp: "store",
                clearValue: kind === "float" ? color : color.map(v => Math.trunc(v)) }] });
            pass.end();
        }

        clearDSV(c, id, flags, stencil, depth) {
            const view = c.dsvs.get(id);
            const S = view && this.surfaces.get(view.sid);
            if (!S || !S.texture) return;
            const format = S.f.gpu;
            this.endPass();
            const attachment = { view: this.attachmentView(S, view, format) };
            if (!format.startsWith("stencil")) {
                attachment.depthLoadOp = flags & 1 ? "clear" : "load";
                attachment.depthStoreOp = "store";
                attachment.depthClearValue = Math.min(1, Math.max(0, depth));
            }
            if (hasStencil(format)) {
                attachment.stencilLoadOp = flags & 2 ? "clear" : "load";
                attachment.stencilStoreOp = "store";
                attachment.stencilClearValue = stencil & 0xFF;
            }
            const pass = this.encoder().beginRenderPass({ colorAttachments: [], depthStencilAttachment: attachment });
            pass.end();
        }

        /** A view of one mip level and layer, to render into */
        attachmentView(S, view, format) {
            const layer = S.volume ? 0 : Math.min(view.first, S.layers - 1);
            const key = "a:" + format + ":" + view.mip + ":" + layer;
            let v = S.views.get(key);
            if (!v) {
                v = S.texture.createView({ format, dimension: "2d", baseMipLevel: Math.min(view.mip, S.gpuMips - 1), mipLevelCount: 1,
                    baseArrayLayer: layer, arrayLayerCount: 1 });
                S.views.set(key, v);
            }
            return v;
        }

        // ------------------------------------------------------------------
        // Queries

        beginQuery(c, qid) {
            const q = c.queries.get(qid);
            if (!q) return;
            if (q.type === 0 || q.type === 4 || q.type === 7) {
                // occlusion: counted in the render passes from here on
                this.endPass();
                q.indices = [];
                this.activeOcclusion.set(q, true);
            }
        }

        endQuery(b) {
            const [cid, qid, type, id] = b;
            const c = this.contexts.get(cid);
            const q = c && c.queries.get(qid);
            const answer = (value64) => {
                const bytes = new Uint8Array(88);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, value64 >>> 0, true);
                view.setUint32(4, Math.floor(value64 / 0x100000000), true);
                if (type === 2) {
                    // timestamp disjoint: frequency 1 GHz, not disjoint
                    view.setUint32(0, 1000000000, true);
                    view.setUint32(4, 0, true);
                    view.setUint32(8, 0, true);
                }
                if (type === 4) view.setUint32(0, value64 ? 1 : 0, true);
                this.respond(id, bytes);
            };
            if (!q || !(type === 0 || type === 4 || type === 7)) {
                answer(type === 1 ? Math.floor(performance.now() * 1e6) : 0);
                return;
            }
            this.endPass();
            this.activeOcclusion.delete(q);
            const indices = q.indices;
            if (!indices.length || !this.occlusion) return answer(0);
            const target = this.device.createBuffer({ size: indices.length * 8, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
            const resolved = this.device.createBuffer({ size: indices.length * 8, usage: BUFFER_USAGE.QUERY_RESOLVE | BUFFER_USAGE.COPY_SRC });
            const encoder = this.encoder();
            indices.forEach((index, i) => encoder.resolveQuerySet(this.occlusion.set, index, 1, resolved, i * 8));
            encoder.copyBufferToBuffer(resolved, 0, target, 0, indices.length * 8);
            this.transient.push(resolved);
            this.flushEncoder();
            this.pending.push(target.mapAsync(1).then(() => {
                const values = new BigUint64Array(target.getMappedRange());
                let sum = 0;
                for (const v of values) sum += Number(v);
                target.destroy();
                answer(sum);
            }, () => answer(0)));
        }

        // ------------------------------------------------------------------
        // Drawing

        draw(c, call) {
            const st = c.state;
            const vsStage = c.stages[SHADER_VS], psStage = c.stages[SHADER_PS];
            const vs = c.shaders.get(vsStage.shader), ps = c.shaders.get(psStage.shader);
            if (!vs || !vs.program) return this.warn("no-vs", "a draw without a vertex shader");
            if (c.stages[SHADER_GS].shader !== INVALID && c.shaders.get(c.stages[SHADER_GS].shader)) {
                this.warn("gs", "geometry shaders are not supported yet: drawn without");
            }
            const topology = TOPOLOGY[st.topology];
            if (!topology) return this.warn("topology" + st.topology, "topology " + st.topology + " is not supported");

            // render targets
            const colors = [];
            let width = 0, height = 0, samples = 1;
            const targets = {};
            for (let i = 0; i < st.rtvs.length; i++) {
                const view = c.rtvs.get(st.rtvs[i]);
                const S = view && this.surfaces.get(view.sid);
                if (!S || !S.texture) { colors.push(null); continue; }
                const f = this.formatOf(view.format) || S.f;
                const format = f.gpu || S.f.gpu;
                const level = this.level(S, view.mip);
                width = level.width; height = level.height; samples = S.samples > 1 ? 4 : 1;
                colors.push({ S, view, format, x: f.can.includes("x") });
                const kind = sampleKind(format);
                targets[i] = kind === "sint" ? "i32" : kind === "uint" ? "u32" : "f32";
            }
            const dsView = c.dsvs.get(st.dsv);
            const DS = dsView && this.surfaces.get(dsView.sid);
            let depthFormat = null;
            if (DS && DS.texture) {
                depthFormat = DS.f.gpu;
                const level = this.level(DS, dsView.mip);
                if (!width) { width = level.width; height = level.height; samples = DS.samples > 1 ? 4 : 1; }
            }
            if (!width) return;

            // the input layout
            const layout = c.layouts.get(st.layout);
            const vertexInputs = {}, buffers = [], slots = [];
            if (layout) {
                const bySlot = new Map();
                const running = new Map();
                for (const e of layout.elements) {
                    const f = this.formatOf(e.format);
                    if (!f || !f.vertex) {
                        this.warn("vfmt" + e.format, "vertex format " + e.format + " is not supported");
                        continue;
                    }
                    let offset = e.offset;
                    if (offset === INVALID) offset = running.get(e.slot) || 0;
                    running.set(e.slot, offset + vertexSize(f.vertex));
                    if (!bySlot.has(e.slot)) bySlot.set(e.slot, { instanced: e.instanced, attributes: [] });
                    bySlot.get(e.slot).attributes.push({ format: f.vertex, offset, shaderLocation: e.register });
                    vertexInputs[e.register] = /sint/.test(f.vertex) ? "i32" : /uint/.test(f.vertex) ? "u32" : "f32";
                    if (e.instanced && e.rate > 1) this.warn("rate", "instance data step rates above 1 are not supported");
                }
                for (const [slot, b] of [...bySlot].sort((a, b2) => a[0] - b2[0])) {
                    const vb = st.vbs[slot] || { sid: INVALID, stride: 0, offset: 0 };
                    let stride = vb.stride;
                    const end = Math.max(...b.attributes.map(a => a.offset + vertexSize(a.format)));
                    if (stride && (stride & 3 || stride < end)) {
                        this.warn("stride", "a vertex stride WebGPU does not take (" + stride + ")");
                        stride = align(Math.max(stride, end), 4);
                    }
                    buffers.push({ arrayStride: stride, stepMode: b.instanced ? "instance" : "vertex", attributes: b.attributes });
                    slots.push({ slot, vb });
                }
            }

            // the pixel shader's interface decides the vertex shader's outputs
            const varyings = ps && ps.program ? WGSL.pixelVaryings(ps.program) : {};
            const blend = c.blends.get(st.blend);
            const dualSource = !!(blend && usesSource1(blend.words));
            const vsOptions = { group: 0, vertexInputs, varyings };
            const psOptions = { group: 1, targets, dualSource };
            let vsModule, psModule = null;
            try {
                vsModule = this.module(vs, vsOptions);
                if (ps && ps.program) psModule = this.module(ps, psOptions);
            } catch (error) {
                return this.warn("translate:" + error.message, "shader translation failed: " + error.message);
            }

            const raster = c.rasters.get(st.raster);
            const depth = c.depths.get(st.depth);
            const key = [vs.id, ps ? ps.id : 0, JSON.stringify(vsOptions), JSON.stringify(psOptions), topology,
                call.indexed && /strip/.test(topology) ? (st.ib.format === SVGA3D_R16_UINT ? 16 : 32) : 0,
                JSON.stringify(buffers), colors.map(t => t ? t.format + (t.x ? "x" : "") : "-").join(","), depthFormat, samples,
                blend ? blend.words.join(",") : "", raster ? raster.words.join(",") : "", depth ? depth.words.join(",") : "",
                st.sampleMask, this.bindingKinds(c, vsModule, psModule)].join("|");
            let pipeline = this.pipelines.get(key);
            if (!pipeline) {
                pipeline = this.createPipeline(c, { vsModule, psModule, buffers, topology, call, colors, depthFormat, samples,
                    blend, raster, depth, dualSource });
                if (!pipeline) return;
                this.pipelines.set(key, pipeline);
                this.stats.pipelines++;
            }

            // the bind groups: the vertex shader's and the pixel shader's
            const viewport = this.viewport(st, width, height);
            const groups = [this.bindGroup(c, SHADER_VS, vsModule, pipeline.layouts[0], call, viewport.fix),
                psModule ? this.bindGroup(c, SHADER_PS, psModule, pipeline.layouts[1], call, null) : this.emptyGroup];
            if (groups.includes(null)) return;

            // the pass: the same attachments keep it open
            const passKey = colors.map(t => t ? t.S.sid + ":" + t.S.generation + ":" + t.view.mip + ":" + t.view.first + ":" + t.format : "-").join(",") +
                "|" + (DS && DS.texture ? DS.sid + ":" + DS.generation + ":" + dsView.mip + ":" + dsView.first : "-") +
                "|" + [...this.activeOcclusion.keys()].length;
            if (!this.pass || this.passKey !== passKey) {
                this.endPass();
                this.beginPass(colors, DS && DS.texture ? { S: DS, view: dsView } : null, passKey);
            }
            const pass = this.pass;
            pass.setPipeline(pipeline.pipeline);
            pass.setBindGroup(0, groups[0]);
            pass.setBindGroup(1, groups[1]);
            pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, viewport.min, viewport.max);
            const scissor = this.scissor(st, raster, width, height);
            pass.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
            pass.setBlendConstant(st.blendFactor);
            pass.setStencilReference(st.stencilRef & 0xFF);
            slots.forEach(({ vb }, i) => {
                const S = this.surfaces.get(vb.sid);
                if (S && S.buffer && vb.offset < S.shadow.length) pass.setVertexBuffer(i, S.buffer, vb.offset & ~3);
                else pass.setVertexBuffer(i, this.dummyBuffer, 0);
            });
            this.stats.draws++;
            if (call.indirect) {
                const S = this.surfaces.get(call.indirect.sid);
                if (!S || !S.buffer) return;
                if (call.indexed) {
                    if (!this.setIndexBuffer(pass, st)) return;
                    pass.drawIndexedIndirect(S.buffer, call.indirect.offset);
                } else {
                    pass.drawIndirect(S.buffer, call.indirect.offset);
                }
                return;
            }
            if (!call.count || !call.instances) return;
            if (call.indexed) {
                if (!this.setIndexBuffer(pass, st)) return;
                pass.drawIndexed(call.count, call.instances, call.first, call.base, call.firstInstance);
            } else {
                pass.draw(call.count, call.instances, call.first, call.firstInstance);
            }
        }

        setIndexBuffer(pass, st) {
            const S = this.surfaces.get(st.ib.sid);
            if (!S || !S.buffer) return false;
            const format = st.ib.format === SVGA3D_R16_UINT ? "uint16" : "uint32";
            pass.setIndexBuffer(S.buffer, format, st.ib.offset & ~(format === "uint16" ? 1 : 3));
            return true;
        }

        beginPass(colors, depth, key) {
            const descriptor = {
                colorAttachments: colors.map(t => t && { view: this.attachmentView(t.S, t.view, t.format), loadOp: "load", storeOp: "store" }),
            };
            if (depth) {
                const format = depth.S.f.gpu;
                const attachment = { view: this.attachmentView(depth.S, depth.view, format) };
                if (!format.startsWith("stencil")) { attachment.depthLoadOp = "load"; attachment.depthStoreOp = "store"; }
                if (hasStencil(format)) { attachment.stencilLoadOp = "load"; attachment.stencilStoreOp = "store"; }
                descriptor.depthStencilAttachment = attachment;
            }
            this.passOcclusion = null;
            if (this.activeOcclusion.size) {
                if (!this.occlusion) this.occlusion = { set: this.device.createQuerySet({ type: "occlusion", count: 4096 }), next: 0 };
                if (this.occlusion.next >= 4096) this.occlusion.next = 0;
                const index = this.occlusion.next++;
                descriptor.occlusionQuerySet = this.occlusion.set;
                for (const q of this.activeOcclusion.keys()) q.indices.push(index);
                this.passOcclusion = index;
            }
            this.pass = this.encoder().beginRenderPass(descriptor);
            if (this.passOcclusion !== null) this.pass.beginOcclusionQuery(this.passOcclusion);
            this.passKey = key;
            this.stats.passes++;
        }

        /** The viewport WebGPU takes, and how the position moves to make up for it */
        viewport(st, width, height) {
            const v = st.viewports[0] || [0, 0, width, height, 0, 1];
            let [x, y, w, h, min, max] = v;
            min = Math.min(1, Math.max(0, min)); max = Math.min(1, Math.max(min, max));
            if (w <= 0 || h <= 0) return { x: 0, y: 0, width: 1, height: 1, min, max, fix: [1, 1, 0, 0] };
            const cx = Math.max(0, x), cy = Math.max(0, y);
            const cw = Math.max(1, Math.min(x + w, width) - cx), ch = Math.max(1, Math.min(y + h, height) - cy);
            if (cx === x && cy === y && cw === w && ch === h) return { x, y, width: w, height: h, min, max, fix: [1, 1, 0, 0] };
            // NDC of the wanted viewport, mapped into the clamped one
            const sx = w / cw, sy = h / ch;
            const ox = ((x + w / 2) - (cx + cw / 2)) / (cw / 2), oy = -((y + h / 2) - (cy + ch / 2)) / (ch / 2);
            return { x: cx, y: cy, width: cw, height: ch, min, max, fix: [sx, sy, ox, oy] };
        }

        scissor(st, raster, width, height) {
            // (rasterizer dword 4: depthClipEnable, scissorEnable, ...)
            const enabled = raster && (raster.words[4] >> 8 & 0xFF);
            if (!enabled || !st.scissors.length) return [0, 0, width, height];
            const [l, t, r, b] = st.scissors[0];
            const x = Math.min(width, Math.max(0, l)), y = Math.min(height, Math.max(0, t));
            return [x, y, Math.max(0, Math.min(width, r) - x), Math.max(0, Math.min(height, b) - y)];
        }

        /** Part of the pipeline key: what the bound views are (depth, filterable) */
        bindingKinds(c, vsModule, psModule) {
            const parts = [];
            for (const [type, module] of [[SHADER_VS, vsModule], [SHADER_PS, psModule]]) {
                if (!module) continue;
                const stage = c.stages[type];
                for (const b of module.result.bindings) {
                    if (b.type !== "texture") continue;
                    const srv = c.srvs.get(stage.srvs[b.slot]);
                    const S = srv && this.surfaces.get(srv.sid);
                    parts.push(S && S.texture ? this.textureSampleType(S, srv, b) : "none");
                }
            }
            return parts.join(",");
        }

        textureSampleType(S, srv, binding) {
            if (binding.sampleType === "depth") return "depth";
            if (binding.sampleType !== "float") return binding.sampleType;
            const f = this.formatOf(srv.format) || S.f;
            const format = f.gpu || S.f.gpu;
            if (isDepthFormat(format)) return "unfilterable-float";
            if (/32float/.test(format) && !this.features.float32Filterable) return "unfilterable-float";
            return "float";
        }

        createPipeline(c, o) {
            const layouts = [];
            for (const [type, module] of [[SHADER_VS, o.vsModule], [SHADER_PS, o.psModule]]) {
                if (!module) { layouts.push(this.emptyLayout); continue; }
                const visibility = type === SHADER_VS ? 1 : 2;
                const stage = c.stages[type];
                const entries = [];
                const unfilterable = new Set();
                for (const b of module.result.bindings) {
                    if (b.type === "texture") {
                        const srv = c.srvs.get(stage.srvs[b.slot]);
                        const S = srv && this.surfaces.get(srv.sid);
                        let sampleType = S && S.texture ? this.textureSampleType(S, srv, b) : (b.sampleType === "depth" ? "depth" : b.sampleType === "float" ? "unfilterable-float" : b.sampleType);
                        if (sampleType === "unfilterable-float") unfilterable.add(b.slot);
                        entries.push({ binding: b.binding, visibility, texture: { sampleType, viewDimension: b.dimension, multisampled: b.multisampled } });
                    } else if (b.type === "sampler" || b.type === "comparison") {
                        entries.push({ binding: b.binding, visibility, sampler: { type: b.type === "comparison" ? "comparison" : "filtering" } });
                    } else if (b.type === "uniform" || b.type === "draw") {
                        entries.push({ binding: b.binding, visibility, buffer: { type: "uniform" } });
                    } else if (b.type === "read-storage") {
                        entries.push({ binding: b.binding, visibility, buffer: { type: "read-only-storage" } });
                    } else if (b.type === "storage") {
                        entries.push({ binding: b.binding, visibility, buffer: { type: "storage" } });
                    }
                }
                // samplers used with unfilterable textures must not filter
                if (unfilterable.size) {
                    for (const e of entries) if (e.sampler && e.sampler.type === "filtering") e.sampler.type = "non-filtering";
                }
                layouts.push(this.device.createBindGroupLayout({ entries }));
            }
            const raster = o.raster ? o.raster.words : [3 | 3 << 8 | 0 << 16, 0, 0, 0, 1, 0, 0];
            const fill = raster[0] & 0xFF, cull = raster[0] >> 8 & 0xFF, ccw = raster[0] >> 16 & 0xFF;
            if (fill === 2 || fill === 1) this.warn("wireframe", "wireframe and point fill are drawn solid");
            const depthBias = raster[1] | 0, biasClamp = f32(raster[2]), slope = f32(raster[3]);
            const depthClip = raster[4] & 0xFF;
            const primitive = {
                topology: o.topology,
                cullMode: cull === 2 ? "front" : cull === 3 ? "back" : "none",
                frontFace: ccw ? "ccw" : "cw",
            };
            if (o.call.indexed && /strip/.test(o.topology)) primitive.stripIndexFormat = "uint32";
            if (!depthClip && this.features.depthClipControl) primitive.unclippedDepth = true;
            const descriptor = {
                layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
                vertex: { module: o.vsModule.module, entryPoint: "main", buffers: o.buffers },
                primitive,
                multisample: { count: o.samples },
            };
            if (o.call.indexed && /strip/.test(o.topology)) {
                const st = c.state;
                primitive.stripIndexFormat = st.ib.format === SVGA3D_R16_UINT ? "uint16" : "uint32";
            }
            if (o.depthFormat) {
                const d = o.depth ? o.depth.words : null;
                const byte = (word, i) => word >> (8 * i) & 0xFF;
                const ds = { format: o.depthFormat, depthWriteEnabled: false, depthCompare: "always" };
                if (d) {
                    const depthEnable = byte(d[0], 0), writeMask = byte(d[0], 1), func = byte(d[0], 2), stencilEnable = byte(d[0], 3);
                    if (depthEnable) {
                        ds.depthWriteEnabled = !!writeMask;
                        ds.depthCompare = COMPARE[func] || "always";
                    }
                    if (stencilEnable && hasStencil(o.depthFormat)) {
                        ds.stencilReadMask = byte(d[1], 2);
                        ds.stencilWriteMask = byte(d[1], 3);
                        const face = (word) => ({ failOp: STENCIL_OPS[byte(word, 0)] || "keep", depthFailOp: STENCIL_OPS[byte(word, 1)] || "keep",
                            passOp: STENCIL_OPS[byte(word, 2)] || "keep", compare: COMPARE[byte(word, 3)] || "always" });
                        ds.stencilFront = byte(d[1], 0) ? face(d[2]) : { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
                        ds.stencilBack = byte(d[1], 1) ? face(d[3]) : { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
                    }
                } else {
                    ds.depthWriteEnabled = true;
                    ds.depthCompare = "less";
                }
                if (/depth/.test(o.depthFormat)) {
                    ds.depthBias = depthBias;
                    ds.depthBiasSlopeScale = slope;
                    ds.depthBiasClamp = biasClamp;
                } else {
                    delete ds.depthWriteEnabled;
                    delete ds.depthCompare;
                }
                descriptor.depthStencil = ds;
            }
            const sampleMask = c.state.sampleMask >>> 0;
            if (o.samples > 1 && sampleMask !== 0xFFFFFFFF) descriptor.multisample.mask = sampleMask;
            if (o.blend && (o.blend.words[0] & 0xFF)) descriptor.multisample.alphaToCoverageEnabled = o.samples > 1;
            if (o.psModule) {
                const targets = o.colors.map((t, i) => {
                    if (!t) return null;
                    const target = { format: t.format };
                    const words = o.blend ? o.blend.words : null;
                    const independent = words ? (words[0] >> 8 & 0xFF) : 0;
                    const rt = words ? (independent ? i : 0) : -1;
                    if (rt >= 0) {
                        const w0 = words[1 + 3 * rt], w1 = words[2 + 3 * rt], w2 = words[3 + 3 * rt];
                        const byte = (word, k) => word >> (8 * k) & 0xFF;
                        const enable = byte(w0, 0), src = byte(w0, 1), dst = byte(w0, 2), op = byte(w0, 3);
                        const srcA = byte(w1, 0), dstA = byte(w1, 1), opA = byte(w1, 2), mask = byte(w1, 3);
                        target.writeMask = mask & 0xF;
                        const blendable = !/int$/.test(t.format) && (!/32float/.test(t.format) || this.features.float32Blendable);
                        if (enable && blendable) {
                            target.blend = {
                                color: { srcFactor: BLEND_FACTORS[src] || "one", dstFactor: BLEND_FACTORS[dst] || "zero", operation: BLEND_OPS[op] || "add" },
                                alpha: { srcFactor: alphaFactor(BLEND_FACTORS[srcA] || "one"), dstFactor: alphaFactor(BLEND_FACTORS[dstA] || "zero"),
                                    operation: BLEND_OPS[opA] || "add" },
                            };
                            for (const part of [target.blend.color, target.blend.alpha]) {
                                if (part.operation === "min" || part.operation === "max") { part.srcFactor = "one"; part.dstFactor = "one"; }
                            }
                        }
                    }
                    // an "X" target keeps its alpha at 1
                    if (t.x) target.writeMask = (target.writeMask === undefined ? 0xF : target.writeMask) & 0x7;
                    return target;
                });
                descriptor.fragment = { module: o.psModule.module, entryPoint: "main", targets };
            }
            try {
                return { pipeline: this.device.createRenderPipeline(descriptor), layouts };
            } catch (error) {
                this.warn("pipeline:" + error.message, "a pipeline failed: " + error.message);
                return null;
            }
        }

        bindGroup(c, type, module, layout, call, fix) {
            const stage = c.stages[type];
            const entries = [];
            for (const b of module.result.bindings) {
                switch (b.type) {
                    case "uniform": {
                        const cb = stage.cbs[b.slot];
                        const S = cb && this.surfaces.get(cb.sid);
                        entries.push({ binding: b.binding, resource: this.constantBuffer(S, cb, b.size) });
                        break;
                    }
                    case "draw":
                        entries.push({ binding: b.binding, resource: this.drawParameters(call, fix || [1, 1, 0, 0]) });
                        break;
                    case "sampler":
                    case "comparison": {
                        const state = c.samplers.get(stage.samplers[b.slot]);
                        entries.push({ binding: b.binding, resource: this.sampler(state, b.type === "comparison", layout, b.binding) });
                        break;
                    }
                    case "texture": {
                        const srv = c.srvs.get(stage.srvs[b.slot]);
                        entries.push({ binding: b.binding, resource: this.textureView(srv, b) });
                        break;
                    }
                    case "read-storage":
                    case "storage": {
                        const srv = c.srvs.get(stage.srvs[b.slot]);
                        const S = srv && this.surfaces.get(srv.sid);
                        entries.push({ binding: b.binding, resource: S && S.buffer ? { buffer: S.buffer } : { buffer: this.dummyBuffer } });
                        break;
                    }
                }
            }
            try {
                return this.device.createBindGroup({ layout, entries });
            } catch (error) {
                this.warn("group:" + error.message, "a bind group failed: " + error.message);
                return null;
            }
        }

        /** A constant buffer binding: aligned and big enough, or a copy that is */
        constantBuffer(S, cb, size) {
            if (S && S.buffer && cb.offset % 256 === 0 && cb.offset + size <= S.shadow.length) {
                return { buffer: S.buffer, offset: cb.offset, size };
            }
            // too short, or not aligned: the bytes, copied where they fit
            const bytes = new Uint8Array(align(size, 16));
            if (S && S.shadow) bytes.set(S.shadow.subarray(cb.offset, Math.min(S.shadow.length, cb.offset + size)));
            const buffer = this.device.createBuffer({ size: bytes.length, usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST });
            this.device.queue.writeBuffer(buffer, 0, bytes);
            this.transient.push(buffer);
            return { buffer, offset: 0, size };
        }

        drawParameters(call, fix) {
            if (this.drawSlot >= DRAW_SLOTS) {
                // every slot is in this encoder's work: send it first
                this.flushEncoder();
                this.drawSlot = 0;
            }
            const offset = this.drawSlot++ * DRAW_SLOT;
            const data = new ArrayBuffer(32);
            const u = new Uint32Array(data), f = new Float32Array(data);
            u[0] = call.indexed ? call.base >>> 0 : 0;
            u[1] = call.firstInstance >>> 0;
            f.set(fix, 4);
            this.device.queue.writeBuffer(this.drawBuffer, offset, data);
            return { buffer: this.drawBuffer, offset, size: 32 };
        }

        sampler(state, comparison, layout, binding) {
            const words = state ? state.words : null;
            const key = (words ? words.join(",") : "default") + (comparison ? ":c" : "");
            let sampler = this.samplerCache.get(key);
            if (sampler) return sampler;
            const descriptor = {};
            if (words) {
                const filter = words[0];
                const linear = bit => (filter & bit) ? "linear" : "nearest";
                descriptor.magFilter = linear(4);
                descriptor.minFilter = linear(16);
                descriptor.mipmapFilter = linear(1);
                const address = words[1];
                descriptor.addressModeU = ADDRESS[address & 0xFF] || "repeat";
                descriptor.addressModeV = ADDRESS[address >> 8 & 0xFF] || "repeat";
                descriptor.addressModeW = ADDRESS[address >> 16 & 0xFF] || "repeat";
                const anisotropy = words[3] & 0xFF;
                if (filter & 64 && anisotropy > 1) {
                    descriptor.magFilter = descriptor.minFilter = descriptor.mipmapFilter = "linear";
                    descriptor.maxAnisotropy = Math.min(16, anisotropy);
                }
                const minLod = f32(words[8]), maxLod = f32(words[9]);
                descriptor.lodMinClamp = Math.max(0, Number.isFinite(minLod) ? minLod : 0);
                descriptor.lodMaxClamp = Math.max(descriptor.lodMinClamp, Math.min(32, Number.isFinite(maxLod) ? maxLod : 32));
                if (comparison) descriptor.compare = COMPARE[words[3] >> 8 & 0xFF] || "less-equal";
            } else if (comparison) {
                descriptor.compare = "less-equal";
            }
            sampler = this.device.createSampler(descriptor);
            this.samplerCache.set(key, sampler);
            return sampler;
        }

        /** A view of a shader resource as the shader declares it */
        textureView(srv, binding) {
            const S = srv && this.surfaces.get(srv.sid);
            if (!S || !S.texture) return this.dummyTexture(binding);
            const f = this.formatOf(srv.format) || S.f;
            let format = f.gpu || S.f.gpu;
            if (format !== S.f.gpu && SRGB[S.f.gpu] !== format) format = S.f.gpu;
            const [most, first, mips, count] = srv.desc;
            const dimension = binding.dimension;
            const baseMip = Math.min(most, S.gpuMips - 1);
            const mipCountView = Math.max(1, Math.min(mips === INVALID ? S.gpuMips : mips, S.gpuMips - baseMip));
            let layers = S.volume ? 1 : S.layers;
            let baseLayer = S.volume ? 0 : Math.min(first, layers - 1);
            let layerCount = dimension === "2d" ? 1 : dimension === "cube" ? 6 :
                dimension === "cube-array" ? Math.floor((layers - baseLayer) / 6) * 6 : Math.max(1, Math.min(count || 1, layers - baseLayer));
            if (dimension === "2d-array" && !count) layerCount = layers - baseLayer;
            if (dimension === "cube" && layers - baseLayer < 6) return this.dummyTexture(binding);
            const aspect = isDepthFormat(format) ? (srv.format === 82 || srv.format === 63 ? "stencil-only" : "depth-only") : "all";
            const key = "v:" + format + ":" + dimension + ":" + baseMip + ":" + mipCountView + ":" + baseLayer + ":" + layerCount + ":" + aspect;
            let view = S.views.get(key);
            if (!view) {
                view = S.texture.createView({ format, dimension: S.volume ? "3d" : dimension, baseMipLevel: baseMip, mipLevelCount: mipCountView,
                    baseArrayLayer: baseLayer, arrayLayerCount: S.volume ? 1 : layerCount, aspect });
                S.views.set(key, view);
            }
            return view;
        }

        dummyTexture(binding) {
            const key = binding.dimension + ":" + binding.sampleType + ":" + binding.multisampled;
            let view = this.dummyTextures.get(key);
            if (view) return view;
            const format = binding.sampleType === "depth" ? "depth32float" : binding.sampleType === "sint" ? "rgba8sint" :
                binding.sampleType === "uint" ? "rgba8uint" : "rgba8unorm";
            const cube = binding.dimension === "cube" || binding.dimension === "cube-array";
            const texture = this.device.createTexture({ size: [1, 1, binding.dimension === "3d" ? 1 : cube ? 6 : 1],
                dimension: binding.dimension === "3d" ? "3d" : "2d", format, sampleCount: binding.multisampled ? 4 : 1,
                usage: TEXTURE_USAGE.TEXTURE_BINDING | (binding.multisampled ? TEXTURE_USAGE.RENDER_ATTACHMENT : 0) });
            view = texture.createView({ dimension: binding.dimension });
            this.dummyTextures.set(key, view);
            return view;
        }
    }

    /** One DX context's objects and state */
    class GXContext {
        constructor(cid) {
            this.cid = cid;
            this.generation = 0;
            this.rtvs = new Map(); this.dsvs = new Map(); this.srvs = new Map(); this.uavs = new Map();
            this.layouts = new Map(); this.blends = new Map(); this.depths = new Map(); this.rasters = new Map();
            this.samplers = new Map(); this.shaders = new Map(); this.queries = new Map();
            this.stages = {};
            for (let type = SHADER_VS; type <= SHADER_CS; type++) {
                this.stages[type] = { shader: INVALID, cbs: new Array(16).fill(null), srvs: new Array(128).fill(INVALID),
                    samplers: new Array(16).fill(INVALID) };
            }
            this.state = {
                layout: INVALID, vbs: new Array(32).fill(null), ib: { sid: INVALID, format: SVGA3D_R16_UINT, offset: 0 },
                topology: 1, rtvs: [], dsv: INVALID, blend: INVALID, blendFactor: [0, 0, 0, 0], sampleMask: INVALID,
                depth: INVALID, stencilRef: 0, raster: INVALID, viewports: [], scissors: [], predication: [INVALID, 0],
            };
        }

        stage(type) {
            return this.stages[type] || null;
        }

        /** A COTable set again: its objects are defined anew */
        reset(type) {
            const maps = { [COTABLE.RTVIEW]: this.rtvs, [COTABLE.DSVIEW]: this.dsvs, [COTABLE.SRVIEW]: this.srvs,
                [COTABLE.ELEMENTLAYOUT]: this.layouts, [COTABLE.BLENDSTATE]: this.blends, [COTABLE.DEPTHSTENCIL]: this.depths,
                [COTABLE.RASTERIZERSTATE]: this.rasters, [COTABLE.SAMPLER]: this.samplers, [COTABLE.DXQUERY]: this.queries,
                [COTABLE.DXSHADER]: this.shaders, [COTABLE.UAVIEW]: this.uavs };
            if (maps[type]) maps[type].clear();
        }
    }

    /** [mip, layer] of a subresource index */
    function subresource(S, index) {
        return [index % S.mips, Math.floor(index / S.mips)];
    }

    function mipCount(width, height, depth) {
        return 1 + Math.floor(Math.log2(Math.max(width, height, depth)));
    }

    /** Bytes of a WebGPU vertex format */
    function vertexSize(format) {
        if (format === "unorm10-10-10-2" || format === "unorm8x4-bgra") return 4;
        const size = /(8|16|32)(?:x(\d))?$/.exec(format);
        return size ? (+size[1] / 8) * (+size[2] || 1) : 4;
    }

    /** Whether a blend state reads the pixel shader's second color */
    function usesSource1(words) {
        for (let rt = 0; rt < 8; rt++) {
            const w0 = words[1 + 3 * rt], w1 = words[2 + 3 * rt];
            for (const factor of [w0 >> 8 & 0xFF, w0 >> 16 & 0xFF, w1 & 0xFF, w1 >> 8 & 0xFF]) {
                if (factor >= 14 && factor <= 17) return true;
            }
        }
        return false;
    }

    /** WebGPU's alpha factors take no colors */
    function alphaFactor(factor) {
        return { "src": "src-alpha", "one-minus-src": "one-minus-src-alpha", "dst": "dst-alpha", "one-minus-dst": "one-minus-dst-alpha",
            "src1": "src1-alpha", "one-minus-src1": "one-minus-src1-alpha" }[factor] || factor;
    }

    // Pixels of formats WebGPU lacks, stored as rgba8unorm: 16-bit ones
    const SIXTEEN = { 3: "565", 139: "565", 4: "1555", 5: "1555", 140: "1555", 6: "4444", 145: "4444" };

    /** A row of the guest's pixels into RGBA8 */
    function expandRow(format, bytes, from, to) {
        const kind = SIXTEEN[format];
        const count = Math.floor(from.length / bytes);
        for (let i = 0; i < count; i++) {
            const o = i * 4;
            if (!kind) { to[o] = from[i * bytes]; to[o + 3] = 255; continue; }
            const v = from[2 * i] | from[2 * i + 1] << 8;
            if (kind === "565") { to[o] = (v >> 11 & 31) * 255 / 31; to[o + 1] = (v >> 5 & 63) * 255 / 63; to[o + 2] = (v & 31) * 255 / 31; to[o + 3] = 255; }
            else if (kind === "1555") { to[o] = (v >> 10 & 31) * 255 / 31; to[o + 1] = (v >> 5 & 31) * 255 / 31; to[o + 2] = (v & 31) * 255 / 31; to[o + 3] = v & 0x8000 ? 255 : 0; }
            else { to[o] = (v >> 8 & 15) * 17; to[o + 1] = (v >> 4 & 15) * 17; to[o + 2] = (v & 15) * 17; to[o + 3] = (v >> 12 & 15) * 17; }
        }
    }

    /** A row of RGBA8 into the guest's pixels */
    function packRow(format, bytes, from, to) {
        const kind = SIXTEEN[format];
        const count = Math.floor(to.length / bytes);
        for (let i = 0; i < count; i++) {
            const r = from[4 * i], g = from[4 * i + 1], b = from[4 * i + 2], a = from[4 * i + 3];
            if (!kind) { to[i * bytes] = r; continue; }
            let v;
            if (kind === "565") v = (r >> 3) << 11 | (g >> 2) << 5 | b >> 3;
            else if (kind === "1555") v = (a >> 7) << 15 | (r >> 3) << 10 | (g >> 3) << 5 | b >> 3;
            else v = (a >> 4) << 12 | (r >> 4) << 8 | (g >> 4) << 4 | b >> 4;
            to[2 * i] = v & 0xFF;
            to[2 * i + 1] = v >> 8;
        }
    }

    const api = { GXExecutor, GX, GX_MAGIC };
    if (isNode) module.exports = api;
    else global.V86GXExecutor = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
