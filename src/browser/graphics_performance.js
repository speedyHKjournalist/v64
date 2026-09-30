// Opt-in host graphics diagnostics. No command payloads, pixels, guest memory,
// shader source or URLs are retained. Timers are per batch/page/submit, not draw.
const FRAME_LIMITS = [8.334, 16.667, 25, 33.334, 50, 66.667, 100, 200, 500, 1000];
const COUNTERS = ["batches", "commands", "presents", "queueSubmits", "drawCalls",
    "indexedDrawCalls", "upDrawCalls", "pipelineCreations", "pipelineHits",
    "bindGroupCreations", "bindGroupHits", "readbackRequests", "frameFlushes",
    "renderPasses", "commandsFailed", "droppedDraws", "unsupportedCommands",
    "draws", "pipelines", "bindGroups", "shaderLinks", "shaderCacheHits",
    "textureUploads", "textureBytes", "refusals", "uploadBytes", "transientUploadBytes"];

function metric()
{
    return { "calls": 0, "completed": 0, "pending": 0, "errors": 0,
        "sync_ms": 0, "elapsed_ms": 0, "max_elapsed_ms": 0, "untracked": 0 };
}

export class GraphicsPerformance
{
    constructor(emulator, options = {})
    {
        this.emulator = emulator;
        this.now = options.now || (() => performance.now());
        this.host = options.host || globalThis;
        this.cpu_time = options.cpu_time || (() => 0);
        this.start_ms = options.start_ms ?? this.now();
        this.active = true;
        this.cleanup = [];
        this.seen = new WeakSet();
        this.pending = new Set();
        this.queued = new WeakMap();
        this.queue_tokens = new Set();
        this.executors = [];
        this.queues = [];
        this.streams = new Map();
        this.raf = null;
        this.observer = null;
        this.hidden_since = null;
        this.hidden_ms = 0;
        this.data = {
            "version": 1, "available": false, "hook_failures": 0,
            "pci": metric(), "journal_append": metric(), "journal_store": metric(),
            "journal": { "timing_available": false, "pages": 0, "pending": 0, "max_pending": 0,
                "raw_bytes": 0, "compressed_bytes": 0, "queue_wait_ms": 0,
                "service_ms": 0, "max_service_ms": 0, "worker_wall_ms": 0,
                "worker_pages": 0, "local_pages": 0, "errors": 0, "untracked_pages": 0 },
            "host": { "raf_available": false, "long_tasks_available": false,
                "long_tasks": 0, "long_task_ms": 0, "long_task_max_ms": 0 },
            "streams_dropped": 0, "slow_present_intervals": [],
        };
        this.discover();
        const doc = this.host.document;
        if(doc)
        {
            const change = () => {
                const now = this.now();
                if(this.hidden_since !== null) this.hidden_ms += now - this.hidden_since;
                this.hidden_since = doc.visibilityState === "hidden" ? now : null;
            };
            change();
            doc.addEventListener("visibilitychange", change);
            this.cleanup.push(() => doc.removeEventListener("visibilitychange", change));
        }
        if(typeof this.host.requestAnimationFrame === "function")
        {
            this.data["host"]["raf_available"] = true;
            const tick = () => {
                if(!this.active) return;
                this.frame("browser-raf", "browser");
                this.raf = this.host.requestAnimationFrame(tick);
            };
            this.raf = this.host.requestAnimationFrame(tick);
        }
        const observer = this.host.PerformanceObserver;
        if(observer && observer.supportedEntryTypes?.includes("longtask"))
        {
            try {
                this.observer = new observer(list => this.long_tasks(list.getEntries()));
                this.observer.observe({ "type": "longtask", "buffered": false });
                this.data["host"]["long_tasks_available"] = true;
            } catch(_) { this.observer = null; }
        }
    }

    long_tasks(entries)
    {
        if(!this.active) return;
        const host = this.data["host"];
        for(const entry of entries)
        {
            if(entry.startTime < this.start_ms) continue;
            host["long_tasks"]++;
            host["long_task_ms"] += entry.duration;
            host["long_task_max_ms"] = Math.max(host["long_task_max_ms"], entry.duration);
        }
    }

