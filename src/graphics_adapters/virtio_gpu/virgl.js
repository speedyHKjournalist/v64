// virtio-gpu's 3D (virgl, plan section 6.3): the device side. Mesa's virgl
// driver sends gallium's state and draws as the virgl command stream
// (third_party/virgl/virgl_protocol.h) in SUBMIT_3D; it is translated here
// into what GX runs (src/browser/glbridge/gx/gx_executor.js), as SVGA's DX
// does: 3D resources are GX surfaces, and the context's state becomes the
// DX commands of a GX context (virgl_context.js), with TGSI shaders turned
// into VGPU10 programs (tgsi_vgpu10.js).
//
// GX runs in the renderer (the page's WebGPU device, or a headless
// Chrome's in tests), batch by batch; the device completes what waits for
// the GPU (fenced commands, readbacks) once the renderer says a batch is done.

import { LOG_VGA } from "../../const.js";
import { dbg_log } from "../../log.js";
import { GX, GXWriter, QUERY_REGION_BYTES, READBACK_HEADER_BYTES, READBACK_MAX_BYTES, RESPONSE_OK } from "../renderer_protocol.js";
import { virgl_format } from "./virgl_caps.js";
import { VirglContext } from "./virgl_context.js";
import * as C from "../vmware_svga/svga_constants.js";

/** A batch is sent at the latest when it is this big */
const BATCH_FLUSH_BYTES = 8 << 20;

// PIPE_TEXTURE_* (struct virtio_gpu_resource_create_3d's target)
export const TARGET = { BUFFER: 0, TEXTURE_1D: 1, TEXTURE_2D: 2, TEXTURE_3D: 3, TEXTURE_CUBE: 4, TEXTURE_RECT: 5,
    TEXTURE_1D_ARRAY: 6, TEXTURE_2D_ARRAY: 7, TEXTURE_CUBE_ARRAY: 8 };

/**
 * A 3D resource: a GX surface (the resource id is its sid) and, as for 2D
 * resources, the guest pages transfers copy from and to
 * @constructor
 */
export function Resource3D(id, target, format, bind, width, height, depth, array_size, last_level, nr_samples, flags)
{
    this.id = id;
    this.three_d = true;
    this.target = target;
    this.format = format;
    this.bind = bind;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.depth = Math.max(1, depth);
    this.array_size = Math.max(1, array_size);
    this.last_level = last_level;
    this.nr_samples = nr_samples;
    this.flags = flags;
    this.info = target === TARGET.BUFFER ? null : virgl_format(format);
    /** @type {Uint8Array} the picture as last read back, for the screen (a scanout's) */
    this.data = null;
    /** `data` is newer than the GPU's copy's picture (2D transfers wrote it,
     * nothing has drawn into it since) */
    this.host_newer = false;
    this.backing = null;
    this.backing_starts = null;
    this.backing_length = 0;
    this.uuid = null;
}

Resource3D.prototype.is_buffer = function()
{
    return this.target === TARGET.BUFFER;
};

/** Bytes per block, and the block size, of the resource's format (1 x 1 for buffers) */
Resource3D.prototype.block = function()
{
    if(this.is_buffer() || !this.info) return { bytes: 1, bw: 1, bh: 1 };
    const compressed = /^SVGA3D_BC/.test(this.info.name);
    const bytes = compressed ? (/BC1|BC4/.test(this.info.name) ? 8 : 16) : bytes_per_pixel(this.info.name);
    return { bytes, bw: compressed ? 4 : 1, bh: compressed ? 4 : 1 };
};

/**
 * @param {string} name SVGA3D format
 * @return {number}
 */
function bytes_per_pixel(name)
{
    if(/R32G32B32A32|D32_FLOAT_S8X24/.test(name)) return name.includes("D32") ? 8 : 16;
    if(/R32G32B32_/.test(name)) return 12;
    if(/R16G16B16A16|R32G32_/.test(name)) return 8;
    if(/R8G8B8A8|B8G8R8|R10G10B10A2|R11G11B10|R9G9B9E5|R16G16_|R32_|D32_FLOAT$|D24/.test(name)) return 4;
    if(/R8G8_|R16_|D16|B5G6R5|B5G5R5A1|B4G4R4A4/.test(name)) return 2;
    return 1;
}

