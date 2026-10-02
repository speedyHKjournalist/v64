// The Venus device's command buffers, queues and synchronization
// (venus_vk.js runs them). Command buffers record the commands as decoded;
// a submission turns them into one VX batch (BEGIN, the commands, END), sent
// when its timeline waits are met. When the renderer has run it, what it
// wrote into mapped memory is back in the guest's mappings, then its
// semaphores and fence signal. One renderer queue runs everything in order,
// so binary semaphores need no wait.

import { VX } from "../renderer_protocol.js";
import { VK_SUCCESS, VK_NOT_READY, VK_TIMEOUT, VK_EVENT_SET, VK_EVENT_RESET, VK_ERROR_FEATURE_NOT_PRESENT,
    REMAINING } from "./venus_device_info.js";
import { lo, hi, range_size } from "./venus_vk_resources.js";

const STYPE_SEMAPHORE_TYPE_CREATE_INFO = 1000207002;
const STYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO = 1000207003;
const SEMAPHORE_TYPE_TIMELINE = 1;
const SEMAPHORE_WAIT_ANY = 1;
const FENCE_CREATE_SIGNALED = 1;
const QUERY_RESULT_64 = 1, QUERY_RESULT_WAIT = 2, QUERY_RESULT_WITH_AVAILABILITY = 4;

/** a timeline value's wait can go to the renderer: it is signaled, or a signal of it went first */
function timeline_ready(semaphore, value)
{
    return semaphore.value >= value || semaphore.submitted >= value;
}

/**
 * Wait until `check` holds or `timeout` (ns, of the machine's time) passes
 * @param {!Object} vk the model
 * @param {function():boolean} check
 * @param {number} timeout
 * @param {function(boolean)} then called with whether it holds
 * @return {?function(function())}
 */
function wait_until(vk, check, timeout, then)
{
    if(check()) { then(true); return null; }
    if(!timeout) { then(false); return null; }
    return done => vk.add_waiter(check, timeout, ok => { then(ok); done(); });
}

/** @type {!Object<string, function(!Object, !Object, !Object): ?function(function())>} */
export const COMMAND_HANDLERS = {
    // Command pools and buffers

    "vkCreateCommandPool": function(vk, ctx, a)
    {
        ctx.objects.set(a.pCommandPool, { type: "command_pool", buffers: new Set() });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyCommandPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.commandPool);
        if(pool) for(const id of pool.buffers) ctx.objects.delete(id);
        ctx.objects.delete(a.commandPool);
        return null;
    },
    "vkResetCommandPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.commandPool);
        if(pool) for(const id of pool.buffers) { const cb = ctx.objects.get(id); if(cb) cb.commands = []; }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkTrimCommandPool": function(vk, ctx, a) { return null; },
    "vkAllocateCommandBuffers": function(vk, ctx, a)
    {
        const info = a.pAllocateInfo;
        const pool = ctx.objects.get(info.commandPool);
        for(const id of a.pCommandBuffers || [])
        {
            ctx.objects.set(id, { type: "command_buffer", pool: info.commandPool, level: info.level, commands: [] });
            if(pool) pool.buffers.add(id);
        }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkFreeCommandBuffers": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.commandPool);
        for(const id of a.pCommandBuffers || [])
        {
            ctx.objects.delete(id);
            if(pool) pool.buffers.delete(id);
        }
        return null;
    },
    "vkBeginCommandBuffer": function(vk, ctx, a)
    {
        const cb = ctx.objects.get(a.commandBuffer);
        if(cb) { cb.commands = []; cb.begin = a.pBeginInfo; }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkEndCommandBuffer": function(vk, ctx, a) { a.ret = VK_SUCCESS; return null; },
    "vkResetCommandBuffer": function(vk, ctx, a)
    {
        const cb = ctx.objects.get(a.commandBuffer);
        if(cb) cb.commands = [];
        a.ret = VK_SUCCESS;
        return null;
    },

    // Queues

    "vkQueueSubmit": function(vk, ctx, a)
    {
        const submits = (a.pSubmits || []).map(s => {
            let wait_values = null, signal_values = null;
            for(let n = s.pNext; n; n = n.pNext)
            {
                if(n.sType === STYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO) { wait_values = n.pWaitSemaphoreValues; signal_values = n.pSignalSemaphoreValues; }
            }
            return {
                waits: (s.pWaitSemaphores || []).map((id, i) => [id, wait_values ? wait_values[i] : 0]),
                command_buffers: s.pCommandBuffers || [],
                signals: (s.pSignalSemaphores || []).map((id, i) => [id, signal_values ? signal_values[i] : 0]),
            };
        });
        vk.submit(ctx, a.queue, submits, a.fence);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkQueueSubmit2": function(vk, ctx, a)
    {
        const submits = (a.pSubmits || []).map(s => ({
            waits: (s.pWaitSemaphoreInfos || []).map(w => [w.semaphore, w.value]),
            command_buffers: (s.pCommandBufferInfos || []).map(c => c.commandBuffer),
            signals: (s.pSignalSemaphoreInfos || []).map(w => [w.semaphore, w.value]),
        }));
        vk.submit(ctx, a.queue, submits, a.fence);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkQueueBindSparse": function(vk, ctx, a)
    {
        a.ret = VK_ERROR_FEATURE_NOT_PRESENT;
        return null;
    },
    "vkQueueWaitIdle": function(vk, ctx, a)
    {
        const queue = ctx.objects.get(a.queue);
        return wait_until(vk, () => !queue || !queue.pending.length && !queue.inflight, Infinity, () => { a.ret = VK_SUCCESS; });
    },
    "vkDeviceWaitIdle": function(vk, ctx, a)
    {
        const queues = [...ctx.objects.values()].filter(o => o.type === "queue" && o.device === a.device);
        return wait_until(vk, () => queues.every(q => !q.pending.length && !q.inflight), Infinity, () => { a.ret = VK_SUCCESS; });
    },

    // Fences

    "vkCreateFence": function(vk, ctx, a)
    {
        ctx.objects.set(a.pFence, { type: "fence", signaled: !!(a.pCreateInfo.flags & FENCE_CREATE_SIGNALED), pending: 0 });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyFence": function(vk, ctx, a) { ctx.objects.delete(a.fence); return null; },
    "vkResetFences": function(vk, ctx, a)
    {
        for(const id of a.pFences || []) { const fence = ctx.objects.get(id); if(fence) fence.signaled = false; }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkResetFenceResourceMESA": function(vk, ctx, a)
    {
        const fence = ctx.objects.get(a.fence);
        if(fence) fence.signaled = false;
        return null;
    },
    "vkGetFenceStatus": function(vk, ctx, a)
    {
        const fence = ctx.objects.get(a.fence);
        a.ret = !fence || fence.signaled ? VK_SUCCESS : VK_NOT_READY;
        return null;
    },
    "vkWaitForFences": function(vk, ctx, a)
    {
        const fences = (a.pFences || []).map(id => ctx.objects.get(id)).filter(f => f);
        const check = () => a.waitAll ? fences.every(f => f.signaled) : fences.some(f => f.signaled);
        return wait_until(vk, check, a.timeout, ok => { a.ret = ok ? VK_SUCCESS : VK_TIMEOUT; });
    },

    // Semaphores

    "vkCreateSemaphore": function(vk, ctx, a)
    {
        let timeline = false, value = 0;
        for(let s = a.pCreateInfo.pNext; s; s = s.pNext)
        {
            if(s.sType === STYPE_SEMAPHORE_TYPE_CREATE_INFO) { timeline = s.semaphoreType === SEMAPHORE_TYPE_TIMELINE; value = s.initialValue; }
        }
        ctx.objects.set(a.pSemaphore, { type: "semaphore", timeline, value, submitted: value, signaled: false });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroySemaphore": function(vk, ctx, a) { ctx.objects.delete(a.semaphore); return null; },
    "vkGetSemaphoreCounterValue": function(vk, ctx, a)
    {
        const semaphore = ctx.objects.get(a.semaphore);
        a.pValue = semaphore ? semaphore.value : 0;
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkSignalSemaphore": function(vk, ctx, a)
    {
        const semaphore = ctx.objects.get(a.pSignalInfo.semaphore);
        if(semaphore)
        {
            semaphore.value = Math.max(semaphore.value, a.pSignalInfo.value);
            semaphore.submitted = Math.max(semaphore.submitted, semaphore.value);
            vk.wake();
        }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkWaitSemaphores": function(vk, ctx, a)
    {
        const info = a.pWaitInfo;
        const pairs = (info.pSemaphores || []).map((id, i) => [ctx.objects.get(id), info.pValues[i]]).filter(p => p[0]);
        const reached = ([semaphore, value]) => semaphore.value >= value;
        const check = () => info.flags & SEMAPHORE_WAIT_ANY ? pairs.some(reached) : pairs.every(reached);
        return wait_until(vk, check, a.timeout, ok => { a.ret = ok ? VK_SUCCESS : VK_TIMEOUT; });
    },
    "vkWaitSemaphoreResourceMESA": function(vk, ctx, a) { return null; },
    "vkImportSemaphoreResourceMESA": function(vk, ctx, a)
    {
        // (a sync file's payload: signaled, as the renderer runs in order)
        const semaphore = ctx.objects.get(a.semaphore);
        if(semaphore) semaphore.signaled = true;
        return null;
    },

    // Events

    "vkCreateEvent": function(vk, ctx, a)
    {
        ctx.objects.set(a.pEvent, { type: "event", set: false });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyEvent": function(vk, ctx, a) { ctx.objects.delete(a.event); return null; },
    "vkGetEventStatus": function(vk, ctx, a)
    {
        const event = ctx.objects.get(a.event);
        a.ret = event && event.set ? VK_EVENT_SET : VK_EVENT_RESET;
        return null;
    },
    "vkSetEvent": function(vk, ctx, a)
    {
        const event = ctx.objects.get(a.event);
        if(event) event.set = true;
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkResetEvent": function(vk, ctx, a)
    {
        const event = ctx.objects.get(a.event);
        if(event) event.set = false;
        a.ret = VK_SUCCESS;
        return null;
    },

    // Queries (their results come with VK3's render passes)

    "vkCreateQueryPool": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        ctx.objects.set(a.pQueryPool, { type: "query_pool", query_type: info.queryType, count: info.queryCount,
            results: new Float64Array(info.queryCount), available: new Uint8Array(info.queryCount) });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyQueryPool": function(vk, ctx, a) { ctx.objects.delete(a.queryPool); return null; },
    "vkResetQueryPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.queryPool);
        if(pool) pool.available.fill(0, a.firstQuery, a.firstQuery + a.queryCount);
        return null;
    },
    "vkGetQueryPoolResults": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.queryPool);
        const answer = () => {
            const out = new Uint8Array(a.dataSize), view = new DataView(out.buffer);
            let all = true;
            for(let i = 0; i < a.queryCount; i++)
            {
                const q = a.firstQuery + i, at = i * a.stride, available = pool && pool.available[q];
                if(!available) all = false;
                const value = pool ? pool.results[q] : 0;
                const write = (offset, v) => {
                    if(a.flags & QUERY_RESULT_64)
                    {
                        if(offset + 8 > out.length) return;
                        view.setUint32(offset, lo(v), true);
                        view.setUint32(offset + 4, hi(v), true);
                    }
                    else if(offset + 4 <= out.length) view.setUint32(offset, Math.min(v, 0xFFFFFFFF), true);
                };
                if(available) write(at, value);
                if(a.flags & QUERY_RESULT_WITH_AVAILABILITY) write(at + (a.flags & QUERY_RESULT_64 ? 8 : 4), available ? 1 : 0);
            }
            a.pData = out;
            a.ret = all ? VK_SUCCESS : VK_NOT_READY;
        };
        if(!(a.flags & QUERY_RESULT_WAIT) || !pool) { answer(); return null; }
        const available = () => pool.available.subarray(a.firstQuery, a.firstQuery + a.queryCount).every(x => x);
        return wait_until(vk, available, Infinity, () => answer());
    },
};

// ---------------------------------------------------------------------------
// Commands into VX

/**
 * A buffer's memory and where in it
 * @return {Array} [memory, offset] or null when it has none
 */
function at(ctx, id, offset)
{
    const buffer = ctx.objects.get(id);
    if(!buffer || !buffer.memory) return null;
    return [buffer.memory, buffer.offset + offset, buffer];
}

const f32_bits = v => new Uint32Array(new Float32Array([v]).buffer)[0];
// VkDescriptorType
const UNIFORM_BUFFER = 6, STORAGE_BUFFER = 7, UNIFORM_BUFFER_DYNAMIC = 8, STORAGE_BUFFER_DYNAMIC = 9;
const STORAGE_IMAGE = 3;

/** A command buffer's state as its commands are translated */
export function command_state()
{
    return {
        // the render pass: { pass, framebuffer, subpass, clears, used: Set of attachments }
        pass: null,
        // the bound descriptor sets, by bind point: group -> [set, dynamic offsets]
        sets: [new Map(), new Map()],
    };
}

/**
 * BEGIN_PASS of a subpass: its attachments, their loads (the first use of
 * an attachment in the render pass loads as the render pass says, later
 * ones keep what is there) and clear values
 */
function begin_subpass(vk, ctx, p)
{
    const sub = p.pass.subpasses[p.subpass];
    if(!sub) return;
    const fb = p.framebuffer;
    const view = i => { const v = ctx.objects.get(fb.attachments[i]); return v ? v.rid : 0; };
    const clear = i => {
        const c = p.clears[i];
        const bits = c && c.color ? Array.from(c.color.uint32 || c.color.int32 || [0, 0, 0, 0], x => x >>> 0) : [0, 0, 0, 0];
        return bits;
    };
    const load = (i, op) => p.used.has(i) ? 0 : op;
    const colors = sub.colors.map((r, k) => {
        if(!r || r.attachment === REMAINING) return null;
        const a = p.pass.attachments[r.attachment];
        const resolve = sub.resolves && sub.resolves[k] && sub.resolves[k].attachment !== REMAINING ? view(sub.resolves[k].attachment) : 0;
        return { view: view(r.attachment), load: load(r.attachment, a.load), store: a.store, clear: clear(r.attachment), resolve, format: a.format };
    });
    let depth = null;
    if(sub.depth && sub.depth.attachment !== REMAINING)
    {
        const i = sub.depth.attachment, a = p.pass.attachments[i];
        const bits = clear(i);
        depth = { view: view(i), load: load(i, a.load), store: a.store, stencil_load: load(i, a.stencil_load), stencil_store: a.stencil_store,
            clear_depth: new Float32Array(new Uint32Array([bits[0]]).buffer)[0], clear_stencil: bits[1], format: a.format };
    }
    for(const r of sub.colors.concat([sub.depth], sub.resolves || [])) if(r && r.attachment !== REMAINING) p.used.add(r.attachment);
    vk.vx.command(VX.BEGIN_PASS, [], new TextEncoder().encode(JSON.stringify({ colors, depth, width: fb.width, height: fb.height })));
}

/**
 * SET_BIND_GROUP of a descriptor set: its descriptors resolved to the
 * renderer's objects; dynamic offsets from `dynamic` in binding order.
 * Storage buffers the shaders may write are noted by `write`.
 */
function bind_set(vk, ctx, bind_point, group, set, dynamic, storage)
{
    const words = [];
    const keys = [...set.descriptors.keys()].sort((p, q) => p - q);
    let d_index = 0;
    for(const key of keys)
    {
        const d = set.descriptors.get(key);
        const binding = Math.floor(key / 1024), element = key % 1024;
        let rid = 0, sampler = 0, offset = 0, size = 0;
        if(d.type === UNIFORM_BUFFER || d.type === STORAGE_BUFFER || d.type === UNIFORM_BUFFER_DYNAMIC || d.type === STORAGE_BUFFER_DYNAMIC)
        {
            const buffer = ctx.objects.get(d.buffer);
            if(!buffer || !buffer.memory) continue;
            const extra = d.type === UNIFORM_BUFFER_DYNAMIC || d.type === STORAGE_BUFFER_DYNAMIC ? dynamic[d_index++] || 0 : 0;
            rid = buffer.memory.rid;
            offset = buffer.offset + d.offset + extra;
            size = range_size(buffer, d.offset, d.range);
            if(d.type === STORAGE_BUFFER || d.type === STORAGE_BUFFER_DYNAMIC) storage.push([buffer.memory, offset, size]);
        }
        else
        {
            const view = d.view ? ctx.objects.get(d.view) : null, s = d.sampler ? ctx.objects.get(d.sampler) : null;
            rid = view ? view.rid : 0;
            sampler = s ? s.rid : 0;
        }
        words.push(binding, element, d.type, rid, sampler, lo(offset), hi(offset), size >>> 0);
    }
    vk.vx.command(VX.SET_BIND_GROUP, [group | bind_point << 16, words.length / 8, ...words]);
}

/**
 * A submission's command buffers, written into the VX batch
 * @param {!Object} vk the model
 * @param {!Object} ctx
 * @param {!Array} commands [name, parameters] of a command buffer
 * @param {!Object} state { written: Set of memory the GPU writes, after: run on completion }
 */
export function translate(vk, ctx, commands, state)
{
    const vx = vk.vx;
    const image = id => ctx.objects.get(id);
    /** the GPU writes [offset, offset + size) of the memory */
    const write = (memory, offset, size) => {
        let ranges = state.written.get(memory);
        if(!ranges) state.written.set(memory, ranges = []);
        ranges.push([offset, offset + size]);
    };
    const cb = state.cb || (state.cb = command_state());
    /** before a draw or dispatch: the storage buffers of the bound sets are the GPU's to write */
    const storage_writes = bind_point => {
        for(const [, [set, dynamic]] of cb.sets[bind_point])
        {
            const storage = [];
            for(const d of set.descriptors.values())
            {
                if(d.type !== STORAGE_BUFFER && d.type !== STORAGE_BUFFER_DYNAMIC) continue;
                const buffer = ctx.objects.get(d.buffer);
                if(buffer && buffer.memory) write(buffer.memory, buffer.offset + d.offset, range_size(buffer, d.offset, d.range));
            }
        }
    };
    for(const [name, a] of commands)
    {
        switch(name)
        {
            // Render passes
            case "vkCmdBeginRenderPass":
            case "vkCmdBeginRenderPass2":
            {
                const info = a.pRenderPassBegin;
                const pass = ctx.objects.get(info.renderPass), framebuffer = ctx.objects.get(info.framebuffer);
                if(!pass || !framebuffer) break;
                cb.pass = { pass, framebuffer, subpass: 0, clears: info.pClearValues || [], used: new Set() };
                begin_subpass(vk, ctx, cb.pass);
                break;
            }
            case "vkCmdNextSubpass":
            case "vkCmdNextSubpass2":
                if(!cb.pass) break;
                vx.command(VX.END_PASS, []);
                cb.pass.subpass++;
                begin_subpass(vk, ctx, cb.pass);
                break;
            case "vkCmdEndRenderPass":
            case "vkCmdEndRenderPass2":
                if(!cb.pass) break;
                vx.command(VX.END_PASS, []);
                cb.pass = null;
                break;
            case "vkCmdClearAttachments":
            {
                const attachments = (a.pAttachments || []).map(c => ({ aspect: c.aspectMask, index: c.colorAttachment,
                    clear: Array.from(c.clearValue.color.uint32 || c.clearValue.color.int32 || [0, 0, 0, 0], x => x >>> 0) }));
                const rects = (a.pRects || []).map(r => ({ x: r.rect.offset.x, y: r.rect.offset.y, width: r.rect.extent.width, height: r.rect.extent.height }));
                vx.command(VX.CLEAR_ATTACHMENTS, [], new TextEncoder().encode(JSON.stringify({ attachments, rects })));
                break;
            }

            // State
            case "vkCmdBindPipeline":
            {
                const pipeline = ctx.objects.get(a.pipeline);
                if(pipeline) vx.command(VX.BIND_PIPELINE, [pipeline.rid]);
                break;
            }
            case "vkCmdBindDescriptorSets":
            {
                const point = a.pipelineBindPoint === 1 ? 1 : 0;
                let dynamic = Array.from(a.pDynamicOffsets || []);
                (a.pDescriptorSets || []).forEach((id, k) => {
                    const set = ctx.objects.get(id);
                    if(!set) return;
                    const count = [...set.descriptors.values()].filter(d => d.type === UNIFORM_BUFFER_DYNAMIC || d.type === STORAGE_BUFFER_DYNAMIC).length;
                    const mine = dynamic.slice(0, count);
                    dynamic = dynamic.slice(count);
                    cb.sets[point].set(a.firstSet + k, [set, mine]);
                    bind_set(vk, ctx, point, a.firstSet + k, set, mine, []);
                });
                break;
            }
            case "vkCmdBindVertexBuffers":
                (a.pBuffers || []).forEach((id, i) => {
                    const place = at(ctx, id, a.pOffsets[i]);
                    if(!place) return;
                    const size = place[2].size - a.pOffsets[i];
                    vx.command(VX.SET_VERTEX_BUFFER, [a.firstBinding + i, place[0].rid, lo(place[1]), hi(place[1]), lo(size), hi(size)]);
                });
                break;
            case "vkCmdBindIndexBuffer":
            {
                const place = at(ctx, a.buffer, a.offset);
                if(!place) break;
                const size = place[2].size - a.offset;
                vx.command(VX.SET_INDEX_BUFFER, [place[0].rid, lo(place[1]), hi(place[1]), lo(size), hi(size), a.indexType]);
                break;
            }
            case "vkCmdPushConstants":
                if(a.pValues) vx.command(VX.SET_PUSH_CONSTANTS, [a.offset, a.size], a.pValues);
                break;
            case "vkCmdSetViewport":
            {
                const v = (a.pViewports || [])[0];
                if(v) vx.command(VX.SET_VIEWPORT, [v.x, v.y, v.width, v.height, v.minDepth, v.maxDepth].map(f32_bits));
                break;
            }
            case "vkCmdSetScissor":
            {
                const r = (a.pScissors || [])[0];
                if(r) vx.command(VX.SET_SCISSOR, [r.offset.x >>> 0, r.offset.y >>> 0, r.extent.width, r.extent.height]);
                break;
            }
            case "vkCmdSetBlendConstants":
                vx.command(VX.SET_BLEND_CONSTANTS, Array.from(a.blendConstants, f32_bits));
                break;
            case "vkCmdSetStencilReference":
                vx.command(VX.SET_STENCIL_REFERENCE, [a.faceMask, a.reference]);
                break;
            case "vkCmdSetLineWidth":
            case "vkCmdSetDepthBias":
            case "vkCmdSetDepthBounds":
            case "vkCmdSetStencilCompareMask":
            case "vkCmdSetStencilWriteMask":
                vk.warn_once(name, name + " is kept from the pipeline (WebGPU's is static)");
                break;

            // Draws and dispatches
            case "vkCmdDraw":
                storage_writes(0);
                vx.command(VX.DRAW, [a.vertexCount, a.instanceCount, a.firstVertex, a.firstInstance]);
                break;
            case "vkCmdDrawIndexed":
                storage_writes(0);
                vx.command(VX.DRAW_INDEXED, [a.indexCount, a.instanceCount, a.firstIndex, a.vertexOffset >>> 0, a.firstInstance]);
                break;
            case "vkCmdDrawIndirect":
            case "vkCmdDrawIndexedIndirect":
            {
                const place = at(ctx, a.buffer, a.offset);
                if(!place) break;
                storage_writes(0);
                vx.command(VX.DRAW_INDIRECT, [place[0].rid, lo(place[1]), hi(place[1]), a.drawCount, a.stride, name === "vkCmdDrawIndexedIndirect" ? 1 : 0]);
                break;
            }
            case "vkCmdDispatch":
                storage_writes(1);
                vx.command(VX.DISPATCH, [a.groupCountX, a.groupCountY, a.groupCountZ]);
                break;
            case "vkCmdDispatchIndirect":
            {
                const place = at(ctx, a.buffer, a.offset);
                if(!place) break;
                storage_writes(1);
                vx.command(VX.DISPATCH_INDIRECT, [place[0].rid, lo(place[1]), hi(place[1])]);
                break;
            }

            case "vkCmdCopyBuffer":
            case "vkCmdCopyBuffer2":
            {
                const info = name === "vkCmdCopyBuffer2" ? a.pCopyBufferInfo : a;
                for(const region of info.pRegions || [])
                {
                    const src = at(ctx, info.srcBuffer, region.srcOffset), dst = at(ctx, info.dstBuffer, region.dstOffset);
                    if(!src || !dst || !region.size) continue;
                    vx.command(VX.COPY_BUFFER, [src[0].rid, lo(src[1]), hi(src[1]), dst[0].rid, lo(dst[1]), hi(dst[1]), lo(region.size), hi(region.size)]);
                    write(dst[0], dst[1], region.size);
                }
                break;
            }
            case "vkCmdFillBuffer":
            {
                const dst = at(ctx, a.dstBuffer, a.dstOffset);
                if(!dst) break;
                const size = range_size(dst[2], a.dstOffset, a.size) & ~3;
                if(size <= 0) break;
                vx.command(VX.FILL_BUFFER, [dst[0].rid, lo(dst[1]), hi(dst[1]), lo(size), hi(size), a.data]);
                write(dst[0], dst[1], size);
                break;
            }
            case "vkCmdUpdateBuffer":
            {
                const dst = at(ctx, a.dstBuffer, a.dstOffset);
                if(!dst || !a.pData) break;
                vx.command(VX.UPDATE_BUFFER, [dst[0].rid, lo(dst[1]), hi(dst[1]), a.dataSize], a.pData);
                write(dst[0], dst[1], a.dataSize);
                break;
            }
            case "vkCmdCopyBufferToImage":
            case "vkCmdCopyBufferToImage2":
            case "vkCmdCopyImageToBuffer":
            case "vkCmdCopyImageToBuffer2":
            {
                const to_image = name.startsWith("vkCmdCopyBufferToImage");
                const info = name.endsWith("2") ? (to_image ? a.pCopyBufferToImageInfo : a.pCopyImageToBufferInfo) : a;
                const buffer = to_image ? info.srcBuffer : info.dstBuffer;
                const img = image(to_image ? info.dstImage : info.srcImage);
                if(!img) break;
                for(const region of info.pRegions || [])
                {
                    const place = at(ctx, buffer, region.bufferOffset);
                    if(!place) continue;
                    const s = region.imageSubresource, o = region.imageOffset, e = region.imageExtent;
                    const layers = s.layerCount === REMAINING ? img.layers - s.baseArrayLayer : s.layerCount;
                    vx.command(VX.COPY_BUFFER_IMAGE, [to_image ? 1 : 0, place[0].rid, lo(place[1]), hi(place[1]),
                        region.bufferRowLength, region.bufferImageHeight, img.rid, s.aspectMask, s.mipLevel, s.baseArrayLayer, layers,
                        o.x, o.y, o.z, e.width, e.height, e.depth]);
                    if(!to_image)
                    {
                        // rows of the region (texels of the format's size; whole rows: a little more is no harm)
                        const texel = s.aspectMask === 4 ? 1 : s.aspectMask === 2 && img.format === 124 ? 2 : s.aspectMask === 2 ? 4 : img.texel_bytes;
                        const pitch = (region.bufferRowLength || e.width) * texel, rows = region.bufferImageHeight || e.height;
                        write(place[0], place[1], pitch * rows * Math.max(layers, e.depth));
                    }
                }
                break;
            }
            case "vkCmdCopyImage":
            case "vkCmdCopyImage2":
            {
                const info = name === "vkCmdCopyImage2" ? a.pCopyImageInfo : a;
                const src = image(info.srcImage), dst = image(info.dstImage);
                if(!src || !dst) break;
                for(const r of info.pRegions || [])
                {
                    const s = r.srcSubresource, d = r.dstSubresource;
                    const layers = s.layerCount === REMAINING ? src.layers - s.baseArrayLayer : s.layerCount;
                    vx.command(VX.COPY_IMAGE, [src.rid, s.aspectMask, s.mipLevel, s.baseArrayLayer, r.srcOffset.x, r.srcOffset.y, r.srcOffset.z,
                        dst.rid, d.aspectMask, d.mipLevel, d.baseArrayLayer, r.dstOffset.x, r.dstOffset.y, r.dstOffset.z,
                        r.extent.width, r.extent.height, r.extent.depth, layers]);
                }
                break;
            }
            case "vkCmdBlitImage":
            case "vkCmdBlitImage2":
            {
                const info = name === "vkCmdBlitImage2" ? a.pBlitImageInfo : a;
                const src = image(info.srcImage), dst = image(info.dstImage);
                if(!src || !dst) break;
                for(const r of info.pRegions || [])
                {
                    const s = r.srcSubresource, d = r.dstSubresource, so = r.srcOffsets, dof = r.dstOffsets;
                    const layers = s.layerCount === REMAINING ? src.layers - s.baseArrayLayer : s.layerCount;
                    vx.command(VX.BLIT_IMAGE, [src.rid, s.mipLevel, s.baseArrayLayer, so[0].x, so[0].y, so[0].z, so[1].x, so[1].y, so[1].z,
                        dst.rid, d.mipLevel, d.baseArrayLayer, dof[0].x, dof[0].y, dof[0].z, dof[1].x, dof[1].y, dof[1].z,
                        layers, info.filter === 1 ? 1 : 0]);
                }
                break;
            }
            case "vkCmdClearColorImage":
            case "vkCmdClearDepthStencilImage":
            {
                const img = image(a.image);
                if(!img) break;
                const color = name === "vkCmdClearColorImage";
                let values;
                if(color) values = Array.from(a.pColor.uint32 || a.pColor.int32 || [0, 0, 0, 0], v => v >>> 0);
                else
                {
                    const f = new Float32Array([a.pDepthStencil.depth]);
                    values = [new Uint32Array(f.buffer)[0], a.pDepthStencil.stencil, 0, 0];
                }
                for(const r of a.pRanges || [])
                {
                    const mips = r.levelCount === REMAINING ? img.mips - r.baseMipLevel : r.levelCount;
                    const layers = r.layerCount === REMAINING ? img.layers - r.baseArrayLayer : r.layerCount;
                    vx.command(VX.CLEAR_IMAGE, [img.rid, r.aspectMask, r.baseMipLevel, mips, r.baseArrayLayer, layers, ...values]);
                }
                break;
            }
            case "vkCmdResolveImage":
            case "vkCmdResolveImage2":
            {
                const info = name === "vkCmdResolveImage2" ? a.pResolveImageInfo : a;
                const src = image(info.srcImage), dst = image(info.dstImage);
                if(!src || !dst) break;
                for(const r of info.pRegions || [])
                {
                    const s = r.srcSubresource, d = r.dstSubresource;
                    vx.command(VX.RESOLVE_IMAGE, [src.rid, s.mipLevel, s.baseArrayLayer, r.srcOffset.x, r.srcOffset.y,
                        dst.rid, d.mipLevel, d.baseArrayLayer, r.dstOffset.x, r.dstOffset.y, r.extent.width, r.extent.height,
                        s.layerCount === REMAINING ? src.layers - s.baseArrayLayer : s.layerCount]);
                }
                break;
            }
            case "vkCmdExecuteCommands":
                for(const id of a.pCommandBuffers || [])
                {
                    const secondary = ctx.objects.get(id);
                    if(secondary) translate(vk, ctx, secondary.commands, state);
                }
                break;
            case "vkCmdSetEvent":
            case "vkCmdSetEvent2":
            case "vkCmdResetEvent":
            case "vkCmdResetEvent2":
            {
                const event = ctx.objects.get(a.event), set = name.startsWith("vkCmdSet");
                if(event) state.after.push(() => { event.set = set; });
                break;
            }
            case "vkCmdResetQueryPool":
            {
                const pool = ctx.objects.get(a.queryPool);
                if(pool) pool.available.fill(0, a.firstQuery, a.firstQuery + a.queryCount);
                break;
            }
            // (one queue, in order: barriers and event waits are kept already)
            case "vkCmdPipelineBarrier":
            case "vkCmdPipelineBarrier2":
            case "vkCmdWaitEvents":
            case "vkCmdWaitEvents2":
                break;
            default:
                vk.warn_once(name, name + " is not done yet");
        }
    }
}
