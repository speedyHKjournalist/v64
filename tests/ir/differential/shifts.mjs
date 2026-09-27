import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-shifts/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>{
    const bytes=fs.readFileSync(`build/ir-shifts/${i}-${opt}.wasm`);
    assert(WebAssembly.validate(bytes));return new WebAssembly.Module(bytes);
}));
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Independent bit-serial oracle: one-bit steps rather than the emitter's
// variable-shift formulas. Undefined flags follow the documented pinned policy.
function reference(c,regs,flags,last,memory,count) {
    const [, ,width,group,dst,immediate]=c,w=BigInt(width),mask=(1n<<w)-1n;
    const r=width===8?dst&3:dst,lsb=width===8&&dst>=4?8n:0n;
    const original=(BigInt(dst<8?regs[r]:memory)>> (dst<8?lsb:0n))&mask;
    let result=original,cf=BigInt(flags&1),n=(immediate<0?(immediate===-2?1:count):immediate)&31;
    if((group===2||group===3)&&width<32)n%=width+1;
    if(n===0) return dst<8?[...regs,flags]:[...regs,flags,Number(original)];
    let pair=group===8?(original<<w)|(BigInt(regs[1])&mask):((BigInt(regs[1])&mask)<<w)|original;
    const pair_mask=(1n<<(2n*w))-1n;
    for(let bit=0;bit<n;bit++) {
        const low=result&1n,high=result>>(w-1n)&1n;
        if(group===0){result=(result<<1n|high)&mask;cf=high;}
        else if(group===1){result=result>>1n|low<<(w-1n);cf=low;}
        else if(group===2){result=(result<<1n|cf)&mask;cf=high;}
        else if(group===3){result=result>>1n|cf<<(w-1n);cf=low;}
        else if(group===4||group===6){result=result<<1n&mask;cf=high;}
        else if(group===5){result>>=1n;cf=low;}
        else if(group===7){result=result>>1n|high<<(w-1n);cf=low;}
        else if(group===8){cf=pair>>(2n*w-1n)&1n;pair=(pair<<1n|cf)&pair_mask;result=pair>>w;}
        else {cf=pair&1n;pair=pair>>1n|cf<<(2n*w-1n);result=pair&mask;}
    }
    const high=result>>(w-1n)&1n;
    let of=(group===1||group===3)?high^(result>>(w-2n)&1n):group===5?original>>(w-1n):group===7?0n:group===9?(original>>(w-1n))^high:cf^high;
    if(group===8&&width===32&&n!==1)of=0n;
    let out_flags=flags&~0x801|Number(cf)|Number(of)<<11;
    if(group>=4) {
        const parity=Number(result&255n).toString(2).replaceAll("0","").length%2===0;
        const af=Number(result&15n)<(last&15);
        out_flags=out_flags&~0xD4|Number(parity)<<2|Number(af)<<4|Number(result===0n)<<6|Number(high)<<7;
    }
    const out=[...regs,out_flags>>>0];
    if(dst<8)out[r]=Number(BigInt(regs[r])&~(mask<<lsb)|result<<lsb)>>>0;
    return dst<8?out:[...out,Number(result)];
}

