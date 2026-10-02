// One virgl context: its command stream (VIRGL_CCMD_*, third_party/virgl/
// virgl_protocol.h) decoded command by command, and gallium's state turned
// into the SVGA DX commands GX runs, as Mesa's svga driver would send them:
//
// - each sub-context (one per GL context of the guest) is a GX context;
// - objects become DX objects with their handle as id (blend, depth-stencil,
//   samplers, element layouts, shader resource views, render target and
//   depth-stencil views, queries); rasterizer states and shaders have
//   variants, made when a draw needs them, with ids from VARIANT_ID up;
// - shaders are TGSI text, translated by tgsi_vgpu10.js for what a draw has
//   bound: the next stage's inputs (GL links by semantic, D3D by register),
//   the viewport's Y direction and depth range, sampler view swizzles;
// - state (viewports, framebuffer, buffers, views) is kept as gallium's and
//   sent at draws, the DX commands that changed only;
// - user constants (SET_CONSTANT_BUFFER) go into a buffer of the device's.
//
// Each command is a header dword (command, object type, length in dwords)
// and its payload.

import { GX } from "../renderer_protocol.js";
import { virgl_format, TARGET } from "./virgl_caps.js";
import { parse_tgsi } from "./tgsi.js";
import { tgsi_to_vgpu10, SVGA_SHADER_TYPE, IMAGE_UAV, GRID_CONSTANT_BUFFER } from "./tgsi_vgpu10.js";
import * as C from "../vmware_svga/svga_constants.js";

// VIRGL_CCMD_*
export const CCMD = {
    NOP: 0, CREATE_OBJECT: 1, BIND_OBJECT: 2, DESTROY_OBJECT: 3, SET_VIEWPORT_STATE: 4, SET_FRAMEBUFFER_STATE: 5,
    SET_VERTEX_BUFFERS: 6, CLEAR: 7, DRAW_VBO: 8, RESOURCE_INLINE_WRITE: 9, SET_SAMPLER_VIEWS: 10,
    SET_INDEX_BUFFER: 11, SET_CONSTANT_BUFFER: 12, SET_STENCIL_REF: 13, SET_BLEND_COLOR: 14, SET_SCISSOR_STATE: 15,
    BLIT: 16, RESOURCE_COPY_REGION: 17, BIND_SAMPLER_STATES: 18, BEGIN_QUERY: 19, END_QUERY: 20,
    GET_QUERY_RESULT: 21, SET_POLYGON_STIPPLE: 22, SET_CLIP_STATE: 23, SET_SAMPLE_MASK: 24,
    SET_STREAMOUT_TARGETS: 25, SET_RENDER_CONDITION: 26, SET_UNIFORM_BUFFER: 27, SET_SUB_CTX: 28,
    CREATE_SUB_CTX: 29, DESTROY_SUB_CTX: 30, BIND_SHADER: 31, SET_TESS_STATE: 32, SET_MIN_SAMPLES: 33,
    SET_SHADER_BUFFERS: 34, SET_SHADER_IMAGES: 35, MEMORY_BARRIER: 36, LAUNCH_GRID: 37,
    SET_FRAMEBUFFER_STATE_NO_ATTACH: 38, TEXTURE_BARRIER: 39, SET_ATOMIC_BUFFERS: 40, SET_DEBUG_FLAGS: 41,
    GET_QUERY_RESULT_QBO: 42, TRANSFER3D: 43, END_TRANSFERS: 44, COPY_TRANSFER3D: 45, SET_TWEAKS: 46,
    CLEAR_TEXTURE: 47, PIPE_RESOURCE_CREATE: 48, PIPE_RESOURCE_SET_TYPE: 49, GET_MEMORY_INFO: 50,
    SEND_STRING_MARKER: 51, LINK_SHADER: 52,
};
const CCMD_NAMES = [];
for(const name of Object.keys(CCMD)) CCMD_NAMES[CCMD[name]] = name;

// VIRGL_OBJECT_*
export const OBJECT = {
    NULL: 0, BLEND: 1, RASTERIZER: 2, DSA: 3, SHADER: 4, VERTEX_ELEMENTS: 5, SAMPLER_VIEW: 6, SAMPLER_STATE: 7,
    SURFACE: 8, QUERY: 9, STREAMOUT_TARGET: 10, MSAA_SURFACE: 11,
};

const INVALID = 0xFFFFFFFF;
/** The ids of DX objects that are variants (rasterizer states, shaders): above the guest's handles */
const VARIANT_ID = 0x80000000;
const CONSTANT_BUFFER_BYTES = 65536;
const STAGES = 6;
const PIPE_PRIM_PATCHES = 14;
const PIPE_SHADER = { VERTEX: 0, FRAGMENT: 1, GEOMETRY: 2, TESS_CTRL: 3, TESS_EVAL: 4, COMPUTE: 5 };

const f32 = (() => {
    const u = new Uint32Array(1), f = new Float32Array(u.buffer);
    return { from: bits => { u[0] = bits; return f[0]; }, bits: value => { f[0] = value; return u[0]; } };
})();

// gallium -> SVGA3D enums
// PIPE_BLENDFACTOR_* -> SVGA3D_BLENDOP_*
const BLEND_FACTOR = { 0x01: 2, 0x02: 3, 0x03: 5, 0x04: 7, 0x05: 9, 0x06: 11, 0x07: 12, 0x08: 18, 0x09: 14, 0x0A: 16,
    0x11: 1, 0x12: 4, 0x13: 6, 0x14: 8, 0x15: 10, 0x17: 13, 0x18: 19, 0x19: 15, 0x1A: 17 };
// PIPE_STENCIL_OP_* -> SVGA3D_STENCILOP_*
const STENCIL_OP = [1, 2, 3, 4, 5, 7, 8, 6];
// PIPE_TEX_WRAP_* -> SVGA3D_TEX_ADDRESS_*
const WRAP = [1, 3, 3, 4, 2, 5, 5, 5];
// PIPE_PRIM_* -> SVGA3dPrimitiveType (0: Mesa converts them)
const PRIMITIVE = [2, 3, 0, 4, 1, 5, 0, 0, 0, 0, 7, 8, 9, 10];
// PIPE_POLYGON_MODE_* -> SVGA3D_FILLMODE_*
const FILL = [3, 2, 1, 3];
const QUERY_PRIMITIVES_GENERATED = 6, QUERY_PRIMITIVES_EMITTED = 7;
// PIPE_QUERY_* -> SVGA3dQueryType (the others are answered by the device)
const QUERY_TYPE = { 0: C.SVGA3D_QUERYTYPE_OCCLUSION64, 1: C.SVGA3D_QUERYTYPE_OCCLUSIONPREDICATE, 2: C.SVGA3D_QUERYTYPE_OCCLUSIONPREDICATE,
    3: C.SVGA3D_QUERYTYPE_TIMESTAMP };

/**
 * One sub-context (a guest GL context): a GX context and gallium's state
 * @constructor
 */
function SubContext(context, cid)
{
    this.context = context;
    this.virgl = context.virgl;
    this.cid = cid;
    /** @type {!Map<number, !Object>} handle -> object ({kind: OBJECT.*, ...}) */
    this.objects = new Map();
    this.next_variant = VARIANT_ID;
    // gallium's state
    this.fb = { cbufs: [], zsurf: 0 };
    this.viewport = { scale: [1, 1, 1], translate: [0, 0, 0] };
    this.scissor = [0, 0, 0, 0];
    this.blend = 0;
    this.dsa = 0;
    this.rasterizer = 0;
    this.elements = 0;
    this.blend_color = [0, 0, 0, 0];
    this.stencil_ref = 0;
    this.sample_mask = INVALID;
    /** @type {!Array<?{stride: number, offset: number, res: number}>} */
    this.vertex_buffers = [];
    /** @type {?{res: number, size: number, offset: number}} */
    this.index_buffer = null;
    this.shaders = new Array(STAGES).fill(0);
    /** per stage: sampler view handles, sampler state handles */
    this.views = Array.from({ length: STAGES }, () => []);
    this.samplers = Array.from({ length: STAGES }, () => []);
    /** per stage and slot: {user: Uint32Array} or {res, offset, length} */
    this.cbs = Array.from({ length: STAGES }, () => []);
    /** the device's user constant buffers, per stage: {sid, data} */
    this.user_buffers = [];
    /** the device's buffer of widened 8-bit indices */
    this.index_scratch = null;
    /** the stream output targets (STREAMOUT_TARGET handles) */
    this.so_targets = [];
    /** @type {!Set<!Object>} the queries counting primitives that are running */
    this.counting = new Set();
    /** @type {Array<number>} the render condition (SET_PREDICATION's words) */
    this.predication = null;
    /** per stage: shader storage buffers ({res, offset, length}) and images ({res, format, ...}) */
    this.buffers = Array.from({ length: STAGES }, () => []);
    this.images = Array.from({ length: STAGES }, () => []);
    /** @type {!Map<string, number>} the UA views made of them, by what they view */
    this.ua_views = new Map();
    /** the device's buffer of a dispatch's grid size (gl_NumWorkGroups) */
    this.grid_buffer = 0;
    /** @type {!Map<string, string>} what was last sent, by command */
    this.sent = new Map();
    this.gx(GX.CONTEXT_DEFINE, [cid]);
}

/**
 * @param {number} op
 * @param {!IArrayLike<number>} words
 * @param {Uint8Array=} bytes
 */
SubContext.prototype.gx = function(op, words, bytes)
{
    this.virgl.gxw.command(op, words, bytes);
};

