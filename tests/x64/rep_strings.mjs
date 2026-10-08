#!/usr/bin/env node
// REP MOVS and REP STOS in 64-bit mode against QEMU, interpreted and with
// the x64 page tier: element sizes 1, 2, 4 and 8, both directions, one
// element up to more than a page (several interpreter steps), and source to
// destination distances around the elements' span, where an element reads
// what an earlier one wrote (LZ backreferences) or does not. The interpreter
// copies a chunk at once in the second case (x64::execute::bulk_string, as
// cpu::string), element by element in the first. The operands lie in 4 KiB
// pages mapped to scattered frames, as a process's memory is (the page
// tier's single-page template, the interpreter's chunks at page ends).
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const OUT = 0x300000, RESULTS = OUT + 0x100;
// 8 pages at 1 GiB, mapped in this order of the frames at FRAMES
const AREA = 0x40000000, PAGES = 8, FRAMES = 0x600000, ORDER = [3, 6, 1, 7, 0, 5, 2, 4];
const cases = [];
for(const size of [1, 2, 4, 8])
{
    for(const down of [false, true])
    {
        for(const bytes of [size, 7 * size, 1000, 5000])
        {
            const count = Math.max(1, Math.floor(bytes / size));
            const span = count * size;
            // the first element's address: 3 bytes past a page boundary in
            // the middle of the area (a backward string runs down from it)
            const src = AREA + 0x4003 + size;
            for(const distance of new Set([-(span + 3), -span, -span + 1, -size - 1, -size, -1, 0, 1, size - 1, size, size + 1, span - 1, span, span + 3]))
            {
                cases.push({movs: true, size, down, count, src, dst: src + distance});
            }
            for(const offset of [0x2FFD, 0x5001 + size])
            {
                cases.push({movs: false, size, down, count, src: 0, dst: AREA + offset});
            }
        }
    }
}
const KIND = c => (c.movs ? 0 : 4) + Math.log2(c.size);
const table = cases.map((c, n) => `dq ${KIND(c)},${+c.down},${c.count},${c.src},${c.dst},0x${(0x0123456789ABCDEFn + BigInt(n) * 0x1111n).toString(16)}`).join("\n");

const ROUNDS = 3;
const source = long_mode_guest(`
; the area's 4 KiB pages: PML4[0] -> PDPT 0x201000, entry 1 -> PD 0x203000 -> PT 0x204000
mov edi,0x203000
mov ecx,1024
xor eax,eax
.zero:
mov [rdi],rax
add rdi,8
dec ecx
jnz .zero
mov qword [0x201008],0x203003
mov qword [0x203000],0x204003
${ORDER.map((frame, page) => `mov qword [${0x204000 + 8 * page}],${FRAMES + frame * 4096 + 3}`).join("\n")}
mov rax,cr3
mov cr3,rax
mov r15d,${ROUNDS}
round_loop:
lea r12,[rel cases]
mov r13d,${cases.length}
mov r14d,${RESULTS}
case_loop:
call fill
mov rbx,[r12]
mov rcx,[r12+16]
mov rsi,[r12+24]
mov rdi,[r12+32]
mov rax,[r12+40]
cmp qword [r12+8],0
je forward
std
forward:
lea rdx,[rel kinds]
jmp [rdx+rbx*8]
k_movsb: rep movsb
jmp done
k_movsw: rep movsw
jmp done
k_movsd: rep movsd
jmp done
k_movsq: rep movsq
jmp done
k_stosb: rep stosb
jmp done
k_stosw: rep stosw
jmp done
k_stosd: rep stosd
jmp done
k_stosq: rep stosq
done:
cld
mov [r14+8],rsi
mov [r14+16],rdi
mov [r14+24],rcx
call hash
mov [r14],rax
add r14,32
add r12,48
dec r13d
jnz case_loop
dec r15d
jnz round_loop
jmp finish
align 8
kinds: dq k_movsb,k_movsw,k_movsd,k_movsq,k_stosb,k_stosw,k_stosd,k_stosq
; the area: a Weyl sequence of quadwords
fill:
mov rdi,${AREA}
mov ecx,${PAGES * 512}
mov rax,0x0F1E2D3C4B5A6978
mov rdx,0x9E3779B97F4A7C15
.fill:
mov [rdi],rax
add rax,rdx
add rdi,8
dec ecx
jnz .fill
ret
hash:
mov rdi,${AREA}
mov ecx,${PAGES * 512}
xor eax,eax
mov rdx,0x100000001B3
.hash:
xor rax,[rdi]
imul rax,rdx
rol rax,5
add rdi,8
dec ecx
jnz .hash
ret
finish:
`, `
align 8
cases:
${table}
`);
const directory = assemble("rep-strings", source);
const length = RESULTS - OUT + cases.length * 32;
const expected = await reference(directory, {length, timeout: 120000});
const check = (result, label) => {
    for(let n = 0; n < cases.length; n++)
    {
        const at = RESULTS - OUT + n * 32;
        const got = result.subarray(at, at + 32), want = expected.subarray(at, at + 32);
        if(Buffer.compare(got, want) !== 0)
        {
            const c = cases[n], q = (b, i) => b.readBigUInt64LE(i * 8).toString(16);
            assert.fail(`${label}: case ${n} ${c.movs ? "MOVS" : "STOS"}${c.size * 8} ${c.down ? "down" : "up"} count ${c.count} ` +
                `src ${c.src.toString(16)} dst ${c.dst.toString(16)}: hash/RSI/RDI/RCX ${[0, 1, 2, 3].map(i => q(got, i))}, QEMU ${[0, 1, 2, 3].map(i => q(want, i))}`);
        }
    }
};
check(await actual(directory, {length, timeout: 120000}), "interpreted");
console.log(`PASS (interpreted): ${cases.length} REP MOVS/STOS cases as QEMU`);
let retired;
check(await actual(directory, {length, timeout: 120000, options: {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true},
    inspect: emulator => { retired = emulator.v86.cpu.wm.exports.x64_page_stat(1); }}), "x64 page tier");
assert.ok(retired > 1000000, `the page tier ran the cases (${retired} retired natively)`);
console.log(`PASS (x64 page tier): ${cases.length} REP MOVS/STOS cases as QEMU (${retired} retired natively)`);
