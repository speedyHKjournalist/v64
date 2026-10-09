// BMI1, BMI2, TZCNT, LZCNT and MOVBE (docs/simd-xsave-plan.md P10) in regions
// (tests/ir/semantics/bmi.rs's fixtures, before and after the passes) against
// the interpreter, and their results against tests/rust/bmi_model.mjs:
// register and memory sources after an INC whose result and flags the region
// holds, before an ADC and an XOR that read the results and CF; MMIO; #PF
// across into an absent page (none for an operand that ends at the page end);
// #GP for a null segment; CR0.TS, CR0.EM and CR4.OSXSAVE, which these forms
// ignore; real and virtual-8086 mode, where C4 is LES (the VEX forms #UD).
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
import {VEX_FORMS, execute_vex, ops} from "../../rust/bmi_model.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-bmi/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-bmi/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const VEX=Object.fromEntries(VEX_FORMS.map(f=>[f.name,f]));

// ESI (before INC ESI), EDX (VEX.vvvv's source: BEXTR's start and length,
// BZHI's index, the shifts' count, PDEP's and PEXT's selector, MULX's
// multiplicand), ECX, EBX, and the memory operand's bytes
const SAMPLES=[
    [0x12345677,0x00000804,0xA5A5A5A5,0x5A5A5A5A,[0x78,0x56,0x34,0x12]],
    [0xFFFFFFFF,0,0xFFFFFFFF,0,[0,0,0,0]],
    [0xFFFFFFFE,0xFFFFFFFF,0,0xFFFFFFFF,[0xFF,0xFF,0xFF,0xFF]],
    [0x7FFFFFFE,0x00002000,0x80000000,1,[0x00,0x00,0x00,0x80]],
    [0x7FFFFFFF,0x0000001F,0x7F00,0x8000,[0x01,0x00,0x00,0x00]],
    [0xDEADBEEE,0x00000020,0xC0DE,0x1234,[0xEF,0xBE,0xAD,0xDE]],
    [0x0000FFFE,0x00000021,0x00010000,0xFFFF0000,[0xFE,0xFF,0x00,0x00]],
    [0x55AA55A9,0x0000FF10,0x76543210,0x0F0F0F0F,[0xAA,0x55,0xAA,0x55]],
];

