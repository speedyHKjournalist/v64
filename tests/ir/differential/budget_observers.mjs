// Original versus prepaid polls at real CPU faults, MMIO and fused epoch exits.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const PC = 0x100000, DATA = 0x310040, OTHER = 0x320040, SHADOW = 0x330000;
const STACK = 0x90000, HANDLER = 0x180000, INITIAL = 0xFFFFFFFE;
const fixture_dir = process.env.IR_OBSERVER_FIXTURES || "build/ir-budget-observers";
const cases = JSON.parse(fs.readFileSync(`${fixture_dir}/cases.json`));
const wasm = process.argv[2] || "build/v86-ir-test.wasm";
const vm = new V86({wasm_path: wasm, memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, mem = cpu.mem8;
    const words = new Uint32Array(e.memory.buffer), view = new DataView(mem.buffer, mem.byteOffset);
    const set32 = (a, n) => view.setUint32(a, n >>> 0, true);
    vm.run(); const deadline = performance.now() + 10000;
    while(view.getUint16(0x500, true) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
    await vm.stop();
    const cr0 = cpu.cr[0], cr4 = cpu.cr[4];
    let events = [], mutate = false;
    const visible = () => ({gpr: Array.from(cpu.reg32), xmm: Array.from(cpu.reg_xmm32s),
        flags: e.get_eflags() >>> 0, ip: cpu.instruction_pointer[0] >>> 0});
    const observe = (address, value, bytes) => {
        events.push({address, value: value === undefined ? null : value >>> 0, bytes, state: visible()});
        if(mutate) mem[PC + 3] ^= 1; // Invalidate a future instruction, never execute stale bytes.
        const a = SHADOW + (address & 4095);
        if(value !== undefined) {
            if(bytes === 1) mem[a] = value; else set32(a, value);
        }
        return bytes === 1 ? mem[a] : view.getUint32(a, true);
    };
    cpu.io.mmap_register(0xA0000, 0x20000, a => observe(a, undefined, 1),
        (a, n) => observe(a, n, 1), a => observe(a, undefined, 4), (a, n) => observe(a, n, 4));
    const instances = cases.map((_, i) => new WebAssembly.Instance(new WebAssembly.Module(
        fs.readFileSync(`${fixture_dir}/${i}.wasm`)), {e: {...e, m: e.memory}}));
    const reference = new Map();
    let comparisons = 0, faults = 0, callbacks = 0, epoch_exits = 0;
    for(let i = 0; i < cases.length; i++) {
        const [name, bytes, batch, fused, budget, elide_epoch = false] = cases[i];
        const scenarios = ["hot", "cold"];
        if(!["sse", "divide"].includes(name)) scenarios.push("missing", "cross_page", "second_page_fault", "mmio", "callback", "null_segment");
        if(["store", "rmw", "xmm"].includes(name)) scenarios.push("readonly", "code_alias");
        if(name === "second_load") scenarios.push("later_fault");
        if(["sse", "xmm"].includes(name)) scenarios.push("task_fault");
        if(name === "sse") scenarios.push("nan");
        if(name === "divide") scenarios.push("zero_divisor");
        for(const scenario of scenarios) {
            const cross = ["cross_page", "second_page_fault"].includes(scenario);
            const address = cross ? (DATA & ~4095) + 4095 : DATA;
            const io = ["mmio", "callback"].includes(scenario);
            const physical = io ? SHADOW + (address & 4095)
                : scenario === "code_alias" ? PC + (address & 4095) : address;
            const reset = () => {
                e.ir_test_set_cr0((cr0 | 0x10000) & ~12); cpu.cr[4] = cr4 | 0x200;
                cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
                cpu.is_32[0] = cpu.stack_size_32[0] = 1;
                cpu.reg32.set([7, scenario === "zero_divisor" ? 0 : 11, 0, 0x12345678, STACK, 7, address, OTHER]);
                cpu.reg_xmm32s.fill(scenario === "nan" ? 0x7F812345 : 0x3F800000);
                cpu.flags[0] = 3; cpu.flags_changed[0] = 0;
                cpu.in_hlt[0] = 0; cpu.instruction_pointer[0] = PC; words[612 >> 2] = 0;
                words[560 >> 2] = 0x12345678; cpu.cr[2] = 0xBADF000;
                mem.set(bytes, PC); mem.fill(0x5A, physical, physical + 32); set32(OTHER, 0xCAFEBABE);
                mem.fill(0xCC, STACK - 64, STACK);
                cpu.idtr_offset[0] = 0x2000; cpu.idtr_size[0] = 0x7FF;
                for(const vector of [0, 7, 13, 14]) {
                    set32(0x2000 + vector * 8, 8 << 16 | (HANDLER & 0xFFFF));
                    set32(0x2004 + vector * 8, (HANDLER & 0xFFFF0000) | 0x8E00);
                }
                for(const a of [DATA, DATA + 4096, OTHER, PC]) set32(0x13000 + (a >>> 12) * 4, (a & ~4095) | 3);
                if(io) set32(0x13000 + (address >>> 12) * 4, 0xA0003);
                if(scenario === "code_alias") set32(0x13000 + (address >>> 12) * 4, PC | 3);
                if(scenario === "missing") set32(0x13000 + (address >>> 12) * 4, 0);
                if(scenario === "readonly") set32(0x13000 + (address >>> 12) * 4, (address & ~4095) | 1);
                if(scenario === "second_page_fault") set32(0x13000 + ((address >>> 12) + 1) * 4, 0);
                if(scenario === "later_fault") set32(0x13000 + (OTHER >>> 12) * 4, 0);
                e.full_clear_tlb(); e.update_state_flags();
                if(["hot", "later_fault", "code_alias"].includes(scenario)) {
                    e.ir_memory_write(address, mem[physical], 1);
                    if(scenario !== "later_fault") e.ir_memory_read(OTHER, 4);
                }
                if(scenario === "task_fault") e.ir_test_set_cr0(cpu.cr[0] | 8);
                if(scenario === "null_segment") cpu.segment_is_null[3] = 1;
                words[664 >> 2] = INITIAL; events = []; mutate = scenario === "callback" && fused; // Epoch invalidation is the fused-entry contract.
            };
            const snapshot = () => ({...visible(), previous: words[560 >> 2], count: words[664 >> 2],
                cr2: cpu.cr[2], data: Array.from(mem.slice(physical, physical + 32)),
                code: Array.from(mem.slice(PC, PC + bytes.length)), frame: Array.from(mem.slice(STACK - 32, STACK)), events});
            reset(); instances[i].exports.f(0);
            const actual = snapshot(), retired = (actual.count - INITIAL) >>> 0;
            assert(retired <= budget, `${name}/${scenario}/${budget}: retirement bound`);
            const key = [name, fused, budget, scenario].join("/");
            if(batch || elide_epoch) assert.deepEqual(actual, reference.get(key), `original poll boundary ${key}`);
            else reference.set(key, actual);
            const fault = actual.ip === HANDLER;
            reset(); for(let step = 0; step < retired + Number(fault); step++) e.ir_test_step();
            const expected = snapshot(); expected.count = actual.count; expected.previous = actual.previous;
            assert.deepEqual(actual, expected, `CPU interpreter prefix ${key}/${batch}`);
            if(fault) faults++;
            if(actual.events.length) callbacks++;
            if(fused && name === "load" && scenario === "cold" && budget >= 3) {
                assert.equal(retired, 2, "epoch exit must precede the following INC"); epoch_exits++;
            }
            comparisons++;
        }
    }
    assert(faults && callbacks && epoch_exits);
    console.log(`PASS: ${wasm}: ${comparisons} original/prepaid/CPU comparisons; ${faults} precise faults, ${callbacks} callback cases, ${epoch_exits} checked epoch exits`);
} finally { await vm.destroy(); }
