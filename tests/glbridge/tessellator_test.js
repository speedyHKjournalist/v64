#!/usr/bin/env node
// The D3D11 tessellator's port (src/browser/glbridge/gx/tessellator.js)
// against Microsoft's reference: for each case, the number of points and
// indices and a checksum of both, as the reference (CHWTessellator from
// Mesa's src/gallium/auxiliary/tessellator, built natively) gave them.
// tessellator_browser_test.html checks the WGSL port against this one.
"use strict";

const assert = require("assert/strict");
const { tessellate } = require("../../src/browser/glbridge/gx/tessellator.js");

// domain (1 isoline, 2 tri, 3 quad), partitioning (1 integer, 2 pow2,
// 3 fractional_odd, 4 fractional_even), primitive (1 point, 2 line,
// 3 triangle_cw, 4 triangle_ccw), tess factors, points, indices, point
// checksum, index checksum
const CASES = [
    [3, 1, 3, [1, 1, 1, 1, 1, 1], 4, 6, 1572864, 30597376],
    [3, 1, 3, [4, 4, 4, 4, 4, 4], 25, 96, 28573696, 871542293],
    [3, 1, 4, [2, 3, 5, 7, 4, 6], 32, 135, 46323026, 864199540],
    [3, 3, 3, [3.3, 2.7, 5.1, 1.2, 4.4, 3.9], 34, 144, 49707327, 861807487],
    [3, 4, 3, [2.5, 6.2, 3.1, 9.7, 7.3, 2.2], 47, 198, 90441030, 195548004],
    [3, 2, 3, [64, 64, 64, 64, 64, 64], 4225, 24576, 465986526, 995813054],
    [3, 1, 1, [3, 2, 4, 5, 3, 2], 16, 16, 15106047, 474293891],
    [3, 4, 2, [2.2, 3.3, 4.4, 5.5, 6.6, 7.7], 69, 136, 181115218, 731816722],
    [3, 3, 3, [1, 1, 1, 1, 1.5, 1], 8, 30, 4172460, 388039772],
    [3, 1, 3, [0, 1, 1, 1, 1, 1], 0, 0, 0, 0],
    [2, 1, 3, [1, 1, 1, 1], 3, 3, 655360, 1026],
    [2, 1, 3, [5, 5, 5, 5], 27, 111, 20827342, 956385304],
    [2, 3, 4, [3.7, 2.1, 6.6, 4.9], 27, 111, 21809894, 102937995],
    [2, 4, 3, [2.5, 7.5, 4.25, 3.3], 25, 90, 18360395, 100074146],
    [2, 2, 3, [33, 17, 9, 64], 3036, 18033, 796911218, 355795131],
    [2, 3, 1, [4.4, 2.2, 3.3, 5.5], 40, 40, 42457966, 43791062],
    [2, 1, 2, [3, 4, 5, 6], 31, 60, 26727737, 790190988],
    [2, 4, 4, [63.9, 2, 2, 2], 69, 204, 74008150, 656067277],
    [1, 1, 2, [4, 3], 16, 24, 11905708, 603087170],
    [1, 3, 2, [2.5, 6.6], 24, 42, 23505606, 651174205],
    [1, 4, 1, [3, 7.7], 27, 27, 29171733, 643608609],
    [1, 1, 2, [64, 64], 4160, 8192, 568061947, 460932118],
    [1, 2, 1, [1, 1], 2, 2, 131072, 33],
    [1, 3, 2, [0, 5], 0, 0, 0, 0],
];

for (const [domain, partitioning, primitive, factors, points, indices, pointSum, indexSum] of CASES) {
    const r = tessellate({ domain, partitioning, primitive, factors });
    const where = `domain ${domain}, partitioning ${partitioning}, primitive ${primitive}, factors ${factors}`;
    assert.equal(r.points.length / 2, points, "points: " + where);
    assert.equal(r.indices.length, indices, "indices: " + where);
    let us = 0, idx = 0;
    for (let i = 0; i < points; i++) {
        us = (us + Math.round(r.points[i * 2] * 65536) * (i + 1) + Math.round(r.points[i * 2 + 1] * 65536) * (i + 7)) % 1000000007;
    }
    for (let i = 0; i < indices; i++) idx = (idx * 31 + r.indices[i] + 1) % 1000000007;
    assert.equal(us, pointSum, "the points: " + where);
    assert.equal(idx, indexSum, "the indices: " + where);
}
console.log("PASS: " + CASES.length + " tessellations match D3D11's reference (points, indices)");
