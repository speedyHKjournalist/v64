#!/usr/bin/env node
// Tier-0 differential fuzzing: random integer/SSE/x87 instruction sequences
// run hot in a loop (so their page is compiled by the IR Tier-0 page tier) and
// must leave exactly the interpreter's state: GPRs, EFLAGS (including the
// rarely read AF/OF, captured by PUSHFD/LAHF inside the loop), memory, XMM and
// x87 registers, and the retired-instruction count.
//
//   node tests/ir/differential/tier0_fuzz.mjs [cases=40] [seed=1] [wasm]
// Needs build/bench/boot.bin (make bench-build): flat protected mode, paging.
// FUZZ_STRADDLE=1 places each program across a page boundary and compiles
// Tier-0 page functions with their neighbor pages (ir_t0_set_ranges).
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";

const cases = Number(process.argv[2] || 40);
let seed = Number(process.argv[3] || 1) >>> 0;
const wasm = process.argv[4] || "build/v86-ir-runtime.wasm";
const manifest = JSON.parse(fs.readFileSync("build/bench/manifest.json", "utf8"));
const boot = fs.readFileSync(manifest.boot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CODE = 0x500000, DATA = 0x600000, STACK = 0x610000, ITERATIONS = 2500;
const random = () => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed;
};
const pick = list => list[random() % list.length];
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
// EBX holds DATA (never written); ESP the stack. Byte registers exclude BL/BH.
const REGS = [0, 1, 2, 5, 6, 7];
const BYTE_REGS = [0, 1, 2, 4, 5, 6];
const reg = () => pick(REGS);
const disp = () => random() % 28 * 4;                    // [ebx + disp8], 0..108 (signed disp8)
const mem = r => [0x43 | r << 3, disp()];                 // modrm for [ebx + disp8]
const rr = (r, m) => 0xC0 | r << 3 | m;

