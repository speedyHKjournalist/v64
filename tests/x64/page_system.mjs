#!/usr/bin/env node
// System behavior of the x64 page tier (src/rust/x64/pagegen.rs, pages.rs)
// in hot loops, against QEMU TCG and the wide interpreter:
// - CPL3 loops (the access cache's user tables) and a user access to a
//   supervisor page from compiled code;
// - #PF on a not-present page, CR0.WP write faults on a read-only page after
//   reads of it were cached, and NX instruction fetches, each resuming the
//   loop through the fault handler (the page function retries the access in
//   the interpreter, which delivers the fault);
// - one backing page run through two linear aliases (position-independent
//   functions);
// - self-modifying code: a loop patching an immediate of a function in
//   another compiled page, and an instruction later in its own page.
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";

const RESULT = 0x300000;
const scenarios = [];
const add = (name, code) => scenarios.push({name, code});

add("user loop and supervisor fault", `
mov ecx, 0xC0000081
xor eax, eax
mov edx, 0x00200018
wrmsr
mov ecx, 0xC0000082
lea rax, [rel .back]
mov rdx, rax
shr rdx, 32
wrmsr
mov ecx, 0xC0000084
xor eax, eax
xor edx, edx
wrmsr
push 0x23
push 0x3D0000
push 2
push 0x33
lea rax, [rel .user]
push rax
iretq
.user:
mov rsi, 0x600000
mov ecx, 40000
xor eax, eax
xor r9, r9
.uloop:
mov edx, ecx
and edx, 511
add rax, [rsi+rdx*8]
mov [rsi+rdx*8], rax
xor rax, rdx
test ecx, 1023
jnz .unext
lea rbx, [rel .uafter]
mov [0x500010], rbx
mov rbx, [0xA00008]
.uafter:
inc r9
.unext:
dec ecx
jnz .uloop
mov qword [0x500010], 0
mov r8, rax
syscall
.back:
mov rsp, 0x3F0000
mov edx, 0x10
mov ss, edx
mov r10, rcx
mov r11, [0x600100]`);

add("not-present page faults", `
lea rax, [rel .kafter]
mov [0x500010], rax
mov ecx, 30000
xor r8, r8
xor r9, r9
.kloop:
mov rbx, 0x700000
test ecx, 7
jnz .mapped
mov rbx, 0x40001008
.mapped:
mov rax, [rbx]
add r8, rax
add qword [rbx+8], rcx
jmp .knext
.kafter:
inc r9
.knext:
dec ecx
jnz .kloop
mov qword [0x500010], 0
mov r10, [0x700008]`);

add("write-protect faults after cached reads", `
lea rax, [rel .wafter]
mov [0x500010], rax
mov rsi, 0x800000
mov ecx, 30000
xor r8, r8
xor r9, r9
.wloop:
mov edx, ecx
and edx, 511
add r8, [rsi+rdx*8]
test ecx, 15
jnz .wnext
mov [rsi+rdx*8], r8
.wafter:
inc r9
.wnext:
dec ecx
jnz .wloop
mov qword [0x500010], 0`);

add("NX fetch faults", `
lea rax, [rel .nafter]
mov [0x500010], rax
mov ecx, 5000
xor r9, r9
mov r10, 0xC00000
.nloop:
call r10
.nafter:
inc r9
dec ecx
jnz .nloop
mov qword [0x500010], 0
mov r8, rsp`);

add("patching a compiled function in another page", `
mov ecx, 30000
xor r10, r10
.sloop:
call smc_target
test ecx, 511
jnz .snext
inc byte [rel smc_target+3]
.snext:
dec ecx
jnz .sloop
mov r8, r10
movzx r9, byte [rel smc_target+3]`);

add("patching the running page", `
mov ecx, 30000
xor r11, r11
.ploop:
mov eax, ecx
shr eax, 6
mov byte [rel .patched+1], al
.patched:
mov bl, 0
movzx rbx, bl
add r11, rbx
dec ecx
jnz .ploop
mov r8, r11`);

add("one page function at two linear aliases", `
mov ecx, 20000
xor r10, r10
xor r11, r11
.aloop:
lea rax, [rel alias_target]
call rax
mov eax, alias_target
call rax
dec ecx
jnz .aloop
mov r8, [rel alias_data]
mov r9, [alias_data]`);

add("STI shadow before a pending self-IPI", `
mov al, 0xFF
out 0x21, al
out 0xA1, al
mov rbx, 0xFEE00000
mov dword [rbx+0xF0], 0x1FF
lea rax, [rel handler_64]
lea rdi, [rel idt+64*16]
mov word [rdi], ax
mov rdx, rax
shr rdx, 16
mov word [rdi+6], dx
shr rdx, 16
mov dword [rdi+8], edx
xor eax, eax
xor edx, edx
xor r9, r9
xor r10, r10
xor r11, r11
mov ecx, 3000
.iloop:
mov dword [rbx+0x300], 0x40040
sti
inc rax
inc rdx
cli
dec ecx
jnz .iloop
mov r8, rax`);

// Each scenario has its own code page (SMC scenarios exhaust their page's
// recompilations).
const body = scenarios.map((s, n) => `
align 4096
; ${s.name}
${s.code}
mov rdi, ${RESULT + 8 + n * 64}
mov [rdi], r8
mov [rdi+8], r9
mov [rdi+16], r10
mov [rdi+24], r11
mov rax, [0x500020]
mov [rdi+32], rax
mov rax, [0x500028]
mov [rdi+40], rax
mov rax, [0x500030]
mov [rdi+48], rax
`).join("\n");

