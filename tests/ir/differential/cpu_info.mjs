import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-cpu-info/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-cpu-info/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const release of [false,true]){
    let clock,clock_events=[],cpu,e,words;
    const vm=new V86({wasm_fn:async imports=>{const original=imports.env.microtick;imports.env.microtick=()=>{if(clock===undefined) return original();clock_events.push({clock,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});return clock;};return (await WebAssembly.instantiate(fs.readFileSync(release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm"),imports)).instance.exports;},memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
    try {
        await new Promise(r=>vm.add_listener("emulator-loaded",r));cpu=vm.v86.cpu;e=cpu.wm.exports;words=new Uint32Array(e.memory.buffer);const raw=new Uint8Array(e.memory.buffer),mem=cpu.mem8,v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true);
        vm.run();const deadline=performance.now()+10000;while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
        const PC=0x8000,STACK=0x90000,HANDLER=0x180000,cr0=cpu.cr[0],cr4=cpu.cr[4];
        const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:{...e,m:e.memory}})));
        function desc(n,base,limit,access,flags){set32(0x3000+n*8,limit&65535|base<<16);set32(0x3004+n*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
        function reset(i,a=0,c=0,d=0,acpi=0,warm=0){
            const [bytes,mode]=cases[i];e.ir_test_set_cr0(cr0|0x10000);cpu.cr[4]=cr4;cpu.cr[2]=0xBADF000;
            cpu.segment_offsets.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=0;
            cpu.reg32.set([a,c,d,0x12345678,STACK,0x99AABBCC,0x7FFFFFFF,0xAABBCCDD]);cpu.flags[0]=0x8D7;cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;
            raw[548]=1;raw[552]=acpi;words[636>>2]=0x18;words[640>>2]=0x92000;words[644>>2]=0x200000;e.set_cpuid_level(0x16);
            desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0,0xFFFFF,0xFB,12);desc(4,0,0xFFFFF,0xF3,12);desc(5,0x4000,0x67,0x89,0);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;
            cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;set32(0x2000+13*8,8<<16|HANDLER&65535);set32(0x2004+13*8,HANDLER&0xFFFF0000|0x8E00);set32(0x12000,0x13003);set32(0x13000+8*4,0x8003);
            mem.fill(0xCC,STACK-96,STACK+16);mem.set(bytes,PC);e.full_clear_tlb();e.update_state_flags();e.ir_test_tsc_reset(0n);clock=1000.25;for(let n=0;n<warm;n++)e.read_tsc();clock_events=[];
        }
        const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,cr2:cpu.cr[2]>>>0,cpl:words[612>>2]&255,mode:cpu.is_32[0],sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),sysenter:Array.from(words.slice(636>>2,(644>>2)+1)),apic:raw[548],tsc:Array.from({length:6},(_,n)=>e.ir_test_tsc_state(n)),frame:Buffer.from(mem.slice(STACK-96,STACK+16))});
        function compare(i,configure,expectedCount=102){configure();instances[i][0].exports.f(0);const actual=state(),events=clock_events.slice();assert.equal(words[664>>2],expectedCount);configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`CPU info ${i}`);assert.deepEqual(events,clock_events);configure();instances[i][1].exports.f(0);assert.equal(words[664>>2],expectedCount);assert.deepEqual(state(),actual);assert.deepEqual(clock_events,events);return actual;}
        let cpuid=0;
        for(let i=0;i<cases.length;i++) if(cases[i][2]===0xA2) for(const leaf of [...Array(0x18).keys(),0x40000000,0x80000000,0x80000001,0xFFFFFFFF]) for(const sub of [0,1,2,3,0xFFFFFFFF]) for(const acpi of [0,1]){
            const actual=compare(i,()=>reset(i,leaf,sub,0,acpi));if(leaf===0){assert.equal(actual.regs[0],0x16);assert.deepEqual([actual.regs[3],actual.regs[2],actual.regs[1]],[0x756E6547,0x49656E69,0x6C65746E]);}cpuid++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${cpuid} CPUID leaf/subleaf/ACPI comparisons in both IR variants`);
        let msr=0;
        const reads=[0x10,0x17,0x1B,0x33,0x34,0x3A,0x48,0x8B,0xC1,0xC2,0xCE,0x10F,0x122,0x123,0x140,0x174,0x175,0x176,0x179,0x186,0x187,0x1A0,0x277,0x570,0x60D,0xC0011020,0xC0011029];
        const writes=[0x10,0x33,0x3A,0x48,0x79,0x8B,0xC1,0xC2,0x10F,0x122,0x123,0x140,0x174,0x175,0x176,0x179,0x186,0x187,0x1A0,0x277,0xC0000101,0xC0011020,0xC0011029];
        for(let i=0;i<cases.length;i++) if([0x30,0x32].includes(cases[i][2])) for(const index of cases[i][2]===0x30?writes:reads) for(const acpi of [0,1]) for(const value of [0,0x89ABCDEF]){
            const actual=compare(i,()=>reset(i,value,index,value,acpi));if(cases[i][2]===0x30&&index===0x174)assert.equal(actual.sysenter[0],value&65535);msr++;
        }
        for(let i=0;i<cases.length;i++) if(cases[i][2]===0x30) for(const acpi of [0,1]) for(const value of [0xFEE00000,0xFEE00800,...(!acpi?[0]:[])]){const actual=compare(i,()=>reset(i,value,0x1B,0,acpi));assert.equal(actual.apic,Number(!!(value&0x800)));msr++;}
        console.log(`PASS (${release?"release":"debug"}): ${msr} recognized MSR state/no-op/APIC comparisons`);
        let tsc=0;
        for(let i=0;i<cases.length;i++) if(cases[i][2]===0x31) for(const warm of [0,1,2,5]) for(const tick of [1000.25,1000.250001,1000.251,2000]){
            const actual=compare(i,()=>{reset(i,0xAAAAAAAA,0,0xBBBBBBBB,0,warm);clock=tick;});if(!warm)assert.equal((BigInt(actual.regs[2])<<32n)|BigInt(actual.regs[0]),BigInt(Math.trunc(tick*1000000)));tsc++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${tsc} deterministic RDTSC clock/interpolation state comparisons`);
        function privilege(cpl,vm_mode,tsd){words[612>>2]=cpl;cpu.flags[0]|=vm_mode?0x20000:0;cpu.cr[4]=cr4|(tsd?4:0);if(cpl){cpu.sreg[1]=0x1B;cpu.sreg[2]=0x23;cpu.segment_access_bytes[1]=0xFB;cpu.segment_access_bytes[2]=0xF3;set32(0x12000,0x13007);set32(0x13000+8*4,0x8007);}e.full_clear_tlb();e.update_state_flags();}
        let permissions=0;
        for(let i=0;i<cases.length;i++) for(const cpl of [0,3]) for(const tsd of [false,true]) for(const vm_mode_local of [false,true]){if(vm_mode_local&&(cpl!==3||cases[i][1])) continue;const op=cases[i][2],fault=cpl!==0&&(op===0x30||op===0x32||op===0x31&&tsd);
            const actual=compare(i,()=>{reset(i,0,op===0xA2?0:0x174);privilege(cpl,vm_mode_local,tsd);},fault?101:102);if(fault){assert.equal(actual.ip,HANDLER);assert.equal(clock_events.length,0);}permissions++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${permissions} CPL/CR4.TSD/VM86 permission and fault cases`);
        let real=0,levels=0,sequences=0;
        for(let i=0;i<cases.length;i++) if(!cases[i][1]){
            const actual=compare(i,()=>{reset(i,0,0x174);e.ir_test_set_cr0(0);e.update_state_flags();});assert.equal(actual.ip,PC+cases[i][0].length);real++;
        }
        for(let i=0;i<cases.length;i++) if(cases[i][2]===0xA2) for(const level of [0,2,0xFFFFFFFF]){
            const actual=compare(i,()=>{reset(i);e.set_cpuid_level(level);});assert.equal(actual.regs[0],level);levels++;
        }
        // Preserve offset/interpolation across instructions, including repeated
        // writes. Reset only before the complete sequence, never between steps.
        for(const mode of [false,true]) for(const opt of [0,1]){
            const index=op=>cases.findIndex(c=>c[1]===mode&&c[2]===op&&c[0].length===3);
            const operations=[[0x30,0x1234,1000.25],[0x31,0,1000.251],[0x32,0,1000.252],[0x30,0x5678,1000.253],[0x31,0,1000.254],[0x32,0,1000.254]];
            function sequence(ir){reset(index(0x30));const states=[];for(const [op,value,tick] of operations){const i=index(op);mem.set(cases[i][0],PC);cpu.instruction_pointer[0]=PC;cpu.reg32[0]=value;cpu.reg32[1]=0x10;cpu.reg32[2]=0;clock=tick;clock_events=[];if(ir)instances[i][opt].exports.f(0);else {e.ir_test_step();e.ir_test_step();}states.push({state:state(),events:clock_events.slice()});} if(ir)assert.equal(words[664>>2],112);return states;}
            assert.deepEqual(sequence(true),sequence(false));sequences++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${real} real-mode, ${levels} configured CPUID-level, ${sequences} persistent TSC sequences`);
        let unsupported=0;
        const caught=f=>{try {f();return false;} catch(error){assert(error instanceof WebAssembly.RuntimeError);return true;}};
        function compare_abort(i,configure,opt){configure();assert.equal(caught(()=>instances[i][opt].exports.f(0)),!release);const actual=state(),events=clock_events.slice();assert.equal(words[664>>2],release?102:101);configure();e.ir_test_step();assert.equal(caught(()=>e.ir_test_step()),!release);assert.deepEqual(actual,state());assert.deepEqual(events,clock_events);return actual;}
        for(let i=0;i<cases.length;i++) if(cases[i][0].length===3&&[0x30,0x32].includes(cases[i][2])) for(const index of [0,0xDEADBEEF]) for(const opt of [0,1]){
            const actual=compare_abort(i,()=>reset(i,0x12345678,index,0x87654321),opt);if(release&&cases[i][2]===0x32)assert.deepEqual([actual.regs[0],actual.regs[2]],[0,0]);unsupported++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${unsupported} pinned unknown-MSR abort/no-op/zero-result cases`);
        let apic_invalid=0;
        for(let i=0;i<cases.length;i++) if(cases[i][0].length===3&&cases[i][2]===0x30) for(const [a,d,acpi] of [[0xFEE00800,1,1],[0xFED00800,0,1],[0xFEE00C00,0,1],[0,0,1]]) for(const opt of [0,1]){
            const actual=compare_abort(i,()=>reset(i,a,0x1B,d,acpi),opt);assert.equal(actual.apic,release?Number(!!(a&0x800)):1);apic_invalid++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${apic_invalid} pinned restricted-APIC debug-abort/release-state cases`);
    } finally {clock=undefined;await vm.destroy();}
}
