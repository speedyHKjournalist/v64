// Legacy 3D (level vgpu9; plan section 5.8): the SVGA3D commands of VMware's
// pre-guest-backed 3D, the D3D9-shaped API that Windows' vm3d and Mesa's svga
// driver speak to a device without SVGA_CAP_GBOBJECTS.
//
// The CPU side (this file) validates commands, reads the guest memory they
// refer to, and writes self-contained D9WG batches (svga3d_d9wg.js) for the
// renderer, which runs them through the D3D9 executor on WebGPU
// (src/browser/glbridge/svga_renderer.js). Nothing here touches WebGPU.
//
// - Each SVGA3D context is a D9WG device of its own: the executor keeps the
//   whole D3D9 state per device, so switching contexts needs no shadowing.
//   Surfaces, shaders and declarations are resources every device can use.
// - A surface is a D9WG texture (2D, cube, volume or depth), created when it
//   is defined. A buffer surface (SVGA3D_BUFFER) is a vertex buffer, a 16-bit
//   index buffer or a 32-bit one depending on how a draw uses it, each made
//   the first time; their bytes are kept here so a new role starts complete.
// - Pictures leave the GPU through readbacks: SURFACE_DMA to the guest, and
//   PRESENT / BLIT_SURFACE_TO_SCREEN, whose rows are read back and drawn into
//   the screens' pictures (or the legacy frame buffer). So the screen, the
//   cursor, screenshots and snapshots stay where the 2D levels have them.
// - Completion: fences and command buffers that follow GPU work complete
//   when the renderer has run every batch before them (after_work).

import { LOG_VGA } from "../../const.js";
import { dbg_log } from "../../log.js";
import * as C from "./svga_constants.js";
import { D9WGWriter, OP, KIND, RESPONSE_REGION_OFFSET, QUERY_REGION_BYTES, QUERY_SLOT_BYTES,
    READBACK_HEADER_BYTES, READBACK_MAX_BYTES, RESPONSE_OK } from "./svga3d_d9wg.js";
import { FORMATS, D3DFMT, VGPU9_DEVCAPS, PRIMITIVES, primitive_vertices, d3d_transform, d3d_light_type,
    D3DRS, SAME_RENDER_STATES, d3d_blend, D3DTSS, D3DSAMP, TEXTURE_OPS, d3d_texture_argument,
    d3d_texture_transform_flags, d3d_address, d3d_texcoord_generation } from "./svga3d_tables.js";

const INVALID = 0xFFFFFFFF;

const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_DEPTHSTENCIL = 0x2;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DUSAGE_AUTOGENMIPMAP = 0x400;
const D3DQUERYTYPE_OCCLUSION = 9;
const D3DFOG_NONE = 0;
const D3DCULL_NONE = 1;
const D3DCULL_CW = 2;
const D3DCULL_CCW = 3;

/** The D9WG device for work that belongs to no context (copies, readbacks) */
const UTILITY_DEVICE = 0x7FFF0001;
/** The executor's first shader handle (D9WG_SHADER_HANDLE_BASE) */
const SHADER_HANDLE_BASE = 0x40000001;
/** Texture stages from here on are the vertex shader's samplers */
const SAMPLERS_PS = 16;
const D3DVERTEXTEXTURESAMPLER0 = 257;
const MAX_STREAMS = 16;
/** A batch is sent at the latest when it is this big */
const BATCH_FLUSH_BYTES = 8 << 20;
/** Query result slots in the response region */
const QUERY_SLOTS = QUERY_REGION_BYTES / QUERY_SLOT_BYTES;

/** SVGA3dDeclType -> bytes */
const DECL_SIZES = [4, 8, 12, 16, 4, 4, 4, 8, 4, 4, 8, 4, 8, 4, 4, 4, 8];

/** Which D9WG resources a buffer surface may have: vertex, index16, index32 */
const ROLE_VERTEX = 0;
const ROLE_INDEX16 = 1;
const ROLE_INDEX32 = 2;

/**
 * @constructor
 */
function Surface(sid, flags, format, faces, sizes, samples)
{
    this.sid = sid;
    this.flags = flags;
    this.format = format;
    /** @type {?Object} */
    this.info = FORMATS[format] || null;
    this.faces = faces;
    /** [width, height, depth] of each mip level */
    this.sizes = sizes;
    this.samples = samples;
    this.handle = 0;
    this.kind = 0;
    /** @type {Uint8Array} a buffer's bytes */
    this.data = null;
    /** a buffer's D9WG buffers, by role */
    this.roles = [0, 0, 0];
}

/**
 * @constructor
 */
function Context(cid, device)
{
    this.cid = cid;
    /** its D9WG device */
    this.device = device;
    /** "type:shid" -> D9WG shader handle */
    this.shaders = new Map();
    this.viewport = null;
    this.zrange = [0, 1];
    this.scissor = null;
    this.cull = C.SVGA3D_FACE_NONE;
    this.winding = C.SVGA3D_FRONTWINDING_CW;
    this.texcoord_index = new Int32Array(SAMPLERS_PS);
    this.texcoord_gen = new Int32Array(SAMPLERS_PS);
    for(let i = 0; i < SAMPLERS_PS; i++) this.texcoord_index[i] = i;
    /** streams given a frequency other than 1 by the last draw */
    this.instanced = 0;
    /** the color target 0 surface, for the clear and viewport sizes */
    this.target = null;
}

/**
 * @constructor
 * @param {!Object} device the SVGADevice
 * @param {!Object} renderer the channel: post(message, transfer), listen(handler)
 */
export function SVGA3D(device, renderer)
{
    this.device = device;
    this.renderer = renderer;
    this.writer = new D9WGWriter();
    /** @type {!Map<number, !Surface>} */
    this.surfaces = new Map();
    /** @type {!Map<number, !Context>} */
    this.contexts = new Map();
    this.declarations = new Map();
    this.next_handle = 1;
    this.next_shader = 0;
    this.next_device = 1;
    this.next_request = 1;
    this.frame = 0;
    // batches sent and run
    this.submitted = 0;
    this.completed = 0;
    /** @type {!Array<{seq: number, run: function()}>} waiting for batches, in order */
    this.completions = [];
    /** @type {!Map<number, function(Uint8Array, number)>} request id -> answer */
    this.requests = new Map();
    this.warned = new Set();
    renderer.listen(message => this.receive(message));
}

SVGA3D.prototype.reset = function()
{
    this.writer = new D9WGWriter();
    this.surfaces.clear();
    this.contexts.clear();
    this.declarations.clear();
    this.completions = [];
    this.requests.clear();
    this.completed = this.submitted;
    this.renderer.post({ "type": "reset" });
};

SVGA3D.prototype.warn_once = function(key, text)
{
    if(this.warned.has(key)) return;
    this.warned.add(key);
    dbg_log("svga3d: " + text, LOG_VGA);
};

// ---------------------------------------------------------------------------
// The FIFO's 3D registers

/**
 * The 3D hardware version and the devcaps record
 * @param {!Int32Array} fifo
 */
SVGA3D.write_fifo_caps = function(fifo)
{
    fifo[C.SVGA_FIFO_3D_HWVERSION] = C.SVGA3D_HWVERSION_WS8_B1;
    fifo[C.SVGA_FIFO_3D_HWVERSION_REVISED] = C.SVGA3D_HWVERSION_WS8_B1;
    let at = C.SVGA_FIFO_3D_CAPS;
    // SVGA3dFifoCapsRecordHeader: length in dwords with itself, type
    fifo[at] = 2 + 2 * VGPU9_DEVCAPS.length;
    fifo[at + 1] = C.SVGA3D_FIFO_CAPS_RECORD_DEVCAPS;
    at += 2;
    for(const [index, value] of VGPU9_DEVCAPS)
    {
        fifo[at++] = index;
        fifo[at++] = value;
    }
    // a record of length 0 ends the list
    fifo[at] = 0;
};

// ---------------------------------------------------------------------------
// Batches and completion

/** @return {boolean} whether something sent to the renderer has not run yet */
SVGA3D.prototype.busy = function()
{
    return !this.writer.empty() || this.submitted > this.completed;
};

/**
 * Send the batch being written
 */
SVGA3D.prototype.flush = function()
{
    if(this.writer.empty()) return;
    const bytes = this.writer.finish(++this.frame, 0);
    const seq = ++this.submitted;
    this.renderer.post({ "type": "submit", "seq": seq, "bytes": bytes }, [bytes.buffer]);
};

/**
 * Run `run` once everything sent so far has run (now, if it has)
 * @param {function()} run
 */
SVGA3D.prototype.after_work = function(run)
{
    this.flush();
    if(this.submitted > this.completed)
    {
        this.completions.push({ seq: this.submitted, run });
    }
    else
    {
        run();
    }
};

/**
 * @param {!Object} message from the renderer
 */
SVGA3D.prototype.receive = function(message)
{
    switch(message["type"])
    {
        case "write":
            this.answer(message["offset"], message["bytes"]);
            break;
        case "done":
            this.completed = Math.max(this.completed, message["seq"]);
            while(this.completions.length && this.completions[0].seq <= this.completed)
            {
                this.completions.shift().run();
            }
            break;
        case "lost":
            // The renderer is gone: tell the driver, and let nothing wait
            dbg_log("svga3d: the renderer was lost: " + message["reason"], LOG_VGA);
            this.device.set_irq(C.SVGA_IRQFLAG_ERROR);
            this.completed = this.submitted;
            for(const request of this.requests.values()) request(null, 0);
            this.requests.clear();
            while(this.completions.length) this.completions.shift().run();
            break;
    }
};

/**
 * A write into the response region: a query result or a readback
 * @param {number} offset from the start of the response region
 * @param {!Uint8Array} bytes
 */
SVGA3D.prototype.answer = function(offset, bytes)
{
    if(bytes.length < 16) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getUint32(0, true), status = view.getUint32(12, true);
    const request = this.requests.get(id);
    if(!request) return;
    this.requests.delete(id);
    if(offset < QUERY_REGION_BYTES)
    {
        // D9WGQueryResponse: request id, value (64 bits), status
        request(bytes.subarray(4, 12), status);
    }
    else
    {
        // D9WGReadbackResponse: request id, byte count, reserved, status, bytes
        const count = view.getUint32(4, true);
        request(status === RESPONSE_OK ? bytes.subarray(READBACK_HEADER_BYTES, READBACK_HEADER_BYTES + count) : null, status);
    }
};

// ---------------------------------------------------------------------------
// Commands

/**
 * One 3D command
 * @param {number} id SVGA_3D_CMD_*
 * @param {!Int32Array} p its body, after SVGA3dCmdHeader
 */
SVGA3D.prototype.command = function(id, p)
{
    const f = new Float32Array(p.buffer, p.byteOffset, p.length);
    switch(id)
    {
        case C.SVGA_3D_CMD_SURFACE_DEFINE: this.define_surface(p, false); break;
        case C.SVGA_3D_CMD_SURFACE_DEFINE_V2: this.define_surface(p, true); break;
        case C.SVGA_3D_CMD_SURFACE_DESTROY: if(p.length >= 1) this.destroy_surface(p[0] >>> 0); break;
        case C.SVGA_3D_CMD_SURFACE_DMA: this.surface_dma(p); break;
        case C.SVGA_3D_CMD_SURFACE_COPY: this.surface_copy(p); break;
        case C.SVGA_3D_CMD_SURFACE_STRETCHBLT: this.surface_stretch(p); break;
        case C.SVGA_3D_CMD_CONTEXT_DEFINE: if(p.length >= 1) this.define_context(p[0] >>> 0); break;
        case C.SVGA_3D_CMD_CONTEXT_DESTROY: if(p.length >= 1) this.destroy_context(p[0] >>> 0); break;
        case C.SVGA_3D_CMD_SETTRANSFORM: this.set_transform(p, f); break;
        case C.SVGA_3D_CMD_SETZRANGE: this.set_zrange(p, f); break;
        case C.SVGA_3D_CMD_SETRENDERSTATE: this.set_render_states(p, f); break;
        case C.SVGA_3D_CMD_SETRENDERTARGET: this.set_render_target(p); break;
        case C.SVGA_3D_CMD_SETTEXTURESTATE: this.set_texture_states(p, f); break;
        case C.SVGA_3D_CMD_SETMATERIAL: this.set_material(p, f); break;
        case C.SVGA_3D_CMD_SETLIGHTDATA: this.set_light(p, f); break;
        case C.SVGA_3D_CMD_SETLIGHTENABLED: this.set_light_enabled(p); break;
        case C.SVGA_3D_CMD_SETVIEWPORT: this.set_viewport(p); break;
        case C.SVGA_3D_CMD_SETCLIPPLANE: this.set_clip_plane(p, f); break;
        case C.SVGA_3D_CMD_CLEAR: this.clear(p, f); break;
        case C.SVGA_3D_CMD_PRESENT: this.present(p); break;
        case C.SVGA_3D_CMD_SHADER_DEFINE: this.define_shader(p); break;
        case C.SVGA_3D_CMD_SHADER_DESTROY: this.destroy_shader(p); break;
        case C.SVGA_3D_CMD_SET_SHADER: this.set_shader(p); break;
        case C.SVGA_3D_CMD_SET_SHADER_CONST: this.set_shader_const(p); break;
        case C.SVGA_3D_CMD_DRAW_PRIMITIVES: this.draw_primitives(p); break;
        case C.SVGA_3D_CMD_SETSCISSORRECT: this.set_scissor(p); break;
        case C.SVGA_3D_CMD_BEGIN_QUERY: this.begin_query(p); break;
        case C.SVGA_3D_CMD_END_QUERY: this.end_query(p); break;
        case C.SVGA_3D_CMD_WAIT_FOR_QUERY:
            // the result is written when it is known; the driver polls it
            break;
        case C.SVGA_3D_CMD_BLIT_SURFACE_TO_SCREEN: this.blit_surface_to_screen(p); break;
        case C.SVGA_3D_CMD_GENERATE_MIPMAPS: this.generate_mipmaps(p); break;
        case C.SVGA_3D_CMD_ACTIVATE_SURFACE:
        case C.SVGA_3D_CMD_DEACTIVATE_SURFACE:
            // residency hints
            break;
        case C.SVGA_3D_CMD_PRESENT_READBACK:
        case C.SVGA_3D_CMD_SCREEN_DMA:
            this.warn_once("cmd" + id, "command " + id + " is not implemented");
            break;
        default:
            this.warn_once("cmd" + id, "command " + id + " ignored at level vgpu9");
    }
    if(this.writer.size() > BATCH_FLUSH_BYTES) this.flush();
};

// ---------------------------------------------------------------------------
// Surfaces

/**
 * SURFACE_DEFINE(_V2): sid, flags, format, face[6].numMipLevels
 * (V2: multisampleCount, autogenFilter), then an SVGA3dSize per mip of each face
 */
SVGA3D.prototype.define_surface = function(p, v2)
{
    const head = v2 ? 11 : 9;
    if(p.length < head) return;
    const sid = p[0] >>> 0, flags = p[1] >>> 0, format = p[2] >>> 0;
    const mips = p[3] >>> 0;
    let faces = 0;
    for(let i = 0; i < 6; i++) if(p[3 + i]) faces++;
    const samples = v2 ? p[9] >>> 0 : 0;
    if(!mips || !faces || p.length < head + 3 * mips * faces)
    {
        this.warn_once("define", "a surface definition without sizes");
        return;
    }
    const sizes = [];
    for(let i = 0; i < mips; i++)
    {
        const at = head + 3 * i;
        sizes.push([p[at] >>> 0, p[at + 1] >>> 0, Math.max(1, p[at + 2] >>> 0)]);
    }
    if(this.surfaces.has(sid)) this.destroy_surface(sid);
    const surface = new Surface(sid, flags, format, faces, sizes, samples);
    this.surfaces.set(sid, surface);
    const info = surface.info;
    if(!info)
    {
        this.warn_once("format" + format, "surface format " + format + " is not supported");
        return;
    }
    const [width, height, depth] = sizes[0];
    if(!info.d3d)
    {
        // a buffer: its D9WG buffers are made as draws use it
        surface.data = new Uint8Array(width * height * depth);
        return;
    }

    const handle = surface.handle = this.next_handle++;
    const w = this.writer;
    let usage = 0;
    if(info.depth) usage |= D3DUSAGE_DEPTHSTENCIL;
    else if(info.target && info.block === 1) usage |= D3DUSAGE_RENDERTARGET;
    if(flags & C.SVGA3D_SURFACE_AUTOGENMIPMAPS) usage |= D3DUSAGE_AUTOGENMIPMAP;
    if(faces === 6 && (flags & C.SVGA3D_SURFACE_CUBEMAP))
    {
        surface.kind = KIND.TEXTURE_CUBE;
        w.begin(OP.CREATE_TEXTURE_CUBE).u32(UTILITY_DEVICE).u32(handle).u32(width).u32(mips)
            .u32(info.d3d).u32(usage).u32(0).u32(0);
    }
    else if(depth > 1 || (flags & C.SVGA3D_SURFACE_VOLUME))
    {
        surface.kind = KIND.TEXTURE_VOLUME;
        w.begin(OP.CREATE_TEXTURE_VOLUME).u32(UTILITY_DEVICE).u32(handle).u32(width).u32(height).u32(depth)
            .u32(mips).u32(info.d3d).u32(usage).u32(0).u32(0);
    }
    else
    {
        surface.kind = KIND.TEXTURE_2D;
        // D3DMULTISAMPLE_n_SAMPLES is n
        w.begin(OP.CREATE_TEXTURE_2D).u32(UTILITY_DEVICE).u32(handle).u32(width).u32(height).u32(mips)
            .u32(info.d3d).u32(usage).u32(0).u32(samples > 1 ? samples : 0).u32(0);
    }
};

