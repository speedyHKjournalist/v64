; Fixed-work throughput kernel for W2 (docs/acpi-x86-64-multicore-plan.zh-CN.md):
; the same total work, split over 1..N cores, cooperative or in vCPU workers.
; The BSP starts the APs with INIT/SIPI; then rounds repeat: every core waits
; until the host raises GO above the rounds done, processes items and adds
; its partial result to SUM, whose final value does not depend on the number
; of cores or on which core took which item. With CHUNK = 0 each core takes
; the static share [core * total / cores, (core + 1) * total / cores);
; otherwise the cores claim CHUNK items at a time from NEXT with LOCK XADD
; (as parallel programs balance load; host cores need not be equally fast).
;
; Workloads (WORKLOAD):
; 1 compute: 64 rounds of multiply/rotate/xor per item
; 2 lock:    a shared counter and record updated under an XCHG spin lock,
;            with 32 rounds of private work outside it
; 3 memory:  copy a 4 KiB block of a 4 MiB buffer (REP MOVSD) to the core's
;            scratch page and sum it
; 4 io:      read the ACPI PM timer and write port 0x80
;
; Host interface at CONTROL: +0 cores, +4 workload, +8 total items, +12 GO,
; +32 CHUNK (input); +16 rounds done, +20 SUM, +24 lock counter, +28 errors
; (output); +36 NEXT (reset by the host before each round).

bits 32
org 0x100000

MB_MAGIC equ 0x1BADB002
MB_FLAGS equ 0x10000
CONTROL equ 0x380000
CORES equ CONTROL + 0
WORKLOAD equ CONTROL + 4
TOTAL equ CONTROL + 8
GO equ CONTROL + 12
DONE equ CONTROL + 16
SUM equ CONTROL + 20
COUNTER equ CONTROL + 24
ERRORS equ CONTROL + 28
CHUNK equ CONTROL + 32
NEXT equ CONTROL + 36
BARRIER_COUNT equ CONTROL + 0x40
BARRIER_SENSE equ CONTROL + 0x80
SPIN equ CONTROL + 0xC0
SHARED_RECORD equ CONTROL + 0x100
RECORDS equ CONTROL + 0x400     ; 64 bytes per core: +0 barrier sense
BUFFER equ 0x1000000            ; 4 MiB, filled once by the BSP
SCRATCH equ 0x1400000           ; 4 KiB per core
PM_TIMER equ 0x608
LAPIC equ 0xFEE00000
STACKS equ 0x300000

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
    mov al, 0xFF
    out 0x21, al
    out 0xA1, al
    ; the PIIX4 PM block at 0x600 (00:07.0: PMBA, then PMREGMISC)
    mov dx, 0xCF8
    mov eax, 0x80000000 | 7 << 11 | 0x40
    out dx, eax
    mov dx, 0xCFC
    mov eax, 0x601
    out dx, eax
    mov dx, 0xCF8
    mov eax, 0x80000000 | 7 << 11 | 0x80
    out dx, eax
    mov dx, 0xCFC
    mov eax, 1
    out dx, eax
    ; the memory workload's buffer: dword k = k * 0x9E3779B1
    mov edi, BUFFER
    xor eax, eax
    mov ecx, 0x100000
.fill:
    mov [edi], eax
    add eax, 0x9E3779B1
    add edi, 4
    loop .fill
    mov esi, trampoline
    mov edi, 0x8000
    mov ecx, trampoline_end - trampoline
    rep movsb
    mov dword [LAPIC + 0xF0], 0x1FF
    mov ebx, 1
.next_ap:
    cmp ebx, [CORES]
    jae .started
    mov ecx, ebx
    shl ecx, 24
    mov [LAPIC + 0x310], ecx
    mov dword [LAPIC + 0x300], 0xC500 ; INIT level assert
    mov dword [LAPIC + 0x300], 0x8500 ; INIT level deassert
    mov dword [LAPIC + 0x300], 0x608  ; SIPI vector 8
    inc ebx
    jmp .next_ap
.started:
    xor ebx, ebx
    jmp all_cores

bits 16
trampoline:
    cli
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

; ebx = core id (= APIC ID); ebp = rounds done
all_cores:
    xor ebp, ebp
.round:
    call barrier
.wait_go:
    cmp [GO], ebp
    ja .go
    pause
    jmp .wait_go
.go:
    push 0                          ; this core's partial result
    cmp dword [CHUNK], 0
    je .static
