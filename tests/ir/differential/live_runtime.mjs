import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const wasm="build/v86-ir-runtime.wasm";
const names=WebAssembly.Module.exports(new WebAssembly.Module(fs.readFileSync(wasm))).map(x=>x.name);
assert(names.includes("ir_compile_live"));assert(!names.some(n=>n.startsWith("ir_test_")||n.startsWith("jit_test_")||n==="__stack_pointer"));
const vm=new V86({wasm_path:wasm,memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports;
    vm.run();const deadline=performance.now()+10000;while(new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset).getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();await sleep(20);cpu.jit_clear_cache();
    for(const tier of [1,2]) for(const opt of [0,1]){
        cpu.in_hlt[0]=0;cpu.segment_offsets[1]=0xFF000;cpu.instruction_pointer[0]=0x100000;cpu.reg32[0]=0x7FFFFFFF;
        new Uint32Array(e.memory.buffer)[664>>2]=0xFFFFFFFC;
        vm.write_memory(Uint8Array.from([0xB9,3,0,0,0,0x40,0x49,0x75,0xFC,0xA3,0,6,0,0,0xF4]),0x100000);
        const id=e.ir_compile_live(15,tier,opt,1,64,8);assert.notEqual(id,0n,`runtime compile error ${e.ir_live_error()}`);
        const bytes=new Uint8Array(e.memory.buffer,e.ir_live_info(id,0),e.ir_live_info(id,1)).slice();
        const {instance}=await WebAssembly.instantiate(bytes,{e:{...e,m:e.memory}});assert.equal(e.ir_live_validate(id),1);instance.exports.f(0);
        assert.equal(cpu.reg32[0]>>>0,0x80000002);assert.equal(new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset).getUint32(0x600,true),0x80000002);
        // The coalesced tail now reaches HLT after the store: MOV + three
        // INC/DEC/JNZ iterations + store + HLT retire twelve instructions.
        assert.equal(new Uint32Array(e.memory.buffer)[664>>2],8);
        assert.equal(cpu.instruction_pointer[0],0x10000F);assert.equal(cpu.in_hlt[0],1);
        assert.equal(e.ir_live_release(id),1);
    }
    console.log("PASS: experimental-only release compiles, instantiates and executes IR CFG/store artifacts with exact wrapped counts, in both tier requests and optimization modes, without any test-hook exports");
} finally {await vm.destroy();}
