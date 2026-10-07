// CRC32 (F2 0F 38 F0/F1, SSE4.2) in regions (tests/ir/semantics/crc32.rs's
// fixtures, before and after the passes) against the interpreter, and its
// result against the CRC-32C model of tests/rust/sse4_model.mjs: register and
// memory sources of 8, 16 and 32 bits, the flags kept, MMIO, #PF across into
// an absent page (none for an operand that ends at the page end), #GP for a
// null segment, and CR0.TS, CR0.EM and CR4.OSFXSR, which CRC32 ignores.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
import {crc32} from "../../rust/sse4_model.mjs";

const cases=JSON.parse(fs.readFileSync("build/ir-crc32/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-crc32/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// ECX (the CRC before), ESI and EDX (DH), and the memory operand's bytes
const SAMPLES=[
    [0,0x12345678,0xABCDEF01,[0x31,0x32,0x33,0x34]],
    [0xFFFFFFFF,0,0,[0,0,0,0]],
    [0xFFFFFFFF,0xFFFFFFFF,0xFFFF,[0xFF,0xFF,0xFF,0xFF]],
    [0x8F2E1D3C,0x7FFFFFFF,0x8000,[0x80,0x00,0x00,0x80]],
    [1,0x80000000,0x7F00,[0x01,0x00,0x00,0x00]],
    [0xE3069283,0xDEADBEEF,0xC0DE,[0xEF,0xBE,0xAD,0xDE]],
    [0x00010000,0x0000FFFF,0x0100,[0xFE,0xFF,0x00,0x00]],
    [0x76543210,0x55AA55AA,0x5AA5,[0xAA,0x55,0xAA,0x55]],
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
        cpu_features:["SSSE3","SSE4.1","SSE4.2"],
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
            assert(performance.now()<deadline,"CRC32 guest bootstrap timed out");
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
                rawFlags:cpu.flags[0]>>>0,
                flagsChanged:cpu.flags_changed[0]>>>0,
                last:linear32[104>>2]>>>0,
                ip:cpu.instruction_pointer[0]>>>0,
                previous:linear32[560>>2]>>>0,
                cr2:cpu.cr[2]>>>0,
                xmm:Array.from(cpu.reg_xmm32s),mxcsr:cpu.mxcsr[0],
                data:Buffer.from(mem.slice(DATA, DATA+8192)),
                events:events.slice(),
                frame:Buffer.from(mem.slice(STACK-96,STACK+16)),
            };
        }
        function reset(i,{task=0,osfxsr=true,delta=0,pageFault: page_fault=false,nullSegment: null_segment=false,mmio=false,sample=0}={}){
            const [bytes,mode]=cases[i];
            e.ir_test_set_cr0((cr0|0x10000)&~12|task);
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
            const [crc,esi,edx,data]=SAMPLES[sample];
            cpu.reg32.set([0x12345678,crc,edx,0x7FFFFFFF,STACK,0x55555555,esi,0xAABBCCDD]);
            // (all arithmetic flags set: CRC32 changes none)
            cpu.flags[0]=0x8D7;
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
            mem.fill(0,DATA,DATA+8192);
            mem.set(data,DATA+delta);
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
            assert.equal(linear32[664>>2],100);
            for(const opt of [0,1]){
                configure();
                instances[i][opt].exports.f(0);
                assert.equal(linear32[664>>2],expected_count);
                assert.deepEqual(state(),expected,`CRC32 case ${i}/${opt}`);
            }
            return expected;
        }
        /** ECX after the case, by the model: the INCs before (16 or 32 bits) included */
        function model(i,sample){
            const [,mode,,dirty,memory,width]=cases[i];
            const [crc,esi,edx,data]=SAMPLES[sample];
            const inc=v=>mode?v+1>>>0:(v&0xFFFF0000|v+1&0xFFFF)>>>0;
            const source=memory?data.reduce((v,b,k)=>v|b<<8*k,0)>>>0:width===8?edx>>>8&255:inc(esi);
            const bytes=width/8;
            return Number(crc32(BigInt(dirty?inc(crc):crc),BigInt(source)&(1n<<BigInt(width))-1n,bytes));
        }

        let comparisons=0;
        for(let i=0;i<cases.length;i++) {
            const [bytes,,,dirty,memory,width]=cases[i], before=dirty?102:101, end=PC+bytes.length;
            for(let sample=0;sample<SAMPLES.length;sample++) {
                const expected=compare(i,()=>reset(i,{sample}),before+1);
                assert.equal(expected.ip,end);
                assert.equal(expected.regs[1],model(i,sample)>>>0,`CRC32 case ${i}: the model`);
                comparisons++;
            }
            if(memory) {
                for(const mmio of [false,true]) {
                    compare(i,()=>reset(i,{mmio,delta:0xFFF,sample:5}),before+1); comparisons++;
                }
                // (across into the absent page; a byte operand in it)
                assert.equal(compare(i,()=>reset(i,{delta:width===8?0x1000:0xFFF,pageFault:true}),before).ip,PF); comparisons++;
                // (the exact extent: the operand ends at the page end)
                assert.equal(compare(i,()=>reset(i,{delta:0x1000-width/8,pageFault:true,sample:5}),before+1).ip,end); comparisons++;
                assert.equal(compare(i,()=>reset(i,{nullSegment:true}),before).ip,GP); comparisons++;
            }
            // (no XMM state: CR0.TS, CR0.EM and CR4.OSFXSR do not matter)
            for(const [task,osfxsr] of [[4,true],[8,true],[12,true],[0,false]]) {
                assert.equal(compare(i,()=>reset(i,{task,osfxsr,sample:3}),before+1).ip,end); comparisons++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${comparisons} CRC32 register/memory, CRC-32C model, MMIO, page fault, extent, null segment and CR0/CR4 cases`);
    } finally {
        await vm.destroy();
    }
}
