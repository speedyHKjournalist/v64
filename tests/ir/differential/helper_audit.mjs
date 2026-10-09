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
        // (PSHUFB and PALIGNR, SSSE3's integer shuffles among the sse-fp cases since the SIMD/XSAVE
        // plan's P3, compile their register forms natively: no adapter to keep)
        const code=manifest[i][0],shuffle=[[0x0F,0x38,0x00],[0x0F,0x3A,0x0F]]
            .some(s=>code.some((_,k)=>s.every((b,j)=>code[k+j]===b)));
        if(family.startsWith("simd-"))assert.equal(semantic.length,0,`${family}/${i} acquired an arithmetic helper`);
        else if(!(family==="sse-fp"&&shuffle))assert(semantic.length>0,`${family}/${i} lost its audited baseline semantic adapter`);
    }
    report.families[family]={modules,semanticModules: semantic_modules,averageBytes:Math.round(total_bytes/modules),imports};
}
fs.writeFileSync("build/ir-helper-audit.json",JSON.stringify(report,null,2)+"\n");
console.log("PASS: common packed arithmetic/moves/shuffles/lane operations have zero FP/MMX arithmetic imports; remaining FP/MMX calls inventoried in build/ir-helper-audit.json");
