// Interpreter-only diagnostic contract for VERR/VERW: raw versus computed ZF.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const release of [false,true]){
    const vm=new V86({wasm_path:release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
    try {
        await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true);
        vm.run();const deadline=performance.now()+10000;while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
        for(const modrm of [0xE0,0xE8]) for(const zero of [false,true]){
            cpu.segment_offsets.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.is_32[0]=1;cpu.stack_size_32[0]=1;words[612>>2]=0;
            cpu.gdtr_offset[0]=0x5000;cpu.gdtr_size[0]=0x10FF;set32(0x5008,0xFFFF);set32(0x500C,0xCF9B00);set32(0x5010,0xFFFF);set32(0x5014,0xCF9300);
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;set32(0x2000+14*8,8<<16|0x200);set32(0x2004+14*8,0x180000|0x8E00);
            set32(0x12000,0x13003);set32(0x13000+5*4,0x5003);set32(0x13000+6*4,0);e.full_clear_tlb();e.update_state_flags();
            cpu.instruction_pointer[0]=0x8000;cpu.reg32[0]=0x1000;cpu.reg32[3]=zero?-1:1;cpu.reg32[4]=0x90000;cpu.flags[0]=zero?2:0x42;cpu.flags_changed[0]=0;mem.set([0x43,0x0F,0x00,modrm],0x8000);
            e.ir_test_step();const computed=Number(!!(e.get_eflags()&64)),raw=Number(!!(cpu.flags[0]&64));e.ir_test_step();assert.equal(cpu.instruction_pointer[0],0x180200);assert.equal(cpu.cr[2],0x6000);
            const saved=Number(!!(v.getUint32(0x90000-4,true)&64));assert.equal(computed,+zero);assert.equal(raw,+!zero);assert.equal(saved,raw);
            console.log(`PASS (${release?"release":"debug"}): ${modrm===0xE0?"VERR":"VERW"} descriptor #PF ZF computed=${computed}, raw/saved=${saved}`);
        }
    } finally {await vm.destroy();}
}
