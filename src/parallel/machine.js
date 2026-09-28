// Host-parallel machine (docs/acpi-x86-64-multicore-plan.zh-CN.md, W1): the
// bootstrap processor and every device run on this thread, in the machine
// instance of v86-parallel.wasm (base 0); each application processor runs in
// a vCPU worker (src/parallel/vcpu.js) with its own relocated instance in the
// same shared memory.
//
// This side serves the workers' port and device-MMIO accesses, keeps the
// control block's clock offset current and stops all cores (parks them at a
// safe point) around snapshots, resets, sleep states and pauses.

import { dbg_log } from "../log.js";
import { LOG_CPU } from "../const.js";
import { CORE_STATE_RANGES } from "../state_layout.js";
import { image_size, PAGE_SIZE } from "./relocate.js";
import * as C from "./control.js";

/* global __dirname, V86_BUNDLE */

const NODE = typeof process !== "undefined" && process.versions && process.versions.node;

export class ParallelMachine
{
    /**
     * @param {Object} cpu the machine's CPU (instance at base 0)
     * @param {{bytes: Uint8Array, settings: Object, worker_url: (string|URL)}} options
     */
    constructor(cpu, options)
    {
        this.cpu = cpu;
        this.exports = cpu.wm.exports;
        this.cores = cpu.cores.length;
        this.bytes = options.bytes;
        this.settings = options.settings;
        this.worker_url = options.worker_url;
        this.control = new SharedArrayBuffer(C.CONTROL_WORDS * 4 + 8);
        this.ctrl = new Int32Array(this.control);
        this.clock_offset = new Float64Array(this.control, C.CONTROL_WORDS * 4, 1);
        this.workers = [];
        this.epoch = 0;
        this.stopping_epoch = 0;
        this.command = C.COMMAND_NONE;
        this.failure = null;
        this.destroyed = false;
        this.served = 0;
        this.sync_clock();
    }

    sync_clock()
    {
        this.clock_offset[0] = performance.timeOrigin + performance.now() - this.cpu.clock.now();
    }

    /** Start the application processors; they wait for INIT/SIPI */
    async start()
    {
        const memory = this.cpu.wasm_memory;
        const pages = Math.ceil(image_size(this.bytes) / PAGE_SIZE);
        this.exports["parallel_set_active"](true);
        const ready = [];
        for(let core = 1; core < this.cores; core++)
        {
            // fresh (so zeroed) pages for the worker's static data and stack
            const base = memory.grow(pages) * PAGE_SIZE;
            const worker = await create_worker(this.worker_url, "v86 vCPU " + core);
            this.workers[core] = worker;
            ready.push(new Promise((resolve, reject) => {
                worker.on_message(message => {
                    if(message["type"] === "ready") resolve();
                    else if(message["type"] === "error")
                    {
                        this.failure = new Error("vCPU " + core + " failed: " + message["message"]);
                        reject(this.failure);
                        this.cpu.stop_idling();
                    }
                });
                worker.on_error(error => {
                    this.failure = error;
                    reject(error);
                    this.cpu.stop_idling();
                });
            }));
            worker.post({
                "bytes": this.bytes, "memory": memory, "control": this.control,
                "base": base, "core": core, "cores": this.cores,
                "mem8": this.cpu.mem8.byteOffset, "memory_size": this.cpu.memory_size[0],
                "settings": this.settings, "log": false,
            });
        }
        await Promise.all(ready);
        this.watch();
        dbg_log("parallel machine: " + (this.cores - 1) + " vCPU workers", LOG_CPU);
    }

    /** Run the machine's loop whenever a worker kicks core 0 (I/O, parking, IPIs) */
    watch()
    {
        const wake = new Int32Array(this.cpu.wasm_memory.buffer);
        const index = this.exports["parallel_wake_addr"](0) >>> 2;
        const loop = () => {
            if(this.destroyed) return;
            const value = Atomics.load(wake, index);
            const waiter = typeof Atomics.waitAsync === "function" ? Atomics.waitAsync(wake, index, value, 100) : null;
            const next = () => { if(!this.destroyed) { this.cpu.stop_idling(); loop(); } };
            if(waiter && waiter.async) waiter.value.then(next);
            else setTimeout(next, waiter ? 0 : 1);
        };
        loop();
    }

