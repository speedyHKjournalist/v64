// Debug OSFXSR logging precedes displacement/immediate decoding. Cached IR must
// defer untouched, retire its zero-step owner and let the real CPU interpret.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const wasm=process.argv[2]||"build/v86-ir-cache-test.wasm";
const release=process.argv.includes("--release");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const little=value=>Array.from({length:4},(_,i)=>value>>>(i*8)&255);
let observer=null;
// The region scheduler is under test: Tier-0 (on by default) is off.
const vm=new V86({ir_tier0:false,wasm_fn:async imports=>{
    const original=imports.env.log_from_wasm;
    imports.env.log_from_wasm=(...args)=>observer?observer(...args):original(...args);
    return (await WebAssembly.instantiate(fs.readFileSync(wasm),imports)).instance.exports;
},memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});

try {
    await new Promise(resolve=>vm.add_listener("emulator-loaded",resolve));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,PC=0x100000,DATA=0x200000,HANDLER=0x180100;
    const words=()=>new Uint32Array(e.memory.buffer);
    const view=()=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset);
    const set32=(address,value)=>view().setUint32(address,value,true);
    vm.run();let deadline=performance.now()+10000;
    while(view().getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);}
    await vm.stop();
    const snapshot=()=>{
        e.fpu_sync_all?.();
        return {gpr:Array.from(cpu.reg32),flags:e.get_eflags(),xmm:Array.from(cpu.reg_xmm32s),
            fpu:Array.from(cpu.fpu_st),empty:cpu.fpu_stack_empty[0],top:cpu.fpu_stack_ptr[0],
            control:cpu.fpu_control_word[0],status:cpu.fpu_status_word[0],mxcsr:cpu.mxcsr[0],
            pc:cpu.instruction_pointer[0],count:words()[664>>2],cr0:cpu.cr[0],
            data:Array.from(cpu.mem8.slice(DATA,DATA+32)),
            frame:Array.from(cpu.mem8.slice(0x8FFE0,0x90000))};
    };
    let comparisons=0;
    const cases=[
        ["sse_reg",[0x0F,0x58,0xC1]],
        ["sse_mem",[0x0F,0x58,0x05,...little(DATA)]],
        ["mmx_immediate",[0x0F,0x71,0xF0,1]],
        ["mmx_mem",[0x0F,0x6F,0x05,...little(DATA)]],
        ["sti_mmx_immediate",[0x0F,0x71,0xF0,1]],
        ["native_move_reg",[0x0F,0x10,0xC1]],
        ["native_move_mem",[0x0F,0x10,0x05,...little(DATA)]],
        ["native_integer",[0x66,0x0F,0xFE,0xC1]],
        ["native_immediate",[0x66,0x0F,0x71,0xF0,1]],
        ["sti_native_immediate",[0x66,0x0F,0x71,0xF0,1]],
        ["ldmxcsr",[0x0F,0xAE,0x15,...little(DATA)]],
        ["stmxcsr",[0x0F,0xAE,0x1D,...little(DATA)]],
        ["invalid_sse_mem",[0x0F,0x50,0x05,...little(DATA)],true],
        ["reserved_sse_mem",[0x0F,0x6C,0x05,...little(DATA)],true],
        ["integer_control",[0x90]],
        ["reserved_control",[0x0F,0xAE,0xE8]],
        ["invalid_control",[0x0F,0xC3,0xC0],true],
        ["invalid_x87_control",[0x0F,0xAE,0xC0],true],
    ];
    for(const [name,instruction,fault=false] of cases
        .filter(([name])=>!process.env.IR_DEBUG_CASES||process.env.IR_DEBUG_CASES.split(",").includes(name)))
    for(const tier of [1,2]) for(const opt of [0,1])
    for(const scenario of ["observe","clear_task","diagnostics","ordinary"]
        .filter(mode=>!process.env.IR_DEBUG_MODES||process.env.IR_DEBUG_MODES.split(",").includes(mode))) {
        const guarded=!name.endsWith("_control"),shadow=name.startsWith("sti_");
        if((!guarded||release)&&scenario==="clear_task")continue;
        const diagnostics=Number(scenario==="diagnostics");
        const observes=!release&&guarded&&["observe","clear_task"].includes(scenario);
        const deferred=!release&&guarded&&scenario!=="ordinary";
        const code=[...(shadow?[0xFB]:[]),...instruction,0x40,0xF4];
        const instructionPc=PC+Number(shadow),operandOffset=instruction[0]===0x66?4:3;
        const logPc=instructionPc+operandOffset;
        const results=[];
        for(const cached of [false,true]) {
            observer=null;
            assert.equal(e.ir_auto_config(0,16,64,192,256,64),1);
            cpu.jit_clear_cache();e.ir_cache_collect();
            assert.equal(await vm.configure_ir_diagnostics(diagnostics),true);
            cpu.in_hlt[0]=0;cpu.flags[0]=2;cpu.flags_changed[0]=0;
            cpu.is_32[0]=1;cpu.stack_size_32[0]=1;cpu.segment_offsets.fill(0,0,6);
            cpu.segment_is_null.fill(0,0,6);cpu.instruction_pointer[0]=PC;
            cpu.reg32.set([5,0,0,0,0x90000,0,DATA,DATA]);
            cpu.cr[0]=0x80010011|(scenario==="clear_task"?12:0);cpu.cr[3]=0x12000;cpu.cr[4]=512;
            words()[612>>2]=0;cpu.sreg.set([16,8,16,16,16,16]);
            cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
            cpu.segment_limits.fill(0xFFFFFFFF,0,6);
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=23;
            set32(0x3008,0xFFFF);set32(0x300C,0xCF9B00);
            set32(0x3010,0xFFFF);set32(0x3014,0xCF9300);
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
            for(const vector of [6,7,13]) {
                set32(0x2000+vector*8,8<<16|HANDLER&0xFFFF);
                set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);
            }
            cpu.mem8.fill(0xCC,0x8FFE0,0x90000);cpu.mem8[HANDLER]=0xF4;
            set32(0x12000,0x13003);
            for(let p=0;p<1024;p++)set32(0x13000+p*4,p*4096|3);
            e.full_clear_tlb();e.update_state_flags();
            e.fpu_discard_cache?.();cpu.fpu_st.fill(0);cpu.fpu_st[0]=1;
            cpu.fpu_stack_empty[0]=0;cpu.fpu_stack_ptr[0]=0;
            cpu.fpu_control_word[0]=0x37F;cpu.fpu_status_word[0]=0;
            cpu.reg_xmm32s.fill(0x3F800000);cpu.mxcsr[0]=0x1F80;
            for(let i=0;i<4;i++){set32(DATA+i*4,0x3F800000);set32(DATA+16+i*4,0x40000000);}
            if(name.includes("native_immediate"))cpu.reg_xmm32s[0]=0x00010001;
            if(name==="ldmxcsr") {set32(DATA,0x1F80);set32(DATA+16,0x3F80);}
            vm.write_memory(Uint8Array.from(code),PC);words()[664>>2]=0xFFFFFFFC;
            if(cached)assert(await cpu.ir_compile_cached(fault?instruction.length:code.length,tier,opt,1,64,8),name);
            // Leave automatic discovery active: a rejected owner must not trap
            // the real dispatcher in a zero-step/recompile loop.
            assert.equal(e.ir_auto_config(1,16,64,192,256,64),1);
            // Debug FP with diagnostic imports defers even when OSFXSR starts
            // enabled: those observers could otherwise clear it after a guard.
            cpu.cr[4]=["ordinary","diagnostics"].includes(scenario)?512:0;
            const before={hits:e.ir_cache_stat(2),steps:e.ir_cache_stat(10),zero:e.ir_cache_stat(12),
                attempts:e.ir_auto_stat(2)+e.ir_auto_stat(3)};
            let calls=0;
            observer=(pointer,length)=>{
                const message=new TextDecoder().decode(new Uint8Array(e.memory.buffer,pointer,length));
                if(!message.includes("task switch test with cr4.osfxsr=0"))return;
                if(cpu.instruction_pointer[0]!==logPc)return;
                calls++;
                // These bytes have not yet been decoded by the interpreter.
                if(name.includes("immediate"))cpu.mem8[instructionPc+operandOffset]=2;
                if(name.endsWith("_mem")||["ldmxcsr","stmxcsr"].includes(name))
                    cpu.mem8.set(little(DATA+16),instructionPc+operandOffset);
                if(scenario==="clear_task")cpu.cr[0]&=~12;
                cpu.reg_xmm32s[8]=0x13579BDF;cpu.reg32[3]=0x12345678;
                cpu.mem8[instructionPc+instruction.length]=0x48;
            };
            vm.run();deadline=performance.now()+5000;
            while(!cpu.in_hlt[0]){assert(performance.now()<deadline,"debug deferral must reach interpreter/HALT");await sleep(1);}
            await vm.stop();observer=null;
            assert.equal(calls,Number(observes),`${name}/${scenario}: actual interpreter logger executes once at the pre-operand PC`);
            assert.equal(e.ir_cache_stat(2)-before.hits,Number(cached));
            if(deferred) {
                assert.equal(e.ir_cache_stat(12)-before.zero,Number(cached),"zero-step owner is retired");
                assert.equal(e.ir_cache_stat(10)-before.steps,0,"deferred artifacts cannot retire guest work");
            }
            else if(cached&&!fault) {
                assert.equal(e.ir_cache_stat(12)-before.zero,0,"ordinary IR must not be blanket deferred");
                assert(e.ir_cache_stat(10)>before.steps,"non-observing IR must actually execute");
            }
            assert.equal(e.ir_auto_stat(2)+e.ir_auto_stat(3),before.attempts,"deferral cannot busy-recompile");
            // The existing CPU interpreter charges the faulting decode attempt;
            // a completed IR fault retires none. Count each path explicitly:
            // both execute the handler HLT once, without replaying the fault.
            const retired=fault?(cached&&!deferred?1:2):3;
            assert.equal(words()[664>>2],(0xFFFFFFFC+retired+Number(shadow))>>>0,
                `${name}/${scenario}/${cached}: exact fault/success accounting`);
            const state=snapshot();
            assert.equal(state.gpr[0],fault?5:observes?4:6,"the interpreter observes the callback's future opcode write");
            if(name==="sse_reg")assert.equal(state.xmm[0],0x40000000);
            if(name==="sse_mem")assert.equal(state.xmm[0],observes?0x40400000:0x40000000);
            if(name.includes("mmx_immediate"))assert.equal(state.fpu[0],observes?4:2,"the immediate is read after the log callback");
            if(name==="mmx_mem")assert.equal(state.fpu[0],observes?0x40000000:0x3F800000);
            if(name==="native_move_mem")assert.equal(state.xmm[0],observes?0x40000000:0x3F800000);
            if(name==="native_integer")assert.equal(state.xmm[0],0x7F000000);
            if(name.includes("native_immediate"))assert.equal(state.xmm[0],observes?0x00040004:0x00020002);
            if(name==="ldmxcsr")assert.equal(state.mxcsr,observes?0x3F80:0x1F80);
            if(name==="stmxcsr")assert.equal(view().getUint32(DATA+(observes?16:0),true),0x1F80);
            if(fault)assert.equal(state.pc,HANDLER+1,"the exact #UD path reaches its handler once");
            results.push(state);
        }
        if(fault&&!deferred) {
            assert.equal(results[1].count,(results[0].count-1)>>>0,
                "ordinary IR fault excludes the interpreter's faulting decode attempt");
            assert.deepEqual({...results[1],count:results[0].count},results[0],
                `${name}/${tier}/${opt}/${scenario}: fault architectural state is exact`);
            if(process.env.IR_DEBUG_CASES)
                console.log(`FAULT ACCOUNTING ${name}/${tier}/${opt}/${scenario}: interpreter=${results[0].count} IR=${results[1].count}`);
        }
        else assert.deepEqual(results[1],results[0],`${name}/${tier}/${opt}/${scenario}: cached deferral matches all interpreter state and counts`);
        comparisons++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${wasm}: ${comparisons} SSE/MMX/native SIMD/FP-state/invalid dispatch comparisons, mutable operands/CR0, STI, diagnostic deferral, ordinary IR execution and exact counter wrap`);
} finally {
    observer=null;await vm.destroy();
}
