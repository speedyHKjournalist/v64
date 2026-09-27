import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-bits/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>{
    const bytes=fs.readFileSync(`build/ir-bits/${i}-${opt}.wasm`);assert(WebAssembly.validate(bytes));return new WebAssembly.Module(bytes);
}));
function reference(c,regs,flags,last,data,index) {
    const [, ,width,kind,rm,imm]=c,out=regs.slice(),mask=width===16?65535:0xFFFFFFFF;
    const value=(rm>=8?data:regs[rm])&mask;
    if(kind===7){
        // BSWAP ignores the decoded operand-width override in the baseline.
        const v=regs[rm];out[rm]=(v>>>24|(v>>>8&0xFF00)|(v<<8&0xFF0000)|v<<24)>>>0;return {regs:out,flags};}
    if(kind>=4) {
        const bits=BigInt(value>>>0),positions=[];for(let n=0;n<width;n++) if(bits>>BigInt(n)&1n)positions.push(n);
        const result=kind===6?positions.length:positions.length?(kind===4?positions[0]:positions.at(-1)):0;
        if(kind===6){flags=flags&~0x8D5|Number(!positions.length)<<6;}
        else {
            const other=(result-last)>>>0,overflow=(((last^result)&(other^result))>>>(width-1))&1;
            const parity=result.toString(2).replaceAll("0","").length%2===0;
            flags=flags&~0x8D5|overflow<<11|Number(parity)<<2|Number((result&15)<(last&15))<<4|Number(!positions.length)<<6;
        }
        if(kind===6||positions.length)out[1]=width===32?result:(out[1]&0xFFFF0000|result)>>>0;
        return {regs:out,flags:flags>>>0};
    }
    const bit=rm>=8?index&7:(imm<0?regs[1]:imm)&(width-1),old=rm>=8?BigInt(data&255):BigInt(value>>>0);
    const selected=1n<<BigInt(bit),carry=Number(!!(old&selected));flags=flags&~1|carry;
    const result=kind===0?old:kind===1?old|selected:kind===2?old&~selected:old^selected;
    if(rm<8&&kind!==0)out[rm]=width===32?Number(result):(out[rm]&0xFFFF0000|Number(result))>>>0;
    return {regs:out,flags:flags>>>0,data:Number(result)};
}
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x100000,BASE=0x310040,HANDLER=0x180000,STACK=0x90000;e.ir_test_set_cr0(cpu.cr[0]|0x10000);
    let slow=0,events=[],target=BASE,bit_index=0;
    const imports={...e,m:e.memory,ir_memory_read:(...a)=>{slow++;return e.ir_memory_read(...a);},ir_rmw_read:(...a)=>{slow++;return e.ir_rmw_read(...a);},ir_rmw_write:(...a)=>{slow++;return e.ir_rmw_write(...a);}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    function reset(i,input,index,base=BASE,hot=false,fault="",lazy=false) {
        const [bytes,mode,width,kind,rm,imm]=cases[i];
        cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=0;
        cpu.reg32.set([input,index,input,0x12345678,STACK,0x89ABCDEF,base,0xAA5533CC]);
        if(rm===9){cpu.reg32[6]=base&65535;cpu.segment_offsets[3]=base&0xFFFF0000;}
        if(rm===10){cpu.reg32[6]=base-0x10000;cpu.segment_offsets[4]=0x10000;}
        bit_index=imm<0?(width===16?index<<16>>16:index|0):imm&(width-1);
        target=(base+(kind<4?bit_index>>3:0))>>>0;
        cpu.flags[0]=input&1?0x8D7:2;cpu.flags_changed[0]=lazy?0x8D5:0;words[96>>2]=31;
        words[104>>2]=(input^0x8000001F)>>>0;words[112>>2]=(input+3)>>>0;
        cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;mem.set(bytes,PC);mem.fill(0xCC,STACK-64,STACK);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const vector of [13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        for(let page=0x30E;page<=0x314;page++)set32(0x13000+page*4,page*4096|3);
        const page=target>>>12;
        if(target<mem.length-8){mem.fill(0x6D,target-8,target+8);set32(target,input);}
        e.full_clear_tlb();e.update_state_flags();
        if(hot&&rm>=8)e.ir_memory_write(target,mem[target],1);
        if(fault==="missing")set32(0x13000+page*4,0);
        if(fault==="readonly")set32(0x13000+page*4,page*4096|1);
        if(fault==="cross")set32(0x13000+(page+1)*4,0);
        if(fault==="segment")cpu.segment_is_null[rm===10?4:3]=1;
        if(fault==="device")set32(0x13000+page*4,0xA0003);
        if(fault==="unused-base")set32(0x13000+(base>>>12)*4,0);
        if(fault)e.full_clear_tlb();slow=0;events=[];
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,cr2:cpu.cr[2]>>>0,
        data:target<mem.length?Array.from(mem.slice(target-4,target+8)):[],stack:Array.from(mem.slice(STACK-32,STACK))});
    const raw_state=()=>[cpu.flags[0]>>>0,cpu.flags_changed[0]>>>0,
        words[112>>2]>>>0,words[104>>2]>>>0,words[96>>2]>>>0];
    const values=[0,1,2,0xFFFFFFFF,0x80000000,0x80000001,0xFFFF,0x8000,0xAA55FF80,0x12345678];
    const indices=[-32768,-257,-33,-17,-9,-8,-1,0,1,7,8,15,16,31,32,63,255,256,32767,32768,65535];
    let ordinary=0,native=0;
    for(let i=0;i<cases.length;i++) for(const input of values) for(const index of cases[i][3]<4&&cases[i][5]<0?indices:[0,0xDEADBEEF]) for(const opt of [0,1]) {
        reset(i,input,index,BASE,true);
        const expected=reference(cases[i],Array.from(cpu.reg32,x=>x>>>0),e.get_eflags()>>>0,words[104>>2],get32(target),bit_index);
        instances[i][opt].exports.f(0);const actual=state(),actual_raw=raw_state();assert.equal(words[664>>2],101);assert.equal(actual.ip,PC+cases[i][0].length);
        assert.deepEqual(actual.regs,expected.regs,`reference bits ${i} input=${input} index=${index}`);assert.equal(actual.flags,expected.flags);
        if(cases[i][4]>=8&&cases[i][3]<4)assert.equal(mem[target],expected.data);
        if(cases[i][4]>=8){assert.equal(slow,0);native++;}
        reset(i,input,index,BASE,true);e.ir_test_step();assert.deepEqual(actual,state(),`CPU bits ${i} input=${input.toString(16)} index=${index} opt=${opt}`);
        assert.deepEqual(actual_raw,raw_state(),`raw bit backing ${i} kind=${cases[i][3]}`);ordinary++;
    }
    console.log(`PASS: ${ordinary} bit/string/scan/POPCNT/BSWAP comparisons, ${native} native warm memory paths`);
    const observe=(kind,a,value)=>events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return 0x81;},(a,v)=>observe("w8",a,v),a=>{observe("r32",a);return 0x81000001|0;},(a,v)=>observe("w32",a,v>>>0));
    const selected=cases.map((c,i)=>[c,i]).filter(([c])=>c[4]>=8&&c[5]===-1);
    let faults=0,devices=0,lazy=0,boundaries=0;
    for(const [c,i] of selected) for(const opt of [0,1]) {
        for(const fault of ["missing","segment",...(c[3]>0&&c[3]<4?["readonly"]:[]),...(c[3]>=4?["cross"]:[])]) {
            const base=fault==="cross"?0x310FFF:BASE;
            reset(i,0x8000,-9,base,false,fault,true);instances[i][opt].exports.f(0);const actual=state();
            assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],100);assert.equal(events.length,0);
            reset(i,0x8000,-9,base,false,fault,true);e.ir_test_step();assert.deepEqual(actual,state(),`bit fault ${i} ${fault}`);faults++;
        }
        reset(i,0x8000,-9,BASE,false,"device",true);instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();
        assert(events.length>0);if(c[3]<4){assert.equal(events[0].kind,"r8");assert.equal(events.length,c[3]===0?1:2);}
        reset(i,0x8000,-9,BASE,false,"device",true);e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events,`MMIO bit width ${i}`);devices++;
        reset(i,0x8000,-9,BASE,false,"",true);instances[i][opt].exports.f(0);const actual_lazy=state();
        reset(i,0x8000,-9,BASE,false,"",true);e.ir_test_step();assert.deepEqual(actual_lazy,state());lazy++;
        if(c[3]<4) for(const [base,index] of [[0x310FFF,8],[0x310000,-1],[0x30FFFF,8],[0x310000,-32768]]) {
            reset(i,0x81,index,base,false,"unused-base");instances[i][opt].exports.f(0);const adjusted=state();
            assert.equal(adjusted.ip,PC+c[0].length,"unused base page must not be read");
            reset(i,0x81,index,base,false,"unused-base");e.ir_test_step();assert.deepEqual(adjusted,state());boundaries++;
        }
    }
    console.log(`PASS: ${faults} bit memory faults, ${devices} MMIO comparisons, ${lazy} lazy FLAGS, ${boundaries} signed-index/page/address16 boundary cases`);
    let exhaustive=0;
    for(const kind of [4,5,6]) for(const opt of [0,1]) {
        const i=cases.findIndex(c=>c[1]&&c[2]===16&&c[3]===kind&&c[4]===0);
        for(let input=0;input<65536;input++) {
            reset(i,input,0xBEEF1234);
            const expected=reference(cases[i],Array.from(cpu.reg32,x=>x>>>0),e.get_eflags()>>>0,words[104>>2],input,0);
            instances[i][opt].exports.f(0);const actual=state();assert.deepEqual(actual.regs,expected.regs);assert.equal(actual.flags,expected.flags);
            reset(i,input,0xBEEF1234);e.ir_test_step();assert.deepEqual(actual,state());exhaustive++;
        }
    }
    console.log(`PASS: ${exhaustive} exhaustive 16-bit BSF/BSR/POPCNT cases`);
    let basis=0;
    for(const kind of [4,5,6]) for(const mode of [false,true]) for(const opt of [0,1]) {
        const i=cases.findIndex(c=>c[1]===mode&&c[2]===32&&c[3]===kind&&c[4]===0);
        for(let bit=0;bit<32;bit++) for(const input of [(1<<bit)>>>0,~(1<<bit)>>>0]) {
            reset(i,input,0x12345678);instances[i][opt].exports.f(0);const actual=state();
            reset(i,input,0x12345678);e.ir_test_step();assert.deepEqual(actual,state());basis++;
        }
    }
    console.log(`PASS: ${basis} dword scan/count basis and complement patterns`);

    let counts=0;
    const count_samples=[0n,1n,2n,0x80000000n,0x100000000n,0x8000000000000000n,0xFFFFFFFFFFFFFFFFn];
    function count_reference(value,width) {
        const positions=[];for(let bit=0;bit<width;bit++) if(value>>BigInt(bit)&1n)positions.push(bit);
        return [positions.length?width-1-positions.at(-1):width,positions.length?positions[0]:width,positions.length];
    }
    for(const opt of [0,1]) for(const input of count_samples) for(const constant of [false,true]) {
        const m=new WebAssembly.Memory({initial:64}),s=new Uint32Array(m.buffer);s[0]=Number(input&0xFFFFFFFFn);s[1]=Number(input>>32n);s[8]=2;
        const name=constant?input.toString():"input";
        const module=new WebAssembly.Module(fs.readFileSync(`build/ir-bits/count-${name}-${opt}.wasm`));
        new WebAssembly.Instance(module,{e:{m}}).exports.f(0);
        assert.deepEqual(Array.from(s.slice(0,6)),[...count_reference(input&0xFFFFFFFFn,32),...count_reference(input,64)]);counts++;
    }
    console.log(`PASS: ${counts} i32/i64 bit counts, zero/full-width boundaries and folded/unfolded artifacts`);

} finally {await vm.destroy();}
