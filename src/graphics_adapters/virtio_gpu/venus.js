// Venus: Vulkan for the guest's Mesa venus driver, over virtio-gpu (capset 4,
// level "venus"). This is the transport: the capset, Venus contexts, the
// shared memory the driver allocates (HOST3D blobs of blob id 0, in the host
// visible memory, BAR4), the command rings in it, reply streams and the
// MESA transport commands. The Vulkan commands themselves go to the Vulkan
// model (venus_vk.js). docs/vmware-svga-virtio-gpu-plan.zh-CN.md, section 6.5.
//
// The driver writes commands into a ring and moves its tail; this device
// reads them on its timer (every time the machine's timers run) and when the
// driver submits anything, moves the head past each command it has done, and
// writes replies into the reply stream the driver set. A command whose answer
// waits for the GPU stops its ring (or its submission) until it is answered.
// Rings never go idle: the driver need not notify, and the status keeps the
// ALIVE bit, which the driver's watchdog clears while it waits.

import { COMMANDS, EXTENSIONS, VenusReader, VenusWriter, VK_XML_VERSION, WIRE_FORMAT_VERSION } from "./venus_protocol.js";
import { dbg_log } from "../../log.js";
import { LOG_VIRTIO } from "../../const.js";

export const CAPSET_VENUS = 4;
/** virgl_renderer_capset_venus: 5 dwords, the extension mask (32), 3 dwords */
export const CAPSET_VENUS_SIZE = 40 * 4;

const COMMAND_GENERATE_REPLY = 1;

const RING_STATUS_FATAL = 2;
const RING_STATUS_ALIVE = 4;

/** what may be written into a ring's buffer between two reads (the driver's limit is the buffer) */
const MAX_DIRECT = 1 << 20;

/**
 * The capset: the protocol of venus_protocol.js (Mesa 26.1.6's), every
 * extension of it (the extension mask's bit 0 clear says so); what the
 * device supports is what it enumerates
 * @return {!Uint8Array}
 */
export function venus_capset()
{
    const words = new Uint32Array(CAPSET_VENUS_SIZE / 4);
    words[0] = WIRE_FORMAT_VERSION;
    words[1] = VK_XML_VERSION;
    words[2] = EXTENSIONS["VK_EXT_command_serialization"][1];
    words[3] = EXTENSIONS["VK_MESA_venus_protocol"][1];
    // supports_blob_id_0: shared memory is HOST3D, blob id 0
    words[4] = 1;
    // allow_vk_wait_syncs, supports_multiple_timelines; not use_guest_vram
    words[37] = 1;
    words[38] = 1;
    words[39] = 0;
    return new Uint8Array(words.buffer);
}

/**
 * A blob of a Venus context: shared memory (blob id 0) or the export of
 * a VkDeviceMemory (blob id: the memory's object id)
 * @constructor
 */
export function VenusBlob(id, ctx_id, blob_id, flags, size)
{
    this.id = id;
    this.venus = true;
    this.ctx_id = ctx_id;
    this.blob_id = blob_id;
    this.blob_flags = flags;
    this.blob_size = size;
    /** where it is mapped in the host visible memory, -1 when it is not */
    this.map_offset = -1;
    /** @type {Object} the VkDeviceMemory it exports */
    this.memory = null;
    this.backing = null;
}

/**
 * A command ring in shared memory
 * @constructor
 */
function Ring(id, blob, info)
{
    this.id = id;
    this.blob = blob;
    this.head_offset = info.headOffset;
    this.tail_offset = info.tailOffset;
    this.status_offset = info.statusOffset;
    this.buffer_offset = info.bufferOffset;
    this.buffer_size = info.bufferSize;
    this.extra_offset = info.extraOffset;
    this.extra_size = info.extraSize;
    /** where this device has read to (the driver's seqnos are these positions) */
    this.head = 0;
    /** @type {Run} the commands in progress, when one waits */
    this.run = null;
    this.fatal = false;
}

/**
 * Commands being run: a ring's (between its head and tail) or a
 * submission's; stopped at a command that waits
 * @constructor
 * @param {!VenusReader} reader
 * @param {function(number)} on_command after each command, its length
 * @param {function()} on_end
 */
function Run(reader, on_command, on_end)
{
    this.reader = reader;
    this.on_command = on_command;
    this.on_end = on_end;
    this.waiting = false;
}

