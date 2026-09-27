import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const PC = 0x100000;
const CODE_PAGE = PC & ~4095;
const HANDLER = 0x180000;
const STACK = 0x90000;
const DATA = 0x310040;
const MISSING = 0x320040;
const programs = {
    continue: Uint8Array.from([0x88, 0x11, 0x43]),
    rmw_continue: Uint8Array.from([0xFF, 0x01, 0x43]),
    rmw_fault: Uint8Array.from([0xFF, 0x01, 0x8B, 0x06]),
    fault_after: Uint8Array.from([0x88, 0x11, 0x8B, 0x06]),
    store_load: Uint8Array.from([0x88, 0x11, 0x8A, 0x19]),
    rmw_load8: Uint8Array.from([0xFE, 0x01, 0x8A, 0x19]),
    rmw_load16: Uint8Array.from([0x66, 0xFF, 0x01, 0x66, 0x8B, 0x19]),
    rmw_load32: Uint8Array.from([0xFF, 0x01, 0x8B, 0x19]),
};
const modules = Object.fromEntries(Object.keys(programs).map(name => [
    name,
    [0, 1, 2, 3].map(opt => {
        const bytes = fs.readFileSync(`build/ir-store-continuation/${name}-${opt}.wasm`);
        assert(WebAssembly.validate(bytes), `${name}/${opt} validates`);
        return new WebAssembly.Module(bytes);
    }),
]));

