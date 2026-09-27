import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const cases=JSON.parse(fs.readFileSync("build/ir-multiply/cases.json"));
const modules=cases.map((_,i)=>[0,1].map(opt=>{
    const bytes=fs.readFileSync(`build/ir-multiply/${i}-${opt}.wasm`);assert(WebAssembly.validate(bytes));return new WebAssembly.Module(bytes);
}));
const vm=new V86({wasm_path:"build/v86-ir-test.wasm",memory_size:32<<20,
    bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,
    disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function reference(c,regs,flags,last,memory) {
    const [, ,width,kind,src,dst]=c,w=BigInt(width),mask=(1n<<w)-1n;
    const read=(reg,bits)=>BigInt(regs[bits===8?reg&3:reg])>>BigInt(bits===8&&reg>=4?8:0)&((1n<<BigInt(bits))-1n);
    const source=src<8?read(src,width):BigInt(memory)&mask,signed=kind!==4&&kind!==6;
    const value=n=>signed?BigInt.asIntN(width,n):n;
    const out=regs.slice(),write=(r,bits,n)=>{
        const reg=bits===8?r&3:r,shift=BigInt(bits===8&&r>=4?8:0),m=(1n<<BigInt(bits))-1n;
        out[reg]=Number(BigInt(out[reg])&~(m<<shift)|(n&m)<<shift)>>>0;
    };
    if(kind===6||kind===7) {
        let dividend=width===8?read(0,16):(read(2,width)<<w)|read(0,width);
        if(signed)dividend=BigInt.asIntN(width*2,dividend);
        const divisor=value(source);
        if(divisor===0n) return null;
        const quotient=dividend/divisor,remainder=dividend%divisor;
        if(quotient<(signed?-(1n<<(w-1n)):0n)||quotient>(signed?(1n<<(w-1n))-1n:mask)) return null;
        write(0,width,quotient);write(width===8?4:2,width,remainder);return [...out,flags,last];
    }
    const other=kind<8?read(0,width):kind===8?read(dst,width):kind===9?BigInt(0x89ABCDEF)&mask:BigInt.asUintN(width,-128n);
    const result=value(source)*value(other),low=result&mask;
    const overflow=signed?result<-(1n<<(w-1n))||result>=(1n<<(w-1n)):result>mask;
    if(kind<8){if(width===8)write(0,16,result);else {write(0,width,result);write(2,width,result>>w);}}
    else write(dst,width,result);
    const parity=Number(low&255n).toString(2).replaceAll("0","").length%2===0;
    const bits=Number(overflow)*0x801|Number(parity)<<2|Number(Number(low&15n)<(last&15))<<4|Number(low===0n)<<6|Number(low>>(w-1n))<<7;
    return [...out,(flags&~0x8D5|bits)>>>0,last];
}
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer);
    const view=new DataView(mem.buffer,mem.byteOffset),set32=(a,v)=>view.setUint32(a,v,true),get32=a=>view.getUint32(a,true);
    vm.run();const deadline=performance.now()+10000;
    while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();
    const PC=0x100000,ADDRESS=0x300040,HANDLER=0x180000,STACK=0x90000;
    const old_gdt=[cpu.gdtr_offset[0],cpu.gdtr_size[0]];
    e.ir_test_set_cr0(cpu.cr[0]|0x10000);
    let reads=0,div_faults=0,events=[];
    const imports={...e,m:e.memory,ir_memory_read:(...a)=>{reads++;return e.ir_memory_read(...a);},
        ir_divide_fault:()=>{div_faults++;return e.ir_divide_fault();}};
    const instances=modules.map(pair=>pair.map(m=>new WebAssembly.Instance(m,{e:imports})));
    function reset(i,seed,address=ADDRESS,hot=false,fault="",lazy=false) {
        const [bytes,mode,,,src]=cases[i],[lo,hi,source]=seed;
        cpu.gdtr_offset[0]=old_gdt[0];cpu.gdtr_size[0]=old_gdt[1];
        cpu.segment_offsets.fill(0,0,6);cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=0;
        cpu.reg32.set([lo,source,hi,source,STACK,source,address,source]);
        if(src===9){cpu.reg32[6]=address&65535;cpu.segment_offsets[3]=address&0xFFFF0000;}
        cpu.flags[0]=lo&1?0x8D7:2;cpu.flags_changed[0]=lazy?0x8D5:0;
        words[96>>2]=31;words[104>>2]=(source^0x1F)>>>0;words[112>>2]=(lo+source)>>>0;
        cpu.instruction_pointer[0]=PC;cpu.in_hlt[0]=0;words[664>>2]=100;
        mem.set(bytes,PC);mem.fill(0xCC,STACK-64,STACK);set32(address,source);
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;
        for(const vector of [0,13,14]){set32(0x2000+vector*8,8<<16|HANDLER&65535);set32(0x2004+vector*8,HANDLER&0xFFFF0000|0x8E00);}
        const page=address>>>12;set32(0x13000+page*4,page*4096|3);set32(0x13000+(page+1)*4,(page+1)*4096|3);
        e.full_clear_tlb();e.update_state_flags();
        if(hot)e.ir_memory_read(address,4);
        if(fault==="missing")set32(0x13000+page*4,0);
        if(fault==="cross")set32(0x13000+(page+1)*4,0);
        if(fault==="segment")cpu.segment_is_null[3]=1;
        if(fault==="device")set32(0x13000+page*4,0xA0003);
        if(fault)e.full_clear_tlb();reads=div_faults=0;events=[];
    }
    const state=(a=ADDRESS)=>[...Array.from(cpu.reg32,x=>x>>>0),e.get_eflags()>>>0,words[104>>2],cpu.instruction_pointer[0]>>>0,
        cpu.cr[2]>>>0,get32(a),...Array.from(mem.slice(STACK-32,STACK))];
    const raw_state=()=>[cpu.flags[0]>>>0,cpu.flags_changed[0]>>>0,
        words[112>>2]>>>0,words[104>>2]>>>0,words[96>>2]>>>0];
    const seeds=[];
    for(const lo of [0,1,0xFFFFFFFF,0x80000000,0x7FFFFFFF,0xFFFF,0x8000,0xFF,0x80])
        for(const source of [0,1,2,0xFFFFFFFF,0x80000000,0x7FFFFFFF,0xFFFF,0x8000,0x80])seeds.push([lo,lo&1?0xFFFFFFFF:0,source]);
    seeds.push([0,0x80000000,0xFFFFFFFF],[0,0x80000000,1],[0,1,1],[0xFFFFFFFF,0x7FFFFFFF,0xFFFFFFFF],
        [0xFF80,0,0xFF],[0x8000,0,0xFF],[0,0x8000,0xFFFF],[0,0x7FFF,0xFFFF],[0xFFFF,0xFFFF,2]);
    let random=0x92837211;for(let n=0;n<32;n++){
        const next=()=>{random^=random<<13;random^=random>>>17;random^=random<<5;return random>>>0;};seeds.push([next(),next(),next()]);
    }
    let success=0,de=0,native=0;
    for(let i=0;i<cases.length;i++) for(const [s,seed] of seeds.entries()) for(const opt of [0,1]) {
        reset(i,seed,ADDRESS,true);
        const expected=reference(cases[i],Array.from(cpu.reg32,x=>x>>>0),e.get_eflags()>>>0,words[104>>2],get32(ADDRESS));
        instances[i][opt].exports.f(0);const actual=state(),actual_raw=raw_state();
        if(expected){assert.deepEqual(actual.slice(0,10),expected,`BigInt multiply/divide ${i}/${s}/${opt}`);assert.equal(actual[10],PC+cases[i][0].length);assert.equal(words[664>>2],101);assert.equal(div_faults,0);success++;}
        else {assert.equal(actual[10],HANDLER);assert.equal(words[664>>2],100);assert.equal(div_faults,1);de++;}
        if(cases[i][4]>=8){assert.equal(reads,0);native++;}
        reset(i,seed,ADDRESS,true);e.ir_test_step();
        assert.deepEqual(actual,state(),`CPU multiply/divide ${i}/${s}/${opt}`);
        if(expected)assert.deepEqual(actual_raw,raw_state(),`raw multiply/divide backing ${i}/${s}/${opt}`);
    }
    console.log(`PASS: ${success} native multiply/divide successes, ${de} single #DE deliveries, ${native} warm source reads; BigInt and exact CPU oracles`);
    const observe=(kind,a)=>events.push({kind,a,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});
    cpu.io.mmap_register(0xA0000,0x20000,a=>{observe("r8",a);return 0;},()=>assert.fail("multiply/divide wrote device"),
        a=>{observe("r32",a);return 0;},()=>assert.fail("multiply/divide wrote device"));
    let access_faults=0,devices=0,lazy=0;
    for(let i=0;i<cases.length;i++) if(cases[i][4]>=8) for(const opt of [0,1]) {
        for(const fault of ["missing","segment",...(cases[i][2]>8?["cross"]:[])]) {
            const address=fault==="cross"?0x300FFF:ADDRESS,seed=[0xF,0x80000000,0];
            reset(i,seed,address,false,fault,true);instances[i][opt].exports.f(0);const actual=state(address);
            assert.equal(actual[10],HANDLER);assert.equal(words[664>>2],100);assert.equal(div_faults,0,"source fault precedes division fault");
            reset(i,seed,address,false,fault,true);e.ir_test_step();assert.deepEqual(actual,state(address));access_faults++;
        }
        const seed=[0xF,0,0];reset(i,seed,ADDRESS,false,"device",true);instances[i][opt].exports.f(0);const actual=state(),observed=events.slice();
        assert(observed.length>0);reset(i,seed,ADDRESS,false,"device",true);e.ir_test_step();assert.deepEqual(actual,state());assert.deepEqual(observed,events);devices++;
        reset(i,[0x800F,0xFFFF,0xFFFF],ADDRESS,false,"",true);instances[i][opt].exports.f(0);const lazy_state=state();
        reset(i,[0x800F,0xFFFF,0xFFFF],ADDRESS,false,"",true);e.ir_test_step();assert.deepEqual(lazy_state,state());lazy++;
    }
    console.log(`PASS: ${access_faults} source #PF/#GP precedence cases, ${devices} MMIO reads, ${lazy} lazy-FLAGS paths`);
    let privileged=0;
    for(const kind of [6,7]) for(const width of [8,16,32]) for(const opt of [0,1]) for(const cs of [0,0x10000]) {
        const i=cases.findIndex(c=>c[1]&&c[2]===width&&c[3]===kind&&c[4]===1);
        const configure=()=>{
            reset(i,[0,0x80000000,0]);cpu.reg32[4]=0x310040;
            for(const [index,low,high] of [[0,0,0],[1,0xFFFF,0x00CF9A00],[2,0xFFFF,0x00CF9200],
                [3,0xFFFF,0x00CFFA00|cs>>16],[4,0xFFFF,0x00CFF200],[5,0x40000067,0x00008900]]) {
                set32(0x3000+index*8,low);set32(0x3004+index*8,high);
            }
            cpu.gdtr_offset[0]=0x3000;cpu.gdtr_size[0]=47;
            cpu.segment_offsets[6]=0x4000;cpu.segment_limits[6]=0x67;cpu.sreg[6]=0x28;cpu.tss_size_32[0]=1;
            set32(0x4004,STACK);set32(0x4008,16);
            cpu.sreg.set([0x23,0x1B,0x23,0x23,0x23,0x23]);
            cpu.segment_access_bytes.set([0xF3,0xFB,0xF3,0xF3,0xF3,0xF3]);words[612>>2]=3;
            cpu.segment_offsets[1]=cs;cpu.instruction_pointer[0]=PC+cs;mem.set(cases[i][0],PC+cs);
            set32(0x12000,0x13007);set32(0x13000+((PC+cs)>>>12)*4,(PC+cs)|7);
            e.full_clear_tlb();e.update_state_flags();
        };
        configure();instances[i][opt].exports.f(0);const actual=state();
        assert.equal(actual[10],HANDLER);assert.equal(div_faults,1);assert.equal(words[664>>2],100);
        assert.equal(cpu.reg32[4],STACK-20);assert.equal(get32(STACK-8),0x310040);assert.equal(get32(STACK-20),PC,"#DE saved logical fault EIP");
        configure();e.ir_test_step();assert.deepEqual(actual,state());privileged++;
    }
    console.log(`PASS: ${privileged} ring3 #DE deliveries through a TSS, with CS-relative fault frames`);
    let prefixes=0;
    for(const opt of [0,1]) {
        const instance=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-multiply/prelude-${opt}.wasm`)),{e:imports});
        const i=cases.findIndex(c=>c[1]&&c[2]===32&&c[3]===7&&c[4]===1);
        for(const seed of seeds) {
            const configure=()=>{reset(i,seed);mem.set([0x45,0xF7,0xF9],PC);};
            configure();instance.exports.f(0);const actual=state();
            assert.equal(words[664>>2],actual[10]===HANDLER?101:102);
            configure();e.ir_test_step();e.ir_test_step();assert.deepEqual(actual,state());prefixes++;
        }
    }
    console.log(`PASS: ${prefixes} completed-prefix accounting and divide fault snapshots`);

    let wide=0;
    const samples=[[0x9ABCDEF0,0x12345678,0x76543210,0xFEDCBA98],[0xFFFFFFFF,0xFFFFFFFF,1,0],[0,0x80000000,0xFFFFFFFF,0x7FFFFFFF]];
    const pair=(s,i)=>BigInt(s[i])|BigInt(s[i+1])<<32n,mask=(1n<<64n)-1n;
    for(const opt of [0,1]) for(const sample of samples) {
        const m=new WebAssembly.Memory({initial:64}),s=new Uint32Array(m.buffer);s.set(sample);s[4]=3;s[8]=2;
        const x=pair(s,0),y=pair(s,2);
        const loop=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-multiply/wide-loop-${opt}.wasm`)),{e:{m}});
        loop.exports.f(0);assert.deepEqual([pair(s,0),pair(s,2),pair(s,4),pair(s,6)],[y,(x+y)&mask,(x*y)&mask,(y-x)&mask]);wide++;
        s.fill(0);s.set(sample);s[8]=2;
        let calls=0;
        const helper=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(`build/ir-multiply/wide-helper-${opt}.wasm`)),{e:{m,wide_operation:(a,b)=>{
            calls++;assert.equal(BigInt.asUintN(64,a),x);assert.equal(b,BigInt(sample[2]|0));return [0,a+b,0x89ABCDEF,a*b];
        }}});
        helper.exports.f(0);const b=BigInt(sample[2]|0);
        assert.equal(pair(s,0),(x+b)&mask);assert.equal(s[2],0x89ABCDEF);assert.equal(pair(s,3),(x*b)&mask);assert.equal(calls,1);wide++;
    }
    console.log(`PASS: ${wide} i64 loop phi-copy and mixed-width helper ABI executions`);

} finally {await vm.destroy();}