/**
 * A Venus context: the guest process's driver instance
 * @constructor
 * @param {!Venus} venus
 * @param {number} id
 */
function VenusContext(venus, id)
{
    this.venus = venus;
    this.id = id;
    /** @type {!Map<number, !Ring>} */
    this.rings = new Map();
    /** @type {?{blob: !VenusBlob, offset: number, size: number, position: number}} the reply stream */
    this.reply = null;
    /** the last vkSubmitVirtqueueSeqnoMESA, by ring */
    this.virtqueue_seqnos = new Map();
    /** @type {!Array<!Run>} submissions (SUBMIT_3D) waiting for the one before them */
    this.submissions = [];
    /** @type {!Array<function()>} commands waiting for a virtqueue or ring seqno */
    this.seqno_waits = [];
    /** the Vulkan objects of this context, by the ids the driver gave them */
    this.objects = new Map();
    this.destroyed = false;
}

/**
 * @constructor
 * @param {!Object} gpu the VirtioGPU
 * @param {!Object} vk the Vulkan model: handle(ctx, name, args) -> wait or null
 */
export function Venus(gpu, vk)
{
    this.gpu = gpu;
    this.vk = vk;
    /** @type {!Map<number, !VenusContext>} */
    this.contexts = new Map();
    this.stats = { commands: 0, replies: 0, rings: 0, waits: 0, errors: 0, unknown: {} };
    /** @type {?function(string, !Object)} a harness's hook: each command as decoded */
    this.on_command = null;
    this.last_alive = 0;
}

Venus.prototype.reset = function()
{
    for(const ctx of this.contexts.values()) this.vk.destroy_context(ctx);
    this.contexts.clear();
};

/** @param {number} id */
Venus.prototype.create_context = function(id)
{
    const old = this.contexts.get(id);
    if(old) this.destroy_context(id);
    const ctx = new VenusContext(this, id);
    this.contexts.set(id, ctx);
    this.vk.create_context(ctx);
};

/** @param {number} id */
Venus.prototype.destroy_context = function(id)
{
    const ctx = this.contexts.get(id);
    if(!ctx) return;
    ctx.destroyed = true;
    this.vk.destroy_context(ctx);
    this.contexts.delete(id);
};

/** @return {!Uint8Array} the host visible memory */
Venus.prototype.bytes = function()
{
    return this.gpu.hostmem_bytes();
};

/**
 * RESOURCE_CREATE_BLOB of a Venus context
 * @return {VenusBlob} null when it cannot be made
 */
Venus.prototype.create_blob = function(id, ctx_id, flags, blob_id, size)
{
    const ctx = this.contexts.get(ctx_id);
    if(!ctx || !size) return null;
    const blob = new VenusBlob(id, ctx_id, blob_id, flags, size);
    if(blob_id !== 0)
    {
        // a VkDeviceMemory's export
        const memory = ctx.objects.get(blob_id);
        if(!memory || !this.vk.export_memory(ctx, memory, blob))
        {
            if(this.vk.debug) this.vk.debug("blob " + id + " of object " + blob_id + " (" + (memory ? memory.type + " of " + memory.size +
                (memory.blob ? ", exported as " + memory.blob.id : "") : "none") + "), " + size + " bytes: refused");
            return null;
        }
        blob.memory = memory;
    }
    return blob;
};

/**
 * The blob was mapped at `offset`; shared memory needs nothing, memory gets
 * its contents
 * @param {!VenusBlob} blob
 * @return {?function(function())} when the contents come later
 */
Venus.prototype.mapped = function(blob)
{
    return blob.memory ? this.vk.map_memory(blob.memory, blob) : null;
};

/** @param {!VenusBlob} blob */
Venus.prototype.unref_blob = function(blob)
{
    if(blob.memory) this.vk.unexport_memory(blob.memory, blob);
    const ctx = this.contexts.get(blob.ctx_id);
    if(!ctx) return;
    for(const ring of [...ctx.rings.values()]) if(ring.blob === blob) ctx.rings.delete(ring.id);
    if(ctx.reply && ctx.reply.blob === blob) ctx.reply = null;
};

/**
 * SUBMIT_3D of a Venus context: commands, run in order after the context's
 * earlier submissions
 * @param {number} ctx_id
 * @param {!Uint8Array} bytes
 * @param {number=} ring_idx a fence on this timeline (a queue's): answered after the queue's work
 * @return {?function(function())} the answer waits until it calls back
 */
