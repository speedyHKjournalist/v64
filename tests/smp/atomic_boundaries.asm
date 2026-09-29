; LOCK/XCHG/CMPXCHG8B exception/MMIO gate. The guest performs all page-table
; updates, accesses and #PF recovery. Test PIO only brackets observations.
bits 32
org 0x100000
%define CONTROL 0x380000
%define DESCRIPTORS 0x381000
%define RESULT 0x382000
%define PD 0x200000
%define PT 0x201000
%define IDT 0x280000
%define VIRTUAL 0x40000000
%define RECOVERY CONTROL + 12
header:
    dd 0x1BADB002, 0x10000, -(0x1BADB002 + 0x10000)
    dd header, header, end, end, start
start:
    cli
    cld
    lgdt [gdtr]
    jmp 8:protected
protected:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov esp, 0x310000
    mov edi, IDT
    mov ecx, 256
    mov eax, unexpected
    mov ebx, eax
    and eax, 0xFFFF
    or eax, 8 << 16
    and ebx, 0xFFFF0000
    or ebx, 0x8E00
.idt:
    stosd
    xchg eax, ebx
    stosd
    xchg eax, ebx
    loop .idt
    mov eax, page_fault
    mov word [IDT + 14 * 8], ax
    shr eax, 16
    mov word [IDT + 14 * 8 + 6], ax
    mov eax, invalid_opcode
    mov word [IDT + 6 * 8], ax
    shr eax, 16
    mov word [IDT + 6 * 8 + 6], ax
    lidt [idtr]
    mov dword [PD], 0x83
    mov dword [PD + 1024], PT | 3
    mov eax, PD
    mov cr3, eax
    mov eax, cr4
    or eax, 1 << 4
    mov cr4, eax
    mov eax, cr0
    or eax, (1 << 31) | (1 << 16) ; CR0.PG + WP: supervisor RO writes fault
    mov cr0, eax
    mov esi, DESCRIPTORS
    xor ebp, ebp
.next:
    mov eax, [esi]
    mov [PT], eax
    mov eax, [esi + 4]
    mov [PT + 4], eax
    invlpg [VIRTUAL]
    invlpg [VIRTUAL + 4096]
    mov dword [RESULT + 40], 0
    mov dword [RESULT + 48], 0
    mov dword [RESULT + 28], 0
    mov dword [RESULT + 32], 0
    mov dword [RESULT + 36], 0
    mov eax, [esi + 12]           ; operation table index
    shl eax, 3
    mov ebx, [operations + eax + 4]
    mov [RECOVERY], ebx
    mov ebx, [operations + eax]
    mov [CONTROL + 16], ebx
    mov eax, [esi + 20]
    mov [CONTROL + 20], eax      ; warm-up iterations or one observed access
    mov eax, ebp
    mov dx, 0x504
    out dx, eax
.repeat:
    mov edi, [esi + 8]
    mov eax, [esi + 16]
    mov edx, 0x88776655
    mov ebx, 0x10203040
    mov ecx, 0x50607080
    push dword 0x8D7             ; CF/PF/AF/ZF/SF/OF, IF clear
    popfd
    call [CONTROL + 16]
    mov [RESULT], eax
    mov [RESULT + 4], edx
    mov [RESULT + 8], ebx
    mov [RESULT + 12], ecx
    pushfd
    pop dword [RESULT + 16]
    dec dword [CONTROL + 20]
    jnz .repeat
    mov eax, ebp
    mov dx, 0x508
    out dx, eax
    inc ebp
    add esi, 24
    cmp ebp, [CONTROL]
    jb .next
    mov dword [CONTROL + 4], 0xD0D0
.halt:
    hlt
    jmp .halt
page_fault:
    mov dword [RESULT + 48], 14
    push eax
    mov eax, [esp + 8]
    mov [RESULT + 28], eax
    mov eax, cr2
    mov [RESULT + 32], eax
    mov eax, [esp + 4]
    mov [RESULT + 36], eax
    inc dword [RESULT + 40]
    mov eax, [esp + 16]
    mov [RESULT + 44], eax
    mov eax, [RECOVERY]
    mov [esp + 8], eax
    pop eax
    add esp, 4
    iretd
invalid_opcode:
    mov dword [RESULT + 48], 6
    push eax
    mov eax, [esp + 4]
    mov [RESULT + 28], eax
    inc dword [RESULT + 40]
    mov eax, [esp + 12]
    mov [RESULT + 44], eax
    mov eax, [RECOVERY]
    mov [esp + 4], eax
    pop eax
    iretd
unexpected:
    mov dword [CONTROL + 8], 1
    cli
    hlt
    jmp unexpected
align 8
gdt:
    dq 0, 0x00CF9A000000FFFF, 0x00CF92000000FFFF
gdtr:
    dw $ - gdt - 1
    dd gdt
idtr:
    dw 256 * 8 - 1
    dd IDT
operations:
    dd op0, after0, op1, after1, op2, after2, op3, after3
    dd op4, after4, op5, after5, op6, after6, op7, after7
    dd op8, after8, op9, after9, op10, after10, op11, after11
    dd op12, after12, op13, after13, op14, after14, op15, after15
    dd op16, after16
align 4096
op0: lock inc word [edi]
after0: ret
align 4096
op1: lock inc dword [edi]
after1: ret
align 4096
op2: xchg ax, [edi]
after2: ret
align 4096
op3: xchg eax, [edi]
after3: ret
align 4096
op4: lock xadd [edi], eax
after4: ret
align 4096
op5: lock cmpxchg [edi], ebx
after5: ret
align 4096
op6: lock cmpxchg [edi], ebx
after6: ret
align 4096
op7: lock cmpxchg8b [edi]
after7: ret
align 4096
op8: lock cmpxchg8b [edi]
after8: ret
align 4096
op9: db 0xF0, 0x01, 0xD8             ; LOCK ADD EAX, EBX (register destination)
after9: ret
align 4096
op10: db 0xF0, 0x89, 0x07            ; LOCK MOV [EDI], EAX
 after10: ret
align 4096
op11: db 0xF0, 0xFF, 0xC0            ; LOCK INC EAX
 after11: ret
align 4096
op12: db 0xF0, 0x0F, 0xC7, 0xC8      ; LOCK CMPXCHG8B register encoding
 after12: ret
align 4096
op13: db 0xF0, 0x83, 0x3F, 1         ; LOCK CMP [EDI], 1
 after13: ret
align 4096
op14: db 0xF0, 0x0F, 0xBA, 0x27, 1   ; LOCK BT [EDI], 1
 after14: ret
align 4096
op15: db 0xF0, 0x03, 0x07            ; LOCK ADD EAX, [EDI] (read-only memory)
 after15: ret
align 4096
op16: db 0xF0, 0x90                  ; LOCK NOP
 after16: ret
end:
