import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases = JSON.parse(fs.readFileSync("build/ir-memory/cases.json"));
const modules = cases.map((_, i) => [0, 1].map(opt => {
    const bytes = fs.readFileSync(`build/ir-memory/${i}-${opt}.wasm`);
    assert(WebAssembly.validate(bytes), `fixture ${i}/${opt} validates`);
    return new WebAssembly.Module(bytes);
}));
const vm = new V86({wasm_path: "build/v86-ir-test.wasm", memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
    await new Promise(r => vm.add_listener("emulator-loaded", r));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, mem = cpu.mem8, words = new Uint32Array(cpu.wasm_memory.buffer);
    vm.run(); const deadline = performance.now() + 10000;
    while(new DataView(mem.buffer, mem.byteOffset).getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout"); await sleep(1);
    }
    await vm.stop();
    const cmov_false = cases.findIndex(b => b[1] === 0x0F && b[2] === 0x41 && b[3] === 0x11);
    assert(cmov_false >= 0);
    const PC = 0x100000, HANDLER = 0x180000, STACK = 0x90000;
    const set32 = (a, v) => new DataView(mem.buffer, mem.byteOffset).setUint32(a, v, true);
    const get32 = a => new DataView(mem.buffer, mem.byteOffset).getUint32(a, true);
    const initial_cr0 = cpu.cr[0];
    let slow_reads = 0, slow_writes = 0, segment_faults = 0;
    const imports = {...e, m: e.memory,
        ir_rmw_read: (...args) => { slow_reads++; return e.ir_rmw_read(...args); },
        ir_rmw_write: (...args) => { slow_writes++; return e.ir_rmw_write(...args); },
        ir_memory_read: (...args) => { slow_reads++; return e.ir_memory_read(...args); },
        ir_memory_write: (...args) => { slow_writes++; return e.ir_memory_write(...args); },
        ir_segment_address: (...args) => { segment_faults++; return e.ir_segment_address(...args); },
    };
    const instances = modules.map(pair => pair.map(module => new WebAssembly.Instance(module, {e: imports})));
    function reset(i, address, hot, fault = "none", csBase = 0) {
        e.ir_test_set_cr0(initial_cr0 | 0x10000); // WP: supervisor writes respect read-only PTEs.
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_offsets[1] = csBase;
        cpu.segment_is_null.fill(0, 0, 6);
        const regs = [0x7FFFFFFF, address, 0x81ABFEDC, 0x12345678, STACK, 0x77777777, 3, 0x88888888];
        if(i === 13) { cpu.segment_offsets[4] = 0x2000; regs[1] = address - 0x2000; }
        if(i === 14) { regs[3] = 0xFF80; regs[6] = 0x90; cpu.segment_offsets[3] = address - 0x10; }
        if(i === 15) regs[1] = address - 0x7F - 12;
        cpu.reg32.set(regs);
        cpu.flags[0] = 3; cpu.flags_changed[0] = 0x8D4;
        words[96 >> 2] = 31; words[104 >> 2] = 0x7FFFFFFF; words[112 >> 2] = 0x80000000;
        cpu.instruction_pointer[0] = PC + csBase; cpu.in_hlt[0] = 0;
        words[664 >> 2] = 100;
        mem.set(cases[i], PC + csBase);
        for(let n = -8; n < 16; n++) mem[address + n] = n * 29 + 0x9B & 255;
        mem.fill(0xCC, STACK - 64, STACK);
        cpu.idtr_offset[0] = 0x2000; cpu.idtr_size[0] = 0x7FF;
        for(const vector of [13, 14]) {
            set32(0x2000 + vector * 8, (8 << 16) | (HANDLER & 65535));
            set32(0x2004 + vector * 8, (HANDLER & 0xFFFF0000) | 0x8E00);
        }
        const page = address >>> 12, next = page + 1;
        set32(0x13000 + page * 4, page * 4096 | 3);
        set32(0x13000 + next * 4, next * 4096 | 3);
        e.full_clear_tlb();
        if(hot) {
            // Prime writable permissions and D bits without changing the test bytes.
            e.ir_memory_write(address, mem[address], 1);
            e.ir_memory_write(address + 4, mem[address + 4], 1);
        }
        if(fault === "missing") set32(0x13000 + page * 4, 0);
        if(fault === "cross") set32(0x13000 + next * 4, 0);
        if(fault === "readonly") set32(0x13000 + page * 4, page * 4096 | 1);
        if(fault === "segment") cpu.segment_is_null[i === 13 ? 4 : 3] = 1;
        if(fault !== "none") e.full_clear_tlb();
        slow_reads = slow_writes = segment_faults = 0;
    }
    function snapshot(address) {
        return {regs: Array.from(cpu.reg32, x => x >>> 0), flags: e.get_eflags() >>> 0,
            ip: cpu.instruction_pointer[0] >>> 0, cr2: cpu.cr[2] >>> 0,
            data: Array.from(mem.slice(address - 8, address + 16)), stack: Array.from(mem.slice(STACK - 64, STACK))};
    }
    let total = 0, fast = 0, faults = 0;
    for(let i = 0; i < cases.length; i++) for(const address of [0x310040, 0x310FFD, 0x310FFF])
        for(const hot of [false, true]) for(const opt of [0, 1]) {
            reset(i, address, hot);
            instances[i][opt].exports.f(0);
            const actual = snapshot(address), executed = actual.ip === PC + cases[i].length - 1 ? 2 : 3;
            assert.equal(words[664 >> 2], 100 + executed, "CPU instruction accounting never double-counts materialization");
            if(hot && address === 0x310040) {
                assert.equal(slow_reads + slow_writes + segment_faults, 0, "warm same-page RAM uses native Wasm"); fast++;
            }
            assert(get32(0x13000 + (address >>> 12) * 4) & 0x20, "page-walk accessed bit");
            reset(i, address, hot);
            for(let step = 0; step < executed; step++) e.ir_test_step();
            assert.deepEqual(actual, snapshot(address), `RAM case ${i}, address ${address.toString(16)}, hot=${hot}, opt=${opt}`);
            total++;
        }
    for(const [i, fault, address] of [[0,"missing",0x310040], [0,"cross",0x310FFF],
        [3,"readonly",0x310040], [3,"cross",0x310FFF], [13,"segment",0x310040], [20,"readonly",0x310040], [20,"cross",0x310FFF], [cmov_false,"missing",0x310040]]) for(const opt of [0,1]) for(const cs_base of [0, 0x10000]) {
        reset(i, address, false, fault, cs_base);
        instances[i][opt].exports.f(0);
        const actual = snapshot(address);
        assert.equal(actual.ip, HANDLER, "real CPU exception delivered before return");
        assert.equal(words[664 >> 2], 101, "faulting instruction not committed");
        assert.equal(actual.regs[4], STACK - 16, "one exception frame, no duplicate delivery");
        assert.equal(get32(STACK - 12), PC + 1, "fault EIP points to MOV, after preceding INC");
        reset(i, address, false, fault, cs_base);
        e.ir_test_step(); e.ir_test_step();
        assert.deepEqual(actual, snapshot(address), `real fault ${fault}, opt=${opt}`);
        faults++;
    }
    let events = [], remap_during_read = false;
    const remap = () => { if(remap_during_read) { set32(0x13000 + 0xA0 * 4, 0x330003); e.full_clear_tlb(); } };
    const observe = (kind, address, value) => events.push({kind, address, value,
        eax: cpu.reg32[0] >>> 0, ip: cpu.instruction_pointer[0] >>> 0, flags: e.get_eflags() >>> 0});
    cpu.io.mmap_register(0xA0000, 0x20000,
        a => { observe("r8", a); remap(); return (a & 7) + 0x80; },
        (a,v) => observe("w8", a, v),
        a => { observe("r32", a); remap(); return 0x89ABCDEF | 0; },
        (a,v) => observe("w32", a, v >>> 0));
    let mmio = 0;
    for(let i = 0; i < cases.length; i++) for(const opt of [0,1]) {
        reset(i, 0xA0040, false); events = [];
        instances[i][opt].exports.f(0);
        const actual = snapshot(0xA0040), observed = events.slice();
        const executed = actual.ip === PC + cases[i].length - 1 ? 2 : 3;
        assert(slow_reads + slow_writes > 0, "MMIO must take an observing slow path");
        reset(i, 0xA0040, false); events = [];
        for(let step = 0; step < executed; step++) e.ir_test_step();
        assert.deepEqual(actual, snapshot(0xA0040), "MMIO CPU state differential");
        assert.deepEqual(observed, events, "MMIO callback order, width, value, FLAGS and EIP observation");
        mmio++;
    }
    for(const opt of [0,1]) {
        reset(20, 0xA0040, false); events = []; remap_during_read = true;
        const untouched = Array.from(mem.slice(0x330040, 0x330044));
        instances[20][opt].exports.f(0);
        const actual = snapshot(0xA0040), observed = events.slice();
        assert.deepEqual(events.map(e => e.kind), ["r32", "w32"], "RMW write keeps its pretranslated MMIO address after remapping");
        assert.deepEqual(Array.from(mem.slice(0x330040, 0x330044)), untouched);
        reset(20, 0xA0040, false); events = [];
        e.ir_test_step(); e.ir_test_step();
        assert.deepEqual(observed, events);
        assert.deepEqual(actual, snapshot(0xA0040));
        remap_during_read = false;
    }
    for(const opt of [0,1]) {
        const configure = () => {
            reset(20, 0x310FFF, false);
            set32(0x13000 + 0x311 * 4, 0x330003);
            mem.set([0x12,0x34,0x56], 0x330000); e.full_clear_tlb();
        };
        configure(); instances[20][opt].exports.f(0);
        const actual = snapshot(0x310FFF), high = Array.from(mem.slice(0x330000, 0x330003));
        configure(); e.ir_test_step(); e.ir_test_step();
        assert.deepEqual(actual, snapshot(0x310FFF), "RMW noncontiguous physical pages");
        assert.deepEqual(high, Array.from(mem.slice(0x330000, 0x330003)));
    }
    for(const [fault, address] of [["readonly", 0xA0040], ["cross", 0xA0FFF]]) for(const opt of [0,1]) {
        reset(20, address, false, fault); events = [];
        instances[20][opt].exports.f(0);
        const actual = snapshot(address);
        assert.equal(actual.ip, HANDLER);
        assert.deepEqual(events, [], "RMW validates every write page before any MMIO read");
        reset(20, address, false, fault); events = [];
        e.ir_test_step(); e.ir_test_step();
        assert.deepEqual(actual, snapshot(address), "RMW denied device access matches interpreter");
        assert.deepEqual(events, []);
        faults++;
    }
    for(const opt of [0,1]) {
        reset(3, 0x310040, false);
        const last = cases[3].length - 1, alias = 0x800000 + last;
        set32(0x15000, 0x100003); e.full_clear_tlb();
        e.ir_memory_write(alias, mem[PC + last], 1);
        cpu.reg32[1] = alias; slow_writes = 0;
        const old_ebx = cpu.reg32[3];
        instances[3][opt].exports.f(0);
        assert.equal(slow_writes, 0, "self-modifying alias takes native store then exit");
        assert.equal(cpu.instruction_pointer[0], PC + last, "never execute stale instructions after a store");
        assert.equal(cpu.reg32[3], old_ebx, "following INC has not executed");
        assert.equal(get32(PC + last), 0x81ABFEDC);
    }
    // A cached supervisor translation must not become a CPL3 RAM fast path.
    // Stop at the slow-path boundary so this check does not need a ring-transition TSS.
    reset(0, 0x310040, true);
    const cpl = new Uint8Array(cpu.wasm_memory.buffer, 612, 1);
    cpl[0] = 3;
    const guard_stop = new Error("user permission slow path");
    const guarded = new WebAssembly.Instance(modules[0][0], {e: {...imports,
        ir_memory_read: () => { throw guard_stop; },
    }});
    try { assert.throws(() => guarded.exports.f(0), e => e === guard_stop); }
    finally { cpl[0] = 0; }
    // Non-zero CS base exercises GuestEip -> linear CPU IP conversion on successful exits.
    for(const opt of [0,1]) {
        reset(0, 0x310040, true, "none", 0x10000);
        instances[0][opt].exports.f(0);
        assert.equal(cpu.instruction_pointer[0], PC + 0x10000 + cases[0].length);
    }
    console.log(`PASS: ${total} real-CPU integer memory differential cases, ${fast} native warm RAM paths, ${faults} real #PF/#GP cases, ${mmio} MMIO cases, remapped/noncontiguous RMW tickets, self-modifying aliases, CS-relative exits, lazy FLAGS and instruction accounting`);
} finally { await vm.destroy(); }
