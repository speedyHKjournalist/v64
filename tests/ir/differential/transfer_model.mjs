// Register/lane reference independent of the IR permutation maps.
export function transfer(c,before,data) {
    const [,,,op,,store,r,operand]=c,register=operand<8;
    const xmm=before.xmm.slice(),regs=before.regs.slice(),dst=xmm.slice(r*4,r*4+4),src=register?xmm.slice(operand*4,operand*4+4):data;
    let output;
    if(store){
        const lane=[0x0F17,0x660F17].includes(op)?2:0;
        if(!register) return {xmm,regs,memory:dst.slice(lane,lane+c[4]/4)};
        if(op===0x660F7E)regs[operand]=dst[0];
        else xmm.splice(operand*4,4,dst[0],dst[1],0,0);
    } else {
        switch(op){
            case 0x0F12: output=register?[src[2],src[3],dst[2],dst[3]]:[src[0],src[1],dst[2],dst[3]];break;
            case 0x660F12: output=[src[0],src[1],dst[2],dst[3]];break;
            case 0x0F16: case 0x660F16: output=[dst[0],dst[1],src[0],src[1]];break;
            case 0xF20F12: output=[src[0],src[1],src[0],src[1]];break;
            case 0xF30F12: output=[src[0],src[0],src[2],src[2]];break;
            case 0xF30F16: output=[src[1],src[1],src[3],src[3]];break;
            case 0x660F6E: output=[register?regs[operand]:src[0],0,0,0];break;
            case 0xF30F7E: output=[src[0],src[1],0,0];break;
            default: throw new Error(`unknown transfer ${op.toString(16)}`);
        }
        xmm.splice(r*4,4,...output);
    }
    return {xmm,regs};
}
