import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SOURCE=0x310000,DEST=0x330000,PC=0x8000,STACK=0x90000,HANDLER=0x180000;
const source=k=>[0,1,3,6].includes(k),destination=k=>k!==3&&k!==6;
const input=c=>c.kind===5,output=c=>c.kind===6;
const encode=c=>{const b=[];if(c.width!==1&&c.mode===(c.width===2))b.push(0x66);if(c.mode!==c.asize)b.push(0x67);if(c.seg!==3)b.push([0x26,0x2E,0x36,0x3E,0x64,0x65][c.seg]);b.push(c.repne?0xF2:0xF3);b.push([0xA4,0xA6,0xAA,0xAC,0xAE,0x6C,0x6E][c.kind]+Number(c.width!==1));return b;};
export async function boot(path){
    const vm=new V86({wasm_path:path,memory_size:32<<20,bios:{buffer:Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},disable_keyboard:true,disable_mouse:true,disable_speaker:true,net_device:{type:"none"},autostart:false});
    await new Promise(r=>vm.add_listener("emulator-loaded",r));const cpu=vm.v86.cpu,e=cpu.wm.exports,mem=cpu.mem8,words=new Uint32Array(e.memory.buffer),v=new DataView(mem.buffer,mem.byteOffset),set32=(a,n)=>v.setUint32(a,n,true),get32=a=>v.getUint32(a,true);
    vm.run();const until=performance.now()+10000;while(v.getUint16(0x500,true)!==0xCAFE){assert(performance.now()<until);await sleep(1);} await vm.stop();
    const cr0=cpu.cr[0];let events=[],from,to,windows=[],on_event,active;
    function observe(kind,a,width,value){events.push({kind,a,width,value,regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,ip:cpu.instruction_pointer[0]>>>0});on_event?.();}
    cpu.io.register_read(0x500,null,()=>{observe("in",0x500,1);return 0xEF;},()=>{observe("in",0x500,2);return 0xCDEF;},()=>{observe("in",0x500,4);return 0x89ABCDEF|0;});
    cpu.io.register_write(0x500,null,n=>observe("out",0x500,1,n),n=>observe("out",0x500,2,n),n=>observe("out",0x500,4,n>>>0));
    const physical=a=>(a>=0xA1000?(to&~4095):(from&~4095))+(a&4095);
    cpu.io.mmap_register(0xA0000,0x4000,a=>{observe("read",a,1);return mem[physical(a)];},(a,n)=>{observe("write",a,1,n);mem[physical(a)]=n;},a=>{observe("read",a,4);return get32(physical(a))|0;},(a,n)=>{observe("write",a,4,n>>>0);set32(physical(a),n);});
    function reset(c){active=c;on_event=undefined;e.ir_test_set_cr0(cr0|0x10000);cpu.cr[2]=0xBADF000;
        cpu.segment_offsets.set([DEST,c.seg===1?SOURCE:0,0,SOURCE,SOURCE,SOURCE]);cpu.segment_is_null.fill(0,0,6);cpu.segment_limits.fill(0xFFFFFFFF,0,6);cpu.sreg.set([16,8,16,16,16,16]);cpu.segment_access_bytes.set([0x93,0x9B,0x93,0x93,0x93,0x93]);cpu.stack_size_32[0]=1;cpu.is_32[0]=+c.mode;words[612>>2]=0;
        const si=c.si??0x40,di=c.di??0x80;cpu.reg32.set([0x55555555,c.asize?c.count:0xAAAA0000|c.count&65535,0xBEEF0500,0x12345678,STACK,0xABCDDCBA,c.asize?si:0xBBBB0000|si&65535,c.asize?di:0xCCCC0000|di&65535]);
        cpu.flags[0]=0x8D7|c.df<<10;cpu.flags_changed[0]=0;words[104>>2]=0x76543210;cpu.in_hlt[0]=0;words[664>>2]=100;
        cpu.idtr_offset[0]=0x2000;cpu.idtr_size[0]=0x7FF;const handler=c.handler??HANDLER;for(const vector of [13,14]){set32(0x2000+vector*8,8<<16|handler&65535);set32(0x2004+vector*8,handler&0xFFFF0000|0x8E00);}
        set32(0x12000,0x13003);set32(0x13000+8*4,0x8003);for(let p=0x310;p<=0x350;p++)set32(0x13000+p*4,p*4096|3);
        from=(cpu.segment_offsets[c.seg]+(c.asize?si:si&65535))>>>0;to=DEST+(c.asize?di:di&65535);mem.fill(0x55,SOURCE,SOURCE+0x11000);mem.fill(c.repne?0x66:0x55,DEST,DEST+0x11000);mem.fill(0xCC,STACK-96,STACK+16);
        const bytes=encode(c);cpu.instruction_pointer[0]=PC+cpu.segment_offsets[1];mem.set(bytes,cpu.instruction_pointer[0]);windows=[[SOURCE,0x11000],[DEST,0x11000],[STACK-96,112]];e.full_clear_tlb();e.update_state_flags();events=[];
    }
    function step(){e.ir_test_step();}
    function batch(limit){const ip=cpu.instruction_pointer[0]>>>0;words[560>>2]=ip;cpu.instruction_pointer[0]=ip+encode(active).length;const packed=e.ir_test_rep_batch(active.kind,active.width,active.asize,active.seg,active.repne,limit);return {outcome:Number(packed&0xFFFFFFFFn),iterations:Number(packed>>32n)};}
    const state=()=>({regs:Array.from(cpu.reg32,x=>x>>>0),flags:e.get_eflags()>>>0,last:words[104>>2],ip:cpu.instruction_pointer[0]>>>0,cr2:cpu.cr[2]>>>0,cpl:words[612>>2]&255,mode:cpu.is_32[0],ss32:cpu.stack_size_32[0],base:Array.from(cpu.segment_offsets.slice(0,6),x=>x>>>0),count:words[664>>2],sreg:Array.from(cpu.sreg.slice(0,6)),data:windows.map(([a,n])=>Buffer.from(mem.slice(a,a+n)))});
    return {vm,cpu,e,mem,words,set32,set16:(a,n)=>v.setUint16(a,n,true),window:(a,n)=>windows.push([a,n]),state,reset,step,batch,events:()=>events,addresses:()=>[from,to],onEvent:f=>{on_event=f;}};
}

export { SOURCE, DEST, PC, STACK, HANDLER, source, destination, encode };