for(const release of [false,true]){
    const wasm_path=(process.argv[2] || "build/v86-ir-test")+(release?"-release":"")+".wasm";
    const vm=new V86({
        graphics_adapter: "bochs_vga",
        wasm_fn:async imports=>(await WebAssembly.instantiate(fs.readFileSync(wasm_path),imports)).instance.exports,
        memory_size:32<<20,
        bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
        disable_keyboard:true,disable_mouse:true,disable_speaker:true,
        net_device:{type:"none"},autostart:false,
        // (LZCNT: the x86-64 profile's)
        cpu_type:"x86_64",cpu_features:["BMI1","BMI2","LZCNT","MOVBE"],cpu_features_unreleased:true,
    });
    try {
        await new Promise(resolve=>vm.add_listener("emulator-loaded",resolve));
        const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8;
        const linear32=new Uint32Array(e.memory.buffer);
        const view=new DataView(mem.buffer,mem.byteOffset);
        const set32=(address,value)=>view.setUint32(address,value,true);
        vm.run();
        const deadline=performance.now()+10000;
        while(view.getUint16(0x500,true)!==0xCAFE){
            assert(performance.now()<deadline,"BMI guest bootstrap timed out");
            await sleep(1);
        }
        await vm.stop();

        const PC=0x8000,STACK=0x90000,UD=0x180100,NM=0x180300,PF=0x180400,GP=0x180500,DATA=0x6000;
        // (real mode's #UD: 0700:0000)
        const REAL_UD=0x7000;
        const cr0=cpu.cr[0],cr4=cpu.cr[4];
        let events=[];
        const physical=a=>DATA+(a-0xA0000);
        const observe=(kind,a,value)=>events.push([kind,a,value,Array.from(cpu.reg32),cpu.instruction_pointer[0]]);
        cpu.io.mmap_register(0xA0000,0x20000,
            a=>{observe("read8",a);return mem[physical(a)];},
            (a,x)=>{observe("write8",a,x);mem[physical(a)]=x;},
            a=>{observe("read32",a);return view.getInt32(physical(a),true);},
            (a,x)=>{observe("write32",a,x);set32(physical(a),x);});
        const imports={...e,m:e.memory};
        const instances=modules.map(pair=>pair.map(module=>new WebAssembly.Instance(module,{e:imports})));

        function desc(n,base,access){
            set32(0x3000+n*8,(base<<16)|0xFFFF);
            set32(0x3004+n*8,(base&0xFF000000)|(base>>>16&255)|access<<8|0xCF0000);
        }
        function state(){
            return {
                regs:Array.from(cpu.reg32,value=>value>>>0),
                flags:e.get_eflags()>>>0,
                ip:cpu.instruction_pointer[0]>>>0,
                previous:linear32[560>>2]>>>0,
                cr2:cpu.cr[2]>>>0,
                data:Buffer.from(mem.slice(DATA,DATA+8192)),
                events:events.slice(),
                frame:Buffer.from(mem.slice(STACK-96,STACK+16)),
            };
        }
        function reset(i,{task=0,osxsave=false,delta=0,pageFault: page_fault=false,nullSegment: null_segment=false,mmio=false,sample=0,real=false,vm86=false}={}){
            const [bytes,mode]=cases[i];
            const [esi,edx,ecx,ebx,data]=SAMPLES[sample];
            e.ir_test_set_cr0(real?cr0&~0x80000001:(cr0|0x10000)&~12|task);
            cpu.cr[4]=osxsave?cr4|1<<18:cr4&~(1<<18);
            cpu.cr[2]=0xBADF000;
            cpu.segment_offsets.fill(0,0,6);
            // (virtual-8086 mode: real mode's segments at CPL 3)
            const real_segments=real||vm86;
            cpu.segment_limits.fill(real_segments?0xFFFF:0xFFFFFFFF,0,6);
            cpu.segment_is_null.fill(0,0,6);
            cpu.sreg.set(real_segments?[0,0,0,0,0,0]:[16,8,16,16,16,16]);
            cpu.segment_access_bytes.set(vm86?[0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]:[0x93,0x9B,0x93,0x93,0x93,0x93]);
            cpu.is_32[0]=+mode;
            cpu.stack_size_32[0]=+!real_segments;
            linear32[612>>2]=vm86?3:0;
            cpu.reg32.set([0x12345678,ecx,edx,ebx,STACK,0x55555555,esi,0xAABBCCDD]);
            // (all arithmetic flags set)
            cpu.flags[0]=0x8D7|(vm86?0x20000:0);
            cpu.flags_changed[0]=0;
            cpu.instruction_pointer[0]=PC;
            cpu.in_hlt[0]=0;
            linear32[664>>2]=100;
            mem.set(bytes,PC);
            mem.fill(0xCC,STACK-96,STACK+16);

            desc(1,0,0x9B);desc(2,0,0x93);
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=23;
            // (virtual-8086 mode: a TSS with the ring 0 stack, 16:STACK)
            if(vm86) {
                desc(5,0x4000,0x89);cpu.gdtr_size[0]=47;
                cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.tss_size_32[0]=1;
                set32(0x4004,STACK);set32(0x4008,16);
            }
            cpu.idtr_offset[0]=real?0:0x2000;cpu.idtr_size[0]=real?0x3FF:0x7FF;
            set32(6*4,REAL_UD>>4<<16);
            for(const [vector,handler] of [[6,UD],[7,NM],[13,GP],[14,PF]]){
                set32(0x2000+vector*8,8<<16|handler&65535);
                set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);
            }
            // (user pages at CPL 3; the TSS's)
            set32(0x12000,vm86?0x13007:0x13003);
            for(const page of [0,2,3,4,6,7,8,0x18,0x8F,0x90]){
                set32(0x13000+page*4,page*4096|(vm86?7:3));
            }
            e.full_clear_tlb();
            e.update_state_flags();
            mem.fill(0,DATA,DATA+8192);
            mem.set(data,DATA+delta);
            cpu.segment_offsets[3]=delta;
            cpu.segment_is_null[3]=+null_segment;
            if(mmio) { set32(0x13000+6*4,0xA0003);set32(0x13000+7*4,0xA1003); }
            if(page_fault) set32(0x13000+(delta ? 7 : 6)*4,0);
            events=[];
            e.full_clear_tlb();
        }

        // (the case's remaining instructions, one step each, until one faults)
        function interpreter(i){
            while(true){
                const ip=cpu.instruction_pointer[0]>>>0;
                if(ip<PC||ip>=PC+cases[i][0].length) break;
                e.ir_test_step();
            }
            return state();
        }
        // The region, then the interpreter from where it exits; `exit`:
        // where the region itself may end (an address or a list): at the
        // case's end, at the fault's handler, or for a memory form also
        // after it (in paged modes the helper's access ends the region
        // there, with no code owner to continue with: ir::runtime::bmi)
        function compare(i,configure,label,exit){
            configure();
            const expected=interpreter(i);
            for(const opt of [0,1]){
                configure();
                instances[i][opt].exports.f(0);
                if(exit!==undefined) assert([exit].flat().includes(cpu.instruction_pointer[0]>>>0),`BMI case ${i}/${opt} (${cases[i][2]}) ${label}: the region's exit ${(cpu.instruction_pointer[0]>>>0).toString(16)}`);
                assert.deepEqual(interpreter(i),expected,`BMI case ${i}/${opt} (${cases[i][2]}) ${label}`);
            }
            return expected;
        }
        /** ECX, EBX and the memory operand's bytes after the case, by the
         * model: the INCs before (16 or 32 bits) included */
        function model(i,sample){
            const [,mode,name,dirty,memory,bits]=cases[i];
            let [esi,edx,ecx,ebx,data]=SAMPLES[sample];
            const inc=v=>mode?v+1>>>0:(v&0xFFFF0000|v+1&0xFFFF)>>>0;
            esi=inc(esi);
            if(dirty) edx=inc(edx);
            const mask=(1n<<BigInt(bits))-1n;
            const loaded=BigInt(data.reduce((v,b,k)=>v+b*2**(8*k),0));
            const source=(memory?loaded:BigInt(esi))&mask;
            const regs=[0x12345678,ecx,edx,ebx,STACK,0x55555555,esi,0xAABBCCDD].map(BigInt);
            const write=(r,v)=>{regs[r]=bits===16?regs[r]&~0xFFFFn|v:v;};
            const out=[...data];
            const f=VEX[name];
            if(f) {
                const {writes}=execute_vex(f,{reg:1,vvvv:f.group?1:name==="mulx"?3:2,source,imm8:45,gpr:r=>regs[r],bits:32});
                for(const [r,v] of writes) regs[r]=v;
            }
            else if(name==="tzcnt"||name==="lzcnt") write(1,ops[name](source,bits).result);
            else if(name==="movbe_load") write(1,ops.movbe(source,bits).result);
            else {
                const v=ops.movbe(regs[1]&mask,bits).result;
                for(let k=0;k<bits/8;k++) out[k]=Number(v>>BigInt(8*k)&0xFFn);
            }
            return {ecx:Number(regs[1]),ebx:Number(regs[3]),data:out};
        }

        let comparisons=0;
        for(let i=0;i<cases.length;i++) {
            const [bytes,mode,name,,memory,bits]=cases[i], end=PC+bytes.length;
            // (the region's exit when the form completes: after the ADC and XOR, 4 bytes)
            const done=memory?[end-4,end]:end;
            for(let sample=0;sample<SAMPLES.length;sample++) {
                const result=compare(i,()=>reset(i,{sample}),`sample ${sample}`,done);
                assert.equal(result.ip,end,`BMI case ${i} (${name}) sample ${sample}: completes`);
                const expected=model(i,sample);
                assert.deepEqual([result.regs[1],result.regs[3],Array.from(result.data.subarray(0,4))],
                    [expected.ecx,expected.ebx,expected.data],`BMI case ${i} (${name}) sample ${sample}: the model`);
                comparisons++;
            }
            if(memory) {
                for(const mmio of [false,true]) {
                    compare(i,()=>reset(i,{mmio,delta:0xFFF,sample:5}),"MMIO/page end"); comparisons++;
                }
                // (across into the absent page by one byte, then the exact extent)
                assert.equal(compare(i,()=>reset(i,{delta:0x1001-bits/8,pageFault:true}),"across into an absent page",PF).ip,PF); comparisons++;
                assert.equal(compare(i,()=>reset(i,{delta:0x1000-bits/8,pageFault:true,sample:7}),"the page end",done).ip,end); comparisons++;
                assert.equal(compare(i,()=>reset(i,{nullSegment:true}),"null segment",GP).ip,GP); comparisons++;
            }
            // (no AVX state: CR0.TS, CR0.EM and CR4.OSXSAVE do not matter)
            for(const [label,options] of [["CR0.TS",{task:8}],["CR0.EM",{task:4}],["CR0.TS and CR0.EM",{task:12}],["CR4.OSXSAVE",{osxsave:true}]]) {
                assert.equal(compare(i,()=>reset(i,{...options,sample:3}),label,done).ip,end,`BMI case ${i}: ${label}`); comparisons++;
            }
            if(!mode) {
                const vex=name in VEX;
                assert.equal(compare(i,()=>reset(i,{real:true,sample:4}),"real mode",vex?REAL_UD:done).ip,vex?REAL_UD:end); comparisons++;
                assert.equal(compare(i,()=>reset(i,{vm86:true,sample:4}),"virtual-8086 mode",vex?UD:done).ip,vex?UD:end); comparisons++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${comparisons} BMI1/BMI2/TZCNT/LZCNT/MOVBE cases in regions as in the interpreter and the model: register and memory forms, MMIO, page fault, extent, null segment, CR0/CR4, real and virtual-8086 mode`);

    } finally {
        await vm.destroy();
    }
}
