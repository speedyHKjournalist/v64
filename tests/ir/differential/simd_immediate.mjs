import assert from "node:assert/strict";
import {runSseFixture} from "./debug_sse_fixture.mjs";
import fs from "node:fs";
import {packedImmediate as packed_immediate} from "./packed_model.mjs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-simd-immediate/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-simd-immediate/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const release of [false,true]){
 const vm=new V86({wasm_path:release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
 try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),xmm=new Uint32Array(e.memory.buffer,832,32);
    const v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,BASE=0x310000,ALT=0x350000,STACK=0x90000,UD=0x180100,NM=0x180300,PF=0x180200,GP=0x180000,cr0=cpu.cr[0],cr4=cpu.cr[4];let target,events=[],on_event,slow=0,guards=0;
    const imports={...e,m:e.memory,ir_xmm_binary:(...a)=>{slow++;return e.ir_xmm_binary(...a);},ir_xmm_load:(...a)=>{slow++;return e.ir_xmm_load(...a);},ir_xmm_store:(...a)=>{slow++;return e.ir_xmm_store(...a);},ir_sse_guard:()=>{guards++;return e.ir_sse_guard();}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    const extra=name=>[0,1].map(opt=>new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-simd-immediate/${name}-${opt}.wasm`)),{e:imports}));
    const chain=extra("chain"),resume=extra("resume"),chain_bytes=JSON.parse(fs.readFileSync("build/ir-simd-immediate/chain.json"));
    const visible=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),xmm:Array.from(xmm),flags:e.get_eflags()>>>0,rawZero:cpu.flags[0]&64,zeroLazy:cpu.flags_changed[0]&64,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0});
    const state=()=>({...visible(),previous:words[560>>2],cr:Array.from(cpu.cr,x=>x>>>0),cpl:words[612>>2]&255,sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),data:Buffer.from(mem.slice(target-16,target+32)),alternate:Buffer.from(mem.slice(ALT,ALT+0x1020)),frame:Buffer.from(mem.slice(STACK-128,STACK+16))});
    function desc(n,base,access){set32(0x3000+n*8,(base<<16)|0xFFFF);set32(0x3004+n*8,(base&0xFF000000)|(base>>>16&255)|access<<8|0xCF0000);}
    function reset(i,{offset=0x40,hot=false,cpl=0,task=0,osfxsr=true,real=false,vm86=false}={}){
        const [bytes,mode,asize,,,store,register,operand,seg]=cases[i];
        cpu.cr[4]=osfxsr?cr4|0x200:cr4&~0x200;e.ir_test_set_cr0((real?cr0&~0x80000001:cr0|0x10000)&~12|task);cpu.cr[2]=0xBADF000;
        cpu.segment_offsets.set([BASE,0,0,BASE,BASE,BASE]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,cpl?0x1B:8,cpl?0x23:16,16,16,16]);cpu.segment_access_bytes.set([0x93,cpl?0xFB:0x9B,cpl?0xF3:0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=cpl;
        cpu.reg32.set([0x12345678,0xFEDCBA98,0x89ABCDEF,0x7FFFFFFF,STACK,0x55555555,offset,offset]);
        const bits=[0,0x80000000,0x7F800000,0xFF800000,0x7FC12345,0x7F812345,1,0xFFFFFFFF];for(let r=0;r<8;r++) for(let lane=0;lane<4;lane++)xmm[r*4+lane]=bits[(r+lane)%8];
        cpu.flags[0]=0x8D7|(vm86?0x20000:0);cpu.flags_changed[0]=0;words[104>>2]=0x87654321;cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;mem.set(bytes,PC);
        target=(cpu.segment_offsets[seg<0?3:seg]+(asize===16?offset&65535:offset))>>>0;mem.fill(0xCC,target-16,target+32);[0x80000000,0x7F812345,0xFFFFFFFF,1].forEach((n,l)=>set32(target+l*4,n));mem.fill(0x6D,ALT,ALT+0x1020);mem.fill(0xCC,STACK-128,STACK+16);
        desc(1,0,0x9B);desc(2,0,0x93);desc(3,0,0xFB);desc(4,0,0xF3);desc(5,0x4000,0x89);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const [vector,handler] of [[6,UD],[7,NM],[13,GP],[14,PF]]){set32(0x2000+vector*8,8<<16|handler&65535);set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13007);for(const page of [0,2,3,4,8,0x18,0x8F,0x90,0x310,0x311,0x31F,0x320,0x350,0x351])set32(0x13000+page*4,page*4096|7);
        e.full_clear_tlb();e.update_state_flags();if(hot&&operand>=8){e.ir_memory_write(target,mem[target],1);e.ir_memory_write(target+15,mem[target+15],1);}events=[];on_event=undefined;slow=guards=0;
    }
    const caught=f=>{try {f();return false;} catch(error){assert(error instanceof WebAssembly.RuntimeError);return true;}};
    function compare(i,configure,{fault=false,abort=false,check}={}){
        configure();e.ir_test_step();const before=visible(),data=Array.from({length:4},(_,l)=>get32(target+l*4));assert.equal(caught(()=>e.ir_test_step()),abort);const expected=state(),observed=events.slice();check?.(before,data,expected);
        const counts=[];for(const opt of [0,1]){configure();assert.equal(caught(()=>runSseFixture(instances[i][opt],cpu,e,state,{fault,abort,nextPc:cpu.instruction_pointer[0]+cases[i][0].length})),abort);assert.equal(words[664>>2],fault||abort?101:102);assert.deepEqual(state(),expected,`SSE integer ${i}/${opt}`);assert.deepEqual(events,observed,`events ${i}/${opt}`);counts.push([slow,guards]);} return {expected,observed,counts};
    }
    const model=(c,before,after)=>{
        const expected=before.xmm.slice(),r=c[6];
        expected.splice(r*4,4,...packed_immediate(c[3],c[10],c[9],before.xmm.slice(r*4,r*4+4)));
        assert.deepEqual(after.xmm,expected);assert.deepEqual(after.regs,before.regs);assert.equal(after.flags,before.flags);
    };
    for(let i=0;i<cases.length;i++){
        const {counts}=compare(i,()=>reset(i),{check:(before,_,after)=>model(cases[i],before,after)});
        assert(counts.every(([n,g])=>n===0&&g===0));
    }
    console.log(`PASS (${release?"release":"debug"}): ${cases.length} independent/CPU immediate shifts, all imm8 values and all XMM destinations`);
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[1]&&c[2]===32&&c[6]===0&&[0,1,15,16,31,32,63,64,255].includes(c[9]));
    let randomized=0,tasks=0,modes=0;
    for(const [c,i] of selected){
        for(let seed=0;seed<16;seed++){
            compare(i,()=>{reset(i);let rng=seed+1;for(let n=0;n<32;n++){rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;xmm[n]=rng>>>0;}},{check:(before,_,after)=>model(c,before,after)});randomized++;
        }
        for(const task of [4,8,12]) for(const cpl of [0,3]){
            const {expected,counts}=compare(i,()=>reset(i,{task,cpl}),{fault:true});
            assert.equal(expected.ip,task&4?UD:NM);assert(counts.every(([n,g])=>n===0&&g===1));tasks++;
        }
        for(const option of [{osfxsr:false},{real:true},{vm86:true,cpl:3}]){compare(i,()=>reset(i,option));modes++;}
    }
    console.log(`PASS (${release?"release":"debug"}): ${randomized} randomized immediate vectors, ${tasks} EM/TS guards and ${modes} OSFXSR/real/VM86 cases`);
    const physical=a=>a>=0xA2000?0x3000+(a&4095):BASE+a-0xA0000;
    const observe=(kind,a)=>{events.push({kind,a,state:visible()});on_event?.(kind,a);};
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return mem[physical(a)];},()=>{},a=>{observe("r32",a);return get32(physical(a))|0;},()=>{});
    for(const [c,i] of selected){
        const {observed}=compare(i,()=>{reset(i,{task:4});set32(0x13000+3*4,0xA2007);e.full_clear_tlb();},{fault:true});assert(observed.length>0);
    }
    console.log(`PASS (${release?"release":"debug"}): ${selected.length} pre-immediate guard exception observations`);
    const base_case=cases.findIndex(c=>c[1]&&c[2]===32&&c[3]===0x660F71&&c[6]===0&&c[7]===0);
    const setup_chain=(hot,deviceLoad=false)=>{reset(base_case);cpu.segment_offsets.fill(0,0,6);cpu.reg32[6]=BASE+0x40;cpu.reg32[7]=BASE+0x10040;mem.fill(0xCC,BASE+0x10040,BASE+0x10050);mem.set(chain_bytes,PC);e.full_clear_tlb();if(hot){e.ir_memory_write(BASE+0x40,mem[BASE+0x40],1);e.ir_memory_write(BASE+0x10040,mem[BASE+0x10040],1);} if(deviceLoad){set32(0x13000+0x310*4,0xA0007);e.full_clear_tlb();on_event=kind=>{if(kind.startsWith("r")){xmm[8]=0xDEADBEEF;xmm[24]=0xDEADBEEF;}};}slow=guards=0;events=[];};
    let chains=0;
    for(const hot of [false,true]) for(const device_load of [false,true]){
        const steps=hot&&!device_load?6:3;setup_chain(hot,device_load);for(let n=0;n<steps;n++)e.ir_test_step();const expected=state(),observed=events.slice();for(let n=steps;n<6;n++)e.ir_test_step();const completed=state(),out=Buffer.from(mem.slice(BASE+0x10040,BASE+0x10050));
        for(const opt of [0,1]){setup_chain(hot,device_load);chain[opt].exports.f(0);assert.equal(words[664>>2],100+steps);assert.deepEqual(state(),expected);assert.deepEqual(events,observed);if(steps===3)resume[opt].exports.f(0);assert.equal(words[664>>2],106);assert.deepEqual(state(),completed);assert.deepEqual(Buffer.from(mem.slice(BASE+0x10040,BASE+0x10050)),out);chains++;}
    }
    const setup_fault=()=>{setup_chain(false);set32(0x13000+0x310*4,0);e.full_clear_tlb();};
    setup_fault();for(let n=0;n<3;n++)e.ir_test_step();const faulted=state();assert.equal(faulted.ip,PF);
    for(const opt of [0,1]){setup_fault();chain[opt].exports.f(0);assert.equal(words[664>>2],102);assert.deepEqual(state(),faulted);}
    console.log(`PASS (${release?"release":"debug"}): ${chains} mixed byte-shuffle/unpack/shift/pack SSA and resume chains and 2 dirty-XMM fault exits`);
 } finally {await vm.destroy();}
}
