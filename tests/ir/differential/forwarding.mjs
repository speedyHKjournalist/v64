import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const cases = JSON.parse(fs.readFileSync("build/ir-forwarding/cases.json"));
const modules = cases.map((_, i) => [false, true].map(forward => {
    const bytes = fs.readFileSync(`build/ir-forwarding/${i}-${forward}.wasm`);
    assert(WebAssembly.validate(bytes));
    return new WebAssembly.Module(bytes);
}));
const loop_corpus = JSON.parse(fs.readFileSync("build/ir-forwarding/loops.json"));
const loop_modules = loop_corpus.cases.map((_, caseIndex) => new Map(
    loop_corpus.budgets.map(budget => [budget, [false, true].map(cached => {
        const bytes = fs.readFileSync(
            `build/ir-forwarding/loop-${caseIndex}-${budget}-${cached}.wasm`);
        assert(WebAssembly.validate(bytes));
        return new WebAssembly.Module(bytes);
    })])
));
const vm = new V86({wasm_path: "build/v86-ir-test.wasm", memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, mem = cpu.mem8;
    const words = new Uint32Array(cpu.wasm_memory.buffer);
    const view = new DataView(mem.buffer, mem.byteOffset);
    vm.run();
    const deadline = performance.now() + 10000;
    while(view.getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout");
        await sleep(1);
    }
    await vm.stop();
    const PC = 0x100000, STACK = 0x90000, HANDLER = 0x180000;
    const initial_cr0 = cpu.cr[0];
    const put = (address, value) => view.setUint32(address, value, true);
    const get = address => view.getUint32(address, true);
    let slow_reads = 0, events = [], mode = "ordinary", callbacks = 0;
    const imports = {...e, m: e.memory, ir_memory_read: (...args) => {
        slow_reads++;
        return e.ir_memory_read(...args);
    }};
    const instances = modules.map(pair => pair.map(module => new WebAssembly.Instance(module, {e: imports})));
    const loop_instances = loop_modules.map(byBudget => new Map(
        [...byBudget].map(([budget, pair]) => [
            budget,
            pair.map(module => new WebAssembly.Instance(module, {e: imports})),
        ])
    ));
    function reset(index, address, hot, fault = "none") {
        e.ir_test_set_cr0(initial_cr0 | 0x10000);
        cpu.segment_offsets.fill(0, 0, 6);
        cpu.segment_is_null.fill(0, 0, 6);
        cpu.reg32.set([0x12345678, 0x87654321, 0xABCDEF01, 0xFEDCBA98, STACK, 0x76543210, address, 0x11223344]);
        cpu.flags[0] = 3; cpu.flags_changed[0] = 0x8D4;
        words[96 >> 2] = 31; words[104 >> 2] = 0x7FFFFFFF; words[112 >> 2] = 0x80000000;
        cpu.instruction_pointer[0] = PC; cpu.in_hlt[0] = 0;
        cpu.cr[2] = 0; words[664 >> 2] = 100;
        mem.set(cases[index], PC);
        mem.fill(0xCC, STACK - 64, STACK);
        for(let n = -8; n < 16; n++) mem[address + n] = (n * 29 + 0x9B) & 255;
        mem.set([0x12, 0x34, 0x56, 0x78], 0x330040);
        cpu.idtr_offset[0] = 0x2000; cpu.idtr_size[0] = 0x7FF;
        for(const vector of [13, 14]) {
            put(0x2000 + vector * 8, (8 << 16) | (HANDLER & 65535));
            put(0x2004 + vector * 8, (HANDLER & 0xFFFF0000) | 0x8E00);
        }
        const page = address >>> 12;
        put(0x13000 + page * 4, page * 4096 | 3);
        put(0x13000 + (page + 1) * 4, (page + 1) * 4096 | 3);
        e.full_clear_tlb();
        mode = "ordinary"; callbacks = 0; events = [];
        if(hot) e.ir_memory_read(address, [1, 2, 4, 4][index]);
        if(fault === "missing") put(0x13000 + page * 4, 0);
        if(fault === "cross") put(0x13000 + (page + 1) * 4, 0);
        if(fault === "segment") cpu.segment_is_null[3] = 1;
        if(fault !== "none") e.full_clear_tlb();
        slow_reads = 0;
    }
    function snapshot(address) {
        return {gpr: Array.from(cpu.reg32, value => value >>> 0), flags: e.get_eflags() >>> 0,
            ip: cpu.instruction_pointer[0] >>> 0, cr2: cpu.cr[2] >>> 0,
            committed: words[664 >> 2], stack: Array.from(mem.slice(STACK - 64, STACK)),
            data: Array.from(mem.slice(address - 8, address + 16))};
    }
    function interpret(count) {
        // ir_test_step is the instruction body, not the outer CPU loop: account
        // successful retirements explicitly for an independent count oracle.
        for(let step = 0; step < count; step++) {
            e.ir_test_step();
            if(cpu.instruction_pointer[0] === HANDLER) break;
            words[664 >> 2]++;
        }
    }
    let ram = 0, fault_cases = 0, mmio = 0;
    for(let index = 0; index < cases.length; index++) {
        for(const address of [0x310040, 0x310FFC, 0x310FFD, 0x310FFF]) {
            for(const hot of [false, true]) for(const opt of [0, 1]) {
                reset(index, address, hot);
                instances[index][opt].exports.f(0);
                const actual = snapshot(address);
                assert.equal(actual.ip, PC + cases[index].length);
                assert.equal(actual.committed, 103);
                if(hot && address === 0x310040) assert.equal(slow_reads, 0);
                reset(index, address, hot);
                interpret(3);
                assert.deepEqual(actual, snapshot(address), `RAM width=${1 << index} hot=${hot} address=${address} opt=${opt}`);
                ram++;
            }
        }
        for(const fault of ["missing", "segment", ...(index === 0 ? [] : ["cross"])]) {
            const address = fault === "cross" ? 0x310FFF : 0x310040;
            for(const opt of [0, 1]) {
                reset(index, address, false, fault);
                instances[index][opt].exports.f(0);
                const actual = snapshot(address);
                assert.equal(actual.ip, HANDLER);
                assert.equal(actual.committed, 100, "faulting first read must not retire");
                assert.equal(get(STACK - 12), PC);
                reset(index, address, false, fault);
                interpret(1);
                assert.deepEqual(actual, snapshot(address));
                fault_cases++;
            }
        }
    }
    let budget_exits = 0;
    for(let index = 0; index < cases.length; index++) for(const budget of [1, 2, 3, 4, 8]) {
        const pair = [false, true].map(forward => {
            const module = new WebAssembly.Module(fs.readFileSync(
                `build/ir-forwarding/cfg-${index}-${budget}-${forward}.wasm`));
            return new WebAssembly.Instance(module, {e: imports});
        });
        for(const hot of [false, true]) {
            let expected;
            for(const instance of pair) {
                reset(index, 0x310040, hot);
                instance.exports.f(0);
                const actual = snapshot(0x310040), completed = actual.committed - 100;
                assert(completed >= 0 && completed <= 3);
                if(budget === 8) assert.equal(completed, 3);
                if(expected) assert.deepEqual(actual, expected, "read forwarding preserves exact merged-block budget exits");
                else expected = actual;
                reset(index, 0x310040, hot);
                interpret(completed);
                assert.deepEqual(actual, snapshot(0x310040));
                budget_exits++;
            }
        }
    }
    const observe = (kind, address) => {
        callbacks++;
        events.push({kind, address, gpr: Array.from(cpu.reg32),
            pc: cpu.instruction_pointer[0] >>> 0, flags: e.get_eflags() >>> 0});
        if(mode === "remap") {
            put(0x13000 + 0xA0 * 4, 0x330003);
            e.full_clear_tlb();
        } else if(mode === "unmap") {
            put(0x13000 + 0xA0 * 4, 0);
            e.full_clear_tlb();
        }
        // Repeated reads are observably different: a cached MMIO value is wrong.
        return (0x89ABC000 + callbacks * 17) | 0;
    };
    cpu.io.mmap_register(0xA0000, 0x20000,
        address => observe("r8", address) & 255, () => assert.fail("unexpected write"),
        address => observe("r32", address), () => assert.fail("unexpected write"));
    for(let index = 0; index < cases.length; index++) for(const callback_mode of ["ordinary", "remap", "unmap"]) {
        for(const opt of [0, 1]) {
            const configure = () => { reset(index, 0xA0040, false); mode = callback_mode; };
            configure();
            instances[index][opt].exports.f(0);
            const actual = snapshot(0xA0040), observed = events.slice();
            assert(slow_reads > 0, "MMIO must use observing slow reads");
            if(callback_mode === "ordinary") assert(callbacks >= 3, "every device read must occur");
            if(callback_mode === "unmap") {
                assert.equal(actual.ip, HANDLER, "second read sees callback-induced unmapping");
                assert.equal(actual.committed, 101);
                assert.equal(get(STACK - 12), PC + [2, 3, 2, 2][index]);
                fault_cases++;
            } else {
                assert.equal(actual.committed, 103);
            }
            configure();
            interpret(callback_mode === "unmap" ? 2 : 3);
            assert.deepEqual(actual, snapshot(0xA0040), `MMIO ${callback_mode} width=${1 << index} opt=${opt}`);
            assert.deepEqual(observed, events, "preserve callback order and observed architectural state");
            mmio++;
        }
    }
    // The loop-cache corpus keeps the first dynamic load at its original
    // fault point and reuses only a successful native-RAM result on later
    // iterations. Compare cache-disabled/cache-enabled modules against the
    // independent instruction-step interpreter across RAM, faults, callbacks
    // and exact budget exits.
    function reset_loop(case_index, count, hot = false, fault = "none") {
        const spec = loop_corpus.cases[case_index];
        reset(2, spec.address, hot, fault);
        mem.set(spec.bytes, PC);
        cpu.reg32[1] = count;
        slow_reads = 0;
        callbacks = 0;
        events = [];
    }
    let loop_ram = 0, loop_faults = 0, loop_mmio = 0, loop_budgets = 0;
    const full_budget_pair = loop_instances[0].get(64);
    for(const count of [1, 2, 4]) for(const hot of [false, true]) {
        let expected;
        for(const instance of full_budget_pair) {
            reset_loop(0, count, hot);
            instance.exports.f(0);
            const actual = snapshot(loop_corpus.cases[0].address);
            assert.equal(actual.ip, PC + loop_corpus.cases[0].bytes.length);
            assert.equal(actual.committed, 100 + 1 + 3 * count);
            if(expected) assert.deepEqual(actual, expected, "loop cache preserves RAM execution");
            else expected = actual;
            reset_loop(0, count, hot);
            interpret(1 + 3 * count);
            assert.deepEqual(actual, snapshot(loop_corpus.cases[0].address));
            loop_ram++;
        }
    }
    for(const instance of full_budget_pair) {
        reset_loop(0, 3, false, "missing");
        instance.exports.f(0);
        const actual = snapshot(loop_corpus.cases[0].address);
        assert.equal(actual.ip, HANDLER);
        assert.equal(actual.committed, 101, "NOP retires before the first faulting loop load");
        assert.equal(get(STACK - 12), PC + 1, "loop cache must not advance the first fault point");
        reset_loop(0, 3, false, "missing");
        interpret(2);
        assert.deepEqual(actual, snapshot(loop_corpus.cases[0].address));
        loop_faults++;
    }
    const mmio_pair = loop_instances[1].get(64);
    for(const callback_mode_local of ["ordinary", "remap", "unmap"]) {
        for(const instance of mmio_pair) {
            const configure = () => {
                reset_loop(1, 3, false);
                mode = callback_mode_local;
            };
            configure();
            instance.exports.f(0);
            const actual = snapshot(loop_corpus.cases[1].address);
            const observed = events.slice();
            if(callback_mode_local === "ordinary") {
                assert.equal(callbacks, 3, "MMIO loop loads may never become cache-valid");
                assert.equal(actual.committed, 110);
            } else if(callback_mode_local === "remap") {
                assert.equal(callbacks, 1, "only the first MMIO load precedes remapping to RAM");
                assert.equal(actual.committed, 110);
            } else {
                assert.equal(callbacks, 1);
                assert.equal(actual.ip, HANDLER, "second loop load sees callback-induced unmapping");
                assert.equal(actual.committed, 104);
                assert.equal(get(STACK - 12), PC + 1);
                loop_faults++;
            }
            configure();
            interpret(callback_mode_local === "unmap" ? 5 : 10);
            assert.deepEqual(actual, snapshot(loop_corpus.cases[1].address),
                `loop MMIO ${callback_mode_local} cache differential`);
            assert.deepEqual(observed, events, "loop cache preserves MMIO callback order/state");
            loop_mmio++;
        }
    }
    for(const budget of loop_corpus.budgets) {
        const pair = loop_instances[0].get(budget);
        let expected;
        for(const instance of pair) {
            reset_loop(0, 3, false);
            instance.exports.f(0);
            const actual = snapshot(loop_corpus.cases[0].address);
            const completed = actual.committed - 100;
            assert(completed >= 0 && completed <= 10);
            if(budget === 64) assert.equal(completed, 10);
            if(expected) assert.deepEqual(actual, expected,
                `loop cache preserves exact budget exit at budget=${budget}`);
            else expected = actual;
            reset_loop(0, 3, false);
            interpret(completed);
            assert.deepEqual(actual, snapshot(loop_corpus.cases[0].address));
            loop_budgets++;
        }
    }

    // A warmed supervisor mapping must still be checked at CPL3 before a chain
    // can obtain its first valid native-RAM result. No TSS is needed for this test.
    for(const opt of [0, 1]) {
        reset(2, 0x310040, true);
        const cpl = new Uint8Array(cpu.wasm_memory.buffer, 612, 1);
        const stop = new Error("permission slow path");
        const guarded = new WebAssembly.Instance(modules[2][opt], {e: {...imports,
            ir_memory_read: () => { throw stop; },
        }});
        cpl[0] = 3;
        try { assert.throws(() => guarded.exports.f(0), error => error === stop); }
        finally { cpl[0] = 0; }
    }
    console.log(`PASS: ${ram} guarded-read RAM differentials, ${fault_cases} real fault cases, ${mmio} MMIO/callback-remapping differentials, ${budget_exits} exact merged-block budget exits; loop cache ${loop_ram} RAM, ${loop_faults} fault, ${loop_mmio} MMIO/remap and ${loop_budgets} budget differentials; CPL guards passed`);
} finally {
    await vm.destroy();
}