Venus.prototype.submit = function(ctx_id, bytes, ring_idx)
{
    const ctx = this.contexts.get(ctx_id);
    if(!ctx) return null;
    // (the driver sends commands it waits for through its rings first)
    this.run_rings(ctx);
    let finished = false, finish = null;
    const run = new Run(new VenusReader(bytes), () => {}, () => {
        const done = () => {
            finished = true;
            ctx.submissions.shift();
            if(finish) finish();
            if(ctx.submissions.length) this.resume(ctx, ctx.submissions[0]);
        };
        if(ring_idx && !this.vk.timeline_idle(ctx, ring_idx)) this.vk.add_waiter(() => this.vk.timeline_idle(ctx, ring_idx), Infinity, done);
        else done();
    });
    ctx.submissions.push(run);
    if(ctx.submissions.length === 1) this.resume(ctx, run);
    return finished ? null : done => { if(finished) done(); else finish = done; };
};

/**
 * Run commands until they end or one waits
 * @param {!VenusContext} ctx
 * @param {!Run} run
 */
Venus.prototype.resume = function(ctx, run)
{
    const r = run.reader;
    run.waiting = false;
    while(r.p < r.end)
    {
        if(ctx.destroyed) return;
        const start = r.p;
        let wait;
        try
        {
            wait = this.command(ctx, r);
        }
        catch(e)
        {
            this.stats.errors++;
            dbg_log("venus: " + (e && e.message || e), LOG_VIRTIO);
            this.fatal(ctx, run);
            return;
        }
        if(wait)
        {
            this.stats.waits++;
            run.waiting = true;
            wait(() => {
                run.on_command(r.p - start);
                this.resume(ctx, run);
            });
            return;
        }
        run.on_command(r.p - start);
    }
    run.on_end();
};

/**
 * A ring's commands cannot go on: its status says so, and the driver aborts
 * @param {!VenusContext} ctx
 * @param {!Run} run
 */
Venus.prototype.fatal = function(ctx, run)
{
    for(const ring of ctx.rings.values())
    {
        if(ring.run !== run) continue;
        ring.fatal = true;
        this.set_status(ring, RING_STATUS_FATAL);
    }
    // (a submission: what follows it still runs)
    if(ctx.submissions[0] === run) run.on_end();
};

/**
 * One command
 * @param {!VenusContext} ctx
 * @param {!VenusReader} r
 * @return {?function(function())} the command's reply waits
 */
Venus.prototype.command = function(ctx, r)
{
    const type = r.u32(), flags = r.u32();
    const entry = COMMANDS[type];
    if(!entry) throw new Error("unknown command " + type);
    const name = entry[0];
    const args = entry[1](r);
    this.stats.commands++;
    if(this.on_command) this.on_command(name, args);
    const transport = TRANSPORT[name];
    const wait = transport ? transport(this, ctx, args) : this.vk.handle(ctx, name, args);
    if(!(flags & COMMAND_GENERATE_REPLY)) return wait;
    if(!entry[2]) throw new Error(name + " has no reply");
    if(!wait)
    {
        this.write_reply(ctx, entry[2], args);
        return null;
    }
    // the reply goes where the stream is then
    return done => wait(() => {
        try
        {
            this.write_reply(ctx, entry[2], args);
        }
        catch(e)
        {
            this.stats.errors++;
            dbg_log("venus: " + name + ": " + (e && e.message || e), LOG_VIRTIO);
        }
        done();
    });
};

/**
 * @param {!VenusContext} ctx
 * @param {function(!VenusWriter, !Object)} encode
 * @param {!Object} args
 */
Venus.prototype.write_reply = function(ctx, encode, args)
{
    const stream = ctx.reply;
    if(!stream || stream.blob.map_offset < 0) throw new Error("a reply without a reply stream");
    const w = new VenusWriter(256);
    encode(w, args);
    const out = w.result();
    if(stream.position + out.length > stream.size) throw new Error("the reply does not fit its stream");
    this.bytes().set(out, stream.blob.map_offset + stream.offset + stream.position);
    stream.position += out.length;
    this.stats.replies++;
};

/**
 * @param {!VenusContext} ctx
 * @param {number} id
 * @return {!VenusBlob}
 */
Venus.prototype.shared_memory = function(ctx, id)
{
    const r = this.gpu.resources.get(id);
    if(!r || !r.venus || r.map_offset < 0) throw new Error("resource " + id + " is not mapped shared memory");
    return r;
};

