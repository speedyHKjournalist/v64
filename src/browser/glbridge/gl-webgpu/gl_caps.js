// What the renderer can do, as OpenGL reports it (docs/opengl-webgpu-plan.md
// C3: the capabilities come from one place). The page's executor and the CPU
// side's shadow (gl_shadow.js) both answer from here. A capabilities object
// is { limits, features } as the WebGPU adapter reports them -- plain data:
// the renderer sends it to the device once its adapter is up, and the device
// keeps it in its snapshot, so a guest restored on another machine is told
// what it was told before.

(function(global) {
    "use strict";

    const constants = global.GLWGConstants || require("./gl_constants.js");
    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const GL = constants.GL;

    // Fixed by the executor's design, whatever the adapter
    const LIMITS = {
        MAX_TEXTURE_UNITS: 8,
        MAX_TEXTURE_COORDS: 8,
        MAX_LIGHTS: 8,
        MAX_CLIP_PLANES: 6,
        MAX_VERTEX_ATTRIBS: 16,
        MAX_DRAW_BUFFERS: 8,
        MAX_PIXEL_MAP_TABLE: protocol.C.V86GL_MAX_TYPED_QUERY_VALUES,
        MODELVIEW_STACK_DEPTH: 32,
        OTHER_STACK_DEPTH: 4,
        // gl_shader_translator.js's MAX_INTER_STAGE_SLOTS vec4s
        MAX_VARYING_FLOATS: 16 * 4,
    };

    const BASE_EXTENSIONS = [
        "GL_ARB_multitexture", "GL_ARB_texture_env_add",
        "GL_ARB_texture_env_combine", "GL_ARB_texture_env_dot3",
        "GL_ARB_texture_env_crossbar", "GL_ARB_texture_cube_map",
        "GL_ARB_texture_border_clamp", "GL_ARB_texture_mirrored_repeat",
        "GL_ARB_texture_compression", "GL_SGI_color_matrix",
        "GL_ARB_texture_non_power_of_two", "GL_ARB_depth_texture",
        "GL_ARB_shadow", "GL_ARB_point_parameters", "GL_ARB_point_sprite",
        "GL_ARB_transpose_matrix", "GL_ARB_window_pos",
        "GL_ARB_vertex_buffer_object", "GL_ARB_occlusion_query",
        "GL_ARB_multisample", "GL_ARB_shader_objects",
        "GL_ARB_vertex_shader", "GL_ARB_fragment_shader",
        "GL_ARB_shading_language_100", "GL_ARB_draw_buffers",
        "GL_EXT_texture3D", "GL_EXT_texture_lod_bias",
        "GL_EXT_texture_edge_clamp", "GL_EXT_blend_color",
        "GL_EXT_blend_minmax", "GL_EXT_blend_subtract",
        "GL_EXT_blend_func_separate", "GL_EXT_blend_equation_separate",
        "GL_EXT_stencil_wrap", "GL_EXT_stencil_two_side",
        "GL_EXT_secondary_color", "GL_EXT_fog_coord",
        "GL_EXT_packed_pixels", "GL_EXT_rescale_normal",
        "GL_EXT_separate_specular_color", "GL_EXT_bgra",
        "GL_EXT_framebuffer_object", "GL_EXT_framebuffer_blit",
        "GL_EXT_paletted_texture", "GL_EXT_generate_mipmap",
        "GL_SGIS_generate_mipmap", "GL_SGIS_texture_edge_clamp",
        "GL_SGIS_texture_lod", "GL_NV_blend_square",
    ];

    /*
     * The capabilities to send: the adapter limits the answers use, and the
     * features. limits and features are the executor's (WebGPU's
     * GPUSupportedLimits, and its own feature flags).
     */
    function capabilities(limits, features) {
        limits = limits || {};
        features = features || {};
        return {
            limits: {
                maxTextureDimension2D: limits.maxTextureDimension2D || 8192,
                maxTextureDimension3D: limits.maxTextureDimension3D || 2048,
                maxColorAttachments: limits.maxColorAttachments || 8,
            },
            features: {
                bc: !!features.bc,
                float32Filterable: !!features.float32Filterable,
                depthClipControl: !!features.depthClipControl,
            },
        };
    }

    function extensions(caps) {
        const list = [...BASE_EXTENSIONS];
        // Only advertised when the adapter really has the BC formats: the
        // CPU decode path keeps the picture right, but a guest that sees
        // S3TC will hand us compressed data forever, and saying so honestly
        // lets it choose.
        if (caps.features.bc)
            list.push("GL_EXT_texture_compression_s3tc");
        if (caps.features.float32Filterable)
            list.push("GL_ARB_texture_float", "GL_ARB_half_float_pixel");
        if (caps.features.depthClipControl)
            list.push("GL_ARB_depth_clamp");
        list.push("GL_EXT_texture_filter_anisotropic");
        return list.join(" ");
    }

    // glGetString's answer, or undefined when pname is not a capability
    function string(caps, pname) {
        switch (pname) {
        case GL.VENDOR: return "Anthropic v86gl";
        case GL.RENDERER: return "v86 WebGPU bridge";
        case GL.VERSION: return "2.1 (v86gl/WebGPU)";
        case GL.SHADING_LANGUAGE_VERSION: return "1.20";
        case GL.EXTENSIONS: return extensions(caps);
        default: return undefined;
        }
    }

    // glGetIntegerv's answer, or undefined when pname is not a capability
    function integer(caps, pname) {
        const limits = caps.limits;
        const C = protocol.C;
        switch (pname) {
        case C.V86GL_QUERY_HOST_CAPABILITIES:
            return C.V86GL_HOST_CAP_WEBGL2 | C.V86GL_HOST_CAP_COLOR_BUFFER_FLOAT |
                (caps.features.float32Filterable ? C.V86GL_HOST_CAP_TEXTURE_FLOAT_LINEAR : 0) |
                C.V86GL_HOST_CAP_ANISOTROPY;
        case GL.MAX_TEXTURE_SIZE:
            return Math.min(16384, limits.maxTextureDimension2D);
        case GL.MAX_3D_TEXTURE_SIZE:
            return Math.min(2048, limits.maxTextureDimension3D);
        case GL.MAX_CUBE_MAP_TEXTURE_SIZE:
            return Math.min(16384, limits.maxTextureDimension2D);
        case GL.MAX_TEXTURE_UNITS: return LIMITS.MAX_TEXTURE_UNITS;
        case GL.MAX_TEXTURE_COORDS: return LIMITS.MAX_TEXTURE_COORDS;
        case GL.MAX_TEXTURE_IMAGE_UNITS: return 16;
        case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return 16;
        case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return 24;
        case GL.MAX_VERTEX_ATTRIBS: return LIMITS.MAX_VERTEX_ATTRIBS;
        case GL.MAX_VARYING_FLOATS: return LIMITS.MAX_VARYING_FLOATS;
        case GL.MAX_VERTEX_UNIFORM_COMPONENTS: return 1024;
        case GL.MAX_FRAGMENT_UNIFORM_COMPONENTS: return 1024;
        case GL.MAX_DRAW_BUFFERS:
        case GL.MAX_COLOR_ATTACHMENTS:
            return Math.min(LIMITS.MAX_DRAW_BUFFERS, limits.maxColorAttachments);
        case GL.MAX_RENDERBUFFER_SIZE:
            return Math.min(16384, limits.maxTextureDimension2D);
        case GL.MAX_LIGHTS: return LIMITS.MAX_LIGHTS;
        case GL.MAX_PIXEL_MAP_TABLE: return LIMITS.MAX_PIXEL_MAP_TABLE;
        case GL.MAX_CLIP_PLANES: return LIMITS.MAX_CLIP_PLANES;
        case GL.MAX_MODELVIEW_STACK_DEPTH: return LIMITS.MODELVIEW_STACK_DEPTH;
        case GL.MAX_PROJECTION_STACK_DEPTH: return LIMITS.OTHER_STACK_DEPTH;
        case GL.MAX_TEXTURE_STACK_DEPTH: return LIMITS.OTHER_STACK_DEPTH;
        case GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT: return 16;
        case GL.MAX_ELEMENTS_VERTICES: return 65536;
        case GL.MAX_ELEMENTS_INDICES: return 65536;
        case GL.SAMPLE_BUFFERS: return 0;
        // GL_SAMPLES is zero when the selected framebuffer has no
        // multisample buffer; one is the raster sample count, not the GL
        // query value for this pixel format.
        case GL.SAMPLES: return 0;
        case GL.SUBPIXEL_BITS: return 8;
        case GL.RED_BITS: case GL.GREEN_BITS:
        case GL.BLUE_BITS: case GL.ALPHA_BITS: return 8;
        case GL.DEPTH_BITS: return 24;
        case GL.STENCIL_BITS: return 8;
        case GL.MAX_VIEWPORT_DIMS:
            return Math.min(16384, limits.maxTextureDimension2D);
        case GL.NUM_COMPRESSED_TEXTURE_FORMATS:
            return caps.features.bc ? 4 : 0;
        default: return undefined;
        }
    }

    const api = { LIMITS, capabilities, extensions, string, integer };
    global.GLCaps = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