/**
 * @constructor
 * @param {!Object} gpu the VirtioGPU
 * @param {!Object} renderer the channel: post(message, transfer), listen(handler)
 */
export function Virgl(gpu, renderer)
{
    this.gpu = gpu;
    this.renderer = renderer;
    this.gxw = new GXWriter();
    /** @type {!Map<number, !VirglContext>} */
    this.contexts = new Map();
    // batches sent and run
    this.submitted = 0;
    this.completed = 0;
    /** @type {!Array<{seq: number, run: function()}>} waiting for batches, in order */
    this.completions = [];
    /** @type {!Map<number, function(Uint8Array, number)>} request id -> answer */
    this.requests = new Map();
    this.next_request = 1;
    this.warned = new Set();
    /** @type {!Array<string>} the first warnings, for test harnesses */
    this.warnings = [];
    /** @type {!Object<number, number>} virgl commands seen, by VIRGL_CCMD_* (for the harnesses) */
    this.counts = {};
    renderer.listen(message => this.receive(message));
}

Virgl.prototype.warn_once = function(key, text)
{
    if(this.warned.has(key)) return;
    this.warned.add(key);
    if(this.warnings.length < 100) this.warnings.push(text);
    dbg_log("virgl: " + text, LOG_VGA);
};

/** A device reset: no contexts, nothing waits */
Virgl.prototype.reset = function()
{
    this.contexts.clear();
    this.gxw = new GXWriter();
    this.completions = [];
    for(const answer of this.requests.values()) answer(null, 0);
    this.requests.clear();
    this.completed = this.submitted;
    this.renderer.post({ "type": "reset" });
};

// ---------------------------------------------------------------------------
// Batches and completion

/** @return {boolean} whether something sent to the renderer has not run yet */
Virgl.prototype.busy = function()
{
    return !this.gxw.empty() || this.submitted > this.completed;
};

/** Send the batch being written */
Virgl.prototype.flush = function()
{
    if(this.gxw.empty()) return;
    const bytes = this.gxw.finish();
    const seq = ++this.submitted;
    this.renderer.post({ "type": "submit", "seq": seq, "bytes": bytes, "stream": "gx" }, [bytes.buffer]);
};

Virgl.prototype.flush_big = function()
{
    if(this.gxw.size() > BATCH_FLUSH_BYTES) this.flush();
};

/**
 * Run `run` once everything written so far has run (now, if it has)
 * @param {function()} run
 */
Virgl.prototype.after_work = function(run)
{
    this.flush();
    if(this.submitted > this.completed) this.completions.push({ seq: this.submitted, run });
    else run();
};

/**
 * A request for an answer from the renderer (a readback)
 * @param {function(Uint8Array, number)} answer
 * @return {number} its id
 */
Virgl.prototype.request = function(answer)
{
    const id = this.next_request++;
    this.requests.set(id, answer);
    return id;
};

/** @param {!Object} message from the renderer */
Virgl.prototype.receive = function(message)
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
            // The renderer is gone: let nothing wait (the guest's next
            // commands draw nothing)
            dbg_log("virgl: the renderer was lost: " + message["reason"], LOG_VGA);
            this.completed = this.submitted;
            for(const answer of this.requests.values()) answer(null, 0);
            this.requests.clear();
            while(this.completions.length) this.completions.shift().run();
            break;
    }
};

/**
 * A readback's answer in the response region
 * @param {number} offset
 * @param {!Uint8Array} bytes
 */
