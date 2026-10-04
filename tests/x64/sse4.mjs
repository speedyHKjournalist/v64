#!/usr/bin/env node
// SSE4.1 and SSE4.2 integer forms in the x64 engine (docs/simd-xsave-plan.md
// P4b): in 64-bit mode (XMM8-15 through REX, PEXTRQ/PINSRQ through REX.W,
// register destinations zero-extended to 64 bits) and in compatibility mode,
// with register and memory sources, against QEMU and the SDM model of
// tests/rust/sse4_model.mjs; PTEST's flags; #GP(0) for a misaligned m128
// (none for narrow operands), #NM with CR0.TS, #UD with CR0.EM, F3 or
// MOVNTDQA from a register. Interpreted, with the x64 page tier, and with
// compatibility-mode code compiled. Both blocks loop so that they become hot.
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";
import {extract, get, insert, insertps, ptest, set, sse4_38, sse4_3a} from "../rust/sse4_model.mjs";

const OUT = 0x300000, CASE = OUT + 0x80, SKIP = OUT + 0x84, MATCH = OUT + 0xC0, FAULTS = OUT + 0x100, RESULTS = OUT + 0x1000;
// (compatibility-mode code is compiled only after a while)
const IDT = 0x380000, ROUNDS = 400, COMPAT_ROUNDS = 20000;

// 16 sample vectors: random bytes and lanes of edge values
const samples = new Uint8Array(16 * 16);
{
    const view = new DataView(samples.buffer);
    let seed = 0x2468ACE1;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const edges = [[1, [0x00, 0x01, 0x7F, 0x80, 0x81, 0xFF, 0x40, 0xC0]],
        [2, [0x0000, 0x0001, 0x7FFF, 0x8000, 0x8001, 0xFFFF, 0x4000, 0xC000]],
        [4, [0, 1, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFFFFFF, 0x40000000, 0xC0000000]]];
    for(let n = 0; n < 16; n++)
    {
        const [size, values] = edges[n % 4] || [1, null];
        for(let i = 0; i < 16; i += size)
        {
            const value = values ? values[random() & 7] : random() & 255;
            if(size === 1) samples[n * 16 + i] = value;
            else if(size === 2) view.setUint16(n * 16 + i, value, true);
            else view.setUint32(n * 16 + i, value, true);
        }
    }
}
const sample = i => samples.subarray(i * 16, i * 16 + 16);
const hex = b => Buffer.from(b).toString("hex");

// [name, 66 0F 38 opcode byte, memory bytes]
const BINARY = [["pblendvb", 0x10], ["blendvps", 0x14], ["blendvpd", 0x15], ["pmovsxbw", 0x20, 8], ["pmovsxbd", 0x21, 4],
    ["pmovsxbq", 0x22, 2], ["pmovsxwd", 0x23, 8], ["pmovsxwq", 0x24, 4], ["pmovsxdq", 0x25, 8], ["pmuldq", 0x28], ["pcmpeqq", 0x29],
    ["packusdw", 0x2B], ["pmovzxbw", 0x30, 8], ["pmovzxbd", 0x31, 4], ["pmovzxbq", 0x32, 2], ["pmovzxwd", 0x33, 8],
    ["pmovzxwq", 0x34, 4], ["pmovzxdq", 0x35, 8], ["pcmpgtq", 0x37], ["pminsb", 0x38], ["pminsd", 0x39], ["pminuw", 0x3A],
    ["pminud", 0x3B], ["pmaxsb", 0x3C], ["pmaxsd", 0x3D], ["pmaxuw", 0x3E], ["pmaxud", 0x3F], ["pmulld", 0x40], ["phminposuw", 0x41]];
const IMMEDIATE = [["blendps", 0x0C], ["blendpd", 0x0D], ["pblendw", 0x0E], ["insertps", 0x21], ["mpsadbw", 0x42]];

// the cases: {long, kind, name, op, memory, dst, src, a, b, mask, imm8, offset}; the result is at RESULTS + 16 n
const cases = [];
const regs = long => long ? 16 : 8;
for(const long of [true, false])
{
    const base = long ? 8 : 0;
    for(const [name, op, bytes = 16] of BINARY) for(const memory of [false, true])
    {
        for(const [a, b, mask] of memory ? [[3, 6, 9]] : [[0, 1, 2], [2, 5, 11], [7, 7, 4]])
        {
            const n = cases.length;
            const dst = base + n % 8;
            const src = memory ? undefined : a === b ? dst : (dst + 1 + n * 5 % (regs(long) - 1)) % regs(long);
            cases.push({long, kind: "binary", name, op, memory, dst, src, a, b, mask, imm8: 0, offset: memory && bytes < 16 ? n & 7 : 0});
        }
    }
    for(const [name, op] of IMMEDIATE) for(const memory of [false, true]) for(const imm8 of memory ? [0x1B, 0xE4] : [0x00, 0x5A, 0xA5, 0xFF, 0x93])
    {
        const n = cases.length;
        const dst = base + n % 8, src = memory ? undefined : (dst + 3) % regs(long);
        cases.push({long, kind: "immediate", name, op, memory, dst, src, a: n % 16, b: (n + 5) % 16, imm8, offset: 0});
    }
    for(const memory of [false, true]) for(const [a, b] of [[1, 2], [5, 5], [10, 12]])
    {
        const n = cases.length;
        cases.push({long, kind: "ptest", name: "ptest", op: 0x17, memory, dst: base + n % 8, src: memory ? undefined : base + (n + 1) % 8, a, b, imm8: 0, offset: 0});
    }
    // extracts to a GPR (preloaded with ones: zero-extended) and to memory, inserts from a GPR and memory
    for(const [name, op, size] of [["pextrb", 0x14, 1], ["pextrw", 0x15, 2], ["pextrd", 0x16, 4], ["extractps", 0x17, 4],
        ...long ? [["pextrq", 0x16, 8]] : []]) for(const memory of [false, true]) for(const imm8 of [0, 3, 6, 13])
    {
        const n = cases.length;
        cases.push({long, kind: "extract", name, op, size, memory, dst: base + n % 8, a: n % 16, imm8, offset: memory ? n & 7 : 0});
    }
    for(const [name, op, size] of [["pinsrb", 0x20, 1], ["pinsrd", 0x22, 4], ...long ? [["pinsrq", 0x22, 8]] : []])
        for(const memory of [false, true]) for(const imm8 of [0, 1, 7, 14])
    {
        const n = cases.length;
        cases.push({long, kind: "insert", name, op, size, memory, dst: base + n % 8, a: n % 16, b: (n + 9) % 16, imm8, offset: memory ? n & 7 : 0});
    }
    {
        const n = cases.length;
        cases.push({long, kind: "movntdqa", name: "movntdqa", op: 0x2A, memory: true, dst: base + n % 8, a: n % 16, b: (n + 4) % 16, imm8: 0, offset: 0});
    }
}
const at = (i, offset = 0) => `[samples + ${i * 16 + offset}]`;
const code = (c, n) => {
    const x = r => "xmm" + r, out = RESULTS + n * 16;
    const lines = [];
    switch(c.kind)
    {
        case "binary":
            lines.push(`movdqu xmm0,${at(c.mask)}`, `movdqu ${x(c.dst)},${at(c.a)}`);
            if(!c.memory) lines.push(`movdqu ${x(c.src)},${at(c.b)}`);
            lines.push(`${c.name} ${x(c.dst)},${c.memory ? at(c.b, c.offset) : x(c.src)}`, `movdqu [${out}],${x(c.dst)}`);
            break;
        case "immediate":
            lines.push(`movdqu ${x(c.dst)},${at(c.a)}`);
            if(!c.memory) lines.push(`movdqu ${x(c.src)},${at(c.b)}`);
            lines.push(`${c.name} ${x(c.dst)},${c.memory ? at(c.b) : x(c.src)},${c.imm8}`, `movdqu [${out}],${x(c.dst)}`);
            break;
        case "ptest":
            lines.push(`movdqu ${x(c.dst)},${at(c.a)}`);
            if(!c.memory) lines.push(`movdqu ${x(c.src)},${at(c.b)}`);
            // (OF, SF, AF set by 0x7F + 1, CF by STC)
            lines.push("mov al,0x7F", "add al,1", "stc", `ptest ${x(c.dst)},${c.memory ? at(c.b) : x(c.src)}`);
            lines.push(c.long ? "pushfq\npop rax" : "pushfd\npop eax", "and eax,0x8D5", `mov [${out}],eax`);
            break;
        case "extract":
        {
            lines.push(`movdqu ${x(c.dst)},${at(c.a)}`);
            if(c.memory)
            {
                lines.push(`mov dword [${out}],0xEEEEEEEE`, `mov dword [${out + 4}],0xEEEEEEEE`, `mov dword [${out + 8}],0xEEEEEEEE`, `mov dword [${out + 12}],0xEEEEEEEE`);
                const width = ["", "byte", "word", "", "dword", "", "", "", "qword"][c.size];
                lines.push(`${c.name} ${width} [${out + c.offset}],${x(c.dst)},${c.imm8}`);
            }
            else
            {
                // (the register written, zero-extended: ones before)
                lines.push(c.long ? "mov rdx,-1" : "mov edx,-1");
                // (PEXTRW to a register: the SSE4.1 encoding, 66 0F 3A 15)
                if(c.op === 0x15)
                {
                    const rex = c.dst >= 8 ? [0x44] : [];
                    lines.push(`db 0x66, ${[...rex, 0x0F, 0x3A, 0x15, 0xC0 | (c.dst & 7) << 3 | 2, c.imm8].join(", ")}`);
                }
                else lines.push(`${c.name} ${c.size === 8 ? "rdx" : "edx"},${x(c.dst)},${c.imm8}`);
                lines.push(c.long ? `mov [${out}],rdx` : `mov [${out}],edx\nmov dword [${out + 4}],0`);
            }
            break;
        }
        case "insert":
            lines.push(`movdqu ${x(c.dst)},${at(c.a)}`);
            if(c.memory) lines.push(`${c.name} ${x(c.dst)},${["", "byte", "", "", "dword", "", "", "", "qword"][c.size]} ${at(c.b, c.offset)},${c.imm8}`);
            else lines.push(c.size === 8 ? `mov rdx,${at(c.b)}` : `mov edx,${at(c.b)}`, `${c.name} ${x(c.dst)},${c.size === 8 ? "rdx" : "edx"},${c.imm8}`);
            lines.push(`movdqu [${out}],${x(c.dst)}`);
            break;
        case "movntdqa":
            lines.push(`movntdqa ${x(c.dst)},${at(c.b)}`, `movdqu [${out}],${x(c.dst)}`);
            break;
    }
    return lines.join("\n");
};
const block = long => cases.map((c, n) => c.long === long ? code(c, n) : "").filter(Boolean).join("\n");

