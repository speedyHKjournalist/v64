// SSE4.1 and SSE4.2 integer forms in the 32-bit engines (docs/simd-xsave-plan.md
// 7.2, 7.3, P4b) against a model of the SDM's pseudocode written here
// (tests/rust/sse4_model.mjs, independent of src/rust/cpu/simd_int.rs):
// register and memory sources, the destination as the source and as XMM0
// (BLENDV's mask), every imm8 of the blends, INSERTPS and MPSADBW, the
// element selection of PEXTR*/PINSR* to and from registers and memory, the
// flags of PTEST and the exceptions: #UD without the feature, with CR0.EM,
// without CR4.OSFXSR, with LOCK or an F2/F3 prefix and for MOVNTDQA from a
// register, #NM with CR0.TS, #GP(0) for a misaligned m128 (none for the
// narrow operands) and #PF, each without effect. Every case runs in the
// interpreter, then hot under Tier-0 and the region tiers.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import { extract, get, insert, insertps, ptest, set, sse4_38, sse4_3a } from "./sse4_model.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const hex = bytes => Buffer.from(bytes).toString("hex");
const CODE = 0x100000, DEST = 0x200000, SOURCE = 0x210000, MASK = 0x220000, OUT = 0x230000, FAULT = 0x24F000, SKIP = 0x24F100;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000, ABSENT = 0x2F0000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

// Operand data: random bytes, and lanes of edge values (8 kinds)
const make_data = seed => {
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const a = new Uint8Array(512 * 16), v = new DataView(a.buffer);
    const edges = {
        1: [0x00, 0x01, 0x7F, 0x80, 0x81, 0xFE, 0xFF, 0x40],
        2: [0x0000, 0x0001, 0x7FFF, 0x8000, 0x8001, 0xFFFF, 0x4000, 0xC000],
        4: [0, 1, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFFFFFF, 0x0000FFFF, 0xFFFF0000],
    };
    for(let n = 0; n < 512; n++)
    {
        const kind = n % 8;
        for(let i = 0; i < 16; i++)
        {
            if(kind < 3) a[n * 16 + i] = random();
            else if(kind === 3) a[n * 16 + i] = edges[1][random() & 7];
            else if(kind === 4 && i % 2 === 0) v.setUint16(n * 16 + i, edges[2][random() & 7], true);
            else if(kind === 5 && i % 4 === 0) v.setUint32(n * 16 + i, edges[4][random() & 7], true);
            // (equal halves: PCMPEQQ, PHMINPOSUW ties)
            else if(kind === 6) a[n * 16 + i] = i < 8 ? random() & 3 : a[n * 16 + i - 8];
            else if(kind === 7) a[n * 16 + i] = (random() & 1) * 0xFF;
        }
    }
    return a;
};
const destinations = make_data(0x5EED1234), sources = make_data(0x0BADC0DE), masks = make_data(0x13579BDF);

const LOAD = [0xF3, 0x0F, 0x6F], STORE = [0xF3, 0x0F, 0x7F];
const absolute = (r, a) => [0x05 | r << 3, ...u32(a)];
const mov_r32 = (r, v) => [0xB8 | r, ...u32(v)];
const store_r32 = (r, a) => [0x89, 0x05 | r << 3, ...u32(a)];
const PUSHF_STORE = a => [0x9C, 0x58, 0xA3, ...u32(a)];
/** 66 0F map op ModRM(reg, rm or [address]) imm8 */
const encode = (map, op, reg, rm, address, imm8, prefixes = []) => [...prefixes, 0x66, 0x0F, map, op,
    ...(address === undefined ? [0xC0 | reg << 3 | rm] : absolute(reg, address)), ...(imm8 === undefined ? [] : [imm8])];
const OSFXSR = [0x0F, 0x20, 0xE0, 0x0D, ...u32(0x600), 0x0F, 0x22, 0xE0]; // CR4 |= OSFXSR | OSXMMEXCPT
const NO_OSFXSR = [0x0F, 0x20, 0xE0, 0x25, ...u32(~0x200 >>> 0), 0x0F, 0x22, 0xE0];
const CLTS = [0x0F, 0x06];
const SET_CR0 = bits => [0x0F, 0x20, 0xC0, 0x0D, ...u32(bits), 0x0F, 0x22, 0xC0];
const CLEAR_CR0 = bits => [0x0F, 0x20, 0xC0, 0x25, ...u32(~bits >>> 0), 0x0F, 0x22, 0xC0];