/** A DX command of this context */
SubContext.prototype.dx = function(id, words)
{
    const w = new Uint32Array(2 + words.length);
    w[0] = this.cid;
    w[1] = id;
    for(let i = 0; i < words.length; i++) w[2 + i] = words[i] >>> 0;
    this.gx(GX.DX, w);
};

/** ... sent only when it differs from what was sent last time under `key` */
SubContext.prototype.dx_changed = function(key, id, words)
{
    const text = words.join(",");
    if(this.sent.get(key) === text) return;
    this.sent.set(key, text);
    this.dx(id, words);
};

SubContext.prototype.destroy = function()
{
    this.gx(GX.CONTEXT_DESTROY, [this.cid]);
    for(const b of this.user_buffers) if(b) this.gx(GX.SURFACE_DESTROY, [b.sid]);
    if(this.index_scratch) this.gx(GX.SURFACE_DESTROY, [this.index_scratch.sid]);
};

SubContext.prototype.warn = function(key, text)
{
    this.virgl.warn_once(key, text);
};

// ---------------------------------------------------------------------------

/**
 * @constructor
 * @param {!Object} virgl the Virgl device side
 * @param {number} ctx_id
 */
export function VirglContext(virgl, ctx_id)
{
    this.virgl = virgl;
    this.ctx_id = ctx_id;
    /** @type {!Map<number, !SubContext>} */
    this.subs = new Map();
    /** a shader whose text comes in parts */
    this.pending_shader = null;
    /** @type {function(number):?Object} resources by id (during run) */
    this.resource = () => null;
    this.sub = this.sub_context(0);
}

VirglContext.prototype.sub_context = function(id)
{
    let sub = this.subs.get(id);
    if(!sub)
    {
        sub = new SubContext(this, this.virgl.next_cid++);
        this.subs.set(id, sub);
    }
    return sub;
};

VirglContext.prototype.destroy = function()
{
    for(const sub of this.subs.values()) sub.destroy();
    this.subs.clear();
};

/** A resource is gone: nothing of this context may name it any more */
VirglContext.prototype.forget_resource = function(id)
{
    for(const sub of this.subs.values())
    {
        sub.vertex_buffers = sub.vertex_buffers.map(b => b && b.res === id ? null : b);
        if(sub.index_buffer && sub.index_buffer.res === id) sub.index_buffer = null;
        for(const cbs of sub.cbs) for(let i = 0; i < cbs.length; i++) if(cbs[i] && cbs[i].res === id) cbs[i] = null;
    }
};

/**
 * A command stream
 * @param {!Uint32Array} words
 * @param {function(number):?Object} resource by id
 */
VirglContext.prototype.run = function(words, resource)
{
    this.resource = resource;
    let at = 0;
    while(at < words.length)
    {
        const header = words[at];
        const command = header & 0xFF, object = header >>> 8 & 0xFF, length = header >>> 16;
        if(at + 1 + length > words.length)
        {
            this.virgl.warn_once("truncated", "a virgl command (" + command + ") runs past its stream");
            break;
        }
        const p = words.subarray(at + 1, at + 1 + length);
        this.virgl.counts[command] = (this.virgl.counts[command] || 0) + 1;
        this.command(command, object, p);
        at += 1 + length;
    }
};

/**
 * @param {number} command VIRGL_CCMD_*
 * @param {number} object VIRGL_OBJECT_* (CREATE, BIND, DESTROY)
 * @param {!Uint32Array} p the payload
 */
VirglContext.prototype.command = function(command, object, p)
{
    const sub = this.sub;
    switch(command)
    {
        case CCMD.NOP:
        case CCMD.SET_DEBUG_FLAGS:
        case CCMD.SET_TWEAKS:
        case CCMD.SEND_STRING_MARKER:
        case CCMD.LINK_SHADER:
        case CCMD.END_TRANSFERS:
        case CCMD.TEXTURE_BARRIER:
        case CCMD.MEMORY_BARRIER:
        case CCMD.SET_MIN_SAMPLES:
        case CCMD.SET_POLYGON_STIPPLE:
        case CCMD.SET_CLIP_STATE:
            return;
        case CCMD.CREATE_SUB_CTX:
            this.sub_context(p[0]);
            return;
        case CCMD.SET_SUB_CTX:
            this.sub = this.sub_context(p[0]);
            return;
        case CCMD.DESTROY_SUB_CTX:
        {
            const gone = this.subs.get(p[0]);
            if(!gone || p[0] === 0) return;
            gone.destroy();
            this.subs.delete(p[0]);
            if(this.sub === gone) this.sub = this.sub_context(0);
            return;
        }
        case CCMD.RESOURCE_INLINE_WRITE:
            this.inline_write(p);
            return;
        case CCMD.CREATE_OBJECT:
            if(object === OBJECT.SHADER) this.create_shader(p);
            else this.create_object(sub, object, p);
            return;
        case CCMD.BIND_OBJECT:
            switch(object)
            {
                case OBJECT.BLEND: sub.blend = p[0]; return;
                case OBJECT.DSA: sub.dsa = p[0]; return;
                case OBJECT.RASTERIZER: sub.rasterizer = p[0]; return;
                case OBJECT.VERTEX_ELEMENTS: sub.elements = p[0]; return;
            }
            break;
        case CCMD.DESTROY_OBJECT:
            this.destroy_object(sub, p[0]);
            return;
        case CCMD.BIND_SHADER:
            if(p[1] < STAGES) sub.shaders[p[1]] = p[0];
            return;
        case CCMD.SET_VIEWPORT_STATE:
            // (one viewport: virgl's caps say so)
            if(p[0] === 0 && p.length >= 7)
            {
                sub.viewport = { scale: [0, 1, 2].map(i => f32.from(p[1 + i])), translate: [0, 1, 2].map(i => f32.from(p[4 + i])) };
            }
            return;
        case CCMD.SET_SCISSOR_STATE:
            if(p[0] === 0 && p.length >= 3) sub.scissor = [p[1] & 0xFFFF, p[1] >>> 16, p[2] & 0xFFFF, p[2] >>> 16];
            return;
        case CCMD.SET_FRAMEBUFFER_STATE:
            sub.fb = { zsurf: p[1], cbufs: Array.from(p.subarray(2, 2 + Math.min(p[0], 8))) };
            return;
        case CCMD.SET_FRAMEBUFFER_STATE_NO_ATTACH:
            // the size of drawing without attachments (Mesa sends it with
            // every framebuffer; GX takes the viewport's then)
            return;
        case CCMD.SET_VERTEX_BUFFERS:
            sub.vertex_buffers = [];
            for(let i = 0; 3 * i + 2 < p.length; i++)
            {
                sub.vertex_buffers.push(p[3 * i + 2] ? { stride: p[3 * i], offset: p[3 * i + 1], res: p[3 * i + 2] } : null);
            }
            return;
        case CCMD.SET_INDEX_BUFFER:
            sub.index_buffer = p.length >= 3 && p[0] ? { res: p[0], size: p[1], offset: p[2] } : null;
            return;
        case CCMD.SET_SAMPLER_VIEWS:
            if(p[0] < STAGES) p.subarray(2).forEach((handle, i) => { sub.views[p[0]][p[1] + i] = handle; });
            return;
        case CCMD.BIND_SAMPLER_STATES:
            if(p[0] < STAGES) p.subarray(2).forEach((handle, i) => { sub.samplers[p[0]][p[1] + i] = handle; });
            return;
        case CCMD.SET_CONSTANT_BUFFER:
            if(p[0] < STAGES) sub.cbs[p[0]][p[1]] = p.length > 2 ? { user: p.slice(2) } : null;
            return;
        case CCMD.SET_UNIFORM_BUFFER:
            if(p[0] < STAGES) sub.cbs[p[0]][p[1]] = p[4] ? { res: p[4], offset: p[2], length: p[3] } : null;
            return;
        case CCMD.SET_STENCIL_REF:
            sub.stencil_ref = p[0] & 0xFF;
            return;
        case CCMD.SET_BLEND_COLOR:
            sub.blend_color = [0, 1, 2, 3].map(i => f32.from(p[i]));
            return;
        case CCMD.SET_SAMPLE_MASK:
            sub.sample_mask = p[0];
            return;
        case CCMD.CLEAR:
            this.clear(sub, p);
            return;
        case CCMD.DRAW_VBO:
            this.draw(sub, p);
            return;
        case CCMD.BLIT:
            this.blit(sub, p);
            return;
        case CCMD.RESOURCE_COPY_REGION:
            this.copy_region(p);
            return;
        case CCMD.BEGIN_QUERY:
            this.begin_query(sub, p[0]);
            return;
        case CCMD.END_QUERY:
            this.end_query(sub, p[0]);
            return;
        case CCMD.GET_QUERY_RESULT:
            // (end_query writes the result once the GPU has it, and SUBMIT_3D
            // completes after that)
            return;
        case CCMD.SET_STREAMOUT_TARGETS:
            this.set_streamout_targets(sub, p);
            return;
        case CCMD.SET_SHADER_BUFFERS:
            // stage, first slot, then (offset, length, resource) each
            if(p[0] < STAGES)
            {
                for(let i = 0; 2 + 3 * i + 2 < p.length; i++)
                {
                    const w = 2 + 3 * i;
                    sub.buffers[p[0]][p[1] + i] = p[w + 2] ? { res: p[w + 2], offset: p[w], length: p[w + 1] } : null;
                }
            }
            return;
        case CCMD.SET_SHADER_IMAGES:
            // stage, first slot, then (format, access, first layer | last << 16 or buffer offset, level or buffer size, resource) each
            if(p[0] < STAGES)
            {
                for(let i = 0; 2 + 5 * i + 4 < p.length; i++)
                {
                    const w = 2 + 5 * i;
                    sub.images[p[0]][p[1] + i] = p[w + 4] ? { res: p[w + 4], format: p[w], layers: p[w + 2], level: p[w + 3] } : null;
                }
            }
            return;
        case CCMD.LAUNCH_GRID:
            this.launch_grid(sub, p);
            return;
        case CCMD.SET_TESS_STATE:
            // the default tessellation levels (a control shader always sets its own)
            return;
        case CCMD.PIPE_RESOURCE_CREATE:
            // a HOST3D blob's template (target, format, bind, width, height,
            // depth, array size, last level, samples, flags), which
            // RESOURCE_CREATE_BLOB takes by the blob id
            if(p.length >= 11) this.virgl.blob_templates.set(this.ctx_id + ":" + p[10], Array.from(p.subarray(0, 10)));
            return;
        case CCMD.SET_RENDER_CONDITION:
        {
            const q = p[0] && sub.objects.get(p[0]);
            sub.predication = q && q.defined ? [p[0], p[1] ? 1 : 0] : null;
            sub.dx_changed("predication", C.SVGA_3D_CMD_DX_SET_PREDICATION, sub.predication || [INVALID, 0]);
            return;
        }
    }
    this.virgl.warn_once("ccmd" + command, "virgl command " + (CCMD_NAMES[command] || command) + " is not supported yet");
};

// ---------------------------------------------------------------------------
// Objects

VirglContext.prototype.create_object = function(sub, kind, p)
{
    const handle = p[0];
    if(sub.objects.has(handle)) this.destroy_object(sub, handle);
    this.create_kind(sub, kind, p);
    // (what made it: a snapshot makes it again so)
    const o = sub.objects.get(handle);
    if(o)
    {
        o.create_kind = kind;
        o.create_words = Array.from(p);
    }
};

VirglContext.prototype.create_kind = function(sub, kind, p)
{
    const handle = p[0];
    switch(kind)
    {
        case OBJECT.BLEND: return this.create_blend(sub, p);
        case OBJECT.DSA: return this.create_dsa(sub, p);
        case OBJECT.RASTERIZER:
            sub.objects.set(handle, { kind, words: Array.from(p.subarray(1, 9)), variants: new Map() });
            return;
        case OBJECT.SAMPLER_STATE: return this.create_sampler(sub, p);
        case OBJECT.VERTEX_ELEMENTS: return this.create_elements(sub, p);
        case OBJECT.SAMPLER_VIEW: return this.create_view(sub, p);
        case OBJECT.SURFACE:
        case OBJECT.MSAA_SURFACE:
            return this.create_surface(sub, p);
        case OBJECT.QUERY: return this.create_query(sub, p);
        case OBJECT.STREAMOUT_TARGET:
            sub.objects.set(handle, { kind, res: p[1], offset: p[2], size: p[3] });
            return;
    }
    sub.warn("object" + kind, "virgl object type " + kind + " is not supported yet");
};

VirglContext.prototype.destroy_object = function(sub, handle)
{
    const o = sub.objects.get(handle);
    if(!o) return;
    sub.objects.delete(handle);
    switch(o.kind)
    {
        case OBJECT.BLEND: sub.dx(C.SVGA_3D_CMD_DX_DESTROY_BLEND_STATE, [handle]); break;
        case OBJECT.DSA: sub.dx(C.SVGA_3D_CMD_DX_DESTROY_DEPTHSTENCIL_STATE, [handle]); break;
        case OBJECT.RASTERIZER:
            for(const id of o.variants.values()) sub.dx(C.SVGA_3D_CMD_DX_DESTROY_RASTERIZER_STATE, [id]);
            break;
        case OBJECT.SAMPLER_STATE: sub.dx(C.SVGA_3D_CMD_DX_DESTROY_SAMPLER_STATE, [handle]); break;
        case OBJECT.VERTEX_ELEMENTS: sub.dx(C.SVGA_3D_CMD_DX_DESTROY_ELEMENTLAYOUT, [handle]); break;
        case OBJECT.SAMPLER_VIEW: if(o.defined) sub.dx(C.SVGA_3D_CMD_DX_DESTROY_SHADERRESOURCE_VIEW, [handle]); break;
        case OBJECT.SURFACE:
            if(o.defined) sub.dx(o.depth ? C.SVGA_3D_CMD_DX_DESTROY_DEPTHSTENCIL_VIEW : C.SVGA_3D_CMD_DX_DESTROY_RENDERTARGET_VIEW, [handle]);
            break;
        case OBJECT.QUERY: if(o.defined) sub.dx(C.SVGA_3D_CMD_DX_DESTROY_QUERY, [handle]); break;
        case OBJECT.SHADER:
            for(const v of o.variants.values())
            {
                sub.dx(C.SVGA_3D_CMD_DX_DESTROY_SHADER, [v.shid]);
                for(const soid of v.soids.values()) sub.dx(C.SVGA_3D_CMD_DX_DESTROY_STREAMOUTPUT, [soid]);
            }
            break;
    }
    // what named it is sent again (the same handle may come back as another object)
    sub.sent.clear();
};

/** BLEND: handle, S0 (independent, logic op, dither, alpha to coverage, alpha to one), S1 (logic op), S2 per render target */
VirglContext.prototype.create_blend = function(sub, p)
{
    const handle = p[0], s0 = p[1];
    const independent = s0 & 1, a2c = s0 >>> 3 & 1;
    if(s0 & 2) sub.warn("logicop", "virgl: blend logic ops are not supported yet");
    const factor = f => BLEND_FACTOR[f] || 2;
    const words = [handle, a2c | independent << 8];
    for(let i = 0; i < 8; i++)
    {
        const rt = p[3 + (independent ? i : 0)] || 0;
        words.push((rt & 1) | factor(rt >>> 4 & 0x1F) << 8 | factor(rt >>> 9 & 0x1F) << 16 | ((rt >>> 1 & 7) + 1) << 24,
            factor(rt >>> 17 & 0x1F) | factor(rt >>> 22 & 0x1F) << 8 | ((rt >>> 14 & 7) + 1) << 16 | (rt >>> 27 & 0xF) << 24,
            0);
    }
    sub.objects.set(handle, { kind: OBJECT.BLEND });
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_BLEND_STATE, words);
};

/** DSA: handle, S0 (depth; alpha test), S1 (front stencil), S2 (back stencil), alpha ref */
VirglContext.prototype.create_dsa = function(sub, p)
{
    const handle = p[0], s0 = p[1], front = p[2], back = p[3];
    const stencil = s => ({ enabled: s & 1, func: (s >>> 1 & 7) + 1, fail: STENCIL_OP[s >>> 4 & 7], zpass: STENCIL_OP[s >>> 7 & 7],
        zfail: STENCIL_OP[s >>> 10 & 7], read: s >>> 13 & 0xFF, write: s >>> 21 & 0xFF });
    // (a disabled back face stencil means the front's for both)
    const f = stencil(front), b = back & 1 ? stencil(back) : f;
    const words = [handle,
        (s0 & 1) | (s0 >>> 1 & 1) << 8 | ((s0 >>> 2 & 7) + 1) << 16 | f.enabled << 24,
        f.enabled | f.enabled << 8 | f.read << 16 | f.write << 24,
        f.fail | f.zfail << 8 | f.zpass << 16 | f.func << 24,
        b.fail | b.zfail << 8 | b.zpass << 16 | b.func << 24];
    sub.objects.set(handle, { kind: OBJECT.DSA, alpha: s0 >>> 8 & 1 ? { func: s0 >>> 9 & 7, ref: f32.from(p[4] || 0) } : null });
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_DEPTHSTENCIL_STATE, words);
};

/** SAMPLER_STATE: handle, S0 (wraps, filters, compare, anisotropy), lod bias, min lod, max lod, border color */
VirglContext.prototype.create_sampler = function(sub, p)
{
    const handle = p[0], s0 = p[1];
    const min_linear = s0 >>> 9 & 1, mip = s0 >>> 11 & 3, mag_linear = s0 >>> 13 & 1, compare = s0 >>> 15 & 1;
    const anisotropy = s0 >>> 20 & 0x1F;
    let filter = (mip === 1 ? 1 : 0) | (mag_linear ? 4 : 0) | (min_linear ? 16 : 0);
    if(anisotropy > 1) filter |= 64;
    if(compare) filter |= 128;
    let min_lod = f32.from(p[3]), max_lod = f32.from(p[4]);
    // no mipmapping: the view's first level only
    if(mip === 2)
    {
        min_lod = 0;
        max_lod = 0;
    }
    const words = [handle, filter,
        WRAP[s0 & 7] | WRAP[s0 >>> 3 & 7] << 8 | WRAP[s0 >>> 6 & 7] << 16,
        p[2], Math.max(1, anisotropy) | ((s0 >>> 16 & 7) + 1) << 8,
        p[5], p[6], p[7], p[8], f32.bits(min_lod), f32.bits(max_lod)];
    sub.objects.set(handle, { kind: OBJECT.SAMPLER_STATE });
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_SAMPLER_STATE, words);
};

