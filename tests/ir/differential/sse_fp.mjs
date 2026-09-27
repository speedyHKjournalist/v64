import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-sse-fp/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-sse-fp/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

for(const release of [false,true]){
    let logObserver=null;
    const wasmPath=(process.argv[2] || "build/v86-ir-test")+(release?"-release":"")+".wasm";
    const vm=new V86({
        wasm_fn:async imports=>{
            const original=imports.env.log_from_wasm;
            imports.env.log_from_wasm=(...args)=>logObserver?logObserver():original(...args);
            return (await WebAssembly.instantiate(fs.readFileSync(wasmPath),imports)).instance.exports;
        },
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
        function reset(i,{task=0,empty=0,top=0,flags=0x8D7,delta=0,pageFault: page_fault=false,nullSegment: null_segment=false,mmio=false,sample=0,rounding=0,denormal=0,masks=true}={}){
            const [bytes,mode,opcode]=cases[i];
            e.ir_test_set_cr0((cr0|0x10000)&~12|task);
            cpu.cr[4]=cr4|512; // Ordinary continuation excludes the debug OSFXSR observer.
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
        function compare(i,configure,expected_count){
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
                assert.deepEqual(state(),expected,`SSE FP case ${i}/${opt}`);
            }
            return expected;
        }

        for(const op of [0x0F58,0x0F59,0x0F5C,0x0F5E]) {
            const i=cases.findIndex(c=>c[1]&&c[2]===op&&!c[3]&&!c[4]&&!c[0].includes(0x67));
            assert(i>=0);
            for(const opt of [0,1]) {
                reset(i);cpu.reg_xmm32s.fill(0x3F800000);register_calls=0;instances[i][opt].exports.f(0);
                assert.equal(register_calls,0,"finite packed arithmetic must use native SIMD");
                reset(i,{sample:2});register_calls=0;instances[i][opt].exports.f(0);
                assert.equal(register_calls,1,"special values must retain scalar payload semantics");
                reset(i,{task:8});register_calls=0;instances[i][opt].exports.f(0);
                assert.equal(register_calls,1,"task fault must use precise recovery");
            }
        }
        // Each operation has a unique non-NaN IEEE result. Exercise cases the
        // previous three finite-value guards rejected, plus invalid operations
        // whose result (rather than an input) introduces a NaN. Compare full
        // XMM/MXCSR/x87/FLAGS state, without canonicalising NaN bits.
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
            for(const [a,b] of double?pairs64:pairs32) for(let rounding=0;rounding<4;rounding++) {
                const configure=()=>{
                    reset(i,{rounding});
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
                let nan=false;
                for(let lane=0;lane<lanes;lane++) {
                    const low=BigInt(expected.xmm[4+lane*words]>>>0);
                    const bits=double?low|BigInt(expected.xmm[5+lane*words]>>>0)<<32n:low;
                    nan ||= double ? (bits&0x7FFFFFFFFFFFFFFFn)>0x7FF0000000000000n
                        : (bits&0x7FFFFFFFn)>0x7F800000n;
                }
                for(const opt of [0,1]) {
                    configure();register_calls=0;instances[i][opt].exports.f(0);
                    assert.deepEqual(state(),expected,`result guard ${op}/${a}/${b}/${rounding}/${opt}`);
                    assert.equal(register_calls,Number(nan),"only active NaN results require the payload-preserving helper");
                    assert.equal(linear32[664>>2],102);
                    result_guard_cases++;
                }
            }
            for(const task of [4,8,12]) for(const opt of [0,1]) {
                reset(i,{task});const expected=interpreter(i);
                reset(i,{task});register_calls=0;instances[i][opt].exports.f(0);
                assert.deepEqual(state(),expected,`native FP task guard ${op}/${task}/${opt}`);
                assert.equal(register_calls,1,"task fault must keep precise CPU helper recovery");
                assert.equal(linear32[664>>2],101);
                result_guard_cases++;
            }
        }
        console.log(`PASS: ${result_guard_cases} exact PS/PD/SS/SD result guards, scalar lane preservation and task faults`);
        let comparisons=0;
        for(let i=0;i<cases.length;i++) {
            const [,mode,opcode,dirty,memory,width]=cases[i], before=dirty?102:101;
            const aligned=(opcode&255)===0xD0;
            for(let sample=0;sample<16;sample++) for(let rounding=0;rounding<4;rounding++) {
                const expected=compare(i,()=>reset(i,{sample,rounding}),before+1);
                assert.equal(expected.ip,PC+cases[i][0].length); comparisons++;
            }
            if(mode && !memory && !dirty && !cases[i][0].includes(0x67)) {
                for(const sample of [1,2,9,10,11,14,15]) for(let rounding=0;rounding<4;rounding++) for(let denormal=0;denormal<4;denormal++) for(const masks of [false,true]) {
                    compare(i,()=>reset(i,{sample,rounding,denormal,masks}),before+1); comparisons++;
                }
            }
            if(memory) {
                for(const mmio of [false,true]) {
                    compare(i,()=>reset(i,{mmio,delta:aligned?0xFF0:0xFFF,sample:4}),before+1); comparisons++;
                }
                assert.equal(compare(i,()=>reset(i,{delta:aligned?0:0xFFF,pageFault:true}),before).ip,PF); comparisons++;
                assert.equal(compare(i,()=>reset(i,{nullSegment:true}),before).ip,GP); comparisons++;
                if(aligned) { assert.equal(compare(i,()=>reset(i,{delta:0xFFF,pageFault:true}),before).ip,GP); comparisons++; }
            }
            if(!dirty) for(const task of [4,8,12]) {
                const expected=compare(i,()=>reset(i,{task,nullSegment:true}),101);
                assert.equal(expected.ip,task===8?NM:UD); comparisons++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${comparisons} SSE FP arithmetic/conversion/NaN/rounding, dirty XMM, MMIO, page/alignment faults and #NM/#UD priority cases`);

        if(!release) {
            const observerCases=JSON.parse(fs.readFileSync("build/ir-sse-fp-observer/cases.json"));
            let observers=0;
            for(let i=0;i<observerCases.length;i++) {
                const [name,bytes,mode,opt,after]=observerCases[i];
                const module=new WebAssembly.Module(fs.readFileSync(`build/ir-sse-fp-observer/${i}.wasm`));
                let links=0;
                for(const path of ["entry","dynamic","direct"]) for(const mutation of ["none","code","context","xmm","counter","all"]) {
                    const instance=new WebAssembly.Instance(module,{e:{...imports,
                        ir_request_link:()=>{links++;},
                        ir_enter_checked:(...args)=>{
                            const accepted=e.ir_enter_checked(...args);
                            if(path==="dynamic")cpu.cr[4]&=~512;
                            return accepted;
                        },
                    }});
                    let calls=0;
                    const configure=()=>{
                        reset(0);mem.set(bytes,PC);cpu.is_32[0]=+mode;cpu.reg32[7]=DATA;
                        cpu.cr[4]&=~512;e.update_state_flags();calls=0;links=0;
                        logObserver=()=>{
                            // The prelude's interpreter-only debug warning has
                            // no callback side effects. Inspect the target SSE
                            // observer, including its fully committed prefix.
                            if(cpu.instruction_pointer[0]!==PC+after)return;
                            calls++;
                            assert.equal(cpu.reg_xmm32s[8],0,"unrelated dirty XMM must reach the observer");
                            assert.equal(linear32[664>>2],102,"observer sees the exact retired prefix");
                            if(["code","all"].includes(mutation))mem[PC+after]=0x48;
                            if(["context","all"].includes(mutation)) {
                                cpu.reg32[3]=0x12345678;cpu.segment_offsets[3]=16;
                            }
                            if(["xmm","all"].includes(mutation)) {
                                cpu.reg_xmm32s[8]=0x13579BDF;cpu.reg_xmm32s[0]=0x40000000;
                            }
                            if(["counter","all"].includes(mutation))linear32[664>>2]=0xFFFFFFFF;
                        };
                    };
                    configure();e.ir_test_step();linear32[664>>2]++;
                    e.ir_test_step();linear32[664>>2]++;
                    e.ir_test_step();
                    const expected=state(),expectedCount=(linear32[664>>2]+1)>>>0;
                    assert.equal(calls,1,"baseline target observer executes once");
                    configure();
                    const epochAddress=e.ir_admission_epoch_address();
                    const epoch=new DataView(e.memory.buffer).getBigUint64(epochAddress,true);
                    if(path==="entry") {
                        const before=state();
                        instance.exports.f(0);
                        assert.equal(calls,0,"entry deferral cannot run an observer");
                        assert.equal(linear32[664>>2],100,"entry deferral retires no work");
                        assert.deepEqual(state(),before,"entry deferral has no CPU side effects");
                        assert.equal(new DataView(e.memory.buffer).getBigUint64(epochAddress,true),epoch);
                        e.ir_test_step();linear32[664>>2]++;
                        e.ir_test_step();linear32[664>>2]++;
                    }
                    else if(path==="dynamic") {
                        cpu.cr[4]|=512;
                        instance.exports.f(0);
                        assert.equal(calls,0,"dynamic deferral cannot run an observer");
                        assert.equal(cpu.instruction_pointer[0],PC+1,"dynamic deferral stops at the prelude's first SSE opcode");
                        assert.equal(linear32[664>>2],101,"dynamic deferral retires only the integer prefix");
                        assert(new DataView(e.memory.buffer).getBigUint64(epochAddress,true)>epoch);
                        e.ir_test_step();linear32[664>>2]++;
                    }
                    else {
                        e.ir_test_step();linear32[664>>2]++;
                        e.ir_test_step();linear32[664>>2]++;
                    }
                    if(path==="direct") {
                        linear32[560>>2]=PC+5;cpu.instruction_pointer[0]=PC+after;
                        const opcode=name==="selective"?0xF51:name==="full"?0xF2C:0xF58;
                        const outcome=name==="memory"?e.ir_sse_fp_mem_continue(opcode,DATA,3,1,0)
                            :e.ir_sse_fp_reg_continue(opcode,0,1,0);
                        assert.equal(outcome,4,"direct helper debug observer retains its terminal ABI");
                    }
                    else {
                        // The standalone fixture has no CPU dispatcher. Execute
                        // the explicitly deferred instruction exactly once.
                        e.ir_test_step();linear32[664>>2]++;
                    }
                    assert.equal(calls,1,`${name}/${mode}/${opt}/${path}/${mutation}: target observer runs once`);
                    assert.equal(links,0,"observing SSE success cannot request normal chaining");
                    assert.equal(linear32[664>>2],expectedCount,"completed prefix retires once, including callback count wrap");
                    assert.equal(cpu.instruction_pointer[0],PC+after,"observer prevents stale suffix execution");
                    assert.equal(cpu.segment_offsets[3],["context","all"].includes(mutation)?16:0);
                    assert.deepEqual(state(),expected,`${name}/${mode}/${opt}/${path}/${mutation}: CPU-owned post-state`);
                    logObserver=null;observers++;
                }
            }
            console.log(`PASS (debug): ${observers} SSE OSFXSR entry/dynamic deferrals and direct helper observers, native/selective/full/memory, dirty XMM/GPR/context/code and exact counter wrap`);
        }

    } finally {
        await vm.destroy();
    }
}
