; Near CALL/RET to small leaf and two-level functions (return-site dispatch).
%include "micro.inc"
_bench_main:
    push ebx
    mov ecx, [esp + 8]
    shl ecx, 11
    xor eax, eax
    mov ebx, 1
.loop:
    call leaf
    call outer
    dec ecx
    jnz .loop
    pop ebx
    ret
leaf:
    add eax, ebx
    rol ebx, 1
    ret
outer:
    call leaf
    xor eax, 0x55
    call leaf
    ret
