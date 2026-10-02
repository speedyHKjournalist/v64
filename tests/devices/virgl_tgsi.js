#!/usr/bin/env node

// virtio-gpu's virgl shaders: TGSI text (tests/gpu/shaders/tgsi/, as
// Mesa's virgl driver sent it) through tgsi.js and tgsi_vgpu10.js into
// VGPU10 tokens, which GX's decoder must take and its WGSL emitter turn into
// WGSL naga accepts (when naga is there: cargo install naga-cli).

import assert from "assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const IR = require("../../src/browser/glbridge/shader_ir/dxbc_frontend.js");
const W = require("../../src/browser/glbridge/shader_ir/wgsl_emitter.js");
const { parse_tgsi } = await import("../../src/graphics_adapters/virtio_gpu/tgsi.js");
const { tgsi_to_vgpu10 } = await import("../../src/graphics_adapters/virtio_gpu/tgsi_vgpu10.js");

const naga = process.env.D9_NAGA || (spawnSync("naga", ["--version"]).status === 0 ? "naga" : null);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "virgl-tgsi-"));

function validate(name, code)
{
    if(!naga) return;
    const file = path.join(scratch, name + ".wgsl");
    fs.writeFileSync(file, code);
    const result = spawnSync(naga, [file], { encoding: "utf8" });
    if(result.status !== 0)
    {
        console.error(code.split("\n").map((l, i) => String(i + 1).padStart(4) + "  " + l).join("\n"));
        assert.fail(name + ": naga rejected the WGSL:\n" + result.stderr + result.stdout);
    }
}

const corpus = path.join(__dirname, "../gpu/shaders/tgsi");
const files = fs.readdirSync(corpus).filter(f => f.endsWith(".txt")).sort();
const programs = new Map(files.map(f => [f, parse_tgsi(fs.readFileSync(path.join(corpus, f), "utf8"))]));

// fragment shaders first: their inputs are what the vertex shaders write
const links = new Map();
let count = 0;
for(const [name, program] of programs)
{
    if(program.processor !== 1) continue;
    const key = { flatshade: false, color_buffers: 2, swizzles: [[0, 1, 2, 5], [0, 0, 0, 5], [0, 1, 2, 3]], alpha_func: 4, alpha_ref: 0.5 };
    const result = tgsi_to_vgpu10(program, key);
    assert.deepEqual(result.problems, [], name);
    const p = IR.decode(result.tokens);
    const targets = { 0: "f32", 1: "f32" };
    const wgsl = W.emit(p, { targets });
    assert.deepEqual(wgsl.warnings, [], name);
    validate(name, wgsl.code);
    links.set(name.replace(/-fs\.txt$/, ""), { inputs: result.inputs, varyings: W.pixelVaryings(p) });
    count++;
}
for(const [name, program] of programs)
{
    if(program.processor !== 0) continue;
    const link = links.get(name.replace(/-vs\.txt$/, "")) || { inputs: { GENERIC0: 0 }, varyings: { 0: { type: "f32" } } };
    for(const [flip_y, halfz] of [[false, false], [true, true]])
    {
        const result = tgsi_to_vgpu10(program, { outputs: link.inputs, flip_y, halfz });
        assert.deepEqual(result.problems, [], name);
        const p = IR.decode(result.tokens);
        const vertexInputs = {};
        for(const input of p.inputs) if(!input.name) vertexInputs[input.index] = "f32";
        const wgsl = W.emit(p, { vertexInputs, varyings: link.varyings });
        assert.deepEqual(wgsl.warnings, [], name);
        validate(name + (flip_y ? "-flip" : ""), wgsl.code);
        // the position: Y flipped, Z into [0, 1], or as it is
        if(flip_y) assert.match(wgsl.code, /-/, name);
    }
    count++;
}
assert.ok(count >= 5);
console.log("PASS: " + count + " TGSI programs translated" + (naga ? ", their WGSL valid by naga" : " (naga not found: WGSL unchecked)"));
fs.rmSync(scratch, { recursive: true, force: true });
