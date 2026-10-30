"use strict";
(function(global) {
    const { GPUBufferUsage, GPUTextureUsage, GPUMapMode } = global;
    const t = global.GLShaderTranslator || require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js");
    const arb = global.GLARBProgram || require("../../src/browser/glbridge/gl-webgpu/gl_arb_program.js");
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const source = "#version 120\nuniform float scale;void main(){gl_Position=gl_Vertex;gl_Position.x*=scale;gl_FrontColor=vec4(2,-1,0.5,1);gl_BackColor=vec4(0.25,0.5,0.75,1);gl_TexCoord[0]=gl_MultiTexCoord0+gl_MultiTexCoord1;gl_ClipVertex=gl_Vertex;}";
    function glsl(name, source, attributes, expected, uniforms, options) {
        const compiled = t.compileShader(source, "vertex"), link = t.linkVertexCapture(compiled, options);
        if (!link.ok) throw new Error(name + ": " + link.log);
        return { name, wgsl: link.wgslCompute, reflection: link.reflection, attributes, expected, uniforms };
    }
    function cases() {
        const result = [glsl("glsl_native", source, { 0: [0.25, 0, 0, 1], 8: [1, 2, 3, 4], 9: [4, 3, 2, 1] },
            [0.5, 0, 0, 1, 1, 0, 0.5, 1, 0.25, 0.5, 0.75, 1, 5, 5, 5, 5, 0.25, 0, 0, 1], [2])];
        result.push(glsl("matrix_attributes", "#version 120\nattribute mat3 frame;uniform vec4 offset;vec3 move(vec3 p){return frame*p+offset.xyz;}void main(){gl_Position=vec4(move(gl_Vertex.xyz),1);}",
            { 0: [0.25, 0.5, 0.75, 1], 4: [2, 0, 0, 0], 5: [0, 3, 0, 0], 6: [0, 0, 4, 0] },
            [1.5, 3.5, 6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0], [1, 2, 3, 0], { bindAttribLocations: new Map([["frame", 4]]) }));
        const texture = glsl("vertex_texture_lod", "#version 120\nuniform sampler2D probe;void main(){gl_Position=gl_Vertex;gl_Position.z=texture2DLod(probe,gl_MultiTexCoord0.xy,1.0).r;}",
            { 0: [0.25, 0.5, 0, 1], 8: [0.5, 0.5, 0, 1] },
            [0.25, 0.5, 128 / 255, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
        texture.texture = true; result.push(texture);
        for (const invariant of [false, true]) {
            const program = "!!ARBvp1.0\n" + (invariant ? "OPTION ARB_position_invariant;\n" : "MUL result.position,vertex.position,program.env[0];\n") +
                "MOV result.color.front.primary,program.local[0];\nMOV result.color.back.primary,vertex.color;\nADD result.texcoord[0],vertex.texcoord[0],vertex.texcoord[1];\nEND";
            const link = arb.compileARBProgram(program, { vertexCapture: true });
            if (!link.ok) throw new Error(link.log);
            const params = new Float32Array(arb.MAX_PROGRAM_PARAMETERS * 8); params.set([2, 1, 1, 1]); params.set([2, -1, 0.5, 1], arb.MAX_PROGRAM_PARAMETERS * 4);
            result.push({ name: invariant ? "arb_invariant" : "arb_parameters", wgsl: link.wgsl, reflection: link.reflection,
                attributes: { 0: [0.25, 0, 0, 1], 3: [0.25, 0.5, 0.75, 1], 8: [1, 2, 3, 4], 9: [4, 3, 2, 1] },
                expected: [invariant ? 0.25 : 0.5, 0, 0, 1, 1, 0, 0.5, 1, 0.25, 0.5, 0.75, 1, 5, 5, 5, 5, ...(invariant ? [0.25, 0, 0, 1] : [0, 0, 0, 0])],
                uniforms: params, state: invariant ? [...identity, ...identity] : null });
        }
        return result;
    }
    async function run(device, check) {
        for (const entry of cases()) {
            const owned = [], buffer = (size, usage, data) => {
                const b = device.createBuffer({ size, usage }); owned.push(b);
                if (data) device.queue.writeBuffer(b, 0, data); return b;
            };
            const uniformEntries = [];
            if (entry.uniforms) uniformEntries.push({ binding: 1, resource: { buffer: buffer(Math.max(16, entry.uniforms.length * 4), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, new Float32Array(entry.uniforms)) } });
            if (entry.state) uniformEntries.push({ binding: 0, resource: { buffer: buffer(entry.state.length * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, new Float32Array(entry.state)) } });
            const input = new Float32Array(65 * 64);
            for (let vertex = 0; vertex < 65; ++vertex) for (const [slot, values] of Object.entries(entry.attributes)) input.set(values, vertex * 64 + slot * 4);
            const inputBuffer = buffer(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, input),
                output = buffer(65 * t.VERTEX_CAPTURE.outputBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
                read = buffer(output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
            const module = device.createShaderModule({ code: entry.wgsl }), pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "capture_main" } });
            const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline);
            // Automatic layouts include empty groups below the highest used
            // group. Bind each one, including a completely constant program.
            for (let group = 0; group < 4; ++group) {
                let entries = group === 1 ? uniformEntries : group === 3 ? [{ binding: 0, resource: { buffer: inputBuffer } }, { binding: 1, resource: { buffer: output } }] : [];
                if (group === 2 && entry.texture) {
                    const texture = device.createTexture({ size: [2, 2, 1], mipLevelCount: 2, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); owned.push(texture);
                    device.queue.writeTexture({ texture, mipLevel: 0 }, new Uint8Array(16), { bytesPerRow: 8 }, [2, 2, 1]);
                    device.queue.writeTexture({ texture, mipLevel: 1 }, new Uint8Array([128, 64, 32, 255]), {}, [1, 1, 1]);
                    entries = [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: device.createSampler({}) }];
                }
                pass.setBindGroup(group, device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries }));
            }
            pass.dispatchWorkgroups(2); pass.end(); encoder.copyBufferToBuffer(output, 0, read, 0, output.size); device.queue.submit([encoder.finish()]);
            await read.mapAsync(GPUMapMode.READ); const values = new Float32Array(read.getMappedRange());
            for (let vertex = 0; vertex < 65; ++vertex) entry.expected.forEach((expected, i) => check(Math.abs(values[vertex * 20 + i] - expected) < 0.000001,
                entry.name + " vertex " + vertex + " component " + i + ": " + values[vertex * 20 + i] + " expected " + expected));
            read.unmap(); for (const object of owned) object.destroy();
        }
    }
    const api = { source, cases, run };
    global.GLVertexCaptureCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