// FUZZ_KIND=i0..i33 / s0..s9 restricts programs to one instruction kind.
const only = process.env.FUZZ_KIND || "";
const straddle = process.env.FUZZ_STRADDLE === "1";
function instruction() {
    const op = random() % 8, r = reg(), m = reg();
    const kind = random() % 34;
    switch(only.startsWith("i") ? Number(only.slice(1)) : kind) {
        case 0: return [op << 3 | 1, rr(r, m)];                                  // ALU r/m32, r32
        case 1: return [0x81, rr(op, m), ...u32(random())];                       // ALU r/m32, imm32
        case 2: return [0x83, rr(op, m), random() & 255];                         // ALU r/m32, imm8
        case 3: return [op << 3 | 3, ...mem(r)];                                  // ALU r32, m32
        case 4: return [op << 3 | 1, ...mem(r)];                                  // ALU m32, r32
        case 5: return [op << 3, rr(pick(BYTE_REGS), pick(BYTE_REGS))];          // ALU r/m8, r8
        case 6: return [0x66, op << 3 | 1, rr(r, m)];                             // ALU r/m16, r16
        case 7: return [0x80, rr(op, pick(BYTE_REGS)), random() & 255];           // ALU r/m8, imm8
        case 8: return [pick([0x40, 0x48]) | r];                                   // INC/DEC r32
        case 9: return [0xFF, 0x43 | (random() & 1) << 3, disp()];                // INC/DEC m32
        case 10: return [0xF7, rr(pick([2, 3]), m)];                              // NOT/NEG
        case 11: return [0xC1, rr(op, m), random() & 63];                         // shift/rotate imm
        case 12: return [0xD1, rr(op, m)];                                        // shift/rotate 1
        case 13: return [0xD3, rr(op, m)];                                        // shift/rotate CL
        case 14: return [0xC0, rr(op, pick(BYTE_REGS)), random() & 31];           // 8-bit shift/rotate
        case 15: return [0x66, 0xD3, rr(op, m)];                                  // 16-bit by CL
        case 16: return [0x0F, 0xAF, rr(r, m)];                                   // IMUL r, r/m
        case 17: return [0x6B, rr(r, m), random() & 255];                         // IMUL r, r/m, imm8
        case 18: return [0xF7, rr(pick([4, 5]), m)];                              // MUL/IMUL edx:eax
        case 19: return [0x0F, pick([0xA3, 0xAB, 0xB3, 0xBB]), rr(r, m)];         // BT* r, r
        case 20: return [0x0F, 0xBA, rr(4 + (random() & 3), m), random() & 255];  // BT* r, imm8
        case 21: return [0x0F, pick([0xBC, 0xBD]), rr(r, m)];                     // BSF/BSR
        case 22: return [0x0F, pick([0xA4, 0xAC]), rr(r, m), random() & 31];      // SHLD/SHRD imm
        case 23: return [0x0F, pick([0xA5, 0xAD]), rr(r, m)];                     // SHLD/SHRD CL
        case 24: return [0x0F, 0x40 | random() % 16, rr(r, m)];                   // CMOVcc
        case 25: return [0x0F, 0x90 | random() % 16, 0x43, disp()];               // SETcc m8
        case 26: return [0x0F, pick([0xC1, 0xB1]), rr(r, m)];                     // XADD/CMPXCHG
        case 27: return [0x0F, pick([0xC1, 0xB1]), ...mem(r)];                    // on memory
        case 28: return [0x9C, 0x8F, 0x43, disp()];                               // PUSHFD; POP m32
        case 29: return [0x9F, 0x88, 0x63, disp()];                               // LAHF; MOV m8, AH
        case 30: return [0x8D, 0x44 | r << 3, (random() & 3) << 6 | m << 3 | 3, random() & 255]; // LEA
        case 31: return [0x0F, pick([0xB6, 0xB7, 0xBE, 0xBF]), rr(r, m)];         // MOVZX/MOVSX
        case 32: return [pick([0x99, 0x98]), 0x87, rr(r, m)];                     // CDQ/CWDE; XCHG
        default: {                                                                 // DIV/IDIV ecx
            const signed = random() & 1;
            return [0xB9, ...u32(random() | 0x10000), 0x31, 0xD2, 0xF7, rr(6 + signed, 1)];
        }
    }
}
function simd() {
    const x = random() & 7, y = random() & 7;
    const kind = random() % 10;
    switch(only.startsWith("s") ? Number(only.slice(1)) : kind) {
        case 0: return [0x0F, 0x10, 0x43 | x << 3, disp() & ~15];                 // MOVUPS xmm, m128
        case 1: return [0x0F, pick([0x58, 0x59, 0x5C, 0x5D, 0x5F]), rr(x, y)];     // ADDPS...
        case 2: return random() & 1 ? [0xF2, 0x0F, pick([0x58, 0x59, 0x5C, 0x51]), rr(x, y)] // ADDSD...
            : [0xF2, 0x0F, pick([0x10, 0x11, 0x58, 0x59]), 0x43 | x << 3, disp()];
        case 3: return [0x66, 0x0F, pick([0xFE, 0xFD, 0xEF, 0xDB, 0xD5, 0xF6, 0x62, 0x6B]), rr(x, y)];
        case 4: return random() & 1 ? [0x0F, 0xC6, rr(x, y), random() & 255]      // SHUFPS
            : [0x0F, 0xC6, 0x43 | x << 3, disp() & ~15, random() & 255];
        case 5: return [0x66, 0x0F, 0x70, rr(x, y), random() & 255];              // PSHUFD
        case 6: return [0x0F, 0x2E, rr(x, y)];                                    // UCOMISS
        case 7: return [0xF2, 0x0F, 0x2C, rr(reg(), y)];                          // CVTTSD2SI
        case 8: return [0x0F, 0x11, 0x43 | x << 3, disp() & ~15];                 // MOVUPS m128, xmm
        default: return [0x66, 0x0F, 0x72, rr(pick([2, 4, 6]), x), random() & 63]; // PSxLD imm
    }
}
// Register-only x87 runs between loads and stores (depth-tracked).
function x87_run() {
    const d = () => disp() & ~7, out = [];
    let depth = 0;
    for(let k = 0; k < 2 + (random() & 1); k++) { out.push(0xDD, 0x43, d()); depth++; }
    for(let k = 0; k < 4 + random() % 8; k++) {
        const r = random() % depth, op = random() % 11;
        if(op == 0 && depth < 7) { out.push(0xD9, 0xC0 + r); depth++; }                       // FLD ST(r)
        else if(op == 1 && depth < 7) { out.push(0xD9, random() & 1 ? 0xE8 : 0xEE); depth++; } // FLD1/FLDZ
        else if(op == 2) out.push(0xD9, 0xC8 + r);                                              // FXCH
        else if(op == 3) out.push(0xD8, 0xC0 + 8 * pick([0, 1, 4, 5, 6, 7]) + r);               // Fop ST0, ST(r)
        else if(op == 4) out.push(0xDC, 0xC0 + 8 * pick([0, 1, 4, 5, 6, 7]) + r);               // Fop ST(r), ST0
        else if(op == 5 && depth >= 2) { out.push(0xDE, 0xC0 + 8 * pick([0, 1, 4, 5, 6, 7]) + Math.max(1, r)); depth--; } // FopP
        else if(op == 6) out.push(0xD9, random() & 1 ? 0xE0 : 0xE1);                           // FCHS/FABS
        else if(op == 7) out.push(0xDD, 0xD0 + r);                                              // FST ST(r)
        else if(op == 8 && depth >= 2) { out.push(0xDD, 0xD8 + Math.max(1, r)); depth--; }      // FSTP ST(r)
    }
    while(depth--) out.push(0xDD, 0x5B, d());                                                   // FSTP m64
    return out;
}
// Balanced x87 sequences (the stack is empty between them).
function x87() {
    const d = () => disp() & ~7, i = random() & 1;
    if(random() & 1) return x87_run();
    switch(random() % 8) {
        case 0: return [0xD9, 0x43, d(), 0xDD, 0x43, d(), 0xDE, 0xC9, 0xD8, 0xC0, 0xDD, 0x5B, d()]; // FLD m32; FLD m64; FMULP; FADD st0; FSTP m64
        case 1: return [0xDB, 0x43, d(), 0xDB, 0x5B, d()];                                   // FILD m32; FISTP m32
        case 2: return [0xD9, 0xE8, 0xD9, 0xEE, 0xDF, 0xF1, 0xDD, 0xD8];                     // FLD1; FLDZ; FCOMIP st1; FSTP st0
        case 3: return [0xD9, 0x43, d(), 0xD9, 0xE0, 0xD9, 0xE1, 0xD9, 0x5B, d()];            // FLD; FCHS; FABS; FSTP m32
        case 4: return [0xDD, 0x43, d(), 0xDD, 0x43, d(), 0xD9, 0xC9, 0xDE, 0xE9, 0xDF, 0xE0, 0xDD, 0x5B, d()]; // FXCH; FSUBP; FNSTSW AX
        case 5: return [0xD9, 0xE8, 0xDD, 0x43, d(), 0xDB, 0xF1, 0xDA, 0xC1 + 8 * i, 0xDD, 0xD9, 0xDD, 0xD8]; // FCOMI; FCMOVB/E
        case 6: return [0xDF, 0x43, d(), 0xDE, 0x43, d(), 0xDF, 0x5B, d()];                  // FILD m16; FIADD m16; FISTP m16
        default: return [0xD9, 0x7B, d(), 0xD9, 0x6B, d(), 0xDD, 0x43, d(), 0xDD, 0x5B, d()];  // FNSTCW; FLDCW; FLD; FSTP
    }
}
function program() {
    const body = [];
    const mix = random() % 5;
    for(let k = 0; k < 40; k++) {
        const vector = only ? only.startsWith("s") : !(mix && random() % 5);
        const float = only ? only === "x" : random() % 7 == 0;
        // Single-kind programs still interleave PUSHFD/LAHF to expose FLAGS.
        body.push(...(only && k % 4 == 3 ? [0x9C, 0x8F, 0x43, disp()] : float ? x87() : vector ? simd() : instruction()));
    }
    // DEC DWORD [ebx + 124]; JNZ top; HLT
    const tail = [0xFF, 0x4B, 124];
    const jump = -(body.length + tail.length + 6);
    return [...body, ...tail, 0x0F, 0x85, ...u32(jump), 0xF4];
}

