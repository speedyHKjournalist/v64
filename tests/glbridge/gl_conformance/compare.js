// Compares the executor's pixels for one scene against Apple GL's
// (references.json.gz: the accelerated renderer, with the software renderer as
// a second opinion). Shared by gl_conformance_browser_test.html and Node.
//
// A pixel fails when it differs from the reference by more than the
// tolerance, unless it matches the software renderer (the two Apple renderers
// disagree there, so either is acceptable), or it is an edge pixel: in
// "strict" scenes an edge is where the reference is not locally linear (a
// coverage boundary or a triangle seam; smooth Gouraud gradients are linear
// and stay interior), in "loose" scenes (lines, points) any pixel matching the
// reference within its 3x3 neighbourhood both ways.
"use strict";
(function(global) {
    const SIZE = 64;

    // Apple has no accumulation buffer on framebuffer objects: the accum
    // scene's reference is GL 2.1 section 4.2.4's arithmetic
    function synthetic(name) {
        if (name !== "accum") return null;
        const image = new Uint8Array(SIZE * SIZE * 4);
        const q = v => Math.round(Math.min(1, Math.max(0, v)) * 255);
        for (let y = 0; y < SIZE; ++y) for (let x = 0; x < SIZE; ++x) {
            let c;
            if (y >= 48) c = [0.1, 0.2, 0.3, 0.4];
            else if (y >= 24) c = [0.2, 0.6, 1.0, 0.5];
            else {
                // colour buffer values are 8-bit when Accum reads them
                const a = [0.8, 0.4, 0.2, 1].map(v => q(v) / 255), b = [0.2, 0.6, 1.0, 0.5].map(v => q(v) / 255);
                c = a.map((v, i) => ((v * 0.5 + b[i] * 0.25) * 0.8 + 0.1) * 1.5);
            }
            image.set(c.map(q), (y * SIZE + x) * 4);
        }
        return image;
    }

    function maxDiff(a, b, i) {
        let m = 0;
        for (let k = 0; k < 4; ++k) m = Math.max(m, Math.abs(a[i + k] - b[i + k]));
        return m;
    }

    function isEdge(ref, x, y, tol) {
        const at = (xx, yy) => (Math.min(SIZE - 1, Math.max(0, yy)) * SIZE + Math.min(SIZE - 1, Math.max(0, xx))) * 4;
        const i = at(x, y);
        for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
            const a = at(x - dx, y - dy), b = at(x + dx, y + dy);
            for (let k = 0; k < 4; ++k)
                if (Math.abs(ref[a + k] + ref[b + k] - 2 * ref[i + k]) > 2 * tol + 4) return true;
        }
        return false;
    }

    function nearMatch(a, b, x, y, tol) {
        const i = (y * SIZE + x) * 4;
        for (let dy = -1; dy <= 1; ++dy) for (let dx = -1; dx <= 1; ++dx) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue;
            const j = (yy * SIZE + xx) * 4;
            let d = 0;
            for (let k = 0; k < 4; ++k) d = Math.max(d, Math.abs(a[i + k] - b[j + k]));
            if (d <= tol) return true;
        }
        return false;
    }

    // per pixel: 0 ok, 1 interior failure, 2 edge-only difference, 3 matches the other Apple renderer
    function classify(ref, got, mode, alt, tol) {
        const bad = new Uint8Array(SIZE * SIZE);
        let interior = 0, edge = 0, worst = 0;
        for (let y = 0; y < SIZE; ++y) for (let x = 0; x < SIZE; ++x) {
            const i = (y * SIZE + x) * 4, d = maxDiff(ref, got, i);
            if (d <= tol) continue;
            if (alt && maxDiff(alt, got, i) <= tol) { bad[y * SIZE + x] = 3; continue; }
            if (mode === "loose") {
                if (nearMatch(ref, got, x, y, tol) && nearMatch(got, ref, x, y, tol)) {
                    bad[y * SIZE + x] = 2; edge++; continue;
                }
            } else if (isEdge(ref, x, y, tol)) { bad[y * SIZE + x] = 2; edge++; continue; }
            bad[y * SIZE + x] = 1; interior++; worst = Math.max(worst, d);
        }
        return { bad, interior, edge, worst };
    }

    const pixel = (image, x, y) => Array.from(image.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));

    /*
     * scene: from scenes.js; hw, sw: the references' scenes (rgba and extra
     * bytes as Uint8Array); got: the executor's { rgba, extra, error,
     * validation, exception }. Returns the verdict and what failed.
     */
    // The references with the tiles the specification decides (tile.expect)
    // painted in its colour: there the renderers' agreement does not count
    function specified(scene, image) {
        if (!image || !scene.tiles.some(tile => tile.expect)) return image;
        const out = image.slice();
        for (const tile of scene.tiles) {
            if (!tile.expect) continue;
            for (let y = tile.y; y < tile.y + tile.h; ++y)
                for (let x = tile.x; x < tile.x + tile.w; ++x) out.set(tile.expect, (y * SIZE + x) * 4);
        }
        return out;
    }

    function compareScene(scene, hw, sw, got, tol = 2) {
        const synth = synthetic(scene.name);
        const ref = specified(scene, synth || hw.rgba), alt = synth ? null : specified(scene, sw.rgba);
        // problems: everything, as text; failedTiles: the labels of the tiles
        // with interior failures; other: what is not a tile's (WebGPU errors,
        // ReadPixels results)
        const result = { name: scene.name, problems: [], failedTiles: [], other: [], interior: 0, edge: 0, worst: 0 };
        const other = text => { result.problems.push(text); result.other.push(text); };
        if (got.exception) other("exception: " + got.exception.split("\n")[0]);
        for (const message of got.validation || [])
            other("WebGPU: " + message.split("\n")[0]);
        if (!got.rgba || got.rgba.length !== ref.length) {
            other("no pixels read back");
            result.verdict = "FAIL";
            return result;
        }
        const c = classify(ref, got.rgba, scene.mode, alt, tol);
        result.interior = c.interior;
        result.edge = c.edge;
        result.worst = c.worst;
        for (const tile of scene.tiles) {
            let bad = 0, worst = 0, wx = -1, wy = -1;
            for (let y = tile.y; y < tile.y + tile.h; ++y) for (let x = tile.x; x < tile.x + tile.w; ++x) {
                if (c.bad[y * SIZE + x] !== 1) continue;
                ++bad;
                const d = maxDiff(ref, got.rgba, (y * SIZE + x) * 4);
                if (d > worst) { worst = d; wx = x; wy = y; }
            }
            if (!bad) continue;
            result.failedTiles.push(tile.label);
            result.problems.push("[" + tile.label + "] " + bad + " px, worst " + worst + " @" + wx + "," + wy +
                ": ref " + pixel(ref, wx, wy) + " got " + pixel(got.rgba, wx, wy));
        }
        // glReadPixels results, byte for byte (floats decoded)
        (hw.extra || []).forEach((e, k) => {
            const x = (got.extra || [])[k];
            const isFloat = e.type === 0x1406;
            const decode = b => isFloat ? Array.from(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~3))))
                : Array.from(b);
            const R = decode(e.bytes), G = x ? decode(x.bytes) : [];
            let worst = R.length === G.length ? 0 : Infinity;
            for (let i = 0; i < Math.min(R.length, G.length); ++i) worst = Math.max(worst, Math.abs(R[i] - G[i]));
            if (worst > (isFloat ? 0.01 : tol))
                other("ReadPixels 0x" + e.format.toString(16) + "/0x" + e.type.toString(16) + " " +
                    e.w + "x" + e.h + "@" + e.x + "," + e.y + ": ref " + R.slice(0, 8).map(v => +v.toFixed(3)) +
                    " got " + G.slice(0, 8).map(v => +v.toFixed(3)));
        });
        result.verdict = c.interior || result.problems.length ? "FAIL" : "PASS";
        return result;
    }

    const api = { SIZE, compareScene, classify };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else global.GLConformanceCompare = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
