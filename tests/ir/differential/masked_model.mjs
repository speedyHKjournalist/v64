// Independently select each byte using scalar shifts; no IR/Wasm masks.
export function masked(c,before,data){
 const source=c[6],mask=c[9],memory=data.slice();
 for(let byte=0;byte<16;byte++){
    const word=byte>>2,shift=(byte&3)*8;
    if((before.xmm[mask*4+word]>>>(shift+7))&1){
        const value=(before.xmm[source*4+word]>>>shift)&255;
        memory[word]=((memory[word]&~(255<<shift))|value<<shift)>>>0;
    }
 }
 return {xmm:before.xmm.slice(),regs:before.regs.slice(),memory};
}
