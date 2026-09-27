; Benchmark entry. Parameter block: [0x600] iterations (in), [0x604] checksum
; (out), [0x608] status (0 running, 1 done, 0x80000000|vector on exception),
; [0x60C] faulting EIP. Interrupts stay disabled.
bits 32
global _start
global ___chkstk_ms
extern _bench_main
section .text
_start:
    mov esp, 0x3F0000
    push dword [0x600]
    call _bench_main
    add esp, 4
    mov [0x604], eax
    mov dword [0x608], 1
    hlt
    jmp $
; MinGW probes stack frames above 4 KiB; the benchmark stack is fully mapped.
___chkstk_ms:
    ret