const vm = new V86({
    wasm_path: process.argv[2] || "build/v86-ir-test.wasm",
    memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    net_device: {type: "none"},
    autostart: false,
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu;
    const e = cpu.wm.exports;
    const mem = cpu.mem8;
    const view = new DataView(mem.buffer, mem.byteOffset);
    const words = new Uint32Array(cpu.wasm_memory.buffer);
    vm.run();
    const deadline = performance.now() + 10000;
    while(view.getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout");
        await sleep(1);
    }
    await vm.stop();

    const set32 = (address, value) => view.setUint32(address, value >>> 0, true);
    const get32 = address => view.getUint32(address, true);
    const initial_cr0 = cpu.cr[0];
    let slow_reads = 0;
    let slow_writes = 0;
    const imports = {
        ...e,
        m: e.memory,
        ir_memory_read: (...args) => {
            slow_reads++;
            return e.ir_memory_read(...args);
        },
        ir_memory_write: (...args) => {
            slow_writes++;
            return e.ir_memory_write(...args);
        },
    };
    const instances = Object.fromEntries(Object.entries(modules).map(([name, pair]) => [
        name,
        pair.map(module => new WebAssembly.Instance(module, {e: imports})),
    ]));

    function map_identity(address) {
        const page = address >>> 12;
        set32(0x13000 + page * 4, page * 4096 | 3);
    }
    function reset(name, dataAddress = DATA, loadAddress = MISSING) {
        e.ir_test_set_cr0(initial_cr0 | 0x10000); // CR0.WP: supervisor honours read-only PTEs.
        cpu.segment_offsets.fill(0, 0, 6);
        cpu.segment_is_null.fill(0, 0, 6);
        cpu.reg32.set([
            0x7FFFFFFF,
            dataAddress,
            0x81ABFE90,
            0x12345678,
            STACK,
            0x77777777,
            loadAddress,
            0x88888888,
        ]);
        cpu.flags[0] = 3;
        cpu.flags_changed[0] = 0x8D4;
        words[96 >> 2] = 31;
        words[104 >> 2] = 0x7FFFFFFF;
        words[112 >> 2] = 0x80000000;
        cpu.instruction_pointer[0] = PC;
        cpu.in_hlt[0] = 0;
        words[664 >> 2] = 100;
        mem.set(programs[name], PC);
        mem[dataAddress] = 0x5A;
        mem.fill(0xCC, STACK - 64, STACK);
        cpu.idtr_offset[0] = 0x2000;
        cpu.idtr_size[0] = 0x7FF;
        for(const vector of [13, 14]) {
            set32(0x2000 + vector * 8, (8 << 16) | (HANDLER & 0xFFFF));
            set32(0x2004 + vector * 8, (HANDLER & 0xFFFF0000) | 0x8E00);
        }
        map_identity(dataAddress);
        map_identity(loadAddress);
        e.full_clear_tlb();
        slow_reads = 0;
        slow_writes = 0;
    }
    function prime_write(address) {
        e.ir_memory_write(address, mem[address], 1);
        slow_reads = 0;
        slow_writes = 0;
    }

    let fast_continuations = 0;
    let store_load_runs = 0;
    let slow_exits = 0;
    let alias_exits = 0;
    let precise_faults = 0;
    let rmw_forward_runs = 0;
    const snapshot = address => ({gpr:Array.from(cpu.reg32), flags:e.get_eflags(), ip:cpu.instruction_pointer[0],
        cr2:cpu.cr[2], bytes:Array.from(mem.slice(address,address+8)),frame:Array.from(mem.slice(STACK-32,STACK))});
    for(const name of ["rmw_load8","rmw_load16","rmw_load32"]) for(const opt of [0,1,2,3])
    for(const address of [DATA, (DATA&~4095)+4095, PC+programs[name].length-1]) for(const hot of [false,true]) {
        reset(name,address); map_identity(address+4); if(hot)prime_write(address);
        instances[name][opt].exports.f(0); const actual=snapshot(address),steps=(words[664>>2]-100)>>>0;
        assert(steps===1||steps===2);
        reset(name,address); map_identity(address+4); if(hot)prime_write(address);
        for(let n=0;n<steps;n++)e.ir_test_step();
        assert.deepEqual(actual,snapshot(address),`${name}/${opt}/${address}/${hot}: committed RMW forwarding`);
        rmw_forward_runs++;
    }
    for(const name of ["rmw_load8","rmw_load16","rmw_load32"]) for(const opt of [0,1,2,3])
    for(const fault of ["readonly","second_page"]) {
        if(name === "rmw_load8" && fault === "second_page") continue;
        const address = fault === "readonly" ? DATA : (DATA&~4095)+4095;
        const prepare_fault = () => {
            reset(name,address); map_identity(address+4);
            const page = (address >>> 12) + (fault === "second_page" ? 1 : 0);
            set32(0x13000+page*4, fault === "second_page" ? 0 : page*4096|1);
            e.full_clear_tlb();
        };
        prepare_fault(); instances[name][opt].exports.f(0);
        assert.equal(words[664>>2],100,"faulting RMW must not retire or seed a following load");
        const actual=snapshot(address);prepare_fault();e.ir_test_step();
        assert.deepEqual(actual,snapshot(address),`${name}/${opt}/${fault}: first write-permission fault`);
        rmw_forward_runs++;
    }
    let io_events = [];
    const observer_read = (address,bytes) => {io_events.push(["read",address,bytes]);mem[PC+programs.rmw_load8.length-1]=0xCC;return bytes===1?0x7F:0x7FFFFFFF;};
    cpu.io.mmap_register(0xA0000,0x20000,address=>observer_read(address,1),(address,value)=>io_events.push(["write",address,value]),
        address=>observer_read(address,4),(address,value)=>io_events.push(["write",address,value]));
    for(const name of ["rmw_load8","rmw_load16","rmw_load32"]) for(const opt of [0,1,2,3]) {
        reset(name,0xA0000);io_events=[];instances[name][opt].exports.f(0);
        assert.equal(words[664>>2],101,"MMIO RMW returns after its one commit");
        const actual=snapshot(0xA0000),events=io_events;reset(name,0xA0000);io_events=[];e.ir_test_step();
        assert.deepEqual(actual,snapshot(0xA0000));assert.deepEqual(events,io_events,"MMIO callbacks and raw code mutation preserve ordering");
        rmw_forward_runs++;
    }
    console.log(`PASS: ${rmw_forward_runs} RMW forwarding comparisons: narrow/wide, cold/warm, page crossing, write faults, code aliases and MMIO callback mutation`);
    for(const opt of [0, 1, 2, 3]) {
        reset("rmw_continue"); prime_write(DATA);
        const before_rmw = get32(DATA);
        instances.rmw_continue[opt].exports.f(0);
        assert.equal(get32(DATA), (before_rmw + 1) >>> 0);
        assert.equal(cpu.reg32[3] >>> 0, 0x12345679, "native RMW continues with carried flags/state");
        assert.equal(words[664 >> 2], 102);
        assert.equal(cpu.instruction_pointer[0] >>> 0, PC + 3);

        reset("rmw_continue");
        instances.rmw_continue[opt].exports.f(0);
        assert.equal(cpu.reg32[3] >>> 0, 0x12345678, "cold RMW remains an observing exit");
        assert.equal(words[664 >> 2], 101);

        reset("rmw_continue");
        const rmw_alias = 0x800000 + 2;
        set32(0x13000 + (rmw_alias >>> 12) * 4, CODE_PAGE | 3);
        e.full_clear_tlb(); e.ir_memory_write(rmw_alias, get32(PC + 2), 4);
        cpu.reg32[1] = rmw_alias;
        instances.rmw_continue[opt].exports.f(0);
        assert.equal(mem[PC + 2], 0x44);
        assert.equal(cpu.reg32[3] >>> 0, 0x12345678, "RMW alias cannot execute stale next instruction");
        assert.equal(words[664 >> 2], 101);

        reset("rmw_fault");
        set32(0x13000 + (MISSING >>> 12) * 4, 0); e.full_clear_tlb(); prime_write(DATA);
        const before_fault = get32(DATA);
        instances.rmw_fault[opt].exports.f(0);
        assert.equal(get32(DATA), (before_fault + 1) >>> 0);
        assert.equal(cpu.instruction_pointer[0] >>> 0, HANDLER);
        assert.equal(get32(STACK - 12), PC + 2);
        assert.equal(words[664 >> 2], 101, "RMW commits once before following #PF");

        reset("continue");
        prime_write(DATA);
        instances.continue[opt].exports.f(0);
        assert.equal(slow_writes, 0, "warm same-page RAM store stays native");
        assert.equal(mem[DATA], 0x90, "native byte store is visible");
        assert.equal(cpu.reg32[3] >>> 0, 0x12345679, "instruction after safe store executes");
        assert.equal(cpu.instruction_pointer[0] >>> 0, PC + programs.continue.length);
        assert.equal(words[664 >> 2], 102, "continued store and following instruction commit once");
        fast_continuations++;

        reset("store_load");
        prime_write(DATA);
        instances.store_load[opt].exports.f(0);
        assert.equal(slow_writes, 0, "store-load case keeps the store on native RAM");
        assert.equal(slow_reads, 0, "same-address load does not fall back to the CPU slow path");
        assert.equal(mem[DATA], 0x90, "store-load case commits the written byte");
        assert.equal(cpu.reg32[3] >>> 0, 0x12345690, "following byte load observes the stored value");
        assert.equal(cpu.instruction_pointer[0] >>> 0, PC + programs.store_load.length);
        assert.equal(words[664 >> 2], 102, "store and forwarded load retire exactly once each");
        store_load_runs++;

        reset("continue");
        instances.continue[opt].exports.f(0);
        assert.equal(slow_writes, 1, "cold translation keeps the observing slow path");
        assert.equal(cpu.reg32[3] >>> 0, 0x12345678, "slow-path success exits before following instruction");
        assert.equal(cpu.instruction_pointer[0] >>> 0, PC + 2);
        assert.equal(words[664 >> 2], 101);
        slow_exits++;

        reset("continue");
        const alias = 0x800000 + 2;
        set32(0x13000 + (alias >>> 12) * 4, CODE_PAGE | 3);
        e.full_clear_tlb();
        e.ir_memory_write(alias, mem[PC + 2], 1); // Prime the alias without changing code.
        cpu.reg32[1] = alias;
        slow_writes = 0;
        instances.continue[opt].exports.f(0);
        assert.equal(slow_writes, 0, "physical code alias still takes the native store");
        assert.equal(mem[PC + 2], 0x90, "alias store modifies the current code page");
        assert.equal(cpu.instruction_pointer[0] >>> 0, PC + 2, "current code dependency forces exit");
        assert.equal(cpu.reg32[3] >>> 0, 0x12345678, "stale following byte is never executed");
        assert.equal(words[664 >> 2], 101);
        alias_exits++;

        reset("fault_after");
        set32(0x13000 + (MISSING >>> 12) * 4, 0);
        e.full_clear_tlb();
        prime_write(DATA);
        instances.fault_after[opt].exports.f(0);
        assert.equal(slow_writes, 0, "preceding store remains on its native fast path");
        assert(slow_reads > 0, "following missing-page load reaches the CPU slow path");
        assert.equal(mem[DATA], 0x90, "completed store survives the later fault");
        assert.equal(cpu.instruction_pointer[0] >>> 0, HANDLER, "#PF is delivered before IR return");
        assert.equal(cpu.reg32[4] >>> 0, STACK - 16, "one page-fault frame is pushed");
        assert.equal(get32(STACK - 12), PC + 2, "fault EIP points at the instruction after the store");
        assert.equal(words[664 >> 2], 101, "faulting instruction is not committed");
        precise_faults++;
    }

    console.log(
        `PASS: ${fast_continuations} guarded fast-store continuations, ${store_load_runs} store-load runs, ` +
        `${slow_exits} slow-path exits, ${alias_exits} physical-code-alias exits, ` +
        `${precise_faults} precise post-store faults`,
    );
} finally {
    await vm.destroy();
}
