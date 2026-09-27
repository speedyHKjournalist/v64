import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const wasm=process.argv[2]||"build/v86-ir-test.wasm";
const vm=new V86({wasm_path:wasm,memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
    await new Promise(r=>vm.add_listener("emulator-loaded",r));
    const cpu=vm.v86.cpu,e=cpu.wm.exports;
    let mem,raw,words,view;
    const refresh=()=>{mem=cpu.mem8;raw=new Uint8Array(e.memory.buffer);words=new Uint32Array(e.memory.buffer);view=new DataView(mem.buffer,mem.byteOffset);};refresh();
    const set32=(a,n)=>view.setUint32(a,n,true),set64=(a,n)=>view.setBigUint64(a,BigInt(n),true);
    vm.run();const deadline=performance.now()+10000;
    while(view.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<deadline);await sleep(1);} await vm.stop();await sleep(20);cpu.jit_clear_cache();
    let mmio=0;cpu.io.mmap_register(0xA0000,0x4000,()=>{mmio++;return 0x40;},()=>mmio++,()=>{mmio++;return 0x40404040;},()=>mmio++);
    const PC=0x100000,DATA=0x110000;
    const defaults=(linear=PC,pc=0x1000,mode=true)=>{
        refresh();cpu.in_hlt[0]=0;raw[648]=0;cpu.is_32[0]=+mode;cpu.stack_size_32[0]=1;words[612>>2]=0;
        cpu.segment_offsets.fill(0,0,6);cpu.segment_offsets[1]=(linear-pc)>>>0;cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);
        cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);
        cpu.reg32.set([0x7FFFFFFF,3,0x12345678,0x89ABCDEF,0x90000,0xFEDCBA98,DATA,0x76543210]);
        cpu.flags[0]=0x8D7;cpu.flags_changed[0]=0x8D5;words[96>>2]=31;words[104>>2]=0x7FFFFFFF;words[112>>2]=0;
        words[664>>2]=0xFFFFFFFC;words[560>>2]=0x11223344;cpu.cr[2]=0xBADF000;
        cpu.cr[0]=0x80010011|0;cpu.cr[3]=0x12000;cpu.cr[4]=512;
        set32(0x12000,0x13003);set32(0x12008,0x15003);set32(0x15000,PC|3);set32(0x15004,PC+4096|3);
        for(const p of [PC,PC+4096,DATA,DATA+4096])set32(0x13000+(p>>>12)*4,p|3);
        set32(DATA,0x1234ABCD);set32(DATA+4096,0xABCD1234);
        cpu.instruction_pointer[0]=linear;e.full_clear_tlb();e.update_state_flags();mmio=0;
    };
    const unchanged=()=>({cpu:Buffer.from(raw.slice(64,1200)),tables:Buffer.from(mem.slice(0x12000,0x1D000)),data:Buffer.from(mem.slice(DATA,DATA+8192)),
        tlb:Buffer.from(new Uint8Array(e.memory.buffer,e.ir_tlb_base(),4<<20)),mmio});
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,
        xmm:Array.from(words.slice(832>>2,960>>2)),data:view.getUint32(DATA,true)});
    const compile=(length,cfg=1,opt=1)=>{
        const before=unchanged();const id=e.ir_compile_live(length,2,opt,cfg,32,8);refresh();
        assert.deepEqual(unchanged(),before,"live compilation must not change guest state, tables, TLB, RAM or MMIO");
        return id;
    };
    const module=id=>{
        const ptr=e.ir_live_info(id,0),len=e.ir_live_info(id,1);assert(ptr&&len);
        const bytes=new Uint8Array(e.memory.buffer,ptr,len).slice();
        return {bytes,instance:new WebAssembly.Instance(new WebAssembly.Module(bytes),{e:{...e,m:e.memory}})};
    };
    const valid=id=>{const before=unchanged();const result=e.ir_live_validate(id);refresh();assert.deepEqual(unchanged(),before,"revalidation is read-only");return result;};
    let compiled=0;
    for(const mode of [false,true]) for(const cfg of [0,1]) for(const opt of [0,1]) for(const kind of [0,1,2,3,4,5]){
        if(kind===4&&!cfg) continue;
        const prefix=mode?[]:[0x67];
        const programs=[[0x40],[...prefix,0x8B,0x06],[...prefix,0x89,0x06],[0x0F,0xA2],[0x40,0x49,0x75,0xFC],[0x66,0x0F,0xEF,0xC1]];
        const code=programs[kind],linear=compiled&1?0x800000:PC,pc=compiled&2?0xFFFFFFFC:0x1000;
        defaults(linear,pc,mode);mem.set(code,PC);if(kind===3)cpu.reg32[0]=0;
        const id=compile(code.length,cfg,opt);assert(id>0n,`compile ${kind}/${mode}: ${e.ir_live_error()}`);assert.equal(valid(id),1);
        assert.equal(e.ir_live_info(id,4)>>>0,linear);assert.equal(e.ir_live_info(id,5)>>>0,pc);assert.equal(e.ir_live_info(id,6),+mode);
        assert.equal(e.ir_live_info(id,7),code.length);assert.equal(e.ir_live_info(id,2),1);assert.equal(e.ir_live_mapping(id,0,1),PC);
        const {instance}=module(id);instance.exports.f(0);refresh();const actual=state(),count=(words[664>>2]-0xFFFFFFFC)>>>0;assert(count>0&&count<=32);
        defaults(linear,pc,mode);mem.set(code,PC);if(kind===3)cpu.reg32[0]=0;
        for(let n=0;n<count;n++)e.ir_test_step();refresh();assert.deepEqual(actual,state(),`live IR ${kind}/${mode}/${cfg}/${opt}`);compiled++;
    }
    console.log(`PASS: ${wasm}: ${compiled} IR artifacts compiled inside the live CPU Wasm, read-only capture and revalidation, actual execution vs interpreter`);
    let faults=0;
    for(const mode of [false,true]) for(const cfg of [0,1]) for(const opt of [0,1]){
        const code=mode?[0x8B,0x06]:[0x67,0x8B,0x06];
        const prepare=()=>{defaults(PC,0x1000,mode);mem.set(code,PC);set32(0x13000+(DATA>>>12)*4,0);
            cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;set32(0x2000+14*8,8<<16);set32(0x2004+14*8,0x180000|0x8E00);mem.fill(0xCC,0x8FFE0,0x90000);};
        const fault_state=()=>({...state(),previous:words[560>>2],cr2:cpu.cr[2]>>>0,frame:Buffer.from(mem.slice(0x8FFE0,0x90000))});
        prepare();const id=compile(code.length,cfg,opt);assert(id);assert.equal(valid(id),1);module(id).instance.exports.f(0);refresh();const actual=fault_state();
        assert.equal(actual.ip,0x180000);assert.equal(actual.cr2,DATA);assert.equal(words[664>>2],0xFFFFFFFC);
        prepare();e.ir_test_step();refresh();assert.deepEqual(actual,fault_state());faults++;
    }
    console.log(`PASS: ${wasm}: ${faults} live-compiled data page faults preserve exact exception frames and do not retire the faulting instruction`);
    let paging=0;
    const one=(expected=PC)=>{const id=compile(1);assert(id>0n,`paging compile error ${e.ir_live_error()}`);assert.equal(e.ir_live_mapping(id,0,1),expected);assert.equal(valid(id),1);paging++;return id;};
    defaults();mem[PC]=0x40;one();
    // An existing TLB translation remains visible until the guest invalidates it.
    e.ir_memory_read(PC,1);set32(0x13000+(PC>>>12)*4,PC+4096|3);mem[PC+4096]=0x48;
    let id=one();mem[PC+4096]=0x40;e.full_clear_tlb();assert.equal(valid(id),0,"mapping identity changes even when bytes are identical");id=one(PC+4096);
    defaults();mem[PC]=0x40;cpu.cr[3]=0x12018;set32(0x12018,0x13003);one(); // Baseline CR3 low bits.
    // Supervisor and user rights, including a read-only user code page.
    defaults();mem[PC]=0x40;set32(0x12000,0x13007);set32(0x13000+(PC>>>12)*4,PC|5);words[612>>2]=3;e.update_state_flags();one();
    set32(0x12000,0x13003);assert.equal(compile(1),0n);assert.equal(e.ir_live_error(),3);
    defaults();mem[PC]=0x40;cpu.cr[0]=0x11;one();
    defaults();mem[PC]=0x40;cpu.cr[4]|=16;set32(0x12000,0x83);one(); // 4 MiB
    const pae=(huge=false)=>{
        defaults();mem[PC]=0x40;cpu.cr[4]|=32|(huge?16:0);
        new BigUint64Array(e.memory.buffer,968,4).set([0x16001n,0n,0n,0n]);
        set64(0x16000,huge?0x83:0x17003);set64(0x17000+(PC>>>12)*8,PC|3);
    };
    pae();one();pae(true);one(); // 2 MiB, following the baseline's PSE gate
    pae();cpu.cr[3]=0xA0000;one(); // Cached PDPTEs, not a new MMIO read through CR3.
    pae();set64(0x17000+(PC>>>12)*8,0x8000000000100003n);assert.equal(compile(1),0n);assert.equal(e.ir_live_error(),5);
    // Cross-page code, noncontiguous physical pages and repeated physical aliases.
    for(const alias of [false,true]){
        defaults(PC+4095,0x1FFF);mem[PC+4095]=0xB8;
        const second=alias?PC:PC+0x3000;mem.set([0x78,0x56,0x34,0x12],second);set32(0x13000+((PC+4096)>>>12)*4,second|3);
        id=compile(5);assert(id>0n);assert.equal(valid(id),1);assert.equal(e.ir_live_info(id,2),2);assert.equal(e.ir_live_info(id,3),alias?1:2);
        assert.equal(e.ir_live_mapping(id,1,1),second);module(id).instance.exports.f(0);refresh();assert.equal(cpu.reg32[0],0x12345678);
        cpu.instruction_pointer[0]=PC+4095;assert.equal(valid(id),1);vm.write_memory(Uint8Array.of(0x78),second);assert.equal(valid(id),0,"secondary-page write notification invalidates the artifact");paging++;
    }
    defaults(0xFFFFFFFF,0xFFFFFFFF);set32(0x12000+1023*4,0x18003);set32(0x18000+1023*4,PC|3);set32(0x13000,PC+0x3000|3);
    mem[PC+4095]=0xB8;mem.set([0xEF,0xBE,0xAD,0xDE],PC+0x3000);id=compile(5);assert(id);assert.equal(valid(id),1);
    assert.equal(e.ir_live_mapping(id,0,0)>>>0,0xFFFFF000);assert.equal(e.ir_live_mapping(id,1,0),0);
    module(id).instance.exports.f(0);refresh();assert.equal(cpu.reg32[0]>>>0,0xDEADBEEF);assert.equal(cpu.instruction_pointer[0],4);paging++;
    // Neither absent code nor MMIO page-table/code reads may deliver faults or callbacks.
    defaults(PC+4095,0x1FFF);mem[PC+4095]=0x40;set32(0x13000+((PC+4096)>>>12)*4,0);one();
    assert.equal(compile(2),0n);assert.equal(e.ir_live_error(),3);
    for(const where of ["directory","table","code","pae-directory","pae-table"]){
        if(where.startsWith("pae"))pae();else defaults();mem[PC]=0x40;
        if(where==="directory")cpu.cr[3]=0xA0000;
        if(where==="table")set32(0x12000,0xA0003);
        if(where==="code")set32(0x13000+(PC>>>12)*4,0xA0003);
        if(where==="pae-directory") new BigUint64Array(e.memory.buffer,968,4)[0]=0xA0001n;
        if(where==="pae-table")set64(0x16000,0xA0003);
        assert.equal(compile(1),0n,where);assert.equal(e.ir_live_error(),4,where);assert.equal(mmio,0);paging++;
    }
    console.log(`PASS: ${wasm}: ${paging} cold/warm, non-paged, user, PSE, PAE, cross-page/alias and MMIO capture cases, with exact TLB/page-table preservation`);
    defaults();mem[PC]=0x40;id=compile(1);const copy=module(id).bytes;
    mem[PC]=0x48;assert.equal(valid(id),0,"raw RAM writes are detected even without legacy notifications");mem[PC]=0x40;assert.equal(valid(id),1);
    vm.write_memory(Uint8Array.of(0x40),PC);assert.equal(valid(id),0,"notified same-byte write changes the task's dependency version");
    id=compile(1);vm.write_memory(Uint8Array.of(0x90),DATA);assert.equal(valid(id),1,"unrelated writes retain the artifact");
    const old=id;id=compile(1);assert.notEqual(id,old);assert.equal(e.ir_live_info(old,0),0);assert.equal(e.ir_live_release(old),0);assert.equal(valid(id),1);
    assert.deepEqual(copy,module(id).bytes,"owned byte copies survive replacing the live compiler result");
    cpu.is_32[0]=0;assert.equal(valid(id),0);cpu.is_32[0]=1;assert.equal(valid(id),1);
    const pending=WebAssembly.instantiate(module(id).bytes,{e:{...e,m:e.memory}});
    vm.write_memory(Uint8Array.of(0x48),PC);await pending;assert.equal(valid(id),0,"code changed while the browser instantiated the artifact");
    mem[PC]=0x40;id=compile(1);
    const cancelled=id,late=WebAssembly.instantiate(module(id).bytes,{e:{...e,m:e.memory}});
    id=compile(1);await late;assert.equal(valid(cancelled),0);assert.equal(valid(id),1);
    const saved=await vm.save_state();await vm.restore_state(saved);refresh();assert.equal(valid(id),0);assert.equal(e.ir_live_info(id,0),0);
    id=compile(1);assert(id);cpu.jit_clear_cache();assert.equal(valid(id),0);
    id=compile(1);assert(id);assert.equal(e.ir_live_release(id),1);assert.equal(e.ir_live_release(id),0);
    id=compile(1);assert(id);assert.equal(compile(1921),0n);assert.equal(e.ir_live_error(),1);assert.equal(e.ir_live_info(id,0),0);
    mem[PC]=0x0F;assert.equal(compile(1),0n);assert.equal(e.ir_live_error(),6);
    // Straight-line coalescing makes 65 NOPs legal. Preserve exact execution
    // budgets and keep a separate, genuinely over-budget CFG rejection case.
    defaults();mem.fill(0x90,PC,PC+65);id=compile(65);assert(id>0n);assert.equal(valid(id),1);
    const nop_state=state(),nop_count=words[664>>2];module(id).instance.exports.f(0);refresh();
    const nops=(words[664>>2]-nop_count)>>>0;
    // Work units include CFG dispatch as well as instruction polls.
    assert(nops>0&&nops<=32,"coalesced NOPs stop within the execution work budget");
    assert.deepEqual(state(),{...nop_state,ip:PC+nops},"budget exit preserves exact retirement and architectural state");
    defaults();const branches=Uint8Array.from({length:130},(_,i)=>i%2?0:0x75);mem.set(branches,PC);
    assert.equal(compile(branches.length),0n,"distinct conditional blocks still exceed the CFG budget");
    assert.equal(e.ir_live_error(),7);assert.equal(e.ir_live_info(id,0),0,"failed compilation discards the previous artifact");
    mem.fill(0x90,PC,PC+129);assert.equal(compile(129),0n);assert.equal(e.ir_live_error(),7,"decoded-instruction cap remains enforced");
    defaults();mem[PC]=0x40;cpu.in_hlt[0]=1;assert.equal(compile(1),0n);assert.equal(e.ir_live_error(),2);
    cpu.in_hlt[0]=0;raw[648]=1;assert.equal(compile(1),0n);assert.equal(e.ir_live_error(),2);raw[648]=0;
    assert.equal(e.ir_live_info(0xFFFFFFFFFFFFFFFFn,0),0);assert.equal(e.ir_live_release(0xFFFFFFFFFFFFFFFFn),0);
    console.log(`PASS: ${wasm}: immutable byte ownership, raw/notified/unrelated writes, mode changes, obsolete handles, restore/cache reset, release and compile failures`);
} finally {await vm.destroy();}
