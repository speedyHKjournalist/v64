; ELF32 Linux process: bind to argv[1] (CPU 0..7), verify getcpu before and
; after real arithmetic progress, then report one bounded completion record.
; No libc, compiler, scheduler affinity utility or guest build tools needed.
; nasm -f bin tests/smp/affinity_probe.asm -o build/smp/affinity_probe
bits 32
org 0x08048000

elf_header:
    db 0x7F, "ELF", 1, 1, 1, 0
    times 8 db 0
    dw 2, 3
    dd 1, start, program_header - $$, 0, 0
    dw 52, 32, 1, 0, 0, 0
program_header:
    dd 1, 0, $$, $$, file_end - $$, file_end - $$, 7, 0x1000

start:
    cmp dword [esp], 2
    jne failure
    mov eax, [esp + 8]
    cmp byte [eax + 1], 0
    jne failure
    movzx ecx, byte [eax]
    sub ecx, '0'
    cmp ecx, 7
    ja failure
    mov [requested_cpu], ecx
    mov eax, 1
    shl eax, cl
    mov [cpu_mask], eax
    add cl, '0'
    mov [id_digit], cl
    mov [cpu_digit], cl

    mov eax, 241                    ; sched_setaffinity(0, 4, &mask)
    xor ebx, ebx
    mov ecx, 4
    mov edx, cpu_mask
    int 0x80
    test eax, eax
    js failure
    call check_cpu

    xor eax, eax
    mov ecx, 100000
.progress:
    add eax, ecx
    dec ecx
    jnz .progress
    cmp eax, (100000 * 100001 / 2) & 0xFFFFFFFF
    jne failure
    call check_cpu

    mov ecx, message
    mov edx, message_end - message
    call write_stdout
    xor ebx, ebx
    jmp exit

check_cpu:
    mov eax, 318                    ; getcpu(&actual_cpu, NULL, NULL)
    mov ebx, actual_cpu
    xor ecx, ecx
    xor edx, edx
    int 0x80
    test eax, eax
    js failure
    mov eax, [actual_cpu]
    cmp eax, [requested_cpu]
    jne failure
    ret

failure:
    mov ecx, error_message
    mov edx, error_end - error_message
    call write_stdout
    mov ebx, 1
exit:
    mov eax, 1                      ; exit(status)
    int 0x80
    ud2
write_stdout:
    mov eax, 4                      ; write(1, message, length)
    mov ebx, 1
    int 0x80
    ret

align 4
requested_cpu: dd 0
actual_cpu: dd 0
cpu_mask: dd 0
message: db "C2_PROGRESS id="
id_digit: db "0"
    db " cpu="
cpu_digit: db "0"
    db " iterations=100000", 10
message_end:
error_message: db "C2_AFFINITY_FAIL", 10
error_end:
file_end:
