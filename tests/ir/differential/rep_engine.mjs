import assert from "node:assert/strict";
import {boot, SOURCE, DEST, PC, STACK, HANDLER, source, destination, encode} from "./rep_cpu.mjs";
const reference=await boot(process.env.IR_REP_REFERENCE||"build/v86-rep-reference.wasm"),current=await boot("build/v86-ir-test.wasm");
try {
    const cases=[];for(const mode of [false,true]) for(const asize of [false,true]) for(const width of [1,2,4]) for(let kind=0;kind<7;kind++) for(const repne of [false,true]) for(const df of [0,1]) for(const count of [0,1,3,17])cases.push({mode,asize,width,kind,repne,df,count,seg:3});
    let ordinary=0;
    for(const c of cases){reference.reset(c);reference.step();const expected=reference.state(),events=reference.events();
        current.reset(c);current.step();assert.deepEqual(current.state(),expected,`legacy REP ${JSON.stringify(c)}`);assert.deepEqual(current.events(),events);
        current.reset(c);const result=current.batch(0xFFFFFFFF);assert.deepEqual(current.state(),expected,`explicit REP ${JSON.stringify(c)}`);assert.deepEqual(current.events(),events);assert.equal(result.outcome,expected.ip===PC?1:0);assert.equal(result.iterations,c.count-(expected.regs[1]&(c.asize?-1:65535)));ordinary++;
    }
    console.log(`PASS: ${ordinary} old/new legacy and explicit REP engine comparisons`);
    const selected=cases.filter(c=>!c.mode&&c.count===17&&c.df===0);
    let device=0;
    for(const c of selected){const configure=x=>{x.reset(c);const [from,to]=x.addresses();if(source(c.kind))x.set32(0x13000+(from>>>12)*4,0xA0003);if(destination(c.kind))x.set32(0x13000+(to>>>12)*4,0xA1003);x.e.full_clear_tlb();};
        configure(reference);reference.step();const expected=reference.state(),events=reference.events();configure(current);const result=current.batch(0xFFFFFFFF);assert.equal(result.outcome,0);assert.deepEqual(current.state(),expected);assert.deepEqual(current.events(),events,`REP device ${JSON.stringify(c)}`);device++;
    }
    console.log(`PASS: ${device} complete REP memory/port device event sequences`);
    let faults=0;
    for(const base of selected) for(const fault of ["segment","first","later"]){const c={...base,si:fault==="later"?0x1000-3*base.width:0x40,di:fault==="later"?0x1000-3*base.width:0x80};
        const configure=x=>{x.reset(c);const [from,to]=x.addresses();if(fault==="segment")x.cpu.segment_is_null[destination(c.kind)?0:3]=1;else {x.set32(0x13000+((destination(c.kind)?to:from)>>>12)*4+(fault==="later"?4:0),0);}x.e.full_clear_tlb();x.e.update_state_flags();};
        configure(reference);reference.step();const expected=reference.state(),events=reference.events();configure(current);const result=current.batch(0xFFFFFFFF);assert.deepEqual(current.state(),expected,`REP fault ${JSON.stringify(c)}/${fault}`);assert.deepEqual(current.events(),events);assert.equal(result.outcome,expected.ip===HANDLER?2:1);assert.equal(result.iterations,c.count-(expected.regs[1]& (c.asize?-1:65535)));faults++;
    }
    console.log(`PASS: ${faults} REP segment/page faults and partial-progress states`);
    let bounded=0;
    for(const base of selected) for(const limit of [0,1,2,5,16,17,18]){const c={...base,count:17};current.reset(c);const initial=current.state();const result=current.batch(limit),actual=current.state();assert(result.iterations<=limit);assert.equal(result.iterations,Math.min(limit,c.count));assert.equal(result.outcome,limit<c.count?1:0);assert.equal(actual.regs[1]&(c.asize?-1:65535),c.count-result.iterations);assert.equal(actual.count,100);
        if(limit===0){assert.deepEqual(actual,initial);assert.equal(current.events().length,0);} else if(limit<c.count){assert.equal(actual.ip,PC);if([1,4].includes(c.kind)){assert.equal(actual.flags,initial.flags);assert.equal(actual.last,initial.last);}}
        bounded++;
    }
    console.log(`PASS: ${bounded} zero/exact/partial REP element budgets`);
    let continuation=0;
    for(const c of selected){reference.reset(c);reference.step();const expected=reference.state();current.reset(c);let iterations=0,calls=0;for(;;){const result=current.batch(3);iterations+=result.iterations;calls++;assert(calls<10);if(result.outcome===0) break;assert.equal(result.outcome,1);}assert.equal(iterations,c.count);assert.deepEqual(current.state(),expected,`REP resume ${JSON.stringify(c)}`);continuation++;}
    console.log(`PASS: ${continuation} repeated bounded entries without duplicated iterations`);
    let termination=0;
    for(const c of selected) if([1,4].includes(c.kind)) for(const stop of [0,1,3,16]) for(const limit of [1,2,5]){
        const configure=x=>{x.reset(c);const [,to]=x.addresses();x.mem.fill(c.repne?0x55:0x66,to+stop*c.width,to+(stop+1)*c.width);};
        configure(reference);reference.step();const expected=reference.state();configure(current);let iterations=0,calls=0;for(;;){const result=current.batch(limit);iterations+=result.iterations;assert(++calls<30);if(result.outcome===0) break;assert.equal(result.outcome,1);}assert.equal(iterations,stop+1);assert.deepEqual(current.state(),expected);termination++;
    }
    console.log(`PASS: ${termination} REPE/REPNE early termination across budget cuts`);
    let huge=0;
    for(const base of selected){const c={...base,count:0xFFFFFFFF};current.reset(c);const result=current.batch(2),actual=current.state();assert.equal(result.outcome,1);assert.equal(result.iterations,2);assert.equal(actual.regs[1],c.asize?0xFFFFFFFD:0xAAAAFFFD);assert.equal(actual.ip,PC);huge++;}
    console.log(`PASS: ${huge} maximal unsigned counters bounded to two iterations`);
    let zero=0;
    for(const base of selected){const c={...base,count:0};for(const x of [reference,current]){x.reset(c);x.cpu.segment_is_null.fill(1,0,6);x.e.update_state_flags();}reference.step();const result=current.batch(0);assert.equal(result.outcome,0);assert.equal(result.iterations,0);assert.deepEqual(current.state(),reference.state());assert.equal(current.events().length,0);zero++;}
    console.log(`PASS: ${zero} zero-count precedence over budget, segments and devices`);
    let refault=0;
    for(const base of selected) if(base.asize){const c={...base,si:0x1000-base.width*3,di:0x1000-base.width*3};const configure=x=>{x.reset(c);const [from,to]=x.addresses();x.set32(0x13000+((destination(c.kind)?to:from)>>>12)*4+4,0);x.e.full_clear_tlb();};
        configure(reference);reference.step();reference.step();const expected=reference.state();configure(current);const first=current.batch(0xFFFFFFFF),second=current.batch(0xFFFFFFFF);assert.equal(first.outcome,1);assert.equal(first.iterations,3);assert.equal(second.outcome,2);assert.equal(second.iterations,0);assert.deepEqual(current.state(),expected);assert.deepEqual(current.events(),reference.events());refault++;}
    console.log(`PASS: ${refault} page-batch reentry faults without duplicated progress`);
    let same_ip_fault=0;
    for(const base of selected){const c={...base,handler:PC+encode(base).length};const configure=x=>{x.reset(c);x.cpu.segment_is_null[destination(c.kind)?0:3]=1;x.e.update_state_flags();};configure(reference);reference.step();configure(current);const result=current.batch(3);assert.equal(result.outcome,2);assert.equal(result.iterations,0);assert.equal(current.state().ip,c.handler);assert.deepEqual(current.state(),reference.state());same_ip_fault++;}
    console.log(`PASS: ${same_ip_fault} explicit fault outcomes when handler IP equals decoded next IP`);
    let aliases=0;
    for(const asize of [false,true]) for(const width of [1,2,4]) for(const df of [0,1]) for(const gap of [-width,0,width,3*width]) for(const limit of [1,2,5]){
        const c={mode:true,asize,width,kind:0,repne:false,df,count:17,seg:3,si:0x100,di:0x100+gap};
        const configure=x=>{x.reset(c);const [from,to]=x.addresses();for(let n=-128;n<128;n++)x.mem[from+n]=(n*7+93)&255;x.set32(0x13000+(to>>>12)*4,(from&~4095)|3);x.e.full_clear_tlb();};
        configure(reference);reference.step();const expected=reference.state();configure(current);let iterations=0,calls=0;for(;;){const result=current.batch(limit);iterations+=result.iterations;assert(++calls<30);if(result.outcome===0) break;assert.equal(result.outcome,1);}assert.equal(iterations,c.count);assert.deepEqual(current.state(),expected);aliases++;
    }
    console.log(`PASS: ${aliases} physical-alias and LZ overlap copies across budget cuts`);
    let privilege_faults=0;
    for(const c of selected) if(c.kind>=5){const configure=x=>{x.reset(c);x.words[612>>2]=3;x.cpu.sreg[1]=0x1B;x.cpu.sreg[2]=0x23;x.cpu.segment_access_bytes[1]=0xFB;x.cpu.segment_access_bytes[2]=0xF3;x.cpu.segment_offsets[6]=0x4000;x.cpu.segment_limits[6]=0x67;x.cpu.tss_size_32[0]=0;x.set16(0x4002,0x9000);x.set16(0x4004,16);x.mem.fill(0xCC,0x8FA0,0x9000);x.window(0x8FA0,96);x.set32(0x12000,0x13007);x.set32(0x13000+4*4,0x4003);x.set32(0x13000+8*4,0x8007);x.e.full_clear_tlb();x.e.update_state_flags();};
        configure(reference);reference.step();configure(current);const result=current.batch(3);assert.equal(result.outcome,2);assert.equal(result.iterations,0);assert.deepEqual(current.state(),reference.state());assert.equal(current.events().length,0);privilege_faults++;}
    console.log(`PASS: ${privilege_faults} REP I/O permission failures with explicit zero progress`);
    let overrides=0;
    for(const base of selected) for(const seg of [0,1,2,3,4,5]){
        const c={...base,seg};const configure=x=>{x.reset(c);const [from]=x.addresses();if(source(c.kind))x.mem.fill(0x55,from,from+128);};
        configure(reference);reference.step();configure(current);const result=current.batch(0xFFFFFFFF);assert.deepEqual(current.state(),reference.state());assert.deepEqual(current.events(),reference.events());assert.equal(result.outcome,0);overrides++;
    }
    console.log(`PASS: ${overrides} REP segment overrides and fixed ES destinations`);
} finally {await reference.vm.destroy();await current.vm.destroy();}
