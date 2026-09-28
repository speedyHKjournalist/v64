// A vCPU worker (docs/acpi-x86-64-multicore-plan.zh-CN.md, W1): one
// application processor of a machine whose bootstrap processor and devices
// run on another thread (src/parallel/machine.js).
//
// The worker relocates its own instance of v86-parallel.wasm into the shared
// memory and attaches it to the machine (crate::parallel): guest RAM, the
// local APICs and the IOAPIC are the machine's; the CPU state, TLB, JIT and
// Rust heap are this instance's. Port and device MMIO accesses go to the
// machine through the control block; the worker blocks meanwhile. Its loop
// never returns to the event loop: generated code is compiled synchronously
// and all coordination goes through shared memory.

import { CPU } from "../cpu.js";
import { MachineClock } from "../machine_clock.js";
import { WASM_TABLE_OFFSET, WASM_TABLE_SIZE } from "../const.js";
import { view } from "../lib.js";
import { CORE_STATE_RANGES, STATE_OFFSETS } from "../state_layout.js";
import { relocate } from "./relocate.js";
import * as C from "./control.js";

const CORE_EVENT_INIT = 1;
const CORE_EVENT_SIPI = 2;
const INIT_PRESERVED = [[STATE_OFFSETS.x64_pat, 8],
    [STATE_OFFSETS.x64_mtrr_def_type, STATE_OFFSETS.x64_mc_banks + 128 - STATE_OFFSETS.x64_mtrr_def_type]];

/**
 * @param {Object} init from ParallelMachine.start
 * @param {function(Object)} post message to the machine
 */
export async function run_vcpu(init, post)
{
    const core = init.core;
    const memory = init.memory;
    const ctrl = new Int32Array(init.control);
    const clock_offset = new Float64Array(init.control, C.CONTROL_WORDS * 4, 1);
    const word = w => C.core_word(core, w);
    const table = new WebAssembly.Table({ "element": "anyfunc", "initial": WASM_TABLE_SIZE + WASM_TABLE_OFFSET });

    let cpu = null, exports = null;
    const host_now = () => performance.timeOrigin + performance.now();
    const now = () => host_now() - clock_offset[0];

    // a request the machine performs on the devices' thread
    function request(op, addr, v0 = 0, v1 = 0, v2 = 0, v3 = 0)
    {
        ctrl[word(C.IO_OP)] = op;
        ctrl[word(C.IO_ADDR)] = addr;
        ctrl[word(C.IO_V0)] = v0;
        ctrl[word(C.IO_V1)] = v1;
        ctrl[word(C.IO_V2)] = v2;
        ctrl[word(C.IO_V3)] = v3;
        Atomics.store(ctrl, word(C.IO_STATE), C.IO_REQUEST);
        Atomics.add(ctrl, C.DOORBELL, 1);
        Atomics.notify(ctrl, C.DOORBELL);
        // the machine's core leaves its slice to serve it
        exports["parallel_kick"](0);
        while(Atomics.load(ctrl, word(C.IO_STATE)) === C.IO_REQUEST)
        {
            Atomics.wait(ctrl, word(C.IO_STATE), C.IO_REQUEST, 1000);
            if(Atomics.load(ctrl, C.SHUTDOWN)) throw new Error("machine shut down during I/O");
        }
        const result = ctrl[word(C.IO_RESULT)];
        Atomics.store(ctrl, word(C.IO_STATE), C.IO_IDLE);
        return result;
    }

    const env = {
        "memory": memory,
        "__indirect_function_table": table,
        "cpu_exception_hook": () => false,
        "run_hardware_timers": (acpi_enabled, t) => acpi_enabled ? exports["apic_timer"](t) : 100,
        "cpu_event_halt": () => {},
        "abort": () => { throw new Error("abort from vCPU " + core); },
        "microtick": () => cpu ? cpu.clock.now() : now(),
        "get_rand_int": () => Math.random() * 0x100000000 | 0,
        "stop_idling": () => {},
        "x64_native_publish": (token, pointer, length) => cpu.publish_wide_native(token, pointer, length),
        "x64_native_execute": (token, budget) => cpu.wide_native_functions.get(token)?.(budget) || 0,
        "x64_native_discard": () => cpu.wide_native_functions.clear(),
        "x64_page_publish": (id, slot, pointer, length) => cpu.x64_page_publish(id, slot, pointer, length),
        "io_port_read8": port => request(C.OP_IN8, port),
        "io_port_read16": port => request(C.OP_IN16, port),
        "io_port_read32": port => request(C.OP_IN32, port),
        "io_port_write8": (port, value) => { request(C.OP_OUT8, port, value); },
        "io_port_write16": (port, value) => { request(C.OP_OUT16, port, value); },
        "io_port_write32": (port, value) => { request(C.OP_OUT32, port, value); },
        "mmap_read8": addr => request(C.OP_MMIO_READ8, addr),
        "mmap_read32": addr => request(C.OP_MMIO_READ32, addr),
        "mmap_write8": (addr, value) => { request(C.OP_MMIO_WRITE8, addr, value); },
        "mmap_write16": (addr, value) => { request(C.OP_MMIO_WRITE16, addr, value); },
        "mmap_write32": (addr, value) => { request(C.OP_MMIO_WRITE32, addr, value); },
        "mmap_write64": (addr, v0, v1) => { request(C.OP_MMIO_WRITE64, addr, v0, v1); },
        "mmap_write128": (addr, v0, v1, v2, v3) => { request(C.OP_MMIO_WRITE128, addr, v0, v1, v2, v3); },
        "log_from_wasm": (offset, length) => {
            const bytes = new Uint8Array(memory.buffer, offset, length).slice();
            if(init.log) console.log("[vCPU " + core + "] " + new TextDecoder().decode(bytes));
        },
        "console_log_from_wasm": (offset, length) => {
            const bytes = new Uint8Array(memory.buffer, offset, length).slice();
            console.error("[vCPU " + core + "] " + new TextDecoder().decode(bytes));
        },
        "dbg_trace_from_wasm": () => {},
        "ir_codegen_finalize": (id, slot, pointer, length) => { cpu.ir_auto_publish(id, slot, pointer, length); },
        "jit_clear_func": index => cpu.jit_clear_func(index),
        "parallel_notify": address => { Atomics.notify(new Int32Array(memory.buffer), address >>> 2); },
    };

    const module = await WebAssembly.compile(relocate(new Uint8Array(init.bytes), init.base));
    const instance = await WebAssembly.instantiate(module, { "env": env });
    exports = instance.exports;
    exports["rust_init"]();
    exports["parallel_attach"](init.base, core);

    const bus = { send() {}, register() {}, pair: null };
    cpu = new CPU(bus, { exports, wasm_table: table }, () => {});
    cpu.clock = new MachineClock({ now });
    const settings = init.settings;
    cpu.configure_jit_backend(settings);
    // no event loop in this worker: install generated code synchronously
    cpu.ir_sync_publication = true;
    cpu.publish_wide_native = function(token, pointer, length)
    {
        const bytes = new Uint8Array(memory.buffer, pointer, length).slice();
        try
        {
            const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes),
                { "e": { "m": memory, "x64_native_guard": exports["x64_native_guard"] } });
            if(exports["x64_native_ready"](token, true)) this.wide_native_functions.set(token, instance.exports["f"]);
        }
        catch(e)
        {
            exports["x64_native_ready"](token, false);
        }
    };
    exports["set_x64_test_capabilities"](!!settings.experimental_x64);
    exports["set_x87_fast_math"]?.(settings["x87_fast_math"] !== false);
    exports["set_x87_jit_cache"]?.(settings["x87_jit_cache"] !== false);
    if(settings.cpuid_level) cpu.set_cpuid_level(settings.cpuid_level);
    cpu.mem8 = view(Uint8Array, memory, init.mem8, init.memory_size);
    cpu.mem32s = view(Uint32Array, memory, init.mem8, init.memory_size >> 2);
    exports["parallel_set_active"](true);
    exports["parallel_idle"](true);
    cpu.reset_cpu();
    exports["context_reset"](core);
    const reset_state = cpu.save_core_state();
    let running = false;

    ctrl[word(C.STATE_BASE)] = cpu.state_base;
    Atomics.store(ctrl, word(C.STATUS), C.STATUS_WAIT_SIPI);
    post({ "type": "ready", "core": core, "state_base": cpu.state_base });

    // INIT and start-up IPIs for this core (CPU.prototype.take_core_events)
    function take_core_events()
    {
        const events = exports["apic_take_core_events"](core);
        if(!events) return;
        if(events & CORE_EVENT_INIT)
        {
            if(exports["exception_shutdown"](core) === 2) return;
            exports["apic_init_core"](core);
            exports["context_reset"](core);
            const next = reset_state.map(bytes => bytes.slice());
            const current = cpu.save_core_state();
            for(const [offset, size] of INIT_PRESERVED)
            {
                const index = CORE_STATE_RANGES.findIndex(([start, end]) => offset >= start && offset + size <= end);
                const at = offset - CORE_STATE_RANGES[index][0];
                next[index].set(current[index].subarray(at, at + size), at);
            }
            cpu.load_core_state(next);
            running = false;
        }
        if((events & CORE_EVENT_SIPI) && !running)
        {
            const vector = events >> 8 & 0xFF;
            cpu.sreg[1] = vector << 8;
            cpu.segment_offsets[1] = vector << 12;
            cpu.instruction_pointer[0] = vector << 12;
            cpu.previous_ip[0] = vector << 12;
            cpu.update_state_flags();
            running = true;
        }
        Atomics.store(ctrl, word(C.RUNNING), running ? 1 : 0);
    }

    // a safe point: the machine stops every core for a snapshot, reset or pause
    function park(epoch)
    {
        exports["fpu_cache_barrier"]();
        ctrl[word(C.TSC_OFFSET_LO)] = exports["parallel_tsc_offset"](false);
        ctrl[word(C.TSC_OFFSET_HI)] = exports["parallel_tsc_offset"](true);
        Atomics.store(ctrl, word(C.RUNNING), running ? 1 : 0);
        Atomics.store(ctrl, word(C.STATUS), C.STATUS_PARKED);
        exports["parallel_idle"](true);
        Atomics.store(ctrl, word(C.ACK), epoch);
        Atomics.add(ctrl, C.DOORBELL, 1);
        Atomics.notify(ctrl, C.DOORBELL);
        for(;;)
        {
            const resumed = Atomics.load(ctrl, C.RESUME);
            if(resumed >= epoch || Atomics.load(ctrl, C.SHUTDOWN)) break;
            Atomics.wait(ctrl, C.RESUME, resumed, 1000);
        }
        if(Atomics.load(ctrl, C.SHUTDOWN)) return;
        const command = Atomics.load(ctrl, C.COMMAND);
        if(command === C.COMMAND_RESET)
        {
            // machine reset or power-on: back to waiting for INIT/SIPI
            exports["jit_clear_cache_js"]();
            cpu.reset_cpu();
            exports["context_reset"](core);
            cpu.load_core_state(reset_state.map(bytes => bytes.slice()));
            running = false;
        }
        else if(command === C.COMMAND_RELOAD)
        {
            // the machine replaced this core's state and RAM (snapshot restore)
            exports["jit_clear_cache_js"]();
            exports["context_reset"](core);
            exports["parallel_set_tsc_offset"](ctrl[word(C.TSC_OFFSET_LO)], ctrl[word(C.TSC_OFFSET_HI)]);
            exports["fpu_discard_cache"]();
            cpu.full_clear_tlb();
            cpu.update_state_flags();
            running = Atomics.load(ctrl, word(C.RUNNING)) !== 0;
        }
        else if(command === C.COMMAND_FLUSH)
        {
            exports["context_reset_translations"]?.(core);
            cpu.full_clear_tlb();
        }
        exports["parallel_sync"]();
        exports["parallel_idle"](false);
        Atomics.store(ctrl, word(C.RUNNING), running ? 1 : 0);
        Atomics.store(ctrl, word(C.STATUS), running ? C.STATUS_RUNNING : C.STATUS_WAIT_SIPI);
    }

    const wake = new Int32Array(memory.buffer);
    const wake_index = exports["parallel_wake_addr"](core) >>> 2;
    const quantum = settings.cpu_quantum || 20000;
    let acked = Atomics.load(ctrl, C.STOP);
    let steps = 0;
    let jit_entries = 0, last_entries = 0;

    for(;;)
    {
        if(Atomics.load(ctrl, C.SHUTDOWN)) break;
        const stop = Atomics.load(ctrl, C.STOP);
        if(stop !== acked)
        {
            park(stop);
            acked = stop;
            continue;
        }
        const seen = Atomics.load(wake, wake_index);
        take_core_events();
        if(!running)
        {
            Atomics.store(ctrl, word(C.STATUS), C.STATUS_WAIT_SIPI);
            exports["parallel_idle"](true);
            Atomics.wait(wake, wake_index, seen, 100);
            exports["parallel_idle"](false);
            continue;
        }
        // compiled code: other cores' publications and code writes
        exports["parallel_poll"]();
        const now = cpu.clock.now();
        // this core's compile budget (as the machine's loop does for its core)
        exports["begin_cpu_frame"](now);
        const next_timer = exports["apic_timer"](now);
        const retired = cpu.run_cpu_slice(quantum);
        steps = steps + retired | 0;
        ctrl[word(C.STEPS)] = steps;
        ctrl[word(C.SLICES)]++;
        // (cumulative: a reset or restore clears the caches' own counters)
        const entries = exports["ir_t0_entries"]() + exports["ir_cache_stat"](2) >>> 0;
        jit_entries += entries >= last_entries ? entries - last_entries : entries;
        last_entries = entries;
        ctrl[word(C.JIT_ENTRIES)] = jit_entries;
        ctrl[word(C.UNPUBLISHED)] = exports["parallel_code_stat"](0);
        if(cpu.in_hlt[0])
        {
            exports["handle_irqs"]();
            if(cpu.in_hlt[0] && !exports["apic_peek_core_events"](core))
            {
                Atomics.store(ctrl, word(C.STATUS), C.STATUS_HALTED);
                ctrl[word(C.WAITS)]++;
                exports["parallel_idle"](true);
                Atomics.wait(wake, wake_index, seen, Math.max(0, Math.min(next_timer, 50)));
                exports["parallel_idle"](false);
            }
        }
        Atomics.store(ctrl, word(C.STATUS), C.STATUS_RUNNING);
    }
    Atomics.store(ctrl, word(C.STATUS), C.STATUS_EXITED);
    post({ "type": "exited", "core": core });
}

/** Worker entry: the first message starts the core */
export function start_vcpu_worker()
{
    const node = typeof process !== "undefined" && process.versions && process.versions.node;
    const start = async (init, post) => {
        try
        {
            await run_vcpu(init, post);
        }
        catch(error)
        {
            const ctrl = new Int32Array(init.control);
            Atomics.store(ctrl, C.core_word(init.core, C.ERROR), 1);
            Atomics.store(ctrl, C.core_word(init.core, C.STATUS), C.STATUS_FAILED);
            Atomics.add(ctrl, C.DOORBELL, 1);
            Atomics.notify(ctrl, C.DOORBELL);
            post({ "type": "error", "core": init.core, "message": String(error && error.stack || error) });
        }
    };
    if(node)
    {
        import("node:worker_threads").then(({ parentPort }) => {
            parentPort.once("message", init => start(init, message => parentPort.postMessage(message)));
        });
    }
    else
    {
        globalThis.onmessage = e => { globalThis.onmessage = null; start(e.data, message => globalThis.postMessage(message)); };
    }
}
