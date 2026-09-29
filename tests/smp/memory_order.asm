; Single-producer/single-consumer ring queues. Queue slots carry a sequence and
; its complement, published with an ordinary store to HEAD. This deliberately
; uses no LOCK instructions, fences or PAUSE on the normal data path: x86
; store/store and load/load order and fresh loads across slices are sufficient.
bits 32
org 0x100000
%define CONTROL 0x380000
%define QUEUES 0x390000
%define RECORDS 0x381000
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
    mov ebp, esi
    shr ebp, 1
    shl ebp, 12
    add ebp, QUEUES
    mov edi, 1
    xor ebx, ebx
    test esi, 1
    jz consumer
producer:
    mov eax, [ebp]                 ; producer-owned HEAD
    mov ecx, eax
    sub ecx, [ebp + 64]            ; acquire latest consumer TAIL
    cmp ecx, 16
    je producer
    mov edx, eax
    and edx, 15
    shl edx, 3
%ifdef PUBLISH_EARLY
    inc eax
    mov [ebp], eax
    pause                         ; force observer between bad publish/payload
%endif
    mov [ebp + edx + 128], edi
    mov ecx, edi
    not ecx
    mov [ebp + edx + 132], ecx
%ifndef PUBLISH_EARLY
    inc eax
    mov [ebp], eax                 ; release payload with ordinary x86 store
%endif
    inc edi
    cmp edi, [CONTROL]
    jbe producer
    jmp done
consumer:
    mov eax, [ebp + 64]
    cmp eax, [ebp]                 ; acquire published HEAD, no cached load
    je consumer
    mov edx, eax
    and edx, 15
    shl edx, 3
    cmp [ebp + edx + 128], edi
    jne failed
    mov ecx, edi
    not ecx
    cmp [ebp + edx + 132], ecx
    jne failed
    add ebx, edi
    inc eax
    mov [ebp + 64], eax            ; release slot only after both payload reads
    inc edi
    cmp edi, [CONTROL]
    jbe consumer
done:
    mov edx, esi
    shl edx, 6
    mov [RECORDS + edx + 4], ebx
    mov [RECORDS + edx + 8], edi
    lea eax, [esi + 0xD0D0]
    mov [RECORDS + edx], eax
.halt:
    hlt
    jmp .halt
failed:
    mov [CONTROL + 4], edi
    lea eax, [esi + 1]
    mov [CONTROL + 8], eax
    jmp done
align 8
gdt:
    dq 0, 0x00CF9A000000FFFF, 0x00CF92000000FFFF
gdtr:
    dw $ - gdt - 1
    dd gdt
end:
