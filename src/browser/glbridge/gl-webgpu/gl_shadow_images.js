// Public GL names are bindings; retained image identities survive name reuse.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
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
    state.rule("BIND_FRAMEBUFFER", (c, [target]) =>
        [GL.FRAMEBUFFER_EXT, GL.READ_FRAMEBUFFER, GL.DRAW_FRAMEBUFFER].includes(target) ? 0 : GL.INVALID_ENUM);
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
        default: return GL.INVALID_ENUM;
        }
        return [[+(!!name && !!result)], "b"];
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
})(typeof globalThis !== "undefined" ? globalThis : this);
