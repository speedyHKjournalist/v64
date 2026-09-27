// Call immediately after observing guest HLT, before awaiting stop acknowledgement.
// v86.stop() can wait for an already scheduled idle tick. That shutdown latency
// is not guest execution and must not make a short CPU workload appear faster
// relative to another backend by adding a common constant to both timings.
export async function finish_halted_timing(vm, started, clock = () => performance.now()) {
    const halted = clock();
    await vm.stop();
    const stopped = clock();
    return { ms: halted - started, stop_wait_ms: stopped - halted,
        timing_scope: "start-to-observed-halt" };
}
