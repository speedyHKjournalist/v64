// D9WG batches, the renderer's input. The SVGA3D layer (svga3d.js) turns the
// guest's legacy 3D commands into the protocol the D3D9 executor
// (src/browser/glbridge/d3d9-webgpu/d3d9_executor.js) already runs for the
// guest D3D9 proxy: glbridge/d3d9proxy/d3d9_protocol.h, version 1.7. A batch
// is self-contained (inline data travels in it), so it can be recorded and
// replayed without the guest.

export const D9WG_MAGIC = 0x47573944;
const VERSION_MAJOR = 1;
const VERSION_MINOR = 7;
const BATCH_HEADER_BYTES = 32;
const COMMAND_HEADER_BYTES = 16;

/** The batch flag that makes the executor submit the frame's GPU work */
export const D9WG_BATCH_FLAG_PRESENT = 1;

// Every batch carries this session: one guest device, one resource namespace
const SESSION_LOW = 0x41475653;     // "SVGA"
const SESSION_HIGH = 0;

/** Opcodes (enum D9WGOpcode) */
export const OP = {
    CLEAR: 5,
    STRETCH_RECT: 8,
    COLOR_FILL: 9,
    READBACK_SURFACE: 12,
    CREATE_BUFFER: 0x100,
    UPDATE_BUFFER: 0x101,
    DESTROY_RESOURCE: 0x103,
    CREATE_TEXTURE_2D: 0x110,
    CREATE_TEXTURE_CUBE: 0x111,
    CREATE_TEXTURE_VOLUME: 0x112,
    UPDATE_TEXTURE: 0x113,
    CREATE_VERTEX_DECLARATION: 0x120,
    CREATE_VERTEX_SHADER: 0x121,
    CREATE_PIXEL_SHADER: 0x122,
    CREATE_QUERY: 0x123,
    SET_RENDER_STATE: 0x200,
    SET_SAMPLER_STATE: 0x201,
    SET_TEXTURE_STAGE_STATE: 0x202,
    SET_TEXTURE: 0x203,
    SET_VIEWPORT: 0x204,
    SET_SCISSOR_RECT: 0x205,
    SET_TRANSFORM: 0x206,
    SET_MATERIAL: 0x207,
    SET_LIGHT: 0x208,
    LIGHT_ENABLE: 0x209,
    SET_STREAM_SOURCE: 0x20A,
    SET_STREAM_SOURCE_FREQ: 0x20B,
    SET_INDICES: 0x20C,
    SET_VERTEX_DECLARATION: 0x20D,
    SET_RENDER_TARGET: 0x20F,
    SET_VERTEX_SHADER: 0x211,
    SET_PIXEL_SHADER: 0x212,
    SET_VERTEX_SHADER_CONSTANT_F: 0x213,
    SET_VERTEX_SHADER_CONSTANT_I: 0x214,
    SET_VERTEX_SHADER_CONSTANT_B: 0x215,
    SET_PIXEL_SHADER_CONSTANT_F: 0x216,
    SET_PIXEL_SHADER_CONSTANT_I: 0x217,
    SET_PIXEL_SHADER_CONSTANT_B: 0x218,
    SET_CLIP_PLANE: 0x219,
    SET_DEPTH_STENCIL_SURFACE_LEVEL: 0x21E,
    GENERATE_MIPS: 0x221,
    DRAW_PRIMITIVE: 0x300,
    DRAW_INDEXED_PRIMITIVE: 0x301,
    BEGIN_QUERY: 0x400,
    END_QUERY: 0x401,
};

/** D9WG resource kinds (D9WG_RESOURCE_*) */
export const KIND = {
    VERTEX_BUFFER: 1,
    INDEX_BUFFER: 2,
    TEXTURE_2D: 3,
    TEXTURE_CUBE: 4,
    TEXTURE_VOLUME: 5,
    VERTEX_DECLARATION: 6,
    VERTEX_SHADER: 7,
    PIXEL_SHADER: 8,
    QUERY: 9,
};

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

/**
 * Builds one batch at a time
 * @constructor
 */
export function D9WGWriter()
{
    this.bytes = new Uint8Array(1 << 16);
    this.view = new DataView(this.bytes.buffer);
    this.length = BATCH_HEADER_BYTES;
    this.count = 0;
    this.sequence = 0;
    // the command being written: where its header is
    this.command_at = -1;
    /** @type {?function()} called before each command: the other stream is sent first */
    this.before = null;
}

/** @return {boolean} */
D9WGWriter.prototype.empty = function()
{
    return this.count === 0;
};

