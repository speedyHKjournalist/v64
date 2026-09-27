// Randomized differential test of inlined fast-math x87 (ir::x87::native)
// against the interpreter. Each program is a loop of x87 memory/register
// forms, fallback forms and FLDCW mode changes over special operands. Every IR
// run (interpreted, Tier 1, Tier 2) starts from the same state and must end in
// the interpreter's architectural state, compared after syncing the f64 cache.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const wasm=process.argv[2]||"build/v86-ir-runtime.wasm";
const programs=Number(process.env.IR_X87_PROGRAMS||120);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BASE=0x100000,DATA=0x80000,OUT=DATA+0x100,ITERATIONS=24;

let seed=Number(process.env.IR_X87_SEED||0x87);
const random=n=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return (seed>>>8)%n;};
const pick=list=>list[random(list.length)];

// Operands at DATA: f32 words, f64 words, integers and control words.
function fill(view){
    const f32=[1,-2.5,0,-0,Infinity,-Infinity,NaN,1.401298464324817e-45,3.4028234663852886e38,0.1,1e-39,65504.5];
    f32.forEach((v,i)=>view.setFloat32(DATA+4*i,v,true));
    const f64=[1.5,-0.1,0,-0,Infinity,NaN,5e-324,1.7976931348623157e308,2147483647.5,-2147483648.5,3.5,1e300];
    f64.forEach((v,i)=>view.setFloat64(DATA+0x30+8*i,v,true));
    const i32=[0,1,-1,0x7FFFFFFF,-0x80000000,123456789,-7,40000];
    i32.forEach((v,i)=>view.setInt32(DATA+0x90+4*i,v,true));
    [0x7FFFFFFFn,-0x8000000000000000n,1n<<53n,(1n<<53n)+1n,-(1n<<53n)-1n,99n].forEach((v,i)=>view.setBigInt64(DATA+0xB0+8*i,v,true));
    [0x037F,0x077F,0x0B7F,0x0F7F,0x027F,0x007F,0x0E7F,0x033F].forEach((v,i)=>view.setUint16(DATA+0xE0+2*i,v,true));
    for(let i=0;i<0x40;i++)view.setUint8(OUT+i,0xCC);
}
const f32=()=>4*random(12),f64=()=>0x30+8*random(12),i32=()=>0x90+4*random(8),i16=()=>0x90+2*random(16),i64=()=>0xB0+8*random(6),cw=()=>0xE0+2*random(8);
// ModRM mod=01: [esi+disp8] (rm=6) for loads, [edi+disp8] (rm=7) for stores.
const load=(op,group,disp)=>[op,0x46|group<<3,disp];
const store=(op,group)=>[op,0x47|group<<3,8*random(8)];
const register=(op,group,r)=>[op,0xC0|group<<3|r];
function instruction(){
    switch(random(12)){
    case 0: return pick([()=>load(0xD9,0,f32()),()=>load(0xDD,0,f64()),()=>load(0xDB,0,i32()),()=>load(0xDF,0,i16()),()=>load(0xDF,5,i64())])();
    case 1: case 2: {const g=random(8);return pick([()=>load(0xD8,g,f32()),()=>load(0xDC,g,f64()),()=>load(0xDA,g,i32()),()=>load(0xDE,g,i16())])();}
    case 3: case 4: {
        const op=pick([0xD8,0xDC,0xDE]),g=random(8);
        return op===0xDE&&g===3?[0xDE,0xD9]:register(op,g,random(8)); // DE/3 is only FCOMPP
    }
    case 5: return pick([()=>register(0xD9,0,random(8)),()=>register(0xD9,1,random(8)),()=>register(0xDD,2,random(8)),()=>register(0xDD,3,random(8)),()=>[0xD9,0xE8],()=>[0xD9,0xEE]])();
    case 6: return pick([()=>[0xD9,0xE0],()=>[0xD9,0xE1],()=>register(0xDD,0,random(8)),()=>register(0xDF,0,random(8)),()=>[0xDE,0xD9],()=>[0xDA,0xE9],()=>register(0xDD,4,random(8)),()=>register(0xDD,5,random(8))])();
    case 7: case 8: return pick([()=>store(0xD9,2),()=>store(0xD9,3),()=>store(0xDD,2),()=>store(0xDD,3),()=>store(0xDB,1),()=>store(0xDB,2),()=>store(0xDB,3),()=>store(0xDF,1),()=>store(0xDF,2),()=>store(0xDF,3),()=>store(0xDD,1),()=>store(0xDF,7),()=>store(0xD9,7),()=>store(0xDD,7)])();
    case 9: return load(0xD9,5,cw());
    // Fallback-only forms interleaved with inlined ones.
    case 10: return pick([[0xD9,0xFA],[0xD9,0xEB],[0xD9,0xE5],[0xD9,0xFC],[0xDF,0xE0],[0xDB,0xF1]]);
    default: return [0xD9,0xC0|random(2)];
    }
}
function program(){
    const body=[];
    for(let n=4+random(20);n--;)body.push(...instruction());
    // DEC ECX; JNZ rel32 back to the start; HLT.
    const back=-(body.length+1+6);
    return [...body,0x49,0x0F,0x85,back&255,back>>8&255,back>>16&255,back>>>24,0xF4];
}

