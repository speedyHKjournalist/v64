; AVX2 (the templates of docs/simd-xsave-plan.md P7 part 3): a strlen-like
; scan of a 4 KiB table, 32 bytes a step: VPCMPEQB with a broadcast byte,
; VPMINUB, VPCMPGTB, VPOR, VPANDN, VPADDB, VPXOR, VPMINUD, VPCMPEQD, VPAND
; and VPMOVMSKB r32, ymm; VPBROADCASTB/D each round.
%include "micro.inc"
_bench_main:
    push esi
    push ebx
    mov edx, [esp + 12]
    shl edx, 4
    xor ebx, ebx
.loop:
    mov esi, table
    mov ecx, 128
    vpbroadcastb ymm7, [needle]
    vpbroadcastd ymm6, [bias]
.inner:
    vmovdqu ymm0, [esi]
    vpcmpeqb ymm1, ymm0, ymm7
    vpminub ymm2, ymm0, ymm6
    vpcmpgtb ymm3, ymm0, ymm6
    vpor ymm1, ymm1, ymm3
    vpandn ymm4, ymm2, ymm1
    vpaddb ymm5, ymm4, ymm0
    vpxor ymm5, ymm5, ymm2
    vpminud ymm5, ymm5, ymm0
    vpcmpeqd ymm4, ymm5, ymm0
    vpand ymm4, ymm4, ymm1
    vpmovmskb eax, ymm4
    add ebx, eax
    vpmovmskb eax, ymm5
    xor ebx, eax
    add esi, 32
    dec ecx
    jnz .inner
    vzeroupper
    dec edx
    jnz .loop
    mov eax, ebx
    pop ebx
    pop esi
    ret
section .data
align 32
needle: db 0x5A
align 4
bias: dd 0x40404040
align 32
table:
%assign i 0
%rep 1024
    dd (i * 2654435761 + 12345) & 0xFFFFFFFF
%assign i i+1
%endrep
