// Actual CPU differential: vector stores retain SSA only on checked ordinary RAM.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";

const PC = 0x100000, PEER = PC + 0x2000, DATA = 0x310040, LOAD = 0x320040;
const STACK = 0x90000, PF = 0x180000, ALIAS = 0x800000;
const cases = [
    ["movss", 4, 0], ["movsd", 8, 0], ["movups", 16, 0], ["movd", 4, 0],
    ["movq", 8, 0], ["movhps", 8, 8], ["movntps", 16, 0], ["maskmovdqu", 16, 0],
];
const wasm = process.argv[2] || "build/v86-ir-test.wasm";
const vm = new V86({ wasm_path: wasm, memory_size: 32 << 20,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "none" }, autostart: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, mem = cpu.mem8;
    const view = new DataView(mem.buffer, mem.byteOffset);
    const words = new Uint32Array(e.memory.buffer), xmm = new Uint32Array(e.memory.buffer, 832, 32);
    const set32 = (a, n) => view.setUint32(a, n >>> 0, true);
    vm.run(); const deadline = performance.now() + 10000;
    while(view.getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout"); await sleep(1);
    }
    await vm.stop();
    const cr0 = cpu.cr[0], cr4 = cpu.cr[4];
    let slow = 0, events = [], mutate = false;
    const visible = () => ({ gpr: Array.from(cpu.reg32), xmm: Array.from(xmm),
        flags: e.get_eflags(), ip: cpu.instruction_pointer[0] >>> 0 });
    const state = physical => ({ ...visible(), cr2: cpu.cr[2], previous: words[560 >> 2],
        bytes: Array.from(mem.slice(physical, physical + 20)),
        frame: Array.from(mem.slice(STACK - 32, STACK)) });
    const imports = { ...e, m: e.memory,
        ir_xmm_store: (...args) => { slow++; return e.ir_xmm_store(...args); },
        ir_xmm_masked_store: (...args) => { slow++; return e.ir_xmm_masked_store(...args); } };
    const observe = (address, value, bytes) => {
        events.push({ address, value: value >>> 0, bytes, state: visible() });
        const physical = 0x310000 + (address & 4095);
        if(bytes === 1) mem[physical] = value; else set32(physical, value);
        if(mutate) { mem[PC + 1] ^= 1; cpu.reg32[5] = 0xDEADBEEF; xmm[28] = 0xCAFE1234; }
    };
    cpu.io.mmap_register(0xA0000, 0x20000, () => 0,
        (a, n) => observe(a, n, 1), () => 0, (a, n) => observe(a, n, 4));
    let comparisons = 0, fast = 0, aliases = 0, faults = 0, callback_cases = 0;
    for(const [name, width, lane] of cases) {
        const code = Uint8Array.from(JSON.parse(fs.readFileSync(`build/ir-vector-store/${name}.json`)));
        const instances = Array.from({ length: 6 }, (_, n) => new WebAssembly.Instance(
            new WebAssembly.Module(fs.readFileSync(`build/ir-vector-store/${name}-${n}.wasm`)), { e: imports }));
        for(const scenario of ["hot", "unaligned", "last_range", "cold", "cross_page", "readonly",
            "second_page_fault", "later_fault", "current_alias", "peer_alias", "mmio", "callback", "mask_zero"]) {
            if(scenario === "mask_zero" && name !== "maskmovdqu") continue;
            const address = scenario === "unaligned" ? DATA + 1
                : scenario === "last_range" ? (DATA & ~4095) + 4096 - width
                : ["cross_page", "second_page_fault"].includes(scenario) ? (DATA & ~4095) + 4095
                : scenario.endsWith("alias") ? ALIAS + 0x200 : DATA;
            const physical = scenario === "current_alias" ? PC + 0x200
                : scenario === "peer_alias" ? PEER + 0x200 : address;
            const native = ["hot", "unaligned", "last_range", "later_fault", "mask_zero"].includes(scenario);
            const failure = ["readonly", "second_page_fault", "later_fault"].includes(scenario);
            function reset() {
                e.ir_test_set_cr0((cr0 | 0x10000) & ~12); cpu.cr[4] = cr4 | 0x200;
                cpu.cr[2] = 0xBADF000;
                cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
                cpu.is_32[0] = cpu.stack_size_32[0] = 1;
                cpu.reg32.set([0x7FFFFFFF, address, 0xABCD1234, 0x12345678, STACK, 7, LOAD, address]);
                for(let i = 0; i < 32; i++) xmm[i] = (0x80000001 + i * 0x1020304) >>> 0;
                xmm.set([0x80808080, 0x00800080, 0x80000000, 0x00808000], 4);
                if(scenario === "mask_zero") xmm.fill(0, 4, 8);
                cpu.flags[0] = 3; cpu.flags_changed[0] = 0;
                words[104 >> 2] = 0x87654321; words[664 >> 2] = 0xFFFFFFFE;
                cpu.instruction_pointer[0] = PC; cpu.in_hlt[0] = 0;
                mem.set(code, PC); mem.fill(0x5A, physical, physical + 20);
                mem.fill(0xCC, STACK - 64, STACK); set32(LOAD, 0xCAFEBABE);
                cpu.idtr_offset[0] = 0x2000; cpu.idtr_size[0] = 0x7FF;
                set32(0x2000 + 14 * 8, 8 << 16 | (PF & 0xFFFF));
                set32(0x2004 + 14 * 8, (PF & 0xFFFF0000) | 0x8E00);
                for(const a of [DATA, DATA + 4096, LOAD, PC, PEER, address, address + 16])
                    set32(0x13000 + (a >>> 12) * 4, (a & ~4095) | 3);
                if(scenario.endsWith("alias")) set32(0x13000 + (address >>> 12) * 4, (physical & ~4095) | 3);
                if(scenario === "readonly") set32(0x13000 + (address >>> 12) * 4, (address & ~4095) | 1);
                if(scenario === "second_page_fault") set32(0x13000 + ((address >>> 12) + 1) * 4, 0);
                if(scenario === "later_fault") set32(0x13000 + (LOAD >>> 12) * 4, 0);
                if(["mmio", "callback"].includes(scenario)) set32(0x13000 + (DATA >>> 12) * 4, 0xA0003);
                e.full_clear_tlb(); e.update_state_flags();
                if(native || scenario.endsWith("alias")) e.ir_memory_write(address, mem[physical], 1);
                if(native && scenario !== "later_fault") e.ir_memory_read(LOAD, 4);
                slow = 0; events = []; mutate = scenario === "callback";
            }
            for(let variant = 0; variant < instances.length; variant++) {
                const continued = native && variant < 4;
                const retired = failure ? (scenario === "later_fault" && continued ? 4 : scenario === "later_fault" ? 3 : 2)
                    : continued ? 5 : 3;
                const executed = retired + Number(failure && (scenario !== "later_fault" || continued));
                reset();
                const expected_bytes = Array.from(mem.slice(physical, physical + 20));
                const source = new Uint8Array(16), source_words = new Uint32Array(source.buffer);
                for(let i = 0; i < 4; i++) source_words[i] = xmm[i] ^ xmm[8 + i];
                const mask = new Uint8Array(xmm.buffer, xmm.byteOffset + 16, 16);
                if(!failure || scenario === "later_fault") for(let i = 0; i < width; i++)
                    if(name !== "maskmovdqu" || mask[i] & 0x80) expected_bytes[i] = source[lane + i];
                instances[variant].exports.f(0);
                assert.equal((words[664 >> 2] - 0xFFFFFFFE) >>> 0, retired, `${name}/${scenario}/${variant}: exact wrapped retirement`);
                assert.equal(slow, native || scenario.endsWith("alias") ? 0 : 1, `${name}/${scenario}/${variant}: store path`);
                const actual = state(physical), actual_events = events;
                if(scenario !== "callback") assert.deepEqual(actual.bytes, expected_bytes, `${name}/${scenario}: independent byte/lane/mask result`);
                reset(); for(let i = 0; i < executed; i++) e.ir_test_step();
                assert.deepEqual(actual, state(physical), `${name}/${scenario}/${variant}: architectural state`);
                assert.deepEqual(actual_events, events, `${name}/${scenario}/${variant}: callback order/state`);
                if(continued) fast++;
                if(scenario.endsWith("alias")) { assert.equal(actual.ip, PC + code.length - 3); aliases++; }
                if(failure && executed > retired) { assert.equal(actual.ip, PF); faults++; }
                if(actual_events.length) callback_cases++;
                comparisons++;
            }
        }
    }
    console.log(`PASS: ${wasm}: ${comparisons} vector-store CPU comparisons; ${fast} native continuations, ${aliases} physical-code-alias exits, ${faults} precise faults, ${callback_cases} MMIO/callback cases`);
} finally { await vm.destroy(); }
