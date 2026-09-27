import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-enter/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-enter/${i}-${opt}.wasm`))));
const vm=new V86({wasm_path:"build/v86-ir-test-release.wasm",memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;
    while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const cr0=cpu.cr[0],gdt=[cpu.gdtr_offset[0],cpu.gdtr_size[0]],PC=0x100000,BASE=0x310000,HANDLER=0x180000;
    let reads=0,writes=0,events=[],on_event,windows=[];
    const imports={...e,m:e.memory,ir_memory_write_unmasked_word:(...a)=>{writes++;return e.ir_memory_write_unmasked_word(...a);},ir_memory_read:(...a)=>{reads++;return e.ir_memory_read(...a);},ir_memory_write:(...a)=>{writes++;return e.ir_memory_write(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    const pte=page=>0x13000+page*4;
    function reset(i,ss32,offset=0x80,bpOffset=0x8080,hot=false) {
        const [bytes,mode]=cases[i];on_event=undefined;events=[];
        e.ir_test_set_cr0(cr0|0x10000);cpu.gdtr_offset[0]=gdt[0];cpu.gdtr_size[0]=gdt[1];
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.segment_offsets.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);
        cpu.segment_offsets[2]=ss32?0:BASE;cpu.segment_offsets[4]=0x990000;
        cpu.reg32.set([0x7FFFFFFF,0x12345678,0x89ABCDEF,0x3000,ss32?BASE+offset:(0xABCD0000|offset)>>>0,ss32?BASE+bpOffset:(0x45670000|bpOffset)>>>0,0x76543210,0xFEDCBA98]);
        cpu.is_32[0]=+mode;cpu.stack_size_32[0]=+ss32;words[612>>2]=0;
        cpu.flags[0]=3;cpu.flags_changed[0]=0;cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const v of [13,14]){set32(0x2000+v*8,8<<16|HANDLER&65535);set32(0x2004+v*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);set32(pte(0x100),0x100003);
        for(let page=0x30F;page<=0x340;page++)set32(pte(page),page*4096|3);
        for(let a=0x30F000;a<0x331000;a+=4)set32(a,(a*0x1357)^0xA9876543);
        mem.set(bytes,PC);windows=[[0x30F000,0x22000]];
        e.full_clear_tlb();e.update_state_flags();
        if(hot) for(let a=0x30F000;a<0x331000;a+=4096)e.ir_memory_write(a,mem[a],1);
        reads=writes=0;
    }
    function state(){return {regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,cr2:cpu.cr[2]>>>0,
        cpl:words[612>>2]&255,cs:cpu.sreg[1],ss:cpu.sreg[2],data:windows.map(([a,n])=>Buffer.from(mem.slice(a,a+n))) };}
    const find=(mode,width,nesting,size=0)=>cases.findIndex(c=>c[1]===mode&&c[2]===width&&c[3]===size&&c[4]===nesting);
    const observe=(kind,a,value)=>{events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});on_event?.(kind,a,value);};
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return 0x80+(a&7);},(a,v)=>observe("w8",a,v),a=>{observe("r32",a);return 0x89ABCDEF|0;},(a,v)=>observe("w32",a,v>>>0));
    let total=0,native=0;
    for(let i=0;i<cases.length;i++) for(const ss32 of [false,true]) for(const hot of [false,true]) for(const opt of [0,1]) {
        reset(i,ss32,0x80,0x8080,hot);instances[i][opt].exports.f(0);const actual=state();
        assert.equal(actual.ip,PC+cases[i][0].length-1);assert.equal(words[664>>2],102);
        if(hot){assert.equal(reads+writes,0,"ENTER warm accesses use native RAM");native++;}
        // Independent pointer model of the pinned ordering; allocation is only
        // pointer arithmetic and must not read/check the allocated stack range.
        const [,mode,width,size,raw]=cases[i],n=raw&31,b=width/8,initial=ss32?BASE+0x80:0xABCD0080,frame=(initial-b)>>>0;
        const sp=ss32?(initial-(n+1)*b-size)>>>0:((initial&0xFFFF0000)|((initial-(n+1)*b-size)&65535))>>>0;
        const bp=width===32?frame:(((ss32?BASE+0x8080:0x45678080)&0xFFFF0000)|(frame&65535))>>>0;
        assert.equal(actual.regs[4],sp);assert.equal(actual.regs[5],bp);
        reset(i,ss32,0x80,0x8080,hot);e.ir_test_step();e.ir_test_step();
        assert.deepEqual(actual,state(),`ENTER mode=${mode} width=${width} n=${raw} size=${size} ss32=${ss32} opt=${opt}`);total++;
    }
    console.log(`PASS: ${total} ENTER pointer/CPU comparisons, ${native} warm native paths`);
    let wraps=0,devices=0,remaps=0;
    for(const mode of [false,true]) for(const width of [16,32]) for(const ss32 of [false,true]) for(const opt of [0,1]) for(const nesting of [0,1,3,31]) {
        const i=find(mode,width,nesting);
        for(const offset of [1,0xFFF1,0xFFFE]) for(const alias of [false,true]) {
            const configure=()=>reset(i,ss32,offset,alias?offset:1);
            configure();instances[i][opt].exports.f(0);const actual=state();
            configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`ENTER wrap/alias width=${width} ss32=${ss32} n=${nesting} offset=${offset} alias=${alias}`);wraps++;
        }
        for(const device of ["stack","chain","both"]){
            const configure=()=>{reset(i,ss32);if(device!=="chain")set32(pte(0x310),0xA0003);if(device!=="stack")set32(pte(0x318),0xA1003);e.full_clear_tlb();};
            configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();
            configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(observed,events,`ENTER MMIO order n=${nesting} width=${width} device=${device}`);assert.deepEqual(actual,state());devices++;
        }
        if(nesting>=3){
            const configure=()=>{reset(i,ss32,0x80,width/8+0x1000);set32(pte(0x311),0xA0003);e.full_clear_tlb();
                on_event=()=>{set32(pte(0x310),0x330003);e.full_clear_tlb();on_event=undefined;};};
            configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert.equal(on_event,undefined);
            configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events);remaps++;
        }
    }
    console.log(`PASS: ${wraps} ENTER wrap/frame-alias cases, ${devices} MMIO states, ${remaps} callback remaps`);
    let aliases=0;
    for(const mode of [false,true]) for(const width of [16,32]) for(const opt of [0,1]) for(const nesting of [0,3]) {
        const i=find(mode,width,nesting);
        const configure=()=>{reset(i,true);cpu.reg32[4]=PC+cases[i][0].length-1+width/8;
            mem.fill(0xCC,PC-256,PC);mem.fill(0xCC,PC+cases[i][0].length,PC+256);windows.push([PC-256,512]);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();
        assert.equal(actual.ip,PC+cases[i][0].length-1,"ENTER exits before overwritten following instruction");assert.equal(words[664>>2],102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());aliases++;
    }
    console.log(`PASS: ${aliases} ENTER self-alias instruction exits`);
    function ring3(){
        for(const [index,lo,hi] of [[0,0,0],[1,0xFFFF,0x00CF9A00],[2,0xFFFF,0x00CF9200],[3,0xFFFF,0x00CFFA00],[4,0xFFFF,0x00CFF200],[5,0x40000067,0x00008900]]){set32(0x3000+index*8,lo);set32(0x3004+index*8,hi);}
        cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;
        set32(0x4004,0x90000);set32(0x4008,16);cpu.sreg.set([0x23,0x1B,0x23,0x23,0x23,0x23]);cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;
        set32(0x12000,0x13007);set32(pte(0x100),0x100007);for(let p=0x30F;p<=0x340;p++)set32(pte(p),p*4096|7);
        mem.fill(0xCC,0x8FFC0,0x90020);windows.push([0x8FFC0,0x60]);e.full_clear_tlb();e.update_state_flags();
    }
    const invoke=f=>{try {f();return false;} catch(err){assert(err instanceof Error);return true;}};
    let faults=0,traps=0;
    for(const mode of [false,true]) for(const width of [16,32]) for(const opt of [0,1]) for(const scenario of ["final","first-push","later-push","first-read","later-read","final-remap"]) {
        const nesting=scenario==="final"?0:scenario==="first-push"?1:3,i=find(mode,width,nesting),b=width/8;
        const configure=()=>{
            reset(i,true,scenario==="later-push"?0x1000+b:0x8080,scenario==="later-read"?0x1000+b:0x4040);ring3();
            if(scenario==="first-read")set32(pte(0x314),0);
            if(scenario==="later-read")set32(pte(0x310),0);
            if(scenario==="final"||scenario==="first-push")set32(pte(0x318),0x318005);
            if(scenario==="later-push")set32(pte(0x310),0x310005);
            if(scenario==="final-remap"){
                set32(pte(0x318),0xA0007);let write_callbacks=0;
                on_event=kind=>{if(kind.startsWith("w")&&++write_callbacks===(width===16?6:3)){set32(pte(0x318),0x318005);e.full_clear_tlb();on_event=undefined;}};
            }
            e.full_clear_tlb();events=[];
        };
        configure();const trapped=invoke(()=>instances[i][opt].exports.f(0)),actual=state(),observed=events.slice();
        const expected_trap=scenario!=="final"&&scenario!=="final-remap";
        assert.equal(trapped,expected_trap,`ENTER fault trap policy ${scenario}`);assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);assert.equal(words[664>>2],101);
        const completed_pushes=scenario==="later-push"||scenario==="later-read"?1:scenario==="final-remap"?3:0;
        const original_sp=BASE+(scenario==="later-push"?0x1000+b:0x8080);
        assert.equal(get32(0x90000-8),(original_sp-completed_pushes*b)>>>0,"ENTER frame saves exact partial ESP");
        const frame=Array.from({length:6},(_,i)=>get32(0x90000-24+i*4));
        configure();e.ir_test_step();const baseline_trap=invoke(()=>e.ir_test_step());
        assert.equal(baseline_trap,expected_trap,`baseline ENTER unwrap ${scenario}`);assert.deepEqual(actual,state(),`ENTER fault progress ${scenario} width=${width} mode=${mode}`);assert.deepEqual(observed,events);
        assert.deepEqual(frame,Array.from({length:6},(_,i)=>get32(0x90000-24+i*4)));faults++;if(trapped)traps++;
    }
    console.log(`PASS: ${faults} ENTER real ring3 faults/progress frames, including ${traps} pinned post-delivery host traps`);
} finally {await vm.destroy();}
