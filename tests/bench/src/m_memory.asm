; Loads and stores to an L1-sized array: indexed, unaligned and byte/word
; accesses mixed with ALU work.
%include "micro.inc"
_bench_main:
    push ebx
    push esi
    push edi
    mov ecx, [esp + 16]
    shl ecx, 11
    xor eax, eax
    xor ebx, ebx
.loop:
    mov esi, ebx
    and esi, 1023
    mov edx, [array + esi * 4]
    add edx, eax
    mov [array + esi * 4 + 4], edx
    movzx edi, byte [array + esi + 1]
    add eax, edi
    mov di, [array + esi * 2 + 3]
    add eax, edi
    mov [array + esi + 2], ax
    add ebx, 97
    dec ecx
    jnz .loop
    pop edi
    pop esi
    pop ebx
    ret
section .bss
array: resd 1100
