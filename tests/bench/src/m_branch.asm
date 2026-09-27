; Data-dependent, poorly predictable branches driven by a 32-bit LFSR.
%include "micro.inc"
_bench_main:
    push ebx
    push esi
    mov ecx, [esp + 12]
    shl ecx, 12
    mov eax, 0xACE1ACE1
    xor ebx, ebx
    xor esi, esi
.loop:
    shr eax, 1
    jnc .no_tap
    xor eax, 0xD0000001
.no_tap:
    test al, 2
    jz .a
    add ebx, 3
    test al, 4
    jnz .b
    sub esi, ebx
    jmp .c
.a:
    inc esi
    test al, 8
    jz .c
.b:
    xor ebx, esi
.c:
    cmp bl, al
    jae .d
    add esi, 5
.d:
    dec ecx
    jnz .loop
    lea eax, [ebx + esi]
    pop esi
    pop ebx
    ret
