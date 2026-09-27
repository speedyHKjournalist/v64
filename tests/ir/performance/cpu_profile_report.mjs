// V8 sampling complements the emitted timers; idle is kept separate.
import fs from "node:fs";
import assert from "node:assert/strict";
const profile=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const nodes=new Map(profile.nodes.map(n=>[n.id,n]));
const parents=new Map();
for(const n of profile.nodes) for(const child of n.children||[]) parents.set(child,n.id);
const own=new Map(),groups=new Map();let total=0;
for(let i=0;i<profile.samples.length;i++) {
 const id=profile.samples[i],ms=profile.timeDeltas[i]/1000;
 assert(Number.isFinite(ms)&&ms>=0);
 const stack=[];for(let at=id;at;at=parents.get(at)) stack.push(nodes.get(at).callFrame);
 const names=stack.map(f=>f.functionName).join(" ");
 const group=names.includes("(idle)")?"idle":
  /compile_lifted|compile_cpu|lower_draft|ir.*passes/.test(names)?"IR compiler":
  /jit_generate_module|jit_analyze_and_generate/.test(names)?"legacy compiler":
  stack.some(f=>f.url.startsWith("wasm:")&&!f.url.includes("v86.wasm"))?"generated code and called helpers":
  // The uninstrumented IR dispatch inlines jit_run_interpreted into main_loop.
  // Keep its generated interpreter frame and descendants in the same group.
  /jit_run_interpreted|gen.*interpreter.*run/.test(names)?"interpreter":
  /ir.*runtime.*schedule/.test(names)?"IR scheduler":
  /ir.*runtime.*cache/.test(names)?"IR admission and dispatch":
  /wasm/.test(stack[0].url)?"other core":
  names.includes("(garbage collector)")?"GC":"host and devices";
 groups.set(group,(groups.get(group)||0)+ms);
 const key=stack[0].functionName;own.set(key,(own.get(key)||0)+ms);total+=ms;
}
const rank=rows=>[...rows].map(([name,ms])=>({name,ms,pct:ms/total*100})).sort((a,b)=>b.ms-a.ms);
console.log(JSON.stringify({sampled_ms:total,groups:rank(groups),leaf_functions:rank(own).slice(0,30),
 caveat:"Sample intervals and stack-name grouping, including idle; not OS CPU accounting. Inlined code without a recognizable frame remains in other core. Profiling perturbs execution. Use profiling-off paired medians for acceptance."},null,2));
