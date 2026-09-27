// Browser-side ownership boundary. Guest RAM and synchronous devices live only
// in the worker; this side owns DOM adapters and asynchronous GPU execution.
import { GraphicsPerformance } from "./graphics_performance.js";

export function encode_worker_file(f)
{
    if(!f) return undefined;
    if(f.get || f.set || f.load) throw new Error("CPU Worker requires a URL, File or buffer disk descriptor");
    return { "url": f.url && new URL(f.url, location.href).href,
        "buffer": f.buffer, "async": f.async, "size": f.size,
        "fixed_chunk_size": f.fixed_chunk_size, "use_parts": f.use_parts };
}

export function encode_worker_options(o)
{
    const file = encode_worker_file;
    const fs = o.filesystem;
    if(o.wasm_fn || fs?.handle9p) throw new Error("CPU Worker cannot transfer wasm_fn or handle9p callbacks");
    return {
        "graphics_available": !!o["graphics_adapter"],
        "wasm_path": new URL(o.wasm_path || "build/v86.wasm", location.href).href,
        "wasm_fallback_path": o["wasm_fallback_path"] && new URL(o["wasm_fallback_path"], location.href).href,
        "memory_size": o.memory_size, "vga_memory_size": o.vga_memory_size,
        "boot_order": o.boot_order, "acpi": o.acpi, "disable_jit": o.disable_jit,
        "jit_backend": o["jit_backend"], "ir_region_budget": o["ir_region_budget"],
        "ir_stats": o["ir_stats"],
        "ir_verify": o["ir_verify"], "ir_dump": o["ir_dump"],
        "ir_opt_level": o["ir_opt_level"], "ir_passes_disabled": o["ir_passes_disabled"],
        "ir_tier0": o["ir_tier0"],
        "x87_fast_math": o["x87_fast_math"],
        "x87_jit_cache": o["x87_jit_cache"],
        "fastboot": o.fastboot, "bootmenu": o.bootmenu, "cmdline": o.cmdline,
        "cpuid_level": o.cpuid_level, "uart1": o.uart1, "uart2": o.uart2, "uart3": o.uart3,
        "parallel1": o.parallel1, "virtio_balloon": o.virtio_balloon,
        "virtio_console": !!o.virtio_console, "modem": o.modem && { "uart": o.modem.uart },
        "preserve_mac_from_state_image": o.preserve_mac_from_state_image,
        "mac_address_translation": o.mac_address_translation,
        "net_device": { "type": o.net_device?.type || "ne2k" },
        "v86gl_pci": o.v86gl_pci || (o["graphics_adapter"] ? { "maxBatchBytes": 16 * 1024 * 1024 } : undefined),
        "bios": file(o.bios), "vga_bios": file(o.vga_bios), "hda": file(o.hda), "hdb": file(o.hdb),
        "fda": file(o.fda), "fdb": file(o.fdb), "cdrom": file(o.cdrom),
        "multiboot": file(o.multiboot), "bzimage": file(o.bzimage), "initrd": file(o.initrd),
        "initial_state": file(o.initial_state),
        "filesystem": fs && { "baseurl": fs.baseurl && new URL(fs.baseurl, location.href).href,
            "basefs": typeof fs.basefs === "string" ? new URL(fs.basefs, location.href).href : file(fs.basefs),
            "proxy_url": fs.proxy_url },
        "bzimage_initrd_from_filesystem": o.bzimage_initrd_from_filesystem,
        "disable_keyboard": true, "disable_mouse": true, "disable_speaker": true,
        "autostart": false,
    };
}

export class CPUWorkerController
{
    constructor(emulator, options)
    {
        this.emulator = emulator;
        this.options = options;
        this.pending = new Map();
        this.next_id = 0;
        this.epoch = 1;
        this.failed = null;
        this.closed = false;
        this.graphics_work = Promise.resolve();
        this.startup_resolve = null;
        this.startup_reject = null;
        this.startup = new Promise((resolve, reject) => {
            this.startup_resolve = resolve;
            this.startup_reject = reject;
        });
        this.startup.catch(() => {});
        this.operations = this.startup;
        this.instructions = 0;
        this.frame_pending = false;
        this.input_queue = [];
        this.ready = false;
        this.screen_queue = [];
        this.device_info = {};
        this.restore_checkpoint = null;
        this.recording_report = null;
        this.direct_audio = false;
        this.stats = { "mode": "worker", "graphics_batches": 0, "graphics_bytes": 0,
            "graphics_pending": 0, "graphics_peak_pending": 0 };
        const url = options["cpu_worker_url"] || "build/cpu-worker.js";
        this.worker = new Worker(url, { "name": "v86 CPU" });
        this.worker.onmessage = e => this.receive(e.data);
        this.worker.onerror = e => this.fail(new Error(e.message || "CPU Worker failed to start"));
        this.worker.onmessageerror = () => this.fail(new Error("CPU Worker message could not be decoded"));
        emulator.bus.send = (name, value) => {
            if(this.closed || this.failed) return;
            if(!this.ready) this.input_queue.push([name, value]);
            else this.post({ "type": "event", "epoch": this.epoch, "name": name, "value": value });
        };
    }

