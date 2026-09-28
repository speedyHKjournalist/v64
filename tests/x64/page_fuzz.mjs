#!/usr/bin/env node
// Random long-mode programs, each looped until its code pages are compiled by
// the x64 page tier (src/rust/x64/pagegen.rs), then compared with the same
// guest run by the wide interpreter alone: every GPR, RFLAGS and the data
// pages must be identical. The programs mix templated forms (all widths,
// memory operands with SIB/RIP/FS bases, LOCK RMW, stack, calls, forward
// branches) with interpreter steps and page-crossing accesses (retries).
//
// PAGE_FUZZ_SEED, PAGE_FUZZ_CASES (per guest), PAGE_FUZZ_GUESTS.
import assert from "node:assert/strict";
import fs from "node:fs";
import {assemble} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {setImmediate as yield_event} from "node:timers/promises";

let seed = Number(process.env.PAGE_FUZZ_SEED || 1) >>> 0 || 1;
const random = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0x100000000;
};
const pick = list => list[Math.floor(random() * list.length)];
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const hex = n => "0x" + n.toString(16);

// r13: small index; r14: data base; r15: loop counter; rsp: stack.
const GPR64 = ["rax", "rcx", "rdx", "rbx", "rsi", "rdi", "rbp", "r8", "r9", "r10", "r11", "r12"];
const NAMES = {
    rax: ["rax", "eax", "ax", "al"], rcx: ["rcx", "ecx", "cx", "cl"], rdx: ["rdx", "edx", "dx", "dl"],
    rbx: ["rbx", "ebx", "bx", "bl"], rsi: ["rsi", "esi", "si", "sil"], rdi: ["rdi", "edi", "di", "dil"],
    rbp: ["rbp", "ebp", "bp", "bpl"], r8: ["r8", "r8d", "r8w", "r8b"], r9: ["r9", "r9d", "r9w", "r9b"],
    r10: ["r10", "r10d", "r10w", "r10b"], r11: ["r11", "r11d", "r11w", "r11b"], r12: ["r12", "r12d", "r12w", "r12b"],
};
const WIDTHS = [64, 32, 16, 8];
const SIZE = {64: "qword", 32: "dword", 16: "word", 8: "byte"};
const LEGACY8 = ["al", "cl", "dl", "bl", "ah", "ch", "dh", "bh"];
const REX8 = ["al", "cl", "dl", "bl", "sil", "dil", "bpl", "r8b", "r9b", "r10b", "r11b", "r12b"];
// Registers usable together in one instruction (no AH-BH with REX).
const regs = (w, n) => {
    const set = w === 8 ? (random() < 0.4 ? LEGACY8 : REX8) : GPR64.map(r => NAMES[r][WIDTHS.indexOf(w)]);
    return Array.from({length: n}, () => pick(set));
};
const reg = w => regs(w, 1)[0];
// Combinable with a memory operand (which may use REX.B for r14).
const low_reg = w => NAMES[pick(["rax", "rcx", "rdx", "rbx", "rsi", "rdi", "r8", "r9", "r10"])][WIDTHS.indexOf(w)];
// Data: two pages at r14 = FS base = 0x500000, and a RIP-relative buffer.
const mem = w => {
    const bytes = w / 8;
    const cross = random() < 0.04;
    const disp = cross ? 4096 - int(1, Math.max(1, bytes - 1)) : int(0, 8190 - bytes) & ~(random() < 0.7 ? bytes - 1 : 0);
    switch(int(0, 4))
    {
        case 0: return `${SIZE[w]} [r14+${disp}]`;
        case 1: return `${SIZE[w]} [r14+r13*${pick([1, 2, 4, 8])}+${Math.min(disp, 8190 - 255 * 8 - bytes)}]`;
        case 2: return `${SIZE[w]} [fs:${disp}]`;
        case 3: return `${SIZE[w]} [rel data+${disp}]`;
        default: return `${SIZE[w]} [r14+${disp - 64}+64]`;
    }
};
const imm = w => {
    const v = [0, 1, -1, 0x7F, 0x80, 0x7FFF, 0x8000, 0x7FFFFFFF, -0x80000000, int(-1000, 1000), int(0, 0xFFFFFFFF) | 0][int(0, 10)];
    if(w === 8) return v & 0xFF;
    if(w === 16) return v & 0xFFFF;
    return v | 0;
};
const CC = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];
const ALU = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
const rm = w => random() < 0.5 ? low_reg(w) : mem(w);

function instruction(state)
{
    const w = pick(WIDTHS);
    const alu = pick(ALU);
    const w16 = pick([16, 32, 64]);
    switch(int(0, 51))
    {
        case 40: { const wide = random() < 0.5; const d = wide ? "r11" : "r11d";
            return `mov r11d, ${int(3, 0x7FFFFFF0) | 3}\n${pick([`xor edx, edx\ndiv ${d}`, `${wide ? "cqo" : "cdq"}\nidiv ${d}`, `mov edx, 1\ndiv ${d}`, (at => `or ${SIZE[wide ? 64 : 32]} [r14+${at}], 3\nxor edx, edx\ndiv ${SIZE[wide ? 64 : 32]} [r14+${at}]`)(int(0, 8000) & ~7)])}`; }
        case 50: case 51: case 41: { const op = pick(["movsb", "movsw", "movsd", "movsq", "stosb", "stosw", "stosd", "stosq"]);
            const src = int(0, 8000), dst = random() < 0.3 ? src + int(-16, 16) : int(0, 8000), count = pick([0, 1, int(2, 16), int(17, 600)]);
            return `lea rsi, [r14+${src}]\nlea rdi, [r14+${Math.max(0, dst)}]\nxor [rsi], r15d\nmov eax, r15d\nmov ecx, ${count}\n${random() < 0.2 ? "std\n" : ""}${random() < 0.8 ? "rep " : ""}${op}\ncld`; }
        case 42: return "swapgs\nadd r12, [gs:8]\nswapgs";
        case 43: return pick(["cli", "mov eax, ds", "mov r9w, ss", `mov word [r14+${int(0, 8000)}], cs`, "mov rdx, fs"]);
        case 44: { const sw = pick([32, 64]); return `${pick(["shld", "shrd"])} ${rm(sw)}, ${low_reg(sw)}, ${int(0, 70)}`; }
        case 45: return `${random() < 0.5 ? "lock " : ""}cmpxchg16b [r14+${int(0, 8000) & ~15}]`;
        case 46: return `${random() < 0.5 ? "lock " : ""}cmpxchg8b [r14+${int(0, 8000)}]`;
        case 48: return pick(["mov r11, cr3\nmov cr3, r11", `invlpg [r14+${int(0, 8000)}]`]);
        case 49: return pick([`add ${low_reg(64)}, r15`, `xor ${mem(32)}, r15d`, `imul ${low_reg(32)}, r15d, ${int(1, 99)}`]);
        case 47: { const d = int(2, 9); return `mov edx, ${int(0, d - 1)}\nmov r11, ${d}\ndiv r11`; }
        case 0: case 1: case 38: { const [a, b] = regs(w, 2); return `${alu} ${a}, ${b}`; }
        case 2: return `${alu} ${reg(w)}, ${imm(w)}`;
        case 3: return `${alu} ${low_reg(w)}, ${mem(w)}`;
        case 4: return `${random() < 0.3 && alu !== "cmp" ? "lock " : ""}${alu} ${mem(w)}, ${low_reg(w)}`;
        case 5: return `${alu} ${mem(w)}, ${imm(w)}`;
        case 6: { const [a, b] = regs(w, 2); return `test ${a}, ${random() < 0.5 ? imm(w) : b}`; }
        case 7: return `mov ${reg(w)}, ${imm(w === 64 && random() < 0.3 ? 32 : w)}`;
        case 8: return w === 64 && random() < 0.3 ? `mov ${reg(64)}, ${hex(int(0, 0xFFFFFFFF) * 0x100000000 + int(0, 0xFFFFFFFF))}` : `mov ${low_reg(w)}, ${mem(w)}`;
        case 9: return `mov ${mem(w)}, ${random() < 0.5 ? low_reg(w) : imm(w === 64 ? 32 : w)}`;
        case 10: return pick([`movzx ${pick(["eax", "ecx", "edx", "ebx", "esi", "edi", "ebp"])}, ${pick(LEGACY8)}`,
            `movsx ${low_reg(pick([32, 64]))}, ${pick([low_reg(8), mem(8), low_reg(16), mem(16)])}`,
            `movzx ${low_reg(pick([16, 32, 64]))}, ${pick([low_reg(8), mem(8)])}`]);
        case 11: return pick([`movsxd ${low_reg(64)}, ${low_reg(32)}`, `movsxd ${low_reg(64)}, ${mem(32)}`, `movzx ${low_reg(64)}, ${mem(16)}`]);
        case 12: return `lea ${low_reg(pick([64, 32, 16]))}, [${low_reg(64)}+${low_reg(64)}*${pick([1, 2, 4, 8])}+${int(-2000, 2000)}]`;
        case 13: { const op = pick(["inc", "dec", "neg", "not"]); return random() < 0.5 ? `${op} ${reg(w)}` : `${random() < 0.3 ? "lock " : ""}${op} ${mem(w)}`; }
        case 14: return `${pick(["shl", "shr", "sar", "rol", "ror"])} ${random() < 0.7 ? reg(w) : mem(w)}, ${pick([1, int(0, 70) & 0xFF, int(0, 7)])}`;
        case 15: return `${pick(["shl", "shr", "sar", "rol", "ror", "rcl", "rcr"])} ${random() < 0.8 ? reg(w) : mem(w)}, cl`;
        case 16: return `imul ${low_reg(w16)}, ${rm(w16)}${random() < 0.5 ? ", " + imm(16) : ""}`;
        case 17: { const mw = pick([32, 64]); return `${pick(["mul", "imul"])} ${rm(mw)}`; }
        case 18: { const r = low_reg(64); return `push ${pick([r, low_reg(64), mem(64), String(imm(32))])}\npop ${r}`; }
        case 19: return `cmov${pick(CC)} ${low_reg(w16)}, ${rm(w16)}`;
        case 20: return `set${pick(CC)} ${random() < 0.6 ? reg(8) : mem(8)}`;
        case 21: { const n = state.labels++; return `j${pick(CC)} .s${n}\n${instruction_simple()}\n${instruction_simple()}\n.s${n}:`; }
        case 22: return `xchg ${low_reg(w)}, ${rm(w)}`;
        case 23: return `${random() < 0.5 ? "lock " : ""}xadd ${mem(w)}, ${low_reg(w)}`;
        case 24: return random() < 0.5 ? `cmpxchg ${low_reg(w)}, ${low_reg(w)}` : `lock cmpxchg ${mem(w)}, ${low_reg(w)}`;
        case 25: return pick(["cbw", "cwde", "cdqe", "cwd", "cdq", "cqo"]);
        case 26: return `${pick(["bt", "bts", "btr", "btc"])} ${rm(w16)}, ${random() < 0.5 ? int(0, 255) : ["r13", "r13d", "r13w"][[64, 32, 16].indexOf(w16)]}`;
        case 27: return `${pick(["bsf", "bsr", "popcnt"])} ${low_reg(w16)}, ${rm(w16)}`;
        case 28: return `bswap ${low_reg(pick([32, 64]))}`;
        case 29: return pick(["clc", "stc", "cmc", "lahf", "sahf", "cld", "std", "nop", "pushfq\npopfq", "pushfq\npop rax", "xchg eax, eax", "nop dword [rax+rax+0x10]"]);
        case 30: return `call ${pick(["leaf_near", "leaf_far"])}`;
        case 31: return pick(["cpuid", "xorps xmm0, xmm1", "movq rax, xmm2", "movq xmm2, rbx", "pause", "paddd xmm3, xmm2"]);
        case 32: return `mov r13d, ${int(0, 255)}`;
        case 33: return `test ${mem(w)}, ${random() < 0.5 ? imm(w) : low_reg(w)}`;
        case 34: return `cmp ${low_reg(w)}, ${mem(w)}\nj${pick(CC)} .c${state.labels}\ninc r12\n.c${state.labels++}:`;
        case 35: return `sub ${low_reg(w)}, ${imm(8)}\nset${pick(CC)} al`;
        case 36: { const r = reg(32); return `xor ${r}, ${r}`; }
        case 37: return `dec r12\nj${pick(["ne", "e", "s", "g", "le"])} .d${state.labels}\nnot r11\n.d${state.labels++}:`;
        default: return `${pick(["add", "sub", "and", "or", "xor", "adc", "sbb"])} ${mem(w)}, ${imm(w)}`;
    }
}
function instruction_simple()
{
    return pick([`add ${low_reg(64)}, ${int(0, 99)}`, `xor ${low_reg(32)}, ${low_reg(32)}`, `inc ${mem(32)}`, `mov ${low_reg(16)}, ${mem(16)}`]);
}

