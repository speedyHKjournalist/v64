import { wasm_fallback_path } from "./wasm_paths.js";
// Dedicated-worker entry. Never transfer the WebAssembly.Memory buffer.
import { V86 } from "./starter.js";
import { PerformanceRecorder } from "./performance_recorder.js";

export function start_cpu_worker()
{
    let emulator, epoch = 1, next_batch = 0, recorder, checkpoint = null;
    let screen_commands = [], screen_scheduled = false, frame_layers = [];
    let timer, command_chain = Promise.resolve();
    const inflight = new Map();
    const MAX_BATCHES = 8, MAX_BYTES = 32 * 1024 * 1024;
    let inflight_bytes = 0;
    let audio_port = null, audio_reset_done = null, audio_enabled = false, audio_rate = 22050;
    let audio_sequence = 0;
    const audio_stats = { "pcm_buffers": 0, "pcm_samples": 0, "pump_requests": 0 };
    const audio_send = (type, value, transfer = []) => audio_port?.postMessage({ "cpu_audio": type, "epoch": epoch, "value": value, "sequence": audio_sequence }, transfer);
    const audio_reset = () => {
        if(!audio_port) return Promise.resolve();
        return new Promise(resolve => { ++audio_sequence; audio_reset_done = resolve; audio_send("reset", null); });
    };
    const send = (type, value = {}, transfer = []) =>
        globalThis.postMessage({ "type": type, "epoch": epoch, ...value }, transfer);
    const fatal = error => {
        if(emulator) emulator.stop();
        send("fatal", { "error": String(error?.stack || error) });
    };
    globalThis.addEventListener("unhandledrejection", e => { e.preventDefault(); fatal(e.reason); });
    const flush_screen = () => {
        screen_scheduled = false;
        if(screen_commands.length) send("screen", { "commands": screen_commands });
        screen_commands = [];
    };
    const screen_call = (name, args) => {
        // Font maps may alias guest memory; snapshot before the CPU continues.
        screen_commands.push([name, args.map(a => ArrayBuffer.isView(a) ? a.slice() : a)]);
        if(!screen_scheduled) { screen_scheduled = true; globalThis.queueMicrotask(flush_screen); }
    };
    const screen = {
        FLAG_BLINKING: 1, FLAG_FONT_PAGE_B: 2,
        pause() {}, continue() {}, destroy() {},
        set_mode: (...a) => screen_call("set_mode", a),
        set_size_text: (...a) => screen_call("set_size_text", a),
        set_size_graphical: (...a) => screen_call("set_size_graphical", a),
        put_char: (...a) => screen_call("put_char", a),
        clear_screen: (...a) => screen_call("clear_screen", a),
        clear_text_state: (...a) => screen_call("clear_text_state", a),
        update_cursor: (...a) => screen_call("update_cursor", a),
        update_cursor_scanline: (...a) => screen_call("update_cursor_scanline", a),
        set_font_bitmap: (...a) => screen_call("set_font_bitmap", a),
        set_font_page: (...a) => screen_call("set_font_page", a),
        update_buffer(layers) {
            for(const l of layers)
            {
                const w = l.buffer_width, h = l.buffer_height;
                if(!w || !h) continue;
                const pixels = new Uint8ClampedArray(w * h * 4);
                for(let y = 0; y < h; y++)
                {
                    const offset = ((l.buffer_y + y) * l.image_data.width + l.buffer_x) * 4;
                    pixels.set(l.image_data.data.subarray(offset, offset + w * 4), y * w * 4);
                }
                frame_layers.push({ "pixels": pixels, "width": w, "height": h, "x": l.screen_x, "y": l.screen_y });
            }
        },
    };
    const stats = () => {
        if(!emulator?.v86?.cpu) return;
        const cpu = emulator.v86.cpu;
        send("stats", { "value": { "instructions": emulator.get_instruction_counter(),
            "memory_size": cpu.memory_size[0], "cdrom": !!cpu.devices.cdrom,
            "cdrom_present": !!cpu.devices.cdrom?.has_disk(),
            "inflight_batches": inflight.size, "inflight_bytes": inflight_bytes } });
    };
    const graphics = event => {
        const bytes = event["bytes"].slice();
        const id = ++next_batch;
        inflight.set(id, { write: event["writeGuestMemory"], valid: event["isMemoryValid"], bytes: bytes.byteLength });
        inflight_bytes += bytes.byteLength;
        event["handled"] = true;
        const value = {};
        for(const key of ["frameId", "flags", "commandCount", "descAddr", "descLen", "batchAddr", "responseBase", "submitCount"])
            value[key] = event[key];
        value["bytes"] = bytes;
        send("graphics", { "id": id, "value": value }, [bytes.buffer]);
    };
    const setup_cpu = () => {
        const pci = emulator.v86.cpu.devices.v86gl_pci;
        if(pci)
        {
            pci.can_accept = () => inflight.size < MAX_BATCHES && inflight_bytes <= MAX_BYTES - pci.maxBatchBytes;
            pci.graphics_state_handlers = {
                save: () => checkpoint,
                restore: value => send("checkpoint", { "value": value }),
            };
        }
    };
    const change_epoch = async () => {
        ++epoch;
        inflight.clear();
        inflight_bytes = 0;
        screen_commands = [];
        send("epoch");
        await audio_reset();
    };
    const disk = name => {
        const d = emulator.v86.cpu.devices;
        switch(name)
        {
            case "hda": return d.ide.primary.master.buffer;
            case "hdb": return d.ide.primary.slave.buffer;
            case "fda": return d.fdc.drives[0].buffer;
            case "fdb": return d.fdc.drives[1].buffer;
            case "cdrom": return d.cdrom.buffer;
        }
        throw new Error("Unknown disk");
    };
    const methods = {
        "init": async options => {
            if(emulator) throw new Error("CPU Worker already initialized");
            options["screen_adapter"] = screen;
            // Fail a missing/invalid core explicitly. The legacy XHR loader can
            // otherwise leave startup pending indefinitely after a 404.
            options.wasm_fn = async env => {
                const primary = options.wasm_path;
                const fallback = options["wasm_fallback_path"] || wasm_fallback_path(primary);
                let last_error;
                for(const url of new Set([primary, fallback]))
                {
                    try
                    {
                        const response = await fetch(url);
                        if(!response.ok) throw new Error("CPU core fetch failed: HTTP " + response.status);
                        const bytes = await response.arrayBuffer();
                        const result = await WebAssembly.instantiate(bytes, env);
                        emulator.wasm_source = bytes;
                        return result.instance.exports;
                    }
                    catch(error) { last_error = error; }
                }
                throw last_error;
            };
            // No network or DOM adapters here. Those connect through the bus.
            options.modem = undefined;
            options["worker_bus_setup"] = instance => {
                emulator = instance;
                const original = instance.emulator_bus.send.bind(instance.emulator_bus);
                instance.emulator_bus.send = (name, value, transfer) => {
                    if(name === "v86gl-pci-frame") { if(options["graphics_available"]) graphics(value); return; }
                    if(name === "emulator-ready") { setup_cpu(); stats(); }
                    original(name, value, undefined);
                    if(name === "dac-send-data") { ++audio_stats["pcm_buffers"]; audio_stats["pcm_samples"] += value[0].length; }
                    if(name === "dac-tell-sampling-rate") audio_rate = value;
                    if(name === "dac-enable") audio_enabled = true;
                    if(name === "dac-disable") audio_enabled = false;
                    if(audio_port)
                    {
                        if(name === "dac-send-data")
                        {
                            audio_send("queue", value, value.map(channel => channel.buffer));
                            return;
                        }
                        if(name === "dac-tell-sampling-rate") { audio_send("rate", value); return; }
                        if(name === "dac-reset") { audio_send("reset", null); return; }
                        if(name === "emulator-started" || name === "emulator-stopped" || name === "dac-enable" || name === "dac-disable")
                            audio_send("enabled", audio_enabled && emulator.is_running());
                    }
                    if(name === "emulator-loaded") return;
                    if(name === "download-error") value = { "file_name": value.file_name };
                    // Structured clone snapshots buffers before synchronous guest
                    // execution resumes. PCM buffers are independently owned.
                    if(name === "dac-send-data")
                    {
                        const pcm = value.map(channel => channel.slice());
                        send("event", { "name": name, "value": pcm }, pcm.map(channel => channel.buffer));
                    }
                    else send("event", { "name": name, "value": value });
                };
            };
            await new Promise((resolve, reject) => {
                new V86(options);
                emulator.add_listener("emulator-loaded", resolve);
                emulator.add_listener("emulator-error", reject);
            });
            flush_screen();
            stats();
            timer = setInterval(stats, 250);
        },
        "audio-attach": async port => {
            audio_port = port;
            audio_port.onmessage = e => {
                const m = e.data;
                if(m["epoch"] !== epoch) return;
                if(m["cpu_audio"] === "reset-done" && m["sequence"] === audio_sequence && audio_reset_done)
                {
                    const done = audio_reset_done; audio_reset_done = null; done();
                }
                if(m["cpu_audio"] === "pump" && audio_enabled && emulator.is_running())
                {
                    ++audio_stats["pump_requests"];
                    emulator.bus.send("dac-request-data");
                }
            };
            await audio_reset();
            audio_send("rate", audio_rate);
            audio_send("enabled", audio_enabled && emulator.is_running());
        },
        "run": () => emulator.run(),
        "stop": async () => { await emulator.stop(); flush_screen(); stats(); },
        "barrier": () => inflight.size,
        "save": async value => {
            if(emulator.is_running() || inflight.size) throw new Error("Save requires a drained, stopped CPU");
            checkpoint = value;
            try { return await emulator.save_state(); }
            finally { checkpoint = null; }
        },
        "restore": async state => {
            if(emulator.is_running() || inflight.size) throw new Error("Restore requires a drained, stopped CPU");
            await change_epoch();
            await emulator.restore_state(state);
            await audio_reset();
            flush_screen(); stats();
        },
        "restart": async () => { await change_epoch(); await emulator.restart(); await audio_reset(); flush_screen(); stats(); },
        "destroy": async () => { clearInterval(timer); await emulator.destroy(); audio_port?.close(); },
        "read_memory": (offset, length) => emulator.read_memory(offset, length).slice(),
        "write_memory": (bytes, offset) => emulator.write_memory(bytes, offset),
        "memory_dump": () => emulator.v86.cpu.mem8.slice(),
        "disk": name => new Promise(resolve => disk(name).get_buffer(bytes => resolve(bytes?.slice(0)))),
        "set_fda": file => emulator.set_fda(file), "set_fdb": file => emulator.set_fdb(file),
        "set_cdrom": file => emulator.set_cdrom(file),
        "eject_fda": () => emulator.eject_fda(), "eject_fdb": () => emulator.eject_fdb(),
        "eject_cdrom": () => emulator.eject_cdrom(),
        "get_disk_fda": () => emulator.get_disk_fda()?.slice() || null, "get_disk_fdb": () => emulator.get_disk_fdb()?.slice() || null,
        "create_file": (name, bytes) => emulator.create_file(name, bytes),
        "read_file": async name => (await emulator.read_file(name))?.slice(),
        "audio-info": () => ({ ...audio_stats, "direct": !!audio_port, "sample_rate": audio_rate }),
        "get_instruction_stats": () => emulator.get_instruction_stats(),
        "get_ir_dumps": clear => emulator.get_ir_dumps(clear),
        "get_jit_info": () => emulator.get_jit_info(),
        "configure_ir_diagnostics": period => emulator.configure_ir_diagnostics(period),
        "record-start": metadata => {
            if(recorder?.active) throw new Error("Already recording");
            for(const key of Object.keys(audio_stats)) audio_stats[key] = 0;
            recorder = new PerformanceRecorder(emulator, { metadata,
                on_stop: report => {
                    report["worker_audio"] = { ...audio_stats, "direct": !!audio_port, "sample_rate": audio_rate };
                    send("recording", { "value": report });
                } });
            recorder.start();
        },
        "record-stop": () => recorder?.stop(),
    };
    globalThis.onmessage = e => {
        const m = e.data;
        if(m["type"] === "rpc")
        {
            const work = command_chain.then(async () => {
                const fn = methods[m["method"]];
                if(!fn || !Object.prototype.hasOwnProperty.call(methods, m["method"])) throw new Error("Unknown worker method");
                return fn(...m["args"]);
            });
            command_chain = work.then(value => {
                const transfer = value instanceof ArrayBuffer ? [value] :
                    ArrayBuffer.isView(value) ? [value.buffer] : [];
                send("result", { "id": m["id"], "value": value }, transfer);
            }, error => send("result", { "id": m["id"], "error": String(error?.stack || error) }));
            return;
        }
        if(m["epoch"] !== epoch || !emulator?.v86) return;
        try
        {
            switch(m["type"])
            {
                case "event":
                    if(m["name"] !== "dac-request-data" || !audio_port) emulator.bus.send(m["name"], m["value"]);
                    break;
                case "frame":
                    frame_layers = [];
                    emulator.v86.cpu.devices.vga?.screen_fill_buffer();
                    send("frame", { "layers": frame_layers }, frame_layers.map(l => l["pixels"].buffer));
                    frame_layers = [];
                    break;
                case "gpu-write": {
                    const b = inflight.get(m["id"]);
                    if(b?.valid()) b.write(m["offset"], m["bytes"]);
                    break;
                }
                case "gpu-done": {
                    const b = inflight.get(m["id"]);
                    if(!b) break;
                    inflight_bytes -= b.bytes;
                    inflight.delete(m["id"]);
                    emulator.v86.cpu.devices.v86gl_pci?.notify(0);
                    break;
                }
            }
        }
        catch(error) { fatal(error); }
    };
}
