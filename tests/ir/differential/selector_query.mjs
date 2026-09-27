import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-selector-query/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-selector-query/${i}-${opt}.wasm`))));
for(const release of [false,true]){
const vm=new V86({wasm_path:release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),raw=new Uint8Array(e.memory.buffer);
    const v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true),set16=(a,n)=>v.setUint16(a,n,true),get16=a=>v.getUint16(a,true);
    vm.run();const deadline=performance.now()+10000;while(get16(0x500)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,BASE=0x310000,STACK=0x90000,GP=0x180000,UD=0x180100,PF=0x180200,cr0=cpu.cr[0],cr4=cpu.cr[4];let target=BASE+0x40,events=[],on_event,calls=0;
    const imports={...e,m:e.memory};for(const name of ["ir_lar_reg","ir_lsl_reg","ir_lar_mem","ir_lsl_mem"])imports[name]=(...args)=>{calls++;return e[name](...args);};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    const illegal=c=>c[5]<8&&![4,6].includes(c[4]),writing=c=>c[5]>=8&&[0,1,4].includes(c[4]);
    function desc(n,base,limit,access,flags){set32(0x3000+n*8,limit&65535|base<<16);set32(0x3004+n*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
    function reset(i,{offset=0x40,value=0x30,cpl=0,real=false,vm86=false,csbase=0}={}){
        const c=cases[i],[bytes,mode,width,asize,group,operand,seg]=c;cpu.cr[4]=cr4;e.ir_test_set_cr0(real?cr0&~0x80000001:cr0|0x10000);cpu.cr[2]=0xBADF000;
        cpu.segment_offsets.set([BASE,csbase,0,BASE,BASE,BASE]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,cpl?0x1B:8,cpl?0x23:16,16,16,16]);cpu.segment_access_bytes.set([0x93,cpl?0xFB:0x9B,cpl?0xF3:0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=cpl;
        cpu.reg32.set([0x7FFFFFFF,0x12345678,0x89ABCDEF,offset,STACK,0x55555555,offset,0x77777777]);if(operand<8)cpu.reg32[operand]=operand===0?(mode?value-1:(value&0xFFFF0000)|((value-1)&65535)):value;
        cpu.flags[0]=0x8D7|(vm86?0x20000:0);cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.instruction_pointer[0]=csbase+PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0,0xFFFFF,0xFB,12);desc(4,0,0xFFFFF,0xF3,12);desc(5,0x4000,0x67,0x89,0);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=63;desc(6,0x65000,0x2345,0x93,8);cpu.sreg[7]=0x38;cpu.segment_offsets[7]=0x70000;cpu.segment_limits[7]=0x7F;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const [vector,handler] of [[6,UD],[13,GP],[14,PF]]){set32(0x2000+vector*8,8<<16|handler&65535);set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13007);for(const p of [0,2,3,4,8,0x18,0x90,0x310,0x311,0x31F,0x320,0x350])set32(0x13000+p*4,p*4096|([0,8,0x18,0x310,0x311,0x31F,0x320,0x350].includes(p)?7:3));
        if(real){cpu.stack_size_32[0]=0;if(!(group===6&&operand===4))cpu.reg32[4]=0xABCD9000;set16(6*4,0x1810);set16(6*4+2,0);set16(13*4,0x1800);set16(13*4+2,0);}
        target=(cpu.segment_offsets[seg<0?3:seg]+(asize===16?offset&65535:offset))>>>0;mem.fill(0xCC,target-16,target+32);set16(target,value&65535);set32(target+2,value);mem.fill(0xCC,STACK-128,STACK+16);mem.fill(0xCC,0x8F80,0x9010);mem.set(bytes,csbase+PC);e.full_clear_tlb();e.update_state_flags();events=[];calls=0;on_event=undefined;
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,previous:words[560>>2],cr:Array.from(cpu.cr,x=>x>>>0),protected:raw[800],cpl:words[612>>2]&255,mode:cpu.is_32[0],ss32:cpu.stack_size_32[0],cached:raw[108],sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),access:Array.from(cpu.segment_access_bytes.slice(0,6)),tables:[cpu.gdtr_size[0],cpu.gdtr_offset[0]>>>0,cpu.idtr_size[0],cpu.idtr_offset[0]>>>0],data:Buffer.from(mem.slice(target-16,target+32)),frames:[STACK-128,0x8F80].map(a=>Buffer.from(mem.slice(a,a+144)))});
    const caught=f=>{try {f();return false;} catch(error){assert(error instanceof WebAssembly.RuntimeError);return true;}};
    function compare(i,configure,count=102,abort=false,after){configure();assert.equal(caught(()=>instances[i][0].exports.f(0)),abort);assert.equal(words[664>>2],count);const actual_after=after?.(),actual=state(),observed=events.slice(),n=calls;configure();e.ir_test_step();assert.equal(caught(()=>e.ir_test_step()),abort);assert.deepEqual(after?.(),actual_after);assert.deepEqual(actual,state(),`selector query ${i}`);assert.deepEqual(observed,events);configure();assert.equal(caught(()=>instances[i][1].exports.f(0)),abort);assert.equal(words[664>>2],count);assert.deepEqual(after?.(),actual_after);assert.deepEqual(state(),actual);assert.deepEqual(events,observed);assert.equal(calls,n);return actual;}
    let ordinary=0;
    for(let i=0;i<cases.length;i++){const c=cases[i],actual=compare(i,()=>reset(i));assert.equal(actual.ip,PC+c[0].length);assert(actual.flags&64);assert.equal(c[2]===16?actual.regs[c[7]]&65535:actual.regs[c[7]],c[4]===2?(c[2]===16?0x9300:0x809300):(c[2]===16?0x5FFF:0x2345FFF));ordinary++;}
    console.log(`PASS (${release?"release":"debug"}): ${ordinary} LAR/LSL operand/destination aliases, widths, addresses and overrides`);
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>[0,8].includes(c[5])&&[0,4].includes(c[7]));
    let guards=0,invalid=0;
    for(const [c,i] of selected){for(const vm86 of [false,true]){if(c[1]) continue;const actual=compare(i,()=>reset(i,{cpl:vm86?3:0,real:!vm86,vm86}),101);assert.equal(actual.ip,vm86?UD:0x1810);guards++;} for(const value of [0,1,2,3,0xFFFF]){const actual=compare(i,()=>reset(i,{value}));assert.equal(actual.flags&64,0);invalid++;}}
    console.log(`PASS (${release?"release":"debug"}): ${guards} real/VM86 #UD and ${invalid} null/out-of-table unsuccessful queries`);
    let types=0;
    for(const [c,i] of selected) if(c[1]&&c[2]===32&&c[3]===32&&c[5]===8&&c[7]===0) for(let type=0;type<16;type++) for(let dpl=0;dpl<4;dpl++) for(let rpl=0;rpl<4;rpl++) for(let cpl=0;cpl<4;cpl++) for(const system of [false,true]) for(const present of [false,true]){
        const access=(present?0x80:0)|(dpl<<5)|(system?0:0x10)|type,valid=system? (c[4]===2?[1,2,3,4,5,9,11,12]:[1,2,3,9,11]).includes(type)&&dpl>=cpl&&dpl>=rpl:((type&12)===12||dpl>=cpl&&dpl>=rpl);
        const actual=compare(i,()=>{reset(i,{value:0x30|rpl,cpl});desc(6,0x65000,0xABCDE,access,8);});assert.equal(!!(actual.flags&64),valid);assert.equal(actual.regs[0],valid?(c[4]===2?0x8A0000|access<<8:0xABCDEFFF):0x80000000);types++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${types} independent descriptor type/DPL/RPL/CPL/present/conforming result checks`);
    let source_faults=0,descriptor_faults=0,segments=0;
    for(const [c,i] of selected){if(c[5]===8){const actual=compare(i,()=>{reset(i,{offset:0xFFF,cpl:3});cpu.reg32[4]=0x12348000;set32(0x13000+0x311*4,0);e.full_clear_tlb();},101);assert.equal(actual.ip,PF);assert.equal(actual.regs[4],STACK-24);source_faults++;}
        const actual=compare(i,()=>{reset(i,{value:0x1000,cpl:3});cpu.reg32[4]=0x12348000;mem.copyWithin(0x5000,0x3000,0x3040);cpu.gdtr_offset[0]=0x5000;cpu.gdtr_size[0]=0x10FF;set32(0x13000+5*4,0x5003);set32(0x13000+6*4,0);e.full_clear_tlb();},101);assert.equal(actual.ip,PF);assert.equal(actual.cr[2],0x6000);if(c[7]===4)assert.equal(actual.regs[4],c[2]===16?0x88000:0x12348000);else assert.equal(actual.regs[4],STACK-24);descriptor_faults++;
    }
    for(let i=0;i<cases.length;i++){const c=cases[i];if(c[5]<8||[1,2].includes(c[6])||c[7]!==0) continue;const seg=c[6]<0?3:c[6];const actual=compare(i,()=>{reset(i,{vm86:true,cpl:3});cpu.segment_is_null[seg]=1;e.update_state_flags();},101);assert.equal(actual.ip,GP);assert.equal(calls,0);segments++;}
    console.log(`PASS (${release?"release":"debug"}): ${source_faults} source #PF, ${descriptor_faults} descriptor #PF/post-fault destination writes, ${segments} segment-priority cases`);
    const observe=(kind,a,value)=>{events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});on_event?.(kind,a,value);};
    const physical=a=>(a>=0xA1000?0x3000:BASE)+(a&4095);
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return mem[physical(a)];},(a,n)=>{observe("w8",a,n);mem[physical(a)]=n;},a=>{observe("r32",a);return get32(physical(a))|0;},(a,n)=>{observe("w32",a,n>>>0);set32(physical(a),n);});
    let devices=0,late_original=0,local=0;
    for(const [c,i] of selected){compare(i,()=>{reset(i);if(c[5]===8)set32(0x13000+0x310*4,0xA0003);set32(0x13000+3*4,0xA1003);e.full_clear_tlb();});assert(events.length>0);devices++;
        if(c[5]===8){const actual=compare(i,()=>{reset(i,{value:0});set32(0x13000+0x310*4,0xA0003);e.full_clear_tlb();on_event=()=>{cpu.reg32[c[7]]=0x1234ABCD;};});assert.equal(actual.regs[c[7]],0x1234ABCD);late_original++;}
        const actual=compare(i,()=>{reset(i,{value:0x34});mem.copyWithin(0x70000,0x3000,0x3040);});assert(actual.flags&64);local++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${devices} operand/descriptor MMIO, ${late_original} post-source original-value captures, ${local} LDT lookups`);
} finally {await vm.destroy();}
}
