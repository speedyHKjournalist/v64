; Guest-only AP startup and IPI fixture for ap_startup.mjs. The host writes
; commands to a mailbox; only this BSP sends INIT/SIPI and changes AP state.
; All APs enter the copied real-mode trampoline at CS:IP = vector*256:0.

bits 32
org 0x100000

MB_MAGIC equ 0x1BADB002
MB_FLAGS equ 0x10000
CONTROL equ 0x380000
RECORDS equ CONTROL + 0x100
LAPIC equ 0xFEE00000
IDT equ 0x200000
STACKS equ 0x300000

; Mailbox: cores, command, target, request, completed, vector, guest_error,
; stage, acknowledgement bitmap. Records: 64 bytes per APIC ID.
header:
    dd MB_MAGIC, MB_FLAGS, -(MB_MAGIC + MB_FLAGS)
    dd header, header, end, end, start

start:
    cli
    cld
    lgdt [gdtr]
    jmp 8:.protected
.protected:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov esp, STACKS + 0x10000
    ; Mask the legacy PIC: every interrupt in this fixture must be an IPI.
    mov al, 0xFF
    out 0x21, al
    out 0xA1, al

    mov esi, trampoline
    mov edi, 0x8000
    mov ecx, trampoline_end - trampoline
    rep movsb
    mov esi, trampoline
    mov edi, 0x9000
    mov ecx, trampoline_end - trampoline
    rep movsb

    mov edi, IDT
    mov ecx, 256
    mov eax, unexpected_interrupt
    mov ebx, eax
    and eax, 0xFFFF
    or eax, 8 << 16
    and ebx, 0xFFFF0000
    or ebx, 0x8E00
.fill_idt:
    stosd
    xchg eax, ebx
    stosd
    xchg eax, ebx
    loop .fill_idt
    mov eax, fixed_ipi
    mov edi, IDT + 0x41 * 8
    call install_gate
%assign n 1
%rep 7
    mov eax, ack_%+n
    mov edi, IDT + (0x50 + n) * 8
    call install_gate
%assign n n+1
%endrep
    mov eax, spurious_interrupt
    mov edi, IDT + 0xFF * 8
    call install_gate
    lidt [idtr]
    mov dword [LAPIC + 0xF0], 0x1FF
    mov dword [CONTROL + 28], 1
    sti

.command_loop:
    mov eax, [CONTROL + 12]
    cmp eax, [CONTROL + 16]
    jne .command
    pause
    jmp .command_loop
.command:
    mov eax, [CONTROL + 4]
    cmp eax, 1
    je .start_all
    cmp eax, 2
    je .directed
    cmp eax, 3
    je .all
    cmp eax, 4
    je .excluding
    cmp eax, 5
    je .physical_broadcast
    cmp eax, 6
    je .restart
    cmp eax, 7
    je .sipi_only
    cmp eax, 8
    je .restart_two_sipis
    mov dword [CONTROL + 24], 1
    jmp .complete
.start_all:
    mov ebx, 1
.next_ap:
    mov ecx, ebx
    shl ecx, 24
    mov [LAPIC + 0x310], ecx
    mov dword [LAPIC + 0x300], 0xC500 ; INIT level assert
    mov dword [LAPIC + 0x300], 0x8500 ; INIT level deassert
    mov dword [LAPIC + 0x300], 0x608  ; SIPI vector 8
    inc ebx
    cmp ebx, [CONTROL]
    jb .next_ap
    jmp .complete
.directed:
    mov eax, [CONTROL + 8]
    shl eax, 24
    mov [LAPIC + 0x310], eax
    mov dword [LAPIC + 0x300], 0x41
    jmp .complete
.all:
    mov dword [LAPIC + 0x300], 0x80041
    jmp .complete
.excluding:
    mov dword [LAPIC + 0x300], 0xC0041
    jmp .complete
.physical_broadcast:
    mov dword [LAPIC + 0x310], 0xFF000000
    mov dword [LAPIC + 0x300], 0x41
    jmp .complete
