import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-cpu-system/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-cpu-system/${i}-${opt}.wasm`))));
let cpu,e,events=[],controlled=false,on_timer;
const observe=(kind,args=[])=>events.push({kind,args,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,halt:cpu.in_hlt[0]});
const vm=new V86({wasm_fn:async imports=>{for(const name of ["microtick","run_hardware_timers","cpu_event_halt","stop_idling"]){const original=imports.env[name];imports.env[name]=(...args)=>{if(!controlled) return original(...args);observe(name,args);if(name==="microtick") return 1000.25;if(name==="run_hardware_timers"){on_timer?.();return 1000.25;} };} return (await WebAssembly.instantiate(fs.readFileSync("build/v86-ir-test.wasm"),imports)).instance.exports;},memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));cpu=vm.v86.cpu;e=cpu.wm.exports;const mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true),set16=(a,n)=>v.setUint16(a,n,true);
    vm.run();const deadline=performance.now()+10000;while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,STACK=0x90000,HANDLER=0x180000,cr0=cpu.cr[0],cr4=cpu.cr[4],transfer=op=>op===0xF34||op===0xF35;
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:{...e,m:e.memory}})));
    controlled=true;
    function desc(n,base,limit,access,flags){set32(0x3000+n*8,limit&65535|base<<16);set32(0x3004+n*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
    function reset(i,{cpl=0,iopl=0,vm86=false,real=false,selector=8,base=0,ss32=true,ts=true,extra=0,interrupt=true,target=0x200000,sp=0x92000,vme=0}={}){
        const [bytes,mode]=cases[i];e.ir_test_set_cr0(real?cr0&~0x80000001:cr0|0x10000);cpu.cr[0]=cpu.cr[0]&~8|(ts?8:0);cpu.cr[4]=cr4|vme;cpu.cr[2]=0xBADF000;
        cpu.segment_offsets.set([0x30000,base,0,0x50000,0x60000,0x70000]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,8|cpl,16|cpl,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B|cpl<<5,0x93|cpl<<5,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=+ss32;words[612>>2]=cpl;
        cpu.reg32.set([0x12345678,sp,target,0x99AABBCC,ss32?STACK:0xABCD9000,0x11223344,0x7FFFFFFF,0xAABBCCDD]);cpu.flags[0]=0x8D7|(interrupt?0x200:0)|iopl<<12|(vm86?0x20000:0)|extra;cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.instruction_pointer[0]=base+PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        words[636>>2]=selector;words[640>>2]=sp;words[644>>2]=target;
        desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0,0xFFFFF,0xFB,12);desc(4,0,0xFFFFF,0xF3,12);desc(5,0x4000,0x67,0x89,0);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;
        cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const vector of [13,14,0x20]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13007);for(const p of [2,3,4,8,0x18,0x90,0x92,0x200])set32(0x13000+p*4,p*4096|([8,0x18,0x92,0x200].includes(p)?7:3));
        if(real){cpu.stack_size_32[0]=0;cpu.reg32[4]=0xABCD9000;set16(13*4,0x1800);set16(2+13*4,0);cpu.idtr_size[0]=0x3FF;}
        mem.fill(0xCC,STACK-128,STACK+16);mem.fill(0xCC,0x8F80,0x9010);mem.fill(0xCC,0x91F80,0x92010);mem.set(bytes,base+PC);e.full_clear_tlb();e.update_state_flags();events=[];on_timer=undefined;
    }
    const state=()=>({halt:cpu.in_hlt[0],regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,previous:words[560>>2],cr:Array.from(cpu.cr,x=>x>>>0),cpl:words[612>>2]&255,mode:cpu.is_32[0],ss32:cpu.stack_size_32[0],cached:words[108>>2],sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),limit:Array.from(cpu.segment_limits.slice(0,6),x=>x>>>0),access:Array.from(cpu.segment_access_bytes.slice(0,6)),null:Array.from(cpu.segment_is_null.slice(0,6)),sysenter:Array.from(words.slice(636>>2,(644>>2)+1)),frames:[STACK-128,0x8F80,0x91F80].map(a=>Buffer.from(mem.slice(a,a+144)))});
    const caught=f=>{try {f();return false;} catch(error){assert(error instanceof WebAssembly.RuntimeError);return true;}};
    function compare(i,configure,count=102,abort=false){configure();assert.equal(caught(()=>instances[i][0].exports.f(0)),abort);assert.equal(words[664>>2],count);const actual=state(),observed=events.slice();if(transfer(cases[i][2])&&count===102)assert.equal(words[620>>2],0xFFFFFFFF);configure();e.ir_test_step();assert.equal(caught(()=>e.ir_test_step()),abort);assert.deepEqual(actual,state(),`system CPU ${i}`);assert.deepEqual(observed,events);configure();assert.equal(caught(()=>instances[i][1].exports.f(0)),abort);assert.equal(words[664>>2],count);assert.deepEqual(state(),actual);assert.deepEqual(events,observed);return actual;}
    for(const mode of [false,true]) for(const opt of [0,1]) for(const fault of [false,true]) {
        const i=cases.findIndex(c=>c[1]===mode&&c[2]===0xFA);
        const configure=()=>{reset(i,{cpl:fault?3:0});mem.set([0x46,0xFA,0x43],PC);};
        const f=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-cpu-system/cli-${mode}-${opt}.wasm`)),{e:{...e,m:e.memory,ir_cli_check:()=>{
            assert.equal(cpu.reg32[6]>>>0, fault ? (mode?0x80000000:0x7FFF0000) : 0x7FFFFFFF, "CLI guarded synchronization");
            return e.ir_cli_check();
        }}}).exports.f;
        configure();f(0);const actual=state();assert.equal(words[664>>2],fault?101:103);
        configure();for(let n=0;n<(fault?2:3);n++)e.ir_test_step();assert.deepEqual(actual,state(),"CLI continues only after privilege success");
    }
    let ordinary=0;
    for(let i=0;i<cases.length;i++) for(const ss32 of [false,true]) for(const base of [0,0x10000]) for(const ts of [false,true]){
        const actual=compare(i,()=>reset(i,{ss32,base,ts})),op=cases[i][2];
        if(transfer(op)){assert.equal(actual.ip,0x200000);assert.equal(actual.regs[4],0x92000);assert.equal(actual.mode,1);assert.equal(actual.ss32,1);assert.equal(actual.cpl,op===0xF34?0:3);assert.equal(actual.base[1],0);assert.equal(actual.base[2],0);assert.equal(actual.sreg[1],op===0xF34?8:0x1B);assert.equal(actual.sreg[2],op===0xF34?16:0x23);if(op===0xF34)assert.equal(actual.flags&0x20200,0);}
        else {assert.equal(actual.ip,base+PC+cases[i][0].length);if(op===0xFA)assert.equal(actual.flags&0x200,0);if(op===0xF06)assert.equal(actual.cr[0]&8,0);}ordinary++;
    }
    console.log(`PASS: ${ordinary} system state/mode/CS-base/stack-width comparisons in both IR variants`);
    let permissions=0;
    for(let i=0;i<cases.length;i++) for(const cpl of [0,1,2,3]) for(const iopl of [0,1,2,3]) for(const vm86 of [false,true]) for(const vme of [0,3]){
        if(vm86&&(cpl!==3||cases[i][1])) continue;
        const op=cases[i][2],fault=op===0xFA?(vm86?iopl!==3:cpl>iopl):op===0xF34?false:cpl!==0;
        const abort=vm86&&vme!==0&&fault;
        const actual=compare(i,()=>reset(i,{cpl,iopl,vm86,vme}),fault?101:102,abort);if(fault&&!abort){assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);}permissions++;
    }
    console.log(`PASS: ${permissions} CPL/IOPL/VM86/VME/PVI permission and TSS fault-state comparisons`);
    let selectors=0;
    for(let i=0;i<cases.length;i++) if(transfer(cases[i][2])) for(const selector of [0,1,2,3,8,11,0x1234,0xFFFC,0xFFFF]) for(const extra of [0,0x1C0000]){
        const fault=selector<4,actual=compare(i,()=>reset(i,{selector,extra}),fault?101:102);
        if(fault)assert.equal(actual.ip,HANDLER);else {const seg=selector&0xFFFC,exit=cases[i][2]===0xF35;assert.equal(actual.sreg[1],(seg+(exit?16:0)|(exit?3:0))&65535);assert.equal(actual.sreg[2],(seg+(exit?24:8)|(exit?3:0))&65535);}selectors++;
    }
    console.log(`PASS: ${selectors} zero/masked/wrapped SYSENTER selector and extended-FLAGS cases`);
    let real=0;
    for(let i=0;i<cases.length;i++) if(!cases[i][1]) for(const iopl of [0,3]) for(const base of [0,0x10000]){
        const fault=transfer(cases[i][2]),actual=compare(i,()=>reset(i,{real:true,iopl,base}),fault?101:102);if(fault)assert.equal(actual.ip,0x1800);real++;
    }
    console.log(`PASS: ${real} real-mode successes and SYSENTER/SYSEXIT #GP frames`);
    let targets=0;
    for(let i=0;i<cases.length;i++) if(transfer(cases[i][2])) for(const target of [0,0xFFFF,0xFFFFFFFF]) for(const sp of [0,0xFFFF,0xFFFFFFFF]){
        const actual=compare(i,()=>reset(i,{target,sp}));assert.equal(actual.ip,target);assert.equal(actual.regs[4],sp);targets++;
    }
    console.log(`PASS: ${targets} untruncated target EIP/ESP values without premature target access`);
    let next_fault=0;
    for(let i=0;i<cases.length;i++) if(transfer(cases[i][2])) for(const opt of [0,1]){
        const configure=()=>{reset(i,{sp:STACK});set32(0x13000+0x200*4,0);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);assert.equal(words[664>>2],102);assert.equal(cpu.instruction_pointer[0],0x200000);e.ir_test_step();const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(actual.cr[2],0x200000);
        configure();e.ir_test_step();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());next_fault++;
    }
    console.log(`PASS: ${next_fault} post-transfer fetch #PF states after successful commit`);
    let halts=0;
    const port_write=(port,value)=>{const a=cpu.reg32[0];cpu.reg32[0]=value;e.instr_E6(port);cpu.reg32[0]=a;};
    for(let i=0;i<cases.length;i++) if(cases[i][2]===0xF4) for(const interrupt of [false,true]) for(const pending of [false,true]) for(const on_tick of [false,true]){
        const configure=()=>{reset(i,{interrupt});for(const [port,value] of [[0x20,0x11],[0x21,0x20],[0x21,4],[0x21,1],[0x21,0xFE]])port_write(port,value);cpu.device_lower_irq(0);if(pending){cpu.flags[0]&=~0x200;cpu.device_raise_irq(0);if(interrupt)cpu.flags[0]|=0x200;} if(on_tick)on_timer=()=>cpu.device_raise_irq(0);events=[];};
        const actual=compare(i,configure);const delivered=interrupt&&(pending||on_tick);assert.equal(actual.halt,delivered?0:1);assert.equal(actual.ip,delivered?HANDLER:PC+cases[i][0].length);
        assert.deepEqual(events.map(x=>x.kind),interrupt?["microtick","run_hardware_timers",...(delivered?["stop_idling"]:[])]:["cpu_event_halt"]);for(const event of events){assert.equal(event.halt,1);assert.equal(event.ip,PC+cases[i][0].length);}
        cpu.device_lower_irq(0);port_write(0x21,0xFF);halts++;
    }
    console.log(`PASS: ${halts} HLT IF/halt-event/timer/PIC delivery sequences with exact observer state`);
    // Successful SYSENTER/SYSEXIT build fixed segment caches, without reading
    // descriptor tables even when their pages would fault or invoke a device.
    const physical=a=>[0x3000,0x2000,0x4000][a-0xA0000>>>12]+(a&4095);
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("read8",[a]);return mem[physical(a)];},(a,n)=>{observe("write8",[a,n]);mem[physical(a)]=n;},a=>{observe("read32",[a]);return get32(physical(a))|0;},(a,n)=>{observe("write32",[a,n]);set32(physical(a),n);});
    let descriptors=0;
    for(let i=0;i<cases.length;i++) if(transfer(cases[i][2])) for(const pte of [0,0xA0003]){
        compare(i,()=>{reset(i);set32(0x13000+3*4,pte);e.full_clear_tlb();});assert.deepEqual(events,[]);descriptors++;
    }
    console.log(`PASS: ${descriptors} successful system transfers without descriptor memory accesses`);
    let fault_observers=0;
    for(let i=0;i<cases.length;i++){
        const actual=compare(i,()=>{reset(i,{cpl:3,selector:0});set32(0x13000+3*4,0xA0003);set32(0x13000+2*4,0xA1003);set32(0x13000+4*4,0xA2003);e.full_clear_tlb();},101);assert.equal(actual.ip,HANDLER);assert(events.some(x=>x.kind==="read32"));assert(!events.some(x=>["microtick","run_hardware_timers","cpu_event_halt"].includes(x.kind)));fault_observers++;
    }
    console.log(`PASS: ${fault_observers} #GP descriptor/IDT/TSS MMIO sequences with exact observer state`);
} finally {controlled=false;await vm.destroy();}