    install(target, key, replacement)
    {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        try {
            target[key] = replacement;
            if(target[key] !== replacement) throw new Error("hook unavailable");
            this.cleanup.push(() => {
                if(target[key] !== replacement) return;
                if(descriptor) Object.defineProperty(target, key, descriptor);
                else delete target[key];
            });
            return true;
        } catch(_) { this.data["hook_failures"]++; return false; }
    }

    wrap(target, key, create)
    {
        if(typeof target?.[key] !== "function") return;
        this.install(target, key, create(target[key]));
    }

    measure(stats, action)
    {
        if(!this.active) return action();
        const start = this.now();
        stats["calls"]++;
        let result;
        try { result = action(); }
        catch(error) { stats["errors"]++; throw error; }
        finally { stats["sync_ms"] += this.now() - start; }
        if(result && typeof result.then === "function")
        {
            if(this.pending.size >= 512) { stats["untracked"]++; return result; }
            const token = {};
            this.pending.add(token);
            stats["pending"]++;
            const finish = error => {
                if(!this.active) return;
                this.pending.delete(token);
                stats["pending"]--;
                if(error) stats["errors"]++;
                else stats["completed"]++;
                const ms = this.now() - start;
                stats["elapsed_ms"] += ms;
                stats["max_elapsed_ms"] = Math.max(stats["max_elapsed_ms"], ms);
            };
            result.then(() => finish(false), () => finish(true));
        }
        else
        {
            const ms = this.now() - start;
            stats["completed"]++;
            stats["elapsed_ms"] += ms;
            stats["max_elapsed_ms"] = Math.max(stats["max_elapsed_ms"], ms);
        }
        return result; // Never replace the renderer's promise or add an await.
    }

    discover()
    {
        if(!this.active) return;
        const bridge = this.emulator["graphics_proxy"]?.["bridge"];
        if(!bridge) return;
        this.data["available"] = true;
        if(!this.seen.has(bridge))
        {
            this.seen.add(bridge);
            this.wrap(bridge, "pushPCIBatch", fn => (...args) =>
                this.measure(this.data["pci"], () => fn.apply(bridge, args)));
        }
        this.attach_journal(bridge["graphicsJournal"]);
        for(const [key, name] of [["d3d9Executor", "d3d9-ddraw"], ["d3d8Executor", "d3d8"], ["glExecutor", "opengl"]])
        {
            const executor = bridge[key];
            if(executor) this.attach_executor(executor, name);
        }
    }