// ---------------------------------------------------------------------------
// Rings

/** Run every context's rings; set their ALIVE bits now and then */
Venus.prototype.timer = function(now)
{
    this.vk.timer(now);
    const alive = now - this.last_alive >= 500 || now < this.last_alive;
    if(alive) this.last_alive = now;
    for(const ctx of this.contexts.values())
    {
        this.run_rings(ctx);
        if(alive) for(const ring of ctx.rings.values()) this.set_status(ring, RING_STATUS_ALIVE);
    }
};

/** @param {!VenusContext} ctx */
Venus.prototype.run_rings = function(ctx)
{
    for(const ring of ctx.rings.values()) this.run_ring(ctx, ring);
};

/**
 * @param {!VenusContext} ctx
 * @param {!Ring} ring
 */
Venus.prototype.run_ring = function(ctx, ring)
{
    if(ring.run || ring.fatal || ring.blob.map_offset < 0) return;
    const bytes = this.bytes();
    const base = ring.blob.map_offset;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tail = view.getUint32(base + ring.tail_offset, true);
    const size = (tail - ring.head) >>> 0;
    if(!size) return;
    if(size > ring.buffer_size || size > MAX_DIRECT || size & 3)
    {
        ring.fatal = true;
        this.set_status(ring, RING_STATUS_FATAL);
        return;
    }
    // the commands, in one piece (the buffer wraps)
    const commands = new Uint8Array(size);
    const at = ring.head & ring.buffer_size - 1, buffer = base + ring.buffer_offset;
    const first = Math.min(size, ring.buffer_size - at);
    commands.set(bytes.subarray(buffer + at, buffer + at + first));
    if(first < size) commands.set(bytes.subarray(buffer, buffer + size - first), first);
    this.stats.rings++;
    ring.run = new Run(new VenusReader(commands), length => {
        ring.head = ring.head + length >>> 0;
        if(ring.blob.map_offset >= 0)
        {
            const now = this.bytes();
            new DataView(now.buffer, now.byteOffset, now.byteLength).setUint32(ring.blob.map_offset + ring.head_offset, ring.head, true);
        }
    }, () => {
        ring.run = null;
        this.wake_seqno_waits(ctx);
        // (more may have come meanwhile)
        if(!ring.fatal && !ctx.destroyed) this.run_ring(ctx, ring);
    });
    this.resume(ctx, ring.run);
};

/**
 * @param {!Ring} ring
 * @param {number} bits
 */
Venus.prototype.set_status = function(ring, bits)
{
    if(ring.blob.map_offset < 0) return;
    const bytes = this.bytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = ring.blob.map_offset + ring.status_offset;
    view.setUint32(at, view.getUint32(at, true) | bits, true);
};

/** @param {!VenusContext} ctx */
Venus.prototype.wake_seqno_waits = function(ctx)
{
    const waits = ctx.seqno_waits;
    ctx.seqno_waits = [];
    for(const check of waits) check();
};

/**
 * Whether ring position a is at or past b (positions wrap at 2**32; the
 * driver's seqnos are positions)
 */
function seqno_passed(a, b)
{
    return (a - b | 0) >= 0;
}

// ---------------------------------------------------------------------------
// The transport commands

