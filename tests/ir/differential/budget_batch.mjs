// Compare batching on/off at every short-block cut, loop edge and count wrap.
// ir_test_step is an independent semantic oracle for the exact retired prefix.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-budget-batch/cases.json"));
const wasm=process.argv[2]||"build/v86-ir-test.wasm";
const vm=new V86({wasm_path:wasm,memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,PC=0x100000,DATA=0x110000,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset);
    vm.run();const deadline=performance.now()+10000;
    while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);}
    await vm.stop();
    const instances=cases.map((_,i)=>new WebAssembly.Instance(new WebAssembly.Module(
        fs.readFileSync(`build/ir-budget-batch/${i}.wasm`)),{e:{...e,m:e.memory}}));
    const snapshot=()=>({regs:Array.from(cpu.reg32),flags:e.get_eflags()>>>0,last:words[104>>2],
        ip:cpu.instruction_pointer[0]>>>0,previous:words[560>>2],count:words[664>>2],
        xmm:Array.from(cpu.reg_xmm32s),data:Array.from(cpu.mem8.slice(DATA,DATA+16))});
    const base=new Map();let comparisons=0,steps=0;
    for(let i=0;i<cases.length;i++) {
        const [program,bytes,mode,batch,budget]=cases[i];
        for(const counter of [1,2,7,0x10001,0xFFFFFFFF]) for(const flags of [2,0x8D7])
        for(const initial of [100,0xFFFFFFFC]) for(const fp_bits of [0x3F800000,0x7F812345]) {
            const reset=()=>{
                cpu.segment_offsets.fill(0,0,6);cpu.segment_offsets[1]=PC-0x8000;cpu.segment_is_null.fill(0,0,6);
                cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.stack_size_32[0]=1;cpu.is_32[0]=+mode;
                cpu.reg32.set([0x7FFFFFFF,counter,0x81828384,0x80000000,0x90000,0xABCD0123,DATA,0x55555555]);
                cpu.flags[0]=flags;cpu.flags_changed[0]=0x8D5;
                words[96>>2]=31;words[104>>2]=0x7FFFFFFF;words[112>>2]=flags&64?0:0x80000000;
                cpu.reg_xmm32s.fill(fp_bits);cpu.in_hlt[0]=0;words[612>>2]=0;
                cpu.instruction_pointer[0]=PC;words[560>>2]=0x12345678;words[664>>2]=initial;
                cpu.mem8.set(bytes,PC);e.update_state_flags();e.full_clear_tlb();
                cpu.mem8.fill(0xA5,DATA,DATA+16);e.ir_memory_read(DATA,4);e.ir_memory_write(DATA,0x12345678,4);
            };
            reset();instances[i].exports.f(0);const actual=snapshot();
            const retired=(actual.count-initial)>>>0;
            assert(retired<=budget,`budget exceeded ${i}/${retired}/${budget}`);
            const key=[program,mode,budget,counter,flags,initial,fp_bits].join("/");
            if(batch) assert.deepEqual(actual,base.get(key),`exact poll prefix ${key}`);
            else base.set(key,actual);
            reset();for(let j=0;j<retired;j++)e.ir_test_step();
            const expected=snapshot();expected.count=actual.count;
            // Previous-IP is a CPU-private recovery slot, not an architectural
            // register: a BeforeInstruction poll and a completed helper have
            // different legal values. The on/off oracle above checks it exactly.
            const {previous:actual_previous,...actualArchitecture}=actual;
            const {previous:expected_previous,...expectedArchitecture}=expected;
            assert(Number.isInteger(actual_previous)&&Number.isInteger(expected_previous));
            assert.deepEqual(actualArchitecture,expectedArchitecture,`interpreter prefix ${i}/${key}`);
            comparisons++;steps+=retired;
        }
    }
    console.log(`PASS: ${wasm}: ${comparisons} exact batched/unbatched/interpreter budget comparisons (${steps} guest steps), 16/32-bit, diamonds, loops, lazy FLAGS and counter wrap`);
} finally {await vm.destroy();}
