#!/usr/bin/env node
import { readFile as read_file, mkdir, writeFile as write_file } from "node:fs/promises";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = new URL("src/browser/glbridge/", root);
const output = new URL("build/glbridge/", root);
// Keep this order explicit: the existing modules bind dependencies at load time.
const files = [
    "webgpu_host.js", "d3d8-webgpu/d3d8_executor.js",
    "d3d9-webgpu/d3d9_shader_pipeline.js", "d3d9-webgpu/d3d9_executor.js",
    "d3d9-webgpu/ddraw_ops.js", "gl-webgpu/gl_constants.js",
    "gl-webgpu/gl_wire.js", "gl-webgpu/gl_state_layout.js",
    "gl-webgpu/gl_shader_translator.js", "gl-webgpu/gl_fixed_function.js",
    "gl-webgpu/gl_arb_program.js", "gl-webgpu/gl_executor.js",
    "graphics_journal.js", "v86_network_bridge.js", "webgpu_compositor.js", "graphics_adapter.js",
];
const contents = await Promise.all(files.map(file => read_file(new URL(file, source), "utf8")));
const worker = await read_file(new URL("d3d9-webgpu/d3d9_shader_worker.js", source), "utf8");
const journal_worker = await read_file(new URL("graphics_journal_worker.js", source), "utf8");
const revision = create_hash("sha256").update(contents.join("\n") + worker + journal_worker).digest("hex").slice(0, 20);
const prefix = `globalThis.V86GL_BUILD_REVISION = ${JSON.stringify(revision)};\n`;
await mkdir(output, { recursive: true });
// Isolate CommonJS detection from a consuming page's module/require globals.
const bundle = prefix + "(function(module, require) {\n" + contents.join("\n;\n") + "\n})();\n";
await write_file(new URL("libv86-webgpu.js", output), bundle);
await write_file(new URL("d3d9_shader_worker.js", output), prefix + worker);
await write_file(new URL("d3d9_shader_pipeline.js", output), prefix + contents[2]);
await write_file(new URL("graphics_journal_worker.js", output), prefix + journal_worker);
await write_file(new URL("manifest.json", output), JSON.stringify({ revision, files: [
    "libv86-webgpu.js", "d3d9_shader_worker.js", "d3d9_shader_pipeline.js", "graphics_journal_worker.js",
] }, null, 2) + "\n");
console.log(`Built WebGPU graphics ${revision} in ${fileURLToPath(output)}`);
