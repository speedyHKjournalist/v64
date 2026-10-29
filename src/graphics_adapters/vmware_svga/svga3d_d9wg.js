// D9WG batches, the renderer's input. The SVGA3D layer (svga3d.js) turns the
// guest's legacy 3D commands into the protocol the D3D9 executor
// (src/browser/glbridge/d3d9-webgpu/d3d9_executor.js) already runs for the
// guest D3D9 proxy, at the protocol's current version. A batch
// is self-contained (inline data travels in it), so it can be recorded and
// replayed without the guest.

import { dbg_assert } from "../../log.js";
import { D9WG_MAGIC, D9WG_VERSION_MAJOR, D9WG_VERSION_MINOR, OP, KIND, PAYLOAD_BYTES } from "./d9wg_constants.js";

// The opcodes, the resource kinds and every payload's size come from
// src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js (d9wg_constants.js is
// generated from it); the fields of each command follow its struct there.
export { D9WG_MAGIC, D9WG_BATCH_FLAG_PRESENT, OP, KIND } from "./d9wg_constants.js";

const BATCH_HEADER_BYTES = 32;
const COMMAND_HEADER_BYTES = 16;

// Every batch carries this session: one guest device, one resource namespace
const SESSION_LOW = 0x41475653;     // "SVGA"
const SESSION_HIGH = 0;

// (the response region's layout: ../renderer_protocol.js)

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
    // the command being written: where its header is, and its opcode
    this.command_at = -1;
    this.opcode = 0;
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
    this.opcode = opcode;
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
    dbg_assert(this.length - this.command_at - COMMAND_HEADER_BYTES >= PAYLOAD_BYTES[this.opcode],
        "D9WG opcode 0x" + this.opcode.toString(16) + ": the payload is shorter than its struct");
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
    v.setUint16(4, D9WG_VERSION_MAJOR, true);
    v.setUint16(6, D9WG_VERSION_MINOR, true);
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
