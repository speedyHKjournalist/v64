// Read-only system helpers must expose their results to following SSA without
// retiring faults, and debug CPUID observers must retain authoritative state.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const directory = "build/ir-system-read-continuation";
const cases = JSON.parse(fs.readFileSync(`${directory}/cases.json`));
const modules = cases.map((_, i) => [0, 1].map(opt => [1, 2, 3, 4].map(budget =>
    new WebAssembly.Module(fs.readFileSync(`${directory}/${i}-${opt}-${budget}.wasm`)))));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PC = 0x8000, STACK = 0x90000, GP = 0x180000, UD = 0x180100;
const abiOnly = process.env.IR_SYSTEM_READ_ABI_ONLY === "1";

for(const release of [false, true]) {
    let observer;
    const path = (process.argv[2] || "build/v86-ir-test") + (release ? "-release" : "") + ".wasm";
    const core = new WebAssembly.Module(fs.readFileSync(path));
    const createVm = () => new V86({
        wasm_fn: async imports => {
            const original = imports.env.log_from_wasm;
            imports.env.log_from_wasm = (...args) => observer ? observer(...args) : original(...args);
            return new WebAssembly.Instance(core, imports).exports;
        },
        memory_size: 32 << 20,
        bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
        disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        net_device: {type: "none"}, autostart: false,
    });
    let vm = createVm();
    try {
        let cpu, e, mem, words, raw, dr, view;
        const set32 = (address, value) => view.setUint32(address, value, true);
        const instances = new Map();
        function instance(i, opt, budget) {
            const key = `${i}/${opt}/${budget}`;
            if(!instances.has(key)) instances.set(key, new WebAssembly.Instance(modules[i][opt][budget - 1], {e: {...e, m: e.memory}}));
            return instances.get(key);
        }
        async function boot() {
            await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
            cpu = vm.v86.cpu; e = cpu.wm.exports; mem = cpu.mem8;
            words = new Uint32Array(e.memory.buffer); raw = new Uint8Array(e.memory.buffer);
            dr = new Uint32Array(e.memory.buffer, 684, 8);
            view = new DataView(mem.buffer, mem.byteOffset); instances.clear();
            vm.run(); const deadline = performance.now() + 10000;
            while(view.getUint16(0x500, true) !== 0xCAFE) {
                assert(performance.now() < deadline, "BIOS timeout"); await sleep(1);
            }
            await vm.stop();
        }
        // Never reuse a Rust instance after its deliberate debug panic trap.
        async function recreate() { observer = undefined; await vm.destroy(); vm = createVm(); await boot(); }
        await boot();
        const cr0 = cpu.cr[0], cr3 = cpu.cr[3], cr4 = cpu.cr[4];
        function desc(n, base, access) {
            set32(0x3000 + n * 8, base << 16 | 65535);
            set32(0x3004 + n * 8, base & 0xFF000000 | base >>> 16 & 255 | access << 8 | 0xCF0000);
        }
        function reset(i, {cpl = 0, de = false, leaf = 0, subleaf = 0, start = 100} = {}) {
            observer = undefined;
            cpu.cr[4] = cr4; cpu.cr[3] = cr3; e.ir_test_set_cr0(cr0 | 0x10000);
            cpu.cr[4] |= de ? 8 : 0; cpu.cr[2] = 0xBADF000;
            dr.set([0x12345678, 0xABCDEF01, 0, 0xFFFFFFFF, 4, 5, 0x66666666, 0x77777777]);
            cpu.segment_offsets.fill(0, 0, 6); cpu.segment_limits.fill(0xFFFFFFFF, 0, 6);
            cpu.segment_is_null.fill(0, 0, 6);
            cpu.sreg.set([16, cpl ? 0x1B : 8, cpl ? 0x23 : 16, 16, 16, 16]);
            cpu.segment_access_bytes.set([0x93, cpl ? 0xFB : 0x9B, cpl ? 0xF3 : 0x93, 0x93, 0x93, 0x93]);
            cpu.is_32[0] = +cases[i][1]; cpu.stack_size_32[0] = 1; words[612 >> 2] = cpl;
            cpu.reg32.set([leaf, subleaf, 0x89ABCDEF, 0x7FFFFFFF, STACK, 0x12345678, 0xBADF00D, 0x65432100]);
            cpu.reg_xmm32s.set(Array.from({length: 32}, (_, n) => 0x10000000 + n));
            cpu.flags[0] = 0x8D7; cpu.flags_changed[0] = 0; words[104 >> 2] = 0x76543210;
            cpu.instruction_pointer[0] = PC; cpu.in_hlt[0] = 0; words[664 >> 2] = start;
            words[560 >> 2] = 0x12345678; raw[552] = 1; e.set_cpuid_level(0x16);
            desc(1, 0, 0x9B); desc(2, 0, 0x93); desc(3, 0, 0xFB); desc(4, 0, 0xF3);
            desc(5, 0x4000, 0x89); cpu.gdtr_offset[0] = 0x3000; cpu.gdtr_size[0] = 47;
            cpu.segment_offsets[6] = 0x4000; cpu.segment_limits[6] = 0x67;
            cpu.sreg[6] = 0x28; cpu.tss_size_32[0] = 1; set32(0x4004, STACK); set32(0x4008, 16);
            cpu.idtr_offset[0] = 0x2000; cpu.idtr_size[0] = 0x7FF;
            for(const [vector, handler] of [[6, UD], [13, GP]]) {
                set32(0x2000 + vector * 8, 8 << 16 | handler & 65535);
                set32(0x2004 + vector * 8, handler & 0xFFFF0000 | 0x8E00);
            }
            set32(0x12000, 0x13007);
            for(const page of [2, 3, 4, 8, 0x18, 0x90]) set32(0x13000 + page * 4, page * 4096 | 7);
            mem.fill(0xCC, STACK - 128, STACK + 16);
            mem.fill(0, PC, PC + 16); mem.set(cases[i][0], PC);
            e.full_clear_tlb(); e.update_state_flags();
        }
        const state = () => ({
            regs: Array.from(cpu.reg32), flags: e.get_eflags(), xmm: Array.from(cpu.reg_xmm32s),
            ip: cpu.instruction_pointer[0], count: words[664 >> 2], cr: Array.from(cpu.cr), dr: Array.from(dr),
            cpl: words[612 >> 2] & 255, mode: cpu.is_32[0], sreg: Array.from(cpu.sreg),
            bases: Array.from(cpu.segment_offsets), code: Buffer.from(mem.slice(PC, PC + 16)),
            frame: Buffer.from(mem.slice(STACK - 128, STACK + 16)),
        });
        const caught = action => {
            try { action(); return false; }
            catch(error) { if(!(error instanceof WebAssembly.RuntimeError)) throw error; return true; }
        };
        let comparisons = 0;
        for(let i = 0; !abiOnly && i < cases.length; i++) {
            const [, , op, index] = cases[i];
            const configurations = op === 0xA2
                ? [0, 1, 2, 4, 7, 0x16, 0x80000000, 0xFFFFFFFF].map(leaf => ({leaf, subleaf: 2}))
                : [{}, {cpl: 3}, {de: true}];
            for(const config of configurations) for(const start of [100, 0xFFFFFFFE]) {
                for(const budget of [1, 2, 3, 4]) {
                    const fault = op !== 0xA2 && (config.cpl || op === 0x20 && ![0, 2, 3, 4].includes(index)
                        || op === 0x21 && config.de && [4, 5].includes(index));
                    const abort = budget > 1 && !release && !config.cpl && op === 0x20 && ![0, 2, 3, 4].includes(index);
                    const terminal = !release && op === 0xA2 && ![0, 2, 0x80000000].includes(config.leaf);
                    const steps = Math.min(budget, fault || terminal ? 2 : 4);
                    reset(i, {...config, start});
                    let referenceAbort = false;
                    for(let n = 0; n < steps; n++) {
                        referenceAbort = caught(() => e.ir_test_step());
                        if(referenceAbort || fault && n === 1) break;
                        words[664 >> 2]++;
                    }
                    assert.equal(referenceAbort, abort);
                    const expected = state();
                    if(abort) await recreate();
                    for(const opt of [0, 1]) {
                        reset(i, {...config, start});
                        assert.equal(caught(() => instance(i, opt, budget).exports.f(0)), abort);
                        assert.deepEqual(state(), expected, `${release}/${i}/${opt}/${budget}/${JSON.stringify(config)}/${start}`);
                        if(abort) await recreate();
                        comparisons++;
                    }
                }
            }
        }
        let observers = 0;
        if(!release && !abiOnly) for(let i = 0; i < cases.length; i++) if(cases[i][2] === 0xA2) {
            for(const leaf of [1, 4, 0xFFFFFFFF]) for(const mutation of ["registers", "code", "context", "count"]) {
                let logs, events;
                const configure = () => {
                    reset(i, {leaf, subleaf: 2, start: 0xFFFFFFFE}); logs = 0; events = [];
                    observer = (pointer, length) => {
                        const message = new TextDecoder().decode(new Uint8Array(e.memory.buffer, pointer, length));
                        if(!message.startsWith("cpuid:")) return;
                        logs++;
                        events.push([message, cpu.instruction_pointer[0], words[664 >> 2], Array.from(cpu.reg32)]);
                        // Unknown leaves have two logs: the second must see
                        // the first callback's writes, as in the interpreter.
                        if(logs !== 1) return;
                        assert.equal(cpu.instruction_pointer[0], PC + cases[i][5]);
                        assert.equal(words[664 >> 2], 0xFFFFFFFF);
                        if(mutation === "registers") {
                            cpu.reg32[6] = 0x12345678; cpu.reg_xmm32s[31] = 0x76543210;
                            cpu.flags[0] = 0x402; cpu.flags_changed[0] = 0;
                        }
                        if(mutation === "code") mem[PC + cases[i][5]] = 0x90;
                        if(mutation === "context") { cpu.instruction_pointer[0] = 0x8800; cpu.segment_offsets[3] = 0x100; }
                        if(mutation === "count") words[664 >> 2] = 123;
                    };
                };
                configure(); e.ir_test_step(); words[664 >> 2]++; e.ir_test_step(); words[664 >> 2]++;
                const expected = state(), expectedEvents = events.slice(), expectedLogs = leaf === 0xFFFFFFFF ? 2 : 1;
                assert.equal(logs, expectedLogs);
                for(const opt of [0, 1]) {
                    configure(); instance(i, opt, 4).exports.f(0);
                    assert.equal(logs, expectedLogs); assert.deepEqual(events, expectedEvents);
                    assert.deepEqual(state(), expected, `CPUID observer ${i}/${opt}/${leaf}/${mutation}`);
                    observers++;
                }
                observer = undefined;
            }
        }
        let abiComparisons = 0;
        for(const kind of ["cr", "dr"]) for(let index = 0; index < 8; index++) {
            // Debug invalid-CR panics already have fresh-instance comparisons
            // above; this ABI matrix checks ordinary and guest-fault outcomes.
            if(!release && kind === "cr" && ![0, 2, 3, 4].includes(index)) continue;
            for(const cpl of [0, 3]) for(const de of kind === "dr" ? [false, true] : [false]) {
                const i = cases.findIndex(c => c[1] && c[2] === (kind === "cr" ? 0x20 : 0x21) && c[3] === index && c[4] === 0);
                const configure = () => {
                    reset(i, {cpl, de, start: 0xFFFFFFFF});
                    words[560 >> 2] = PC; cpu.instruction_pointer[0] = PC + cases[i][5];
                };
                configure(); const terminalOutcome = e[`ir_read_${kind}`](0, index), terminal = state();
                configure(); const continuingOutcome = e[`ir_read_${kind}_continue`](0, index), continuing = state();
                if(terminalOutcome === 4) {
                    assert.equal(continuingOutcome, 0); assert.equal(terminal.count, 0);
                    assert.equal(continuing.count, 0xFFFFFFFF);
                    continuing.count = terminal.count;
                }
                else {
                    assert.equal(terminalOutcome, 2); assert.equal(continuingOutcome, 2);
                    assert.equal(continuing.count, 0xFFFFFFFF, "a delivered fault must not retire");
                }
                assert.deepEqual(continuing, terminal, `direct ${kind}/${index}/${cpl}/${de}`);
                abiComparisons++;
            }
        }
        for(const leaf of [0, 1, 2, 4, 7, 0x80000000, 0xFFFFFFFF]) {
            const i = cases.findIndex(c => c[1] && c[2] === 0xA2);
            reset(i, {leaf, start: 0xFFFFFFFF}); assert.equal(e.ir_cpuid(), 4); const terminal = state();
            reset(i, {leaf, start: 0xFFFFFFFF}); const outcome = e.ir_cpuid_continue(), continuing = state();
            const canContinue = release || [0, 2, 0x80000000].includes(leaf);
            assert.equal(outcome, canContinue ? 0 : 4);
            assert.equal(terminal.count, 0); assert.equal(continuing.count, canContinue ? 0xFFFFFFFF : 0);
            continuing.count = terminal.count; assert.deepEqual(continuing, terminal);
            abiComparisons++;
        }
        console.log(`PASS (${release ? "release" : "debug"}): ${comparisons} system read continuation/fault/budget/counter-wrap comparisons, ${observers} CPUID observer comparisons, ${abiComparisons} terminal/continuing ABI comparisons`);
    }
    finally { observer = undefined; await vm.destroy(); }
}
