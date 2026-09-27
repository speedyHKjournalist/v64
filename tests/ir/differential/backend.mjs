import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
import { backend_scenarios } from "../backend-scenarios.mjs";
await backend_scenarios(V86, {
    wasm_path: process.argv[2] || "build/v86-ir-runtime.wasm",
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/cpu-worker-test.bin")).buffer },
});
