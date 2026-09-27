import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const modules=[0,1,2].map(i=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-multientry/${i}-${opt}.wasm`))));
const vm=new V86({wasm_path:process.argv[2]||"build/v86-ir-test.wasm",memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,w=new Uint32Array(e.memory.buffer),raw=new Uint8Array(e.memory.buffer);
    const v=new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset),put=(a,x)=>v.setUint32(a,x,true);
    vm.run();const end=performance.now()+10000;
    while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<end);await new Promise(r=>setTimeout(r,1));} await vm.stop();
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:{...e,m:e.memory}})));
    function reset(offset) {
        cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);cpu.is_32[0]=cpu.stack_size_32[0]=1;
        cpu.reg32.fill(0);cpu.reg32[4]=0x90000;cpu.flags[0]=2;cpu.flags_changed[0]=0;cpu.in_hlt[0]=0;raw[648]=0;
        cpu.instruction_pointer[0]=0x1FFD+offset;w[664>>2]=100;put(0x13004,0x1003);put(0x13008,0x2003);
        cpu.mem8.set([0xB8,0x40,0x40,0x40,0x40,0x40],0x1FFD);e.full_clear_tlb();e.update_state_flags();
    }
    const state=()=>({regs:Array.from(cpu.reg32),flags:e.get_eflags(),ip:cpu.instruction_pointer[0],previous:w[560>>2]});
    for(const [i,offset,count] of [[0,0,2],[1,1,5],[2,5,1]]) {
        reset(offset);for(let n=0;n<count;n++)e.ir_test_step();const expected=state();
        for(const opt of [0,1]) {
            reset(offset);instances[i][opt].exports.f(0);assert.deepEqual(state(),expected);assert.equal(w[664>>2],100+count);
            for(const wrong of [0,1,5].filter(x=>x!==offset)) {
                reset(wrong);const before=Buffer.from(raw.slice(64,1200));instances[i][opt].exports.f(0);assert.deepEqual(Buffer.from(raw.slice(64,1200)),before);
            }
        }
    }
    console.log("PASS: split overlapping CPU entries execute independently with exact counts and reject sibling entry contexts before state writes");
} finally {await vm.destroy();}
