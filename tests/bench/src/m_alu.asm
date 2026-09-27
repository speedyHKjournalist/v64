; Register-only integer ALU and FLAGS work (no memory, no helpers).
%include "micro.inc"
_bench_main:
    push ebx
    push esi
    push edi
    mov ecx, [esp + 16]
    shl ecx, 12
    mov eax, 0x12345678
    mov ebx, 0x9E3779B9
    xor edx, edx
    mov esi, 7
    mov edi, 3
.loop:
    add eax, ebx
    xor edx, eax
    rol eax, 5
    sub ebx, edx
    imul esi, eax
    lea edi, [edi + esi * 2 + 1]
    adc edx, edi
    shr ebx, 1
    sbb eax, esi
    and edi, 0x7FFFFFFF
    or ebx, edi
    not esi
    neg edx
    dec ecx
    jnz .loop
    xor eax, ebx
    xor eax, edx
    xor eax, esi
    xor eax, edi
    pop edi
    pop esi
    pop ebx
    ret
