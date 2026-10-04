#!/usr/bin/env node
// The XSAVE feature set in the x64 engine and in compatibility mode
// (docs/simd-xsave-plan.md P2), with cpu_type "x86_64" and the x86-64-v3
// features: XSAVE64 and XSAVE store x87 state in their 64- and 32-bit formats,
// XMM0-XMM15 and YMM0_H-YMM15_H; FXSAVE64 leaves bytes 416-511 alone;
// compatibility-mode XSAVE and XRSTOR store and load registers 0-7 only, and
// XRSTOR there leaves XMM8-15 and YMM8_H-15_H alone; XGETBV; and the faults
// of the x64 engine (#UD without CR4.OSXSAVE or with a mandatory prefix, #NM
// with CR0.TS, #GP for misalignment, the header, MXCSR and XSETBV/XGETBV).
// Interpreted, then with the x64 page tier.
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const OUT = 0x300000, XGETBV = OUT + 0x10, SKIP = OUT + 0x80, CASE = OUT + 0x84, MATCH = OUT + 0xC0, FAULTS = OUT + 0x100;
const DATA = OUT + 0x400, IDT = OUT + 0x9000;
const AREA_Y = OUT + 0x1000, AREA1 = OUT + 0x2000, AREA2 = OUT + 0x3000, AREA3 = OUT + 0x4000;
const AREA4 = OUT + 0x5000, AREA5 = OUT + 0x6000, AREA6 = OUT + 0x7000, BAD_HEADER = OUT + 0x8000, BAD_MXCSR = OUT + 0x8400;
const LENGTH = 0xA000;
// the faulting cases: [vector, what]
const CASES = [[6, "XSAVE without CR4.OSXSAVE"], [13, "XSAVE64 misaligned"], [7, "XSAVE64 with CR0.TS"],
    [13, "XRSTOR64, XCOMP_BV[63]"], [13, "XRSTOR64, MXCSR reserved bits"], [13, "XSETBV 0"], [13, "XGETBV 1"],
    [6, "66 XGETBV"], [6, "F3 XSAVE64"]];

/** set CASE and SKIP, then the faulting instruction at label f<n>, then check its RIP */
const fault = (n, length, instruction) => `
mov dword [${CASE}],${n}
mov dword [${SKIP}],${length}
f${n}: ${instruction}
lea rax,[rel f${n}]
cmp rax,[${FAULTS} + ${n} * 16 + 8]
sete byte [${MATCH} + ${n}]`;

const directory = assemble("xsave", long_mode_guest(`
; an IDT: #UD, #NM and #GP record CASE's vector and RIP, then skip SKIP bytes
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
; SSE (OSFXSR, OSXMMEXCPT) and XSAVE enabled, XCR0 x87, SSE, AVX
mov rax,cr4
or eax,1 << 18 | 3 << 9
mov cr4,rax
xor ecx,ecx
mov eax,7
xor edx,edx
xsetbv
xor ecx,ecx
xgetbv
mov [${XGETBV}],eax
mov [${XGETBV + 4}],edx
; XMM0-15, two x87 registers, then YMM0_H-15_H and MXCSR from AREA_Y
mov rsi,${DATA}
%assign i 0
%rep 16
movdqu xmm%[i],[rsi + i * 16]
%assign i i + 1
%endrep
fninit
fld qword [rsi + 256]
fld qword [rsi + 264]
mov eax,4
xor edx,edx
mov rbx,${AREA_Y}
xrstor64 [rbx]
mov eax,-1
mov edx,-1
mov rbx,${AREA1}
xsave64 [rbx]
mov rbx,${AREA2}
xsave [rbx]
mov rbx,${AREA3}
fxsave64 [rbx]
; compatibility mode: XSAVE into AREA4, XRSTOR from AREA5
push 8
mov rax,compat
push rax
o64 retf
bits 32
compat:
mov ebx,${AREA4}
mov eax,-1
mov edx,-1
xsave [ebx]
mov ebx,${AREA5}
xrstor [ebx]
jmp 0x18:back
bits 64
back:
mov rax,HIGH+in_long_mode
jmp rax
in_long_mode:
mov eax,-1
mov edx,-1
mov rbx,${AREA6}
xsave64 [rbx]
; the faults
mov rax,cr4
and eax,~(1 << 18)
mov cr4,rax
mov rbx,${AREA1}
${fault(0, 3, "xsave [rbx]")}
mov rax,cr4
or eax,1 << 18
mov cr4,rax
mov rbx,${AREA1 + 32}
${fault(1, 4, "xsave64 [rbx]")}
mov rax,cr0
or eax,8
mov cr0,rax
mov rbx,${AREA1}
${fault(2, 4, "xsave64 [rbx]")}
clts
mov rbx,${BAD_HEADER}
${fault(3, 4, "xrstor64 [rbx]")}
mov rbx,${BAD_MXCSR}
${fault(4, 4, "xrstor64 [rbx]")}
xor ecx,ecx
xor eax,eax
xor edx,edx
${fault(5, 3, "xsetbv")}
mov ecx,1
${fault(6, 3, "xgetbv")}
xor ecx,ecx
${fault(7, 4, "db 0x66, 0x0F, 0x01, 0xD0")}
mov rbx,${AREA1}
${fault(8, 5, "db 0xF3, 0x48, 0x0F, 0xAE, 0x23")}
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
`));