SVGA3D.prototype.destroy_surface = function(sid)
{
    const surface = this.surfaces.get(sid);
    if(!surface) return;
    this.surfaces.delete(sid);
    const w = this.writer;
    if(surface.handle) w.begin(OP.DESTROY_RESOURCE).u32(surface.handle).u32(surface.kind);
    for(let role = 0; role < 3; role++)
    {
        if(surface.roles[role]) w.begin(OP.DESTROY_RESOURCE).u32(surface.roles[role]).u32(role === ROLE_VERTEX ? KIND.VERTEX_BUFFER : KIND.INDEX_BUFFER);
    }
};

/**
 * The D9WG buffer of a buffer surface in a role, made (and filled) the first time
 * @return {number} 0 if the surface is not a buffer
 */
SVGA3D.prototype.buffer_role = function(surface, role)
{
    if(!surface.data) return 0;
    if(surface.roles[role]) return surface.roles[role];
    const handle = surface.roles[role] = this.next_handle++;
    const w = this.writer;
    const index = role !== ROLE_VERTEX;
    w.begin(OP.CREATE_BUFFER).u32(UTILITY_DEVICE).u32(handle).u32(index ? KIND.INDEX_BUFFER : KIND.VERTEX_BUFFER)
        .u32(surface.data.length).u32(D3DUSAGE_DYNAMIC)
        .u32(role === ROLE_INDEX16 ? D3DFMT.INDEX16 : role === ROLE_INDEX32 ? D3DFMT.INDEX32 : 0).u32(0).u32(0);
    this.update_buffer(handle, 0, surface.data);
    return handle;
};

SVGA3D.prototype.update_buffer = function(handle, offset, bytes)
{
    const w = this.writer.begin(OP.UPDATE_BUFFER).u32(handle).u32(offset).u32(bytes.length);
    const data_offset = w.placeholder();
    w.u32(0).u32(0);
    w.patch(data_offset, w.data(bytes));
};

/**
 * The size of a mip level in blocks, and its bytes per row
 */
function level_layout(surface, mip)
{
    const [width, height, depth] = surface.sizes[mip];
    const { block, bytes } = surface.info;
    const columns = Math.ceil(width / block), rows = Math.ceil(height / block);
    return { width, height, depth, columns, rows, pitch: columns * bytes };
}

/**
 * SURFACE_DMA: guest image (gmrId, offset, pitch), host image (sid, face,
 * mipmap), transfer, then SVGA3dCopyBox[] and maybe SVGA3dCmdSurfaceDMASuffix
 */
SVGA3D.prototype.surface_dma = function(p)
{
    if(p.length < 7) return;
    const gmr = p[0] >>> 0, offset = p[1] >>> 0, pitch = p[2] >>> 0;
    const surface = this.surfaces.get(p[3] >>> 0);
    const face = p[4] >>> 0, mip = p[5] >>> 0, transfer = p[6] >>> 0;
    if(!surface || !surface.info || mip >= surface.sizes.length) return;
    let rest = p.length - 7;
    // the suffix, if there is one, ends the command and says its own size
    if(rest % 9 === 3 && (p[p.length - 3] >>> 0) === 12) rest -= 3;
    const boxes = Math.floor(rest / 9);
    for(let i = 0; i < boxes; i++)
    {
        const b = 7 + 9 * i;
        const box = [p[b] >>> 0, p[b + 1] >>> 0, p[b + 2] >>> 0, p[b + 3] >>> 0, p[b + 4] >>> 0, p[b + 5] >>> 0,
            p[b + 6] >>> 0, p[b + 7] >>> 0, p[b + 8] >>> 0];
        if(transfer === C.SVGA3D_WRITE_HOST_VRAM) this.dma_to_host(surface, face, mip, gmr, offset, pitch, box);
        else if(transfer === C.SVGA3D_READ_HOST_VRAM) this.dma_to_guest(surface, face, mip, gmr, offset, pitch, box);
    }
};

/**
 * One box from guest memory into a surface
 * @param {!Array<number>} box x, y, z, w, h, d (host), srcx, srcy, srcz (guest)
 */
SVGA3D.prototype.dma_to_host = function(surface, face, mip, gmr, offset, pitch, box)
{
    const gmrs = this.device.gmrs;
    let [x, y, z, w, h, d, sx, sy, sz] = box;
    if(surface.data)
    {
        // a buffer: bytes x..x+w from the guest's srcx
        w = Math.min(w, surface.data.length - x);
        if(w <= 0) return;
        const bytes = gmrs.read(gmr, offset + sx, w);
        if(!bytes) return this.warn_once("dma-gmr", "SURFACE_DMA outside of its GMR");
        surface.data.set(bytes, x);
        for(const handle of surface.roles) if(handle) this.update_buffer(handle, x, bytes);
        return;
    }
    if(!surface.handle) return;
    if(surface.info.depth)
    {
        return this.warn_once("dma-depth", "SURFACE_DMA into a depth surface is not supported");
    }
    const level = level_layout(surface, mip);
    const block = surface.info.block, bytes_per = surface.info.bytes;
    x = Math.min(x, level.width); y = Math.min(y, level.height);
    w = Math.min(w, level.width - x); h = Math.min(h, level.height - y);
    if(surface.kind === KIND.TEXTURE_VOLUME) d = Math.min(d, level.depth - z);
    else { z = surface.kind === KIND.TEXTURE_CUBE ? face : 0; d = 1; sz = 0; }
    if(w <= 0 || h <= 0 || d <= 0) return;
    // in blocks
    const bx = Math.floor(x / block), by = Math.floor(y / block);
    const columns = Math.ceil((x + w) / block) - bx, rows = Math.ceil((y + h) / block) - by;
    const row_bytes = columns * bytes_per;
    const guest_slice = pitch * level.rows;
    const data = new Uint8Array(row_bytes * rows * d);
    for(let slice = 0; slice < d; slice++)
    {
        const start = offset + (sz + slice) * guest_slice + Math.floor(sy / block) * pitch + Math.floor(sx / block) * bytes_per;
        const span = gmrs.read(gmr, start, (rows - 1) * pitch + row_bytes);
        if(!span) return this.warn_once("dma-gmr", "SURFACE_DMA outside of its GMR");
        for(let row = 0; row < rows; row++)
        {
            data.set(span.subarray(row * pitch, row * pitch + row_bytes), (slice * rows + row) * row_bytes);
        }
    }
    const wr = this.writer.begin(OP.UPDATE_TEXTURE).u32(surface.handle).u32(mip)
        .u32(bx * block).u32(by * block).u32(z).u32(w).u32(h).u32(d)
        .u32(row_bytes).u32(row_bytes * rows).u32(data.length);
    wr.patch(wr.placeholder(), wr.data(data));
};

/**
 * One box from a surface into guest memory
 */
