; x87 register-stack arithmetic without memory operands (FLD ST(i), FMUL,
; FADD, FXCH, FSUB, FABS, FCHS, FADDP): a bounded fixed-point iteration.
%include "micro.inc"
_bench_main:
    mov ecx, [esp + 4]
    shl ecx, 12
    fld1
    fld1
    fadd st0, st0
    fdivp st1, st0          ; a = 0.5
    fld st0
    fmul st0, st0           ; b = 0.25
    fldz                    ; [x, b, a]
.loop:
    fld st0                 ; [x, x, b, a]
    fmul st0, st3           ; [x*a, x, b, a]
    fadd st0, st2           ; [y = x*a + b, x, b, a]
    fxch st1                ; [x, y, b, a]
    fsub st0, st1
    fabs
    fchs                    ; [-|x - y|, y, b, a]
    faddp st1, st0          ; [y - |x - y|, b, a]
    dec ecx
    jnz .loop
    fmul st0, st0
    fadd st0, st1
    fstp st1
    fstp st1
    push dword 1000000
    fimul dword [esp]
    fistp dword [esp]
    pop eax
    ret
