import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-x87-memory/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-x87-memory/${i}-${opt}.wasm`))));
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
            assert(performance.now()<deadline,"x87 IR guest bootstrap timed out");
            await sleep(1);
        }
        await vm.stop();

        const PC=0x8000,STACK=0x90000,UD=0x180100,NM=0x180300,PF=0x180400,GP=0x180500,DATA=0x6000;
        const cr0=cpu.cr[0],cr4=cpu.cr[4];
        let events=[];
        const physical=a=>DATA+(a-0xA0000);
        // Device callbacks cannot observe x87 state. Continuing IR stores pop
        // after the write preflight but before the data write, so write events
        // record the integer context only; the final state compares the FPU.
        const observe=(kind,a,value)=>events.push([kind,a,value,Array.from(cpu.reg32),cpu.instruction_pointer[0],
            ...kind.startsWith("write")?[]:[fpu_state()]]);
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
                data:Buffer.from(mem.slice(DATA, DATA+8192)),
                events:events.slice(),
                frame:Buffer.from(mem.slice(STACK-96,STACK+16)),
            };
        }
        function reset(i,{task=0,empty=0,top=0,flags=0x8D7,delta=0,pageFault: page_fault=false,nullSegment: null_segment=false,mmio=false}={}){
            const [bytes,mode]=cases[i];
            e.ir_test_set_cr0((cr0|0x10000)&~12|task);
            cpu.cr[4]=cr4;
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
            e.instr32_DD_6_mem(DATA+delta);
            e.ir_test_x87_seed(); linear8[816]=empty; linear8[1032]=top;
            cpu.segment_offsets[3]=delta;
            cpu.segment_is_null[3]=+null_segment;
            if(mmio) { set32(0x13000+6*4,0xA0003);set32(0x13000+7*4,0xA1003); }
            if(page_fault) set32(0x13000+7*4,0);
            events=[];
            e.full_clear_tlb();
        }

        function interpreter(i){
            e.ir_test_step();
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
                assert.deepEqual(state(),expected,`x87 case ${i}/${opt}`);
            }
            return expected;
        }

        let special=0;
        for(let i=0;i<cases.length;i++) {
            const [,mode,width,op,group,invalid,unimpl]=cases[i];
            if(invalid||unimpl||!mode||width!==32||![0xD8,0xDA,0xDC,0xDE].includes(op)) continue;
            for(let sample=0;sample<12;sample++) for(const precision of [0,2,3]) for(let rounding=0;rounding<4;rounding++) {
                compare(i,()=>{
                    reset(i);e.ir_test_x87_pattern(sample,0x3F|precision<<8|rounding<<10);
                    // Rotate raw F32/F64/integer encodings independently of ST values.
                    const words=[0,0x80000000,1,0x7F800000,0x7F812345,0x7FC54321,0xFFFFFFFF,0x7FF00000,0x7FF80000,0xFFF00000,0x3FF80000,0x80000001];
                    for(let n=0;n<4;n++)set32(DATA+n*4,words[(sample+n)%words.length]);
                },102);special++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${special} x87 memory arithmetic special-value/control-mode cases`);
        let comparisons=0;
        for(let i=0;i<cases.length;i++) {
            const [,mode,width,op,group,invalid,unimpl]=cases[i];
            // The fixed CPU asserts on unsupported FBLD/16-bit FSAVE/FRSTOR in
            // debug. Release delivers #UD; both still honor #NM first.
            if(!unimpl || release) {
                for(const mmio of [false,true]) for(const delta of [0,0xFFC]) for(const [empty,top] of [[0,0],[0xC0,3]]) {
                    const expected=compare(i,()=>reset(i,{delta,empty,top,mmio}),invalid||unimpl?101:102);
                    assert.equal(expected.ip,invalid||unimpl?UD:PC+cases[i][0].length);
                    comparisons++;
                }
                if(!invalid && !unimpl) {
                    // Page 7 is the tail of the operand. Two/four-byte forms at
                    // 0x6FFC fit and succeed; larger accesses fault in order.
                    reset(i,{delta:0xFFF,pageFault:true});
                    const expected=interpreter(i);
                    assert.equal(expected.ip,PF);
                    compare(i,()=>reset(i,{delta:0xFFF,pageFault:true}),101);
                    comparisons++;
                }
            }
            assert.equal(compare(i,()=>reset(i,{nullSegment:true}),101).ip,GP);
            comparisons++;
            for(const task of [4,8,12]) {
                const expected=compare(i,()=>reset(i,{task,nullSegment:true,pageFault:true,delta:0xFFF}),101);
                assert.equal(expected.ip,NM,"#NM precedes null segment and data faults");
                comparisons++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${comparisons} x87 memory/environment/F80, cross-page fault, stack commit and #NM-priority cases in both IR variants`);
    } finally {
        await vm.destroy();
    }
}