/** VERTEX_ELEMENTS: handle, then per element: offset, instance divisor, vertex buffer, format */
VirglContext.prototype.create_elements = function(sub, p)
{
    const handle = p[0];
    const words = [handle];
    for(let i = 0; 1 + 4 * i + 3 < p.length; i++)
    {
        const e = 1 + 4 * i;
        const info = virgl_format(p[e + 3]);
        if(!info || !info.vertex) sub.warn("vformat" + p[e + 3], "virgl vertex format " + p[e + 3] + " is not supported");
        words.push(p[e + 2], p[e], info ? info.svga : 0, p[e + 1] ? C.SVGA3D_INPUT_PER_INSTANCE_DATA : 0, p[e + 1], i);
    }
    sub.objects.set(handle, { kind: OBJECT.VERTEX_ELEMENTS });
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_ELEMENTLAYOUT, words);
};

/** The SVGA3dResourceType of a resource */
function resource_dimension(r)
{
    switch(r.target)
    {
        case TARGET.BUFFER: return C.SVGA3D_RESOURCE_BUFFER;
        case TARGET.TEXTURE_1D:
        case TARGET.TEXTURE_1D_ARRAY: return C.SVGA3D_RESOURCE_TEXTURE1D;
        case TARGET.TEXTURE_3D: return C.SVGA3D_RESOURCE_TEXTURE3D;
        case TARGET.TEXTURE_CUBE:
        case TARGET.TEXTURE_CUBE_ARRAY: return C.SVGA3D_RESOURCE_TEXTURECUBE;
    }
    return C.SVGA3D_RESOURCE_TEXTURE2D;
}

/** The bytes of an element of a buffer view's format */
function element_bytes(name)
{
    if(/R32G32B32A32/.test(name)) return 16;
    if(/R32G32B32_/.test(name)) return 12;
    if(/R32G32_|R16G16B16A16/.test(name)) return 8;
    if(/R32_|R16G16_|R8G8B8A8|B8G8R8|R10G10B10A2|R11G11B10/.test(name)) return 4;
    if(/R16_|R8G8_/.test(name)) return 2;
    return 1;
}

/**
 * SAMPLER_VIEW: handle, resource, format (the target in the high byte),
 * layers (first | last << 16) or first element, levels (first | last << 8)
 * or last element, swizzle (3 bits each)
 */
VirglContext.prototype.create_view = function(sub, p)
{
    const handle = p[0];
    const r = this.resource(p[1]);
    const format = p[2] & 0xFFFFFF;
    const info = virgl_format(format);
    const view_swizzle = [0, 3, 6, 9].map(s => p[5] >>> s & 7);
    // the format's swizzle (L8 is R8 read as RRR1), then the view's
    const base = info && info.swizzle || [0, 1, 2, 3];
    const swizzle = view_swizzle.map(c => c <= 3 ? base[c] : c);
    const o = { kind: OBJECT.SAMPLER_VIEW, res: p[1], swizzle, defined: false };
    sub.objects.set(handle, o);
    if(!r || !r.three_d || !info)
    {
        sub.warn("view-format" + format, "virgl: a sampler view of format " + format + " or of an unknown resource");
        return;
    }
    let desc;
    if(r.is_buffer())
    {
        // first and last element (of the view's format)
        desc = [p[3], Math.max(0, p[4] - p[3] + 1), 0, 0];
    }
    else
    {
        const first_level = p[4] & 0xFF, last_level = p[4] >>> 8 & 0xFF;
        const first_layer = p[3] & 0xFFFF, last_layer = p[3] >>> 16;
        // (SVGA3dShaderResourceViewDesc: most detailed mip, first slice, mips, slices)
        desc = [first_level, first_layer, last_level - first_level + 1, Math.max(1, last_layer - first_layer + 1)];
    }
    o.defined = true;
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_SHADERRESOURCE_VIEW, [handle, p[1], info.svga, resource_dimension(r), ...desc]);
};

/** SURFACE: handle, resource, format, level (or first element), layers (first | last << 16, or last element) */
VirglContext.prototype.create_surface = function(sub, p)
{
    const handle = p[0];
    const r = this.resource(p[1]);
    const info = virgl_format(p[2]);
    const o = { kind: OBJECT.SURFACE, res: p[1], depth: false, defined: false, integer: false, signed: false };
    sub.objects.set(handle, o);
    if(!r || !r.three_d || !info)
    {
        sub.warn("surface-format" + p[2], "virgl: a surface of format " + p[2] + " or of an unknown resource");
        return;
    }
    o.depth = info.can.includes("d");
    o.integer = /_[US]INT$/.test(info.name) && !o.depth;
    o.signed = /_SINT$/.test(info.name);
    const level = p[3], first = p[4] & 0xFFFF, last = p[4] >>> 16;
    const words = [handle, p[1], info.svga, resource_dimension(r), level, first, Math.max(1, last - first + 1)];
    o.defined = true;
    sub.dx(o.depth ? C.SVGA_3D_CMD_DX_DEFINE_DEPTHSTENCIL_VIEW : C.SVGA_3D_CMD_DX_DEFINE_RENDERTARGET_VIEW, words);
};

/** QUERY: handle, type | index << 16, offset, resource (where the result goes) */
VirglContext.prototype.create_query = function(sub, p)
{
    const handle = p[0], type = p[1] & 0xFFFF;
    const svga = QUERY_TYPE[type];
    const o = { kind: OBJECT.QUERY, type, svga: svga === undefined ? -1 : svga, offset: p[2], res: p[3], defined: false };
    sub.objects.set(handle, o);
    if(o.svga < 0) return;
    o.defined = true;
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_QUERY, [handle, o.svga, 0]);
};

/**
 * CREATE_OBJECT SHADER: handle, type, offlen (the text's length, or with
 * bit 31 where this part goes), number of tokens, stream output (count,
 * then with outputs 4 strides and 2 dwords per output), then the TGSI
 * text, maybe over several commands
 */
VirglContext.prototype.create_shader = function(p)
{
    const handle = p[0], type = p[1], offlen = p[2];
    // (a compute shader has its shared memory's size where the others have
    // their stream output)
    const compute = type === PIPE_SHADER.COMPUTE;
    const so_count = compute ? 0 : p[4];
    const header = 5 + (so_count && !(offlen >>> 31) ? 4 + 2 * so_count : 0);
    const text = new Uint8Array(p.buffer, p.byteOffset + header * 4, Math.max(0, p.length - header) * 4);
    let pending;
    if(offlen >>> 31)
    {
        pending = this.pending_shader;
        if(!pending || pending.handle !== handle) return;
        const at = offlen & 0x7FFFFFFF;
        pending.bytes.set(text.subarray(0, Math.max(0, pending.bytes.length - at)), at);
        pending.got = at + text.length;
    }
    else
    {
        pending = { handle, type, bytes: new Uint8Array(offlen), got: text.length,
            so: so_count ? Array.from(p.subarray(5, 5 + 4 + 2 * so_count)) : null, shared: compute ? p[4] : 0, sub: this.sub };
        pending.bytes.set(text.subarray(0, offlen));
        this.pending_shader = pending;
    }
    if(pending.got < pending.bytes.length) return;
    this.pending_shader = null;
    let end = pending.bytes.indexOf(0);
    if(end < 0) end = pending.bytes.length;
    const source = new TextDecoder().decode(pending.bytes.subarray(0, end));
    if(this.virgl.shader_log) this.virgl.shader_log(pending.type, source);
    this.define_shader(pending.sub, handle, pending.type, source, pending.so, pending.shared);
};

/**
 * A shader object: its TGSI parsed (variants are made at draws)
 * @param {Array<number>} so_words its stream output
 * @param {number=} shared a compute shader's shared memory, in bytes
 */
VirglContext.prototype.define_shader = function(sub, handle, type, source, so_words, shared)
{
    if(sub.objects.has(handle)) this.destroy_object(sub, handle);
    let program = null;
    try
    {
        program = parse_tgsi(source);
    }
    catch(e)
    {
        sub.warn("tgsi:" + e.message, "virgl: a shader does not parse: " + e.message);
    }
    if(program) program.shared = shared || 0;
    sub.objects.set(handle, { kind: OBJECT.SHADER, stage: type, program, variants: new Map(), so: stream_output_info(so_words),
        source, so_words, shared: shared || 0 });
};

/**
 * RESOURCE_INLINE_WRITE: res, level, usage, stride, layer_stride, box
 * (x, y, z, w, h, d), then the bytes
 */
VirglContext.prototype.inline_write = function(p)
{
    const r = this.resource(p[0]);
    if(!r || !r.three_d || p.length < 11) return;
    const bytes = new Uint8Array(p.buffer, p.byteOffset + 11 * 4, (p.length - 11) * 4);
    const [level, , stride, layer_stride, x, y, z, w, h, d] = p.subarray(1, 11);
    this.virgl.transfer_to_host(r, [x, y, z, w, h, d], level, 0, stride, layer_stride, (from, out, to, length) => {
        if(from + length > bytes.length) return false;
        out.set(bytes.subarray(from, from + length), to);
        return true;
    });
    this.virgl.wrote(r);
};

// ---------------------------------------------------------------------------
// Drawing

/** The 3D resources of the framebuffer's surfaces: the GPU has written them */
VirglContext.prototype.written = function(sub)
{
    for(const handle of [...sub.fb.cbufs, sub.fb.zsurf])
    {
        const s = handle && sub.objects.get(handle);
        const r = s && this.resource(s.res);
        if(r && r.three_d) this.virgl.wrote(r);
    }
};

