(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const parameters = global.GLTextureParameters || require("./gl_texture_parameters.js");
    const setters = new Set(["TEX_PARAMETERI", "TEX_PARAMETERF", "TEX_PARAMETERIV", "TEX_PARAMETERFV"]);
    const ensure = image => image.parameters || (image.parameters = parameters.initial());
    const copy = values => Object.fromEntries(Object.entries(values).map(([p, v]) => [p, v.slice()]));
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