SVGA3D.prototype.dma_to_guest = function(surface, face, mip, gmr, offset, pitch, box)
{
    const gmrs = this.device.gmrs;
    let [x, y, z, w, h, d, sx, sy, sz] = box;
    if(surface.data)
    {
        // buffers only change through DMA: their bytes are here
        w = Math.min(w, surface.data.length - x);
        if(w > 0) gmrs.write(gmr, offset + sx, surface.data.subarray(x, x + w));
        return;
    }
    if(!surface.handle || surface.info.depth) return;
    const level = level_layout(surface, mip);
    const block = surface.info.block, bytes_per = surface.info.bytes;
    w = Math.min(w, level.width - x); h = Math.min(h, level.height - y);
    if(surface.kind !== KIND.TEXTURE_VOLUME) { d = 1; sz = 0; z = surface.kind === KIND.TEXTURE_CUBE ? face : 0; }
    if(w <= 0 || h <= 0) return;
    const bx = Math.floor(x / block), by = Math.floor(y / block);
    const columns = Math.ceil((x + w) / block) - bx, rows = Math.ceil((y + h) / block) - by;
    const guest_slice = pitch * level.rows;
    for(let slice = 0; slice < d; slice++)
    {
        const layer = surface.kind === KIND.TEXTURE_VOLUME ? z + slice : z;
        const guest = offset + (sz + slice) * guest_slice + Math.floor(sy / block) * pitch + Math.floor(sx / block) * bytes_per;
        this.read_rows(surface, layer, mip, by, rows, (data, first, count, data_pitch) => {
            for(let row = 0; row < count; row++)
            {
                const from = row * data_pitch + bx * bytes_per;
                gmrs.write(gmr, guest + (first - by + row) * pitch, data.subarray(from, from + columns * bytes_per));
            }
        });
    }
};

/**
 * Read rows (of blocks) of a mip level back from the GPU, in pieces that fit
 * the response region; `done` gets each piece as it arrives
 * @param {function(!Uint8Array, number, number, number)} done (bytes, first row, rows, pitch)
 */
SVGA3D.prototype.read_rows = function(surface, layer, mip, first, rows, done)
{
    const level = level_layout(surface, mip);
    const block = surface.info.block;
    const per_request = Math.max(1, Math.floor(READBACK_MAX_BYTES / level.pitch));
    for(let row = first; row < first + rows; row += per_request)
    {
        const count = Math.min(per_request, first + rows - row);
        const id = this.next_request++;
        this.requests.set(id, (bytes, status) => {
            if(bytes) done(bytes, row, count, level.pitch);
        });
        this.writer.begin(OP.READBACK_SURFACE).u32(UTILITY_DEVICE).u32(surface.handle).u32(mip)
            .u32(surface.info.d3d).u32(level.width).u32(level.height)
            .u32(row * block).u32(Math.min(count * block, level.height - row * block))
            .u32(level.pitch).u32(count * level.pitch).u32(QUERY_REGION_BYTES).u32(id).u32(layer);
    }
};

/** An SVGA3dSurfaceImageId: its surface if it has a texture */
SVGA3D.prototype.image = function(p, at)
{
    const surface = this.surfaces.get(p[at] >>> 0);
    return surface && (surface.handle || surface.data) ? surface : null;
};

/**
 * SURFACE_COPY: src image, dest image, then SVGA3dCopyBox[]
 */
SVGA3D.prototype.surface_copy = function(p)
{
    const src = this.image(p, 0), dst = this.image(p, 3);
    if(!src || !dst || p.length < 6) return;
    for(let b = 6; b + 9 <= p.length; b += 9)
    {
        const x = p[b] >>> 0, y = p[b + 1] >>> 0, w = p[b + 3] >>> 0, h = p[b + 4] >>> 0;
        const sx = p[b + 6] >>> 0, sy = p[b + 7] >>> 0;
        if(src.data && dst.data)
        {
            const count = Math.min(w, src.data.length - sx, dst.data.length - x);
            if(count <= 0) continue;
            dst.data.set(src.data.subarray(sx, sx + count), x);
            for(const handle of dst.roles) if(handle) this.update_buffer(handle, x, dst.data.subarray(x, x + count));
            continue;
        }
        if(!src.handle || !dst.handle) continue;
        this.stretch(src, p[1] >>> 0, p[2] >>> 0, sx, sy, sx + w, sy + h, dst, p[4] >>> 0, p[5] >>> 0, x, y, x + w, y + h, true);
    }
};

/**
 * SURFACE_STRETCHBLT: src, dest, boxSrc, boxDest (x, y, z, w, h, d), mode
 */
SVGA3D.prototype.surface_stretch = function(p)
{
    const src = this.image(p, 0), dst = this.image(p, 3);
    if(!src || !dst || !src.handle || !dst.handle || p.length < 18) return;
    const sx = p[6] >>> 0, sy = p[7] >>> 0, dx = p[12] >>> 0, dy = p[13] >>> 0;
    this.stretch(src, p[1] >>> 0, p[2] >>> 0, sx, sy, sx + (p[9] >>> 0), sy + (p[10] >>> 0),
        dst, p[4] >>> 0, p[5] >>> 0, dx, dy, dx + (p[15] >>> 0), dy + (p[16] >>> 0), (p[18] >>> 0) === C.SVGA3D_STRETCH_BLT_POINT);
};

SVGA3D.prototype.stretch = function(src, src_face, src_mip, sl, st, sr, sb, dst, dst_face, dst_mip, dl, dt, dr, db, point)
{
    this.writer.begin(OP.STRETCH_RECT).u32(UTILITY_DEVICE)
        .u32(src.handle).u32(src_mip).i32(sl).i32(st).i32(sr).i32(sb)
        .u32(dst.handle).u32(dst_mip).i32(dl).i32(dt).i32(dr).i32(db)
        .u32(point ? 1 : 0).u32(src_face).u32(dst_face);
};

/**
 * GENERATE_MIPMAPS: sid, filter
 */
SVGA3D.prototype.generate_mipmaps = function(p)
{
    const surface = this.image(p, 0);
    if(surface && surface.handle) this.writer.begin(OP.GENERATE_MIPS).u32(UTILITY_DEVICE).u32(surface.handle);
};

// ---------------------------------------------------------------------------
// Contexts and their state

SVGA3D.prototype.define_context = function(cid)
{
    if(this.contexts.has(cid)) this.destroy_context(cid);
    // a new D9WG device: a fresh, default D3D9 state
    this.contexts.set(cid, new Context(cid, this.next_device++));
};

SVGA3D.prototype.destroy_context = function(cid)
{
    const context = this.contexts.get(cid);
    if(!context) return;
    this.contexts.delete(cid);
    for(const [key, handle] of context.shaders)
    {
        this.writer.begin(OP.DESTROY_RESOURCE).u32(handle).u32(key.startsWith(C.SVGA3D_SHADERTYPE_VS + ":") ? KIND.VERTEX_SHADER : KIND.PIXEL_SHADER);
    }
};

/** @return {Context} the context a command names in its first dword */
SVGA3D.prototype.context = function(p)
{
    const context = p.length ? this.contexts.get(p[0] >>> 0) : undefined;
    if(!context) this.warn_once("cid", "a command for an undefined context");
    return context || null;
};

SVGA3D.prototype.set_transform = function(p, f)
{
    const context = this.context(p);
    const state = p.length >= 18 ? d3d_transform(p[1] >>> 0) : -1;
    if(!context || state < 0) return;
    const w = this.writer.begin(OP.SET_TRANSFORM).u32(context.device).u32(state);
    for(let i = 0; i < 16; i++) w.f32(f[2 + i]);
};

SVGA3D.prototype.set_zrange = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    context.zrange = [f[1], f[2]];
    this.emit_viewport(context);
};

SVGA3D.prototype.set_viewport = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 5) return;
    context.viewport = [p[1] >>> 0, p[2] >>> 0, p[3] >>> 0, p[4] >>> 0];
    this.emit_viewport(context);
};

SVGA3D.prototype.emit_viewport = function(context)
{
    if(!context.viewport) return;
    const [x, y, width, height] = context.viewport;
    this.writer.begin(OP.SET_VIEWPORT).u32(context.device).u32(x).u32(y).u32(width).u32(height)
        .f32(context.zrange[0]).f32(context.zrange[1]).u32(0);
};

SVGA3D.prototype.set_scissor = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 5) return;
    const x = p[1] | 0, y = p[2] | 0;
    context.scissor = [x, y, x + (p[3] | 0), y + (p[4] | 0)];
    this.emit_scissor(context);
};

SVGA3D.prototype.emit_scissor = function(context)
{
    if(!context.scissor) return;
    const [l, t, r, b] = context.scissor;
    this.writer.begin(OP.SET_SCISSOR_RECT).u32(context.device).i32(l).i32(t).i32(r).i32(b);
};

SVGA3D.prototype.render_state = function(context, state, value)
{
    this.writer.begin(OP.SET_RENDER_STATE).u32(context.device).u32(state).u32(value).u32(0);
};

/**
 * SETRENDERSTATE: cid, then SVGA3dRenderState[] (state, value)
 */
