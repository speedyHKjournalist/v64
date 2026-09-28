#!/usr/bin/env node
// Direct boot (multiboot/bzimage) stays 32-bit: x86-64 kernels boot from a
// BIOS disk or ISO, or through a 32-bit multiboot entry that enables long
// mode itself (all tests/x64 guests). Inputs the loaders cannot handle are
// rejected with an emulator-error before anything runs, instead of being
// parsed with 32-bit structures. A 32-bit i386 multiboot ELF still boots.
import assert from "node:assert/strict";

const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const MAGIC = 0x1BADB002;

function elf({elf_class = 1, machine = 3, code = []} = {})
{
    const image = new Uint8Array(0x200);
    const view = new DataView(image.buffer);
    view.setUint32(0, 0x464C457F, true);
    image.set([elf_class, 1, 1], 4);
    view.setUint16(16, 2, true);          // ET_EXEC
    view.setUint16(18, machine, true);
    view.setUint32(20, 1, true);
    view.setUint32(24, 0x10010C, true);   // entry
    view.setUint32(28, 52, true);         // program headers
    view.setUint16(40, 52, true);
    view.setUint16(42, 32, true);
    view.setUint16(44, 1, true);
    view.setUint16(46, 40, true);
    // PT_LOAD of the whole file at 1 MiB
    [1, 0, 0x100000, 0x100000, 0x200, 0x200, 5, 0x1000].forEach((v, i) => view.setUint32(52 + i * 4, v, true));
    // multiboot header without the address fields (the ELF headers are used)
    [MAGIC, 0, -MAGIC >>> 0].forEach((v, i) => view.setUint32(0x100 + i * 4, v, true));
    image.set(code, 0x10C);
    return image.buffer;
}
function headerless()
{
    const image = new Uint8Array(0x200);
    [MAGIC, 0, -MAGIC >>> 0].forEach((v, i) => new DataView(image.buffer).setUint32(0x40 + i * 4, v, true));
    return image.buffer;
}
function bzimage(protocol)
{
    const image = new Uint8Array(0x1000);
    const view = new DataView(image.buffer);
    view.setUint16(0x1FE, 0xAA55, true);
    view.setUint32(0x202, 0x53726448, true); // "HdrS"
    view.setUint16(0x206, protocol, true);
    image[0x211] = 1;                          // LOADED_HIGH
    return image.buffer;
}

async function boot(options)
{
    const emulator = new V86({memory_size: 32 << 20, autostart: false, disable_jit: true, log_level: 0, ...options});
    try
    {
        return await new Promise(resolve => {
            emulator.add_listener("emulator-loaded", () => resolve({emulator}));
            emulator.add_listener("emulator-error", error => resolve({error}));
        });
    }
    catch(error) { return {error}; }
}

for(const [name, options, pattern] of [
    ["64-bit multiboot ELF", {multiboot: {buffer: elf({elf_class: 2})}}, /64-bit ELF/],
    ["x86-64 machine ELF32", {multiboot: {buffer: elf({machine: 62})}}, /not an i386 image \(machine 62\)/],
    ["multiboot without address header or ELF", {multiboot: {buffer: headerless()}}, /neither an address header nor an ELF header/],
    ["bzimage boot protocol 2.01", {bzimage: {buffer: bzimage(0x201)}, bios: {buffer: new Uint8Array(65536).fill(0xF4).buffer}}, /older than 2\.02/],
    ["bzimage without a boot header", {bzimage: {buffer: new ArrayBuffer(0x1000)}, bios: {buffer: new Uint8Array(65536).fill(0xF4).buffer}}, /no Linux boot sector signature/],
])
{
    const {emulator, error} = await boot(options);
    if(emulator) { await emulator.destroy(); assert.fail(name + ": loaded"); }
    assert.match(String(error?.message || error), pattern, name);
    console.log(`PASS rejected: ${name}`);
}

// mov dword [0x300000], 0xC064C064; hlt
const {emulator, error} = await boot({multiboot: {buffer: elf({code: [0xC7, 0x05, 0, 0, 0x30, 0, 0x64, 0xC0, 0x64, 0xC0, 0xF4, 0xEB, 0xFE]})}});
assert.ok(emulator, "i386 multiboot ELF loads: " + error);
try
{
    const cpu = emulator.v86.cpu;
    for(let round = 0; round < 2000 && new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x300000, true) !== 0xC064C064; round++) cpu.run_cores();
    assert.equal(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x300000, true), 0xC064C064, "i386 multiboot ELF ran");
}
finally { await emulator.destroy(); }
console.log("PASS i386 multiboot ELF still boots");