async function machine(tier0) {
    const vm = new V86({
        wasm_path: wasm, disable_jit: !tier0, memory_size: 128 << 20, // reference: the interpreter only
        bios: { buffer: Uint8Array.from(boot).buffer }, disable_keyboard: true, disable_mouse: true,
        disable_speaker: true, net_device: { type: "none" }, autostart: false,
    });
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    vm.run();
    const end = performance.now() + 15000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x500, true) !== 0xCAFE) {
        assert(performance.now() < end, "benchmark BIOS did not start");
        await sleep(1);
    }
    await vm.stop();
    if(tier0) assert(e.ir_auto_set_tier0(1));
    if(tier0 && straddle) assert(e.ir_t0_set_ranges(1));
    return { vm, cpu, e, tier0 };
}

async function run(m, code, init, page, split) {
    const { vm, cpu, e } = m;
    // A fresh code page per case: mem8.set bypasses code-write detection.
    // Straddling programs start `split` bytes before the end of a page.
    const base = split ? CODE + page * 0x2000 + 0x1000 - split : CODE + page * 0x1000;
    cpu.mem8.set(code, base);
    cpu.mem8.set(init.data, DATA);
    cpu.mem8.fill(0, STACK - 0x1000, STACK);
    new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).setUint32(DATA + 124, ITERATIONS, true);
    cpu.reg32.set(init.regs);
    cpu.reg32[3] = DATA; cpu.reg32[4] = STACK;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0; cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = base;
    e.fpu_discard_cache();
    new Uint32Array(cpu.reg_xmm32s.buffer, cpu.reg_xmm32s.byteOffset, 32).set(init.xmm);
    cpu.mxcsr[0] = 0x1F80;
    cpu.fpu_st.fill(0); cpu.fpu_stack_empty[0] = 255; cpu.fpu_stack_ptr[0] = 0;
    e.set_control_word(0x37F); cpu.fpu_status_word[0] = 0;
    e.update_state_flags();
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    vm.run();
    const end = performance.now() + 20000;
    while(!cpu.in_hlt[0]) {
        if(performance.now() > end) {
            await vm.stop();
            const v = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
            throw new Error(`timeout (${m.tier0 ? "tier-0" : "interpreter"}): eip ${(cpu.instruction_pointer[0] >>> 0).toString(16)} ` +
                `status ${v.getUint32(0x608, true).toString(16)} counter ${v.getUint32(DATA + 124, true)} ` +
                `retired ${new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0} code ${Buffer.from(code).toString("hex")}`);
        }
        await sleep(0);
    }
    await vm.stop();
    return {
        regs: Array.from(cpu.reg32, v => v >>> 0),
        eip: cpu.instruction_pointer[0] >>> 0,
        eflags: e.get_eflags() >>> 0,
        data: Array.from(cpu.mem8.subarray(DATA, DATA + 256)),
        stack: Array.from(cpu.mem8.subarray(STACK - 64, STACK)),
        xmm: Array.from(new Uint32Array(cpu.reg_xmm32s.buffer, cpu.reg_xmm32s.byteOffset, 32), v => v >>> 0),
        count: new Uint32Array(e.memory.buffer)[664 >> 2] >>> 0,
        fpu: (e.fpu_sync_all(), [cpu.fpu_stack_ptr[0], cpu.fpu_stack_empty[0], cpu.fpu_status_word[0], ...Array.from(new Uint8Array(cpu.fpu_st.buffer, cpu.fpu_st.byteOffset, 128))]),
        status: new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x608, true),
    };
}

