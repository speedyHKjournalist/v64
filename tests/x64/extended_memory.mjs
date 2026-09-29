#!/usr/bin/env node
// X6 (docs/acpi-x86-64-multicore-plan.zh-CN.md): guest RAM beyond the wasm32
// backing store. 64 MiB of RAM, 16 MiB of it relocated to 4 GiB, and
// EXTENDED_GIB (default 6) GiB of extended RAM after it, cached in a pool of
// only 4 MiB of frames, so that nearly every access pages. A long-mode guest
// writes and checks samples across all of it and dense patterns in part of
// it, copies with string instructions, runs code there, runs with its page
// tables there (their accessed/dirty bits too), runs 32-bit compatibility-
// mode code there (the 32-bit bus aperture) and reads a block the host wrote
// by DMA. The host checks the bytes, then a snapshot stream restores them
// into a second machine. Interpreter and page tier must agree; the page
// tier's access caches must release their frames (X64_CORES=2 runs the
// machine through the multi-core slice loop, whose safe points do that too).
import assert from "node:assert/strict";
import { assemble, actual } from "./guest_runner.mjs";
import { long_mode_guest } from "./guest_builder.mjs";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const MiB = 1 << 20, GiB = 2 ** 30;
const memory_size = 64 * MiB, high = 16 * MiB;
const EXTENDED = (+process.env.EXTENDED_GIB || 6) * GiB;
const EXT = 4 * GiB + high;                  // first extended byte
const KEY = 0x5A5A5A5A12345678n;
const DENSE = EXT + GiB, DENSE_BYTES = 32 * MiB;
const DMA = EXT + 2 * GiB + MiB + 0x4000;   // (between the 64 KiB samples)
assert.ok(EXTENDED >= 6 * GiB, "the fixture's addresses need at least 6 GiB");

