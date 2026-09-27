import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const wasm = process.argv[2] || "build/v86-ir-test.wasm";
const bytes = JSON.parse(fs.readFileSync("build/ir-licm/cpu.json"));
const vm = new V86({wasm_path: wasm, memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let executions = 0, steps = 0;
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, mem = cpu.mem8;
    const words = new Uint32Array(e.memory.buffer), raw = new Uint8Array(e.memory.buffer);
    const view = new DataView(mem.buffer, mem.byteOffset);
    vm.run();
    const deadline = performance.now() + 10000;
    while(view.getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "test BIOS initialized");
        await sleep(1);
    }
    await vm.stop();
    cpu.jit_clear_cache();
    const PC = 0x100000;
    function reset(counter, a, b, flags, lazy, initial_count) {
        cpu.segment_offsets.fill(0, 0, 6);
        cpu.segment_is_null.fill(0, 0, 6);
        cpu.segment_limits.fill(0xFFFFFFFF, 0, 6);
        cpu.sreg.set([16, 8, 16, 16, 16, 16]);
        cpu.segment_access_bytes.set([0x93, 0x9B, 0x93, 0x93, 0x93, 0x93]);
        cpu.stack_size_32[0] = 1;
        cpu.is_32[0] = 1;
        words[612 >> 2] = 0;
        raw[648] = 0;
        cpu.in_hlt[0] = 0;
        cpu.reg32.set([0xDEADBEEF, counter, 0x12345678, a, 0x90000, 0x2468ACE0, b, 0x13579BDF]);
        cpu.flags[0] = flags;
        cpu.flags_changed[0] = lazy ? 0x8D5 : 0;
        words[96 >> 2] = 31;
        words[104 >> 2] = 0x7FFFFFFF;
        words[112 >> 2] = flags & 64 ? 0 : 0x80000000;
        cpu.instruction_pointer[0] = PC;
        words[560 >> 2] = 0x76543210;
        words[664 >> 2] = initial_count;
        mem.set(bytes, PC);
        e.update_state_flags();
        e.full_clear_tlb();
    }
    const state = () => ({gpr: Array.from(cpu.reg32, value => value >>> 0),
        flags: e.get_eflags() >>> 0, operand: words[104 >> 2], ip: cpu.instruction_pointer[0] >>> 0});
    for(const budget of [1, 2, 3, 4, 5, 8, 17, 100]) {
        const instances = [false, true].map(opt => new WebAssembly.Instance(
            new WebAssembly.Module(fs.readFileSync(`build/ir-licm/cpu-${budget}-${opt}.wasm`)),
            {e: {...e, m: e.memory}}));
        for(const counter of [0, 1, 2, 7, 0xFFFFFFFF])
        for(const a of [0, 0x7FFFFFFF, 0xFFFFFFFF])
        for(const b of [1, 0x80000000])
        for(const flags of [2, 0x8D7])
        for(const lazy of [false, true])
        for(const initial_count_local of [99, 0xFFFFFFFC]) {
            let baseline;
            for(const [index, instance] of instances.entries()) {
                reset(counter, a, b, flags, lazy, initial_count_local);
                instance.exports.f(0);
                const actual = state();
                const retired = (words[664 >> 2] - initial_count_local) >>> 0;
                const observed = {...actual, retired, previous: words[560 >> 2]};
                assert(retired <= budget, "bounded guest retirement");
                if(index === 0) baseline = observed;
                else assert.deepEqual(observed, baseline, "Tier 2 LICM preserves exact budget recovery");
                reset(counter, a, b, flags, lazy, initial_count_local);
                for(let step = 0; step < retired; step++) e.ir_test_step();
                assert.deepEqual(actual, state(), `interpreter equivalence: budget ${budget}, tier ${index + 1}`);
                if(actual.ip === PC + bytes.length) {
                    assert.equal(actual.gpr[1], 0);
                    assert.equal(actual.gpr[0], Number(BigInt(counter) * (BigInt(a) + BigInt(b)) & 0xFFFFFFFFn));
                }
                executions++;
                steps += retired;
            }
        }
    }
    console.log(`PASS: ${wasm}: ${executions} CPU LICM comparisons and ${steps} interpreter steps; exact Tier 1/2 recovery, lazy FLAGS, wrapping counts and arithmetic`);
} finally {
    await vm.destroy();
}
