import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-reload/cases.json"));
const modules=cases.map((_,i)=>[0,1,2,3].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-reload/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

for(const release of [false,true]){
    const vm=new V86({
        wasm_path:(process.argv[2] || "build/v86-ir-test")+(release?"-release":"")+".wasm",
        memory_size:32<<20,
        bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
        disable_keyboard:true,disable_mouse:true,disable_speaker:true,
        net_device:{type:"none"},autostart:false,
    });
    try {
        await new Promise(resolve=>vm.add_listener("emulator-loaded",resolve));
        const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8;
        const linear8=new Uint8Array(e.memory.buffer),linear32=new Uint32Array(e.memory.buffer);
        const view=new DataView(mem.buffer,mem.byteOffset);
        const set32=(address,value)=>view.setUint32(address,value,true);
        vm.run();
        const deadline=performance.now()+10000;
        while(view.getUint16(0x500,true)!==0xCAFE){
            assert(performance.now()<deadline,"normal helper reload guest bootstrap timed out");
            await sleep(1);
        }
        await vm.stop();

        const PC=0x8000,STACK=0x90000,UD=0x180100,NM=0x180300,PF=0x180400,GP=0x180500,DATA=0x6000;
        const cr0=cpu.cr[0],cr4=cpu.cr[4];
        let events=[],mutate=false,context_mutation="",active_case=0;
        const physical=a=>DATA+(a-0xA0000);
        const observe=(kind,a,value)=>events.push([kind,a,value,Array.from(cpu.reg32),cpu.instruction_pointer[0],fpu_state()]);
        cpu.io.mmap_register(0xA0000,0x20000,
            a=>{observe("read8",a);return mem[physical(a)];},
            (a,x)=>{observe("write8",a,x);mem[physical(a)]=x;},
            a=>{
                observe("read32",a);
                if(mutate){cpu.reg32[0]=0x12345670;cpu.reg_xmm32s[8]=0x3F800000;cpu.flags[0]^=1;cpu.flags_changed[0]=0;}
                if(context_mutation==="segment") cpu.segment_offsets[3]=0x100;
                if(context_mutation==="descriptor") cpu.gdtr_size[0]=31;
                if(context_mutation==="task") cpu.segment_offsets[6]=0x123000;
                if(context_mutation==="control-flags") cpu.flags[0]|=0x400;
                if(context_mutation==="paging") {cpu.cr[4]^=0x80;e.full_clear_tlb();}
                if(context_mutation==="mode") {cpu.is_32[0]^=1;e.update_state_flags();}
                if(context_mutation==="redirect") cpu.instruction_pointer[0]=PC+0x100;
                if(context_mutation==="code") vm.write_memory(Uint8Array.of(0x90),PC+cases[active_case][0].length-1);
                if(context_mutation==="cache") cpu.jit_clear_cache();
                return view.getInt32(physical(a),true);
            },
            (a,x)=>{observe("write32",a,x);set32(physical(a),x);});
        const imports={...e,m:e.memory};
        const instances=modules.map(pair=>pair.map(module=>new WebAssembly.Instance(module,{e:imports})));

        function desc(n,base,access){
            set32(0x3000+n*8,(base<<16)|0xFFFF);
            set32(0x3004+n*8,(base&0xFF000000)|(base>>>16&255)|access<<8|0xCF0000);
        }
        function fpu_state(){
            return {
                empty:linear8[816],
                top:linear8[1032],
                control:new DataView(e.memory.buffer).getUint16(1036,true),
                status:new DataView(e.memory.buffer).getUint16(1040,true),
                opcode:linear32[1044>>2]>>>0,
                fip:linear32[1048>>2]>>>0,
                fipsel:linear32[1052>>2]>>>0,
                fdp:linear32[1056>>2]>>>0,
                fdpsel:linear32[1060>>2]>>>0,
                st:Buffer.from(linear8.slice(1152,1152+8*16)),
            };
        }
        function state(){
            return {
                regs:Array.from(cpu.reg32,value=>value>>>0),
                flags:e.get_eflags()>>>0,
                rawFlags:cpu.flags[0]>>>0,
                flagsChanged:cpu.flags_changed[0]>>>0,
                last:linear32[104>>2]>>>0,
                ip:cpu.instruction_pointer[0]>>>0,
                previous:linear32[560>>2]>>>0,
                cr2:cpu.cr[2]>>>0,
                context:[cpu.cr[4],cpu.is_32[0],...cpu.segment_offsets,cpu.gdtr_size[0]],
                code:Buffer.from(mem.slice(PC,PC+cases[active_case][0].length)),
                fpu:fpu_state(),xmm:Array.from(cpu.reg_xmm32s),mxcsr:cpu.mxcsr[0],
                data:Buffer.from(mem.slice(DATA, DATA+8192)),
                events:events.slice(),
                frame:Buffer.from(mem.slice(STACK-96,STACK+16)),
            };
        }
        function reset(i,{task=0,empty=0,top=0,flags=0x8D7,delta=0,pageFault: page_fault=false,nullSegment: null_segment=false,mmio=false,sample=0,rounding=0,callbackMutation: callback_mutation=false,changeContext: change_context=""}={}){
            active_case=i;context_mutation=change_context;
            const [bytes,mode,opcode]=cases[i];
            e.ir_test_set_cr0((cr0|0x10000)&~12|task);
            cpu.cr[4]=cr4|512; // Exercise normal SSE reload; debug observers have a dedicated matrix.
            cpu.cr[2]=0xBADF000;
            cpu.segment_offsets.fill(0);
            cpu.segment_limits.fill(0xFFFFFFFF,0,6);
            cpu.segment_is_null.fill(0,0,6);
            cpu.sreg.set([16,8,16,16,16,16]);
            cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
            cpu.is_32[0]=+mode;
            cpu.stack_size_32[0]=1;
            linear32[612>>2]=0;
            cpu.reg32.set([0x12345678,0xFEDCBA98,0x89ABCDEF,0x7FFFFFFF,STACK,0x55555555,0x10203040,0xAABBCCDD]);
            cpu.flags[0]=flags;
            cpu.flags_changed[0]=0;
            linear32[104>>2]=0x76543210;
            cpu.instruction_pointer[0]=PC;
            cpu.in_hlt[0]=0;
            linear32[664>>2]=100;
            mem.set(bytes,PC);
            mem.fill(0xCC,STACK-96,STACK+16);

            desc(1,0,0x9B);desc(2,0,0x93);
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=23;
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
            for(const [vector,handler] of [[6,UD],[7,NM],[13,GP],[14,PF]]){
                set32(0x2000+vector*8,8<<16|handler&65535);
                set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);
            }
            set32(0x12000,0x13023);
            for(const page of [0,2,3,6,7,8,0x18,0x8F,0x90]){
                set32(0x13000+page*4,page*4096|0x23);
            }
            e.full_clear_tlb();
            e.update_state_flags();

            e.ir_test_x87_seed();
            linear32.set([0x123,0x12345678,8,0x23456789,16],1044>>2);
            linear8[816]=empty;
            linear8[1032]=top;
            mem.fill(0,DATA,DATA+8192);
            cpu.mxcsr[0]=0x1F80 | rounding<<13;
            // Includes +/-zero, denormals, infinities, quiet/signaling NaNs,
            // i32 conversion overflow/rounding boundaries and arbitrary upper lanes.
            const patterns=[
                [0x3FC00000,0xC0200000,0x40800000,0x3F000000],
                [0,0x80000000,1,0x80000001],
                [0x7F800000,0xFF800000,0x7FC12345,0x7F812345],
                [0x4F000000,0xCF000001,0x3FFFFFFF,0xBF000001],
                [0,0x3FF80000,0,0xC0040000],
                [1,0,1,0x80000000],
                [0,0x7FF00000,0x12345,0x7FF80000],
                [0,0x41E00000,0,0xC1E00001],
            ];
            const values=patterns[sample];
            for(let n=0;n<32;n++) cpu.reg_xmm32s[n]=values[n%4];
            // Destination differs from source unless a preceding PXOR dirties it.
            cpu.reg_xmm32s.set(patterns[(sample+4)%patterns.length],4);
            for(let n=0;n<4;n++) set32(DATA+delta+4*n,values[n]);
            cpu.reg32[0]=values[0];
            cpu.segment_offsets[3]=delta;
            cpu.segment_is_null[3]=+null_segment;
            if(mmio) { set32(0x13000+6*4,0xA0023);set32(0x13000+7*4,0xA1023); }
            if(change_context==="walk") set32(0x13000+6*4,mmio?0xA0003:0x6003);
            if(page_fault) set32(0x13000+(delta ? 7 : 6)*4,0);
            cpu.reg32[1]=3;mutate=callback_mutation;
            if(cases[i][6]===6) set32(0x13000+7*4,0);
            events=[];
            e.full_clear_tlb();
        }

        function compare(i,configure){
            configure();let retired=0;
            for(let step=0;step<32;step++) {
                e.ir_test_step();
                const ip=cpu.instruction_pointer[0]>>>0;
                if([UD,NM,GP,PF].includes(ip)) break;
                retired++;
                if(ip<PC || ip>=PC+cases[i][0].length) break;
                assert(step<31,"bounded helper continuation loop");
            }
            const expected=state();assert.equal(linear32[664>>2],100);
            for(const opt of [0,1,2,3]) {
                configure();instances[i][opt].exports.f(0);
                assert.equal(linear32[664>>2],100+retired,`reload retirement ${i}/${opt}`);
                assert.deepEqual(state(),expected,`helper reload ${i}/${opt}`);
            }
            return expected;
        }

        let comparisons=0;
        for(let i=0;i<cases.length;i++) {
            const memory=cases[i][4],kind=cases[i][6];
            for(let sample=0;sample<8;sample++) {
                compare(i,()=>reset(i,{sample}));comparisons++;
            }
            if(kind===3) for(const callback_mutation_local of [false,true]) {
                compare(i,()=>reset(i,{mmio:true,callbackMutation: callback_mutation_local}));comparisons++;
                assert.equal(compare(i,()=>reset(i,{delta:0xFFF,pageFault:true})).ip,PF);comparisons++;
            }
            if(kind===3) for(const change_context_local of ["segment","paging","mode","redirect","code","cache","walk","descriptor","task","control-flags"]) {
                const configure=()=>reset(i,{mmio:true,callbackMutation:true,changeContext: change_context_local});
                configure();e.ir_test_step();e.ir_test_step();
                const expected=state();
                for(const opt of [0,1,2,3]) {
                    configure();instances[i][opt].exports.f(0);
                    assert.equal(linear32[664>>2],102,`observer exit retirement ${change_context_local}/${i}/${opt}`);
                    assert.deepEqual(state(),expected,`observer must exit before suffix: ${change_context_local}/${i}/${opt}`);
                }
                comparisons++;
            }
            for(const task of [4,8,12]) {
                assert.equal(compare(i,()=>reset(i,{task})).ip,task===8?NM:UD);comparisons++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${comparisons} GPR/FLAGS/XMM reload continuations, CFG loops, observer mutations, context/code invalidation exits and pre/post-helper faults in four IR variants`);

    } finally {
        await vm.destroy();
    }
}
