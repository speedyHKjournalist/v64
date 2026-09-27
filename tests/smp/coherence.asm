; Cooperative SMP coherence gate. The harness starts independent protected-
; mode contexts; INIT/SIPI itself is covered by ap_startup.asm. All sharing,
; atomics, code modification, page-table changes and shootdown IPIs below are
; guest instructions. EDI = core ID, CONTROL = {cores, iterations}.
bits 32
org 0x100000
%define CONTROL 0x380000
%define TOTAL CONTROL + 8
%define GUARDED CONTROL + 12
%define LOCKWORD CONTROL + 16
%define FINISHED CONTROL + 20
%define PHASE CONTROL + 24
%define SHOOT CONTROL + 28
%define OLD_SEEN CONTROL + 32
%define NEW_SEEN CONTROL + 36
%define SMC_SEEN CONTROL + 40
%define ERROR CONTROL + 44
%define RECORDS CONTROL + 0x100
%define UNALIGNED 0x390FFF
%define CMP64 0x391FFD
%define IDT 0x280000
%define PD 0x200000
%define VIRTUAL 0x40000000
%define ALIAS 0x50000000
%define LAPIC 0xFEE00000

header:
    dd 0x1BADB002, 0x10000, -(0x1BADB002 + 0x10000)
    dd header, header, end, end, start

start:
    cli
    cld
    mov esi, edi
    lgdt [gdtr]
    jmp 8:protected
protected:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    lea esp, [esi + 1]
    shl esp, 16
    add esp, 0x300000
    mov al, 0xFF
    out 0x21, al
    out 0xA1, al

    mov ebp, esi
    shl ebp, 12
    add ebp, PD
    mov edi, ebp
    mov ecx, 1024
    xor eax, eax
    rep stosd
    mov dword [ebp], 0x83
    mov dword [ebp + (VIRTUAL >> 22) * 4], 0x400083
    mov dword [ebp + (LAPIC >> 22) * 4], 0xFEC00083
    cmp esi, 1
    jne .no_alias
    mov eax, hot_function
    or eax, 3
    mov [0x220000], eax
    mov dword [ebp + (ALIAS >> 22) * 4], 0x220003
.no_alias:
    mov cr3, ebp
    mov eax, cr4
    or eax, 1 << 4
    mov cr4, eax
    mov eax, cr0
    or eax, 1 << 31
    mov cr0, eax
    mov dword [LAPIC + 0xF0], 0x1FF
    mov dword [LAPIC + 0x350], 0x10000
    cmp esi, 1
    jne .alias_warmed
    mov eax, [ALIAS]                ; cache alias before core 0 compiles it
.alias_warmed:

    mov ebp, esi
    shl ebp, 6
    add ebp, RECORDS
    mov edi, [CONTROL + 4]
.atomic:
    mov eax, 1
    lock xadd [TOTAL], eax
    add [ebp + 4], eax              ; sum all returned tickets in host
    lock inc dword [UNALIGNED]      ; crosses a 4 KiB page boundary
.acquire:
    mov eax, 1
    xchg eax, [LOCKWORD]            ; implicit LOCK
    test eax, eax
    jnz .acquire
    inc dword [GUARDED]
    mov dword [LOCKWORD], 0
.retry64:
    mov eax, [CMP64]
    mov edx, [CMP64 + 4]
    mov ebx, eax
    mov ecx, edx
    add ebx, 1
    adc ecx, 0
    lock cmpxchg8b [CMP64]           ; unaligned and spans two pages
    jnz .retry64
    dec edi
    jnz .atomic
    lock inc dword [FINISHED]
.barrier:
    mov eax, [FINISHED]
    cmp eax, [CONTROL]
    jne .barrier                   ; shared load must observe another core
    cmp esi, 0
    je primary
    cmp esi, 1
    je modifier
.other:
    cmp dword [PHASE], 6
    jne .other
    jmp done

primary:
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
    mov eax, shootdown
    mov word [IDT + 0x70 * 8], ax
    shr eax, 16
    mov word [IDT + 0x70 * 8 + 6], ax
    lidt [idtr]
    mov ecx, 8192
.warm:
    call hot_function
    dec ecx
    jnz .warm
.wait_compiled:
    call hot_function
    cmp dword [CONTROL + 52], 0
    je .wait_compiled
    mov dword [PHASE], 1
.wait_smc:
    cmp dword [PHASE], 2
    jne .wait_smc
    xor eax, eax
    cpuid                          ; architecturally serialize modified code
    call hot_function
    mov [SMC_SEEN], eax
    mov eax, [VIRTUAL]             ; populate this core's translation
    mov dword [PHASE], 3
.wait_remap:
    cmp dword [PHASE], 4
    jne .wait_remap
    mov eax, [VIRTUAL]             ; must still use OLD translation
    mov [OLD_SEEN], eax
    mov dword [PHASE], 5
    sti
.wait_shoot:
    cmp dword [SHOOT], 0
    je .wait_shoot
    cli
    mov eax, [VIRTUAL]             ; now INVLPG made the new PDE visible
    mov [NEW_SEEN], eax
    mov dword [PHASE], 6
    jmp done

modifier:
.wait_hot:
    cmp dword [PHASE], 1
    jne .wait_hot
    cmp dword [CONTROL + 48], 0
    jne .dma_wrote
    mov dword [ALIAS + 1], 0x22222222
.dma_wrote:
    mov dword [PHASE], 2
.wait_tlb:
    cmp dword [PHASE], 3
    jne .wait_tlb
    mov dword [PD + (VIRTUAL >> 22) * 4], 0x800083
    mov dword [PHASE], 4
.wait_stale:
    cmp dword [PHASE], 5
    jne .wait_stale
    mov dword [LAPIC + 0x310], 0
    mov dword [LAPIC + 0x300], 0x70
.wait_done:
    cmp dword [PHASE], 6
    jne .wait_done

done:
    lea eax, [esi + 0xD0D0]
    mov [ebp], eax
.halt:
    hlt
    jmp .halt

shootdown:
%ifndef SKIP_SHOOTDOWN
    invlpg [VIRTUAL]
%endif
    inc dword [SHOOT]
    mov dword [LAPIC + 0xB0], 0
    iretd
unexpected:
    mov dword [ERROR], 1
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

; Use a distinct executable physical page to detect stale code after a write
; by a core whose local TLB has never executed or marked that page as code.
align 4096
hot_function:
    mov eax, 0x11111111
    ret
end:
