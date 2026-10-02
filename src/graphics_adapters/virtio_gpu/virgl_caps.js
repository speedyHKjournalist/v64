// What virtio-gpu's 3D (virgl) tells the guest it can do: the formats, as
// SVGA3D formats GX has (src/graphics_adapters/vmware_svga/svga_dx_formats.js
// says what GX can do with each), and the capsets VIRGL (1) and VIRGL2 (2),
// struct virgl_caps_v1 and v2 of third_party/virgl/virgl_hw.h. Mesa's virgl
// driver derives its GL version from them (virgl_screen.c): GLSL 3.30, so
// OpenGL 3.3 and OpenGL ES 3.0.

import { DX_FORMATS } from "../vmware_svga/svga_dx_formats.js";
import * as C from "../vmware_svga/svga_constants.js";

// PIPE_TEXTURE_* (struct virtio_gpu_resource_create_3d's target)
export const TARGET = { BUFFER: 0, TEXTURE_1D: 1, TEXTURE_2D: 2, TEXTURE_3D: 3, TEXTURE_CUBE: 4, TEXTURE_RECT: 5,
    TEXTURE_1D_ARRAY: 6, TEXTURE_2D_ARRAY: 7, TEXTURE_CUBE_ARRAY: 8 };

/** The renderer's name in the capset (Mesa shows "virgl (<it>)") */
const RENDERER = "v86 GX on WebGPU";

// Swizzles (PIPE_SWIZZLE_*): what a sampler view of a format reads
const X = 0, Y = 1, Z = 2, W = 3, ZERO = 4, ONE = 5;

/**
 * virgl format (VIRGL_FORMAT_*) -> [SVGA3D format name, swizzle or null].
 * The legacy luminance/alpha/intensity formats are red (red and green)
 * formats read through a swizzle.
 * @type {!Object<number, !Array>}
 */
export const VIRGL_FORMATS = {
    1: ["SVGA3D_B8G8R8A8_UNORM", null],
    2: ["SVGA3D_B8G8R8X8_UNORM", null],
    5: ["SVGA3D_B5G5R5A1_UNORM", null],
    6: ["SVGA3D_B4G4R4A4_UNORM", null],
    7: ["SVGA3D_B5G6R5_UNORM", null],
    8: ["SVGA3D_R10G10B10A2_UNORM", null],
    9: ["SVGA3D_R8_UNORM", [X, X, X, ONE]],        // L8
    10: ["SVGA3D_R8_UNORM", [ZERO, ZERO, ZERO, X]], // A8
    11: ["SVGA3D_R8_UNORM", [X, X, X, X]],          // I8
    12: ["SVGA3D_R8G8_UNORM", [X, X, X, Y]],        // L8A8
    13: ["SVGA3D_R16_UNORM", [X, X, X, ONE]],       // L16
    16: ["SVGA3D_D16_UNORM", null],
    18: ["SVGA3D_D32_FLOAT", null],
    19: ["SVGA3D_D24_UNORM_S8_UINT", null],
    21: ["SVGA3D_D24_UNORM_S8_UINT", null],         // Z24X8
    28: ["SVGA3D_R32_FLOAT", null],
    29: ["SVGA3D_R32G32_FLOAT", null],
    30: ["SVGA3D_R32G32B32_FLOAT", null],
    31: ["SVGA3D_R32G32B32A32_FLOAT", null],
    48: ["SVGA3D_R16_UNORM", null],
    49: ["SVGA3D_R16G16_UNORM", null],
    51: ["SVGA3D_R16G16B16A16_UNORM", null],
    56: ["SVGA3D_R16_SNORM", null],
    57: ["SVGA3D_R16G16_SNORM", null],
    59: ["SVGA3D_R16G16B16A16_SNORM", null],
    64: ["SVGA3D_R8_UNORM", null],
    65: ["SVGA3D_R8G8_UNORM", null],
    67: ["SVGA3D_R8G8B8A8_UNORM", null],
    74: ["SVGA3D_R8_SNORM", null],
    75: ["SVGA3D_R8G8_SNORM", null],
    77: ["SVGA3D_R8G8B8A8_SNORM", null],
    91: ["SVGA3D_R16_FLOAT", null],
    92: ["SVGA3D_R16G16_FLOAT", null],
    94: ["SVGA3D_R16G16B16A16_FLOAT", null],
    95: ["SVGA3D_R8_UNORM", [X, X, X, ONE]],        // L8_SRGB (not decoded)
    100: ["SVGA3D_B8G8R8A8_UNORM_SRGB", null],
    101: ["SVGA3D_B8G8R8X8_UNORM_SRGB", null],
    104: ["SVGA3D_R8G8B8A8_UNORM_SRGB", null],
    105: ["SVGA3D_BC1_UNORM", [X, Y, Z, ONE]],      // DXT1_RGB
    106: ["SVGA3D_BC1_UNORM", null],
    107: ["SVGA3D_BC2_UNORM", null],
    108: ["SVGA3D_BC3_UNORM", null],
    109: ["SVGA3D_BC1_UNORM_SRGB", [X, Y, Z, ONE]],
    110: ["SVGA3D_BC1_UNORM_SRGB", null],
    111: ["SVGA3D_BC2_UNORM_SRGB", null],
    112: ["SVGA3D_BC3_UNORM_SRGB", null],
    113: ["SVGA3D_BC4_UNORM", null],
    114: ["SVGA3D_BC4_SNORM", null],
    115: ["SVGA3D_BC5_UNORM", null],
    116: ["SVGA3D_BC5_SNORM", null],
    124: ["SVGA3D_R11G11B10_FLOAT", null],
    125: ["SVGA3D_R9G9B9E5_SHAREDEXP", null],
    126: ["SVGA3D_D32_FLOAT_S8X24_UINT", null],
    134: ["SVGA3D_R8G8B8A8_UNORM", [X, Y, Z, ONE]],  // R8G8B8X8
    177: ["SVGA3D_R8_UINT", null],
    178: ["SVGA3D_R8G8_UINT", null],
    180: ["SVGA3D_R8G8B8A8_UINT", null],
    181: ["SVGA3D_R8_SINT", null],
    182: ["SVGA3D_R8G8_SINT", null],
    184: ["SVGA3D_R8G8B8A8_SINT", null],
    185: ["SVGA3D_R16_UINT", null],
    186: ["SVGA3D_R16G16_UINT", null],
    188: ["SVGA3D_R16G16B16A16_UINT", null],
    189: ["SVGA3D_R16_SINT", null],
    190: ["SVGA3D_R16G16_SINT", null],
    192: ["SVGA3D_R16G16B16A16_SINT", null],
    193: ["SVGA3D_R32_UINT", null],
    194: ["SVGA3D_R32G32_UINT", null],
    195: ["SVGA3D_R32G32B32_UINT", null],
    196: ["SVGA3D_R32G32B32A32_UINT", null],
    197: ["SVGA3D_R32_SINT", null],
    198: ["SVGA3D_R32G32_SINT", null],
    199: ["SVGA3D_R32G32B32_SINT", null],
    200: ["SVGA3D_R32G32B32A32_SINT", null],
    253: ["SVGA3D_R10G10B10A2_UINT", null],
    255: ["SVGA3D_BC7_UNORM", null],
    256: ["SVGA3D_BC7_UNORM_SRGB", null],
    257: ["SVGA3D_BC6H_SF16", null],
    258: ["SVGA3D_BC6H_UF16", null],
};

/** The formats a scanout (a page flip, a cursor) may have */
const SCANOUT_FORMATS = [1, 2, 67, 134];

/**
 * @param {number} format VIRGL_FORMAT_*
 * @return {?{svga: number, name: string, swizzle: Array<number>, can: string, vertex: string}}
 */
export function virgl_format(format)
{
    const entry = VIRGL_FORMATS[format];
    if(!entry) return null;
    const [name, swizzle] = entry;
    const gx = DX_FORMATS[name];
    if(!gx || !gx[0] && !gx[2]) return null;
    return { svga: C[name], name, swizzle, can: gx[1], vertex: gx[2] };
}

/**
 * The format bitmasks (struct virgl_supported_format_mask): bit n is format n
 * @param {function(?Object, number):boolean} test
 * @return {!Uint32Array} 16 dwords
 */
function format_mask(test)
{
    const mask = new Uint32Array(16);
    for(const key of Object.keys(VIRGL_FORMATS))
    {
        const n = +key;
        if(test(virgl_format(n), n)) mask[n >> 5] |= 1 << (n & 31);
    }
    return mask;
}

// struct virgl_caps_bool_set1, bit by bit
const BSET = {
    indep_blend_enable: 0, indep_blend_func: 1, cube_map_array: 2, shader_stencil_export: 3,
    conditional_render: 4, start_instance: 5, primitive_restart: 6, blend_eq_sep: 7, instanceid: 8,
    vertex_element_instance_divisor: 9, seamless_cube_map: 10, occlusion_query: 11, timer_query: 12,
    streamout_pause_resume: 13, texture_multisample: 14, fragment_coord_conventions: 15,
    depth_clip_disable: 16, seamless_cube_map_per_texture: 17, ubo: 18, color_clamping: 19,
    poly_stipple: 20, mirror_clamp: 21, texture_query_lod: 22, has_fp64: 23,
    has_tessellation_shaders: 24, has_indirect_draw: 25, has_sample_shading: 26, has_cull: 27,
    conditional_render_inverted: 28, derivative_control: 29, polygon_offset_clamp: 30,
    transform_feedback_overflow_query: 31,
};

// capability_bits
const VIRGL_CAP_TGSI_INVARIANT = 1 << 0;
// a surface's format says whether it encodes sRGB (GL_FRAMEBUFFER_SRGB)
const VIRGL_CAP_SRGB_WRITE_CONTROL = 1 << 15;
const VIRGL_CAP_FBO_MIXED_COLOR_FORMATS = 1 << 18;
const VIRGL_CAP_CLIP_HALFZ = 1 << 27;

// PIPE_PRIM_*: points, lines, line strip, triangles, triangle strip, and
// the adjacency ones (the rest Mesa converts: line loops, fans, quads, polygons)
const PRIM_MASK = 1 << 0 | 1 << 1 | 1 << 3 | 1 << 4 | 1 << 5 | 1 << 10 | 1 << 11 | 1 << 12 | 1 << 13;

/** sizeof(struct virgl_caps_v1), sizeof(struct virgl_caps_v2) */
export const CAPS_V1_BYTES = 308;
export const CAPS_V2_BYTES = 1408;

/** The capsets: [id, max version, bytes] */
export const CAPSETS = [[1, 1, CAPS_V1_BYTES], [2, 2, CAPS_V2_BYTES]];

/**
 * A capset's contents: VIRGL (1) is virgl_caps_v1, VIRGL2 (2) virgl_caps_v2
 * @param {number} id
 * @return {!Uint8Array}
 */
