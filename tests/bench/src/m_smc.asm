; Self-modifying code: every 64th iteration rewrites an immediate in a
; function on its own page, then keeps calling it (invalidation/recompile).
%include "micro.inc"
_bench_main:
    push ebx
    mov ecx, [esp + 8]
    shl ecx, 10
    xor eax, eax
    xor ebx, ebx
.loop:
    test ecx, 63
    jnz .call
    inc ebx
    mov [patched + 1], ebx
.call:
    call patched
    dec ecx
    jnz .loop
    pop ebx
    ret
    align 4096
patched:
    mov edx, 0
    add eax, edx
    rol eax, 1
    ret
