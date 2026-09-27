import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-descriptor/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-descriptor/${i}-${opt}.wasm`))));
for(const release of [false,true]){
const vm=new V86({wasm_path:release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),raw=new Uint8Array(e.memory.buffer);
    const v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true),set16=(a,n)=>v.setUint16(a,n,true),get16=a=>v.getUint16(a,true);
    vm.run();const deadline=performance.now()+10000;while(get16(0x500)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,BASE=0x310000,STACK=0x90000,GP=0x180000,UD=0x180100,PF=0x180200,cr0=cpu.cr[0],cr4=cpu.cr[4];let target=BASE+0x40,events=[],on_event,calls=0;
    const imports={...e,m:e.memory};for(const name of ["ir_sgdt","ir_sidt","ir_lgdt","ir_lidt","ir_smsw_mem","ir_smsw_reg","ir_lmsw_mem","ir_lmsw_reg","ir_invlpg","ir_descriptor_ud"])imports[name]=(...args)=>{calls++;return e[name](...args);};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    const illegal=c=>c[5]<8&&![4,6].includes(c[4]),writing=c=>c[5]>=8&&[0,1,4].includes(c[4]);
    function desc(n,base,limit,access,flags){set32(0x3000+n*8,limit&65535|base<<16);set32(0x3004+n*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
    function reset(i,{offset=0x40,value=0x89ABCDEF,cpl=0,real=false,vm86=false,csbase=0}={}){
        const c=cases[i],[bytes,mode,width,asize,group,operand,seg]=c;cpu.cr[4]=cr4;e.ir_test_set_cr0(real?cr0&~0x80000001:cr0|0x10000);cpu.cr[2]=0xBADF000;
        cpu.segment_offsets.set([BASE,csbase,0,BASE,BASE,BASE]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,cpl?0x1B:8,cpl?0x23:16,16,16,16]);cpu.segment_access_bytes.set([0x93,cpl?0xFB:0x9B,cpl?0xF3:0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=cpl;
        cpu.reg32.set([0x7FFFFFFF,0x12345678,0x89ABCDEF,offset,STACK,0x55555555,offset,0x77777777]);if(group===6&&operand<8)cpu.reg32[operand]=operand===0?(mode?value-1:(value&0xFFFF0000)|((value-1)&65535)):value;
        cpu.flags[0]=0x8D7|(vm86?0x20000:0);cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.instruction_pointer[0]=csbase+PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0,0xFFFFF,0xFB,12);desc(4,0,0xFFFFF,0xF3,12);desc(5,0x4000,0x67,0x89,0);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const [vector,handler] of [[6,UD],[13,GP],[14,PF]]){set32(0x2000+vector*8,8<<16|handler&65535);set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13007);for(const p of [0,2,3,4,8,0x18,0x90,0x310,0x311,0x31F,0x320,0x350])set32(0x13000+p*4,p*4096|([0,8,0x18,0x310,0x311,0x31F,0x320,0x350].includes(p)?7:3));
        if(real){cpu.stack_size_32[0]=0;if(!(group===6&&operand===4))cpu.reg32[4]=0xABCD9000;set16(6*4,0x1810);set16(6*4+2,0);set16(13*4,0x1800);set16(13*4+2,0);}
        target=(cpu.segment_offsets[seg<0?3:seg]+(asize===16?offset&65535:offset))>>>0;mem.fill(0xCC,target-16,target+32);set16(target,value&65535);set32(target+2,value);mem.fill(0xCC,STACK-128,STACK+16);mem.fill(0xCC,0x8F80,0x9010);mem.set(bytes,csbase+PC);e.full_clear_tlb();e.update_state_flags();events=[];calls=0;on_event=undefined;
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,previous:words[560>>2],cr:Array.from(cpu.cr,x=>x>>>0),protected:raw[800],cpl:words[612>>2]&255,mode:cpu.is_32[0],ss32:cpu.stack_size_32[0],cached:raw[108],sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),access:Array.from(cpu.segment_access_bytes.slice(0,6)),tables:[cpu.gdtr_size[0],cpu.gdtr_offset[0]>>>0,cpu.idtr_size[0],cpu.idtr_offset[0]>>>0],data:Buffer.from(mem.slice(target-16,target+32)),frames:[STACK-128,0x8F80].map(a=>Buffer.from(mem.slice(a,a+144)))});
    const caught=f=>{try {f();return false;} catch(error){assert(error instanceof WebAssembly.RuntimeError);return true;}};
    function compare(i,configure,count=102,abort=false,after){configure();assert.equal(caught(()=>instances[i][0].exports.f(0)),abort);assert.equal(words[664>>2],count);const actual_after=after?.(),actual=state(),observed=events.slice(),n=calls;configure();e.ir_test_step();assert.equal(caught(()=>e.ir_test_step()),abort);assert.deepEqual(after?.(),actual_after);assert.deepEqual(actual,state(),`descriptor ${i}`);assert.deepEqual(observed,events);configure();assert.equal(caught(()=>instances[i][1].exports.f(0)),abort);assert.equal(words[664>>2],count);assert.deepEqual(after?.(),actual_after);assert.deepEqual(state(),actual);assert.deepEqual(events,observed);assert.equal(calls,n);return actual;}
    let ordinary=0;
    for(let i=0;i<cases.length;i++){const c=cases[i],[bytes,mode,width,asize,group,operand]=c;for(const value of [0,0x89ABCDEF]){
        const bad=illegal(c),actual=compare(i,()=>reset(i,{value}),bad?101:102);assert.equal(actual.ip,bad?UD:PC+bytes.length);
        if(!bad){if(group===2||group===3){const slot=group===2?0:2;assert.equal(actual.tables[slot],value&65535);assert.equal(actual.tables[slot+1],width===16?value&0xFFFFFF:value);} if(group===0||group===1){assert.equal(get16(target),group===0?47:0x7FF);assert.equal(get32(target+2),group===0?0x3000:0x2000);} if(group===4){if(operand>=8){assert.equal(get16(target),actual.cr[0]&65535);assert.equal(get32(target+2),value);} else assert.equal(width===32?actual.regs[operand]:actual.regs[operand]&65535,width===32?actual.cr[0]:actual.cr[0]&65535);} if(group===6)assert.equal(actual.cr[0]&15,(value&15)|1);}ordinary++;
    }}
    console.log(`PASS (${release?"release":"debug"}): ${ordinary} descriptor/system-word CPU comparisons across widths, addresses, overrides and repeats`);
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[7]===0&&(c[5]===0||c[5]===8));
    let permissions=0;
    for(const [c,i] of selected) for(const cpl of [0,3]) for(const vm86 of [false,true]){if(vm86&&(cpl!==3||c[1])) continue;const fault=illegal(c)||cpl!==0&&[2,3,6,7].includes(c[4]);const actual=compare(i,()=>reset(i,{cpl,vm86}),fault?101:102);if(fault)assert.equal(actual.ip,illegal(c)?UD:GP);permissions++;}
    console.log(`PASS (${release?"release":"debug"}): ${permissions} CPL/VM86 and illegal-register #UD priority cases`);
    let memory_faults=0;
    for(const [c,i] of selected) if(c[5]===8) for(const offset of [0xFFD,0xFFE,0xFFF,0x1000]) for(const cpl of [0,3]){
        const permission=cpl!==0&&[2,3,6,7].includes(c[4]),fault=permission||c[4]!==7&&(c[4]<4||offset>=0xFFF),configure=()=>{reset(i,{offset,cpl});set32(0x13000+0x311*4,0);e.full_clear_tlb();};
        const actual=compare(i,configure,fault?101:102);if(fault)assert.equal(actual.ip,permission?GP:PF);if(writing(c)&&fault)assert.equal(get16(target),0xCDEF);memory_faults++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${memory_faults} preflight/read/write page boundaries and permission-before-data faults`);
    let segments=0;
    for(let i=0;i<cases.length;i++){const c=cases[i];if(c[5]<8||c[7]!==0||[1,2].includes(c[6])) continue;const seg=c[6]<0?3:c[6];for(const cpl of [0,3]){const actual=compare(i,()=>{reset(i,{cpl});cpu.segment_is_null[seg]=1;e.update_state_flags();},101);assert.equal(actual.ip,GP);assert.equal(calls,0);segments++;}}
    console.log(`PASS (${release?"release":"debug"}): ${segments} null-segment checks before terminal helper entry`);
    let tails=0,masks=0;
    for(const [c,i] of selected) if(c[5]===8) for(const offset of [0xFFFC,0xFFFE,0xFFFF]){compare(i,()=>reset(i,{offset}));tails++;}
    for(const [c,i] of selected) if(c[5]===8&&c[4]<2) for(const base of [0xFFFFFF,0xAB123456,0xFFFFFFFF]){
        compare(i,()=>{reset(i);if(c[4]===0){cpu.gdtr_size[0]=0xBEEF;cpu.gdtr_offset[0]=base;} else {cpu.idtr_size[0]=0xBEEF;cpu.idtr_offset[0]=base;}});assert.equal(get16(target),0xBEEF);assert.equal(get32(target+2),c[2]===16?base&0xFFFFFF:base);masks++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${tails} linear descriptor tails at address16 boundaries and ${masks} table-base masks`);
    const observe=(kind,a,value)=>{events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,tables:[cpu.gdtr_size[0],cpu.gdtr_offset[0]>>>0,cpu.idtr_size[0],cpu.idtr_offset[0]>>>0]});on_event?.(kind,a,value);};
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return mem[BASE+(a&4095)];},(a,n)=>{observe("w8",a,n);mem[BASE+(a&4095)]=n;},a=>{observe("r32",a);return get32(BASE+(a&4095))|0;},(a,n)=>{observe("w32",a,n>>>0);set32(BASE+(a&4095),n);});
    let devices=0,remaps=0,late_faults=0,field_reads=0;
    for(const [c,i] of selected) if(c[5]===8){
        const configure=()=>{reset(i);set32(0x13000+0x310*4,0xA0003);e.full_clear_tlb();};compare(i,configure);assert.equal(events.length===0,c[4]===7);devices++;
        if(c[4]<4){
            const setup=(fail,changeTable=false)=>{reset(i,{offset:0xFFE});set32(0x13000+0x310*4,0xA0003);set32(0x350000,0x76543210);e.full_clear_tlb();let n=0;on_event=()=>{if(++n===2){if(changeTable){if(c[4]===0)cpu.gdtr_offset[0]=0x76543210;else cpu.idtr_offset[0]=0x76543210;} else {set32(0x13000+0x311*4,fail?0:0x350003);e.full_clear_tlb();}}};};
            const extra=()=>get32(0x350000);compare(i,()=>setup(false),102,false,extra);remaps++;
            compare(i,()=>setup(true),101,c[4]<2,extra);late_faults++;
            if(c[4]<2){compare(i,()=>setup(false,true));assert.equal(get32(BASE+0x1000),c[2]===16?0x543210:0x76543210);field_reads++;}
        }
    }
    console.log(`PASS (${release?"release":"debug"}): ${devices} MMIO, ${remaps} callback remaps, ${late_faults} late faults/aborts, ${field_reads} delayed table-base reads`);
    let real=0;
    for(const [c,i] of selected) if(!c[1]) for(const value of [0,1,15,0xFFFF]){const bad=illegal(c),actual=compare(i,()=>reset(i,{real:true,value}),bad?101:102);if(bad)assert.equal(actual.ip,0x1810);if(c[4]===6)assert.equal(actual.protected,value&1);real++;}
    console.log(`PASS (${release?"release":"debug"}): ${real} real-mode descriptor operations and LMSW protected-mode entry`);
    let invalidation=0;
    for(const [c,i] of selected) if(c[4]===7&&c[5]===8) for(const global of [false,true]){
        const read=a=>Number(e.ir_memory_read(a,4)&0xFFFFFFFFn),configure=()=>{reset(i);cpu.cr[4]|=0x80;set32(0x13000+0x310*4,0x350003|(global?0x100:0));set32(0x350000+0x40,0xA11D);set32(BASE+0x40,0xB22D);set32(0x311040,0xC33D);e.full_clear_tlb();assert.equal(read(BASE+0x40),0xA11D);assert.equal(read(BASE+0x1040),0xC33D);set32(0x13000+0x310*4,0x310003);set32(0x13000+0x311*4,0);};
        compare(i,configure,102,false,()=>{const a=read(BASE+0x40),b=read(BASE+0x1040);assert.equal(a,0xB22D);assert.equal(b,0xC33D);return [a,b];});invalidation++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${invalidation} INVLPG warmed/global target invalidations with adjacent TLB entry retention`);
} finally {await vm.destroy();}
}
