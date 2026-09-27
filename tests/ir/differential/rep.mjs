import assert from "node:assert/strict";
import fs from "node:fs";
import {boot, PC, HANDLER, source, destination} from "./rep_cpu.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-rep/cases.json"));
const reference=await boot("build/v86-rep-reference.wasm"),current=await boot("build/v86-ir-test.wasm");
const cache=new Map();
function instance(i,limit,entry,opt){const key=`${i}-${limit}-${entry}-${opt}`;if(!cache.has(key))cache.set(key,new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-rep/${key}.wasm`)),{e:{...current.e,m:current.e.memory}}));return cache.get(key);}
const config=(i,count,df=0)=>{const [,mode,width,asize,kind,repne,seg]=cases[i];return {mode,width,asize,kind,repne,seg:seg<0?3:seg,count,df};};
function reset(x,i,c){x.reset(c);x.mem.set(cases[i][0],x.cpu.instruction_pointer[0]);const [from]=x.addresses();if(source(c.kind)&&c.seg===2)x.mem.fill(0x55,from,from+128);}
function comparable(x){const state=x.state();delete state.count;return state;}
function run(i,limit,entry,opt){instance(i,limit,entry,opt).exports.f(0);const packed=current.e.ir_rep_result();return {outcome:Number(packed&0xFFFFFFFFn),iterations:Number(packed>>32n)};}
try {
    let ordinary=0;
    for(let i=0;i<cases.length;i++) for(const count of [0,1,5]) for(const df of [0,1]) for(const opt of [0,1]){
        const c=config(i,count,df);reset(reference,i,c);reference.step();reference.step();const expected=comparable(reference),events=reference.events();reset(current,i,c);const result=run(i,128,0,opt);assert.equal(result.outcome,4);assert.equal(result.iterations,count-(expected.regs[1]&(c.asize?-1:65535)));assert.equal(current.state().count,102);assert.deepEqual(comparable(current),expected,`REP IR ${i}/${count}/${df}/${opt}`);assert.deepEqual(current.events(),events);ordinary++;
    }
    console.log(`PASS: ${ordinary} optimized/unoptimized REP IR CPU/observer comparisons`);
    const selected=cases.map((c,i)=>[config(i,17),i]).filter(([,i])=>cases[i][6]===-1);
    let partial=0,work=0;
    for(const [c,i] of selected) for(const opt of [0,1]) for(const limit of [1,3]){
        reset(reference,i,c);reference.step();reference.step();const expected=comparable(reference);reset(current,i,c);let entry=0,iterations=0,calls=0;
        for(;;){const result=run(i,limit,entry,opt);calls++;assert(calls<20);iterations+=result.iterations;assert(result.iterations<=limit);assert.equal(current.state().count,result.outcome===4?102:101);if(result.outcome===4) break;assert.equal(result.outcome,3);assert.equal(current.state().ip,PC+1);entry=1;}
        assert.equal(iterations,c.count);assert.deepEqual(comparable(current),expected,`REP resume ${i}/${limit}/${opt}`);partial++;work+=iterations;
    }
    console.log(`PASS: ${partial} bounded IR reentry sequences, ${work} elements counted with one final instruction commit`);
    let zero=0;
    for(const [base,i] of selected) for(const opt of [0,1]) for(const count of [0,17]){
        const c={...base,count};reset(current,i,c);const result=run(i,0,0,opt);assert.equal(result.outcome,count?3:4);assert.equal(result.iterations,0);assert.equal(current.state().count,count?101:102);assert.equal(current.events().length,0);
        if(count){const next=run(i,128,1,opt);assert.equal(next.outcome,4);assert.equal(next.iterations,count);assert.equal(current.state().count,102);}
        current.e.ir_enter();assert.equal(current.e.ir_rep_result(),0n,"entry clears prior REP work metadata");zero++;
    }
    console.log(`PASS: ${zero} zero-budget/zero-count boundaries and runtime result reset checks`);
    let devices=0;
    for(const [c,i] of selected) for(const opt of [0,1]){
        const configure=x=>{reset(x,i,c);const [from,to]=x.addresses();if(source(c.kind))x.set32(0x13000+(from>>>12)*4,0xA0003);if(destination(c.kind))x.set32(0x13000+(to>>>12)*4,0xA1003);x.e.full_clear_tlb();};
        configure(reference);reference.step();reference.step();const expected=comparable(reference),events=reference.events();configure(current);const result=run(i,128,0,opt);assert.equal(result.outcome,4);assert.equal(current.state().count,102);assert.deepEqual(comparable(current),expected);assert.deepEqual(current.events(),events,`REP IR devices ${i}/${opt}`);devices++;
    }
    console.log(`PASS: ${devices} REP IR MMIO and port event sequences`);
    let faults=0;
    for(const [base,i] of selected) for(const opt of [0,1]) for(const fault of ["segment","first","later"]){const c={...base,si:fault==="later"?0x1000-3*base.width:0x40,di:fault==="later"?0x1000-3*base.width:0x80};
        const configure=x=>{reset(x,i,c);const [from,to]=x.addresses();if(fault==="segment")x.cpu.segment_is_null[destination(c.kind)?0:3]=1;else {x.set32(0x13000+((destination(c.kind)?to:from)>>>12)*4+(fault==="later"?4:0),0);}x.e.full_clear_tlb();x.e.update_state_flags();};
        configure(reference);reference.step();reference.step();const expected=comparable(reference),events=reference.events();configure(current);const result=run(i,128,0,opt);assert.equal(result.outcome,expected.ip===HANDLER?2:3);assert.equal(result.iterations,c.count-(expected.regs[1]&(c.asize?-1:65535)));assert.equal(current.state().count,101);assert.deepEqual(comparable(current),expected,`REP IR fault ${i}/${fault}`);assert.deepEqual(current.events(),events);faults++;
        if(result.outcome===3){reference.step();const expected=comparable(reference),again=run(i,128,1,opt);assert.equal(again.outcome,2);assert.equal(again.iterations,0);assert.equal(current.state().count,101);assert.deepEqual(comparable(current),expected);faults++;}
    }
    console.log(`PASS: ${faults} REP IR faults/page reentry with precise partial work and no final commit`);
    let termination=0;
    for(const [c,i] of selected) if([1,4].includes(c.kind)) for(const opt of [0,1]) for(const stop of [0,1,3,16]){
        const configure=x=>{reset(x,i,c);const [,to]=x.addresses();x.mem.fill(c.repne?0x55:0x66,to+stop*c.width,to+(stop+1)*c.width);};
        configure(reference);reference.step();reference.step();const expected=comparable(reference);configure(current);let entry=0,iterations=0;for(let calls=0;;calls++){assert(calls<20);const result=run(i,3,entry,opt);iterations+=result.iterations;if(result.outcome===4) break;assert.equal(result.outcome,3);assert.equal(current.state().count,101);entry=1;}assert.equal(iterations,stop+1);assert.equal(current.state().count,102);assert.deepEqual(comparable(current),expected);termination++;
    }
    console.log(`PASS: ${termination} REPE/REPNE IR termination and FLAGS across budget cuts`);
    let huge=0;
    for(const [base,i] of selected) for(const opt of [0,1]){const c={...base,count:0xFFFFFFFF};reset(current,i,c);const result=run(i,1,0,opt);assert.equal(result.outcome,3);assert.equal(result.iterations,1);assert.equal(current.state().count,101);assert.equal(current.state().regs[1],c.asize?0xFFFFFFFE:0xAAAAFFFE);huge++;}
    console.log(`PASS: ${huge} maximal REP counters bounded by IR without a final commit`);
    let zero_faults=0;
    for(const [base,i] of selected) for(const opt of [0,1]){const c={...base,count:0};reset(current,i,c);current.cpu.segment_is_null.fill(1,0,6);const [from,to]=current.addresses();current.set32(0x13000+(from>>>12)*4,0);current.set32(0x13000+(to>>>12)*4,0);current.e.full_clear_tlb();current.e.update_state_flags();const result=run(i,0,0,opt);assert.equal(result.outcome,4);assert.equal(result.iterations,0);assert.equal(current.state().count,102);assert.equal(current.events().length,0);zero_faults++;}
    console.log(`PASS: ${zero_faults} zero-count IR completion before invalid segments and mappings`);
    const index=cases.findIndex(c=>c[1]&&c[2]===1&&c[3]&&c[4]===0&&!c[5]&&c[6]===-1);
    reset(current,index,config(index,17));const compiled=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync("build/ir-rep/request-3.wasm")),{e:{...current.e,m:current.e.memory}});compiled.exports.f(0);assert.equal(current.e.ir_rep_result(),3n<<32n|3n);assert.equal(current.state().count,101);assert.equal(current.state().regs[1],14);
    console.log("PASS: immutable CPU CompileRequest applies its distinct REP iteration budget");
    let outcomes=0;
    for(const opt of [0,1]) for(const status of [0,1,2,3,4,99]){
        const mod=new WebAssembly.Module(fs.readFileSync(`build/ir-rep/${index}-3-0-${opt}.wasm`));const fake=new WebAssembly.Instance(mod,{e:{...current.e,m:current.e.memory,ir_rep_movs:()=>{current.cpu.reg32[0]=0x2468ACE0;current.cpu.instruction_pointer[0]=0x200000;current.words[664>>2]=777;return status;}}});reset(current,index,config(index,17));
        let trapped=false;try {fake.exports.f(0);} catch(error){assert(error instanceof WebAssembly.RuntimeError);trapped=true;}assert.equal(trapped,![2,3,4].includes(status));assert.equal(current.state().regs[0],0x2468ACE0);assert.equal(current.state().ip,0x200000);assert.equal(current.state().count,777);outcomes++;
    }
    console.log(`PASS: ${outcomes} terminal REP outcome checks preserving authoritative CPU state`);
    let privilege_faults=0;
    for(const [c,i] of selected) if(c.kind>=5) for(const opt of [0,1]){
        const configure=x=>{reset(x,i,c);x.words[612>>2]=3;x.cpu.sreg[1]=0x1B;x.cpu.sreg[2]=0x23;x.cpu.segment_access_bytes[1]=0xFB;x.cpu.segment_access_bytes[2]=0xF3;x.cpu.segment_offsets[6]=0x4000;x.cpu.segment_limits[6]=0x67;x.cpu.tss_size_32[0]=0;x.set16(0x4002,0x9000);x.set16(0x4004,16);x.mem.fill(0xCC,0x8FA0,0x9000);x.window(0x8FA0,96);x.set32(0x12000,0x13007);x.set32(0x13000+4*4,0x4003);x.set32(0x13000+8*4,0x8007);x.e.full_clear_tlb();x.e.update_state_flags();};
        configure(reference);reference.step();reference.step();configure(current);const result=run(i,3,0,opt);assert.equal(result.outcome,2);assert.equal(result.iterations,0);assert.equal(current.state().count,101);assert.deepEqual(comparable(current),comparable(reference));assert.equal(current.events().length,0);privilege_faults++;
    }
    console.log(`PASS: ${privilege_faults} REP IR I/O permission faults before element work`);
} finally {await reference.vm.destroy();await current.vm.destroy();}
