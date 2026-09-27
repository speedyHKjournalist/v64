import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const wasm=process.argv[2]||"build/v86-ir-test.wasm";
const cases=JSON.parse(fs.readFileSync("build/ir-shared-entry/cases.json"));
const vm=new V86({wasm_path:wasm,memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
    await new Promise(resolve=>vm.add_listener("emulator-loaded",resolve));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,words=new Uint32Array(e.memory.buffer),raw=new Uint8Array(e.memory.buffer);
    vm.run();const end=performance.now()+10000;
    while(new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset).getUint16(0x500,true)!==0xCAFE){assert(performance.now()<end);await sleep(1);}
    await vm.stop();await sleep(20);cpu.jit_clear_cache();
    const PC=0x100000,CS=PC-0x1000,code=Uint8Array.of(0x40,0x43,0x49,0x75,0xFB);
    function reset(mode,offset){
        cpu.segment_offsets.fill(0,0,6);cpu.segment_offsets[1]=CS;
        cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=0;raw[648]=0;cpu.in_hlt[0]=0;
        cpu.reg32.set([0x7FFFFFFF,3,0x12345678,0x89ABCDEF,0x90000,0xFEDCBA98,0x110000,0x76543210]);
        cpu.flags[0]=0x8D7;cpu.flags_changed[0]=0;words[104>>2]=0x13579;
        cpu.instruction_pointer[0]=PC+offset;words[560>>2]=PC+offset;words[664>>2]=0xFFFFFFFC;
        for(let i=0;i<32;i++)words[(832>>2)+i]=Math.imul(i+1,0x1234567)>>>0;
        cpu.mem8.set(code,PC);e.full_clear_tlb();e.update_state_flags();
    }
    const state=()=>({regs:Array.from(cpu.reg32),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,
        xmm:Array.from(cpu.reg_xmm32s)});
    let compared=0,rejected=0;
    for(let i=0;i<cases.length;i++){
        const [mode,budget]=cases[i];
        // One instance/function is reused for all three cold PC aliases.
        const instance=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-shared-entry/${i}.wasm`)),{e:{...e,m:e.memory}});
        const f=instance.exports.f;
        for(const offset of [0,1,2]){
            reset(mode,offset);f(0);const actual=state(),count=(words[664>>2]-0xFFFFFFFC)>>>0;
            assert(count<=12,`case ${i} bounded execution`);
            if(budget>=5)assert(count>0,`case ${i} makes progress`);
            reset(mode,offset);for(let n=0;n<count;n++)e.ir_test_step();
            assert.deepEqual(actual,state(),`shared body ${i}, offset ${offset}, ${count} retired`);compared++;
        }
        for(const mismatch of ["pc","cs","mode","prefix","halt","index"]){
            reset(mode,1);let selector=0;
            if(mismatch==="pc")cpu.instruction_pointer[0]=PC+3;
            if(mismatch==="cs")cpu.segment_offsets[1]+=4096;
            if(mismatch==="mode")cpu.is_32[0]^=1;
            if(mismatch==="prefix")raw[648]=1;
            if(mismatch==="halt")cpu.in_hlt[0]=1;
            if(mismatch==="index")selector=1;
            const before=Buffer.from(raw.slice(64,1200));f(selector);
            assert.deepEqual(Buffer.from(raw.slice(64,1200)),before,`${i}: reject ${mismatch} without CPU effects`);rejected++;
        }
    }
    console.log(`PASS: ${wasm}: ${compared} shared-body alias/interpreter comparisons and ${rejected} no-effect entry rejections, 16/32-bit and exact budget boundaries`);
} finally {await vm.destroy();}