/** @return {number} bytes so far */
D9WGWriter.prototype.size = function()
{
    return this.length;
};

D9WGWriter.prototype.reserve = function(bytes)
{
    if(this.length + bytes <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while(capacity < this.length + bytes) capacity *= 2;
    const bigger = new Uint8Array(capacity);
    bigger.set(this.bytes.subarray(0, this.length));
    this.bytes = bigger;
    this.view = new DataView(bigger.buffer);
};

/**
 * Start a command; its fields follow with u32/i32/f32/data
 * @param {number} opcode
 */
D9WGWriter.prototype.begin = function(opcode)
{
    if(this.before) this.before();
    this.end();
    this.reserve(COMMAND_HEADER_BYTES);
    this.command_at = this.length;
    const v = this.view, at = this.length;
    v.setUint16(at, opcode, true);
    v.setUint16(at + 2, 0, true);
    v.setUint32(at + 4, 0, true);
    v.setUint32(at + 8, ++this.sequence, true);
    v.setUint32(at + 12, 0, true);
    this.length += COMMAND_HEADER_BYTES;
    this.count++;
    return this;
};

/** Finish the command being written: its size, padded to 8 bytes */
D9WGWriter.prototype.end = function()
{
    if(this.command_at < 0) return;
    const padded = this.length + 7 & ~7;
    this.reserve(padded - this.length);
    this.bytes.fill(0, this.length, padded);
    this.length = padded;
    this.view.setUint32(this.command_at + 4, this.length - this.command_at, true);
    this.command_at = -1;
};

D9WGWriter.prototype.u32 = function(value)
{
    this.reserve(4);
    this.view.setUint32(this.length, value >>> 0, true);
    this.length += 4;
    return this;
};

D9WGWriter.prototype.i32 = function(value)
{
    this.reserve(4);
    this.view.setInt32(this.length, value | 0, true);
    this.length += 4;
    return this;
};

D9WGWriter.prototype.f32 = function(value)
{
    this.reserve(4);
    this.view.setFloat32(this.length, value, true);
    this.length += 4;
    return this;
};

/**
 * Raw bytes inside the current command
 * @param {!Uint8Array} bytes
 * @return {number} their offset from the start of the batch (data_offset)
 */
D9WGWriter.prototype.data = function(bytes)
{
    const at = this.length + 3 & ~3;
    this.reserve(at - this.length + bytes.length);
    this.bytes.fill(0, this.length, at);
    this.bytes.set(bytes, at);
    this.length = at + bytes.length;
    return at;
};

/**
 * A field whose value is known only later (a data_offset before its data)
 * @return {number} where to patch
 */
D9WGWriter.prototype.placeholder = function()
{
    const at = this.length;
    this.u32(0);
    return at;
};

D9WGWriter.prototype.patch = function(at, value)
{
    this.view.setUint32(at, value >>> 0, true);
};

/**
 * Close the batch
 * @param {number} frame_id
 * @param {number} flags D9WG_BATCH_FLAG_*
 * @return {!Uint8Array} the batch, owned by the caller
 */
D9WGWriter.prototype.finish = function(frame_id, flags)
{
    this.end();
    const v = this.view;
    v.setUint32(0, D9WG_MAGIC, true);
    v.setUint16(4, VERSION_MAJOR, true);
    v.setUint16(6, VERSION_MINOR, true);
    v.setUint32(8, frame_id >>> 0, true);
    v.setUint32(12, flags, true);
    v.setUint32(16, this.count, true);
    v.setUint32(20, this.length - BATCH_HEADER_BYTES, true);
    v.setUint32(24, SESSION_LOW, true);
    v.setUint32(28, SESSION_HIGH, true);
    const batch = this.bytes.slice(0, this.length);
    this.length = BATCH_HEADER_BYTES;
    this.count = 0;
    return batch;
};

/**
 * The commands of a batch, for tests and traces
 * @param {!Uint8Array} batch
 * @return {!Array<{opcode: number, view: !DataView, at: number, size: number}>}
 *     at: the payload's offset in the batch
 */
export function d9wg_commands(batch)
{
    const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
    if(view.getUint32(0, true) !== D9WG_MAGIC) throw new Error("not a D9WG batch");
    const end = BATCH_HEADER_BYTES + view.getUint32(20, true);
    const commands = [];
    for(let at = BATCH_HEADER_BYTES; at < end;)
    {
        const size = view.getUint32(at + 4, true);
        commands.push({ opcode: view.getUint16(at, true), view, at: at + COMMAND_HEADER_BYTES, size: size - COMMAND_HEADER_BYTES });
        at += size;
    }
    return commands;
}