    attach_executor(executor, name)
    {
        if(this.seen.has(executor)) { this.attach_queue(executor["device"]?.["queue"]); return; }
        if(this.executors.length >= 12) return;
        this.seen.add(executor);
        const stats = { "api": name, "submit": metric(), "execute": metric(), "finish_frame": metric(),
            "queue_wait_calls": 0, "queue_wait_ms": 0, "queue_wait_max_ms": 0, "queue_wait_untracked": 0,
            "execute_sync_ms": executor["performanceTimingVersion"] === 1 || name !== "d3d9-ddraw" ? 0 : null,
            "counters": {}, "counter_resets": 0 };
        const state = { executor, stats, baseline: {} };
        this.executors.push(state);
        this.read_counters(state, true);
        if(executor["performanceTimingVersion"] === 1)
            this.install(executor, "performanceTiming", {
                "now": this.now,
                "sync": ms => { if(this.active) stats["execute_sync_ms"] += ms; },
            });
        this.wrap(executor, "submit", fn => (...args) => {
            const metadata = args[1];
            let token;
            if(this.active && metadata && typeof metadata === "object")
            {
                if(this.queue_tokens.size < 512 && !this.queued.has(metadata))
                {
                    token = { start: this.now() };
                    this.queued.set(metadata, token);
                    this.queue_tokens.add(token);
                }
                else stats["queue_wait_untracked"]++;
            }
            const release = () => {
                if(token && this.queued.get(metadata) === token)
                {
                    this.queued.delete(metadata);
                    this.queue_tokens.delete(token);
                }
            };
            try {
                const result = this.measure(stats["submit"], () => fn.apply(executor, args));
                if(token && result && typeof result.then === "function") result.then(release, release);
                return result;
            } catch(error) { release(); throw error; }
        });
        this.wrap(executor, "executeBatch", fn => (...args) => {
            const token = args[1] && this.queued.get(args[1]);
            if(this.active && token)
            {
                this.queued.delete(args[1]);
                this.queue_tokens.delete(token);
                const ms = this.now() - token.start;
                stats["queue_wait_calls"]++;
                stats["queue_wait_ms"] += ms;
                stats["queue_wait_max_ms"] = Math.max(stats["queue_wait_max_ms"], ms);
            }
            this.attach_queue(executor["device"]?.["queue"]);
            const before = stats["execute"]["sync_ms"];
            try { return this.measure(stats["execute"], () => fn.apply(executor, args)); }
            finally {
                if(this.active && name !== "d3d9-ddraw")
                    stats["execute_sync_ms"] += stats["execute"]["sync_ms"] - before;
            }
        });
        this.wrap(executor, "finishFrame", fn => (...args) => {
            this.attach_queue(executor["device"]?.["queue"]);
            return this.measure(stats["finish_frame"], () => fn.apply(executor, args));
        });
        if(name === "opengl")
            this.wrap(executor, "presentToCanvas", fn => (...args) => {
                const result = fn.apply(executor, args);
                if(result === true) this.frame(name, "gl");
                return result;
            });
        else if(executor["options"])
        {
            const options = executor["options"], original = options["onPresent"];
            this.install(options, "onPresent", (...args) => {
                this.frame(name, String(args[0]?.["sessionKey"] || "default").slice(0, 64));
                if(typeof original === "function") return original.apply(options, args);
            });
        }
    }

    read_counters(state, initial = false)
    {
        state.stats["executor_error_flag"] = !!state.executor["failed"];
        const current = state.executor["stats"] || {};
        for(const key of COUNTERS)
        {
            const value = current[key];
            if(typeof value !== "number" || !Number.isFinite(value)) continue;
            const previous = state.baseline[key];
            if(!initial && previous !== undefined)
            {
                if(value < previous) state.stats["counter_resets"]++;
                state.stats["counters"][key] += value >= previous ? value - previous : value;
            }
            else state.stats["counters"][key] = 0;
            state.baseline[key] = value;
        }
    }

    attach_queue(queue)
    {
        if(!this.active || !queue || this.seen.has(queue) || this.queues.length >= 4) return;
        this.seen.add(queue);
        const stats = { "id": this.queues.length, "submit": metric(), "fence": metric(),
            "fence_supported": typeof queue["onSubmittedWorkDone"] === "function" };
        this.queues.push(stats);
        let next = 0, pending = false;
        this.wrap(queue, "submit", fn => (...args) => {
            const result = this.measure(stats["submit"], () => fn.apply(queue, args));
            if(this.active && stats["fence_supported"] && !pending && this.now() >= next)
            {
                next = this.now() + 500;
                pending = true;
                try {
                    const promise = this.measure(stats["fence"], () => queue["onSubmittedWorkDone"]());
                    promise.then(() => { pending = false; }, () => { pending = false; });
                } catch(_) { pending = false; } // Optional probe must not fail rendering.
            }
            return result;
        });
    }

