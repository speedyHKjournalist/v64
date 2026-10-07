// Runs a standalone fixture module (no dispatcher). Its XMM forms raise #UD
// without CR4.OSFXSR, as the interpreter does, so the callers' OSFXSR=0
// columns are fault columns.
export function run_sse_fixture(instance) {
    instance.exports.f(0);
}

/** Whether a legacy SSE memory operand of `bytes` must be 16-byte aligned
 * (#GP(0) otherwise, before #PF; SDM exception type 4): an m128, except of
 * MOVUPS, MOVUPD, MOVDQU, LDDQU and PCMPxSTRx. UNPCKLPS/UNPCKLPD read 8 bytes
 * of one. */
export function aligned_m128(opcode, bytes) {
    if([0x0F10, 0x0F11, 0x660F10, 0x660F11, 0xF30F6F, 0xF30F7F, 0xF20FF0, 0x660F3A60, 0x660F3A61, 0x660F3A62, 0x660F3A63].includes(opcode)) return false;
    return bytes === 16 || opcode === 0x0F14 || opcode === 0x660F14;
}
