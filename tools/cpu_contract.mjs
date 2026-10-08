#!/usr/bin/env node
// CPU identity contract (docs/x86-64.md): the virtual CPU's identity as
// the guest sees it, per profile: CPUID for a fixed list of leaves and which
// MSRs RDMSR reads (and their reset values) instead of raising #GP. A
// multiboot guest runs the instructions on the bootstrap processor, so this is
// the observed contract, not a copy of the source. In a profile with long
// mode the MSRs are read with EFER.LME set, as a 64-bit OS reads them.
//
//   node tools/cpu_contract.mjs          write tests/platform/cpu-contract.json
//   node tools/cpu_contract.mjs --check  fail if the emulator differs from that file
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { assemble, actual } from "../tests/x64/guest_runner.mjs";

// the release build: the debug build asserts on an unknown MSR in the legacy
// profile, which (upstream's policy) reads it as 0 rather than raising #GP
process.env.TEST_RELEASE_BUILD = "1";

const root = fileURLToPath(new URL("../", import.meta.url));
const contract_path = root + "tests/platform/cpu-contract.json";

const LEAVES = [
    [0, 0], [1, 0], [2, 0], [4, 0], [4, 1], [4, 2], [4, 3], [6, 0], [7, 0], [7, 1], [0xA, 0],
    [0xB, 0], [0xB, 1], [0xB, 2], [0xD, 0], [0xD, 1], [0x40000000, 0],
    [0x80000000, 0], [0x80000001, 0], [0x80000002, 0], [0x80000003, 0], [0x80000004, 0],
    [0x80000005, 0], [0x80000006, 0], [0x80000007, 0], [0x80000008, 0], [0x8000000A, 0],
];
const MSRS = [
    0x10, 0x17, 0x1B, 0x3A, 0x3B, 0x48, 0x8B, 0xE7, 0xE8, 0xFE, 0x10A, 0x174, 0x175, 0x176,
    0x179, 0x17A, 0x17B, 0x1A0, 0x1D9, 0x200, 0x201, 0x20E, 0x20F, 0x250, 0x258, 0x259,
    0x268, 0x26F, 0x277, 0x2FF, 0x345, 0x400, 0x401, 0x402, 0x403, 0x40C, 0x40F, 0x6E0,
    0xC0000080, 0xC0000081, 0xC0000082, 0xC0000083, 0xC0000084, 0xC0000100, 0xC0000101,
    0xC0000102, 0xC0000103,
];
// (counters whose values change; only whether they are readable is part of
// the contract)
const VOLATILE = new Set([0x10, 0xE7, 0xE8]);
const PROFILES = {
    "legacy-1": {},
    "legacy-4": { cpu_cores: 4, acpi: true },
    "x64-1": { cpu_type: "x86_64" },
    "x64-4": { cpu_type: "x86_64", cpu_cores: 4, acpi: true },
    // the released features (docs/simd-xsave-plan.md M1, M2, M3)
    "legacy-v2": { cpu_features: "x86-64-v2" },
    "x64-v2": { cpu_type: "x86_64", cpu_features: "x86-64-v2" },
    "legacy-xsave": { cpu_features: ["XSAVE"] },
    "x64-xsave": { cpu_type: "x86_64", cpu_features: ["XSAVE"] },
    "legacy-avx": { cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"] },
    "x64-avx": { cpu_type: "x86_64", cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"] },
};

const OUT = 0x300000, CPUID_AT = OUT + 16, MSR_AT = CPUID_AT + 16 * LEAVES.length;
const source = `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
cli
; a GDT of its own (exceptions reload CS from it), then an IDT whose #GP
; handler skips the faulting RDMSR (2 bytes) and flags it
lgdt [gdtr]
jmp 8:.flat
.flat:
mov ax, 16
mov ds, ax
mov es, ax
mov ss, ax
mov esp, 0x200000
mov edi, idt
mov ecx, 32
.gate:
mov eax, other
mov [edi], ax
mov word [edi + 2], 8
mov word [edi + 4], 0x8E00
shr eax, 16
mov [edi + 6], ax
add edi, 8
loop .gate
mov eax, gp_handler
mov [idt + 13 * 8], ax
shr eax, 16
mov [idt + 13 * 8 + 6], ax
lidt [idtr]
mov esi, leaves
mov edi, ${CPUID_AT}
.cpuid:
mov eax, [esi]
cmp eax, -1
je .msrs
mov ecx, [esi + 4]
cpuid
mov [edi], eax
mov [edi + 4], ebx
mov [edi + 8], ecx
mov [edi + 12], edx
add esi, 8
add edi, 16
jmp .cpuid
.msrs:
; with long mode (CPUID.80000001h:EDX[29]), as a 64-bit OS sees them: EFER.LME set
mov eax, 0x80000001
cpuid
test edx, 1 << 29
jz .probe
mov ecx, 0xC0000080
rdmsr
or eax, 1 << 8
wrmsr
.probe:
mov esi, msrs
mov edi, ${MSR_AT}
.msr:
mov ecx, [esi]
cmp ecx, -1
je .done
mov dword [faulted], 0
xor eax, eax
xor edx, edx
rdmsr
mov ebx, [faulted]
mov [edi], ebx
mov [edi + 4], eax
mov [edi + 8], edx
add esi, 4
add edi, 12
jmp .msr
.done:
mov dword [${OUT}], 0xC064C064
.halt:
hlt
jmp .halt
gp_handler:
mov dword [faulted], 1
add esp, 4                      ; the error code
add dword [esp], 2              ; past RDMSR
iret
other:
mov dword [${OUT} + 4], 0xBAD
.stop:
hlt
jmp .stop
align 4
faulted: dd 0
leaves:
${LEAVES.map(([leaf, sub]) => `dd ${leaf}, ${sub}`).join("\n")}
dd -1, -1
msrs:
${MSRS.map(msr => `dd ${msr}`).join("\n")}
dd -1
align 8
gdt: dq 0, 0x00CF9A000000FFFF, 0x00CF92000000FFFF
gdtr: dw 3 * 8 - 1
dd gdt
idtr: dw 32 * 8 - 1
dd idt
idt: times 32 dq 0
image_end:
`;

const hex = n => "0x" + (n >>> 0).toString(16).padStart(8, "0");
const directory = assemble("cpu-contract", source);
const observed = {};
for(const [name, options] of Object.entries(PROFILES))
{
    const bytes = await actual(directory, { length: MSR_AT - OUT + 12 * MSRS.length, options });
    assert.notEqual(bytes.readUInt32LE(4), 0xBAD, name + ": unexpected exception");
    const cpuid = {};
    LEAVES.forEach(([leaf, sub], i) => {
        const at = CPUID_AT - OUT + 16 * i;
        cpuid[`${hex(leaf)}.${sub}`] = [0, 4, 8, 12].map(o => hex(bytes.readUInt32LE(at + o)));
    });
    const msrs = {};
    MSRS.forEach((msr, i) => {
        const at = MSR_AT - OUT + 12 * i;
        msrs[hex(msr)] = bytes.readUInt32LE(at) ? "#GP" : VOLATILE.has(msr) ? "readable" :
            hex(bytes.readUInt32LE(at + 8)) + ":" + hex(bytes.readUInt32LE(at + 4)).slice(2);
    });
    observed[name] = { options, cpuid, msrs };
}
const vendor = regs => [regs[1], regs[3], regs[2]].map(r => Buffer.from(Uint32Array.of(parseInt(r, 16)).buffer).toString("latin1")).join("");
const document = {
    about: "Observed CPUID (EAX, EBX, ECX, EDX per leaf.subleaf) and RDMSR (EDX:EAX or #GP) of the bootstrap processor per profile; " +
        "generated by tools/cpu_contract.mjs, checked by `node tools/cpu_contract.mjs --check`",
    vendor: vendor(observed["x64-1"].cpuid["0x00000000.0"]),
    profiles: observed,
};

if(process.argv.includes("--check"))
{
    const committed = JSON.parse(fs.readFileSync(contract_path, "utf8"));
    assert.deepEqual(document, committed, "the CPU differs from tests/platform/cpu-contract.json " +
        "(update it with `node tools/cpu_contract.mjs` if the change is intended)");
    console.log(`CPU contract matches (${Object.keys(PROFILES).length} profiles, ${LEAVES.length} CPUID leaves, ${MSRS.length} MSRs)`);
}
else
{
    fs.mkdirSync(root + "tests/platform", { recursive: true });
    fs.writeFileSync(contract_path, JSON.stringify(document, null, 1) + "\n");
    console.log("wrote " + contract_path);
}
