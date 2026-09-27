import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-control-regs/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-control-regs/${i}-${opt}.wasm`))));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const release of [false,true]){
    const core=new WebAssembly.Module(fs.readFileSync((process.argv[2]||"build/v86-ir-test")+(release?"-release":"")+".wasm"));
    const bios=Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
    const create_vm=()=>new V86({wasm_fn:async imports=>new WebAssembly.Instance(core,imports).exports,memory_size:32<<20,bios:{buffer:bios},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
    let vm=create_vm();
    try {
        let cpu,e,mem,words,raw,pdpte,dr,v;
        const set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true),set16=(a,n)=>v.setUint16(a,n,true);
        let install_mappings=()=>{};
        const instances=new Map();
        function instance(i,opt){
            const key=i*2+opt;
            if(!instances.has(key))instances.set(key,new WebAssembly.Instance(modules[i][opt],{e:{...e,m:e.memory}}));
            return instances.get(key);
        }
        async function boot(){
            await new Promise(r=>vm.add_listener("emulator-loaded",r));
            cpu=vm.v86.cpu;e=cpu.wm.exports;mem=cpu.mem8;
            words=new Uint32Array(e.memory.buffer);raw=new Uint8Array(e.memory.buffer);
            pdpte=new BigUint64Array(e.memory.buffer,968,4);dr=new Uint32Array(e.memory.buffer,684,8);
            v=new DataView(mem.buffer,mem.byteOffset);instances.clear();
            vm.run();const deadline=performance.now()+10000;
            while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);}
            await vm.stop();install_mappings();
        }
        // A caught Wasm panic does not unwind Rust's linear-memory stack or
        // allocator state. Each expected abort gets a fresh core/VM; only the
        // immutable compiled modules are reused, never the trapped instance.
        async function recreate(){await vm.destroy();vm=create_vm();await boot();}
        await boot();
        const PC=0x8000,STACK=0x90000,GP=0x180000,UD=0x180100,PF=0x180200,BASE=0x310000,cr0=cpu.cr[0],cr3=cpu.cr[3],cr4=cpu.cr[4];let events=[];
        function desc(n,base,limit,access,flags){set32(0x3000+n*8,limit&65535|base<<16);set32(0x3004+n*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
        function source(i,value){const c=cases[i],r=c[4];cpu.reg32[r]=r===3?(c[1]?value-1:(value&0xFFFF0000)|((value-1)&65535)):value;}
        function reset(i,value,{cpl=0,real=false,vm86=false,de=false,base=0}={}){
            const [bytes,mode]=cases[i];cpu.cr[4]=cr4;cpu.cr[3]=cr3;e.ir_test_set_cr0(real?cr0&~0x80000001:cr0|0x10000);cpu.cr[4]|=de?8:0;cpu.cr[2]=0xBADF000;
            pdpte.set([0x111n,0x222n,0x333n,0x444n]);dr.set([0x12345678,0xABCDEF01,0,0xFFFFFFFF,0x44444444,0x55555555,0x66666666,0x77777777]);
            cpu.segment_offsets.set([0x30000,base,0,0x50000,0x60000,0x70000]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);cpu.sreg.set([16,cpl?0x1B:8,cpl?0x23:16,16,16,16]);cpu.segment_access_bytes.set([0x93,cpl?0xFB:0x9B,cpl?0xF3:0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=cpl;
            cpu.reg32.set([0x12345678,0x89ABCDEF,0xFEDCBA98,0x7FFFFFFF,STACK,0x55555555,0x66666666,0x77777777]);if(value!==undefined)source(i,value);cpu.flags[0]=0x8D7|(vm86?0x20000:0);cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.instruction_pointer[0]=base+PC;cpu.in_hlt[0]=0;words[664>>2]=100;
            desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0,0xFFFFF,0xFB,12);desc(4,0,0xFFFFF,0xF3,12);desc(5,0x4000,0x67,0x89,0);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const [vector,handler] of [[6,UD],[13,GP],[14,PF]]){set32(0x2000+vector*8,8<<16|handler&65535);set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);}
            set32(0x12000,0x13007);for(const p of [2,3,4,8,0x18,0x90,0x310])set32(0x13000+p*4,p*4096|([8,0x18,0x310].includes(p)?7:3));
            mem.fill(0xCC,STACK-128,STACK+16);mem.fill(0xCC,0x8F80,0x9010);if(real){cpu.stack_size_32[0]=0;if(cases[i][4]!==4||value===undefined)cpu.reg32[4]=0xABCD9000;set16(6*4,0x1810);set16(6*4+2,0);set16(13*4,0x1800);set16(13*4+2,0);}
            mem.set(bytes,base+PC);e.full_clear_tlb();e.update_state_flags();events=[];
        }
        const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,previous:words[560>>2],cr:Array.from(cpu.cr,x=>x>>>0),dr:Array.from(dr),pdpte:Array.from(pdpte),protected:raw[800],cpl:words[612>>2]&255,mode:cpu.is_32[0],ss32:cpu.stack_size_32[0],cached:raw[108],sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),access:Array.from(cpu.segment_access_bytes.slice(0,6)),frames:[STACK-128,0x8F80].map(a=>Buffer.from(mem.slice(a,a+144)))});
        let last_trap; const caught=f=>{try {f();return false;} catch(error){assert(error instanceof WebAssembly.RuntimeError);last_trap=error.stack;return true;}};
        async function compare(i,configure,count=102,abort=false,after){
            configure();assert.equal(caught(()=>instance(i,0).exports.f(0)),abort,`CR/DR initial trap case=${i} decoded=${cases[i]} eax=${cpu.reg32[0]} ${last_trap}`);
            assert.equal(words[664>>2],count);
            const observed_after=after?.(),actual=state(),observed=events.slice();
            if(abort)await recreate();
            configure();e.ir_test_step();assert.equal(caught(()=>e.ir_test_step()),abort);
            assert.deepEqual(after?.(),observed_after);assert.deepEqual(actual,state(),`CR/DR ${i}/${release}`);assert.deepEqual(observed,events);
            if(abort)await recreate();
            configure();assert.equal(caught(()=>instance(i,1).exports.f(0)),abort);assert.equal(words[664>>2],count);
            assert.deepEqual(after?.(),observed_after);assert.deepEqual(state(),actual);assert.deepEqual(events,observed);
            if(abort)await recreate();
            return actual;
        }
        const valid_cr=n=>[0,2,3,4].includes(n),write_value=(index,pattern)=>index===0?cr0|0x10000:index===2?pattern:index===3?cr3:cr4;
        let ordinary=0;
        for(let i=0;i<cases.length;i++){const [bytes,mode,op,index,r]=cases[i];if(!(op&1)&&!valid_cr(index)) continue;for(const pattern of [0,0x89ABCDEF]){
            const value=op===0x22?write_value(index,pattern):op===0x23?pattern:undefined,actual=await compare(i,()=>reset(i,value));assert.equal(actual.ip,PC+bytes.length);
            if(op===0x20)assert.equal(actual.regs[r],actual.cr[index]);if(op===0x21)assert.equal(actual.regs[r],actual.dr[index===4||index===5?index+2:index]);if(op===0x23)assert.equal(actual.dr[index===4||index===5?index+2:index],pattern);ordinary++;
        }}
        console.log(`PASS (${release?"release":"debug"}): ${ordinary} full-width CR/DR transfers including all ignored ModRM.mod forms`);
        const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[0].length===4&&c[5]===3);
        let permissions=0,aliases=0,invalid=0;
        for(const [c,i] of selected) for(const cpl of [1,2,3]) for(const vm86 of [false,true]){if(vm86&&(cpl!==3||c[1])) continue;const actual=await compare(i,()=>reset(i,undefined,{cpl,vm86,de:!!(c[2]&1)&&[4,5].includes(c[3])}),101);assert.equal(actual.ip,GP);permissions++;}
        for(const [c,i] of selected) if(c[2]&1&&[4,5].includes(c[3])){const actual=await compare(i,()=>reset(i,undefined,{de:true}),101);assert.equal(actual.ip,UD);aliases++;}
        for(const [c,i] of selected) if(!(c[2]&1)&&!valid_cr(c[3])){const actual=await compare(i,()=>reset(i),101,!release);if(release)assert.equal(actual.ip,UD);invalid++;}
        console.log(`PASS (${release?"release":"debug"}): ${permissions} permission/VM86, ${aliases} DR4/5 DE faults, ${invalid} invalid CR abort/#UD cases`);
        let cr4_bits=0;
        for(const [c,i] of selected) if(c[2]===0x22&&c[3]===4&&c[4]===0) for(let bit=0;bit<32;bit++){
            const value=2**bit,invalid=(value&0xFFC99800)!==0;
            // PG is off so enabling PAE does not require a valid translation tree.
            const actual=await compare(i,()=>{reset(i,value);e.ir_test_set_cr0(cr0&~0x80000000);set32(cr3,0);},invalid?101:102);assert.equal(actual.cr[4],invalid?cr4:value);if(invalid)assert.equal(actual.ip,GP);cr4_bits++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${cr4_bits} CR4 individual valid/reserved-bit state transitions`);
        let real=0;
        for(const [c,i] of selected) if(!c[1]&&c[4]!==4&&((c[2]&1)||valid_cr(c[3]))){const value=c[2]===0x22?(c[3]===0?0:c[3]===3?cr3:0):c[2]===0x23?0x89ABCDEF:undefined;await compare(i,()=>reset(i,value,{real:true}));real++;}
        console.log(`PASS (${release?"release":"debug"}): ${real} real-mode control/debug register transfers`);
        const find=(op,index,mode=true)=>cases.findIndex(c=>c[1]===mode&&c[2]===op&&c[3]===index&&c[4]===0&&c[5]===3&&c[0].length===4);
        const read=()=>Number(e.ir_memory_read(BASE,4)&0xFFFFFFFFn);
        function data_mapping(){set32(0x13000+0x310*4,0x350003);set32(0x350000,0xA11D);set32(0x360000,0xB22D);set32(BASE,0xC33D);e.full_clear_tlb();}
        let tlb=0;
        for(const mode of [false,true]) for(const global of [false,true]){
            const i=find(0x22,3,mode),configure=()=>{reset(i,0x14000);cpu.cr[4]=cr4|0x80;data_mapping();if(global)set32(0x13000+0x310*4,0x350103);mem.copyWithin(0x15000,0x13000,0x14000);set32(0x14000,0x15007);set32(0x15000+0x310*4,0x360003);assert.equal(read(),0xA11D);};
            await compare(i,configure,102,false,()=>{const value=read();assert.equal(value,global?0xA11D:0xB22D);return value;});tlb++;
        }
        for(const mode of [false,true]) for(const bit of [3,4,7]){
            const i=find(0x22,4,mode),configure=()=>{reset(i,cr4^1<<bit);data_mapping();assert.equal(read(),0xA11D);set32(0x13000+0x310*4,0x360003);};
            await compare(i,configure,102,false,()=>{const value=read();assert.equal(value,bit===3?0xA11D:0xB22D);return value;});tlb++;
        }
        for(const mode of [false,true]) for(const pg_off of [false,true]){
            const i=find(0x22,0,mode),configure=()=>{reset(i,pg_off?cr0&~0x80000000:cr0&~0x10000);data_mapping();assert.equal(read(),0xA11D);set32(0x13000+0x310*4,0x360003);};
            await compare(i,configure,102,false,()=>{const value=read();assert.equal(value,pg_off?0xC33D:0xB22D);return value;});tlb++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${tlb} warmed TLB CR3/global, CR4 flush/retention and CR0 WP/PG mapping checks`);
        const observe=(kind,a,n)=>events.push({kind,a,n,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,cr:Array.from(cpu.cr,x=>x>>>0),pdpte:Array.from(pdpte)});
        install_mappings=()=>cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("read8",a);return mem[0x50000+(a&4095)];},(a,n)=>{observe("write8",a,n);mem[0x50000+(a&4095)]=n;},a=>{observe("read32",a);return get32(0x50000+(a&4095))|0;},(a,n)=>{observe("write32",a,n);set32(0x50000+(a&4095),n);});
        install_mappings();
        let pae=0;
        for(const mode of [false,true]) for(const index of [0,3,4]) for(const device of [false,true]) for(const bad_slot of [-1,0,1,2,3]){
            const i=find(0x22,index,mode),address=device?0xA0000:0x50000,value=index===3?address|15:index===0?(cr0&~0x80000000)^0x40000000:0x30;
            const configure=()=>{reset(i,value);e.ir_test_set_cr0(cr0&~0x80000000);cpu.cr[4]=0x20;cpu.cr[3]=index===3?cr3:address;for(let slot=0;slot<4;slot++){set32(0x50000+slot*8,0x20001+slot*4096|0xE00);set32(0x50004+slot*8,slot===bad_slot?1:0);}e.full_clear_tlb();events=[];};
            const abort=bad_slot>=0&&!release,actual=await compare(i,configure,abort?101:102,abort);for(let slot=0;slot<4;slot++)assert.equal(actual.pdpte[slot],abort&&slot>=bad_slot?BigInt((slot+1)*0x111):BigInt(0x20001+slot*4096)|(slot===bad_slot?1n<<32n:0n));
            if(device){assert.equal(events.length,(abort?bad_slot+1:4)*2);assert(events.every(x=>x.kind==="read32"));} else assert.equal(events.length,0);pae++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${pae} RAM/MMIO PDPTE reloads and partial debug-abort state across CR0/CR3/CR4`);
        let pdpt_bits=0;
        for(const mode of [false,true]) for(const device of [false,true]) for(const bit of [1,2,3,4,5,6,7,8,9,10,11,12]) for(const present of [false,true]){
            const i=find(0x22,3,mode),address=device?0xA0000:0x50000,bad_low=0x22000|(present?1:0)|1<<bit,abort=!release&&([3,4].includes(bit)||present&&[1,2,5,6,7,8].includes(bit));
            const configure=()=>{reset(i,address);e.ir_test_set_cr0(cr0&~0x80000000);cpu.cr[4]=0x20;for(let slot=0;slot<4;slot++){set32(0x50000+slot*8,slot===2?bad_low:0x20001+slot*4096);set32(0x50004+slot*8,0);}e.full_clear_tlb();events=[];};
            const actual=await compare(i,configure,abort?101:102,abort);assert.equal(actual.pdpte[2],abort?0x333n:BigInt(bad_low&~0xE00));assert.equal(actual.pdpte[3],abort?0x444n:0x23001n);assert.equal(events.length,device?(abort?6:8):0);pdpt_bits++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${pdpt_bits} present/absent PDPTE reserved, ignored and address-bit cases`);

        let pinned=0;
        for(const mode of [false,true]){
            const i=find(0x22,0,mode);await compare(i,()=>reset(i,0x80000000),101,true);pinned++;
            for(const low of [0,1,7,8,16,24,32,0xFFF]){const i=find(0x22,3,mode),abort=!release&&(low&24)!==0,actual=await compare(i,()=>reset(i,0x14000|low),abort?101:102,abort);assert.equal(actual.cr[3],abort?cr3:(0x14000|low)&~0xFE7);pinned++;}
        }
        console.log(`PASS (${release?"release":"debug"}): ${pinned} CR0 PG-without-PE and non-PAE CR3 low-bit policies`);
        let fetch_fault=0;
        for(const mode of [false,true]) for(const opt of [0,1]){
            const i=find(0x22,3,mode),configure=()=>{reset(i,0x14000);mem.copyWithin(0x15000,0x13000,0x14000);set32(0x14000,0x15007);set32(0x15000+8*4,0);e.full_clear_tlb();};
            configure();instance(i,opt).exports.f(0);assert.equal(words[664>>2],102);e.ir_test_step();const actual=state();assert.equal(actual.ip,PF);assert.equal(actual.cr[2],PC+4);configure();e.ir_test_step();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());fetch_fault++;
        }
        console.log(`PASS (${release?"release":"debug"}): ${fetch_fault} next-fetch #PF cases in the newly committed CR3 address space`);

    } finally {await vm.destroy();}
}
