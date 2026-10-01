// DX (SVGA_CAP_DX, level dx10 and up; plan section 5.10): the device side of
// VMware's VGPU10 contexts. The renderer side is GX
// (src/browser/glbridge/gx/gx_executor.js); between them go GX batches
// (GXWriter below).
//
// What the device keeps, in the formats the guest knows:
// - each DX context's state as SVGADXContextMobFormat (2048 dwords), which
//   DX_READBACK_CONTEXT writes to the context's MOB and DX_BIND_CONTEXT with
//   valid contents reads back;
// - the object definitions in the context's COTables, guest memory written
//   as objects are defined (and read again when a COTable is set with valid
//   entries, which is how Windows' driver moves and restores them).
// So a snapshot of guest memory holds the DX state; the renderer's objects
// are made again from it.
//
// Commands go to GX nearly as they are: GX.DX carries the context, the
// command id and its body. Definitions loaded from a COTable go as the
// DX_DEFINE_* command they came from. Surfaces a command names are made in
// GX first (svga3d.js gx_surface), filled from their MOB.

import { LOG_VGA } from "../../const.js";
import { dbg_log } from "../../log.js";
import * as C from "./svga_constants.js";

const INVALID = 0xFFFFFFFF;

/** GX batch header magic: "GX10" */
export const GX_MAGIC = 0x30315847;

/** GX opcodes (gx_executor.js has the same) */
export const GX = {
    SURFACE_DEFINE: 1,      // sid, format, flags (64 bits), width, height, depth, mips, layers, samples, cube
    SURFACE_DESTROY: 2,     // sid
    SURFACE_UPLOAD: 3,      // sid, layer, mip, x, y, z, w, h, d, row pitch, slice pitch, then the bytes
    SURFACE_READBACK: 4,    // sid, layer, mip, x, y, z, w, h, d, request id
    CONTEXT_DEFINE: 5,      // cid
    CONTEXT_DESTROY: 6,     // cid
    SHADER_CODE: 7,         // cid, shid, type, then the tokens
    DX: 8,                  // cid, SVGA_3D_CMD_DX_*, then the command's body
    SURFACE_COPY: 9,        // src sid, layer, mip, x, y, z, dst sid, layer, mip, x, y, z, w, h, d
    QUERY_END: 10,          // cid, qid, type, request id
    COTABLE_RESET: 11,      // cid, SVGACOTableType: forget the objects of a type
    SURFACE_STRETCH: 12,    // src sid, layer, mip, l, t, r, b, dst sid, layer, mip, l, t, r, b, linear
    // a surface both GX and D9WG have (D3D9 apps' and DWM's): every image of
    // the D9WG resource into GX's surface, or back
    SURFACE_IMPORT: 13,     // sid, D9WG handle
    SURFACE_EXPORT: 14,     // sid, D9WG handle
};

/** Bytes of a COTable entry, per SVGACOTableType */
export const COTABLE_ENTRY_BYTES = [32, 32, 32, 1024, 128, 16, 32, 64, 2048, 16, 32, 64];

/** SVGADXContextMobFormat: dword offsets */
export const DXCTX = {
    LAYOUT: 0, VERTEX_BUFFERS: 1, INDEX_SID: 97, INDEX_OFFSET: 99, INDEX_FORMAT: 100, TOPOLOGY: 101,
    BLEND: 102, BLEND_FACTOR: 103, SAMPLE_MASK: 107, DEPTH_STENCIL: 108, STENCIL_REF: 109, RASTERIZER: 110,
    DSV: 111, RTVS: 112, SO_TARGETS: 128, SOID: 132, UAV_SPLICE: 143, VIEWPORT_COUNTS: 144,
    VIEWPORTS: 148, SCISSORS: 276, PREDICATION: 404, IFACE_MOB: 406, IFACE_OFFSET: 407,
    SHADER_STATE: 408, SHADER_STATE_DWORDS: 193, QUERIES: 1592, COTABLES: 1656, UAVS: 1732, CS_UAVS: 1796,
    DWORDS: 2048,
};
// within a shader stage's state: shaderId, constantBuffers[16] (sid, offset, size), shaderResources[128], samplers[16]
const STAGE_SHADER = 0, STAGE_CBS = 1, STAGE_SRVS = 49, STAGE_SAMPLERS = 177;

/** The commands among the DX ones' ids that are not DX commands */
const NOT_DX = new Set([
    C.SVGA_3D_CMD_SCREEN_COPY, C.SVGA_3D_CMD_GROW_OTABLE, C.SVGA_3D_CMD_INTRA_SURFACE_COPY,
    C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V3, C.SVGA_3D_CMD_WHOLE_SURFACE_COPY, C.SVGA_3D_CMD_WRITE_ZERO_SURFACE,
    C.SVGA_3D_CMD_UPDATE_ZERO_SURFACE, C.SVGA_3D_CMD_LOGICOPS_BITBLT, C.SVGA_3D_CMD_LOGICOPS_TRANSBLT,
    C.SVGA_3D_CMD_LOGICOPS_STRETCHBLT, C.SVGA_3D_CMD_LOGICOPS_COLORFILL, C.SVGA_3D_CMD_LOGICOPS_ALPHABLEND,
    C.SVGA_3D_CMD_LOGICOPS_CLEARTYPEBLEND, C.SVGA_3D_CMD_UPDATE_GB_SCREENTARGET_V2, C.SVGA_3D_CMD_DEFINE_GB_SURFACE_V4,
    C.SVGA_3D_CMD_SURFACE_STRETCHBLT_NON_MS_TO_MS, C.SVGA_3D_CMD_UPDATE_GB_SCREENTARGET_MOVE,
    C.SVGA_3D_CMD_RESERVED1, C.SVGA_3D_CMD_RESERVED2, C.SVGA_3D_CMD_RESERVED3, C.SVGA_3D_CMD_RESERVED4,
    C.SVGA_3D_CMD_RESERVED5, C.SVGA_3D_CMD_RESERVED6, C.SVGA_3D_CMD_RESERVED7, C.SVGA_3D_CMD_RESERVED8,
]);

/**
 * The DX commands that only move surfaces' contents: Windows' kernel driver
 * sends them outside of DX contexts (present blits to the screen targets)
 */
const SURFACE_ONLY = new Set([
    C.SVGA_3D_CMD_DX_PRESENTBLT, C.SVGA_3D_CMD_DX_PRED_COPY_REGION, C.SVGA_3D_CMD_DX_PRED_COPY,
    C.SVGA_3D_CMD_DX_BUFFER_COPY, C.SVGA_3D_CMD_DX_TRANSFER_FROM_BUFFER, C.SVGA_3D_CMD_DX_PRED_TRANSFER_FROM_BUFFER,
    C.SVGA_3D_CMD_DX_SURFACE_COPY_AND_READBACK, C.SVGA_3D_CMD_DX_UPDATE_SUBRESOURCE, C.SVGA_3D_CMD_DX_READBACK_SUBRESOURCE,
    C.SVGA_3D_CMD_DX_INVALIDATE_SUBRESOURCE, C.SVGA_3D_CMD_DX_BUFFER_UPDATE, C.SVGA_3D_CMD_DX_RESOLVE_COPY,
    C.SVGA_3D_CMD_DX_PRED_RESOLVE_COPY, C.SVGA_3D_CMD_DX_PRED_CONVERT_REGION, C.SVGA_3D_CMD_DX_PRED_CONVERT,
    C.SVGA_3D_CMD_DX_PRED_STAGING_COPY, C.SVGA_3D_CMD_DX_STAGING_COPY, C.SVGA_3D_CMD_DX_PRED_STAGING_COPY_REGION,
    C.SVGA_3D_CMD_DX_PRED_STAGING_CONVERT_REGION, C.SVGA_3D_CMD_DX_PRED_STAGING_CONVERT,
    C.SVGA_3D_CMD_DX_STAGING_BUFFER_COPY, C.SVGA_3D_CMD_DX_TRANSFER_TO_BUFFER,
]);

