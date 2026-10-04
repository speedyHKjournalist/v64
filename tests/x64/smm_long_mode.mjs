#!/usr/bin/env node
// An SMI in long mode (src/rust/cpu/smm.rs): the guest sends itself an SMI
// through the local APIC (ICR delivery mode SMI) from 64-bit code. Its
// handler at SMBASE + 0x8000 (the default SMBASE, 0x30000: no firmware runs)
// sends itself another one on its first run, which waits in SMM until RSM;
// it copies QEMU's 64-bit save area (revision 0x20064) out and edits the
// saved RAX and R8 before RSM. Long mode resumes after the APIC write with
// the state the save area held: RAX incremented twice, R8's high half
// replaced, the rest as it was.
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const body = `
; the local APIC: PDPT[3] -> a page directory with its 2 MiB page (uncached)
mov qword [0x201018], 0x203003
mov eax, 0xFEE0009B
mov [0x203000+0x1F7*8], rax
mov rax, cr3
mov cr3, rax
; the SMI handler at SMBASE + 0x8000
lea rsi, [rel smi_handler]
mov edi, 0x38000
mov ecx, smi_handler_end - smi_handler
rep movsb
mov dword [0x500100], 0
mov rax, 0x1111222233334444
mov rbx, 0x0123456789ABCDEF
mov r8, 0x5555666677778888
mov r15, 0x9999AAAABBBBCCCC
mov rbp, rsp
pushfq
pop qword [0x300030]
; an SMI to this core: ICR delivery mode SMI, shorthand self (the APIC
; through a register: a disp32 address is sign extended)
mov edi, 0xFEE00000
mov dword [rdi+0x310], 0
mov dword [rdi+0x300], 0x40200
after_smi:
mov [0x300008], rax
mov [0x300010], rbx
mov [0x300018], r8
mov [0x300020], r15
mov eax, [0x500100]
mov [0x300028], rax
mov [0x300038], rsp
mov [0x300040], rbp
pushfq
pop qword [0x300048]
mov rax, cr0
mov [0x300050], rax
mov rax, cr3
mov [0x300058], rax
mov rax, cr4
mov [0x300060], rax
mov ecx, 0xC0000080
rdmsr
mov [0x300068], eax
mov [0x30006C], edx
lea rax, [rel after_smi]
mov [0x300070], rax
lea rax, [rel gdt]
mov [0x300078], rax
; the save area of the second SMI, as its handler copied it
mov esi, 0x500200
mov edi, 0x300100
mov ecx, 0x200
rep movsb
`;
// (16-bit code, run at 0x3000:0x8000: relative jumps, absolute addresses
// through the 4 GiB segments of SMM)
const data = `
bits 16
smi_handler:
inc dword [dword 0x500100]
cmp dword [dword 0x500100], 1
jne .copy
mov dword [dword 0xFEE00310], 0
mov dword [dword 0xFEE00300], 0x40200
.copy:
mov esi, 0x3FE00
mov edi, 0x500200
mov ecx, 0x80
cld
a32 rep movsd
add dword [dword 0x3FFF8], 1
mov dword [dword 0x3FFBC], 0x11223344
rsm
smi_handler_end:
bits 64
`;
const directory = assemble("smm-long-mode", long_mode_guest(body, data));
let core_state;
const result = await actual(directory, {length: 0x300, timeout: 30000, options: {cpu_type: "x86_64"},
    inspect: emulator => {
        const cpu = emulator.v86.cpu;
        core_state = {smm: !!cpu.smm_active(), pending: !!cpu.apic_core_smi_pending(0)};
    }});
const u64 = offset => result.readBigUInt64LE(offset);
const u32 = offset => result.readUInt32LE(offset);
const u16 = offset => result.readUInt16LE(offset);
// an offset of the save area (from SMBASE + 0x8000) in the copy
const area = offset => 0x100 + offset - 0x7E00;

assert.equal(u64(0), 0xC064C064n, "guest completed");
assert.equal(u64(0x28), 2n, "two SMIs: the second one waited for RSM");
assert.deepEqual(core_state, {smm: false, pending: false});
assert.equal(u64(0x08), 0x1111222233334446n, "RAX: incremented by each handler");
assert.equal(u64(0x10), 0x0123456789ABCDEFn, "RBX");
assert.equal(u64(0x18), 0x1122334477778888n, "R8: the high half the handler wrote");
assert.equal(u64(0x20), 0x9999AAAABBBBCCCCn, "R15");
assert.equal(u64(0x38), u64(0x40), "RSP");
assert.equal(u64(0x48), u64(0x30), "RFLAGS");

assert.equal(u32(area(0x7EFC)), 0x00020064, "revision: SMBASE relocation, 64-bit layout");
assert.equal(u32(area(0x7F00)), 0x30000, "SMBASE");
assert.equal(u64(area(0x7F78)), u64(0x70), "RIP: after the APIC write");
assert.equal(u64(area(0x7FF8)), 0x1111222233334445n, "RAX (the first handler's edit)");
assert.equal(u64(area(0x7FE0)), 0x0123456789ABCDEFn, "RBX");
assert.equal(u64(area(0x7FD8)), u64(0x40), "RSP");
assert.equal(u64(area(0x7FF8 - 8 * 8)), 0x1122334477778888n, "R8");
assert.equal(u64(area(0x7FF8 - 15 * 8)), 0x9999AAAABBBBCCCCn, "R15");
assert.equal(u32(area(0x7F70)), Number(u64(0x30)), "RFLAGS");
assert.equal(u64(area(0x7ED0)), u64(0x68) & 0xFFFFFFFFn, "EFER: LME, LMA, NXE");
assert.equal(u64(area(0x7ED0)), 0xD00n);
assert.equal(u32(area(0x7F58)), Number(u64(0x50) & 0xFFFFFFFFn), "CR0");
assert.equal(u64(area(0x7F50)), 0x200000n, "CR3");
assert.equal(u32(area(0x7F48)), 0x20, "CR4: PAE");
assert.equal(u64(area(0x7F50)), u64(0x58));
assert.equal(u16(area(0x7E10)), 0x18, "CS selector");
assert.equal(u16(area(0x7E12)) & ~1, 0xA09A, "CS attributes: code, L, G");
assert.equal(u32(area(0x7E14)), 0xFFFFFFFF, "CS limit");
assert.equal(u64(area(0x7E18)), 0n, "CS base");
assert.equal(u16(area(0x7E20)), 0x10, "SS selector");
assert.equal(u16(area(0x7E22)) & ~1, 0xC092, "SS attributes: data, B, G");
assert.equal(u16(area(0x7E30)), 0x10, "DS selector");
assert.equal(u32(area(0x7E64)), 31, "GDTR limit");
assert.equal(u64(area(0x7E68)), u64(0x78) & 0xFFFFFFFFn, "GDTR base");
assert.equal(u16(area(0x7E92)) & 0x8F, 0x8B, "TR: a busy 64-bit TSS");
console.log("X64_SMM_LONG_MODE_PASS");