// the faults: [vector, what, long, instruction, the vector QEMU raises instead]
const FAULT_CASES = [
    [13, "pminud xmm8,[misaligned]", true, "pminud xmm8,[samples + 8]"],
    // PTEST's m128 is of exception type 4 (SDM): legacy SSE raises #GP(0)
    // unless it is 16-byte aligned. QEMU 10.2 does not check (none).
    [13, "ptest xmm1,[misaligned]", false, "ptest xmm1,[samples + 4]", 0],
    [13, "movntdqa xmm9,[misaligned]", true, "movntdqa xmm9,[samples + 8]"],
    [13, "mpsadbw xmm2,[misaligned]", false, "mpsadbw xmm2,[samples + 12],5"],
    [7, "pmaxsd xmm10,xmm11 with CR0.TS", true, "pmaxsd xmm10,xmm11"],
    [7, "pextrd eax,xmm1 with CR0.TS", false, "pextrd eax,xmm1,1"],
    [6, "pblendw xmm1,xmm2 with CR0.EM", true, "pblendw xmm1,xmm2,3"],
    [6, "insertps xmm1,xmm2 with CR0.EM", false, "insertps xmm1,xmm2,0x10"],
    [6, "F3 pminud xmm1,xmm2", true, "db 0xF3, 0x66, 0x0F, 0x38, 0x3B, 0xCA"],
    [6, "F2 pextrb eax,xmm1", false, "db 0xF2, 0x66, 0x0F, 0x3A, 0x14, 0xC8, 1"],
    [6, "movntdqa xmm1,xmm2", true, "db 0x66, 0x0F, 0x38, 0x2A, 0xCA"],
    [6, "movntdqa xmm3,xmm4", false, "db 0x66, 0x0F, 0x38, 0x2A, 0xDC"],
];
const SET_CR0 = (bits, long) => long ? `mov rax,cr0\nor eax,${bits}\nmov cr0,rax` : `mov eax,cr0\nor eax,${bits}\nmov cr0,eax`;
const CLEAR_CR0 = long => long ? "mov rax,cr0\nand eax,~12\nmov cr0,rax" : "mov eax,cr0\nand eax,~12\nmov cr0,eax";
const faults = long => FAULT_CASES.map(([vector, what, in_long, instruction], n) => in_long !== long ? "" : `
${vector === 7 ? SET_CR0(8, long) : vector === 6 && what.includes("CR0.EM") ? SET_CR0(4, long) : ""}
mov dword [${CASE}],${n}
mov dword [${SKIP}],fault_end${n} - fault${n}
fault${n}: ${instruction}
fault_end${n}:
${CLEAR_CR0(long)}
mov eax,fault${n}
cmp eax,[${FAULTS + n * 16 + 8}]
sete byte [${MATCH + n}]`).join("\n");

