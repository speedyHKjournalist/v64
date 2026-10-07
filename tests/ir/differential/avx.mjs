// AVX (VEX-encoded SIMD, crate::cpu::avx) in regions (tests/ir/semantics/avx.rs's
// fixtures, before and after the passes) against the interpreter: register,
// memory, general-purpose and state forms after an instruction whose result
// the region holds (XMM2, or ESI and EAX) and before one that reads the VEX
// form's result; the upper halves of the YMM registers and XCR0's checks
// (#UD without CR4.OSXSAVE or with XCR0 3, #NM with CR0.TS, CR0.EM ignored);
// MXCSR (#XM from the floating-point forms, DAZ, FZ, rounding); MMIO, #PF
// across into an absent page, #GP for a null segment, a misaligned
// VMOVAPS/VMOVNTDQA operand or VLDMXCSR's reserved bits; real mode, where C4
// and C5 are LES and LDS (#UD with a register operand).
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-avx/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-avx/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// (the state layout: XCR0 and the upper halves of YMM0-YMM15)
const XCR0=2432,YMM_HI=2448;

let seed=0x5EED5EED;
const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
// XMM0-7, YMM_Hi128 0-7, the memory operand's 32 bytes (a valid MXCSR in
// the first 4 but for the last sample), EAX, ECX, ESI
const SAMPLES=Array.from({length:6},(_,n)=>({
    xmm:Array.from({length:32},random),
    ymm:Array.from({length:32},random),
    data:Array.from({length:32},(_,i)=>n===5&&i<4?[0,0,1,0][i]:i===2||i===3?0:random()&255),
    gpr:[random(),random(),random()],
}));

