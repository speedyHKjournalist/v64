#!/usr/bin/env node
// Execution-level long-mode opcode matrix (X3). Every row of the opcode-map
// corpus (x64::decode::tests::opcode_map_corpus, expectations written by
// tests/x64/oracle from iced-x86 gated by the advertised CPUID profile) runs
// once at CPL3 in a sandbox: code slots are user read-only pages, data and
// stack are user no-execute pages, the harness and everything else is
// supervisor-only or not present, the FPU/MXCSR state is reset per case, and
// every exception vector, SYSCALL and SYSENTER lands in the harness, which
// records the outcome. Each slot is the instruction followed by INT3, so a
// completed instruction reports its executed length.
//
// Checks: an encoding is #UD in v86 exactly when iced-x86 + the profile say
// it is invalid, and a completed instruction consumed iced-x86's length.
// OPCODE_MATRIX_LIMIT=n runs the first n rows; X64_JIT=1 runs with the page
// tier (each case executes once, so this mostly exercises the interpreter).
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {setImmediate as yield_event} from "node:timers/promises";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = root + "build/x64-opcode-matrix/";
fs.mkdirSync(directory, {recursive: true});
const expected_path = root + "build/x64-decode/expected.json";
assert.ok(fs.existsSync(expected_path), "run `make x64-decode-tests` first (writes build/x64-decode/expected.json)");
let rows = JSON.parse(fs.readFileSync(expected_path, "utf8"));
if(process.env.OPCODE_MATRIX_LIMIT) rows = rows.slice(0, +process.env.OPCODE_MATRIX_LIMIT);

