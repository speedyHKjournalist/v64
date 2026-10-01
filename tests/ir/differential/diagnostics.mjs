import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const wasm=process.argv[2]||"build/v86-ir-cache-test.wasm";
let clock_observer=null,rdtsc_active=false;
const vm=new V86({graphics_adapter: "bochs_vga", wasm_fn:async imports=>{
 const tick=imports.env.microtick;
 imports.env.microtick=()=>{if(rdtsc_active)clock_observer?.();return tick();};
 return (await WebAssembly.instantiate(fs.readFileSync(wasm),imports)).instance.exports;
},memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
 await new Promise(r=>vm.add_listener("emulator-loaded",r));
 const cpu=vm.v86.cpu,e=cpu.wm.exports,PC=0x100000,DATA=0x110000,STACK=0x90000;
 const words=()=>new Uint32Array(e.memory.buffer),v=()=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset);
 const until=async(test)=>{const end=performance.now()+15000;while(!test()){assert(performance.now()<end,"timeout");await sleep(1);}};
 vm.run();await until(()=>v().getUint16(0x500,true)===0xCAFE);await vm.stop();
 assert.throws(()=>vm.configure_ir_diagnostics(3),RangeError);assert.equal(e.ir_diagnostic_config(3),0);
 let imported=false;const instantiate=WebAssembly.instantiate;
 WebAssembly.instantiate=(code,imports)=>{
  imported=WebAssembly.Module.imports(new WebAssembly.Module(code)).some(i=>i.name==="ir_diagnostic_begin");
  const rdtsc=imports.e?.ir_rdtsc_continue;
  if(rdtsc)imports={...imports,e:{...imports.e,ir_rdtsc_continue:(...args)=>{
   rdtsc_active=true;try {return rdtsc(...args);} finally {rdtsc_active=false;}
  }}};
  return instantiate(code,imports);
 };
 const prepare=async(period,code)=>{
  await vm.stop();assert.equal(e.ir_auto_config(0,2,4,192,256,64),1);
  assert.equal(await vm.configure_ir_diagnostics(period),true);
  cpu.in_hlt[0]=0;cpu.segment_offsets.fill(0,0,6);cpu.flags[0]=2;cpu.flags_changed[0]=0;
  cpu.is_32[0]=1;cpu.stack_size_32[0]=1;cpu.reg32.set([0,4000,0,0,STACK,0,DATA,0]);cpu.instruction_pointer[0]=PC;
  e.update_state_flags();e.full_clear_tlb();vm.write_memory(Uint8Array.from(code),PC);words()[664>>2]=0;
 };
 const run=async()=>{vm.run();await until(()=>!!cpu.in_hlt[0]);await vm.stop();};
 const state=()=>({regs:Array.from(cpu.reg32),flags:e.get_eflags(),ip:cpu.instruction_pointer[0],count:words()[664>>2]});
 const report=()=>vm.get_jit_info().ir.diagnostics;
 const check=()=>{
  const d=report(),tot=d.totals;
  assert.equal(Object.values(d.exits).reduce((n,r)=>n+r.count,0),tot.ir_activations);
  assert.equal(Object.values(d.exits).reduce((n,r)=>n+r.guest_steps,0),tot.ir_steps);
  assert.equal(tot.ir_steps+tot.interpreter_steps,words()[664>>2]);
  assert.equal(d.admission.accepted,tot.ir_activations);assert.equal(tot.instrumentation_errors,0);
  assert.equal(Object.values(d.missing_entries).reduce((a,b)=>a+b,0),d.admission.missing);
  const sum=Object.values(d.timings).reduce((n,r)=>n+r.sampled_ms,0);
  assert(Math.abs(sum-tot.sampled_batch_ms)<0.01,`exclusive timers conserve time: ${sum}/${tot.sampled_batch_ms}`);
  assert.equal(Object.values(d.helper_exits).reduce((n,r)=>n+r.count,0),d.exits.helper_control_or_fault.count+d.exits.helper_yield.count+d.exits.helper_invalidated.count);
  assert.equal(["rdtsc","cpuid","read_cr","write_cr","clts"].reduce((n,k)=>n+d.control_exits[k].count,0),d.helper_exits.cpu_control.count);
  for(const [phase,total] of Object.entries(d.compiler)) {
   const rows=d.compiler_breakdown.map(b=>b.phases[phase]).filter(Boolean);
   assert.equal(rows.reduce((n,r)=>n+r.calls,0),total.calls,`${phase}: classified calls conserve total`);
   assert(Math.abs(rows.reduce((n,r)=>n+r.ms,0)-total.ms)<0.001,`${phase}: classified time conserves total`);
  }
  assert.equal(d.exits.unclassified.count,0,"all executed test exits classified");
  return d;
 };
 const loop=[0x40,0x49,0x75,0xFC,0xF4];
 await prepare(0,loop);assert(await cpu.ir_compile_cached(5,2,1,1,32,8));assert.equal(imported,false);await run();const plain=state();
 let off=report();assert.equal(off.enabled,false);assert.equal(off.totals.cpu_batch_ms,0);assert.equal(off.totals.ir_steps,0);
 await prepare(1,loop);assert(await cpu.ir_compile_cached(5,2,1,1,32,8));assert.equal(imported,true);await run();assert.deepEqual(state(),plain);
 let d=check();assert(d.exits.budget.count>0);assert(d.timings.state_write.sampled_calls>0);assert(d.timings.generated.sampled_ms>0);assert(d.compiler.emit.calls>0);assert(d.publication.calls>0);
 assert.equal(d.totals.batches,d.totals.sampled_batches);
 d.exits.budget.count=-1;assert(report().exits.budget.count>0,"copied snapshot");
 const old_session=d.session;assert(await vm.configure_ir_diagnostics(1));e.ir_diagnostic_publication(old_session,12345,1);assert.equal(report().publication.calls,0,"late publication belongs to its session");
 await prepare(1,[0xC6,0x06,0x90,0x40,0xF4]);assert(await cpu.ir_compile_cached(4,2,1,1,32,8));await run();d=check();assert.equal(d.exits.scalar_store.count,1);assert(d.timings.memory_slow.sampled_calls>0);
 // Device callback cannot reset live timing/exit state or change compiler policy.
 let rejected=0;cpu.io.mmap_register(0xA0000,0x20000,()=>0,()=>{},()=>{rejected+=e.ir_diagnostic_config(0)===0;return 7;},()=>{});
 await prepare(1,[0x8B,0x06,0x40,0xF4]);cpu.reg32[6]=0xA0000;assert(await cpu.ir_compile_cached(3,2,1,1,32,8));await run();d=check();assert.equal(rejected,1);assert.equal(cpu.reg32[0],8);assert(d.timings.memory_slow.sampled_calls>0);
 // A fault in admitted IR must not be counted as a completed slow store/normal exit.
 await prepare(1,[0x8B,0x06,0x40,0xF4]);
 const HANDLER=0x180000;cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
 v().setUint32(0x2000+14*8,8<<16|HANDLER&65535,true);v().setUint32(0x2004+14*8,HANDLER&0xFFFF0000|0x8E00,true);
 vm.write_memory(Uint8Array.of(0xF4),HANDLER);v().setUint32(0x13000+(DATA>>>12)*4,0,true);e.full_clear_tlb();
 assert(await cpu.ir_compile_cached(3,2,1,1,32,8));await run();d=check();assert.equal(d.exits.fault.count,1);assert.equal(d.exits.fault.guest_steps,0);assert.equal(cpu.cr[2]>>>0,DATA);
 v().setUint32(0x13000+(DATA>>>12)*4,DATA|3,true);e.full_clear_tlb();
 // Rejected in-owner continuations keep their semantic family in diagnostics.
 // An observer's XMM mutation must survive without stale SSA writeback.
 for(const [name,code,family] of [["in",[0xE4,0x93],"port_read"],["out",[0xE6,0x93],"port_write"],["rdtsc",[0x0F,0x31],"cpu_control"]]) {
  await prepare(1,[...code,0x43,0xF4]);let observed=0;
  const mutate=()=>{observed++;cpu.reg_xmm32s[0]^=1;return 7;};
  if(name==="in")cpu.io.register_read(0x93,null,mutate);
  else if(name==="out")cpu.io.register_write(0x93,null,mutate);
  else clock_observer=()=>{if(cpu.instruction_pointer[0]===PC+2){clock_observer=null;mutate();}};
  assert(await cpu.ir_compile_cached(3,2,1,1,32,8));await run();clock_observer=null;
  d=check();assert.equal(observed,1);assert.equal(cpu.reg32[3],1);assert.equal(words()[664>>2],3);
  assert.equal(d.helper_exits[family].count,1,`${name}: declined continuation remains classified`);
  if(name==="rdtsc")assert.equal(d.control_exits.rdtsc.count,1);
 }
 // Delayed compilation cannot reinstall diagnostic code after switching off.
 await prepare(1,loop);let resolve,held;
 WebAssembly.instantiate=(code,imports)=>new Promise(r=>{resolve=r;held={code,imports};});
 const pending=cpu.ir_compile_cached(5,2,1,1,32,8);await until(()=>!!held);
 assert(await vm.configure_ir_diagnostics(0));resolve(await instantiate(held.code,held.imports));assert.equal(await pending,false);assert.equal(e.ir_cache_stat(0),0);
 WebAssembly.instantiate=instantiate;
 assert.equal(report().enabled,false);
 console.log(`PASS: ${wasm}: diagnostic off/on exact guest state, no off-mode imports, counter/timer conservation, budget/store/MMIO/fault exits, active rejection, copied snapshots and stale-session publication`);
} finally {await vm.destroy();}
