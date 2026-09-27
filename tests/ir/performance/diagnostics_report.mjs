import fs from "node:fs";
import assert from "node:assert/strict";
for(const file of process.argv.slice(2)) {
    const rows=fs.readFileSync(file,"utf8").split("\n").filter(s=>s.startsWith("{")).map(s=>JSON.parse(s));
    const last=rows.filter(r=>r.jit?.ir?.diagnostics).at(-1);
    assert(last,`no diagnostic snapshot: ${file}`);
    const d=last.jit.ir.diagnostics,t=d.totals;
    const stages=Object.entries(d.timings).map(([stage,r])=>({stage,...r,
        sampled_share_pct:t.sampled_batch_ms?r.sampled_ms/t.sampled_batch_ms*100:0,
        sampled_us_per_call:r.sampled_calls?r.sampled_ms/r.sampled_calls*1000:0,
        near_empty_scope_floor:!!r.sampled_calls&&r.sampled_ms/r.sampled_calls<5*d.empty_scope_sampled_ms,
    })).sort((a,b)=>b.sampled_ms-a.sampled_ms);
    const exits=Object.entries(d.exits).map(([reason,r])=>({reason,...r,
        share_pct:t.ir_activations?r.count/t.ir_activations*100:0,
        instructions_per_exit:r.count?r.guest_steps/r.count:0,
    })).filter(r=>r.count).sort((a,b)=>b.count-a.count);
    if(d.enabled) {
        assert.equal(exits.reduce((n,r)=>n+r.count,0),t.ir_activations);
        assert.equal(exits.reduce((n,r)=>n+r.guest_steps,0),t.ir_steps);
        assert.equal(t.instrumentation_errors,0);
        assert(Math.abs(stages.reduce((n,r)=>n+r.sampled_ms,0)-t.sampled_batch_ms)<0.1);
    }
    const estimate_ratio=t.cpu_batch_ms?t.sampled_batch_ms*d.sample_period/t.cpu_batch_ms:null;
    const warnings=[];
    if(last.overrun_ms>5000) warnings.push("Synchronous work overran the requested run window; compare actual durations, not requested durations.");
    if(estimate_ratio!==null&&(estimate_ratio<0.5||estimate_ratio>1.5)) warnings.push("Sampled time extrapolation differs substantially from measured batch time. Use all-call compiler timings for rare stalls; do not treat sampled stage shares as whole-run CPU shares.");
    console.log(JSON.stringify({file,avg_mips:last.avg_mips,wall_ms:last.ms,
        requested_ms:last.requested_ms??null,overrun_ms:last.overrun_ms??null,period:d.sample_period,warnings,
        cpu_batch_ms:t.cpu_batch_ms,sampled_batches:t.sampled_batches,batches:t.batches,
        sampling_time_estimate_ratio:estimate_ratio,
        empty_scope_sampled_us:d.empty_scope_sampled_ms*1000,empty_scope_wall_us:d.empty_scope_wall_ms*1000,
        ir_step_share:t.ir_steps/(t.ir_steps+t.interpreter_steps)||0,
        instructions_per_activation:t.ir_steps/t.ir_activations||0,
        stages,exits,admission:d.admission,chain_stops:d.chain_stops,compiler:d.compiler,compiler_breakdown:d.compiler_breakdown,publication:d.publication,
        helper_exits:d.helper_exits,
        control_exits:d.control_exits,discovery_latency:d.discovery_latency,missing_entries:d.missing_entries,
        interpreter_hotspots:d.interpreter_hotspots?.sort((a,b)=>b.inclusive_ms-a.inclusive_ms).slice(0,20),
        hotspot_replacements:d.hotspot_replacements,
        hotspots:d.hotspots.sort((a,b)=>b.inclusive_ms-a.inclusive_ms).slice(0,20),
        caveat:"Sampled timing includes observer overhead. estimated_ms is period-scaled, not a measured CPU-time total; near-floor scopes are not reliable cost rankings. Publication latency overlaps execution. Hotspot rows may be replaced on collision."
    },null,2));
}
