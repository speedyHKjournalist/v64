; REP string instructions: MOVSD/STOSD blocks, MOVSB tails, SCASB searches
; and CMPSD compares over small and page-sized buffers.
%include "micro.inc"
_bench_main:
    push ebx
    push esi
    push edi
    mov ebx, [esp + 16]
    shl ebx, 4
    cld
.loop:
    mov esi, source
    mov edi, target
    mov ecx, 1024
    rep movsd
    mov edi, target + 4096
    mov eax, ebx
    mov ecx, 64
    rep stosd
    mov esi, source + 1
    mov edi, target + 8192 + 3
    mov ecx, 37
    rep movsb
    mov edi, source
    mov al, 0x5A
    mov ecx, 512
    repne scasb
    mov esi, source
    mov edi, target
    mov ecx, 256
    repe cmpsd
    dec ebx
    jnz .loop
    mov eax, [target + 4096]
    add eax, ecx
    pop edi
    pop esi
    pop ebx
    ret
section .data
source: times 4096 db 0x11
section .bss
target: resb 12288