const SLOTS = 0x800000, SLOT = 32, RESULTS = 0x2000000, RECORD = 16, DATA = 0x600000, USER_STACK = 0x7F0000;
const MAGIC = 0xC064C064, STATUS = 0x480000;
assert.ok(rows.length * SLOT <= 0x1800000 - SLOTS && rows.length * RECORD <= 0x1000000);
const error_code = new Set([8, 10, 11, 12, 13, 14, 17, 21, 29, 30]);
const stubs = Array.from({length: 32}, (_, v) => `stub_${v}:\n${error_code.has(v) ? "" : "push 0\n"}push ${v}\njmp record_fault`).join("\n");
const gates = Array.from({length: 32}, (_, v) => `lea rax,[rel stub_${v}]\nmov edi,${v}\ncall set_gate`).join("\n");
const source = `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
cli
cld
lgdt [gdtr32]
jmp 8:protected
protected:
mov ax,16
mov ds,ax
mov es,ax
mov ss,ax
mov esp,0x5F0000
; 2 MiB pages: 0-8 MiB supervisor (harness, tables, stacks), data/stack
; user RW NX, code slots user RO, results supervisor, the rest absent
mov dword [0x200000],0x201007
mov dword [0x201000],0x202007
mov dword [0x202000+0*8],0x000083
mov dword [0x202000+1*8],0x200083
mov dword [0x202000+2*8],0x400083
mov dword [0x202000+3*8],0x600087
mov dword [0x202000+3*8+4],0x80000000
mov edi,0x202000+4*8
mov eax,0x800085
mov ecx,8
.code:
mov [edi],eax
add eax,0x200000
add edi,8
loop .code
mov edi,0x202000+16*8
mov eax,0x2000083
mov ecx,8
.results:
mov [edi],eax
mov dword [edi+4],0x80000000
add eax,0x200000
add edi,8
loop .results
mov eax,cr4
or eax,0x620
mov cr4,eax
mov eax,0x200000
mov cr3,eax
mov ecx,0xC0000080
mov eax,0x901
xor edx,edx
wrmsr
mov eax,cr0
or eax,0x80010033
and eax,~0x0C
mov cr0,eax
jmp 24:long_mode
bits 64
long_mode:
lgdt [rel gdtr64]
lidt [rel idtr64]
lea rax,[rel tss]
mov word [rel gdt+58],ax
shr rax,16
mov byte [rel gdt+60],al
mov byte [rel gdt+63],ah
shr rax,16
mov dword [rel gdt+64],eax
mov qword [rel tss+4],0x5F0000
; I/O map base beyond the TSS limit: CPL3 port I/O faults
mov word [rel tss+102],104
mov ax,0x38
ltr ax
mov al,0xFF
out 0x21,al
out 0xA1,al
${gates}
; INT3 closes every slot and must be usable from CPL3
mov byte [rel idt+3*16+5],0xEE
mov ecx,0xC0000081
xor eax,eax
mov edx,0x00230018
wrmsr
mov ecx,0xC0000082
lea rax,[rel syscall_landing]
mov rdx,rax
shr rdx,32
wrmsr
mov ecx,0xC0000084
mov eax,0x4700
xor edx,edx
wrmsr
mov ecx,0x174
mov eax,0x18
xor edx,edx
wrmsr
mov ecx,0x175
mov eax,0x5E0000
wrmsr
mov ecx,0x176
lea rax,[rel sysenter_landing]
mov rdx,rax
shr rdx,32
wrmsr
mov rdi,${DATA}
mov rax,0x5A5A5A5A5A5A5A5A
mov ecx,0x40000
rep stosq
run_case:
mov rsp,0x5F0000
mov eax,[rel case_index]
cmp eax,[rel case_count]
jae done
mov dword [${STATUS}],eax
fninit
ldmxcsr [rel mxcsr_default]
mov rax,0x1000
mov ecx,8
mov edx,0x10
mov rbx,${DATA + 0x800}
mov rsi,${DATA + 0x100}
mov rdi,${DATA + 0x200}
mov rbp,${DATA + 0x400}
mov r8,${DATA + 0x480}
mov r9,${DATA + 0x500}
mov r10,${DATA + 0x580}
mov r11,${DATA + 0x600}
mov r12,${DATA + 0x680}
mov r13,${DATA + 0x700}
mov r14,${DATA + 0x780}
mov r15,${DATA + 0x880}
push 0x23
push ${USER_STACK}
push 2
push 0x33
mov r15d,[rel case_index]
shl r15,5
add r15,${SLOTS}
push r15
mov r15,${DATA + 0x880}
iretq
; [rsp] vector, [rsp+8] error, [rsp+16] RIP
record_fault:
mov eax,[rel case_index]
shl rax,4
add rax,${RESULTS}
mov rdx,[rsp]
mov [rax],edx
mov rdx,[rsp+8]
mov [rax+4],edx
mov rdx,[rsp+16]
mov [rax+8],rdx
inc dword [rel case_index]
jmp run_case
syscall_landing:
mov eax,[rel case_index]
shl rax,4
add rax,${RESULTS}
mov dword [rax],0x100
mov [rax+8],rcx
inc dword [rel case_index]
jmp run_case
sysenter_landing:
mov eax,[rel case_index]
shl rax,4
add rax,${RESULTS}
mov dword [rax],0x101
inc dword [rel case_index]
jmp run_case
done:
mov dword [${STATUS + 4}],${MAGIC}
hlt
jmp done
set_gate:
shl rdi,4
lea rdx,[rel idt]
add rdi,rdx
mov word [rdi],ax
mov word [rdi+2],0x18
mov word [rdi+4],0x8E00
mov rdx,rax
shr rdx,16
mov word [rdi+6],dx
shr rdx,16
mov dword [rdi+8],edx
mov dword [rdi+12],0
ret
${stubs}
align 16
mxcsr_default: dd 0x1F80
case_index: dd 0
case_count: dd ${rows.length}
align 16
gdt:
dq 0,0x00CF9A000000FFFF,0x00CF92000000FFFF,0x00AF9A000000FFFF
dq 0x00CFF2000000FFFF,0x00CFFA000000FFFF,0x00AFFA000000FFFF
dq 0x0000890000000067,0
dq 0,0
gdtr32: dw 87
dd gdt
gdtr64: dw 87
dq gdt
idtr64: dw 511
dq idt
align 16
tss: times 104 db 0
align 16
idt: times 512 db 0
image_end:
`;
fs.writeFileSync(directory + "guest.asm", source);
const nasm = spawnSync("nasm", ["-f", "bin", "-o", directory + "guest.bin", directory + "guest.asm"], {encoding: "utf8"});
assert.equal(nasm.status, 0, nasm.stderr);