for(const release of [false,true]){
    const wasm_path=(process.argv[2] || "build/v86-ir-test")+(release?"-release":"")+".wasm";
    const vm=new V86({
        graphics_adapter: "bochs_vga",
        wasm_fn:async imports=>(await WebAssembly.instantiate(fs.readFileSync(wasm_path),imports)).instance.exports,
        memory_size:32<<20,
        bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
        disable_keyboard:true,disable_mouse:true,disable_speaker:true,
        net_device:{type:"none"},autostart:false,
        cpu_features:["SSSE3","SSE4.1","SSE4.2","XSAVE","AVX"],cpu_features_unreleased:true,
    });
    try {
        await new Promise(resolve=>vm.add_listener("emulator-loaded",resolve));
        const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8;
        const linear32=new Uint32Array(e.memory.buffer);
        const ymm=new Uint32Array(e.memory.buffer,YMM_HI,64);
        const view=new DataView(mem.buffer,mem.byteOffset);
        const set32=(address,value)=>view.setUint32(address,value,true);
        vm.run();
        const deadline=performance.now()+10000;
        while(view.getUint16(0x500,true)!==0xCAFE){
            assert(performance.now()<deadline,"AVX guest bootstrap timed out");
            await sleep(1);
        }
        await vm.stop();

        const PC=0x8000,STACK=0x90000,UD=0x180100,NM=0x180300,PF=0x180400,GP=0x180500,DATA=0x6000;
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
                xmm:Array.from(cpu.reg_xmm32s),ymm:Array.from(ymm),mxcsr:cpu.mxcsr[0],
                data:Buffer.from(mem.slice(DATA, DATA+8192)),
                events:events.slice(),
                frame:Buffer.from(mem.slice(STACK-96,STACK+16)),
            };
        }
        function reset(i,{task=0,osxsave=true,xcr0=7,delta=0,pageFault: page_fault=false,nullSegment: null_segment=false,mmio=false,sample=0,real=false,mxcsr=0x1F80}={}){
            const [bytes,mode]=cases[i];
            const s=SAMPLES[sample];
            e.ir_test_set_cr0(real?cr0&~0x80000001:(cr0|0x10000)&~12|task);
            cpu.cr[4]=(cr4|0x600)&~(1<<18)|(osxsave?1<<18:0);
            linear32[XCR0>>2]=xcr0;linear32[XCR0+4>>2]=0;
            cpu.cr[2]=0xBADF000;
            cpu.segment_offsets.fill(0,0,6);
            cpu.segment_limits.fill(real?0xFFFF:0xFFFFFFFF,0,6);
            cpu.segment_is_null.fill(0,0,6);
            cpu.sreg.set(real?[0,0,0,0,0,0]:[16,8,16,16,16,16]);
            cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
            cpu.is_32[0]=+mode;
            cpu.stack_size_32[0]=+!real;
            linear32[612>>2]=0;
            // (EDI: VMASKMOVDQU's destination, DI in 16-bit code)
            cpu.reg32.set([s.gpr[0],s.gpr[1],0x12345678,0x7FFFFFFF,STACK,0x55555555,s.gpr[2],mode?DATA+3:0xAAAA0000|DATA+3]);
            cpu.flags[0]=0x8D7;
            cpu.flags_changed[0]=0;
            cpu.reg_xmm32s.set(s.xmm);
            ymm.fill(0);
            ymm.set(s.ymm);
            cpu.mxcsr[0]=mxcsr;
            cpu.instruction_pointer[0]=PC;
            cpu.in_hlt[0]=0;
            linear32[664>>2]=100;
            mem.set(bytes,PC);
            mem.fill(0xCC,STACK-96,STACK+16);

            desc(1,0,0x9B);desc(2,0,0x93);
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=23;
            cpu.idtr_offset[0]=real?0:0x2000;cpu.idtr_size[0]=real?0x3FF:0x7FF;
            for(const [vector,handler] of [[6,UD],[7,NM],[13,GP],[14,PF]]){
                set32(0x2000+vector*8,8<<16|handler&65535);
                set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);
            }
            set32(0x12000,0x13003);
            for(const page of [0,2,3,6,7,8,0x18,0x8F,0x90]){
                set32(0x13000+page*4,page*4096|3);
            }
            e.full_clear_tlb();
            e.update_state_flags();
            mem.fill(0,DATA,DATA+8192);
            mem.set(s.data,DATA+delta);
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
        // The region, then the interpreter from where it exits: a helper's
        // memory access ends the region here (no code owner to continue
        // with: ir::runtime::avx), and the CPU goes on from that boundary
        function compare(i,configure,label){
            configure();
            const expected=interpreter(i);
            for(const opt of [0,1]){
                configure();
                instances[i][opt].exports.f(0);
                assert.deepEqual(interpreter(i),expected,`AVX case ${i}/${opt} ${label}`);
            }
            return expected;
        }

        let comparisons=0;
        for(let i=0;i<cases.length;i++) {
            const [bytes,mode,count,memory]=cases[i], end=PC+bytes.length;
            for(let sample=0;sample<SAMPLES.length;sample++) {
                compare(i,()=>reset(i,{sample}),`sample ${sample}`); comparisons++;
            }
            // (each completes but VMOVAPS, VMOVNTDQA and VLDMXCSR with a reserved bit)
            const completed=compare(i,()=>reset(i,{sample:1}),"sample 1");
            if(completed.ip!==end) assert.equal(completed.ip,GP,`AVX case ${i}: completes or #GP`);
            if(memory) {
                for(const mmio of [false,true]) {
                    compare(i,()=>reset(i,{mmio,delta:0xFF0,sample:2}),"MMIO/page end"); comparisons++;
                }
                compare(i,()=>reset(i,{delta:0xFF8,pageFault:true}),"across into an absent page"); comparisons++;
                assert.equal(compare(i,()=>reset(i,{nullSegment:true}),"null segment").ip,GP); comparisons++;
            }
            // #UD without CR4.OSXSAVE or with XCR0 3, #NM with CR0.TS, at the
            // VEX form; CR0.EM ignored: PADDD after it is #UD
            const at=PC+(bytes[0]===0x66?4:bytes[0]===0x46?2:0);
            for(const [label,options,vector,eip] of [["without CR4.OSXSAVE",{osxsave:false},UD,at],["XCR0 3",{xcr0:3},UD,at],
                ["CR0.TS",{task:8},NM,at],["CR0.TS without CR4.OSXSAVE",{task:8,osxsave:false},UD,at],["CR0.EM",{task:4},UD,end-4]]) {
                const result=compare(i,()=>reset(i,{...options,sample:3}),label);
                // (PADDD before, legacy SSE, faults first with CR0.EM and CR0.TS)
                if(!(bytes[0]===0x66&&options.task))
                    assert.deepEqual([result.ip,view.getUint32(STACK-12,true)],[vector,eip],`AVX case ${i}: ${label}`);
                comparisons++;
            }
            if(!mode) {
                compare(i,()=>reset(i,{real:true,sample:4}),"real mode"); comparisons++;
            }
            // MXCSR: every exception unmasked (#XM from floating-point forms), DAZ and FZ, rounding down
            for(const mxcsr of [0,0x9FC0,0x3F80]) {
                compare(i,()=>reset(i,{sample:2,mxcsr}),`MXCSR ${mxcsr.toString(16)}`); comparisons++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${comparisons} AVX cases in regions as in the interpreter: register, memory, general-purpose and state forms, MMIO, faults, CR0/CR4/XCR0, real mode`);
    } finally {
        await vm.destroy();
    }
}
