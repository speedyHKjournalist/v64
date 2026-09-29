; A boot sector reached only after SeaBIOS completes POST, including its
; expected-CPU-count rendezvous. The harness supplies this on a floppy.
bits 16
org 0x7C00

start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7C00
    ; Expose the fw_cfg count seen by firmware, without changing it.
    mov dx, 0x510
    mov ax, 5                      ; FW_CFG_NB_CPUS
    out dx, ax
    inc dx
    in al, dx
    mov [0x500], al
    in al, dx
    mov [0x501], al
    mov eax, 1
    cpuid
    shr ebx, 24
    mov [0x504], ebx                ; boot must reach this on the BSP
    mov eax, 0x534D5042              ; "SMPB" pass marker
    out 0xF4, eax
.halt:
    hlt
    jmp .halt

times 510 - ($ - $$) db 0
dw 0xAA55
