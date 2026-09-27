import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-io/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-io/${i}-${opt}.wasm`))));
const wasm=process.argv[2]||"build/v86-ir-test.wasm";
const vm=new V86({wasm_path:wasm,memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true),set16=(a,v)=>view.setUint16(a,v,true);
    vm.run();const deadline=performance.now()+10000;while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,BASE=0x310000,STACK=0x90000,HANDLER=0x180000,TSS=0x40000,BITMAP=TSS+0x2080,cr0=cpu.cr[0];let target=BASE+0x40,events=[],on_port,slow=0,windows=[];
    const observe=(kind,port,width,value)=>{events.push({kind,port,width,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,data:Buffer.from(mem.slice(target-8,target+8))});on_port?.(kind,port,width,value);};
    for(const port of [0xE8,0x500,0x507,0xFFFE]){
        cpu.io.register_read(port,null,()=>{observe("in",port,8);return 0xEF;},()=>{observe("in",port,16);return 0xCDEF;},()=>{observe("in",port,32);return 0x89ABCDEF|0;});
        cpu.io.register_write(port,null,v=>observe("out",port,8,v),v=>observe("out",port,16,v),v=>observe("out",port,32,v>>>0));
    }
    const imports={...e,m:e.memory,ir_memory_read:(...a)=>{slow++;return e.ir_memory_read(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    function desc(n,base,limit,access,flags){set32(0x3000+n*8,limit&65535|base<<16);set32(0x3004+n*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
    function reset(i,port=0x500,df=0,offset=0x40,hot=false){
        const c=cases[i],[bytes,mode,width,asize,kind,segment]=c,seg=kind===4?0:segment<0?3:segment;
        e.ir_test_set_cr0(cr0|0x10000);cpu.cr[2]=0xBADF000;on_port=undefined;
        desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0,0xFFFFF,0xFB,12);desc(4,0,0xFFFFF,0xF3,12);desc(5,TSS,0x5000,0x89,0);cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;
        cpu.segment_offsets.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);if(kind>=4)cpu.segment_offsets[seg]=BASE;
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.stack_size_32[0]=1;words[612>>2]=0;cpu.is_32[0]=+mode;
        cpu.reg32.set([0xAABBCCDD,0x11223344,0xABCD0000|port,0x7FFFFFFF,(STACK-cpu.segment_offsets[2])>>>0,0x99AABBCC,asize===16?0xAAAA0000|offset&65535:offset,asize===16?0xBBBB0000|offset&65535:offset]);
        cpu.flags[0]=0x8D7|df<<10;cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.instruction_pointer[0]=(PC+cpu.segment_offsets[1])>>>0;cpu.in_hlt[0]=0;words[664>>2]=100;cpu.reg_xmm32s.fill(0);
        cpu.segment_offsets[6]=TSS;cpu.segment_limits[6]=0x5000;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;set32(TSS+4,STACK);set32(TSS+8,16);set16(TSS+0x66,0x2080);mem.fill(0,BITMAP,BITMAP+0x2010);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const vector of [13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);for(const p of [3,8,0x40,0x42,0x43,0x44])set32(0x13000+p*4,p*4096|3);for(let p=0x310;p<=0x330;p++)set32(0x13000+p*4,p*4096|3);
        target=BASE+(asize===16?offset&65535:offset);mem.fill(0x5A,target-32,target+64);set32(target,0x12345678);mem.fill(0xCC,STACK-96,STACK+16);mem.set(bytes,cpu.instruction_pointer[0]);windows=[[target-32,96],[STACK-96,112]];
        e.full_clear_tlb();e.update_state_flags();if(hot&&kind===5){e.ir_memory_read(target,1);e.ir_memory_read(target+width/8-1,1);}slow=0;events=[];
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),xmm:Array.from(cpu.reg_xmm32s,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,cr2:cpu.cr[2]>>>0,cpl:words[612>>2]&255,ss32:cpu.stack_size_32[0],mode:cpu.is_32[0],sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),data:windows.map(([a,n])=>Buffer.from(mem.slice(a,a+n)))});
    let ordinary=0,owned=0;
    for(let i=0;i<cases.length;i++) for(const port of cases[i][4]<2?[0xE8]:[0x500,0x507,0xFFFE]) for(const df of [0,1]) for(const opt of [0,1]) for(const hot of [false,true]){
        reset(i,port,df,0x40,hot);const before=state();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice(),c=cases[i];assert.equal(words[664>>2],102);assert.equal(events.length,1);assert.equal(events[0].port,port);assert.equal(events[0].width,c[2]);
        if(hot&&c[4]===5){assert.equal(slow,0);owned++;}assert.equal(actual.regs[1],before.regs[1]);
        if(c[4]>=4){const reg=c[4]===4?7:6,delta=(df?-1:1)*c[2]/8,old=before.regs[reg];assert.equal(actual.regs[reg],c[3]===32?(old+delta)>>>0:(old&~65535|(old+delta)&65535)>>>0);}
        reset(i,port,df,0x40,hot);e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`I/O ordinary ${i}/${port}/${df}`);assert.deepEqual(observed,events);ordinary++;
    }
    console.log(`PASS: ${ordinary} scalar/string I/O CPU/device comparisons, ${owned} CPU-owned OUTS source paths`);
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[5]===-1&&c[6]===0);
    function privilege(cpl,iopl,vmMode=false){words[612>>2]=cpl;cpu.flags[0]=cpu.flags[0]&~0x23000|iopl<<12|(vmMode?0x20000:0);if(cpl===3){cpu.sreg.set([0x23,0x1B,0x23,0x23,0x23,0x23]);cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);set32(0x12000,0x13007);set32(0x13000+8*4,0x8007);for(let p=0x310;p<=0x330;p++)set32(0x13000+p*4,p*4096|7);}e.full_clear_tlb();e.update_state_flags();}
    let permission=0;
    for(const [c,i] of selected) for(const opt of [0,1]) for(const port of c[4]<2?[0xE8]:[0x500,0x507,0xFFFE]) for(const [cpl,iopl,vmMode] of [[0,0,false],[3,0,false],[3,3,false],[3,0,true],[3,3,true]]) for(const denied of [false,true]){
        if(vmMode&&c[1]) continue;
        const configure=()=>{reset(i,port);privilege(cpl,iopl,vmMode);if(denied)mem[BITMAP+(port>>>3)]|=1<<(port&7);};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice(),fault=denied&&(cpl>iopl||vmMode);assert.equal(words[664>>2],fault?101:102);assert.equal(events.length,fault?0:1);if(fault)assert.equal(actual.ip,HANDLER);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`I/O permission ${i}/${port}/${cpl}/${iopl}/${vmMode}/${denied}`);assert.deepEqual(observed,events);permission++;
    }
    console.log(`PASS: ${permission} CPL/IOPL/VM86 bitmap permission cases`);
    let faults=0;
    for(const [c,i] of selected) if(c[4]>=4) for(const opt of [0,1]) for(const fault of ["segment","permission","data","both","readonly",...(c[2]>8?["tail"]:[])]){
        const configure=()=>{reset(i,0x507,0,fault==="tail"?0xFFF:0x40);privilege(3,0);if(fault==="segment"){cpu.segment_is_null[c[4]===4?0:3]=1;} if(fault==="permission"||fault==="both")mem[BITMAP+(0x507>>>3)]|=128;if(["data","both","readonly","tail"].includes(fault))set32(0x13000+(target>>>12)*4+(fault==="tail"?4:0),fault==="readonly"?(target&~4095)|5:0);e.full_clear_tlb();e.update_state_flags();};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice(),success=fault==="readonly"&&c[4]===5;assert.equal(words[664>>2],success?102:101);assert.equal(events.length,success?1:0);if(!success)assert.equal(actual.ip,HANDLER);
        if(["data","tail"].includes(fault)||fault==="readonly"&&!success)assert.equal(actual.cr2,fault==="tail"?(target&~4095)+4096:target);
        if(fault==="permission"||fault==="both")assert.equal(slow,0,"permission precedes OUTS memory");
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`I/O fault order ${i}/${fault}`);assert.deepEqual(observed,events);faults++;
    }
    console.log(`PASS: ${faults} string I/O segment/permission/page fault ordering cases`);
    let bitmap_bits=0;
    for(const [c,i] of selected) for(const opt of [0,1]) for(let byte=0;byte<=c[2]/8;byte++){
        const port=c[4]<2?0xE8:0x507,configure=()=>{reset(i,port);privilege(3,0);const bit=port+byte;mem[BITMAP+(bit>>>3)]|=1<<(bit&7);};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice(),fault=byte<c[2]/8;assert.equal(events.length,fault?0:1);assert.equal(words[664>>2],fault?101:102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events);bitmap_bits++;
    }
    console.log(`PASS: ${bitmap_bits} bitmap byte-lane permissions and adjacent allowed bits`);
    let tss_faults=0;
    for(const [c,i] of selected) for(const opt of [0,1]) for(const fault of ["tss16","short-header","short-bitmap","header-page","bitmap-page"]){
        const configure=()=>{reset(i);privilege(3,0);if(fault==="tss16"){cpu.tss_size_32[0]=0;set16(TSS+2,0x9000);set16(TSS+4,16);mem.fill(0xCC,0x8FA0,0x9000);windows.push([0x8FA0,96]);} if(fault==="short-header")cpu.segment_limits[6]=0x66;if(fault==="short-bitmap")cpu.segment_limits[6]=0x2080+((c[4]<2?0xE8:0x500)>>>3)-1;
            if(fault==="header-page"){cpu.segment_offsets[6]=TSS+0xFA0;set32(TSS+0xFA4,STACK);set32(TSS+0xFA8,16);set32(0x13000+0x41*4,0);} if(fault==="bitmap-page")set32(0x13000+0x42*4,0);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(events.length,0);assert.equal(words[664>>2],101);
        if(fault==="header-page")assert.equal(actual.cr2,TSS+0x1006);if(fault==="bitmap-page")assert.equal(actual.cr2,BITMAP+((c[4]<2?0xE8:0x500)>>>3));
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`I/O TSS ${i}/${fault}`);tss_faults++;
    }
    console.log(`PASS: ${tss_faults} TSS form/limit/header-page/bitmap-page failures`);
    const physical=a=>a<0xA1000?(target&~4095)+(a&4095):a<0xA2000?TSS+(a&4095):(BITMAP&~4095)+(a&4095);
    cpu.io.mmap_register(0xA0000,0x4000,a=>{observe("memory-read",a,8);return mem[physical(a)];},(a,v)=>observe("memory-write",a,8,v),a=>{observe("memory-read",a,32);return get32(physical(a))|0;},(a,v)=>observe("memory-write",a,32,v>>>0));
    let devices=0;
    for(const [c,i] of selected) for(const opt of [0,1]){
        const configure=()=>{reset(i);privilege(3,0);set32(0x13000+0x40*4,0xA1003);set32(0x13000+0x42*4,0xA2003);if(c[4]>=4)set32(0x13000+(target>>>12)*4,0xA0007);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert.equal(words[664>>2],102);assert(observed.some(e=>e.kind==="memory-read"));assert.equal(observed.filter(e=>e.kind==="in"||e.kind==="out").length,1);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events,`I/O device ordering ${i}`);devices++;
    }
    console.log(`PASS: ${devices} TSS/bitmap/data MMIO and port ordering comparisons`);
    let observer_mutations=0;
    for(const [c,i] of selected) if(c[4]>=4) for(const opt of [0,1]) for(const df of [0,1]) {
        for(const stage of ["header","bitmap","port","memory"]) for(const denied of stage==="header"||stage==="bitmap"?[false,true]:[false]) {
            let mutations=0;
            const configure=()=>{
                reset(i,0x507,df);privilege(3,0);
                set32(0x13000+0x40*4,0xA1003);set32(0x13000+0x42*4,0xA2003);
                set32(0x13000+(target>>>12)*4,0xA0007);
                if(denied)mem[BITMAP+(0x507>>>3)]|=128;
                mutations=0;
                on_port=(kind,address)=>{
                    const selected=stage==="port"?kind==="in"||kind==="out"
                        :stage==="memory"?address>=0xA0000&&address<0xA1000
                        :stage==="header"?address>=0xA1000&&address<0xA2000
                        :address>=0xA2000&&address<0xA3000;
                    if(!selected||mutations)return;
                    mutations++;
                    cpu.reg32[0]=0x11223344;cpu.reg32[1]=0xDEADBEEF|0;
                    cpu.reg32[2]=0xCAFEBEEF|0;cpu.reg32[3]=0x76543210;
                    cpu.reg32[6]=0xFACEABCD|0;cpu.reg32[7]=0xBEEFFEDC|0;
                    for(let lane=0;lane<32;lane++)cpu.reg_xmm32s[lane]=0x13579+lane;
                    cpu.flags[0]=e.get_eflags()^0x400;cpu.flags_changed[0]=0;
                };
                e.full_clear_tlb();e.update_state_flags();
            };
            const label=`string I/O observer ${i}/${opt}/${df}/${stage}/${denied}`;
            configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();
            assert.equal(mutations,1,label);assert.equal(words[664>>2],denied?101:102,label);
            assert.equal(observed.filter(e=>e.kind==="in"||e.kind==="out").length,denied?0:1,label);
            if(!denied&&c[3]===16)assert.equal(actual.regs[c[4]===4?7:6]>>>16,c[4]===4?0xBEEF:0xFACE,
                `${label}: address16 preserves callback-updated pointer high bits`);
            configure();e.ir_test_step();e.ir_test_step();assert.equal(mutations,1,label);
            assert.deepEqual(actual,state(),label);assert.deepEqual(observed,events,label);observer_mutations++;
        }
    }
    console.log(`PASS: ${observer_mutations} single INS/OUTS permission/port/data observers preserve GPR/XMM/FLAGS and address16 high bits, with exact success/fault retirement`);
    let remaps=0;
    for(const [c,i] of selected) if(c[4]===4) for(const opt of [0,1]) for(const fail of [false,true]){
        const configure=()=>{reset(i);mem.fill(0x66,0x330000,0x330100);windows.push([0x330000,256]);on_port=()=>{set32(0x13000+(target>>>12)*4,fail?0:0x330003);e.full_clear_tlb();on_port=undefined;};};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert.equal(events.length,1);assert.equal(on_port,undefined);assert.equal(words[664>>2],fail?101:102);if(fail){assert.equal(actual.ip,HANDLER);assert.equal(actual.cr2,target);}
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events);remaps++;
    }
    console.log(`PASS: ${remaps} INS port-callback destination remaps/faults after preflight`);
    let boundaries=0;
    for(const [c,i] of selected) if(c[4]>=4) for(const opt of [0,1]) for(const df of [0,1]) for(const offset of [0,0xFFF,0xFFFF]){
        reset(i,0x507,df,offset);instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert.equal(words[664>>2],102);
        reset(i,0x507,df,offset);e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events);boundaries++;
    }
    console.log(`PASS: ${boundaries} INS/OUTS page boundaries and DF/address16 wraps`);
    let real=0;
    for(const [c,i] of selected) if(!c[1]) for(const opt of [0,1]) for(const df of [0,1]){
        const configure=()=>{reset(i,0x507,df);e.ir_test_set_cr0(cr0&~0x80000001);if(c[4]>=4){const data=mem.slice(target-32,target+64);cpu.segment_offsets[c[4]===4?0:3]=0x31000;cpu.sreg[c[4]===4?0:3]=0x3100;target=0x31040;mem.set(data,target-32);windows[0]=[target-32,96];}e.full_clear_tlb();e.update_state_flags();};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert.equal(words[664>>2],102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events);real++;
    }
    console.log(`PASS: ${real} real-mode scalar and string I/O cases`);
} finally {await vm.destroy();}