    attach_journal(journal)
    {
        if(!journal || this.seen.has(journal)) return;
        this.seen.add(journal);
        this.wrap(journal, "append", fn => (...args) => this.measure(this.data["journal_append"], () => fn.apply(journal, args)));
        if(journal["store"])
            this.wrap(journal["store"], "put", fn => (...args) => this.measure(this.data["journal_store"], () => fn.apply(journal["store"], args)));
        const stats = this.data["journal"];
        if(journal["performanceTimingVersion"] !== 1) return;
        stats["timing_available"] = true;
        this.install(journal, "performanceTiming", { "page": bytes => {
            if(!this.active) return null;
            if(stats["pending"] >= 128) { stats["untracked_pages"]++; return null; }
            const queued = this.now();
            let start = null;
            stats["pages"]++;
            stats["pending"]++;
            stats["max_pending"] = Math.max(stats["max_pending"], stats["pending"]);
            stats["raw_bytes"] += bytes;
            return {
                "start": () => { if(this.active) { start = this.now(); stats["queue_wait_ms"] += start - queued; } },
                "finish": result => {
                    if(!this.active) return;
                    stats["pending"]--;
                    const ms = this.now() - start;
                    stats["service_ms"] += ms;
                    stats["max_service_ms"] = Math.max(stats["max_service_ms"], ms);
                    if(!result) { stats["errors"]++; return; }
                    stats["compressed_bytes"] += result["data"].byteLength;
                    if(result["compression_backend"] === "worker")
                    {
                        stats["worker_pages"]++;
                        stats["worker_wall_ms"] += result["compression_ms"] || 0;
                    }
                    else stats["local_pages"]++;
                },
            };
        } });
    }

    frame(api, session)
    {
        if(!this.active) return;
        const key = api + ":" + session, now = this.now(), cpu = this.cpu_time();
        let state = this.streams.get(key);
        if(!state)
        {
            if(this.streams.size >= 16) { this.data["streams_dropped"]++; return; }
            state = { "api": api, "session": session, "events": 0, "intervals": 0, "interval_sum_ms": 0,
                "interval_max_ms": 0, "histogram": new Array(FRAME_LIMITS.length + 1).fill(0),
                "last_ms": null, "last_cpu_ms": cpu };
            this.streams.set(key, state);
        }
        if(state["last_ms"] !== null)
        {
            const ms = now - state["last_ms"];
            state["intervals"]++;
            state["interval_sum_ms"] += ms;
            state["interval_max_ms"] = Math.max(state["interval_max_ms"], ms);
            let bin = 0;
            while(bin < FRAME_LIMITS.length && ms > FRAME_LIMITS[bin]) bin++;
            state["histogram"][bin]++;
            if(api !== "browser-raf" && ms >= 50)
            {
                const item = { "api": api, "session": session, "end_ms": now - this.start_ms,
                    "interval_ms": ms, "cpu_main_loop_ms": Math.max(0, cpu - state["last_cpu_ms"]) };
                const slow = this.data["slow_present_intervals"];
                if(slow.length < 32) slow.push(item);
                else
                {
                    let smallest = 0;
                    for(let i = 1; i < slow.length; i++) if(slow[i]["interval_ms"] < slow[smallest]["interval_ms"]) smallest = i;
                    if(ms > slow[smallest]["interval_ms"]) slow[smallest] = item;
                }
            }
        }
        state["events"]++;
        state["last_ms"] = now;
        state["last_cpu_ms"] = cpu;
    }

    snapshot()
    {
        this.discover();
        for(const state of this.executors) this.read_counters(state);
        const now = this.now();
        const streams = Array.from(this.streams.values(), state => ({ ...state,
            "since_last_event_ms": now - state["last_ms"],
            "mean_fps": state["interval_sum_ms"] > 0 ? state["intervals"] * 1000 / state["interval_sum_ms"] : null,
            "last_ms": state["last_ms"] - this.start_ms }));
        return JSON.parse(JSON.stringify({ ...this.data, "streams": streams,
            "interval_histogram_upper_ms": FRAME_LIMITS,
            "executors": this.executors.map(state => state.stats), "gpu_queues": this.queues,
            "queue_wait_pending": this.queue_tokens.size,
            "hidden_ms": this.hidden_ms + (this.hidden_since === null ? 0 : now - this.hidden_since) }));
    }

    stop()
    {
        if(this.observer) this.long_tasks(this.observer.takeRecords());
        const report = this.snapshot();
        this.active = false;
        if(this.raf !== null) this.host.cancelAnimationFrame(this.raf);
        if(this.observer) this.observer.disconnect();
        for(const restore of this.cleanup.reverse()) restore();
        this.cleanup = [];
        this.pending.clear();
        this.queue_tokens.clear();
        return report;
    }
}
