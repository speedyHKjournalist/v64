// One virgl context: its command stream (VIRGL_CCMD_*, third_party/virgl/
// virgl_protocol.h) decoded command by command. Each command is a header
// dword (command, object type, length in dwords) and its payload.

import { GX } from "../renderer_protocol.js";

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

/**
 * @constructor
 * @param {!Object} virgl the Virgl device side
 * @param {number} ctx_id
 */
export function VirglContext(virgl, ctx_id)
{
    this.virgl = virgl;
    this.ctx_id = ctx_id;
    /** the GX context (the virtio context id) */
    this.cid = ctx_id;
    this.sub_ctx = 0;
    virgl.gxw.command(GX.CONTEXT_DEFINE, [this.cid]);
}

VirglContext.prototype.destroy = function()
{
    this.virgl.gxw.command(GX.CONTEXT_DESTROY, [this.cid]);
};

/** A resource is gone: nothing of this context may name it any more */
VirglContext.prototype.forget_resource = function(id)
{
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
            return;
        case CCMD.CREATE_SUB_CTX:
        case CCMD.SET_SUB_CTX:
            this.sub_ctx = p[0];
            return;
        case CCMD.DESTROY_SUB_CTX:
            return;
        case CCMD.RESOURCE_INLINE_WRITE:
            this.inline_write(p);
            return;
    }
    this.virgl.warn_once("ccmd" + command, "virgl command " + (CCMD_NAMES[command] || command) + " is not supported yet");
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
    let offset = 0;
    this.virgl.transfer_to_host(r, [x, y, z, w, h, d], level, 0, stride, layer_stride, (from, out, to, length) => {
        if(from + length > bytes.length) return false;
        out.set(bytes.subarray(from, from + length), to);
        offset = from + length;
        return true;
    });
};
