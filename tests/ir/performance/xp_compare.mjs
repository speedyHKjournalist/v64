// Sequential fresh-VM, same-image XP boot comparison of build/v86-ir-runtime.wasm
// with optional IR_BASELINE_WASM / IR_REFERENCE_WASM cores; no concurrent jobs.
import fs from "node:fs";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash as create_hash} from "node:crypto";
const [disk, prefix="build/ir13-xp-paired"] = process.argv.slice(2);
assert(disk);
const runs = Number(process.env.IR_COMPARE_RUNS || 3);
assert(Number.isInteger(runs) && runs >= 3 && runs <= 10);
const rows=[];
const variants=["ir"];
if(process.env.IR_BASELINE_WASM) variants.push("baseline_ir");
if(process.env.IR_REFERENCE_WASM) variants.push("reference_ir");
for(let round=0;round<runs;round++) for(const variant of round%2?[...variants].reverse():variants) {
    const wasm=variant==="baseline_ir"?process.env.IR_BASELINE_WASM
        :variant==="reference_ir"?process.env.IR_REFERENCE_WASM:"build/v86-ir-runtime.wasm";
    // Keep historical policy explicit when comparing cores across a default
    // tuning change. Log each arm's effective settings in the result as well.
    const policy={};
    if(variant==="baseline_ir") for(const option of ["HOT_THRESHOLD","PROMOTION_THRESHOLD"]) {
        if(process.env[`IR_BASELINE_${option}`]!==undefined) policy[`IR_${option}`]=process.env[`IR_BASELINE_${option}`];
    }
    // Resident promotion is experimental and absent from historical cores.
    // Scope the opt-in to its explicit arm, never silently apply it to another.
    const env={...process.env,...policy};
    delete env.IR_RESIDENT_PROMOTION;
    const resident_option=variant==="ir"?"IR_RESIDENT_PROMOTION"
        :variant==="baseline_ir"?"IR_BASELINE_RESIDENT_PROMOTION"
        :variant==="reference_ir"?"IR_REFERENCE_RESIDENT_PROMOTION":null;
    if(resident_option && process.env[resident_option]!==undefined) {
        env.IR_RESIDENT_PROMOTION=process.env[resident_option];
    }
    const file=`${prefix}-${round}-${variant}.jsonl`, fd=fs.openSync(file,"w");
    const child=spawnSync(process.execPath,["tests/ir/performance/xp_boot.mjs",disk,wasm],{
        env:{...env,IR_BOOT_MS:process.env.IR_BOOT_MS||"180000",IR_BOOT_TARGET:"desktop",IR_DIAGNOSTICS:"0",IR_BENCH_RECORD:"0"},
        stdio:["ignore",fd,fd],timeout:300000,
    });
    fs.closeSync(fd);
    assert.equal(child.status,0,`run failed: ${file}: ${child.error||child.signal||child.status}`);
    const events=fs.readFileSync(file,"utf8").split("\n").filter(l=>l.startsWith("{")).map(l=>JSON.parse(l));
    const result=events.findLast(e=>e.event==="result");
    assert(result?.completed&&result.milestone,`milestone not reached: ${file}`);
    const ir=result.jit?.ir;
    const work=result.ir_work||{guest_steps:ir?.cache_guest_steps,activations:ir?.cache_hits,full_checks:ir?.cache_full_checks,observer_checks:0};
    const row={round,variant,file,wasm,region_budget:result.jit.ir_region_budget,...result.milestone,mips:result.milestone.instructions/result.milestone.ms/1000,
        // These counters are sampled at stop, slightly after the display event.
        stop_metrics:ir?{instructions:result.instructions,ir_coverage:work.guest_steps/result.instructions,
            instructions_per_activation:work.guest_steps/work.activations||0,
            activations_per_million:work.activations*1e6/result.instructions,
            full_checks_per_million:work.full_checks*1e6/result.instructions,
            observer_checks_per_million:work.observer_checks*1e6/result.instructions,
            validation_attempts_per_million:(work.full_checks+work.observer_checks)*1e6/result.instructions,
            warm_handoffs_per_million:result.boundary_counters?.warm_handoff_supported?work.warm_handoffs*1e6/result.instructions:null,
            missing_hint_hits_per_million:result.boundary_counters?.missing_hint_supported?work.missing_hint_hits*1e6/result.instructions:null,
            publications:ir.tier1_published+ir.tier2_published,evictions:ir.cache_evictions,
            ...result.boundary_counters}:null};
    rows.push(row);console.log(JSON.stringify(row));
}
const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
const medians=Object.fromEntries(variants.map(variant=>[variant,{
    ms:median(rows.filter(r=>r.variant===variant).map(r=>r.ms)),
    mips:median(rows.filter(r=>r.variant===variant).map(r=>r.mips)),
    instructions:median(rows.filter(r=>r.variant===variant).map(r=>r.instructions)),
}]));
const result={milestone:"first 800x600x32 mode (not desktop idle)",runs,rows,medians,
    artifacts:Object.fromEntries([...new Set(rows.map(r=>r.wasm))].map(file=>[file,create_hash("sha256").update(fs.readFileSync(file)).digest("hex")])),
    baseline_time_ratio:medians.baseline_ir?medians.ir.ms/medians.baseline_ir.ms:null,
    baseline_throughput_ratio:medians.baseline_ir?medians.ir.mips/medians.baseline_ir.mips:null,
    reference_time_ratio:medians.reference_ir?medians.ir.ms/medians.reference_ir.ms:null,
    reference_throughput_ratio:medians.reference_ir?medians.ir.mips/medians.reference_ir.mips:null};
fs.writeFileSync(`${prefix}-summary.json`,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result));