    post(message, transfer = []) { this.worker.postMessage(message, transfer); }

    rpc(method, args = [], transfer = [])
    {
        if(this.closed || this.failed) return Promise.reject(this.failed || new Error("CPU Worker is closed"));
        const id = ++this.next_id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { this.post({ "type": "rpc", "id": id, "method": method, "args": args }, transfer); }
            catch(error) { this.pending.delete(id); reject(error); }
        });
    }

    fail(error)
    {
        if(this.failed || this.closed) return;
        this.failed = error;
        this.startup_reject(error);
        this.emulator.cpu_is_running = false;
        for(const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        this.worker.terminate();
        this.emulator.screen_adapter?.pause();
        this.emulator.speaker_adapter?.pause();
        this.emulator.emulator_bus.send("emulator-error", error);
        console.error("[v86 CPU Worker]", error);
    }

    async start()
    {
        await this.emulator["graphics_adapter"]?.["ready"];
        await this.rpc("init", [encode_worker_options(this.options)]);
        if(this.restore_checkpoint)
        {
            const g = this.emulator["graphics_adapter"];
            if(!g) throw new Error("Snapshot contains graphics state but no graphics adapter is configured");
            g["beginStateRestore"]();
            g["onPCIStateRestored"](this.restore_checkpoint);
            await g["finishStateRestore"]();
            this.restore_checkpoint = null;
        }
        const dac = this.emulator.speaker_adapter?.dac;
        if(dac?.connect_cpu_worker)
        {
            const port = await dac.connect_cpu_worker();
            await this.rpc("audio-attach", [port], [port]);
            this.direct_audio = true;
        }
        this.ready = true;
        for(const [name, value] of this.input_queue) this.emulator.bus.send(name, value);
        this.input_queue = [];
        if(this.options.autostart && !this.emulator.destroyed) await this.rpc("run");
        this.startup_resolve();
        this.emulator.emulator_bus.send("emulator-loaded");
        this.options = null;
    }

    receive(m)
    {
        if(this.closed || this.failed) return;
        if(m["type"] === "result")
        {
            const p = this.pending.get(m["id"]);
            if(!p) return;
            this.pending.delete(m["id"]);
            if(m["error"]) p.reject(new Error(m["error"])); else p.resolve(m["value"]);
            return;
        }
        if(m["type"] === "fatal") { this.fail(new Error(m["error"])); return; }
        if(m["type"] === "epoch")
        {
            this.epoch = m["epoch"];
            this.screen_queue = [];
            this.frame_pending = false;
            if(!this.direct_audio) this.emulator.emulator_bus.send("dac-reset");
            return;
        }
        if(m["epoch"] !== this.epoch) return;
        switch(m["type"])
        {
            case "event":
                if(m["name"] === "download-progress" || m["name"] === "download-error")
                {
                    const v = m["value"];
                    this.emulator.emulator_bus.send(m["name"], { file_name: v["file_name"],
                        file_index: v["file_index"], file_count: v["file_count"],
                        loaded: v["loaded"], total: v["total"], lengthComputable: v["lengthComputable"] });
                }
                else this.emulator.emulator_bus.send(m["name"], m["value"]);
                break;
            case "screen":
                // Guest text redraws can exceed the host's argument limit.
                // Append individually so even large bursts remain lossless.
                for(const command of m["commands"]) this.screen_queue.push(command);
                this.flush_screen();
                break;
            case "frame": this.frame_pending = false; this.draw_frame(m["layers"]); break;
            case "stats":
                this.instructions = m["value"]["instructions"];
                this.device_info = m["value"];
                break;
            case "graphics": this.graphics(m); break;
            case "checkpoint":
                this.restore_checkpoint = m["value"];
                break;
            case "recording": this.recording_report?.(m["value"]); break;
        }
    }

    flush_screen()
    {
        const s = this.emulator.screen_adapter;
        const methods = {
            "set_mode": (...a) => s.set_mode(...a), "set_size_text": (...a) => s.set_size_text(...a),
            "set_size_graphical": (...a) => s.set_size_graphical(...a), "put_char": (...a) => s.put_char(...a),
            "update_cursor": (...a) => s.update_cursor(...a),
            "update_cursor_scanline": (...a) => s.update_cursor_scanline(...a),
            "clear_screen": () => s.clear_screen(), "clear_text_state": () => s.clear_text_state(),
            "set_font_bitmap": (...a) => s.set_font_bitmap(...a), "set_font_page": (...a) => s.set_font_page(...a),
        };
        for(const [name, args] of this.screen_queue.splice(0)) methods[name](...args);
    }

    request_frame()
    {
        if(!this.ready || this.frame_pending || this.closed || this.failed) return;
        this.frame_pending = true;
        this.post({ "type": "frame", "epoch": this.epoch });
    }

    draw_frame(layers)
    {
        this.emulator.screen_adapter.update_buffer(layers.map(l => ({
            image_data: new ImageData(l["pixels"], l["width"], l["height"]),
            screen_x: l["x"], screen_y: l["y"], buffer_x: 0, buffer_y: 0,
            buffer_width: l["width"], buffer_height: l["height"],
        })));
    }

    graphics(m)
    {
        const epoch = this.epoch;
        const event = m["value"];
        const bridge = this.emulator["graphics_adapter"];
        ++this.stats["graphics_batches"];
        this.stats["graphics_bytes"] += event["bytes"].byteLength;
        ++this.stats["graphics_pending"];
        this.stats["graphics_peak_pending"] = Math.max(this.stats["graphics_peak_pending"], this.stats["graphics_pending"]);
        event["isMemoryValid"] = () => epoch === this.epoch && !this.closed && !this.failed;
        event["writeGuestMemory"] = (offset, bytes) => {
            if(!event["isMemoryValid"]()) return;
            const copy = new Uint8Array(bytes).slice();
            this.post({ "type": "gpu-write", "epoch": epoch, "id": m["id"], "offset": offset, "bytes": copy }, [copy.buffer]);
        };
        const work = this.graphics_work.then(async () => {
            if(epoch !== this.epoch) return;
            if(!bridge) throw new Error("CPU Worker graphics batch has no renderer");
            this.emulator.emulator_bus.send("v86gl-pci-frame", event);
            await bridge["waitForSubmittedBatches"]();
        });
        this.graphics_work = work.then(() => {
            --this.stats["graphics_pending"];
            this.post({ "type": "gpu-done", "epoch": epoch, "id": m["id"] });
        }, error => { this.fail(error); throw error; });
        this.graphics_work.catch(() => {});
    }

    serialize(operation)
    {
        const next = this.operations.catch(() => {}).then(operation);
        this.operations = next.then(() => {}, () => {});
        return next;
    }

    async stop()
    {
        await this.rpc("stop");
        // Acknowledging a batch can release another pending virtqueue request.
        // Drain to a fixed point, not just the promise observed at stop time.
        let pending;
        do {
            await this.graphics_work;
            pending = await this.rpc("barrier");
        } while(pending);
        await this.emulator.speaker_adapter?.pause();
    }

    state(kind, state = null)
    {
        return this.serialize(async () => {
            const running = this.emulator.is_running();
            await this.stop();
            const g = this.emulator["graphics_adapter"];
            let ok = false;
            try
            {
                if(kind === "save")
                {
                    await g?.["prepareSaveState"]();
                    const checkpoint = g ? g["serializeCheckpoint"]() : null;
                    const result = await this.rpc("save", [checkpoint]);
                    ok = true;
                    return result;
                }
                this.restore_checkpoint = null;
                g?.["beginStateRestore"]();
                await g?.["waitForIdle"](false, true);
                await this.rpc(kind, state ? [state] : []);
                if(kind === "restore")
                {
                    g?.["onPCIStateRestored"](this.restore_checkpoint);
                    await g?.["finishStateRestore"]();
                }
                else await g?.["reset"]();
                ok = true;
            }
            catch(error) { g?.["cancelStateRestore"](); throw error; }
            finally
            {
                g?.["releaseCheckpoint"]();
                this.restore_checkpoint = null;
                if(running && !this.emulator.destroyed && (ok || kind === "save")) await this.rpc("run");
            }
        });
    }

    async destroy()
    {
        if(this.closed) return;
        await this.operations.catch(() => {});
        if(!this.failed)
        {
            try { await this.stop(); await this.rpc("destroy"); }
            finally { this.close(); }
        }
        else this.close();
    }

    close()
    {
        this.closed = true;
        this.startup_reject(new Error("CPU Worker destroyed"));
        this.worker.terminate();
        for(const p of this.pending.values()) p.reject(new Error("CPU Worker destroyed"));
        this.pending.clear();
        this.input_queue = [];
        this.screen_queue = [];
    }
}

export class WorkerPerformanceRecorder
{
    constructor(emulator, options)
    {
        this.emulator = emulator;
        this.options = options;
        this.active = false;
        this.report = null;
        this.graphics = null;
    }
    async start()
    {
        if(this.active) throw new Error("Performance recording is already active");
        this.active = true;
        this.graphics = new GraphicsPerformance(this.emulator);
        this.emulator.worker_controller.recording_report = report => this.finish(report);
        try {
            await this.emulator.worker_controller.startup;
            await this.emulator.worker_controller.rpc("record-start", [this.options.metadata || {}]);
        }
        catch(error) { this.active = false; this.graphics.stop(); throw error; }
    }
    finish(report)
    {
        if(!this.active) return;
        report["graphics"] = this.graphics.stop();
        report["worker_transport"] = { ...this.emulator.worker_controller.stats };
        report["metadata"]["cpu_thread"] = "dedicated-worker";
        this.report = report;
        this.active = false;
        this.options.on_stop?.(report);
    }
    async stop()
    {
        if(this.active) this.finish(await this.emulator.worker_controller.rpc("record-stop"));
        return this.report;
    }
}
