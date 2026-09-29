#!/usr/bin/env node
// Independent XP reference. The supplied converted disk is opened by QEMU's
// temporary snapshot layer. Only a new disposable FAT tool disk is writable.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {read_fat16} from "./disk_fixture.mjs";
const [disk, tools] = process.argv.slice(2);
assert.ok(disk && tools, "usage: windows_reference.mjs converted-xp.img tools.img");
const directory = path.resolve(process.env.XP_QEMU_DIR || "build/c3-xp-qemu");
fs.mkdirSync(directory, {recursive:true});
const auxiliary = path.join(directory,"tools.img");
fs.copyFileSync(tools,auxiliary,fs.constants.COPYFILE_EXCL);
const stat = fs.statSync(disk);
const args = ["-machine","pc,accel=tcg","-cpu","pentium3","-smp","4","-m","512",
    "-drive",`file=${path.resolve(disk)},format=raw,if=ide,index=0,snapshot=on`,
    "-drive",`file=${auxiliary},format=raw,if=ide,index=1`,
    "-device","ne2k_pci","-vga","std","-display","none","-serial","none","-monitor","none","-qmp","stdio","-no-reboot"];
const child=spawn("qemu-system-i386",args,{stdio:["pipe","pipe","pipe"]});
let buffer="",stderr="",id=0;
const pending=new Map();
child.stderr.on("data",data=>stderr+=data);
child.stdout.on("data",data=>{
    buffer+=data;
    while(buffer.includes("\n"))
    {
        const end=buffer.indexOf("\n"),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        let value;try {value=JSON.parse(line);} catch{continue;}
        if(value.id!==undefined){pending.get(value.id)?.(value);pending.delete(value.id);}
    }
});
const request=(execute,args={})=>new Promise((resolve,reject)=>{
    const n=id++;pending.set(n,value=>value.error?reject(new Error(JSON.stringify(value.error))):resolve(value.return));
    child.stdin.write(JSON.stringify({execute,arguments:args,id:n})+"\n");
});
const monitor=(command,cpu_index=0)=>request("human-monitor-command",{"command-line":command,"cpu-index":cpu_index});
const qcode={" ":"spc", ".":"dot", "/":"slash", "\\":"backslash", "-":"minus", ":":"shift-semicolon", "%":"shift-5", "(":"shift-9", ")":"shift-0", "@":"shift-2"};
async function keys(names)
{
    const event = (key,down)=>({type:"key",data:{down,key:{type:"qcode",data:key}}});
    await request("input-send-event",{events:names.map(key=>event(key,true))});
    await delay(50);
    await request("input-send-event",{events:names.toReversed().map(key=>event(key,false))});
    await delay(50);
}
async function command(text)
{
    console.log("QEMU guest command: "+text);
    await keys(["meta_l","r"]);await delay(1000);
    for(const ch of text.toLowerCase()) await keys((qcode[ch] || ch).split("-"));
    await keys(["ret"]);
}
const report={disk:path.resolve(disk),args,version:spawnSync("qemu-system-i386",["--version"],{encoding:"utf8"}).stdout,observations:[],result:null};
try
{
    await request("qmp_capabilities");
    const started=performance.now(),limit=+(process.env.XP_QEMU_MS || 180000);
    let next_command=135000,next_sample=0;
    while(performance.now()-started<limit)
    {
        const ms=Math.round(performance.now()-started);
        const bytes=read_fat16(fs.readFileSync(auxiliary),"RESULT.TXT");
        if(bytes)
        {
            const value=Buffer.from(bytes).toString("ascii");
            report.probe=value;
            if(value.includes("C3_XP_DONE processors=4")){report.result=value;console.log(value);break;}
        }
        if(ms>=next_sample)
        {
            const registers=[];
            for(let n=0;n<4;n++)registers.push(await monitor("info registers",n));
            report.observations.push({ms,registers});
            await request("screendump",{filename:path.join(directory,`screen-${ms}.ppm`)});
            fs.writeFileSync(path.join(directory,"qualification.json"),JSON.stringify(report,null,2)+"\n");
            console.log(`QEMU progress ${ms} ms: ${registers.map(v=>v.match(/EIP=([\da-f]+)/i)?.[1]).join(",")}`);
            next_sample+=30000;
        }
        if(ms>=next_command){await command("cmd /c for %d in (d e f g h) do @if exist %d:\\c3probe.exe %d:\\c3probe.exe");next_command+=45000;}
        await delay(1000);
    }
    await request("screendump",{filename:path.join(directory,"screen-final.ppm")});
    await request("stop");
    await monitor(`pmemsave 0x562EC0 20 "${path.join(directory,"bugcheck.bin")}"`);
    if(!report.result || !/C3_XP_DONE processors=4 progress=512 failures=0 checks=128,128,128,128/.test(report.result))process.exitCode=1;
}
finally
{
    report.stderr=stderr;
    fs.writeFileSync(path.join(directory,"qualification.json"),JSON.stringify(report,null,2)+"\n");
    await request("quit").catch(()=>{});child.kill();
    const after=fs.statSync(disk);assert.equal(after.size,stat.size);assert.equal(after.mtimeMs,stat.mtimeMs,"reference input disk remained unchanged");
}