SVGA3D.prototype.set_render_states = function(p, f)
{
    const context = this.context(p);
    if(!context) return;
    for(let at = 1; at + 2 <= p.length; at += 2)
    {
        const state = p[at] >>> 0, value = p[at + 1] >>> 0;
        const same = SAME_RENDER_STATES[state];
        if(same !== undefined)
        {
            this.render_state(context, same, value);
            continue;
        }
        switch(state)
        {
            case C.SVGA3D_RS_SRCBLEND: this.render_state(context, D3DRS.SRCBLEND, d3d_blend(value)); break;
            case C.SVGA3D_RS_DSTBLEND: this.render_state(context, D3DRS.DESTBLEND, d3d_blend(value)); break;
            case C.SVGA3D_RS_SRCBLENDALPHA: this.render_state(context, D3DRS.SRCBLENDALPHA, d3d_blend(value)); break;
            case C.SVGA3D_RS_DSTBLENDALPHA: this.render_state(context, D3DRS.DESTBLENDALPHA, d3d_blend(value)); break;
            case C.SVGA3D_RS_FILLMODE:
                // SVGA3dFillMode: mode, face (D3D9 fills both faces alike)
                this.render_state(context, D3DRS.FILLMODE, value & 0xFFFF);
                break;
            case C.SVGA3D_RS_CULLMODE:
                context.cull = value;
                this.emit_cull(context);
                break;
            case C.SVGA3D_RS_FRONTWINDING:
                context.winding = value;
                this.emit_cull(context);
                break;
            case C.SVGA3D_RS_ALPHAREF:
                // a float in [0, 1]; D3D9's is 0..255
                this.render_state(context, D3DRS.ALPHAREF, Math.max(0, Math.min(255, Math.round(f[at + 1] * 255))));
                break;
            case C.SVGA3D_RS_FOGMODE:
            {
                // SVGA3dFogMode: function (16 bits), type, base
                const fn = value & 0xFFFF, type = value >>> 16 & 0xFF, base = value >>> 24 & 0xFF;
                const mode = fn >= C.SVGA3D_FOGFUNC_EXP && fn <= C.SVGA3D_FOGFUNC_LINEAR ? fn : D3DFOG_NONE;
                this.render_state(context, D3DRS.FOGTABLEMODE, type === C.SVGA3D_FOGTYPE_PIXEL ? mode : D3DFOG_NONE);
                this.render_state(context, D3DRS.FOGVERTEXMODE, type === C.SVGA3D_FOGTYPE_VERTEX ? mode : D3DFOG_NONE);
                this.render_state(context, D3DRS.RANGEFOGENABLE, base === C.SVGA3D_FOGBASE_RANGEBASED ? 1 : 0);
                break;
            }
            case C.SVGA3D_RS_RANGEFOGENABLE:
                this.render_state(context, D3DRS.RANGEFOGENABLE, value);
                break;
            case C.SVGA3D_RS_OUTPUTGAMMA:
                // the output's gamma: 2.2 is sRGB
                this.render_state(context, D3DRS.SRGBWRITEENABLE, f[at + 1] > 1.5 ? 1 : 0);
                break;
            default:
                if(state >= C.SVGA3D_RS_WRAP0 && state <= C.SVGA3D_RS_WRAP15)
                {
                    const i = state - C.SVGA3D_RS_WRAP0;
                    this.render_state(context, i < 8 ? D3DRS.WRAP0 + i : D3DRS.WRAP8 + i - 8, value);
                }
                // LINEPATTERN, ZBIAS, ZVISIBLE, COORDINATETYPE, LINEWIDTH,
                // TRANSPARENCYANTIALIAS: nothing in D3D9 or WebGPU
                break;
        }
    }
};

/**
 * CULLMODE says which face is culled, FRONTWINDING which winding is front;
 * D3D9 says which winding is culled
 */
SVGA3D.prototype.emit_cull = function(context)
{
    let cull = D3DCULL_NONE;
    if(context.cull === C.SVGA3D_FACE_FRONT || context.cull === C.SVGA3D_FACE_BACK)
    {
        const front_cw = context.winding !== C.SVGA3D_FRONTWINDING_CCW;
        const cull_cw = (context.cull === C.SVGA3D_FACE_FRONT) === front_cw;
        cull = cull_cw ? D3DCULL_CW : D3DCULL_CCW;
    }
    this.render_state(context, D3DRS.CULLMODE, cull);
};

/**
 * SETRENDERTARGET: cid, type, target (sid, face, mipmap)
 */
SVGA3D.prototype.set_render_target = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 5) return;
    const type = p[1] >>> 0, sid = p[2] >>> 0, face = p[3] >>> 0, mip = p[4] >>> 0;
    const surface = sid === INVALID ? null : this.surfaces.get(sid) || null;
    const handle = surface && surface.handle || 0;
    if(type === C.SVGA3D_RT_DEPTH)
    {
        const size = surface ? surface.sizes[Math.min(mip, surface.sizes.length - 1)] : [0, 0];
        this.writer.begin(OP.SET_DEPTH_STENCIL_SURFACE_LEVEL).u32(context.device).u32(handle).u32(mip).u32(size[0]).u32(size[1]);
    }
    else if(type === C.SVGA3D_RT_STENCIL)
    {
        // the depth surface carries the stencil too
    }
    else if(type >= C.SVGA3D_RT_COLOR0 && type <= C.SVGA3D_RT_COLOR3)
    {
        const index = type - C.SVGA3D_RT_COLOR0;
        this.writer.begin(OP.SET_RENDER_TARGET).u32(context.device).u32(index).u32(handle).u32(mip).u32(face);
        if(index === 0)
        {
            context.target = surface;
            // D3D9 resets the viewport and scissor with target 0; SVGA3D does not
            this.emit_viewport(context);
            this.emit_scissor(context);
        }
    }
};

/**
 * SETTEXTURESTATE: cid, then SVGA3dTextureState[] (stage, name, value)
 */
