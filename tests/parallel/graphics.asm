; A graphical screen with cores in vCPU workers (tests/parallel/browser_graphics.html):
; the BSP switches to 640x480x32 through the Bochs VBE registers and fills
; the linear frame buffer, red above row 240 and green below. With cores in
; workers the wasm memory, and so the VGA's pixel buffer, is shared memory.
; The frame buffer is where the firmware put the VGA's BAR0, as for a driver.

bits 32
org 0x100000

MB_MAGIC equ 0x1BADB002
MB_FLAGS equ 0x10000
VGA_BAR0 equ 0x80000000 | 0x12 << 11 | 0x10  ; PCI 00:12.0, register 0x10

header:
    dd MB_MAGIC, MB_FLAGS, -(MB_MAGIC + MB_FLAGS)
    dd header, header, end, end, start

%macro vbe 2
    mov dx, 0x1CE
    mov ax, %1
    out dx, ax
    mov dx, 0x1CF
    mov ax, %2
    out dx, ax
%endmacro

start:
    cli
    cld
    vbe 4, 0                    ; disable
    vbe 1, 640                  ; x resolution
    vbe 2, 480                  ; y resolution
    vbe 3, 32                   ; bits per pixel
    vbe 4, 0x41                 ; enable, linear frame buffer
    mov dx, 0xCF8
    mov eax, VGA_BAR0
    out dx, eax
    mov dx, 0xCFC
    in eax, dx
    and eax, ~0xF
    mov edi, eax
    mov ecx, 640 * 240
    mov eax, 0x00FF0000         ; red
    rep stosd
    mov ecx, 640 * 240
    mov eax, 0x0000FF00         ; green
    rep stosd
.halt:
    hlt
    jmp .halt
end:
