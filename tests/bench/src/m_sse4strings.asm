; SSE4.2 PCMPISTRI over NUL-terminated strings: strlen in 16-byte chunks
; (equal each against the empty string: the index of the NUL) and the first
; vowel (equal any), with unaligned operands.
%include "micro.inc"
_bench_main:
    push esi
    push edi
    push ebx
    mov ebx, [esp + 16]
    shl ebx, 4
    xor edi, edi
    pxor xmm0, xmm0
    movdqa xmm1, [vowels]
.loop:
    mov esi, strings
.next:
    mov eax, esi
.length:
    pcmpistri xmm0, [eax], 0x08
    lea eax, [eax + 16]
    jnz .length
    lea eax, [eax + ecx - 16]
    sub eax, esi
    add edi, eax
    pcmpistri xmm1, [esi], 0x00
    add edi, ecx
    lea esi, [esi + eax + 1]
    cmp byte [esi], 0
    jnz .next
    dec ebx
    jnz .loop
    mov eax, edi
    pop ebx
    pop edi
    pop esi
    ret
section .data
align 16
vowels: db "aeiou", 0
    times 10 db 0
strings:
    db "the quick brown fox jumps over the lazy dog", 0
    db "pack my box with five dozen liquor jugs", 0
    db "sphinx of black quartz, judge my vow", 0
    db "x", 0
    db "how vexingly quick daft zebras jump", 0
    db "rhythm", 0
    db "a much longer string that spans several sixteen byte chunks before its end", 0
    db "bright vixens jump; dozy fowl quack", 0
    db 0
    times 32 db 0
