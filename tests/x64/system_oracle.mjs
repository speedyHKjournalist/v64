#!/usr/bin/env node
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
const cases = [];
const add = (name, code) => cases.push({name, code});
const fault = (name, code, vector, error = 0) => add(name, `lea rax, [rel .resume]\nmov [0x500010], rax\n${code}\n.resume:\nmov rax, ${vector}\nmov rbx, ${error}`);
add("wide descriptor registers", "sgdt [0x501000]\nsidt [0x501010]\nmov rax, [0x501002]\nmov rbx, [0x501012]\nstr cx\nsldt dx");
add("FS and kernel GS MSRs", "mov ecx, 0xC0000100\nmov eax, 0x55667788\nmov edx, 0xFFFF8888\nwrmsr\nrdmsr\nmov ebx, edx");
add("SWAPGS full bases", "mov ecx, 0xC0000101\nmov eax, 0x12345678\nmov edx, 0xFFFF9000\nwrmsr\nmov ecx, 0xC0000102\nmov eax, 0x87654321\nmov edx, 0xFFFFA000\nwrmsr\nswapgs\nmov ecx, 0xC0000101\nrdmsr\nmov ebx, edx\nswapgs");
add("RDTSCP TSC_AUX", "mov ecx, 0xC0000103\nmov eax, 0xFEDCBA98\nxor edx, edx\nwrmsr\nrdtscp\nxor eax, eax\nxor edx, edx");
add("PAT read and write", "mov ecx, 0x277\nmov eax, 0x00070406\nmov edx, eax\nwrmsr\nrdmsr");
fault("noncanonical LSTAR", "mov ecx, 0xC0000082\nxor eax, eax\nmov edx, 0x8000\nwrmsr", 13);
fault("reserved CR3 physical bits", "mov rax, 0x1000000000\nmov cr3, rax", 13);
fault("LMA cannot clear PAE", "mov rax, cr4\nand eax, ~0x20\nmov cr4, rax", 13);
fault("LME is immutable while paging", "mov ecx, 0xC0000080\nrdmsr\nand eax, ~0x100\nwrmsr", 13);
fault("long CS cannot clear paging", "mov rax, cr0\nbtr rax, 31\nmov cr0, rax", 13);
fault("noncanonical load", "mov rax, 0x800000000000\nmov rbx, [rax]", 13);
fault("noncanonical stack operand", "mov rbp, 0x800000000000\nmov rbx, [rbp]", 12);
fault("unmapped canonical page", "mov rax, 0x40000000\nmov rbx, [rax]", 14);
fault("illegal instruction", "ud2", 6);
fault("division error", "xor edx, edx\nxor ecx, ecx\ndiv rcx", 0);
fault("invalid TSS selector", "mov eax, 0x10\nltr ax", 13, 16);
fault("busy TSS reload", "mov eax, 0x38\nltr ax", 13, 56);
add("same privilege interrupt full frame", "int 0x40");
add("IST stack and IRETQ", "int 0x41");
add("SYSCALL kernel entry preserves high RCX and R11", "mov ecx, 0xC0000081\nmov eax, 0\nmov edx, 0x00180018\nwrmsr\nmov ecx, 0xC0000082\nlea rax, [rel .entry]\nmov rdx, rax\nshr rdx, 32\nwrmsr\nmov ecx, 0xC0000084\nmov eax, 0x600\nxor edx, edx\nwrmsr\nsyscall\njmp .done\n.entry:\nmov rax, rcx\nmov rbx, r11\njmp rcx\n.done:");
add("user IRETQ SYSCALL SYSRETQ round trip", "mov ecx, 0xC0000081\nxor eax, eax\nmov edx, 0x00200018\nwrmsr\nmov ecx, 0xC0000082\nlea rax, [rel .service]\nmov rdx, rax\nshr rdx, 32\nwrmsr\nmov qword [0x500018], 0\npush 0x23\npush 0x3D0000\npush 2\npush 0x33\nlea rax, [rel .user]\npush rax\niretq\n.user:\nmov rax, 0x1122334455667788\nsyscall\nmov rbx, 0x8877665544332211\nsyscall\n.service:\ninc qword [0x500018]\ncmp qword [0x500018], 1\njne .done\no64 sysret\n.done:\nmov rsp, 0x3F0000\nmov rcx, [0x500018]\nmov rdx, 0");
add("RETFQ compatibility code and 32-bit far RET return", "push 8\nmov eax, .compat\npush rax\no64 retf\nbits 32\n.compat:\nmov eax, 0x76543210\nmov ebx, 0xFEDCBA98\npush dword 0x18\npush dword .back64\nretf\nbits 64\n.back64:\nmov rdx, HIGH+.high\njmp rdx\n.high:\nxor edx, edx");
add("compatibility SYSENTER to full high kernel RIP", "mov ecx, 0x174\nmov eax, 0x18\nxor edx, edx\nwrmsr\nmov ecx, 0x175\nmov eax, 0x3F0000\nwrmsr\nmov ecx, 0x176\nlea rax, [rel .entry64]\nmov rdx, rax\nshr rdx, 32\nwrmsr\npush 0x23\npush 0x3D0000\npush 2\npush 0x2B\nmov eax, .compat\npush rax\niretq\nbits 32\n.compat:\nmov ebx, 0xAABBCCDD\nsysenter\nbits 64\n.entry64:\nmov rax, rsp\nmov ecx, 0x11223344\nxor edx, edx\nmov esi,0x10\nmov ss,si");
add("full-width debug address registers", "mov rax, 0xFFFF812345678900\nmov dr0, rax\nmov rbx, dr0\nxor eax,eax\nmov dr0,rax\nmov dr7,rax\nmov rcx,dr7");
fault("DR6 rejects high reserved bits", "mov rax,0x100000000\nmov dr6,rax",13);
add("DR0 retains full noncanonical bit pattern", "mov rax,0x800000000000\nmov dr0,rax\nmov rbx,dr0\nxor eax,eax\nmov dr0,rax");
fault("DR4 with CR4.DE", "mov rdx,cr4\nbts rdx,3\nmov cr4,rdx\nmov rax,dr4",6);
add("debug general-detect fault", "lea rax,[rel .resume]\nmov [0x500010],rax\nmov eax,0x2000\nmov dr7,rax\nmov rbx,0x1234\nmov rbx,dr0\n.resume:\nmov rax,dr7\nmov rcx,dr6\nxor edx,edx\nmov dr6,rdx");
add("trap flag retires one instruction before DB", "xor eax,eax\nmov dr6,rax\npush qword 0x102\npopfq\ninc eax\nmov rbx,dr6");
add("FS GS stack selectors", "mov eax,0x10\nmov fs,ax\nmov gs,ax\npush fs\npop rax\npush gs\npop rbx\npush qword 0x10\npop fs\npush qword 0x10\npop gs\nmov cx,fs\nmov dx,gs");
for(const [name, instruction] of [["LAR code", "lar rax,ecx"], ["LSL data", "lsl rax,ecx"], ["VERR code", "verr cx"], ["VERW data", "verw cx"]])
{
    add(name, `mov ecx,0x10\nmov rax,0x123456789ABCDEF0\n${instruction}\npushfq\npop rbx\nand ebx,0x40`);
}
add("LAR invalid selector preserves destination", "mov ecx,0xFFF0\nmov rax,0x123456789ABCDEF0\nlar rax,ecx\npushfq\npop rbx\nand ebx,0x40");
fault("NX instruction fetch preserves full fault address", "mov qword [0x202040],0x1000087\nbts qword [0x202040],63\nmov rax,0x1000000\ninvlpg [rax]\njmp rax",14,17);
fault("CR0.WP write protection", "mov qword [0x202040],0x1000085\nmov rax,0x1000000\ninvlpg [rax]\nmov qword [rax],0x1234",14,3);
fault("reserved physical address bit in large leaf", "mov rax,0x1001000087\nmov [0x202040],rax\nmov rax,0x1000000\ninvlpg [rax]\nmov rbx,[rax]",14,9);
add("cross-page write fault has no RAM partial commit", "lea rax,[rel .resume]\nmov [0x500010],rax\nmov qword [0x202060],0x208007\nmov qword [0x208000],0x1800007\nmov qword [0x208008],0x1801005\nmov eax,0x1800000\ninvlpg [rax]\nadd eax,0x1000\ninvlpg [rax]\nmov dword [0x1800FFC],0xAABBCCDD\nmov rax,0x1122334455667788\nmov [0x1800FFC],rax\n.resume:\nmov eax,[0x1800FFC]\nmov ebx,3");
add("wide TLB retains translation until INVLPG", "mov qword [0x202060],0x208007\nmov qword [0x208000],0x1800007\nmov dword [0x1A00000],0x76543210\nmov eax,0x1800000\ninvlpg [rax]\nmov dword [rax],0x12345678\nmov ebx,[rax]\nmov qword [0x208000],0x1A00007\nmov ebx,[rax]\ninvlpg [rax]\nmov ecx,[rax]\nxor eax,eax");
add("execution breakpoint faults before register commit", "lea rax,[rel .resume]\nmov [0x500010],rax\nxor eax,eax\nmov dr6,rax\nlea rax,[rel .watched]\nmov dr0,rax\nmov eax,1\nmov dr7,rax\nxor eax,eax\n.watched:\ninc eax\n.resume:\nxor edx,edx\nmov dr7,rdx\nmov rbx,dr6");
add("high data write breakpoint traps after committed store", "xor eax,eax\nmov dr6,rax\nmov rdi,HIGH+0x500800\nmov dr0,rdi\nmov eax,0x90001\nmov dr7,rax\nmov r9,0x1122334455667788\nmov [rdi],r9\nxor eax,eax\nmov dr7,rax\nmov rax,[rdi]\nmov rbx,dr6");
add("high data read breakpoint traps after register commit", "xor eax,eax\nmov dr6,rax\nmov rdi,HIGH+0x500800\nmov dr0,rdi\nmov eax,0xB0001\nmov dr7,rax\nmov rax,[rdi]\nxor edx,edx\nmov dr7,rdx\nmov rbx,dr6");
// Far transfers in 64-bit mode (SDM Vol.2A JMP/CALL; Vol.3A §5.8.3.1).
// The case fills the 64-bit call gate at GDT 0x48 (DPL 3) with its target.
const gate = (target, selector = "0x18") => `lea rax,[rel ${target}]\nmov word [rel gdt+0x48],ax\nmov word [rel gdt+0x4A],${selector}\nmov word [rel gdt+0x4C],0xEC00\nshr rax,16\nmov word [rel gdt+0x4E],ax\nshr rax,16\nmov dword [rel gdt+0x50],eax\nmov dword [rel gdt+0x54],0`;
add("far JMP m16:32 to compatibility code and RETF back", "jmp far dword [rel .ptr]\n.ptr: dd .compat\ndw 0x08\nbits 32\n.compat:\nmov eax,0x13572468\nmov ebx,cs\npush dword 0x18\npush dword .back64\nretf\nbits 64\n.back64:\nmov rdx,HIGH+.high\njmp rdx\n.high:\nxor edx,edx");
add("far CALL m16:64 to 64-bit code and RETFQ", "call far qword [rel .ptr]\nmov rdx,rsp\njmp .done\n.target:\nmov rax,[rsp]\nmov rbx,[rsp+8]\nmov rcx,cs\no64 retf\n.ptr: dq .target\ndw 0x18\n.done:\nsub rdx,0x3F0000");
add("far CALL m16:32 pushes 32-bit CS:EIP", "call far dword [rel .ptr]\n.ret32:\nmov rdx,HIGH+.high\njmp rdx\n.target:\nmov eax,[rsp]\nmov ebx,[rsp+4]\nlea rcx,[rsp+8]\nsub rcx,0x3F0000\nretf\n.ptr: dd .target\ndw 0x18\n.high:\nxor edx,edx");
add("64-bit call gate from CPL3 to CPL0 switches to TSS RSP0", gate(".entry") + "\npush 0x23\npush 0x3D0000\npush 2\npush 0x33\nlea rax,[rel .user]\npush rax\niretq\n.user:\ncall far dword [rel .ptr]\n.ptr: dd 0\ndw 0x4B\n.entry:\nmov rax,[rsp+8]\nmov rbx,[rsp+24]\nmov rcx,[rsp+16]\nmov rdx,rsp\nmov rsi,ss\nshl rsi,32\nor rdx,rsi\nmov rsi,cs\nshl rsi,48\nor rdx,rsi\nmov rsp,0x3F0000\nmov esi,0x10\nmov ss,si");
add("64-bit call gate at same privilege keeps the stack", gate(".entry") + "\ncall far dword [rel .ptr]\n.ptr: dd 0\ndw 0x48\n.entry:\nmov rax,[rsp+8]\nlea rbx,[rsp+16]\nsub rbx,0x3F0000\nmov rcx,cs\nmov rsp,0x3F0000");
fault("far JMP to a TSS selector", "jmp far dword [rel .ptr]\n.ptr: dd 0\ndw 0x38", 13, 0x38);
fault("far JMP to a data segment", "jmp far dword [rel .ptr]\n.ptr: dd 0\ndw 0x10", 13, 0x10);
fault("far JMP null selector", "jmp far dword [rel .ptr]\n.ptr: dd 0\ndw 0", 13, 0);
fault("far JMP register form", "db 0xFF,0xE8", 6);
fault("far CALL noncanonical 64-bit offset", "call far qword [rel .ptr]\n.ptr: dq 0x800000000000\ndw 0x18", 13, 0);
fault("far JMP to DPL3 code from CPL0", "jmp far dword [rel .ptr]\n.ptr: dd 0\ndw 0x30", 13, 0x30);
fault("call gate to 32-bit code", gate(".entry", "0x08") + "\ncall far dword [rel .ptr]\n.ptr: dd 0\ndw 0x48\n.entry:\nnop", 13, 8);
fault("call gate above the GDT limit", "call far dword [rel .ptr]\n.ptr: dd 0\ndw 0x58", 13, 0x58);

