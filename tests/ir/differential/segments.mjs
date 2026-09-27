import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-segments/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-segments/${i}-${opt}.wasm`))));
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const far=c=>![0x8C,0x8E].includes(c[3]);
const destination=c=>c[3]===0x8E?c[4]:({196:0,197:3,4018:2,4020:4,4021:5})[c[3]];
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true),set16=(a,v)=>view.setUint16(a,v,true);
    vm.run();const deadline=performance.now()+10000;while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x8000,BASE=0x310000,STACK=0x90000,HANDLER=0x180000,cr0=cpu.cr[0];let reads=0,writes=0,calls=0,events=[],on_event,windows=[],target=BASE;
    const imports={...e,m:e.memory,ir_mov_segment_continue:(...a)=>{calls++;return e.ir_mov_segment_continue(...a);},ir_memory_read:(...a)=>{reads++;return e.ir_memory_read(...a);},ir_memory_write:(...a)=>{writes++;return e.ir_memory_write(...a);},ir_load_segment:(...a)=>{calls++;return e.ir_load_segment(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    function desc(index,base,limit,access,flags){set32(0x3000+index*8,limit&65535|base<<16);set32(0x3004+index*8,base&0xFF000000|(base>>>16&255)|access<<8|(limit&0xF0000)|flags<<20);}
    function reset(i,selector=0x20,offset=0x40,hot=false){
        const c=cases[i],[bytes,mode,width,op,reg,operand]=c;e.ir_test_set_cr0(cr0|0x10000);cpu.cr[2]=0xBADF000;on_event=undefined;
        desc(0,0,0,0,0);desc(1,0,0xFFFFF,0x9B,12);desc(2,0,0xFFFFF,0x93,12);desc(3,0x330000,65535,0x93,0);desc(4,0x340000,0xFFFFF,0x93,12);desc(5,0,0xFFFFF,0xFB,12);desc(6,0x350000,0xFFFFF,0xF3,12);desc(7,0x4000,0x67,0x89,0);desc(8,0,0xFFFFF,0x13,12);desc(9,0,0xFFFFF,0x99,12);
        cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=79;cpu.segment_offsets.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.segment_is_null.fill(0,0,6);
        cpu.sreg.set([0x18,8,16,0x20,0x18,0x20]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=0;
        cpu.reg32.set([0x7FFFFFFF,0x11223344,0x55667788,0x99AABBCC,STACK,0xABCD0020,BASE+offset,0xFEDCBA98]);
        if(operand===9)cpu.reg32[4]=BASE+offset;
        if(operand===10){cpu.reg32[5]=0xABCD0020;cpu.reg32[6]=(0xDCBA0000|(offset-0x20)&65535)>>>0;cpu.segment_offsets[2]=BASE;cpu.reg32[4]=(STACK-BASE)>>>0;}
        if(operand===11){cpu.segment_offsets[4]=BASE;cpu.reg32[6]=offset;}
        if(op===0x8E&&operand<8){cpu.reg32[operand]=0xAABB0000|selector;if(operand===0)cpu.reg32[0]=0xAABB0000|((selector-1)&65535);}
        cpu.flags[0]=0x8D7;cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;for(const vector of [11,12,13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);for(const p of [3,5,6,8,0x18])set32(0x13000+p*4,p*4096|3);for(let p=0x30F;p<=0x350;p++)set32(0x13000+p*4,p*4096|3);
        target=BASE+offset;mem.fill(0x5A,target-64,target+128);mem.fill(0xCC,STACK-64,STACK+16);mem.set(bytes,PC);set32(target,far(c)?0x89ABCDEF:selector);if(far(c))set16(target+width/8,selector);
        windows=[[target-64,192],[STACK-64,80],[0x3000,80]];e.full_clear_tlb();e.update_state_flags();
        if(hot&&operand>=8){e.ir_memory_write(target,mem[target],1);e.ir_memory_write(target+width/8,mem[target+width/8],1);}
        reads=writes=calls=0;events=[];
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,cr2:cpu.cr[2]>>>0,cpl:words[612>>2]&255,ss32:cpu.stack_size_32[0],mode:cpu.is_32[0],sreg:Array.from(cpu.sreg.slice(0,6)),base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),limit:Array.from(cpu.segment_limits.slice(0,6),x=>x>>>0),access:Array.from(cpu.segment_access_bytes.slice(0,6)),null:Array.from(cpu.segment_is_null.slice(0,6)),data:windows.map(([a,n])=>Buffer.from(mem.slice(a,a+n)))});
    const steps=c=>c[3]===0x8C&&c[5]<8?3:2;
    let ordinary=0,native=0;
    for(let i=0;i<cases.length;i++) for(const selector of [0x18,0x20]) for(const hot of [false,true]) for(const opt of [0,1]){
        reset(i,selector,0x40,hot);instances[i][opt].exports.f(0);const actual=state(),c=cases[i];assert.equal(words[664>>2],100+steps(c));assert.equal(calls,c[3]===0x8C?0:1);
        if(hot&&c[5]>=8){assert.equal(reads+writes,0);native++;}
        if(c[3]!==0x8C){assert.equal(actual.sreg[destination(c)],selector);if(far(c))assert.equal(actual.regs[c[4]]&(c[2]===16?65535:-1),c[2]===16?0xCDEF:0x89ABCDEF|0);}
        reset(i,selector,0x40,hot);for(let n=0;n<steps(c);n++)e.ir_test_step();assert.deepEqual(actual,state(),`segment ordinary ${i}/${selector}/${hot}`);ordinary++;
    }
    console.log(`PASS: ${ordinary} segment MOV/far-load CPU comparisons, ${native} native data paths`);
    const observe=(kind,a,value)=>{events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0,ss32:cpu.stack_size_32[0]});on_event?.();};
    const physical=a=>a>=0xA1000&&a<0xA2000?0x3000+(a&4095):((target&~4095)+(a&4095));
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return mem[physical(a)];},(a,v)=>observe("w8",a,v),a=>{observe("r32",a);return get32(physical(a))|0;},(a,v)=>observe("w32",a,v>>>0));
    let devices=0,selectors=0;
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[5]===8||c[5]===11);
    for(const [c,i] of selected) for(const opt of [0,1]){
        const configure=()=>{reset(i);set32(0x13000+0x310*4,0xA0003);if(c[3]!==0x8C)set32(0x13000+3*4,0xA1003);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert(events.length>0);
        configure();for(let n=0;n<steps(c);n++)e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events,`segment device ordering ${i}`);devices++;
        if(c[3]!==0x8C&&c[5]===8) for(const selector of [0,0x40,0x48,0x100,0x1B]){
            reset(i,selector);instances[i][opt].exports.f(0);const actual=state(),fault=selector!==0||destination(c)===2;assert.equal(words[664>>2],fault?101:102);if(fault)assert.equal(actual.ip,HANDLER);
            reset(i,selector);e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`segment validation ${i}/${selector}`);selectors++;
        }
    }
    console.log(`PASS: ${devices} source/descriptor MMIO observations and ${selectors} selector fault/null cases`);
    function user(){cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x38;cpu.tss_size_32[0]=1;set32(0x4004,STACK);set32(0x4008,16);cpu.sreg.set([0x33,0x2B,0x33,0x33,0x33,0x33]);cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;set32(0x12000,0x13007);set32(0x13000+8*4,0x8007);for(let p=0x30F;p<=0x350;p++)set32(0x13000+p*4,p*4096|7);e.full_clear_tlb();e.update_state_flags();}
    let faults=0;
    for(let i=0;i<cases.length;i++){const c=cases[i];if(c[5]<8) continue;for(const opt of [0,1]) for(const fault of ["first",...(far(c)?["selector"]:[]),...(c[3]===0x8C?["readonly"]:[])]){
        const offset=fault==="selector"?0x1000-c[2]/8:0x40,configure=()=>{reset(i,0x33,offset);user();set32(0x13000+(fault==="selector"?0x311:0x310)*4,fault==="readonly"?0x310005:0);e.full_clear_tlb();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(actual.ip,HANDLER);assert.equal(actual.cpl,0);assert.equal(actual.cr2,fault==="selector"?BASE+0x1000:BASE+offset);assert.equal(words[664>>2],101);assert.equal(calls,0);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`segment memory fault ${i}/${fault}`);faults++;
    }}
    console.log(`PASS: ${faults} real ring3 operand faults, including far-pointer selector reads before descriptor changes`);
    let boundaries=0,remaps=0;
    for(const [c,i] of selected) if(c[5]===8||c[5]===11) for(const opt of [0,1]){
        for(const offset of [0xFFF,0xFFFF]){
            reset(i,0x20,offset);instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);
            reset(i,0x20,offset);e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`segment crossing ${i}/${offset}`);boundaries++;
        }
        if(far(c)){
            const offset=0x1000-c[2]/8,configure=()=>{reset(i,0x20,offset);set32(0x13000+0x310*4,0xA0003);mem.fill(0x5A,0x350000,0x350100);set16(0x350000,0x18);windows.push([0x350000,128]);e.full_clear_tlb();
                on_event=()=>{set32(0x13000+0x311*4,0x350003);e.full_clear_tlb();on_event=undefined;};};
            configure();instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert.equal(on_event,undefined);assert.equal(actual.sreg[destination(c)],0x18);
            configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events);remaps++;
        }
    }
    // Address16 far pointers continue linearly across FFFF rather than wrapping
    // the selector word to the beginning of the source segment.
    for(let i=0;i<cases.length;i++) if(far(cases[i])&&cases[i][5]===10) for(const opt of [0,1]){
        const configure=()=>reset(i,0x20,0xFFFE);configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());boundaries++;
    }
    console.log(`PASS: ${boundaries} page/address16 boundaries and ${remaps} MMIO-driven selector-page remaps`);
    const caught=f=>{try {f();return false;} catch(err){assert(err instanceof WebAssembly.RuntimeError);return true;}};
    let descriptor_faults=0;
    for(const [c,i] of selected) if(c[5]===8&&c[3]!==0x8C&&c[4]!==4) for(const opt of [0,1]) for(const write_fault of [false,true]){
        const configure=()=>{reset(i,0x1000);mem.copyWithin(0x5000,0x3000,0x3050);cpu.gdtr_offset[0]=0x5000;cpu.gdtr_size[0]=0x10FF;set32(0x6000,0xFFFF);set32(0x6004,0x00CF9200);set32(0x13000+6*4,write_fault?0x6001:0);windows.push([0x5000,0x1100]);e.full_clear_tlb();};
        configure();const trapped=caught(()=>instances[i][opt].exports.f(0)),actual=state();assert.equal(trapped,write_fault);assert.equal(actual.cr2,write_fault?0x6005:0x6000);assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],101);
        configure();e.ir_test_step();assert.equal(caught(()=>e.ir_test_step()),write_fault);assert.deepEqual(actual,state());descriptor_faults++;
    }
    console.log(`PASS: ${descriptor_faults} descriptor read/accessed-bit #PF cases with old GPR preservation`);
    let real=0;
    for(const [c,i] of selected) if(c[5]===8&&!c[1]) for(const opt of [0,1]) for(const selector of [0,0xA000,0xFFFF]){
        const configure=()=>{reset(i,selector);e.ir_test_set_cr0(cr0&~0x80000001);e.full_clear_tlb();e.update_state_flags();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());real++;
    }
    console.log(`PASS: ${real} real-mode segment transfer/far-load cases`);
    let vm_cases=0;
    for(const [c,i] of selected) if(c[5]===8&&!c[1]) for(const opt of [0,1]) for(const selector of [0,0xA000,0xFFFF]) for(const iopl of [0,3]){
        const configure=()=>{reset(i,selector);user();cpu.flags[0]|=0x20000|iopl<<12;e.update_state_flags();};
        configure();instances[i][opt].exports.f(0);const actual=state();assert.equal(words[664>>2],102);assert.equal(actual.cpl,3);
        if(c[3]!==0x8C){assert.equal(actual.sreg[destination(c)],selector);assert.equal(actual.base[destination(c)],selector<<4);}
        configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`VM86 segment ${i}/${selector}/${iopl}`);vm_cases++;
    }
    console.log(`PASS: ${vm_cases} VM86 segment transfer/far-load cases at IOPL0/3`);
    for(const seg of [0,2,3,4,5]) for(const opt of [0,1]) for(const vm86 of [false,true]) {
        const code=[0x41,0x8E,0xC0|seg<<3,[0x26,0x2E,0x36,0x3E,0x64,0x65][seg],0x8B,0x1D,0,4,0,0,0x43];
        const configure=()=>{
            reset(cases.findIndex(c=>c[1]&&c[3]===0x8E&&c[4]===seg&&c[5]===0));
            e.ir_test_set_cr0(vm86?cr0&~0x80000000:cr0&~0x80000001);
            if(vm86) cpu.flags[0]|=0x20000;
            cpu.reg32[0]=0x300;cpu.reg32[1]=0x12345678;mem.set(code,PC);set32(0x3400,0x789ABCDE);
            e.full_clear_tlb();e.update_state_flags();
        };
        const instance=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-segments/continue-${seg}-${opt}.wasm`)),{e:imports});
        configure();instance.exports.f(0);const actual=state();
        assert.equal(words[664>>2],104);assert.equal(actual.regs[3],0x789ABCDF);assert.equal(actual.regs[1],0x12345679);
        configure();for(let i=0;i<4;i++)e.ir_test_step();assert.deepEqual(actual,state(),`segment continuation ${seg}/${opt}/${vm86}`);
    }
    console.log("PASS: real/VM86 segment continuation keeps dirty SSA state and uses changed DS/ES/SS/FS/GS bases");
} finally {await vm.destroy();}