.claim:
    mov esi, [CHUNK]
    lock xadd [NEXT], esi           ; esi = first item of the claim
    cmp esi, [TOTAL]
    jae .claimed_all
    mov edi, esi
    add edi, [CHUNK]
    cmp edi, [TOTAL]
    jbe .bounded
    mov edi, [TOTAL]
.bounded:
    call dispatch
    add [esp], eax
    jmp .claim
.static:
    ; this core's items [esi, edi)
    mov eax, [TOTAL]
    mul ebx
    div dword [CORES]
    mov esi, eax
    lea eax, [ebx + 1]
    mul dword [TOTAL]
    div dword [CORES]
    mov edi, eax
    call dispatch
    add [esp], eax
.claimed_all:
    pop eax
.finish:
    lock add [SUM], eax
    call barrier
    inc ebp
    test ebx, ebx
    jnz .round
    mov [DONE], ebp
    jmp .round

; items [esi, edi) of WORKLOAD: eax = their partial result
dispatch:
    mov eax, [WORKLOAD]
    cmp eax, 1
    je work_compute
    cmp eax, 2
    je work_lock
    cmp eax, 3
    je work_memory
    cmp eax, 4
    je work_io
    lock inc dword [ERRORS]
    xor eax, eax
    ret

; eax = f(esi) summed over [esi, edi)
work_compute:
    xor edx, edx
.item:
    cmp esi, edi
    jae .done
    mov eax, esi
    mov ecx, 64
.mix:
    imul eax, eax, 0x9E3779B1
    rol eax, 13
    xor eax, ecx
    dec ecx
    jnz .mix
    add edx, eax
    inc esi
    jmp .item
.done:
    mov eax, edx
    ret

; the counter under the lock; eax = the private work's sum
work_lock:
    push ebp
    xor ebp, ebp
.item:
    cmp esi, edi
    jae .done
.acquire:
    mov eax, 1
    xchg [SPIN], eax
    test eax, eax
    jz .locked
    pause
    jmp .acquire
.locked:
    mov eax, [COUNTER]
    inc eax
    mov [COUNTER], eax
    mov [SHARED_RECORD], esi
    mov [SHARED_RECORD + 4], ebx
    mov dword [SPIN], 0
    mov eax, esi
    mov ecx, 32
.mix:
    imul eax, eax, 0x9E3779B1
    rol eax, 13
    xor eax, ecx
    dec ecx
    jnz .mix
    add ebp, eax
    inc esi
    jmp .item
.done:
    mov eax, ebp
    pop ebp
    ret

; eax = sum of the dwords of block (item % 1024), copied to scratch
work_memory:
    push ebp
    xor ebp, ebp
    mov edx, esi
.item:
    cmp edx, edi
    jae .done
    push edi
    mov esi, edx
    and esi, 1023
    shl esi, 12
    add esi, BUFFER
    mov edi, ebx
    shl edi, 12
    add edi, SCRATCH
    mov ecx, 1024
    rep movsd
    sub edi, 4096
    xor eax, eax
    mov ecx, 1024
.sum:
    add eax, [edi]
    add edi, 4
    dec ecx
    jnz .sum
    add ebp, eax
    pop edi
    inc edx
    jmp .item
.done:
    mov eax, ebp
    pop ebp
    ret

; eax = number of PM timer reads that returned a 24-bit value
work_io:
    push ebp
    xor ebp, ebp
.item:
    cmp esi, edi
    jae .done
    mov dx, PM_TIMER
    in eax, dx
    test eax, 0xFF000000
    jnz .bad
    inc ebp
.bad:
    out 0x80, al
    inc esi
    jmp .item
.done:
    mov eax, ebp
    pop ebp
    ret

; sense-reversing barrier over all cores
barrier:
    push eax
    push ecx
    push edi
    mov edi, ebx
    shl edi, 6
    add edi, RECORDS
    mov ecx, [edi]
    xor ecx, 1
    mov [edi], ecx
    mov eax, 1
    lock xadd [BARRIER_COUNT], eax
    inc eax
    cmp eax, [CORES]
    jne .wait
    mov dword [BARRIER_COUNT], 0
    mov [BARRIER_SENSE], ecx
    jmp .done
.wait:
    pause
    cmp [BARRIER_SENSE], ecx
    jne .wait
.done:
    pop edi
    pop ecx
    pop eax
    ret

align 8
gdt:
    dq 0
    dq 0x00CF9A000000FFFF
    dq 0x00CF92000000FFFF
gdt_end:
gdtr:
    dw gdt_end - gdt - 1
    dd gdt
end:
