BITS 32

    ; jmp target is at page offset 0xFEF: STI as the first instruction of a
    ; block whose interrupt shadow ends near the end of the page. The target
    ; lies beyond the 1920-byte region window, so the region exits there.
    jmp .sti_at_fef

    times 0xFEF - ($ - $$) db 0x90

.sti_at_fef:
    sti
    cli
    hlt
