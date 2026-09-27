import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-misc/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-misc/${i}-${opt}.wasm`))));
const chains=JSON.parse(fs.readFileSync("build/ir-misc/chains.json"));
const chain_modules=chains.map((_,i)=>[0,1].map(opt=>new WebAssembly.Module(fs.readFileSync(`build/ir-misc/chain-${i}-${opt}.wasm`))));
const parity=n=>{let ones=0;for(let bit=0;bit<8;bit++)ones+=n>>bit&1;return Number(!(ones&1));};
const szp=n=>parity(n)<<2|Number(n===0)<<6|n&128;
function reference(c,regs,flags) {
    const [, ,op,width,imm]=c,r=regs.slice(),al=r[0]&255,ah=r[0]>>>8&255,ax=r[0]&65535,cf=flags&1,af=flags>>4&1;
    const write=(reg,width,value)=>{r[reg]=width===32?value>>>0:(r[reg]&~(2**width-1)|value&(2**width-1))>>>0;};
    switch(op){
        case 0x98:write(0,width,width===16?al<<24>>24:ax<<16>>16);break;
        case 0x99:write(2,width,width===16?ax<<16>>31:r[0]>>31);break;
        case 0x9E:flags=((flags&~255|ah)&0x3F7FD5)|2;break;
        case 0x9F:r[0]=(r[0]&~0xFF00|(flags&255)<<8)>>>0;break;
        case 0xFC:flags&=~1024;break;
        case 0xFD:flags|=1024;break;
        case 0xD6:write(0,8,cf?255:0);break;
        case 0x37:case 0x3F:{const adjust=Number((al&15)>9||af);write(0,16,((ax+(adjust?(op===0x37?262:-262):0))&65535)&0xFF0F);flags=flags&~17|adjust*17;break;}
        case 0x27:case 0x2F:{const lower=Number((al&15)>9||af),upper=Number(al>153||cf),n=(al+(op===0x27?1:-1)*(lower*6+upper*96))&255;write(0,8,n);flags=flags&~0xD5|szp(n)|lower<<4|upper|Number(op===0x2F&&lower&&al<6);break;}
        case 0xD5:{const n=(al+ah*imm)&255;write(0,16,n);flags=flags&~0x8D5|szp(n);break;}
        case 0xD4:if(!imm) return null;else {const n=al%imm;write(0,16,(Math.floor(al/imm)<<8)|n);flags=flags&~0x8D5|szp(n);break;}
        default:throw Error("nonregister reference");
    }
    return {regs:r,flags:flags>>>0};
}
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x100000,BASE=0x310000,STACK=0x90000,HANDLER=0x180000,cr0=cpu.cr[0],gdt=[cpu.gdtr_offset[0],cpu.gdtr_size[0]];
    let slow=0,events=[],target=BASE,active_case=-1,deliveries=0;
    const imports={...e,m:e.memory,ir_memory_read:(...a)=>{slow++;return e.ir_memory_read(...a);},ir_memory_write:(...a)=>{slow++;return e.ir_memory_write(...a);},ir_divide_fault:()=>{deliveries++;return e.ir_divide_fault();}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports}))),chain_instances=chain_modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    function environment(){
        e.ir_test_set_cr0(cr0|0x10000);cpu.gdtr_offset[0]=gdt[0];cpu.gdtr_size[0]=gdt[1];
        cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.stack_size_32[0]=1;words[612>>2]=0;
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const vector of [0,13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);set32(0x13000+0x100*4,0x100003);
        for(let p=0x30E;p<=0x340;p++)set32(0x13000+p*4,p*4096|3);
        e.full_clear_tlb();active_case=-1;
    }
    environment();
    function reset(i,input,flags,lazy=false){
        const [bytes,mode]=cases[i];cpu.reg32.set([input,0x89ABCDEF,0x55667788,0x7FFFFFFF,STACK,0xAA55CC33,0x80000001,0x10203040]);
        cpu.is_32[0]=+mode;cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;deliveries=0;
        cpu.flags[0]=flags;cpu.flags_changed[0]=lazy?0x8D5:0;words[96>>2]=31;words[104>>2]=(input^0x8000001F)>>>0;words[112>>2]=(input+3)>>>0;
        if(active_case!==i){mem.set(bytes,PC);active_case=i;}e.update_state_flags();
    }
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0});
    const find=(op,mode=true,width=0,imm=-1)=>cases.findIndex(c=>c[2]===op&&c[1]===mode&&c[3]===width&&c[4]===imm);
    const is_memory=c=>c[5]!==0;
    function compare(i,input,flags,opt,lazy=false){
        reset(i,input,flags,lazy);const before=state(),expected=reference(cases[i],before.regs,before.flags);assert(expected);
        instances[i][opt].exports.f(0);const actual=state();
        assert.equal(words[664>>2],101);assert.equal(actual.ip,PC+cases[i][0].length);assert.equal(actual.last,before.last);
        assert.deepEqual(actual.regs,expected.regs,`misc reference ${i}/${input}/${flags}`);assert.equal(actual.flags,expected.flags,`misc flags ${i}/${input}/${flags}`);
        reset(i,input,flags,lazy);e.ir_test_step();const baseline=state();
        // Only DAA/DAS OF is undefined and uses an explicit preserve-input policy.
        if(cases[i][2]===0x27||cases[i][2]===0x2F){baseline.flags&=~0x800;actual.flags&=~0x800;}
        assert.deepEqual(actual,baseline,`CPU misc ${i}/${input}/${flags}/lazy=${lazy}`);
    }
    let ordinary=0;
    const inputs=[0,1,5,6,9,10,15,16,0x7F,0x80,0x99,0x9A,0xFF,0x100,0x7FFF,0x8000,0xFFFF,0xFFFFFFFF,0x80000000,0x7FFFFFFF,0xAABBCCDD];
    for(let i=0;i<cases.length;i++) if(!is_memory(cases[i])&&!(cases[i][2]===0xD4&&cases[i][4]===0)) for(const input of inputs) for(const opt of [0,1]) for(const lazy of [false,true]){
        compare(i,input,input&1?0x8D7:0x402,opt,lazy);ordinary++;
    }
    console.log(`PASS: ${ordinary} scalar conversion/FLAGS/BCD CPU and independent-reference comparisons`);
    let exhaustive=0;
    for(const mode of [false,true]) for(const opt of [0,1]){
        for(const op of [0x27,0x2F]) for(let al=0;al<256;al++) for(let bits=0;bits<8;bits++){
            compare(find(op,mode),0xABCD8000|al,2|(bits&1)|((bits>>1&1)<<4)|((bits>>2)<<11),opt);exhaustive++;
        }
        for(const op of [0x37,0x3F]) for(let ax=0;ax<65536;ax++) for(const af of [0,16]){
            compare(find(op,mode),0xABCD0000|ax,2|af|(ax&0x8C5),opt);exhaustive++;
        }
        for(let base=1;base<256;base++) for(let al=0;al<256;al++){
            compare(find(0xD4,mode,0,base),0xABCD8000|al,0x8D7,opt);exhaustive++;
        }
        for(const base of [0,10,255]) for(let ax=0;ax<65536;ax++){
            compare(find(0xD5,mode,0,base),0xABCD0000|ax,0x8D7,opt);exhaustive++;
        }
        for(const op of [0x98,0x99]) for(const width of [16,32]) for(let ax=0;ax<65536;ax++){
            compare(find(op,mode,width),0xABCD0000|ax,0x8D7,opt);exhaustive++;
        }
        for(const op of [0x9E,0x9F]) for(let byte=0;byte<256;byte++) for(let bits=0;bits<64;bits++){
            const flags=2|[0,2,4,6,7,11].reduce((f,shift,n)=>f|((bits>>n&1)<<shift),0);
            compare(find(op,mode),0xABCD00AA|byte<<8,flags,opt);exhaustive++;
        }
    }
    console.log(`PASS: ${exhaustive} exhaustive BCD, sign-extension and flag-transfer cases`);
    let sequences=0;
    for(let n=0;n<chains.length;n++) for(const input of inputs) for(const opt of [0,1]){
        const i=find(0x9F),configure=()=>{environment();reset(i,input,0x8D7);mem.set(chains[n],PC);active_case=-1;mem.fill(0xCC,STACK-32,STACK);};
        configure();chain_instances[n][opt].exports.f(0);const actual=state(),frame=Array.from(mem.slice(STACK-32,STACK));
        const steps=[3,3,3,3,3,3,2,4,2][n];assert.equal(words[664>>2],100+(n===6?1:steps));assert.equal(deliveries,n===6?1:0);
        configure();for(let k=0;k<steps;k++)e.ir_test_step();const baseline=state();if(n<2){baseline.flags&=~0x800;actual.flags&=~0x800;}
        assert.deepEqual(actual,baseline,`misc chain ${n}`);assert.deepEqual(frame,Array.from(mem.slice(STACK-32,STACK)));sequences++;
    }
    console.log(`PASS: ${sequences} in-region FLAGS/BCD chains and completed-prefix #DE accounting`);
    const observe=(kind,a,value)=>events.push({kind,a,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return 0x81;},(a,v)=>observe("w8",a,v),a=>{observe("r32",a);return 0x81000001|0;},(a,v)=>observe("w32",a,v>>>0));
    function memory_reset(i,input,hot=false,fault=""){
        environment();reset(i,input,0x8D7,true);const [,,op,width,,address,segment,offset]=cases[i];
        cpu.segment_offsets[segment]=BASE;cpu.reg32[3]=0xABCD0000|offset;
        if(op===0xD7&&address===32)cpu.reg32[3]=offset;
        target=(BASE+(op===0xD7?address===16?(offset+(input&255))&65535:offset+(input&255):offset))>>>0;
        mem.fill(0x6D,target-8,target+12);set32(target,0x12345678);mem.fill(0xCC,STACK-32,STACK);
        if(hot)e.ir_memory_write(target,mem[target],1);
        const page=target>>>12;
        if(fault==="missing")set32(0x13000+page*4,0);
        if(fault==="readonly")set32(0x13000+page*4,page*4096|1);
        if(fault==="cross")set32(0x13000+(page+1)*4,0);
        if(fault==="segment")cpu.segment_is_null[segment]=1;
        if(fault==="device")set32(0x13000+page*4,0xA0003);
        if(fault)e.full_clear_tlb();slow=0;events=[];return width;
    }
    const memory_state=()=>({...state(),cr2:cpu.cr[2]>>>0,data:Array.from(mem.slice(target-4,target+8)),frame:Array.from(mem.slice(STACK-32,STACK))});
    let memory=0,native=0,faults=0,devices=0;
    for(let i=0;i<cases.length;i++) if(is_memory(cases[i])) for(const opt of [0,1]){
        for(const hot of [false,true]) for(const input of [0,1,255,0xAA55FF80]){
            memory_reset(i,input,hot);instances[i][opt].exports.f(0);const actual=memory_state();assert.equal(words[664>>2],101);
            if(hot&&((target&4095)+cases[i][3]/8<=4096)){assert.equal(slow,0);native++;}
            memory_reset(i,input,hot);e.ir_test_step();assert.deepEqual(actual,memory_state(),`implicit memory ${i}`);memory++;
        }
        const c=cases[i];for(const fault of ["missing","segment",...(c[2]===0xA2||c[2]===0xA3?["readonly"]:[]),...(c[3]>8&&(c[7]&4095)===4095?["cross"]:[])]){
            memory_reset(i,0x80,false,fault);instances[i][opt].exports.f(0);const actual=memory_state();assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],100);assert.equal(events.length,0);
            memory_reset(i,0x80,false,fault);e.ir_test_step();assert.deepEqual(actual,memory_state(),`implicit memory fault ${i}/${fault}`);faults++;
        }
        memory_reset(i,0x80,false,"device");instances[i][opt].exports.f(0);const actual=memory_state(),observed=events.slice();assert(events.length>0);
        memory_reset(i,0x80,false,"device");e.ir_test_step();assert.deepEqual(actual,memory_state());assert.deepEqual(observed,events);devices++;
    }
    console.log(`PASS: ${memory} moffs/XLAT cases, ${native} native paths, ${faults} real faults and ${devices} MMIO states`);
    let division_faults=0;
    for(const mode of [false,true]) for(const opt of [0,1]) for(const input of inputs){
        const i=find(0xD4,mode,0,0),configure=()=>{environment();reset(i,input,0x8D7,true);mem.fill(0xCC,STACK-32,STACK);};
        configure();instances[i][opt].exports.f(0);const actual=memory_state();assert.equal(actual.ip,HANDLER);assert.equal(words[664>>2],100);assert.equal(deliveries,1);
        configure();e.ir_test_step();assert.deepEqual(actual,memory_state());division_faults++;
    }
    let user_faults=0;
    for(const mode of [false,true]) for(const opt of [0,1]) for(const input of [0,255,0x8000,0xFFFFFFFF]){
        const i=find(0xD4,mode,0,0),configure=()=>{
            environment();reset(i,input,0x8D7,true);
            for(const [index,lo,hi] of [[0,0,0],[1,0xFFFF,0x00CF9A00],[2,0xFFFF,0x00CF9200],[3,0xFFFF,0x00CFFA00],[4,0xFFFF,0x00CFF200],[5,0x40000067,0x00008900]]){set32(0x3000+index*8,lo);set32(0x3004+index*8,hi);}
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;
            set32(0x4004,STACK);set32(0x4008,16);cpu.sreg.set([0x23,0x1B,0x23,0x23,0x23,0x23]);cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;
            cpu.reg32[4]=BASE+0x80;set32(0x12000,0x13007);set32(0x13000+0x100*4,0x100007);mem.fill(0xCC,STACK-32,STACK);e.full_clear_tlb();e.update_state_flags();
        };
        configure();instances[i][opt].exports.f(0);const actual=memory_state();assert.equal(deliveries,1);assert.equal(words[664>>2],100);assert.equal(actual.ip,HANDLER);assert.equal(words[612>>2]&255,0);assert.equal(actual.regs[4],STACK-20);assert.equal(get32(STACK-8),BASE+0x80);
        configure();e.ir_test_step();assert.deepEqual(actual,memory_state());user_faults++;
    }
    console.log(`PASS: ${user_faults} ring3 AAM #DE deliveries through a real TSS`);
    console.log(`PASS: ${division_faults} AAM zero-base #DE cases with unchanged pre-instruction state`);
} finally {await vm.destroy();}