/** CLEAR: buffers (PIPE_CLEAR_*), color (4 dwords), depth (a double), stencil */
VirglContext.prototype.clear = function(sub, p)
{
    const buffers = p[0];
    sub.fb.cbufs.forEach((handle, i) => {
        if(!(buffers & 4 << i) || !handle) return;
        const s = sub.objects.get(handle);
        if(!s || !s.defined || s.depth) return;
        // integer targets get their values as integers
        if(s.integer) sub.gx(GX.CLEAR_RTV_INTEGER, [sub.cid, handle, s.signed ? 1 : 0, p[1], p[2], p[3], p[4]]);
        else sub.dx(C.SVGA_3D_CMD_DX_CLEAR_RENDERTARGET_VIEW, [handle, p[1], p[2], p[3], p[4]]);
    });
    if(buffers & 3 && sub.fb.zsurf)
    {
        const s = sub.objects.get(sub.fb.zsurf);
        if(s && s.defined && s.depth)
        {
            const depth = new Float64Array(new Uint32Array([p[5], p[6]]).buffer)[0];
            sub.dx(C.SVGA_3D_CMD_DX_CLEAR_DEPTHSTENCIL_VIEW, [(buffers & 3) | (p[7] & 0xFF) << 16, sub.fb.zsurf, f32.bits(depth)]);
        }
    }
    this.written(sub);
};

/**
 * A shader's variant for `key`: translated, defined in GX
 * @return {?{shid: number, inputs: !Object<string, number>}}
 */
VirglContext.prototype.variant = function(sub, handle, key)
{
    const o = sub.objects.get(handle);
    if(!o || o.kind !== OBJECT.SHADER || !o.program) return null;
    const text = JSON.stringify(key);
    let v = o.variants.get(text);
    if(v) return v;
    const result = tgsi_to_vgpu10(o.program, key);
    for(const problem of result.problems) sub.warn("tgsi-" + problem, "virgl: shaders with " + problem + " are not supported yet");
    const shid = sub.next_variant++;
    const type = SVGA_SHADER_TYPE[o.program.processor];
    const bytes = new Uint8Array(result.tokens.buffer, result.tokens.byteOffset, result.tokens.byteLength);
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_SHADER, [shid, type, bytes.length]);
    sub.gx(GX.SHADER_CODE, [sub.cid, shid, type], bytes);
    v = { shid, inputs: result.inputs, outputs: result.outputs, soids: new Map() };
    o.variants.set(text, v);
    return v;
};

/**
 * The tessellator's settings, from the evaluation shader's properties (and
 * the control shader's output control points)
 * @return {?{domain: string, partitioning: number, output_primitive: number, in_cps: number, out_cps: number}}
 */
VirglContext.prototype.tessellator = function(sub, tes, tcs, in_cps)
{
    const e = sub.objects.get(tes), c = sub.objects.get(tcs);
    if(!e || !e.program || !c || !c.program) return null;
    const prop = (o, name, value) => +((o.program.properties[name] || [value])[0]);
    const domain = { 1: "isoline", 4: "tri", 7: "quad" }[prop(e, "TES_PRIM_MODE", 7)] || "quad";
    // PIPE_TESS_SPACING_* (fractional odd, fractional even, equal) -> VGPU10's partitioning
    const partitioning = [3, 4, 1][prop(e, "TES_SPACING", 2)] || 1;
    // (GL's clockwise is D3D's counter-clockwise: Mesa's svga does so)
    const output_primitive = prop(e, "TES_POINT_MODE", 0) ? 1 : domain === "isoline" ? 2 : prop(e, "TES_VERTEX_ORDER_CW", 0) ? 4 : 3;
    return { domain, partitioning, output_primitive, in_cps, out_cps: prop(c, "TCS_VERTICES_OUT", in_cps) };
};

/** The swizzles of a stage's sampler views (for its shader's key) */
function view_swizzles(sub, stage)
{
    return sub.views[stage].map(handle => {
        const v = handle && sub.objects.get(handle);
        return v && v.swizzle || [0, 1, 2, 3];
    });
}

/**
 * The rasterizer state's DX object, made at its first draw. (Its front face
 * is right as it is: Mesa flips it for framebuffer objects, whose Y the
 * vertex stage flips, and so gallium's window coordinates are D3D's.)
 */
VirglContext.prototype.rasterizer_variant = function(sub)
{
    const o = sub.objects.get(sub.rasterizer);
    if(!o || o.kind !== OBJECT.RASTERIZER) return INVALID;
    let id = o.variants.get("dx");
    if(id !== undefined) return id;
    const [s0, , , s3, line_width, units, scale, clamp] = o.words;
    const cull = s0 >>> 8 & 3;
    if(cull === 3) sub.warn("cull-both", "virgl: culling both faces is not supported");
    const front_ccw = s0 >>> 15 & 1;
    const offset = s0 >>> 20 & 1;
    id = sub.next_variant++;
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_RASTERIZER_STATE_V2, [id,
        FILL[s0 >>> 10 & 3] | [1, 2, 3, 2][cull] << 8 | front_ccw << 16 | (s0 >>> 4 & 1 ? 0 : 1) << 24,
        offset ? Math.round(f32.from(units)) : 0, offset ? clamp : 0, offset ? scale : 0,
        (s0 >>> 1 & 1) | (s0 >>> 14 & 1) << 8 | (s0 >>> 25 & 1) << 16 | (s0 >>> 26 & 1) << 24,
        line_width, (s0 >>> 27 & 1) | (s3 >>> 16 & 0xFF) << 8 | (s3 & 0xFFFF) << 16, 0]);
    o.variants.set("dx", id);
    return id;
};

/** A stage's user constants, in the device's buffer for them */
VirglContext.prototype.user_constants = function(sub, stage, data)
{
    let b = sub.user_buffers[stage];
    if(!b)
    {
        b = sub.user_buffers[stage] = { sid: this.virgl.next_private_sid++, data: null };
        sub.gx(GX.SURFACE_DEFINE, [b.sid, C.SVGA3D_BUFFER, 0, 0, CONSTANT_BUFFER_BYTES, 1, 1, 1, 1, 0, 0]);
    }
    if(b.data !== data)
    {
        b.data = data;
        const bytes = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, CONSTANT_BUFFER_BYTES));
        sub.gx(GX.SURFACE_UPLOAD, [b.sid, 0, 0, 0, 0, 0, bytes.length, 1, 1, bytes.length, bytes.length], bytes);
    }
    return b.sid;
};

/** A stage's bindings: constant buffers, sampler views, samplers */
VirglContext.prototype.bind_stage = function(sub, stage)
{
    const type = stage + 1;
    const cbs = sub.cbs[stage];
    for(let slot = 0; slot < 15; slot++)
    {
        const cb = cbs[slot];
        const key = "cb" + stage + ":" + slot;
        if(!cb && !sub.sent.has(key)) continue;
        let words;
        if(!cb) words = [slot, type, INVALID, 0, 0];
        else if(cb.user) words = [slot, type, this.user_constants(sub, stage, cb.user), 0, CONSTANT_BUFFER_BYTES];
        else words = [slot, type, cb.res, cb.offset, cb.length];
        sub.dx_changed(key, C.SVGA_3D_CMD_DX_SET_SINGLE_CONSTANT_BUFFER, words);
    }
    const views = sub.views[stage].map(handle => {
        const v = handle && sub.objects.get(handle);
        return v && v.defined ? handle : INVALID;
    });
    if(views.length) sub.dx_changed("srv" + stage, C.SVGA_3D_CMD_DX_SET_SHADER_RESOURCES, [0, type, ...views]);
    const samplers = sub.samplers[stage].map(handle => handle && sub.objects.has(handle) ? handle : INVALID);
    if(samplers.length) sub.dx_changed("sampler" + stage, C.SVGA_3D_CMD_DX_SET_SAMPLERS, [0, type, ...samplers]);
};

/**
 * DRAW_VBO: start, count, mode, indexed, instance count, index bias, start
 * instance, primitive restart, restart index, min and max index, count from
 * stream output (then tessellation and indirect draws)
 */
