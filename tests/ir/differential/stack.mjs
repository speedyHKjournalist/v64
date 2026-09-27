import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases = JSON.parse(fs.readFileSync("build/ir-stack/cases.json"));
const modules = cases.map((_,i) => [0,1].map(opt => {
    const bytes = fs.readFileSync(`build/ir-stack/${i}-${opt}.wasm`);
    assert(WebAssembly.validate(bytes), `stack fixture ${i}/${opt}`); return new WebAssembly.Module(bytes);
}));
const vm = new V86({wasm_path: "build/v86-ir-test.wasm", memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(r => setTimeout(r,ms));
try {
    await new Promise(r => vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(cpu.wasm_memory.buffer);
    const view = new DataView(mem.buffer,mem.byteOffset), set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run(); const deadline=performance.now()+10000;
    while(view.getUint16(0x500,true)!==0xCAFE) { assert(performance.now()<deadline); await sleep(1); }
    await vm.stop();
    const initial_cr0=cpu.cr[0], old_gdt=[cpu.gdtr_offset[0],cpu.gdtr_size[0]];
    const PC=0x100000,HANDLER=0x180000,BASE=0x310000,DEST=0x320040;
    let reads=0,writes=0,windows=[];
    const imports={...e,m:e.memory,ir_memory_read:(...a)=>{reads++;return e.ir_memory_read(...a);},
        ir_memory_write:(...a)=>{writes++;return e.ir_memory_write(...a);}};
    const instances=modules.map(pair=>pair.map(module=>new WebAssembly.Instance(module,{e:imports})));
    function reset(i, ss32, offset=0x40, high=0, hot=false) {
        const [bytes,mode32,width,name]=cases[i];
        e.ir_test_set_cr0(initial_cr0|0x10000);
        cpu.gdtr_offset[0]=old_gdt[0];cpu.gdtr_size[0]=old_gdt[1];
        cpu.sreg.set([16,8,16,16,16,16]); cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.segment_offsets.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);
        cpu.is_32[0]=+mode32;cpu.stack_size_32[0]=+ss32;words[612>>2]=0;
        cpu.segment_offsets[2]=ss32?0:BASE;
        const sp=ss32?BASE+offset:(high|offset)>>>0;
        cpu.reg32.set([0x7FFFFFFF,DEST,0x11223344,0x3000,sp,0x55667788,0x40,0x99AABBCC]);
        if(name==="leave") cpu.reg32[5]=ss32?BASE+offset:(0x12340000|offset)>>>0;
        if(name==="pop_mem16") cpu.segment_offsets[3]=DEST-0x3040;
        if(name==="pop_fs") {cpu.segment_offsets[4]=0x10000;cpu.reg32[1]=DEST-0x10000;}
        cpu.flags[0]=3;cpu.flags_changed[0]=0;
        cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const vector of [13,14]) {set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);
        for(let page=0x30F;page<=0x330;page++) set32(0x13000+page*4,page*4096|3);
        mem.fill(0x5A,0x30F000,0x331000);mem.set(bytes,PC);
        set32(BASE+offset,0x89ABCDEF);set32(DEST,0x10203040);
        const delta=(name==="pusha"?-8:name==="popa"?8:name.startsWith("push")?-1:1)*width/8;
        const next=ss32?BASE+offset+delta:BASE+(offset+delta&65535);
        windows=[BASE+offset-32,next-32,DEST-32].map(a=>[a,Array.from(mem.slice(a,a+80))]);
        e.full_clear_tlb();e.update_state_flags();
        if(hot) for(const a of [BASE+offset,next,DEST]) e.ir_memory_write(a,mem[a],1);
        reads=writes=0;
    }
    function state() {return {regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,
        cr2:cpu.cr[2]>>>0,cs:cpu.sreg[1],ss:cpu.sreg[2],cpl:new Uint8Array(e.memory.buffer,612,1)[0],
        data:windows.map(([a])=>Array.from(mem.slice(a,a+80)))};}
    let total=0,native=0;
    for(let i=0;i<cases.length;i++) for(const ss32 of [false,true]) for(const hot of [false,true]) for(const opt of [0,1]) {
        reset(i,ss32,0x40,0,hot);instances[i][opt].exports.f(0);
        const actual=state(),executed=actual.ip===PC+cases[i][0].length-1?2:3;
        assert.equal(actual.ip,PC+cases[i][0].length-(executed===2?1:0));
        assert.equal(words[664>>2],100+executed,"stack commit counted once");
        if(hot) {assert.equal(reads+writes,0,"warm stack accesses use native RAM");native++;}
        reset(i,ss32,0x40,0,hot);for(let n=0;n<executed;n++)e.ir_test_step();
        assert.deepEqual(actual,state(),`stack ${cases[i][3]}, mode32=${cases[i][1]}, width=${cases[i][2]}, ss32=${ss32}, hot=${hot}, opt=${opt}`);total++;
    }
    let wraps=0;
    for(let i=0;i<cases.length;i++) if(/^(push_r4|pop_r4|push_imm|pop_8f_esp)$/.test(cases[i][3]))
        for(const ss32 of [false,true]) for(const offset of [1,0xFFFE]) for(const opt of [0,1]) {
            reset(i,ss32,offset,ss32?0:0xABCD0000);instances[i][opt].exports.f(0);
            const actual=state(),executed=actual.ip===PC+cases[i][0].length-1?2:3;
            reset(i,ss32,offset,ss32?0:0xABCD0000);for(let n=0;n<executed;n++)e.ir_test_step();
            assert.deepEqual(actual,state(),`wrap/high ESP ${cases[i][3]} ss32=${ss32} offset=${offset}`);wraps++;
        }
    console.log(`PASS: ${total} real CPU stack comparisons, ${native} native warm stack paths, ${wraps} SP-wrap/high-ESP comparisons`);
    const find_case=(name,mode32,width)=>cases.findIndex(c=>c[3]===name&&c[1]===mode32&&c[2]===width);
    let faults=0;
    for(const [name,fault] of [["push_mem","source"],["pop_mem","destination"],["pop_r0","stack"],
        ["push_mem","segment"],["pop_mem","segment"],["pop_fs","segment"]])
        for(const mode32 of [false,true]) for(const width of [16,32]) for(const ss32 of [false,true]) for(const opt of [0,1]) {
            const i=find_case(name,mode32,width),offset=fault==="stack"?0x1000:0x40;
            const configure=()=>{
                reset(i,ss32,offset);
                if(fault==="source")set32(0x13000+0x320*4,0);
                if(fault==="destination")set32(0x13000+0x320*4,0x320001);
                if(fault==="stack")set32(0x13000+0x311*4,0);
                if(fault==="segment")cpu.segment_is_null[name==="pop_fs"?4:3]=1;
                e.full_clear_tlb();
            };
            configure();instances[i][opt].exports.f(0);
            const actual=state();
            assert.equal(actual.ip,HANDLER,`stack ${fault} delivered`);
            assert.equal(words[664>>2],101,"faulting stack instruction is not committed");
            configure();e.ir_test_step();e.ir_test_step();
            assert.deepEqual(actual,state(),`${name} ${fault} mode=${mode32} width=${width} ss32=${ss32}`);
            faults++;
        }
    for(const width of [16,32]) for(const opt of [0,1]) {
        const i=find_case("push_r4",true,width);
        const configure=()=>{
            reset(i,true);
            // Ring3 PUSH faults onto a distinct valid ring0 stack through a real TSS.
            for(const [index,low,high] of [[0,0,0],[1,0xFFFF,0x00CF9A00],[2,0xFFFF,0x00CF9200],
                [3,0xFFFF,0x00CFFA00],[4,0xFFFF,0x00CFF200],[5,0x40000067,0x00008900]]) {
                set32(0x3000+index*8,low);set32(0x3004+index*8,high);
            }
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;
            cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;
            set32(0x4004,0x90000);set32(0x4008,16);
            cpu.sreg.set([0x23,0x1B,0x23,0x23,0x23,0x23]);
            cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;
            set32(0x12000,0x13007);set32(0x13000+0x100*4,0x100007);set32(0x13000+0x310*4,0x310005);
            mem.fill(0xCC,0x8FFC0,0x90020);windows.push([0x8FFC0,[]]);
            e.full_clear_tlb();e.update_state_flags();
        };
        configure();instances[i][opt].exports.f(0);
        const actual=state();
        assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);assert.equal(actual.regs[4],0x90000-24);
        assert.equal(get32(0x90000-8),BASE+0x40,"fault frame preserves pre-PUSH user ESP");
        assert.equal(words[664>>2],101);
        configure();e.ir_test_step();e.ir_test_step();
        assert.deepEqual(actual,state(),`real ring3 PUSH write fault width=${width}`);faults++;
    }
    console.log(`PASS: ${faults} real stack faults, including POP temporary-ESP segment faults and ring3 PUSH through a TSS`);
    let events=[],on_event;
    const observe=(kind,a,value)=>{events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),esp:cpu.reg32[4]>>>0,eax:cpu.reg32[0]>>>0,
        flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});if(on_event)on_event();};
    cpu.io.mmap_register(0xA0000,0x20000,
        a=>{observe("r8",a);return 0x80+(a&7);},(a,v)=>observe("w8",a,v),
        a=>{observe("r32",a);return 0x89ABCDEF|0;},(a,v)=>observe("w32",a,v>>>0));
    let devices=0;
    for(const name of ["push_r4","pop_r4","push_mem","pop_mem","pop_mem_esp","pusha","popa","leave"])
        for(const mode32 of [false,true]) for(const width of [16,32]) for(const ss32 of [false,true]) for(const opt of [0,1]) {
            const i=find_case(name,mode32,width);
            const configure=()=>{
                reset(i,ss32);
                const page=name==="push_mem"||name==="pop_mem"?0x320:0x310;
                set32(0x13000+page*4,0xA0003);e.full_clear_tlb();events=[];
            };
            configure();instances[i][opt].exports.f(0);
            const actual=state(),observed=events.slice(),executed=actual.ip===PC+cases[i][0].length-1?2:3;
            assert(events.length>0);
            configure();for(let n=0;n<executed;n++)e.ir_test_step();
            assert.deepEqual(observed,events,`stack device observation ${name} width=${width} ss32=${ss32}`);
            assert.deepEqual(actual,state(),`stack MMIO ${name}`);devices++;
        }
    console.log(`PASS: ${devices} stack MMIO comparisons, including old ESP observation and POP [ESP] post-increment addressing`);
    let multiple_faults=0, skipped=0, multiple_wraps=0, alias_stores=0;
    for(const name of ["popa","leave"]) for(const mode32 of [false,true]) for(const width of [16,32])
        for(const ss32 of [false,true]) for(const opt of [0,1]) for(const device_first of [false,true]) {
            const i=find_case(name,mode32,width),offset=name==="popa"?0x1000-4*width/8:0x1000;
            const configure=()=>{
                reset(i,ss32,name==="leave"?0x40:offset);
                if(name==="leave")cpu.reg32[5]=ss32?BASE+0x1000:0x12341000;
                set32(0x13000+0x311*4,0);
                if(device_first && name==="popa")set32(0x13000+0x310*4,0xA0003);
                // Leave a normal kernel stack below the faulting range. POPA's
                // device-first case also uses the device for the exception frame;
                // only its writes are allowed, no POPA device read may occur.
                e.full_clear_tlb();events=[];
            };
            configure();instances[i][opt].exports.f(0);
            const actual=state(),observed=events.slice();
            assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],101);
            assert.equal(observed.filter(e=>e.kind.startsWith("r")).length,0,"range fault precedes device read");
            configure();e.ir_test_step();e.ir_test_step();
            assert.deepEqual(actual,state(),`${name} range fault width=${width} ss32=${ss32} device=${device_first}`);
            assert.deepEqual(observed,events);multiple_faults++;
        }
    // PUSHA preflight faults must precede every register write, with the original
    // user ESP saved by real exception delivery to a separate kernel stack.
    for(const width of [16,32]) for(const opt of [0,1]) for(const last_page of [false,true]) {
        const i=find_case("pusha",true,width),offset=0x1000+4*width/8;
        const configure=()=>{
            reset(i,true,offset);
            for(const [index,low,high] of [[0,0,0],[1,0xFFFF,0x00CF9A00],[2,0xFFFF,0x00CF9200],
                [3,0xFFFF,0x00CFFA00],[4,0xFFFF,0x00CFF200],[5,0x40000067,0x00008900]]) {
                set32(0x3000+index*8,low);set32(0x3004+index*8,high);
            }
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;
            cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;
            set32(0x4004,0x90000);set32(0x4008,16);
            cpu.sreg.set([0x23,0x1B,0x23,0x23,0x23,0x23]);
            cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;
            set32(0x12000,0x13007);set32(0x13000+0x100*4,0x100007);
            set32(0x13000+0x310*4,last_page?0xA0007:0x310005);
            set32(0x13000+0x311*4,last_page?0x311005:0x311007);
            mem.fill(0xCC,0x8FFC0,0x90020);windows.push([0x8FFC0,[]]);
            e.full_clear_tlb();e.update_state_flags();events=[];
        };
        configure();instances[i][opt].exports.f(0);
        const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);
        assert.equal(get32(0x90000-8),BASE+offset,"PUSHA fault preserves initial ESP");
        assert.equal(words[664>>2],101);assert.deepEqual(events,[],"no PUSHA device write before range fault");
        configure();e.ir_test_step();e.ir_test_step();
        assert.deepEqual(actual,state(),`PUSHA preflight width=${width} lastPage=${last_page}`);multiple_faults++;
    }
    for(const mode32 of [false,true]) for(const width of [16,32]) for(const ss32 of [false,true]) for(const opt of [0,1]) {
        const i=find_case("popa",mode32,width);
        const configure=()=>{reset(i,ss32);set32(0x13000+0x310*4,0xA0003);e.full_clear_tlb();events=[];};
        configure();instances[i][opt].exports.f(0);
        const observed=events.slice(),skip=0xA0040+3*width/8;
        assert.equal(events.length,width===32?7:14,"POPA reads exactly seven registers");
        assert(events.every(e=>e.a<skip||e.a>=skip+width/8),"saved SP slot must never be read");
        configure();e.ir_test_step();e.ir_test_step();e.ir_test_step();
        assert.deepEqual(observed,events);skipped++;
    }
    for(const name of ["pusha","popa","leave"]) for(const mode32 of [false,true]) for(const width of [16,32])
        for(const ss32 of [false,true]) for(const opt of [0,1]) for(const offset of [1,0xFFF1,0xFFFE]) {
            const i=find_case(name,mode32,width);
            reset(i,ss32,offset,ss32?0:0xABCD0000);instances[i][opt].exports.f(0);
            const actual=state(),executed=name==="pusha"?2:3;
            assert.equal(words[664>>2],100+executed);
            reset(i,ss32,offset,ss32?0:0xABCD0000);for(let n=0;n<executed;n++)e.ir_test_step();
            assert.deepEqual(actual,state(),`multiple stack wrap ${name} mode=${mode32} width=${width} ss32=${ss32} offset=${offset}`);multiple_wraps++;
        }
    for(const mode32 of [false,true]) for(const width of [16,32]) for(const opt of [0,1]) {
        const i=find_case("pusha",mode32,width);
        const configure=()=>{reset(i,true);cpu.reg32[4]=PC+2+width;
            windows.push([PC-8,[]]);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();
        assert.equal(actual.ip,PC+cases[i][0].length-1,"PUSHA exits before modified following instruction");
        assert.equal(words[664>>2],102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());alias_stores++;
    }
    console.log(`PASS: ${multiple_faults} multi-stack preflight/LEAVE faults, ${skipped} skipped-SP device checks, ${multiple_wraps} stack wraps, ${alias_stores} self-alias PUSHA exits`);
    let remaps=0;
    for(const name of ["pusha","popa"]) for(const mode32 of [false,true]) for(const width of [16,32])
        for(const ss32 of [false,true]) for(const opt of [0,1]) {
            const i=find_case(name,mode32,width),offset=0x1000+(name==="pusha"?1:-1)*4*width/8;
            const configure=()=>{
                on_event=undefined;reset(i,ss32,offset);
                const device_page=name==="pusha"?0x311:0x310,remap_page=name==="pusha"?0x310:0x311;
                set32(0x13000+device_page*4,0xA0003);
                mem.fill(0x42,0x330000,0x331000);windows.push([0x330000,[]],[0x330FC0,[]]);
                e.full_clear_tlb();events=[];
                on_event=()=>{set32(0x13000+remap_page*4,0x330003);e.full_clear_tlb();on_event=undefined;};
            };
            configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();
            assert.equal(on_event,undefined);assert.equal(words[664>>2],name==="pusha"?102:103);
            configure();for(let n=0;n<(name==="pusha"?2:3);n++)e.ir_test_step();
            assert.deepEqual(actual,state(),`${name} translation changed by device width=${width} ss32=${ss32}`);
            assert.deepEqual(observed,events);remaps++;
        }
    console.log(`PASS: ${remaps} multi-stack device remaps; each later access rechecks translation`);


} finally {await vm.destroy();}