async function boot(options){
    const vm=new V86({wasm_path:wasm,memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
        disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false,...options});
    await new Promise((r,j)=>{vm.add_listener("emulator-loaded",r);vm.add_listener("emulator-error",j);});
    const cpu=vm.v86.cpu,view=()=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset);
    vm.run();const end=performance.now()+15000;
    while(view().getUint16(0x500,true)!==0xCAFE){assert(performance.now()<end,"boot");await sleep(1);}
    await vm.stop();
    return {vm,cpu,e:cpu.wm.exports,view};
}
async function execute(machine,pc){
    const {vm,cpu,e,view}=machine;
    fill(view());
    cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);cpu.is_32[0]=1;cpu.stack_size_32[0]=1;
    cpu.reg32.set([0x1234,ITERATIONS,0,0,0x90000,0,DATA,OUT]);
    cpu.flags[0]=2;cpu.flags_changed[0]=0;cpu.in_hlt[0]=0;cpu.instruction_pointer[0]=pc;
    e.fpu_discard_cache();cpu.fpu_st.fill(0);cpu.fpu_stack_empty[0]=255;cpu.fpu_stack_ptr[0]=0;
    e.set_control_word(0x37F);cpu.fpu_status_word[0]=0;
    e.update_state_flags();
    vm.run();const end=performance.now()+10000;
    while(!cpu.in_hlt[0]){assert(performance.now()<end,"program timeout");await sleep(0);}
    await vm.stop();
    e.fpu_sync_all();
    const bytes=new Uint8Array(cpu.fpu_st.buffer,cpu.fpu_st.byteOffset,cpu.fpu_st.byteLength);
    return {gpr:Array.from(cpu.reg32),flags:e.get_eflags(),ip:cpu.instruction_pointer[0],
        st:Array.from({length:8},(_,i)=>Array.from(bytes.slice(i*16,i*16+10))),
        empty:cpu.fpu_stack_empty[0],top:cpu.fpu_stack_ptr[0],control:cpu.fpu_control_word[0],status:cpu.fpu_status_word[0],
        out:Array.from(cpu.mem8.slice(OUT,OUT+0x40))};
}

const reference=await boot({disable_jit:true});
const ir=await boot({jit_backend:"ir",ir_region_budget:{hot_threshold:1,promotion_threshold:2}});
assert.equal(ir.e.ir_auto_set_heat_steps(0),1,"compile on first visit");
try {
    let compared=0,compiled=0;
    for(let n=0;n<programs;n++){
        const pc=BASE+n*0x1000,code=Uint8Array.from(program());
        reference.vm.write_memory(code,pc);ir.vm.write_memory(code,pc);
        const expected=await execute(reference,pc);
        const before=ir.e.ir_cache_stat(10);
        for(let run=0;run<12;run++){
            const actual=await execute(ir,pc);
            assert.deepEqual(actual,expected,`program ${n} run ${run}: ${Buffer.from(code).toString("hex")}`);
            compared++;await sleep(1);
        }
        if((ir.e.ir_cache_stat(10)-before)>>>0)compiled++;
    }
    assert(compiled>programs/2,`IR executed only ${compiled}/${programs} programs`);
    console.log(`PASS: ${wasm}: ${compared} randomized inlined/fallback x87 runs match the interpreter (${compiled}/${programs} programs ran IR code)`);
} finally {
    await reference.vm.destroy();await ir.vm.destroy();
}
