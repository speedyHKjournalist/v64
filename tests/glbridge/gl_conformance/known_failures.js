// Scenes that fail today, each with the issue of docs/opengl-webgpu-review.md
// that fixes it. A scene whose failure is its own WebGPU errors or ReadPixels
// results is known as a whole (a string); otherwise only the tiles listed may
// fail -- the rest of the scene still has to pass. A fix deletes its entry or
// tile; a known failure that passes fails the run.
"use strict";
globalThis.GLConformanceKnownFailures = {
    texenv_crossbar_unit1_off: "S1-2g: a COMBINE crossbar source on a disabled unit is invalid WGSL",
    light_basic: { reason: "S2-2: RESCALE_NORMAL uses the wrong length", tiles: [
        "Scale 0.5, RESCALE_NORMAL",
    ] },
    light_twoside_colormaterial: { reason: "S2-13: COLOR_MATERIAL never latches into the material", tiles: [
        "COLOR_MATERIAL latched diffuse (0.9,0.1,0.1) after disable",
        "COLOR_MATERIAL EMISSION color (0,0,0.5)",
    ] },
    depth_range_reversed: "S1-2d: glDepthRange(n > f) is refused by WebGPU",
    clip_planes: { reason: "S2-10: user clip planes", tiles: [
        "plane1 keeps y<=10",
    ] },
    texgen: { reason: "S2-12: the q coordinate is dropped", tiles: [
        "TexCoord4f q=2: (1.25,0.75,0,2)->(0.625,0.375)",
    ] },
    drawpixels_bitmap: { reason: "S2-15: an invalid raster position still draws", tiles: [
        "invalid raster pos (x=-10, then moved): nothing",
    ] },
    tex_wrap_border: { reason: "S3: CLAMP_TO_BORDER has no border colour", tiles: [
        "CLAMP",
        "CLAMP_TO_BORDER",
    ] },
    mipmap: { reason: "S2-21 completeness, S3 LOD bias", tiles: [
        "TEXTURE_LOD_BIAS 1 at 16px: green",
        "TexEnv FILTER_CONTROL LOD_BIAS 2 at 16px: blue",
        "incomplete (mip filter, 1 level): untextured (0.2,0.8,0.4)",
    ] },
    tex_formats_unpack: { reason: "S2-22: BGRA with packed _REV types swaps red and blue", tiles: [
        "BGRA 8_8_8_8_REV",
        "RGB 3_3_2",
        "internal RGB5_A1",
        "UNPACK_SWAP_BYTES 5_6_5 (= tile 0)",
    ] },
    polymode_line: { reason: "S2-14: wireframe draws the triangulation's diagonal", tiles: [
        "LINE mode outline",
    ] },
    polymode_front_line_back_fill: { reason: "S2-14: the front polygon mode is used for both faces", tiles: [
        "BACK FILL (CW quad filled)",
        "FRONT LINE (CCW quad outlined)",
    ] },
    polymode_point: "S1-2e: indexed or polygon-mode points have no corner buffer",
    color_clamp_sum: { reason: "S2-11 COLOR_SUM, S2-17 vertex colour clamping", tiles: [
        "R: 2->0 clamped first => mid 0.5; G: -1->1 => mid 0.5",
        "COLOR_SUM primary+secondary",
        "COLOR_SUM after texturing (prim*0.5+sec)",
        "COLOR_SUM saturates at 1",
    ] },
    glsl_semantics: { reason: "S2-17: gl_FrontColor is not clamped", tiles: [
        "VS writes gl_FrontColor 2.0/0.0: clamped before interpolation",
    ] },
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
    readpixels_formats: "S2-23: readback ignores format, type and pack state",
    projective_texcoord: { reason: "S2-12: projective texture coordinates", tiles: [
        "q 1->4 across x: projective s/q",
        "uniform q=0.5",
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
    glsl_program_name_reuse: "S1-4: pipelines are cached by program name, across contexts (the earlier "
        + "program's pipeline wants a texture bind group this one does not set)",
    viewport_offscreen: { reason: "S2-7: a viewport outside the window is squashed", tiles: [
        "Viewport(-32,0,128,32): NDC x in [-.25,.25] -> window x 16..48",
        "Viewport(0,32,128,128): NDC [-1,-.75]^2 -> window 0..16 x 32..48",
    ] },
};
