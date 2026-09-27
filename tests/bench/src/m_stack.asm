; Stack traffic: PUSH/POP of registers and frames (EBP chains, locals).
%include "micro.inc"
_bench_main:
    push ebx
    push esi
    push edi
    mov ecx, [esp + 16]
    shl ecx, 11
    xor eax, eax
.loop:
    push eax
    push ecx
    push 7
    call frame
    add esp, 12
    dec ecx
    jnz .loop
    pop edi
    pop esi
    pop ebx
    ret
frame:
    push ebp
    mov ebp, esp
    sub esp, 16
    mov edx, [ebp + 8]
    mov [ebp - 4], edx
    mov edx, [ebp + 12]
    add edx, [ebp - 4]
    mov [ebp - 8], edx
    push ebx
    push esi
    mov ebx, [ebp + 16]
    lea esi, [edx + ebx]
    xor eax, esi
    pop esi
    pop ebx
    mov esp, ebp
    pop ebp
    ret
