// Architectural flags plus the independently observable CPU ZF backing bit.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-verr/raw.json"));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const release of [false,true]){
    const vm=new V86({wasm_path:release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
    try {
        await new Promise(r=>vm.add_listener("emulator-loaded",r));
        const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true);
        vm.run();const deadline=performance.now()+10000;while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
        const cr0=cpu.cr[0],cr4=cpu.cr[4],instances=new Map();let events=[];
        function instance(name,opt){const key=`${name}-${opt}`;if(!instances.has(key))instances.set(key,new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-verr/${key}.wasm`)),{e:{...e,m:e.memory}}));return instances.get(key);}
        const visible=()=>({gpr:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,rawZero:cpu.flags[0]&64,zeroLazy:cpu.flags_changed[0]&64,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0});
        cpu.io.mmap_register(0xA0000,0x20000,a=>{events.push([a,visible()]);return 0x37;},()=>assert.fail("unexpected MMIO store"),a=>{events.push([a,visible()]);return 0x12345678;},()=>assert.fail("unexpected MMIO store"));
        function reset(bytes,group,seed,raw_zero,lazy,bridge){
            cpu.cr[4]=cr4;e.ir_test_set_cr0(cr0);cpu.cr[2]=0xBADF000;
            cpu.segment_offsets.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.is_32[0]=1;cpu.stack_size_32[0]=1;words[612>>2]=0;
            cpu.gdtr_offset[0]=0x5000;cpu.gdtr_size[0]=0x10FF;set32(0x5008,0xFFFF);set32(0x500C,0xCF9B00);set32(0x5010,0xFFFF);set32(0x5014,0xCF9300);
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;set32(0x2000+14*8,8<<16|0x200);set32(0x2004+14*8,0x180000|0x8E00);
            set32(0x12000,0x13003);for(const page of [0,2,5,8,0x18,0x8F,0x90])set32(0x13000+page*4,page*4096|3);set32(0x13000+6*4,0);set32(0x13000+0x310*4,0xA0003);
            cpu.reg32.set([seed&1?0x4000:0, [0,1,16,32,255][seed],0xFE123456,[-1,0,0x80000000,0x7FFFFFFF,1][seed],0x90000,0x55555555,0x310040,0x1000]);
            cpu.flags[0]=0x813|raw_zero;cpu.flags_changed[0]=lazy?64:0;words[104>>2]=0x87654321;words[112>>2]=raw_zero?1:0;words[96>>2]=31;
            cpu.instruction_pointer[0]=0x8000;words[664>>2]=100;cpu.in_hlt[0]=0;
            mem.fill(0xCC,0x8FFC0,0x90010);mem.set([...bytes,...(bridge?[0x90]:[]),0x0F,0,0xC7|group<<3],0x8000);e.full_clear_tlb();e.update_state_flags();events=[];
        }
        function fault(){assert.equal(cpu.instruction_pointer[0],0x180200);assert.equal(cpu.cr[2],0x6000);return {state:visible(),frame:Buffer.from(mem.slice(0x8FFC0,0x90010)),events:events.slice()};}
        let transitions=0;
        for(const [name,bytes,count] of cases) for(const group of [4,5]) for(let seed=0;seed<5;seed++) for(const raw_zero_local of [0,64]) for(const lazy of [false,true]){
            for(const bridge of [false,true]){
                reset(bytes,group,seed,raw_zero_local,lazy,bridge);
                for(let n=0;n<count;n++)e.ir_test_step();
                const expected_prefix=visible();
                if(bridge)e.ir_test_step();
                const expected_before=visible();e.ir_test_step();const expected=fault();
                assert.equal(v.getUint32(0x90000-4,true)&64,expected_before.rawZero);
                for(const opt of [0,1]){
                    reset(bytes,group,seed,raw_zero_local,lazy,bridge);
                    instance(`raw-${name}`,opt).exports.f(0);
                    assert.deepEqual(visible(),expected_prefix,`prefix ${name}/${group}/${seed}/${raw_zero_local}/${lazy}/${opt}`);
                    if(bridge)instance(`bridge-${name}`,opt).exports.f(0);
                    assert.deepEqual(visible(),expected_before,`reload ${name}/${opt}`);
                    assert.equal(words[664>>2],100+count+Number(bridge));
                    e.ir_test_step();assert.deepEqual(fault(),expected,`IR exit -> interpreter ${name}/${opt}`);transitions++;
                    if(!bridge){
                        reset(bytes,group,seed,raw_zero_local,lazy,false);
                        instance(`raw-${name}-${group}`,opt).exports.f(0);
                        assert.equal(words[664>>2],100+count);
                        assert.deepEqual(fault(),expected,`fused IR ${name}/${opt}`);transitions++;
                    }
                }
            }
        }
        // A later interpreter instruction writes backing ZF before a device
        // store and only then clears its lazy bit. Preserve this entry distinction.
        cpu.io.mmap_register(0xA0000,0x20000,()=>0,()=>{},a=>{events.push(["read",a,visible()]);return 0x12345678;},(a,n)=>events.push(["write",a,n,visible()]));
        let late_flags=0;
        for(const raw_zero_local_local of [0,64]) for(const lazy of [false,true]){
            const setup=()=>{reset([0x90],4,0,raw_zero_local_local,lazy,false);mem.set([0x90,0x0F,0xC7,0x0E],0x8000);cpu.reg32[0]=cpu.reg32[2]=0x12345678;};
            setup();e.ir_test_step();const before=visible();e.ir_test_step();const expected=visible(),observed=events.slice();
            const writes=observed.filter(x=>x[0]==="write");assert.equal(writes.length,2);assert(writes.every(x=>(x[3].flags&64)===(lazy?before.flags&64:64)));
            for(const opt of [0,1]){setup();instance("raw-nop",opt).exports.f(0);e.ir_test_step();assert.deepEqual(visible(),expected);assert.deepEqual(events,observed);late_flags++;}
        }
        console.log(`PASS (${release?"release":"debug"}): ${late_flags} IR exit -> interpreter CMPXCHG8B write-callback ZF/laziness observations`);
        console.log(`PASS (${release?"release":"debug"}): ${transitions} raw/computed ZF writer, lazy-entry, helper, fused and IR/IR/interpreter transitions`);
    } finally {await vm.destroy();}
}
