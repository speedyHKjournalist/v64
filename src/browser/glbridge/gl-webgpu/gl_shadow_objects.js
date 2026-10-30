// The GL shadow's textures, renderbuffers and framebuffer objects
// (docs/opengl-webgpu-plan.md C3): their names, what each texture level and
// renderbuffer holds (size and internal format), what each framebuffer
// object has attached, and the bindings -- so glCheckFramebufferStatus is
// answered on the CPU side, by EXT_framebuffer_object's rules.
//
// Textures and renderbuffers belong to the share group; framebuffer objects,
// the draw and read buffers to the context (as the executor keeps them).

(function(global) {
    "use strict";

    const protocol = global.GLProtocol || require("./gl_protocol.js");
    const constants = global.GLWGConstants || require("./gl_constants.js");
    const glCaps = global.GLCaps || require("./gl_caps.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const { GLFN, C, F, RECORDS } = protocol;
    const GL = constants.GL;

    const OK = C.V86GL_SYNC_QUERY_STATUS_OK;
    const PENDING = C.V86GL_SYNC_QUERY_STATUS_PENDING;
    const MAX_TEXTURE_UNITS = glCaps.LIMITS.MAX_TEXTURE_UNITS;
    const MAX_COLOR_ATTACHMENTS = glCaps.LIMITS.MAX_DRAW_BUFFERS;

    const DEPTH_FORMATS = new Set([GL.DEPTH_COMPONENT, GL.DEPTH_COMPONENT16, GL.DEPTH_COMPONENT24,
        GL.DEPTH_COMPONENT32, GL.DEPTH_COMPONENT32F, GL.DEPTH_STENCIL, GL.DEPTH24_STENCIL8, 0x8CAD]);
    const STENCIL_FORMATS = new Set([GL.STENCIL_INDEX, GL.STENCIL_INDEX1_EXT, GL.STENCIL_INDEX4_EXT,
        GL.STENCIL_INDEX8_EXT, GL.STENCIL_INDEX16_EXT, GL.DEPTH_STENCIL, GL.DEPTH24_STENCIL8, 0x8CAD]);

    // A texture image target: the binding it is made through, and its layer
    // (a cube map's face)
    function imageTarget(target) {
        const face = target - GL.TEXTURE_CUBE_MAP_POSITIVE_X;
        if (face >= 0 && face < 6) return { binding: GL.TEXTURE_CUBE_MAP, layer: face };
        return { binding: target, layer: 0 };
    }

    const proto = GLShadow.prototype;

    proto.textureObject = function(name) {
        const group = this.current.group;
        let texture = group.textures.get(name);
        if (!texture) {
            texture = { name, id: group.nextImageId++, target: 0, levels: new Map(), deleted: false };
            group.textures.set(name, texture);
            group.textureImages.set(texture.id, texture);
        }
        return texture;
    };

    proto.defaultTexture = function(target) {
        const c = this.current, group = c.group;
        let id = c.defaultTextures.get(target);
        if (!id) {
            const texture = { name: 0, id: group.nextImageId++, target, levels: new Map(), deleted: false };
            id = texture.id; group.textureImages.set(id, texture); c.defaultTextures.set(target, id);
        }
        return group.textureImages.get(id);
    };

    proto.genTextures = function(bytes, view, offset, size) {
        for (const name of this.names("GEN_TEXTURES", view, offset, size) || []) if (name) this.textureObject(name);
    };

    // A deleted texture is unbound from every unit of this context and
    // detached from the framebuffer objects bound here
    proto.deleteTextures = function(bytes, view, offset, size) {
        const c = this.current;
        for (const name of this.names("DELETE_TEXTURES", view, offset, size) || []) {
            const texture = c.group.textures.get(name);
            if (!name || !texture) continue;
            c.group.textures.delete(name); texture.deleted = true;
            c.units.forEach((unit, i) => {
                for (const [target] of unit) if (c.unitImages[i].get(target) === texture.id) {
                    unit.set(target, 0); c.unitImages[i].delete(target);
                }
            });
            this.detach("texture", texture.id);
        }
    };

    proto.bindTexture = function(bytes, view, offset, size) {
        const a = this.args("BIND_TEXTURE", view, offset, size);
        if (!a) return;
        const c = this.current;
        c.units[c.activeTexture].set(a[0], a[1]);
        c.unitImages[c.activeTexture].set(a[0], a[1] ? this.textureObject(a[1]).id : this.defaultTexture(a[0]).id);
        if (a[1]) {
            const texture = this.textureObject(a[1]);
            if (!texture.target) texture.target = a[0];
        }
    };

    proto.activeTexture = function(bytes, view, offset, size) {
        const a = this.args("ACTIVE_TEXTURE", view, offset, size);
        const unit = a ? a[0] - GL.TEXTURE0 : -1;
        if (unit >= 0 && unit < MAX_TEXTURE_UNITS) this.current.activeTexture = unit;
    };

    // The texture bound for an image target on the active unit, and the layer
    proto.boundImage = function(target) {
        const { binding, layer } = imageTarget(target);
        const c = this.current;
        const id = c.unitImages[c.activeTexture].get(binding);
        return { texture: id ? c.group.textureImages.get(id) : this.defaultTexture(binding), layer };
    };

    proto.defineLevel = function(target, level, width, height, depth, internalFormat) {
        const image = this.boundImage(target);
        if (!image || level < 0) return;
        let layer = image.texture.levels.get(image.layer);
        if (!layer) image.texture.levels.set(image.layer, layer = new Map());
        if (width > 0 && height > 0 && depth > 0) layer.set(level, { width, height, depth, internalFormat });
        else layer.delete(level);
    };

    proto.texImage = function(dimensions) {
        const name = "TEX_IMAGE_" + dimensions + "D";
        return function(bytes, view, offset, size) {
            if (size < RECORDS[name].size) return;
            const r = protocol.decodeRecord(name, view, offset);
            this.defineLevel(r.target, r.level, r.width, dimensions >= 2 ? r.height : 1, dimensions >= 3 ? r.depth : 1,
                r.internalformat >>> 0);
        };
    };
    proto.texImage1D = proto.texImage(1);
    proto.texImage2D = proto.texImage(2);
    proto.texImage3D = proto.texImage(3);

    proto.compressedTexImage = function(dimensions) {
        const name = "COMPRESSED_TEX_IMAGE_" + dimensions + "D";
        return function(bytes, view, offset, size) {
            if (size < RECORDS[name].size) return;
            const r = protocol.decodeRecord(name, view, offset);
            this.defineLevel(r.target, r.level, r.width, dimensions >= 2 ? r.height : 1, dimensions >= 3 ? r.depth : 1,
                r.internalformat);
        };
    };
    proto.compressedTexImage1D = proto.compressedTexImage(1);
    proto.compressedTexImage2D = proto.compressedTexImage(2);
    proto.compressedTexImage3D = proto.compressedTexImage(3);

    // glCopyTexImage1D (target, level, internalformat, x, y, width, border)
    proto.copyTexImage1D = function(bytes, view, offset, size) {
        const a = this.args("COPY_TEX_IMAGE_1D", view, offset, size);
        if (a) this.defineLevel(a[0], a[1], a[5], 1, 1, a[2]);
    };

    // glCopyTexImage2D (target, level, internalformat, x, y, width, height, border)
    proto.copyTexImage2D = function(bytes, view, offset, size) {
        const a = this.args("COPY_TEX_IMAGE_2D", view, offset, size);
        if (a) this.defineLevel(a[0], a[1], a[5], a[6], 1, a[2]);
    };

    // Every level below the base, halving to 1, in the base level's format
    proto.generateMipmap = function(bytes, view, offset, size) {
        const a = this.args("GENERATE_MIPMAP", view, offset, size);
        const texture = a && this.boundImage(a[0]).texture;
        if (!texture) return;
        for (const layer of texture.levels.values()) {
            const base = layer.get(0);
            if (!base) continue;
            let { width, height, depth } = base;
            for (let level = 1; width > 1 || height > 1 || depth > 1; ++level) {
                width = Math.max(1, width >> 1);
                height = Math.max(1, height >> 1);
                depth = Math.max(1, depth >> 1);
                layer.set(level, { width, height, depth, internalFormat: base.internalFormat });
            }
        }
    };

    proto.genRenderbuffers = function(bytes, view, offset, size) {
        for (const name of this.names("GEN_RENDERBUFFERS", view, offset, size) || [])
            if (name) this.renderbufferObject(name);
    };

    proto.renderbufferObject = function(name) {
        const group = this.current.group;
        let rb = group.renderbuffers.get(name);
        if (!rb) {
            rb = { name, id: group.nextImageId++, width: 0, height: 0, internalFormat: 0, deleted: false, created: false };
            group.renderbuffers.set(name, rb); group.renderbufferImages.set(rb.id, rb);
        }
        return rb;
    };

    proto.deleteRenderbuffers = function(bytes, view, offset, size) {
        const c = this.current;
        for (const name of this.names("DELETE_RENDERBUFFERS", view, offset, size) || []) {
            const rb = c.group.renderbuffers.get(name);
            if (!name || !rb) continue;
            c.group.renderbuffers.delete(name); rb.deleted = true;
            if (c.renderbufferImage === rb.id) c.renderbuffer = c.renderbufferImage = 0;
            this.detach("renderbuffer", rb.id);
        }
    };

    proto.bindRenderbuffer = function(bytes, view, offset, size) {
        const a = this.args("BIND_RENDERBUFFER", view, offset, size);
        if (!a) return;
        this.current.renderbufferImage = a[1] ? this.renderbufferObject(a[1]).id : 0;
        if (a[1]) this.renderbufferObject(a[1]).created = true;
        this.current.renderbuffer = a[1];
    };

    // glRenderbufferStorage (target, internalformat, width, height)
    proto.renderbufferStorage = function(bytes, view, offset, size) {
        const a = this.args("RENDERBUFFER_STORAGE", view, offset, size);
        const rb = a && this.current.group.renderbufferImages.get(this.current.renderbufferImage);
        if (!rb) return;
        rb.internalFormat = a[1];
        rb.width = Math.max(0, a[2]);
        rb.height = Math.max(0, a[3]);
    };

    proto.framebufferObject = function(name) {
        const c = this.current;
        let fbo = c.framebuffers.get(name);
        if (!fbo) c.framebuffers.set(name, fbo = { name, created: false, color: new Array(MAX_COLOR_ATTACHMENTS).fill(null),
            depth: null, stencil: null });
        return fbo;
    };

    proto.genFramebuffers = function(bytes, view, offset, size) {
        for (const name of this.names("GEN_FRAMEBUFFERS", view, offset, size) || []) if (name) this.framebufferObject(name);
    };

    proto.deleteFramebuffers = function(bytes, view, offset, size) {
        const c = this.current;
        for (const name of this.names("DELETE_FRAMEBUFFERS", view, offset, size) || []) {
            if (!name) continue;
            c.framebuffers.delete(name);
            if (c.drawFramebuffer === name) c.drawFramebuffer = 0;
            if (c.readFramebuffer === name) c.readFramebuffer = 0;
        }
    };

    proto.bindFramebuffer = function(bytes, view, offset, size) {
        const a = this.args("BIND_FRAMEBUFFER", view, offset, size);
        if (!a) return;
        const c = this.current;
        if (a[1]) this.framebufferObject(a[1]).created = true;
        if (a[0] !== GL.READ_FRAMEBUFFER) c.drawFramebuffer = a[1];
        if (a[0] !== GL.DRAW_FRAMEBUFFER) c.readFramebuffer = a[1];
    };

    proto.boundFramebuffer = function(target) {
        const c = this.current;
        const name = target === GL.READ_FRAMEBUFFER ? c.readFramebuffer : c.drawFramebuffer;
        return name ? c.framebuffers.get(name) || null : null;
    };

    proto.attach = function(target, attachment, record) {
        const fbo = this.boundFramebuffer(target);
        if (!fbo) return;
        if (attachment === GL.DEPTH_ATTACHMENT) fbo.depth = record;
        else if (attachment === GL.STENCIL_ATTACHMENT) fbo.stencil = record;
        else if (attachment === GL.DEPTH_STENCIL_ATTACHMENT) fbo.depth = fbo.stencil = record;
        else {
            const index = attachment - GL.COLOR_ATTACHMENT0;
            if (index >= 0 && index < MAX_COLOR_ATTACHMENTS) fbo.color[index] = record;
        }
    };

    // An object deleted while attached to a framebuffer object bound here
    proto.detach = function(kind, id) {
        const c = this.current;
        for (const fboName of new Set([c.drawFramebuffer, c.readFramebuffer])) {
            const fbo = fboName && c.framebuffers.get(fboName);
            if (!fbo) continue;
            const stale = record => record && record.kind === kind && record.id === id;
            fbo.color = fbo.color.map(record => stale(record) ? null : record);
            if (stale(fbo.depth)) fbo.depth = null;
            if (stale(fbo.stencil)) fbo.stencil = null;
        }
    };

    // glFramebufferTexture* (target, attachment, textarget, texture, level, zoffset)
    proto.framebufferTexture = function(bytes, view, offset, size) {
        const a = this.args("FRAMEBUFFER_TEXTURE", view, offset, size);
        if (!a) return;
        const face = a[2] - GL.TEXTURE_CUBE_MAP_POSITIVE_X;
        this.attach(a[0], a[1], a[3] ? { kind: "texture", name: a[3], level: a[4],
            id: this.current.group.textures.get(a[3])?.id,
            layer: face >= 0 && face < 6 ? face : a[5] } : null);
    };

    // glFramebufferRenderbuffer (target, attachment, renderbuffertarget, renderbuffer)
    proto.framebufferRenderbuffer = function(bytes, view, offset, size) {
        const a = this.args("FRAMEBUFFER_RENDERBUFFER", view, offset, size);
        if (a) this.attach(a[0], a[1], a[3] ? { kind: "renderbuffer", name: a[3], level: 0, layer: 0,
            id: this.current.group.renderbuffers.get(a[3])?.id } : null);
    };

    proto.drawBuffer = function(bytes, view, offset, size) {
        const a = this.args("DRAW_BUFFER", view, offset, size);
        if (a) this.current.drawBuffers = [a[0]];
    };

    proto.drawBuffers = function(bytes, view, offset, size) {
        const buffers = this.names("DRAW_BUFFERS", view, offset, size);
        if (buffers) this.current.drawBuffers = buffers.length ? buffers : [GL.NONE];
    };

    proto.readBuffer = function(bytes, view, offset, size) {
        const a = this.args("READ_BUFFER", view, offset, size);
        if (a) this.current.readBuffer = a[0];
    };

    // What an attachment holds: {width, height, internalFormat}, or null
    proto.attachedImage = function(record) {
        const group = this.current.group;
        if (record.kind === "renderbuffer") {
            const rb = group.renderbufferImages.get(record.id);
            return rb && rb.width && rb.height ? rb : null;
        }
        const texture = group.textureImages.get(record.id);
        const layer = texture && texture.levels.get(texture.target === GL.TEXTURE_3D ? 0 : record.layer);
        const level = layer && layer.get(record.level);
        if (!level) return null;
        // a 3D texture's attached layer must be one it has
        return texture.target === GL.TEXTURE_3D && record.layer >= level.depth ? null : level;
    };

    // EXT_framebuffer_object's completeness. Two depth and stencil images
    // that are not the same one are UNSUPPORTED: WebGPU has one
    // depth-stencil attachment.
    proto.framebufferStatus = function(target) {
        const c = this.current;
        const name = target === GL.READ_FRAMEBUFFER ? c.readFramebuffer : c.drawFramebuffer;
        if (!name) return GL.FRAMEBUFFER_COMPLETE;
        const fbo = c.framebuffers.get(name);
        if (!fbo) return GL.FRAMEBUFFER_UNDEFINED;
        let width = 0, height = 0, any = false, dimensions = true;
        const complete = (record, accept) => {
            if (!record) return true;
            const image = this.attachedImage(record);
            if (!image || !accept(image.internalFormat >>> 0)) return false;
            if (!any) {
                width = image.width;
                height = image.height;
                any = true;
            } else if (image.width !== width || image.height !== height) {
                dimensions = false;
            }
            return true;
        };
        for (const record of fbo.color)
            if (!complete(record, format => !DEPTH_FORMATS.has(format) && !STENCIL_FORMATS.has(format)))
                return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        if (!complete(fbo.depth, format => DEPTH_FORMATS.has(format)))
            return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        if (!complete(fbo.stencil, format => STENCIL_FORMATS.has(format)))
            return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        if (!any) return GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
        if (!dimensions) return GL.FRAMEBUFFER_INCOMPLETE_DIMENSIONS_EXT;
        const same = (x, y) => x.kind === y.kind && x.id === y.id && x.level === y.level && x.layer === y.layer;
        if (fbo.depth && fbo.stencil && !same(fbo.depth, fbo.stencil)) return GL.FRAMEBUFFER_UNSUPPORTED_EXT;
        // a buffer that is not an attachment (BACK on an FBO) means the first
        const index = buffer => buffer >= GL.COLOR_ATTACHMENT0 ? buffer - GL.COLOR_ATTACHMENT0 : 0;
        if (target !== GL.READ_FRAMEBUFFER)
            for (const buffer of c.drawBuffers)
                if (buffer !== GL.NONE && !fbo.color[index(buffer)]) return GL.FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER_EXT;
        if (target !== GL.DRAW_FRAMEBUFFER && c.readBuffer !== GL.NONE && !fbo.color[index(c.readBuffer)])
            return GL.FRAMEBUFFER_INCOMPLETE_READ_BUFFER_EXT;
        return GL.FRAMEBUFFER_COMPLETE;
    };

    // {target, status, result, reserved}
    proto.checkFramebufferStatus = function(bytes, view, offset, size) {
        const R = F.CHECK_FRAMEBUFFER_STATUS;
        if (size < RECORDS.CHECK_FRAMEBUFFER_STATUS.size || view.getUint32(offset + R.status, true) !== PENDING) return;
        view.setUint32(offset + R.result, this.framebufferStatus(view.getUint32(offset + R.target, true)), true);
        view.setUint32(offset + R.status, OK, true);
        ++this.stats.answered;
    };

    GLShadow.install({
        [GLFN.GEN_TEXTURES]: "genTextures",
        [GLFN.DELETE_TEXTURES]: "deleteTextures",
        [GLFN.BIND_TEXTURE]: "bindTexture",
        [GLFN.ACTIVE_TEXTURE]: "activeTexture",
        [GLFN.TEX_IMAGE_1D]: "texImage1D",
        [GLFN.TEX_IMAGE_2D]: "texImage2D",
        [GLFN.TEX_IMAGE_3D]: "texImage3D",
        [GLFN.COMPRESSED_TEX_IMAGE_1D]: "compressedTexImage1D",
        [GLFN.COMPRESSED_TEX_IMAGE_2D]: "compressedTexImage2D",
        [GLFN.COMPRESSED_TEX_IMAGE_3D]: "compressedTexImage3D",
        [GLFN.COPY_TEX_IMAGE_1D]: "copyTexImage1D",
        [GLFN.COPY_TEX_IMAGE_2D]: "copyTexImage2D",
        [GLFN.GENERATE_MIPMAP]: "generateMipmap",
        [GLFN.GEN_RENDERBUFFERS]: "genRenderbuffers",
        [GLFN.DELETE_RENDERBUFFERS]: "deleteRenderbuffers",
        [GLFN.BIND_RENDERBUFFER]: "bindRenderbuffer",
        [GLFN.RENDERBUFFER_STORAGE]: "renderbufferStorage",
        [GLFN.GEN_FRAMEBUFFERS]: "genFramebuffers",
        [GLFN.DELETE_FRAMEBUFFERS]: "deleteFramebuffers",
        [GLFN.BIND_FRAMEBUFFER]: "bindFramebuffer",
        [GLFN.FRAMEBUFFER_TEXTURE]: "framebufferTexture",
        [GLFN.FRAMEBUFFER_RENDERBUFFER]: "framebufferRenderbuffer",
        [GLFN.DRAW_BUFFER]: "drawBuffer",
        [GLFN.DRAW_BUFFERS]: "drawBuffers",
        [GLFN.READ_BUFFER]: "readBuffer",
        [GLFN.CHECK_FRAMEBUFFER_STATUS]: "checkFramebufferStatus",
    });

    const levelsOut = texture => [...texture.levels].map(([layer, levels]) => [layer, [...levels]]);
    const levelsIn = saved => new Map(saved.map(([layer, levels]) => [layer, new Map(levels)]));

    function collectImages(shadow) {
        for (const group of shadow.groups.values()) {
            const live = new Set();
            const units = list => { for (const unit of list) for (const id of unit.values()) live.add(id); };
            for (const c of shadow.contexts.values()) if (c.group === group) {
                units(c.unitImages); for (const id of c.defaultTextures.values()) live.add(id);
                live.add(c.renderbufferImage);
                for (const fbo of c.framebuffers.values()) for (const r of [...fbo.color, fbo.depth, fbo.stencil]) if (r) live.add(r.id);
                for (const a of c.state?.attrib || []) {
                    const images = a.parts?.images;
                    if (images) units(images.unitImages.map(u => new Map(u)));
                }
            }
            for (const pool of [group.textureImages, group.renderbufferImages])
                for (const [id, image] of pool) if ((image.deleted || !image.name) && !live.has(id)) pool.delete(id);
        }
    }

    GLShadow.part({
        afterBatch: collectImages,
        group(group) {
            group.textures = new Map();
            group.renderbuffers = new Map();
            group.textureImages = new Map();
            group.renderbufferImages = new Map();
            group.nextImageId = 1;
        },
        context(context) {
            context.activeTexture = 0;
            context.units = Array.from({ length: MAX_TEXTURE_UNITS }, () => new Map());
            context.unitImages = Array.from({ length: MAX_TEXTURE_UNITS }, () => new Map());
            context.defaultTextures = new Map();
            context.framebuffers = new Map();
            context.drawFramebuffer = 0;
            context.readFramebuffer = 0;
            context.renderbuffer = 0;
            context.renderbufferImage = 0;
            context.drawBuffers = [GL.BACK];
            context.readBuffer = GL.BACK;
        },
        getState(shadow, state) {
            state.objects = {
                version: 2,
                groups: [...shadow.groups.values()].map(group => ({ key: group.key,
                    nextImageId: group.nextImageId,
                    textures: [...group.textureImages.values()].map(t => [t.name, t.target, levelsOut(t), t.id, t.deleted]),
                    renderbuffers: [...group.renderbufferImages.values()] })),
                contexts: [...shadow.contexts.values()].map(c => ({ key: c.key, activeTexture: c.activeTexture,
                    units: c.units.map(unit => [...unit]), framebuffers: [...c.framebuffers.values()],
                    unitImages: c.unitImages.map(unit => [...unit]), defaultTextures: [...c.defaultTextures],
                    renderbufferImage: c.renderbufferImage,
                    drawFramebuffer: c.drawFramebuffer, readFramebuffer: c.readFramebuffer, renderbuffer: c.renderbuffer,
                    drawBuffers: c.drawBuffers, readBuffer: c.readBuffer })),
            };
        },
        setState(shadow, state) {
            const saved = state.objects;
            if (!saved) return;
            for (const g of saved.groups) {
                const group = shadow.groups.get(g.key);
                if (!group) continue;
                group.nextImageId = g.nextImageId || 1;
                for (const [name, target, levels, savedId, deleted] of g.textures) {
                    const t = { name, target, levels: levelsIn(levels), id: savedId || group.nextImageId++, deleted: !!deleted };
                    group.textureImages.set(t.id, t); if (name && !deleted) group.textures.set(name, t);
                }
                for (const savedRb of g.renderbuffers) {
                    const rb = { ...savedRb, id: savedRb.id || group.nextImageId++ };
                    group.renderbufferImages.set(rb.id, rb); if (!rb.deleted) group.renderbuffers.set(rb.name, rb);
                }
            }
            for (const c of saved.contexts) {
                const context = shadow.contexts.get(c.key);
                if (!context) continue;
                Object.assign(context, { activeTexture: c.activeTexture, units: c.units.map(unit => new Map(unit)),
                    unitImages: c.unitImages ? c.unitImages.map(unit => new Map(unit)) : c.units.map(unit =>
                        new Map(unit.map(([target, name]) => [target, context.group.textures.get(name)?.id]))),
                    defaultTextures: new Map(c.defaultTextures || []),
                    renderbufferImage: c.renderbufferImage || context.group.renderbuffers.get(c.renderbuffer)?.id || 0,
                    framebuffers: new Map(c.framebuffers.map(fbo => [fbo.name, fbo])), drawFramebuffer: c.drawFramebuffer,
                    readFramebuffer: c.readFramebuffer, renderbuffer: c.renderbuffer, drawBuffers: c.drawBuffers,
                    readBuffer: c.readBuffer });
                if (!saved.version) for (const fbo of context.framebuffers.values())
                    for (const r of [...fbo.color, fbo.depth, fbo.stencil]) if (r)
                        r.id = (r.kind === "texture" ? context.group.textures : context.group.renderbuffers).get(r.name)?.id;
            }
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