export function capset(id)
{
    const bytes = new Uint8Array(CAPS_V2_BYTES);
    const view = new DataView(bytes.buffer);
    const u32 = (at, value) => view.setUint32(at, value >>> 0, true);
    const i32 = (at, value) => view.setInt32(at, value, true);
    const f32 = (at, value) => view.setFloat32(at, value, true);
    const mask = (at, words) => words.forEach((w, i) => u32(at + i * 4, w));

    const sampler = format_mask(f => !!f && /[su]/.test(f.can));
    // (not through a swizzle: an A8 target is R8, where alpha would land in
    // red; RGBX only drops its alpha)
    const render = format_mask((f, n) => !!f && f.can.includes("r") && (!f.swizzle || n === 134));
    const depth = format_mask(f => !!f && f.can.includes("d"));
    const vertex = format_mask(f => !!f && !!f.vertex);
    // (no fragment_coord_conventions: D3D's fragment position is GL's upper
    // left, and Mesa moves it for the rest itself)
    let bset = 0;
    for(const name of ["indep_blend_enable", "indep_blend_func", "conditional_render", "primitive_restart",
        "blend_eq_sep", "instanceid", "vertex_element_instance_divisor", "seamless_cube_map", "occlusion_query",
        "timer_query", "texture_multisample", "depth_clip_disable", "ubo"])
    {
        bset |= 1 << BSET[name];
    }

    // virgl_caps_v1
    u32(0, id === 1 ? 1 : 2);   // max_version
    mask(4, sampler);
    mask(68, render);
    mask(132, depth);
    mask(196, vertex);
    u32(260, bset);
    u32(264, 330);              // glsl_level
    u32(268, 2048);             // max_texture_array_layers
    u32(272, 4);                // max_streamout_buffers
    u32(276, 1);                // max_dual_source_render_targets
    u32(280, 8);                // max_render_targets
    u32(284, 4);                // max_samples
    u32(288, PRIM_MASK);
    u32(292, 1 << 16);          // max_tbo_size
    // the default uniform block and 13 UBOs: the 14 constant buffers of a D3D11 stage
    u32(296, 14);               // max_uniform_blocks
    u32(300, 1);                // max_viewports
    u32(304, 0);                // max_texture_gather_components
    if(id === 1) return bytes.slice(0, CAPS_V1_BYTES);

    // virgl_caps_v2
    f32(308, 1); f32(312, 1);   // aliased point sizes (WebGPU draws 1-pixel points)
    f32(316, 1); f32(320, 1);   // smooth point sizes
    f32(324, 1); f32(328, 1);   // aliased line widths
    f32(332, 1); f32(336, 1);   // smooth line widths
    f32(340, 16);               // max_texture_lod_bias
    u32(344, 256);              // max_geom_output_vertices
    u32(348, 1024);             // max_geom_total_output_components
    u32(352, 16);               // max_vertex_outputs
    u32(356, 16);               // max_vertex_attribs
    u32(360, 0);                // max_shader_patch_varyings
    i32(364, -8); i32(368, 7);  // texel offsets
    i32(372, 0); i32(376, 0);   // texture gather offsets
    u32(380, 16);               // texture_buffer_offset_alignment
    u32(384, 256);              // uniform_buffer_offset_alignment
    u32(388, 256);              // shader_buffer_offset_alignment
    u32(392, VIRGL_CAP_TGSI_INVARIANT | VIRGL_CAP_SRGB_WRITE_CONTROL | VIRGL_CAP_FBO_MIXED_COLOR_FORMATS |
        VIRGL_CAP_CLIP_HALFZ);
    // sample_locations[1] is 4x (Mesa's virgl_get_sample_position): a byte
    // per sample, x and y in 16ths; GX supersamples it, the centres of a 2x2 block
    u32(396 + 4, 0xCC4CC444);
    u32(428, 2048);             // max_vertex_attrib_stride
    u32(484, 8192);             // max_texture_2d_size
    u32(488, 2048);             // max_texture_3d_size
    u32(492, 8192);             // max_texture_cube_size
    u32(556, 15);               // host_feature_check_version
    mask(560, format_mask(f => !!f && /[sud]/.test(f.can)));   // supported_readback_formats
    mask(624, format_mask((f, n) => SCANOUT_FORMATS.includes(n)));
    u32(688, 0);                // capability_bits_v2
    u32(692, 256);              // max_video_memory, in MiB
    const name = new TextEncoder().encode(RENDERER);
    bytes.set(name.subarray(0, 63), 696);
    f32(760, 16);               // max_anisotropy
    u32(764, 16);               // max_texture_samplers
    mask(768, render);          // supported_multisample_formats
    for(let i = 0; i < 6; i++) u32(832 + i * 4, 65536);  // max_const_buffer_size
    u32(856, 0);                // num_video_caps
    u32(1372, 65536);           // max_uniform_block_size
    u32(1372, 65536);           // max_uniform_block_size
    return bytes;
}