const reference = await machine(false), tier0 = await machine(true);
let failures = 0;
for(let c = 0; c < cases; c++) {
    const code = program();
    const init = {
        regs: Array.from({ length: 8 }, () => random()),
        data: Array.from({ length: 256 }, () => random() & 255),
        // Finite floats: exponents kept in range so arithmetic rarely makes NaNs.
        xmm: Array.from({ length: 32 }, () => random() & 0xBFFFFFFF),
    };
    const split = straddle ? 4 + random() % (code.length - 8) : 0;
    const expected = await run(reference, code, init, c, split), actual = await run(tier0, code, init, c, split);
    for(const key of Object.keys(expected)) {
        try { assert.deepEqual(actual[key], expected[key]); }
        catch {
            failures++;
            console.log(`case ${c}: ${key} differs\n  code ${Buffer.from(code).toString("hex")}\n  expected ${JSON.stringify(expected[key])}\n  actual   ${JSON.stringify(actual[key])}`);
            break;
        }
    }
}
const pages = tier0.e.ir_t0_stat(0);
await reference.vm.destroy(); await tier0.vm.destroy();
assert(pages > 0, "no Tier-0 page was compiled");
if(failures) { console.log(`FAIL: ${failures}/${cases} cases differ`); process.exit(1); }
console.log(`PASS: ${cases} random programs, Tier-0 (${pages} page compiles) matches the interpreter`);
process.exit(0);
