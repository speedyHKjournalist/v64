#!/usr/bin/env node
import assert from "node:assert/strict";
import {assemble, reference, actual} from "./guest_runner.mjs";
import {longModeGuest} from "./guest_builder.mjs";
const source = longModeGuest(`
mov ecx,10000
xor r8d,r8d
xor r9d,r9d
call hot_loop
mov [0x300008],r8
mov [0x300010],r9
; Patch the immediate through the LOW alias of the currently cached high code.
mov byte [hot_loop+3],7
mov ecx,10000
xor r8d,r8d
xor r9d,r9d
call hot_loop
mov [0x300018],r8
mov [0x300020],r9
`, `
hot_loop:
add r8,byte 3
xor r9,r8
sub ecx,1
jnz hot_loop
ret
`);
const dir = assemble("cache", source);
const config = {length: 40};
const oracle = await reference(dir, config);
for(const backend of ["tier0", "region"])
{
    let retired = 0, rejected = 0;
    const result = await actual(dir, {...config, options: {disable_jit: false, experimental_smp_jit: true,
        ir_tier0: backend === "tier0", ir_sync_publication: true}, inspect: emulator => {
        const ex = emulator.v86.cpu.wm.exports;
        retired = ex.x64_native_stat(1); rejected = ex.x64_native_stat(2);
        assert.ok(retired > 1000, "runtime executed actual native instructions");
        assert.ok(rejected > 0, "low alias SMC rejected an old high RIP entry");
    }});
    assert.deepEqual(result, oracle, backend + " native result agrees with QEMU after SMC");
    console.log(`PASS ${backend}: ${retired} native retirements, ${rejected} stale entries rejected`);
}