VirglContext.prototype.draw = function(sub, p)
{
    const [start, count, mode, indexed, instances, index_bias, start_instance] = p;
    // (patches: SVGA's patch lists, by the vertices a patch has)
    const topology = mode === PIPE_PRIM_PATCHES ? 10 + Math.max(1, Math.min(32, p[12] || 1)) : PRIMITIVE[mode];
    if(!topology)
    {
        sub.warn("prim" + mode, "virgl: primitive " + mode + " is not supported");
        return;
    }
    // indirect: a buffer of D3D's arguments too (GL's are the same), count draws stride apart
    const indirect = p.length > 14 && p[14] ? { res: p[14], offset: p[15], stride: p[16], count: p[17], count_res: p[19] } : null;
    if(indirect && indirect.count_res) sub.warn("indirect-count", "virgl: indirect draw counts are not supported yet");
    const vs = sub.shaders[PIPE_SHADER.VERTEX], fs = sub.shaders[PIPE_SHADER.FRAGMENT], gs = sub.shaders[PIPE_SHADER.GEOMETRY];
    const tes = mode === PIPE_PRIM_PATCHES ? sub.shaders[PIPE_SHADER.TESS_EVAL] : 0;
    const tcs = tes ? sub.shaders[PIPE_SHADER.TESS_CTRL] : 0;
    if(this.virgl.debug_log && mode === PIPE_PRIM_PATCHES) this.virgl.debug_log("patches " + JSON.stringify({ tes, tcs, p: Array.from(p) }));
    if(tes && !tcs)
    {
        sub.warn("no-tcs", "virgl: tessellation without a control shader is not supported yet");
        return;
    }
    if(!vs) return;
    const rs = sub.objects.get(sub.rasterizer);
    const s0 = rs && rs.kind === OBJECT.RASTERIZER ? rs.words[0] : 0;
    const halfz = !!(s0 >>> 2 & 1);
    // gallium's Y scale: positive draws GL's way up (framebuffer objects)
    const flip_y = sub.viewport.scale[1] > 0;
    const dsa = sub.objects.get(sub.dsa);
    const fs_key = {
        color_buffers: sub.fb.cbufs.length,
        swizzles: view_swizzles(sub, PIPE_SHADER.FRAGMENT),
        flatshade: !!(s0 & 1),
    };
    // GL's clip distances (the rasterizer state's clip_plane_enable)
    const clip_enable = rs && rs.kind === OBJECT.RASTERIZER ? rs.words[3] >>> 24 & 0xFF : 0;
    if(clip_enable) fs_key.clip_enable = clip_enable;
    if(dsa && dsa.alpha)
    {
        fs_key.alpha_func = dsa.alpha.func;
        fs_key.alpha_ref = dsa.alpha.ref;
    }
    const fsv = fs ? this.variant(sub, fs, fs_key) : null;
    const fs_inputs = fsv ? fsv.inputs : {};
    let vsv, gsv = null;
    // (what stream output captures must be in output registers)
    const streaming = sub.so_targets.some(t => t);
    const all_outputs = handle => streaming && !!this.shader_so(sub, handle);
    let tesv = null, tcsv = null;
    // the stages from the last to the first: each writes where the next reads
    let next = fs_inputs;
    if(gs)
    {
        gsv = this.variant(sub, gs, { outputs: next, all_outputs: all_outputs(gs), flip_y, halfz,
            swizzles: view_swizzles(sub, PIPE_SHADER.GEOMETRY) });
        next = gsv ? gsv.inputs : {};
    }
    if(tes)
    {
        const t = this.tessellator(sub, tes, tcs, p[12] || 1);
        if(!t) return;
        tesv = this.variant(sub, tes, { outputs: next, all_outputs: !gs && all_outputs(tes), flip_y: !gs && flip_y, halfz: gs ? true : halfz,
            cps: t.out_cps, swizzles: view_swizzles(sub, PIPE_SHADER.TESS_EVAL) });
        tcsv = tesv && this.variant(sub, tcs, { outputs: tesv.inputs, in_cps: t.in_cps, domain: t.domain, partitioning: t.partitioning,
            output_primitive: t.output_primitive, swizzles: view_swizzles(sub, PIPE_SHADER.TESS_CTRL) });
        if(!tcsv) return;
        next = tcsv.inputs;
    }
    const last = !gs && !tes;
    vsv = this.variant(sub, vs, { outputs: next, all_outputs: last && all_outputs(vs), flip_y: last && flip_y, halfz: last ? halfz : true,
        swizzles: view_swizzles(sub, PIPE_SHADER.VERTEX) });
    if(!vsv) return;
    // primitives counted for the queries running (before rasterizer discard)
    if(sub.counting.size)
    {
        const prims = primitive_count(mode, count) * Math.max(1, instances);
        for(const q of sub.counting) q.count += prims;
    }
    // stream output: of the last vertex stage, into the targets bound
    const discard = !!(s0 >>> 3 & 1);
    const soid = this.stream_output(sub, gs ? gs : tes ? tes : vs, gs ? gsv : tes ? tesv : vsv, discard);
    if(discard && soid === INVALID) return;
    sub.dx_changed("soid", C.SVGA_3D_CMD_DX_SET_STREAMOUTPUT, [soid]);
    sub.dx_changed("vs", C.SVGA_3D_CMD_DX_SET_SHADER, [vsv.shid, C.SVGA3D_SHADERTYPE_VS]);
    sub.dx_changed("gs", C.SVGA_3D_CMD_DX_SET_SHADER, [gsv ? gsv.shid : INVALID, C.SVGA3D_SHADERTYPE_GS]);
    sub.dx_changed("hs", C.SVGA_3D_CMD_DX_SET_SHADER, [tcsv ? tcsv.shid : INVALID, C.SVGA3D_SHADERTYPE_HS]);
    sub.dx_changed("ds", C.SVGA_3D_CMD_DX_SET_SHADER, [tesv ? tesv.shid : INVALID, C.SVGA3D_SHADERTYPE_DS]);
    sub.dx_changed("ps", C.SVGA_3D_CMD_DX_SET_SHADER, [fsv ? fsv.shid : INVALID, C.SVGA3D_SHADERTYPE_PS]);
    this.bind_stage(sub, PIPE_SHADER.VERTEX);
    this.bind_stage(sub, PIPE_SHADER.FRAGMENT);
    if(gs) this.bind_stage(sub, PIPE_SHADER.GEOMETRY);
    if(tes)
    {
        this.bind_stage(sub, PIPE_SHADER.TESS_CTRL);
        this.bind_stage(sub, PIPE_SHADER.TESS_EVAL);
    }
    // (UAVs: the fragment stage's; D3D11 has them there and in compute)
    sub.dx_changed("uavs", C.SVGA_3D_CMD_DX_SET_UA_VIEWS, [0, ...this.ua_views(sub, PIPE_SHADER.FRAGMENT)]);

    // fixed function
    sub.dx_changed("rasterizer", C.SVGA_3D_CMD_DX_SET_RASTERIZER_STATE, [this.rasterizer_variant(sub)]);
    sub.dx_changed("blend", C.SVGA_3D_CMD_DX_SET_BLEND_STATE, [sub.objects.has(sub.blend) ? sub.blend : INVALID,
        ...sub.blend_color.map(f32.bits), sub.sample_mask]);
    sub.dx_changed("depth", C.SVGA_3D_CMD_DX_SET_DEPTHSTENCIL_STATE, [sub.objects.has(sub.dsa) ? sub.dsa : INVALID, sub.stencil_ref]);
    const rtvs = sub.fb.cbufs.map(handle => {
        const s = handle && sub.objects.get(handle);
        return s && s.defined && !s.depth ? handle : INVALID;
    });
    const z = sub.fb.zsurf && sub.objects.get(sub.fb.zsurf);
    sub.dx_changed("targets", C.SVGA_3D_CMD_DX_SET_RENDERTARGETS, [z && z.defined && z.depth ? sub.fb.zsurf : INVALID, ...rtvs]);
    // the viewport as D3D's (Y down, depth from min to max)
    const [sx, sy, sz] = sub.viewport.scale, [tx, ty, tz] = sub.viewport.translate;
    const ax = Math.abs(sx), ay = Math.abs(sy);
    const near = halfz ? tz : tz - sz, far = tz + sz;
    sub.dx_changed("viewport", C.SVGA_3D_CMD_DX_SET_VIEWPORTS, [0,
        f32.bits(tx - ax), f32.bits(ty - ay), f32.bits(2 * ax), f32.bits(2 * ay),
        f32.bits(Math.max(0, Math.min(near, far))), f32.bits(Math.min(1, Math.max(near, far)))]);
    sub.dx_changed("scissor", C.SVGA_3D_CMD_DX_SET_SCISSORRECTS, [0, ...sub.scissor]);

    // vertices
    sub.dx_changed("layout", C.SVGA_3D_CMD_DX_SET_INPUT_LAYOUT, [sub.objects.has(sub.elements) ? sub.elements : INVALID]);
    const buffers = [0];
    for(const b of sub.vertex_buffers)
    {
        if(b && this.resource(b.res)) buffers.push(b.res, b.stride, b.offset);
        else buffers.push(INVALID, 0, 0);
    }
    if(buffers.length > 1) sub.dx_changed("vbs", C.SVGA_3D_CMD_DX_SET_VERTEX_BUFFERS, buffers);
    sub.dx_changed("topology", C.SVGA_3D_CMD_DX_SET_TOPOLOGY, [topology]);

    const n = Math.max(1, instances);
    if(this.virgl.debug_log) this.virgl.debug_log("draw " + JSON.stringify({ mode, topology, count, start, indexed, n, indirect,
        vs: vsv && vsv.shid, tcs: tcsv && tcsv.shid, tes: tesv && tesv.shid, gs: gsv && gsv.shid, fs: fsv && fsv.shid, flip_y, halfz }));
    if(indirect)
    {
        if(indexed)
        {
            const ib = sub.index_buffer;
            if(!ib || ib.size === 1) return;
            sub.dx_changed("ib", C.SVGA_3D_CMD_DX_SET_INDEX_BUFFER, [ib.res, ib.size === 4 ? C.SVGA3D_R32_UINT : C.SVGA3D_R16_UINT, ib.offset]);
        }
        const id = indexed ? C.SVGA_3D_CMD_DX_DRAW_INDEXED_INSTANCED_INDIRECT : C.SVGA_3D_CMD_DX_DRAW_INSTANCED_INDIRECT;
        const size = indexed ? 20 : 16;
        for(let i = 0; i < Math.max(1, indirect.count); i++)
        {
            sub.dx(id, [indirect.res, indirect.offset + i * (indirect.stride || size)]);
        }
    }
    else if(p.length > 11 && p[11])
    {
        // as many vertices as stream output wrote into vertex buffer 0
        sub.dx(C.SVGA_3D_CMD_DX_DRAW_AUTO, []);
    }
    else if(indexed)
    {
        const ib = sub.index_buffer;
        if(!ib) return;
        let sid = ib.res, offset = ib.offset, format = ib.size === 4 ? C.SVGA3D_R32_UINT : C.SVGA3D_R16_UINT;
        if(ib.size === 1)
        {
            // D3D has no 8-bit indices: the guest's copy, widened
            sid = this.widen_indices(sub, ib, count, !!p[7]);
            if(!sid) return;
            offset = 0;
            format = C.SVGA3D_R16_UINT;
        }
        sub.dx_changed("ib", C.SVGA_3D_CMD_DX_SET_INDEX_BUFFER, [sid, format, offset]);
        // (the index buffer's offset has the first index already)
        if(n > 1 || start_instance) sub.dx(C.SVGA_3D_CMD_DX_DRAW_INDEXED_INSTANCED, [count, n, 0, index_bias, start_instance]);
        else sub.dx(C.SVGA_3D_CMD_DX_DRAW_INDEXED, [count, 0, index_bias]);
    }
    else
    {
        if(n > 1 || start_instance) sub.dx(C.SVGA_3D_CMD_DX_DRAW_INSTANCED, [count, n, start, start_instance]);
        else sub.dx(C.SVGA_3D_CMD_DX_DRAW, [count, start]);
    }
    this.written(sub);
    this.virgl.flush_big();
};

