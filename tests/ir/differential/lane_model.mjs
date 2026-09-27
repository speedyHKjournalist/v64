// Scalar bit operations independent of Wasm lane instructions and IR lowering.
export function lane(c,before,data){
 const [,,,op,,store,r,operand,,immediate]=c;
 const xmm=before.xmm.slice(),regs=before.regs.slice();
 if(store) return {xmm,regs,memory:xmm.slice(r*4,r*4+4)};
 if(op===0xF20FF0)xmm.splice(r*4,4,...data);
 else if(op===0x660FC4){
    const index=immediate&7,word=(operand<8?regs[operand]:data[0])&65535;
    const position=r*4+(index>>1),shift=(index&1)*16;
    xmm[position]=((xmm[position]&~(65535<<shift))|(word<<shift))>>>0;
 } else if(op===0x660FC5){
    const index=immediate&7;regs[r]=(xmm[operand*4+(index>>1)]>>>((index&1)*16))&65535;
 } else {
    const size=op===0x0F50?32:op===0x660F50?64:op===0x660FD7?8:0;
    if(!size) throw new Error(`unknown lane opcode ${op.toString(16)}`);
    let mask=0;
    for(let n=0;n<128/size;n++){const bit=(n+1)*size-1;mask|=((xmm[operand*4+(bit>>5)]>>>(bit&31))&1)<<n;}
    regs[r]=mask;
 }
 return {xmm,regs};
}