const source = `bits 32
org 0x100000
%define HIGH 0xFFFF800000000000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
cli
cld
lgdt [gdtr32]
jmp 8:protected
protected:
mov ax,16
mov ds,ax
mov es,ax
mov ss,ax
mov esp,0x3F0000
mov dword [0x200000],0x201007
mov dword [0x200800],0x201007
mov dword [0x201000],0x202007
mov edi,0x202000
mov eax,0x87
mov ecx,512
.pages:
mov [edi],eax
add eax,0x200000
add edi,8
loop .pages
; 0x800000: user read-only, 0xA00000: supervisor, 0xC00000: no-execute,
; 0xFEE00000: local APIC (uncached)
mov dword [0x201000+3*8],0x203003
mov dword [0x203000+0x1F7*8],0xFEE0009B
mov dword [0x202000+4*8],0x800085
mov dword [0x202000+5*8],0xA00083
mov dword [0x202000+6*8+4],0x80000000
mov eax,cr4
or eax,0x20
mov cr4,eax
mov eax,0x200000
mov cr3,eax
mov ecx,0xC0000080
mov eax,0x901
xor edx,edx
wrmsr
mov eax,cr0
or eax,0x80010001
mov cr0,eax
jmp 24:long_mode
bits 64
long_mode:
mov rax,HIGH+high_mode
jmp rax
high_mode:
lgdt [rel gdtr64]
lidt [rel idtr64]
lea rax,[rel tss]
mov word [rel gdt+58],ax
shr rax,16
mov byte [rel gdt+60],al
mov byte [rel gdt+63],ah
shr rax,16
mov dword [rel gdt+64],eax
mov rax,HIGH+0x3E0000
mov [rel tss+4],rax
mov ax,0x38
ltr ax
lea rdi,[rel idt]
mov ecx,256
lea rax,[rel unexpected]
.init_idt:
mov word [rdi],ax
mov word [rdi+2],0x18
mov word [rdi+4],0x8E00
mov rdx,rax
shr rdx,16
mov word [rdi+6],dx
shr rdx,16
mov dword [rdi+8],edx
mov dword [rdi+12],0
add rdi,16
loop .init_idt
lea rax,[rel handler_14]
lea rdi,[rel idt+14*16]
mov word [rdi],ax
mov rdx,rax
shr rdx,16
mov word [rdi+6],dx
shr rdx,16
mov dword [rdi+8],edx
mov qword [0x500010],0
mov byte [0xC00000],0xC3
${body}
mov dword [${RESULT}],0xC064C064
hlt
jmp $
handler_14:
push rax
mov rax,[rsp+8]
mov [0x500028],rax
mov qword [0x500020],14
mov rax,cr2
mov [0x500030],rax
mov rax,[0x500010]
test rax,rax
jz .return
mov [rsp+16],rax
.return:
pop rax
add rsp,8
iretq
handler_64:
add r10, rax
add r11, rdx
inc r9
mov dword [rbx+0xB0], 0
iretq
unexpected:
cli
hlt
jmp $
align 4096
smc_target:
add r10, byte 5
ret
align 4096
alias_target:
lea rdx, [rel alias_data]
add r10, [rdx]
inc qword [rdx]
add r11, rdx
call smc_target
lea rax, [rel .back]
add r11, rax
.back:
ret
align 4096
alias_data: dq 0
align 16
gdt:
dq 0,0x00CF9A000000FFFF,0x00CF92000000FFFF,0x00AF9A000000FFFF
dq 0x00CFF2000000FFFF,0x00CFFA000000FFFF,0x00AFFA000000FFFF
dq 0x0000890000000067,0
dq 0,0
gdtr32: dw 87
dd gdt
gdtr64: dw 87
dq HIGH+gdt
idtr64: dw 4095
dq HIGH+idt
align 16
tss: times 104 db 0
align 16
idt: times 4096 db 0
image_end:
`;
const dir = assemble("page-system", source);
const config = {length: 8 + scenarios.length * 64, timeout: 120000};
const oracle = await reference(dir, config);
console.log(`QEMU: ${scenarios.length} page tier system scenarios`);
const compare = (result, label) => {
    for(const [n, s] of scenarios.entries()) for(let field = 0; field < 7; field++)
    {
        const at = 8 + n * 64 + field * 8;
        assert.equal(result.readBigUInt64LE(at).toString(16), oracle.readBigUInt64LE(at).toString(16),
            `${label}: ${s.name}, ${["r8", "r9", "r10", "r11", "vector", "error", "cr2"][field]}`);
    }
};
compare(await actual(dir, config), "interpreter");
let stats;
compare(await actual(dir, {...config, options: {disable_jit: false, ir_sync_publication: true}, inspect: emulator => {
    stats = Array.from({length: 13}, (_, i) => emulator.v86.cpu.wm.exports.x64_page_stat(i));
}}), "page tier");
const [compiled, retired, retries, , , invalidated] = stats;
console.log(`page tier: compiled ${compiled}, native ${retired}, retries ${retries}, invalidated ${invalidated}, stats ${JSON.stringify(stats)}`);
assert.ok(retired > 400000, "the loops ran in page functions");
assert.ok(retries > 1000, "faulting accesses left compiled code to be interpreted");
assert.ok(invalidated >= 10, "code writes retired compiled pages");
console.log("PASS page tier system scenarios agree with QEMU and the interpreter");