const xmm = Uint8Array.from({length: 256}, (_, i) => i * 7 + 1);
const ymm = Uint8Array.from({length: 256}, (_, i) => i * 11 + 5);
const setup = emulator => {
    const write = (bytes, address) => emulator.write_memory(bytes, address);
    const u32 = n => Uint8Array.from([n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255]);
    write(new Uint8Array(LENGTH), OUT);
    write(xmm, DATA);
    write(new Uint8Array(Float64Array.of(1.5, -2.25).buffer), DATA + 256);
    // AREA_Y: YMM_Hi128 with MXCSR 0x1FA0; XSTATE_BV: AVX
    write(u32(0x1FA0), AREA_Y + 24);
    write(ymm, AREA_Y + 576);
    write(u32(4), AREA_Y + 512);
    for(const area of [AREA3, AREA4]) write(new Uint8Array(832).fill(0xCC), area);
    write(new Uint8Array(64), AREA4 + 512);
    // AREA5: x87 in its initial configuration, XMM 5A, YMM_H A5
    write(u32(0x37F), AREA5);
    write(u32(0x1F80), AREA5 + 24);
    write(new Uint8Array(256).fill(0x5A), AREA5 + 160);
    write(new Uint8Array(256).fill(0xA5), AREA5 + 576);
    write(u32(7), AREA5 + 512);
    write(u32(0x80000000), BAD_HEADER + 520 + 4);
    write(u32(0x10000), BAD_MXCSR + 24);
};

for(const [label, options] of [["interpreted", {}],
    ["x64 page tier", {disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true}]])
{
    const result = new Uint8Array(await actual(directory, {length: LENGTH, setup, options: {cpu_type: "x86_64", cpu_features: "x86-64-v3", ...options}}));
    const view = new DataView(result.buffer, result.byteOffset, result.length);
    const at = address => address - OUT;
    const area = address => result.subarray(at(address), at(address) + 832);
    const u32 = (address, offset) => view.getUint32(at(address) + offset, true);
    assert.deepEqual([u32(XGETBV, 0), u32(XGETBV, 4)], [7, 0], `${label}: XGETBV 0`);
    // XSAVE64: the 64-bit FIP (the high alias), all 16 XMM and YMM_H
    const full = area(AREA1);
    assert.equal(u32(AREA1, 12), 0xFFFF8000, `${label}: XSAVE64: FIP[63:32]`);
    assert.deepEqual([u32(AREA1, 0) & 0xFFFF, full[4], u32(AREA1, 24), u32(AREA1, 28)], [0x37F, 0xC0, 0x1FA0, 0xFFFF], `${label}: XSAVE64: FCW, FTW, MXCSR`);
    assert.deepEqual(full.subarray(160, 416), xmm, `${label}: XSAVE64: XMM0-15`);
    assert.deepEqual(full.subarray(576, 832), ymm, `${label}: XSAVE64: YMM0_H-15_H`);
    assert.deepEqual([u32(AREA1, 512), u32(AREA1, 516)], [7, 0], `${label}: XSAVE64: XSTATE_BV`);
    // XSAVE: FIP[31:0] with FCS (which x87 instructions in 64-bit mode set to 0), not FIP[63:32]
    assert.deepEqual([u32(AREA2, 8), u32(AREA2, 12)], [u32(AREA1, 8), 0], `${label}: XSAVE: FIP[31:0], FCS`);
    assert.deepEqual(area(AREA2).subarray(160, 416), xmm, `${label}: XSAVE: XMM0-15 in 64-bit mode`);
    // FXSAVE64: XMM0-15, but not bytes 416-511
    const fx = area(AREA3);
    assert.deepEqual(fx.subarray(160, 416), xmm, `${label}: FXSAVE64: XMM0-15`);
    assert.ok(fx.subarray(416, 512).every(b => b === 0xCC), `${label}: FXSAVE64 leaves 416-511 alone`);
    // compatibility mode: registers 0-7 only
    const compat = area(AREA4);
    assert.deepEqual(compat.subarray(160, 288), xmm.subarray(0, 128), `${label}: compatibility XSAVE: XMM0-7`);
    assert.ok(compat.subarray(288, 512).every(b => b === 0xCC), `${label}: compatibility XSAVE leaves XMM8-15 alone`);
    assert.deepEqual(compat.subarray(576, 704), ymm.subarray(0, 128), `${label}: compatibility XSAVE: YMM0_H-7_H`);
    assert.ok(compat.subarray(704).every(b => b === 0xCC), `${label}: compatibility XSAVE leaves YMM8_H-15_H alone`);
    assert.equal(u32(AREA4, 512), 7, `${label}: compatibility XSAVE: XSTATE_BV`);
    // ... and XRSTOR loads XMM0-7 and YMM0_H-7_H
    const after = area(AREA6);
    assert.ok(after.subarray(160, 288).every(b => b === 0x5A), `${label}: XMM0-7 from compatibility XRSTOR`);
    assert.deepEqual(after.subarray(288, 416), xmm.subarray(128), `${label}: XMM8-15 kept`);
    assert.ok(after.subarray(576, 704).every(b => b === 0xA5), `${label}: YMM0_H-7_H from compatibility XRSTOR`);
    assert.deepEqual(after.subarray(704, 832), ymm.subarray(128), `${label}: YMM8_H-15_H kept`);
    assert.deepEqual([u32(AREA6, 0) & 0xFFFF, after[4], u32(AREA6, 512)], [0x37F, 0, 6], `${label}: x87 initial, XSTATE_BV SSE and AVX`);
    // the faults, at their instructions
    CASES.forEach(([vector, what], n) => {
        assert.equal(u32(FAULTS + n * 16, 0), vector, `${label}: ${what}: vector`);
        assert.equal(result[at(MATCH) + n], 1, `${label}: ${what}: RIP`);
    });
    console.log(`PASS (${label}): XSAVE64/XSAVE/FXSAVE64 layouts, compatibility-mode XSAVE/XRSTOR, XGETBV and ${CASES.length} faults`);
}
