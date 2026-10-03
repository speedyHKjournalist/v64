// Compare warm successor handoff against full admission with exact fixed work.
// All physical/source/owner mutations are deliberate, never performance shortcuts.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, jit_backend: "ir", memory_size: 32 << 20,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "none" }, autostart: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24];
const PC = 0x100000, pages = [PC, PC + 0x9000, PC + 0x3000, PC + 0xC000];
const alternate = PC + 0x15000, iterations = 512, initial_count = 0xFFFFFFF0;
const jump = (from, to) => [0xE9, ...u32(to - from - 5)];
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // These cases exercise the strict (byte-validating) admission contract and
    // its slow-path machinery; notified_validation.mjs covers the default.
    assert.equal(e.ir_cache_set_strict_validation(1), 1);
    const words = () => new Uint32Array(e.memory.buffer);
    const memory = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    const count = () => vm.get_instruction_counter() >>> 0;
    const write32 = (address, value) => memory().setUint32(address, value, true);
    vm.run(); const deadline = performance.now() + 10000;
    while(memory().getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout"); await sleep(1);
    }
    await vm.stop();
    assert.equal(e.ir_cache_set_warm_chaining(2), 0, "reject invalid policy");
    const reset_registers = () => {
        cpu.in_hlt[0] = 0; cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
        cpu.is_32[0] = cpu.stack_size_32[0] = 1;
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
        cpu.reg32.set([0, iterations, 0, 0, 0x90000, 0, 0, 0]);
        cpu.instruction_pointer[0] = PC; cpu.reg_xmm32s.fill(0);
        words()[664 >> 2] = initial_count; e.update_state_flags();
    };
    const run = () => {
        const end = performance.now() + 10000;
        while(!cpu.in_hlt[0]) { assert(performance.now() < end, "guest progress"); e.main_loop(); }
    };
    const snapshot = () => ({
        gpr: Array.from(cpu.reg32, x => x >>> 0), flags: e.get_eflags() >>> 0,
        ip: cpu.instruction_pointer[0] >>> 0, previous: words()[560 >> 2],
        count: count(), xmm: Array.from(cpu.reg_xmm32s),
        guard: memory().getUint32(0x160000, true),
    });
    let compared = 0, observed_handoffs = 0;
    for(const kind of ["ordinary", "observer_epoch", "guest_smc", "raw_code", "notified_code", "mapping", "reset", "xmm",
        "recording", "diagnostics", "full_validation", "between_batches", "replacement"]) {
        const states = [];
        for(const enabled of [0, 1]) {
            assert.equal(await vm.configure_ir_diagnostics(kind === "diagnostics" ? 1 : 0), true);
            assert.equal(e.ir_auto_config(0, 2, 4, 192, 256, 64), 1);
            cpu.jit_clear_cache(); e.ir_cache_collect();
            assert.equal(e.ir_cache_set_fusion(0), 1);
            assert.equal(e.ir_cache_set_fast_validation(kind === "full_validation" ? 0 : 1), 1);
            assert.equal(e.ir_cache_set_warm_chaining(enabled), 1);
            e.performance_recording_enable(kind === "recording" ? 1 : 0);
            reset_registers();
            cpu.cr[0] = 0x80010011 | 0; cpu.cr[3] = 0x12000; cpu.cr[4] = 512;
            write32(0x12000, 0x13003);
            for(let page = 0; page < 1024; page++) write32(0x13000 + page * 4, page * 4096 | 3);
            write32(0x160000, 0x12345678); e.full_clear_tlb(); e.update_state_flags();
            const observer = ["observer_epoch", "raw_code", "notified_code", "mapping", "reset", "xmm"].includes(kind);
            const chunks = [
                [0x43, ...jump(pages[0] + 1, pages[1])],
                kind === "guest_smc"
                    ? [0x45, 0x83, 0xFB, 32, 0x75, 7, 0xC6, 0x05, ...u32(pages[2]), 0x4F,
                        ...jump(pages[1] + 13, pages[2])]
                    : [0x45, ...(observer ? [0xE4, 0x93] : []), ...jump(pages[1] + (observer ? 3 : 1), pages[2])],
                [0x47, ...jump(pages[2] + 1, pages[3])],
                [0x49, 0x0F, 0x85, ...u32(PC - (pages[3] + 7)), 0xF4],
            ];
            for(let i = 0; i < pages.length; i++) vm.write_memory(Uint8Array.from(chunks[i]), pages[i]);
            // An alternate physical page keeps the virtual branch displacement.
            vm.write_memory(Uint8Array.from([0x4F, ...chunks[2].slice(1)]), alternate);
            for(let i = 0; i < pages.length; i++) {
                cpu.instruction_pointer[0] = pages[i];
                assert(await cpu.ir_compile_cached(chunks[i].length, 2, 1, 1, 256, 64));
            }
            const run_count = (observer ? 9 : kind === "guest_smc" ? 10 : 8) * iterations + 1
                + (kind === "guest_smc" ? 1 : 0);
            let calls = 0, mutations = 0;
            cpu.io.register_read(0x93, null, () => {
                calls++;
                // Quiescence is part of the public policy contract even when a
                // fast handoff, rather than a full admission, entered this owner.
                assert.equal(e.ir_cache_set_warm_chaining(enabled), kind === "reset" && calls > 32 ? 1 : 0, `${kind}/${calls}: active owner rejects policy changes`);
                if(cpu.reg32[3] === 32) {
                    mutations++;
                    if(kind === "raw_code") cpu.mem8[pages[2]] = 0x4F;
                    if(kind === "notified_code") vm.write_memory(Uint8Array.of(0x4F), pages[2]);
                    if(kind === "mapping") {
                        write32(0x13000 + (pages[2] >>> 12) * 4, alternate | 3); e.full_clear_tlb();
                    }
                    if(kind === "reset") cpu.jit_clear_cache();
                    if(kind === "xmm") cpu.reg_xmm32s[0] = 0x13579BDF;
                }
                return 0x7A;
            });
            reset_registers(); e.full_clear_tlb();
            const before_handoffs = e.ir_cache_stat(35);
            const before_full_checks = e.ir_cache_stat(19);
            run();
            const handoffs = (e.ir_cache_stat(35) - before_handoffs) >>> 0;
            const full_checks = (e.ir_cache_stat(19) - before_full_checks) >>> 0;
            if(!enabled || ["recording", "diagnostics", "full_validation"].includes(kind)) {
                assert.equal(handoffs, 0, `${kind}: conservative path selected`);
            } else if(!observer) {
                assert(handoffs > (kind === "guest_smc" ? 0 : 100), `${kind}: actually exercise warm handoff`);
                observed_handoffs += handoffs;
            } else if(kind === "observer_epoch") {
                // Every port callback invalidates the other three owners' byte
                // certificates. They must be fully revalidated, but may still
                // hand off directly once all their existing TLB mappings match.
                // Epoch-only handoff managed fewer than one edge per iteration.
                assert(handoffs > iterations * 3.5,
                    `${kind}: refreshed successor certificates hand off; ${handoffs}`);
                assert(full_checks >= iterations * 3 - 3,
                    `${kind}: observer-invalidated successors still compare their complete sources; ${full_checks}`);
                observed_handoffs += handoffs;
            }
            assert.equal(count(), (initial_count + run_count) >>> 0, `${kind}: wrapped retirement`);
            assert.equal(cpu.reg32[3], iterations); assert.equal(cpu.reg32[5], iterations);
            assert.equal(cpu.reg32[7], ["guest_smc", "raw_code", "notified_code", "mapping"].includes(kind) ? 62 - iterations : iterations);
            assert.equal(cpu.reg32[1], 0); assert.equal(cpu.instruction_pointer[0], pages[3] + 8);
            assert.equal(calls, observer ? iterations : 0); assert.equal(mutations, observer ? 1 : 0);
            if(kind === "xmm") assert.equal(cpu.reg_xmm32s[0], 0x13579BDF);
            if(kind === "diagnostics") {
                const d = vm.get_jit_info().ir.diagnostics;
                assert.equal(Object.values(d.exits).reduce((n, x) => n + x.count, 0), d.totals.ir_activations);
                assert.equal(d.totals.ir_steps + d.totals.interpreter_steps, run_count);
                assert.equal(d.totals.instrumentation_errors, 0);
            }
            if(["between_batches", "replacement"].includes(kind)) {
                // Old successor/owner hints must not authorize stale code in a
                // later CPU batch or after table-slot replacement/compaction.
                reset_registers(); cpu.mem8[pages[2]] = 0x4F;
                if(kind === "replacement") {
                    cpu.instruction_pointer[0] = pages[2];
                    assert(await cpu.ir_compile_cached(chunks[2].length, 2, 1, 1, 256, 64));
                    cpu.instruction_pointer[0] = PC;
                }
                run();
                assert.equal(cpu.reg32[7], -iterations, `${kind}: new code, not stale target`);
                assert.equal(count(), (initial_count + run_count) >>> 0);
            }
            states.push(snapshot());
            assert.equal(e.ir_cache_stat(36), enabled, "active callback could not change policy");
            e.performance_recording_enable(0);
        }
        assert.deepEqual(states[1], states[0], `${kind}: fast handoff equals conservative admission`);
        compared++;
    }
    assert(observed_handoffs > 0);
    console.log(`PASS: ${wasm}: ${compared} paired warm-chain scenarios, ${observed_handoffs} handoffs; exact wrapped retirement, raw/notified SMC, remapping, reset, XMM, held owner, replacement, host batches and instrumentation fallback`);
} finally { await vm.destroy(); }