/** Query results (SVGADXQueryResultUnion member sizes), by type */
const QUERY_RESULT_BYTES = [4, 8, 12, 88, 4, 16, 4, 8, 16, 16, 16, 16, 4, 4, 4, 4];

/**
 * A GX batch being written: dwords
 * @constructor
 */
export function GXWriter()
{
    this.words = new Uint32Array(1 << 14);
    this.length = 4;
    this.count = 0;
    /** @type {?function()} called before each command: the other stream is sent first */
    this.before = null;
}

GXWriter.prototype.empty = function()
{
    return this.count === 0;
};

/** @return {number} bytes so far */
GXWriter.prototype.size = function()
{
    return this.length * 4;
};

GXWriter.prototype.reserve = function(dwords)
{
    if(this.length + dwords <= this.words.length) return;
    let capacity = this.words.length;
    while(capacity < this.length + dwords) capacity *= 2;
    const bigger = new Uint32Array(capacity);
    bigger.set(this.words.subarray(0, this.length));
    this.words = bigger;
};

/**
 * A command: its opcode, its dwords, then maybe bytes (padded to dwords)
 * @param {number} op
 * @param {!IArrayLike<number>} dwords
 * @param {Uint8Array=} bytes
 */
GXWriter.prototype.command = function(op, dwords, bytes)
{
    if(this.before) this.before();
    const byte_count = bytes ? bytes.length : 0;
    const body = dwords.length + (byte_count + 3 >> 2);
    this.reserve(2 + body);
    const w = this.words;
    w[this.length++] = op;
    w[this.length++] = body;
    for(let i = 0; i < dwords.length; i++) w[this.length++] = dwords[i];
    if(bytes)
    {
        const tail = new Uint8Array(w.buffer, this.length * 4, body * 4 - dwords.length * 4);
        tail.fill(0);
        tail.set(bytes);
        this.length += byte_count + 3 >> 2;
    }
    this.count++;
};

/**
 * The batch: header (magic, version, dwords, commands), then the commands
 * @return {!Uint8Array}
 */
GXWriter.prototype.finish = function()
{
    const w = this.words;
    w[0] = GX_MAGIC;
    w[1] = 1;
    w[2] = this.length;
    w[3] = this.count;
    const bytes = new Uint8Array(w.buffer.slice(0, this.length * 4));
    this.length = 4;
    this.count = 0;
    return bytes;
};

/**
 * One DX context
 * @constructor
 */
function DXContext(cid)
{
    this.cid = cid;
    this.mob = INVALID;
    /** SVGADXContextMobFormat */
    this.state = new Uint32Array(DXCTX.DWORDS);
    for(let i = 0; i < C.SVGA_COTABLE_MAX; i++) this.state[DXCTX.COTABLES + i] = INVALID;
    this.state[DXCTX.SAMPLE_MASK] = INVALID;
    /** @type {!Array<!Map<number, number>>} view id -> sid, for RTVs, DSVs, SRVs, UAVs */
    this.views = [new Map(), new Map(), new Map(), new Map()];
    /** @type {!Map<number, !Array<number>>} shader id -> [type, size], also without a COTable */
    this.shaders = new Map();
}

const VIEW_RTV = 0, VIEW_DSV = 1, VIEW_SRV = 2, VIEW_UAV = 3;

/**
 * @constructor
 * @param {!Object} svga3d the SVGA3D that owns the surfaces and the renderer channel
 */
export function DXDevice(svga3d)
{
    this.s = svga3d;
    /** @type {!Map<number, !DXContext>} */
    this.contexts = new Map();
    /** @type {DXContext} */
    this.device_dx = null;
}

DXDevice.prototype.reset = function()
{
    this.contexts.clear();
    this.device_dx = null;
};

DXDevice.prototype.warn = function(key, text)
{
    this.s.warn_once("dx-" + key, text);
};

/** The GX writer, as the stream now being written */
DXDevice.prototype.gx = function()
{
    return this.s.gx_writer();
};

DXDevice.prototype.forward = function(cid, id, p)
{
    const words = new Uint32Array(2 + p.length);
    words[0] = cid;
    words[1] = id;
    words.set(new Uint32Array(p.buffer, p.byteOffset, p.length), 2);
    this.gx().command(GX.DX, words);
};

/**
 * Make sure a surface a command names is in GX, with its newest contents (0
 * or INVALID name none)
 * @param {boolean=} write whether DX will change it
 */
DXDevice.prototype.surface = function(sid, write)
{
    if(sid === INVALID || sid === 0 && !this.s.surfaces.has(0)) return null;
    const surface = this.s.surfaces.get(sid);
    if(!surface)
    {
        this.warn("sid", "a DX command names an undefined surface");
        return null;
    }
    this.s.gx_surface(surface, write);
    return surface;
};

/** ... and that the GPU will write it */
DXDevice.prototype.written = function(sid)
{
    const surface = this.surface(sid, true);
    if(surface) surface.host_newer = true;
};

/**
 * Before a draw: surfaces legacy 3D changed since come over, and the bound
 * targets are written (the D3D9 driver and DWM share surfaces)
 */
DXDevice.prototype.drawing = function(context)
{
    const s = this.s;
    if(!s.duals.size) return;
    for(const surface of s.duals) if(surface.home === "d9wg" && surface.stale) s.gx_surface(surface);
    const st = context.state;
    const mark = (kind, view) => {
        const sid = context.views[kind].get(view);
        const surface = sid === undefined ? null : s.surfaces.get(sid);
        if(surface && surface.in_d9) s.gx_surface(surface, true);
    };
    mark(VIEW_DSV, st[DXCTX.DSV]);
    for(let i = 0; i < 8; i++) mark(VIEW_RTV, st[DXCTX.RTVS + i]);
};

// ---------------------------------------------------------------------------
// COTables

/** The COTable entry of an object, in guest memory */
DXDevice.prototype.write_entry = function(context, type, id, dwords)
{
    const mob = context.state[DXCTX.COTABLES + type];
    if(mob === INVALID) return;
    const size = COTABLE_ENTRY_BYTES[type];
    const bytes = new Uint8Array(size);
    if(dwords) bytes.set(new Uint8Array(Uint32Array.from(dwords, v => v >>> 0).buffer).subarray(0, size));
    this.s.device.mobs.write(mob, id * size, bytes);
};