/** @type {!Object<string, function(!Venus, !VenusContext, !Object): ?function(function())>} */
const TRANSPORT = {
    "vkCreateRingMESA": function(venus, ctx, a)
    {
        const info = a.pCreateInfo;
        const blob = venus.shared_memory(ctx, info.resourceId);
        const end = info.offset + info.size;
        if(info.bufferSize & info.bufferSize - 1 || end > blob.blob_size ||
            info.bufferOffset + info.bufferSize > info.size || info.extraOffset + info.extraSize > info.size)
        {
            throw new Error("vkCreateRingMESA: bad layout");
        }
        // (offsets within the resource: the ring may start inside it)
        const ring = new Ring(a.ring, blob, {
            headOffset: info.offset + info.headOffset, tailOffset: info.offset + info.tailOffset,
            statusOffset: info.offset + info.statusOffset, bufferOffset: info.offset + info.bufferOffset,
            bufferSize: info.bufferSize, extraOffset: info.offset + info.extraOffset, extraSize: info.extraSize,
        });
        ctx.rings.set(a.ring, ring);
        venus.set_status(ring, RING_STATUS_ALIVE);
        return null;
    },
    "vkDestroyRingMESA": function(venus, ctx, a)
    {
        ctx.rings.delete(a.ring);
        return null;
    },
    "vkNotifyRingMESA": function(venus, ctx, a)
    {
        const ring = ctx.rings.get(a.ring);
        if(ring) venus.run_ring(ctx, ring);
        return null;
    },
    "vkWriteRingExtraMESA": function(venus, ctx, a)
    {
        const ring = ctx.rings.get(a.ring);
        if(!ring || a.offset + 4 > ring.extra_size) throw new Error("vkWriteRingExtraMESA: bad ring or offset");
        const bytes = venus.bytes();
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            .setUint32(ring.blob.map_offset + ring.extra_offset + a.offset, a.value, true);
        return null;
    },
    "vkSetReplyCommandStreamMESA": function(venus, ctx, a)
    {
        const stream = a.pStream;
        const blob = venus.shared_memory(ctx, stream.resourceId);
        if(stream.offset + stream.size > blob.blob_size) throw new Error("vkSetReplyCommandStreamMESA: past the resource");
        ctx.reply = { blob, offset: stream.offset, size: stream.size, position: 0 };
        return null;
    },
    "vkSeekReplyCommandStreamMESA": function(venus, ctx, a)
    {
        if(!ctx.reply || a.position > ctx.reply.size) throw new Error("vkSeekReplyCommandStreamMESA: no stream or past it");
        ctx.reply.position = a.position;
        return null;
    },
    "vkExecuteCommandStreamsMESA": function(venus, ctx, a)
    {
        // (run here, inline: a stream that waits makes the whole command wait)
        const streams = a.pStreams || [];
        let index = 0, finished = false, finish = null;
        const end = () => { finished = true; if(finish) finish(); };
        // the streams from `index` on; true when one waits (the rest runs after it)
        const next = () => {
            while(index < streams.length)
            {
                const i = index++, stream = streams[i];
                if(a.pReplyPositions) TRANSPORT["vkSeekReplyCommandStreamMESA"](venus, ctx, { position: a.pReplyPositions[i] });
                const blob = venus.shared_memory(ctx, stream.resourceId);
                if(stream.offset + stream.size > blob.blob_size) throw new Error("vkExecuteCommandStreamsMESA: past the resource");
                const start = blob.map_offset + stream.offset;
                const r = new VenusReader(venus.bytes().slice(start, start + stream.size));
                if(venus.run_inline(ctx, r, () => { if(!next()) end(); })) return true;
            }
            return false;
        };
        if(!next()) return null;
        return done => { if(finished) done(); else finish = done; };
    },
    "vkSubmitVirtqueueSeqnoMESA": function(venus, ctx, a)
    {
        ctx.virtqueue_seqnos.set(a.ring, a.seqno);
        venus.wake_seqno_waits(ctx);
        return null;
    },
    "vkWaitVirtqueueSeqnoMESA": function(venus, ctx, a)
    {
        // (the driver's roundtrip: the seqno arrives with a submission)
        const reached = () => [...ctx.virtqueue_seqnos.values()].some(seqno => seqno >= a.seqno);
        if(reached()) return null;
        return done => {
            const check = () => { if(reached()) done(); else ctx.seqno_waits.push(check); };
            check();
        };
    },
    "vkWaitRingSeqnoMESA": function(venus, ctx, a)
    {
        const ring = ctx.rings.get(a.ring);
        if(!ring) return null;
        venus.run_ring(ctx, ring);
        const reached = () => !ctx.rings.has(a.ring) || seqno_passed(ring.head, a.seqno);
        if(reached()) return null;
        return done => {
            const check = () => { if(reached()) done(); else ctx.seqno_waits.push(check); };
            check();
        };
    },
};

/**
 * Commands run inside another (vkExecuteCommandStreamsMESA)
 * @param {!VenusContext} ctx
 * @param {!VenusReader} r
 * @param {function()} then when a waiting command is done and the rest has run
 * @return {boolean} whether a command waits (then is called later)
 */
Venus.prototype.run_inline = function(ctx, r, then)
{
    while(r.p < r.end)
    {
        const wait = this.command(ctx, r);
        if(wait)
        {
            wait(() => {
                if(!this.run_inline(ctx, r, then)) then();
            });
            return true;
        }
    }
    return false;
};
