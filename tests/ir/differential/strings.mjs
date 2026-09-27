import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-strings/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-strings/${i}-${opt}.wasm`))));
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const source=c=>[0xA4,0xA6,0xAC].includes(c[4]),destination=c=>c[4]!==0xAC,stores=c=>[0xA4,0xAA].includes(c[4]),steps=c=>stores(c)?2:3;
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,SRC=0x310000,DST=0x330000,STACK=0x90000,HANDLER=0x180000,cr0=cpu.cr[0],gdt=[cpu.gdtr_offset[0],cpu.gdtr_size[0]];
    let reads=0,writes=0,events=[],windows=[],from,to,on_event,linear;
    const imports={...e,m:e.memory,ir_memory_read:(...a)=>{reads++;return e.ir_memory_read(...a);},ir_memory_write:(...a)=>{writes++;return e.ir_memory_write(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    function reset(i,df=0,si=0x40,di=0x80,hot=false){
        const c=cases[i],[bytes,mode,width,asize,,segment]=c,seg=segment<0?3:segment;
        e.ir_test_set_cr0(cr0|0x10000);cpu.cr[2]=0xBADF000;on_event=undefined;
        cpu.gdtr_offset[0]=gdt[0];cpu.gdtr_size[0]=gdt[1];cpu.segment_offsets.set([DST,seg===1?SRC:0,SRC,SRC,SRC,SRC]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.stack_size_32[0]=1;words[612>>2]=0;cpu.is_32[0]=+mode;
        cpu.reg32.set([0xAABBCCDD,0x55667788,0x12345678,0x7FFFFFFF,(STACK-SRC)>>>0,0x2468ACE0,asize===16?(0xABCD0000|si&65535):si,asize===16?(0xDCBA0000|di&65535):di]);
        cpu.flags[0]=0x8D7|df<<10;cpu.flags_changed[0]=0;words[104>>2]=0x76543210;linear=(cpu.segment_offsets[1]+PC)>>>0;cpu.instruction_pointer[0]=linear;cpu.in_hlt[0]=0;words[664>>2]=100;
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const vector of [13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);set32(0x13000+8*4,0x8003);for(let p=0x310;p<=0x350;p++)set32(0x13000+p*4,p*4096|3);
        from=(cpu.segment_offsets[seg]+(asize===16?si&65535:si))>>>0;to=(DST+(asize===16?di&65535:di))>>>0;
        mem.fill(0x66,from-32,from+64);mem.fill(0x99,to-32,to+64);set32(from,0x89ABCDEF);set32(to,0x12345678);mem.fill(0xCC,STACK-96,STACK+16);mem.set(bytes,linear);
        windows=[[from-32,96],[to-32,96],[STACK-96,112]];e.full_clear_tlb();e.update_state_flags();
        if(hot){if(source(c)){e.ir_memory_read(from,1);e.ir_memory_read(from+width/8-1,1);} if(destination(c)){if(stores(c)){e.ir_memory_write(to,mem[to],1);e.ir_memory_write(to+width/8-1,mem[to+width/8-1],1);} else {e.ir_memory_read(to,1);e.ir_memory_read(to+width/8-1,1);}}}
        reads=writes=0;events=[];
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,cr2:cpu.cr[2]>>>0,cpl:words[612>>2]&255,ss32:cpu.stack_size_32[0],mode:cpu.is_32[0],sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),data:windows.map(([a,n])=>Buffer.from(mem.slice(a,a+n)))});
    const adjust=(old,delta,asize)=>asize===32?(old+delta)>>>0:(old&0xFFFF0000|(old+delta)&65535)>>>0;
    let ordinary=0,native=0;
    for(let i=0;i<cases.length;i++) for(const df of [0,1]) for(const hot of [false,true]) for(const opt of [0,1]){
        const c=cases[i];reset(i,df,0x40,0x80,hot);const before=state();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],100+steps(c));
        const delta=(df?-1:1)*c[2]/8;for(const reg of [6,7])assert.equal(actual.regs[reg],adjust(before.regs[reg],(reg===6?source(c):destination(c))?delta:0,c[3]));assert.equal(actual.regs[1],before.regs[1]);
        if(hot){assert.equal(reads+writes,0);native++;}
        reset(i,df,0x40,0x80,hot);for(let n=0;n<steps(c);n++)e.ir_test_step();assert.deepEqual(actual,state(),`string ordinary ${i}/${df}/${hot}`);ordinary++;
    }
    console.log(`PASS: ${ordinary} single-string CPU comparisons, ${native} native data paths`);
    const observe=(kind,a,value)=>{events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});on_event?.();};
    const physical=a=>(a>=0xA1000?(to&~4095):(from&~4095))+(a&4095);
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return mem[physical(a)];},(a,v)=>observe("w8",a,v),a=>{observe("r32",a);return get32(physical(a))|0;},(a,v)=>observe("w32",a,v>>>0));
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[5]===-1);
    let devices=0;
    for(const [c,i] of selected) for(const df of [0,1]) for(const opt of [0,1]){
        const configure=()=>{reset(i,df);if(source(c))set32(0x13000+(from>>>12)*4,0xA0003);if(destination(c))set32(0x13000+(to>>>12)*4,0xA1003);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert(events.length>0);
        configure();for(let n=0;n<steps(c);n++)e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events,`string device order ${i}`);devices++;
    }
    console.log(`PASS: ${devices} string MMIO ordering/state observations`);
    let faults=0;
    for(const [c,i] of selected) for(const opt of [0,1]) for(const fault of [...(source(c)?["src"]:[]),...(destination(c)?["dst"]:[]),...(source(c)&&destination(c)?["both"]:[]),...(stores(c)?["readonly"]:[])]){
        const configure=()=>{reset(i);if(fault==="src"||fault==="both")set32(0x13000+(from>>>12)*4,0);if(fault==="dst"||fault==="both"||fault==="readonly")set32(0x13000+(to>>>12)*4,fault==="readonly"?(to&~4095)|1:0);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(actual.cr2,fault==="src"||fault==="both"?from:to);assert.equal(words[664>>2],101);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`string fault ${i}/${fault}`);faults++;
    }
    console.log(`PASS: ${faults} source/destination/write permission #PF cases`);
    let segments=0;
    for(let i=0;i<cases.length;i++) for(const opt of [0,1]) for(const nulls of [[0],[cases[i][5]<0?3:cases[i][5]],[0,cases[i][5]<0?3:cases[i][5]]]){
        if(nulls.includes(1)||nulls.includes(2)) continue;const c=cases[i];
        const configure=()=>{reset(i);for(const seg of nulls)cpu.segment_is_null[seg]=1;e.update_state_flags();};
        configure();instances[i][opt].exports.f(0);const actual=state(),fault=destination(c)&&nulls.includes(0)||source(c)&&nulls.includes(c[5]<0?3:c[5]);assert.equal(words[664>>2],100+(fault?1:steps(c)));if(fault){assert.equal(actual.ip,HANDLER);assert.equal(reads+writes,0);}
        configure();for(let n=0;n<(fault?2:steps(c));n++)e.ir_test_step();assert.deepEqual(actual,state(),`string segment null ${i}/${nulls}`);segments++;
    }
    console.log(`PASS: ${segments} ES/source segment checks, including ignored SCAS source overrides`);
    let boundaries=0;
    for(const [c,i] of selected) for(const opt of [0,1]) for(const df of [0,1]) for(const [si,di] of [[0xFFF,0xFFF],[0xFFFF,0xFFFF],[0,0]]){
        reset(i,df,si,di);instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],100+steps(c));
        reset(i,df,si,di);for(let n=0;n<steps(c);n++)e.ir_test_step();assert.deepEqual(actual,state(),`string boundary ${i}/${si}/${df}`);boundaries++;
    }
    console.log(`PASS: ${boundaries} string page/address16 pointer wrap cases`);
    let remaps=0;
    for(const [c,i] of selected) if(c[4]===0xA4||c[4]===0xA6) for(const opt of [0,1]) for(const fail of [false,true]){
        const configure=()=>{reset(i);set32(0x13000+(from>>>12)*4,0xA0003);mem.fill(0x5A,0x350000,0x350100);windows.push([0x350000,256]);e.full_clear_tlb();if(stores(c))e.ir_memory_write(to,mem[to],1);else e.ir_memory_read(to,1);events=[];
            on_event=()=>{set32(0x13000+(to>>>12)*4,fail?0:0x350003);e.full_clear_tlb();on_event=undefined;};};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert.equal(on_event,undefined);assert.equal(words[664>>2],100+(fail?1:steps(c)));if(fail){assert.equal(actual.ip,HANDLER);assert.equal(actual.cr2,to);}
        configure();for(let n=0;n<(fail?2:steps(c));n++)e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events);remaps++;
    }
    console.log(`PASS: ${remaps} source-MMIO destination remaps and delayed destination faults`);
    function user(){
        const desc=(n,base,limit,access,flags)=>{set32(0x3000+n*8,limit&65535|base<<16);set32(0x3004+n*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);};
        desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0,0xFFFFF,0xFB,12);desc(4,0,0xFFFFF,0xF3,12);desc(5,0x4000,0x67,0x89,0);
        cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);
        cpu.sreg.set([0x23,0x1B,0x23,0x23,0x23,0x23]);cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;set32(0x12000,0x13007);set32(0x13000+8*4,0x8007);for(let p=0x310;p<=0x350;p++)set32(0x13000+p*4,p*4096|7);e.full_clear_tlb();e.update_state_flags();
    }
    let cross_faults=0;
    for(const [c,i] of selected) if(c[2]>8) for(const opt of [0,1]) for(const side of [...(source(c)?["src"]:[]),...(destination(c)?["dst"]:[])]){
        const configure=()=>{reset(i,1,side==="src"?0xFFF:0x40,side==="dst"?0xFFF:0x80);user();set32(0x13000+((side==="src"?from:to)>>>12)*4+4,0);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);assert.equal(actual.cr2,((side==="src"?from:to)&~4095)+4096);assert.equal(words[664>>2],101);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`string ring3 second page ${i}/${side}`);cross_faults++;
    }
    console.log(`PASS: ${cross_faults} ring3 second-page read/write faults through a kernel TSS stack`);
    let aliases=0;
    for(const [c,i] of selected) if(c[4]===0xA4) for(const opt of [0,1]) for(const delta of [-1,0,1]){
        const configure=()=>{reset(i,0,0x40,0x40+delta);set32(0x13000+(to>>>12)*4,(from&~4095)|3);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());aliases++;
    }
    console.log(`PASS: ${aliases} single-iteration MOVS physical-alias and overlap cases`);
    let values=0;
    for(const [c,i] of selected) for(const opt of [0,1]) for(const [a,b] of [[0,0],[0,1],[1,0],[0xFFFFFFFF,0xFFFFFFFF],[0x7FFFFFFF,0xFFFFFFFF],[0x80000000,1],[0x7FFF,0xFFFF],[0x8000,1],[0x7F,0xFF],[0x80,1]]){
        const configure=()=>{reset(i);set32(from,a);set32(to,b);cpu.reg32[0]=a;};
        configure();instances[i][opt].exports.f(0);const actual=state();
        configure();for(let n=0;n<steps(c);n++)e.ir_test_step();assert.deepEqual(actual,state(),`string operand/FLAGS ${i}/${a}/${b}`);values++;
    }
    console.log(`PASS: ${values} string zero/sign/borrow/overflow operand patterns with complete FLAGS`);
    let selfmodifying=0;
    for(const [c,i] of selected) if(stores(c)) for(const opt of [0,1]){
        const configure=()=>{reset(i,0,0x40,c[0].length-2);set32(0x13000+(to>>>12)*4,PC|3);windows.push([PC,32]);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);assert.equal(actual.regs[2],0x12345678);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());selfmodifying++;
    }
    console.log(`PASS: ${selfmodifying} string writes aliasing following instruction bytes`);
    let real=0,vm86=0;
    for(const [c,i] of selected) if(!c[1]) for(const opt of [0,1]) for(const df of [0,1]) for(const vm_mode of [false,true]){
        const configure=()=>{reset(i,df);if(vm_mode){user();cpu.flags[0]|=0x20000;} else {e.ir_test_set_cr0(cr0&~0x80000001);}
            const source_data=mem.slice(from-32,from+64),dest_data=mem.slice(to-32,to+64);
            cpu.segment_offsets.set([0x33000,0,0,0x31000,0x31000,0x31000]);cpu.sreg.set([0x3300,0,0,0x3100,0x3100,0x3100]);cpu.segment_limits.fill(65535,0,6);cpu.reg32[4]=STACK;
            from=0x31040;to=0x33080;mem.set(source_data,from-32);mem.set(dest_data,to-32);windows=[[from-32,96],[to-32,96],[STACK-96,112]];
            if(vm_mode){set32(0x13000+0x31*4,0x31007);set32(0x13000+0x33*4,0x33007);}e.full_clear_tlb();e.update_state_flags();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],100+steps(c));assert.equal(actual.cpl,vm_mode?3:0);
        configure();for(let n=0;n<steps(c);n++)e.ir_test_step();assert.deepEqual(actual,state(),`string mode ${i}/${df}/${vm_mode}`);if(vm_mode)vm86++;else real++;
    }
    console.log(`PASS: ${real} real-mode and ${vm86} VM86 single-string cases`);
} finally {await vm.destroy();}
