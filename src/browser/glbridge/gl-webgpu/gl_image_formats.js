// Image storage decisions shared by the CPU metadata and the renderer.
(function(global) {
    "use strict";
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const BASE_INTERNAL_FORMATS = {
        [GL.ALPHA]: "ALPHA", [GL.ALPHA4]: "ALPHA", [GL.ALPHA8]: "ALPHA",
        [GL.ALPHA12]: "ALPHA", [GL.ALPHA16]: "ALPHA",
        [GL.LUMINANCE]: "LUMINANCE", [GL.LUMINANCE4]: "LUMINANCE",
        [GL.LUMINANCE8]: "LUMINANCE", [GL.LUMINANCE12]: "LUMINANCE",
        [GL.LUMINANCE16]: "LUMINANCE",
        [GL.LUMINANCE_ALPHA]: "LUMINANCE_ALPHA",
        [GL.LUMINANCE4_ALPHA4]: "LUMINANCE_ALPHA",
        [GL.LUMINANCE8_ALPHA8]: "LUMINANCE_ALPHA",
        [GL.LUMINANCE12_ALPHA12]: "LUMINANCE_ALPHA",
        [GL.LUMINANCE16_ALPHA16]: "LUMINANCE_ALPHA",
        [GL.INTENSITY]: "INTENSITY", [GL.INTENSITY8]: "INTENSITY",
        [GL.INTENSITY16]: "INTENSITY",
        [GL.RGB]: "RGB", [GL.RGB4]: "RGB", [GL.RGB5]: "RGB", [GL.RGB8]: "RGB",
        [GL.RGB10]: "RGB", [GL.RGB12]: "RGB", [GL.RGB16]: "RGB",
        [GL.R3_G3_B2]: "RGB", [GL.RGB565]: "RGB",
        [GL.RGBA]: "RGBA", [GL.RGBA2]: "RGBA", [GL.RGBA4]: "RGBA",
        [GL.RGB5_A1]: "RGBA", [GL.RGBA8]: "RGBA", [GL.RGB10_A2]: "RGBA",
        [GL.RGBA12]: "RGBA", [GL.RGBA16]: "RGBA",
        [GL.BGR]: "RGB", [GL.BGRA]: "RGBA",
        3: "RGB", 4: "RGBA", 1: "LUMINANCE", 2: "LUMINANCE_ALPHA",
        [GL.DEPTH_COMPONENT]: "DEPTH",
        [GL.DEPTH_COMPONENT16]: "DEPTH",
        [GL.DEPTH_COMPONENT24]: "DEPTH",
        [GL.DEPTH_COMPONENT32]: "DEPTH",
        [GL.SRGB]: "RGB", [GL.SRGB8]: "RGB",
        [GL.SRGB_ALPHA]: "RGBA", [GL.SRGB8_ALPHA8]: "RGBA",
        [GL.RGBA16F_ARB]: "RGBA", [GL.RGBA32F_ARB]: "RGBA",
        [GL.RGB16F_ARB]: "RGB", [GL.RGB32F_ARB]: "RGB",
        [GL.COLOR_INDEX]: "COLOR_INDEX",
        [GL.COLOR_INDEX8_EXT]: "COLOR_INDEX",
    };

    const COMPRESSED_FORMATS = {
        [GL.COMPRESSED_RGB_S3TC_DXT1_EXT]:
            { gpu: "bc1-rgba-unorm", blockBytes: 8, base: "RGB", dxt: 1 },
        [GL.COMPRESSED_RGBA_S3TC_DXT1_EXT]:
            { gpu: "bc1-rgba-unorm", blockBytes: 8, base: "RGBA", dxt: 1 },
        [GL.COMPRESSED_RGBA_S3TC_DXT3_EXT]:
            { gpu: "bc2-rgba-unorm", blockBytes: 16, base: "RGBA", dxt: 3 },
        [GL.COMPRESSED_RGBA_S3TC_DXT5_EXT]:
            { gpu: "bc3-rgba-unorm", blockBytes: 16, base: "RGBA", dxt: 5 },
    };

    function storageFormatFor(internalFormat, features) {
        const compressed = COMPRESSED_FORMATS[internalFormat];
        if (compressed) {
            // Without the BC feature the blocks are decoded on the CPU rather
            // than the extension being withdrawn, because the guest may have
            // already been told S3TC exists. The decode is deterministic, so
            // the picture is identical; only the memory cost differs.
            return features && features.bc ?
                { gpu: compressed.gpu, compressed: true, blockBytes: compressed.blockBytes,
                  base: compressed.base, dxt: compressed.dxt } :
                { gpu: "rgba8unorm", compressed: false, decodeDXT: compressed.dxt,
                  base: compressed.base, blockBytes: compressed.blockBytes };
        }
        const base = BASE_INTERNAL_FORMATS[internalFormat];
        switch (internalFormat) {
        case GL.DEPTH_COMPONENT:
        case GL.DEPTH_COMPONENT24:
            // depth24plus has an implementation-defined texel layout and cannot
            // receive queue.writeTexture data. depth32float preserves uploaded
            // depth values and remains renderable/sampleable on core WebGPU.
            return { gpu: "depth32float", depth: true, base: "DEPTH" };
        case GL.DEPTH_COMPONENT16:
            return { gpu: "depth16unorm", depth: true, base: "DEPTH" };
        case GL.DEPTH_COMPONENT32:
            return { gpu: "depth32float", depth: true, base: "DEPTH" };
        case GL.SRGB:
        case GL.SRGB8:
        case GL.SRGB_ALPHA:
        case GL.SRGB8_ALPHA8:
            return { gpu: "rgba8unorm-srgb", base: base || "RGBA" };
        case GL.RGBA16F_ARB:
        case GL.RGB16F_ARB:
            return { gpu: "rgba16float", base: base || "RGBA", float: true };
        case GL.RGBA32F_ARB:
        case GL.RGB32F_ARB:
            return { gpu: "rgba32float", base: base || "RGBA", float: true };
        case GL.COLOR_INDEX:
        case GL.COLOR_INDEX8_EXT:
            // Palettised textures keep their index on the GPU and are resolved
            // in the shader, the same way the D3D9 path handles P8.
            return { gpu: "r8uint", base: "COLOR_INDEX", palettised: true };
        default:
            return { gpu: "rgba8unorm", base: base || "RGBA",
                ...(SIZED_BITS[internalFormat] ? { bits: SIZED_BITS[internalFormat] } : {}) };
        }
    }

    /*
     * The bits a sized internal format keeps per channel (R, G, B, A), when
     * fewer than eight: the image is stored at that precision as GL does
     * (review S2-22: RGB5_A1 kept an alpha of 100 that has one bit)
     */
    const SIZED_BITS = {
        [GL.R3_G3_B2]: [3, 3, 2, 8], [GL.RGB4]: [4, 4, 4, 8], [GL.RGB5]: [5, 5, 5, 8],
        [GL.RGBA2]: [2, 2, 2, 2], [GL.RGBA4]: [4, 4, 4, 4], [GL.RGB5_A1]: [5, 5, 5, 1],
        [GL.ALPHA4]: [8, 8, 8, 4], [GL.LUMINANCE4]: [4, 4, 4, 8], [GL.LUMINANCE4_ALPHA4]: [4, 4, 4, 4],
    };


    function renderbufferFormatFor(format, features) {
        const stencil = [GL.STENCIL_INDEX, GL.STENCIL_INDEX1_EXT, GL.STENCIL_INDEX4_EXT, GL.STENCIL_INDEX8_EXT, GL.STENCIL_INDEX16_EXT];
        if (stencil.includes(format)) return { gpu: "depth24plus-stencil8", base: "STENCIL", components: [0, 0, 0, 0, 0, 8] };
        if ([GL.DEPTH_STENCIL, GL.DEPTH24_STENCIL8].includes(format))
            return { gpu: "depth24plus-stencil8", base: "DEPTH_STENCIL", components: [0, 0, 0, 0, 24, 8] };
        if ([GL.DEPTH_COMPONENT, GL.DEPTH_COMPONENT16, GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT32, GL.DEPTH_COMPONENT32F].includes(format)) {
            const bits = format === GL.DEPTH_COMPONENT16 ? 16 : 32;
            return { gpu: bits === 16 ? "depth16unorm" : "depth32float", base: "DEPTH", depth: true,
                internalFormat: bits === 16 ? GL.DEPTH_COMPONENT16 : format === GL.DEPTH_COMPONENT32F ? format : GL.DEPTH_COMPONENT32,
                components: [0, 0, 0, 0, bits, 0] };
        }
        const base = BASE_INTERNAL_FORMATS[format];
        if (!["RGB", "RGBA"].includes(base) || format < 5 || [GL.BGR, GL.BGRA, GL.RGB565].includes(format)) return null;
        const storage = storageFormatFor(format, features);
        const bits = storage.gpu === "rgba32float" ? 32 : storage.gpu === "rgba16float" ? 16 : 8;
        return { ...storage, components: [bits, bits, bits, base === "RGBA" ? bits : 0, 0, 0] };
    }

    const api = { BASE_INTERNAL_FORMATS, COMPRESSED_FORMATS, SIZED_BITS, storageFormatFor, renderbufferFormatFor };
    global.GLImageFormats = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
