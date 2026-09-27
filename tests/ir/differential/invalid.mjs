import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases = JSON.parse(fs.readFileSync("build/ir-invalid/cases.json"));
const modules = cases.map((_, i) => [0, 1].map(opt => new WebAssembly.Module(fs.readFileSync(`build/ir-invalid/${i}-${opt}.wasm`))));
const vm = new V86({wasm_path: process.argv[2] || "build/v86-ir-test.wasm", memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: {type: "none"}, autostart: false});
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, mem = cpu.mem8;
    const w = new Uint32Array(e.memory.buffer), v = new DataView(mem.buffer, mem.byteOffset);
    const put32 = (a, x) => v.setUint32(a, x, true), put16 = (a, x) => v.setUint16(a, x, true);
    vm.run(); const deadline = performance.now() + 10000;
    while(v.getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline); await new Promise(r => setTimeout(r, 1));
    }
    await vm.stop();
    const initial_cr0 = cpu.cr[0], initial_cr4 = cpu.cr[4], PC = 0x8000, SP = 0x9000, HANDLER = 0x180000;
    const instances = modules.map(pair => pair.map(m => new WebAssembly.Instance(m, {e: {...e, m: e.memory}})));
    function desc(n, base, access, size32) {
        put32(0x3000 + n * 8, 0xFFFF | base << 16);
        put32(0x3004 + n * 8, base & 0xFF000000 | (base >>> 16 & 255) | access << 8 | 0xF0000 | (size32 ? 12 : 8) << 20);
    }
    function reset(i, {real = false, csBase: cs_base = 0, ss32 = true, overflow = false, nullSegment: null_segment = false, taskFlags: task_flags = 0, targetAccess: target_access = 0x9B, gateAccess: gate_access = 0xEE, pageFault: page_fault = 0} = {}) {
        const [bytes, mode] = cases[i]; const width = mode ? 32 : 16;
        e.ir_test_set_cr0(real ? initial_cr0 & ~0x80000001 : (initial_cr0 | 0x10001) & ~12 | task_flags);
        cpu.cr[4] = initial_cr4 | 512; cpu.cr[2] = 0xBADF000;
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_offsets[1] = cs_base;
        cpu.segment_limits.fill(0xFFFFFFFF, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
        cpu.sreg.set([16, 8, 16, 16, 16, 16]); cpu.segment_access_bytes.set([0x93, 0x9B, 0x93, 0x93, 0x93, 0x93]);
        cpu.segment_is_null[3] = +null_segment;
        cpu.is_32[0] = +mode; cpu.stack_size_32[0] = +ss32; w[612 >> 2] = 0;
        cpu.reg32.set([0x12345678, 0x87654321, 0x3456789A, 0x76543210, SP, 0x11223344, overflow ? 0x7FFFFFFF : 0, 0xAABBCCDD]);
        // INC ESI determines OF for INTO; choose the corresponding 16-bit input.
        if(overflow && !mode) cpu.reg32[6] = 0x7FFF;
        cpu.flags[0] = 2; cpu.flags_changed[0] = 0; w[104 >> 2] = 0x12345678;
        cpu.instruction_pointer[0] = cs_base + PC; cpu.in_hlt[0] = 0; w[664 >> 2] = 100;
        cpu.gdtr_offset[0] = 0x3000; cpu.gdtr_size[0] = 47;
        desc(1, 0, 0x9B, true); desc(2, 0, 0x93, true); desc(3, 0x10000, target_access, mode);
        desc(4, 0, 0xF3, true); desc(5, 0x4000, 0x89, false);
        cpu.segment_offsets[6] = 0x4000; cpu.segment_limits[6] = 0x67; cpu.sreg[6] = 0x28; cpu.tss_size_32[0] = 1;
        put32(0x4004, 0x92000); put32(0x4008, 16);
        cpu.idtr_offset[0] = 0x2000; cpu.idtr_size[0] = 0x7FF;
        for(const vector of [3, 4, 6, 7, 11, 12, 13, 14, 0x30]) {
            put32(0x2000 + vector * 8, 8 << 16 | HANDLER & 65535);
            put32(0x2004 + vector * 8, HANDLER & 0xFFFF0000 | ([3, 4, 0x30].includes(vector) ? gate_access : 0x8E) << 8);
            if(real) { put16(vector * 4, 0x1800); put16(vector * 4 + 2, 0); }
        }
        put32(0x12000, 0x13007);
        for(const page of [2, 3, 4, 7, 8, 9, 0x18, 0x90, 0x92, 0x180]) put32(0x13000 + page * 4, page * 4096 | 7);
        mem.fill(0xCC, SP - 128, SP + 64); mem.fill(0xCC, 0x92000 - 128, 0x92000 + 16);
        const put = width === 16 ? put16 : put32;
        put(SP, 0xA000); put(SP + width / 8, 0x18); put(SP + width / 4, 2);
        put(0x7000, 0xA000); put16(0x7000 + width / 8, 0x18);
        mem.set(bytes, cs_base + PC);
        if(page_fault === 4) {
            // Only the target descriptor faults. Exception CS/SS descriptors
            // remain on page 3, so fault delivery cannot recursively fault.
            mem.set(mem.slice(0x3000, 0x3030), 0x3FE8);
            cpu.gdtr_offset[0] = 0x3FE8;
        }
        if(page_fault) put32(0x13000 + page_fault * 4, 0);
        e.full_clear_tlb(); e.update_state_flags();
    }
    function state() {
        return {regs: Array.from(cpu.reg32, x => x >>> 0), flags: e.get_eflags() >>> 0,
            ip: cpu.instruction_pointer[0] >>> 0, previous: w[560 >> 2], cpl: w[612 >> 2] & 255,
            sreg: Array.from(cpu.sreg), base: Array.from(cpu.segment_offsets), limit: Array.from(cpu.segment_limits),
            access: Array.from(cpu.segment_access_bytes), null: Array.from(cpu.segment_is_null),
            mode: cpu.is_32[0], ss32: cpu.stack_size_32[0], cr: Array.from(cpu.cr), cached: w[108 >> 2],
            frames: [SP - 128, 0x92000 - 128].map(a => Buffer.from(mem.slice(a, a + 192)))};
    }
    let comparisons = 0;
    function compare(i, options = {}, retired = 2) {
        reset(i, options); e.ir_test_step(); e.ir_test_step(); const expected = state();
        for(const opt of [0, 1]) {
            reset(i, options); instances[i][opt].exports.f(0);
            assert.equal(w[664 >> 2], 100 + retired, `retirement ${i} ${JSON.stringify(options)}`);
            assert.deepEqual(state(), expected, `state ${i} opt=${opt} ${JSON.stringify(options)}`);
            comparisons++;
        }
        return expected;
    }
    for(let i = 0; i < cases.length; i++) {
        for(const task_flags_local of [0,4,8,12]) for(const null_segment_local of [false,true]) {
            const actual=compare(i,{taskFlags: task_flags_local,nullSegment: null_segment_local,pageFault:7},1);
            assert.equal(actual.ip,HANDLER);
            assert.equal(actual.cr[2],0xBADF000,"invalid forms must not read operand memory");
        }
    }
    console.log(`PASS: ${comparisons} invalid-form CPU comparisons, guard/segment/#UD priority, unmapped operands and exact retirement`);
} finally { await vm.destroy(); }