/**
 * A stage's shader storage buffers and images as UA views (raw buffers at
 * u0 on, typed images at u8 on): 64 view ids
 * @return {!Array<number>}
 */
VirglContext.prototype.ua_views = function(sub, stage)
{
    const ids = new Array(64).fill(INVALID);
    const view = (key, words) => {
        let id = sub.ua_views.get(key);
        if(id === undefined)
        {
            id = sub.next_variant++;
            sub.ua_views.set(key, id);
            sub.dx(C.SVGA_3D_CMD_DX_DEFINE_UA_VIEW, [id, ...words]);
        }
        return id;
    };
    sub.buffers[stage].forEach((b, slot) => {
        const r = b && this.resource(b.res);
        if(!r || !r.three_d) return;
        // raw: in dwords
        ids[slot] = view("b" + [b.res, b.offset, b.length], [b.res, C.SVGA3D_R32_TYPELESS, C.SVGA3D_RESOURCE_BUFFER,
            b.offset >>> 2, Math.max(1, b.length >>> 2), C.SVGA3D_UABUFFER_RAW, 0]);
        this.virgl.wrote(r);
    });
    sub.images[stage].forEach((image, slot) => {
        const r = image && this.resource(image.res);
        const info = image && virgl_format(image.format);
        if(!r || !r.three_d || !info || IMAGE_UAV + slot >= 64) return;
        const first = image.layers & 0xFFFF, last = image.layers >>> 16;
        const desc = r.is_buffer() ? [image.layers, Math.max(1, image.level), 0, 0] :
            [image.level, first, Math.max(1, last - first + 1), 0];
        ids[IMAGE_UAV + slot] = view("i" + [image.res, image.format, image.layers, image.level],
            [image.res, info.svga, resource_dimension(r), ...desc]);
        this.virgl.wrote(r);
    });
    return ids;
};

/**
 * LAUNCH_GRID: block size, grid size, then an indirect buffer and offset
 * (the grid size from there)
 */
VirglContext.prototype.launch_grid = function(sub, p)
{
    const cs = sub.shaders[PIPE_SHADER.COMPUTE];
    const v = cs && this.variant(sub, cs, { swizzles: view_swizzles(sub, PIPE_SHADER.COMPUTE) });
    if(!v) return;
    sub.dx_changed("cs", C.SVGA_3D_CMD_DX_SET_SHADER, [v.shid, C.SVGA3D_SHADERTYPE_CS]);
    this.bind_stage(sub, PIPE_SHADER.COMPUTE);
    sub.dx_changed("csuavs", C.SVGA_3D_CMD_DX_SET_CS_UA_VIEWS, [0, ...this.ua_views(sub, PIPE_SHADER.COMPUTE)]);
    // the grid size, for gl_NumWorkGroups
    if(!sub.grid_buffer)
    {
        sub.grid_buffer = this.virgl.next_private_sid++;
        sub.gx(GX.SURFACE_DEFINE, [sub.grid_buffer, C.SVGA3D_BUFFER, 0, 0, 256, 1, 1, 1, 1, 0, 0]);
    }
    const indirect = p.length > 6 && p[6] ? this.resource(p[6]) : null;
    if(indirect) sub.gx(GX.SURFACE_COPY, [p[6], 0, 0, p[7], 0, 0, sub.grid_buffer, 0, 0, 0, 0, 0, 12, 1, 1]);
    else
    {
        const grid = new Uint8Array(Uint32Array.of(p[3], p[4], p[5], 0).buffer);
        sub.gx(GX.SURFACE_UPLOAD, [sub.grid_buffer, 0, 0, 0, 0, 0, 16, 1, 1, 16, 16], grid);
    }
    sub.dx_changed("cb5:" + GRID_CONSTANT_BUFFER, C.SVGA_3D_CMD_DX_SET_SINGLE_CONSTANT_BUFFER,
        [GRID_CONSTANT_BUFFER, C.SVGA3D_SHADERTYPE_CS, sub.grid_buffer, 0, 256]);
    if(indirect) sub.dx(C.SVGA_3D_CMD_DX_DISPATCH_INDIRECT, [p[6], p[7]]);
    else sub.dx(C.SVGA_3D_CMD_DX_DISPATCH, [p[3], p[4], p[5]]);
    this.virgl.flush_big();
};

/**
 * 8-bit indices as 16-bit ones in a buffer of the device's, from the
 * guest's copy (with primitive restart, 0xFF restarts as 0xFFFF)
 */
VirglContext.prototype.widen_indices = function(sub, ib, count, restart)
{
    const r = this.resource(ib.res);
    if(!r || !r.backing) return 0;
    const bytes = new Uint8Array(count);
    if(!this.virgl.gpu.read_backing(r, ib.offset, bytes, 0, count)) return 0;
    const wide = new Uint16Array(count + 1 & ~1);
    wide.set(bytes);
    if(restart) for(let i = 0; i < count; i++) if(wide[i] === 0xFF) wide[i] = 0xFFFF;
    if(!sub.index_scratch || sub.index_scratch.bytes < wide.byteLength)
    {
        if(sub.index_scratch) sub.gx(GX.SURFACE_DESTROY, [sub.index_scratch.sid]);
        const size = Math.max(4096, wide.byteLength * 2);
        sub.index_scratch = { sid: this.virgl.next_private_sid++, bytes: size };
        sub.gx(GX.SURFACE_DEFINE, [sub.index_scratch.sid, C.SVGA3D_BUFFER, 0, 0, size, 1, 1, 1, 1, 0, 0]);
    }
    const data = new Uint8Array(wide.buffer);
    sub.gx(GX.SURFACE_UPLOAD, [sub.index_scratch.sid, 0, 0, 0, 0, 0, data.length, 1, 1, data.length, data.length], data);
    return sub.index_scratch.sid;
};

/** How many primitives a draw of `count` vertices of mode `mode` (PIPE_PRIM_*) makes */
function primitive_count(mode, count)
{
    switch(mode)
    {
        case 0: return count;
        case 1: return count >> 1;
        case 3: return Math.max(0, count - 1);
        case 4: return Math.floor(count / 3);
        case 5: return Math.max(0, count - 2);
        case 10: return count >> 2;
        case 11: return Math.max(0, count - 3);
        case 12: return Math.floor(count / 6);
        case 13: return Math.max(0, (count - 4) >> 1);
    }
    return 0;
}

/**
 * A shader's stream output (CREATE_OBJECT SHADER's): 4 strides in dwords,
 * then per output: register | start component << 8 | components << 10 |
 * buffer << 13 | offset in dwords << 16, and the stream
 * @return {?{strides: !Array<number>, outputs: !Array<!Object>}}
 */
function stream_output_info(words)
{
    if(!words) return null;
    const outputs = [];
    for(let at = 4; at + 1 < words.length; at += 2)
    {
        const w = words[at];
        outputs.push({ register: w & 0xFF, start: w >>> 8 & 3, components: w >>> 10 & 7, buffer: w >>> 13 & 7,
            offset: w >>> 16, stream: words[at + 1] & 3 });
    }
    return { strides: words.slice(0, 4), outputs };
}

/** A shader's stream output, if it has one */
VirglContext.prototype.shader_so = function(sub, handle)
{
    const o = sub.objects.get(handle);
    return o && o.kind === OBJECT.SHADER && o.so && o.so.outputs.length ? o.so : null;
};

/**
 * SET_STREAMOUT_TARGETS: the append mask, then the targets (STREAMOUT_TARGET
 * handles); an appended target goes on from where stream output got to
 */
VirglContext.prototype.set_streamout_targets = function(sub, p)
{
    const append = p[0];
    sub.so_targets = Array.from(p.subarray(1, 5));
    const words = [0];
    for(let i = 0; i < 4; i++)
    {
        const t = sub.so_targets[i] && sub.objects.get(sub.so_targets[i]);
        const r = t && t.kind === OBJECT.STREAMOUT_TARGET && this.resource(t.res);
        if(r)
        {
            words.push(t.res, append >> i & 1 ? INVALID : t.offset, t.size);
            if(r.three_d) this.virgl.wrote(r);
        }
        else words.push(INVALID, 0, 0);
    }
    // (sent each time: targets set again start from their offsets again)
    sub.dx(C.SVGA_3D_CMD_DX_SET_SOTARGETS, words);
};

/**
 * The stream output declaration of a shader variant (its outputs' registers),
 * defined once: INVALID without stream output
 * @param {boolean} discard nothing is rasterized
 */
VirglContext.prototype.stream_output = function(sub, handle, variant, discard)
{
    const so = sub.so_targets.some(t => t) && variant ? this.shader_so(sub, handle) : null;
    if(!so) return INVALID;
    // (the draw writes the targets)
    for(const target of sub.so_targets)
    {
        const t = target && sub.objects.get(target);
        const r = t && t.kind === OBJECT.STREAMOUT_TARGET && this.resource(t.res);
        if(r && r.three_d) this.virgl.wrote(r);
    }
    let soid = variant.soids.get(discard);
    if(soid !== undefined) return soid;
    // SVGA3dStreamOutputDeclarationEntry: buffer, register, mask, stream; gaps
    // (where nothing is written) as registers no shader has
    const entries = [], filled = [0, 0, 0, 0];
    const sorted = so.outputs.slice().sort((a, b) => a.buffer - b.buffer || a.offset - b.offset);
    for(const o of sorted)
    {
        while(filled[o.buffer] < o.offset)
        {
            const gap = Math.min(4, o.offset - filled[o.buffer]);
            entries.push([o.buffer, 0xFFFF, (1 << gap) - 1, o.stream]);
            filled[o.buffer] += gap;
        }
        const reg = variant.outputs[o.register];
        entries.push([o.buffer, reg === undefined ? 0xFFFF : reg, ((1 << o.components) - 1) << o.start, o.stream]);
        filled[o.buffer] += o.components;
    }
    soid = sub.next_variant++;
    const words = [soid, Math.min(entries.length, 64)];
    for(let i = 0; i < 64; i++) words.push(...(entries[i] || [0, 0, 0, 0]));
    words.push(...so.strides.map(s => s * 4), discard ? INVALID : 0);
    sub.dx(C.SVGA_3D_CMD_DX_DEFINE_STREAMOUTPUT, words);
    variant.soids.set(discard, soid);
    return soid;
};

// ---------------------------------------------------------------------------
// Copies

/**
 * BLIT: S0 (mask, filter, scissor, render condition, alpha blend), scissor,
 * destination (resource, level, format, x, y, z, w, h, d), source (same)
 */
VirglContext.prototype.blit = function(sub, p)
{
    const linear = (p[0] >>> 8 & 3) === 1;
    const dst = this.resource(p[3]), src = this.resource(p[12]);
    if(!dst || !src || !dst.three_d || !src.three_d) return;
    const [dx, dy, dz, dw, dh, dd] = Array.from(p.subarray(6, 12), v => v | 0);
    const [sx, sy, sz, sw, sh, sd] = Array.from(p.subarray(15, 21), v => v | 0);
    const dst_level = p[4], src_level = p[13];
    if(src.nr_samples > 1 && dst.nr_samples <= 1)
    {
        // a multisample resolve
        const info = virgl_format(p[5]);
        sub.dx(C.SVGA_3D_CMD_DX_RESOLVE_COPY, [p[3], dst_level, p[12], src_level, info ? info.svga : 0]);
    }
    else
    {
        const layers = Math.max(1, Math.min(Math.abs(dd), Math.abs(sd)));
        const volume_src = src.target === TARGET.TEXTURE_3D, volume_dst = dst.target === TARGET.TEXTURE_3D;
        for(let i = 0; i < layers; i++)
        {
            if(sw === dw && sh === dh && sw > 0 && sh > 0)
            {
                sub.gx(GX.SURFACE_COPY, [p[12], volume_src ? 0 : sz + i, src_level, sx, sy, volume_src ? sz + i : 0,
                    p[3], volume_dst ? 0 : dz + i, dst_level, dx, dy, volume_dst ? dz + i : 0, sw, sh, 1]);
            }
            else
            {
                sub.gx(GX.SURFACE_STRETCH, [p[12], volume_src ? 0 : sz + i, src_level, sx, sy, sx + sw, sy + sh,
                    p[3], volume_dst ? 0 : dz + i, dst_level, dx, dy, dx + dw, dy + dh, linear ? 1 : 0]);
            }
        }
    }
    this.virgl.wrote(dst);
};

/** RESOURCE_COPY_REGION: destination (resource, level, x, y, z), source (resource, level, x, y, z), size */
VirglContext.prototype.copy_region = function(p)
{
    const dst = this.resource(p[0]), src = this.resource(p[5]);
    if(!dst || !src || !dst.three_d || !src.three_d) return;
    const [dx, dy, dz] = [p[2], p[3], p[4]], [sx, sy, sz] = [p[7], p[8], p[9]], [w, h, d] = [p[10], p[11], p[12]];
    const gxw = this.virgl.gxw;
    if(src.is_buffer())
    {
        gxw.command(GX.SURFACE_COPY, [p[5], 0, 0, sx, 0, 0, p[0], 0, 0, dx, 0, 0, w, 1, 1]);
    }
    else if(src.target === TARGET.TEXTURE_3D)
    {
        gxw.command(GX.SURFACE_COPY, [p[5], 0, p[6], sx, sy, sz, p[0], 0, p[1], dx, dy, dz, w, h, d]);
    }
    else
    {
        for(let i = 0; i < Math.max(1, d); i++)
        {
            gxw.command(GX.SURFACE_COPY, [p[5], sz + i, p[6], sx, sy, 0, p[0], dz + i, p[1], dx, dy, 0, w, h, 1]);
        }
    }
    this.virgl.wrote(dst);
};

// ---------------------------------------------------------------------------
// Queries: the result goes into the query's resource, in guest memory
// (struct virgl_host_query_state: state, result size, result)

VirglContext.prototype.begin_query = function(sub, handle)
{
    const q = sub.objects.get(handle);
    if(!q || q.kind !== OBJECT.QUERY) return;
    if(q.defined) sub.dx(C.SVGA_3D_CMD_DX_BEGIN_QUERY, [handle]);
    else if(q.type === QUERY_PRIMITIVES_GENERATED || q.type === QUERY_PRIMITIVES_EMITTED)
    {
        q.count = 0;
        sub.counting.add(q);
    }
};

VirglContext.prototype.end_query = function(sub, handle)
{
    const q = sub.objects.get(handle);
    if(!q || q.kind !== OBJECT.QUERY) return;
    const r = this.resource(q.res);
    const write = value => {
        if(!r || !r.backing) return;
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 1, true);     // VIRGL_QUERY_STATE_DONE
        view.setUint32(4, 8, true);
        view.setUint32(8, value % 0x100000000, true);
        view.setUint32(12, Math.floor(value / 0x100000000), true);
        this.virgl.gpu.write_backing(r, q.offset, bytes);
    };
    if(!q.defined)
    {
        // primitives counted here; GPU_FINISHED is true, the rest 0
        sub.counting.delete(q);
        write(q.type === QUERY_PRIMITIVES_GENERATED || q.type === QUERY_PRIMITIVES_EMITTED ? q.count : q.type === 11 ? 1 : 0);
        return;
    }
    const id = this.virgl.request(bytes => {
        let value = 0;
        if(bytes && bytes.length >= 8)
        {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            value = view.getUint32(0, true) + view.getUint32(4, true) * 0x100000000;
            if(q.type === 1 || q.type === 2) value = value ? 1 : 0;
        }
        write(value);
    });
    sub.gx(GX.QUERY_END, [sub.cid, handle, q.svga, id, 0]);
};

// ---------------------------------------------------------------------------
// Snapshots: each sub-context's objects (as the commands that made them, or
// a shader's text) and gallium's state; GX gets them again from these

/** The state of the sub-contexts that a snapshot keeps */
const SAVED_STATE = ["fb", "viewport", "scissor", "blend", "dsa", "rasterizer", "elements", "blend_color", "stencil_ref",
    "sample_mask", "vertex_buffers", "index_buffer", "shaders", "views", "samplers", "so_targets", "predication", "buffers", "images"];

VirglContext.prototype.get_state = function()
{
    const subs = [];
    let active = 0;
    for(const [id, sub] of this.subs)
    {
        if(sub === this.sub) active = id;
        const objects = [];
        for(const [handle, o] of sub.objects)
        {
            if(o.kind === OBJECT.SHADER) objects.push([OBJECT.SHADER, handle, o.stage, o.source, o.so_words || null, o.shared]);
            else if(o.create_words) objects.push([o.create_kind, handle, o.create_words]);
        }
        const state = {};
        for(const name of SAVED_STATE) state[name] = sub[name];
        state.cbs = sub.cbs.map(stage => stage.map(cb => cb ? (cb.user ? { user: Array.from(cb.user) } : cb) : null));
        subs.push([id, objects, JSON.stringify(state)]);
    }
    return [this.ctx_id, active, subs];
};

/**
 * @param {!Array} state from get_state
 * @param {function(number):?Object} resource by id
 */
VirglContext.prototype.set_state = function(state, resource)
{
    const [, active, subs] = state;
    this.resource = resource;
    for(const sub of this.subs.values()) sub.destroy();
    this.subs.clear();
    for(const [id, objects, json] of subs)
    {
        const sub = this.sub_context(id);
        for(const o of objects)
        {
            if(o[0] === OBJECT.SHADER) this.define_shader(sub, o[1], o[2], o[3], o[4], o[5]);
            else this.create_object(sub, o[0], Uint32Array.from(o[2], v => v >>> 0));
        }
        const saved = JSON.parse(json);
        for(const name of SAVED_STATE) if(saved[name] !== undefined) sub[name] = saved[name];
        sub.cbs = saved.cbs.map(stage => stage.map(cb => cb && cb.user ? { user: Uint32Array.from(cb.user) } : cb));
        sub.sent.clear();
        // what is sent when it is set, not at draws
        if(sub.so_targets.some(t => t)) this.set_streamout_targets(sub, Uint32Array.from([0xF, ...sub.so_targets]));
        if(sub.predication) sub.dx(C.SVGA_3D_CMD_DX_SET_PREDICATION, sub.predication);
    }
    this.sub = this.sub_context(active);
};
