; SSE4.1 ROUND over finite values: ROUNDSD floor and ceil (PE suppressed),
; ROUNDSS truncation from memory, ROUNDPD in MXCSR's mode (PE reported).
%include "micro.inc"
_bench_main:
    push esi
    push edi
    ; values[i] = (i - 256) * 0.37, singles[i] = (i - 128) * 0.61
    xor ecx, ecx
.fill_values:
    lea eax, [ecx - 256]
    cvtsi2sd xmm0, eax
    mulsd xmm0, [scale_double]
    movsd [values + ecx * 8], xmm0
    inc ecx
    cmp ecx, 512
    jb .fill_values
    xor ecx, ecx
.fill_singles:
    lea eax, [ecx - 128]
    cvtsi2ss xmm0, eax
    mulss xmm0, [scale_single]
    movss [singles + ecx * 4], xmm0
    inc ecx
    cmp ecx, 256
    jb .fill_singles
    mov edx, [esp + 12]
    shl edx, 4
    xorpd xmm6, xmm6
    xorps xmm7, xmm7
.loop:
    mov esi, values
    mov edi, singles
    mov ecx, 256
.inner:
    movsd xmm0, [esi]
    roundsd xmm1, xmm0, 9
    roundsd xmm2, xmm0, 10
    addsd xmm1, xmm2
    roundss xmm3, [edi], 11
    addss xmm7, xmm3
    roundpd xmm4, [esi], 4
    addpd xmm6, xmm4
    addsd xmm6, xmm1
    add esi, 16
    add edi, 4
    dec ecx
    jnz .inner
    dec edx
    jnz .loop
    cvttsd2si eax, xmm6
    cvttss2si ecx, xmm7
    add eax, ecx
    pop edi
    pop esi
    ret
section .data
align 8
scale_double: dq 0.37
scale_single: dd 0.61
section .bss
align 16
values: resq 512
singles: resd 256
