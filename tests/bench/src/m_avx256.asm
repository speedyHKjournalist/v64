; AVX VEX.256 moves (the templates of docs/simd-xsave-plan.md P6 part 3):
; VMOVDQA/VMOVDQU ymm loads, VMOVNTDQ and VMOVDQU ymm stores (aligned and
; not), VMOVUPS between YMM registers over a 4 KiB table; VPXOR (VEX.128)
; sums the low halves, VZEROUPPER each round.
%include "micro.inc"
_bench_main:
    push esi
    push edi
    mov edx, [esp + 12]
    shl edx, 4
    vpxor xmm6, xmm6, xmm6
.loop:
    mov esi, table
    mov edi, copy
    mov ecx, 128
.inner:
    vmovdqa ymm0, [esi]
    vmovdqu ymm1, [esi + 8]
    vmovntdq [edi], ymm0
    vmovdqu [edi + 4100], ymm1
    vmovups ymm2, ymm1
    vpxor xmm6, xmm6, xmm2
    add esi, 32
    add edi, 32
    dec ecx
    jnz .inner
    vmovdqu ymm3, [copy + 4116]
    vpxor xmm6, xmm6, xmm3
    vzeroupper
    dec edx
    jnz .loop
    vpshufd xmm0, xmm6, 0x4E
    vpaddd xmm6, xmm6, xmm0
    vpshufd xmm0, xmm6, 0xB1
    vpaddd xmm6, xmm6, xmm0
    vmovd eax, xmm6
    pop edi
    pop esi
    ret
section .data
align 32
table:
%assign i 0
%rep 1032
    dd (i * 2654435761 + 12345) & 0xFFFFFFFF
%assign i i+1
%endrep
align 32
copy: times 8256 db 0
