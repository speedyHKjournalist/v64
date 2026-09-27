#!/usr/bin/env node
// Native modules contain no guest execution helpers. The only call is a cold
// admission guard, proving this compares real Wasm arithmetic with QEMU output.
import assert from "node:assert/strict";
import fs from "node:fs";
const root=new URL("../../",import.meta.url);
const path=s=>new URL(s,root);
const cases=JSON.parse(fs.readFileSync(path("build/x64-integer/cases.json")));
const golden=fs.readFileSync(path("build/x64-integer/qemu.bin"));
const modules=JSON.parse(fs.readFileSync(path("build/x64-native/manifest.json")));
const memory=new WebAssembly.Memory({initial:64});const view=new DataView(memory.buffer);
const low=r=>r<8?64+r*4:1424+(r-8)*4;
const high=r=>1360+r*4;
const write=(r,v)=>{view.setUint32(low(r),Number(v&0xFFFFFFFFn),true);view.setUint32(high(r),Number(v>>32n&0xFFFFFFFFn),true);};
const read=r=>BigInt(view.getUint32(low(r),true))|BigInt(view.getUint32(high(r),true))<<32n;
let admitted=true,guard_calls=0;
const instance=(bytes, expected_token=7n)=>{
    const module=new WebAssembly.Module(bytes);
    assert.deepEqual(WebAssembly.Module.imports(module).filter(i=>i.kind==="function").map(i=>i.name),["x64_native_guard"]);
    return new WebAssembly.Instance(module,{e:{m:memory,x64_native_guard:token=>{assert.equal(typeof token,"bigint");assert.equal(token,expected_token);guard_calls++;return Number(admitted);}}});
};
const names={0:"add",1:"or",2:"adc",3:"sbb",4:"and",5:"sub",6:"xor",7:"cmp"};const suffix={8:"b",16:"w",32:"d",64:""};
let checked=0;
for(const [name,width,code] of modules)
{
    const f=instance(fs.readFileSync(path("build/x64-native/"+name))).exports.f;
    for(let n=0;n<cases.length;n++)
    {
        const test=cases[n];if(test.code!==`${names[code]} r8${suffix[width]}, r9${suffix[width]}`) continue;
        write(8,BigInt(test.a));write(9,BigInt(test.b));view.setUint32(120,test.flags,true); // gp::flags
        view.setUint32(100,0x1234,true); // dirty lazy mask gets canonicalized by ALU
        assert.equal(f(1),1);assert.equal(read(8),golden.readBigUInt64LE(n*72),`${test.code}: r8`);
        assert.equal(read(9),golden.readBigUInt64LE(n*72+8),`${test.code}: r9`);
        assert.equal(view.getUint32(120,true)&test.mask,Number(golden.readBigUInt64LE(n*72+48))&test.mask,`${test.code}: FLAGS`);
        checked++;
    }
}
for(const [name,assembly] of JSON.parse(fs.readFileSync(path("build/x64-native/extra.json"))))
{
    const f=instance(fs.readFileSync(path("build/x64-native/"+name))).exports.f;
    for(let n=0;n<cases.length;n++)
    {
        const test=cases[n];if(test.code!==assembly) continue;
        write(8,BigInt(test.a));write(9,BigInt(test.b));view.setUint32(120,test.flags,true);
        assert.equal(f(1),1);assert.equal(read(8),golden.readBigUInt64LE(n*72),`${test.code}: r8`);
        assert.equal(read(9),golden.readBigUInt64LE(n*72+8),`${test.code}: r9`);
        assert.equal(view.getUint32(120,true)&test.mask,Number(golden.readBigUInt64LE(n*72+48))&test.mask,`${test.code}: FLAGS`);
        checked++;
    }
}
// Existing QEMU guest branch outcomes are the independent truth table. Each
// native target crosses a low-DWORD boundary, so a truncated RIP cannot pass.
for(const [cc,name] of ["o","no","b","ae","e","ne","be","a","s","ns","p","np","l","ge","le","g"].entries())
{
    const f=instance(fs.readFileSync(path(`build/x64-native/branch-${cc}.wasm`))).exports.f;
    for(let n=0;n<cases.length;n++)
    {
        const test=cases[n];if(!test.code.startsWith(`mov r8, 0\nj${name} `)) continue;
        for(let r=0;r<16;r++) write(r,0xABCDEF1234567890n+BigInt(r));
        const registers=Array.from({length:16},(_,r)=>read(r));
        view.setUint32(120,test.flags,true);
        assert.equal(f(1),1);
        const actual=BigInt(view.getUint32(556,true)) | BigInt(view.getUint32(1584,true))<<32n;
        const taken=golden.readBigUInt64LE(n*72)===0n;
        assert.equal(actual,0xFFFF8000FFFFFFF6n+(taken?256n:0n),`${name}: full branch RIP`);
        assert.equal(view.getUint32(120,true),test.flags,`${name}: FLAGS unchanged`);
        assert.deepEqual(Array.from({length:16},(_,r)=>read(r)),registers,`${name}: GPRs unchanged`);
        checked++;
    }
}
const artifact=instance(fs.readFileSync(path("build/x64-native/registers.wasm")),0x123456789ABCDEF0n).exports.f;
view.setUint32(120,2,true);write(1,0xABCDEF0102030405n);assert.equal(artifact(2),2);assert.equal(read(8),0x7FFFFFFFFFFFFFFFn);assert.equal(read(9),1n);
const before=Buffer.from(new Uint8Array(memory.buffer));assert.equal(artifact(0),0);assert.deepEqual(Buffer.from(new Uint8Array(memory.buffer)),before,"zero budget leaves architectural state untouched");
admitted=false;assert.equal(artifact(5),0);assert.deepEqual(Buffer.from(new Uint8Array(memory.buffer)),before,"rejected guard does not mutate CPU state");
admitted=true;assert.equal(artifact(5),5);assert.equal(read(8),0xABCDEF0102030405n);assert.equal(read(9),0n);
assert.ok(guard_calls>checked);console.log(`PASS: ${checked} native Wasm i64 register/flags cases agree with QEMU; budget and stale-entry rejection preserve state`);