const slots = new Uint8Array(rows.length * SLOT).fill(0xCC);
const lengths = [];
for(const [n, [hex, , length]] of rows.entries())
{
    const bytes = Buffer.from(hex, "hex");
    const used = Math.min(length || 15, 15, bytes.length);
    slots.set(bytes.subarray(0, used), n * SLOT);
    lengths.push(used);
}
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const emulator = new V86({multiboot: {url: directory + "guest.bin"}, memory_size: 64 << 20, acpi: true,
    disable_jit: !process.env.X64_JIT, ir_sync_publication: true, autostart: false, log_level: 0});
const outcomes = [];
try
{
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    const cpu = emulator.v86.cpu;
    cpu.mem8.set(slots, SLOTS);
    const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    const deadline = performance.now() + Number(process.env.OPCODE_MATRIX_TIMEOUT || 1800000);
    let rounds = 0;
    while(view().getUint32(STATUS + 4, true) !== MAGIC)
    {
        if(performance.now() > deadline) throw new Error("matrix timed out at case " + view().getUint32(STATUS, true));
        cpu.run_cores();
        if((++rounds & 63) === 0) await yield_event();
    }
    for(let n = 0; n < rows.length; n++)
    {
        const at = RESULTS + n * RECORD;
        outcomes.push({vector: view().getUint32(at, true), error: view().getUint32(at + 4, true), rip: view().getBigUint64(at + 8, true)});
    }
}
finally { await emulator.destroy(); }

// Encodings that are architecturally #UD although iced-x86 decodes them as
// instructions (UD0/UD1/UD2).
const always_ud = new Set(["Ud0_r16_rm16", "Ud0_r32_rm32", "Ud0_r64_rm64", "Ud1_r16_rm16", "Ud1_r32_rm32", "Ud1_r64_rm64", "Ud2", "Ud0"]);
// Encodings iced-x86 attributes to an extension this profile lacks, but which
// a processor without that extension executes in an older form (SDM): TZCNT
// and LZCNT run as REP BSF/BSR, WBNOINVD as WBINVD, and the prefetch/hint
// spaces 0F0D, 0F18 and 0F19-0F1F (PREFETCHW, PREFETCHIT*, CLDEMOTE, CET
// RDSSP) are NOPs.
const older_form = /^(Tzcnt|Lzcnt)_|^Wbnoinvd$|^Prefetch(w|wt1|reserved\d|it0|it1)?_m8$|^Cldemote_m8$|^Rdssp[dq]_r(32|64)$/;
const problems = new Map();
const details = [];
let completed = 0, ud = 0;
for(const [n, [hex, expect_valid, , code]] of rows.entries())
{
    const {vector, rip} = outcomes[n];
    const slot = BigInt(SLOTS + n * SLOT);
    const is_ud = vector === 6 && rip === slot;
    ud += is_ud;
    const valid = (expect_valid || older_form.test(code)) && !always_ud.has(code);
    let problem = null;
    if(valid && is_ud) problem = "v86 #UD, expected valid";
    else if(!valid && !is_ud) problem = `v86 ${vector === 3 ? "completed" : "vector " + vector}, expected #UD`;
    else if(valid && vector === 3 && rip === slot + BigInt(lengths[n] + 1)) completed++;
    // (relative branches may land on an INT3 inside their own slot; INT3
    // itself reports the address after it)
    else if(valid && vector === 3 && rip > slot && rip <= slot + 16n && rip !== slot + 1n
        && !/^(J[a-z]*|Loop[a-z]*|Jrcxz|Jecxz|Call)_rel|^Int3/.test(code)) problem = `executed ${rip - slot - 1n} bytes, expected ${lengths[n]}`;
    if(problem)
    {
        details.push([hex.slice(0, 30), code, problem]);
        const key = `${code}: ${problem}`;
        const entry = problems.get(key) || {count: 0, example: hex.slice(0, 30)};
        entry.count++;
        problems.set(key, entry);
    }
}
for(const [key, {count, example}] of [...problems].sort((a, b) => b[1].count - a[1].count))
    console.log(`MISMATCH ${key} x${count} (e.g. ${example})`);
console.log(`opcode matrix: ${rows.length} encodings run at CPL3, ${ud} #UD, ${completed} completed with the expected length, ${problems.size} mismatching forms`);
fs.writeFileSync(directory + "mismatches.json", JSON.stringify([...problems], null, 1));
fs.writeFileSync(directory + "mismatch-rows.json", JSON.stringify(details));
assert.equal(problems.size, 0, "long-mode execution disagrees with iced-x86 + the CPUID profile");
console.log("PASS opcode matrix");