DXDevice.prototype.read_entry = function(context, type, id)
{
    const mob = context.state[DXCTX.COTABLES + type];
    const size = COTABLE_ENTRY_BYTES[type];
    const bytes = mob === INVALID ? null : this.s.device.mobs.read(mob, id * size, size);
    return bytes ? new Uint32Array(bytes.buffer, bytes.byteOffset, size >> 2) : null;
};

/**
 * The DX_DEFINE_* command (id, body) that makes an object a COTable entry
 * describes, or null for an empty entry
 * @param {!Uint32Array} e
 * @return {Array}
 */
function entry_command(type, id, e)
{
    if(e.every(v => v === 0)) return null;
    switch(type)
    {
        case C.SVGA_COTABLE_RTVIEW:
            return [C.SVGA_3D_CMD_DX_DEFINE_RENDERTARGET_VIEW, [id, e[0], e[1], e[2], e[3], e[4], e[5]]];
        case C.SVGA_COTABLE_DSVIEW:
            return [C.SVGA_3D_CMD_DX_DEFINE_DEPTHSTENCIL_VIEW_V2, [id, e[0], e[1], e[2], e[3], e[4], e[5], e[6]]];
        case C.SVGA_COTABLE_SRVIEW:
            return [C.SVGA_3D_CMD_DX_DEFINE_SHADERRESOURCE_VIEW, [id, e[0], e[1], e[2], e[3], e[4], e[5], e[6]]];
        case C.SVGA_COTABLE_ELEMENTLAYOUT:
        {
            const count = Math.min(e[1], 32);
            return [C.SVGA_3D_CMD_DX_DEFINE_ELEMENTLAYOUT, [id, ...e.subarray(2, 2 + 6 * count)]];
        }
        case C.SVGA_COTABLE_BLENDSTATE:
            return [C.SVGA_3D_CMD_DX_DEFINE_BLEND_STATE, [id, ...e.subarray(0, 25)]];
        case C.SVGA_COTABLE_DEPTHSTENCIL:
            return [C.SVGA_3D_CMD_DX_DEFINE_DEPTHSTENCIL_STATE, [id, ...e.subarray(0, 4)]];
        case C.SVGA_COTABLE_RASTERIZERSTATE:
            return [C.SVGA_3D_CMD_DX_DEFINE_RASTERIZER_STATE_V2, [id, ...e.subarray(0, 7), e[7] & 0xFF]];
        case C.SVGA_COTABLE_SAMPLER:
            return [C.SVGA_3D_CMD_DX_DEFINE_SAMPLER_STATE, [id, ...e.subarray(0, 10)]];
        case C.SVGA_COTABLE_DXQUERY:
            return [C.SVGA_3D_CMD_DX_DEFINE_QUERY, [id, e[0] & 0xFF, e[1]]];
        case C.SVGA_COTABLE_UAVIEW:
            return [C.SVGA_3D_CMD_DX_DEFINE_UA_VIEW, [id, ...e.subarray(0, 8)]];
        case C.SVGA_COTABLE_STREAMOUTPUT:
            return [C.SVGA_3D_CMD_DX_DEFINE_STREAMOUTPUT, [id, ...e.subarray(0, 1 + 256 + 4 + 1)]];
    }
    return null;
}

/**
 * The objects a COTable holds (its first `count` entries) are defined in GX
 */
DXDevice.prototype.load_cotable = function(context, type, count)
{
    const gx = this.gx();
    gx.command(GX.COTABLE_RESET, [context.cid, type]);
    const view = { [C.SVGA_COTABLE_RTVIEW]: VIEW_RTV, [C.SVGA_COTABLE_DSVIEW]: VIEW_DSV,
        [C.SVGA_COTABLE_SRVIEW]: VIEW_SRV, [C.SVGA_COTABLE_UAVIEW]: VIEW_UAV }[type];
    if(view !== undefined) context.views[view].clear();
    for(let id = 0; id < count; id++)
    {
        const e = this.read_entry(context, type, id);
        if(!e) break;
        if(type === C.SVGA_COTABLE_DXSHADER)
        {
            // type, size, offset, mob: defined, and bound if it has a MOB
            if(!e[0] && !e[1]) continue;
            context.shaders.set(id, [e[0], e[1]]);
            this.forward(context.cid, C.SVGA_3D_CMD_DX_DEFINE_SHADER, Uint32Array.of(id, e[0], e[1]));
            if(e[3] !== INVALID) this.shader_code(context, id, e[0], e[1], e[3], e[2]);
            continue;
        }
        const command = entry_command(type, id, e);
        if(!command) continue;
        this.define(context, command[0], Uint32Array.from(command[1], v => v >>> 0), false);
    }
};

// ---------------------------------------------------------------------------
// Commands

/**
 * One DX command
 * @param {number} id
 * @param {!Int32Array} body
 * @param {number} cid the context of the command buffer it came in
 * @return {boolean} whether it was one of these
 */
DXDevice.prototype.command = function(id, body, cid)
{
    if(id < C.SVGA_3D_CMD_DX_MIN || id > C.SVGA_3D_CMD_DX_STAGING_BUFFER_COPY || NOT_DX.has(id)) return false;
    const p = new Uint32Array(body.buffer, body.byteOffset, body.length);
    // the commands that name their context themselves
    switch(id)
    {
        case C.SVGA_3D_CMD_DX_DEFINE_CONTEXT: this.define_context(p[0]); return true;
        case C.SVGA_3D_CMD_DX_DESTROY_CONTEXT: this.destroy_context(p[0]); return true;
        case C.SVGA_3D_CMD_DX_BIND_CONTEXT: this.bind_context(p[0], p[1], p[2]); return true;
        case C.SVGA_3D_CMD_DX_READBACK_CONTEXT: this.readback_context(p[0]); return true;
        case C.SVGA_3D_CMD_DX_INVALIDATE_CONTEXT: return true;
        case C.SVGA_3D_CMD_DX_SET_COTABLE:
        case C.SVGA_3D_CMD_DX_GROW_COTABLE:
            this.set_cotable(p[0], p[1], p[2], p[3], id === C.SVGA_3D_CMD_DX_GROW_COTABLE);
            return true;
        case C.SVGA_3D_CMD_DX_READBACK_COTABLE: return true;
        case C.SVGA_3D_CMD_DX_COPY_COTABLE_INTO_MOB: this.copy_cotable(p[0], p[1], p[2]); return true;
        case C.SVGA_3D_CMD_DX_BIND_SHADER: this.bind_shader(p[0], p[1], p[2], p[3]); return true;
        case C.SVGA_3D_CMD_DX_BIND_ALL_SHADER: this.bind_all_shaders(p[0], INVALID, p[1], false); return true;
        case C.SVGA_3D_CMD_DX_COND_BIND_ALL_SHADER: this.bind_all_shaders(p[0], p[1], p[2], true); return true;
        case C.SVGA_3D_CMD_DX_BIND_ALL_QUERY: this.bind_all_queries(p[0], p[1]); return true;
        case C.SVGA_3D_CMD_DX_READBACK_ALL_QUERY: return true;
        case C.SVGA_3D_CMD_DX_MOB_FENCE_64: this.mob_fence(p[0], p[1], p[2], p[3]); return true;
        case C.SVGA_3D_CMD_DX_BIND_SHADER_IFACE: return true;
        case C.SVGA_3D_CMD_DX_HINT: return true;
    }
    let context = this.contexts.get(cid);
    if(!context && SURFACE_ONLY.has(id)) context = this.device_context();
    if(!context)
    {
        this.warn("cid", "a DX command (" + id + ") outside of a DX context");
        return true;
    }
    if(this.define(context, id, p, true)) return true;
    this.state_command(context, id, p);
    return true;
};