const hex = n => "0x" + n.toString(16);
// Identity map [4 GiB, 12 GiB) with 2 MiB pages: PDs at 0x210000.., PDPT[4..11];
// linear 1 GiB (PDPT[1], PD at 0x218000) -> EXT + 2 GiB for compatibility mode.
const body = `
mov rdi, 0x210000
mov rax, 0x100000083
mov ecx, 8 * 512
.map:
mov [rdi], rax
add rax, 0x200000
add rdi, 8
dec ecx
jnz .map
mov rdi, 0x201020
mov rax, 0x210003
mov ecx, 8
.pdpt:
mov [rdi], rax
add rax, 0x1000
add rdi, 8
loop .pdpt
mov rax, ${hex(EXT + 2 * GiB)} | 0x83
mov [0x218000], rax
mov qword [0x201008], 0x218003
mov rax, cr3
mov cr3, rax

; 1. a qword every 64 KiB of extended RAM, then check them all
mov rbx, ${hex(EXT)}
mov r8, ${hex(EXTENDED)}
mov r9, ${hex(KEY)}
xor rcx, rcx
.sample_write:
lea rdi, [rbx + rcx]
mov rax, rdi
xor rax, r9
mov [rdi], rax
add rcx, 0x10000
cmp rcx, r8
jb .sample_write
xor rcx, rcx
xor r10, r10
.sample_check:
lea rdi, [rbx + rcx]
mov rax, rdi
xor rax, r9
cmp [rdi], rax
je .sample_ok
inc r10
.sample_ok:
add rcx, 0x10000
cmp rcx, r8
jb .sample_check
mov [0x300008], r10

; 2. dense: 32 MiB of qwords i * K, checked; then 1 MiB copied inside
;    extended RAM and 8 KiB out of it with REP MOVSQ
mov rdi, ${hex(DENSE)}
mov ecx, ${DENSE_BYTES / 8}
xor rdx, rdx
mov r11, 0x9E3779B97F4A7C15
.dense_write:
mov [rdi], rdx
add rdx, r11
add rdi, 8
dec ecx
jnz .dense_write
mov rdi, ${hex(DENSE)}
mov ecx, ${DENSE_BYTES / 8}
xor rdx, rdx
xor r10, r10
.dense_check:
cmp [rdi], rdx
je .dense_ok
inc r10
.dense_ok:
add rdx, r11
add rdi, 8
dec ecx
jnz .dense_check
mov [0x300010], r10
mov rsi, ${hex(DENSE)}
mov rdi, ${hex(DENSE + DENSE_BYTES)}
mov ecx, ${MiB / 8}
rep movsq
mov rsi, ${hex(DENSE + 8 * MiB)}
mov rdi, 0x380000
mov ecx, 8192 / 8
rep movsq

; 3. code in extended RAM
lea rsi, [rel ext_code]
mov rdi, ${hex(EXT + 3 * GiB + 0x123000)}
mov ecx, ext_code_end - ext_code
rep movsb
mov rax, ${hex(EXT + 3 * GiB + 0x123000)}
call rax
mov [0x300018], rax

; 4. page tables in extended RAM: copy PML4, PDPT, the low PD and the 8
;    PDs, point them at each other there, and touch a fresh page through them
mov rbp, ${hex(EXT + 4 * GiB)}
mov rsi, 0x200000
mov rdi, rbp
mov ecx, 0x3000 / 8
rep movsq
mov rsi, 0x210000
lea rdi, [rbp + 0x10000]
mov ecx, 0x9000 / 8
rep movsq
lea rax, [rbp + 0x1003]
mov [rbp], rax
mov [rbp + 0x800], rax
lea rax, [rbp + 0x2003]
mov [rbp + 0x1000], rax
lea rax, [rbp + 0x18003]
mov [rbp + 0x1008], rax
lea rax, [rbp + 0x10003]
lea rdi, [rbp + 0x1020]
mov ecx, 8
.remap:
mov [rdi], rax
add rax, 0x1000
add rdi, 8
loop .remap
mov cr3, rbp
; linear EXT + 5 GiB through the copies; then its PD entry there
mov rdi, ${hex(EXT + 5 * GiB)}
mov rax, 0x0123456789ABCDEF
mov [rdi], rax
mov rax, [rdi]
mov [0x300020], rax
mov rax, [rbp + 0x10000 + ${((EXT + 5 * GiB - 4 * GiB) / (2 * MiB)) * 8}]
mov [0x300028], rax
mov rax, cr3
mov [0x300030], rax
mov rax, 0x200000
mov cr3, rax

; 5. compatibility mode: 32-bit code at linear 1 GiB, which is extended RAM
lea rsi, [rel compat_code]
mov rdi, 0x40000000
mov ecx, compat_code_end - compat_code
rep movsb
sub rsp, 8
mov dword [rsp], compat_return
mov dword [rsp + 4], 24
push 8
push 0x40000000
retfq
compat_return:
mov rax, HIGH + compat_back
jmp rax
compat_back:

; 6. the block the host wrote by DMA: sum of its qwords
mov rsi, ${hex(DMA)}
mov ecx, 4096 / 8
xor rax, rax
.dma_sum:
add rax, [rsi]
add rsi, 8
loop .dma_sum
mov [0x300048], rax
; and a block for the host to read
mov rdi, ${hex(DMA + 4096)}
mov ecx, 4096 / 8
mov rax, 0x1111111111111111
.dma_fill:
mov [rdi], rax
mov rdx, 0x0101010101010101
add rax, rdx
add rdi, 8
loop .dma_fill
`;
const data = `
ext_code:
lea rax, [rel ext_code]
add rax, 7
ret
ext_code_end:
bits 32
compat_code:
mov dword [0x40180000], 0x11111111
add dword [0x40180000], 0x22222222
mov dword [0x40180004], 0
lock add dword [0x40180004], 5
mov esi, 0x40180000
mov edi, 0x40180100
mov ecx, 16
rep movsd
mov eax, [0x40180100]
mov [0x300040], eax
mov eax, [0x40180004]
mov [0x300044], eax
retf
compat_code_end:
bits 64
`;
const source = long_mode_guest(body, data);
const directory = assemble("extended-memory", source);

const dma_block = new Uint8Array(4096);
for(let i = 0; i < dma_block.length; i++) dma_block[i] = i * 7 + 3;
const dma_sum = (() => {
    let sum = 0n;
    const view = new DataView(dma_block.buffer);
    for(let i = 0; i < 4096; i += 8) sum += view.getBigUint64(i, true);
    return sum & (1n << 64n) - 1n;
})();
const options = { memory_size, high_memory_size: high, extended_memory_size: EXTENDED, extended_memory_cache: 4 * MiB };
const u64_at = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(offset, true);
const dense_expected = i => BigInt.asUintN(64, BigInt(i) * 0x9E3779B97F4A7C15n);

