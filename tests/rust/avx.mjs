// AVX in the 32-bit engines (docs/simd-xsave-plan.md 8, P5): the VEX forms
// of the shared executor (src/rust/cpu/avx.rs) against a model written here
// from the SDM, and the rules every VEX form shares: VEX.vvvv is the first
// source; a VEX.128 destination register has bits 255:128 zeroed (seen
// through XSAVE, after XRSTOR loaded every upper half), legacy SSE leaves
// them; memory operands have their exact width and need no alignment but
// for VMOVAPS/VMOVAPD/VMOVDQA and the non-temporal moves (#GP(0)); #UD
// without CR4.OSXSAVE, XCR0's SSE and YMM bits or the AVX feature, #NM with
// CR0.TS (after #UD); CR0.EM and CR4.OSFXSR do not matter; #PF has no
// effect. Operands alias in every combination; VEX.W and VEX.L where they
// are ignored, and both VEX prefixes. Every case runs in the interpreter,
// then hot under Tier-0 (which steps VEX forms) and the region tiers (the
// AVX helper, ir::runtime::avx).
//
// P5 part 1: the data movement and logic forms, VZEROUPPER, VLDMXCSR and
// VSTMXCSR.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import { FORMS, big, execute, le, mask, memory_bytes } from "./avx_model.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const hex = bytes => Buffer.from(bytes).toString("hex");
const CODE = 0x100000, SOURCE = 0x200000, DEST = 0x220000, OUT = 0x240000, FAULT = 0x24F000, SKIP = 0x24F100;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000, ABSENT = 0x2F0000;
// a case's XRSTOR and XSAVE areas (standard format, YMM_Hi128 at 576)
const AREAS = 0x300000;
const area_in = n => AREAS + n * 0x800, area_out = n => AREAS + n * 0x800 + 0x400;
// a case's memory at SOURCE and DEST
const SPAN = 48;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

// instructions
const absolute = (r, a) => [0x05 | r << 3, ...u32(a)];
const mov_r32 = (r, v) => [0xB8 | r, ...u32(v)];
const store_r32 = (r, a) => [0x89, 0x05 | r << 3, ...u32(a)];
const xsetbv = value => [...mov_r32(1, 0), ...mov_r32(0, value), ...mov_r32(2, 0), 0x0F, 0x01, 0xD1];
const xrstor = a => [...mov_r32(3, a), ...mov_r32(0, 6), ...mov_r32(2, 0), 0x0F, 0xAE, 0x2B];
const xsave = a => [...mov_r32(3, a), ...mov_r32(0, 6), ...mov_r32(2, 0), 0x0F, 0xAE, 0x23];
// CR4 = CR4 | or & and
const cr4 = (or, and = -1) => [0x0F, 0x20, 0xE0, 0x0D, ...u32(or), 0x25, ...u32(and >>> 0), 0x0F, 0x22, 0xE0];
const OSFXSR = 0x200, OSXMMEXCPT = 0x400, OSXSAVE = 1 << 18;
const CLTS = [0x0F, 0x06];
const SET_CR0 = bits => [0x0F, 0x20, 0xC0, 0x0D, ...u32(bits), 0x0F, 0x22, 0xC0];
const CLEAR_CR0 = bits => [0x0F, 0x20, 0xC0, 0x25, ...u32(~bits >>> 0), 0x0F, 0x22, 0xC0];
/** A VEX instruction: map (1: 0F, 2: 0F38, 3: 0F3A), pp (0, 1: 66, 2: F3,
 * 3: F2), VEX.L, VEX.W and VEX.vvvv; the ModRM byte's reg and r/m register
 * or [address] (neither: no ModRM byte); imm8. The two-byte prefix unless
 * `three`, the map or VEX.W needs the three-byte one. */
function vex({ map = 1, pp = 0, l = 0, w = 0, vvvv = 0, three = false }, op, reg, rm, address, imm8)
{
    const modrm = address !== undefined ? absolute(reg, address) : rm !== undefined ? [0xC0 | reg << 3 | rm] : [];
    const tail = [op, ...modrm, ...(imm8 === undefined ? [] : [imm8])];
    const fields = (~vvvv & 15) << 3 | l << 2 | pp;
    if(map === 1 && !w && !three) return [0xC5, 0x80 | fields, ...tail];
    return [0xC4, 0xE0 | map, w << 7 | fields, ...tail];
}
const GPRS = [1, 5, 6, 7, 0, 2, 3]; // (not ESP)

// Operand data: a case's XMM and YMM_Hi128 registers, MXCSR and memory
const random_bytes = (seed, n) => {
    const a = new Uint8Array(n);
    for(let i = 0; i < n; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; a[i] = seed; }
    return a;
};
const MAX_CASES = 64;
const XMM = random_bytes(0x5EED1234, MAX_CASES * 128), YMMH = random_bytes(0x0BADC0DE, MAX_CASES * 128);
const SOURCES = random_bytes(0x13579BDF, MAX_CASES * SPAN), DESTINATIONS = random_bytes(0x2468ACE1, MAX_CASES * SPAN);
const MXCSRS = random_bytes(0x600DF00D, MAX_CASES * 2);
const GPR_VALUES = random_bytes(0xFEEDFACE, MAX_CASES * 4);
// (exceptions masked: the floating-point forms' cases run without faults, tests/rust/avx_fp.mjs has those)
const mxcsr_of = n => MXCSRS[2 * n] | MXCSRS[2 * n + 1] << 8 | 0x1F80;
const gpr_of = n => new DataView(GPR_VALUES.buffer).getUint32(4 * n, true);
/** The state of case `n` (`c`) before its instruction: XMM0-7 (x), their
 * upper halves (h), MXCSR, the memory at its source (read-only here) and
 * destination, and 16 bytes of results (out); its memory operand at `c.at`
 * of both (avx_model.mjs's execute) */
function initial(n, c)
{
    const s = {
        x: Array.from({ length: 8 }, (_, r) => big(XMM.subarray((n * 8 + r) * 16, (n * 8 + r + 1) * 16))),
        h: Array.from({ length: 8 }, (_, r) => big(YMMH.subarray((n * 8 + r) * 16, (n * 8 + r + 1) * 16))),
        mxcsr: mxcsr_of(n),
        src: c.source || SOURCES.subarray(n * SPAN, (n + 1) * SPAN),
        dest: Uint8Array.from(c.destination || DESTINATIONS.subarray(n * SPAN, (n + 1) * SPAN)),
        out: Uint8Array.from(c.out_before || new Uint8Array(16)),
    };
    const at = c.at ?? 0;
    s.load = size => big(s.src.subarray(at, at + size));
    s.store = (size, v) => s.dest.set(le(v, size), at);
    s.load_at = (offset, size) => big(s.src.subarray(at + offset, at + offset + size));
    s.store_at = (offset, size, v) => s.dest.set(le(v, size), at + offset);
    // (registers the case sets: c.registers)
    for(const [r, value] of Object.entries(c.registers || {})) s.x[r] = value;
    s.masked = (value, selected) => le(value).forEach((b, i) => { if(selected[i]) s.dest[at + i] = b; });
    s.gpr = r => BigInt(c.gpr_values?.[r] ?? c.gpr);
    // (ECX of VPCMPESTRI/VPCMPISTRI and the general-purpose destinations: out[0..4])
    s.set_gpr = (r, value) => s.out.set(le(value & mask(32), 4));
    // (the flags: out[4..8], those that set them)
    Object.defineProperty(s, "flags", { set: value => s.out.set(le(BigInt(value), 4), 4) });
    return s;
}
/** Case `n`'s XRSTOR area: MXCSR, XMM0-7 (those of `registers` instead)
 * and YMM_Hi128 0-7 in use */
function area(n, registers = {})
{
    const a = new Uint8Array(832);
    a.set(u32(mxcsr_of(n)), 24);
    a.set(XMM.subarray(n * 128, n * 128 + 128), 160);
    for(const [r, value] of Object.entries(registers)) a.set(le(value), 160 + 16 * r);
    a[512] = 6;
    a.set(YMMH.subarray(n * 128, n * 128 + 128), 576);
    return a;
}

const machines = [];
/** `until`: what else a warm run of compiled code waits for */
async function run(vm, program, warm, interpreter, label, until = () => true)
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
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && (compiled_activations(e) === start || !until(vm)))
    {
        assert(performance.now() < deadline, `program/JIT timeout (${label}: ${program.length} bytes, done ${word(vm, 0x600) === 0xCAFE}, ` +
            `compiled ${compiled_activations(e) - start}, ${until(vm) ? "" : "not "}ready, last fault ${word(vm, FAULT)} at ${word(vm, FAULT + 4).toString(16)})`);
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
const VECTORS = [[6, false], [7, false], [13, true], [14, true], [19, false]];
// SSE and AVX state enabled: CR4.OSFXSR, OSXMMEXCPT and OSXSAVE, XCR0 7
// (without AVX: 3)
const prologue = xcr0 => [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...CLTS, ...CLEAR_CR0(4), ...cr4(OSFXSR | OSXMMEXCPT | OSXSAVE), ...xsetbv(xcr0)];
let PROLOGUE = prologue(7);
/** Runs `program` on each machine of `set`: warm (compiled), then once more
 * cold; returns what `read` reads after each run (the cold run is mostly
 * interpreted: the program was rewritten) */
async function run_all(program, before = () => {}, set = machines, read = () => null, until = undefined)
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
            await run(vm, loop([...PROLOGUE, ...program]), warm, vm === set[0], `machine ${i} ${warm ? "hot" : "one round"}`, until);
            results.push({ label: `machine ${i} ${warm ? "hot" : "one round"}`, data: read(vm) });
        }
    }
    return results;
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
const pages = (vm, page, present) => {
    // (the BIOS's page table: 0x13000, identity)
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};
/** VEX instructions stepped by Tier-0 (machine 1) since ir_t0_steps_reset:
 * keyed by their first two bytes, C4 or C5 and the next, or an address-size
 * or segment prefix and C4 or C5 */
function tier0_vex_steps()
{
    const steps = machines[1].v86.cpu.wm.exports["ir_t0_steps"];
    let count = 0;
    for(let byte = 0; byte < 256; byte++) count += steps(0xC4 | byte << 8) + steps(0xC5 | byte << 8);
    for(const prefix of [0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x67]) count += steps(prefix | 0xC400) + steps(prefix | 0xC500);
    return count;
}

let checks = 0;
/** The build has Wasm SIMD (the portable one has no vector IR) */
const simd = vm => vm.v86.cpu.wm.exports["ir_wasm_simd_supported"]() !== 0;
/** Runs `cases` in one program: each loads its registers with XRSTOR, runs
 * its `code` between `pre` and `post` and stores its registers with XSAVE;
 * the registers, MXCSR, its destination memory and `out` must be as its
 * `model` says, in each run */
async function check_cases(name, cases, { before = () => {} } = {})
{
    const program = [];
    for(const c of cases)
    {
        program.push(...xrstor(area_in(c.n)), ...(c.pre || []), ...c.code, ...(c.post || []), ...xsave(area_out(c.n)));
    }
    const write = vm => {
        for(const c of cases)
        {
            vm.write_memory(area(c.n, c.registers), area_in(c.n));
            vm.write_memory(new Uint8Array(832), area_out(c.n));
            vm.write_memory(c.source || SOURCES.subarray(c.n * SPAN, (c.n + 1) * SPAN), c.source_at ?? SOURCE + c.n * SPAN);
            vm.write_memory(c.destination || DESTINATIONS.subarray(c.n * SPAN, (c.n + 1) * SPAN), c.destination_at ?? DEST + c.n * SPAN);
            vm.write_memory(new Uint8Array(16), OUT + c.n * 16);
        }
        before(vm);
    };
    for(const vm of machines)
    {
        vm.v86.cpu.wm.exports["ir_t0_steps_reset"]();
        vm.v86.cpu.wm.exports["ir_avx_calls_reset"]();
    }
    const results = await run_all(program, write, machines, vm => ({
        fault: word(vm, FAULT),
        cases: cases.map(c => ({
            area: bytes(vm, area_out(c.n), 832),
            dest: bytes(vm, c.destination_at ?? DEST + c.n * SPAN, SPAN),
            out: bytes(vm, OUT + c.n * 16, 16),
        })),
        tier0: vm === machines[1] ? tier0_vex_steps() : 0,
        avx_calls: vm.v86.cpu.wm.exports["ir_avx_calls"](),
    }), vm => vm === machines[1] ? tier0_vex_steps() >= cases.length :
        vm === machines[2] && simd(vm) ? vm.v86.cpu.wm.exports["ir_avx_calls"]() >= cases.length : true);
    // (the hot runs ran the VEX forms compiled: Tier-0 steps them, the region
    // tiers call the AVX helper, but in a build without Wasm SIMD, whose
    // regions decline XMM state)
    assert.ok(results[2].data.tier0 >= cases.length, `${name}: Tier-0 stepped ${results[2].data.tier0} VEX instructions`);
    if(simd(machines[2])) assert.ok(results[4].data.avx_calls >= cases.length, `${name}: ${results[4].data.avx_calls} AVX helper calls in regions`);
    for(const { label, data } of results)
    {
        assert.equal(data.fault, 0, `${name} (${label}): no fault`);
        cases.forEach((c, i) => {
            const s = initial(c.n, c);
            c.model(s);
            const got = data.cases[i];
            const what = `${name} case ${c.n} ${hex(c.code)} (${label})`;
            for(let r = 0; r < 8; r++)
            {
                assert.equal(hex(got.area.subarray(160 + 16 * r, 176 + 16 * r)), hex(le(s.x[r])), `${what}: xmm${r}`);
                assert.equal(hex(got.area.subarray(576 + 16 * r, 592 + 16 * r)), hex(le(s.h[r])), `${what}: ymm${r}[255:128]`);
            }
            assert.equal(new DataView(got.area.buffer).getUint32(24, true), s.mxcsr, `${what}: MXCSR`);
            assert.equal(hex(got.dest), hex(s.dest), `${what}: memory`);
            assert.equal(hex(got.out), hex(s.out), `${what}: results`);
        });
    }
    checks += cases.length;
}
/** Registers of case `n`: destination, first source and r/m, which alias in
 * every combination over 32 cases */
const regs = n => {
    const d = n & 7;
    const v = [d, d + 1 & 7, n >> 1 & 7, n * 5 & 7][n >> 3 & 3];
    const m = [d, v, d + 3 & 7, n * 3 + 2 & 7][n & 3];
    return [d, v, m];
};
const CASES = 32;

/** `faulting` raises `vector` at its first byte in every run, after
 * XRSTOR of case 0's registers and `setup`, before `epilogue` and XSAVE:
 * the registers (but YMM_Hi128 with `keep_upper` false), MXCSR and the
 * memory at `memory` are unchanged */