// The forms of 66 0F 38 with simd_int::sse4 semantics: [op, name, memory bytes]
const BINARY = [[0x10, "pblendvb"], [0x14, "blendvps"], [0x15, "blendvpd"], [0x20, "pmovsxbw", 8], [0x21, "pmovsxbd", 4],
    [0x22, "pmovsxbq", 2], [0x23, "pmovsxwd", 8], [0x24, "pmovsxwq", 4], [0x25, "pmovsxdq", 8], [0x28, "pmuldq"], [0x29, "pcmpeqq"],
    [0x2B, "packusdw"], [0x30, "pmovzxbw", 8], [0x31, "pmovzxbd", 4], [0x32, "pmovzxbq", 2], [0x33, "pmovzxwd", 8],
    [0x34, "pmovzxwq", 4], [0x35, "pmovzxdq", 8], [0x37, "pcmpgtq"], [0x38, "pminsb"], [0x39, "pminsd"], [0x3A, "pminuw"],
    [0x3B, "pminud"], [0x3C, "pmaxsb"], [0x3D, "pmaxsd"], [0x3E, "pmaxuw"], [0x3F, "pmaxud"], [0x40, "pmulld"],
    [0x41, "phminposuw"]].map(([op, name, bytes = 16]) => ({ op, name, bytes }));
// 66 0F 3A with imm8 between XMM operands
const IMMEDIATE = [[0x0C, "blendps"], [0x0D, "blendpd"], [0x0E, "pblendw"], [0x21, "insertps"], [0x42, "mpsadbw"]];
const EXTRACT = [[0x14, "pextrb", 1], [0x15, "pextrw", 2], [0x16, "pextrd", 4], [0x17, "extractps", 4]];
const INSERT = [[0x20, "pinsrb", 1], [0x22, "pinsrd", 4]];
const GPRS = [0, 1, 2, 3, 5, 6, 7]; // (not ESP)

const machines = [];
async function run(vm, program, warm, interpreter)
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
    if(error_code) p.push(0x58, 0xA3, ...u32(FAULT + 12));
    p.push(0xC7, 0x05, ...u32(FAULT), ...u32(vector));
    p.push(0x8B, 0x04, 0x24, 0xA3, ...u32(FAULT + 4));
    p.push(0x0F, 0x20, 0xD0, 0xA3, ...u32(FAULT + 8));
    p.push(0xA1, ...u32(SKIP), 0x01, 0x04, 0x24, 0xCF);
    return p;
}
const VECTORS = [[6, false], [7, false], [13, true], [14, true]];
const PROLOGUE = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...CLTS, ...CLEAR_CR0(4), ...OSFXSR];
/** Runs `program` on each machine of `set`: warm (compiled), then once more
 * cold; returns what `read` reads after each run (the cold run is mostly
 * interpreted: the program was rewritten) */
async function run_all(program, before = () => {}, set = machines, read = () => null)
{
    const results = [];
    for(const [i, vm] of set.entries())
    {
        vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
        VECTORS.forEach(([vector, error_code], i) => {
            const h = HANDLER + i * 0x100;
            vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
            vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
        });
        for(const warm of [true, false])
        {
            before(vm);
            vm.write_memory(new Uint8Array(16), FAULT);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            await run(vm, loop([...PROLOGUE, ...program]), warm, vm === set[0]);
            results.push({ label: `machine ${i} ${warm ? "hot" : "one round"}`, data: read(vm) });
        }
    }
    return results;
}
/** Runs `program` on every machine; the results of OUT (`length` bytes) of
 * each run must agree; returns the interpreter's */
