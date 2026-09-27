import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-loops/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-loops/${i}-${opt}.wasm`))));
const memory=new WebAssembly.Memory({initial:64}),standalone_words=new Uint32Array(memory.buffer);
const standalone=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-loops/${i}-${opt}-standalone.wasm`)),{e:{m:memory}})));
const chains=JSON.parse(fs.readFileSync("build/ir-loops/chains.json"));
const chain_modules=chains.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-loops/chain-${i}-${opt}.wasm`))));
function reference(c,counter,flags){
    const [bytes,,operand,address,op,disp,pc]=c;
    const next=(pc+bytes.length)>>>0;
    const result=op===0xE3?counter:address===32?(counter-1)>>>0:((counter&0xFFFF0000)|((counter-1)&65535))>>>0;
    const selected=address===32?result:result&65535;
    const taken=op===0xE3?selected===0:selected!==0&&(op===0xE2||(op===0xE1)===!!(flags&64));
    let target=(next+disp)>>>0;if(operand===16)target&=65535;
    return {counter:result,ip:taken?target:next,taken};
}
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true);
    vm.run();const deadline=performance.now()+10000;while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x100000,STACK=0x90000,HANDLER=0x180000;let active=-1;
    e.ir_test_set_cr0(cpu.cr[0]|0x10000);
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:{...e,m:e.memory}}))),chain_instances=chain_modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:{...e,m:e.memory}})));
    function reset(i,counter,flags,lazy=false,code=PC){
        const [bytes,mode,,,,,pc]=cases[i];cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.stack_size_32[0]=1;words[612>>2]=0;
        cpu.segment_offsets[1]=(code-pc)>>>0;cpu.reg32.set([0x7FFFFFFF,counter,0x11223344,0x80000000,STACK,0x99AABBCC,0x12345678,0xFEDCBA98]);
        cpu.is_32[0]=+mode;cpu.flags[0]=flags;cpu.flags_changed[0]=lazy?0x8D5:0;words[96>>2]=31;words[104>>2]=0x7FFFFFFF;words[112>>2]=flags&64?0:0x80000000;
        cpu.instruction_pointer[0]=code;cpu.in_hlt[0]=0;words[664>>2]=100;
        if(active!==i||code!==PC){mem.set(bytes,code);active=code===PC?i:-1;}e.update_state_flags();
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,previous:words[560>>2]});
    const counters=[0,1,2,65535,65536,65537,0x7FFFFFFF,0x80000000,0xFFFFFFFF];
    let ordinary=0,standalone_count=0;
    for(let i=0;i<cases.length;i++) for(const counter of counters) for(const flags of [2,0x42,0x897,0x8D7]) for(const lazy of [false,true]) for(const opt of [0,1]){
        reset(i,counter,flags,lazy);const input=state(),expected=reference(cases[i],counter,input.flags),base=cpu.segment_offsets[1]>>>0;
        instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],101);assert.equal(actual.regs[1],expected.counter);assert.equal(actual.flags,input.flags);assert.equal(actual.last,input.last);assert.equal(actual.ip,(base+expected.ip)>>>0);assert.equal(actual.previous,PC);
        reset(i,counter,flags,lazy);e.ir_test_step();assert.deepEqual(actual,state(),`counter branch ${i}, ECX=${counter}, flags=${flags}, lazy=${lazy}, opt=${opt}`);ordinary++;
        if(!lazy){
            standalone_words.set(input.regs,0);standalone_words[8]=input.flags;standalone_words[9]=cases[i][6];standalone_words[10]=100;standalone_words[11]=input.last;
            standalone[i][opt].exports.f(0);const expected_regs=input.regs.slice();expected_regs[1]=expected.counter;
            assert.deepEqual(Array.from(standalone_words.slice(0,8)),expected_regs);assert.equal(standalone_words[8],input.flags);assert.equal(standalone_words[9],expected.ip);assert.equal(standalone_words[10],1);assert.equal(standalone_words[11],input.last);standalone_count++;
        }
    }
    console.log(`PASS: ${ordinary} LOOP/LOOPcc/JCXZ CPU comparisons, ${standalone_count} standalone reference executions`);
    let exhaustive=0;
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[1]&&c[2]===32&&c[3]===16&&c[5]===-17&&c[6]===PC);
    for(const [,i] of selected) for(const flags of [2,0x42]) for(const opt of [0,1]) for(let cx=0;cx<65536;cx++){
        const counter=(0xABCD0000|cx)>>>0;reset(i,counter,flags);instances[i][opt].exports.f(0);const actual=state(),expected=reference(cases[i],counter,flags);
        assert.equal(actual.regs[1],expected.counter);assert.equal(actual.ip,expected.ip);assert.equal(actual.flags,flags);assert.equal(words[664>>2],101);
        reset(i,counter,flags);e.ir_test_step();assert.deepEqual(actual,state());exhaustive++;
    }
    console.log(`PASS: ${exhaustive} exhaustive CX values, both ZF values, all counter-branch kinds`);
    let sequences=0;
    const base_case=cases.findIndex(c=>c[1]&&c[6]===PC);
    for(let n=0;n<chains.length;n++) for(const counter of counters) for(const value of [0,1,0x7FFFFFFF,0xFFFFFFFF]) for(const opt of [0,1]){
        const configure=()=>{reset(base_case,counter,0x8D7,true);cpu.reg32[0]=value;mem.set(chains[n],PC);active=-1;};
        configure();chain_instances[n][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`counter chain ${n}`);sequences++;
    }
    console.log(`PASS: ${sequences} counter/FLAGS SSA chains, including constant counters and partial ECX writes`);
    let target_faults=0;
    for(let i=0;i<cases.length;i++){const c=cases[i];if(c[5]!==127||c[6]!==PC) continue;for(const opt of [0,1]){
        const counter=c[4]===0xE3?0:2,flags=c[4]===0xE1?0x42:2,code=PC+0xFF0;
        const target=((code-c[6])+reference(c,counter,flags).ip)>>>0,page=target>>>12;
        assert.notEqual(page,code>>>12);
        const configure=()=>{reset(i,counter,flags,false,code);cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
            set32(0x2000+14*8,8<<16|HANDLER&65535);set32(0x2004+14*8,HANDLER&0xFFFF0000|0x8E00);
            set32(0x13000+page*4,0);mem.fill(0xCC,STACK-32,STACK);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const completed=state();assert.equal(completed.ip,target);assert.equal(words[664>>2],101);
        e.ir_test_step();const actual={...state(),cr2:cpu.cr[2]>>>0,frame:Array.from(mem.slice(STACK-32,STACK))};assert.equal(actual.ip,HANDLER);assert.equal(actual.cr2,target);assert.equal(words[664>>2],101);
        configure();e.ir_test_step();assert.deepEqual(completed,state());e.ir_test_step();assert.deepEqual(actual,{...state(),cr2:cpu.cr[2]>>>0,frame:Array.from(mem.slice(STACK-32,STACK))});
        set32(0x13000+page*4,page*4096|3);e.full_clear_tlb();target_faults++;
    }}
    console.log(`PASS: ${target_faults} next-target #PF cases after branch/count commit, with nonzero CS bases`);
} finally {await vm.destroy();}