const cases = Number(process.env.PAGE_FUZZ_CASES || 12);
const guests = Number(process.env.PAGE_FUZZ_GUESTS || 4);
const ITERATIONS = Number(process.env.PAGE_FUZZ_ITERATIONS || 300);
const RESULT = 0x300000, RECORD = 0x2100, MAGIC = 0xC064C064;
let failures = 0, native_total = 0;
for(let guest = 0; guest < guests; guest++)
{
    const first_seed = seed;
    let body = `
mov rax, cr4
or eax, 0x600
mov cr4, rax
mov ecx, 0xC0000100
mov eax, 0x500000
xor edx, edx
wrmsr
mov ecx, 0xC0000102
mov eax, 0x500100
xor edx, edx
wrmsr
`;
    let functions = "";
    for(let c = 0; c < cases; c++)
    {
        const state = {labels: 0};
        let lines = [];
        const count = int(20, 70);
        for(let i = 0; i < count; i++) lines.push(instruction(state));
        // Cold access caches each iteration: generated slow paths run too.
        if(random() < 0.5) lines.splice(int(0, lines.length), 0, "mov r11, cr3\nmov cr3, r11");
        let init = GPR64.map(r => `mov ${r}, ${hex(int(0, 0xFFFFFFFF) * 0x100000000 + int(0, 0xFFFFFFFF))}`).join("\n");
        if(process.env.PAGE_FUZZ_BODY)
        {
            // {init: string, lines: [string]} (see PAGE_FUZZ_SAVE)
            const saved = JSON.parse(fs.readFileSync(process.env.PAGE_FUZZ_BODY, "utf8"));
            init = saved.init;
            lines = saved.lines;
        }
        if(process.env.PAGE_FUZZ_SAVE && +process.env.PAGE_FUZZ_SAVE_GUEST === guest && c === +process.env.PAGE_FUZZ_SAVE_CASE)
            fs.writeFileSync(process.env.PAGE_FUZZ_SAVE, JSON.stringify({init, lines}, null, 1));
        functions += `
align 4096
case_${c}:
${init}
mov r13d, ${int(0, 255)}
mov r14, 0x500000
mov r15d, ${ITERATIONS}
push 0x${(int(0, 0xFFF) & 0xCD5).toString(16)}
popfq
.loop:
${lines.join("\n")}
dec r15d
jnz .loop
mov r15, ${RESULT + 8 + c * RECORD}
${[...GPR64, "r13", "r14"].map((r, i) => `mov [r15+${i * 8}], ${r}`).join("\n")}
pushfq
pop rax
mov [r15+${15 * 8}], rax
cld
mov rsi, 0x500000
lea rdi, [r15+256]
mov ecx, 8192
rep movsb
; reset the data pages for the next case
mov rdi, 0x500000
mov ecx, 8192
mov al, 0x5A
rep stosb
ret
`;
        body += `call case_${c}\n`;
    }
    const source = long_mode_guest(body + `mov rsp, 0x3F0000\n`, `
${functions}
align 4096
leaf_near:
add r12, 7
xor r11, r12
ret
align 4096
leaf_far:
lea r12, [r12+r11*2+3]
ror r11, 5
ret
align 16
data: times 8192 db 0
`);
    const dir = assemble(`page-fuzz-${guest}`, source.replace("high_mode:\n", "high_mode:\nmov rdi, 0x500000\nmov ecx, 8192\nmov al, 0x5A\nrep stosb\n"));
    const length = 8 + cases * RECORD;
    const run = async jit => {
        const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
        const emulator = new V86({multiboot: {url: dir + "guest.bin"}, memory_size: 32 << 20, acpi: true,
            disable_jit: !jit, experimental_smp_jit: true, ir_sync_publication: true, autostart: false, log_level: 0});
        try
        {
            await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
            const cpu = emulator.v86.cpu;
            const deadline = performance.now() + 120000;
            let rounds = 0;
            while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(RESULT, true) !== MAGIC)
            {
                if(performance.now() > deadline) throw new Error("guest timed out: " + JSON.stringify(cpu.get_diagnostics()));
                cpu.run_cores();
                if((++rounds & 63) === 0) await yield_event();
            }
            const native = jit ? cpu.wm.exports.x64_page_stat(1) : 0;
            return {result: Buffer.from(cpu.mem8.slice(RESULT, RESULT + length)), native,
                stats: jit ? Array.from({length: 13}, (_, i) => cpu.wm.exports.x64_page_stat(i)) : []};
        }
        finally { await emulator.destroy(); }
    };
    const reference = await run(false);
    const compiled = await run(true);
    native_total += compiled.native;
    for(let c = 0; c < cases; c++)
    {
        const at = 8 + c * RECORD;
        const a = reference.result.subarray(at, at + RECORD), b = compiled.result.subarray(at, at + RECORD);
        if(!a.equals(b))
        {
            failures++;
            const names = [...GPR64, "r13", "r14", "r15", "flags"];
            const diffs = [];
            for(let i = 0; i < 16; i++) if(a.readBigUInt64LE(i * 8) !== b.readBigUInt64LE(i * 8)) diffs.push(`${names[i]}: interpreter ${a.readBigUInt64LE(i * 8).toString(16)} page ${b.readBigUInt64LE(i * 8).toString(16)}`);
            for(let i = 256; i < RECORD; i++) if(a[i] !== b[i]) { diffs.push(`data+${i - 256}: ${a[i].toString(16)} vs ${b[i].toString(16)}`); if(diffs.length > 24) break; }
            console.log(`FAIL guest ${guest} (seed ${first_seed}) case ${c}:\n  ` + diffs.join("\n  "));
        }
    }
    console.log(`guest ${guest} (seed ${first_seed}): ${cases} cases, native retired ${compiled.native}, stats ${JSON.stringify(compiled.stats)}`);
    assert.ok(compiled.native > cases * ITERATIONS * 5, "the page tier executed the loops");
}
assert.equal(failures, 0, `${failures} cases differ`);
console.log(`PASS page fuzz: ${guests * cases} programs identical to the interpreter (${native_total} native instructions)`);
