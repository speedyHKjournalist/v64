// Scenes that fail today, each with the issue of docs/opengl-webgpu-review.md
// that fixes it. A scene whose failure is its own WebGPU errors or ReadPixels
// results is known as a whole (a string); otherwise only the tiles listed may
// fail -- the rest of the scene still has to pass. A fix deletes its entry or
// tile; a known failure that passes fails the run.
"use strict";
globalThis.GLConformanceKnownFailures = {
    tex_wrap_border: { reason: "S3: CLAMP_TO_BORDER has no border colour", tiles: [
        "CLAMP",
        "CLAMP_TO_BORDER",
    ] },
    polymode_line: { reason: "S2-14: wireframe draws the triangulation's diagonal", tiles: [
        "LINE mode outline",
    ] },
    polymode_front_line_back_fill: { reason: "S2-14: the front polygon mode is used for both faces", tiles: [
        "BACK FILL (CW quad filled)",
        "FRONT LINE (CCW quad outlined)",
    ] },
    polymode_point: "S1-2e: indexed or polygon-mode points have no corner buffer",
    arb_fragment_program: { reason: "S2-48: the ARB parser", tiles: [
        "LIT x>0: (1,.5,.0625,1)*.5",
        "LIT x<=0: z=0",
        "TXP (1.25,.75,0,2)->texel(2,1)",
        "RSQ(-4)=0.5 (abs)",
        "fragment.position/64",
        "CMP (-1?a:b) + KIL on other",
        "FLR(-1.25)=-2 FRC(-1.25)=.75",
        "POW(.25,.5) EX2(-1) LG2(4)/4",
        "SCS(pi/6): cos .866 sin .5",
        "XPD x*y=z, DPH",
        "state.fog.color + state.light[0].diffuse*0",
        "LRP + MAD + SUB saturate",
        "DST",
    ] },
    arb_vertex_program: { reason: "S2-48: the ARB parser", tiles: [
        "ARL relative: local[a0.x+1] with a0=2.7 -> local[3]",
        "ARL negative: arr[a0.x-1] a0=floor(-0.3)... use 2.7 -> arr[1]",
        "EXP 1.5 -> (2, .5, 2.828, 1)/4",
        "LOG 8 -> (3, 1, 3, 1)/4",
        "LIT in VP",
    ] },
    arb_fp_semantics: { reason: "S2-48/S2-51: ARB fragment programs", tiles: [
        "TXP (1.25,.75,0,2)->texel(2,1)",
        "state.fog.color",
    ] },
    arb_vp_semantics: { reason: "S2-48: ARB vertex programs", tiles: [
        "env set before binding; ARL a0=floor(2.7)=2 -> arr[3]",
        "ARL negative offset arr[a0.x-1] -> arr[1]",
    ] },
    arb_diag: { reason: "S2-48: ARB programs", tiles: [
        "TEX, TEXTURE_2D disabled",
        "state.fog.color, FOG disabled",
        "state.fog.color, FOG enabled",
        "state.light[0].diffuse in FP",
    ] },
};