Virgl.prototype.answer = function(offset, bytes)
{
    if(bytes.length < READBACK_HEADER_BYTES || offset < QUERY_REGION_BYTES) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getUint32(0, true), count = view.getUint32(4, true), status = view.getUint32(12, true);
    const answer = this.requests.get(id);
    if(!answer) return;
    this.requests.delete(id);
    answer(status === RESPONSE_OK ? bytes.subarray(READBACK_HEADER_BYTES, READBACK_HEADER_BYTES + count) : null, status);
};

// ---------------------------------------------------------------------------
// Resources

/**
 * RESOURCE_CREATE_3D: a GX surface
 * @param {!Resource3D} r
 * @return {boolean} whether the format is one GX has
 */
Virgl.prototype.create_resource = function(r)
{
    if(r.is_buffer())
    {
        this.gxw.command(GX.SURFACE_DEFINE, [r.id, C.SVGA3D_BUFFER, 0, 0, r.width, 1, 1, 1, 1, 0, 0]);
        return true;
    }
    if(!r.info)
    {
        this.warn_once("format" + r.format, "virgl format " + r.format + " has no GX surface");
        return false;
    }
    const cube = r.target === TARGET.TEXTURE_CUBE || r.target === TARGET.TEXTURE_CUBE_ARRAY;
    const layers = r.target === TARGET.TEXTURE_3D ? 1 : r.array_size * (r.target === TARGET.TEXTURE_CUBE ? 6 : 1);
    const flags = r.target === TARGET.TEXTURE_3D ? C.SVGA3D_SURFACE_VOLUME : 0;
    this.gxw.command(GX.SURFACE_DEFINE, [r.id, r.info.svga, flags, 0, r.width, r.height,
        r.target === TARGET.TEXTURE_3D ? r.depth : 1, r.last_level + 1, layers, r.nr_samples > 1 ? r.nr_samples : 0, cube ? 1 : 0]);
    return true;
};

/** @param {!Resource3D} r */
Virgl.prototype.destroy_resource = function(r)
{
    this.gxw.command(GX.SURFACE_DESTROY, [r.id]);
    for(const context of this.contexts.values()) context.forget_resource(r.id);
};

/**
 * TRANSFER_TO_HOST_3D: a box of a level from the guest's backing (rows of
 * `stride` bytes, layers or slices `layer_stride` apart, from `offset`) into GX
 * @param {!Resource3D} r
 * @param {function(number, !Uint8Array, number, number):boolean} read_backing (from, out, at, length)
 */
Virgl.prototype.transfer_to_host = function(r, box, level, offset, stride, layer_stride, read_backing)
{
    const [x, y, z, w, h, d] = box;
    if(r.is_buffer())
    {
        const bytes = new Uint8Array(w);
        if(!read_backing(offset, bytes, 0, w)) return false;
        this.gxw.command(GX.SURFACE_UPLOAD, [r.id, 0, 0, x, 0, 0, w, 1, 1, w, w], bytes);
        this.flush_big();
        return true;
    }
    const { bytes: block_bytes, bw, bh } = r.block();
    const row_bytes = Math.ceil(w / bw) * block_bytes, rows = Math.ceil(h / bh);
    const volume = r.target === TARGET.TEXTURE_3D;
    const pitch = stride || row_bytes;
    const slice = layer_stride || pitch * rows;
    for(let i = 0; i < Math.max(1, d); i++)
    {
        const data = new Uint8Array(row_bytes * rows);
        for(let row = 0; row < rows; row++)
        {
            if(!read_backing(offset + i * slice + row * pitch, data, row * row_bytes, row_bytes)) return false;
        }
        this.gxw.command(GX.SURFACE_UPLOAD, [r.id, volume ? 0 : z + i, level, x, y, volume ? z + i : 0, w, h, 1,
            row_bytes, row_bytes * rows], data);
    }
    this.flush_big();
    return true;
};

/**
 * TRANSFER_FROM_HOST_3D: a box of a level from GX into the guest's backing;
 * `done` once its bytes are there
 * @param {!Resource3D} r
 * @param {function(number, !Uint8Array):boolean} write_backing (at, bytes)
 * @param {function()} done
 */