    /** Perform the workers' pending port and MMIO accesses; returns how many */
    service()
    {
        const ctrl = this.ctrl, cpu = this.cpu;
        let count = 0;
        for(let core = 1; core < this.cores; core++)
        {
            const at = w => C.core_word(core, w);
            if(Atomics.load(ctrl, at(C.IO_STATE)) !== C.IO_REQUEST) continue;
            const op = ctrl[at(C.IO_OP)], addr = ctrl[at(C.IO_ADDR)];
            const v0 = ctrl[at(C.IO_V0)], v1 = ctrl[at(C.IO_V1)], v2 = ctrl[at(C.IO_V2)], v3 = ctrl[at(C.IO_V3)];
            let result = 0;
            switch(op)
            {
                case C.OP_IN8: result = this.exports["machine_io_read8"](addr); break;
                case C.OP_IN16: result = cpu.io.port_read16(addr); break;
                case C.OP_IN32: result = cpu.io.port_read32(addr); break;
                case C.OP_OUT8: this.exports["machine_io_write8"](addr, v0); break;
                case C.OP_OUT16: cpu.io.port_write16(addr, v0 & 0xFFFF); break;
                case C.OP_OUT32: cpu.io.port_write32(addr, v0); break;
                case C.OP_MMIO_READ8: result = cpu.mmap_read8(addr >>> 0); break;
                case C.OP_MMIO_READ32: result = cpu.mmap_read32(addr >>> 0); break;
                case C.OP_MMIO_WRITE8: cpu.mmap_write8(addr >>> 0, v0 & 0xFF); break;
                case C.OP_MMIO_WRITE16: cpu.mmap_write16(addr >>> 0, v0 & 0xFFFF); break;
                case C.OP_MMIO_WRITE32: cpu.mmap_write32(addr >>> 0, v0); break;
                case C.OP_MMIO_WRITE64: cpu.mmap_write64(addr >>> 0, v0, v1); break;
                case C.OP_MMIO_WRITE128: cpu.mmap_write128(addr >>> 0, v0, v1, v2, v3); break;
                default: dbg_log("vCPU " + core + ": unknown request " + op, LOG_CPU);
            }
            ctrl[at(C.IO_RESULT)] = result;
            ctrl[at(C.IO_COUNT)]++;
            Atomics.store(ctrl, at(C.IO_STATE), C.IO_DONE);
            Atomics.notify(ctrl, at(C.IO_STATE));
            count++;
        }
        this.served += count;
        return count;
    }

    check_failure()
    {
        if(this.failure) throw this.failure;
        for(let core = 1; core < this.cores; core++)
        {
            if(Atomics.load(this.ctrl, C.core_word(core, C.ERROR)))
            {
                throw new Error("vCPU " + core + " failed");
            }
        }
    }

    /** Whether a stop is in effect (requested and not resumed) */
    stopping()
    {
        return this.stopping_epoch > Atomics.load(this.ctrl, C.RESUME);
    }

    /** Ask every worker to park at its next safe point, without waiting */
    request_stop()
    {
        if(this.stopping()) return;
        this.stopping_epoch = ++this.epoch;
        Atomics.store(this.ctrl, C.STOP, this.stopping_epoch);
        for(let core = 1; core < this.cores; core++) this.exports["parallel_kick"](core);
    }

    /** Whether every worker has parked for the current stop */
    all_parked()
    {
        if(!this.stopping()) return false;
        for(let core = 1; core < this.cores; core++)
        {
            const status = Atomics.load(this.ctrl, C.core_word(core, C.STATUS));
            if(status === C.STATUS_FAILED || status === C.STATUS_EXITED) continue;
            if(Atomics.load(this.ctrl, C.core_word(core, C.ACK)) !== this.stopping_epoch) return false;
        }
        return true;
    }

    /** Stop every worker at a safe point, serving their I/O until they get there */
    async park()
    {
        this.request_stop();
        const deadline = Date.now() + 30000;
        while(!this.all_parked())
        {
            this.service();
            this.check_failure();
            if(Date.now() > deadline) throw new Error("vCPU workers did not stop: " + JSON.stringify(this.status()));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    /** A command the workers run when they next resume (they must be parked) */
    schedule(command)
    {
        this.command = Math.max(this.command, command);
    }

    /** Let parked workers continue */
    resume()
    {
        if(!this.stopping()) return;
        this.sync_clock();
        Atomics.store(this.ctrl, C.COMMAND, this.command);
        this.command = C.COMMAND_NONE;
        Atomics.store(this.ctrl, C.RESUME, this.stopping_epoch);
        Atomics.notify(this.ctrl, C.RESUME);
    }

    /** The saved state of a parked core, in the layout of CPU.prototype.save_core_state */
    read_core(core)
    {
        const base = this.ctrl[C.core_word(core, C.STATE_BASE)];
        const memory = new Uint8Array(this.cpu.wasm_memory.buffer);
        return CORE_STATE_RANGES.map(([start, end]) => memory.slice(base + start, base + end));
    }

    write_core(core, saved)
    {
        const base = this.ctrl[C.core_word(core, C.STATE_BASE)];
        const memory = new Uint8Array(this.cpu.wasm_memory.buffer);
        CORE_STATE_RANGES.forEach(([start], i) => memory.set(saved[i], base + start));
    }

    /** Address of offset 0 of a worker core's state block (live, racy while it runs) */
    state_base(core) { return this.ctrl[C.core_word(core, C.STATE_BASE)]; }
    core_running(core) { return Atomics.load(this.ctrl, C.core_word(core, C.RUNNING)) !== 0; }
    set_core_running(core, running) { Atomics.store(this.ctrl, C.core_word(core, C.RUNNING), running ? 1 : 0); }
    core_tsc_offset(core)
    {
        return [this.ctrl[C.core_word(core, C.TSC_OFFSET_LO)] >>> 0, this.ctrl[C.core_word(core, C.TSC_OFFSET_HI)] >>> 0];
    }
    set_core_tsc_offset(core, tsc)
    {
        this.ctrl[C.core_word(core, C.TSC_OFFSET_LO)] = tsc[0];
        this.ctrl[C.core_word(core, C.TSC_OFFSET_HI)] = tsc[1];
    }
    core_counters(core)
    {
        const at = w => this.ctrl[C.core_word(core, w)] >>> 0;
        return { slices: at(C.SLICES), steps: at(C.STEPS), waits: at(C.WAITS), io: at(C.IO_COUNT), jit: at(C.JIT_ENTRIES),
            unpublished: at(C.UNPUBLISHED) };
    }

    status()
    {
        const names = ["starting", "wait-for-sipi", "running", "halted", "parked", "failed", "exited"];
        const cores = [];
        for(let core = 1; core < this.cores; core++)
        {
            const at = w => this.ctrl[C.core_word(core, w)];
            cores.push(Object.assign({ "core": core, "status": names[at(C.STATUS)], "ack": at(C.ACK),
                "io_state": at(C.IO_STATE) }, this.core_counters(core)));
        }
        return { "epoch": this.epoch, "resume": this.ctrl[C.RESUME], "served": this.served, "cores": cores };
    }

    destroy()
    {
        if(this.destroyed) return;
        this.destroyed = true;
        Atomics.store(this.ctrl, C.SHUTDOWN, 1);
        Atomics.notify(this.ctrl, C.RESUME);
        for(let core = 1; core < this.cores; core++)
        {
            this.exports["parallel_kick"](core);
            Atomics.notify(this.ctrl, C.core_word(core, C.IO_STATE));
            this.workers[core]?.terminate();
        }
        this.exports["parallel_set_active"](false);
    }
}

/**
 * The script of the vCPU workers when the embedder doesn't pass one
 * (`vcpu_worker_url`): build/vcpu-worker.js for the bundles (next to
 * libv86.js in Node, like v86.wasm), the ES module entry for the source tree
 * @return {Promise<string|URL>}
 */
export async function default_worker_url()
{
    if(typeof V86_BUNDLE !== "undefined")
    {
        return NODE && typeof __dirname === "string" ? __dirname + "/vcpu-worker.js" : "build/vcpu-worker.js";
    }
    return (await import("./" + "entry_url.js"))["VCPU_WORKER_ENTRY"];
}

async function create_worker(url, name)
{
    if(NODE)
    {
        const { Worker } = await import("node:" + "worker_threads");
        // (a relative path is relative to the working directory, like v86.wasm)
        const target = url instanceof URL || /^[a-z]+:/i.test(url) ? new URL(url) :
            /^\.{0,2}[\\/]/.test(url) ? url : "./" + url;
        const worker = new Worker(target, { "name": name });
        worker["unref"]();
        return {
            post: message => worker.postMessage(message),
            on_message: f => worker.on("message", f),
            on_error: f => worker.on("error", f),
            terminate: () => worker.terminate(),
        };
    }
    const worker = new Worker(url, { "type": "module", "name": name });
    return {
        post: message => worker.postMessage(message),
        on_message: f => { worker.onmessage = e => f(e.data); },
        on_error: f => { worker.onerror = e => f(e.error || new Error(e.message)); },
        terminate: () => worker.terminate(),
    };
}
