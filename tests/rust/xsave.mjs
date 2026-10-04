// The XSAVE feature set in the 32-bit engines (docs/simd-xsave-plan.md P2):
// CPUID leaves 1 and 0xD, CR4.OSXSAVE, XGETBV/XSETBV, XSAVE/XRSTOR in the
// standard format (round trips, partial saves, init on restore, the header
// and MXCSR checks, the fault order and page faults without partial effects)
// and FXSAVE/FXRSTOR, which share the state encoding (cpu/xstate.rs). Each
// case runs in the interpreter, then hot under Tier-0 and the region tiers.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x210000, FAULT = 0x211000, SKIP = 0x211100;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000;
// XSAVE areas (64-byte aligned); CROSSING's YMM_Hi128 starts on the next page
const AREA = 0x202000, AREA2 = 0x203000, AREA3 = 0x204000, CROSSING = 0x205DC0, ABSENT = 0x206000;

const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

// instructions
const mov_eax = n => [0xB8, ...u32(n)], mov_ecx = n => [0xB9, ...u32(n)], mov_edx = n => [0xBA, ...u32(n)], mov_ebx = n => [0xBB, ...u32(n)];
const store_eax = a => [0xA3, ...u32(a)], store_ebx = a => [0x89, 0x1D, ...u32(a)];
const store_ecx = a => [0x89, 0x0D, ...u32(a)], store_edx = a => [0x89, 0x15, ...u32(a)];
const cpuid = (leaf, subleaf, out) => [...mov_eax(leaf), ...mov_ecx(subleaf), 0x0F, 0xA2,
    ...store_eax(out), ...store_ebx(out + 4), ...store_ecx(out + 8), ...store_edx(out + 12)];
const OSXSAVE = [0x0F, 0x20, 0xE0, 0x0D, ...u32(1 << 18), 0x0F, 0x22, 0xE0];          // CR4 |= OSXSAVE
const NO_OSXSAVE = [0x0F, 0x20, 0xE0, 0x25, ...u32(~(1 << 18) >>> 0), 0x0F, 0x22, 0xE0];
// SSE enabled (CR4.OSFXSR, OSXMMEXCPT: the BIOS leaves them clear)
const ENABLE_SSE = [0x0F, 0x20, 0xE0, 0x0D, ...u32(0x600), 0x0F, 0x22, 0xE0];
const SET_TS = [0x0F, 0x20, 0xC0, 0x0D, ...u32(8), 0x0F, 0x22, 0xC0], CLTS = [0x0F, 0x06];
const XGETBV = [0x0F, 0x01, 0xD0], XSETBV = [0x0F, 0x01, 0xD1];
const xsetbv = value => [...mov_ecx(0), ...mov_eax(value), ...mov_edx(0), ...XSETBV];
const XSAVE = [0x0F, 0xAE, 0x23], XRSTOR = [0x0F, 0xAE, 0x2B];                        // [ebx]
const FXSAVE = [0x0F, 0xAE, 0x03], FXRSTOR = [0x0F, 0xAE, 0x0B];
const ALL = [...mov_eax(-1), ...mov_edx(-1)];
const fld = a => [0xDD, 0x05, ...u32(a)], fstp = a => [0xDD, 0x1D, ...u32(a)], FNINIT = [0xDB, 0xE3];
const fnstcw = a => [0xD9, 0x3D, ...u32(a)];
const movups_load = (r, a) => [0x0F, 0x10, 5 | r << 3, ...u32(a)], movups_store = (r, a) => [0x0F, 0x11, 5 | r << 3, ...u32(a)];
const ldmxcsr = a => [0x0F, 0xAE, 0x15, ...u32(a)], stmxcsr = a => [0x0F, 0xAE, 0x1D, ...u32(a)];
const XORPS_0_7 = [0x0F, 0x57, 0xC0, 0x0F, 0x57, 0xFF];

const machines = [];
// The start of every program: a known CR0.TS, CR4.OSXSAVE and XCR0 (a warm
// run stops anywhere in its loop)
let preamble = [];
async function run(vm, program, warm = true, interpreter = false)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    vm.write_memory(Uint8Array.from(program), CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 20000;
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && compiled_activations(e) === start)
    {
        assert(performance.now() < deadline, "program/JIT timeout");
        await sleep(1);
    }
    if(warm) await sleep(20);
    await vm.stop();
}
// the body repeats until byte 0x604 is set, then halts after one more round
function loop(body)
{
    const p = [...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}
/** A handler for `vector`: records it, the faulting EIP, CR2 and the error code, and skips [SKIP] bytes */
function handler(vector, error_code)
{
    const p = [];
    if(error_code) p.push(0x58, ...store_eax(FAULT + 12));            // pop eax: the error code
    p.push(0xC7, 0x05, ...u32(FAULT), ...u32(vector));
    p.push(0x8B, 0x04, 0x24, ...store_eax(FAULT + 4));                // [esp]: EIP
    p.push(0x0F, 0x20, 0xD0, ...store_eax(FAULT + 8));                // CR2
    p.push(0xA1, ...u32(SKIP), 0x01, 0x04, 0x24, 0xCF);               // add [esp], [SKIP]; iret
    return p;
}
const VECTORS = [[6, false], [7, false], [13, true], [14, true]];
async function run_all(program, before = () => {}, set = machines)
{
    for(const vm of set)
    {
        vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
        VECTORS.forEach(([vector, error_code], i) => {
            const h = HANDLER + i * 0x100;
            vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
            vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
        });
        // (the program first loads the IDT)
        const p = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...ENABLE_SSE, ...preamble, ...program];
        for(const warm of [true, false])
        {
            before(vm);
            vm.write_memory(new Uint8Array(16), FAULT);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            await run(vm, loop(p), warm, vm === set[0]);
        }
    }
}
/** The interpreter, then Tier-0 and the region tiers, with `options` */
async function create_machines(options = {})
{
    const set = [];
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            ...arm, ...options, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        set.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
    }
    return set;
}
/**
 * `faulting` raises `vector` at its first byte after `prologue` (the
 * handler skips it, `epilogue` follows), with CR2 `cr2` for a page fault
 */
async function expect_fault(set, prologue, faulting, vector, { epilogue = [], before = () => {}, cr2, label } = {})
{
    // (the IDT load, SSE and the preamble come first)
    const at = CODE + 7 + ENABLE_SSE.length + preamble.length + prologue.length;
    await run_all([...prologue, ...faulting, ...epilogue], vm => {
        vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
        before(vm);
    }, set);
    for(const vm of set)
    {
        const name = label || faulting.map(b => b.toString(16)).join(" ");
        assert.deepEqual([word(vm, FAULT), word(vm, FAULT + 4)], [vector, at], `${name}: vector, EIP`);
        if(cr2 !== undefined) assert.equal(word(vm, FAULT + 8), cr2, `${name}: CR2`);
    }
}
/** No fault */
function no_fault(set, name)
{
    for(const vm of set) assert.equal(word(vm, FAULT), 0, `${name}: fault ${word(vm, FAULT)} at ${word(vm, FAULT + 4).toString(16)}`);
}
const fill = (vm, a, n, byte) => vm.write_memory(new Uint8Array(n).fill(byte), a);
/** A pattern-filled area whose header (bytes 512-575) is 0 but XSTATE_BV */
function prepare(vm, a, xstate_bv = 0)
{
    fill(vm, a, 832, 0xCC);
    vm.write_memory(new Uint8Array(64), a + 512);
    vm.write_memory(Uint8Array.from(u32(xstate_bv)), a + 512);
}
const pages = (vm, page, present) => {
    // (the BIOS's page table: 0x13000, identity)
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};

