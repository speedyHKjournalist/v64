#!/usr/bin/env node
// The x64 page tier writes device memory (the VGA frame buffer,
// src/rust/cpu/mmio_ram.rs) directly once a write translation of it is
// cached: the page is marked written when the translation is filled, and the
// translation is retired when the screen takes the written pages, so the next
// write marks the page again. When the guest moves the BAR, cached
// translations of the old place must go: writes there reach nothing.
//
// A long-mode guest runs one hot store loop (compiled into a page function)
// four times; the host draws the screen and moves BAR0 in between.
import assert from "node:assert/strict";
import {assemble} from "./guest_runner.mjs";

const STATUS = 0x300000;    // guest: the phase it finished; host: the phase it may start
const NEW_BASE = 0x300008;  // host: where BAR0 went
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
mov esp,0x3F0000
; identity map: 0-1 GiB, and the 2 MiB pages of the frame buffer in 3-4 GiB
mov dword [0x200000],0x201007
mov dword [0x201000],0x202007
mov dword [0x201000+3*8],0x203003
mov edi,0x202000
mov eax,0x83
mov ecx,512
.low:
mov [edi],eax
add eax,0x200000
add edi,8
loop .low
; BAR0 of the VGA (PCI 00:12.0)
mov dx,0xCF8
mov eax,0x80000000 | 0x12 << 11 | 0x10
out dx,eax
mov dx,0xCFC
in eax,dx
and eax,~0xF
mov [lfb],eax
call map_lfb
; 64x48, 32 bpp, linear frame buffer (Bochs VBE)
mov dx,0x1CE
mov ax,4
out dx,ax
mov dx,0x1CF
mov ax,0
out dx,ax
mov dx,0x1CE
mov ax,1
out dx,ax
mov dx,0x1CF
mov ax,64
out dx,ax
mov dx,0x1CE
mov ax,2
out dx,ax
mov dx,0x1CF
mov ax,48
out dx,ax
mov dx,0x1CE
mov ax,3
out dx,ax
mov dx,0x1CF
mov ax,32
out dx,ax
mov dx,0x1CE
mov ax,4
out dx,ax
mov dx,0x1CF
mov ax,0x41
out dx,ax
mov eax,cr4
or eax,0x20
mov cr4,eax
mov eax,0x200000
mov cr3,eax
mov ecx,0xC0000080
mov eax,0x100
xor edx,edx
wrmsr
mov eax,cr0
or eax,0x80000001
mov cr0,eax
jmp 24:long_mode

; the four 2 MiB pages of the 8 MiB frame buffer at [lfb]
map_lfb:
mov eax,[lfb]
mov edi,eax
sub edi,0xC0000000
shr edi,21
lea edi,[0x203000+edi*8]
or eax,0x83
mov ecx,4
.map:
mov [edi],eax
add eax,0x200000
add edi,8
loop .map
ret

bits 64
long_mode:
mov esi,[lfb]
mov eax,0x00112233
call fill
mov edi,1
call phase
mov eax,0x00AABBCC
call fill
mov edi,2
call phase
; BAR0 moved: the old place first, then the new one
mov eax,0x00445566
call fill
mov edi,3
call phase
; (the host has mapped the new place)
mov rax,cr3
mov cr3,rax
mov esi,[NEW_BASE]
mov eax,0x00778899
call fill
mov edi,4
call phase
.halt:
hlt
jmp .halt

; the hot loop: 1024 pixels at rsi, many times over
fill:
mov ecx,300000
.loop:
mov edx,ecx
and edx,1023
mov [rsi+rdx*4],eax
dec ecx
jnz .loop
ret

; report phase edi done, wait until the host lets phase edi + 1 start
phase:
mov [${STATUS}],edi
.wait:
pause
cmp dword [${STATUS}+4],edi
jne .wait
ret

align 8
lfb: dd 0
gdt:
dq 0,0x00CF9A000000FFFF,0x00CF92000000FFFF,0x00AF9A000000FFFF
gdtr32: dw 31
dd gdt
image_end:
`.replace("[NEW_BASE]", `[${NEW_BASE}]`);

const directory = assemble("frame-buffer", source);
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const emulator = new V86({multiboot: {url: directory + "guest.bin"}, memory_size: 32 << 20, acpi: true,
    disable_jit: false, experimental_smp_jit: true, ir_sync_publication: true, autostart: false, log_level: 0});
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const cpu = emulator.v86.cpu, io = cpu.io, vga = cpu.devices.vga;
const word = address => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(address, true);
const set_word = (address, value) => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).setUint32(address, value, true);
const run_until = phase => {
    const deadline = performance.now() + 60000;
    while(word(STATUS) !== phase)
    {
        assert.ok(performance.now() < deadline, "the guest did not finish phase " + phase);
        cpu.run_cores();
    }
};
const pixel = (x, y) => {
    cpu.devices.display.request_frame();
    const p = (y * vga.pixels.width + x) * 4;
    return [...vga.pixels.data.subarray(p, p + 3)].map(v => v.toString(16).padStart(2, "0")).join("");
};
const lfb_fills = () => cpu.wm.exports["x64_page_stat"](17);

run_until(1);
assert.ok(lfb_fills() > 0, "the page tier translated frame buffer pages for direct access");
assert.equal(pixel(5, 0), "112233", "direct writes marked their page: drawn");
console.log(`PASS: page functions write the frame buffer directly (${lfb_fills()} translations)`);

set_word(STATUS + 4, 1);
run_until(2);
// No screen update since phase 2's writes: the loop's write translation is
// still cached (and its page marked) when the BAR moves
const old_base = vga.lfb_address;
const new_base = old_base + (16 << 20) >>> 0;
io.port_write32(0xcf8, 0x80000000 | 0x12 << 11 | 0x10);
io.port_write32(0xcfc, new_base);
assert.equal(vga.lfb_address, new_base);
set_word(NEW_BASE, new_base);
// map the new place for the guest: 2 MiB pages in its 3-4 GiB directory
for(let k = 0; k < 4; k++) set_word(0x203000 + ((new_base - 0xC0000000 >>> 21) + k) * 8, new_base + k * (2 << 20) | 0x83);
set_word(STATUS + 4, 2);
run_until(3);
assert.equal(pixel(5, 0), "aabbcc",
    "phase 2 marked its page again after the screen took it, and phase 3's writes to the old place reached nothing");
console.log("PASS: pages are marked again after the screen took them; a moved BAR drops cached translations");

set_word(STATUS + 4, 3);
run_until(4);
assert.equal(pixel(5, 0), "778899", "writes to the new place are drawn");
console.log(`PASS: the frame buffer is drawn from its new place (${old_base.toString(16)} -> ${new_base.toString(16)})`);
await emulator.destroy();
