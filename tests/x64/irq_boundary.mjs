#!/usr/bin/env node
// External interrupts raised by a device callback inside a long-mode
// instruction are delivered at the next instruction boundary: the handler
// runs once, sees the following RIP, and IRETQ restores the original stack.
// Expected values follow the SDM interrupt-delivery rules (Vol.3A §6.6).
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const body = `
lidt [rel idtr]
lea rax, [rel irq1]
mov word [rel idt+0x21*16], ax
mov word [rel idt+0x21*16+2], 0x18
mov word [rel idt+0x21*16+4], 0x8E00
shr rax, 16
mov word [rel idt+0x21*16+6], ax
shr rax, 16
mov dword [rel idt+0x21*16+8], eax
; ICW1-4: master PIC at vector 0x20, slave at 0x28, 8086 mode.
mov al, 0x11
out 0x20, al
out 0xA0, al
mov al, 0x20
out 0x21, al
mov al, 0x28
out 0xA1, al
mov al, 4
out 0x21, al
mov al, 2
out 0xA1, al
mov al, 1
out 0x21, al
out 0xA1, al
mov al, 0xFF
out 0xA1, al
mov al, 0xFD
out 0x21, al
mov rbp, rsp
sti
; Case 1: the 8042 raises IRQ1 while executing this OUT.
mov al, 0x20
out 0x64, al
after_device_out:
nop
nop
mov [0x300008], rbp
mov [0x300010], rsp
pushfq
pop qword [0x300018]
; Case 2: IRQ1 becomes pending while masked; unmasking it in OUT delivers it.
cli
mov al, 0xFF
out 0x21, al
mov al, 0x20
out 0x64, al
sti
mov al, 0xFD
out 0x21, al
after_unmask_out:
nop
mov [0x300020], rsp
cli
`;
const data = `
irq1:
mov rax, [rsp]
mov rcx, [rel count]
mov [0x300040+rcx*8], rax
inc qword [rel count]
in al, 0x60
mov al, 0x20
out 0x20, al
iretq
align 8
count: dq 0
idtr: dw 0x22*16-1
dq HIGH+idt
align 16
idt: times 0x22*16 db 0
`;
const source = long_mode_guest(body, data);
const directory = assemble("irq-boundary", source);
const result = await actual(directory, {length: 0x60, timeout: 20000});
const u64 = offset => result.readBigUInt64LE(offset);
function label_address(name)
{
    // Assemble a copy that appends the label's link address.
    const probe = source.replace("image_end:\n", `image_end:\ndq ${name}\n`);
    fs.writeFileSync(directory + "probe.asm", probe);
    const out = spawnSync("nasm", ["-f", "bin", "-o", directory + "probe.bin", directory + "probe.asm"], {encoding: "utf8"});
    assert.equal(out.status, 0, out.stderr);
    const bytes = fs.readFileSync(directory + "probe.bin");
    return 0xFFFF800000000000n + bytes.readBigUInt64LE(bytes.length - 8);
}
assert.equal(u64(0), 0xC064C064n, "guest completed");
assert.equal(u64(0x08), u64(0x10), "IRETQ restored RSP after device-raised IRQ");
assert.notEqual(u64(0x18) & 0x200n, 0n, "IF restored");
assert.equal(u64(0x20), u64(0x08), "IRETQ restored RSP after unmask-delivered IRQ");
assert.equal(u64(0x40), label_address("after_device_out"), "return RIP follows the device OUT");
assert.equal(u64(0x48), label_address("after_unmask_out"), "return RIP follows the unmasking OUT");
assert.equal(u64(0x50), 0n, "exactly two deliveries");
console.log("X64_IRQ_BOUNDARY_PASS");
