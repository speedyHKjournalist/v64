import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases = JSON.parse(fs.readFileSync("build/ir-cfg/cases.json"));
const modules = cases.map((_, i) => new WebAssembly.Module(fs.readFileSync(`build/ir-cfg/${i}.wasm`)));
const vm = new V86({wasm_path:process.argv[2] || "build/v86-ir-test.wasm", memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true, disable_mouse:true, disable_speaker:true, net_device:{type:"none"}, autostart:false});
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
    await new Promise(r => vm.add_listener("emulator-loaded", r));
    const cpu=vm.v86.cpu, e=cpu.wm.exports, mem=cpu.mem8, words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer, mem.byteOffset);
    vm.run(); const deadline=performance.now()+10000;
    while(view.getUint16(0x500,true)!==0xCAFE) { assert(performance.now()<deadline); await sleep(1); }
    await vm.stop();
    const instances=modules.map(m => new WebAssembly.Instance(m, {e:{...e,m:e.memory}}));
    const PC=0x100000, DATA=0x110000, STACK=0x90000;
    function reset(c, counter, flags, lazy, initial_count, cold) {
        const [,bytes,mode,pc]=c;
        cpu.segment_offsets.fill(0,0,6); cpu.segment_is_null.fill(0,0,6); cpu.segment_limits.fill(0xFFFFFFFF,0,6);
        cpu.sreg.set([16,8,16,16,16,16]); cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.stack_size_32[0]=1; words[612>>2]=0; cpu.segment_offsets[1]=(PC-pc)>>>0;
        cpu.reg32.set([0x7FFFFFFF,counter,0x11223344,0x80000000,STACK,0x99AABBCC,DATA,0xFEDCBA98]);
        // CPUID leaf 0 also exercises an adapter after the entry prologue.
        if(c[0]===11) cpu.reg32[0]=0;
        // These semantic fixtures must execute SSE instead of taking the debug
        // OSFXSR observer deferral. Fault/disabled-SSE paths have separate tests.
        cpu.cr[4] |= 0x600; cpu.cr[0] &= ~12;
        cpu.is_32[0]=+mode; cpu.flags[0]=flags; cpu.flags_changed[0]=lazy?0x8D5:0;
        words[96>>2]=31; words[104>>2]=0x7FFFFFFF; words[112>>2]=flags&64?0:0x80000000;
        cpu.instruction_pointer[0]=PC; cpu.in_hlt[0]=0; words[664>>2]=initial_count;
        mem.set(bytes,PC); view.setUint32(DATA,0x87654321,true);
        for(let j=0;j<32;j++) words[(832>>2)+j]=(Math.imul(j+1,0x91827365)^0xFEDCBA98)>>>0;
        e.update_state_flags();
        e.full_clear_tlb();
        if(!cold) e.ir_memory_read(DATA, 4);
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],
        ip:cpu.instruction_pointer[0]>>>0, xmm:Array.from(words.slice(832>>2,960>>2)), data:view.getUint32(DATA,true)});
    const raw_flags=()=>({flags:cpu.flags[0]>>>0,lazy_mask:cpu.flags_changed[0]>>>0,
        last_result:words[112>>2]>>>0,last_op1:words[104>>2]>>>0,last_op_size:words[96>>2]>>>0});
    let executions=0, steps=0, budget_comparisons=0;
    let baseline=[];
    for(let i=0;i<cases.length;i++) {
        const c=cases[i], [program,,,pc,budget,opt]=c;
        if(!opt) baseline=[];
        let trial=0;
        for(const counter of [0,1,2,7,0x10001,0xFFFFFFFF]) for(const flags of [2,0x8D7])
        for(const lazy of [false,true]) for(const initial_count_local of [100,0xFFFFFFFC]) {
            const cold=!!(executions&1);
            reset(c,counter,flags,lazy,initial_count_local,cold); const before=state(), raw_before=raw_flags();
            instances[i].exports.f(0);
            const actual=state(), raw_after=raw_flags(), count=(words[664>>2]-initial_count_local)>>>0;
            if(opt && program===3 && pc===0x1000) {
                assert.deepEqual(raw_flags(),raw_before,"pure self-loop preserves exact lazy FLAGS backing");
            }
            const observed={...actual,count,previous:words[560>>2]};
            if(opt) { assert.deepEqual(observed,baseline[trial],`optimization preserves exact budget exit: CFG ${i}`); budget_comparisons++; }
            else baseline.push(observed);
            trial++;
            assert(count<=budget,`unbounded guest count: ${i}, ${count}/${budget}`);
            if([2,13,18].includes(program) && budget>=2) {
                assert(count>0,`SSE CFG ${i} must execute rather than defer`);
            }
            if(program===3 && pc===0x1000) assert.equal(count,budget-1,"self-jump retirement count");
            if(program===4 && pc===0x1000 && (before.flags&64)) assert.equal(count,Math.floor(budget/2),"conditional self-jump retirement count");
            reset(c,counter,flags,lazy,initial_count_local,cold);
            for(let j=0;j<count;j++) e.ir_test_step();
            assert.deepEqual(actual,state(),`CFG ${i}, ECX=${counter}, flags=${flags}, lazy=${lazy}, count=${count}`);
            if(opt && (program===19 || program===20 || program===21 || program===22)) {
                assert.deepEqual(raw_after,raw_flags(),
                    program===19
                        ? "supported ALU preserves exact interpreter lazy FLAGS backing"
                        : program===22
                            ? "carry/direction controls preserve exact raw FLAGS backing"
                            : "ADC/SBB/INC/DEC preserve exact interpreter mixed FLAGS backing");
            }
            // ir_test_step deliberately bypasses the interpreter scheduler counter.
            executions++; steps+=count;
        }
    }
    console.log(`PASS: ${executions} reachable bytecode CFG comparisons, ${steps} interpreter steps; loops, diamonds, prefixes, count wrap, FLAGS/XMM state, cold/warm RAM and terminal adapters`);
    console.log(`PASS: ${budget_comparisons} exact optimized/unoptimized budget exits, including previous IP and retirement counts`);
    let faults=0;
    const HANDLER=0x180000, set32=(a,v)=>view.setUint32(a,v,true);
    for(let i=0;i<cases.length;i++) {
        const c=cases[i];
        if(![12,13,17,18].includes(c[0]) || c[3]!==0x1000 || c[4]!==100) continue;
        for(const initial_count_local_local of [100,0xFFFFFFFC]) for(const lazy of [false,true]) {
            const configure=()=>{
                reset(c,7,0x8D7,lazy,initial_count_local_local,false);
                cpu.idtr_offset[0]=0x2000; cpu.idtr_size[0]=0x7FF;
                set32(0x2000+14*8,8<<16|HANDLER&65535);
                set32(0x2004+14*8,HANDLER&0xFFFF0000|0x8E00);
                set32(0x13000+((DATA+4096)>>>12)*4,0);
                mem.fill(0xCC,STACK-32,STACK);
                e.full_clear_tlb(); e.ir_memory_read(DATA,4);
            };
            const fault_state=()=>({...state(),previous:words[560>>2],cr2:cpu.cr[2]>>>0,
                frame:Array.from(mem.slice(STACK-32,STACK))});
            configure(); instances[i].exports.f(0); const actual=fault_state();
            assert.equal(actual.ip,HANDLER); assert.equal(actual.cr2,DATA+4096);
            const retired = c[0] >= 17 ? 6 : 5;
            assert.equal(words[664>>2],(initial_count_local_local+retired)>>>0,"only completed instructions retire before second-iteration fault");
            configure(); for(let j=0;j<retired+1;j++) e.ir_test_step();
            assert.deepEqual(actual,fault_state(),`second-iteration #PF, CFG ${i}`);
            set32(0x13000+((DATA+4096)>>>12)*4,(DATA+4096)|3); e.full_clear_tlb();
            faults++;
        }
    }
    console.log(`PASS: ${faults} second-iteration scalar/vector #PF comparisons, including dirty GPR/FLAGS/XMM, CS-relative recovery, stack frames and wrapping retirement counts`);
    let skipped_faults=0;
    for(let i=0;i<cases.length;i++) {
        const c=cases[i]; if(![14,15].includes(c[0]) || c[3]!==0x1000 || c[4]!==100) continue;
        for(const initial_count_local_local_local of [100,0xFFFFFFFC]) for(const lazy of [false,true]) {
            const configure=()=>{
                reset(c,7,0x8D7,lazy,initial_count_local_local_local,true);
                set32(0x13000+(DATA>>>12)*4,0); e.full_clear_tlb();
            };
            const count=c[0]===14?3:6;
            configure(); instances[i].exports.f(0); const actual=state();
            assert.equal(actual.ip,PC+c[1].length);
            assert.equal(words[664>>2],(initial_count_local_local_local+count)>>>0);
            configure(); for(let j=0;j<count;j++) e.ir_test_step();
            assert.deepEqual(actual,state(),"constant branch must not execute the absent-page arm");
            set32(0x13000+(DATA>>>12)*4,DATA|3);e.full_clear_tlb(); skipped_faults++;
        }
    }
    console.log(`PASS: ${skipped_faults} constant branches skip absent-page reads with exact retirement and CPU state`);
} finally { await vm.destroy(); }
