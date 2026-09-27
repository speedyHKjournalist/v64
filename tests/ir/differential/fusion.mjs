import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
// disable_jit: fixture modules run by hand, with the IR scheduler idle.
const vm=new V86({wasm_path:process.argv[2]||"build/v86-ir-test.wasm",disable_jit:true,memory_size:32<<20,
 bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
 disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
 await new Promise(r=>vm.add_listener("emulator-loaded",r));
 const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,w=new Uint32Array(e.memory.buffer),v=new DataView(mem.buffer,mem.byteOffset);
 const A=0x100000,B=A+0x2000,DATA=0x110000,STACK=0x90000;
 vm.run();const end=performance.now()+10000;
 while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<end);await sleep(1);} await vm.stop();
 const state=()=>({gpr:Array.from(cpu.reg32),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,
  data:v.getUint32(DATA,true),xmm:Array.from(cpu.reg_xmm32s),cr2:cpu.cr[2]>>>0,frame:Array.from(mem.slice(STACK-32,STACK))});
 function reset(mode,kind,{cold=false,miss=false,lazy=false,count=100,mmio=false}={}){
  const base=mode?0:0xFF000;
  cpu.segment_offsets.fill(0,0,6);cpu.segment_offsets[1]=base;cpu.segment_is_null.fill(0,0,6);
  cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.sreg.set([16,8,16,16,16,16]);
  cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.stack_size_32[0]=1;w[612>>2]=0;
  cpu.reg32.set([0x7FFFFFFF,0x87654321,miss?0x7000:B-base,A-base,STACK,0,mmio?0xA0000:DATA,0xFEDCBA98]);
  // OSFXSR/OSXMMEXCPT as an OS sets them: debug builds decline SSE code at
  // entry without OSFXSR (the interpreter's warning is a host observer).
  cpu.cr[4]|=0x600;
  cpu.is_32[0]=+mode;cpu.flags[0]=0x8D7;cpu.flags_changed[0]=lazy?0x8D5:0;
  w[96>>2]=31;w[104>>2]=0x7FFFFFFF;w[112>>2]=0x80000000;
  cpu.instruction_pointer[0]=A;cpu.in_hlt[0]=0;w[664>>2]=count;cpu.cr[2]=0;
  mem.set(kind===2?[0x66,0x0F,0xEF,0xC1,0xFF,0xE2]:[0x40,0xFF,0xE2],A);
  mem.set(kind===3?[...(!mode?[0x67]:[]),0xC6,0x06,0x90,0x47,0xFF,0xE3]:kind===1?[...(!mode?[0x67]:[]),0x8B,0x0E,0x47,0xFF,0xE3]:[0x41,0xFF,0xE3],B);
  v.setUint32(DATA,0x76543210,true);mem.fill(0xCC,STACK-32,STACK);
  for(let i=0;i<32;i++)cpu.reg_xmm32s[i]=Math.imul(i+1,0x91827365)^0xFEDCBA98;
  e.update_state_flags();e.full_clear_tlb();if(!cold&&!mmio){if(kind===3)e.ir_memory_write(DATA,0x76543210,4);else e.ir_memory_read(DATA,4);}
 }
 // Identical overlapping windows may share a trace; the peer is also a side entry.
 const overlap=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync("build/ir-fusion/overlap.wasm")),{e:{...e,m:e.memory}}).exports.f;
 reset(true,0); cpu.reg32[2]=A+3; mem.set([0x40,0xFF,0xE2,0x41,0xFF,0xE3],A);
 overlap(0); const overlap_state=state(),overlap_steps=(w[664>>2]-100)>>>0;
 assert(overlap_steps>8);
 reset(true,0); cpu.reg32[2]=A+3; mem.set([0x40,0xFF,0xE2,0x41,0xFF,0xE3],A);
 for(let i=0;i<overlap_steps;i++)e.ir_test_step();assert.deepEqual(overlap_state,state());
 const four=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync("build/ir-fusion/four.wasm")),{e:{...e,m:e.memory}}).exports.f;
 const four_reset=()=>{reset(true,0);cpu.reg32[2]=B;cpu.reg32[3]=B+0x2000;cpu.reg32[6]=B+0x4000;cpu.reg32[7]=A;
  [[0x40,0xFF,0xE2],[0x41,0xFF,0xE3],[0x45,0xFF,0xE6],[0x40,0xFF,0xE7]].forEach((code,i)=>mem.set(code,A+i*0x2000));};
 four_reset();four(0);const four_state=state(),four_steps=(w[664>>2]-100)>>>0;assert(four_steps>24&&four_steps<=32,"four-source activation is bounded and crosses the cycle repeatedly");
 four_reset();for(let i=0;i<four_steps;i++)e.ir_test_step();assert.deepEqual(four_state,state());
 const interior=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync("build/ir-fusion/four-interior.wasm")),{e:{...e,m:e.memory}}).exports.f;
 four_reset();cpu.reg32[7]=A+1;interior(0);
 const interior_state=state(),interior_steps=(w[664>>2]-100)>>>0;assert(interior_steps>24&&interior_steps<=32);
 four_reset();cpu.reg32[7]=A+1;for(let i=0;i<interior_steps;i++)e.ir_test_step();assert.deepEqual(interior_state,state());
 let helper_comparisons=0;
 for(const mode of [false,true]) for(const count of [3,4]) for(const simd of [false,true]) for(const opt of [false,true]) for(const budget of [1,2,3,4,7,32]) for(const fault of [false,true]) {
  const configure=()=>{
   reset(mode,0,{count:0xFFFFFFFC});const base=mode?0:0xFF000;
   cpu.reg32[2]=B-base;cpu.reg32[3]=B+0x2000-base;cpu.reg32[6]=B+0x4000-base;cpu.reg32[7]=A-base;
   for(let i=0;i<count;i++)mem.set([[0x40,0x41,0x45,0x40][i],...(simd?[0xF3,0x0F,0x51,0xC0]:[0xFA]),0xFF,[0xE2,0xE3,count===3?0xE7:0xE6,0xE7][i]],A+i*0x2000);
   cpu.reg_xmm32s[0]=0x40800000;cpu.cr[0]=cpu.cr[0]&~12|(simd&&fault?8:0);
   if(!simd&&fault)words_cpl(3);
   v.setUint32(0x12000,v.getUint32(0x12000,true)|4,true);
   for(let i=0;i<count;i++)v.setUint32(0x13000+((A+i*0x2000)>>>12)*4,(A+i*0x2000)|7,true);
   e.full_clear_tlb();
   const handler=0x180000;cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
   for(const vector of [7,13]){v.setUint32(0x2000+vector*8,8<<16|handler&65535,true);v.setUint32(0x2004+vector*8,handler&0xFFFF0000|0x8E00,true);}
   // Ring-3 CLI uses the standard ring-0 TSS stack.
   cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;
   v.setUint32(0x4004,STACK,true);v.setUint32(0x4008,16,true);e.update_state_flags();
  };
  function words_cpl(cpl){w[612>>2]=cpl;cpu.sreg[1]=8|cpl;cpu.sreg[2]=16|cpl;}
  const f=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-fusion/helpers-${mode}-${count}-${simd}-${opt}-${budget}.wasm`)),{e:{...e,m:e.memory}}).exports.f;
  configure();f(0);const actual=state(),steps=(w[664>>2]-0xFFFFFFFC)>>>0;
  assert(steps<=budget);if(!fault&&budget===32)assert(steps>count*3,"audited helpers retain state across the complete cycle");
  configure();for(let i=0;i<steps+(actual.ip===0x180000?1:0);i++)e.ir_test_step();
  assert.deepEqual(actual,state(),`helper fusion ${mode}/${count}/${simd}/${opt}/${budget}/${fault}`);helper_comparisons++;
 }
 console.log(`PASS: ${helper_comparisons} three/four-source CLI/SSE helper comparisons with faults, budgets, count wrap and state retention`);
 cpu.cr[0]&=~12;
 let comparisons=0,retained=0;
 for(const mode of [false,true]) for(let kind=0;kind<4;kind++) for(const optimize of [false,true]) for(const budget of [1,2,3,4,7,32]){
  const f=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-fusion/${mode}-${kind}-${optimize}-${budget}.wasm`)),{e:{...e,m:e.memory}}).exports.f;
  for(const cold of [false,true]) for(const miss of [false,true]) for(const lazy of [false,true]) for(const count of [100,0xFFFFFFFC]){
   const opts={cold,miss,lazy,count};reset(mode,kind,opts);f(0);const actual=state(),n=(w[664>>2]-count)>>>0;
   assert(n<=budget,`bounded count ${mode}/${kind}/${optimize}/${budget}: ${n}`);
   if(miss&&budget>=3)assert.equal(n,2,"prediction miss exits after the jump");
   if(!miss&&!cold&&budget===32){assert(n>8,"one activation must retain state through repeated region transitions");retained++;}
   reset(mode,kind,opts);for(let i=0;i<n;i++)e.ir_test_step();
   assert.deepEqual(actual,state(),`fusion mode=${mode},kind=${kind},opt=${optimize},budget=${budget},${JSON.stringify(opts)}`);comparisons++;
  }
 }
 // An observing memory callback may alter captured code without cache notifications.
 // The admission epoch must force a precise exit before another guest instruction.
 let callbacks=0;
 cpu.io.mmap_register(0xA0000,0x20000,()=>0,()=>{},()=>{callbacks++;mem[A]=0x48;return 0x76543210;},()=>{});
 for(const optimize of [false,true]){
  const f=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-fusion/true-1-${optimize}-32.wasm`)),{e:{...e,m:e.memory}}).exports.f;
  reset(true,1,{mmio:true});callbacks=0;f(0);
  assert.equal(callbacks,1);assert.equal(w[664>>2],103);assert.equal(cpu.instruction_pointer[0]>>>0,B+2);
  assert.equal(cpu.reg32[0]>>>0,0x80000000);assert.equal(cpu.reg32[1]>>>0,0x76543210);assert.equal(cpu.reg32[7]>>>0,0xFEDCBA98);
  // Fault in the peer must expose preceding source state, not the cold-entry state.
  reset(true,1,{cold:true});const HANDLER=0x180000;
  cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
  v.setUint32(0x2000+14*8,8<<16|HANDLER&65535,true);v.setUint32(0x2004+14*8,HANDLER&0xFFFF0000|0x8E00,true);
  v.setUint32(0x13000+(DATA>>>12)*4,0,true);e.full_clear_tlb();f(0);
  const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(actual.cr2,DATA);assert.equal(w[664>>2],102);
  reset(true,1,{cold:true});for(let i=0;i<3;i++)e.ir_test_step();assert.deepEqual(actual,state(),"peer #PF restores carried state and exact frame");
  v.setUint32(0x13000+(DATA>>>12)*4,DATA|3,true);e.full_clear_tlb();
 }
 // Both physical code dependencies, including a distinct virtual alias of the peer,
 // must take the committing store exit before any subsequent compiled instruction.
 for(const optimize of [false,true]) for(const target of [A,B,0x114000]){
  reset(true,3);cpu.reg32[6]=target;
  if(target===0x114000)v.setUint32(0x13000+(target>>>12)*4,B|3,true);
  e.full_clear_tlb();e.ir_memory_write(target,mem[target===A?A:B],1);
  const f=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-fusion/true-3-${optimize}-32.wasm`)),{e:{...e,m:e.memory}}).exports.f;
  f(0);assert.equal(w[664>>2],103);assert.equal(cpu.instruction_pointer[0]>>>0,B+3);
  assert.equal(cpu.reg32[7]>>>0,0xFEDCBA98);assert.equal(mem[target===A?A:B],0x90);
  v.setUint32(0x13000+(target>>>12)*4,target|3,true);e.full_clear_tlb();
 }
 console.log(`PASS: ${comparisons} fused/interpreter comparisons; ${retained} repeated state-retaining executions, guarded prediction misses, 16/32-bit, GPR/FLAGS/XMM, count wrap, cold/warm RAM, callback code mutation, peer #PF and source/alias stores`);
} finally {await vm.destroy();}
