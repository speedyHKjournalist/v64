#!/usr/bin/env node
// 32-bit protected mode: LLDT, LTR and task switch faults (SDM Vol.3A §7.3,
// Vol.2A LLDT/LTR/JMP), compared with QEMU. These used to panic the host
// (unimplemented paths); the guest must see the architectural fault instead:
// LLDT of a non-LDT, a not-present LDT or an LDT-relative selector, LTR of
// a busy TSS, JMP to a not-present or busy TSS, a working task switch there
// and back, and a task switch whose new TSS names an invalid LDT (#TS in the
// new task, after the switch).
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";

const source = `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
cli
lgdt [gdtr]
jmp 8:pm
pm:
mov ax,0x10
mov ds,ax
mov es,ax
mov ss,ax
mov fs,ax
mov gs,ax
mov esp,0x3F0000
mov dword [0x300004],0
; interrupt gates for #TS, #NP, #GP
mov edi,idt
mov eax,handler_10
call gate
mov edi,idt+11*8-10*8
mov eax,handler_11
call gate
mov edi,idt+13*8-10*8
mov eax,handler_13
call gate
lidt [idtr]
; TSS bases into their descriptors
mov eax,tss1
mov edi,gdt+0x20
call set_base
mov eax,tss2
mov edi,gdt+0x28
call set_base
mov eax,tss2
mov edi,gdt+0x30
call set_base
mov eax,tss4
mov edi,gdt+0x48
call set_base
mov eax,ldt_table
mov edi,gdt+0x18
call set_base
mov eax,ldt_table
mov edi,gdt+0x40
call set_base
; 1. LLDT of a data segment: #GP(0x38)
mov dword [resume],.n1
mov ax,0x38
lldt ax
.n1:
; 2. LLDT of a not-present LDT: #NP(0x40)
mov dword [resume],.n2
mov ax,0x40
lldt ax
.n2:
; 3. LLDT of an LDT-relative selector: #GP(0x1C)
mov dword [resume],.n3
mov ax,0x1C
lldt ax
.n3:
; a valid LDT
mov ax,0x18
lldt ax
sldt ax
mov [0x300100],eax
; 4. LTR, then LTR of the same (now busy) TSS: #GP(0x20)
mov ax,0x20
ltr ax
mov dword [resume],.n4
ltr ax
.n4:
; 5. JMP to a not-present TSS: #NP(0x30)
mov dword [resume],.n5
jmp 0x30:0
.n5:
; 6. JMP to the busy current TSS: #GP(0x20)
mov dword [resume],.n6
jmp 0x20:0
.n6:
; 7. a task switch to task 2 and back
jmp 0x28:0
mov [0x300108],eax
str ax
mov [0x30010C],eax
; 8. a new TSS with an invalid LDT: #TS(0x38) in the new task (last:
; segment state after a fault past the commit point is undefined)
jmp 0x48:0
hlt

task2:
mov eax,0x7A5C2
mov [0x300104],eax
jmp 0x20:0

task4:
hlt

gate:
mov [edi],ax
mov word [edi+2],8
mov word [edi+4],0x8E00
shr eax,16
mov [edi+6],ax
ret
set_base:
mov [edi+2],ax
shr eax,16
mov [edi+4],al
mov [edi+7],ah
ret

handler_10:
; the new task's data segments may be unusable: reload before recording
mov eax,[esp]
mov bx,0x10
mov ds,bx
mov es,bx
mov ss,bx
mov esp,0x3C0000
mov [0x300118],eax
mov eax,[0x300004]
mov dword [0x300008+eax*8],10
mov dword [0x30000C+eax*8],0
inc dword [0x300004]
str ax
mov [0x300110],eax
mov dword [0x300000],0xC064C064
hlt
jmp $
handler_11:
push 11
jmp common_handler
handler_13:
push 13
common_handler:
push eax
push ebx
mov eax,[0x300004]
mov ebx,[esp+8]
mov [0x300008+eax*8],ebx
mov ebx,[esp+12]
mov [0x30000C+eax*8],ebx
inc dword [0x300004]
mov ebx,[resume]
mov [esp+16],ebx
pop ebx
pop eax
add esp,8
iret

align 8
resume: dd 0
gdt:
dq 0
dq 0x00CF9A000000FFFF   ; 0x08 code
dq 0x00CF92000000FFFF   ; 0x10 data
dq 0x0000820000000017   ; 0x18 LDT
dq 0x0000890000000067   ; 0x20 TSS 1 (available)
dq 0x0000890000000067   ; 0x28 TSS 2 (available)
dq 0x0000090000000067   ; 0x30 TSS (not present)
dq 0x00CF92000000FFFF   ; 0x38 data (not an LDT)
dq 0x0000020000000017   ; 0x40 LDT (not present)
dq 0x0000890000000067   ; 0x48 TSS 4 (its LDT field is invalid)
gdt_end:
gdtr: dw gdt_end-gdt-1
dd gdt
idtr: dw 14*8-1
dd idt-10*8
idt: times 4*8 db 0
ldt_table: times 24 db 0
align 16
tss1: times 104 db 0
tss2:
dd 0, 0x3E0000, 0x10, 0, 0, 0, 0, 0
dd task2, 2, 0, 0, 0, 0, 0x3E0000, 0, 0, 0
dd 0x10, 8, 0x10, 0x10, 0x10, 0x10, 0, 0
align 16
tss4:
dd 0, 0x3D0000, 0x10, 0, 0, 0, 0, 0
dd task4, 2, 0, 0, 0, 0, 0x3D0000, 0, 0, 0
dd 0x10, 8, 0x10, 0x10, 0x10, 0x10, 0x38, 0
image_end:
`;
const directory = assemble("task-faults", source);
const config = {length: 0x120};
const qemu = await reference(directory, config);
const v86 = await actual(directory, config);
const faults = buffer => Array.from({length: buffer.readUInt32LE(4)}, (_, i) =>
    [buffer.readUInt32LE(8 + i * 8), buffer.readUInt32LE(12 + i * 8)]);
console.log("QEMU faults", JSON.stringify(faults(qemu)));
assert.deepEqual(faults(qemu), [[13, 0x38], [11, 0x40], [13, 0x1C], [13, 0x20], [11, 0x30], [13, 0x20], [10, 0]], "reference");
assert.deepEqual(faults(v86), faults(qemu), "vectors and error codes");
for(const [offset, what] of [[0x100, "SLDT"], [0x104, "task 2 ran"], [0x10C, "TR after returning"], [0x110, "TR after the #TS"]])
{
    assert.equal(v86.readUInt32LE(offset) >>> 0, qemu.readUInt32LE(offset) >>> 0, what);
}
// (SDM: the error code is the LDT selector; QEMU pushes it through the new
// task's SS, whose state is undefined here, so only v86's is checked)
assert.equal(v86.readUInt32LE(0x118), 0x38, "#TS error code");
console.log("PASS task switch/LLDT/LTR faults agree with QEMU");
