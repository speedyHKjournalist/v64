// Static import audit: distinguish arithmetic helpers from guards/entry services.
import assert from "node:assert/strict";
import fs from "node:fs";
const families=["simd-integer","simd-immediate","simd-shuffle","simd-transfer","simd-lane","sse-fp","mmx"];
const report={schema:1,measurement:"module import presence, not wall-clock timing",families:{}};
for(const family of families) {
    const dir=`build/ir-${family}`;
    const manifest=JSON.parse(fs.readFileSync(`${dir}/cases.json`));
    let modules=0,semantic_modules=0,total_bytes=0;
    const imports={};
    for(let i=0;i<manifest.length;i++) {
        const bytes=fs.readFileSync(`${dir}/${i}-1.wasm`);
        const list=WebAssembly.Module.imports(new WebAssembly.Module(bytes)).filter(x=>x.kind==="function");
        modules++;total_bytes+=bytes.length;
        const semantic=list.filter(x=>/^ir_(sse_fp|mmx)/.test(x.name));
        if(semantic.length)semantic_modules++;
        for(const {name} of list)imports[name]=(imports[name]||0)+1;
        if(family.startsWith("simd-"))assert.equal(semantic.length,0,`${family}/${i} acquired an arithmetic helper`);
        else assert(semantic.length>0,`${family}/${i} lost its audited baseline semantic adapter`);
    }
    report.families[family]={modules,semanticModules: semantic_modules,averageBytes:Math.round(total_bytes/modules),imports};
}
fs.writeFileSync("build/ir-helper-audit.json",JSON.stringify(report,null,2)+"\n");
console.log("PASS: common packed arithmetic/moves/shuffles/lane operations have zero FP/MMX arithmetic imports; remaining FP/MMX calls inventoried in build/ir-helper-audit.json");
