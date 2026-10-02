// What the display adapters' devices and their renderer
// (src/browser/glbridge/svga_renderer.js) share: GX batches (the GX writer
// and opcodes; gx/gx_executor.js runs them) and the response region the
// renderer writes answers into (query results, readbacks). vmware_svga and
// virtio_gpu both write GX.

/** Where the executor writes answers: offsets into a 16 MiB arena whose last
 * 4 MiB are the response region (query slots first, then readbacks) */
export const RESPONSE_REGION_OFFSET = 12 << 20;
export const RESPONSE_REGION_BYTES = 4 << 20;
export const QUERY_SLOT_BYTES = 16;
export const QUERY_REGION_BYTES = 16 * 1024;
export const READBACK_HEADER_BYTES = 16;
/** The largest readback payload one request may carry */
export const READBACK_MAX_BYTES = RESPONSE_REGION_BYTES - QUERY_REGION_BYTES - READBACK_HEADER_BYTES - 16;
export const RESPONSE_OK = 1;
export const RESPONSE_FAILED = 2;

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
    CLEAR_RTV_INTEGER: 15,  // cid, render target view, signed, 4 values (DX's clear has floats)
};

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
