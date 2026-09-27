import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-cmpxchg8b/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-cmpxchg8b/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const release of [false,true]){
    const vm=new V86({wasm_path:release?"build/v86-ir-test-release.wasm":"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
    try {
        await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
        const v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true);
        vm.run();const deadline=performance.now()+10000;while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
        const PC=0x8000,BASE=0x310000,ALT=0x350000,STACK=0x90000,PF=0x180200,GP=0x180000,cr0=cpu.cr[0],cr4=cpu.cr[4];let target,events=[],on_event,slow=0;
        const imports={...e,m:e.memory,ir_cmpxchg8b:(...a)=>{slow++;return e.ir_cmpxchg8b(...a);}};
        const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
        const visible=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,rawZero:cpu.flags[0]&64,zeroLazy:cpu.flags_changed[0]&64,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0});
        const state=()=>({...visible(),previous:words[560>>2],cr2:cpu.cr[2]>>>0,cpl:words[612>>2]&255,ss32:cpu.stack_size_32[0],sreg:Array.from(cpu.sreg.slice(0,6)),bases:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),data:Buffer.from(mem.slice(target-8,target+16)),alternate:Buffer.from(mem.slice(ALT,ALT+0x1010)),frame:Buffer.from(mem.slice(STACK-128,STACK+16))});
        function desc(n,base,access){set32(0x3000+n*8,(base<<16)|0xFFFF);set32(0x3004+n*8,(base&0xFF000000)|(base>>>16&255)|access<<8|0xCF0000);}
        function reset(i,{offset=0x40,match=0,input=0x89ABCDEF,cpl=0,lazy=false,rawZero: raw_zero=0,hot=false,real=false}={}){
            const [bytes,mode,,asize,seg,,head,operand]=cases[i];
            cpu.cr[4]=cr4;e.ir_test_set_cr0(real?cr0&~0x80000001:cr0|0x10000);cpu.cr[2]=0xBADF000;
            cpu.segment_offsets.set([BASE,0,0,BASE,BASE,BASE]);cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.sreg.set([16,cpl?0x1B:8,cpl?0x23:16,16,16,16]);cpu.segment_access_bytes.set([0x93,cpl?0xFB:0x9B,cpl?0xF3:0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=cpl;
            cpu.reg32.set([input,0x76543210,~input,0xFEDCBA98,STACK,0x55555555,0x40,0x7FFF]);
            const set_post=(r,n)=>{cpu.reg32[r]=r===7&&head?(mode?n-1:(n&0xFFFF0000)|((n-1)&65535)):n;};
            if(asize===32)set_post(operand,offset);
            else {const regs=[[3,6],[3,7],[5,6],[5,7],[6],[7],[5],[3]][operand];set_post(regs[0],offset);if(regs.length===2)set_post(regs[1],0);}
            const post=Array.from(cpu.reg32,x=>x>>>0);if(head)post[7]=mode?(post[7]+1)>>>0:(post[7]&0xFFFF0000)|((post[7]+1)&65535);
            const default_seg=asize===32?([4,5].includes(operand)?2:3):([2,3,6].includes(operand)?2:3);
            target=(cpu.segment_offsets[seg<0?default_seg:seg]+(asize===16?offset&65535:offset))>>>0;
            mem.fill(0xCC,target-8,target+16);set32(target,post[0]^(match===1?1:0));set32(target+4,post[2]^(match===2?1:0));mem.fill(0x6D,ALT,ALT+0x1010);mem.fill(0xCC,STACK-128,STACK+16);
            cpu.flags[0]=0x813|raw_zero;cpu.flags_changed[0]=lazy?64:0;words[96>>2]=31;words[112>>2]=raw_zero?1:0;words[104>>2]=0x87654321;cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;mem.set(bytes,PC);
            desc(1,0,0x9B);desc(2,0,0x93);desc(3,0,0xFB);desc(4,0,0xF3);desc(5,0x4000,0x89);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const [vector,handler] of [[13,GP],[14,PF]]){set32(0x2000+vector*8,8<<16|handler&65535);set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);}
            set32(0x12000,0x13007);for(const page of [0,2,3,4,8,0x18,0x8F,0x90,0x310,0x311,0x31F,0x320,0x350,0x351])set32(0x13000+page*4,page*4096|7);
            e.full_clear_tlb();e.update_state_flags();if(hot){e.ir_memory_write(target,mem[target],1);e.ir_memory_write(target+7,mem[target+7],1);}events=[];on_event=undefined;slow=0;
        }
        const caught=f=>{try {f();return false;} catch(error){assert(error instanceof WebAssembly.RuntimeError);return true;}};
        function compare(i,configure,{fault=false,abort=false,check}={}){
            configure();e.ir_test_step();const before=visible(),data=[get32(target),get32(target+4)];assert.equal(caught(()=>e.ir_test_step()),abort);const expected=state(),observed=events.slice();check?.(before,data,expected);
            const counts=[];for(const opt of [0,1]){configure();assert.equal(caught(()=>instances[i][opt].exports.f(0)),abort);assert.equal(words[664>>2],fault||abort?101:102);assert.deepEqual(state(),expected,`CMPXCHG8B ${i}/${opt}`);assert.deepEqual(events,observed,`events ${i}/${opt}`);counts.push(slow);} return {expected,observed,counts};
        }
        let ordinary=0,native=0;
        for(let i=0;i<cases.length;i++) for(const match of [0,1,2]) for(const hot of [false,true]){
            const {counts}=compare(i,()=>reset(i,{match,hot}),{check:(before,data,after)=>{
                const regs=before.regs.slice();if(match){regs[0]=data[0];regs[2]=data[1];}
                assert.deepEqual(after.regs,regs);assert.equal(after.flags>>>0,(before.flags&~64|(match?0:64))>>>0);assert.equal(after.rawZero,match?0:64);assert.equal(after.zeroLazy,0);
                assert.equal(get32(target),match?data[0]:before.regs[3]);assert.equal(get32(target+4),match?data[1]:before.regs[1]);
            }});assert(counts.every(n=>n===(hot?0:1)));ordinary++;if(hot)native+=2;
        }
        console.log(`PASS (${release?"release":"debug"}): ${ordinary} independent/CPU CMPXCHG8B comparisons, ${native} native RAM entries`);
        const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[1]&&c[2]===32&&c[3]===32&&c[4]===-1&&[0,0xF0].includes(c[5])&&c[7]===6);
        let boundary=0,permissions=0,segments=0,real=0,code_guards=0,user=0,word_tails=0;
        for(const [c,i] of selected){
            for(const offset of [0xFF8,0xFF9,0xFFC,0xFFF,0xFFFF]) for(const match of [0,1,2]){compare(i,()=>reset(i,{offset,match,hot:true}));boundary++;}
            for(const cpl of [0,3]) for(const fault of ["missing","readonly","cross"]){
                const {expected,observed}=compare(i,()=>{reset(i,{cpl,offset:fault==="cross"?0xFFC:0x40});const p=target>>>12;set32(0x13000+(fault==="cross"?p+1:p)*4,fault==="readonly"?p*4096|5:0);e.full_clear_tlb();},{fault:true});
                assert.equal(expected.ip,PF);assert.equal(expected.cr2,fault==="cross"?BASE+4096:target);assert.equal(observed.length,0);permissions++;
            }
            for(const match of [0,1]){
                const {counts}=compare(i,()=>{reset(i,{hot:true,match});words[(e.ir_tlb_base()>>>2)+(target>>>12)]|=32;});
                assert(counts.every(n=>n===1));code_guards++;
            }
            for(const cpl of [0,3]) for(const hot of [false,true]){compare(i,()=>reset(i,{cpl,hot}));user++;}
            compare(i,()=>{reset(i);e.ir_test_set_cr0(cpu.cr[0]&~0x10000);set32(0x13000+(target>>>12)*4,(target&~4095)|5);e.full_clear_tlb();});user++;
            compare(i,()=>reset(i,{real:true}));real++;
        }
        for(let i=0;i<cases.length;i++){
            const c=cases[i];if(c[3]!==16||c[4]!==3||c[7]!==7||![0,0xF0].includes(c[5])) continue;
            for(const match of [0,1]){compare(i,()=>reset(i,{offset:0xFFFF,match}));word_tails++;}
            const {expected}=compare(i,()=>{reset(i,{offset:0xFFFF,cpl:3});set32(0x13000+0x320*4,0);e.full_clear_tlb();},{fault:true});assert.equal(expected.cr2,0x320000);word_tails++;
        }
        for(let i=0;i<cases.length;i++){const c=cases[i];if(!c[1]||c[2]!==32||c[3]!==32||c[7]!==6||c[5]!==0||[1,2].includes(c[4])) continue;
            const {expected,counts}=compare(i,()=>{reset(i);cpu.segment_is_null[c[4]<0?3:c[4]]=1;e.update_state_flags();},{fault:true});assert.equal(expected.ip,GP);assert(counts.every(n=>n===0));segments++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${boundary} boundaries, ${permissions} write-preflight faults, ${segments} segment faults, ${real} real-mode cases, ${code_guards} code-bit guard checks, ${user} CPL/WP cases, ${word_tails} address16 linear-tail checks`);
        const observe=(kind,a,n)=>{events.push({kind,a,n,state:visible()});on_event?.(kind,a,n);};
        const physical=a=>BASE+(a-0xA0000);
        cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return mem[physical(a)];},(a,n)=>{observe("w8",a,n);mem[physical(a)]=n;},a=>{observe("r32",a);return get32(physical(a))|0;},(a,n)=>{observe("w32",a,n>>>0);set32(physical(a),n);});
        const device=(i,options={})=>{reset(i,{input:0x12345678,...options});set32(0x13000+0x310*4,0xA0007);set32(0x13000+0x311*4,0xA1007);e.full_clear_tlb();};
        let devices=0,mutations=0,remaps=0,traps=0,signed_reads=0;
        for(const [c,i] of selected){
            for(const match of [0,1,2]) for(const lazy of [false,true]) for(const raw_zero_local of [0,64]){
                const {observed}=compare(i,()=>device(i,{match,lazy,rawZero: raw_zero_local}));const writes=observed.filter(x=>x.kind.startsWith("w"));assert.equal(writes.length,match?0:2,JSON.stringify({i,match,lazy,rawZero: raw_zero_local,observed}));
                if(!match){const first_read=observed.find(x=>x.kind.startsWith("r"));const seen=first_read.state.zeroLazy?first_read.state.flags&64:64;assert(writes.every(x=>(x.state.flags&64)===seen&&x.state.rawZero===64));}devices++;
            }
            // Pinned memory::read64s sign-extends its low MMIO dword; the
            // cross-page safe_read64s path instead zero-extends each dword.
            for(const offset of [0x40,0xFF8,0xFFC,0xFFF]){
                const {expected,observed}=compare(i,()=>device(i,{input:0x89ABCDEF,offset}));
                const cross=(offset&4095)>4088;
                assert.equal(!!(expected.flags&64),cross);
                assert.equal(expected.regs[2],cross?0x76543210:0xFFFFFFFF);
                assert.equal(observed.some(x=>x.kind.startsWith("w")),cross);signed_reads++;
            }
            const signed_match=compare(i,()=>{device(i,{input:0x89ABCDEF});cpu.reg32[2]=-1;});
            assert(signed_match.expected.flags&64);assert.equal(signed_match.observed.filter(x=>x.kind.startsWith("w")).length,2);signed_reads++;
            for(const offset of [0x40,0xFFC]){
                compare(i,()=>{device(i,{offset,match:1});on_event=kind=>{if(kind.startsWith("r")){cpu.reg32[0]=get32(target);cpu.reg32[2]=get32(target+4);cpu.reg32[3]=0xAABBCCDD;cpu.reg32[1]=0x11223344;}};});assert.equal(get32(target),0xAABBCCDD);assert.equal(get32(target+4),0x11223344);mutations++;
                compare(i,()=>{device(i,{offset});on_event=(kind)=>{if(kind.startsWith("w")){cpu.reg32[3]=0x10203040;cpu.reg32[1]=0x50607080;}};});assert.equal(get32(target+4),0x76543210);mutations++;
            }
            compare(i,()=>{device(i);on_event=kind=>{if(kind.startsWith("r")){set32(0x13000+0x310*4,ALT|7);e.full_clear_tlb();}};});assert.equal(get32(ALT+0x40),0xFEDCBA98);assert.equal(get32(ALT+0x44),0x76543210);remaps++;
            for(const lazy of [false,true]){
                const {expected}=compare(i,()=>{device(i,{lazy,cpl:3});on_event=kind=>{if(kind.startsWith("r")){set32(0x13000+0x310*4,0);e.full_clear_tlb();}};},{abort:true});assert.equal(expected.ip,PF);traps++;
                const partial=compare(i,()=>{device(i,{offset:0xFFC,cpl:3,lazy});on_event=kind=>{if(kind.startsWith("w")){set32(0x13000+0x311*4,0);e.full_clear_tlb();}};},{abort:true});
                assert.equal(partial.expected.ip,PF);assert.equal(get32(BASE+0xFFC),0xFEDCBA98);assert.equal(get32(BASE+0x1000),0xEDCBA987);traps++;
                const read=compare(i,()=>{device(i,{offset:0xFFC,cpl:3,lazy});on_event=kind=>{if(kind.startsWith("r")){set32(0x13000+0x311*4,0);e.full_clear_tlb();}};},{abort:true});assert.equal(read.expected.ip,PF);traps++;
            }
        }
        console.log(`PASS (${release?"release":"debug"}): ${devices} MMIO/lazy-ZF sequences, ${mutations} callback register changes, ${remaps} write remaps, ${traps} late fault/abort sequences, ${signed_reads} pinned signed-low reads`);
    } finally {await vm.destroy();}
}