SVGA3D.prototype.set_texture_states = function(p, f)
{
    const context = this.context(p);
    if(!context) return;
    const w = this.writer, device = context.device;
    const stage_state = (stage, state, value) => {
        if(stage < 8) w.begin(OP.SET_TEXTURE_STAGE_STATE).u32(device).u32(stage).u32(state).u32(value);
    };
    for(let at = 1; at + 3 <= p.length; at += 3)
    {
        const stage = p[at] >>> 0, name = p[at + 1] >>> 0, value = p[at + 2] >>> 0;
        const sampler = stage < SAMPLERS_PS ? stage : D3DVERTEXTEXTURESAMPLER0 + stage - SAMPLERS_PS;
        const sampler_state = (state, v) => w.begin(OP.SET_SAMPLER_STATE).u32(device).u32(sampler).u32(state).u32(v);
        switch(name)
        {
            case C.SVGA3D_TS_BIND_TEXTURE:
            {
                const surface = value === INVALID ? null : this.surfaces.get(value);
                w.begin(OP.SET_TEXTURE).u32(device).u32(sampler).u32(surface && surface.handle || 0).u32(0);
                break;
            }
            case C.SVGA3D_TS_COLOROP: stage_state(stage, D3DTSS.COLOROP, TEXTURE_OPS[value] || 1); break;
            case C.SVGA3D_TS_ALPHAOP: stage_state(stage, D3DTSS.ALPHAOP, TEXTURE_OPS[value] || 1); break;
            case C.SVGA3D_TS_COLORARG0: stage_state(stage, D3DTSS.COLORARG0, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_COLORARG1: stage_state(stage, D3DTSS.COLORARG1, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_COLORARG2: stage_state(stage, D3DTSS.COLORARG2, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_ALPHAARG0: stage_state(stage, D3DTSS.ALPHAARG0, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_ALPHAARG1: stage_state(stage, D3DTSS.ALPHAARG1, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_ALPHAARG2: stage_state(stage, D3DTSS.ALPHAARG2, d3d_texture_argument(value)); break;
            case C.SVGA3D_TS_BUMPENVMAT00: stage_state(stage, D3DTSS.BUMPENVMAT00, value); break;
            case C.SVGA3D_TS_BUMPENVMAT01: stage_state(stage, D3DTSS.BUMPENVMAT01, value); break;
            case C.SVGA3D_TS_BUMPENVMAT10: stage_state(stage, D3DTSS.BUMPENVMAT10, value); break;
            case C.SVGA3D_TS_BUMPENVMAT11: stage_state(stage, D3DTSS.BUMPENVMAT11, value); break;
            case C.SVGA3D_TS_BUMPENVLSCALE: stage_state(stage, D3DTSS.BUMPENVLSCALE, value); break;
            case C.SVGA3D_TS_BUMPENVLOFFSET: stage_state(stage, D3DTSS.BUMPENVLOFFSET, value); break;
            case C.SVGA3D_TS_CONSTANT: stage_state(stage, D3DTSS.CONSTANT, value); break;
            case C.SVGA3D_TS_TEXTURETRANSFORMFLAGS: stage_state(stage, D3DTSS.TEXTURETRANSFORMFLAGS, d3d_texture_transform_flags(value)); break;
            case C.SVGA3D_TS_TEXCOORDINDEX:
            case C.SVGA3D_TS_TEXCOORDGEN:
                // one D3D9 state: the index, with the generation in its high bits
                if(stage >= SAMPLERS_PS) break;
                if(name === C.SVGA3D_TS_TEXCOORDINDEX) context.texcoord_index[stage] = value;
                else context.texcoord_gen[stage] = value;
                stage_state(stage, D3DTSS.TEXCOORDINDEX, context.texcoord_index[stage] | d3d_texcoord_generation(context.texcoord_gen[stage]));
                break;
            case C.SVGA3D_TS_ADDRESSU: sampler_state(D3DSAMP.ADDRESSU, d3d_address(value)); break;
            case C.SVGA3D_TS_ADDRESSV: sampler_state(D3DSAMP.ADDRESSV, d3d_address(value)); break;
            case C.SVGA3D_TS_ADDRESSW: sampler_state(D3DSAMP.ADDRESSW, d3d_address(value)); break;
            case C.SVGA3D_TS_MIPFILTER: sampler_state(D3DSAMP.MIPFILTER, value); break;
            case C.SVGA3D_TS_MAGFILTER: sampler_state(D3DSAMP.MAGFILTER, value); break;
            case C.SVGA3D_TS_MINFILTER: sampler_state(D3DSAMP.MINFILTER, value); break;
            case C.SVGA3D_TS_BORDERCOLOR: sampler_state(D3DSAMP.BORDERCOLOR, value); break;
            case C.SVGA3D_TS_TEXTURE_MIPMAP_LEVEL: sampler_state(D3DSAMP.MAXMIPLEVEL, value); break;
            case C.SVGA3D_TS_TEXTURE_LOD_BIAS: sampler_state(D3DSAMP.MIPMAPLODBIAS, value); break;
            case C.SVGA3D_TS_TEXTURE_ANISOTROPIC_LEVEL: sampler_state(D3DSAMP.MAXANISOTROPY, value); break;
            case C.SVGA3D_TS_GAMMA:
                // the texture's gamma: 2.2 is sRGB
                sampler_state(D3DSAMP.SRGBTEXTURE, f[at + 2] > 1.5 ? 1 : 0);
                break;
            default:
                // the colour key states: not in D3D9
                break;
        }
    }
};

/**
 * SETMATERIAL: cid, face, SVGA3dMaterial (diffuse, ambient, specular, emissive, shininess)
 */
SVGA3D.prototype.set_material = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 19) return;
    // D3D9 has one material, for both faces
    if((p[1] >>> 0) === C.SVGA3D_FACE_BACK) return;
    const w = this.writer.begin(OP.SET_MATERIAL).u32(context.device);
    for(let i = 0; i < 17; i++) w.f32(f[2 + i]);
};

/**
 * SETLIGHTDATA: cid, index, SVGA3dLightData
 */
SVGA3D.prototype.set_light = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 31) return;
    const w = this.writer.begin(OP.SET_LIGHT).u32(context.device).u32(p[1] >>> 0).u32(d3d_light_type(p[2] >>> 0));
    // diffuse, specular, ambient (4 each), position, direction (3 of 4 each)
    for(let i = 4; i < 16; i++) w.f32(f[i]);
    for(let i = 16; i < 19; i++) w.f32(f[i]);
    for(let i = 20; i < 23; i++) w.f32(f[i]);
    // range, falloff, attenuation 0-2, theta, phi
    for(let i = 24; i < 31; i++) w.f32(f[i]);
};

SVGA3D.prototype.set_light_enabled = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    this.writer.begin(OP.LIGHT_ENABLE).u32(context.device).u32(p[1] >>> 0).u32(p[2] ? 1 : 0).u32(0);
};

SVGA3D.prototype.set_clip_plane = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 6) return;
    this.writer.begin(OP.SET_CLIP_PLANE).u32(context.device).u32(p[1] >>> 0).f32(f[2]).f32(f[3]).f32(f[4]).f32(f[5]);
};

/**
 * CLEAR: cid, flags, color, depth, stencil, then SVGA3dRect[] (x, y, w, h)
 */
SVGA3D.prototype.clear = function(p, f)
{
    const context = this.context(p);
    if(!context || p.length < 5) return;
    const rects = Math.floor((p.length - 5) / 4);
    // the flag bits are D3DCLEAR's
    const w = this.writer.begin(OP.CLEAR).u32(context.device).u32(p[1] & 7).u32(p[2] >>> 0).f32(f[3]).u32(p[4] >>> 0).u32(rects);
    for(let i = 0; i < rects; i++)
    {
        const at = 5 + 4 * i, x = p[at] | 0, y = p[at + 1] | 0;
        w.i32(x).i32(y).i32(x + (p[at + 2] | 0)).i32(y + (p[at + 3] | 0));
    }
};

// ---------------------------------------------------------------------------
// Shaders

/** 64-bit FNV-1a over the tokens' bytes (d3d9_shader_pipeline.js hashTokens) */
function hash_tokens(tokens)
{
    let low = 0x84222325, high = 0xcbf29ce4;
    for(let i = 0; i < tokens.length * 4; i++)
    {
        low = (low ^ tokens[i >> 2] >>> 8 * (i & 3) & 0xFF) >>> 0;
        // times 0x100000001b3, in 16-bit limbs
        const l0 = low & 0xFFFF, l1 = low >>> 16, h0 = high & 0xFFFF, h1 = high >>> 16;
        const r0 = l0 * 0x1b3;
        const r1 = l1 * 0x1b3 + (r0 >>> 16);
        const r2 = h0 * 0x1b3 + (r1 >>> 16) + l0;
        const r3 = h1 * 0x1b3 + (r2 >>> 16) + l1;
        low = ((r1 & 0xFFFF) << 16 | r0 & 0xFFFF) >>> 0;
        high = ((r3 & 0xFFFF) << 16 | r2 & 0xFFFF) >>> 0;
    }
    return [low, high];
}

/**
 * SHADER_DEFINE: cid, shid, type, then D3D9 shader tokens
 */
SVGA3D.prototype.define_shader = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 4) return;
    const shid = p[1] >>> 0, type = p[2] >>> 0;
    if(type !== C.SVGA3D_SHADERTYPE_VS && type !== C.SVGA3D_SHADERTYPE_PS) return;
    const key = type + ":" + shid;
    if(context.shaders.has(key)) this.destroy_shader(p);
    const handle = SHADER_HANDLE_BASE + 2 * this.next_shader++;
    context.shaders.set(key, handle);
    const tokens = p.subarray(3);
    const [low, high] = hash_tokens(tokens);
    const w = this.writer.begin(type === C.SVGA3D_SHADERTYPE_VS ? OP.CREATE_VERTEX_SHADER : OP.CREATE_PIXEL_SHADER)
        .u32(context.device).u32(handle).u32(tokens.length);
    const code = w.placeholder();
    w.u32(low).u32(high);
    w.patch(code, w.data(new Uint8Array(tokens.buffer, tokens.byteOffset, tokens.byteLength)));
};

SVGA3D.prototype.destroy_shader = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    const type = p[2] >>> 0, key = type + ":" + (p[1] >>> 0);
    const handle = context.shaders.get(key);
    if(!handle) return;
    context.shaders.delete(key);
    this.writer.begin(OP.DESTROY_RESOURCE).u32(handle).u32(type === C.SVGA3D_SHADERTYPE_VS ? KIND.VERTEX_SHADER : KIND.PIXEL_SHADER);
};

/**
 * SET_SHADER: cid, type, shid (SVGA3D_INVALID_ID: fixed function)
 */
SVGA3D.prototype.set_shader = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    const type = p[1] >>> 0, shid = p[2] >>> 0;
    const handle = shid === INVALID ? 0 : context.shaders.get(type + ":" + shid) || 0;
    if(type === C.SVGA3D_SHADERTYPE_VS) this.writer.begin(OP.SET_VERTEX_SHADER).u32(context.device).u32(handle);
    else if(type === C.SVGA3D_SHADERTYPE_PS) this.writer.begin(OP.SET_PIXEL_SHADER).u32(context.device).u32(handle);
};

