import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-exchange/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>{const bytes=fs.readFileSync(`build/ir-exchange/${i}-${opt}.wasm`);assert(WebAssembly.validate(bytes));return new WebAssembly.Module(bytes);}));
const locked=JSON.parse(fs.readFileSync("build/ir-exchange/locked.json"));
const locked_modules=locked.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-exchange/locked-${i}-${opt}.wasm`))));
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const part=(regs,r,width)=>BigInt(regs[width===8?r&3:r]>>>0)>>BigInt(width===8&&r>=4?8:0)&((1n<<BigInt(width))-1n);
function reference(c,regs,flags,last,memory) {
    const [, ,width,kind,src,dst]=c,w=BigInt(width),mask=(1n<<w)-1n,out=regs.slice();
    const a=dst>=8?BigInt(memory)&mask:part(regs,dst,width),source=part(regs,src,width),acc=part(regs,0,width);
    const write=(reg,value)=>{const r=width===8?reg&3:reg,shift=BigInt(width===8&&reg>=4?8:0);out[r]=Number(BigInt(out[r])&~(mask<<shift)|(value&mask)<<shift)>>>0;};
    let result=source;
    if(kind===0)write(src,a);
    else {
        const left=kind===1?a:acc,right=kind===1?source:a,raw=kind===1?left+right:left-right,low=raw&mask,sign=1n<<(w-1n);
        const signed=n=>n&sign?n-mask-1n:n,signed_raw=kind===1?signed(left)+signed(right):signed(left)-signed(right);
        const cf=raw<0n||raw>mask,of=signed_raw< -sign||signed_raw>=sign,af=!!((left^right^low)&16n);
        const parity=Number(low&255n).toString(2).replaceAll("0","").length%2===0;
        const bits=Number(cf)|Number(parity)<<2|Number(af)<<4|Number(low===0n)<<6|Number(!!(low&sign))<<7|Number(of)<<11;
        flags=(flags&~0x8D5|bits)>>>0;last=Number(left);
        if(kind===1){write(src,a);result=low;}
        else {if(acc!==a)write(0,a);result=acc===a?source:a;}
    }
    if(dst<8)write(dst,result);
    return {regs:out,flags,last,data:Number(result)};
}
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x100000,BASE=0x300040,HANDLER=0x180000,STACK=0x90000;e.ir_test_set_cr0(cpu.cr[0]|0x10000);
    let slow=0,events=[],on_read;
    const imports={...e,m:e.memory,ir_rmw_read:(...a)=>{slow++;return e.ir_rmw_read(...a);},ir_rmw_write:(...a)=>{slow++;return e.ir_rmw_write(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports}))),locked_instances=locked_modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    function reset(i,input,equal,base=BASE,hot=false,fault="",lazy=false) {
        const [bytes,mode,width,,,dst]=cases[i];
        cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=0;
        cpu.reg32.set([input,0x89ABCDEF,input^0x80000000,input+1,STACK,0x12345678,base,~input]);
        if(dst===9){cpu.reg32[6]=base&65535;cpu.segment_offsets[3]=base&0xFFFF0000;}
        if(dst===10){cpu.reg32[6]=base-0x10000;cpu.segment_offsets[4]=0x10000;}
        const data=(input^0x13579BDF)>>>0;
        if(equal){const desired=dst>=8?BigInt(data):part(cpu.reg32,dst,width),mask=(1n<<BigInt(width))-1n;cpu.reg32[0]=Number(BigInt(cpu.reg32[0]>>>0)&~mask|desired&mask);}
        cpu.flags[0]=input&1?0x8D7:2;cpu.flags_changed[0]=lazy?0x8D5:0;
        words[96>>2]=31;words[104>>2]=input^0xF;words[112>>2]=input+3;
        cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;mem.set(bytes,PC);mem.fill(0xCC,STACK-64,STACK);mem.fill(0x6D,base-8,base+12);set32(base,data);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const vector of [13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        const page=base>>>12;set32(0x13000+page*4,page*4096|3);set32(0x13000+(page+1)*4,(page+1)*4096|3);
        e.full_clear_tlb();e.update_state_flags();
        if(hot&&dst>=8){e.ir_memory_write(base,mem[base],1);e.ir_memory_write(base+3,mem[base+3],1);}
        if(fault==="missing")set32(0x13000+page*4,0);
        if(fault==="readonly")set32(0x13000+page*4,page*4096|1);
        if(fault==="cross"||fault==="device-cross")set32(0x13000+(page+1)*4,0);
        if(fault==="segment")cpu.segment_is_null[dst===10?4:3]=1;
        if(fault.startsWith("device"))set32(0x13000+page*4,0xA0003);
        if(fault)e.full_clear_tlb();slow=0;events=[];on_read=undefined;
    }
    const state=(base=BASE)=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,cr2:cpu.cr[2]>>>0,
        data:Array.from(mem.slice(base-4,base+8)),stack:Array.from(mem.slice(STACK-32,STACK))});
    const values=[0,1,0xFFFFFFFF,0x80000000,0x7FFFFFFF,0x80FF7FFF];
    let ordinary=0,native=0;
    for(let i=0;i<cases.length;i++) for(const input of values) for(const equal of [false,true]) for(const opt of [0,1]) {
        reset(i,input,equal,BASE,true);const expected=reference(cases[i],Array.from(cpu.reg32,x=>x>>>0),e.get_eflags()>>>0,words[104>>2],get32(BASE));
        instances[i][opt].exports.f(0);const actual=state();assert.deepEqual(actual.regs,expected.regs,`exchange oracle ${i} ${input} ${equal}`);assert.equal(actual.flags,expected.flags);assert.equal(actual.last,expected.last);
        if(cases[i][5]>=8){const width=cases[i][2],mask=width===32?0xFFFFFFFF:(1<<width)-1;assert.equal((get32(BASE)&mask)>>>0,expected.data);assert.equal(slow,0);native++;}
        assert.equal(words[664>>2],101);reset(i,input,equal,BASE,true);e.ir_test_step();assert.deepEqual(actual,state(),`CPU exchange ${i} ${input} ${equal} ${opt}`);ordinary++;
    }
    console.log(`PASS: ${ordinary} XCHG/XADD/CMPXCHG alias/FLAGS comparisons, ${native} native warm memory paths including explicit/implicit LOCK`);
    const observe=(kind,a,value)=>events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);if(on_read)on_read();return 0x81;},(a,v)=>observe("w8",a,v),
        a=>{observe("r32",a);if(on_read)on_read();return 0x81000001|0;},(a,v)=>observe("w32",a,v>>>0));
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[5]>=8&&[0,4,6].includes(c[4]));
    let faults=0,devices=0,unaligned=0;
    for(const [c,i] of selected) for(const equal of [false,true]) for(const opt of [0,1]) {
        for(const fault of ["missing","readonly","segment",...(c[2]>8?["cross","device-cross"]:[])]) {
            const base=fault.includes("cross")?0x300FFF:BASE;reset(i,0xF,equal,base,false,fault,true);instances[i][opt].exports.f(0);const actual=state(base);
            assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],100);assert.equal(events.length,0);
            reset(i,0xF,equal,base,false,fault,true);e.ir_test_step();assert.deepEqual(actual,state(base));faults++;
        }
        reset(i,0xF,equal,BASE,false,"device",true);instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();
        assert(events.some(e=>e.kind.startsWith("r"))&&events.some(e=>e.kind.startsWith("w")),"failed CMPXCHG still writes");
        reset(i,0xF,equal,BASE,false,"device",true);e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events,`exchange MMIO ${i}`);devices++;
        if(c[2]>8){reset(i,0xFF,equal,0x300FFF,false);instances[i][opt].exports.f(0);const actual=state(0x300FFF);
            reset(i,0xFF,equal,0x300FFF,false);e.ir_test_step();assert.deepEqual(actual,state(0x300FFF));unaligned++;}
    }
    console.log(`PASS: ${faults} exchange faults, ${devices} MMIO read/write states, ${unaligned} cross-page successes`);
    let locks=0;
    for(let i=0;i<locked.length;i++) for(const opt of [0,1]) for(const input of values) for(const device of [false,true]) {
        const exchange=cases.findIndex(c=>c[1]&&c[2]===32&&c[3]===1&&c[4]===3&&c[5]===8&&c[6]);
        const configure=()=>{reset(exchange,input,false,BASE,false,device?"device":"",true);cpu.reg32[1]=7;mem.set(locked[i],PC);};
        configure();locked_instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();assert.equal(words[664>>2],101);
        configure();e.ir_test_step();assert.deepEqual(actual,state(),`LOCK family ${i}`);assert.deepEqual(observed,events);locks++;
    }
    console.log(`PASS: ${locks} audited LOCK arithmetic/unary/bit-family CPU and MMIO comparisons`);
    const shared=new WebAssembly.Memory({initial:64,maximum:64,shared:true});
    assert.throws(()=>new WebAssembly.Instance(modules[cases.findIndex(c=>c[6])][0],{e:{...imports,m:shared}}),WebAssembly.LinkError,"locked artifacts reject shared memory");
    const i=cases.findIndex(c=>c[1]&&c[2]===32&&c[3]===2&&c[4]===3&&c[5]===8&&c[6]);
    reset(i,0xF,false,BASE,false,"device");on_read=()=>globalThis.queueMicrotask(()=>events.push({kind:"microtask"}));instances[i][1].exports.f(0);
    assert.deepEqual(events.map(e=>e.kind),["r32","w32"],"no async interleaving inside LOCK pair");await Promise.resolve();assert.equal(events.at(-1).kind,"microtask");
    console.log("PASS: non-shared memory ABI and synchronous locked-pair scheduling constraints");
} finally {await vm.destroy();}
