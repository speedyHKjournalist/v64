import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-control/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>{
    const bytes=fs.readFileSync(`build/ir-control/${i}-${opt}.wasm`);assert(WebAssembly.validate(bytes));return new WebAssembly.Module(bytes);
}));
{
    const m=new WebAssembly.Memory({initial:64});
    new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync("build/ir-control/dynamic-exit.wasm")),{e:{m}}).exports.f(0);
    assert.equal(new Uint32Array(m.buffer)[9],42,"state-only dynamic EIP survives DCE and code generation");
}
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const v=new DataView(mem.buffer,mem.byteOffset),set32=(a,x)=>v.setUint32(a,x,true),get32=a=>v.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;
    while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const initial_cr0=cpu.cr[0],old_gdt=[cpu.gdtr_offset[0],cpu.gdtr_size[0]],BASE=0x310000,SP=0x4000,DEST=0x320040,HANDLER=0x180000;
    let slow=0;
    const imports={...e,m:e.memory,ir_memory_read:(...a)=>{slow++;return e.ir_memory_read(...a);},
        ir_memory_write:(...a)=>{slow++;return e.ir_memory_write(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    const find=(name,mode32=true,width=32)=>cases.findIndex(c=>c[3]===name&&c[1]===mode32&&c[2]===width);
    function reset(i,ss32,cs=0,hot=false) {
        const [bytes,mode32,width,name,pc]=cases[i];
        e.ir_test_set_cr0(initial_cr0|0x10000);cpu.gdtr_offset[0]=old_gdt[0];cpu.gdtr_size[0]=old_gdt[1];
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.segment_offsets.fill(0,0,6);cpu.segment_offsets[1]=cs;cpu.segment_offsets[2]=BASE;
        cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);
        cpu.is_32[0]=+mode32;cpu.stack_size_32[0]=+ss32;words[612>>2]=0;
        cpu.reg32.set([0x8FFF,0x9001,0x9002,0x9003,SP,0x9005,0x9006,0x9007]);
        if(name==="call_mem"||name==="jmp_mem")cpu.reg32[1]=DEST;
        cpu.flags[0]=3;cpu.flags_changed[0]=0;cpu.instruction_pointer[0]=pc+cs;cpu.in_hlt[0]=0;words[664>>2]=100;
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const vector of [13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);
        for(let page=0x313;page<=0x330;page++)set32(0x13000+page*4,page*4096|3);
        mem.fill(0x5A,BASE+SP-64,BASE+SP+64);mem.fill(0xCC,0x8FFC0,0x90020);
        set32(BASE+SP,0x9000);set32(DEST,0x9000);
        if(name==="call_overlap")set32(BASE+SP-width/8,0x9000);
        mem.set(bytes,pc+cs);
        e.full_clear_tlb();e.update_state_flags();
        if(hot) for(const a of [BASE+SP,BASE+SP-4,DEST])e.ir_memory_write(a,mem[a],1);
        slow=0;
    }
    function state(){return {regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,
        cr2:cpu.cr[2]>>>0,selectors:Array.from(cpu.sreg.slice(0,6)),bases:Array.from(cpu.segment_offsets.slice(0,6)),
        cpl:new Uint8Array(e.memory.buffer,612,1)[0],stack:Array.from(mem.slice(BASE+SP-64,BASE+SP+64)),
        kernel:Array.from(mem.slice(0x8FFC0,0x90020))};}
    let normal=0,warm=0;
    for(let i=0;i<cases.length;i++) for(const ss32 of [false,true]) for(const cs of [0,0x10000]) for(const hot of [false,true]) for(const opt of [0,1]) {
        reset(i,ss32,cs,hot);instances[i][opt].exports.f(0);const actual=state();
        assert.equal(words[664>>2],102,"control transfer commits once");
        if(hot){assert.equal(slow,0,"warm control transfer needs no slow memory call");warm++;}
        const [bytes,,width,name,pc]=cases[i];
        if(name.startsWith("call")) {
            const at=BASE+SP-width/8,ret=width===16?v.getUint16(at,true):get32(at);
            assert.equal(ret,(pc+bytes.length)&(width===16?65535:0xFFFFFFFF),"pushed CS-relative return EIP");
        }
        reset(i,ss32,cs,hot);e.ir_test_step();e.ir_test_step();
        assert.deepEqual(actual,state(),`near ${name}, mode=${cases[i][1]}, width=${width}, ss32=${ss32}, cs=${cs}, opt=${opt}`);normal++;
    }
    let edges=0;
    for(const name of ["ret","ret_imm","call_mem","jmp_mem"]) for(const width of [16,32])
        for(const target of [0x80000000,0xFFFFFFFF,0x1234FFFF]) for(const opt of [0,1]) {
            const i=find(name,true,width),configure=()=>{reset(i,false,0x10000);set32(name.startsWith("ret")?BASE+SP:DEST,target);};
            configure();instances[i][opt].exports.f(0);const actual=state();
            assert.equal(actual.ip,((width===16?target&65535:target)+0x10000)>>>0);
            configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),"dynamic target width/wrap");edges++;
        }
    console.log(`PASS: ${normal} near-control comparisons, ${warm} warm runs without slow memory calls, ${edges} dynamic-target edge cases`);
    let faults=0;
    for(const [name,fault] of [["call_mem","source"],["jmp_mem","source"],["call_mem","segment"],
        ["jmp_mem","segment"],["ret","stack"],["ret_imm","stack"]])
        for(const mode32 of [false,true]) for(const width of [16,32]) for(const ss32 of [false,true]) for(const cs of [0,0x10000]) for(const opt of [0,1]) {
            const i=find(name,mode32,width),configure=()=>{
                reset(i,ss32,cs);
                if(fault==="source")set32(0x13000+0x320*4,0);
                if(fault==="stack")set32(0x13000+0x314*4,0);
                if(fault==="segment")cpu.segment_is_null[3]=1;
                e.full_clear_tlb();
            };
            configure();instances[i][opt].exports.f(0);const actual=state();
            assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],101);
            configure();e.ir_test_step();e.ir_test_step();
            assert.deepEqual(actual,state(),`${name} ${fault} width=${width} ss32=${ss32} cs=${cs}`);faults++;
        }
    for(const name of ["call_r4","call_overlap"]) for(const width of [16,32]) for(const opt of [0,1]) {
        const i=find(name,true,width),configure=()=>{
            reset(i,true);
            for(const [index,low,high] of [[0,0,0],[1,0xFFFF,0x00CF9A00],[2,0xFFFF,0x00CF9200],
                [3,0xFFFF,0x00CFFA00],[4,0xFFFF,0x00CFF231],[5,0x40000067,0x00008900]]) {
                set32(0x3000+index*8,low);set32(0x3004+index*8,high);
            }
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;
            cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;
            set32(0x4004,0x90000);set32(0x4008,16);
            cpu.sreg.set([0x23,0x1B,0x23,0x23,0x23,0x23]);
            cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;
            set32(0x12000,0x13007);set32(0x13000+(cases[i][4]>>>12)*4,(cases[i][4]&~4095)|7);
            set32(0x13000+0x313*4,0x313005);e.full_clear_tlb();e.update_state_flags();
        };
        configure();instances[i][opt].exports.f(0);const actual=state();
        assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);assert.equal(actual.regs[4],0x90000-24);
        assert.equal(get32(0x90000-8),SP,"CALL write fault saves original user ESP");
        assert.equal(words[664>>2],101);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),"CALL ring3 stack write fault");faults++;
    }
    let fetch_faults=0;
    for(const name of ["call_r2","jmp_r2","ret"]) for(const opt of [0,1]) {
        const i=find(name),configure=()=>{reset(i,true);cpu.reg32[2]=0x330000;set32(BASE+SP,0x330000);set32(0x13000+0x330*4,0);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);
        assert.equal(cpu.instruction_pointer[0],0x330000,"control transfer completes before target fetch");
        assert.equal(words[664>>2],102);e.ir_test_step();const actual=state();
        assert.equal(actual.ip,HANDLER);assert.equal(actual.cr2,0x330000);
        configure();e.ir_test_step();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),"next target fetch owns its fault");fetch_faults++;
    }
    console.log(`PASS: ${faults} near-control faults (including ring3 CALL write failure), ${fetch_faults} faults on the subsequent target fetch`);
    let events=[];
    const observe=(kind,a,value)=>events.push({kind,a,value,esp:cpu.reg32[4]>>>0,ip:cpu.instruction_pointer[0]>>>0,flags:e.get_eflags()>>>0});
    cpu.io.mmap_register(0xA0000,0x20000,
        a=>{observe("r8",a);return a&1?0x90:0;},(a,x)=>observe("w8",a,x),
        a=>{observe("r32",a);return 0x9000;},(a,x)=>observe("w32",a,x>>>0));
    let devices=0;
    for(const name of ["call_mem","jmp_mem","call_r4","call_overlap","ret","ret_imm"])
        for(const mode32 of [false,true]) for(const width of [16,32]) for(const ss32 of [false,true]) for(const cs of [0,0x10000]) for(const opt of [0,1]) {
            const i=find(name,mode32,width),configure=()=>{
                reset(i,ss32,cs);const page=name==="call_mem"||name==="jmp_mem"?0x320:name.startsWith("ret")?0x314:0x313;
                set32(0x13000+page*4,0xA0003);e.full_clear_tlb();events=[];
            };
            configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();
            assert(observed.length>0);configure();e.ir_test_step();e.ir_test_step();
            assert.deepEqual(actual,state(),`near control MMIO ${name}`);
            assert.deepEqual(observed,events,"callbacks observe sequential IP and old ESP before control commit");devices++;
        }
    console.log(`PASS: ${devices} near-control MMIO comparisons, including sequential-IP/old-ESP callback observation`);


} finally {await vm.destroy();}