/**
 * SET_SHADER_CONST: cid, reg, type, ctype, then four values per register
 */
SVGA3D.prototype.set_shader_const = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 8) return;
    const reg = p[1] >>> 0, type = p[2] >>> 0, ctype = p[3] >>> 0;
    const count = Math.floor((p.length - 4) / 4);
    const vs = type === C.SVGA3D_SHADERTYPE_VS;
    if(!vs && type !== C.SVGA3D_SHADERTYPE_PS) return;
    let op, data;
    if(ctype === C.SVGA3D_CONST_TYPE_BOOL)
    {
        op = vs ? OP.SET_VERTEX_SHADER_CONSTANT_B : OP.SET_PIXEL_SHADER_CONSTANT_B;
        const bools = new Uint32Array(count);
        for(let i = 0; i < count; i++) bools[i] = p[4 + 4 * i] ? 1 : 0;
        data = new Uint8Array(bools.buffer);
    }
    else
    {
        op = ctype === C.SVGA3D_CONST_TYPE_INT ?
            (vs ? OP.SET_VERTEX_SHADER_CONSTANT_I : OP.SET_PIXEL_SHADER_CONSTANT_I) :
            (vs ? OP.SET_VERTEX_SHADER_CONSTANT_F : OP.SET_PIXEL_SHADER_CONSTANT_F);
        data = new Uint8Array(p.buffer, p.byteOffset + 16, count * 16);
    }
    const w = this.writer.begin(op).u32(context.device).u32(reg).u32(count);
    w.patch(w.placeholder(), w.data(data));
};

// ---------------------------------------------------------------------------
// Drawing

/**
 * DRAW_PRIMITIVES: cid, numVertexDecls, numRanges, then SVGA3dVertexDecl[]
 * (type, method, usage, usageIndex, surfaceId, offset, stride, first, last),
 * SVGA3dPrimitiveRange[] (primType, primitiveCount, indexArray surfaceId,
 * offset, stride, indexWidth, indexBias) and maybe SVGA3dVertexDivisor[]
 */
SVGA3D.prototype.draw_primitives = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 3) return;
    const decls = p[1] >>> 0, ranges = p[2] >>> 0;
    const ranges_at = 3 + 9 * decls, divisors_at = ranges_at + 7 * ranges;
    if(decls > 32 || ranges > 32 || p.length < divisors_at) return;
    const has_divisors = p.length >= divisors_at + decls;
    const w = this.writer, device = context.device;

    // Elements into streams: one per buffer and stride, split where an
    // element would not fit inside the stride from the stream's start
    const elements = [];
    for(let i = 0; i < decls; i++)
    {
        const at = 3 + 9 * i;
        elements.push({
            type: p[at] >>> 0, method: p[at + 1] >>> 0, usage: p[at + 2] >>> 0, usage_index: p[at + 3] >>> 0,
            sid: p[at + 4] >>> 0, offset: p[at + 5] >>> 0, stride: p[at + 6] >>> 0,
            divisor: has_divisors ? p[divisors_at + i] >>> 0 : 0,
        });
    }
    const order = elements.slice().sort((a, b) => a.sid - b.sid || a.stride - b.stride || a.divisor - b.divisor || a.offset - b.offset);
    const streams = [];
    for(const e of order)
    {
        const size = DECL_SIZES[e.type] || 4;
        let stream = streams[streams.length - 1];
        if(!stream || stream.sid !== e.sid || stream.stride !== e.stride || stream.divisor !== e.divisor ||
            e.stride && e.offset + size - stream.base > e.stride || e.offset - stream.base > 0xFFFF)
        {
            stream = { sid: e.sid, stride: e.stride, divisor: e.divisor, base: e.offset };
            streams.push(stream);
        }
        e.stream = streams.length - 1;
    }
    if(streams.length > MAX_STREAMS) return this.warn_once("streams", "a draw with more than 16 vertex streams");

    // the declaration, in the guest's element order (D3DVERTEXELEMENT9)
    const declaration = new Uint8Array(8 * elements.length);
    const view = new DataView(declaration.buffer);
    elements.forEach((e, i) => {
        view.setUint16(8 * i, e.stream, true);
        view.setUint16(8 * i + 2, e.offset - streams[e.stream].base, true);
        declaration.set([e.type, e.method, e.usage, e.usage_index], 8 * i + 4);
    });
    const key = declaration.join(",");
    let handle = this.declarations.get(key);
    if(!handle)
    {
        handle = this.next_handle++;
        this.declarations.set(key, handle);
        w.begin(OP.CREATE_VERTEX_DECLARATION).u32(UTILITY_DEVICE).u32(handle).u32(elements.length).u32(0);
        w.data(declaration);
    }
    w.begin(OP.SET_VERTEX_DECLARATION).u32(device).u32(handle);

    let instanced = 0;
    for(let i = 0; i < streams.length; i++)
    {
        const s = streams[i], surface = this.surfaces.get(s.sid);
        const buffer = surface ? this.buffer_role(surface, ROLE_VERTEX) : 0;
        w.begin(OP.SET_STREAM_SOURCE).u32(device).u32(i).u32(buffer).u32(s.stride).u32(s.base).u32(0);
        // SVGA3dVertexDivisor has D3DSTREAMSOURCE_INDEXEDDATA's and _INSTANCEDATA's bits
        if(s.divisor)
        {
            w.begin(OP.SET_STREAM_SOURCE_FREQ).u32(device).u32(i).u32(s.divisor);
            instanced |= 1 << i;
        }
    }
    // streams that had a frequency and now do not
    for(let i = 0; i < MAX_STREAMS; i++)
    {
        if(context.instanced & ~instanced & 1 << i) w.begin(OP.SET_STREAM_SOURCE_FREQ).u32(device).u32(i).u32(1);
    }
    context.instanced = instanced;

    for(let r = 0; r < ranges; r++)
    {
        const at = ranges_at + 7 * r;
        const type = PRIMITIVES[p[at] >>> 0], count = p[at + 1] >>> 0;
        const index_sid = p[at + 2] >>> 0, index_offset = p[at + 3] >>> 0;
        const index_width = p[at + 5] >>> 0, bias = p[at + 6] | 0;
        if(!type || !count) continue;
        if(index_sid === INVALID)
        {
            // not indexed: indexBias is the first vertex
            w.begin(OP.DRAW_PRIMITIVE).u32(device).u32(type).u32(bias).u32(count);
            continue;
        }
        const surface = this.surfaces.get(index_sid);
        if(!surface || (index_width !== 2 && index_width !== 4) || index_offset % index_width) continue;
        const buffer = this.buffer_role(surface, index_width === 2 ? ROLE_INDEX16 : ROLE_INDEX32);
        w.begin(OP.SET_INDICES).u32(device).u32(buffer);
        w.begin(OP.DRAW_INDEXED_PRIMITIVE).u32(device).u32(type).i32(bias).u32(0)
            .u32(primitive_vertices(type, count)).u32(index_offset / index_width).u32(count);
    }
};

// ---------------------------------------------------------------------------
// Queries

/**
 * BEGIN_QUERY: cid, type. Only occlusion is declared.
 */
SVGA3D.prototype.begin_query = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 2 || (p[1] >>> 0) !== C.SVGA3D_QUERYTYPE_OCCLUSION) return;
    // a D9WG query per BEGIN/END pair: results can overlap
    const handle = context.query = this.next_handle++;
    this.writer.begin(OP.CREATE_QUERY).u32(context.device).u32(handle).u32(D3DQUERYTYPE_OCCLUSION).u32(0);
    this.writer.begin(OP.BEGIN_QUERY).u32(context.device).u32(handle).u32(0).u32(0);
};

/**
 * END_QUERY: cid, type, guestResult (gmrId, offset). The result is pending
 * until the renderer has the count.
 */
