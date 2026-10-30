// Public GL names are bindings; retained image identities survive name reuse.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const buffers = global.GLFramebufferState || require("./gl_framebuffer_state.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    const formats = global.GLImageFormats || require("./gl_image_formats.js");
    const targets = new Set([GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D, GL.TEXTURE_CUBE_MAP]);
    for (const [pname, target] of [[GL.TEXTURE_BINDING_1D, GL.TEXTURE_1D], [GL.TEXTURE_BINDING_2D, GL.TEXTURE_2D],
            [GL.TEXTURE_BINDING_3D, GL.TEXTURE_3D], [GL.TEXTURE_BINDING_CUBE_MAP, GL.TEXTURE_CUBE_MAP]])
        state.query([pname], s => [[s.current.units[s.current.activeTexture].get(target) || 0], "u"]);
    for (const [pname, field] of [[GL.RENDERBUFFER_BINDING, "renderbuffer"], [GL.FRAMEBUFFER_BINDING, "drawFramebuffer"],
            [GL.READ_FRAMEBUFFER_BINDING_EXT, "readFramebuffer"]])
        state.query([pname], s => [[s.current[field]], "u"]);
    state.rule("BIND_TEXTURE", (c, [target, name]) => {
        if (!targets.has(target)) return GL.INVALID_ENUM;
        const t = c.group.textures.get(name);
        return t?.target && t.target !== target ? GL.INVALID_OPERATION : 0;
    });
    state.rule("BIND_RENDERBUFFER", (c, [target]) => target === GL.RENDERBUFFER_EXT ? 0 : GL.INVALID_ENUM);
    state.rule("RENDERBUFFER_STORAGE", (c, [target, format, width, height], s) => {
        if (target !== GL.RENDERBUFFER_EXT || !formats.renderbufferFormatFor(format, s.capabilities?.features)) return GL.INVALID_ENUM;
        if (!c.renderbufferImage) return GL.INVALID_OPERATION;
        const max = s.capabilities ? caps.integer(s.capabilities, GL.MAX_RENDERBUFFER_SIZE) : 16384;
        return width < 0 || height < 0 || width > max || height > max ? GL.INVALID_VALUE : 0;
    });
    state.rule("BIND_FRAMEBUFFER", (c, [target]) =>
        [GL.FRAMEBUFFER_EXT, GL.READ_FRAMEBUFFER, GL.DRAW_FRAMEBUFFER].includes(target) ? 0 : GL.INVALID_ENUM);
    const limit = (s, pname) => s.capabilities ? caps.integer(s.capabilities, pname) : caps.LIMITS.MAX_DRAW_BUFFERS;
    state.query([0x0C01], s => [[s.current.drawBuffers[0] || GL.NONE], "e"]);
    state.query([0x0C02], s => [[s.current.readBuffer], "e"]);
    for (let i = 0; i < 16; ++i) state.query([GL.DRAW_BUFFER0 + i], s =>
        i < limit(s, GL.MAX_DRAW_BUFFERS) ? [[s.current.drawBuffers[i] || GL.NONE], "e"] : GL.INVALID_ENUM);
    function selection(c, value, read, many, s) {
        if (value === GL.NONE) return 0;
        const window = value >= 0x400 && value <= 0x40C && (!read || value !== 0x408);
        const color = value >= GL.COLOR_ATTACHMENT0 && value < GL.COLOR_ATTACHMENT0 + 32;
        if (!window && !color) return GL.INVALID_ENUM;
        if (many && value >= GL.FRONT && value <= GL.FRONT_AND_BACK) return GL.INVALID_OPERATION;
        if (read ? c.readFramebuffer : c.drawFramebuffer)
            return color && value < GL.COLOR_ATTACHMENT0 + limit(s, GL.MAX_COLOR_ATTACHMENTS) ? 0 : GL.INVALID_OPERATION;
        if (color || [0x401, 0x403, 0x407].includes(value) || value >= 0x409) return GL.INVALID_OPERATION;
        if (c.state.format & P.C.V86GL_FORMAT_SINGLE_BUFFER && [GL.BACK, 0x402].includes(value)) return GL.INVALID_OPERATION;
        return 0;
    }
    state.rule("DRAW_BUFFER", (c, [value], s) => selection(c, value, false, false, s));
    state.rule("READ_BUFFER", (c, [value], s) => selection(c, value, true, false, s));
    GLShadow.rules({ [P.GLFN.DRAW_BUFFERS]: (s, bytes, v, o, size) => {
        if (s.current.state.begin) return GL.INVALID_OPERATION;
        const count = v.getInt32(o, true);
        if (count < 0 || count > limit(s, GL.MAX_DRAW_BUFFERS) || 4 + count * 4 > size) return GL.INVALID_VALUE;
        const seen = new Set();
        for (let i = 0; i < count; ++i) {
            const value = v.getUint32(o + 4 + i * 4, true), error = selection(s.current, value, false, true, s);
            if (error) return error;
            if (value !== GL.NONE && seen.has(value)) return GL.INVALID_OPERATION;
            seen.add(value);
        }
        return 0;
    } });
    for (const name of ["GEN_TEXTURES", "DELETE_TEXTURES", "GEN_RENDERBUFFERS", "DELETE_RENDERBUFFERS", "GEN_FRAMEBUFFERS", "DELETE_FRAMEBUFFERS"])
        GLShadow.rules({ [P.GLFN[name]]: (s, bytes, v, o, size) => {
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            const count = v.getInt32(o, true);
            return count < 0 || P.RECORDS[name].size + count * 4 > size ? GL.INVALID_VALUE : 0;
        } });
    state.parameter(P.C.V86GL_PARAMETER_IS_OBJECT, (s, kind, name) => {
        const c = s.current, g = c.group;
        let result;
        switch (kind) {
        case P.C.V86GL_OBJECT_KIND_SHADER: result = g.shaders?.has(name); break;
        case P.C.V86GL_OBJECT_KIND_PROGRAM: result = g.programs?.has(name); break;
        case P.C.V86GL_OBJECT_KIND_TEXTURE: result = !!g.textures.get(name)?.target; break;
        case P.C.V86GL_OBJECT_KIND_RENDERBUFFER: result = g.renderbuffers.get(name)?.created; break;
        case P.C.V86GL_OBJECT_KIND_FRAMEBUFFER: result = c.framebuffers.get(name)?.created; break;
        case P.C.V86GL_OBJECT_KIND_BUFFER: result = g.buffers?.get(name)?.created; break;
        case P.C.V86GL_OBJECT_KIND_QUERY: result = c.queryObjects?.get(name)?.created; break;
        default: return GL.INVALID_ENUM;
        }
        return [[+(!!name && !!result)], "b"];
    });
    state.parameter(P.C.V86GL_PARAMETER_FRAMEBUFFER_ATTACHMENT, (s, target, pname, attachment) => {
        if (![GL.FRAMEBUFFER_EXT, GL.READ_FRAMEBUFFER, GL.DRAW_FRAMEBUFFER].includes(target)) return GL.INVALID_ENUM;
        const fbo = s.boundFramebuffer(target); if (!fbo) return GL.INVALID_OPERATION;
        let record;
        if (attachment === GL.DEPTH_ATTACHMENT) record = fbo.depth;
        else if (attachment === GL.STENCIL_ATTACHMENT) record = fbo.stencil;
        else if (attachment >= GL.COLOR_ATTACHMENT0 && attachment < GL.COLOR_ATTACHMENT0 + limit(s, GL.MAX_COLOR_ATTACHMENTS))
            record = fbo.color[attachment - GL.COLOR_ATTACHMENT0];
        else return GL.INVALID_ENUM;
        if (pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE_EXT)
            return [[record ? record.kind === "texture" ? GL.TEXTURE : GL.RENDERBUFFER_EXT : GL.NONE], "e"];
        if (pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME_EXT) return [[record?.name || 0], "u"];
        if (!record || record.kind !== "texture") return GL.INVALID_ENUM;
        const texture = s.current.group.textureImages.get(record.id);
        switch (pname) {
        case GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL_EXT: return [[record.level], "i"];
        case GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE_EXT:
            return [[texture?.target === GL.TEXTURE_CUBE_MAP ? GL.TEXTURE_CUBE_MAP_POSITIVE_X + record.layer : 0], "e"];
        case GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_3D_ZOFFSET_EXT:
            return [[texture?.target === GL.TEXTURE_3D ? record.layer : 0], "i"];
        default: return GL.INVALID_ENUM;
        }
    });
    state.parameter(P.C.V86GL_PARAMETER_RENDERBUFFER, (s, target, pname) => {
        if (target !== GL.RENDERBUFFER_EXT) return GL.INVALID_ENUM;
        const rb = s.current.group.renderbufferImages.get(s.current.renderbufferImage);
        if (!rb) return GL.INVALID_OPERATION;
        if (pname === GL.RENDERBUFFER_WIDTH_EXT) return [[rb.width], "i"];
        if (pname === GL.RENDERBUFFER_HEIGHT_EXT) return [[rb.height], "i"];
        if (pname === GL.RENDERBUFFER_INTERNAL_FORMAT_EXT) return [[rb.internalFormat], "e"];
        if (pname === 0x8CAB) return [[0], "i"]; // RENDERBUFFER_SAMPLES
        const index = [GL.RENDERBUFFER_RED_SIZE_EXT, GL.RENDERBUFFER_GREEN_SIZE_EXT, GL.RENDERBUFFER_BLUE_SIZE_EXT,
            GL.RENDERBUFFER_ALPHA_SIZE_EXT, GL.RENDERBUFFER_DEPTH_SIZE_EXT, GL.RENDERBUFFER_STENCIL_SIZE_EXT].indexOf(pname);
        if (index < 0) return GL.INVALID_ENUM;
        const bits = rb.componentBits || (rb.width && rb.height ? formats.renderbufferFormatFor(rb.internalFormat)?.components : null);
        return [[bits?.[index] || 0], "i"];
    });
    state.attributes("images", {
        capture(c, mask, client) {
            return !client && mask & 0x40000 ? { activeTexture: c.activeTexture,
                units: c.units.map(u => [...u]), unitImages: c.unitImages.map(u => [...u]) } : null;
        },
        restore(c, saved) {
            c.activeTexture = saved.activeTexture;
            c.units = saved.units.map(u => new Map(u)); c.unitImages = saved.unitImages.map(u => new Map(u));
        },
    });
    state.attributes("framebufferSelection", {
        capture(c, mask, client) {
            return client ? null : { ...(mask & 0x4000 ? { draw: c.drawBuffers.slice() } : {}),
                ...(mask & 0x20 ? { read: c.readBuffer } : {}) };
        },
        restore(c, saved) {
            if (saved.draw) buffers.draw(c, c.framebuffers, saved.draw);
            if (saved.read !== undefined) buffers.read(c, c.framebuffers, saved.read);
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