/** The context of the surface-only commands that come without one */
DXDevice.prototype.device_context = function()
{
    if(!this.device_dx)
    {
        this.device_dx = new DXContext(INVALID);
        this.gx().command(GX.CONTEXT_DEFINE, [INVALID]);
    }
    return this.device_dx;
};

DXDevice.prototype.define_context = function(cid)
{
    this.contexts.set(cid, new DXContext(cid));
    this.s.otable(C.SVGA_OTABLE_DXCONTEXT, cid, [cid, INVALID]);
    this.gx().command(GX.CONTEXT_DEFINE, [cid]);
};

DXDevice.prototype.destroy_context = function(cid)
{
    this.contexts.delete(cid);
    this.s.otable(C.SVGA_OTABLE_DXCONTEXT, cid, null);
    this.gx().command(GX.CONTEXT_DESTROY, [cid]);
};

DXDevice.prototype.bind_context = function(cid, mob, valid)
{
    let context = this.contexts.get(cid);
    if(!context)
    {
        this.warn("bind-undefined", "binding an undefined DX context");
        return;
    }
    context.mob = mob;
    this.s.otable(C.SVGA_OTABLE_DXCONTEXT, cid, [cid, mob]);
    if(!valid || mob === INVALID) return;
    // the guest gives the context back (after it lost the device, or moved
    // it): its state from the MOB, its objects from its COTables
    const bytes = this.s.device.mobs.read(mob, 0, DXCTX.DWORDS * 4);
    if(!bytes) return this.warn("context-mob", "a DX context MOB too small");
    context.state.set(new Uint32Array(bytes.buffer, bytes.byteOffset, DXCTX.DWORDS));
    this.restore(context);
};

DXDevice.prototype.readback_context = function(cid)
{
    const context = this.contexts.get(cid);
    if(!context || context.mob === INVALID) return;
    this.s.device.mobs.write(context.mob, 0, new Uint8Array(context.state.buffer));
};

/**
 * GX gets a context again: the objects of its COTables, then its state
 */
DXDevice.prototype.restore = function(context)
{
    const st = context.state, cid = context.cid;
    for(let type = 0; type < C.SVGA_COTABLE_MAX; type++)
    {
        const mob = st[DXCTX.COTABLES + type];
        if(mob === INVALID) continue;
        const size = this.s.device.mobs.size(mob);
        this.load_cotable(context, type, Math.max(0, Math.floor(size / COTABLE_ENTRY_BYTES[type])));
    }
    const send = (id, words) => this.state_command(context, id, Uint32Array.from(words, v => v >>> 0));
    send(C.SVGA_3D_CMD_DX_SET_INPUT_LAYOUT, [st[DXCTX.LAYOUT]]);
    const buffers = [0];
    for(let i = 0; i < 32; i++) buffers.push(...st.subarray(DXCTX.VERTEX_BUFFERS + 3 * i, DXCTX.VERTEX_BUFFERS + 3 * i + 3));
    send(C.SVGA_3D_CMD_DX_SET_VERTEX_BUFFERS, buffers);
    send(C.SVGA_3D_CMD_DX_SET_INDEX_BUFFER, [st[DXCTX.INDEX_SID], st[DXCTX.INDEX_FORMAT], st[DXCTX.INDEX_OFFSET]]);
    send(C.SVGA_3D_CMD_DX_SET_TOPOLOGY, [st[DXCTX.TOPOLOGY]]);
    send(C.SVGA_3D_CMD_DX_SET_BLEND_STATE, [st[DXCTX.BLEND], ...st.subarray(DXCTX.BLEND_FACTOR, DXCTX.BLEND_FACTOR + 4), st[DXCTX.SAMPLE_MASK]]);
    send(C.SVGA_3D_CMD_DX_SET_DEPTHSTENCIL_STATE, [st[DXCTX.DEPTH_STENCIL], st[DXCTX.STENCIL_REF]]);
    send(C.SVGA_3D_CMD_DX_SET_RASTERIZER_STATE, [st[DXCTX.RASTERIZER]]);
    send(C.SVGA_3D_CMD_DX_SET_RENDERTARGETS, [st[DXCTX.DSV], ...st.subarray(DXCTX.RTVS, DXCTX.RTVS + 8)]);
    const viewports = st[DXCTX.VIEWPORT_COUNTS] & 0xFF, scissors = st[DXCTX.VIEWPORT_COUNTS] >> 8 & 0xFF;
    send(C.SVGA_3D_CMD_DX_SET_VIEWPORTS, [0, ...st.subarray(DXCTX.VIEWPORTS, DXCTX.VIEWPORTS + 6 * viewports)]);
    send(C.SVGA_3D_CMD_DX_SET_SCISSORRECTS, [0, ...st.subarray(DXCTX.SCISSORS, DXCTX.SCISSORS + 4 * scissors)]);
    for(let type = C.SVGA3D_SHADERTYPE_MIN; type < C.SVGA3D_SHADERTYPE_MAX; type++)
    {
        const at = DXCTX.SHADER_STATE + (type - C.SVGA3D_SHADERTYPE_MIN) * DXCTX.SHADER_STATE_DWORDS;
        send(C.SVGA_3D_CMD_DX_SET_SHADER, [st[at + STAGE_SHADER], type]);
        for(let slot = 0; slot < 16; slot++)
        {
            const cb = at + STAGE_CBS + 3 * slot;
            send(C.SVGA_3D_CMD_DX_SET_SINGLE_CONSTANT_BUFFER, [slot, type, st[cb], st[cb + 1], st[cb + 2]]);
        }
        send(C.SVGA_3D_CMD_DX_SET_SHADER_RESOURCES, [0, type, ...st.subarray(at + STAGE_SRVS, at + STAGE_SRVS + 128)]);
        send(C.SVGA_3D_CMD_DX_SET_SAMPLERS, [0, type, ...st.subarray(at + STAGE_SAMPLERS, at + STAGE_SAMPLERS + 16)]);
    }
    send(C.SVGA_3D_CMD_DX_SET_SOTARGETS, [0, ...[0, 1, 2, 3].flatMap(i => [st[DXCTX.SO_TARGETS + i], 0, INVALID])]);
    send(C.SVGA_3D_CMD_DX_SET_STREAMOUTPUT, [st[DXCTX.SOID]]);
    send(C.SVGA_3D_CMD_DX_SET_PREDICATION, [st[DXCTX.PREDICATION], st[DXCTX.PREDICATION + 1]]);
    send(C.SVGA_3D_CMD_DX_SET_UA_VIEWS, [st[DXCTX.UAV_SPLICE], ...st.subarray(DXCTX.UAVS, DXCTX.UAVS + 64)]);
    send(C.SVGA_3D_CMD_DX_SET_CS_UA_VIEWS, [0, ...st.subarray(DXCTX.CS_UAVS, DXCTX.CS_UAVS + 64)]);
};

DXDevice.prototype.set_cotable = function(cid, mob, type, valid, grow)
{
    const context = this.contexts.get(cid);
    if(!context || type >= C.SVGA_COTABLE_MAX) return;
    const old = context.state[DXCTX.COTABLES + type];
    if(grow && old !== INVALID && mob !== INVALID)
    {
        // the device moves the valid entries into the new table
        const bytes = this.s.device.mobs.read(old, 0, Math.min(valid, this.s.device.mobs.size(old)));
        if(bytes) this.s.device.mobs.write(mob, 0, bytes);
    }
    context.state[DXCTX.COTABLES + type] = mob;
    if(grow) return;
    this.load_cotable(context, type, mob === INVALID ? 0 : Math.floor(valid / COTABLE_ENTRY_BYTES[type]));
};

DXDevice.prototype.copy_cotable = function(cid, type, mob)
{
    const context = this.contexts.get(cid);
    const from = context ? context.state[DXCTX.COTABLES + type] : INVALID;
    if(from === INVALID) return;
    const bytes = this.s.device.mobs.read(from, 0, Math.min(this.s.device.mobs.size(from), this.s.device.mobs.size(mob)));
    if(bytes) this.s.device.mobs.write(mob, 0, bytes);
};

/**
 * DX_DEFINE_* and DX_DESTROY_* of the objects in COTables
 * @param {boolean} entry whether to write the COTable entry (not when it came from there)
 * @return {boolean} whether it was one
 */
DXDevice.prototype.define = function(context, id, p, entry)
{
    const cid = context.cid;
    const write = (type, object, dwords) => { if(entry) this.write_entry(context, type, object, dwords); };
    switch(id)
    {
        case C.SVGA_3D_CMD_DX_DEFINE_RENDERTARGET_VIEW:
            context.views[VIEW_RTV].set(p[0], p[1]);
            this.written(p[1]);
            write(C.SVGA_COTABLE_RTVIEW, p[0], p.subarray(1, 7));
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_DEPTHSTENCIL_VIEW:
        case C.SVGA_3D_CMD_DX_DEFINE_DEPTHSTENCIL_VIEW_V2:
            context.views[VIEW_DSV].set(p[0], p[1]);
            this.written(p[1]);
            write(C.SVGA_COTABLE_DSVIEW, p[0], [...p.subarray(1, 7), p[7] & 0xFF]);
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_SHADERRESOURCE_VIEW:
            context.views[VIEW_SRV].set(p[0], p[1]);
            this.surface(p[1]);
            write(C.SVGA_COTABLE_SRVIEW, p[0], p.subarray(1, 8));
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_UA_VIEW:
            context.views[VIEW_UAV].set(p[0], p[1]);
            this.written(p[1]);
            write(C.SVGA_COTABLE_UAVIEW, p[0], p.subarray(1, 9));
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_ELEMENTLAYOUT:
        {
            const count = Math.min(32, Math.floor((p.length - 1) / 6));
            write(C.SVGA_COTABLE_ELEMENTLAYOUT, p[0], [p[0], count, ...p.subarray(1, 1 + 6 * count)]);
            break;
        }
        case C.SVGA_3D_CMD_DX_DEFINE_BLEND_STATE:
            write(C.SVGA_COTABLE_BLENDSTATE, p[0], p.subarray(1, 26));
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_DEPTHSTENCIL_STATE:
            write(C.SVGA_COTABLE_DEPTHSTENCIL, p[0], p.subarray(1, 5));
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_RASTERIZER_STATE:
            write(C.SVGA_COTABLE_RASTERIZERSTATE, p[0], [...p.subarray(1, 8), 0]);
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_RASTERIZER_STATE_V2:
            write(C.SVGA_COTABLE_RASTERIZERSTATE, p[0], [...p.subarray(1, 8), p[8] & 0xFF]);
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_SAMPLER_STATE:
            write(C.SVGA_COTABLE_SAMPLER, p[0], p.subarray(1, 11));
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_QUERY:
            // type, state (new), flags, no MOB yet
            write(C.SVGA_COTABLE_DXQUERY, p[0], [p[1] & 0xFF | C.SVGADX_QDSTATE_IDLE << 24, p[2], INVALID, 0]);
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_SHADER:
            context.shaders.set(p[0], [p[1], p[2]]);
            write(C.SVGA_COTABLE_DXSHADER, p[0], [p[1], p[2], 0, INVALID]);
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_STREAMOUTPUT:
            write(C.SVGA_COTABLE_STREAMOUTPUT, p[0], [...p.subarray(1, 1 + 1 + 256 + 4 + 1), 4, INVALID, 0, 0]);
            break;
        case C.SVGA_3D_CMD_DX_DEFINE_STREAMOUTPUT_WITH_MOB:
            // decls come with DX_BIND_STREAMOUTPUT
            write(C.SVGA_COTABLE_STREAMOUTPUT, p[0], [p[1], ...new Array(256).fill(0), ...p.subarray(3, 8), p[2], INVALID, 0, 1]);
            break;
        case C.SVGA_3D_CMD_DX_BIND_STREAMOUTPUT:
        {
            // soid, mobid, offset, size: the declarations are in the MOB
            const bytes = this.s.device.mobs.read(p[1], p[2], p[3]);
            if(!bytes) break;
            const decls = new Uint32Array(bytes.slice().buffer);
            this.forward(cid, id, Uint32Array.of(p[0], p[1], p[2], p[3], ...decls));
            return true;
        }
        case C.SVGA_3D_CMD_DX_DESTROY_RENDERTARGET_VIEW:
            context.views[VIEW_RTV].delete(p[0]);
            write(C.SVGA_COTABLE_RTVIEW, p[0], null);
            break;
        case C.SVGA_3D_CMD_DX_DESTROY_DEPTHSTENCIL_VIEW:
            context.views[VIEW_DSV].delete(p[0]);
            write(C.SVGA_COTABLE_DSVIEW, p[0], null);
            break;
        case C.SVGA_3D_CMD_DX_DESTROY_SHADERRESOURCE_VIEW:
            context.views[VIEW_SRV].delete(p[0]);
            write(C.SVGA_COTABLE_SRVIEW, p[0], null);
            break;
        case C.SVGA_3D_CMD_DX_DESTROY_UA_VIEW:
            context.views[VIEW_UAV].delete(p[0]);
            write(C.SVGA_COTABLE_UAVIEW, p[0], null);
            break;
        case C.SVGA_3D_CMD_DX_DESTROY_ELEMENTLAYOUT: write(C.SVGA_COTABLE_ELEMENTLAYOUT, p[0], null); break;
        case C.SVGA_3D_CMD_DX_DESTROY_BLEND_STATE: write(C.SVGA_COTABLE_BLENDSTATE, p[0], null); break;
        case C.SVGA_3D_CMD_DX_DESTROY_DEPTHSTENCIL_STATE: write(C.SVGA_COTABLE_DEPTHSTENCIL, p[0], null); break;
        case C.SVGA_3D_CMD_DX_DESTROY_RASTERIZER_STATE: write(C.SVGA_COTABLE_RASTERIZERSTATE, p[0], null); break;
        case C.SVGA_3D_CMD_DX_DESTROY_SAMPLER_STATE: write(C.SVGA_COTABLE_SAMPLER, p[0], null); break;
        case C.SVGA_3D_CMD_DX_DESTROY_QUERY: write(C.SVGA_COTABLE_DXQUERY, p[0], null); break;
        case C.SVGA_3D_CMD_DX_DESTROY_SHADER:
            context.shaders.delete(p[0]);
            write(C.SVGA_COTABLE_DXSHADER, p[0], null);
            break;
        case C.SVGA_3D_CMD_DX_DESTROY_STREAMOUTPUT: write(C.SVGA_COTABLE_STREAMOUTPUT, p[0], null); break;
        default:
            return false;
    }
    this.forward(cid, id, p);
    return true;
};