const directory = assemble("sse4", long_mode_guest(`
mov ebx,6
mov rax,HIGH+ud
call set_gate
mov ebx,7
mov rax,HIGH+nm
call set_gate
mov ebx,13
mov rax,HIGH+gp
call set_gate
lidt [rel idtr]
mov rax,cr4
or eax,3 << 9 ; OSFXSR, OSXMMEXCPT
mov cr4,rax
; 64-bit mode
mov ecx,${ROUNDS}
.rounds:
${block(true)}
dec ecx
jnz .rounds
${faults(true)}
; compatibility mode
push 8
mov rax,compat
push rax
o64 retf
bits 32
compat:
mov ecx,${COMPAT_ROUNDS}
.rounds:
${block(false)}
dec ecx
jnz .rounds
${faults(false)}
jmp 0x18:back
bits 64
back:
mov rax,HIGH+in_long_mode
jmp rax
in_long_mode:
`, `
set_gate:
mov rdi,rbx
shl rdi,4
add rdi,${IDT}
mov [rdi],ax
mov word [rdi + 2],0x18
mov word [rdi + 4],0x8E00
shr rax,16
mov [rdi + 6],ax
shr rax,16
mov [rdi + 8],eax
mov dword [rdi + 12],0
ret
ud:
mov ecx,6
jmp record
nm:
mov ecx,7
jmp record
gp:
add rsp,8
mov ecx,13
record:
mov edx,[${CASE}]
shl edx,4
mov [${FAULTS} + rdx],ecx
mov rax,[rsp]
mov [${FAULTS} + rdx + 8],rax
mov eax,[${SKIP}]
add [rsp],rax
iretq
align 8
idtr: dw 511
dq ${IDT}
align 16
samples: db ${Array.from(samples).join(",")}
`));

const length = RESULTS - OUT + cases.length * 16;
const expected_result = (c) => {
    const result = new Uint8Array(16);
    switch(c.kind)
    {
        case "binary":
        {
            // XMM0 loaded first, then the destination, then a register source
            const registers = [];
            registers[0] = sample(c.mask);
            registers[c.dst] = sample(c.a);
            if(!c.memory) registers[c.src] = sample(c.b);
            const bytes = BINARY.find(([name]) => name === c.name)[2] || 16;
            const source = c.memory ? Uint8Array.from({length: 16}, (_, i) => i < bytes ? samples[c.b * 16 + c.offset + i] : 0) : registers[c.src];
            return sse4_38(c.op, registers[c.dst], source, registers[0]);
        }
        case "immediate":
        {
            const s = sample(c.b), d = !c.memory && c.src === c.dst ? s : sample(c.a);
            return c.op === 0x21 && c.memory ? insertps(d, get(s, 4, 0), c.imm8) : sse4_3a(c.op, d, s, c.imm8);
        }
        case "ptest":
        {
            const s = sample(c.b), d = !c.memory && c.src === c.dst ? s : sample(c.a);
            const {zf, cf} = ptest(d, s);
            set(result, 4, 0, BigInt((zf ? 0x40 : 0) | (cf ? 1 : 0)));
            return result;
        }
        case "extract":
        {
            const value = extract(sample(c.a), c.size, c.imm8);
            if(c.memory)
            {
                result.fill(0xEE);
                set(result.subarray(c.offset), c.size, 0, value);
            }
            else set(result, 8, 0, value);
            return result;
        }
        case "insert":
        {
            const value = c.memory ? get(samples.subarray(c.b * 16 + c.offset), c.size, 0) : get(sample(c.b), c.size, 0);
            return insert(sample(c.a), c.size, value, c.imm8);
        }
        case "movntdqa":
            return sample(c.b);
    }
};
const check = (result, label) => {
    // the model first: QEMU is a reference, not the specification
    cases.forEach((c, n) => {
        const value = Uint8Array.from(result.subarray(RESULTS - OUT + n * 16, RESULTS - OUT + n * 16 + 16));
        assert.equal(hex(value), hex(expected_result(c)),
            `${label}: ${c.long ? "64-bit" : "compatibility"} ${c.name} xmm${c.dst}, ${c.memory ? "[mem]" : c.src === undefined ? "r" : "xmm" + c.src} imm8=${c.imm8}`);
    });
    FAULT_CASES.forEach(([vector, what, , , qemu], n) => {
        const deviation = label === "QEMU" && qemu !== undefined;
        assert.equal(result.readUInt32LE(FAULTS - OUT + n * 16), deviation ? qemu : vector, `${label}: ${what}: vector`);
        assert.equal(result[MATCH - OUT + n], deviation && qemu === 0 ? 0 : 1, `${label}: ${what}: RIP`);
    });
};
// v86 against QEMU, but for the fault records where QEMU deviates
const comparable = buffer => {
    const copy = Buffer.from(buffer);
    FAULT_CASES.forEach(([, , , , qemu], n) => {
        if(qemu === undefined) return;
        copy.fill(0, FAULTS - OUT + n * 16, FAULTS - OUT + n * 16 + 16);
        copy[MATCH - OUT + n] = 0;
    });
    return copy;
};
const expected = await reference(directory, {length});
check(expected, "QEMU");
for(const [label, options, compat] of [["interpreted", {}, false],
    ["x64 page tier", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}, false],
    ["x64 page tier + compatibility-mode JIT", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}, true]])
{
    let page = 0, tier0;
    const result = await actual(directory, {length, timeout: 180000, options: {cpu_features: ["SSSE3", "SSE4.1", "SSE4.2"], ...options},
        setup: emulator => {
            const x = emulator.v86.cpu.wm.exports;
            x.x64_set_compat_jit(compat);
            if(options.disable_jit === false)
            {
                x.ir_auto_set_idle_mode(0, 1);
                // (compile compatibility-mode pages at their first visit)
                assert.ok(x.ir_auto_set_page_threshold(1));
            }
        },
        inspect: emulator => {
            page = emulator.v86.cpu.wm.exports.x64_page_stat(1);
            tier0 = emulator.v86.cpu.get_jit_info().ir?.tier0;
        }});
    check(result, label);
    assert.ok(comparable(result).equals(comparable(expected)), `${label}: equal to QEMU (but for its documented deviations)`);
    if(options.disable_jit === false) assert.ok(page > 1000, `${label}: compiled 64-bit code ran (${page})`);
    if(compat) assert.ok(tier0.activations > 0 && tier0.page_functions > 0, `${label}: compiled compatibility-mode code ran ${JSON.stringify(tier0)}`);
    console.log(`PASS (${label}): ${cases.length} SSE4 cases in 64-bit and compatibility mode, ${FAULT_CASES.length} faults, as QEMU and the SDM model`);
}
