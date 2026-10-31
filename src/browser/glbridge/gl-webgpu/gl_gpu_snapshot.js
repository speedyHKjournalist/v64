// Resource contents, independent of their GL names and binding graph. Single
// sample colour/BC data is copied as bytes; depth and MSAA retain each sample.
(function(global) {
    "use strict";
    const B = { READ: 1, SRC: 4, DST: 8, UNIFORM: 64, STORAGE: 128 }, T = { SRC: 1, DST: 2, BIND: 4, RENDER: 16 };
    const align = n => Math.ceil(n / 256) * 256;
    const SLICE_BYTES = 4 * 1024 * 1024;
    const vertex = "@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f { var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1); }";
    const hasDepth = format => format.startsWith("depth"), hasStencil = format => format.includes("stencil");
    function descriptor(resource) {
        const d = resource.descriptor || {}, size = d.size || {};
        if (typeof resource.createView !== "function") return { size: resource.size, usage: resource.usage ?? d.usage, label: d.label || resource.label || "GL restored buffer" };
        return { size: { width: resource.width ?? size.width ?? size[0], height: resource.height ?? size.height ?? size[1] ?? 1,
            depthOrArrayLayers: resource.depthOrArrayLayers ?? size.depthOrArrayLayers ?? size[2] ?? 1 },
        dimension: resource.dimension || d.dimension || "2d", format: resource.format || d.format,
        mipLevelCount: resource.mipLevelCount || d.mipLevelCount || 1, sampleCount: resource.sampleCount || d.sampleCount || 1,
        usage: resource.usage ?? d.usage, label: d.label || resource.label || "GL restored texture" };
    }
    function bytesPerBlock(format) {
        if (/^bc1-/.test(format)) return [4, 8];
        if (/^bc[23]-/.test(format)) return [4, 16];
        const sizes = { r8uint: 1, r8unorm: 1, rgba8unorm: 4, "rgba8unorm-srgb": 4, bgra8unorm: 4, "bgra8unorm-srgb": 4,
            r32float: 4, rgba16float: 8, rgba32float: 16, stencil8: 1 };
        if (!sizes[format]) throw new Error("GL snapshot does not support texture format " + format);
        return [1, sizes[format]];
    }
    function validate(saved) {
        const bad = () => { throw new Error("Invalid GL resource image"); }, integer = (v, max) => Number.isInteger(v) && v > 0 && v <= max, d = saved?.descriptor;
        if (!d || !integer(d.usage, 0x3FF)) bad();
        if (saved.kind === "buffer") {
            if (!integer(d.size, 0xFFFFFFFF) || d.size % 4 || !(saved.data instanceof Uint8Array) || saved.data.length !== d.size) bad(); return;
        }
        if (saved.kind !== "texture" || !["2d", "3d"].includes(d.dimension) || ![1, 4].includes(d.sampleCount) ||
            !integer(d.size?.width, 32768) || !integer(d.size?.height, 32768) || !integer(d.size?.depthOrArrayLayers, 32768) ||
            !integer(d.mipLevelCount, 16) || d.mipLevelCount > Math.floor(Math.log2(Math.max(d.size.width, d.size.height, d.dimension === "3d" ? d.size.depthOrArrayLayers : 1))) + 1 ||
            d.sampleCount > 1 && (d.dimension !== "2d" || d.mipLevelCount !== 1 || d.size.depthOrArrayLayers !== 1) || !Array.isArray(saved.levels)) bad();
        const depth = ["depth16unorm", "depth32float", "depth24plus-stencil8"].includes(d.format), stencil = hasStencil(d.format),
            [block, unit] = depth ? [1, 4] : bytesPerBlock(d.format), seen = new Set();
        if (d.dimension === "3d" && (depth || stencil)) bad();
        let expected = 0;
        for (let level = 0; level < d.mipLevelCount; ++level) expected += (d.dimension === "3d" ? Math.max(1, d.size.depthOrArrayLayers >> level) : d.size.depthOrArrayLayers) * (depth && stencil ? 2 : 1);
        if (saved.levels.length !== expected) bad();
        for (const image of saved.levels) {
            if (!image || !Number.isInteger(image.level) || image.level < 0 || image.level >= d.mipLevelCount || !Number.isInteger(image.layer) || image.layer < 0 ||
                image.layer >= (d.dimension === "3d" ? Math.max(1, d.size.depthOrArrayLayers >> image.level) : d.size.depthOrArrayLayers) || !(image.data instanceof Uint8Array)) bad();
            const width = Math.max(1, d.size.width >> image.level), height = Math.max(1, d.size.height >> image.level),
                key = image.level + ":" + image.layer + ":" + image.aspect;
            if (seen.has(key)) bad(); seen.add(key);
            let size;
            if (image.aspect === "depth" || image.aspect === "samples" || image.aspect === "stencil-samples") {
                if (image.width !== width || image.height !== height || image.aspect === "depth" && !depth || image.aspect === "samples" && (depth || stencil || d.sampleCount === 1) ||
                    image.aspect === "stencil-samples" && (!stencil || d.sampleCount === 1)) bad();
                size = width * height * d.sampleCount * (image.aspect === "depth" ? 4 : image.aspect === "samples" ? 16 : 1);
            } else {
                const isStencil = image.aspect === "stencil-only", b = isStencil ? 1 : block, bytes = isStencil ? 1 : unit;
                if (isStencil ? !stencil || d.sampleCount !== 1 : image.aspect !== "all" || depth || stencil || d.sampleCount !== 1) bad();
                if (image.width !== Math.ceil(width / b) * b || image.height !== Math.ceil(height / b) * b || image.rows !== Math.ceil(height / b) || image.rowBytes !== Math.ceil(width / b) * bytes) bad();
                size = image.rows * image.rowBytes;
            }
            if (image.data.length !== size) bad();
        }
    }
    async function mapped(executor, buffer) {
        try { await executor.awaitReadback(buffer.mapAsync(1), "GL resource snapshot", () => buffer.destroy()); return new Uint8Array(buffer.getMappedRange()).slice(); }
        finally { try { buffer.unmap(); } finally { buffer.destroy(); } }
    }
    async function rawCopy(executor, texture, d, level, layer, stencil) {
        const { device } = executor, width = Math.max(1, d.size.width >> level), height = Math.max(1, d.size.height >> level),
            [block, bytes] = stencil ? [1, 1] : bytesPerBlock(d.format), columns = Math.ceil(width / block), rows = Math.ceil(height / block),
            rowBytes = columns * bytes, pitch = align(rowBytes), packed = new Uint8Array(rowBytes * rows), step = stencil ? rows : Math.max(1, Math.floor(SLICE_BYTES / pitch));
        for (let first = 0; first < rows; first += step) {
            const count = Math.min(step, rows - first), buffer = device.createBuffer({ size: pitch * count, usage: B.READ | B.DST }), encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture, mipLevel: level, origin: { x: 0, y: first * block, z: layer }, aspect: stencil ? "stencil-only" : "all" },
                { buffer, bytesPerRow: pitch, rowsPerImage: count }, { width: columns * block, height: count * block, depthOrArrayLayers: 1 });
            device.queue.submit([encoder.finish()]); const data = await mapped(executor, buffer);
            for (let y = 0; y < count; ++y) packed.set(data.subarray(y * pitch, y * pitch + rowBytes), (first + y) * rowBytes);
        }
        return { level, layer, width: columns * block, height: rows * block, rows, rowBytes, aspect: stencil ? "stencil-only" : "all", data: packed };
    }
    async function sampledCopy(executor, texture, d, level, layer, depth) {
        const { device } = executor, width = Math.max(1, d.size.width >> level), height = Math.max(1, d.size.height >> level), samples = d.sampleCount,
            count = width * height * samples, unit = depth ? 4 : 16, step = SLICE_BYTES / unit, data = new Uint8Array(count * unit), multisample = samples > 1,
            inputType = depth ? multisample ? "texture_depth_multisampled_2d" : "texture_depth_2d" : "texture_multisampled_2d<f32>";
        for (let first = 0; first < count; first += step) {
            const chunk = Math.min(step, count - first), size = chunk * unit,
            code = `@group(0) @binding(0) var image:${inputType}; @group(0) @binding(1) var<storage,read_write> output:array<${depth ? "f32" : "vec4f"}>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){ let local=id.x; if(local>=${chunk}u){return;} let i=local+${first}u; let p=i/${samples}u;
output[local]=textureLoad(image,vec2i(i32(p%${width}u),i32(p/${width}u)),${multisample ? `i32(i%${samples}u)` : "0"}); }`,
            module = device.createShaderModule({ label: "GL snapshot samples", code }), pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } }),
            output = device.createBuffer({ size, usage: B.STORAGE | B.SRC }), read = device.createBuffer({ size, usage: B.READ | B.DST }), encoder = device.createCommandEncoder();
        try {
            const pass = encoder.beginComputePass(); pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                { binding: 0, resource: texture.createView({ dimension: "2d", baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1, aspect: depth ? "depth-only" : "all" }) },
                { binding: 1, resource: { buffer: output } }] }));
            pass.dispatchWorkgroups(Math.ceil(chunk / 64)); pass.end(); encoder.copyBufferToBuffer(output, 0, read, 0, size); device.queue.submit([encoder.finish()]);
            data.set(await mapped(executor, read), first * unit);
        } finally { output.destroy(); }
        }
        return { level, layer, width, height, aspect: depth ? "depth" : "samples", data };
    }
    function referenceGroup(device, pipeline, binding, value) {
        const buffer = device.createBuffer({ size: 16, usage: B.UNIFORM | B.DST }); device.queue.writeBuffer(buffer, 0, new Uint32Array([value, 0, 0, 0]));
        return { buffer, entry: { binding, resource: { buffer } } };
    }
    async function stencilSamples(executor, texture, d) {
        const { device } = executor, { width, height } = d.size, temporary = device.createTexture({ size: { width, height }, sampleCount: d.sampleCount,
            format: "rgba8unorm", usage: T.RENDER | T.BIND }), buffers = [];
        try {
            const code = vertex + "@group(0) @binding(0) var<uniform> reference:vec4u; @fragment fn fs()->@location(0) vec4f{return vec4f(f32(reference.x)/255.0,0,0,1);}",
                module = device.createShaderModule({ code }), pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
                    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" }, multisample: { count: d.sampleCount },
                    depthStencil: { format: d.format, depthWriteEnabled: false, depthCompare: "always", stencilReadMask: 255, stencilWriteMask: 0,
                        stencilFront: { compare: "equal", passOp: "keep", failOp: "keep", depthFailOp: "keep" }, stencilBack: { compare: "equal", passOp: "keep", failOp: "keep", depthFailOp: "keep" } } }),
                encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{ view: temporary.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
                    depthStencilAttachment: { view: texture.createView(), depthReadOnly: hasDepth(d.format), stencilReadOnly: true } });
            pass.setPipeline(pipeline);
            for (let value = 1; value < 256; ++value) {
                const group = referenceGroup(device, pipeline, 0, value); buffers.push(group.buffer);
                pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [group.entry] })); pass.setStencilReference(value); pass.draw(3);
            }
            pass.end(); device.queue.submit([encoder.finish()]);
            const image = await sampledCopy(executor, temporary, { ...d, format: "rgba8unorm" }, 0, 0, false), colors = new Float32Array(image.data.buffer);
            image.aspect = "stencil-samples"; image.data = Uint8Array.from({ length: colors.length / 4 }, (_, i) => Math.round(colors[i * 4] * 255)); return image;
        } finally { for (const buffer of buffers) buffer.destroy(); temporary.destroy(); }
    }
    async function capture(executor, resource) {
        const { device } = executor, d = descriptor(resource);
        if (typeof resource.createView !== "function") {
            if (!(d.usage & B.SRC)) throw new Error("GL snapshot buffer is not readable");
            const read = device.createBuffer({ size: d.size, usage: B.READ | B.DST }), encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(resource, 0, read, 0, d.size); device.queue.submit([encoder.finish()]);
            return { kind: "buffer", descriptor: d, data: await mapped(executor, read) };
        }
        const levels = [];
        for (let level = 0; level < d.mipLevelCount; ++level) {
            const layers = d.dimension === "3d" ? Math.max(1, d.size.depthOrArrayLayers >> level) : d.size.depthOrArrayLayers;
            for (let layer = 0; layer < layers; ++layer) {
                if (hasDepth(d.format)) levels.push(await sampledCopy(executor, resource, d, level, layer, true));
                if (hasStencil(d.format)) levels.push(d.sampleCount > 1 ? await stencilSamples(executor, resource, d) : await rawCopy(executor, resource, d, level, layer, true));
                if (!hasDepth(d.format) && !hasStencil(d.format)) levels.push(d.sampleCount > 1 ? await sampledCopy(executor, resource, d, level, layer, false) : await rawCopy(executor, resource, d, level, layer, false));
            }
        }
        return { kind: "texture", descriptor: d, levels };
    }
    function renderSamples(executor, texture, d, image) {
        const { device } = executor, depth = image.aspect === "depth", stencil = image.aspect === "stencil-samples", samples = d.sampleCount,
            values = stencil ? Uint32Array.from(image.data) : image.data, input = device.createBuffer({ size: values.byteLength, usage: B.STORAGE | B.DST }), buffers = [input];
        device.queue.writeBuffer(input, 0, values);
        const position = `let i=((u32(p.y)-${image.y || 0}u)*${image.width}u+u32(p.x))*${samples}u+sample;`,
            code = vertex + `@group(0) @binding(0) var<storage,read> values:array<${stencil ? "u32" : depth ? "f32" : "vec4f"}>;` +
                (stencil ? "@group(0) @binding(1) var<uniform> reference:vec4u;" : "") +
                `@fragment fn fs(@builtin(position) p:vec4f, @builtin(sample_index) sample:u32)${stencil ? "" : depth ? "->@builtin(frag_depth) f32" : "->@location(0) vec4f"}{${position}${stencil ? "if(values[i]!=reference.x){discard;}" : "return values[i];"}}`,
            module = device.createShaderModule({ label: "GL restore samples", code }), pipelineDescriptor = { layout: "auto", vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: depth || stencil ? [] : [{ format: d.format }] }, primitive: { topology: "triangle-list" }, multisample: { count: samples } };
        if (depth || stencil) pipelineDescriptor.depthStencil = { format: d.format, depthWriteEnabled: depth, depthCompare: "always", stencilWriteMask: stencil ? 255 : 0,
            stencilFront: { compare: "always", passOp: stencil ? "replace" : "keep", failOp: "keep", depthFailOp: "keep" },
            stencilBack: { compare: "always", passOp: stencil ? "replace" : "keep", failOp: "keep", depthFailOp: "keep" } };
        const pipeline = device.createRenderPipeline(pipelineDescriptor), encoder = device.createCommandEncoder(), view = texture.createView({ dimension: "2d", baseMipLevel: image.level,
            mipLevelCount: 1, baseArrayLayer: image.layer, arrayLayerCount: 1 }), attachment = { view };
        if (hasDepth(d.format)) Object.assign(attachment, stencil ? { depthReadOnly: true } : { depthLoadOp: "load", depthStoreOp: "store" });
        if (hasStencil(d.format)) Object.assign(attachment, depth ? { stencilReadOnly: true } : { stencilLoadOp: "load", stencilStoreOp: "store" });
        const pass = encoder.beginRenderPass({ colorAttachments: depth || stencil ? [] : [{ view, loadOp: "load", storeOp: "store" }],
            ...(depth || stencil ? { depthStencilAttachment: attachment } : {}) });
        pass.setPipeline(pipeline);
        pass.setScissorRect(0, image.y || 0, image.width, image.height);
        for (let value = stencil ? 1 : 0; value < (stencil ? 256 : 1); ++value) {
            const entries = [{ binding: 0, resource: { buffer: input } }];
            if (stencil) { const group = referenceGroup(device, pipeline, 1, value); entries.push(group.entry); buffers.push(group.buffer); pass.setStencilReference(value); }
            pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })); pass.draw(3);
        }
        pass.end(); device.queue.submit([encoder.finish()]); return buffers;
    }
    async function restore(executor, saved) {
        const { device } = executor, d = saved.descriptor;
        if (saved.kind === "buffer") { const buffer = device.createBuffer(d); device.queue.writeBuffer(buffer, 0, saved.data); return buffer; }
        const texture = device.createTexture({ ...d, usage: d.usage | (d.sampleCount > 1 ? T.BIND : T.DST) });
        try {
            for (const image of saved.levels) {
                if (["depth", "samples", "stencil-samples"].includes(image.aspect)) {
                    const stencil = image.aspect === "stencil-samples", rowBytes = image.width * d.sampleCount * (image.aspect === "samples" ? 16 : 4),
                        sourceRow = stencil ? rowBytes / 4 : rowBytes, step = Math.max(1, Math.floor(SLICE_BYTES / rowBytes));
                    for (let y = 0; y < image.height; y += step) {
                        const height = Math.min(step, image.height - y), buffers = renderSamples(executor, texture, d, { ...image, y, height, data: image.data.subarray(y * sourceRow, (y + height) * sourceRow) });
                        try { await executor.awaitReadback(device.queue.onSubmittedWorkDone(), "GL sample restore"); }
                        finally { for (const buffer of buffers) buffer.destroy(); }
                    }
                } else {
                    const block = image.height / image.rows, step = image.aspect === "stencil-only" ? image.rows : Math.max(1, Math.floor(SLICE_BYTES / image.rowBytes));
                    for (let y = 0; y < image.rows; y += step) {
                        const rows = Math.min(step, image.rows - y);
                        device.queue.writeTexture({ texture, mipLevel: image.level, origin: { x: 0, y: y * block, z: image.layer }, aspect: image.aspect },
                            image.data.subarray(y * image.rowBytes, (y + rows) * image.rowBytes), { bytesPerRow: image.rowBytes, rowsPerImage: rows },
                            { width: image.width, height: rows * block, depthOrArrayLayers: 1 });
                    }
                }
            }
            await executor.awaitReadback(device.queue.onSubmittedWorkDone(), "GL resource restore"); return texture;
        } catch (error) { texture.destroy(); throw error; }
    }
    async function checked(executor, operation, restoreImage) {
        executor.device.pushErrorScope("validation");
        let result, failure;
        try { result = await operation(); } catch (error) { failure = error; }
        const error = await executor.device.popErrorScope();
        if (failure || error) { if (restoreImage) result?.destroy(); throw failure || new Error("GL resource snapshot: " + error.message); }
        return result;
    }
    const api = { descriptor, validate, capture: (executor, resource) => checked(executor, () => capture(executor, resource)),
        restore: (executor, saved) => { validate(saved); return checked(executor, () => restore(executor, saved), true); } };
    global.GLGPUArchive = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