async function expect_fault(setup, faulting, vector, { epilogue = [], before = () => {}, cr2, error_code, label, memory, keep_upper = true, registers = {} } = {})
{
    const at = CODE + PROLOGUE.length + xrstor(0).length + setup.length;
    const results = await run_all([...xrstor(area_in(0)), ...setup, ...faulting, ...epilogue, ...xsave(area_out(0))], vm => {
        vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
        vm.write_memory(area(0, registers), area_in(0));
        before(vm);
    }, machines, vm => ({ fault: [0, 4, 8, 12].map(o => word(vm, FAULT + o)), area: bytes(vm, area_out(0), 832),
        memory: memory && bytes(vm, memory[0], memory[1].length) }));
    const name = label || hex(faulting);
    const initial_area = area(0, registers);
    for(const { label: run, data } of results)
    {
        assert.deepEqual(data.fault.slice(0, 2), [vector, at], `${name} (${run}): vector, EIP`);
        if(cr2 !== undefined) assert.equal(data.fault[2], cr2, `${name} (${run}): CR2`);
        if(error_code !== undefined) assert.equal(data.fault[3], error_code, `${name} (${run}): error code`);
        assert.equal(hex(data.area.subarray(160, 288)), hex(initial_area.subarray(160, 288)), `${name} (${run}): XMM registers kept`);
        if(keep_upper) assert.equal(hex(data.area.subarray(576, 704)), hex(initial_area.subarray(576, 704)), `${name} (${run}): YMM_Hi128 kept`);
        assert.equal(word_of(data.area, 24), mxcsr_of(0), `${name} (${run}): MXCSR kept`);
        if(memory) assert.equal(hex(data.memory), hex(memory[1]), `${name} (${run}): memory kept`);
    }
    checks++;
}
const word_of = (a, at) => new DataView(a.buffer, a.byteOffset).getUint32(at, true);

// the kinds of forms (avx_model.mjs) whose memory operand is a destination,
// and those with VEX.vvvv
const STORES = ["store", "scalar_st", "store64", "gpr_store", "stmxcsr", "extract", "maskstore"];
const VVVV = ["binary", "low", "high", "binary_imm", "insert", "insertps", "blendv", "shift_imm", "maskload", "maskstore"];
/** The form has VEX.vvvv (the immediate shifts: the destination) */
const has_vvvv = (f, memory) => VVVV.includes(f.kind) || ["scalar", "scalar_st"].includes(f.kind) && !memory ||
    f.kind === "fp" && ["three", "from_gpr"].includes(f.operands);
// flags before an instruction that sets them: OF, SF, AF (0x7F + 1) and CF (STC)
const FLAGS_BEFORE = [0xB0, 0x7F, 0x04, 0x01, 0xF9];
/** EFLAGS' OSZAPC to `a` (EAX changes) */
const store_flags = a => [0x9C, 0x58, 0x25, ...u32(0x8D5), 0xA3, ...u32(a)];
// explicit lengths of VPCMPESTRx (EAX, EDX): within, beyond, negative, the extremes
const LENGTHS = [0, 1, 3, 7, 8, 9, 15, 16, 17, -1, -5, -16, -17, 0x7FFFFFFF, -0x80000000];
/** Case `n` of form `f`: registers that alias in every combination, the
 * memory operand from n/2 on (unaligned but for the aligned moves), the
 * general-purpose registers set before and stored after */
function form_case(f, n)
{
    const [d, v, m] = regs(n);
    const memory = f.memory || !f.register && n >= CASES / 2;
    const at = f.aligned ? 16 * (n & 1) : n % 17;
    // (the immediate shifts: VEX.vvvv is the destination)
    const vvvv = f.kind === "shift_imm" ? d : has_vvvv(f, memory) ? v : 0;
    // (every imm8 in turn over the forms' cases; VPBLENDVB: the mask register in imm8[7:4], imm8[7] ignored)
    const imm8 = f.kind === "blendv" ? (n * 5 + 3) % 16 << 4 | n * 7 & 15 : n * 37 + 11 & 255;
    const store = STORES.includes(f.kind);
    const address = memory ? (store ? DEST : SOURCE) + n * SPAN + at : undefined;
    const r = GPRS[n % 7];
    const c = { n, at, pre: [], post: [] };
    let [reg, rm] = [d, m];
    const o = { d, v: f.kind === "shift_imm" ? d : v, m: memory ? undefined : m, imm8, long: false };
    switch(f.kind)
    {
        case "to_gpr":
            reg = o.d = r;
            c.pre = mov_r32(r, 0xDEADBEEF);
            c.post = store_r32(r, OUT + n * 16);
            break;
        case "shift_imm": reg = f.group; break;
        case "extract": case "insert":
            rm = r;
            if(memory) break;
            o.m = r;
            c.gpr = gpr_of(n);
            c.pre = mov_r32(r, f.kind === "insert" ? c.gpr : 0xDEADBEEF);
            if(f.kind === "extract") c.post = store_r32(r, OUT + n * 16);
            break;
        case "ptest": case "vtest":
            c.pre = FLAGS_BEFORE;
            c.post = store_flags(OUT + n * 16 + 4);
            break;
        case "fp":
            if(f.operands === "comi")
            {
                c.pre = FLAGS_BEFORE;
                c.post = store_flags(OUT + n * 16 + 4);
            }
            else if(f.operands === "to_gpr")
            {
                reg = o.d = r;
                c.pre = mov_r32(r, 0xDEADBEEF);
                c.post = store_r32(r, OUT + n * 16);
            }
            else if(f.operands === "from_gpr" && !memory)
            {
                rm = o.m = r;
                c.gpr = gpr_of(n);
                c.pre = mov_r32(r, c.gpr);
            }
            break;
        case "pcmpstr":
        {
            // (EAX and EDX: the explicit lengths; ECX ones; the flags set)
            const [la, lb] = [LENGTHS[n % LENGTHS.length], LENGTHS[(n * 7 + 3) % LENGTHS.length]];
            c.gpr_values = { 0: la >>> 0, 2: lb >>> 0 };
            // (VPCMPxSTRM leave ECX)
            c.out_before = Uint8Array.of(255, 255, 255, 255, ...new Array(12).fill(0));
            c.pre = [...FLAGS_BEFORE, ...mov_r32(0, la >>> 0), ...mov_r32(2, lb >>> 0), ...mov_r32(1, -1 >>> 0)];
            c.post = [...store_r32(1, OUT + n * 16), ...store_flags(OUT + n * 16 + 4)];
            break;
        }
        case "gpr_load": case "gpr_store":
            rm = r;
            if(memory) break;
            o.m = r;
            c.gpr = gpr_of(n);
            c.pre = mov_r32(r, f.kind === "gpr_load" ? c.gpr : 0xDEADBEEF);
            if(f.kind === "gpr_store") c.post = store_r32(r, OUT + n * 16);
            break;
        case "ldmxcsr":
        {
            reg = f.group;
            const value = u32(mxcsr_of(n + 32));
            c.source = Uint8Array.from({ length: SPAN }, (_, i) => i >= at && i < at + 4 ? value[i - at] : SOURCES[n * SPAN + i]);
            break;
        }
        case "stmxcsr": reg = f.group; break;
        case "maskmov": c.pre = mov_r32(7, DEST + n * SPAN + at); break;
    }
    // (VEX.W where ignored: WIG, WIG32 outside 64-bit mode)
    const fields = { map: f.map || 1, pp: f.pp, w: f.w === undefined || f.wig32 ? n & 1 : f.w, l: f.lig ? n >> 2 & 1 : 0, three: !!(n & 2), vvvv };
    const immediate = ["load_imm", "binary_imm", "shift_imm", "extract", "insert", "insertps", "blendv", "pcmpstr"].includes(f.kind) ||
        f.imm || f.legacy?.imm8 ? imm8 : undefined;
    c.code = f.kind === "zero_upper" ? vex(fields, f.op) : vex(fields, f.op, reg, rm, address, immediate);
    c.model = s => execute(f, s, o);
    return c;
}

