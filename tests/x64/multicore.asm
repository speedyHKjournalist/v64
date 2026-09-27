bits 32
org 0x100000
%define CONTROL 0x380000
%define RECORDS 0x390000
%define LAPIC 0xFEE00000
%define HIGH 0xFFFF800000000000
%define VIRTUAL HIGH+0x40055000
%define ITERATIONS 512
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,end,end,start
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
mov esp,0x310000
mov al,255
out 0x21,al
out 0xA1,al
mov esi,trampoline
mov edi,0x8000
mov ecx,trampoline_end-trampoline
rep movsb
mov dword [CONTROL+8],-1
mov dword [CONTROL+12],-1
%ifdef REFERENCE
mov dword [CONTROL+28],1
%endif
xor ebx,ebx
.prepare:
mov ebp,ebx
shl ebp,16
add ebp,0x200000
lea eax,[ebp+0x1003]
mov [ebp],eax
mov [ebp+256*8],eax
mov [ebp+ebx*8+256*8],eax
lea eax,[ebp+0x2003]
mov [ebp+0x1000],eax
lea eax,[ebp+0x3003]
mov [ebp+0x1008],eax
lea edi,[ebp+0x2000]
mov eax,0x83
mov ecx,512
.pages:
stosd
mov dword [edi],0
add edi,4
add eax,0x200000
loop .pages
mov eax,ebx
shl eax,21
add eax,0x800083
mov [ebp+0x3000],eax
and eax,~4095
add eax,0x55000
lea edx,[ebx+0xA100]
mov [eax],edx
add eax,0x800000
lea edx,[ebx+0xB200]
mov [eax],edx
mov eax,ebx
shl eax,12
lea edx,[ebx+0xF500]
mov [eax+0x400000],edx
lea edx,[ebx+0x6500]
mov [eax+0x440000],edx
lea edx,[ebx+0x7500]
mov [eax+0x480000],edx
inc ebx
cmp ebx,4
jb .prepare
mov dword [LAPIC+0xF0],0x1FF
mov ebx,1
.start_ap:
mov eax,ebx
shl eax,24
mov [LAPIC+0x310],eax
mov dword [LAPIC+0x300],0xC500
mov dword [LAPIC+0x300],0x8500
mov dword [LAPIC+0x300],0x608
inc ebx
cmp ebx,4
jb .start_ap
xor ebx,ebx
jmp enter_long
bits 16
trampoline:
cli
mov edx,cr0
mov ax,cs
movzx esi,ax
lgdt [cs:trampoline_gdtr-trampoline]
mov eax,cr0
or eax,1
mov cr0,eax
jmp dword 8:ap_entry
trampoline_gdtr:
dw 31
dd gdt
trampoline_end:
bits 32
ap_entry:
mov ax,16
mov ds,ax
mov es,ax
mov ss,ax
mov ebx,[LAPIC+0x20]
shr ebx,24
mov edi,ebx
shl edi,10
mov [RECORDS+edi],edx
mov [RECORDS+edi+4],esi
enter_long:
lea esp,[ebx+1]
shl esp,16
add esp,0x300000
mov eax,ebx
shl eax,16
add eax,0x200000
mov cr3,eax
mov eax,cr4
or eax,0x620
mov cr4,eax
mov ecx,0xC0000080
rdmsr
or eax,0x100
wrmsr
mov eax,cr0
and eax,~12
or eax,0x80010001
mov cr0,eax
jmp 24:long_entry
bits 64
long_entry:
mov r15d,ebx
mov rax,r15
shl rax,39
mov r14,HIGH
or r14,rax
mov rax,high_entry
add rax,r14
jmp rax
high_entry:
mov rbp,r15
shl rbp,10
add rbp,RECORDS
mov rdi,HIGH+CONTROL
mov rax,r15
shl rax,12
add eax,0x400000
mov edx,0xFFFF8000
mov ecx,0xC0000100
wrmsr
add eax,0x40000
inc ecx
wrmsr
add eax,0x40000
inc ecx
wrmsr
mov eax,r15d
or eax,0xAA000000
xor edx,edx
mov ecx,0xC0000103
wrmsr
mov r8,0xAABBCCDD00000000
add r8,r15
%assign n 8
%rep 8
mov rax,0xDADABABA00000000+n
add rax,r15
mov [rbp+64+(n-8)*16],rax
not rax
mov [rbp+72+(n-8)*16],rax
movdqu xmm%+n,[rbp+64+(n-8)*16]
%assign n n+1
%endrep
mov r9,VIRTUAL
mov eax,[r9]
mov [rbp+16],eax
mov rbx,r15
shl rbx,16
add rbx,0x203000
mov eax,r15d
shl eax,21
add eax,0x1000083
mov [rbx],eax ; leave this core's old TLB translation cached across snapshot
xor r12d,r12d
xor r13d,r13d
mov ecx,10000
.hot:
add r12,7
xor r13,r12
dec ecx
jnz .hot
mov r10d,ITERATIONS
call contend
mov [rbp+8],r14
mov [rbp+24],r8
lock inc dword [rdi+16]
.barrier:
cmp dword [rdi+28],0
je .host_release
cmp dword [rdi+16],4
jne .barrier
mov dword [rdi+20],1
.host_release:
cmp dword [rdi+20],0
je .barrier
; State below must have survived many switches and optional snapshot restore.
mov rax,0xAABBCCDD00000000
add rax,r15
cmp r8,rax
jne fail_gpr
cmp r12,70000
jne fail_gpr
mov eax,[r9]
mov [rbp+32],eax
cmp eax,[rbp+16]
jne fail_tlb
invlpg [r9]
mov eax,[r9]
mov [rbp+36],eax
lea edx,[r15d+0xB200]
cmp eax,edx
jne fail_tlb
mov eax,[fs:0]
lea edx,[r15d+0xF500]
cmp eax,edx
jne fail_msr
mov eax,[gs:0]
lea edx,[r15d+0x6500]
cmp eax,edx
jne fail_msr
swapgs
mov eax,[gs:0]
lea edx,[r15d+0x7500]
cmp eax,edx
jne fail_msr
swapgs
rdtscp
mov eax,r15d
or eax,0xAA000000
cmp eax,ecx
jne fail_msr
mov [rbp+40],ecx
%assign n 8
%rep 8
movdqu [rbp+256+(n-8)*16],xmm%+n
mov rax,[rbp+256+(n-8)*16]
cmp rax,[rbp+64+(n-8)*16]
jne fail_xmm
mov rax,[rbp+264+(n-8)*16]
cmp rax,[rbp+72+(n-8)*16]
jne fail_xmm
%assign n n+1
%endrep
mov r10d,ITERATIONS
call contend
mov dword [rbp+48],0xD064
lock inc dword [rdi+24]
.done:
hlt
jmp .done
contend:
.retry:
mov rax,[rdi]
mov rdx,[rdi+8]
lea rbx,[rax+1]
mov rcx,rbx
not rcx
lock cmpxchg16b [rdi]
jnz .retry
dec r10d
jnz .retry
ret
fail_gpr: mov eax,1
jmp failed
fail_tlb: mov eax,2
jmp failed
fail_msr: mov eax,3
jmp failed
fail_xmm: mov eax,4
failed:
mov [rbp+52],eax
mov [rdi+32],eax
jmp high_entry.done
align 8
gdt:
dq 0,0x00CF9A000000FFFF,0x00CF92000000FFFF,0x00AF9A000000FFFF
gdtr: dw 31
dd gdt
end:
