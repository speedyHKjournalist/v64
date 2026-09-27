import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-coverage/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-coverage/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

for(const release of [false,true]){
    let random_observer;
    const vm=new V86({
        wasm_fn:async imports=>{
            imports.env.get_rand_int=()=>{random_observer?.();return 0x89ABCDEF|0;};
            return (await WebAssembly.instantiate(fs.readFileSync((process.argv[2]||"build/v86-ir-test")+(release?"-release":"")+".wasm"),imports)).instance.exports;
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
            assert(performance.now()<deadline,"baseline coverage guest bootstrap timed out");
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
        random_observer=()=>observe("random",0,0x89ABCDEF);
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
                fpu:fpu_state(),xmm:Array.from(cpu.reg_xmm32s),mxcsr:cpu.mxcsr[0],
                data:Buffer.from(mem.slice(DATA, DATA+8192)),
                events:events.slice(),
                frame:Buffer.from(mem.slice(STACK-96,STACK+16)),
            };
        }
        function reset(i,{task=0,empty=0,top=0,flags=0x8D7,delta=0,pageFault: page_fault=false,nullSegment: null_segment=false,mmio=false,sample=0,rounding=0}={}){
            const [bytes,mode,opcode]=cases[i];
            e.ir_test_set_cr0((cr0|0x10000)&~14|task);
            cpu.cr[4]=cr4|512; // Keep ordinary forms on IR; OSFXSR observers are tested separately.
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
            const values=patterns[sample%8];
            for(let n=0;n<32;n++) cpu.reg_xmm32s[n]=values[n%4];
            // Destination differs from source unless a preceding PXOR dirties it.
            cpu.reg_xmm32s.set(patterns[(sample+4)%patterns.length],4);
            for(let n=0;n<4;n++) set32(DATA+delta+4*n,values[n]);
            cpu.reg32[0]=values[0];
            if(opcode===0x63) {
                cpu.reg32[0]=0x12345670 | sample&3;
                cpu.reg32[1]=0x76543210 | sample>>2&3;
                set32(DATA+delta,0xAABBCCF0 | sample&3);
            }

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
                assert.deepEqual(state(),expected,`baseline coverage case ${i}/${opt}`);
            }
            return expected;
        }

        let comparisons=0;
        for(let i=0;i<cases.length;i++) {
            const [,mode,opcode,dirty,memory,width,kind,sse]=cases[i], before=dirty?102:101;
            const can_execute=release || ![1,2,3].includes(kind);
            if(can_execute) {
                const success=kind>=2;
                for(let sample=0;sample<(opcode===0x63?16:1);sample++) {
                    const result=compare(i,()=>reset(i,{sample}),before+Number(success));
                    assert.equal(result.ip,success?PC+cases[i][0].length:UD); comparisons++;

                }
                if(memory) for(const mmio of [false,true]) {
                    compare(i,()=>reset(i,{mmio,delta:0xFFF}),before+Number(success)); comparisons++;
                }
                if(memory) {
                    const accesses=[0x63,0x0FC3].includes(opcode);
                    const result=compare(i,()=>reset(i,{delta:0xFFF,pageFault:true}),before+Number(success&&!accesses));
                    assert.equal(result.ip,accesses?PF:success?PC+cases[i][0].length:UD);comparisons++;
                }
            }
            if(memory) { assert.equal(compare(i,()=>reset(i,{nullSegment:true}),before).ip,GP);comparisons++; }
            if(sse && !dirty) for(const task of [4,8,12]) {
                assert.equal(compare(i,()=>reset(i,{task,nullSegment:true}),101).ip,task===8?NM:UD);comparisons++;
            }
            if(opcode===0x9B && !dirty) for(const task of [2,4,8,10,12,14]) {
                const fault=(task&10)===10;
                assert.equal(compare(i,()=>reset(i,{task}),101+Number(!fault)).ip,fault?NM:PC+cases[i][0].length);comparisons++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${comparisons} baseline reserved/no-op, ARPL/RDRAND/FWAIT, segment/task/page fault and completion cases`);

    } finally {
        await vm.destroy();
    }
}