try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;
    while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);}
    await vm.stop();
    const PC=0x100000,ADDRESS=0x300040,HANDLER=0x180000,STACK=0x90000;
    e.ir_test_set_cr0(cpu.cr[0]|0x10000);
    let slow=0,events=[];
    const imports={...e,m:e.memory,ir_rmw_read:(...a)=>{slow++;return e.ir_rmw_read(...a);},
        ir_rmw_write:(...a)=>{slow++;return e.ir_rmw_write(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    const values=[0,0xFFFFFFFF,0x80000001,0x7FFFFFFF,0xAA55FF80,0x0101807F];
    function reset(i,input,count,address=ADDRESS,hot=false,fault="",lazy=false) {
        const [bytes,mode32,,,dst]=cases[i];
        cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_limits.fill(0xFFFFFFFF,0,6);
        cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.is_32[0]=+mode32;cpu.stack_size_32[0]=1;words[612>>2]=0;
        cpu.reg32.set([input,(input&0xFFFFFF00)|count,0x13579BDF,input^0xBEEF,STACK,0x12340000,address,input]);
        if(dst===9){cpu.reg32[6]=address&65535;cpu.segment_offsets[3]=address&0xFFFF0000;}
        cpu.flags[0]=(input&1)?0x8D7:2;cpu.flags_changed[0]=lazy?0x8D5:0;
        words[104>>2]=(input^0x1F)>>>0;words[112>>2]=(input+3)>>>0;words[96>>2]=31;
        cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        mem.set(bytes,PC);mem.fill(0xCC,STACK-64,STACK);set32(address,input);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const vector of [13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        const page=address>>>12;set32(0x13000+page*4,page*4096|3);set32(0x13000+(page+1)*4,(page+1)*4096|3);
        e.full_clear_tlb();e.update_state_flags();
        if(hot){e.ir_memory_write(address,mem[address],1);e.ir_memory_write(address+3,mem[address+3],1);}
        if(fault==="missing")set32(0x13000+page*4,0);
        if(fault==="readonly")set32(0x13000+page*4,page*4096|1);
        if(fault==="cross")set32(0x13000+(page+1)*4,0);
        if(fault==="segment")cpu.segment_is_null[3]=1;
        if(fault==="device")set32(0x13000+page*4,0xA0003);
        if(fault==="device-cross"){set32(0x13000+page*4,0xA0003);set32(0x13000+(page+1)*4,0);}
        if(fault)e.full_clear_tlb();
        slow=0;events=[];
    }
    function state(address=ADDRESS) {return [...Array.from(cpu.reg32,x=>x>>>0),e.get_eflags()>>>0,
        words[104>>2],cpu.instruction_pointer[0]>>>0,get32(address),cpu.cr[2]>>>0,
        ...Array.from(mem.slice(STACK-32,STACK))];}
    const raw_state=()=>[cpu.flags[0]>>>0,cpu.flags_changed[0]>>>0,
        words[112>>2]>>>0,words[104>>2]>>>0,words[96>>2]>>>0];
    let ordinary=0,native=0;
    for(let i=0;i<cases.length;i++) {
        const [bytes,,,group,dst,immediate]=cases[i];
        const counts=immediate===-1?Array.from({length:dst<8?256:32},(_,n)=>n):[immediate<0?1:immediate];
        for(const count of counts) for(const input of values) for(const opt of [0,1]) {
            reset(i,input,count,ADDRESS,true);
            const independent=reference(cases[i],Array.from(cpu.reg32,x=>x>>>0),e.get_eflags()>>>0,words[104>>2],get32(ADDRESS),count);
            instances[i][opt].exports.f(0);const actual=state(),actual_raw=raw_state();
            assert.deepEqual(actual.slice(0,9),independent.slice(0,9),`bit-serial oracle case=${i} count=${count}`);
            if(dst>=8){const mask=cases[i][2]===32?0xFFFFFFFF:(1<<cases[i][2])-1;assert.equal((actual[11]&mask)>>>0,independent[9]);}
            assert.equal(words[664>>2],101);assert.equal(actual[10],PC+bytes.length);
            if(dst>=8){assert.equal(slow,0,"warm shift RMW remains native");native++;}
            reset(i,input,count,ADDRESS,true);e.ir_test_step();
            assert.deepEqual(actual,state(),`shift ${i} group=${group} dst=${dst} count=${count} input=${input.toString(16)} opt=${opt}`);
            assert.deepEqual(actual_raw,raw_state(),`raw shift backing ${i} group=${group} count=${count}`);ordinary++;
        }
    }
    console.log(`PASS: ${ordinary} CPU shift/rotate comparisons, all 256 CL counts for registers, ${native} native warm RMW executions`);
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[4]===8&&c[5]===-1);
    let faults=0,lazy=0,devices=0;
    const observe=(kind,a,value)=>events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return 0x80+(a&7);},(a,v)=>observe("w8",a,v),
        a=>{observe("r32",a);return 0x89ABCDEF|0;},(a,v)=>observe("w32",a,v>>>0));
    for(const [c,i] of selected) for(const count of [0,1,9,17,32,255]) for(const opt of [0,1]) {
        for(const fault of ["missing","readonly","segment",...(c[2]>8?["cross","device-cross"]:[])]) {
            const address=fault.includes("cross")?0x300FFF:ADDRESS;
            reset(i,0x8D7,count,address,false,fault,true);instances[i][opt].exports.f(0);
            const actual=state(address),observed=events.slice();
            assert.equal(actual[10],HANDLER);assert.equal(words[664>>2],100);assert.equal(observed.length,0,"write permissions precede device read even for count zero");
            reset(i,0x8D7,count,address,false,fault,true);e.ir_test_step();
            assert.deepEqual(actual,state(address),`shift fault group=${c[3]} width=${c[2]} count=${count} ${fault}`);faults++;
        }
        reset(i,0x8D7,count,ADDRESS,false,"device",true);instances[i][opt].exports.f(0);
        const actual=state(),observed=events.slice();assert(observed.some(e=>e.kind.startsWith("r"))&&observed.some(e=>e.kind.startsWith("w")));
        reset(i,0x8D7,count,ADDRESS,false,"device",true);e.ir_test_step();
        assert.deepEqual(actual,state());assert.deepEqual(observed,events,`device FLAGS group=${c[3]} width=${c[2]} count=${count}`);devices++;
        reset(i,0x12347FFF,count,ADDRESS,false,"",true);instances[i][opt].exports.f(0);const lazy_state=state();
        reset(i,0x12347FFF,count,ADDRESS,false,"",true);e.ir_test_step();assert.deepEqual(lazy_state,state());lazy++;
    }
    console.log(`PASS: ${faults} shift memory faults, ${devices} MMIO read/write observers, ${lazy} lazy-FLAGS slow paths (including zero counts)`);
    let chains=0;
    const prefixes=JSON.parse(fs.readFileSync("build/ir-shifts/chains.json"));
    for(let id=0;id<prefixes.length;id++) for(const opt of [0,1]) {
        const instance=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-shifts/chain-${id}-${opt}.wasm`)),{e:imports});
        const combined=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-shifts/combined-${id}-${opt}.wasm`)),{e:imports});
        for(const input of values) for(const count of [0,1,2,7,16,31]) {
            const configure=()=>{reset(0,input,count);cpu.is_32[0]=1;e.update_state_flags();mem.set([...prefixes[id],0xC1,0xE2,count],PC);};
            configure();instance.exports.f(0);e.ir_test_step();const actual=state();
            configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state(),`IR exit provenance ALU=${id} count=${count}`);chains++;
            configure();mem.set([...prefixes[id],0xD3,0xE2],PC);combined.exports.f(0);const together=state();
            configure();mem.set([...prefixes[id],0xD3,0xE2],PC);e.ir_test_step();e.ir_test_step();
            assert.deepEqual(together,state(),`in-region provenance ALU=${id} count=${count}`);chains++;
        }
    }
    console.log(`PASS: ${chains} in-region and IR-to-interpreter shift sequences preserve last_op1 provenance`);
    const standalone=new WebAssembly.Module(fs.readFileSync("build/ir-shifts/standalone.wasm"));
    for(const input of values) {
        const m=new WebAssembly.Memory({initial:64}),s=new Uint32Array(m.buffer);s[0]=input;s[8]=2;s[11]=0xF;
        new WebAssembly.Instance(standalone,{e:{m}}).exports.f(0);
        const result=input<<1>>>0,af=((0xF^(result-0xF)^result)&16)!==0;
        assert.equal(s[0],result);assert.equal((s[8]>>4&1)!==0,af);assert.equal(s[11],0xF);
    }
    console.log("PASS: standalone shift ABI reads and preserves explicit flag provenance");
} finally {await vm.destroy();}