function check_host_view(cpu, label)
{
    for(const offset of [0, 0x10000, 1.5 * GiB, 5 * GiB - 0x10000, EXTENDED - 0x10000])
    {
        const address = EXT + offset;
        assert.equal(u64_at(cpu.read_blob_physical(address, 8), 0), BigInt(address) ^ KEY, `${label}: sample at ${hex(address)}`);
    }
    const dense = cpu.read_blob_physical(DENSE + 3 * MiB, 64 * 1024);
    for(let i = 0; i < dense.length; i += 8)
    {
        assert.equal(u64_at(dense, i), dense_expected((3 * MiB + i) / 8), `${label}: dense qword ${i}`);
    }
    const copied = cpu.read_blob_physical(DENSE + DENSE_BYTES, 4096);
    assert.deepEqual(copied, cpu.read_blob_physical(DENSE, 4096), `${label}: REP MOVSQ inside extended RAM`);
    const filled = cpu.read_blob_physical(DMA + 4096, 4096);
    assert.equal(u64_at(filled, 8), 0x1212121212121212n, `${label}: guest block read by the host`);
}

const results = [];
let snapshot = null;
for(const jit of [false, true])
{
    let stats;
    const result = await actual(directory, {
        length: 0x50, timeout: 600000,
        options: { ...options, disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: true },
        setup: emulator => { emulator.v86.cpu.write_blob_physical(dma_block, DMA); },
        inspect: async emulator => {
            const cpu = emulator.v86.cpu;
            check_host_view(cpu, jit ? "page tier" : "interpreter");
            const low = cpu.mem8.subarray(0x380000, 0x380000 + 8192);
            for(let i = 0; i < 8192; i += 8) assert.equal(u64_at(low, i), dense_expected((8 * MiB + i) / 8), "REP MOVSQ out of extended RAM");
            stats = Array.from({ length: 14 }, (_, i) => cpu.wm.exports.x64_ext_stat(i));
            if(jit)
            {
                const chunks = [];
                await emulator.save_state_stream(chunk => { chunks.push(chunk.slice()); });
                const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
                snapshot = new Uint8Array(total);
                let at = 0;
                for(const chunk of chunks) { snapshot.set(chunk, at); at += chunk.length; }
            }
        },
    });
    const u64 = offset => result.readBigUInt64LE(offset);
    assert.equal(u64(0) & 0xFFFFFFFFn, 0xC064C064n, "guest completed");
    assert.equal(u64(8), 0n, "samples across extended RAM");
    assert.equal(u64(16), 0n, "dense patterns under eviction");
    assert.equal(u64(24), BigInt(EXT + 3 * GiB + 0x123000 + 7), "code fetched and executed in extended RAM");
    assert.equal(u64(32), 0x0123456789ABCDEFn, "access through page tables in extended RAM");
    assert.equal(u64(40) & 0x60n, 0x60n, "accessed and dirty set in the extended PD entry");
    assert.equal(u64(48), BigInt(EXT + 4 * GiB), "CR3 in extended RAM");
    assert.equal(result.readUInt32LE(0x40), 0x33333333, "compatibility-mode code in extended RAM");
    assert.equal(result.readUInt32LE(0x44), 5, "LOCK ADD in compatibility mode");
    assert.equal(u64(0x48), dma_sum, "the host's DMA block");
    assert.ok(stats[3] > 10000, "the frame pool was reused: " + stats);
    // (frames held by access caches are released at safe points, so that
    // eviction goes on and almost no access needs the bounce frame)
    if(jit) assert.ok(stats[8] > 0, "cached frames released: " + stats);
    assert.ok(stats[9] < stats[1] / 10, "bounce accesses are rare: " + stats);
    results.push(result);
    console.log(`${jit ? "page tier" : "interpreter"}: extended RAM ${EXTENDED / GiB} GiB, frames ${stats[7]}; ` +
        `hits ${stats[0]}, loads ${stats[1]}, write-backs ${stats[2]}, evictions ${stats[3]}, aperture ${stats[4]}, ` +
        `releases ${stats[8]}, bounces ${stats[9]}`);
}
assert.deepEqual(results[1], results[0], "page tier and interpreter agree");

// the snapshot stream carries extended RAM into another machine
{
    const emulator = new V86({ multiboot: { url: directory + "guest.bin" }, acpi: true, autostart: false, log_level: 0,
        cpu_cores: Number(process.env.X64_CORES || 1), ...options });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    await emulator.restore_state_stream({ size: snapshot.length, read: async (offset, length) => snapshot.subarray(offset, offset + length) });
    check_host_view(emulator.v86.cpu, "restored");
    await emulator.destroy();
    console.log(`snapshot stream: ${(snapshot.length / MiB).toFixed(1)} MiB restored into another machine`);
}
console.log("X64_EXTENDED_MEMORY_PASS");
