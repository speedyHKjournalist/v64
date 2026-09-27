import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

function standalone(name, seed, opt) {
    const bytes = fs.readFileSync(`build/ir10/${name}-${opt}.wasm`);
    assert(WebAssembly.validate(bytes));
    const m = new WebAssembly.Memory({initial:64});
    const words = new Uint32Array(m.buffer);
    words.set(seed, 0);
    words[8] = 0x8D7;
    words[9] = 0x1000;
    words[10] = 0;
    words[11] = 0x55667788;
    new WebAssembly.Instance(new WebAssembly.Module(bytes), {e:{m}}).exports.f(0);
    return Array.from(words.slice(0, 12));
}

let standalone_comparisons = 0;
for(const name of ["copy","dce","gvn","cfg"]) {
    for(const seed of [
        [0,1,2,3,4,5,6,7],
        [0xFFFFFFFF,0,0x80000000,0x7FFFFFFF,0x12345678,0x89ABCDEF,9,10],
        [17,17,34,51,68,85,102,119],
    ]) {
        assert.deepEqual(
            standalone(name, seed, 1),
            standalone(name, seed, 0),
            `IR-10 ${name} pass changed standalone semantics`
        );
        standalone_comparisons++;
    }
}
console.log(`PASS: ${standalone_comparisons} standalone IR-10 copy/DCE/GVN/CFG per-pass comparisons`);

const vm = new V86({
    wasm_path:process.argv[2] || "build/v86-ir-test.wasm",
    memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,
    disable_mouse:true,
    disable_speaker:true,
    net_device:{type:"none"},
    autostart:false,
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
    await new Promise(r => vm.add_listener("emulator-loaded", r));
    const cpu = vm.v86.cpu;
    const e = cpu.wm.exports;
    const words = new Uint32Array(e.memory.buffer);
    vm.run();
    const deadline = performance.now() + 10000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline);
        await sleep(1);
    }
    await vm.stop();

    const load = name => [0,1].map(opt => {
        const bytes = fs.readFileSync(`build/ir10/${name}-${opt}.wasm`);
        assert(WebAssembly.validate(bytes));
        return new WebAssembly.Instance(new WebAssembly.Module(bytes), {e:{
            ...e,
            m:e.memory,
            ir10_pure_helper:x => [0, (x + 5) | 0],
        }}).exports.f;
    });
    const flags = load("flags");
    const helper = load("helper");

    function reset(pc, logical, seed, lazy) {
        cpu.segment_offsets.fill(0, 0, 6);
        cpu.segment_is_null.fill(0, 0, 6);
        cpu.segment_limits.fill(0xFFFFFFFF, 0, 6);
        cpu.sreg.set([16,8,16,16,16,16]);
        cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.stack_size_32[0] = 1;
        cpu.is_32[0] = 1;
        cpu.segment_offsets[1] = (pc - logical) >>> 0;
        cpu.reg32.set(seed);
        cpu.flags[0] = seed[0] & 1 ? 0x8D7 : 2;
        cpu.flags_changed[0] = lazy ? 0x8D5 : 0;
        words[96>>2] = 31;
        words[104>>2] = 0x13579BDF;
        words[112>>2] = seed[0] ^ 0x80000000;
        cpu.instruction_pointer[0] = pc;
        words[664>>2] = 100;
        cpu.in_hlt[0] = 0;
        e.update_state_flags();
        e.full_clear_tlb();
    }
    const state = () => ({
        regs:Array.from(cpu.reg32, x => x >>> 0),
        flags:e.get_eflags() >>> 0,
        raw:cpu.flags[0] >>> 0,
        changed:cpu.flags_changed[0] >>> 0,
        result:words[112>>2] >>> 0,
        operand:words[104>>2] >>> 0,
        size:words[96>>2] >>> 0,
        ip:cpu.instruction_pointer[0] >>> 0,
        count:words[664>>2] >>> 0,
    });

    let cpu_comparisons = 0;
    for(const lazy of [false,true]) for(const seed of [
        [1,2,3,4,0x90000,6,7,8],
        [0x7FFFFFFF,0x80000000,0xFFFFFFFF,1,0x90000,0x12345678,9,10],
    ]) {
        reset(0x100000, 0x1000, seed, lazy);
        flags[0](0);
        const baseline_flags = state();
        reset(0x100000, 0x1000, seed, lazy);
        flags[1](0);
        assert.deepEqual(state(), baseline_flags, "IR-10 FLAGS liveness changed CPU semantics");
        cpu_comparisons++;

        reset(0x110000, 0x1400, seed, lazy);
        helper[0](0);
        const baseline_helper = state();
        reset(0x110000, 0x1400, seed, lazy);
        helper[1](0);
        assert.deepEqual(state(), baseline_helper, "IR-10 helper-state trim changed CPU semantics");
        cpu_comparisons++;
    }
    console.log(`PASS: ${cpu_comparisons} CPU IR-10 FLAGS/helper-state per-pass comparisons`);
} finally {
    await vm.destroy();
}
