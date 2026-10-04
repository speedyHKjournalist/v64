import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
import {aligned_m128} from "./sse_fixture.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-sse-fp/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-sse-fp/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

for(const release of [false,true]){
    const wasm_path=(process.argv[2] || "build/v86-ir-test")+(release?"-release":"")+".wasm";
    const vm=new V86({
        graphics_adapter: "bochs_vga",
        wasm_fn:async imports=>(await WebAssembly.instantiate(fs.readFileSync(wasm_path),imports)).instance.exports,
        memory_size:32<<20,
        bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
        disable_keyboard:true,disable_mouse:true,disable_speaker:true,
        net_device:{type:"none"},autostart:false,
        cpu_features:["SSSE3","SSE4.1","SSE4.2"], // (the fixtures include the SSSE3 and SSE4 forms)
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
            assert(performance.now()<deadline,"SSE FP guest bootstrap timed out");
            await sleep(1);
        }
        await vm.stop();

        const PC=0x8000,STACK=0x90000,UD=0x180100,NM=0x180300,PF=0x180400,GP=0x180500,DATA=0x6000;
        const cr0=cpu.cr[0],cr4=cpu.cr[4];
        let events=[];
        const physical=a=>DATA+(a-0xA0000);
        const observe=(kind,a,value)=>events.push([kind,a,value,Array.from(cpu.reg32),cpu.instruction_pointer[0],fpu_state()]);
        cpu.io.mmap_register(0xA0000,0x20000,
            a=>{observe("read8",a);return mem[physical(a)];},
            (a,x)=>{observe("write8",a,x);mem[physical(a)]=x;},
            a=>{observe("read32",a);return view.getInt32(physical(a),true);},
            (a,x)=>{observe("write32",a,x);set32(physical(a),x);});
        let register_calls=0;
        const imports={...e,m:e.memory,ir_sse_fp_reg_continue:(...args)=>{register_calls++;return e.ir_sse_fp_reg_continue(...args);}};
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
                fpu:fpu_state(),xmm:Array.from(cpu.reg_xmm32s),mxcsr:cpu.mxcsr[0],
                data:Buffer.from(mem.slice(DATA, DATA+8192)),
                events:events.slice(),
                frame:Buffer.from(mem.slice(STACK-96,STACK+16)),
            };
        }
        function reset(i,{task=0,osfxsr=true,empty=0,top=0,flags=0x8D7,delta=0,pageFault: page_fault=false,nullSegment: null_segment=false,mmio=false,sample=0,rounding=0,denormal=0,masks=true}={}){
            const [bytes,mode,opcode]=cases[i];
            e.ir_test_set_cr0((cr0|0x10000)&~12|task);
            // (XMM forms #UD without CR4.OSFXSR)
            cpu.cr[4]=osfxsr?cr4|512:cr4&~512;
            cpu.cr[2]=0xBADF000;
            cpu.segment_offsets.fill(0,0,6);
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
            set32(0x12000,0x13003);
            for(const page of [0,2,3,6,7,8,0x18,0x8F,0x90]){
                set32(0x13000+page*4,page*4096|3);
            }
            e.full_clear_tlb();
            e.update_state_flags();

            e.ir_test_x87_seed();
            linear32.set([0x123,0x12345678,8,0x23456789,16],1044>>2);
            linear8[816]=empty;
            linear8[1032]=top;
            mem.fill(0,DATA,DATA+8192);
            cpu.mxcsr[0]=(masks?0x1F80:0) | rounding<<13 | (denormal&1)<<6 | (denormal>>1)<<15;
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
                [0,0,0,0x80000000],
                [0x12345,0x7FF00000,0x54321,0xFFF00000],
                [0xFFFFFFFF,0x000FFFFF,0,0x00100000],
                [0x007FFFFF,0x00800000,0x807FFFFF,0x80800000],
                [0x7F7FFFFF,0xFF7FFFFF,0xFFC12345,0xFF812345],
                [0xFFFFFFFF,0x7FEFFFFF,0xFFFFFFFF,0xFFEFFFFF],
                [0x3F000000,0xBF000000,0x40200000,0xC0200000],
                [0,0x3FE00000,0,0xBFE00000],
            ];
            const values=patterns[sample];
            for(let n=0;n<32;n++) cpu.reg_xmm32s[n]=values[n%4];
            // Destination differs from source unless a preceding PXOR dirties it.
            cpu.reg_xmm32s.set(patterns[(sample+4)%patterns.length],4);
            for(let n=0;n<4;n++) set32(DATA+delta+4*n,values[n]);
            cpu.reg32[0]=values[0];
            cpu.segment_offsets[3]=delta;
            cpu.segment_is_null[3]=+null_segment;
            if(mmio) { set32(0x13000+6*4,0xA0003);set32(0x13000+7*4,0xA1003); }
            if(page_fault) set32(0x13000+(delta ? 7 : 6)*4,0);
            events=[];
            e.full_clear_tlb();
        }

        function interpreter(i){
            e.ir_test_step();
            if(cases[i][3]) e.ir_test_step();
            e.ir_test_step();
            return state();
        }
        /** expected_count: a number, or a function of the interpreter's state */
        function compare(i,configure,expected_count){
            configure();
            const expected=interpreter(i);
            if(typeof expected_count==="function") expected_count=expected_count(expected);
            // ir_test_step() intentionally executes interpreter semantics without
            // the main loop's instruction-counter accounting. Count is therefore
            // an IR execution invariant, not part of the interpreter state oracle.
            assert.equal(linear32[664>>2],100);
            for(const opt of [0,1]){
                configure();
                instances[i][opt].exports.f(0);
                assert.equal(linear32[664>>2],expected_count);
                assert.deepEqual(state(),expected,`SSE FP case ${i}/${opt}`);
            }
            return expected;
        }

        for(const op of [0x0F58,0x0F59,0x0F5C,0x0F5E]) {
            const i=cases.findIndex(c=>c[1]&&c[2]===op&&!c[3]&&!c[4]&&!c[0].includes(0x67));
            assert(i>=0);
            for(const opt of [0,1]) {
                // (native only with PE set already: an inexact result changes nothing)
                reset(i);cpu.mxcsr[0]|=0x20;cpu.reg_xmm32s.fill(0x3F800000);register_calls=0;instances[i][opt].exports.f(0);
                assert.equal(register_calls,0,"finite packed arithmetic must use native SIMD");
                reset(i);cpu.reg_xmm32s.fill(0x3F800000);register_calls=0;instances[i][opt].exports.f(0);
                assert.equal(register_calls,1,"PE not set yet: the exact helper");
                reset(i,{sample:2});register_calls=0;instances[i][opt].exports.f(0);
                assert.equal(register_calls,1,"special values must retain scalar payload semantics");
                reset(i,{task:8});register_calls=0;instances[i][opt].exports.f(0);
                assert.equal(register_calls,1,"task fault must use precise recovery");
            }
        }
        // Each operation has a unique non-NaN IEEE result. Exercise cases the
        // previous three finite-value guards rejected, plus invalid operations
        // whose result (rather than an input) introduces a NaN. Compare full
        // XMM/MXCSR/x87/FLAGS state, without canonicalising NaN bits. With PE
        // set, the native path is refused exactly where a flag other than PE
        // could change (ir::native_fp): another rounding mode, a denormal
        // operand, a NaN or infinite result, an inexact tiny product or quotient.
        let result_guard_cases=0;
        const pairs32 = [[0x7F800000n,0x3F800000n], [0xFF800000n,0xBF800000n],
            [0x3F800000n,0x7F800000n], [0xBF800000n,0xFF800000n],
            [0x7F7FFFFFn,0x7F7FFFFFn], [0n,0n], [0x80000000n,0n],
            [1n,0x40000000n], [0x80000001n,0x40000000n],
            [0x7F800000n,0xFF800000n], [0x7F812345n,0x3F800000n],
            [0x3F800000n,0xFFC12345n]];
        const pairs64 = [[0x7FF0000000000000n,0x3FF0000000000000n],
            [0xFFF0000000000000n,0xBFF0000000000000n],
            [0x3FF0000000000000n,0x7FF0000000000000n],
            [0xBFF0000000000000n,0xFFF0000000000000n],
            [0x7FEFFFFFFFFFFFFFn,0x7FEFFFFFFFFFFFFFn], [0n,0n],
            [0x8000000000000000n,0n], [1n,0x4000000000000000n],
            [0x8000000000000001n,0x4000000000000000n],
            [0x7FF0000000000000n,0xFFF0000000000000n],
            [0x7FF0000012345678n,0x3FF0000000000000n],
            [0x3FF0000000000000n,0xFFF8000012345678n]];
        for(const prefix of [0,0x66,0xF3,0xF2]) for(const operation of [0x58,0x59,0x5C,0x5E]) {
            const op=prefix*0x10000+0x0F00+operation;
            const scalar=prefix===0xF2||prefix===0xF3, double=prefix===0x66||prefix===0xF2;
            const words=double?2:1, lanes=scalar?1:4/words;
            const i=cases.findIndex(c=>c[1]&&c[2]===op&&!c[3]&&!c[4]&&!c[0].includes(0x67));
            assert(i>=0,`missing native FP form ${op.toString(16)}`);
            const abs=double?0x7FFFFFFFFFFFFFFFn:0x7FFFFFFFn, min=double?0x0010000000000000n:0x00800000n;
            const inf=double?0x7FF0000000000000n:0x7F800000n;
            const denormal=x=>(x&abs)>0n&&(x&abs)<min;
            for(const [a,b] of double?pairs64:pairs32) for(let rounding=0;rounding<4;rounding++) {
                const configure=()=>{
                    reset(i,{rounding});
                    cpu.mxcsr[0]|=0x20;
                    // Inactive scalar lanes contain signaling/quiet NaNs. They
                    // must not force fallback or lose payload bits during merge.
                    cpu.reg_xmm32s.set([0x7F812345,0xFFF01234,0x7FF12345,0xFF812345,
                        0x7FC54321,0x7FF03456,0xFF812346,0x7FF05678]);
                    for(let lane=0;lane<lanes;lane++) for(let word=0;word<words;word++) {
                        cpu.reg_xmm32s[lane*words+word]=Number(b>>BigInt(word*32)&0xFFFFFFFFn);
                        cpu.reg_xmm32s[4+lane*words+word]=Number(a>>BigInt(word*32)&0xFFFFFFFFn);
                    }
                };
                configure();const expected=interpreter(i);
                let refused=rounding!==0||denormal(a)||denormal(b);
                for(let lane=0;lane<lanes;lane++) {
                    const low=BigInt(expected.xmm[4+lane*words]>>>0);
                    const bits=double?low|BigInt(expected.xmm[5+lane*words]>>>0)<<32n:low;
                    refused ||= (bits&abs)>=inf;
                    const exact_zero=(bits&abs)===0n&&((a&abs)===0n||operation===0x59&&(b&abs)===0n);
                    refused ||= (operation===0x59||operation===0x5E)&&(bits&abs)<min&&!exact_zero;
                }
                for(const opt of [0,1]) {
                    configure();register_calls=0;instances[i][opt].exports.f(0);
                    assert.deepEqual(state(),expected,`result guard ${op}/${a}/${b}/${rounding}/${opt}`);
                    assert.equal(register_calls,Number(refused),`native admission ${op.toString(16)}/${a}/${b}/${rounding}`);
                    assert.equal(linear32[664>>2],102);
                    result_guard_cases++;
                }
            }
            for(const [task,osfxsr] of [[4,true],[8,true],[12,true],[0,false],[8,false]]) for(const opt of [0,1]) {
                reset(i,{task,osfxsr});const expected=interpreter(i);
                reset(i,{task,osfxsr});register_calls=0;instances[i][opt].exports.f(0);
                assert.deepEqual(state(),expected,`native FP task guard ${op}/${task}/${osfxsr}/${opt}`);
                assert.equal(register_calls,1,"task fault must keep precise CPU helper recovery");
                assert.equal(linear32[664>>2],101);
                result_guard_cases++;
            }
        }
        console.log(`PASS: ${result_guard_cases} exact PS/PD/SS/SD result guards, scalar lane preservation and task faults`);
        let comparisons=0;
        for(let i=0;i<cases.length;i++) {
            const [,mode,opcode,dirty,memory,width]=cases[i], before=dirty?102:101;
            // (an m128 operand must be 16-byte aligned)
            const aligned=aligned_m128(opcode,width);
            for(let sample=0;sample<16;sample++) for(let rounding=0;rounding<4;rounding++) {
                const expected=compare(i,()=>reset(i,{sample,rounding}),before+1);
                assert.equal(expected.ip,PC+cases[i][0].length); comparisons++;
            }
            if(mode && !memory && !dirty && !cases[i][0].includes(0x67)) {
                // (unmasked exceptions fault: #UD without CR4.OSXMMEXCPT)
                for(const sample of [1,2,9,10,11,14,15]) for(let rounding=0;rounding<4;rounding++) for(let denormal=0;denormal<4;denormal++) for(const masks of [false,true]) {
                    compare(i,()=>reset(i,{sample,rounding,denormal,masks}),expected=>expected.ip===UD?before:before+1); comparisons++;
                }
            }
            if(memory) {
                for(const mmio of [false,true]) {
                    compare(i,()=>reset(i,{mmio,delta:aligned?0xFF0:0xFFF,sample:4}),before+1); comparisons++;
                }
                // (across into the absent page; a byte operand in it)
                assert.equal(compare(i,()=>reset(i,{delta:aligned?0:width===1?0x1000:0xFFF,pageFault:true}),before).ip,PF); comparisons++;
                assert.equal(compare(i,()=>reset(i,{nullSegment:true}),before).ip,GP); comparisons++;
                if(aligned) { assert.equal(compare(i,()=>reset(i,{delta:0xFFF,pageFault:true}),before).ip,GP); comparisons++; }
            }
            // (#UD for CR0.EM or no CR4.OSFXSR comes before #NM for CR0.TS)
            if(!dirty) for(const [task,osfxsr] of [[4,true],[8,true],[12,true],[0,false],[8,false]]) {
                const expected=compare(i,()=>reset(i,{task,osfxsr,nullSegment:true}),101);
                assert.equal(expected.ip,task===8&&osfxsr?NM:UD); comparisons++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${comparisons} SSE FP arithmetic/conversion/NaN/rounding, dirty XMM, MMIO, page/alignment faults and #NM/#UD (EM, OSFXSR) priority cases`);

    } finally {
        await vm.destroy();
    }
}
