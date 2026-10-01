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
        COTABLE_RESET: 11, SURFACE_STRETCH: 12, SURFACE_IMPORT: 13, SURFACE_EXPORT: 14,
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
    // the input primitives of a geometry shader, by SVGA3dPrimitiveType: the
    // topology code wgsl_emitter.js assembles them by, and how many a draw of
    // n vertices has
    /** An SVGA3dStreamOutputDeclarationEntry at words[at]: outputSlot, registerIndex, registerMask, stream */
    function soEntry(words, at) {
        return { slot: words[at] & 3, reg: words[at + 1], mask: words[at + 2] & 0xF, stream: words[at + 3] };
    }
    const GS_ASSEMBLY = {
        1: { code: 4, prims: n => Math.floor(n / 3) }, 2: { code: 1, prims: n => n }, 3: { code: 2, prims: n => n >> 1 },
        4: { code: 3, prims: n => n - 1 }, 5: { code: 5, prims: n => n - 2 }, 7: { code: 10, prims: n => n >> 2 },
        8: { code: 11, prims: n => n - 3 }, 9: { code: 12, prims: n => Math.floor(n / 6) }, 10: { code: 13, prims: n => (n - 4) >> 1 },
    };

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
            /** the D3D9 executor on the same device: { resource(handle), flush() } */
            this.peer = options.peer || null;
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
            // (a batch cut out of a bigger message may start anywhere)
            if (bytes.byteOffset & 3) bytes = bytes.slice();
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
                case GX.SURFACE_IMPORT: return this.share(b[0], b[1], false);
                case GX.SURFACE_EXPORT: return this.share(b[0], b[1], true);
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
            if (s.soFilled) s.soFilled.destroy();
            s.soFilled = null;
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
            const codec = f.can.includes("e") ? EMULATED[s.format] : null;
            const emulated = !!codec;
            const gpuRow = emulated ? columns * codec.texels * codec.gpu : rowBytes;
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
            // (an emulated format's texture has blocks of one texel)
            const bw = emulated ? 1 : f.bw, bh = emulated ? 1 : f.bh;
            const copyWidth = Math.min(align(w, bw), align(level.width, bw) - x, emulated ? columns * codec.texels : Infinity);
            const copyHeight = Math.min(align(h, bh), align(level.height, bh) - y);
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
            const codec = f.can.includes("e") ? EMULATED[s.format] : null;
            const emulated = !!codec;
            const texels = emulated ? Math.min(w, columns * codec.texels) : w;
            const rowBytes = columns * f.bytes, gpuRow = emulated ? texels * codec.gpu : rowBytes, alignedPitch = align(gpuRow, 256);
            const slices = Math.max(1, d);
            const target = this.device.createBuffer({ size: alignedPitch * rows * slices, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST });
            this.encoder().copyTextureToBuffer(
                { texture: s.texture, mipLevel: mip, origin: [x, y, s.volume ? z : layer], aspect: isDepthFormat(f.gpu) ? "depth-only" : "all" },
                { buffer: target, bytesPerRow: alignedPitch, rowsPerImage: rows },
                [emulated ? texels : align(w, f.bw), emulated ? h : align(h, f.bh), slices]);
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

        /**
         * Copy every image between a surface and the D9WG resource that is
         * the same surface for legacy 3D (options.peer: the D3D9 executor on
         * the same device): a copy where the formats are the same, else a
         * draw. An "X" format's alpha is 1.
         */
        share(sid, handle, toPeer) {
            const s = this.surfaces.get(sid);
            const peer = this.peer && this.peer.resource(handle);
            if (!s || !s.texture || !peer || !peer.gpuTexture) {
                if (s && s.buffer) this.warn("share-buffer", "a buffer shared by DX and legacy 3D");
                else this.warn("share-missing", "a shared surface is missing on one side");
                return;
            }
            // (the D3D9 executor records draws for later: they go first)
            this.peer.flush();
            const gpu = peer.gpuFormat;
            const block = gpu.startsWith("bc") ? 4 : 1;
            const p = { texture: peer.gpuTexture, f: { gpu, can: "", bw: block, bh: block, bytes: 0 },
                width: peer.width, height: peer.height, depth: peer.depth || 1,
                volume: peer.textureType === "3d", layers: peer.layerCount || 1,
                gpuMips: peer.levelCount || 1, samples: 1 };
            if (s.samples > 1 || isDepthFormat(s.f.gpu) || isDepthFormat(gpu)) {
                this.warn("share-kind", "a multisampled or depth surface shared by DX and legacy 3D");
                return;
            }
            const [S, D] = toPeer ? [s, p] : [p, s];
            const opaque = s.f.can.includes("x");
            const sameFamily = S.f.gpu === D.f.gpu || SRGB[S.f.gpu] === D.f.gpu || SRGB[D.f.gpu] === S.f.gpu;
            const mips = Math.min(S.gpuMips, D.gpuMips);
            const layers = S.volume || D.volume ? 1 : Math.min(S.layers, D.layers);
            this.endPass();
            for (let mip = 0; mip < mips; mip++) {
                const sl = this.level(S, mip), dl = this.level(D, mip);
                const w = Math.min(sl.width, dl.width), h = Math.min(sl.height, dl.height);
                for (let layer = 0; layer < layers; layer++) {
                    if (sameFamily && !opaque) {
                        this.encoder().copyTextureToTexture(
                            { texture: S.texture, mipLevel: mip, origin: [0, 0, S.volume ? 0 : layer] },
                            { texture: D.texture, mipLevel: mip, origin: [0, 0, D.volume ? 0 : layer] },
                            [align(w, block), align(h, block), S.volume && D.volume ? Math.min(sl.depth, dl.depth) : 1]);
                    } else if (S.volume || D.volume || block > 1) {
                        this.warn("share-format:" + S.f.gpu + ":" + D.f.gpu, "a shared surface's formats differ: " +
                            S.f.gpu + " and " + D.f.gpu);
                        return;
                    } else {
                        this.blit(S, layer, mip, [0, 0, w, h], D, layer, mip, [0, 0, w, h], false, opaque);
                    }
                    // (D9WG warns about levels nothing has written: these are written)
                    if (toPeer && peer.uploadedLevels) peer.uploadedLevels.add(peer.layerCount === 6 ? mip * 6 + layer : mip);
                }
            }
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
        blit(S, sLayer, sMip, [sl, st, sr, sb], D, dLayer, dMip, [dl, dt, dr, db], linear, opaque) {
            const format = D.f.gpu;
            if (isDepthFormat(format) || isDepthFormat(S.f.gpu)) return this.warn("blit-depth", "blits of depth surfaces are not supported");
            const kind = sampleKind(S.f.gpu);
            const key = format + ":" + kind + (opaque ? ":opaque" : "");
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
    ${type === "f32" ? `let c = textureSampleLevel(t, s, input.uv / box.size.xy, 0.0);` :
        `let c = textureLoad(t, vec2<i32>(input.uv), 0);`}
    return vec4<${outType}>(${opaque ? `vec4<${type}>(c.rgb, ${type === "f32" ? "1.0" : "1"})` : "c"});
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
            entry = { module, result, key };
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
                case DX.DEFINE_STREAMOUTPUT: {
                    // soid, entries, 64 SVGA3dStreamOutputDeclarationEntry, 4 strides, the rasterized stream
                    const entries = [];
                    for (let i = 0; i < Math.min(p[1], 64); i++) entries.push(soEntry(p, 2 + 4 * i));
                    c.streamOutputs.set(p[0], { entries, strides: Array.from(p.subarray(258, 262)), rasterized: p[262] | 0 });
                    return;
                }
                case DX.DEFINE_STREAMOUTPUT_WITH_MOB:
                    // soid, entries, strides used, 4 strides, the rasterized stream; the entries come with BIND
                    c.streamOutputs.set(p[0], { entries: [], count: p[1], strides: Array.from(p.subarray(3, 7)), rasterized: p[7] | 0 });
                    return;
                case DX.BIND_STREAMOUTPUT: {
                    // soid, mob, offset, size, then the entries (svga3d_dx.js reads them from the MOB)
                    const so = c.streamOutputs.get(p[0]);
                    if (!so) return;
                    so.entries = [];
                    for (let at = 4; at + 4 <= p.length && so.entries.length < (so.count || 64); at += 4) so.entries.push(soEntry(p, at));
                    return;
                }
                case DX.DESTROY_STREAMOUTPUT: c.streamOutputs.delete(p[0]); return;
                case DX.SET_STREAMOUTPUT: st.soid = p[0]; return;
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
                    // (pad), then sid, offset, size each; an offset of ~0 appends to what the buffer has
                    st.soTargets = [];
                    for (let at = 1; at + 3 <= p.length && st.soTargets.length < 4; at += 3) {
                        const target = { sid: p[at], offset: p[at + 1], size: p[at + 2] };
                        st.soTargets.push(target);
                        const S = target.sid !== INVALID ? this.surfaces.get(target.sid) : null;
                        if (S && S.buffer && target.offset !== INVALID) this.device.queue.writeBuffer(this.soFilled(S), 0, Uint32Array.of(target.offset));
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
                    return this.drawAuto(c);
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

        /** The render and depth targets of a draw (null: none) */
        attachments(c) {
            const st = c.state;
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
            if (!width) return null;
            return { colors, targets, width, height, samples, DS, dsView, depthFormat };
        }

        /**
         * The input layout: as WebGPU vertex buffers, and as the elements a
         * vertex shader run as compute pulls itself (fetch)
         */
        inputLayout(c) {
            const st = c.state;
            const layout = c.layouts.get(st.layout);
            const vertexInputs = {}, buffers = [], slots = [], fetch = [];
            let pull = false;
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
                    fetch.push({ reg: e.register, slot: e.slot, offset, format: f.vertex, instanced: !!e.instanced });
                    // what WebGPU's vertex fetch cannot take: the vertices are pulled
                    if (/^pull:/.test(f.vertex) || e.instanced && e.rate > 1 || offset % Math.min(4, vertexSize(f.vertex))) pull = true;
                    if (!bySlot.has(e.slot)) bySlot.set(e.slot, { instanced: e.instanced, attributes: [] });
                    bySlot.get(e.slot).attributes.push({ format: f.vertex, offset, shaderLocation: e.register });
                    vertexInputs[e.register] = /sint/.test(f.vertex) ? "i32" : /uint/.test(f.vertex) ? "u32" : "f32";
                }
                for (const [slot, b] of [...bySlot].sort((a, b2) => a[0] - b2[0])) {
                    const vb = st.vbs[slot] || { sid: INVALID, stride: 0, offset: 0 };
                    let stride = vb.stride;
                    const end = Math.max(...b.attributes.map(a => a.offset + vertexSize(a.format)));
                    if (stride && (stride & 3 || stride < end || stride > 2048)) {
                        pull = true;
                        stride = align(Math.max(stride, end), 4);
                    }
                    buffers.push({ arrayStride: stride, stepMode: b.instanced ? "instance" : "vertex", attributes: b.attributes });
                    slots.push({ slot, vb });
                }
            }
            return { vertexInputs, buffers, slots, fetch, layout, pull };
        }

        draw(c, call) {
            const st = c.state;
            const vsStage = c.stages[SHADER_VS], psStage = c.stages[SHADER_PS];
            const vs = c.shaders.get(vsStage.shader), ps = c.shaders.get(psStage.shader);
            if (!vs || !vs.program) return this.warn("no-vs", "a draw without a vertex shader");
            const gs = c.stages[SHADER_GS].shader !== INVALID ? c.shaders.get(c.stages[SHADER_GS].shader) : null;
            const topology = TOPOLOGY[st.topology];
            if (!topology) return this.warn("topology" + st.topology, "topology " + st.topology + " is not supported");
            const so = this.streamOutput(c);
            const a = this.attachments(c);
            if (!a && !so) return;
            const input = this.inputLayout(c);
            // a geometry shader: the vertex and geometry shaders run as compute
            if (gs && gs.program) return this.drawGeometry(c, call, vs, gs, ps, a, input, so);
            // vertices WebGPU cannot fetch: the vertex shader pulls them, as compute
            if (input.pull && !so) return a ? this.drawPulled(c, call, vs, ps, a, input) : undefined;
            // stream output of the vertex shader's primitives
            if (so) {
                this.streamVertices(c, call, vs, input, so);
                if (!a || so.noRaster) return;
            }
            const { colors, targets, width, height, samples, DS, dsView, depthFormat } = a;
            const { vertexInputs, buffers, slots } = input;

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

            const pass = this.renderPass(c, a, pipeline, groups, viewport, raster);
            slots.forEach(({ vb }, i) => {
                const S = this.surfaces.get(vb.sid);
                if (S && S.buffer && vb.offset < S.shadow.length) pass.setVertexBuffer(i, S.buffer, vb.offset & ~3);
                else pass.setVertexBuffer(i, this.dummyBuffer, 0);
            });
            this.stats.draws++;
            if (call.indirect) {
                const S = call.indirect.buffer ? null : this.surfaces.get(call.indirect.sid);
                const buffer = call.indirect.buffer || (S && S.buffer);
                if (!buffer) return;
                if (call.indexed) {
                    if (!this.setIndexBuffer(pass, st)) return;
                    pass.drawIndexedIndirect(buffer, call.indirect.offset);
                } else {
                    pass.drawIndirect(buffer, call.indirect.offset);
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

        /** The render pass of a draw's attachments (the same ones keep it open), its state set */
        renderPass(c, a, pipeline, groups, viewport, raster) {
            const st = c.state, { colors, DS, dsView, width, height } = a;
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
            return pass;
        }

        // ------------------------------------------------------------------
        // Geometry shaders: no WebGPU stage, so the vertex shader runs as
        // compute and pulls its vertices, the geometry shader runs as compute
        // on what it stored, and what that emitted is drawn by a vertex
        // shader reading it (wgsl_emitter.js, "vertex-compute" and "geometry")

        drawGeometry(c, call, vs, gs, ps, a, input, so) {
            const st = c.state;
            if (call.indirect) return this.warn("gs-indirect", "indirect draws with a geometry shader are not supported");
            const count = call.count, instances = call.instances;
            if (!count || !instances) return;
            const assembly = GS_ASSEMBLY[st.topology];
            if (!assembly) return this.warn("gs-topology" + st.topology, "topology " + st.topology + " with a geometry shader");
            const prims = assembly.prims(count);
            if (prims <= 0) return;
            let vsModule, gsModule;
            try {
                vsModule = this.module(vs, { group: 0, mode: "vertex-compute", fetch: input.fetch });
                gsModule = this.module(gs, { group: 0, mode: "geometry" });
            } catch (error) {
                return this.warn("translate:" + error.message, "shader translation failed: " + error.message);
            }
            const g = gsModule.result.gs;
            const vsRecord = Math.max(1, vsModule.result.record), gsRecord = gsModule.result.record;
            const vertices = count * instances, invocations = prims * instances;
            const slots = invocations * g.maxPrims * g.perPrim;
            const vsOut = this.storageBuffer(vertices * vsRecord * 16);
            const gsOut = this.storageBuffer(slots * gsRecord * 16);

            // the vertex shader, pulling its vertices
            const vsPipe = this.computePipeline(c, SHADER_VS, vsModule);
            const gsPipe = this.computePipeline(c, SHADER_GS, gsModule);
            if (!vsPipe || !gsPipe) return;
            const ib = this.surfaces.get(st.ib.sid);
            const vsGroup = this.bindGroup(c, SHADER_VS, vsModule, vsPipe.layout, call, null, {
                "fetch": this.uniform(this.fetchParameters(st, call, input)),
                "index": { buffer: call.indexed && ib && ib.buffer ? ib.buffer : this.dummyBuffer },
                "vertex-buffer": slot => {
                    const vb = st.vbs[slot];
                    const S = vb && this.surfaces.get(vb.sid);
                    return { buffer: S && S.buffer ? S.buffer : this.dummyBuffer };
                },
                "stage-out": { buffer: vsOut },
            });
            // ... and the geometry shader on its records
            const geo = new Uint32Array([prims, instances, count, assembly.code, vsRecord, 0, 0, 0]);
            const gsGroup = this.bindGroup(c, SHADER_GS, gsModule, gsPipe.layout, call, null, {
                "geo": this.uniform(geo), "stage-in": { buffer: vsOut }, "stage-out": { buffer: gsOut },
            });
            if (!vsGroup || !gsGroup) return;
            this.endPass();
            const compute = this.encoder().beginComputePass();
            compute.setPipeline(vsPipe.pipeline);
            compute.setBindGroup(0, vsGroup);
            this.dispatch(compute, vertices);
            compute.setPipeline(gsPipe.pipeline);
            compute.setBindGroup(0, gsGroup);
            this.dispatch(compute, invocations);
            compute.end();
            this.stats.geometryDraws = (this.stats.geometryDraws || 0) + 1;

            // what it emitted: into the stream output buffers, and drawn
            if (so) this.writeStreamOutput(c, so, gsOut, gsRecord, { geometry: true, units: invocations * g.maxPrims, perPrim: g.perPrim });
            if (a && !(so && so.noRaster)) this.drawRecords(c, a, ps, gs, gsModule, gsOut, g.topology, slots);
        }

        // ------------------------------------------------------------------
        // Stream output: what a draw's last vertex stage made, primitive by
        // primitive in order, written into the target buffers by a compute
        // shader made for the declaration; each buffer's filled size stays on
        // the GPU (DrawAuto draws that many vertices)

        /** The stream output of a draw, if one is bound: { decl, targets, noRaster } */
        streamOutput(c) {
            const st = c.state;
            if (st.soid === INVALID) return null;
            const decl = c.streamOutputs.get(st.soid);
            if (!decl || !decl.entries.length) return null;
            const targets = st.soTargets.map(t => {
                const S = t && t.sid !== INVALID ? this.surfaces.get(t.sid) : null;
                return S && S.buffer ? { ...t, S } : null;
            });
            if (!targets.some(t => t)) return null;
            return { decl, targets, noRaster: (decl.rasterized | 0) === -1 };
        }

        /** A buffer's stream output filled size (bytes), on the GPU */
        soFilled(S) {
            if (!S.soFilled) {
                S.soFilled = this.device.createBuffer({ size: 16, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.COPY_DST });
            }
            return S.soFilled;
        }

        /** Stream output without a geometry shader: the vertex shader's primitives */
        streamVertices(c, call, vs, input, so) {
            const st = c.state;
            const assembly = GS_ASSEMBLY[st.topology];
            const perPrim = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 3 }[assembly ? assembly.code : 0];
            if (call.indirect || !perPrim) return this.warn("so-topology", "stream output of this draw (indirect, or adjacency) is not supported");
            const prims = assembly.prims(call.count);
            if (prims <= 0 || !call.instances) return;
            let vsModule;
            try {
                vsModule = this.module(vs, { group: 0, mode: "vertex-compute", fetch: input.fetch });
            } catch (error) {
                return this.warn("translate:" + error.message, "shader translation failed: " + error.message);
            }
            const record = Math.max(1, vsModule.result.record);
            const vsOut = this.storageBuffer(call.count * call.instances * record * 16);
            const vsPipe = this.computePipeline(c, SHADER_VS, vsModule);
            if (!vsPipe) return;
            const ib = this.surfaces.get(st.ib.sid);
            const group = this.bindGroup(c, SHADER_VS, vsModule, vsPipe.layout, call, null, {
                "fetch": this.uniform(this.fetchParameters(st, call, input)),
                "index": { buffer: call.indexed && ib && ib.buffer ? ib.buffer : this.dummyBuffer },
                "vertex-buffer": slot => {
                    const vb = st.vbs[slot];
                    const S = vb && this.surfaces.get(vb.sid);
                    return { buffer: S && S.buffer ? S.buffer : this.dummyBuffer };
                },
                "stage-out": { buffer: vsOut },
            });
            if (!group) return;
            this.endPass();
            const compute = this.encoder().beginComputePass();
            compute.setPipeline(vsPipe.pipeline);
            compute.setBindGroup(0, group);
            this.dispatch(compute, call.count * call.instances);
            compute.end();
            this.writeStreamOutput(c, so, vsOut, record, { geometry: false, units: prims * call.instances, perPrim,
                prims, count: call.count, code: assembly.code });
        }

        /**
         * Write records into the stream output targets, in order
         * @param shape { geometry, units, perPrim } and without a geometry
         *     shader { prims, count, code }: the vertex records' topology
         */
        writeStreamOutput(c, so, src, record, shape) {
            const decl = so.decl;
            // where each entry's components go in a vertex of its buffer
            const writes = [], strides = [0, 0, 0, 0], running = [0, 0, 0, 0];
            for (const e of decl.entries) {
                if (e.stream !== 0) continue;
                for (let lane = 0; lane < 4; lane++) {
                    if (!(e.mask >> lane & 1)) continue;
                    // (a register past the record: a gap)
                    if (e.reg < (shape.geometry ? record - 1 : record)) writes.push({ slot: e.slot, offset: running[e.slot], reg: e.reg, lane });
                    running[e.slot] += 4;
                }
            }
            for (let slot = 0; slot < 4; slot++) strides[slot] = decl.strides[slot] || running[slot];
            const used = [0, 1, 2, 3].filter(slot => so.targets[slot] && strides[slot] && (running[slot] || writes.some(w => w.slot === slot)));
            if (!used.length) return;
            const key = "so:" + JSON.stringify({ writes, strides, used, record, g: shape.geometry, p: shape.perPrim });
            let pipe = this.pipelines.get(key);
            if (!pipe) {
                const P = shape.perPrim, lanes = "xyzw";
                const lines = [];
                lines.push("struct SOParams { units: u32, prims: u32, count: u32, topology: u32, sizes: vec4<u32> }");
                lines.push("@group(0) @binding(0) var<storage, read> src: array<vec4<u32>>;");
                lines.push("@group(0) @binding(1) var<uniform> P: SOParams;");
                lines.push("@group(0) @binding(2) var<storage, read_write> filled: array<u32>;");
                for (const slot of used) lines.push(`@group(0) @binding(${3 + slot}) var<storage, read_write> so${slot}: array<u32>;`);
                lines.push("fn gx_vertex(prim: u32, n: u32) -> u32 {\n    switch (P.topology) {\n" +
                    "        case 1u: { return prim; }\n        case 2u: { return prim * 2u + n; }\n        case 3u: { return prim + n; }\n" +
                    "        case 4u: { return prim * 3u + n; }\n" +
                    "        case 5u: { if ((prim & 1u) == 1u && n < 2u) { return prim + 1u - n; } return prim + n; }\n" +
                    "        default: { return prim + n; }\n    }\n}");
                lines.push("@compute @workgroup_size(1) fn main() {");
                for (const slot of used) lines.push(`    var c${slot} = filled[${slot}u];`);
                lines.push("    for (var u = 0u; u < P.units; u++) {");
                if (shape.geometry) {
                    lines.push(`        let first = u * ${P}u;`);
                    lines.push(`        if (src[first * ${record}u + ${record - 1}u].x == 0u) { continue; }`);
                } else {
                    lines.push("        let instance = u / P.prims;\n        let prim = u % P.prims;");
                }
                // the whole primitive fits, or the stream output stops
                lines.push("        if (" + used.map(slot => `c${slot} + ${P * strides[slot]}u > P.sizes[${slot}]`).join(" || ") + ") { break; }");
                lines.push(`        for (var n = 0u; n < ${P}u; n++) {`);
                lines.push(shape.geometry ? `            let at = (first + n) * ${record}u;` :
                    `            let at = (instance * P.count + gx_vertex(prim, n)) * ${record}u;`);
                for (const w of writes) lines.push(`            so${w.slot}[(c${w.slot} + ${w.offset}u) >> 2u] = src[at + ${w.reg}u].${lanes[w.lane]};`);
                for (const slot of used) lines.push(`            c${slot} += ${strides[slot]}u;`);
                lines.push("        }\n    }");
                for (const slot of used) lines.push(`    filled[${slot}u] = c${slot};`);
                lines.push("}");
                try {
                    const module = this.device.createShaderModule({ code: lines.join("\n") });
                    pipe = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
                } catch (error) {
                    return this.warn("so:" + error.message, "the stream output shader failed: " + error.message);
                }
                this.pipelines.set(key, pipe);
            }
            const sizes = [0, 0, 0, 0];
            for (const slot of used) sizes[slot] = so.targets[slot].S.shadow.length;
            const params = new Uint32Array([shape.units, shape.prims || 1, shape.count || 0, shape.code || 0, ...sizes]);
            const filled = this.storageBuffer(16);
            this.endPass();
            const encoder = this.encoder();
            for (const slot of used) encoder.copyBufferToBuffer(this.soFilled(so.targets[slot].S), 0, filled, slot * 4, 4);
            const entries = [{ binding: 0, resource: { buffer: src } }, { binding: 1, resource: this.uniform(params) },
                { binding: 2, resource: { buffer: filled } }];
            for (const slot of used) entries.push({ binding: 3 + slot, resource: { buffer: so.targets[slot].S.buffer } });
            let group;
            try {
                group = this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
            } catch (error) {
                return this.warn("so-group:" + error.message, "the stream output bind group failed: " + error.message);
            }
            const compute = encoder.beginComputePass();
            compute.setPipeline(pipe);
            compute.setBindGroup(0, group);
            compute.dispatchWorkgroups(1);
            compute.end();
            for (const slot of used) encoder.copyBufferToBuffer(filled, slot * 4, this.soFilled(so.targets[slot].S), 0, 4);
            this.stats.streamOutputs = (this.stats.streamOutputs || 0) + 1;
        }

        /** DrawAuto: as many vertices as stream output put in vertex buffer 0 */
        drawAuto(c) {
            const st = c.state;
            const vb = st.vbs[0];
            const S = vb && this.surfaces.get(vb.sid);
            if (!S || !S.buffer || !vb.stride) return;
            let pipe = this.pipelines.get("drawauto");
            if (!pipe) {
                const code = "@group(0) @binding(0) var<storage, read> filled: array<u32>;\n" +
                    "@group(0) @binding(1) var<storage, read_write> args: array<u32>;\n" +
                    "@group(0) @binding(2) var<uniform> vb: vec4<u32>;\n" +
                    "@compute @workgroup_size(1) fn main() {\n" +
                    "    args[0] = select(0u, (filled[0] - vb.x) / vb.y, filled[0] > vb.x);\n" +
                    "    args[1] = 1u; args[2] = 0u; args[3] = 0u;\n}";
                pipe = this.device.createComputePipeline({ layout: "auto",
                    compute: { module: this.device.createShaderModule({ code }), entryPoint: "main" } });
                this.pipelines.set("drawauto", pipe);
            }
            const args = this.device.createBuffer({ size: 16, usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.INDIRECT });
            this.transient.push(args);
            const group = this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
                { binding: 0, resource: { buffer: this.soFilled(S) } }, { binding: 1, resource: { buffer: args } },
                { binding: 2, resource: this.uniform(Uint32Array.of(vb.offset >>> 0, vb.stride, 0, 0)) }] });
            this.endPass();
            const compute = this.encoder().beginComputePass();
            compute.setPipeline(pipe);
            compute.setBindGroup(0, group);
            compute.dispatchWorkgroups(1);
            compute.end();
            this.draw(c, { count: 0, first: 0, instances: 1, firstInstance: 0, indirect: { buffer: args, offset: 0 } });
        }

        /**
         * A draw of records a compute stage wrote: position and varyings as
         * the pixel shader reads them (`instances` of `count` records each)
         */
        drawRecords(c, a, ps, shader, module, buffer, topology, count, instances) {
            instances = instances || 1;
            const st = c.state;
            const varyings = ps && ps.program ? WGSL.pixelVaryings(ps.program) : {};
            const record = module.result.record, outputs = module.result.gs ? record - 1 : record;
            let position = -1;
            for (const output of shader.program.outputs) if (output.name === IR.NAME.POSITION && output.type === IR.OPERAND.OUTPUT) position = output.index;
            const perInstance = instances > 1 ? count : 0;
            const passKey = "records:" + record + ":" + outputs + ":" + position + ":" + (module.result.gs ? 1 : 0) + ":" +
                JSON.stringify(varyings) + ":" + perInstance;
            let pass = this.modules.get(passKey);
            if (!pass) {
                const fields = ["    @builtin(position) position: vec4<f32>,"], stores = [];
                for (const reg of Object.keys(varyings).map(Number).sort((x, y) => x - y)) {
                    const vary = varyings[reg];
                    const type = vary.type === "u32" ? "u32" : "f32";
                    const flat = type === "u32" || vary.interpolation === "flat" ? "@interpolate(flat) " :
                        vary.interpolation === "linear" ? `@interpolate(linear${vary.sampling ? ", " + vary.sampling : ""}) ` :
                        vary.sampling ? `@interpolate(perspective, ${vary.sampling}) ` : "";
                    fields.push(`    ${flat}@location(${reg}) o${reg}: vec4<${type}>,`);
                    const value = reg < outputs && reg !== position ? `gx_in[at + ${reg}u]` : "vec4<u32>()";
                    stores.push(type === "u32" ? `out.o${reg} = ${value};` : `out.o${reg} = bitcast<vec4<f32>>(${value});`);
                }
                const code = "struct GXDraw { base_vertex: u32, base_instance: u32, pad0: u32, pad1: u32, viewport: vec4<f32> }\n" +
                    "@group(0) @binding(15) var<uniform> gx_draw: GXDraw;\n" +
                    "@group(0) @binding(232) var<storage, read> gx_in: array<vec4<u32>>;\n" +
                    `struct Out {\n${fields.join("\n")}\n}\n` +
                    "@vertex fn main(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> Out {\n" +
                    `    let at = (iid * ${perInstance}u + vid) * ${record}u;\n    var out: Out;\n` +
                    // an unused slot (a geometry shader's flag lane): outside the clip volume
                    (module.result.gs ? `    if (gx_in[at + ${outputs}u].x == 0u) { out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); return out; }\n` : "") +
                    (position >= 0 ? `    let p = bitcast<vec4<f32>>(gx_in[at + ${position}u]);\n` : "    let p = vec4<f32>(0.0, 0.0, 0.0, 1.0);\n") +
                    "    out.position = vec4<f32>(p.xy * gx_draw.viewport.xy + gx_draw.viewport.zw * p.w, p.zw);\n" +
                    stores.map(x => "    " + x).join("\n") + "\n    return out;\n}\n";
                pass = { module: this.device.createShaderModule({ code }),
                    result: { bindings: [{ binding: 15, type: "draw" }, { binding: 232, type: "stage-in" }] } };
                this.modules.set(passKey, pass);
            }
            const blend = c.blends.get(st.blend);
            const dualSource = !!(blend && usesSource1(blend.words));
            let psModule = null;
            try {
                if (ps && ps.program) psModule = this.module(ps, { group: 1, targets: a.targets, dualSource });
            } catch (error) {
                return this.warn("translate:" + error.message, "shader translation failed: " + error.message);
            }
            const raster = c.rasters.get(st.raster);
            const depth = c.depths.get(st.depth);
            const plain = { indexed: false, count, instances: 1, first: 0, base: 0, firstInstance: 0 };
            const key = [passKey, ps ? ps.id : 0, JSON.stringify({ targets: a.targets, dualSource }), topology,
                a.colors.map(t => t ? t.format + (t.x ? "x" : "") : "-").join(","), a.depthFormat, a.samples,
                blend ? blend.words.join(",") : "", raster ? raster.words.join(",") : "", depth ? depth.words.join(",") : "",
                st.sampleMask, this.bindingKinds(c, null, psModule)].join("|");
            let pipeline = this.pipelines.get(key);
            if (!pipeline) {
                pipeline = this.createPipeline(c, { vsModule: pass, psModule, buffers: [], topology, call: plain, colors: a.colors,
                    depthFormat: a.depthFormat, samples: a.samples, blend, raster, depth, dualSource });
                if (!pipeline) return;
                this.pipelines.set(key, pipeline);
                this.stats.pipelines++;
            }
            const viewport = this.viewport(st, a.width, a.height);
            const groups = [this.bindGroup(c, SHADER_VS, pass, pipeline.layouts[0], plain, viewport.fix, { "stage-in": { buffer } }),
                psModule ? this.bindGroup(c, SHADER_PS, psModule, pipeline.layouts[1], plain, null) : this.emptyGroup];
            if (groups.includes(null)) return;
            const renderPass = this.renderPass(c, a, pipeline, groups, viewport, raster);
            this.stats.draws++;
            renderPass.draw(count, instances, 0, 0);
        }

        /** A draw whose vertices WebGPU cannot fetch: the vertex shader as compute, then its records drawn */
        drawPulled(c, call, vs, ps, a, input) {
            const st = c.state;
            if (call.indirect) return this.warn("pull-indirect", "indirect draws of vertices WebGPU cannot fetch are not supported");
            if (!call.count || !call.instances) return;
            let vsModule;
            try {
                vsModule = this.module(vs, { group: 0, mode: "vertex-compute", fetch: input.fetch });
            } catch (error) {
                return this.warn("translate:" + error.message, "shader translation failed: " + error.message);
            }
            const record = Math.max(1, vsModule.result.record);
            const vsOut = this.storageBuffer(call.count * call.instances * record * 16);
            const vsPipe = this.computePipeline(c, SHADER_VS, vsModule);
            if (!vsPipe) return;
            const ib = this.surfaces.get(st.ib.sid);
            const group = this.bindGroup(c, SHADER_VS, vsModule, vsPipe.layout, call, null, {
                "fetch": this.uniform(this.fetchParameters(st, call, input)),
                "index": { buffer: call.indexed && ib && ib.buffer ? ib.buffer : this.dummyBuffer },
                "vertex-buffer": slot => {
                    const vb = st.vbs[slot];
                    const S = vb && this.surfaces.get(vb.sid);
                    return { buffer: S && S.buffer ? S.buffer : this.dummyBuffer };
                },
                "stage-out": { buffer: vsOut },
            });
            if (!group) return;
            this.endPass();
            const compute = this.encoder().beginComputePass();
            compute.setPipeline(vsPipe.pipeline);
            compute.setBindGroup(0, group);
            this.dispatch(compute, call.count * call.instances);
            compute.end();
            this.stats.pulledDraws = (this.stats.pulledDraws || 0) + 1;
            this.drawRecords(c, a, ps, vs, vsModule, vsOut, TOPOLOGY[st.topology], call.count, call.instances);
        }

        /** GXFetch: the draw, and each vertex buffer's offset, stride and instance step rate */
        fetchParameters(st, call, input) {
            const words = new Uint32Array(8 + 64);
            const ib = st.ib;
            words[0] = call.count; words[1] = call.first; words[2] = (call.indexed ? call.base : 0) >>> 0;
            words[3] = call.indexed ? 1 : 0; words[4] = call.instances; words[5] = call.firstInstance >>> 0;
            words[6] = ib.format === SVGA3D_R16_UINT ? 1 : 0; words[7] = ib.offset >>> 0;
            const rates = new Map();
            if (input.layout) for (const e of input.layout.elements) if (e.instanced) rates.set(e.slot, Math.max(1, e.rate || 1));
            for (let slot = 0; slot < 16; slot++) {
                const vb = st.vbs[slot];
                if (!vb) continue;
                words[8 + 4 * slot] = vb.offset >>> 0;
                words[9 + 4 * slot] = vb.stride >>> 0;
                words[10 + 4 * slot] = rates.get(slot) || 1;
            }
            return words;
        }

        /** A uniform buffer with these words, for this encoder's work */
        uniform(words) {
            const buffer = this.device.createBuffer({ size: align(Math.max(16, words.byteLength), 16), usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST });
            this.device.queue.writeBuffer(buffer, 0, words);
            this.transient.push(buffer);
            return { buffer };
        }

        /** A storage buffer for this encoder's work */
        storageBuffer(size) {
            const buffer = this.device.createBuffer({ size: align(Math.max(16, size), 16), usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.COPY_DST });
            this.transient.push(buffer);
            return buffer;
        }

        computePipeline(c, type, module) {
            const key = "compute:" + type + ":" + module.key + ":" + this.bindingKinds(c, module, null, type);
            let pipe = this.pipelines.get(key);
            if (pipe) return pipe;
            try {
                const layout = this.bindGroupLayout(c, type, module, 4);
                pipe = { pipeline: this.device.createComputePipeline({
                    layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                    compute: { module: module.module, entryPoint: "main" } }), layout };
            } catch (error) {
                this.warn("compute:" + error.message, "a compute pipeline failed: " + error.message);
                return null;
            }
            this.pipelines.set(key, pipe);
            return pipe;
        }

        /** Enough workgroups of 64 for n invocations (the y dimension past 65535) */
        dispatch(compute, n) {
            const groups = Math.ceil(n / 64);
            const x = Math.min(groups, 65535), y = Math.ceil(groups / 65535);
            compute.dispatchWorkgroups(x, y);
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
        bindingKinds(c, vsModule, psModule, vsType) {
            const parts = [];
            for (const [type, module] of [[vsType === undefined ? SHADER_VS : vsType, vsModule], [SHADER_PS, psModule]]) {
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

        /** The bind group layout of a module's bindings, for a stage's state */
        bindGroupLayout(c, type, module, visibility) {
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
                } else if (b.type === "uniform" || b.type === "draw" || b.type === "fetch" || b.type === "geo") {
                    entries.push({ binding: b.binding, visibility, buffer: { type: "uniform" } });
                } else if (b.type === "read-storage" || b.type === "index" || b.type === "vertex-buffer" || b.type === "stage-in") {
                    entries.push({ binding: b.binding, visibility, buffer: { type: "read-only-storage" } });
                } else if (b.type === "storage" || b.type === "stage-out") {
                    entries.push({ binding: b.binding, visibility, buffer: { type: "storage" } });
                }
            }
            // samplers used with unfilterable textures must not filter
            if (unfilterable.size) {
                for (const e of entries) if (e.sampler && e.sampler.type === "filtering") e.sampler.type = "non-filtering";
            }
            return this.device.createBindGroupLayout({ entries });
        }

        createPipeline(c, o) {
            const layouts = [];
            for (const [type, module] of [[SHADER_VS, o.vsModule], [SHADER_PS, o.psModule]]) {
                if (!module) { layouts.push(this.emptyLayout); continue; }
                layouts.push(this.bindGroupLayout(c, type, module, type === SHADER_VS ? 1 : 2));
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

        /**
         * @param extra the resources of the compute variants' bindings: by
         *     binding type, and "vertex-buffer" a function of the slot
         */
        bindGroup(c, type, module, layout, call, fix, extra) {
            const stage = c.stages[type];
            const entries = [];
            for (const b of module.result.bindings) {
                if (extra && extra[b.type]) {
                    const resource = typeof extra[b.type] === "function" ? extra[b.type](b.slot) : extra[b.type];
                    entries.push({ binding: b.binding, resource });
                    continue;
                }
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
            /** stream output declarations: { entries: [{ slot, reg, mask, stream }], strides, rasterized } */
            this.streamOutputs = new Map();
            this.stages = {};
            for (let type = SHADER_VS; type <= SHADER_CS; type++) {
                this.stages[type] = { shader: INVALID, cbs: new Array(16).fill(null), srvs: new Array(128).fill(INVALID),
                    samplers: new Array(16).fill(INVALID) };
            }
            this.state = {
                layout: INVALID, vbs: new Array(32).fill(null), ib: { sid: INVALID, format: SVGA3D_R16_UINT, offset: 0 },
                topology: 1, rtvs: [], dsv: INVALID, blend: INVALID, blendFactor: [0, 0, 0, 0], sampleMask: INVALID,
                depth: INVALID, stencilRef: 0, raster: INVALID, viewports: [], scissors: [], predication: [INVALID, 0],
                soid: INVALID, soTargets: [],
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
                [COTABLE.DXSHADER]: this.shaders, [COTABLE.UAVIEW]: this.uavs, [COTABLE.STREAMOUTPUT]: this.streamOutputs };
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

    // Formats WebGPU lacks, stored wider (svga_dx_formats.js "e"): per SVGA
    // format, how many texels a guest block holds, the bytes of a texel on
    // the GPU, and the conversions of one block
    const F16 = (() => {
        const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
        return {
            encode(v) {
                f32[0] = v;
                const x = u32[0], sign = x >>> 16 & 0x8000, exp = (x >>> 23 & 0xFF) - 127 + 15, mant = x & 0x7FFFFF;
                if (exp <= 0) return sign;
                if (exp >= 31) return sign | 0x7C00;
                return sign | exp << 10 | mant >>> 13;
            },
            decode(h) {
                const sign = h & 0x8000 ? -1 : 1, exp = h >> 10 & 31, mant = h & 1023;
                if (!exp) return sign * mant * 2 ** -24;
                if (exp === 31) return mant ? NaN : sign * Infinity;
                return sign * (1 + mant / 1024) * 2 ** (exp - 15);
            },
        };
    })();
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    /** n channels of a normalized integer type, as floats of `width` bytes (2 or 4) */
    function normalized(n, bits, signed, width) {
        const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
        const bytes = bits / 8;
        const read = (v, o) => bits === 8 ? (signed ? v.getInt8(o) : v.getUint8(o)) : (signed ? v.getInt16(o, true) : v.getUint16(o, true));
        const write = (v, o, x) => bits === 8 ? (signed ? v.setInt8(o, x) : v.setUint8(o, x)) : (signed ? v.setInt16(o, x, true) : v.setUint16(o, x, true));
        return {
            texels: 1, gpu: n * width,
            expand(src, si, dst, di) {
                for (let c = 0; c < n; c++) {
                    const value = Math.max(read(src, si + c * bytes) / max, -1);
                    if (width === 4) dst.setFloat32(di + 4 * c, value, true);
                    else dst.setUint16(di + 2 * c, F16.encode(value), true);
                }
            },
            pack(src, si, dst, di) {
                for (let c = 0; c < n; c++) {
                    const value = width === 4 ? src.getFloat32(si + 4 * c, true) : F16.decode(src.getUint16(si + 2 * c, true));
                    write(dst, di + c * bytes, Math.round(clamp(value, signed ? -1 : 0, 1) * max));
                }
            },
        };
    }
    /** RGB32 into RGBA32: alpha 1 */
    const rgb32 = one => ({
        texels: 1, gpu: 16,
        expand(src, si, dst, di) { for (let c = 0; c < 3; c++) dst.setUint32(di + 4 * c, src.getUint32(si + 4 * c, true), true); dst.setUint32(di + 12, one, true); },
        pack(src, si, dst, di) { for (let c = 0; c < 3; c++) dst.setUint32(di + 4 * c, src.getUint32(si + 4 * c, true), true); },
    });
    /** 16-bit packed colors into RGBA8 */
    const packed16 = (decode, encode) => ({
        texels: 1, gpu: 4,
        expand(src, si, dst, di) { const [r, g, b, a] = decode(src.getUint16(si, true)); dst.setUint8(di, r); dst.setUint8(di + 1, g); dst.setUint8(di + 2, b); dst.setUint8(di + 3, a); },
        pack(src, si, dst, di) { dst.setUint16(di, encode(src.getUint8(si), src.getUint8(si + 1), src.getUint8(si + 2), src.getUint8(si + 3)), true); },
    });
    const c5 = v => (v & 31) * 255 / 31, c6 = v => (v & 63) * 255 / 63, c4 = v => (v & 15) * 17;
    const R565 = packed16(v => [c5(v >> 11), c6(v >> 5), c5(v), 255], (r, g, b) => (r >> 3) << 11 | (g >> 2) << 5 | b >> 3);
    const R1555 = packed16(v => [c5(v >> 10), c5(v >> 5), c5(v), v & 0x8000 ? 255 : 0], (r, g, b, a) => (a >> 7) << 15 | (r >> 3) << 10 | (g >> 3) << 5 | b >> 3);
    const R4444 = packed16(v => [c4(v >> 8), c4(v >> 4), c4(v), c4(v >> 12)], (r, g, b, a) => (a >> 4) << 12 | (r >> 4) << 8 | (g >> 4) << 4 | b >> 4);
    /** Two texels sharing R and B in a 4-byte block (R8G8_B8G8, G8R8_G8B8) */
    const pair = (r, g0, b, g1) => ({
        texels: 2, gpu: 4,
        expand(src, si, dst, di) {
            for (const [t, g] of [[0, g0], [1, g1]]) {
                dst.setUint8(di + 4 * t, src.getUint8(si + r)); dst.setUint8(di + 4 * t + 1, src.getUint8(si + g));
                dst.setUint8(di + 4 * t + 2, src.getUint8(si + b)); dst.setUint8(di + 4 * t + 3, 255);
            }
        },
        pack(src, si, dst, di) {
            dst.setUint8(di + r, src.getUint8(si)); dst.setUint8(di + g0, src.getUint8(si + 1));
            dst.setUint8(di + b, src.getUint8(si + 2)); dst.setUint8(di + g1, src.getUint8(si + 5));
        },
    });
    const EMULATED = {
        3: R565, 139: R565, 4: R1555, 5: R1555, 140: R1555, 6: R4444, 145: R4444,
        // A8 and ALPHA8: (0, 0, 0, a)
        135: { texels: 1, gpu: 4, expand(s, si, d, di) { d.setUint32(di, s.getUint8(si) << 24 >>> 0, true); }, pack(s, si, d, di) { d.setUint8(di, s.getUint8(si + 3)); } },
        32: { texels: 1, gpu: 4, expand(s, si, d, di) { d.setUint32(di, s.getUint8(si) << 24 >>> 0, true); }, pack(s, si, d, di) { d.setUint8(di, s.getUint8(si + 3)); } },
        // LUMINANCE8 (L, L, L, 1), LUMINANCE8_ALPHA8 (L, L, L, A)
        11: { texels: 1, gpu: 4, expand(s, si, d, di) { const l = s.getUint8(si); d.setUint32(di, (l | l << 8 | l << 16 | 255 << 24) >>> 0, true); }, pack(s, si, d, di) { d.setUint8(di, s.getUint8(si)); } },
        14: { texels: 1, gpu: 4, expand(s, si, d, di) { const l = s.getUint8(si), a = s.getUint8(si + 1); d.setUint32(di, (l | l << 8 | l << 16 | a << 24) >>> 0, true); },
            pack(s, si, d, di) { d.setUint8(di, s.getUint8(si)); d.setUint8(di + 1, s.getUint8(si + 3)); } },
        // A2R10G10B10 into rgb10a2unorm: R and B change places
        26: { texels: 1, gpu: 4, expand(s, si, d, di) { const v = s.getUint32(si, true); d.setUint32(di, ((v & 0xC00FFC00) | (v >>> 20 & 0x3FF) | (v & 0x3FF) << 20) >>> 0, true); },
            pack(s, si, d, di) { const v = s.getUint32(si, true); d.setUint32(di, ((v & 0xC00FFC00) | (v >>> 20 & 0x3FF) | (v & 0x3FF) << 20) >>> 0, true); } },
        49: rgb32(0x3F800000), 50: rgb32(0x3F800000), 51: rgb32(1), 52: rgb32(1),
        124: normalized(4, 16, false, 4), 55: normalized(4, 16, true, 4),
        129: normalized(2, 16, false, 4), 130: normalized(2, 16, true, 4),
        88: normalized(1, 16, false, 4), 90: normalized(1, 16, true, 4),
        127: normalized(4, 8, true, 2), 132: normalized(2, 8, true, 2), 95: normalized(1, 8, true, 2),
        99: pair(0, 1, 2, 3), 100: pair(1, 0, 3, 2),
    };

    /** A row of the guest's blocks into the GPU's texels */
    function expandRow(format, bytes, from, to) {
        const codec = EMULATED[format];
        if (!codec) return;
        const src = new DataView(from.buffer, from.byteOffset, from.byteLength), dst = new DataView(to.buffer, to.byteOffset, to.byteLength);
        const step = codec.gpu * codec.texels;
        for (let i = 0; (i + 1) * bytes <= from.length && (i + 1) * step <= to.length; i++) codec.expand(src, i * bytes, dst, i * step);
    }

    /** A row of the GPU's texels into the guest's blocks */
    function packRow(format, bytes, from, to) {
        const codec = EMULATED[format];
        if (!codec) return;
        const src = new DataView(from.buffer, from.byteOffset, from.byteLength), dst = new DataView(to.buffer, to.byteOffset, to.byteLength);
        const step = codec.gpu * codec.texels;
        for (let i = 0; (i + 1) * bytes <= to.length && (i + 1) * step <= from.length; i++) codec.pack(src, i * step, dst, i * bytes);
    }

    const api = { GXExecutor, GX, GX_MAGIC };
    if (isNode) module.exports = api;
    else global.V86GXExecutor = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