let count = 0;
try
{
    // Without XSAVE: no CPUID bits, CR4.OSXSAVE is reserved, the instructions #UD
    machines.push(...await create_machines());
    preamble = CLTS;
    await run_all(cpuid(1, 0, OUT));
    for(const vm of machines) assert.equal(word(vm, OUT + 8) & 3 << 26, 0, "CPUID.1:ECX XSAVE, OSXSAVE");
    await expect_fault(machines, OSXSAVE.slice(0, -3), OSXSAVE.slice(-3), 13, { label: "MOV CR4 with OSXSAVE" });
    for(const [instruction, label] of [[XGETBV, "XGETBV"], [XSETBV, "XSETBV"], [[...mov_ebx(AREA), ...XSAVE], "XSAVE"]])
    {
        const prologue = instruction.length > 3 ? instruction.slice(0, -3) : [];
        await expect_fault(machines, prologue, instruction.slice(-3), 6, { label: label + " without XSAVE" });
    }
    count += 5;
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: without XSAVE, CPUID reports none, CR4.OSXSAVE is reserved, XGETBV/XSETBV/XSAVE #UD");

    // XSAVE without AVX: XCR0 can have x87 and SSE state
    machines.push(...await create_machines({ cpu_features: ["XSAVE"] }));
    preamble = [...CLTS, ...OSXSAVE, ...xsetbv(1), ...NO_OSXSAVE];
    await run_all([...cpuid(1, 0, OUT), ...OSXSAVE, ...cpuid(1, 0, OUT + 16), ...cpuid(0xD, 0, OUT + 32),
        ...cpuid(0xD, 1, OUT + 48), ...cpuid(0xD, 2, OUT + 64), ...mov_ecx(0), ...XGETBV, ...store_eax(OUT + 80), ...store_edx(OUT + 84),
        ...xsetbv(3), ...mov_ecx(0), ...XGETBV, ...store_eax(OUT + 88), ...cpuid(0xD, 0, OUT + 96), ...xsetbv(1), ...NO_OSXSAVE]);
    for(const vm of machines)
    {
        assert.equal(word(vm, OUT + 8) >>> 26 & 3, 1, "CPUID.1:ECX: XSAVE, without OSXSAVE");
        assert.equal(word(vm, OUT + 24) >>> 26 & 3, 3, "CPUID.1:ECX: XSAVE, OSXSAVE");
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + 32 + i)), [3, 576, 576, 0], "CPUID.0xD.0");
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + 48 + i)), [0, 0, 0, 0], "CPUID.0xD.1");
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + 64 + i)), [0, 0, 0, 0], "CPUID.0xD.2");
        assert.deepEqual([word(vm, OUT + 80), word(vm, OUT + 84), word(vm, OUT + 88)], [1, 0, 3], "XGETBV: XCR0 1 at reset, 3 after XSETBV");
        assert.equal(word(vm, OUT + 100), 576, "CPUID.0xD.0:EBX with XCR0 3");
    }
    count += 9;
    // XSETBV's checks: XCR0 only, x87 always, supported bits only; XGETBV
    // of XCR 1 needs XGETBV1; no mandatory prefix; LOCK
    for(const [ecx, value] of [[0, 0], [0, 2], [0, 7], [0, 5], [1, 3], [0, 0x100003]])
    {
        await expect_fault(machines, [...OSXSAVE, ...mov_ecx(ecx), ...mov_eax(value), ...mov_edx(0)], XSETBV, 13,
            { epilogue: NO_OSXSAVE, label: `XSETBV ${ecx}, ${value.toString(16)}` });
    }
    await expect_fault(machines, [...OSXSAVE, ...mov_ecx(1)], XGETBV, 13, { epilogue: NO_OSXSAVE, label: "XGETBV 1" });
    for(const prefix of [0x66, 0xF2, 0xF3, 0xF0])
    {
        await expect_fault(machines, [...OSXSAVE, ...mov_ecx(0)], [prefix, ...XGETBV], 6, { epilogue: NO_OSXSAVE, label: `${prefix.toString(16)} XGETBV` });
        await expect_fault(machines, [...OSXSAVE, ...mov_ebx(AREA)], [prefix, ...XSAVE], 6, { epilogue: NO_OSXSAVE, label: `${prefix.toString(16)} XSAVE` });
    }
    count += 15;
    console.log("PASS: CPUID 1 and 0xD, XGETBV/XSETBV and their #GP/#UD cases with XSAVE (XCR0 x87|SSE)");

    // XSAVE and XRSTOR: a round trip of x87, MMX/XMM and MXCSR state; a
    // partial save; init on restore; FXSAVE's layout matches XSAVE's
    const constants = new Float64Array([1.5, -2.25]);
    const xmm = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3);
    const setup = vm => {
        vm.write_memory(new Uint8Array(constants.buffer), DATA);
        vm.write_memory(xmm, DATA + 16);
        vm.write_memory(Uint8Array.from(u32(0x1FA0)), DATA + 48);
        vm.write_memory(Uint8Array.from(u32(0x1F80)), DATA + 52);
        prepare(vm, AREA);
        prepare(vm, AREA2, 1);
        prepare(vm, AREA3);
        vm.write_memory(Uint8Array.from(u32(0x1F80)), AREA3 + 24);
        fill(vm, AREA3 + 160, 16, 0x55);
        prepare(vm, AREA + 0x800);
    };
    const state = [...FNINIT, ...fld(DATA), ...fld(DATA + 8), ...movups_load(0, DATA + 16), ...movups_load(7, DATA + 32), ...ldmxcsr(DATA + 48)];
    await run_all([...OSXSAVE, ...xsetbv(3), ...state,
        ...mov_ebx(AREA), ...ALL, ...XSAVE,
        ...mov_ebx(AREA + 0x800), ...FXSAVE,
        ...mov_ebx(AREA2), ...mov_eax(2), ...mov_edx(0), ...XSAVE,
        ...FNINIT, ...XORPS_0_7, ...ldmxcsr(DATA + 52),
        ...mov_ebx(AREA), ...ALL, ...XRSTOR,
        ...fstp(OUT), ...fstp(OUT + 8), ...movups_store(0, OUT + 16), ...movups_store(7, OUT + 32), ...stmxcsr(OUT + 48),
        // init: XSTATE_BV 0, MXCSR from memory (RFBM[1])
        ...mov_ebx(AREA3), ...mov_eax(3), ...mov_edx(0), ...XRSTOR,
        ...fnstcw(OUT + 64), ...movups_store(0, OUT + 80), ...stmxcsr(OUT + 96),
        ...xsetbv(1), ...NO_OSXSAVE], setup);
    no_fault(machines, "XSAVE/XRSTOR round trip");
    for(const vm of machines)
    {
        assert.deepEqual(new Float64Array(bytes(vm, OUT, 16).buffer), Float64Array.of(-2.25, 1.5), "x87 after XRSTOR");
        assert.deepEqual(bytes(vm, OUT + 16, 32), xmm, "XMM0, XMM7 after XRSTOR");
        assert.equal(word(vm, OUT + 48), 0x1FA0, "MXCSR after XRSTOR");
        const area = bytes(vm, AREA, 832);
        const view = new DataView(area.buffer);
        assert.deepEqual([view.getUint16(0, true), view.getUint32(24, true), view.getUint32(28, true)], [0x37F, 0x1FA0, 0xFFFF], "FCW, MXCSR, MXCSR_MASK");
        assert.equal(area[4], 0xC0, "abridged FTW: two registers in use");
        assert.deepEqual(area.subarray(160, 176), xmm.subarray(0, 16), "XMM0 at 160");
        assert.deepEqual(area.subarray(272, 288), xmm.subarray(16, 32), "XMM7 at 272");
        assert.ok(area.subarray(288, 512).every(b => b === 0xCC), "bytes 288-511 untouched outside 64-bit mode");
        assert.deepEqual([view.getUint32(512, true), view.getUint32(516, true)], [3, 0], "XSTATE_BV: x87 and SSE in use");
        assert.ok(area.subarray(520, 576).every(b => b === 0) && area.subarray(576).every(b => b === 0xCC), "only XSTATE_BV of the header, no YMM");
        assert.ok([5, 14, 15, 22, 23, 42, 43, 47].every(i => area[i] === 0xCC), "reserved bytes are not stored");
        // FXSAVE: the same legacy region
        const fx = bytes(vm, AREA + 0x800, 512);
        for(const [from, to] of [[0, 5], [6, 14], [16, 22], [24, 32], [32, 42], [160, 288]])
        {
            assert.deepEqual(fx.subarray(from, to), area.subarray(from, to), `FXSAVE bytes ${from}-${to}`);
        }
        assert.ok(fx.subarray(288, 512).every(b => b === 0xCC), "FXSAVE leaves 288-511 alone outside 64-bit mode");
        // the partial save: SSE only (MXCSR with it), XSTATE_BV bit 0 kept
        const partial = bytes(vm, AREA2, 576);
        assert.ok(partial.subarray(0, 24).every(b => b === 0xCC) && partial.subarray(32, 160).every(b => b === 0xCC), "x87 not stored");
        assert.equal(new DataView(partial.buffer).getUint32(24, true), 0x1FA0, "MXCSR stored with SSE");
        assert.deepEqual(partial.subarray(160, 176), xmm.subarray(0, 16));
        assert.equal(new DataView(partial.buffer).getUint32(512, true), 3, "XSTATE_BV: old bit 0, bit 1 in use");
        // init: FNINIT's x87 state, XMM zero, MXCSR loaded
        assert.equal(word(vm, OUT + 64) & 0xFFFF, 0x37F, "x87 init: FCW");
        assert.deepEqual(bytes(vm, OUT + 80, 16), new Uint8Array(16), "SSE init: XMM0 0");
        assert.equal(word(vm, OUT + 96), 0x1F80, "MXCSR loaded although SSE is initialized");
    }
    count += 20;
    console.log("PASS: XSAVE/XRSTOR round trip, partial save, init on restore, FXSAVE layout (XCR0 3)");

    // Faults: #UD without CR4.OSXSAVE before #NM; #NM with CR0.TS; #GP for
    // misalignment, the header and MXCSR; page faults before any byte moves
    await expect_fault(machines, [...SET_TS, ...mov_ebx(AREA)], XSAVE, 6, { epilogue: CLTS, label: "XSAVE without OSXSAVE, TS set" });
    await expect_fault(machines, [...OSXSAVE, ...SET_TS, ...mov_ebx(AREA), ...ALL], XSAVE, 7, { epilogue: [...CLTS, ...NO_OSXSAVE], label: "XSAVE with TS" });
    await expect_fault(machines, [...OSXSAVE, ...SET_TS, ...mov_ebx(AREA), ...ALL], XRSTOR, 7, { epilogue: [...CLTS, ...NO_OSXSAVE], label: "XRSTOR with TS" });
    for(const [offset, instruction, label] of [[32, XSAVE, "XSAVE"], [16, XRSTOR, "XRSTOR"], [8, FXSAVE, "FXSAVE"], [4, FXRSTOR, "FXRSTOR"]])
    {
        await expect_fault(machines, [...OSXSAVE, ...mov_ebx(AREA + offset), ...ALL], instruction, 13,
            { epilogue: NO_OSXSAVE, label: label + " misaligned", before: vm => prepare(vm, AREA) });
    }
    for(const [patch, label] of [[[520 + 7, 0x80], "XCOMP_BV[63] without XSAVEC"], [[512, 4 | 3], "XSTATE_BV bit outside XCR0"],
        [[530, 1], "header bytes 23:8"], [[26, 1], "MXCSR reserved bits"]])
    {
        await expect_fault(machines, [...OSXSAVE, ...xsetbv(3), ...mov_ebx(AREA), ...ALL], XRSTOR, 13, {
            epilogue: NO_OSXSAVE, label,
            before: vm => {
                prepare(vm, AREA, 3);
                vm.write_memory(Uint8Array.from(u32(0x1F80)), AREA + 24);
                vm.write_memory(Uint8Array.of(patch[1]), AREA + patch[0]);
            },
        });
    }
    await expect_fault(machines, [...mov_ebx(CROSSING - 0x1000 + 0x40)], FXRSTOR, 13, {
        label: "FXRSTOR with MXCSR reserved bits",
        before: vm => vm.write_memory(Uint8Array.from(u32(0x10000)), CROSSING - 0x1000 + 0x40 + 24),
    });
    // the header on an absent page: nothing stored; XRSTOR reads it first
    for(const [instruction, label] of [[XSAVE, "XSAVE"], [XRSTOR, "XRSTOR"]])
    {
        const base = ABSENT - 512;
        await expect_fault(machines, [...OSXSAVE, ...xsetbv(3), ...mov_ebx(base), ...ALL], instruction, 14, {
            epilogue: NO_OSXSAVE, cr2: ABSENT, label: label + " header on an absent page",
            before: vm => { fill(vm, base, 512, 0xCC); pages(vm, ABSENT, false); },
        });
        for(const vm of machines)
        {
            pages(vm, ABSENT, true);
            assert.ok(bytes(vm, base, 512).every(b => b === 0xCC), label + ": no byte stored before the page fault");
        }
    }
    // components not asked for are not touched: YMM's place on an absent page
    await run_all([...OSXSAVE, ...xsetbv(3), ...mov_ebx(CROSSING), ...ALL, ...XSAVE, ...XRSTOR, ...xsetbv(1), ...NO_OSXSAVE], vm => {
        prepare(vm, CROSSING, 3);
        vm.write_memory(Uint8Array.from(u32(0x1F80)), CROSSING + 24);
        pages(vm, CROSSING + 576, false);
    });
    no_fault(machines, "XSAVE/XRSTOR without AVX state next to an absent page");
    for(const vm of machines) pages(vm, CROSSING + 576, true);
    count += 14;
    console.log("PASS: #UD before #NM, #NM with CR0.TS, #GP for alignment, the header and MXCSR, #PF before any byte moves, no access beyond the components");
    for(const vm of machines) await vm.destroy();
    machines.length = 0;

    // With AVX: XCR0 can enable YMM state, which XRSTOR loads and XSAVE stores
    // (no AVX instruction has semantics yet); CPUID's sizes follow XCR0
    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"] }));
    const ymm = Uint8Array.from({ length: 128 }, (_, i) => i * 13 + 1);
    await run_all([...OSXSAVE, ...cpuid(0xD, 0, OUT), ...cpuid(0xD, 2, OUT + 16), ...xsetbv(7), ...cpuid(0xD, 0, OUT + 32),
        ...mov_ebx(AREA), ...ALL, ...XRSTOR, ...mov_ebx(AREA2), ...ALL, ...XSAVE,
        ...mov_ebx(CROSSING), ...ALL, ...XSAVE,
        ...xsetbv(1), ...NO_OSXSAVE], vm => {
        prepare(vm, AREA, 4);
        vm.write_memory(Uint8Array.from(u32(0x1F80)), AREA + 24);
        vm.write_memory(ymm, AREA + 576);
        prepare(vm, AREA2);
        prepare(vm, CROSSING);
    });
    no_fault(machines, "YMM round trip");
    for(const vm of machines)
    {
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + i)), [7, 576, 832, 0], "CPUID.0xD.0 with AVX, XCR0 1");
        assert.deepEqual([0, 4, 8, 12].map(i => word(vm, OUT + 16 + i)), [256, 576, 0, 0], "CPUID.0xD.2");
        assert.equal(word(vm, OUT + 36), 832, "CPUID.0xD.0:EBX with XCR0 7");
        const area = bytes(vm, AREA2, 832);
        assert.deepEqual(area.subarray(576, 704), ymm, "YMM0_H-YMM7_H stored");
        assert.ok(area.subarray(704).every(b => b === 0xCC), "YMM8_H-YMM15_H only in 64-bit mode");
        assert.equal(new DataView(area.buffer).getUint32(512, true), 4, "XSTATE_BV: x87 and SSE initial (XRSTOR initialized them), AVX in use");
    }
    await expect_fault(machines, [...OSXSAVE, ...mov_ecx(0), ...mov_eax(5), ...mov_edx(0)], XSETBV, 13, { epilogue: NO_OSXSAVE, label: "XSETBV YMM without SSE" });
    // the YMM component on an absent page: nothing stored on the first page
    await expect_fault(machines, [...OSXSAVE, ...xsetbv(7), ...mov_ebx(CROSSING), ...ALL], XSAVE, 14, {
        epilogue: [...xsetbv(1), ...NO_OSXSAVE], cr2: CROSSING + 576, label: "XSAVE with YMM on an absent page",
        before: vm => { prepare(vm, CROSSING); pages(vm, CROSSING + 576, false); },
    });
    for(const vm of machines)
    {
        pages(vm, CROSSING + 576, true);
        assert.ok(bytes(vm, CROSSING, 512).every(b => b === 0xCC), "no legacy-region byte stored before the page fault");
    }
    count += 8;
    console.log("PASS: with AVX, XCR0 enables YMM state; CPUID 0xD sizes follow XCR0; XSAVE stores YMM_Hi128 or faults first");
    console.log(`PASS: ${count} XSAVE feature set checks on ${COMPILED_ARMS.length + 1} arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
