import assert from "node:assert/strict";

// These standalone modules have no dispatcher. Only the explicit debug
// OSFXSR=0 column may defer; verify its zero-step, untouched result before
// interpreting the fixture's two instructions exactly once.
export function runSseFixture(instance,cpu,e,snapshot,{fault,abort,nextPc}) {
    // cargo test emits these fixture modules with debug guards even when they
    // are later imported by a release CPU. Actual release compilation is tested
    // through the dispatcher; never infer fixture emission mode from the CPU.
    const deferred=!(cpu.cr[4]&512);
    const words=new Uint32Array(e.memory.buffer),count=words[664>>2];
    const before=deferred?snapshot():null;
    if(deferred) {
        // Each caller keeps OSFXSR=0 as a separate successful mode column;
        // fault/abort matrices run with OSFXSR=1 and must execute their IR.
        assert(!fault&&!abort,"only the successful OSFXSR=0 column may interpret this fixture");
        assert.equal(cpu.cr[0]&12,0,"the deferred column has no task fault");
    }
    instance.exports.f(0);
    if(deferred) {
        assert.equal(words[664>>2],count,"debug SSE fixture must defer before retiring its prefix");
        assert.deepEqual(snapshot(),before,"debug SSE entry deferral must leave CPU state untouched");
        for(let i=0;i<2;i++) {e.ir_test_step();words[664>>2]++;}
        assert.equal(cpu.instruction_pointer[0],nextPc,"both deferred instructions must complete without a fault");
    }
}