// QEMU 10.2 does not implement these control-write faults (misc_helper.c).
// Check them against explicit SDM outcomes in a separate v86 guest.
const specification_cases = cases.splice(5, 5);
// QEMU 10.2's lcall helper lowers RSP by the pushed CS:RIP before raising
// #GP for a noncanonical target; SDM Vol.3A §6.5 restores it for a fault.
for(const name of ["noncanonical stack operand", "reserved physical address bit in large leaf", "far CALL noncanonical 64-bit offset"])
    specification_cases.push(...cases.splice(cases.findIndex(test => test.name === name), 1));
// QEMU 10.2 TCG never reaches the result marker once a DR0 data watchpoint
// hits a high linear address, so these use SDM Vol.3B §18.2.4/§18.3.1.2
// outcomes: the access completes, then #DB traps with DR6.B0 set.
const expectation_cases = [];
for(const [name, rax, rbx] of [
    ["high data write breakpoint traps after committed store", 0x1122334455667788n, 0xFFFF0FF1n],
    ["high data read breakpoint traps after register commit", 0x1122334455667788n, 0xFFFF0FF1n],
])
{
    const index = cases.findIndex(test => test.name === name);
    assert.notEqual(index, -1, name);
    expectation_cases.push({...cases.splice(index, 1)[0], rax, rbx});
}
function source_for(cases)
{
let body = "";
for(const [n, test] of cases.entries())
{
    body += `\ncase_${n}:\nmov dword [0x300004], ${n}\nmov qword [0x500010], 0\nmov qword [0x500020], 0\nmov qword [0x500028], 0\nmov qword [0x500030], 0\nmov qword [0x500038], 0\nxor eax, eax\nmov cr2, rax\nmov ebx, 0\nmov ecx, 0\nmov edx, 0\n${test.code}\nmov rdi, ${0x300008 + n * 64}\nmov [rdi], rax\nmov [rdi+8], rbx\nmov [rdi+16], rcx\nmov [rdi+24], rdx\nmov rax, [0x500020]\nmov [rdi+32], rax\nmov rax, [0x500028]\nmov [rdi+40], rax\nmov rax, [0x500030]\nmov [rdi+48], rax\nmov rax, [0x500038]\nmov [rdi+56], rax\n`;
}
return `bits 32
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
mov rax,HIGH+0x3C0000
mov [rel tss+36],rax
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
%macro GATE 2
lea rax,[rel handler_%1]
lea rdi,[rel idt+%1*16]
mov word [rdi],ax
mov rdx,rax
shr rdx,16
mov word [rdi+6],dx
shr rdx,16
mov dword [rdi+8],edx
mov byte [rdi+4],%2
%endmacro
GATE 0,0
GATE 1,0
GATE 6,0
GATE 12,0
GATE 13,0
GATE 14,0
GATE 64,0
GATE 65,1
${body}
mov dword [0x300000],0xC064C064
hlt
jmp $
%macro HANDLER 2
handler_%1:
%if %2 == 0
push 0
%endif
push %1
jmp common_handler
%endmacro
HANDLER 0,0
HANDLER 1,0
HANDLER 6,0
HANDLER 12,1
HANDLER 13,1
HANDLER 14,1
HANDLER 64,0
HANDLER 65,0
common_handler:
push rax
mov rax,[rsp+8]
mov [0x500020],rax
mov rax,[rsp+16]
mov [0x500028],rax
mov rax,cr2
mov [0x500030],rax
lea rax,[rsp+24]
mov [0x500038],rax
mov rax,[0x500010]
test rax,rax
jz .return
mov [rsp+24],rax
.return:
and qword [rsp+40],~0x100
pop rax
add rsp,16
iretq
unexpected:
cli
hlt
jmp $
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
}
const dir = assemble("system", source_for(cases));
const config = {length: 8 + cases.length * 64};
const oracle = await reference(dir, config);
console.log(`QEMU: ${cases.length} long-mode system cases`);
if(!process.env.X64_ORACLE_ONLY)
{
    const value = await actual(dir, config);
    for(const [n, test] of cases.entries()) for(let field = 0; field < 8; field++)
    {
        const at = 8 + n * 64 + field * 8;
        assert.equal(value.readBigUInt64LE(at), oracle.readBigUInt64LE(at), `case ${n} ${test.name}, field ${field}`);
    }
    console.log(`PASS: ${cases.length} independent system/exception/IST/syscall cases`);
}

if(!process.env.X64_ORACLE_ONLY)
{
    const directory = assemble("system-control-faults", source_for(specification_cases));
    const result = await actual(directory, {length: 8 + specification_cases.length * 64});
    for(const [n, test] of specification_cases.entries())
    {
        const at = 8 + n * 64;
        assert.equal(result.readBigUInt64LE(at + 32), result.readBigUInt64LE(at), test.name + " vector");
        assert.equal(result.readBigUInt64LE(at + 40), result.readBigUInt64LE(at + 8), test.name + " error code");
        // The #GP frame sits directly below the untouched 0x3F0000 stack.
        if(test.name === "far CALL noncanonical 64-bit offset")
            assert.equal(result.readBigUInt64LE(at + 56), 0x3F0000n - 40n, test.name + " restores RSP");
    }
    console.log(`PASS: ${specification_cases.length} SDM control-write fault cases (QEMU reference unavailable)`);

    const watch = assemble("system-data-breakpoints", source_for(expectation_cases));
    const observed = await actual(watch, {length: 8 + expectation_cases.length * 64});
    for(const [n, test] of expectation_cases.entries())
    {
        const at = 8 + n * 64;
        assert.equal(observed.readBigUInt64LE(at), test.rax, test.name + " committed value");
        assert.equal(observed.readBigUInt64LE(at + 8), test.rbx, test.name + " DR6");
        assert.equal(observed.readBigUInt64LE(at + 32), 1n, test.name + " #DB vector");
    }
    console.log(`PASS: ${expectation_cases.length} SDM data-breakpoint cases (QEMU reference hangs)`);
}
