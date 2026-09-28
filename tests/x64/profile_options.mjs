#!/usr/bin/env node
// Embedder options for 64-bit guests:
// - memory_size above the wasm32 limit is reduced to 2 GiB - 128 KiB instead
//   of wrapping (8 GiB used to become 0 bytes, then the BIOS load failed);
// - experimental_x64 presents the x86-64 CPU profile: CPUID.80000001h:EDX
//   long mode (bit 29), NX (20) and SYSCALL (11) only when it is set.
import assert from "node:assert/strict";
import url from "node:url";
import {assemble, actual} from "./guest_runner.mjs";

const root = url.fileURLToPath(new URL("../../", import.meta.url));
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const MAX = 2 ** 31 - 128 * 1024;

for(const gib of [4, 6, 8])
{
    const emulator = new V86({bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
        memory_size: gib * 2 ** 30, autostart: false, log_level: 0});
    const error = await new Promise(resolve => {
        emulator.add_listener("emulator-loaded", () => resolve(null));
        emulator.add_listener("emulator-error", resolve);
    });
    assert.equal(error, null, `${gib} GiB: ${error}`);
    assert.equal(emulator.v86.cpu.memory_size[0] >>> 0, MAX, `${gib} GiB is reduced to the maximum`);
    await emulator.destroy();
    console.log(`PASS memory_size ${gib} GiB loads with ${MAX / 2 ** 20} MiB`);
}

const directory = assemble("profile-options", `bits 32
org 0x100000
header:
dd 0x1BADB002,0x10000,-(0x1BADB002+0x10000)
dd header,header,image_end,image_end,start
start:
mov eax,0x80000001
cpuid
mov [0x300004],edx
mov dword [0x300000],0xC064C064
hlt
jmp $
image_end:
`);
for(const [x64, expected] of [[false, 0], [true, 1 << 29 | 1 << 20 | 1 << 11]])
{
    const result = await actual(directory, {length: 8, options: {experimental_x64: x64}});
    const edx = result.readUInt32LE(4);
    assert.equal(edx & (1 << 29 | 1 << 20 | 1 << 11), expected >>> 0, `experimental_x64: ${x64}, EDX ${edx.toString(16)}`);
    console.log(`PASS experimental_x64: ${x64} -> CPUID.80000001h:EDX ${edx.toString(16)}`);
}