/**
 * DX_BIND_SHADER: cid, shid, mobid, offset: the tokens are read now
 */
DXDevice.prototype.bind_shader = function(cid, shid, mob, offset)
{
    const context = this.contexts.get(cid);
    if(!context) return;
    const e = this.read_entry(context, C.SVGA_COTABLE_DXSHADER, shid);
    const known = context.shaders.get(shid);
    const type = e && e[1] ? e[0] : known ? known[0] : 0, size = e && e[1] ? e[1] : known ? known[1] : 0;
    this.write_entry(context, C.SVGA_COTABLE_DXSHADER, shid, [type, size, offset, mob]);
    if(mob !== INVALID) this.shader_code(context, shid, type, size, mob, offset);
};

DXDevice.prototype.shader_code = function(context, shid, type, size, mob, offset)
{
    const bytes = size ? this.s.device.mobs.read(mob, offset, size & ~3) : null;
    if(!bytes) return this.warn("shader-mob", "a DX shader outside of its MOB");
    // (a test's hook: tests/x64/windows_boot.mjs, "dxshaders")
    if(this.s.shader_log) this.s.shader_log(shid, type, bytes);
    this.gx().command(GX.SHADER_CODE, [context.cid, shid, type], bytes);
};

/** DX_(COND_)BIND_ALL_SHADER: every shader (bound to test_mob) moves to a MOB */
DXDevice.prototype.bind_all_shaders = function(cid, test_mob, mob, conditional)
{
    const context = this.contexts.get(cid);
    const table = context ? context.state[DXCTX.COTABLES + C.SVGA_COTABLE_DXSHADER] : INVALID;
    if(table === INVALID) return;
    const count = Math.floor(this.s.device.mobs.size(table) / COTABLE_ENTRY_BYTES[C.SVGA_COTABLE_DXSHADER]);
    for(let shid = 0; shid < count; shid++)
    {
        const e = this.read_entry(context, C.SVGA_COTABLE_DXSHADER, shid);
        if(!e || !e[1] || e[3] === INVALID || conditional && e[3] !== test_mob) continue;
        this.bind_shader(cid, shid, mob, e[2]);
    }
};

// ---------------------------------------------------------------------------
// Queries: results in MOBs (SVGA3dQueryState, then the result)

DXDevice.prototype.query_entry = function(context, qid)
{
    return this.read_entry(context, C.SVGA_COTABLE_DXQUERY, qid);
};

DXDevice.prototype.end_query = function(context, qid)
{
    const e = this.query_entry(context, qid);
    if(!e) return this.warn("query", "a query without a COTable entry");
    const type = e[0] & 0xFF, mob = e[2], offset = e[3];
    const result_bytes = QUERY_RESULT_BYTES[type] || 4;
    const write = (state, value) => {
        if(mob === INVALID) return;
        const bytes = new Uint8Array(4 + result_bytes);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, state, true);
        if(value) bytes.set(value.subarray(0, Math.min(result_bytes, value.length)), 4);
        this.s.device.mobs.write(mob, offset, bytes);
    };
    write(C.SVGA3D_QUERYSTATE_PENDING, null);
    const request = this.s.request((value, status) => {
        write(status === 1 ? C.SVGA3D_QUERYSTATE_SUCCEEDED : C.SVGA3D_QUERYSTATE_FAILED, value);
    });
    this.gx().command(GX.QUERY_END, [context.cid, qid, type, request.id, request.slot]);
};

DXDevice.prototype.bind_all_queries = function(cid, mob)
{
    const context = this.contexts.get(cid);
    const table = context ? context.state[DXCTX.COTABLES + C.SVGA_COTABLE_DXQUERY] : INVALID;
    if(table === INVALID) return;
    const count = Math.floor(this.s.device.mobs.size(table) / 16);
    for(let qid = 0; qid < count; qid++)
    {
        const e = this.query_entry(context, qid);
        if(!e || e.every(v => v === 0)) continue;
        e[2] = mob;
        this.write_entry(context, C.SVGA_COTABLE_DXQUERY, qid, e);
    }
};

/** DX_MOB_FENCE_64: a 64-bit value into a MOB once the work before it is done */
DXDevice.prototype.mob_fence = function(low, high, mob, offset)
{
    this.s.after_work(() => {
        this.s.device.mobs.write(mob, offset, new Uint8Array(Uint32Array.of(low, high).buffer));
        this.s.device.set_irq(C.SVGA_IRQFLAG_MOB_FENCE);
    });
};

// ---------------------------------------------------------------------------
// State, draws, copies, transfers

DXDevice.prototype.stage = function(type)
{
    return type >= C.SVGA3D_SHADERTYPE_MIN && type < C.SVGA3D_SHADERTYPE_MAX ?
        DXCTX.SHADER_STATE + (type - C.SVGA3D_SHADERTYPE_MIN) * DXCTX.SHADER_STATE_DWORDS : -1;
};

