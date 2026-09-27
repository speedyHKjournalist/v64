; Control flow that crosses 4 KiB code pages on every step: 16 blocks on 16
; pages, visited in a data-dependent order through direct and indirect jumps.
%include "micro.inc"
_bench_main:
    push ebx
    push esi
    mov ecx, [esp + 12]
    shl ecx, 9
    xor eax, eax
    mov esi, 0x12345
    jmp page0
done:
    pop esi
    pop ebx
    ret
%assign p 0
%rep 16
    align 4096
page %+ p:
    add eax, p * 3 + 1
    rol eax, 3
    imul esi, esi, 69069
    inc esi
%if p == 15
    dec ecx
    jz done
    mov ebx, esi
    shr ebx, 28
    jmp [pages + ebx * 4]
%else
%assign q p + 1
    test esi, 0x100000
    jz page %+ q
    xor eax, esi
    jmp page %+ q
%endif
%assign p p + 1
%endrep
section .data
pages:
%assign p 0
%rep 16
    dd page %+ p
%assign p p + 1
%endrep
