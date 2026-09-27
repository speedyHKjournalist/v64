import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const enabled=Number(process.argv[2]??1);assert([0,1].includes(enabled));
const vm=new V86({wasm_path:"build/v86-ir-runtime.wasm",memory_size:32<<20,
 bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
 disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
 await new Promise(r=>vm.add_listener("emulator-loaded",r));
 const cpu=vm.v86.cpu,e=cpu.wm.exports,w=new Uint32Array(e.memory.buffer),view=new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset);
 vm.run();const deadline=performance.now()+10000;
 while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
 const A=0x100000,B=A+0x2000;
 cpu.jit_clear_cache();e.ir_cache_collect();cpu.in_hlt[0]=0;cpu.flags[0]=2;cpu.flags_changed[0]=0;
 cpu.segment_offsets.fill(0,0,6);cpu.is_32[0]=1;cpu.stack_size_32[0]=1;cpu.reg32.fill(0);
 cpu.reg32[2]=B;cpu.reg32[3]=A;cpu.reg32[4]=0x90000;cpu.instruction_pointer[0]=A;e.update_state_flags();
 vm.write_memory(Uint8Array.of(0x40,0xFF,0xE2),A);vm.write_memory(Uint8Array.of(0x41,0xFF,0xE3),B);w[664>>2]=0;
 if(process.env.IR_DIAGNOSTICS!==undefined)assert.equal(await vm.configure_ir_diagnostics(Number(process.env.IR_DIAGNOSTICS)),true);
 assert.equal(e.ir_cache_set_fusion(enabled),1);assert.equal(e.ir_auto_config(1,2,4,192,256,64),1);
 vm.run();await sleep(1500);await vm.stop();
 assert.equal(e.ir_cache_entry_stat(A,0,1,5),2);assert.equal(e.ir_cache_entry_stat(B,0,1,5),2);
 if(enabled)assert(e.ir_cache_stat(24)>0);
 const counter=()=>new Uint32Array(e.memory.buffer)[664>>2];
 const count=counter(),hits=e.ir_cache_stat(2),full=e.ir_cache_stat(19),start=performance.now();
 vm.run();await sleep(3000);await vm.stop();const ms=performance.now()-start,n=(counter()-count)>>>0,activations=(e.ir_cache_stat(2)-hits)>>>0;
 assert.equal(counter(),((cpu.reg32[0]+cpu.reg32[1])*2-([A+1,B+1].includes(cpu.instruction_pointer[0])?1:0))>>>0);
 console.log(JSON.stringify({fusion:!!enabled,diagnostic_period:Number(process.env.IR_DIAGNOSTICS||0),ms,mips:n/ms/1000,instructions:n,activations,instructions_per_activation:n/activations,
 full_checks:(e.ir_cache_stat(19)-full)>>>0,fused_publications:e.ir_cache_stat(23)}));
} finally {await vm.destroy();}
