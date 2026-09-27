// A conditional owner must retain both already-admitted successors. Compare
// exact guest work against conservative admission, including stale second hints.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const vm = new V86({ wasm_path: wasm, jit_backend: "ir", memory_size: 32 << 20,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "none" }, autostart: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const iterations = 512, initial_count = 0xFFFFFFF0;
const little = (value, size) => Array.from({ length: size }, (_, i) => value >>> (8 * i) & 255);

try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // These cases exercise the strict (byte-validating) admission contract and
    // its slow-path machinery; notified_validation.mjs covers the default.
    assert.equal(e.ir_cache_set_strict_validation(1), 1);
    const memory = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    const words = () => new Uint32Array(e.memory.buffer);
    const write32 = (address, value) => memory().setUint32(address, value, true);
    vm.run();
    const deadline = performance.now() + 10000;
    while(memory().getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout");
        await sleep(1);
    }
    await vm.stop();
    let compared = 0, total_handoffs = 0;
    for(const mode of [0, 1]) for(const kind of ["ordinary", "raw_code", "notified_code",
        "mapping", "reset", "replacement", "diagnostics", "recording", "full_validation"]) {
        const cs = mode ? 0 : 0x10000;
        const pages = [0x8000, 0xA000, 0xB000, 0xC000].map(pc => pc + cs);
        const alternate = 0x180000;
        const displacement_size = mode ? 4 : 2;
        const branch = (opcode, from, to) => [
            ...opcode, ...little(to - from - opcode.length - displacement_size, displacement_size),
        ];
        const observer = ["raw_code", "notified_code", "mapping", "reset"].includes(kind);
        const select = [0xF6, 0xC3, 1]; // TEST BL,1.
        select.push(...branch([0x0F, 0x84], pages[0] + select.length, pages[1]));
        select.push(...branch([0xE9], pages[0] + select.length, pages[2]));
        const left = [0x46, ...(observer ? [0xE4, 0x93] : []), 0x43];
        left.push(...branch([0xE9], pages[1] + left.length, pages[3]));
        // Mutation sites straddle vector/word boundaries so actual Wasm source
        // validation exercises the chunked comparator beyond its first word.
        const padding = kind === "raw_code" ? 17 : kind === "notified_code" ? 31 : kind === "mapping" ? 39 : 0;
        const right = [...Array(padding).fill(0x90), 0x47, 0x43,
            ...branch([0xE9], pages[2] + padding + 2, pages[3])];
        const latch = [0x49, ...branch([0x0F, 0x85], pages[3] + 1, pages[0]), 0xF4];
        const chunks = [select, left, right, latch];
        const states = [];
        for(const enabled of [0, 1]) {
            assert.equal(await vm.configure_ir_diagnostics(kind === "diagnostics" ? 1 : 0), true);
            assert.equal(e.ir_auto_config(0, 2, 4, 192, 256, 64), 1);
            cpu.jit_clear_cache(); e.ir_cache_collect();
            assert.equal(e.ir_cache_set_fusion(0), 1);
            assert.equal(e.ir_cache_set_fast_validation(kind === "full_validation" ? 0 : 1), 1);
            assert.equal(e.ir_cache_set_warm_chaining(enabled), 1);
            e.performance_recording_enable(kind === "recording" ? 1 : 0);
            const prepare = () => {
                cpu.in_hlt[0] = 0; cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
                cpu.is_32[0] = mode; cpu.stack_size_32[0] = 1;
                cpu.segment_offsets.fill(0, 0, 6); cpu.segment_offsets[1] = cs;
                cpu.segment_is_null.fill(0, 0, 6);
                cpu.reg32.set([0, iterations, 0, 0, 0x90000, 0, 0, 0]);
                cpu.instruction_pointer[0] = pages[0]; cpu.reg_xmm32s.fill(0);
                words()[664 >> 2] = initial_count;
                e.update_state_flags();
            };
            prepare();
            cpu.cr[0] = 0x80010011 | 0; cpu.cr[3] = 0x12000; cpu.cr[4] = 512;
            write32(0x12000, 0x13003);
            for(let page = 0; page < 1024; page++) write32(0x13000 + page * 4, page * 4096 | 3);
            e.full_clear_tlb();
            for(let i = 0; i < pages.length; i++) vm.write_memory(Uint8Array.from(chunks[i]), pages[i]);
            vm.write_memory(Uint8Array.from([...right.slice(0, padding), 0x4F, ...right.slice(padding + 1)]), alternate);
            for(let i = 0; i < pages.length; i++) {
                cpu.instruction_pointer[0] = pages[i];
                assert(await cpu.ir_compile_cached(chunks[i].length, 2, 1, 1, 256, 64));
            }
            let calls = 0, mutations = 0;
            cpu.io.register_read(0x93, null, () => {
                calls++;
                if(cpu.reg32[3] === 32) {
                    mutations++;
                    // Root's most recent target is LEFT; RIGHT is the second
                    // hint. Raw writes must revoke its admission certificate.
                    if(kind === "raw_code") cpu.mem8[pages[2] + padding] = 0x4F;
                    if(kind === "notified_code") vm.write_memory(Uint8Array.of(0x4F), pages[2] + padding);
                    if(kind === "mapping") {
                        write32(0x13000 + (pages[2] >>> 12) * 4, alternate | 3);
                        e.full_clear_tlb();
                    }
                    if(kind === "reset") cpu.jit_clear_cache();
                }
                return 0x7A;
            });
            const run = () => {
                const end = performance.now() + 10000;
                while(!cpu.in_hlt[0]) {
                    assert(performance.now() < end, `${kind}/${mode}: guest progress`);
                    e.main_loop();
                }
                assert.equal(vm.get_instruction_counter() >>> 0,
                    (initial_count + iterations * ((observer ? 8 : 7.5) + padding / 2) + 1) >>> 0,
                    `${kind}/${mode}: exact wrapped retirement`);
                assert.equal(cpu.reg32[3], iterations);
                assert.equal(cpu.reg32[6], iterations / 2);
                assert.equal(cpu.reg32[1], 0);
                assert.equal(cpu.instruction_pointer[0], pages[3] + latch.length);
            };
            prepare(); e.full_clear_tlb();
            const before_handoffs = e.ir_cache_stat(35), before_activations = e.ir_cache_stat(2);
            run();
            const handoffs = (e.ir_cache_stat(35) - before_handoffs) >>> 0;
            const activations = (e.ir_cache_stat(2) - before_activations) >>> 0;
            if(!enabled || ["diagnostics", "recording", "full_validation"].includes(kind)) {
                assert.equal(handoffs, 0, `${kind}/${mode}: conservative admission`);
            } else if(!observer) {
                assert.equal(activations, iterations * 3);
                assert(handoffs > iterations * 2.85,
                    `${kind}/${mode}: both alternating targets must hand off; ${handoffs}/${activations}`);
                total_handoffs += handoffs;
            }
            const signed_result = ["raw_code", "notified_code", "mapping"].includes(kind)
                ? 32 - iterations / 2 : iterations / 2;
            assert.equal(cpu.reg32[7], mode ? signed_result : signed_result & 65535);
            assert.equal(calls, observer ? iterations / 2 : 0);
            assert.equal(mutations, observer ? 1 : 0);
            if(kind === "replacement") {
                // Populate both hints, replace RIGHT, then compact record indices.
                // A saved slot/index can never certify its old publication owner.
                prepare();
                vm.write_memory(Uint8Array.of(0x4F), pages[2]);
                cpu.instruction_pointer[0] = pages[2];
                assert(await cpu.ir_compile_cached(right.length, 2, 1, 1, 256, 64));
                e.ir_cache_collect();
                prepare(); run();
                assert.equal(cpu.reg32[7], mode ? -iterations / 2 : -iterations / 2 & 65535);
            }
            states.push({ gpr: Array.from(cpu.reg32), flags: e.get_eflags(),
                ip: cpu.instruction_pointer[0], previous: words()[560 >> 2],
                count: vm.get_instruction_counter() >>> 0, xmm: Array.from(cpu.reg_xmm32s) });
            e.performance_recording_enable(0);
        }
        assert.deepEqual(states[1], states[0], `${kind}/${mode}: paired architectural state`);
        compared++;
    }
    console.log(`PASS: ${wasm}: ${compared} paired polymorphic-chain cases, ${total_handoffs} handoffs; 16/32-bit, nonzero CS, raw/notified SMC, remap, reset, second-owner replacement and instrumentation fallback`);
} finally { await vm.destroy(); }
