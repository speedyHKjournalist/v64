; v86 CPU benchmark BIOS. Enters flat 32-bit protected mode with 4 KiB paging
; identity-mapping the first 64 MiB, enables x87/SSE, installs exception
; handlers that report the vector, then signals readiness and halts.
;
; Memory map: 0x500 ready marker (0xCAFE), 0x600 parameter block (see
; lib/crt0.asm), 0x7000 IDT, 0x10000 page directory, 0x11000-0x20FFF page
; tables, stack below 0x3F0000, benchmark images from 0x400000.
bits 16
org 0
    cli
    lgdt [cs:gdtr]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    jmp dword 8:0xF0000 + protected
bits 32
protected:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov fs, ax
    mov gs, ax
    mov esp, 0x3F0000
    cld
    ; Page directory: 16 tables for 64 MiB.
    xor eax, eax
    mov edi, 0x10000
    mov ecx, 1024
    rep stosd
    mov edi, 0x10000
    mov eax, 0x11003
    mov ecx, 16
.pde:
    stosd
    add eax, 4096
    loop .pde
    mov edi, 0x11000
    mov eax, 3
    mov ecx, 16 * 1024
.pte:
    stosd
    add eax, 4096
    loop .pte
    ; IDT: vectors 0-31 report the exception; the rest are absent.
    xor eax, eax
    mov edi, 0x7000
    mov ecx, 512
    rep stosd
    mov edi, 0x7000
    mov ebx, 0xF0000 + fault0
    xor ecx, ecx
.idt:
    mov eax, ebx
    mov [edi], ax
    mov word [edi + 2], 8
    mov word [edi + 4], 0x8E00
    shr eax, 16
    mov [edi + 6], ax
    add edi, 8
    add ebx, fault1 - fault0
    inc ecx
    cmp ecx, 32
    jb .idt
    lidt [0xF0000 + idtr]
    mov eax, 0x10000
    mov cr3, eax
    ; CR0: PG, NE, MP; clear EM and TS. CR4: OSFXSR, OSXMMEXCPT.
    mov eax, cr0
    or eax, 0x80000022
    and eax, ~0xC
    mov cr0, eax
    mov eax, cr4
    or eax, 0x600
    mov cr4, eax
    fninit
    mov dword [0x500], 0xCAFE
    hlt
    jmp $
    ; One 32-byte stub per vector: record 0x80000000 | vector, then halt.
align 32
fault0:
%assign vector 0
%rep 32
    mov dword [0x608], 0x80000000 | vector
    mov eax, [esp]
    mov [0x60C], eax
    hlt
    jmp $
    align 32
%assign vector vector + 1
%endrep
fault1 equ fault0 + 32
align 8
gdt:
    dq 0, 0x00CF9A000000FFFF, 0x00CF92000000FFFF
gdtr:
    dw 23
    dd 0xF0000 + gdt
idtr:
    dw 32 * 8 - 1
    dd 0x7000
times 0xFFF0 - ($ - $$) db 0xF4
bits 16
    jmp 0xF000:start
start equ 0
times 0x10000 - ($ - $$) db 0xF4
