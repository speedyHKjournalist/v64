; Switch statements compiled to jump tables (indirect JMP to 8 targets).
%include "micro.inc"
_bench_main:
    push ebx
    push esi
    mov ecx, [esp + 12]
    shl ecx, 11
    xor eax, eax
    mov esi, 0x2545F491
switch_loop:
    mov ebx, esi
    shr ebx, 29
    jmp [cases + ebx * 4]
c0: inc eax
    jmp switch_next
c1: add eax, 7
    jmp switch_next
c2: xor eax, esi
    jmp switch_next
c3: shl eax, 1
    jmp switch_next
c4: sub eax, 3
    jmp switch_next
c5: ror eax, 2
    jmp switch_next
c6: not eax
    jmp switch_next
c7: add eax, ebx
switch_next:
    imul esi, esi, 1103515245
    add esi, 12345
    dec ecx
    jnz switch_loop
    pop esi
    pop ebx
    ret
section .data
cases: dd c0, c1, c2, c3, c4, c5, c6, c7
