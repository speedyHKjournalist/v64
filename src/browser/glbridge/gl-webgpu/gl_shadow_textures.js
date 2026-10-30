(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const parameters = global.GLTextureParameters || require("./gl_texture_parameters.js");
    const formats = global.GLImageFormats || require("./gl_image_formats.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    const IMAGE_TARGETS = [null, new Set([GL.TEXTURE_1D, GL.PROXY_TEXTURE_1D]),
        new Set([GL.TEXTURE_2D, GL.PROXY_TEXTURE_2D, GL.PROXY_TEXTURE_CUBE_MAP,
            ...Array.from({ length: 6 }, (_, i) => GL.TEXTURE_CUBE_MAP_POSITIVE_X + i)]),
        new Set([GL.TEXTURE_3D, GL.PROXY_TEXTURE_3D])];
    const PIXEL_FORMATS = new Set([GL.COLOR_INDEX, GL.RED, GL.GREEN, GL.BLUE, GL.ALPHA, GL.RGB, GL.RGBA,
        GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.BGR, GL.BGRA, GL.DEPTH_COMPONENT]);
    const PIXEL_TYPES = new Set([GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT, GL.UNSIGNED_INT,
        GL.FLOAT, GL.HALF_FLOAT_ARB, 0x1A00]); // BITMAP
    const COMPONENTS = new Map([[GL.COLOR_INDEX, 1], [GL.RED, 1], [GL.GREEN, 1], [GL.BLUE, 1], [GL.ALPHA, 1],
        [GL.LUMINANCE, 1], [GL.LUMINANCE_ALPHA, 2], [GL.RGB, 3], [GL.BGR, 3], [GL.RGBA, 4], [GL.BGRA, 4], [GL.DEPTH_COMPONENT, 1]]);
    const SCALAR_BYTES = new Map([[GL.BYTE, 1], [GL.UNSIGNED_BYTE, 1], [GL.SHORT, 2], [GL.UNSIGNED_SHORT, 2],
        [GL.INT, 4], [GL.UNSIGNED_INT, 4], [GL.FLOAT, 4], [GL.HALF_FLOAT_ARB, 2]]);
    const RGB_PACKED = new Set([GL.UNSIGNED_BYTE_3_3_2, GL.UNSIGNED_BYTE_2_3_3_REV, GL.UNSIGNED_SHORT_5_6_5, GL.UNSIGNED_SHORT_5_6_5_REV]);
    const RGBA_PACKED = new Set([GL.UNSIGNED_SHORT_4_4_4_4, GL.UNSIGNED_SHORT_5_5_5_1, GL.UNSIGNED_SHORT_4_4_4_4_REV,
        GL.UNSIGNED_SHORT_1_5_5_5_REV, GL.UNSIGNED_INT_8_8_8_8, GL.UNSIGNED_INT_8_8_8_8_REV,
        GL.UNSIGNED_INT_10_10_10_2, GL.UNSIGNED_INT_2_10_10_10_REV]);
    const setters = new Set(["TEX_PARAMETERI", "TEX_PARAMETERF", "TEX_PARAMETERIV", "TEX_PARAMETERFV"]);
    const ensure = image => image.parameters || (image.parameters = parameters.initial());
    const copy = values => Object.fromEntries(Object.entries(values).map(([p, v]) => [p, v.slice()]));
    function pixelError(format, type) {
        if (!PIXEL_FORMATS.has(format) || !PIXEL_TYPES.has(type) && !RGB_PACKED.has(type) && !RGBA_PACKED.has(type) ||
            type === 0x1A00 && format !== GL.COLOR_INDEX) return GL.INVALID_ENUM;
        return RGB_PACKED.has(type) && format !== GL.RGB || RGBA_PACKED.has(type) && ![GL.RGBA, GL.BGRA].includes(format) ? GL.INVALID_OPERATION : 0;
    }
    function uploadSpan(c, r, dimensions) {
        if (!r.width || dimensions >= 2 && !r.height || dimensions >= 3 && !r.depth) return 0;
        const value = pname => c.state.values[pname]?.[0] || 0;
        const height = dimensions >= 2 ? r.height : 1, depth = dimensions >= 3 ? r.depth : 1;
        let bits = r.type === 0x1A00 ? 1 : SCALAR_BYTES.get(r.type) * COMPONENTS.get(r.format) * 8;
        if (RGB_PACKED.has(r.type)) bits = [GL.UNSIGNED_BYTE_3_3_2, GL.UNSIGNED_BYTE_2_3_3_REV].includes(r.type) ? 8 : 16;
        if (RGBA_PACKED.has(r.type)) bits = [GL.UNSIGNED_INT_8_8_8_8, GL.UNSIGNED_INT_8_8_8_8_REV,
            GL.UNSIGNED_INT_10_10_10_2, GL.UNSIGNED_INT_2_10_10_10_REV].includes(r.type) ? 32 : 16;
        const alignment = value(GL.UNPACK_ALIGNMENT) || 4;
        const stride = Math.ceil(Math.ceil((value(GL.UNPACK_ROW_LENGTH) || r.width) * bits / 8) / alignment) * alignment;
        const imageStride = stride * (value(GL.UNPACK_IMAGE_HEIGHT) || height);
        const skipBits = value(GL.UNPACK_SKIP_PIXELS) * bits;
        return (dimensions >= 3 ? value(GL.UNPACK_SKIP_IMAGES) * imageStride : 0) + value(GL.UNPACK_SKIP_ROWS) * stride +
            Math.floor(skipBits / 8) + (depth - 1) * imageStride + (height - 1) * stride + Math.ceil((skipBits % 8 + r.width * bits) / 8);
    }
    for (const dimensions of [1, 2, 3]) for (const compressed of [false, true]) {
        const name = (compressed ? "COMPRESSED_TEX_IMAGE_" : "TEX_IMAGE_") + dimensions + "D";
        GLShadow.rules({ [P.GLFN[name]]: (s, b, v, o, size) => {
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            const r = P.decodeRecord(name, v, o), proxy = formats.PROXY_TARGETS.get(r.target);
            if (!IMAGE_TARGETS[dimensions].has(r.target)) return GL.INVALID_ENUM;
            const target = proxy || (dimensions === 2 && r.target !== GL.TEXTURE_2D ? GL.TEXTURE_CUBE_MAP : r.target);
            const maximum = s.capabilities ? caps.integer(s.capabilities, target === GL.TEXTURE_3D ? GL.MAX_3D_TEXTURE_SIZE :
                target === GL.TEXTURE_CUBE_MAP ? GL.MAX_CUBE_MAP_TEXTURE_SIZE : GL.MAX_TEXTURE_SIZE) : 8192;
            if (r.level < 0 || r.level > Math.floor(Math.log2(maximum)) || r.border < 0 || r.border > 1) return GL.INVALID_VALUE;
            const sizes = [r.width, ...(dimensions >= 2 ? [r.height] : []), ...(dimensions >= 3 ? [r.depth] : [])];
            const maximumSize = Math.max(1, Math.floor(maximum / 2 ** r.level)) + 2 * r.border;
            if (sizes.some(n => n < 2 * r.border || !proxy && n > maximumSize) || target === GL.TEXTURE_CUBE_MAP && r.width !== r.height)
                return GL.INVALID_VALUE;
            const block = formats.COMPRESSED_FORMATS[r.internalformat];
            if (compressed) {
                if (!block || dimensions !== 2) return GL.INVALID_ENUM;
                if (r.border) return GL.INVALID_OPERATION;
                if (r.image_size !== Math.ceil(r.width / 4) * Math.ceil(r.height / 4) * block.blockBytes) return GL.INVALID_VALUE;
            } else {
                if ((!formats.BASE_INTERNAL_FORMATS[r.internalformat] && !block) || [GL.BGR, GL.BGRA, GL.RGB565].includes(r.internalformat))
                    return GL.INVALID_VALUE;
                const error = pixelError(r.format, r.type); if (error) return error;
                const base = formats.storageFormatFor(r.internalformat).base;
                if ((base === "DEPTH") !== (r.format === GL.DEPTH_COMPONENT) ||
                    base === "COLOR_INDEX" && r.format !== GL.COLOR_INDEX || base === "DEPTH" && ![GL.TEXTURE_1D, GL.TEXTURE_2D].includes(target))
                    return GL.INVALID_OPERATION;
            }
            const bytes = compressed ? r.image_size : r.data_size;
            if (!proxy && P.RECORDS[name].size + bytes > size) return GL.INVALID_VALUE;
            if (!proxy && !compressed && bytes && bytes < uploadSpan(s.current, r, dimensions)) return GL.INVALID_OPERATION;
            return 0;
        } });
    }
    for (const dimensions of [1, 2, 3]) for (const compressed of [false, true]) {
        const name = (compressed ? "COMPRESSED_TEX_SUB_IMAGE_" : "TEX_SUB_IMAGE_") + dimensions + "D";
        GLShadow.rules({ [P.GLFN[name]]: (s, b, v, o, size) => {
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            const r = P.decodeRecord(name, v, o);
            if (!IMAGE_TARGETS[dimensions].has(r.target) || formats.PROXY_TARGETS.has(r.target)) return GL.INVALID_ENUM;
            const cube = dimensions === 2 && r.target !== GL.TEXTURE_2D;
            const maximum = s.capabilities ? caps.integer(s.capabilities, dimensions === 3 ? GL.MAX_3D_TEXTURE_SIZE :
                cube ? GL.MAX_CUBE_MAP_TEXTURE_SIZE : GL.MAX_TEXTURE_SIZE) : 8192;
            if (r.level < 0 || r.level > Math.floor(Math.log2(maximum))) return GL.INVALID_VALUE;
            const image = s.boundImage(r.target), info = image.texture.levels.get(image.layer)?.get(r.level);
            if (!info) return GL.INVALID_OPERATION;
            const lengths = [r.width, ...(dimensions >= 2 ? [r.height] : []), ...(dimensions >= 3 ? [r.depth] : [])];
            const offsets = [r.xoffset, r.yoffset, r.zoffset], bounds = [info.width, info.height, info.depth], border = info.border || 0;
            if (lengths.some((n, i) => n < 0 || offsets[i] < -border || offsets[i] + n > bounds[i] - border)) return GL.INVALID_VALUE;
            const block = formats.COMPRESSED_FORMATS[info.internalFormat], isCompressed = info.compressed ?? !!block;
            if (compressed) {
                if (!formats.COMPRESSED_FORMATS[r.format] || dimensions !== 2) return GL.INVALID_ENUM;
                if (!isCompressed || r.format !== info.internalFormat) return GL.INVALID_OPERATION;
                if (r.image_size !== Math.ceil(r.width / 4) * Math.ceil(r.height / 4) * block.blockBytes) return GL.INVALID_VALUE;
            } else {
                const error = pixelError(r.format, r.type); if (error) return error;
                const base = formats.storageFormatFor(info.internalFormat).base;
                if ((base === "DEPTH") !== (r.format === GL.DEPTH_COMPONENT) || base === "COLOR_INDEX" && r.format !== GL.COLOR_INDEX)
                    return GL.INVALID_OPERATION;
            }
            if (isCompressed && block) {
                if (r.xoffset % 4 || r.yoffset % 4) return GL.INVALID_OPERATION;
                if ((compressed || r.xoffset || r.yoffset) &&
                    (r.width % 4 && r.xoffset + r.width !== info.width || r.height % 4 && r.yoffset + r.height !== info.height))
                    return GL.INVALID_OPERATION;
            }
            const bytes = compressed ? r.image_size : r.data_size;
            if (P.RECORDS[name].size + bytes > size) return GL.INVALID_VALUE;
            if (!compressed && bytes && bytes < uploadSpan(s.current, r, dimensions)) return GL.INVALID_OPERATION;
            return 0;
        } });
    }
    function command(name, a) {
        const scalar = name === "TEX_PARAMETERI" || name === "TEX_PARAMETERF";
        return parameters.normalize(a[1], scalar ? [a[2]] : a.slice(3, 3 + a[2]), name.endsWith("I") || name.endsWith("IV"), scalar);
    }
    for (const name of setters) state.rule(name, (c, a) => {
        if (!parameters.targets.includes(a[0])) return GL.INVALID_ENUM;
        const d = parameters.definitions.get(a[1]);
        if (d && name.endsWith("V") && a[2] !== d.initial.length) return GL.INVALID_VALUE;
        return command(name, a).error || 0;
    });
    GLShadow.rules({ [P.GLFN.PRIORITIZE_TEXTURES]: (s, b, v, o, n) => {
        if (s.current.state.begin) return GL.INVALID_OPERATION;
        const count = v.getInt32(o, true); return count < 0 || 4 + count * 8 > n ? GL.INVALID_VALUE : 0;
    } });
    GLShadow.prototype.prioritizeTextures = function(bytes, view, offset) {
        for (let i = 0; i < view.getInt32(offset, true); ++i) {
            const image = this.current.group.textures.get(view.getUint32(offset + 4 + i * 8, true));
            if (image?.target) ensure(image)[GL.TEXTURE_PRIORITY] = [Math.fround(Math.max(0, Math.min(1, view.getFloat32(offset + 8 + i * 8, true))))];
        }
    };
    GLShadow.install({ [P.GLFN.PRIORITIZE_TEXTURES]: "prioritizeTextures" });
    state.parameter(P.C.V86GL_PARAMETER_TEXTURE, (s, target, pname) => {
        if (!parameters.targets.includes(target)) return GL.INVALID_ENUM;
        const d = parameters.definitions.get(pname); if (!d) return GL.INVALID_ENUM;
        return [ensure(s.boundImage(target).texture)[pname], d.kind];
    });
    state.parameter(P.C.V86GL_PARAMETER_TEXTURE_LEVEL, (s, target, pname, level) => {
        const proxy = formats.PROXY_TARGETS.get(target);
        const cube = target >= GL.TEXTURE_CUBE_MAP_POSITIVE_X && target <= GL.TEXTURE_CUBE_MAP_NEGATIVE_Z;
        if (![GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D].includes(target) && !cube && !proxy) return GL.INVALID_ENUM;
        const maximum = s.capabilities ? caps.integer(s.capabilities, (proxy || target) === GL.TEXTURE_3D ? GL.MAX_3D_TEXTURE_SIZE :
            cube || proxy === GL.TEXTURE_CUBE_MAP ? GL.MAX_CUBE_MAP_TEXTURE_SIZE : GL.MAX_TEXTURE_SIZE) : 16384;
        if (level > Math.floor(Math.log2(maximum))) return GL.INVALID_VALUE;
        const image = !proxy && s.boundImage(target), info = proxy ? s.current.proxyImages.get(target)?.get(level) : image.texture.levels.get(image.layer)?.get(level);
        const compressed = !!(info && (info.compressed ?? !!formats.COMPRESSED_FORMATS[info.internalFormat]));
        switch (pname) {
        case GL.TEXTURE_WIDTH: return [[info?.width || 0], "i"];
        case GL.TEXTURE_HEIGHT: return [[info?.height || 0], "i"];
        case GL.TEXTURE_DEPTH: return [[info?.depth || 0], "i"];
        case GL.TEXTURE_INTERNAL_FORMAT:
            return [[!info ? 1 : !compressed && formats.COMPRESSED_FORMATS[info.internalFormat] ?
                formats.COMPRESSED_FORMATS[info.internalFormat].base === "RGB" ? GL.RGB8 : GL.RGBA8 : info.internalFormat], "e"];
        case GL.TEXTURE_BORDER: return [[info?.border || 0], "i"];
        case GL.TEXTURE_COMPRESSED: return [[+compressed], "b"];
        case GL.TEXTURE_COMPRESSED_IMAGE_SIZE: {
            if (!compressed || proxy) return GL.INVALID_OPERATION;
            const block = formats.COMPRESSED_FORMATS[info.internalFormat]?.blockBytes || 0;
            return [[info.compressedSize ?? Math.ceil(info.width / 4) * Math.ceil(info.height / 4) * info.depth * block], "i"];
        }
        default: {
            if (pname >= 0x8C10 && pname <= 0x8C16) {
                const channel = pname - 0x8C10;
                const bits = info && !info.unsupported && formats.textureComponents(info.internalFormat, compressed, s.capabilities?.features)[channel];
                const storage = info && formats.storageFormatFor(info.internalFormat, s.capabilities?.features);
                return [[!bits ? GL.NONE : storage.float || storage.gpu === "depth32float" ? GL.FLOAT : 0x8C17], "e"];
            }
            const index = [GL.TEXTURE_RED_SIZE, GL.TEXTURE_GREEN_SIZE, GL.TEXTURE_BLUE_SIZE, GL.TEXTURE_ALPHA_SIZE,
                GL.TEXTURE_LUMINANCE_SIZE, GL.TEXTURE_INTENSITY_SIZE, GL.TEXTURE_DEPTH_SIZE, GL.TEXTURE_STENCIL_SIZE_EXT, 0x80ED].indexOf(pname);
            if (index < 0) return GL.INVALID_ENUM;
            return [[info && !info.unsupported ? formats.textureComponents(info.internalFormat, compressed, s.capabilities?.features)[index] : 0], "i"];
        }
        }
    });
    state.attributes("textureParameters", {
        capture(c, mask, client) {
            if (client || !(mask & 0x40000)) return null;
            const saved = new Map();
            for (const unit of c.unitImages) for (const target of parameters.targets) {
                const id = unit.get(target) || c.defaultTextures.get(target) || 0, key = id || "default:" + target;
                const image = c.group.textureImages.get(id);
                saved.set(key, { id, target, values: image ? ensure(image) : parameters.initial() });
            }
            return [...saved.values()].map(item => ({ ...item, values: copy(item.values) }));
        },
        restore(c, saved) {
            for (const item of saved) {
                const image = c.group.textureImages.get(item.id || c.defaultTextures.get(item.target));
                if (image) image.parameters = copy(item.values);
            }
        },
    });
    GLShadow.part({
        command(s, fn, bytes, view, offset, size) {
            const name = P.NAME_BY_OPCODE[fn]; if (!setters.has(name)) return;
            const a = s.args(name, view, offset, size), r = command(name, a);
            if (!r.error) ensure(s.boundImage(a[0]).texture)[a[1]] = r.values;
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