SVGA3D.prototype.end_query = function(p)
{
    const context = this.context(p);
    if(!context || p.length < 4) return;
    const gmr = p[2] >>> 0, offset = p[3] >>> 0;
    const result = (state, value) => {
        const bytes = new Uint32Array([12, state, value]);
        this.device.gmrs.write(gmr, offset, new Uint8Array(bytes.buffer));
    };
    const handle = context.query;
    if((p[1] >>> 0) !== C.SVGA3D_QUERYTYPE_OCCLUSION || !handle)
    {
        result(C.SVGA3D_QUERYSTATE_FAILED, 0);
        return;
    }
    context.query = 0;
    result(C.SVGA3D_QUERYSTATE_PENDING, 0);
    const id = this.next_request++;
    const slot = id % QUERY_SLOTS * QUERY_SLOT_BYTES;
    this.requests.set(id, (value, status) => {
        const count = value ? value[0] | value[1] << 8 | value[2] << 16 | value[3] << 24 : 0;
        result(status === RESPONSE_OK ? C.SVGA3D_QUERYSTATE_SUCCEEDED : C.SVGA3D_QUERYSTATE_FAILED, count >>> 0);
    });
    this.writer.begin(OP.END_QUERY).u32(context.device).u32(handle).u32(slot).u32(id);
    this.writer.begin(OP.DESTROY_RESOURCE).u32(handle).u32(KIND.QUERY);
};

// ---------------------------------------------------------------------------
// Pictures to the screen

/**
 * PRESENT: sid, then SVGA3dCopyRect[] (x, y, w, h, srcx, srcy): the
 * surface's rectangles to the desktop
 */
SVGA3D.prototype.present = function(p)
{
    const surface = this.image(p, 0);
    if(!surface || !surface.handle) return;
    const rects = [];
    for(let at = 1; at + 6 <= p.length; at += 6)
    {
        rects.push({ dx: p[at] | 0, dy: p[at + 1] | 0, w: p[at + 2] | 0, h: p[at + 3] | 0, sx: p[at + 4] | 0, sy: p[at + 5] | 0 });
    }
    if(!rects.length)
    {
        const [width, height] = surface.sizes[0];
        rects.push({ dx: 0, dy: 0, w: width, h: height, sx: 0, sy: 0 });
    }
    for(const r of rects)
    {
        this.to_desktop(surface, r.sx, r.sy, r.w, r.h, r.dx, r.dy, r.w, r.h, null);
    }
};

/**
 * BLIT_SURFACE_TO_SCREEN: srcImage, srcRect (l, t, r, b), destScreenId,
 * destRect (l, t, r, b, in the screen), then clip rectangles in the screen
 */
SVGA3D.prototype.blit_surface_to_screen = function(p)
{
    const surface = this.image(p, 0);
    if(!surface || !surface.handle || p.length < 12) return;
    const screen = this.device.screens.screens.get(p[7] >>> 0);
    if(!screen) return;
    const sl = p[3] | 0, st = p[4] | 0, sw = (p[5] | 0) - sl, sh = (p[6] | 0) - st;
    const dl = p[8] | 0, dt = p[9] | 0, dw = (p[10] | 0) - dl, dh = (p[11] | 0) - dt;
    if(sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    let clips = null;
    if(p.length >= 16)
    {
        clips = [];
        for(let at = 12; at + 4 <= p.length; at += 4) clips.push([p[at] | 0, p[at + 1] | 0, p[at + 2] | 0, p[at + 3] | 0]);
    }
    this.to_desktop(surface, sl, st, sw, sh, screen.x + dl, screen.y + dt, dw, dh,
        clips && clips.map(([l, t, r, b]) => [screen.x + l, screen.y + t, screen.x + r, screen.y + b]));
};

/**
 * Read a rectangle of a surface back and draw it, scaled, on the desktop:
 * into the screens it covers, or into the frame buffer without screens
 * @param {Array<!Array<number>>} clips rectangles (l, t, r, b) on the desktop it is limited to
 */
SVGA3D.prototype.to_desktop = function(surface, sx, sy, sw, sh, dx, dy, dw, dh, clips)
{
    const [width, height] = surface.sizes[0];
    if(sx < 0 || sy < 0 || sx + sw > width || sy + sh > height)
    {
        this.warn_once("present-bounds", "a present outside of its surface");
        return;
    }
    const pixel = pixel_reader(surface.info.d3d);
    if(!pixel) return this.warn_once("present-format" + surface.format, "presenting format " + surface.format + " is not supported");
    const device = this.device;
    const bytes_per = surface.info.bytes;
    this.read_rows(surface, 0, 0, sy, sh, (data, first, count, pitch) => {
        // the destination rows this piece of source rows makes
        const top = dy + Math.ceil((first - sy) * dh / sh), bottom = dy + Math.ceil((first - sy + count) * dh / sh);
        const put = (rgba, row_at, left, right, y) => {
            const source_row = sy + Math.floor((y - dy) * sh / dh) - first;
            for(let x = left; x < right; x++)
            {
                const column = sx + Math.floor((x - dx) * sw / dw);
                pixel(data, source_row * pitch + column * bytes_per, rgba, row_at + x * 4);
            }
        };
        const screens = device.screens.screens;
        if(screens.size)
        {
            for(const screen of screens.values())
            {
                for(const [l, t, r, b] of clips || [[dx, dy, dx + dw, dy + dh]])
                {
                    const left = Math.max(l, dx, screen.x), right = Math.min(r, dx + dw, screen.x + screen.width);
                    const y0 = Math.max(t, top, screen.y), y1 = Math.min(b, bottom, screen.y + screen.height);
                    if(left >= right || y0 >= y1) continue;
                    for(let y = y0; y < y1; y++)
                    {
                        // the screen's own coordinates
                        const row_at = ((y - screen.y) * screen.width - screen.x) * 4;
                        put(screen.rgba, row_at, left, right, y);
                    }
                    if(screen.backing) device.screens.copy_to_backing(screen, left - screen.x, y0 - screen.y, right - screen.x, y1 - screen.y);
                    screen.mark(y0 - screen.y, y1 - screen.y);
                }
            }
        }
        else if(device.svga_active() && device.bpp === 32)
        {
            // the frame buffer of the register mode: BGRX
            const vram = device.vram(), pitch_fb = device.pitch(), row = new Uint8ClampedArray(device.width * 4);
            for(const [l, t, r, b] of clips || [[dx, dy, dx + dw, dy + dh]])
            {
                const left = Math.max(l, dx, 0), right = Math.min(r, dx + dw, device.width);
                for(let y = Math.max(t, top, 0); y < Math.min(b, bottom, device.height); y++)
                {
                    put(row, 0, left, right, y);
                    for(let x = left; x < right; x++)
                    {
                        const at = y * pitch_fb + x * 4;
                        vram[at] = row[x * 4 + 2]; vram[at + 1] = row[x * 4 + 1]; vram[at + 2] = row[x * 4]; vram[at + 3] = 0;
                    }
                }
            }
            device.machine.mmio_ram_mark_dirty(device.vga.lfb_region);
        }
    });
};

/**
 * How to turn a pixel of a format into RGBA
 * @return {?function(!Uint8Array, number, !Uint8ClampedArray, number)}
 */
function pixel_reader(d3d)
{
    switch(d3d)
    {
        case D3DFMT.X8R8G8B8:
        case D3DFMT.A8R8G8B8:
            return (s, i, t, o) => { t[o] = s[i + 2]; t[o + 1] = s[i + 1]; t[o + 2] = s[i]; t[o + 3] = 255; };
        case D3DFMT.A8B8G8R8:
            return (s, i, t, o) => { t[o] = s[i]; t[o + 1] = s[i + 1]; t[o + 2] = s[i + 2]; t[o + 3] = 255; };
        case D3DFMT.R5G6B5:
            return (s, i, t, o) => {
                const v = s[i] | s[i + 1] << 8;
                t[o] = (v >> 11 & 31) * 255 / 31; t[o + 1] = (v >> 5 & 63) * 255 / 63; t[o + 2] = (v & 31) * 255 / 31; t[o + 3] = 255;
            };
        case D3DFMT.X1R5G5B5:
        case D3DFMT.A1R5G5B5:
            return (s, i, t, o) => {
                const v = s[i] | s[i + 1] << 8;
                t[o] = (v >> 10 & 31) * 255 / 31; t[o + 1] = (v >> 5 & 31) * 255 / 31; t[o + 2] = (v & 31) * 255 / 31; t[o + 3] = 255;
            };
        case D3DFMT.A2R10G10B10:
            return (s, i, t, o) => {
                const v = (s[i] | s[i + 1] << 8 | s[i + 2] << 16 | s[i + 3] << 24) >>> 0;
                t[o] = (v >> 20 & 1023) >> 2; t[o + 1] = (v >> 10 & 1023) >> 2; t[o + 2] = (v & 1023) >> 2; t[o + 3] = 255;
            };
    }
    return null;
}
