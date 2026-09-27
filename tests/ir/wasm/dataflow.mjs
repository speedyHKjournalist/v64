import assert from "node:assert/strict";
import fs from "node:fs";
let executions=0;
const memory=new WebAssembly.Memory({initial:64}), words=new Uint32Array(memory.buffer);
for(const budget of [1,2,3,4,5,9,16,100]) {
    const instances=[false,true].map(opt=>new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-dataflow/diamond-${budget}-${opt}.wasm`)),{e:{m:memory}}));
    for(const a of [0,1,0x7FFFFFFF,0xFFFFFFFF]) for(const b of [1,0x80000000,0xFFFFFFFF])
    for(const c of [3,0xFFFFFFFF]) for(const d of [11,0x80000000]) for(const branch of [0,1]) for(const flags of [2,0x8D7]) {
        const input=[a,b,c,d,0x90000,0x12345678,0xABCDEF01,branch];
        const expected=input.slice();
        if(budget>=3) {
            expected[0]=Number((BigInt(a)+BigInt(b))&0xFFFFFFFFn);
            expected[1]=(c+d)>>>0; expected[2]=Number((BigInt(a)+BigInt(b))>>32n); expected[3]=(c+d)>>>0;
        }
        const ip=budget===1?(branch===0?0x8002:0x8003):budget===2?0x8001:0x9000;
        for(const instance of instances) {
            words.set(input); words[8]=flags;words[9]=0;words[10]=99;words[11]=0x76543210;
            instance.exports.f(0);
            assert.deepEqual(Array.from(words.slice(0,8)),expected);
            assert.equal(words[8],flags);assert.equal(words[9],ip);assert.equal(words[10],0);assert.equal(words[11],0x76543210);
            executions++;
        }
    }
}
console.log(`PASS: ${executions} independent dominator-GVN diamond executions, i32/i64 overflow, both arms and exact budget recovery`);