.restart:
.restart_two_sipis:
    mov eax, [CONTROL + 8]
    shl eax, 24
    mov [LAPIC + 0x310], eax
    mov dword [LAPIC + 0x300], 0xC500
    mov dword [LAPIC + 0x300], 0x8500
    mov eax, [CONTROL + 20]
    or eax, 0x600
    mov [LAPIC + 0x300], eax
    cmp dword [CONTROL + 4], 8
    jne .complete
    ; Two SIPIs before a scheduler boundary: the first vector must win.
    xor eax, 1
    mov [LAPIC + 0x300], eax
    jmp .complete
.sipi_only:
    mov eax, [CONTROL + 8]
    shl eax, 24
    mov [LAPIC + 0x310], eax
    mov eax, [CONTROL + 20]
    or eax, 0x600
    mov [LAPIC + 0x300], eax
.complete:
    mov eax, [CONTROL + 12]
    mov [CONTROL + 16], eax
    jmp .command_loop

install_gate:
    mov [edi], ax
    mov word [edi + 2], 8
    mov word [edi + 4], 0x8E00
    shr eax, 16
    mov [edi + 6], ax
    ret

; Position-independent 16-bit code, copied to both 0x8000 and 0x9000.
bits 16
trampoline:
    cli
    mov eax, cr0
    mov edx, eax                    ; prove the AP arrived in real mode
    mov ax, cs
    movzx esi, ax                   ; original startup CS, preserved into PM
    lgdt [cs:trampoline_gdtr - trampoline]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    jmp dword 8:ap_start
trampoline_gdtr:
    dw gdt_end - gdt - 1
    dd gdt
trampoline_end:

bits 32
ap_start:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov ebx, [LAPIC + 0x20]
    shr ebx, 24
    lea esp, [ebx + 1]
    shl esp, 16
    add esp, STACKS
    mov edi, ebx
    shl edi, 6
    add edi, RECORDS
    inc dword [edi]                 ; boot count survives re-INIT
    mov [edi + 12], edx
    mov [edi + 16], esi
    shr esi, 8
    mov [edi + 8], esi
    mov [edi + 24], esp
    mov eax, 1
    push ebx
    cpuid
    shr ebx, 24
    mov [edi + 44], ebx
    pop ebx
    mov eax, cr0
    mov [edi + 48], eax
    xor eax, eax
    mov ax, cs
    mov [edi + 56], eax
    lidt [idtr]
    mov dword [LAPIC + 0xF0], 0x1FF
    mov dword [LAPIC + 0x80], 0
    lea ebp, [ebx + 0xC0010000]
    lea esi, [ebx + 0x51A70000]
    push ebp                       ; private stack canary, retained over HLT
    lea eax, [ebx + 0xA9000000]
    mov [edi + 4], eax
.wait:
    mov dword [edi + 40], 1
    sti
    hlt
    cli
    mov dword [edi + 40], 0
    inc dword [edi + 36]
    lea eax, [ebx + 0xC0010000]
    cmp ebp, eax
    jne .bad_register
    cmp [esp], eax
    jne .bad_register
    lea eax, [ebx + 0x51A70000]
    cmp esi, eax
    jne .bad_register
    lea eax, [ebx + 1]
    shl eax, 16
    add eax, STACKS - 4
    cmp esp, eax
    jne .bad_register
    jmp .wait
.bad_register:
    inc dword [edi + 28]
    jmp .wait

fixed_ipi:
    pushad
    mov ebx, [LAPIC + 0x20]
    shr ebx, 24
    mov edi, ebx
    shl edi, 6
    inc dword [RECORDS + edi + 32]
    mov dword [LAPIC + 0xB0], 0
    test ebx, ebx
    jz .return
    ; A different vector for each AP avoids merging broadcast replies in IRR.
    mov dword [LAPIC + 0x310], 0
    lea eax, [ebx + 0x50]
    mov [LAPIC + 0x300], eax
.return:
    popad
    iretd

%assign n 1
%rep 7
ack_%+n:
    lock bts dword [CONTROL + 32], n
    mov dword [LAPIC + 0xB0], 0
    iretd
%assign n n+1
%endrep

spurious_interrupt:
    iretd
unexpected_interrupt:
    mov dword [CONTROL + 24], 2
    cli
.halt:
    hlt
    jmp .halt

align 8
gdt:
    dq 0
    dq 0x00CF9A000000FFFF
    dq 0x00CF92000000FFFF
gdt_end:
gdtr:
    dw gdt_end - gdt - 1
    dd gdt
idtr:
    dw 256 * 8 - 1
    dd IDT
end:
