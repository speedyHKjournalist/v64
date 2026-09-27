; Read-modify-write memory operands (ADD/INC/XOR/SHL on [mem]) and LOCK XADD.
%include "micro.inc"
_bench_main:
    push ebx
    mov ecx, [esp + 8]
    shl ecx, 11
    xor eax, eax
    xor ebx, ebx
.loop:
    mov edx, ebx
    and edx, 255
    add [counters + edx * 4], ecx
    inc dword [counters + edx * 4 + 1024]
    xor [counters + edx * 4 + 2048], eax
    shl dword [counters + edx * 4 + 3072], 1
    mov eax, 1
    lock xadd [counters], eax
    add ebx, 13
    dec ecx
    jnz .loop
    mov eax, [counters + 4]
    add eax, [counters + 1028]
    add eax, [counters + 2052]
    pop ebx
    ret
section .bss
counters: resd 1024