DXDevice.prototype.state_command = function(context, id, p)
{
    const st = context.state, cid = context.cid;
    const view_sid = (kind, view) => context.views[kind].get(view);
    switch(id)
    {
        case C.SVGA_3D_CMD_DX_SET_SINGLE_CONSTANT_BUFFER:
        {
            // slot, type, sid, offset, size
            const at = this.stage(p[1]);
            if(at < 0 || p[0] >= 16) return;
            st.set([p[2], p[3], p[4]], at + STAGE_CBS + 3 * p[0]);
            this.surface(p[2]);
            break;
        }
        case C.SVGA_3D_CMD_DX_SET_SHADER_RESOURCES:
        {
            const at = this.stage(p[1]);
            if(at < 0) return;
            const ids = p.subarray(2, 2 + Math.max(0, Math.min(p.length - 2, 128 - p[0])));
            st.set(ids, at + STAGE_SRVS + p[0]);
            break;
        }
        case C.SVGA_3D_CMD_DX_SET_SAMPLERS:
        {
            const at = this.stage(p[1]);
            if(at < 0) return;
            st.set(p.subarray(2, 2 + Math.max(0, Math.min(p.length - 2, 16 - p[0]))), at + STAGE_SAMPLERS + p[0]);
            break;
        }
        case C.SVGA_3D_CMD_DX_SET_SHADER:
        {
            const at = this.stage(p[1]);
            if(at < 0) return;
            st[at + STAGE_SHADER] = p[0];
            break;
        }
        case C.SVGA_3D_CMD_DX_SET_INPUT_LAYOUT:
            st[DXCTX.LAYOUT] = p[0];
            break;
        case C.SVGA_3D_CMD_DX_SET_VERTEX_BUFFERS:
        case C.SVGA_3D_CMD_DX_SET_VERTEX_BUFFERS_V2:
        {
            // startBuffer, then (sid, stride, offset[, size]) each
            const each = id === C.SVGA_3D_CMD_DX_SET_VERTEX_BUFFERS ? 3 : 4;
            for(let i = 0; 1 + each * (i + 1) <= p.length && p[0] + i < 32; i++)
            {
                const b = 1 + each * i;
                st.set([p[b], p[b + 1], p[b + 2]], DXCTX.VERTEX_BUFFERS + 3 * (p[0] + i));
                this.surface(p[b]);
            }
            break;
        }
        case C.SVGA_3D_CMD_DX_SET_VERTEX_BUFFERS_OFFSET_AND_SIZE:
            for(let i = 0; 1 + 3 * (i + 1) <= p.length && p[0] + i < 32; i++)
            {
                const b = 1 + 3 * i;
                st.set([p[b], p[b + 1]], DXCTX.VERTEX_BUFFERS + 3 * (p[0] + i) + 1);
            }
            break;
        case C.SVGA_3D_CMD_DX_SET_INDEX_BUFFER:
        case C.SVGA_3D_CMD_DX_SET_INDEX_BUFFER_V2:
            st[DXCTX.INDEX_SID] = p[0];
            st[DXCTX.INDEX_FORMAT] = p[1];
            st[DXCTX.INDEX_OFFSET] = p[2];
            this.surface(p[0]);
            break;
        case C.SVGA_3D_CMD_DX_SET_INDEX_BUFFER_OFFSET_AND_SIZE:
            st[DXCTX.INDEX_FORMAT] = p[0];
            st[DXCTX.INDEX_OFFSET] = p[1];
            break;
        case C.SVGA_3D_CMD_DX_SET_TOPOLOGY:
            st[DXCTX.TOPOLOGY] = p[0];
            break;
        case C.SVGA_3D_CMD_DX_SET_RENDERTARGETS:
        {
            // dsv, then render target views
            st[DXCTX.DSV] = p[0];
            const rtvs = p.subarray(1, Math.min(p.length, 9));
            for(let i = 0; i < 8; i++) st[DXCTX.RTVS + i] = i < rtvs.length ? rtvs[i] : INVALID;
            const dsv = view_sid(VIEW_DSV, p[0]);
            if(dsv !== undefined) this.written(dsv);
            for(const rtv of rtvs)
            {
                const sid = view_sid(VIEW_RTV, rtv);
                if(sid !== undefined) this.written(sid);
            }
            break;
        }
        case C.SVGA_3D_CMD_DX_SET_BLEND_STATE:
            st[DXCTX.BLEND] = p[0];
            st.set(p.subarray(1, 5), DXCTX.BLEND_FACTOR);
            st[DXCTX.SAMPLE_MASK] = p[5];
            break;
        case C.SVGA_3D_CMD_DX_SET_DEPTHSTENCIL_STATE:
            st[DXCTX.DEPTH_STENCIL] = p[0];
            st[DXCTX.STENCIL_REF] = p[1];
            break;
        case C.SVGA_3D_CMD_DX_SET_RASTERIZER_STATE:
            st[DXCTX.RASTERIZER] = p[0];
            break;
        case C.SVGA_3D_CMD_DX_SET_VIEWPORTS:
        {
            const count = Math.min(16, Math.floor((p.length - 1) / 6));
            st.set(p.subarray(1, 1 + 6 * count), DXCTX.VIEWPORTS);
            st[DXCTX.VIEWPORT_COUNTS] = st[DXCTX.VIEWPORT_COUNTS] & ~0xFF | count;
            break;
        }
        case C.SVGA_3D_CMD_DX_SET_SCISSORRECTS:
        {
            const count = Math.min(16, Math.floor((p.length - 1) / 4));
            st.set(p.subarray(1, 1 + 4 * count), DXCTX.SCISSORS);
            st[DXCTX.VIEWPORT_COUNTS] = st[DXCTX.VIEWPORT_COUNTS] & ~0xFF00 | count << 8;
            break;
        }
        case C.SVGA_3D_CMD_DX_SET_SOTARGETS:
            for(let i = 0; i < 4; i++)
            {
                const sid = 1 + 3 * i < p.length ? p[1 + 3 * i] : INVALID;
                st[DXCTX.SO_TARGETS + i] = sid;
                this.written(sid);
            }
            break;
        case C.SVGA_3D_CMD_DX_SET_STREAMOUTPUT:
            st[DXCTX.SOID] = p[0];
            break;
        case C.SVGA_3D_CMD_DX_SET_PREDICATION:
            st[DXCTX.PREDICATION] = p[0];
            st[DXCTX.PREDICATION + 1] = p[1];
            break;
        case C.SVGA_3D_CMD_DX_SET_UA_VIEWS:
            st[DXCTX.UAV_SPLICE] = p[0];
            st.set(p.subarray(1, Math.min(p.length, 65)), DXCTX.UAVS);
            for(const uav of p.subarray(1))
            {
                const sid = view_sid(VIEW_UAV, uav);
                if(sid !== undefined) this.written(sid);
            }
            break;
        case C.SVGA_3D_CMD_DX_SET_CS_UA_VIEWS:
            st.set(p.subarray(1, Math.min(p.length, 65 - p[0])), DXCTX.CS_UAVS + p[0]);
            for(const uav of p.subarray(1))
            {
                const sid = view_sid(VIEW_UAV, uav);
                if(sid !== undefined) this.written(sid);
            }
            break;
        case C.SVGA_3D_CMD_DX_SET_VS_CONSTANT_BUFFER_OFFSET:
        case C.SVGA_3D_CMD_DX_SET_PS_CONSTANT_BUFFER_OFFSET:
        case C.SVGA_3D_CMD_DX_SET_GS_CONSTANT_BUFFER_OFFSET:
        case C.SVGA_3D_CMD_DX_SET_HS_CONSTANT_BUFFER_OFFSET:
        case C.SVGA_3D_CMD_DX_SET_DS_CONSTANT_BUFFER_OFFSET:
        case C.SVGA_3D_CMD_DX_SET_CS_CONSTANT_BUFFER_OFFSET:
        {
            const type = C.SVGA3D_SHADERTYPE_VS + id - C.SVGA_3D_CMD_DX_SET_VS_CONSTANT_BUFFER_OFFSET;
            const at = this.stage(type);
            if(at >= 0 && p[0] < 16) st[at + STAGE_CBS + 3 * p[0] + 1] = p[1];
            break;
        }
        case C.SVGA_3D_CMD_DX_BIND_QUERY:
        case C.SVGA_3D_CMD_DX_SET_QUERY_OFFSET:
        case C.SVGA_3D_CMD_DX_MOVE_QUERY:
        {
            const e = this.query_entry(context, p[0]);
            if(!e) return;
            if(id === C.SVGA_3D_CMD_DX_BIND_QUERY) e[2] = p[1];
            else if(id === C.SVGA_3D_CMD_DX_SET_QUERY_OFFSET) e[3] = p[1];
            else { e[2] = p[1]; e[3] = p[2]; }
            this.write_entry(context, C.SVGA_COTABLE_DXQUERY, p[0], e);
            return;
        }
        case C.SVGA_3D_CMD_DX_END_QUERY:
            this.end_query(context, p[0]);
            return;
        case C.SVGA_3D_CMD_DX_READBACK_QUERY:
            return;

        // the surfaces these name are made in GX first; copies' destinations are written
        case C.SVGA_3D_CMD_DX_DRAW_INDEXED_INSTANCED_INDIRECT:
        case C.SVGA_3D_CMD_DX_DRAW_INSTANCED_INDIRECT:
        case C.SVGA_3D_CMD_DX_DISPATCH_INDIRECT:
        case C.SVGA_3D_CMD_DX_SET_MIN_LOD:
            this.surface(p[0]);
            break;
        case C.SVGA_3D_CMD_DX_PRED_COPY_REGION:
        case C.SVGA_3D_CMD_DX_PRED_STAGING_COPY_REGION:
        case C.SVGA_3D_CMD_DX_RESOLVE_COPY:
        case C.SVGA_3D_CMD_DX_PRED_RESOLVE_COPY:
            this.surface(p[2]);
            this.written(p[0]);
            break;
        case C.SVGA_3D_CMD_DX_PRED_COPY:
        case C.SVGA_3D_CMD_DX_PRED_STAGING_COPY:
        case C.SVGA_3D_CMD_DX_STAGING_COPY:
        case C.SVGA_3D_CMD_DX_PRED_CONVERT:
        case C.SVGA_3D_CMD_DX_PRED_STAGING_CONVERT:
            this.surface(p[1]);
            this.written(p[0]);
            break;
        case C.SVGA_3D_CMD_DX_PRED_CONVERT_REGION:
        case C.SVGA_3D_CMD_DX_PRED_STAGING_CONVERT_REGION:
            this.surface(p[8]);
            this.written(p[0]);
            break;
        case C.SVGA_3D_CMD_DX_BUFFER_COPY:
        case C.SVGA_3D_CMD_DX_STAGING_BUFFER_COPY:
            this.surface(p[1]);
            this.written(p[0]);
            break;
        case C.SVGA_3D_CMD_DX_PRESENTBLT:
            this.surface(p[0]);
            this.written(p[2]);
            break;
        case C.SVGA_3D_CMD_DX_TRANSFER_FROM_BUFFER:
        case C.SVGA_3D_CMD_DX_PRED_TRANSFER_FROM_BUFFER:
            this.surface(p[0]);
            this.written(p[4]);
            break;
        case C.SVGA_3D_CMD_DX_TRANSFER_TO_BUFFER:
            this.surface(p[0]);
            this.written(p[9]);
            if(p[13] & C.SVGA3D_TRANSFER_TO_BUFFER_READBACK)
            {
                this.forward(cid, id, p);
                this.s.readback_surface(this.s.surfaces.get(p[9]));
                return;
            }
            break;
        case C.SVGA_3D_CMD_DX_SURFACE_COPY_AND_READBACK:
        {
            // srcSid, destSid, box: a copy, then the destination into its MOB
            this.surface(p[0]);
            this.written(p[1]);
            this.forward(cid, id, p);
            const dst = this.s.surfaces.get(p[1]);
            if(dst) this.s.readback_surface(dst);
            return;
        }
        case C.SVGA_3D_CMD_DX_GENMIPS:
        {
            const sid = view_sid(VIEW_SRV, p[0]);
            if(sid !== undefined) this.written(sid);
            break;
        }
        case C.SVGA_3D_CMD_DX_CLEAR_RENDERTARGET_VIEW:
        {
            const sid = view_sid(VIEW_RTV, p[0]);
            if(sid !== undefined) this.written(sid);
            break;
        }
        case C.SVGA_3D_CMD_DX_CLEAR_DEPTHSTENCIL_VIEW:
        {
            const sid = view_sid(VIEW_DSV, p[1]);
            if(sid !== undefined) this.written(sid);
            break;
        }
        case C.SVGA_3D_CMD_DX_CLEAR_UA_VIEW_UINT:
        case C.SVGA_3D_CMD_DX_CLEAR_UA_VIEW_FLOAT:
        case C.SVGA_3D_CMD_DX_COPY_STRUCTURE_COUNT:
            break;

        // moving contents between MOBs and the GPU
        case C.SVGA_3D_CMD_DX_UPDATE_SUBRESOURCE:
        {
            // sid, subResource, box (x, y, z, w, h, d)
            const surface = this.s.surfaces.get(p[0]);
            if(surface) this.s.update_subresource(surface, p[1], [p[2], p[3], p[4], p[5], p[6], p[7]]);
            return;
        }
        case C.SVGA_3D_CMD_DX_READBACK_SUBRESOURCE:
        {
            const surface = this.s.surfaces.get(p[0]);
            if(surface) this.s.readback_subresource(surface, p[1]);
            return;
        }
        case C.SVGA_3D_CMD_DX_INVALIDATE_SUBRESOURCE:
            return;
        case C.SVGA_3D_CMD_DX_BUFFER_UPDATE:
        {
            // sid, x, width
            const surface = this.s.surfaces.get(p[0]);
            if(surface) this.s.update_subresource(surface, 0, [p[1], 0, 0, p[2], 1, 1]);
            return;
        }
        case C.SVGA_3D_CMD_DX_DRAW:
        case C.SVGA_3D_CMD_DX_DRAW_INDEXED:
        case C.SVGA_3D_CMD_DX_DRAW_INSTANCED:
        case C.SVGA_3D_CMD_DX_DRAW_INDEXED_INSTANCED:
        case C.SVGA_3D_CMD_DX_DRAW_AUTO:
        case C.SVGA_3D_CMD_DX_DISPATCH:
            this.drawing(context);
            break;
        case C.SVGA_3D_CMD_DX_BEGIN_QUERY:
        case C.SVGA_3D_CMD_DX_SET_SHADER_IFACE:
        case C.SVGA_3D_CMD_DX_SET_STRUCTURE_COUNT:
            break;
        default:
            this.warn("cmd" + id, "DX command " + id + " is not supported");
            return;
    }
    this.forward(cid, id, p);
};

DXDevice.prototype.get_state = function()
{
    const contexts = [];
    for(const c of this.contexts.values()) contexts.push([c.cid, c.mob, c.state]);
    return contexts;
};

/**
 * After a restore: the contexts again, their objects from their COTables
 * (guest memory, restored), their state
 */
DXDevice.prototype.set_state = function(state)
{
    this.contexts.clear();
    this.device_dx = null;
    for(const [cid, mob, saved] of state || [])
    {
        this.define_context(cid);
        const context = this.contexts.get(cid);
        context.mob = mob;
        context.state.set(saved);
        this.restore(context);
    }
};

/** For dbg_log users that only have the module */
export function dx_log(text)
{
    dbg_log("svga-dx: " + text, LOG_VGA);
}
