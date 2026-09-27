; Indirect calls through a function-pointer table (virtual-call shape).
%include "micro.inc"
_bench_main:
    push ebx
    push esi
    mov ecx, [esp + 12]
    shl ecx, 11
    xor eax, eax
    mov esi, 0x9E3779B9
.loop:
    mov ebx, esi
    shr ebx, 30
    call [table + ebx * 4]
    imul esi, esi, 1103515245
    add esi, 12345
    dec ecx
    jnz .loop
    pop esi
    pop ebx
    ret
f0: add eax, 1
    ret
f1: xor eax, 0x1234
    ret
f2: rol eax, 3
    ret
f3: sub eax, esi
    ret
section .data
table: dd f0, f1, f2, f3
