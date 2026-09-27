// Default (notified) code-validity contract, identical to the legacy JIT:
// published owners are retired by the guest-store slow path and by host writes
// through write_blob/jit_dirty_cache; admission then needs only generation and
// TLB mapping identity (the direct-mapped fast table). Strict mode additionally
// detects raw unnotified host writes by comparing every source byte.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const vm = new V86({ wasm_path: wasm, jit_backend: "ir", memory_size: 32 << 20,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "none" }, autostart: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, PC = 0x8000, N = 4000, initial = 0xFFFFFFF0;
    assert.equal(e.ir_cache_stat(48), 0, "notified validation is the default contract");
    const count = () => vm.get_instruction_counter() >>> 0;
    vm.run(); const deadline = performance.now() + 10000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline); await sleep(1);
    }
    await vm.stop();
    const prepare = (pc = PC, n = N) => {
        cpu.in_hlt[0] = 0; cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
        cpu.is_32[0] = 1; cpu.stack_size_32[0] = 1;
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
        cpu.reg32.set([0, n, 0, 0, 0x90000, 0, 0, 0]);
        cpu.instruction_pointer[0] = pc;
        new Uint32Array(e.memory.buffer)[664 >> 2] = initial;
        e.update_state_flags();
    };
    const run = () => {
        const end = performance.now() + 10000;
        while(!cpu.in_hlt[0]) { assert(performance.now() < end); e.main_loop(); }
    };
    const loop = inc => Uint8Array.of(inc ? 0x43 : 0x4B, 0x49, 0x75, 0xFC, 0xF4);
    cpu.jit_clear_cache();
    assert.equal(e.ir_auto_config(0, 1000000, 1000000, 192, 256, 64), 1);
    vm.write_memory(loop(true), PC);
    prepare(); assert(await cpu.ir_compile_cached(5, 2, 1, 1, 256, 64));
    // A published owner runs through the fast table after one full admission.
    let fast = e.ir_cache_stat(46), hits = e.ir_cache_stat(2);
    prepare(); run();
    assert.equal(cpu.reg32[3], N); assert.equal(count(), (initial + N * 3 + 1) >>> 0);
    assert(e.ir_cache_stat(2) > hits, "published owner executes");
    prepare(); fast = e.ir_cache_stat(46); run();
    assert(e.ir_cache_stat(46) > fast, "warm entry uses the direct-mapped witness");
    assert.equal(cpu.reg32[3], N);
    // A TLB flush removes the cached mapping: the witness declines and the
    // complete admission re-establishes the translation before executing IR.
    e.full_clear_tlb();
    prepare(); hits = e.ir_cache_stat(2); run();
    assert(e.ir_cache_stat(2) > hits, "owner survives a mapping-preserving TLB flush");
    assert.equal(cpu.reg32[3], N);
    // Notified host write (write_blob -> jit_dirty_cache) retires the owner.
    const published = e.ir_cache_stat(0);
    vm.write_memory(loop(false), PC);
    assert.equal(e.ir_cache_stat(0), published - 1, "notified write retires the dependent owner");
    prepare(); hits = e.ir_cache_stat(2); run();
    assert.equal(cpu.reg32[3], -N | 0, "new bytes execute after a notified write");
    assert.equal(e.ir_cache_stat(2), hits, "retired owner never executes again");
    assert.equal(count(), (initial + N * 3 + 1) >>> 0);
    // Guest self-modification through the store slow path (TLB_HAS_CODE):
    // A writes DEC EBX over B's first byte, then jumps to the published B.
    cpu.jit_clear_cache();
    assert.equal(e.ir_auto_config(0, 1000000, 1000000, 192, 256, 64), 1);
    const B = PC + 0x10;
    vm.write_memory(Uint8Array.of(0x43, 0xF4), B);
    const jmp = B - (PC + 12);
    vm.write_memory(Uint8Array.of(0xC6, 0x05, B & 255, B >>> 8 & 255, 0, 0, 0x4B,
        0xE9, jmp & 255, jmp >>> 8 & 255, jmp >>> 16 & 255, jmp >>> 24 & 255), PC);
    prepare(B, 0); assert(await cpu.ir_compile_cached(2, 2, 1, 1, 256, 64));
    prepare(B, 0); run(); assert.equal(cpu.reg32[3], 1, "B published with INC EBX");
    prepare(PC, 0); run();
    assert.equal(cpu.reg32[3], -1, "guest store invalidates B before it runs again");
    assert.equal(cpu.mem8[B], 0x4B);
    // A code store inside a chained activation: A writes B's first byte and
    // jumps to B indirectly, so B runs as a separate witnessed owner that A
    // normally links to. The store retires B (and A) before the link; the new
    // bytes execute and no stale witness of a retired owner is entered.
    cpu.jit_clear_cache();
    assert.equal(e.ir_auto_config(0, 1000000, 1000000, 192, 256, 64), 1);
    const SCRATCH = 0x70000, ESI = 6, EDI = 7, EBX = 3;
    vm.write_memory(Uint8Array.of(0xC6, 0x07, 0x4B, 0xFF, 0xE6), PC);
    vm.write_memory(Uint8Array.of(0x43, 0xF4), B);
    const chain = target => { prepare(PC, 0); cpu.reg32[ESI] = B; cpu.reg32[EDI] = target; };
    chain(SCRATCH); assert(await cpu.ir_compile_cached(5, 2, 1, 1, 256, 64));
    prepare(B, 0); assert(await cpu.ir_compile_cached(2, 2, 1, 1, 256, 64));
    chain(SCRATCH); run(); assert.equal(cpu.reg32[EBX], 1);
    const chains = e.ir_cache_stat(47);
    chain(SCRATCH); run(); assert.equal(cpu.reg32[EBX], 1);
    assert(e.ir_cache_stat(47) > chains, "warm A links to B through the fast chain");
    chain(B); run();
    assert.equal(cpu.mem8[B], 0x4B);
    assert.equal(cpu.reg32[EBX], -1, "a chained witness never runs a retired owner");
    // Raw writes bypass both notifications. Under the notified contract they
    // are (like the legacy JIT) not detected; strict mode compares bytes.
    cpu.jit_clear_cache();
    assert.equal(e.ir_auto_config(0, 1000000, 1000000, 192, 256, 64), 1);
    vm.write_memory(loop(true), PC);
    prepare(); assert(await cpu.ir_compile_cached(5, 2, 1, 1, 256, 64));
    prepare(); run(); assert.equal(cpu.reg32[3], N);
    cpu.mem8[PC] = 0x4B;
    assert.equal(e.ir_cache_set_strict_validation(1), 1);
    assert.equal(e.ir_cache_stat(48), 1);
    prepare(); hits = e.ir_cache_stat(2); fast = e.ir_cache_stat(46); run();
    assert.equal(cpu.reg32[3], -N | 0, "strict admission rejects raw-written source bytes");
    assert.equal(e.ir_cache_stat(46), fast, "strict mode never uses the fast witness");
    assert.equal(e.ir_cache_set_strict_validation(0), 1);
    console.log(`PASS: ${wasm}: notified contract: fast witness, TLB-flush readmission, host and guest-store invalidation, chained retirement, strict raw-byte detection`);
} finally { await vm.destroy(); }
