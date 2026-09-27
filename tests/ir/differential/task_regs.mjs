import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-task-regs/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-task-regs/${i}-${opt}.wasm`))));
for(const release of [false,true]){
const vm=new V86({wasm_path:release?"build/v86-task-reference-release.wasm":"build/v86-task-reference.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),raw=new Uint8Array(e.memory.buffer);
    const v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true),set16=(a,n)=>v.setUint16(a,n,true),get16=a=>v.getUint16(a,true);
    vm.run();const deadline=performance.now()+10000;while(get16(0x500)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,BASE=0x310000,STACK=0x90000,GP=0x180000,UD=0x180100,PF=0x180200,cr0=cpu.cr[0],cr4=cpu.cr[4];let target=BASE+0x40,events=[],on_event,calls=0;
    const imports={...e,m:e.memory};for(const name of ["ir_sldt_mem","ir_str_mem","ir_lldt_mem","ir_ltr_mem","ir_sldt_reg","ir_str_reg","ir_lldt_reg","ir_ltr_reg"])imports[name]=(...args)=>{calls++;return e[name](...args);};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    const writing=c=>c[5]>=8&&c[4]<2;
    function desc(n,base,limit,access,flags){set32(0x3000+n*8,limit&65535|base<<16);set32(0x3004+n*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
    function reset(i,{offset=0x40,value=undefined,cpl=0,real=false,vm86=false,csbase=0}={}){
        const c=cases[i],[bytes,mode,width,asize,group,operand,seg]=c;if(value===undefined)value=group===2?0x30:group===3?0x38:0x89ABCDEF;cpu.cr[4]=cr4;e.ir_test_set_cr0(real?cr0&~0x80000001:cr0|0x10000);cpu.cr[2]=0xBADF000;
        cpu.segment_offsets.set([BASE,csbase,0,BASE,BASE,BASE]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,cpl?0x1B:8,cpl?0x23:16,16,16,16]);cpu.segment_access_bytes.set([0x93,cpl?0xFB:0x9B,cpl?0xF3:0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=cpl;
        cpu.reg32.set([0x7FFFFFFF,0x12345678,0x89ABCDEF,offset,STACK,0x55555555,offset,0x77777777]);if(group>=2&&operand<8)cpu.reg32[operand]=operand===0?(mode?value-1:(value&0xFFFF0000)|((value-1)&65535)):value;
        cpu.flags[0]=0x8D7|(vm86?0x20000:0);cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.instruction_pointer[0]=csbase+PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0,0xFFFFF,0xFB,12);desc(4,0,0xFFFFF,0xF3,12);desc(5,0x4000,0x67,0x89,0);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=63;desc(6,0x50000,0x12345,0x82,0);desc(7,0x60000,0x67,0x89,0);cpu.sreg[7]=0x40;cpu.segment_offsets[7]=0x70000;cpu.segment_limits[7]=0x7F;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const [vector,handler] of [[6,UD],[13,GP],[14,PF]]){set32(0x2000+vector*8,8<<16|handler&65535);set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13007);for(const p of [0,2,3,4,8,0x18,0x90,0x310,0x311,0x31F,0x320,0x350])set32(0x13000+p*4,p*4096|([0,8,0x18,0x310,0x311,0x31F,0x320,0x350].includes(p)?7:3));
        if(real){cpu.stack_size_32[0]=0;if(!(group>=2&&operand===4))cpu.reg32[4]=0xABCD9000;set16(6*4,0x1810);set16(6*4+2,0);set16(13*4,0x1800);set16(13*4+2,0);}
        target=(cpu.segment_offsets[seg<0?3:seg]+(asize===16?offset&65535:offset))>>>0;mem.fill(0xCC,target-16,target+32);set16(target,value&65535);set32(target+2,value);mem.fill(0xCC,STACK-128,STACK+16);mem.fill(0xCC,0x8F80,0x9010);mem.set(bytes,csbase+PC);e.full_clear_tlb();e.update_state_flags();events=[];calls=0;on_event=undefined;
    }
    const state=()=>({tss32:cpu.tss_size_32[0],limits:Array.from(cpu.segment_limits,x=>x>>>0),regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,previous:words[560>>2],cr:Array.from(cpu.cr,x=>x>>>0),protected:raw[800],cpl:words[612>>2]&255,mode:cpu.is_32[0],ss32:cpu.stack_size_32[0],cached:raw[108],sreg:Array.from(cpu.sreg),base:Array.from(cpu.segment_offsets,x=>x>>>0),access:Array.from(cpu.segment_access_bytes),tables:[cpu.gdtr_size[0],cpu.gdtr_offset[0]>>>0,cpu.idtr_size[0],cpu.idtr_offset[0]>>>0],data:Buffer.from(mem.slice(target-16,target+32)),gdt:Buffer.from(mem.slice(0x3000,0x3040)),frames:[STACK-128,0x8F80].map(a=>Buffer.from(mem.slice(a,a+144)))});
    // Only the reference test artifact exports this mutable host-stack global.
    // A trapped activation has ended; retain guest state for comparison, but
    // restore its stack before starting the next independently configured call.
    const host_stack=e.__stack_pointer;assert(host_stack instanceof WebAssembly.Global);
    let stack_repairs=0,max_stack_leak=0;
    const caught=f=>{
        const before=host_stack.value;let trapped=false;
        try {f();return false;}
        catch(error){assert(error instanceof WebAssembly.RuntimeError);trapped=true;return true;}
        finally {
            if(trapped){const lost=before-host_stack.value;assert(lost>=0,"downward host stack");max_stack_leak=Math.max(max_stack_leak,lost);if(lost)stack_repairs++;host_stack.value=before;}
            else assert.equal(host_stack.value,before,"normal Wasm activation restores its stack");
        }
    };
    const report_stack=()=>{assert(stack_repairs>0);console.log(`PASS (${release?"release":"debug"}): ${stack_repairs} isolated host-trap stacks; maximum ${max_stack_leak} bytes restored`);};
    function compare(i,configure,count=102,abort=false,after){configure();assert.equal(caught(()=>instances[i][0].exports.f(0)),abort);assert.equal(words[664>>2],count);const actual_after=after?.(),actual=state(),observed=events.slice(),n=calls;configure();e.ir_test_step();assert.equal(caught(()=>e.ir_test_step()),abort);assert.deepEqual(after?.(),actual_after);assert.deepEqual(actual,state(),`task register ${i}`);assert.deepEqual(observed,events);configure();assert.equal(caught(()=>instances[i][1].exports.f(0)),abort);assert.equal(words[664>>2],count);assert.deepEqual(after?.(),actual_after);assert.deepEqual(state(),actual);assert.deepEqual(events,observed);assert.equal(calls,n);return actual;}
    // Also bound the type matrices with fresh CPU instances; caught() isolates
    // each individual abort regardless of compiler-dependent stack frame size.
    if(process.env.IR_TASK_TYPE_SLICE!==undefined){
        const slice=Number(process.env.IR_TASK_TYPE_SLICE);assert(Number.isInteger(slice)&&slice>=0&&slice<8);let n=0;
        for(let i=0;i<cases.length;i++){const c=cases[i];if(c[4]<2||c[7]!==0||![0,8].includes(c[5])||Number(c[1])*4+Number(c[2]===32)*2+Number(c[3]===32)!==slice) continue;
            for(const type of [1,2,3,9,11]) for(const present of [false,true]) for(const system of [false,true]){const valid=present&&system&&(c[4]===2?type===2:[1,9].includes(type));const actual=compare(i,()=>{reset(i);desc(c[4]===2?6:7,0x65000,0x2345,(present?0x80:0)|(system?0:0x10)|type,8);},valid?102:101,!valid);if(valid){const slot=c[4]===2?7:6;assert.equal(actual.base[slot],0x65000);assert.equal(actual.limits[slot],0x2345FFF);if(c[4]===3)assert.equal(actual.tss32,type===9?1:0);}n++;}
        }
        assert.equal(n,80);console.log(`PASS (${release?"release":"debug"}): ${n} fresh-CPU descriptor type cases, width slice ${slice}`);report_stack();continue;
    }
    let ordinary=0;
    for(let i=0;i<cases.length;i++){const c=cases[i],g=c[4],actual=compare(i,()=>reset(i));assert.equal(actual.ip,PC+c[0].length);
        if(g<2){const value=g===0?0x40:0x28;if(c[5]<8)assert.equal(c[2]===16?actual.regs[c[5]]&65535:actual.regs[c[5]],value);else {assert.equal(get16(target),value);assert.equal(get32(target+2),0x89ABCDEF);}}
        else {const slot=g===2?7:6;assert.equal(actual.sreg[slot],g===2?0x30:0x38);assert.equal(actual.base[slot],g===2?0x50000:0x60000);assert.equal(actual.limits[slot],g===2?0x12345:0x67);if(g===3){assert.equal(actual.tss32,1);assert.equal(mem[0x303D],0x8B);}}ordinary++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${ordinary} task/LDTR widths, operands, prefixes and cache/busy-bit comparisons`);
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[7]===0&&(c[5]===0||c[5]===8));
    let modes=0;
    for(const [c,i] of selected) for(const mode of ["user","real","vm"]){if(mode!=="user"&&c[1]) continue;const fault=mode!=="user"||c[4]>=2;const actual=compare(i,()=>reset(i,{cpl:mode==="real"?0:3,real:mode==="real",vm86:mode==="vm"}),fault?101:102);if(fault)assert.equal(actual.ip,mode==="real"?0x1810:mode==="vm"?UD:GP);modes++;}
    console.log(`PASS (${release?"release":"debug"}): ${modes} protected/real/VM86 permission and #UD-before-#GP cases`);
    let faults=0,segments=0;
    for(const [c,i] of selected) if(c[5]===8) for(const offset of [0xFFF,0x1000]) for(const cpl of [0,3]){const actual=compare(i,()=>{reset(i,{offset,cpl});set32(0x13000+0x311*4,0);e.full_clear_tlb();},101);assert.equal(actual.ip,cpl&&c[4]>=2?GP:PF);faults++;}
    for(let i=0;i<cases.length;i++){const c=cases[i];if(c[5]<8||c[7]!==0||[1,2].includes(c[6])) continue;const seg=c[6]<0?3:c[6];const actual=compare(i,()=>{reset(i,{vm86:true,cpl:3});cpu.segment_is_null[seg]=1;e.update_state_flags();},101);assert.equal(actual.ip,GP);assert.equal(calls,0);segments++;}
    console.log(`PASS (${release?"release":"debug"}): ${faults} operand faults and ${segments} segment-before-mode checks`);
    let nulls=0,types=0;
    for(const [c,i] of selected) if(c[4]>=2){for(const value of [0,1,2,3,0x1000]){const abort=c[4]===3||value===0x1000,actual=compare(i,()=>reset(i,{value}),abort?101:102,abort);if(!abort){assert.equal(actual.sreg[7],value);assert.equal(actual.base[7],0);assert.equal(actual.limits[7],0);}nulls++;}
        if(!(c[1]&&c[2]===32&&c[3]===32)) continue;
        for(const type of [1,2,3,9,11]) for(const present of [false,true]) for(const system of [false,true]){const valid=present&&system&&(c[4]===2?type===2:[1,9].includes(type)),configure=()=>{reset(i);desc(c[4]===2?6:7,0x65000,0x2345,(present?0x80:0)|(system?0:0x10)|type,8);};const actual=compare(i,configure,valid?102:101,!valid);if(valid){const slot=c[4]===2?7:6;assert.equal(actual.base[slot],0x65000);assert.equal(actual.limits[slot],0x2345FFF);if(c[4]===3)assert.equal(actual.tss32,type===9?1:0);}types++;}
    }
    console.log(`PASS (${release?"release":"debug"}): ${nulls} null/outside-table policies and ${types} descriptor type/present/granularity cases`);
    let local_selectors=0;
    for(const [c,i] of selected) if(c[4]>=2&&c[1]&&c[2]===32&&c[3]===32) for(const value of [4,12]){
        const configure=()=>{reset(i,{value});const address=0x70000+(value&~7);set32(address,0x50002345);set32(address+4,(c[4]===2?0x82:0x89)<<8|6);};
        const actual=compare(i,configure,release?102:101,!release);if(release){assert.equal(actual.sreg[c[4]===2?7:6],value);assert.equal(actual.base[c[4]===2?7:6],0x65000);}local_selectors++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${local_selectors} pinned TI-selector debug assertions/release LDT lookup cases`);
    const observe=(kind,a,value)=>{events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,sreg:Array.from(cpu.sreg),base:Array.from(cpu.segment_offsets,x=>x>>>0),limits:Array.from(cpu.segment_limits,x=>x>>>0),tss32:cpu.tss_size_32[0]});on_event?.(kind,a,value);};
    const physical=a=>(a>=0xA1000?0x3000:BASE)+(a&4095);
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return mem[physical(a)];},(a,n)=>{observe("w8",a,n);mem[physical(a)]=n;},a=>{observe("r32",a);return get32(physical(a))|0;},(a,n)=>{observe("w32",a,n>>>0);set32(physical(a),n);});
    let devices=0,read_faults=0,busy_faults=0,remaps=0;
    for(const [c,i] of selected){if(c[5]===8){compare(i,()=>{reset(i);set32(0x13000+0x310*4,0xA0003);if(c[4]>=2)set32(0x13000+3*4,0xA1003);e.full_clear_tlb();});assert(events.length>0);if(c[4]===3){const event=events.find(x=>x.kind==="w8"&&x.a===0xA103D);assert(event);assert.equal(event.sreg[6],0x38);assert.equal(event.base[6],0x60000);}devices++;}
        if(c[4]>=2){for(const readonly of [false,true]){const configure=()=>{reset(i,{value:0x1000});mem.copyWithin(0x5000,0x3000,0x3040);cpu.gdtr_offset[0]=0x5000;cpu.gdtr_size[0]=0x10FF;set32(0x6000,0x67);set32(0x6004,(c[4]===2?0x82:0x89)<<8|6);set32(0x13000+5*4,0x5003);set32(0x13000+6*4,readonly?0x6001:0);e.full_clear_tlb();};const fault=!readonly||c[4]===3,abort=readonly&&c[4]===3,actual=compare(i,configure,fault?101:102,abort);if(fault){assert.equal(actual.ip,PF);assert.equal(actual.cr[2],readonly?0x6005:0x6000);} if(abort){assert.equal(actual.sreg[6],0x1000);assert.equal(actual.base[6],0x60000);busy_faults++;} else read_faults++;}
            compare(i,()=>{reset(i);set32(0x13000+3*4,0xA1003);mem.copyWithin(0x7000,0x3000,0x3040);e.full_clear_tlb();let n=0;on_event=(kind)=>{if(kind==="r32"&&++n===2){set32(0x13000+3*4,0x7003);e.full_clear_tlb();}};},102,false,()=>Buffer.from(mem.slice(0x7000,0x7040)));if(c[4]===3){assert.equal(mem[0x703D],0x8B);assert.equal(mem[0x303D],0x89);}remaps++;
        }
    }
    console.log(`PASS (${release?"release":"debug"}): ${devices} MMIO sequences, ${read_faults} descriptor read/readonly cases, ${busy_faults} post-TR busy-write fault/aborts, ${remaps} descriptor callback remaps`);
    let aliases=0;
    for(const [c,i] of selected) if(c[4]>=2){const actual=compare(i,()=>{reset(i,{value:0xFF8});cpu.gdtr_offset[0]=0x5004;cpu.gdtr_size[0]=0xFFFF;set32(0x5FFC,0x67);set32(0x6000,(c[4]===2?0x82:0x89)<<8|6);set32(0x7000,0xCCCCCCCC);set32(0x13000+5*4,0x5003);set32(0x13000+6*4,0x7003);e.full_clear_tlb();},102,false,()=>[get32(0x6000),get32(0x7000)]);assert.equal(actual.base[c[4]===2?7:6],0x60000);if(c[4]===3){assert.equal(mem[0x6001],0x89);assert.equal(mem[0x7001],0x8B);}aliases++;}
    console.log(`PASS (${release?"release":"debug"}): ${aliases} baseline physical descriptor tails and separately translated busy-byte writes`);
    report_stack();
} finally {await vm.destroy();}
}

if(process.env.IR_TASK_TYPE_SLICE===undefined){
    for(let slice=0;slice<8;slice++){const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,IR_TASK_TYPE_SLICE:String(slice)},stdio:"inherit"});assert.equal(result.status,0,`task type slice ${slice}`);}
}