Virgl.prototype.transfer_from_host = function(r, box, level, offset, stride, layer_stride, write_backing, done)
{
    const [x, y, z, w, h, d] = box;
    if(r.is_buffer())
    {
        for(let at = 0; at < w; at += READBACK_MAX_BYTES)
        {
            const count = Math.min(READBACK_MAX_BYTES, w - at);
            const id = this.request(bytes => { if(bytes) write_backing(offset + at, bytes.subarray(0, count)); });
            this.gxw.command(GX.SURFACE_READBACK, [r.id, 0, 0, x + at, 0, 0, count, 1, 1, id]);
        }
        this.after_work(done);
        return;
    }
    const { bytes: block_bytes, bw, bh } = r.block();
    const row_bytes = Math.ceil(w / bw) * block_bytes, rows = Math.ceil(h / bh);
    const volume = r.target === TARGET.TEXTURE_3D;
    const pitch = stride || row_bytes;
    const slice = layer_stride || pitch * rows;
    const per_request = Math.max(1, Math.floor(READBACK_MAX_BYTES / row_bytes));
    for(let i = 0; i < Math.max(1, d); i++)
    {
        for(let first = 0; first < rows; first += per_request)
        {
            const count = Math.min(per_request, rows - first);
            const at = offset + i * slice + first * pitch;
            const id = this.request(bytes => {
                if(!bytes) return;
                for(let row = 0; row < count; row++) write_backing(at + row * pitch, bytes.subarray(row * row_bytes, (row + 1) * row_bytes));
            });
            this.gxw.command(GX.SURFACE_READBACK, [r.id, volume ? 0 : z + i, level, x, y + first * bh, volume ? z + i : 0,
                w, Math.min(count * bh, h - first * bh), 1, id]);
        }
    }
    this.after_work(done);
};

/**
 * The picture of a scanout's resource (level 0, layer 0) into its `data`,
 * then `done` (the rows that came)
 * @param {!Resource3D} r
 * @param {function(number, number)} done first row, rows
 */
Virgl.prototype.read_picture = function(r, x, y, w, h, done)
{
    const { bytes: block_bytes } = r.block();
    const pitch = r.width * block_bytes;
    if(!r.data || r.data.length !== pitch * r.height) r.data = new Uint8Array(pitch * r.height);
    const row_bytes = w * block_bytes;
    const per_request = Math.max(1, Math.floor(READBACK_MAX_BYTES / row_bytes));
    for(let first = y; first < y + h; first += per_request)
    {
        const count = Math.min(per_request, y + h - first);
        const id = this.request(bytes => {
            if(!bytes) return;
            for(let row = 0; row < count; row++)
            {
                r.data.set(bytes.subarray(row * row_bytes, (row + 1) * row_bytes), (first + row) * pitch + x * block_bytes);
            }
            done(first, count);
        });
        this.gxw.command(GX.SURFACE_READBACK, [r.id, 0, 0, x, first, 0, w, count, 1, id]);
    }
    this.flush();
};

// ---------------------------------------------------------------------------
// Contexts

/** CTX_CREATE */
Virgl.prototype.create_context = function(ctx_id)
{
    if(this.contexts.has(ctx_id)) this.destroy_context(ctx_id);
    this.contexts.set(ctx_id, new VirglContext(this, ctx_id));
};

/** CTX_DESTROY */
Virgl.prototype.destroy_context = function(ctx_id)
{
    const context = this.contexts.get(ctx_id);
    if(!context) return;
    context.destroy();
    this.contexts.delete(ctx_id);
};

/**
 * SUBMIT_3D: a context's command stream
 * @param {number} ctx_id
 * @param {!Uint32Array} words
 * @param {function(number):?Object} resource by id
 */
Virgl.prototype.submit = function(ctx_id, words, resource)
{
    const context = this.contexts.get(ctx_id);
    if(!context)
    {
        this.warn_once("ctx" + ctx_id, "SUBMIT_3D for context " + ctx_id + ", which does not exist");
        return;
    }
    context.run(words, resource);
    this.flush_big();
};
