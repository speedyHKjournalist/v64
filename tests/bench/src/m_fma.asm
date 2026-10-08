; FMA (the templates of docs/simd-xsave-plan.md P11 part 2): a polynomial of
; degree 8 in Horner form, the forms libm's _fma variants use most
; (VFMADD213SD, VFMADD132SD, VFMADD231SD; register and memory operands), at
; 512 points a round.
%include "micro.inc"
_bench_main:
    push esi
    push ebx
    mov edx, [esp + 12]
    vxorpd xmm7, xmm7, xmm7
.loop:
    mov ecx, 512
.inner:
    vcvtsi2sd xmm0, xmm0, ecx
    vmulsd xmm0, xmm0, [scale]
    vmovsd xmm1, [coefficients]
    vfmadd213sd xmm1, xmm0, [coefficients + 8]
    vfmadd213sd xmm1, xmm0, [coefficients + 16]
    vfmadd213sd xmm1, xmm0, [coefficients + 24]
    vmovsd xmm2, [coefficients + 32]
    vfmadd132sd xmm1, xmm2, xmm0
    vmovsd xmm2, [coefficients + 40]
    vfmadd132sd xmm1, xmm2, xmm0
    vmovsd xmm3, [coefficients + 48]
    vfmadd231sd xmm3, xmm1, xmm0
    vfmadd213sd xmm3, xmm0, [coefficients + 56]
    vfmadd213sd xmm3, xmm0, [coefficients + 64]
    vaddsd xmm7, xmm7, xmm3
    dec ecx
    jnz .inner
    dec edx
    jnz .loop
    vmovd eax, xmm7
    vpextrd ebx, xmm7, 1
    xor eax, ebx
    pop ebx
    pop esi
    ret
section .data
align 8
scale: dq 0.001953125
coefficients: dq 2.48015873015873e-05, 0.0001984126984126984, 0.001388888888888889, 0.008333333333333333
    dq 0.041666666666666664, 0.16666666666666666, 0.5, 1.0, 1.0
