; SSE4.1 packed integers: PMINUD, PMAXSD from aligned memory, PMULLD,
; PCMPGTQ, PBLENDW, BLENDPS and PACKUSDW over a 4 KiB table.
%include "micro.inc"
_bench_main:
    push esi
    mov edx, [esp + 8]
    shl edx, 4
    movdqa xmm7, [limit]
    pxor xmm6, xmm6
.loop:
    mov esi, table
    mov ecx, 256
.inner:
    movdqa xmm0, [esi]
    movdqa xmm1, xmm0
    pminud xmm0, xmm7
    pmaxsd xmm1, [esi + 16]
    pmulld xmm0, xmm1
    movdqa xmm2, xmm0
    pcmpgtq xmm2, xmm1
    pblendw xmm0, xmm2, 0x5A
    blendps xmm1, xmm0, 5
    packusdw xmm1, xmm0
    paddd xmm6, xmm1
    add esi, 16
    dec ecx
    jnz .inner
    dec edx
    jnz .loop
    pshufd xmm0, xmm6, 0x4E
    paddd xmm6, xmm0
    pshufd xmm0, xmm6, 0xB1
    paddd xmm6, xmm0
    movd eax, xmm6
    pop esi
    ret
section .data
align 16
limit: dd 0x7FFF0000, 0x00FFFFFF, 0x12345678, 0xFFFFFFF0
table:
%assign i 0
%rep 1028
    dd (i * 2654435761 + 12345) & 0xFFFFFFFF
%assign i i+1
%endrep
