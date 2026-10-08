; BMI1, BMI2, LZCNT and MOVBE (the templates of docs/simd-xsave-plan.md P10
; part 2): the words of a 4 KiB table, loaded big-endian (MOVBE), each set
; bit in turn (TZCNT, BLSR), then LZCNT and a left-aligned copy (SHLX), the
; low bits below a count (BZHI), BLSMSK, ANDN and shifts by register (SARX,
; SHRX).
%include "micro.inc"
_bench_main:
    push esi
    push edi
    push ebx
    push ebp
    mov ebp, [esp + 20]
    xor ebx, ebx
.loop:
    mov esi, table
    mov ecx, 1024
.inner:
    movbe eax, [esi]
    mov edx, eax
.bits:
    test edx, edx
    jz .done
    tzcnt edi, edx
    add ebx, edi
    blsr edx, edx
    jmp .bits
.done:
    lzcnt edi, eax
    shlx edx, eax, edi
    add ebx, edx
    bzhi edx, eax, ecx
    xor ebx, edx
    blsmsk edx, eax
    andn edx, edx, ebx
    add ebx, edx
    sarx edx, eax, ecx
    shrx edi, ebx, ecx
    xor ebx, edx
    add ebx, edi
    add esi, 4
    dec ecx
    jnz .inner
    dec ebp
    jnz .loop
    mov eax, ebx
    pop ebp
    pop ebx
    pop edi
    pop esi
    ret
section .data
align 4
table:
%assign i 0
%rep 1024
    dd (i * 2654435761 + 12345) & 0xFFFFFFFF
%assign i i+1
%endrep
