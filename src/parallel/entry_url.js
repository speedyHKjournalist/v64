// The vCPU worker entry of the source tree. Loaded only when running from
// source (src/parallel/machine.js): the Closure bundles cannot compile
// import.meta and use build/vcpu-worker.js instead.
export const VCPU_WORKER_ENTRY = new URL("vcpu_worker_entry.js", import.meta.url);
