#!/usr/bin/env node
// One genuine 32->64 guest, independently executed by QEMU TCG and v86.
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawn, spawnSync} from "node:child_process";
import {setImmediate as yield_event, setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../",import.meta.url));
const dir=root+"build/x64-integer/";fs.mkdirSync(dir,{recursive:true});
const tests=[];
const registers={8:["r8b","r9b"],16:["r8w","r9w"],32:["r8d","r9d"],64:["r8","r9"]};
const vals=[0n,1n,0x7Fn,0x80n,0x7FFFn,0x8000n,0x7FFFFFFFn,0x80000000n,0x1234567887654321n,0x7FFFFFFFFFFFFFFFn,0x8000000000000000n,0xFFFFFFFFFFFFFFFFn];
function add(code,mask=0x8D5,a=0x87654321FEDCBA98n,b=0x1234567889ABCDEFn,flags=0x8D7){tests.push({code,mask,a,b,flags});}
for(const w of [8,16,32,64]) for(const [op,mask] of [["add",0x8D5],["adc",0x8D5],["sub",0x8D5],["sbb",0x8D5],["and",0x8C5],["or",0x8C5],["xor",0x8C5],["cmp",0x8D5],["test",0x8C5]])
{
    const [a,b]=registers[w];for(let i=0;i<vals.length;i++) for(const carry of [0,1])add(`${op} ${a}, ${b}`,mask,vals[i],vals[(i*5+1)%vals.length],0x802|carry);
}
for(const w of [8,16,32,64]) for(const op of ["rol","ror","rcl","rcr","shl","shr","sar"])
{
    const [a]=registers[w];for(const count of [0,1,2,7,8,15,16,31,32,63,64,255])
    {
        const c=count&(w===64?63:31);const rotate=["rol","ror","rcl","rcr"].includes(op);
        let mask=c===0?0x8D5:rotate?1:0xC4|(c<=w?1:0);if(c===1)mask|=0x800;
        add(`${op} ${a}, ${count}`,mask);
    }
}
for(const w of [8,16,32,64])
{
    const [a,b]=registers[w];for(const op of ["xchg","xadd","cmpxchg"])add(`${op} ${a}, ${b}`,op==="xchg"?0x8D5:0x8D5);
    add(`xadd ${a}, ${a}`);add(`inc ${a}`);add(`dec ${a}`);add(`neg ${a}`);add(`not ${a}`);
}
for(const w of [16,32,64])
{
    const [a,b]=registers[w];for(const op of ["imul","bsf","bsr","popcnt"])
        add(`${op} ${a}, ${b}`,op==="imul"?0x801:op==="popcnt"?0x8D5:0x40);
    for(const op of ["shld","shrd"]) for(const count of [0,1,2,7,15])add(`${op} ${a}, ${b}, ${count}`,count===0?0x8D5:count===1?0x8C5:0xC5);
    for(const op of ["bt","bts","btr","btc"]) for(const index of [0,3,15,31,63])add(`${op} ${a}, ${index}`,1);
    if(w!==32)add(`push ${a}\npop ${b}`);add(`mov ${a}, ${b}`);add(`cmovz ${a}, ${b}`);add(`cmovnz ${a}, ${b}`);
}
for(const op of ["mul","imul","div","idiv"]) for(const w of [16,32,64])
{
    const [a]=registers[w];add(`xor edx, edx\nmov eax, 123\n${op} ${a}`,op==="mul"||op==="imul"?0x801:0,7n);
}
for(const w of [16,32,64])
{
    const [operand,other]=registers[w];
    for(const a of [3n,0xFFFFFFFFFFFFFFFFn,0x8000000000000000n])
    {
        add(`mov rax, -1\nmul ${operand}`,0x801,a);
        add(`mov rax, -17\nimul ${operand}`,0x801,a);
        add(`imul ${operand}, ${other}`,0x801,a,0xFFFFFFFFFFFFFFFFn);
    }
    add(`mov rax, -123\nmov rdx, -1\nidiv ${operand}`,0,7n);
    add(`mov rax, 1\nmov edx, 1\ndiv ${operand}`,0,7n);
}
add("mov r8, 0x1122334455667788\nmov r8d, 0xFFEEDDCC");
add("mov r8, 0x1122334455667788\nmov r8w, 0xAA55");
add("mov r8, 0x1122334455667788\nmov r8b, 0xAA");
add("mov rax, 0x1122334455667788\nmov ah, 0xAB");
add("mov rax, 0x1122334455667788\nmov al, 0xAB");
add("bswap r8");add("bswap r8d");
add("xadd ah, al");add("xadd ah, ah");add("xchg ah, al");add("cmpxchg ah, bl");
add("mov r8, 0x1111222233334444\nmov r9, 0xAABBCCDD00400000\nmov r8, [r9d]");
add("mov r8, 0x400000\nlea r9, [r8+r8*4-37]");
add("lea r8, [rel high_mode]");
add("mov r8, 0xFFFFFFFA00000080\nmovsx r9, r8b");
add("mov r8, 0xFFFFFFFA00008000\nmovsx r9, r8w");
add("mov r8, 0xFFFFFFFA80000000\nmovsxd r9, r8d");
add("enter 32, 0\nleave");
add("call .return_test\njmp .return_done\n.return_test: mov r8, 0x1234567890ABCDEF\nret\n.return_done:");
add("mov rax, 0x8899AABBCCDDEEFF\nmov rdx, 0x1020304050607080\nlock cmpxchg16b [rsi]",0x40);
add("xor eax, eax\nxor edx, edx\nlock cmpxchg16b [rsi]",0x40);
add("mov eax, 0xCCDDEEFF\nmov edx, 0x8899AABB\nlock cmpxchg8b [rsi]",0x40);
add("xor eax, eax\nxor edx, edx\nlock cmpxchg8b [rsi]",0x40);
add("mov r8, -1\nlock xadd [rsi], r8");
add("xchg [rsi], r8");
add("mov rax, 0x8899AABBCCDDEEFF\nlock cmpxchg [rsi], r8");
add("xor eax, eax\nlock cmpxchg [rsi], r8");
add("mov r9, -1\nbts qword [rsi+8], r9",1);
add("mov rcx, 2\nmov rsi, 0x400000\nmov rdi, 0x400010\nrep movsq\nmov rsi, 0x400010\nmov r8, [rsi]\nmov r9, [rsi+8]");
add("mov rcx, 2\nmov rsi, 0x400008\nmov rdi, 0x400018\nstd\nrep movsq\nmov r8, [0x400010]\nmov r9, [0x400018]",0xCD5);
add("mov rcx, 0x1234567800000002\nmov rsi, 0x9999999900400000\nmov rdi, 0xAAAAAAAA00400010\na32 rep movsq\nmov r8, [0x400010]\nmov r9, [0x400018]");
add("mov rcx, 0\nmov rsi, 0xDEADBEEF00000000\nmov rdi, rsi\nrep movsq");
add("mov rcx, 2\nmov rdi, 0x400000\nrep stosq");
add("mov rcx, 2\nmov rsi, 0x400000\nrep lodsq");
add("mov rax, 0x8899AABBCCDDEEFF\nmov rcx, 2\nmov rdi, 0x400000\nrepe scasq");
add("mov rax, 0\nmov rcx, 2\nmov rdi, 0x400000\nrepne scasq");
add("mov rcx, 2\nmov rsi, 0x400000\nmov rdi, 0x400008\nrepe cmpsq");
for(const [name,index] of [["fs",0xC0000100],["gs",0xC0000101]])
{
    add(`mov ecx, ${index}\nmov eax, 0x400000\nmov edx, 0xFFFF8000\nwrmsr\nmov r8, [${name}:0]\nmov r9, [${name}:8]\nxor eax, eax\nxor edx, edx\nwrmsr`);
}
for(const [n,cc] of ["o","no","b","ae","e","ne","be","a","s","ns","p","np","l","ge","le","g"].entries())
{
    for(const flags of [2,0x8D7])
    {
        const label=`cc_${n}_${flags}`;
        add(`mov r8, 0\nj${cc} ${label}\nmov r8, 1\n${label}:`,0x8D5,1n,2n,flags);
        add(`cmov${cc} r8, r9`,0x8D5,1n,2n,flags);
        add(`set${cc} r8b`,0x8D5,0xFFFFFFFFFFFFFFFFn,2n,flags);
    }
}
for(const opcode of ["loop","loope","loopne","jrcxz"])
{
    for(const count of [0,1,2])
    {
        const label=`loop_${opcode}_${count}`;
        add(`mov ecx, ${count}\nmov r8, 0\n${opcode} ${label}\nmov r8, 1\n${label}:`);
    }
}
add("db 0x48,0x66,0x89,0xC8");
add("db 0x66,0x48,0x89,0xC8");
add("db 0x48,0x40,0x89,0xC8");
// Cache hints must consume the full encoding without touching mapped or
// noncanonical operands; MOVNTI retains ordinary stores' architectural value.
add("movnti [rsi], r8d");
add("movnti [rsi], r8");
for(const hint of ["prefetcht0", "prefetcht1", "prefetcht2", "prefetchnta", "prefetchw"])
    add(`mov rax, 0x1234567800000000\n${hint} [rax+0x12345678]`);
for(const width of ["r8w", "r8d", "r8"])
    add(`rdrand ${width}\nmov r8, 0`);
add("db 0xF3,0x0F,0x1E,0xFA"); // ENDBR64 is NOP when CET is absent.
add("db 0xF3,0x0F,0x1E,0xFB"); // ENDBR32 is also NOP in this profile.
const RESULT=0x300000,RECORD=72,MAGIC=0xC064C064;
// With a JIT, every case runs again after its pages are hot, so the last
// passes execute compiled code (cases are idempotent).
const REPEAT=Number(process.env.X64_REPEAT||10);
let body="";
for(let n=0;n<tests.length;n++)
{
    const t=tests[n];body+=`\nmov dword [${RESULT+4}], ${n}\n; case ${n}: ${t.code.replaceAll("\n"," / ")}\nmov rsi, 0x400000\nmov rax, 0x8899AABBCCDDEEFF\nmov [rsi], rax\nmov rax, 0x1020304050607080\nmov [rsi+8], rax\nmov rax, 0x1234567890ABCDEF\nmov rdx, 0x234567890ABCDEF1\nmov rbx, 0x34567890ABCDEF12\nmov rcx, 0x4567890ABCDEF123\nmov r8, 0x${t.a.toString(16)}\nmov r9, 0x${t.b.toString(16)}\npush ${t.flags}\npopfq\n${t.code}\npushfq\npop r10\nmov rdi, ${RESULT+8+n*RECORD}\nmov [rdi], r8\nmov [rdi+8], r9\nmov [rdi+16], rax\nmov [rdi+24], rdx\nmov [rdi+32], rbx\nmov [rdi+40], rcx\nmov [rdi+48], r10\nmov rsi, 0x400000\nmov r10, [rsi]\nmov [rdi+56], r10\nmov r10, [rsi+8]\nmov [rdi+64], r10\n`;
}
const source=`bits 32
org 0x100000
header:
dd 0x1BADB002, 0x10000, -(0x1BADB002+0x10000)
dd header, header, image_end, image_end, start
start:
cli
cld
lgdt [gdtr]
jmp 8:protected
protected:
mov ax, 16
mov ds, ax
mov es, ax
mov ss, ax
mov esp, 0x3F0000
mov dword [0x200000], 0x201003
mov dword [0x200800], 0x201003
mov dword [0x201000], 0x202003
mov edi, 0x202000
mov eax, 0x83
mov ecx, 512
.pages:
mov [edi], eax
add eax, 0x200000
add edi, 8
loop .pages
mov eax, cr4
or eax, 0x20
mov cr4, eax
mov eax, 0x200000
mov cr3, eax
mov ecx, 0xC0000080
rdmsr
or eax, 0x100
wrmsr
mov eax, cr0
or eax, 0x80010001
mov cr0, eax
jmp 24:long_mode
bits 64
long_mode:
mov rax, 0xFFFF800000000000+high_mode
jmp rax
high_mode:
${process.env.X64_JIT ? `mov r12, 1000000\n.warm: add r8, r9\ndec r12\njnz .warm\nmov dword [0x2FFFF0], ${REPEAT}\ncase_repeat:\n` : ""}
${body}
${process.env.X64_JIT ? "dec dword [0x2FFFF0]\njnz case_repeat\n" : ""}
mov dword [${RESULT}], ${MAGIC}
hlt
jmp $
align 8
gdt:
dq 0, 0x00CF9A000000FFFF, 0x00CF92000000FFFF, 0x00AF9A000000FFFF
gdtr: dw 31
dd gdt
image_end:
`;
fs.writeFileSync(dir+"guest.asm",source);fs.writeFileSync(dir+"cases.json",JSON.stringify(tests,(_key,v)=>typeof v==="bigint"?v.toString():v,null,2));
const assembled=spawnSync("nasm",["-f","bin","-o",dir+"guest.bin",dir+"guest.asm"],{encoding:"utf8"});assert.equal(assembled.status,0,assembled.stderr);
assert.ok(fs.statSync(dir+"guest.bin").size<0xF0000,"fixture does not overlap page tables");
async function qemu_oracle()
{
    const q=spawn("qemu-system-x86_64",["-machine","pc,accel=tcg","-cpu","max","-m","32M","-display","none","-serial","none","-monitor","none","-qmp","stdio","-no-reboot","-no-shutdown","-kernel",dir+"guest.bin"],{stdio:["pipe","pipe","pipe"]});
    let input="",error="",id=0;const pending=new Map();q.stderr.on("data",d=>error+=d);
    q.stdout.on("data",d=>{input+=d;while(input.includes("\n")){const end=input.indexOf("\n");const line=input.slice(0,end);input=input.slice(end+1);let msg;try {msg=JSON.parse(line);} catch{continue;} if(msg.id!==undefined){const fn=pending.get(msg.id);pending.delete(msg.id);fn?.(msg);}}});
    const request=(execute,args={})=>new Promise((resolve,reject)=>{const n=id++;pending.set(n,msg=>msg.error?reject(new Error(JSON.stringify(msg.error))):resolve(msg.return));q.stdin.write(JSON.stringify({execute,arguments:args,id:n})+"\n");});
    try
    {
        await request("qmp_capabilities");const deadline=performance.now()+20000;let seen=false;
        while(performance.now()<deadline){const value=await request("human-monitor-command",{"command-line":`xp /1wx ${RESULT}`});if(value.includes(MAGIC.toString(16))){seen=true;break;} await delay(50);}
        assert.ok(seen,"QEMU guest timed out: "+error);
        await request("stop");await request("human-monitor-command",{"command-line":`pmemsave ${RESULT+8} ${tests.length*RECORD} "${dir}qemu.bin"`});await request("quit");
    }
    finally {q.kill();}
    return fs.readFileSync(dir+"qemu.bin");
}
const oracle=await qemu_oracle();assert.equal(oracle.length,tests.length*RECORD);
console.log(`QEMU TCG: ${tests.length} integer/flags/aliases/atomic64/CX16 cases, high RIP reached`);
if(process.env.X64_ORACLE_ONLY)process.exit(0);
const {V86}=await import(+process.env.TEST_RELEASE_BUILD?"../../build/libv86.mjs":"../../src/main.js");
const emulator=new V86({graphics_adapter: "bochs_vga", multiboot:{url:dir+"guest.bin"},memory_size:32<<20,acpi:true,cpu_cores:Number(process.env.X64_CORES||1),disable_jit:!process.env.X64_JIT,experimental_smp_jit:true,ir_sync_publication:true,autostart:false,log_level:0});
try
{
    await new Promise(resolve=>emulator.add_listener("emulator-loaded",resolve));const cpu=emulator.v86.cpu;
    const view=()=>new DataView(cpu.mem8.buffer,cpu.mem8.byteOffset);const deadline=performance.now()+30000;let rounds=0;
    while(view().getUint32(RESULT,true)!==MAGIC){if(performance.now()>deadline) throw new Error("v86 guest stalled at case "+view().getUint32(RESULT+4,true)+": "+JSON.stringify(cpu.get_diagnostics()));try {cpu.run_cores();} catch(error) {console.error("guest failure",JSON.stringify(cpu.get_diagnostics()),"case",view().getUint32(RESULT+4,true));throw error;} if(process.env.X64_JIT || (++rounds&255)===0) await yield_event();}
    fs.writeFileSync(dir+"v86.bin",cpu.mem8.slice(RESULT+8,RESULT+8+tests.length*RECORD));const expected=new DataView(oracle.buffer,oracle.byteOffset);
    for(let n=0;n<tests.length;n++) for(let field=0;field<9;field++)
    {
        const at=n*RECORD+field*8;const mask=field===6?BigInt(tests[n].mask):0xFFFFFFFFFFFFFFFFn;
        assert.equal(view().getBigUint64(RESULT+8+at,true)&mask,expected.getBigUint64(at,true)&mask,`case ${n} field ${["r8","r9","rax","rdx","rbx","rcx","flags","mem0","mem8"][field]}: ${tests[n].code}`);
    }
    if(process.env.X64_JIT)
    {
        const stat=n=>cpu.wm.exports.x64_page_stat(n);
        const count=stat(1);
        assert.ok(count>tests.length*4,`page functions actually retired instructions; compiled=${stat(0)}, retries=${stat(2)}, steps=${stat(4)}`);
        console.log(`page tier: retired=${count} compiled=${stat(0)} retries=${stat(2)} unknown=${stat(3)} steps=${stat(4)} templated=${stat(10)}/${stat(9)}`);
    }
    console.log(`PASS: v86 agrees with independent QEMU on ${tests.length} integer guest cases`);
}
finally {await emulator.destroy();}