async function run_out(program, before, length, label)
{
    const results = await run_all(program, before, machines, vm => bytes(vm, OUT, length));
    for(const { label: run, data } of results)
    {
        for(let at = 0; at < length; at += 16)
        {
            if(!data.subarray(at, at + 16).every((b, k) => b === results[0].data[at + k]))
            {
                assert.fail(`${label} at ${at / 16}: ${run} ${hex(data.subarray(at, at + 16))}, interpreter ${hex(results[0].data.subarray(at, at + 16))}`);
            }
        }
    }
    return results[0].data;
}
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
/** `faulting` raises `vector` at its first byte after `prologue` (the
 * handler skips it) in every run, and OUT holds `out` afterwards */
async function expect_fault(prologue, faulting, vector, { epilogue = [], before = () => {}, cr2, error_code, label, out, memory } = {})
{
    const at = CODE + PROLOGUE.length + prologue.length;
    const results = await run_all([...prologue, ...faulting, ...epilogue], vm => {
        vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
        before(vm);
    }, machines, vm => ({ fault: [0, 4, 8, 12].map(o => word(vm, FAULT + o)), out: bytes(vm, OUT, 16),
        memory: memory && bytes(vm, memory[0], memory[1].length) }));
    const name = label || hex(faulting);
    for(const { label: run, data } of results)
    {
        assert.deepEqual(data.fault.slice(0, 2), [vector, at], `${name} (${run}): vector, EIP`);
        if(cr2 !== undefined) assert.equal(data.fault[2], cr2, `${name} (${run}): CR2`);
        if(error_code !== undefined) assert.equal(data.fault[3], error_code, `${name} (${run}): error code`);
        if(out) assert.equal(hex(data.out), hex(out), `${name} (${run}): destination kept`);
        if(memory) assert.equal(hex(data.memory), hex(memory[1]), `${name} (${run}): memory kept`);
    }
}
const pages = (vm, page, present) => {
    // (the BIOS's page table: 0x13000, identity)
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};
const write_data = vm => {
    vm.write_memory(destinations, DEST);
    vm.write_memory(sources, SOURCE);
    vm.write_memory(masks, MASK);
};
let checks = 0;
try
{
    // Without SSE4.1 and SSE4.2: CPUID reports neither, every form is #UD
    const CPUID = [0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT)];
    machines.push(...await create_machines({ cpu_features: ["SSSE3"] }));
    await run_all(CPUID);
    for(const vm of machines) assert.equal(word(vm, OUT) >>> 19 & 3, 0, "CPUID.1:ECX.SSE4_1/SSE4_2");
    for(const { op, name } of [...BINARY, { op: 0x17, name: "ptest" }, { op: 0x2A, name: "movntdqa" }])
    {
        await expect_fault([], encode(0x38, op, 1, undefined, SOURCE, undefined), 6, { label: `${name} without SSE4` });
    }
    for(const [op, name] of [...IMMEDIATE, ...EXTRACT, ...INSERT, [0x08, "roundps"], [0x0B, "roundsd"], [0x40, "dpps"], [0x41, "dppd"]])
    {
        await expect_fault([], encode(0x3A, op, 1, 2, undefined, 0), 6, { label: `${name} without SSE4` });
    }
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: without SSE4.1/SSE4.2, CPUID reports neither and every form is #UD");

    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2"] }));
    await run_all(CPUID);
    for(const vm of machines) assert.equal(word(vm, OUT) >>> 19 & 3, 3, "CPUID.1:ECX.SSE4_1/SSE4_2");

    // 66 0F 38 against the model. XMM0 (BLENDV's mask) is loaded first, then
    // the destination, then a register source: the operands may alias.
    const CASES = 64;
    let cases = 0;
    for(const { op, name, bytes: width } of BINARY)
    {
        const program = [];
        for(let n = 0; n < CASES; n++)
        {
            const dst = n & 7, src = n >> 3 & 7, memory = n >= CASES / 2;
            // a narrow memory operand needs no alignment
            const address = SOURCE + n * 16 + (width < 16 ? n & 7 : 0);
            program.push(...LOAD, ...absolute(0, MASK + n * 16), ...LOAD, ...absolute(dst, DEST + n * 16));
            if(!memory) program.push(...LOAD, ...absolute(src, SOURCE + n * 16));
            program.push(...encode(0x38, op, dst, src, memory ? address : undefined));
            program.push(...STORE, ...absolute(dst, OUT + n * 16));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(CASES * 16), OUT); }, CASES * 16, name);
        for(let n = 0; n < CASES; n++)
        {
            const dst = n & 7, src = n >> 3 & 7, memory = n >= CASES / 2;
            const registers = [masks.slice(n * 16, n * 16 + 16)];
            registers[dst] = destinations.slice(n * 16, n * 16 + 16);
            if(!memory) registers[src] = sources.slice(n * 16, n * 16 + 16);
            const offset = n * 16 + (width < 16 ? n & 7 : 0);
            const source = memory ? Uint8Array.from({ length: 16 }, (_, i) => i < width ? sources[offset + i] : 0) : registers[src];
            const expected = sse4_38(op, registers[dst], source, registers[0]);
            assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected),
                `${name} xmm${dst}, ${memory ? "[mem]" : "xmm" + src} (xmm0 ${hex(registers[0])}): d=${hex(registers[dst])} s=${hex(source)}`);
        }
        cases += CASES;
    }
    console.log(`PASS: ${cases} cases of ${BINARY.length} forms of 66 0F 38 (PMOVSX/PMOVZX, BLENDV, PMULDQ/PMULLD, PCMPEQQ/PCMPGTQ, PACKUSDW, PMIN/PMAX, PHMINPOSUW) match the model on 3 arms`);
    checks += cases;

    // PTEST: ZF and CF from the model, AF, OF, PF and SF cleared (set before)
    {
        const program = [];
        for(let n = 0; n < CASES; n++)
        {
            const memory = n >= CASES / 2;
            program.push(...LOAD, ...absolute(3, DEST + n * 16));
            if(!memory) program.push(...LOAD, ...absolute(5, SOURCE + n * 16));
            // (OF, SF, AF set by 0x7F + 1, CF by STC)
            program.push(0xB0, 0x7F, 0x04, 0x01, 0xF9);
            program.push(...encode(0x38, 0x17, 3, 5, memory ? SOURCE + n * 16 : undefined));
            program.push(...PUSHF_STORE(OUT + n * 16));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(CASES * 16), OUT); }, CASES * 16, "ptest");
        for(let n = 0; n < CASES; n++)
        {
            const { zf, cf } = ptest(destinations.slice(n * 16, n * 16 + 16), sources.slice(n * 16, n * 16 + 16));
            const flags = new DataView(result.buffer).getUint32(n * 16, true);
            assert.equal(flags & 0x8D5, (zf ? 0x40 : 0) | (cf ? 1 : 0), `ptest ${n}: flags ${flags.toString(16)}`);
        }
        cases += CASES;
        checks += CASES;
    }
    console.log("PASS: PTEST sets ZF and CF as the model, clears AF, OF, PF and SF");

    // 66 0F 3A with imm8: every imm8, register and memory sources
    for(const [op, name] of IMMEDIATE)
    {
        const program = [];
        const count = 512;
        for(let n = 0; n < count; n++)
        {
            const imm8 = n & 255, dst = n % 7 + 1, src = n % 5, memory = n >= 256;
            const address = SOURCE + n * 16;
            program.push(...LOAD, ...absolute(dst, DEST + n * 16));
            if(!memory) program.push(...LOAD, ...absolute(src, SOURCE + n * 16));
            program.push(...encode(0x3A, op, dst, src, memory ? address : undefined, imm8));
            program.push(...STORE, ...absolute(dst, OUT + n * 16));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(count * 16), OUT); }, count * 16, name);
        for(let n = 0; n < count; n++)
        {
            const imm8 = n & 255, dst = n % 7 + 1, src = n % 5, memory = n >= 256;
            const s = sources.slice(n * 16, n * 16 + 16);
            // (a destination that is also the source holds the source)
            const d = !memory && dst === src ? s : destinations.slice(n * 16, n * 16 + 16);
            // (INSERTPS from memory: the m32, imm8[7:6] ignored)
            const expected = op === 0x21 && memory ? insertps(d, get(s, 4, 0), imm8) : sse4_3a(op, d, s, imm8);
            assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected), `${name} imm8=${imm8.toString(16)} ${memory ? "[mem]" : "xmm"}`);
        }
        cases += count;
        checks += count;
    }
    console.log(`PASS: BLENDPS/BLENDPD/PBLENDW/INSERTPS/MPSADBW, every imm8 from registers and memory`);

    // PEXTR*/EXTRACTPS to a register (zero-extended) and to memory (the
    // bytes after unchanged), PINSRB/PINSRD from a register (its low bytes) and memory
    for(const [op, name, size] of EXTRACT)
    {
        const program = [], count = 64;
        for(let n = 0; n < count; n++)
        {
            const xmm = n % 8, gpr = GPRS[n % 7], imm8 = n * 37 & 255, memory = n >= count / 2;
            program.push(...LOAD, ...absolute(xmm, SOURCE + n * 16), ...mov_r32(gpr, 0xDEADBEEF));
            if(memory) program.push(...encode(0x3A, op, xmm, 0, OUT + n * 16 + (n & 7), imm8));
            else program.push(...encode(0x3A, op, xmm, gpr, undefined, imm8), ...store_r32(gpr, OUT + n * 16));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(count * 16).fill(0xEE), OUT); }, count * 16, name);
        for(let n = 0; n < count; n++)
        {
            const imm8 = n * 37 & 255, memory = n >= count / 2;
            const value = extract(sources.slice(n * 16, n * 16 + 16), size, imm8);
            const expected = new Uint8Array(16).fill(0xEE);
            if(memory) set(expected.subarray(n & 7), size, 0, value);
            else set(expected, 4, 0, value);
            assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected), `${name} imm8=${imm8} ${memory ? "[mem]" : "r32"}`);
        }
        cases += count;
        checks += count;
    }
    for(const [op, name, size] of INSERT)
    {
        const program = [], count = 64;
        for(let n = 0; n < count; n++)
        {
            const xmm = n % 8, gpr = GPRS[n % 7], imm8 = n * 37 & 255, memory = n >= count / 2;
            program.push(...LOAD, ...absolute(xmm, DEST + n * 16), ...mov_r32(gpr, Number(get(sources.subarray(n * 16), 4, 0))));
            program.push(...encode(0x3A, op, xmm, gpr, memory ? SOURCE + n * 16 + (n & 7) : undefined, imm8));
            program.push(...STORE, ...absolute(xmm, OUT + n * 16));
        }
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(count * 16), OUT); }, count * 16, name);
        for(let n = 0; n < count; n++)
        {
            const imm8 = n * 37 & 255, memory = n >= count / 2;
            const value = get(sources.subarray(n * 16 + (memory ? n & 7 : 0)), size, 0);
            const expected = insert(destinations.slice(n * 16, n * 16 + 16), size, value, imm8);
            assert.equal(hex(result.subarray(n * 16, n * 16 + 16)), hex(expected), `${name} imm8=${imm8} ${memory ? "[mem]" : "r32"}`);
        }
        cases += count;
        checks += count;
    }
    console.log(`PASS: PEXTRB/PEXTRW/PEXTRD/EXTRACTPS and PINSRB/PINSRD with registers and memory, ${cases} cases in all`);

    // MOVNTDQA loads an aligned m128
    {
        const program = [];
        for(let n = 0; n < 8; n++) program.push(...encode(0x38, 0x2A, n, 0, SOURCE + n * 16), ...STORE, ...absolute(n, OUT + n * 16));
        const result = await run_out(program, vm => { write_data(vm); vm.write_memory(new Uint8Array(128), OUT); }, 128, "movntdqa");
        assert.equal(hex(result), hex(sources.slice(0, 128)), "movntdqa");
        checks++;
    }

    // Faults: the destination keeps its value
    const keep = r => [...LOAD, ...absolute(r, DEST)];
    const kept = r => [...STORE, ...absolute(r, OUT)];
    const out = destinations.slice(0, 16);
    const before = vm => { write_data(vm); vm.write_memory(new Uint8Array(16), OUT); };
    const samples = [
        ["pminud", encode(0x38, 0x3B, 6, undefined, SOURCE + 8), true],
        ["pblendvb", encode(0x38, 0x10, 6, undefined, SOURCE + 4), true],
        ["ptest", encode(0x38, 0x17, 6, undefined, SOURCE + 1), true],
        ["movntdqa", encode(0x38, 0x2A, 6, undefined, SOURCE + 8), true],
        ["blendps", encode(0x3A, 0x0C, 6, undefined, SOURCE + 8, 5), true],
        ["mpsadbw", encode(0x3A, 0x42, 6, undefined, SOURCE + 12, 5), true],
        ["pmovzxbw", encode(0x38, 0x30, 6, undefined, SOURCE + 8), false],
        ["pinsrd", encode(0x3A, 0x22, 6, undefined, SOURCE + 1, 1), false],
        ["insertps", encode(0x3A, 0x21, 6, undefined, SOURCE + 3, 0x10), false],
    ];
    for(const [name, form, aligned] of samples)
    {
        const label = name + " [misaligned]";
        if(aligned)
        {
            await expect_fault(keep(6), form, 13, { epilogue: kept(6), before, error_code: 0, label, out });
        }
        else
        {
            const results = await run_all([...keep(6), ...form, ...kept(6)], before, machines, vm => word(vm, FAULT));
            for(const { label: run, data } of results) assert.equal(data, 0, `${label} (${run}): no fault`);
        }
        // CR0.TS: #NM; CR0.EM and no CR4.OSFXSR: #UD
        await expect_fault([...keep(6), ...SET_CR0(8)], form, 7, { epilogue: [...CLTS, ...kept(6)], before, label: name + " with CR0.TS", out });
        await expect_fault([...keep(6), ...SET_CR0(4)], form, 6, { epilogue: [...CLEAR_CR0(4), ...kept(6)], before, label: name + " with CR0.EM", out });
        await expect_fault([...keep(6), ...NO_OSFXSR], form, 6, { epilogue: [...OSFXSR, ...kept(6)], before, label: name + " without OSFXSR", out });
        checks += 4;
    }
    // LOCK, F2 and F3 are #UD; so is MOVNTDQA from a register
    for(const prefix of [0xF0, 0xF2, 0xF3])
    {
        for(const form of [encode(0x38, 0x3B, 6, 1), encode(0x3A, 0x0E, 6, 1, undefined, 3), encode(0x3A, 0x16, 1, 2, undefined, 1)])
        {
            await expect_fault(keep(6), [prefix, ...form], 6, { epilogue: kept(6), before, label: `${prefix.toString(16)} ${hex(form)}`, out });
            checks++;
        }
    }
    await expect_fault(keep(6), encode(0x38, 0x2A, 6, 1), 6, { epilogue: kept(6), before, label: "movntdqa xmm6, xmm1", out });
    // #PF: a load from and a store to an absent page, nothing written
    const absent = vm => { before(vm); vm.write_memory(new Uint8Array(16).fill(0xEE), ABSENT - 16); pages(vm, ABSENT, false); };
    await expect_fault(keep(6), encode(0x38, 0x32, 6, undefined, ABSENT - 1), 14, { epilogue: kept(6), before: absent, cr2: ABSENT, error_code: 0, label: "pmovzxbq across into an absent page", out });
    await expect_fault(keep(6), encode(0x3A, 0x16, 6, undefined, ABSENT - 2, 3), 14, { epilogue: kept(6), before: absent, cr2: ABSENT, error_code: 2,
        label: "pextrd across into an absent page", memory: [ABSENT - 16, new Uint8Array(16).fill(0xEE)] });
    for(const vm of machines) pages(vm, ABSENT, true);
    checks += 3;
    console.log("PASS: #GP(0) for misaligned m128 operands (none for narrow ones), #NM, #UD (EM, OSFXSR, LOCK, F2/F3, MOVNTDQA register) and #PF, without effect");
    console.log(`PASS: ${checks} SSE4 checks on 3 arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
