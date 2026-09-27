import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-x87/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-x87/${i}-${opt}.wasm`))));
const continuationCases=JSON.parse(fs.readFileSync("build/ir-x87-continuation/cases.json"));
const continuationModules=continuationCases.map((_,i)=>new WebAssembly.Module(fs.readFileSync(`build/ir-x87-continuation/${i}.wasm`)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

for(const release of [false,true]){
    const vm=new V86({
        wasm_path:release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm",
        memory_size:32<<20,
        // This suite asserts exact F80 payloads and all rounding/precision modes,
        // not the intentionally approximate browser-default binary64 policy.
        x87_fast_math:false,x87_jit_cache:false,
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
            assert(performance.now()<deadline,"x87 IR guest bootstrap timed out");
            await sleep(1);
        }
        await vm.stop();

        const PC=0x8000,STACK=0x90000,UD=0x180100,NM=0x180300;
        const cr0=cpu.cr[0],cr4=cpu.cr[4];
        const imports={...e,m:e.memory};
        const instances=modules.map(pair=>pair.map(module=>new WebAssembly.Instance(module,{e:imports})));
        const continuationInstances=continuationModules.map(module=>new WebAssembly.Instance(module,{e:imports}));

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
                fpu:fpu_state(),
                xmm:Array.from(cpu.reg_xmm32s),
                frame:Buffer.from(mem.slice(STACK-96,STACK+16)),
            };
        }
        function reset(i,{task=0,empty=0,top=0,flags=0x8D7}={}){
            const [bytes]=cases[i];
            e.ir_test_set_cr0((cr0|0x10000)&~12|task);
            cpu.cr[4]=cr4|512; // Mixed SIMD prefixes exercise ordinary continuation.
            cpu.cr[2]=0xBADF000;
            cpu.segment_offsets.fill(0,0,6);
            cpu.segment_limits.fill(0xFFFFFFFF,0,6);
            cpu.segment_is_null.fill(0,0,6);
            cpu.sreg.set([16,8,16,16,16,16]);
            cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
            cpu.is_32[0]=1;
            cpu.stack_size_32[0]=1;
            linear32[612>>2]=0;
            cpu.reg32.set([0x12345678,0xFEDCBA98,0x89ABCDEF,0x7FFFFFFF,STACK,0x55555555,0x10203040,0xAABBCCDD]);
            cpu.reg_xmm32s.set(Array.from({length:32},(_,n)=>0x10203040+n*0x10203));
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
            for(const [vector,handler] of [[6,UD],[7,NM]]){
                set32(0x2000+vector*8,8<<16|handler&65535);
                set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);
            }
            set32(0x12000,0x13003);
            for(const page of [0,2,3,8,0x18,0x8F,0x90]){
                set32(0x13000+page*4,page*4096|3);
            }
            e.full_clear_tlb();
            e.update_state_flags();

            e.ir_test_x87_seed();
            linear8[816]=empty;
            linear8[1032]=top;
        }

        function interpreter(i){
            e.ir_test_step();
            e.ir_test_step();
            return state();
        }
        function compare(i,configure,expected_count,detail=""){
            configure();
            const expected=interpreter(i);
            // ir_test_step() intentionally executes interpreter semantics without
            // the main loop's instruction-counter accounting. Count is therefore
            // an IR execution invariant, not part of the interpreter state oracle.
            assert.equal(linear32[664>>2],100);
            for(const opt of [0,1]){
                configure();
                instances[i][opt].exports.f(0);
                assert.equal(linear32[664>>2],expected_count);
                assert.deepEqual(state(),expected,`x87 case ${i}/${opt} ${detail}`);
            }
            return expected;
        }

        let special=0;
        for(let i=0;i<cases.length;i++) {
            if(!cases[i][4]) continue;
            for(let sample=0;sample<12;sample++) for(const precision of [0,1,2,3]) for(let rounding=0;rounding<4;rounding++) {
                compare(i,()=>{reset(i);e.ir_test_x87_pattern(sample,0x3F|precision<<8|rounding<<10);},102,`sample=${sample} precision=${precision} rounding=${rounding}`);special++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${special} exact F80 zero/subnormal/infinity/qNaN/sNaN/tie cases across rounding and precision modes`);
        // FYL2XP1 used to pass NaNs through the host ln implementation. Node
        // 24's Wasm tiers may canonicalize that payload differently. Check an
        // explicit F80 oracle, not merely two calls that could share the bug.
        const logarithm_case=cases.findIndex(c=>c[1]===0xD9&&c[2]===7&&c[3]===1&&c[4]);
        assert(logarithm_case>=0);
        for(const [mantissa,exponent,expectedMantissa,expectedExponent] of [
            [0xC000000000012345n,0x7FFF,0xC000000000012000n,0x7FFF],
            [0x8000000000054321n,0xFFFF,0xC000000000054000n,0xFFFF],
            [0xA000000000000000n,0xC000,0xC000000000000000n,0xFFFF], // ln(-2.5+1)
        ]) {
            const configure=()=>{
                reset(logarithm_case);
                const v=new DataView(e.memory.buffer);
                v.setBigUint64(1152,mantissa,true);v.setUint16(1160,exponent,true);
                v.setBigUint64(1168,0x8000000000000000n,true);v.setUint16(1176,0x3FFF,true); // ST1=1
            };
            const expected=compare(logarithm_case,configure,102,"deterministic logarithm");
            assert.equal(expected.fpu.st.readBigUInt64LE(16),expectedMantissa);
            assert.equal(expected.fpu.st.readUInt16LE(24),expectedExponent);
        }
        console.log(`PASS (${release?"release":"debug"}): deterministic FYL2XP1 qNaN/sNaN payloads and negative-domain indefinite`);
        let ordinary=0;
        for(let i=0;i<cases.length;i++){
            const valid=cases[i][4];
            for(const [empty,top] of [[0,0],[0xC0,3]]){
                const expected=compare(i,()=>reset(i,{empty,top}),valid?102:101);
                assert.equal(expected.ip,valid?PC+cases[i][0].length:UD);
                ordinary++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${ordinary} x87 register/F80/stack/status comparisons across both IR variants`);

        let flags=0;
        for(let i=0;i<cases.length;i++){
            const [,opcode,group,,valid]=cases[i];
            if(!valid||!([0xDA,0xDB].includes(opcode)&&group<=3||[0xDB,0xDF].includes(opcode)&&[5,6].includes(group))) continue;
            for(const eflags of [2,3,6,0x42,0x46,0x82,0x86]){
                compare(i,()=>reset(i,{flags:eflags}),102);
                flags++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${flags} x87 FCMOV/FCOMI EFLAGS cases`);

        let task=0;
        const selected=new Set();
        for(let opcode=0xD8;opcode<=0xDF;opcode++){
            const valid_index=cases.findIndex(c=>c[1]===opcode&&c[4]);
            const invalid_index=cases.findIndex(c=>c[1]===opcode&&!c[4]);
            if(valid_index>=0)selected.add(valid_index);
            if(invalid_index>=0)selected.add(invalid_index);
        }
        for(const i of selected) for(const cr0_bits of [4,8,12]) {
            const expected=compare(i,()=>reset(i,{task:cr0_bits}),101);
            assert.equal(expected.ip,NM,"CR0.EM/TS must raise #NM before nested x87 #UD");
            task++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${task} CR0.EM/TS priority cases`);

        let continuations=0;
        const variants=new Map();
        for(let i=0;i<continuationCases.length;i++) {
            const [name,bytes,mode,cfg,opt,budget]=continuationCases[i];
            for(const task of [0,4,8,12]) for(const initial of [100,0xFFFFFFFC])
            for(const flags of [2,0x8D7]) for(const sample of [0,5,9]) {
                const configure=()=>{
                    reset(0,{task,flags});
                    cpu.mem8.set(bytes,PC);
                    cpu.is_32[0]=+mode;
                    cpu.reg32[1]=3;
                    linear32[664>>2]=initial;
                    e.ir_test_x87_pattern(sample,0x33F);
                    e.update_state_flags();
                };
                configure();
                continuationInstances[i].exports.f(0);
                const actual=state(),retired=(linear32[664>>2]-initial)>>>0;
                assert(retired<=budget,`x87 continuation exceeds budget ${i}`);
                assert(retired<=12,"loop must terminate");
                configure();
                for(let n=0;n<retired;n++)e.ir_test_step();
                if(actual.ip===UD||actual.ip===NM)e.ir_test_step();
                const expected=state();
                // Poll recovery may legally place previous_ip at the next
                // instruction; every architectural field and raw FP payload
                // must still match the interpreter's exact retired prefix.
                const {previous:actualPrevious,...actualState}=actual;
                const {previous:expectedPrevious,...expectedState}=expected;
                assert(Number.isInteger(actualPrevious)&&Number.isInteger(expectedPrevious));
                assert.deepEqual(actualState,expectedState,`x87 continuation ${i}/${name}/${mode}/${cfg}/${opt}/${budget}/${task}/${initial}/${flags}/${sample}`);
                const key=[name,mode,cfg,budget,task,initial,flags,sample].join("/");
                if(opt)assert.deepEqual({actual,retired},variants.get(key),`x87 continuation optimization ${key}`);
                else variants.set(key,{actual,retired});
                continuations++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${continuations} x87 successor/loop/exact-budget comparisons, scalar and XMM state, 16/32-bit, late #UD, #NM and count wrap`);
    } finally {
        await vm.destroy();
    }
}
