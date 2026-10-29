#!/usr/bin/env node
// Renders every scene of ../scenes.js with Apple's OpenGL 2.1 (CGL, macOS
// only) and writes ../references.json.gz: the accelerated renderer's pixels
// (the reference) and the software renderer's (a second opinion, for pixels
// the two Apple renderers disagree on).
//
//   node tests/glbridge/gl_conformance/reference/update.mjs
//
// Run it after adding or changing a scene; the result is committed, so the
// browser suite needs no Apple GL.
import { execFileSync } from "node:child_process";
import { mkdtempSync as mkdtemp_sync, readFileSync as read_file_sync, writeFileSync as write_file_sync,
    copyFileSync as copy_file_sync, rmSync as rm_sync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync as gzip_sync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const build = mkdtemp_sync(join(tmpdir(), "gl-conformance-ref-"));
try {
    copy_file_sync(join(here, "ref.c"), join(build, "ref.c"));
    execFileSync(process.execPath, [join(here, "gen_c.js"), build], { stdio: "inherit" });
    execFileSync("clang", ["-O1", "-w", "-o", join(build, "ref"), join(build, "ref.c"),
        "-framework", "OpenGL"], { stdio: "inherit" });
    const render = kind => {
        const out = join(build, kind + ".json");
        execFileSync(join(build, "ref"), [kind, out], { stdio: "inherit" });
        const result = JSON.parse(read_file_sync(out, "utf8"));
        // base64 rather than the renderer's hex: half the size
        for(const scene of result.scenes) {
            scene.rgba = Buffer.from(scene.rgba, "hex").toString("base64");
            for(const extra of scene.extra) extra.bytes = Buffer.from(extra.bytes, "hex").toString("base64");
        }
        return result;
    };
    const references = { hw: render("hw"), sw: render("sw") };
    write_file_sync(join(here, "..", "references.json.gz"), gzip_sync(JSON.stringify(references), { level: 9 }));
    console.log("references:", references.hw.renderer, "/", references.sw.renderer, "--",
        references.hw.scenes.length, "scenes");
} finally {
    rm_sync(build, { recursive: true, force: true });
}
