#!/usr/bin/env node
// high_memory_size: the top of RAM appears at guest physical 4 GiB. A long-mode
// guest maps it with its own page tables, writes and executes there, and the
// host checks the relocated backing bytes and the multiboot memory map.
import assert from "node:assert/strict";
import {assemble, actual} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

const MiB = 1 << 20;
const memory_size = 64 * MiB, high = 16 * MiB, low = memory_size - high;
// PDPT[4] -> PD at 0x203000 mapping [4 GiB, 4 GiB + 16 MiB) with 2 MiB pages,
// at linear 0x100000000 (identity) through the low PML4 entry.
const body = `
mov qword [0x201020], 0x203003
mov rdi, 0x203000
mov rax, 0x100000083
mov ecx, 8
.map:
mov [rdi], rax
add rax, 0x200000
add rdi, 8
loop .map
mov rax, cr3
mov cr3, rax
mov rbx, 0x100000000
mov rax, 0x1122334455667788
mov [rbx], rax
mov [rbx + 0xFFFFF8], rax
not rax
mov [rbx + 0x800000], rax
; copy a tiny function to 4 GiB + 1 MiB and call it there
lea rsi, [rel high_code]
lea rdi, [rbx + 0x100000]
mov ecx, high_code_end - high_code
rep movsb
lea rax, [rbx + 0x100000]
call rax
mov [0x300008], rax
mov rax, [rbx]
mov [0x300010], rax
mov rax, [rbx + 0xFFFFF8]
mov [0x300018], rax
; page tables above 4 GiB: copy PML4/PDPT/PD/PD(4 GiB) to 4 GiB + 2 MiB
mov rsi, 0x200000
mov rdi, 0x100200000
mov ecx, 0x4000 / 8
rep movsq
mov rdi, 0x100200000
mov rax, 0x100201003
mov [rdi], rax
mov [rdi + 0x800], rax
mov rax, 0x100202003
mov [rdi + 0x1000], rax
mov rax, 0x100203003
mov [rdi + 0x1020], rax
mov rax, 0x100200000
mov cr3, rax
; a hot function at 4 GiB + 1 MiB (compiled by a JIT), then patched there
lea rsi, [rel hot_code]
lea rdi, [rbx + 0x100000]
mov ecx, hot_code_end - hot_code
rep movsb
mov r12d, 4000
xor r13, r13
.hot:
mov ecx, 10
lea rax, [rbx + 0x100000]
call rax
add r13, rax
dec r12d
jnz .hot
mov [0x300020], r13
mov dword [rbx + 0x100000 + hot_add - hot_code + 2], 0x22
mov ecx, 10
lea rax, [rbx + 0x100000]
call rax
mov [0x300028], rax
mov rax, cr3
mov [0x300030], rax
mov rax, 0x200000
mov cr3, rax
`;
const data = `
high_code:
lea rax, [rel high_code]
ret
high_code_end:
hot_code:
xor eax, eax
hot_add:
add rax, strict dword 0x11
dec rcx
jnz hot_add
ret
hot_code_end:
`;
// Also request the multiboot memory map (header flag bit 1).
const source = long_mode_guest(body, data).replace("dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)", "dd 0x1BADB002,0x10002,-(0x1BADB002+0x10002)");
assert.ok(source.includes("0x10002"));
const directory = assemble("high-memory", source);
let multiboot_map;
const results = [];
for(const jit of [false, true])
{
let stats;
const result = await actual(directory, {length: 56, options: {memory_size, high_memory_size: high, disable_jit: !jit, ir_sync_publication: true},
    inspect: emulator => {
        const cpu = emulator.v86.cpu;
        const view = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
        const info = 0x7C00, count = view.getUint32(info + 44, true), at = view.getUint32(info + 48, true);
        multiboot_map = [];
        for(let offset = 0; offset < count; offset += 24)
        {
            const entry = at + offset;
            multiboot_map.push([view.getBigUint64(entry + 4, true), view.getBigUint64(entry + 12, true), view.getUint32(entry + 20, true)]);
        }
        // The relocated range is the top of the host backing, not low RAM.
        assert.equal(view.getBigUint64(low, true), 0x1122334455667788n, "4 GiB decodes to the top of the backing store");
        assert.equal(view.getBigUint64(low + 0x800000, true), ~0x1122334455667788n & (1n << 64n) - 1n, "high RAM middle");
        assert.equal(view.getBigUint64(memory_size - 8, true), 0x1122334455667788n, "last relocated qword");
        assert.equal(cpu.low_memory_size, low);
        stats = Array.from({length: 13}, (_, i) => cpu.wm.exports.x64_page_stat(i));
    }});
const u64 = offset => result.readBigUInt64LE(offset);
assert.equal(u64(0) & 0xFFFFFFFFn, 0xC064C064n, "guest completed");
assert.equal(u64(8), 0x100100000n, "code fetched and executed at 4 GiB + 1 MiB");
assert.equal(u64(16), 0x1122334455667788n);
assert.equal(u64(24), 0x1122334455667788n);
assert.equal(u64(32), 4000n * 10n * 0x11n, "hot high-RAM code under page tables above 4 GiB");
assert.equal(u64(40), 10n * 0x22n, "the patched high-RAM code runs");
assert.equal(u64(48), 0x100200000n, "CR3 above 4 GiB");
if(jit)
{
    assert.ok(stats[1] > 30000, `page functions ran the high-RAM code: ${stats}`);
    assert.ok(stats[5] >= 1, `the store through 4 GiB retired the compiled page: ${stats}`);
}
results.push(result);
console.log(`${jit ? "page tier" : "interpreter"}: native ${stats[1]}, compiled ${stats[0]}, invalidated ${stats[5]}`);
}
assert.deepEqual(results[1], results[0], "page tier and interpreter agree");
const available = multiboot_map.filter(entry => entry[2] === 1);
assert.ok(available.every(([base, length]) => base + length <= BigInt(low) || base >= 1n << 32n), "no low RAM entry covers the relocated range");
assert.deepEqual(available.at(-1), [1n << 32n, BigInt(high), 1], "multiboot map reports RAM at 4 GiB");
console.log("X64_HIGH_MEMORY_PASS", JSON.stringify(multiboot_map.map(entry => entry.map(String))));
