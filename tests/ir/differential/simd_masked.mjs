import assert from "node:assert/strict";
import {runSseFixture} from "./debug_sse_fixture.mjs";
import fs from "node:fs";
import {masked} from "./masked_model.mjs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-simd-masked/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-simd-masked/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const release of [false,true]){
 const vm=new V86({wasm_path:release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
 try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),xmm=new Uint32Array(e.memory.buffer,832,32);
    const v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,BASE=0x310000,ALT=0x350000,STACK=0x90000,UD=0x180100,NM=0x180300,PF=0x180200,GP=0x180000,cr0=cpu.cr[0],cr3=cpu.cr[3],cr4=cpu.cr[4];let target,events=[],on_event,slow=0,guards=0;
    const imports={...e,m:e.memory,ir_xmm_masked_store:(...a)=>{slow++;return e.ir_xmm_masked_store(...a);},ir_xmm_load:(...a)=>{slow++;return e.ir_xmm_load(...a);},ir_xmm_store:(...a)=>{slow++;return e.ir_xmm_store(...a);},ir_sse_guard:()=>{guards++;return e.ir_sse_guard();}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    const extra=name=>[0,1].map(opt=>new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-simd-masked/${name}-${opt}.wasm`)),{e:imports}));
    const chain=extra("chain"),resume=extra("resume"),chain_bytes=JSON.parse(fs.readFileSync("build/ir-simd-masked/chain.json"));
    const visible=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),xmm:Array.from(xmm),flags:e.get_eflags()>>>0,rawZero:cpu.flags[0]&64,zeroLazy:cpu.flags_changed[0]&64,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0});
    const state=()=>({...visible(),previous:words[560>>2],cr:Array.from(cpu.cr,x=>x>>>0),cpl:words[612>>2]&255,sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),data:Buffer.from(mem.slice(target-16,target+32)),alternate:Buffer.from(mem.slice(ALT,ALT+0x1020)),frame:Buffer.from(mem.slice(STACK-128,STACK+16))});
    function desc(n,base,access){set32(0x3000+n*8,(base<<16)|0xFFFF);set32(0x3004+n*8,(base&0xFF000000)|(base>>>16&255)|access<<8|0xCF0000);}
    function set_mask(reg,bits){for(let lane=0;lane<16;lane++){const word=reg*4+(lane>>2),shift=(lane&3)*8+7;xmm[word]=((xmm[word]&~(1<<shift))|((bits>>>lane&1)<<shift))>>>0;}}
    function reset(i,{offset=0x40,hot=false,cpl=0,task=0,osfxsr=true,real=false,vm86=false,maskBits: mask_bits=0xA55A}={}){
        const [bytes,mode,asize,,,store,register,operand,seg]=cases[i];
        cpu.cr[3]=cr3;
        cpu.cr[4]=osfxsr?cr4|0x200:cr4&~0x200;e.ir_test_set_cr0((real?cr0&~0x80000001:cr0|0x10000)&~12|task);cpu.cr[2]=0xBADF000;
        cpu.segment_offsets.set([BASE,0,0,BASE,BASE,BASE]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,cpl?0x1B:8,cpl?0x23:16,16,16,16]);cpu.segment_access_bytes.set([0x93,cpl?0xFB:0x9B,cpl?0xF3:0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=cpl;
        cpu.reg32.set([0x12345678,0xFEDCBA98,0x89ABCDEF,0x7FFFFFFF,STACK,0x55555555,offset,offset]);
        const bits=[0x01000200,0x03000400,0x05000600,0x07000800,0x7FC12345,0x7F812345,0x80000001,0xFFFFFFFF];for(let r=0;r<8;r++) for(let lane=0;lane<4;lane++)xmm[r*4+lane]=bits[(r+lane)%8];
        set_mask(cases[i][9],mask_bits);
        cpu.flags[0]=0x8D7|(vm86?0x20000:0);cpu.flags_changed[0]=0;words[104>>2]=0x87654321;cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;mem.set(bytes,PC);
        target=(cpu.segment_offsets[seg<0?3:seg]+(asize===16?offset&65535:offset))>>>0;mem.fill(0xCC,target-16,target+32);[0x80000001,0x7F812345,0xFFFF00FF,0x00108010].forEach((n,l)=>set32(target+l*4,n));mem.fill(0x6D,ALT,ALT+0x1020);mem.fill(0xCC,STACK-128,STACK+16);
        desc(1,0,0x9B);desc(2,0,0x93);desc(3,0,0xFB);desc(4,0,0xF3);desc(5,0x4000,0x89);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const [vector,handler] of [[6,UD],[7,NM],[13,GP],[14,PF]]){set32(0x2000+vector*8,8<<16|handler&65535);set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13007);for(const page of [0,2,3,4,8,0x18,0x8F,0x90,0x310,0x311,0x31F,0x320,0x350,0x351])set32(0x13000+page*4,page*4096|7);
        e.full_clear_tlb();e.update_state_flags();if(hot&&operand>=8){e.ir_memory_write(target,mem[target],1);e.ir_memory_write(target+15,mem[target+15],1);}events=[];on_event=undefined;slow=guards=0;
    }
    const caught=f=>{try {f();return false;} catch(error){assert(error instanceof WebAssembly.RuntimeError);return true;}};
    function compare(i,configure,{fault=false,abort=false,check}={}){
        configure();e.ir_test_step();const before=visible(),data=Array.from({length:4},(_,l)=>get32(target+l*4));assert.equal(caught(()=>e.ir_test_step()),abort);const expected=state(),observed=events.slice();check?.(before,data,expected);
        const counts=[];for(const opt of [0,1]){configure();assert.equal(caught(()=>runSseFixture(instances[i][opt],cpu,e,state,{fault,abort,nextPc:cpu.instruction_pointer[0]+cases[i][0].length})),abort);assert.equal(words[664>>2],fault||abort?101:102);assert.deepEqual(state(),expected,`SSE masked store ${i}/${opt}`);assert.deepEqual(events,observed,`events ${i}/${opt}`);counts.push([slow,guards]);} return {expected,observed,counts};
    }
    let ordinary=0,native=0;
    for(let i=0;i<cases.length;i++) for(const hot of [false,true]) for(const mask_bits_local of [0,1,0x8000,0x5555,0xAAAA,0xFFFF]){
        const c=cases[i],[,,,,width,store,reg,operand]=c;
        const {counts}=compare(i,()=>reset(i,{hot,maskBits: mask_bits_local}),{check:(before,data,after)=>{
            const expected=masked(c,before,data);
            assert.deepEqual(after.xmm,expected.xmm);assert.deepEqual(after.regs,expected.regs);assert.equal(after.flags,before.flags);
            for(let l=0;l<4;l++)assert.equal(get32(target+l*4),expected.memory?.[l]??data[l]);
        }});assert(counts.every(([n,g])=>g===0&&n===(c[7]<8||hot?0:1)));ordinary++;if(c[7]>=8&&hot)native+=2;
    }
    console.log(`PASS (${release?"release":"debug"}): ${ordinary} independent/CPU SIMD masked store scenarios, ${native} native RAM entries`);
    let randomized=0;
    for(let i=0;i<cases.length;i++){
        const c=cases[i];if(!c[1]||c[2]!==32||c[6]!==0||c[7]!==8||![0,1].includes(c[9])) continue;
        for(let seed=0;seed<32;seed++) for(const hot of c[7]<8?[false]:[false,true]){
            compare(i,()=>{reset(i,{hot});let rng=seed+1;const next=()=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return rng>>>0;};
                for(let j=0;j<32;j++)xmm[j]=next();for(let j=0;j<4;j++)set32(target+4*j,next());
                if(c[7]<8) for(let j=0;j<4;j++)cpu.reg32[j]=next();
            },{check:(before,data,after)=>{const expected=masked(c,before,data);assert.deepEqual(after.xmm,expected.xmm);assert.deepEqual(after.regs,expected.regs);for(let l=0;l<4;l++)assert.equal(get32(target+l*4),expected.memory?.[l]??data[l]);}});randomized++;
        }
    }
    console.log(`PASS (${release?"release":"debug"}): ${randomized} independent random masked-store cases`);
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[1]&&c[2]===32&&c[6]===0&&c[7]===8&&c[9]===1);
    let task_cases=0,access=0,segments=0,modes=0;
    for(const [c,i] of selected){
        for(const task of [4,8,12]) for(const cpl of [0,3]){
            const {expected,counts}=compare(i,()=>{reset(i,{task,cpl});if(c[7]>=8)cpu.segment_is_null[3]=1;set32(0x13000+0x310*4,0);e.full_clear_tlb();e.update_state_flags();},{fault:true});
            assert.equal(expected.ip,task&4?UD:NM);assert(counts.every(([n,g])=>n===0&&g===1));task_cases++;
        }
        for(const option of [{osfxsr:false},{real:true},{vm86:true,cpl:3}]){compare(i,()=>reset(i,option));modes++;}
        if(c[7]>=8) for(const offset of [0x41,0xFF0,0xFF8,0xFFC,0xFFF]){
            compare(i,()=>reset(i,{offset,hot:true}));access++;
            const {expected}=compare(i,()=>{reset(i,{offset:0x1000-c[4]+1,cpl:3});set32(0x13000+0x311*4,0);e.full_clear_tlb();},{fault:true});assert.equal(expected.ip,PF);access++;
        }
    }
    for(let i=0;i<cases.length;i++){const c=cases[i];if(!c[1]||c[2]!==32||c[6]!==0||c[7]<8||[1,2].includes(c[8])||c[9]!==1) continue;const {expected}=compare(i,()=>{reset(i);cpu.segment_is_null[c[8]<0?3:c[8]]=1;e.update_state_flags();},{fault:true});assert.equal(expected.ip,GP);segments++;}
    console.log(`PASS (${release?"release":"debug"}): ${task_cases} EM/TS priority cases, ${access} unaligned/boundary/fault cases, ${segments} segment faults, ${modes} OSFXSR/real/VM86 cases`);
    let extents=0;
    for(const [c,i] of selected){
        if(c[7]<8) continue;
        for(const hot of [false,true]){
            const {expected,counts}=compare(i,()=>{
                reset(i,{offset:0x1000-c[4],cpl:3});
                if(hot)e.ir_memory_write(target,mem[target],1);
                set32(0x13000+0x311*4,0);
            });
            assert.equal(expected.ip,PC+c[0].length);
            assert(counts.every(([n])=>n===(hot?0:1)));extents++;
        }
    }
    console.log(`PASS (${release?"release":"debug"}): ${extents} exact sixteen-byte extents with absent following page`);
    const physical=a=>a>=0xA5000&&a<0xA6000?0x13000+(a&4095):a>=0xA4000&&a<0xA5000?0x12000+(a&4095):a>=0xA2000?0x3000+(a&4095):BASE+a-0xA0000;
    const observe=(kind,a,n)=>{events.push({kind,a,n,state:visible()});on_event?.(kind,a,n);};
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return mem[physical(a)];},(a,n)=>{observe("w8",a,n);mem[physical(a)]=n;},a=>{observe("r32",a);return get32(physical(a))|0;},(a,n)=>{observe("w32",a,n>>>0);set32(physical(a),n);});
    const device=(i,options={})=>{reset(i,options);set32(0x13000+0x310*4,0xA0007);set32(0x13000+0x311*4,0xA1007);e.full_clear_tlb();};
    let devices=0,mutations=0,late=0,early=0;
    for(const [c,i] of selected){
        if(c[7]<8) continue;
        for(const offset of [0x40,0xFF8,0xFFC,0xFFF]) for(const mask_bits_local_local of [0,1,0x8000,0x5555,0xAAAA,0xFFFF]){
            const {observed}=compare(i,()=>device(i,{offset,maskBits: mask_bits_local_local}));
            const lanes=Array.from({length:16},(_,n)=>n).filter(n=>mask_bits_local_local>>>n&1);
            assert.deepEqual(observed.map(x=>[x.kind,x.a]),lanes.map(n=>["w8",0xA0000+offset+n]));devices++;
        }
        compare(i,()=>{device(i);on_event=()=>{xmm.set([0x12345678,0x89ABCDEF,0xFEDCBA98,0x76543210],0);xmm.fill(0,4,8);xmm[28]=0x12345678;cpu.reg32[0]=0xCAFEBABE;cpu.reg32[7]=0xDEAD0000;};});assert.equal(xmm[28],0x12345678);assert.equal(cpu.reg32[0]>>>0,0xCAFEBABE);mutations++;
        if(c[5]){
            const {expected}=compare(i,()=>{device(i,{offset:0xFFF,cpl:3});on_event=kind=>{if(kind.startsWith("w")){set32(0x13000+0x311*4,0);e.full_clear_tlb();}};},{abort:true});
            {assert.equal(expected.ip,PF);late++;}
        } else {
            const {expected}=compare(i,()=>{device(i,{offset:0xFFF,cpl:3});on_event=kind=>{if(kind.startsWith("r")){xmm[0]=0xFEDCBA98;set32(0x13000+0x311*4,0);e.full_clear_tlb();}};},{fault:true});{assert.equal(expected.ip,PF);late++;}
        }
        const {observed}=compare(i,()=>{reset(i,{task:4});set32(0x13000+3*4,0xA2007);e.full_clear_tlb();},{fault:true});assert(observed.length>0);early++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${devices} MMIO selective writes, ${mutations} CPU callback state changes, ${late} partial faults/aborts, ${early} pre-EA guard exception observations`);


    const base_case=cases.findIndex(c=>c[1]&&c[2]===32&&c[6]===0&&c[7]===8&&c[9]===1);
    let walk_mutations=0;
    for(const mask_bits_local_local_local of [0,0x8001,0xFFFF]) for(const fault of [false,true]){
        const {expected,observed}=compare(base_case,()=>{
            reset(base_case,{offset:fault?0xFF8:0x40,maskBits:0});
            cpu.cr[3]=0xA4000;set32(0x12000,0xA5007);
            if(fault)set32(0x13000+0x311*4,0);
            e.full_clear_tlb();e.ir_memory_read(PC,1);events=[];
            on_event=(kind,a)=>{if(kind==="r32"&&a===0xA5000+0x310*4){
                xmm.set([0x12345678,0x89ABCDEF,0x76543210,0xFEDCBA98],0);set_mask(1,mask_bits_local_local_local);cpu.reg32[7]=0xBAD00000;
            }};
        },{fault});
        assert(observed.some(x=>x.kind==="r32"&&x.a===0xA5000+0x310*4));
        assert.equal(expected.regs[7],0xBAD00000);assert.equal(expected.ip,fault?PF:PC+cases[base_case][0].length);
        if(!fault){const output=Array.from({length:4},(_,n)=>get32(target+4*n));const original=[0x80000001,0x7F812345,0xFFFF00FF,0x00108010];assert.deepEqual(output,masked(cases[base_case],expected,original).memory);}
        walk_mutations++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${walk_mutations} preflight page-table callback source/mask/address changes and faults`);
    let masks=0;
    reset(base_case,{hot:true});const saved=visible(),initial=mem.slice(target,target+16);
    const configure_mask=bits=>{cpu.reg32.set(saved.regs);xmm.set(saved.xmm);set_mask(1,bits);cpu.flags[0]=0x8D7;cpu.flags_changed[0]=0;cpu.instruction_pointer[0]=PC;words[664>>2]=100;mem.set(initial,target);slow=guards=0;};
    for(let bits=0;bits<65536;bits++){
        configure_mask(bits);e.ir_test_step();const before=visible(),data=Array.from({length:4},(_,n)=>get32(target+n*4)),model=masked(cases[base_case],before,data);e.ir_test_step();
        const expected=visible(),out=Array.from({length:4},(_,n)=>get32(target+n*4));assert.deepEqual(out,model.memory);
        for(const opt of [0,1]){configure_mask(bits);instances[base_case][opt].exports.f(0);assert.deepEqual(visible(),expected);assert.deepEqual(Array.from({length:4},(_,n)=>get32(target+n*4)),out);assert.equal(words[664>>2],102);assert.equal(slow,0);assert.equal(guards,0);}masks++;
    }
    console.log(`PASS (${release?"release":"debug"}): ${masks} exhaustive byte masks with independent/CPU/native memory checks`);
    let preflights=0;
    for(const mask_bits_local_local_local_local of [0,1,0x8000,0xFFFF]) for(const hot of [false,true]){
        for(const option of ["upper-absent","readonly","supervisor"]){
            const {expected,counts}=compare(base_case,()=>{reset(base_case,{maskBits: mask_bits_local_local_local_local,offset:0xFF8,cpl:3});if(hot)e.ir_memory_read(target,1);set32(0x13000+0x311*4,option==="upper-absent"?0:0x311000|(option==="readonly"?5:3));e.full_clear_tlb();if(hot)e.ir_memory_read(target,1);},{fault:true});
            assert.equal(expected.ip,PF);assert(counts.every(([n])=>n===1));preflights++;
        }
    }
    // Address-size truncation applies to initial DI, not to each selected byte.
    for(const asize of [16,32]){const i=cases.findIndex(c=>c[1]&&c[2]===asize&&c[6]===0&&c[7]===8&&c[9]===1);
        compare(i,()=>reset(i,{offset:0xFFF8,hot:true}));preflights++;
        if(asize===16){compare(i,()=>reset(i,{offset:0x12340040,hot:true}));preflights++;}
    }
    console.log(`PASS (${release?"release":"debug"}): ${preflights} full-range zero/sparse-mask permissions and DI boundary checks`);
    const setup_chain=(hot,deviceStore=false)=>{reset(base_case,{hot,maskBits:0xFFFF});mem.set(chain_bytes,PC);mem.set([0x66,0x0F,0xD7,0xD0],PC+chain_bytes.length);if(deviceStore){set32(0x13000+0x310*4,0xA0007);e.full_clear_tlb();on_event=kind=>{if(kind.startsWith("w")){xmm.fill(0xDEADBEEF,0,8);cpu.reg32[7]=0xBAD00000;}};}slow=guards=0;events=[];};
    let chains=0;
    for(const hot of [false,true]) for(const device_store of [false,true]){
        setup_chain(hot,device_store);for(let n=0;n<3;n++)e.ir_test_step();const expected=state(),observed=events.slice();e.ir_test_step();const completed=state();
        for(const opt of [0,1]){setup_chain(hot,device_store);chain[opt].exports.f(0);assert.equal(words[664>>2],103);assert.deepEqual(state(),expected);assert.deepEqual(events,observed);resume[opt].exports.f(0);assert.equal(words[664>>2],104);assert.deepEqual(state(),completed);chains++;}
    }
    const setup_fault=()=>{setup_chain(false);set32(0x13000+0x310*4,0);e.full_clear_tlb();};
    setup_fault();for(let n=0;n<3;n++)e.ir_test_step();const faulted=state();assert.equal(faulted.ip,PF);
    for(const opt of [0,1]){setup_fault();chain[opt].exports.f(0);assert.equal(words[664>>2],102);assert.deepEqual(state(),faulted);}
    console.log(`PASS (${release?"release":"debug"}): ${chains} dirty-vector masked-store completion/reentry chains and 2 dirty-XMM fault exits`);
 } finally {await vm.destroy();}
}