try
{
    // Without AVX: CPUID does not report it, and every VEX form is #UD (with
    // CR4.OSXSAVE and XCR0 3)
    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE"], cpu_features_unreleased: true }));
    PROLOGUE = prologue(3);
    {
        const results = await run_all([0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT)], () => {}, machines, vm => word(vm, OUT));
        for(const { label, data } of results) assert.equal(data >>> 28 & 1, 0, `CPUID.1:ECX.AVX (${label})`);
    }
    for(const [label, form] of [["vmovaps xmm1, xmm2", vex({ pp: 0 }, 0x28, 1, 2)], ["vpxor xmm1, xmm2, [mem]", vex({ pp: 1, vvvv: 2 }, 0xEF, 1, undefined, SOURCE)],
        ["vzeroupper", vex({}, 0x77)], ["vmovd xmm1, ecx", vex({ pp: 1 }, 0x6E, 1, 1)]])
    {
        const results = await run_all(form, vm => vm.write_memory(Uint8Array.from(u32(form.length)), SKIP), machines,
            vm => [0, 4].map(o => word(vm, FAULT + o)));
        for(const { label: run, data } of results) assert.deepEqual(data, [6, CODE + PROLOGUE.length], `${label} without AVX (${run}): #UD`);
        checks++;
    }
    PROLOGUE = prologue(7);
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: without AVX, CPUID does not report it and VEX forms are #UD");

    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"], cpu_features_unreleased: true }));
    {
        const results = await run_all([0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT)], () => {}, machines, vm => word(vm, OUT));
        for(const { label, data } of results) assert.equal(data >>> 27 & 3, 3, `CPUID.1:ECX.OSXSAVE and AVX (${label})`);
    }

    // every form against the model
    for(const f of FORMS.filter(f => !f.long))
    {
        await check_cases(`${f.name} (${(f.map || 1) === 1 ? "" : (f.map === 2 ? "0F38 " : "0F3A ")}${f.op.toString(16)}${f.group === undefined ? "" : "/" + f.group})`,
            Array.from({ length: f.kind === "zero_upper" || f.memory && f.kind.endsWith("mxcsr") ? 8 : CASES }, (_, n) => form_case(f, n)));
    }
    console.log(`PASS: ${FORMS.filter(f => !f.long).length} forms against the model, from registers and memory: bits 255:128 of register destinations zeroed`);

    // VMASKMOVDQU to [DI] with an address-size prefix (DI's address below
    // 64 KiB; EDI's upper half ignored)
    {
        const f = FORMS.find(f => f.kind === "maskmov");
        const cases = [];
        for(let n = 0; n < 8; n++)
        {
            const c = form_case(f, n), low = 0xC000 + n * SPAN;
            cases.push({ ...c, pre: mov_r32(7, 0x5A5A0000 | low + c.at), code: [0x67, ...c.code], destination_at: low });
        }
        await check_cases("vmaskmovdqu (address size 16)", cases);
    }
    console.log("PASS: VMASKMOVDQU to [DI]");

    // Legacy SSE keeps bits 255:128 of its destination, VEX.128 zeroes them
    {
        const chain = [
            0x0F, 0x28, 0xCA,                       // movaps xmm1, xmm2
            ...vex({ pp: 0 }, 0x28, 3, 4),          // vmovaps xmm3, xmm4
            0x0F, 0x57, 0xEE,                       // xorps xmm5, xmm6
            ...vex({ pp: 0, vvvv: 6 }, 0x57, 6, 6), // vxorps xmm6, xmm6, xmm6
            0xF3, 0x0F, 0x10, 0xF8,                 // movss xmm7, xmm0
            ...vex({ pp: 1, vvvv: 7 }, 0xEB, 0, 1), // vpor xmm0, xmm7, xmm1
        ];
        await check_cases("legacy and VEX moves", [{ n: 0, code: chain, model: s => {
            s.x[1] = s.x[2];
            s.x[3] = s.x[4]; s.h[3] = 0n;
            s.x[5] ^= s.x[6];
            s.x[6] = 0n; s.h[6] = 0n;
            s.x[7] = s.x[7] & ~mask(32) | s.x[0] & mask(32);
            s.x[0] = s.x[7] | s.x[1]; s.h[0] = 0n;
        } }]);
    }
    // CR0.EM and CR4.OSFXSR do not matter to VEX forms
    await check_cases("VEX with CR0.EM or without CR4.OSFXSR", [
        { n: 0, pre: SET_CR0(4), code: vex({ pp: 0 }, 0x28, 1, 2), post: CLEAR_CR0(4), model: s => { s.x[1] = s.x[2]; s.h[1] = 0n; } },
        { n: 1, pre: cr4(0, ~OSFXSR), code: vex({ pp: 1, vvvv: 3 }, 0xEF, 1, 2), post: cr4(OSFXSR), model: s => { s.x[1] = s.x[3] ^ s.x[2]; s.h[1] = 0n; } },
        { n: 2, pre: [...SET_CR0(4), ...cr4(0, ~OSFXSR)], code: vex({ pp: 0 }, 0x77), post: [...CLEAR_CR0(4), ...cr4(OSFXSR)], model: s => s.h.fill(0n) },
    ]);
    // narrow operands at the end of a page: no access beyond them
    const form = (pp, op, kind) => FORMS.find(f => f.pp === pp && f.op === op && f.kind === kind && (f.map || 1) === 1);
    // (the form of a name, not one of the 64-bit mode's)
    const named = (name, kind) => FORMS.find(f => f.name === name && !f.long && (kind === undefined || f.kind === kind));
    for(const [label, f, d, v, imm8] of [
        ["vmovss xmm1, [m32]", form(2, 0x10, "scalar"), 1], ["vmovsd xmm2, [m64]", form(3, 0x10, "scalar"), 2],
        ["vmovlps xmm3, xmm4, [m64]", form(0, 0x12, "low"), 3, 4], ["vmovhpd xmm5, xmm6, [m64]", form(1, 0x16, "high"), 5, 6],
        ["vmovddup xmm7, [m64]", form(3, 0x12, "load"), 7], ["vmovq xmm0, [m64]", form(2, 0x7E, "load"), 0],
        ["vmovd xmm1, [m32]", form(1, 0x6E, "gpr_load"), 1], ["vldmxcsr [m32]", form(0, 0xAE, "ldmxcsr"), 2],
        ["vmovss [m32], xmm1", form(2, 0x11, "scalar_st"), 1], ["vmovhps [m64], xmm2", form(0, 0x17, "store64"), 2],
        ["vmovq [m64], xmm3", form(1, 0xD6, "store"), 3], ["vstmxcsr [m32]", form(0, 0xAE, "stmxcsr"), 3],
        ["vmovd [m32], xmm4", form(1, 0x7E, "gpr_store"), 4],
        ["vpmovsxbq xmm1, [m16]", named("vpmovsxbq"), 1], ["vpmovzxdq xmm7, [m64]", named("vpmovzxdq"), 7],
        ["vpinsrb xmm2, xmm3, [m8], 1", named("vpinsrb"), 2, 3, 1], ["vinsertps xmm5, xmm6, [m32], 0x10", named("vinsertps"), 5, 6, 0x10],
        ["vpextrb [m8], xmm4, 2", named("vpextrb"), 4, undefined, 2], ["vpextrw [m16], xmm3, 5", named("vpextrw", "extract"), 3, undefined, 5],
        ["vaddss xmm1, xmm2, [m32]", named("vaddss"), 1, 2], ["vcvtsd2ss xmm3, xmm4, [m64]", named("vcvtsd2ss"), 3, 4],
        ["vcvtps2pd xmm5, [m64]", named("vcvtps2pd"), 5], ["vroundsd xmm6, xmm7, [m64], 1", named("vroundsd"), 6, 7, 1],
        ["vcomiss xmm0, [m32]", named("vcomiss"), 0], ["vbroadcastss xmm2, [m32]", named("vbroadcastss"), 2],
    ])
    {
        const at = SPAN - memory_bytes(f), store = STORES.includes(f.kind);
        // (VLDMXCSR: a valid value)
        const source = Uint8Array.from(SOURCES.subarray(0, SPAN));
        if(f.kind === "ldmxcsr") source.set(u32(0x7F80), at);
        const c = { n: 0, at, source, code: vex({ map: f.map || 1, pp: f.pp, vvvv: v ?? 0 }, f.op, d, undefined, ABSENT - SPAN + at, imm8),
            model: s => execute(f, s, { d, v, imm8, long: false }) };
        // (VCOMISS: the flags)
        if(f.operands === "comi") Object.assign(c, { pre: FLAGS_BEFORE, post: store_flags(OUT + 4) });
        await check_cases(label + " at a page end", [{ ...c, [store ? "destination_at" : "source_at"]: ABSENT - SPAN }], { before: vm => pages(vm, ABSENT, false) });
    }
    // VMASKMOVPS/PD across into an absent page: the unselected lanes there
    // are not accessed (no fault), the selected ones before it are
    {
        // (the low quadword's lanes selected: those of VMASKMOVPS 0 and 1, VMASKMOVPD 0)
        const low_lanes = big(Uint8Array.from({ length: 16 }, (_, i) => i < 8 ? 0x80 : 0));
        for(const op of [0x2C, 0x2D, 0x2E, 0x2F])
        {
            const f = FORMS.find(f => f.map === 2 && f.op === op);
            const store = f.kind === "maskstore";
            const c = { n: 0, at: SPAN - 8, registers: { 2: low_lanes }, code: vex({ map: 2, pp: 1, vvvv: 2 }, op, 1, undefined, ABSENT - 8),
                model: s => execute(f, s, { d: 1, v: 2, long: false }) };
            await check_cases(`${f.name} across into an absent page (the lanes there not selected)`, [{ ...c, [store ? "destination_at" : "source_at"]: ABSENT - SPAN }],
                { before: vm => pages(vm, ABSENT, false) });
        }
    }
    for(const vm of machines) pages(vm, ABSENT, true);
    // VMASKMOVPS/PD set the accessed (and, storing, the dirty) bit of the
    // pages their selected lanes are on; the SDM leaves those of pages with
    // only unselected lanes to the implementation: v86 does not set them
    {
        const low_lanes = big(Uint8Array.from({ length: 16 }, (_, i) => i < 8 ? 0x80 : 0));
        const pte = (vm, page) => word(vm, 0x13000 + (page >>> 12) * 4);
        for(const op of [0x2C, 0x2E])
        {
            const program = [...xrstor(area_in(0)), ...vex({ map: 2, pp: 1, vvvv: 2 }, op, 1, undefined, ABSENT - 8), ...xsave(area_out(0))];
            const results = await run_all(program, vm => {
                vm.write_memory(area(0, { 2: low_lanes }), area_in(0));
                pages(vm, ABSENT - 0x1000, true);
                pages(vm, ABSENT, true);
            }, machines, vm => [pte(vm, ABSENT - 0x1000) & 0x60, pte(vm, ABSENT) & 0x60]);
            for(const { label, data } of results)
            {
                assert.deepEqual(data, [op === 0x2E ? 0x60 : 0x20, 0], `vmaskmovps ${op === 0x2E ? "store" : "load"} (${label}): accessed/dirty bits of the selected lanes' page and the other`);
            }
            checks++;
        }
    }
    console.log("PASS: legacy SSE keeps the upper halves, VEX zeroes them; CR0.EM and CR4.OSFXSR ignored; narrow operands and VMASKMOV's unselected lanes at a page end (no access, no accessed bit)");

    // #UD without CR4.OSXSAVE or with XCR0 3 (before #NM), #NM with CR0.TS
    for(const [label, form] of [
        ["vmovaps xmm1, xmm2", vex({ pp: 0 }, 0x28, 1, 2)], ["vmovups xmm1, [mem]", vex({ pp: 0 }, 0x10, 1, undefined, SOURCE + 3)],
        ["vmovdqu [mem], xmm1", vex({ pp: 2 }, 0x7F, 1, undefined, DEST + 3)], ["vzeroupper", vex({}, 0x77)],
        ["vldmxcsr [mem]", vex({}, 0xAE, 2, undefined, SOURCE)], ["vmaskmovdqu", vex({ pp: 1 }, 0xF7, 1, 2)],
        ["vmovd ecx, xmm1", vex({ pp: 1 }, 0x7E, 1, 1)],
    ])
    {
        const memory = [DEST, DESTINATIONS.subarray(0, 32)];
        const before = vm => { vm.write_memory(DESTINATIONS.subarray(0, 32), DEST); vm.write_memory(Uint8Array.from(u32(0x1F80)), SOURCE); };
        await expect_fault(cr4(0, ~OSXSAVE), form, 6, { epilogue: cr4(OSXSAVE), before, memory, label: label + " without CR4.OSXSAVE" });
        await expect_fault(xsetbv(3), form, 6, { epilogue: xsetbv(7), before, memory, keep_upper: false, label: label + " with XCR0 3" });
        await expect_fault(SET_CR0(8), form, 7, { epilogue: CLTS, before, memory, label: label + " with CR0.TS" });
        await expect_fault([...SET_CR0(8), ...cr4(0, ~OSXSAVE)], form, 6, { epilogue: [...cr4(OSXSAVE), ...CLTS], before, memory, label: label + " with CR0.TS, without CR4.OSXSAVE" });
    }
    console.log("PASS: #UD without CR4.OSXSAVE or with XCR0 3, then #NM with CR0.TS");

    // #GP(0) for a misaligned operand of the aligned moves; #UD for VEX.L1 of
    // VLDMXCSR, VEX.vvvv other than 1111b without that operand; VLDMXCSR's reserved bits
    {
        const memory = [DEST, DESTINATIONS.subarray(0, 32)];
        const before = vm => vm.write_memory(DESTINATIONS.subarray(0, 32), DEST);
        for(const f of FORMS.filter(f => f.aligned))
        {
            const store = f.kind === "store";
            await expect_fault([], vex({ map: f.map || 1, pp: f.pp }, f.op, 1, undefined, store ? DEST + 4 : SOURCE + 8), 13,
                { error_code: 0, before, memory, label: `${f.name} misaligned ${store ? "store" : "load"}` });
        }
        await expect_fault([], vex({ l: 1 }, 0xAE, 2, undefined, SOURCE), 6, { label: "vldmxcsr with VEX.L1" });
        await expect_fault([], vex({ pp: 0, vvvv: 3 }, 0x28, 1, 2), 6, { label: "vmovaps with VEX.vvvv 3" });
        await expect_fault([], vex({ three: true, vvvv: 1 }, 0x77), 6, { label: "vzeroupper with VEX.vvvv 1" });
        await expect_fault([], vex({ map: 3, pp: 1, w: 1, vvvv: 2 }, 0x4C, 1, 3, undefined, 0x40), 6, { label: "vpblendvb with VEX.W1" });
        await expect_fault([], vex({ pp: 1, vvvv: 2 }, 0x73, 3, undefined, SOURCE, 3), 6, { label: "vpsrldq with a memory operand" });
        await expect_fault([], vex({ pp: 1 }, 0xC5, 1, undefined, SOURCE, 1), 6, { label: "vpextrw (C5) with a memory operand" });
        await expect_fault([], vex({ pp: 1, vvvv: 3 }, 0x70, 1, 2, undefined, 0x1B), 6, { label: "vpshufd with VEX.vvvv 3" });
        await expect_fault([], vex({}, 0xAE, 2, undefined, SOURCE + 4), 13, { error_code: 0, before: vm => vm.write_memory(Uint8Array.from(u32(0x10000)), SOURCE + 4), label: "vldmxcsr with a reserved bit" });
    }
    // #PF: a load from and a store to an absent page, nothing written; the
    // two VMASKMOVDQU writes: the whole range writable first, as MASKMOVDQU's
    {
        const memory = [ABSENT - 16, DESTINATIONS.subarray(0, 16)];
        const absent = vm => { vm.write_memory(DESTINATIONS.subarray(0, 16), ABSENT - 16); pages(vm, ABSENT, false); };
        await expect_fault([], vex({ pp: 0 }, 0x10, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT, error_code: 0, label: "vmovups across into an absent page" });
        await expect_fault([], vex({ pp: 3 }, 0x10, 1, undefined, ABSENT - 4), 14, { before: absent, cr2: ABSENT, error_code: 0, label: "vmovsd across into an absent page" });
        await expect_fault([], vex({ pp: 2 }, 0x7F, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT, error_code: 2, memory, label: "vmovdqu store across into an absent page" });
        await expect_fault([], vex({ pp: 1 }, 0xD6, 1, undefined, ABSENT - 4), 14, { before: absent, cr2: ABSENT, error_code: 2, memory, label: "vmovq store across into an absent page" });
        await expect_fault(mov_r32(7, ABSENT - 8), vex({ pp: 1 }, 0xF7, 1, 2), 14, { before: absent, cr2: ABSENT, error_code: 2, memory, label: "vmaskmovdqu across into an absent page" });
        // VMASKMOVPS/PD: a selected lane on the absent page faults, nothing
        // written (the lanes before it selected too: PS 0, 1 and 3, PD 0 and 1)
        const both = big(Uint8Array.from({ length: 16 }, (_, i) => i === 3 || i === 7 || i === 15 ? 0x80 : 0));
        await expect_fault([], vex({ map: 2, pp: 1, vvvv: 2 }, 0x2C, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT + 4, error_code: 0,
            registers: { 2: both }, label: "vmaskmovps load, lane 3 on an absent page" });
        await expect_fault([], vex({ map: 2, pp: 1, vvvv: 2 }, 0x2E, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT + 4, error_code: 2, memory,
            registers: { 2: both }, label: "vmaskmovps store, lane 3 on an absent page" });
        await expect_fault([], vex({ map: 2, pp: 1, vvvv: 2 }, 0x2F, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT, error_code: 2, memory,
            registers: { 2: both }, label: "vmaskmovpd store, lane 1 on an absent page" });
        for(const vm of machines) pages(vm, ABSENT, true);
    }
    console.log("PASS: #GP(0) for misaligned aligned moves and VLDMXCSR's reserved bits, #UD for VEX.L1, VEX.W1, VEX.vvvv and memory operands where invalid, #PF without effect");
    console.log(`PASS: ${checks} AVX checks on 3 arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
