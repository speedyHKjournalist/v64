"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"),
    { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"), P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js");
const compiler = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm"))), fragment = "void main(){gl_FragColor=gl_Color;}";
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        shadow.setCapabilities(gpu.capabilities()); shadow.setGlslang(compiler);
        let interfaces = [];
        const submit = async s => {
            const bytes = s.bytes(), segments = shadow.process(bytes); interfaces = [];
            for (const segment of segments || [{ offset: 0, length: bytes.length }]) {
                const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length), view = new DataView(part.buffer, part.byteOffset, part.byteLength);
                if (view.getUint16(0, true) === P.GLFN.RESOLVED_PROGRAM_INTERFACE) {
                    const header = view.getUint16(2, true) === 0xFFFF ? 8 : 4; interfaces.push(P.decodeProgramInterface(view, header, part.length - header));
                }
                gpu.submit(copied ? part.slice() : part, {});
            }
            await gpu.idle();
        };
        await submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 3).call("CREATE_PROGRAM", 5).call("CREATE_SHADER", 1, GL.VERTEX_SHADER)
            .shaderSource(1, "attribute vec4 position;uniform vec4 colors[2];uniform float bias;void main(){gl_Position=position+vec4(bias,0,0,0);gl_FrontColor=colors[1];}")
            .call("COMPILE_SHADER", 1).call("ATTACH_SHADER", 5, 1).call("CREATE_SHADER", 2, GL.FRAGMENT_SHADER).shaderSource(2, fragment)
            .call("COMPILE_SHADER", 2).call("ATTACH_SHADER", 5, 2).call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5));
        assert.equal(interfaces.length, 1); const iface = interfaces[0], objectId = iface.object_id;
        const cpu = shadow.current.group.programs.get(5), renderer = gpu.current.shareGroup.programs.get(5), color = cpu.linked.uniforms.find(u => u.name === "colors"),
            attribute = cpu.linked.attributes.find(a => a.name === "position");
        assert.equal(renderer.cpuObjectId, objectId); assert.equal(renderer.cpuLinkGeneration, 1);
        assert.equal(renderer.adoptedAttribLocations.get("position"), attribute.location);
        assert.ok(renderer.uniformByLocation.has(color.location + 1), "all array elements are resolved before any location query");
        await submit(new GLStream().uniformfv(color.location + 1, 4, 1, [1, 2, 3, 4]));
        const mapped = renderer.uniformByLocation.get(color.location + 1), at = (mapped.uniform.offsetBytes + mapped.uniform.arrayStrideBytes) / 4;
        assert.deepEqual(Array.from(renderer.uniformFloats.subarray(at, at + 4)), [1, 2, 3, 4]);
        await submit(new GLStream().call("LINK_PROGRAM", 5)); assert.equal(renderer.cpuLinkGeneration, 2); assert.equal(renderer.cpuObjectId, objectId);
        assert.ok(renderer.uniformData.every(n => !n), "a successful link resets values");
        await submit(new GLStream().shaderSource(2, "void main(){broken;}").call("COMPILE_SHADER", 2).call("LINK_PROGRAM", 5));
        assert.equal(interfaces.length, 0); assert.equal(renderer.cpuLinkGeneration, 2); assert.equal(cpu.linkGeneration, 3);
        const restored = new GLShadow(); restored.setState(JSON.parse(JSON.stringify(shadow.getState())));
        assert.equal(restored.current.group.programs.get(5).objectId, objectId); assert.equal(restored.current.group.programs.get(5).executableGeneration, 2);
        await submit(new GLStream().call("DELETE_PROGRAM", 5).call("USE_PROGRAM", 0).call("CREATE_PROGRAM", 5).call("ATTACH_SHADER", 5, 1)
            .shaderSource(2, fragment).call("COMPILE_SHADER", 2).call("ATTACH_SHADER", 5, 2).call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5));
        assert.ok(interfaces[0].object_id > objectId); assert.equal(interfaces[0].link_generation, 1);
        const forged = P.encodeProgramInterface({ program: 5, object_id: 99, link_generation: 77 }, []);
        await submit(new GLStream().record(P.GLFN.RESOLVED_PROGRAM_INTERFACE, forged)); assert.equal(shadow.current.error, GL.INVALID_OPERATION); shadow.current.error = 0;
        await submit(new GLStream().call("PROGRAM_LINK_FAILED", 5)); assert.equal(shadow.current.error, GL.INVALID_OPERATION);
        assert.equal(gpu.current.shareGroup.programs.get(5).linked, true);
        assert.equal(gpu.hostErrors.length, 0); assert.equal(gpu.gpuErrors.errors.length, 0); assert.equal(gpu.stats.refusals, 0);
    }
    const bytes = P.encodeProgramInterface({ program: 1, object_id: 3, link_generation: 4 }, [{ name: "arr[0].value", location_kind: 1, location: 123, value_type: GL.FLOAT, value_count: 2 }]), view = new DataView(bytes.buffer);
    assert.equal(P.decodeProgramInterface(view, 0, bytes.length).entries[0].name, "arr[0].value");
    for (const field of ["entry_count", "data_size", "object_id", "link_generation"]) {
        const bad = bytes.slice(), v = new DataView(bad.buffer); v.setUint32(P.F.RESOLVED_PROGRAM_INTERFACE[field], field.includes("count") || field === "data_size" ? 0xFFFFFFFF : 0, true);
        assert.throws(() => P.decodeProgramInterface(v, 0, bad.length), /GL program interface/);
    }
    console.log("gl_program_interface_test: CPU-resolved locations without queries, complete arrays, link generations, name reuse, snapshots, rejected forgery and bounded wire records passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
