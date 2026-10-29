// Scenes that fail today, each with the issue of docs/opengl-webgpu-review.md
// that fixes it. A scene whose failure is its own WebGPU errors or ReadPixels
// results is known as a whole (a string); otherwise only the tiles listed may
// fail -- the rest of the scene still has to pass. A fix deletes its entry or
// tile; a known failure that passes fails the run.
"use strict";
globalThis.GLConformanceKnownFailures = {
};
