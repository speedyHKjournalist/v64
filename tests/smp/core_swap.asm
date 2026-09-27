; Fixture for tests/smp/core_swap.mjs: a multiboot kernel that two CPU
; contexts run on one machine while the harness switches between them at
; main-loop boundaries (CPU.save_core_state/load_core_state).
;
; The harness sets EDI to the context id (0 or 1) before the first slice.
; Each context maps virtual 0x40000000 to its own 4 MiB page, physical
; 0x400000 * (id + 1), so a TLB entry left over from the other context sends
; writes to the wrong physical page. The loop mixes integer, x87 and SSE work
; so that registers, lazy flags, the x87 stack (and its shadow cache) and XMM
; registers all have to travel with the context.

bits 32
org 0x100000

MB_MAGIC    equ 0x1BADB002
MB_FLAGS    equ 0x10000             ; the address fields below are valid
ITERATIONS  equ 1500000
VIRTUAL     equ 0x40000000
RESULTS     equ 0x380000            ; 64 bytes per context

header:
    dd MB_MAGIC, MB_FLAGS, -(MB_MAGIC + MB_FLAGS)
    dd header, header, end, end, start

start:
    cli
    mov ebx, edi                    ; context id

    ; stack below 0x300000 + (id + 1) * 0x10000
    lea esp, [ebx + 1]
    shl esp, 16
    add esp, 0x300000

    ; page directory at 0x200000 + id * 0x1000: 4 MiB pages
    mov ebp, ebx
    shl ebp, 12
    add ebp, 0x200000
    mov edi, ebp
    mov ecx, 1024
    xor eax, eax
    rep stosd
    mov dword [ebp], 0x83           ; 0..4 MiB identity (present, writable, 4 MiB)
    lea eax, [ebx + 1]
    shl eax, 22
    or eax, 0x83
    mov [ebp + (VIRTUAL >> 22) * 4], eax

    mov cr3, ebp
    mov eax, cr4
    or eax, (1 << 4) | (1 << 9) | (1 << 10)     ; PSE, OSFXSR, OSXMMEXCPT
    mov cr4, eax
    mov eax, cr0
    and eax, ~(1 << 2)                          ; no x87 emulation
    or eax, (1 << 31) | (1 << 1)                ; paging, MP
    mov cr0, eax

    fninit
    fldcw [control]                 ; double precision, as Windows uses: the x87
                                    ; shadow cache (fast math) is live across slices
    fld1
    xorps xmm0, xmm0
    lea eax, [ebx + 1]
    cvtsi2ss xmm1, eax
    shufps xmm1, xmm1, 0            ; xmm1 = id + 1 in every lane

    mov esi, VIRTUAL
    mov ecx, ITERATIONS
    xor eax, eax
.loop:
    imul eax, eax, 33
    add eax, ecx
    add eax, ebx
    mov edx, ecx
    and edx, 1023
    xor eax, [esi + edx * 4]
    mov [esi + edx * 4], eax
    fmul qword [factor]             ; st0 = 1.0000001 ** n: every lost update shows
    addps xmm0, xmm1
    dec ecx
    jnz .loop

    mov edi, ebx
    shl edi, 6
    add edi, RESULTS
    mov [edi], eax
    fstp qword [edi + 8]
    movups [edi + 16], xmm0
    xor eax, eax
    xor ecx, ecx
.sum:
    add eax, [esi + ecx * 4]
    inc ecx
    cmp ecx, 1024
    jne .sum
    mov [edi + 32], eax
    lea eax, [ebx + 0xD0D0]
    mov [edi + 36], eax             ; done marker
.halt:
    hlt
    jmp .halt

align 8
control:    dw 0x027F
align 8
factor:     dq 1.0000001
end:
