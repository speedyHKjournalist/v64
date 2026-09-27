// NASM multiboot entry. The guest itself enters long mode and its high alias.
export function long_mode_guest(body, data = "")
{
    return `bits 32
org 0x100000
%define HIGH 0xFFFF800000000000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
cli
cld
lgdt [gdtr]
jmp 8:protected
protected:
mov ax,16
mov ds,ax
mov es,ax
mov ss,ax
mov esp,0x3F0000
mov dword [0x200000],0x201003
mov dword [0x200800],0x201003
mov dword [0x201000],0x202003
mov edi,0x202000
mov eax,0x83
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
mov eax,0x900
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
${body}
mov dword [0x300000],0xC064C064
hlt
jmp $
${data}
align 8
gdt: dq 0,0x00CF9A000000FFFF,0x00CF92000000FFFF,0x00AF9A000000FFFF
gdtr: dw 31
dd gdt
image_end:
`;
}
